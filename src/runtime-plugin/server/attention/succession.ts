/**
 * Lead succession (docs/design/runtime-coordination-seat-context.md K-D5; K2 plan §2).
 *
 * One Human action replaces a project Lead: a preflight at a quiet point, a handoff the Lead writes
 * on request and Human reviews, the Lead's archive, a successor created as Start project creates
 * one, and a kickoff carrying the handoff verbatim. Each step is recorded and every Paseo effect
 * repeats safely, so a retried call or a reload resumes where the flow stopped. Only Human starts
 * one; the runtime suggests nothing here and prompts no seat but the two it replaces.
 *
 * It runs on its own lane, never inside the attention lane: the archive and the creation raise the
 * lifecycle events that lane processes. What Paseo's before hooks ask of it — whether a Lead is
 * handing over — is answered from memory and never waits for that lane, since those hooks run
 * inside the creation this lane awaits.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_HANDOFF_BYTES, utf8Bytes } from '../../shared/limits.js';
import { compactMarkFor, contextPercent, type SeatContextSettings } from '../../shared/seat-context.js';
import type { Controller } from '../controller.js';
import { settled } from '../domain/state.js';
import { quietlySettled } from '../domain/views.js';
import type { SuccessionText } from '../generated/succession.js';
import { openInTab, SUCCESSION_LABEL, type PaseoPort, type TimelineEntry } from '../paseo-port.js';
import { ProjectStore } from '../store/project.js';
import type { AttentionEngine } from './engine.js';
import type { LogRecord } from './log.js';
import { SUCCESSION_PREFIX, type Seat } from './observer.js';
import { kickoffFacts, type SeatStarter, type StartResult } from './seat-starter.js';
import { seatName } from './signals.js';
import { successionId, TERMINAL_STEPS, type SuccessionReason, type SuccessionRecord, type SuccessionStep, type SuccessionStore } from './succession-store.js';

/**
 * Timeline entries read back to find the handoff turn. Paseo collapses each tool call and merges a
 * message's chunks into one entry, so a handoff turn that runs its checks first still fits.
 */
const TIMELINE_READ = 1_000;
/** How long a request may be missing from the Lead's timeline before it counts as lost. */
const REQUEST_GRACE_MS = 60_000;
/** How long a failed replacement stays on its project's screen, unless dismissed or started again. */
const FAILED_SHOWN_MS = 24 * 60 * 60_000;
/** Context points below the compact mark at which the preflight warns. */
const NEAR_COMPACT_POINTS = 5;

/** What the ledger says about a Lead that is about to be replaced. */
export interface LedgerFacts {
  /** Assignments the Lead leads that are not settled. */
  readonly open: readonly string[];
  /** Runtime notices addressed to the Lead and not yet delivered. */
  readonly notices: number;
  /** Settled assignments whose worktree is still on disk. */
  readonly retained: number;
  /** Why the ledger could not be read, when it could not. */
  readonly unreadable?: string;
}

export type LedgerReader = (projectKey: string, leadAgentId: string) => Promise<LedgerFacts>;

/** Reads a project's ledger, when it has one, inside that project's queue. */
export function controllerLedger(controller: Pick<Controller, 'serial' | 'load' | 'deps'>): LedgerReader {
  return async (projectKey, leadAgentId) => {
    const store = (await ProjectStore.list(controller.deps.runtimeRoot, controller.deps.now)).find(entry => entry.meta.gitCommonDir === projectKey);
    if (store === undefined) return { open: [], notices: 0, retained: 0 };
    return await controller.serial(store.meta.projectId, async () => {
      const loaded = await controller.load(store);
      if (!loaded.ok) return { open: [], notices: 0, retained: 0, unreadable: loaded.message };
      const { state, events } = loaded.value;
      const mine = [...state.assignments.values()].filter(view => view.leadAgentId === leadAgentId);
      const recipients = new Map(events.flatMap(event => (event.type === 'notice.pending' && event.data.recipientAgentId !== undefined
        ? [[event.data.noticeId, event.data.recipientAgentId] as const] : [])));
      return {
        open: mine.filter(view => !settled(view)).map(view => view.id),
        notices: [...state.notices.values()].filter(notice => notice.state !== 'sent' && recipients.get(notice.noticeId) === leadAgentId).length,
        retained: mine.filter(view => settled(view) && !quietlySettled(state, view, existsSync)).length,
      };
    });
  };
}

/** What Paseo's archive of the Lead does to a seat it opened (Paseo 0.9.2 `cascadeArchiveChildren`). */
export type DescendantFate = 'archived-with-lead' | 'detached' | 'kept';

export interface DescendantView {
  readonly agentId: string;
  readonly title: string | null;
  readonly role: string;
  readonly state: string;
  readonly fate: DescendantFate;
  /** Why it is detached or kept rather than archived. */
  readonly why?: 'another workspace' | 'open in a tab' | 'its parent is not running' | 'its parent stays';
}

export interface Blocker {
  readonly code: string;
  readonly message: string;
}

export interface SuccessionPreflight {
  readonly lead: { readonly agentId: string; readonly title: string | null; readonly provider: string; readonly state: string; readonly contextPercent: number | null };
  readonly project: { readonly key: string; readonly name: string; readonly root: string };
  readonly blockers: readonly Blocker[];
  readonly notes: readonly string[];
  readonly descendants: readonly DescendantView[];
  /** The Supervisor the successor is parented to, or null for none. */
  readonly supervisor: { readonly agentId: string; readonly title: string | null } | null;
  readonly successor: { readonly provider: string; readonly model: string | null };
}

export interface SuccessionStatus {
  readonly id: string;
  readonly step: SuccessionStep;
  readonly projectKey: string;
  readonly name: string;
  readonly fromAgentId: string;
  readonly fromTitle: string | null;
  readonly provider: string;
  readonly supervisorAgentId: string | null;
  readonly reason: SuccessionReason;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly toAgentId?: string;
  readonly receivedBytes?: number;
  readonly failure?: { readonly code: string; readonly message: string };
  /** The handoff as received, or as Human last reviewed it. */
  readonly handoff?: string;
}

/** A succession that is not finished, or failed recently, as the room view shows it on its project. */
export interface SuccessionSummary {
  readonly id: string;
  readonly step: SuccessionStep;
  readonly projectKey: string;
  readonly name: string;
  readonly root: string;
  readonly fromAgentId: string;
  readonly fromTitle: string | null;
  readonly canFinish: boolean;
  readonly canCancel: boolean;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface SuccessionDependencies {
  readonly paseo: Pick<PaseoPort, 'getAgent' | 'send' | 'run' | 'recentTimeline' | 'archive' | 'openWorkspace' | 'createAgentInWorkspace' | 'resolveLaunch' | 'promptDelivered'>;
  readonly attention: AttentionEngine;
  readonly starter: Pick<SeatStarter, 'preflight'>;
  readonly ledger: LedgerReader;
  readonly store: SuccessionStore;
  /** The generated messages; without them no succession starts. */
  readonly text: SuccessionText | undefined;
  readonly contextSettings: () => SeatContextSettings;
  readonly now: () => Date;
}

type Reply = { readonly kind: 'absent' } | { readonly kind: 'failed' } | { readonly kind: 'reply'; readonly text: string };

/**
 * The Lead's answer to the request with `messageId`: the trailing run of assistant messages of the
 * turn that request is in, after it. Paseo merges a message's streamed chunks into one entry, and
 * narration before a tool call is not part of the answer.
 */
export function handoffReply(entries: readonly TimelineEntry[], messageId: string): Reply {
  const start = entries.findIndex(entry => entry.kind === 'user' && entry.messageId === messageId);
  if (start === -1) return { kind: 'absent' };
  const turnId = entries[start]?.turnId;
  const after = entries.slice(start + 1);
  const next = turnId === undefined ? after.findIndex(entry => entry.kind === 'user') : -1;
  const own = turnId === undefined ? (next === -1 ? after : after.slice(0, next)) : after.filter(entry => entry.turnId === turnId);
  if (own.some(entry => entry.kind === 'error')) return { kind: 'failed' };
  const said = own.filter(entry => entry.kind === 'assistant' || entry.kind === 'tool' || entry.kind === 'user');
  let first = said.length;
  while (first > 0 && said[first - 1]?.kind === 'assistant') first -= 1;
  return { kind: 'reply', text: said.slice(first).map(entry => entry.text).join('\n\n').trim() };
}

const refuse = (code: string, message: string): StartResult<never> => ({ ok: false, code, message });
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const requestId = (id: string): string => `succession-request-${id}`;
const kickoffId = (id: string): string => `succession-kickoff-${id}`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

export class Succession {
  private lane: Promise<unknown> = Promise.resolve();
  private loaded: Promise<Map<string, SuccessionRecord>> | undefined;
  /** Successions whose handoff is being read in the background for the room view. */
  private readonly collecting = new Set<string>();

  constructor(private readonly deps: SuccessionDependencies) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work, work);
    this.lane = next.catch(() => undefined);
    return next;
  }

  /**
   * Every record, read once per process; finished ones older than the log's retention are pruned
   * first. A failed read is not kept, so the next call tries again.
   */
  private records(): Promise<Map<string, SuccessionRecord>> {
    const loading = this.loaded ?? (async () => {
      await this.deps.store.prune().catch(() => 0);
      return new Map((await this.deps.store.list()).map(record => [record.id, record]));
    })();
    this.loaded = loading;
    loading.catch(() => { if (this.loaded === loading) this.loaded = undefined; });
    return loading;
  }

  private stamp(): string {
    return this.deps.now().toISOString();
  }

  private async save(record: SuccessionRecord): Promise<SuccessionRecord> {
    await this.deps.store.save(record);
    (await this.records()).set(record.id, record);
    return record;
  }

  /** Moves to `step`; a failure recorded at the previous step is cleared unless `change` names one. */
  private async advance(record: SuccessionRecord, step: SuccessionStep, change: Pick<Partial<SuccessionRecord>, 'toAgentId' | 'receivedBytes' | 'failure'> = {}): Promise<SuccessionRecord> {
    const next = { ...record, ...change, step, updatedAt: this.stamp() };
    return await this.save(Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'failure' || change.failure !== undefined)) as SuccessionRecord);
  }

  private async log(type: Extract<LogRecord['type'], `succession.${string}`>, record: SuccessionRecord, extra: { readonly bytes?: number; readonly code?: string } = {}): Promise<void> {
    await this.deps.attention.log.append({
      type, successionId: record.id, projectKey: record.projectKey, fromAgentId: record.fromAgentId,
      ...(record.toAgentId === undefined ? {} : { toAgentId: record.toAgentId }), reason: record.reason, step: record.step, ...extra,
    }).catch(() => undefined);
  }

  private async fail(record: SuccessionRecord, code: string, message: string): Promise<SuccessionRecord> {
    const failed = await this.advance(record, 'failed', { failure: { code, message } });
    await this.log('succession.failed', failed, { code });
    return failed;
  }

  // ── Preflight ────────────────────────────────────────────────────────────────────────────────

  /** What blocks replacing `leadAgentId`, what Paseo's archive does to its seats, and who follows it. */
  preflight(leadAgentId: string): Promise<StartResult<SuccessionPreflight>> {
    return this.serial(() => this.check(leadAgentId));
  }

  private async check(leadAgentId: string, own?: string): Promise<StartResult<SuccessionPreflight>> {
    if (this.deps.text === undefined) return refuse('succession_unavailable', 'This runtime plugin was not generated by paseo-room setup; run setup with --runtime --apply.');
    const attention = this.deps.attention;
    // Every seat read afresh: a descendant started a minute ago blocks as surely as the Lead does.
    if (!await attention.resync([leadAgentId])) return refuse('paseo_unavailable', 'Paseo could not be read, so the Lead\'s state is unknown; try again.');
    const lead = attention.observer.seat(leadAgentId);
    if (lead === undefined || lead.role !== 'lead' || lead.state === 'archived') return refuse('lead_unknown', `${leadAgentId} is not a live room Lead.`);
    const name = seatName(lead);
    const project = lead.project;
    const blockers: Blocker[] = [];
    if (lead.state === 'running') blockers.push({ code: 'lead_busy', message: `${name} is running a turn; wait until it is idle.` });
    if (lead.state === 'permission') blockers.push({ code: 'lead_busy', message: `${name} waits on a permission; resolve it first.` });
    const ledger = await this.deps.ledger(project.key, lead.agentId);
    if (ledger.unreadable !== undefined) blockers.push({ code: 'assignments_open', message: `The project's runtime ledger cannot be read, so its assignments cannot be checked: ${ledger.unreadable}` });
    if (ledger.open.length > 0) {
      blockers.push({ code: 'assignments_open', message: `${String(ledger.open.length)} runtime assignment(s) it leads are not settled (${ledger.open.join(', ')}); have it close or abandon them, or abandon them from the project screen.` });
    }
    if (ledger.notices > 0) blockers.push({ code: 'notices_pending', message: `${String(ledger.notices)} runtime notice(s) to it are not delivered yet; they are retried when it can take them.` });
    const working = attention.observer.descendants(lead.agentId).filter(seat => seat.state === 'running' || seat.state === 'permission');
    if (working.length > 0) blockers.push({ code: 'descendants_running', message: `Seats it opened are still working: ${working.map(seat => seatName(seat)).join(', ')}. Wait for them, or stop them in Paseo.` });
    const other = [...(await this.records()).values()].find(record => record.projectKey === project.key && record.id !== own && !TERMINAL_STEPS.includes(record.step));
    if (other !== undefined) blockers.push({ code: 'step_conflict', message: `A replacement of this project's Lead is already ${other.step}; finish or cancel it first.` });
    const launch = await this.deps.paseo.resolveLaunch(lead.provider).catch(() => undefined);
    if (launch === undefined) blockers.push({ code: 'model_unavailable', message: `No model is configured for ${lead.provider}; set one in its room profile.` });

    const notes: string[] = [];
    if (ledger.retained > 0) notes.push(`${String(ledger.retained)} settled assignment(s) keep a worktree; close each from its assignment view once its work is no longer needed.`);
    const percent = lead.usage === null ? null : contextPercent(lead.usage.used, lead.usage.max);
    const mark = compactMarkFor(this.deps.contextSettings(), lead);
    if (percent !== null && mark !== null && percent >= mark - NEAR_COMPACT_POINTS) {
      notes.push(`Its context is at ${String(percent)}%, near its ${String(mark)}% compact mark: it may compact while writing the handoff.`);
    }
    const resolution = attention.supervisorOf(project.key);
    const supervisor = resolution.supervisorAgentId === undefined ? undefined : attention.observer.seat(resolution.supervisorAgentId);
    return {
      ok: true,
      value: {
        lead: { agentId: lead.agentId, title: lead.title, provider: lead.provider, state: lead.state, contextPercent: percent },
        project: { key: project.key, name: project.name, root: project.root },
        blockers, notes, descendants: await this.fates(lead),
        supervisor: supervisor === undefined ? null : { agentId: supervisor.agentId, title: supervisor.title },
        successor: { provider: lead.provider, model: launch?.model ?? null },
      },
    };
  }

  /**
   * What archiving the Lead does to each seat it opened. Paseo archives a loaded agent's children
   * with it, recursively, but detaches a child in another workspace or open in a client's tab; an
   * agent archived while not loaded takes no child with it. The runtime archives each seat shown as
   * archived with the Lead itself (`complete`), so a Lead or a child that is not running when the
   * Human confirms still takes those with it; the others keep running.
   */
  private async fates(lead: Seat): Promise<DescendantView[]> {
    const seats = this.deps.attention.observer.seats().filter(seat => seat.state !== 'archived');
    const views: DescendantView[] = [];
    const walk = async (parent: Seat, archived: boolean): Promise<void> => {
      for (const child of seats.filter(seat => seat.parentAgentId === parent.agentId)) {
        let fate: DescendantFate = 'kept';
        let why: DescendantView['why'] = 'its parent stays';
        if (archived) {
          const snapshot = await this.deps.paseo.getAgent(child.agentId).catch(() => undefined);
          const workspaceId = snapshot?.workspaceId ?? child.workspaceId;
          const elsewhere = parent.workspaceId !== null && workspaceId !== null && parent.workspaceId !== workspaceId;
          const watched = openInTab(snapshot?.labels ?? {});
          if (!elsewhere && !watched) { fate = 'archived-with-lead'; why = undefined; }
          else if (parent.state === 'closed') why = 'its parent is not running';
          else { fate = 'detached'; why = elsewhere ? 'another workspace' : 'open in a tab'; }
        }
        views.push({ agentId: child.agentId, title: child.title, role: child.role, state: child.state, fate, ...(why === undefined ? {} : { why }) });
        await walk(child, fate === 'archived-with-lead');
      }
    };
    await walk(lead, true);
    return views;
  }

  // ── Request and handoff ──────────────────────────────────────────────────────────────────────

  /** Steps 1–2: refuses on any blocker, else records the succession and asks the Lead for its handoff. */
  start(input: { readonly leadAgentId: string; readonly reason: SuccessionReason; readonly note?: string | undefined }): Promise<StartResult<{ readonly successionId: string }>> {
    return this.serial(async () => {
      const checked = await this.check(input.leadAgentId);
      if (!checked.ok) return checked;
      const found = checked.value;
      const [first] = found.blockers;
      if (first !== undefined) return refuse(first.code, found.blockers.map(blocker => blocker.message).join(' '));
      const at = this.stamp();
      const note = input.note?.trim();
      // Recorded before the request: a closed Lead that the request resumes opens without a compact mark.
      const record = await this.save({
        schema: 1, id: successionId(), projectKey: found.project.key, root: found.project.root, name: found.project.name,
        fromAgentId: found.lead.agentId, fromTitle: found.lead.title, provider: found.lead.provider, supervisorAgentId: found.supervisor?.agentId ?? null,
        reason: input.reason, ...(note === undefined || note === '' ? {} : { note }), step: 'requested', createdAt: at, updatedAt: at,
      });
      await this.log('succession.started', record);
      const request = [`${SUCCESSION_PREFIX}${record.id}]`, this.deps.text?.request ?? '', ...(record.note === undefined ? [] : [`Human's note: ${record.note}`])].join('\n\n');
      try {
        // Steered, never interrupting: a turn begun since the preflight is not cancelled.
        await this.deps.paseo.send(record.fromAgentId, request, requestId(record.id), 'steer');
      } catch (error) {
        const evidence = await this.deps.paseo.promptDelivered(record.fromAgentId, requestId(record.id)).catch(() => 'unknown' as const);
        if (evidence === 'absent') {
          await this.fail(record, 'handoff_failed', `The request could not be sent: ${describe(error)}`);
          return refuse('handoff_failed', `The request could not be sent to the Lead: ${describe(error)}`);
        }
      }
      return { ok: true, value: { successionId: record.id } };
    });
  }

  /** Reads the handoff once the Lead's request turn has ended; a record past `requested` is returned as it is. */
  private async collect(record: SuccessionRecord): Promise<SuccessionRecord> {
    if (record.step !== 'requested') return record;
    const lead = await this.deps.paseo.getAgent(record.fromAgentId).catch(() => null);
    if (lead === null) return record;
    if (lead === undefined || lead.archivedAt !== null) return await this.fail(record, 'handoff_failed', 'The Lead was archived before its handoff arrived.');
    if (lead.activeTurn || lead.status === 'running' || lead.status === 'initializing') return record;
    const reply = handoffReply(await this.deps.paseo.recentTimeline(record.fromAgentId, TIMELINE_READ), requestId(record.id));
    if (reply.kind === 'absent') {
      // A read that failed looks empty too: only Paseo's own answer that the request is not there
      // fails the replacement, and only once Paseo has had time to list it.
      const evidence = await this.deps.paseo.promptDelivered(record.fromAgentId, requestId(record.id)).catch(() => 'unknown' as const);
      if (evidence === 'delivered') return await this.fail(record, 'handoff_failed', 'The handoff turn is too long for the room to read back; ask again for a handoff with fewer checks.');
      const age = this.deps.now().getTime() - Date.parse(record.createdAt);
      return evidence === 'unknown' || age < REQUEST_GRACE_MS ? record : await this.fail(record, 'handoff_failed', 'The request never reached the Lead; ask again.');
    }
    const last = this.deps.attention.observer.seat(record.fromAgentId)?.lastTurn;
    const failedTurn = last !== undefined && last.outcome !== 'completed' && last.firstMessage?.startsWith(`${SUCCESSION_PREFIX}${record.id}]`) === true;
    if (reply.kind === 'failed' || failedTurn) return await this.fail(record, 'handoff_failed', 'The Lead\'s handoff turn failed or was cancelled; ask again.');
    if (reply.text === '') return await this.fail(record, 'handoff_empty', 'The Lead answered without a handoff; ask again.');
    const bytes = utf8Bytes(reply.text);
    if (bytes > MAX_HANDOFF_BYTES) return await this.fail(record, 'handoff_too_large', `The handoff is ${kb(bytes)}, over the ${kb(MAX_HANDOFF_BYTES)} bound; ask again for a shorter one.`);
    await this.deps.store.writeHandoff(record.id, reply.text);
    const received = await this.advance(record, 'received', { receivedBytes: bytes });
    await this.log('succession.handoff-received', received, { bytes });
    return received;
  }

  /** A Lead's turn ended: reads its handoff if it was asked for one. Any other turn waits for nothing. */
  async onTurnEnded(agentId: string): Promise<void> {
    if (!await this.handingOver(agentId)) return;
    await this.serial(async () => {
      for (const record of [...(await this.records()).values()]) {
        if (record.step === 'requested' && record.fromAgentId === agentId) await this.collect(record);
      }
    });
  }

  /** Whether `agentId` is a Lead asked for its handoff; answered from memory, never behind the lane. */
  async handingOver(agentId: string): Promise<boolean> {
    return [...(await this.records()).values()].some(record => record.step === 'requested' && record.fromAgentId === agentId);
  }

  /** Whether a succession of the project has archived its Lead and waits to be finished. */
  async pending(projectKey: string): Promise<boolean> {
    return [...(await this.records()).values()].some(record => record.projectKey === projectKey && (record.step === 'archived' || record.step === 'created'));
  }

  status(id: string): Promise<StartResult<SuccessionStatus>> {
    return this.serial(async () => {
      const known = (await this.records()).get(id);
      if (known === undefined) return refuse('succession_unknown', `No Lead replacement ${id} is known.`);
      const record = await this.collect(known);
      const handoff = record.step === 'requested' ? undefined : await this.deps.store.readHandoff(record.id);
      return {
        ok: true,
        value: {
          id: record.id, step: record.step, projectKey: record.projectKey, name: record.name, fromAgentId: record.fromAgentId, fromTitle: record.fromTitle,
          provider: record.provider, supervisorAgentId: record.supervisorAgentId, reason: record.reason, createdAt: record.createdAt, updatedAt: record.updatedAt,
          ...(record.toAgentId === undefined ? {} : { toAgentId: record.toAgentId }),
          ...(record.receivedBytes === undefined ? {} : { receivedBytes: record.receivedBytes }),
          ...(record.failure === undefined ? {} : { failure: record.failure }),
          ...(handoff === undefined ? {} : { handoff }),
        },
      };
    });
  }

  /**
   * One succession per project for the room view: one not finished, else one that failed within a
   * day and was not dismissed. Answered from memory, never behind the lane, so a replacement in
   * progress does not hold up the room; a handoff whose turn has ended is read in the background.
   */
  async summaries(): Promise<readonly SuccessionSummary[]> {
    const now = this.deps.now().getTime();
    // A project's newest replacement is its only one that may be open: another cannot start meanwhile.
    const newest = new Map<string, SuccessionRecord>();
    for (const record of (await this.records()).values()) {
      const known = newest.get(record.projectKey);
      // Records are kept in the order they were made, so the later of two made in one millisecond wins.
      if (known === undefined || record.createdAt >= known.createdAt) newest.set(record.projectKey, record);
    }
    const shown = [...newest.values()].filter(record => !TERMINAL_STEPS.includes(record.step)
      || (record.step === 'failed' && now - Date.parse(record.updatedAt) < FAILED_SHOWN_MS));
    for (const record of shown) {
      if (record.step !== 'requested' || this.deps.attention.observer.seat(record.fromAgentId)?.state === 'running' || this.collecting.has(record.id)) continue;
      this.collecting.add(record.id);
      void this.serial(async () => { const current = (await this.records()).get(record.id); if (current !== undefined) await this.collect(current); })
        .catch(() => undefined).finally(() => { this.collecting.delete(record.id); });
    }
    return shown.map(record => ({
      id: record.id, step: record.step, projectKey: record.projectKey, name: record.name, root: record.root, fromAgentId: record.fromAgentId, fromTitle: record.fromTitle,
      canFinish: record.step === 'archived' || record.step === 'created', canCancel: record.step !== 'completed',
      ...(record.failure === undefined ? {} : { failure: record.failure }),
    }));
  }

  // ── Complete and cancel ──────────────────────────────────────────────────────────────────────

  /** Steps 4–7, resumed after whichever step was last recorded, with the handoff as Human reviewed it. */
  complete(id: string, handoff: string): Promise<StartResult<{ readonly successorAgentId: string }>> {
    return this.serial(async () => {
      const known = (await this.records()).get(id);
      if (known === undefined) return refuse('succession_unknown', `No Lead replacement ${id} is known.`);
      let record = await this.collect(known);
      if (record.step === 'completed' && record.toAgentId !== undefined) return { ok: true, value: { successorAgentId: record.toAgentId } };
      if (record.step === 'requested') return refuse('step_conflict', 'The Lead has not finished writing its handoff.');
      if (record.step === 'cancelled' || record.step === 'failed') return refuse('step_conflict', `This replacement was ${record.step}; start a new one.`);
      const text = handoff.trim();
      if (text === '') return refuse('handoff_empty', 'The handoff is empty.');
      if (utf8Bytes(text) > MAX_HANDOFF_BYTES) return refuse('handoff_too_large', `The handoff is ${kb(utf8Bytes(text))}, over the ${kb(MAX_HANDOFF_BYTES)} bound.`);
      const attention = this.deps.attention;
      let archivedWith: string[] = [];
      try {
        // Until it is delivered, the stored handoff is the one Human last reviewed.
        if (record.step !== 'created') await this.deps.store.writeHandoff(record.id, text);
        if (record.step === 'received') {
          const archived = await this.archiveLead(record);
          if (!archived.ok) return archived;
          archivedWith = archived.value;
          record = await this.advance(record, 'archived');
          await this.log('succession.archived', record);
        }
        if (record.step === 'archived') {
          // Also takes in the Lead and the seats archived or detached with it, which Paseo no longer lists.
          if (!await attention.resync([record.fromAgentId, ...archivedWith])) return refuse('paseo_unavailable', 'Paseo could not be read, so the project\'s Leads are unknown; try again.');
          for (const other of attention.observer.live(record.projectKey, 'lead')) {
            // A successor this replacement created before an answer was lost is its own, not another Lead.
            if ((await this.deps.paseo.getAgent(other.agentId))?.labels[SUCCESSION_LABEL] === record.id) continue;
            return refuse('lead_exists', `${seatName(other)} (${other.agentId}) already leads ${record.name}; cancel this replacement.`);
          }
          const launch = await this.deps.paseo.resolveLaunch(record.provider);
          if (launch === undefined) return refuse('model_unavailable', `No model is configured for ${record.provider}; set one in its room profile, then finish.`);
          const workspace = await this.deps.paseo.openWorkspace(record.root);
          if (workspace.directory !== null && resolve(workspace.directory) !== record.root) {
            return refuse('workspace_mismatch', `Paseo opened ${workspace.directory} for ${record.root}; start the Lead from Paseo instead, then cancel this replacement.`);
          }
          const supervisor = this.liveSupervisor(record);
          const created = await this.deps.paseo.createAgentInWorkspace(workspace.id, {
            provider: record.provider, ...(supervisor === undefined ? {} : { parentAgentId: supervisor.agentId }), title: `${record.name} — Lead`,
            labels: { [SUCCESSION_LABEL]: record.id },
            ...launch, idempotencyKey: `succession-${record.id}`,
          });
          record = await this.advance(record, 'created', { toAgentId: created.agentId });
          await this.log('succession.created', record);
          await attention.onCreated(created.agentId);
        }
        const successor = record.toAgentId;
        if (record.step === 'created' && successor !== undefined) {
          const delivered = await this.kickoffDelivered(record);
          if (delivered === 'gone') return refuse('successor_gone', 'The new Lead was archived or is gone before its kickoff; cancel this replacement and start a Lead from the project screen.');
          if (delivered === undefined) throw new Error('Paseo could not say whether the new Lead received its kickoff; try again.');
          if (!delivered) {
            await this.deps.store.writeHandoff(record.id, text);
            await this.deps.paseo.run(successor, await this.kickoff(record, text), kickoffId(record.id));
          }
          await this.log('succession.delivered', record, { bytes: utf8Bytes(text) });
          record = await this.advance(record, 'completed');
          await this.log('succession.completed', record);
          const title = attention.observer.seat(successor)?.title ?? `${record.name} — Lead`;
          await attention.told(record.projectKey, `Lead replaced: ${title} (${successor}) succeeds ${record.fromTitle ?? 'the previous Lead'} (${record.fromAgentId}).`);
        }
        return record.toAgentId === undefined ? refuse('step_conflict', `This replacement stopped at ${record.step}.`) : { ok: true, value: { successorAgentId: record.toAgentId } };
      } catch (error) {
        await this.save({ ...record, failure: { code: 'step_failed', message: describe(error) }, updatedAt: this.stamp() });
        return refuse('step_failed', `Replacing the Lead stopped after "${record.step}": ${describe(error)}`);
      }
    });
  }

  /**
   * Step 4, behind the preflight run again. Returns the seats the confirm step showed as archived
   * with the Lead, which the runtime archives too: Paseo takes none with an agent that is not loaded.
   * A Lead Human already archived in Paseo after reading its handoff counts as archived.
   */
  private async archiveLead(record: SuccessionRecord): Promise<StartResult<string[]>> {
    const current = await this.deps.paseo.getAgent(record.fromAgentId);
    if (current !== undefined && current.archivedAt !== null) return { ok: true, value: [] };
    const checked = await this.check(record.fromAgentId, record.id);
    if (!checked.ok) return checked;
    const [first] = checked.value.blockers;
    if (first !== undefined) return refuse(first.code, checked.value.blockers.map(blocker => blocker.message).join(' '));
    if ((checked.value.supervisor?.agentId ?? null) !== record.supervisorAgentId) {
      return refuse('step_conflict', 'The project\'s Supervisor changed since the handoff was asked for; cancel and start again to review the new one.');
    }
    await this.deps.paseo.archive(record.fromAgentId);
    const withLead = checked.value.descendants.filter(seat => seat.fate === 'archived-with-lead').map(seat => seat.agentId);
    // Parents before children; an archive Paseo already cascaded answers its time again.
    for (const agentId of withLead) await this.deps.paseo.archive(agentId);
    return { ok: true, value: checked.value.descendants.map(seat => seat.agentId) };
  }

  /** Whether the successor holds its kickoff: `gone` once it is archived or unknown, undefined when Paseo cannot say. */
  private async kickoffDelivered(record: SuccessionRecord): Promise<boolean | 'gone' | undefined> {
    if (record.toAgentId === undefined) return false;
    const successor = await this.deps.paseo.getAgent(record.toAgentId);
    if (successor === undefined || successor.archivedAt !== null) return 'gone';
    const evidence = await this.deps.paseo.promptDelivered(record.toAgentId, kickoffId(record.id)).catch(() => 'unknown' as const);
    return evidence === 'unknown' ? undefined : evidence === 'delivered';
  }

  /** The Supervisor recorded at the request, while it is still a live room Supervisor. */
  private liveSupervisor(record: SuccessionRecord): Seat | undefined {
    const seat = record.supervisorAgentId === null ? undefined : this.deps.attention.observer.seat(record.supervisorAgentId);
    return seat?.role === 'supervisor' && seat.state !== 'archived' ? seat : undefined;
  }

  /** Delta §6.2: the Start project facts, the predecessor named, the successor's instructions and the handoff verbatim. */
  private async kickoff(record: SuccessionRecord, handoff: string): Promise<string> {
    const found = await this.deps.starter.preflight(record.root);
    if (!found.ok) throw new Error(found.message);
    const supervisor = this.liveSupervisor(record);
    const from = `${record.fromTitle ?? 'the previous Lead'} (${record.fromAgentId})`;
    return [
      `${SUCCESSION_PREFIX}${record.id}] ${kickoffFacts(found.value, supervisor === undefined ? undefined : { title: supervisor.title ?? 'Room Supervisor', agentId: supervisor.agentId })}`,
      `Your predecessor ${from} handed over; its handoff follows verbatim.`,
      this.deps.text?.kickoff ?? '',
      `----- handoff from ${from} -----`,
      handoff,
      '----- end of handoff -----',
    ].join('\n\n');
  }

  /**
   * Ends a replacement before it completes. The Lead stays as it is before the archive; after it, the
   * project is left without a Lead, or with a successor that never got its kickoff, and the handoff is
   * kept. A failed replacement is dismissed from the project screen.
   */
  cancel(id: string): Promise<StartResult<{ readonly cancelled: true }>> {
    return this.serial(async () => {
      const record = (await this.records()).get(id);
      if (record === undefined) return refuse('succession_unknown', `No Lead replacement ${id} is known.`);
      if (record.step === 'completed') return refuse('step_conflict', 'This replacement is complete.');
      if (record.step !== 'cancelled') await this.log('succession.cancelled', await this.advance(record, 'cancelled'));
      return { ok: true, value: { cancelled: true } };
    });
  }
}
