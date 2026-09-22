/**
 * The bridge spool (docs/design/runtime-coordination.md §3.4).
 *
 * A bridge publishes one request file with the same no-clobber primitive as the event store and
 * waits for the matching reply. The server drains the request directory on start and whenever
 * the filesystem reports a change, so a missed notification never loses a request and nothing
 * polls on a timer. A request with no reply is unresolved; one with a reply is terminal. Routing
 * is by the correlation's durable association: a Peer correlation can only ever reach the Peer
 * registry, whatever operation name its envelope carries.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
}

const refusal = (code: string, message: string, retryable = false): HandlerReply => ({ ok: false, result: { schema: 1, error: { code, message, retryable } } });

export class Spool {
  private watcher: FSWatcher | undefined;
  private draining: Promise<void> = Promise.resolve();
  private pending = false;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SpoolDependencies) {}

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

  private async drain(): Promise<void> {
    for (const id of (await this.unresolved()).sort()) {
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      try {
        await this.handle(id);
      } catch (error) {
        this.deps.log?.(`Spool request ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.inFlight.delete(id);
      }
    }
  }

  private async handle(id: string): Promise<void> {
    let request: BridgeRequestV1 | undefined;
    try {
      const parsed = bridgeRequestSchema.safeParse(JSON.parse(await readFile(join(this.requests, `${id}.json`), 'utf8')));
      if (parsed.success && parsed.data.requestId === id) request = parsed.data;
    } catch { /* malformed: refused below */ }
    const reply = request === undefined ? refusal('request_malformed', 'The bridge request could not be read.') : await this.route(request);
    await this.reply(id, reply);
  }

  private async route(request: BridgeRequestV1): Promise<HandlerReply> {
    const caller = await this.deps.resolve(request.correlation);
    if (caller === undefined) return refusal(request.operation === 'ask' || request.operation === 'handoff' ? 'report_unauthorized' : 'unauthorized', 'This bridge is not bound to a runtime seat.');
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
  }
}
