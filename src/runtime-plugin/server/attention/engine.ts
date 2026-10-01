/**
 * The attention engine (docs/design/runtime-coordination-attention.md §3): Observer → signals and
 * Lead-turn candidates → triage → delivery, with the log and the portfolio.
 *
 * Work is serialised on one lane, so lifecycle events, the sweep and RPCs never interleave. The
 * engine starts on the first event or call that brings Paseo's handle, and a failed start is
 * retried on the next one. It decides nothing about assignments and writes nothing Paseo owns.
 */
import { homedir } from 'node:os';
import type { AttentionSettings } from '../../shared/attention.js';
import { DEFAULT_SEAT_CONTEXT_SETTINGS, appliedMark, compactMarkFor, contextPercent, rotateMark, type SeatContextSettings } from '../../shared/seat-context.js';
import type { GitEvidence } from '../git.js';
import type { PaseoPort } from '../paseo-port.js';
import type { Recognition } from '../recognition.js';
import { ProjectStore } from '../store/project.js';
import { Delivery, LETTER_PREFIX, keepNewest, letterId } from './delivery.js';
import { AttentionLog } from './log.js';
import { head, mask, tail } from './mask.js';
import { Observer, type Checkout, type Seat, type TurnFacts } from './observer.js';
import { Portfolio, type Resolution } from './portfolio.js';
import type { LedgerReader } from './succession.js';
import { age, conditions, seatLabel, type Condition, type Level, type SignalKind } from './signals.js';
import { ANSWER, BASELINE, MAX_MARKER_TEXT, markedLeadTurn, type Decision, type LeadTurnFacts, type Marker, type Triaged } from './triage.js';

export const SWEEP_MS = 30_000;
const STALE_SNAPSHOT_MS = 5 * 60_000;
const REOPEN_MS = 10 * 60_000;
const LEDGER_CACHE_MS = 60_000;
const ITEM_MEMORY = 500;
const LETTER_EXCERPT = 240;
/** An answer to the Supervisor's own message carries more of it (§6.2). */
const REPLY_EXCERPT = 1_500;
/** Marker lines quoted in one letter item, each whole up to the parser's bound. */
const LETTER_MARKERS = 3;
/** Relayed marker lines remembered per Lead. */
const RELAYED_MARKERS = 100;

/** A marker line as relayed; the parser has already collapsed its whitespace. */
function markerKey(marker: Marker): string {
  return `${marker.kind}:${marker.text}`;
}

/** A path for display: the home directory shown as `~`. */
export function homeRelative(path: string, home = homedir()): string {
  return home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export type Verdict = 'useful' | 'noise' | 'unknown';

export interface Incident {
  readonly id: string;
  readonly key: string;
  readonly kind: SignalKind;
  readonly level: Level;
  readonly projectKey: string;
  subjects: readonly string[];
  text: string;
  summary: string;
  evidence: string;
  readonly openedAt: number;
  updatedAt: number;
  closedAt: number | undefined;
  count: number;
  /** A Supervisor agent id, or `panel` when nobody may receive it. */
  readonly recipient: string;
  feedback?: Verdict;
}

interface Item {
  readonly recipient: string;
  readonly projectKey: string;
  readonly kind: string;
}

export interface EngineDependencies {
  readonly paseo: PaseoPort;
  readonly recognition: Pick<Recognition, 'recognize'>;
  readonly git: Pick<GitEvidence, 'identity' | 'isLinked' | 'branch'>;
  readonly runtimeRoot: string;
  readonly now: () => Date;
  readonly settings: () => AttentionSettings;
  /** The operator's context budgets; the defaults when omitted. */
  readonly contextSettings?: () => SeatContextSettings;
  readonly log?: (message: string) => void;
  /** Whether Paseo's handle has arrived; the sweep waits for it rather than failing every pass. */
  readonly ready?: () => boolean;
  /** The runtime ledger's open assignments of a Lead; a letter omits them when not supplied. */
  readonly ledger?: LedgerReader;
}

interface PendingLeadTurn {
  readonly id: string;
  readonly leadAgentId: string;
  readonly turn: TurnFacts;
  /** When the Lead's previous turn ended, if the Observer saw it. */
  readonly previousEndedAt: number | undefined;
  readonly dueAt: number;
}

/** How far before an unobserved turn's start a Supervisor prompt is still taken to have started it. */
const PROMPT_WINDOW_MS = 60_000;

export class AttentionEngine {
  readonly observer: Observer;
  readonly portfolio: Portfolio;
  readonly log: AttentionLog;
  readonly delivery: Delivery;
  private readonly incidents = new Map<string, Incident>();
  private readonly items = new Map<string, Item>();
  /** The queued digest Lead-turn item of each Lead: a newer turn supersedes it. */
  private readonly queuedTurn = new Map<string, string>();
  /** Marker lines already relayed per Lead, so a restated one does not page or wake again. */
  private readonly relayedMarkers = new Map<string, Set<string>>();
  private pendingTurns: PendingLeadTurn[] = [];
  private lane: Promise<unknown> = Promise.resolve();
  private started = false;
  private ledger: { readonly keys: ReadonlySet<string>; readonly at: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: EngineDependencies) {
    this.observer = new Observer({ paseo: deps.paseo, recognition: deps.recognition, git: deps.git, now: deps.now });
    this.portfolio = Portfolio.at(deps.runtimeRoot, deps.now);
    this.log = AttentionLog.at(deps.runtimeRoot, deps.now);
    this.delivery = new Delivery({ paseo: deps.paseo, observer: this.observer, log: this.log, now: deps.now, settings: deps.settings });
  }

  private get time(): number {
    return this.deps.now().getTime();
  }

  private contextSettings(): SeatContextSettings {
    return this.deps.contextSettings?.() ?? DEFAULT_SEAT_CONTEXT_SETTINGS;
  }

  private report(message: string): void {
    (this.deps.log ?? (text => { console.error(`[paseo-room-runtime] ${text}`); }))(message);
  }

  /** Runs `work` after every earlier engine operation; a failure is logged, never rethrown to Paseo. */
  run<T>(work: () => Promise<T>): Promise<T | undefined> {
    const next = this.lane.then(work, work).catch((error: unknown) => {
      this.report(`attention: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    this.lane = next;
    return next;
  }

  /** Loads the portfolio and rebuilds the Observer once Paseo is reachable. */
  private async ensureStarted(): Promise<boolean> {
    if (this.started) return true;
    await this.portfolio.load();
    await this.log.prune().catch(() => 0);
    await this.observer.rebuild();
    this.started = true;
    return true;
  }

  /** Starts the sweep timer. Call once from the plugin entry; `dispose` stops it. */
  startTimer(): void {
    this.timer ??= setInterval(() => { void this.run(() => this.sweep()); }, SWEEP_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────────────

  onCreated(agentId: string): Promise<unknown> {
    return this.run(async () => { await this.ensureStarted(); await this.observer.onCreated(agentId); await this.settle(); });
  }

  onTurnStarted(agentId: string): Promise<unknown> {
    return this.run(async () => {
      await this.ensureStarted();
      await this.observer.onTurnStarted(agentId);
      await this.settle();
    });
  }

  onTurnEnded(agentId: string, outcome: Parameters<Observer['onTurnEnded']>[1], timeline: Parameters<Observer['onTurnEnded']>[2], turnId?: string | null): Promise<unknown> {
    return this.run(async () => {
      await this.ensureStarted();
      const previousEndedAt = this.observer.seat(agentId)?.lastTurn?.endedAt;
      const ended = await this.observer.onTurnEnded(agentId, outcome, timeline, turnId);
      if (ended !== undefined && ended.seat.role === 'lead' && ended.seat.state !== 'archived') {
        const grace = this.deps.settings().delivery.envelopeGraceSeconds * 1_000;
        this.pendingTurns.push({ id: letterId(), leadAgentId: agentId, turn: ended.turn, previousEndedAt, dueAt: ended.turn.endedAt + grace });
        if (grace > 0) setTimeout(() => { void this.run(() => this.settle()); }, grace + 50).unref();
      }
      await this.settle();
    });
  }

  onPermissionRequested(agentId: string, requestId: string): Promise<unknown> {
    return this.run(async () => { await this.ensureStarted(); await this.observer.onPermissionRequested(agentId, requestId); await this.settle(); });
  }

  onPermissionResolved(agentId: string, requestId: string): Promise<unknown> {
    return this.run(async () => { await this.ensureStarted(); await this.observer.onPermissionResolved(agentId, requestId); await this.settle(); });
  }

  /**
   * Re-reads from Paseo every seat it lists, and `also` by id, then settles, so a Human decision about
   * the room rests on fresh facts; false when Paseo could not be read. Unlike a rebuild it forgets no
   * seat: Paseo lists no archived agent, and an archived Lead must stay known for the signals about
   * the seats it left behind.
   */
  async resync(also: readonly string[] = []): Promise<boolean> {
    const done = await this.run(async () => {
      await this.ensureStarted();
      const listed = await this.deps.paseo.listAgents();
      for (const snapshot of listed) await this.observer.upsert(snapshot);
      const seen = new Set(listed.map(snapshot => snapshot.id));
      for (const agentId of also) if (!seen.has(agentId)) await this.observer.onCreated(agentId);
      await this.settle();
      return true;
    });
    return done === true;
  }

  onArchived(agentId: string, archivedAt: string): Promise<unknown> {
    return this.run(async () => { await this.ensureStarted(); this.observer.onArchived(agentId, archivedAt); await this.settle(); });
  }

  /** The periodic pass: refresh stale facts, then settle. */
  async sweep(): Promise<void> {
    if (this.deps.ready !== undefined && !this.deps.ready()) return;
    if (!(await this.ensureStarted().catch(() => false))) return;
    await this.observer.refreshStale(STALE_SNAPSHOT_MS);
    await this.settle();
  }

  /** Processes due Lead turns, re-evaluates conditions and delivers what may go now. */
  async settle(): Promise<void> {
    await this.processDueTurns();
    await this.evaluate();
    await this.delivery.pump();
  }

  // ── Recipients ──────────────────────────────────────────────────────────────────────────────

  supervisorOf(projectKey: string): Resolution {
    return this.portfolio.resolve(projectKey, this.observer);
  }

  private recipientFor(condition: Pick<Condition, 'projectKey' | 'subjects'>): string {
    const subject = condition.subjects[0] === undefined ? undefined : this.observer.seat(condition.subjects[0]);
    // A Supervisor is never told about itself: its own trouble goes to the operator.
    if (subject?.role === 'supervisor') return 'panel';
    return this.supervisorOf(condition.projectKey).supervisorAgentId ?? 'panel';
  }

  private projectName(projectKey: string): string {
    return this.observer.projects().get(projectKey)?.name ?? this.observer.seats().find(seat => seat.project.key === projectKey)?.project.name ?? projectKey;
  }

  private async ledgerProjects(): Promise<ReadonlySet<string>> {
    if (this.ledger !== undefined && this.time - this.ledger.at < LEDGER_CACHE_MS) return this.ledger.keys;
    const stores = await ProjectStore.list(this.deps.runtimeRoot, this.deps.now).catch(() => []);
    this.ledger = { keys: new Set(stores.map(store => store.meta.gitCommonDir)), at: this.time };
    return this.ledger.keys;
  }

  private remember(id: string, item: Item): void {
    this.items.set(id, item);
    keepNewest(this.items, ITEM_MEMORY);
  }

  // ── Conditions → incidents ──────────────────────────────────────────────────────────────────

  private async evaluate(): Promise<void> {
    const settings = this.deps.settings();
    const now = this.time;
    const current = conditions({
      observer: this.observer, delivery: settings.delivery, now, ledgerProjects: await this.ledgerProjects(), budgets: this.contextSettings().budgets,
    });
    const seen = new Set<string>();
    for (const condition of current) {
      seen.add(condition.key);
      const known = this.incidents.get(condition.key);
      if (known !== undefined && (known.closedAt === undefined || now - known.closedAt < REOPEN_MS)) {
        if (known.closedAt === undefined && known.evidence === condition.evidence) {
          // The same incident restated: its text may carry a figure that moved, such as a wait or a context size.
          known.text = condition.text;
          known.summary = condition.summary;
          continue;
        }
        known.closedAt = undefined;
        known.count += 1;
        known.evidence = condition.evidence;
        known.text = condition.text;
        known.summary = condition.summary;
        known.subjects = condition.subjects;
        known.updatedAt = now;
        await this.log.append({ type: 'incident.updated', id: known.id, kind: known.kind, level: known.level, projectKey: known.projectKey, subjects: known.subjects, count: known.count });
        continue;
      }
      const recipient = this.recipientFor(condition);
      const incident: Incident = {
        id: letterId(), key: condition.key, kind: condition.kind, level: condition.level, projectKey: condition.projectKey,
        subjects: condition.subjects, text: condition.text, summary: condition.summary, evidence: condition.evidence, openedAt: now, updatedAt: now, closedAt: undefined, count: 1, recipient,
      };
      this.incidents.set(condition.key, incident);
      this.remember(incident.id, { recipient, projectKey: incident.projectKey, kind: incident.kind });
      await this.log.append({ type: 'incident.opened', id: incident.id, kind: incident.kind, level: incident.level, projectKey: incident.projectKey, subjects: incident.subjects, count: 1, text: mask(incident.text) });
      if (recipient !== 'panel' && settings.letters.enabled) {
        this.delivery.enqueue(recipient, { id: incident.id, level: incident.level, line: `${this.projectName(incident.projectKey)} · ${mask(incident.text)}`, createdAt: now });
      }
    }
    for (const incident of this.incidents.values()) {
      if (incident.closedAt !== undefined || seen.has(incident.key)) continue;
      incident.closedAt = now;
      this.delivery.withdraw(incident.id);
      await this.log.append({ type: 'incident.closed', id: incident.id, kind: incident.kind, level: incident.level, projectKey: incident.projectKey, subjects: incident.subjects, count: incident.count });
    }
    // Forget long-closed incidents so the map stays bounded.
    for (const [key, incident] of this.incidents) if (incident.closedAt !== undefined && now - incident.closedAt > 24 * 60 * 60_000) this.incidents.delete(key);
  }

  // ── Lead turns ──────────────────────────────────────────────────────────────────────────────

  /**
   * Whether Paseo reports this Lead turn to the Supervisor itself. Paseo keeps its finish envelopes
   * out of every timeline, so the evidence is the Supervisor's own prompt: its latest
   * `send_agent_prompt` to this Lead, made after the Lead's previous turn ended, is answered by
   * Paseo at the first finish that follows — this one (attention change-003 D-1).
   */
  private async supervisorPrompted(supervisorAgentId: string, pending: PendingLeadTurn): Promise<boolean> {
    const entries = await this.deps.paseo.recentTimeline(supervisorAgentId, 200).catch(() => []);
    const since = pending.previousEndedAt ?? pending.turn.startedAt - PROMPT_WINDOW_MS;
    const prompt = entries.filter(entry => entry.prompts?.tool === 'send_agent_prompt' && entry.prompts.agentId === pending.leadAgentId)
      .map(entry => ({ at: Date.parse(entry.timestamp), notified: entry.prompts?.notified === true }))
      .filter(entry => !Number.isNaN(entry.at) && entry.at < pending.turn.endedAt)
      .at(-1);
    return prompt !== undefined && prompt.notified && prompt.at > since;
  }

  private async processDueTurns(): Promise<void> {
    const now = this.time;
    const due = this.pendingTurns.filter(turn => turn.dueAt <= now);
    this.pendingTurns = this.pendingTurns.filter(turn => turn.dueAt > now);
    for (const pending of due) await this.processLeadTurn(pending);
  }

  private async processLeadTurn(pending: PendingLeadTurn): Promise<void> {
    const lead = this.observer.seat(pending.leadAgentId);
    if (lead === undefined) return;
    const project = lead.project;
    const record = async (decision: string, reason: string): Promise<void> => {
      await this.log.append({ type: 'lead-turn', id: pending.id, projectKey: project.key, leadAgentId: lead.agentId, decision, reason });
    };
    const supervisor = this.supervisorOf(project.key).supervisorAgentId;
    if (supervisor === undefined) { await record('record', 'no Supervisor for this project'); return; }
    const relayed = this.relayedMarkers.get(lead.agentId) ?? new Set<string>();
    const markers = pending.turn.markers.filter(marker => !relayed.has(markerKey(marker)));
    // A handoff request or a successor's kickoff: the runtime reads that turn itself, and its text
    // never reaches a letter. A marker line in it still goes, quoted alone.
    if (markers.length === 0 && pending.turn.trigger === 'succession') { await record('record', 'the runtime reads a succession turn itself'); return; }
    // Paseo's own report of a prompted turn carries only its last message, so a marker still goes.
    if (markers.length === 0 && await this.supervisorPrompted(supervisor, pending)) { await record('record', 'Paseo reports this turn to the Supervisor that prompted it'); return; }

    // Only this turn's own message: an earlier one would be reported as news (a turn canceled at once has none).
    const message = pending.turn.lastMessage ?? '';
    // A turn that read the Supervisor's `message_lead` and says something answers it. The Supervisor
    // waits for that answer rather than polls, so it goes as a reply: never budgeted, folded into the
    // digest or superseded. A turn cut off before saying anything is news like any other.
    const answers = pending.turn.answersSupervisor && message.trim() !== '';
    const facts: LeadTurnFacts = {
      peersRunning: this.observer.descendants(lead.agentId).filter(seat => seat.state === 'running' || seat.state === 'permission').length,
      permissionPending: lead.pending.size > 0,
    };
    // Lead's own marker lines decide, in code; an answer goes at once, and any other turn is a digest line.
    const triaged: Triaged<Decision | 'page'> = markedLeadTurn(markers) ?? (answers ? ANSWER : BASELINE);
    const level = triaged.decision;
    // A turn of the Lead's own loop that leaves a Peer working is progress (§6.1): it goes with the
    // Supervisor's next letter and never wakes it alone, since a Supervisor almost never acts on one.
    const progress = level === 'digest' && pending.turn.trigger === 'runtime' && facts.peersRunning > 0;
    await record(level, progress ? 'progress: the Lead\'s loop still runs; it goes with the next letter' : triaged.reason);
    // An incident still pages; any other answer is a reply, which goes even with letters off.
    const reply = answers && level !== 'page';
    if (level === 'record' || (!this.deps.settings().letters.enabled && !reply)) return;

    this.remember(pending.id, { recipient: supervisor, projectKey: project.key, kind: 'lead-turn' });
    // The Supervisor needs the Lead's latest state, not every intermediate turn; but only a digest
    // line is superseded, so a later progress turn cannot hide a Human question or an incident.
    const superseded = this.queuedTurn.get(lead.agentId);
    if (superseded !== undefined) this.delivery.withdraw(superseded);
    if (level === 'digest') this.queuedTurn.set(lead.agentId, pending.id);
    else this.queuedTurn.delete(lead.agentId);
    for (const marker of markers) relayed.add(markerKey(marker));
    keepNewest(relayed, RELAYED_MARKERS);
    this.relayedMarkers.set(lead.agentId, relayed);
    let said: string;
    if (markers.length > 0) {
      const quoted = markers.slice(0, LETTER_MARKERS).map(marker => `${marker.kind}: "${head(mask(marker.text), MAX_MARKER_TEXT)}"`);
      if (markers.length > LETTER_MARKERS) quoted.push(`and ${String(markers.length - LETTER_MARKERS)} more marker line(s)`);
      said = ` — ${quoted.join(' · ')}`;
    } else {
      const excerpt = message.trim() === '' ? '(no message in this turn)' : `"${tail(mask(message), reply ? REPLY_EXCERPT : LETTER_EXCERPT)}"`;
      said = `${triaged === BASELINE ? '' : ` [${triaged.reason}]`}: ${excerpt}`;
    }
    this.delivery.enqueue(supervisor, {
      id: pending.id, level,
      line: `${project.name} · ${seatLabel(lead)} ended a turn (${pending.turn.outcome}; ${await this.runningNow(lead, facts)})${said}`,
      createdAt: pending.turn.endedAt,
      ...(reply ? { reply: true } : {}),
      ...(progress ? { rideAlong: true } : {}),
      // A NEEDS-HUMAN line is Lead's own question for Human: the wake budget never delays it (§7.2).
      ...(level === 'now' && markers.length > 0 ? { unbudgeted: true } : {}),
    });
  }

  /**
   * What a Lead left running when its turn ended, counted in code: a Lead that says it will go on
   * with nothing running and nothing open has stopped, which its own words do not show.
   */
  private async runningNow(lead: Seat, facts: LeadTurnFacts): Promise<string> {
    const peers = facts.peersRunning === 0 ? 'no Peer running' : `${String(facts.peersRunning)} Peer${facts.peersRunning === 1 ? '' : 's'} running`;
    const ledger = await this.deps.ledger?.(lead.project.key, lead.agentId).catch(() => undefined);
    if (ledger === undefined || ledger.unreadable !== undefined) return peers;
    const open = ledger.open.length;
    return `${peers}, ${open === 0 ? 'no assignment open' : `${String(open)} assignment${open === 1 ? '' : 's'} open`}`;
  }

  /**
   * Tells a project's Supervisor one fact at digest level, such as a Lead replaced (seat context
   * delta K-D5): a one-off item, not a condition, so it opens no incident. `replyTo` names a
   * Supervisor waiting on its own request instead (K-D9), which Delivery answers as a reply.
   */
  told(projectKey: string, line: string, replyTo?: string): Promise<unknown> {
    return this.run(async () => {
      await this.ensureStarted();
      const recipient = replyTo ?? this.supervisorOf(projectKey).supervisorAgentId;
      if (recipient === undefined || (replyTo === undefined && !this.deps.settings().letters.enabled)) return;
      const id = letterId();
      this.remember(id, { recipient, projectKey, kind: 'fact' });
      const text = `${this.projectName(projectKey)} · ${mask(line)}`;
      this.delivery.enqueue(recipient, replyTo === undefined ? { id, level: 'digest', line: text, createdAt: this.time } : { id, level: 'now', line: text, createdAt: this.time, reply: true });
      await this.delivery.pump();
    });
  }

  // ── Feedback and views ──────────────────────────────────────────────────────────────────────

  /**
   * Records feedback on an incident or letter item, or on every item of a sent letter named by its
   * own id; a Supervisor may only rate its own.
   */
  async feedback(id: string, verdict: Verdict, by: { readonly source: 'human' } | { readonly source: 'supervisor'; readonly agentId: string }): Promise<'recorded' | 'unknown' | 'forbidden'> {
    const letter = this.delivery.sent(id);
    const incidents = new Map([...this.incidents.values()].map(incident => [incident.id, incident]));
    const recipient = letter?.recipient ?? this.items.get(id)?.recipient ?? incidents.get(id)?.recipient;
    if (recipient === undefined) return 'unknown';
    if (by.source === 'supervisor' && recipient !== by.agentId) return 'forbidden';
    for (const entry of letter?.items ?? [id]) {
      const known = incidents.get(entry);
      if (known !== undefined) known.feedback = verdict;
      await this.log.append({ type: 'feedback.recorded', id: entry, verdict, by: by.source === 'human' ? 'human' : by.agentId });
    }
    return 'recorded';
  }

  /** Open incidents, optionally only those addressed to one Supervisor. */
  openIncidents(recipient?: string): readonly Incident[] {
    return [...this.incidents.values()].filter(incident => incident.closedAt === undefined && (recipient === undefined || incident.recipient === recipient));
  }

  /** Project keys whose Supervisor is `supervisorAgentId`. */
  portfolioOf(supervisorAgentId: string): readonly string[] {
    return [...this.observer.projects().keys()].filter(key => this.supervisorOf(key).supervisorAgentId === supervisorAgentId);
  }

  /** The room as the panel and Supervisor tools read it; `only` limits it to some projects. */
  roomView(only?: readonly string[]): RoomView {
    const now = this.time;
    const budgets = this.contextSettings();
    const seatView = (seat: Seat): SeatView => ({
      agentId: seat.agentId, role: seat.role, provider: seat.provider, title: seat.title, model: seat.model, thinking: seat.thinking, state: seat.state, cwd: seat.cwd,
      displayCwd: homeRelative(seat.cwd), workspaceId: seat.workspaceId, parentAgentId: seat.parentAgentId, pendingPermissions: seat.pending.size,
      ...(seat.checkout === undefined ? {} : { checkout: { ...seat.checkout, displayRoot: homeRelative(seat.checkout.root) } }),
      ...(seat.lastTurn === undefined ? {} : {
        lastTurn: { outcome: seat.lastTurn.outcome, endedAgo: age(now - seat.lastTurn.endedAt), endedAt: new Date(seat.lastTurn.endedAt).toISOString() },
      }),
      ...(seat.usage === null ? {} : {
        context: {
          used: seat.usage.used, max: seat.usage.max, percent: contextPercent(seat.usage.used, seat.usage.max),
          // A mark is shown only where it reaches the seat and applies on its window, as hooks and signals apply it.
          rotateAtPercent: appliedMark(rotateMark(budgets, seat.role), seat.usage.max),
          compactAtPercent: appliedMark(compactMarkFor(budgets, seat), seat.usage.max),
        },
      }),
      ...(seat.compaction === undefined ? {} : {
        compaction: {
          lastAt: new Date(seat.compaction.lastAt).toISOString(), lastAgo: age(now - seat.compaction.lastAt), seen: seat.compaction.seen,
          ...(seat.compaction.lastTrigger === undefined ? {} : { lastTrigger: seat.compaction.lastTrigger }),
          ...(seat.compaction.lastPreTokens === undefined ? {} : { lastPreTokens: seat.compaction.lastPreTokens }),
        },
      }),
    });
    const projectKeys = [...this.observer.projects().keys()];
    const projects = [...this.observer.projects().values()]
      .filter(project => only === undefined || only.includes(project.key))
      .map(project => {
        const resolution = this.supervisorOf(project.key);
        const supervisor = resolution.supervisorAgentId === undefined ? undefined : this.observer.seat(resolution.supervisorAgentId);
        return {
          key: project.key, name: project.name, root: project.root, displayRoot: homeRelative(project.root), git: project.git, decidedBy: resolution.decidedBy,
          ...(supervisor === undefined ? {} : { supervisor: seatView(supervisor) }),
          seats: this.observer.seats().filter(seat => seat.project.key === project.key && seat.role !== 'supervisor' && seat.state !== 'archived').map(seatView),
          incidents: this.openIncidents().filter(incident => incident.projectKey === project.key).map(incidentView),
        };
      });
    return {
      started: this.started,
      projects,
      supervisors: this.observer.supervisors().map(seat => ({
        ...seatView(seat), portfolio: projectKeys.filter(key => this.supervisorOf(key).supervisorAgentId === seat.agentId).length,
      })),
      panelIncidents: this.openIncidents('panel').filter(incident => !projects.some(project => project.key === incident.projectKey)).map(incidentView),
    };
  }
}

export interface SeatView {
  readonly agentId: string;
  readonly role: string;
  readonly provider: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly state: string;
  readonly cwd: string;
  readonly displayCwd: string;
  readonly workspaceId: string | null;
  readonly parentAgentId: string | null;
  readonly pendingPermissions: number;
  /** The checkout the seat works in, where Git says: a linked worktree or the main checkout, and its branch. */
  readonly checkout?: Checkout & { readonly displayRoot: string };
  readonly lastTurn?: { readonly outcome: string; readonly endedAgo: string; readonly endedAt: string };
  /**
   * The seat's latest model call, and its role's marks in percent (seat context delta §5.1); the
   * compact mark only where it applies to this seat.
   */
  readonly context?: { readonly used: number; readonly max: number; readonly percent: number; readonly rotateAtPercent: number | null; readonly compactAtPercent: number | null };
  /** Compactions seen since the runtime started. */
  readonly compaction?: { readonly lastAt: string; readonly lastAgo: string; readonly lastTrigger?: 'auto' | 'manual'; readonly lastPreTokens?: number; readonly seen: number };
}

export interface IncidentView {
  readonly id: string;
  readonly kind: string;
  readonly level: string;
  readonly text: string;
  readonly summary: string;
  readonly count: number;
  readonly recipient: string;
  readonly projectKey: string;
  readonly subjects: readonly string[];
  readonly openedAt: string;
  readonly feedback?: Verdict;
}

export interface RoomView {
  readonly started: boolean;
  readonly projects: readonly {
    readonly key: string; readonly name: string; readonly root: string; readonly displayRoot: string; readonly git: boolean; readonly decidedBy: string;
    readonly supervisor?: SeatView; readonly seats: readonly SeatView[]; readonly incidents: readonly IncidentView[];
  }[];
  readonly supervisors: readonly (SeatView & { readonly portfolio: number })[];
  readonly panelIncidents: readonly IncidentView[];
}

function incidentView(incident: Incident): IncidentView {
  return {
    id: incident.id, kind: incident.kind, level: incident.level, text: mask(incident.text), summary: mask(incident.summary), count: incident.count, recipient: incident.recipient,
    projectKey: incident.projectKey, subjects: incident.subjects, openedAt: new Date(incident.openedAt).toISOString(),
    ...(incident.feedback === undefined ? {} : { feedback: incident.feedback }),
  };
}

export { LETTER_PREFIX };
