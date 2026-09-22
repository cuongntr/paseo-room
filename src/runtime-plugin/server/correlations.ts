/**
 * Bridge correlations (docs/design/runtime-coordination.md §3.3, §3.4).
 *
 * `before(agent.create)` can only attach a provisional, one-use correlation; it proves nothing
 * about which agent it reached. `before(agent.session_open)` associates it with one agent and
 * workspace, and that association is published durably and never replaced — a second agent
 * presenting the same correlation makes it ambiguous rather than re-pointing it. Even an
 * associated correlation is still not a proven binding: the controller corroborates live facts
 * before it trusts one, because a session can open for a create that later fails.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RuntimeRole } from '../shared/policy.js';
import type { AssignmentKind } from './contracts/assignment.js';
import { AlreadyPublishedError, ensurePrivateDirectory, publishOnce } from './store/publish.js';

export type BridgeKind = 'action' | 'peer';

export interface Correlation {
  readonly id: string;
  readonly kind: BridgeKind;
  readonly role: RuntimeRole;
  readonly providerId: string;
  readonly assignmentId?: string;
  readonly workKind?: AssignmentKind;
  readonly mintedAt: number;
}

const associationSchema = z.strictObject({
  schema: z.literal(1),
  correlationId: z.string().min(1),
  kind: z.enum(['action', 'peer']),
  role: z.enum(['supervisor', 'lead', 'peer']),
  providerId: z.string().min(1),
  assignmentId: z.string().min(1).optional(),
  workKind: z.enum(['engineer', 'architect', 'reviewer', 'scout']).optional(),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  associatedAt: z.iso.datetime({ offset: true }),
});
export type Association = z.infer<typeof associationSchema>;

export interface ExpectedPeerCreate {
  readonly assignmentId: string;
  readonly providerId: string;
  /** Carries a unique token, because the create hook sees no labels or parent. */
  readonly title: string;
  readonly workKind: AssignmentKind;
}

export type AssociateResult = 'associated' | 'already-associated' | 'ambiguous' | 'unknown' | 'expired' | 'provider-mismatch';

export const CORRELATION_TTL_MS = 10 * 60_000;

export class CorrelationRegistry {
  private readonly provisional = new Map<string, Correlation>();
  private readonly expected = new Map<string, ExpectedPeerCreate>();
  private readonly byAssignment = new Map<string, string>();

  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CORRELATION_TTL_MS,
  ) {}

  /** The controller announces its own Peer create before calling Paseo. */
  expectPeerCreate(expected: ExpectedPeerCreate): void {
    this.expected.set(`${expected.providerId}\u0000${expected.title}`, expected);
  }

  forgetPeerCreate(providerId: string, title: string): void {
    this.expected.delete(`${providerId}\u0000${title}`);
  }

  /** One use: a matching create consumes the expectation. Nothing else creates a runtime Peer. */
  takeExpectedPeerCreate(providerId: string, title: string): ExpectedPeerCreate | undefined {
    const key = `${providerId}\u0000${title}`;
    const found = this.expected.get(key);
    this.expected.delete(key);
    return found;
  }

  mint(kind: BridgeKind, role: RuntimeRole, providerId: string, extra: { readonly assignmentId?: string; readonly workKind?: AssignmentKind } = {}): Correlation {
    const correlation: Correlation = { id: `cor_${randomBytes(16).toString('hex')}`, kind, role, providerId, mintedAt: this.now(), ...extra };
    this.provisional.set(correlation.id, correlation);
    if (kind === 'peer' && extra.assignmentId !== undefined) this.byAssignment.set(extra.assignmentId, correlation.id);
    return correlation;
  }

  /** The correlation minted for this assignment's runtime-dispatched Peer, in this process. */
  forAssignment(assignmentId: string): string | undefined {
    return this.byAssignment.get(assignmentId);
  }

  private path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  /** Durably associates a provisional correlation with the agent whose session opened it. */
  async associate(id: string, agentId: string, workspaceId: string | null, providerId: string): Promise<AssociateResult> {
    const existing = await this.lookup(id);
    if (existing !== undefined) return existing.agentId === agentId && existing.providerId === providerId ? 'already-associated' : 'ambiguous';
    const correlation = this.provisional.get(id);
    if (correlation === undefined) return 'unknown';
    if (this.now() - correlation.mintedAt > this.ttlMs) { this.provisional.delete(id); return 'expired'; }
    if (correlation.providerId !== providerId) return 'provider-mismatch';
    const association: Association = {
      schema: 1, correlationId: id, kind: correlation.kind, role: correlation.role, providerId: correlation.providerId,
      ...(correlation.assignmentId === undefined ? {} : { assignmentId: correlation.assignmentId }),
      ...(correlation.workKind === undefined ? {} : { workKind: correlation.workKind }),
      agentId, workspaceId, associatedAt: new Date(this.now()).toISOString(),
    };
    await ensurePrivateDirectory(this.directory);
    try {
      await publishOnce(this.directory, `${id}.json`, `${JSON.stringify(association)}\n`);
    } catch (error) {
      if (!(error instanceof AlreadyPublishedError)) throw error;
      const raced = await this.lookup(id);
      return raced?.agentId === agentId ? 'already-associated' : 'ambiguous';
    }
    this.provisional.delete(id);
    return 'associated';
  }

  /** The durable association, surviving plugin restarts; never a provisional correlation. */
  async lookup(id: string): Promise<Association | undefined> {
    if (!/^cor_[0-9a-f]{32}$/.test(id)) return undefined;
    try {
      const parsed = associationSchema.safeParse(JSON.parse(await readFile(this.path(id), 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The durable Peer association for an assignment, found after a restart as well as before. */
  async findByAssignment(assignmentId: string): Promise<Association | undefined> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return undefined; }
    for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
      const association = await this.lookup(name.slice(0, -'.json'.length));
      if (association?.kind === 'peer' && association.assignmentId === assignmentId) return association;
    }
    return undefined;
  }

  /** Drops provisional correlations past their lifetime; they never activate on their own. */
  expire(): readonly string[] {
    const expired: string[] = [];
    for (const [id, correlation] of this.provisional) {
      if (this.now() - correlation.mintedAt > this.ttlMs) { this.provisional.delete(id); expired.push(id); }
    }
    return expired;
  }
}
