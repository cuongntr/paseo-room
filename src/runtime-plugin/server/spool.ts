/**
 * The bridge spool (docs/design/runtime-coordination.md §3.4).
 *
 * A bridge publishes one request file with the same no-clobber primitive as the event store and
 * waits for the matching reply. The server drains the request directory on start and whenever
 * the filesystem reports a change, so a missed notification never loses a request and nothing
 * polls on a timer. A request with no reply is unresolved; one with a reply is terminal. Routing
 * is by the correlation's durable association: a Peer correlation can only ever reach the Peer
 * registry, whatever operation name its envelope carries.
 *
 * Requests are taken oldest first, and every request gets exactly one reply, also when its handler
 * fails. A Supervisor or Lead request that has not started within `ACTION_START_DEADLINE_MS` is
 * answered `request_expired` and never run: its bridge tells the seat to retry at 60 s, so running it
 * later would act on a stale instruction, twice if the seat did retry (amended 2026-10-02, after a
 * stall ran Supervisor messages hours late). A Peer report has no deadline; its generation fence and
 * receipt decide whether it still counts. Answered pairs are deleted after `SPOOL_RETENTION_MS`.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTION_START_DEADLINE_MS } from '../shared/limits.js';
import type { RuntimeRole } from '../shared/policy.js';
import { bridgeRequestSchema, type BridgeRequestV1 } from './contracts/envelope.js';
import { AlreadyPublishedError, ensurePrivateDirectory, publishOnce } from './store/publish.js';

export interface BridgeCaller {
  readonly kind: 'action' | 'peer';
  readonly role: RuntimeRole;
}

export interface HandlerReply {
  readonly ok: boolean;
  readonly result: unknown;
}

export type OperationHandler = (request: BridgeRequestV1, caller: BridgeCaller) => Promise<HandlerReply>;

export interface Registries {
  readonly supervisor: Readonly<Record<string, OperationHandler>>;
  readonly lead: Readonly<Record<string, OperationHandler>>;
  readonly peer: Readonly<Record<string, OperationHandler>>;
}

export interface SpoolDependencies {
  readonly root: string;
  /** Resolves a correlation to its durable association, or undefined when it has none. */
  readonly resolve: (correlation: string) => Promise<BridgeCaller | undefined>;
  readonly registries: Registries;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

const refusal = (code: string, message: string, retryable = false): HandlerReply => ({ ok: false, result: { schema: 1, error: { code, message, retryable } } });

/** How long an answered request and its reply are kept. The ledger, not the spool, is the record. */
export const SPOOL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

/** What the spool still owes: unanswered requests, how long the oldest has waited, and requests this process let expire. */
export interface SpoolBacklog {
  readonly unanswered: number;
  readonly oldestSeconds: number;
  readonly expired: number;
}

export class Spool {
  private watcher: FSWatcher | undefined;
  private draining: Promise<void> = Promise.resolve();
  private pending = false;
  private readonly inFlight = new Set<string>();
  private expired = 0;
  private prunedAt: number | undefined;
  private pruning: Promise<unknown> = Promise.resolve();
  /** Replies a handler produced but that could not be published: sent again, never recomputed. */
  private readonly unsent = new Map<string, HandlerReply>();

  constructor(private readonly deps: SpoolDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get requests(): string { return join(this.deps.root, 'requests'); }
  get replies(): string { return join(this.deps.root, 'replies'); }

  async start(): Promise<void> {
    await ensurePrivateDirectory(this.requests);
    await ensurePrivateDirectory(this.replies);
    this.watcher = watch(this.requests, () => { void this.schedule(); });
    await this.schedule();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Coalesces notifications into one more drain after the current one. */
  schedule(): Promise<void> {
    if (this.pending) return this.draining;
    this.pending = true;
    this.draining = this.draining.then(async () => {
      this.pending = false;
      await this.drain();
    });
    return this.draining;
  }

  /** Request ids with no reply yet — the unresolved entries the generation fence waits on. */
  async unresolved(): Promise<string[]> {
    const [requests, replies] = await Promise.all([readdir(this.requests).catch(() => []), readdir(this.replies).catch(() => [])]);
    const answered = new Set(replies);
    return requests.filter(name => name.endsWith('.json') && !answered.has(name)).map(name => name.slice(0, -'.json'.length));
  }

  /** Unresolved request ids sent by one bridge correlation. */
  async unresolvedFor(correlation: string): Promise<string[]> {
    const matching: string[] = [];
    for (const id of await this.unresolved()) {
      try {
        const raw = JSON.parse(await readFile(join(this.requests, `${id}.json`), 'utf8')) as { correlation?: unknown };
        if (raw.correlation === correlation) matching.push(id);
      } catch {
        // An unreadable request cannot be attributed; it is refused by the next drain.
      }
    }
    return matching;
  }

  /** Unresolved requests with the time each was written, oldest first; one removed meanwhile is skipped. */
  private async waiting(): Promise<{ readonly id: string; readonly writtenAt: number }[]> {
    const entries = await Promise.all((await this.unresolved()).map(async id => {
      const writtenAt = await stat(join(this.requests, `${id}.json`)).then(found => found.mtimeMs, () => undefined);
      return writtenAt === undefined ? undefined : { id, writtenAt };
    }));
    return entries.filter(entry => entry !== undefined).sort((a, b) => a.writtenAt - b.writtenAt || a.id.localeCompare(b.id));
  }

  /** Requests in hand are not counted: a long but working handler is not a runtime that stopped answering. */
  async backlog(): Promise<SpoolBacklog> {
    const waiting = (await this.waiting()).filter(entry => !this.inFlight.has(entry.id));
    const oldest = waiting[0];
    return { unanswered: waiting.length, oldestSeconds: oldest === undefined ? 0 : Math.max(0, Math.floor((this.now() - oldest.writtenAt) / 1_000)), expired: this.expired };
  }

  /**
   * Deletes every request answered more than `SPOOL_RETENTION_MS` ago, each before its reply so that a
   * request is never left without one and run again, then the reply. An unanswered request is kept.
   */
  async prune(): Promise<number> {
    const cutoff = this.now() - SPOOL_RETENTION_MS;
    let removed = 0;
    for (const name of await readdir(this.replies).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const repliedAt = await stat(join(this.replies, name)).then(found => found.mtimeMs, () => undefined);
      if (repliedAt === undefined || repliedAt > cutoff) continue;
      await rm(join(this.requests, name), { force: true });
      await rm(join(this.replies, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  private async drain(): Promise<void> {
    const waiting = await this.waiting();
    // A reply owed for a request that is gone is owed to nobody.
    for (const id of this.unsent.keys()) if (!waiting.some(entry => entry.id === id)) this.unsent.delete(id);
    for (const { id, writtenAt } of waiting) {
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      try {
        const unsent = this.unsent.get(id);
        if (unsent === undefined) await this.handle(id, writtenAt);
        else await this.reply(id, unsent);
      } catch (error) {
        this.deps.log?.(`Spool request ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.inFlight.delete(id);
      }
    }
    // Beside the drain rather than in it, so a first start with a long history keeps no request waiting.
    if (this.prunedAt === undefined || this.now() - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = this.now();
      this.pruning = this.pruning.then(() => this.prune()).catch((error: unknown) => { this.deps.log?.(`Spool pruning failed: ${error instanceof Error ? error.message : String(error)}`); });
    }
  }

  private async handle(id: string, writtenAt: number): Promise<void> {
    let request: BridgeRequestV1 | undefined;
    try {
      const parsed = bridgeRequestSchema.safeParse(JSON.parse(await readFile(join(this.requests, `${id}.json`), 'utf8')));
      if (parsed.success && parsed.data.requestId === id) request = parsed.data;
    } catch { /* malformed: refused below */ }
    let reply: HandlerReply;
    try {
      reply = request === undefined ? refusal('request_malformed', 'The bridge request could not be read.') : await this.route(request, writtenAt);
    } catch (error) {
      // Left without a reply, the request would run again at every drain, and a Peer's would hold its generation open for good.
      this.deps.log?.(`Spool request ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      reply = refusal('internal_error', 'The runtime failed while handling this call, possibly after acting on it. Check its effect, for example with a status call, before sending it again.');
    }
    await this.reply(id, reply).catch((error: unknown) => { this.unsent.set(id, reply); throw error; });
  }

  private async route(request: BridgeRequestV1, writtenAt: number): Promise<HandlerReply> {
    const caller = await this.deps.resolve(request.correlation);
    if (caller === undefined) return refusal(request.operation === 'ask' || request.operation === 'handoff' ? 'report_unauthorized' : 'unauthorized', 'This bridge is not bound to a runtime seat.');
    const waited = this.now() - writtenAt;
    if (caller.kind === 'action' && waited > ACTION_START_DEADLINE_MS) {
      this.expired += 1;
      return refusal('request_expired', `This call waited ${String(Math.round(waited / 1_000))} s for the runtime and was not run now. If the runtime restarted meanwhile, it may have started it before; check its effect before sending it again.`, true);
    }
    const registry = caller.kind === 'peer' ? this.deps.registries.peer : caller.role === 'lead' ? this.deps.registries.lead : caller.role === 'supervisor' ? this.deps.registries.supervisor : {};
    const handler = Object.hasOwn(registry, request.operation) ? registry[request.operation] : undefined;
    if (handler === undefined) {
      return refusal(caller.kind === 'peer' ? 'report_unauthorized' : 'unauthorized', `${request.operation} is not available to this seat.`);
    }
    return await handler(request, caller);
  }

  private async reply(id: string, reply: HandlerReply): Promise<void> {
    try {
      await publishOnce(this.replies, `${id}.json`, `${JSON.stringify({ protocol: 1, requestId: id, ok: reply.ok, result: reply.result })}\n`);
    } catch (error) {
      if (!(error instanceof AlreadyPublishedError)) throw error;
    }
    this.unsent.delete(id);
  }
}
