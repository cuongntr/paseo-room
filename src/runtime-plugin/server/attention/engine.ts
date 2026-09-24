/**
 * The attention engine (docs/design/runtime-coordination-attention.md §3): Observer → signals and
 * Lead-turn candidates → triage → delivery, with the log and the portfolio.
 *
 * Work is serialised on one lane, so lifecycle events, the sweep and RPCs never interleave. The
 * engine starts on the first event or call that brings Paseo's handle, and a failed start is
 * retried on the next one. It decides nothing about assignments and writes nothing Paseo owns.
 */
import { homedir } from 'node:os';
import type { AttentionSettings, SensorMode } from '../../shared/attention.js';
import type { GitEvidence } from '../git.js';
import type { PaseoPort } from '../paseo-port.js';
import type { Recognition } from '../recognition.js';
import { ProjectStore } from '../store/project.js';
import { Delivery, LETTER_PREFIX, letterId } from './delivery.js';
import { AttentionLog } from './log.js';
import { mask, tail } from './mask.js';
import { Observer, type Seat, type TurnFacts } from './observer.js';
import { Portfolio, type Resolution } from './portfolio.js';
import { age, conditions, seatLabel, type Condition, type Level, type SignalKind } from './signals.js';
import { BASELINE, assistLeadTurn, type Assessment, type LeadTurnFacts, type Triaged } from './triage.js';

export const SWEEP_MS = 30_000;
const STALE_SNAPSHOT_MS = 5 * 60_000;
const REOPEN_MS = 10 * 60_000;
const LEDGER_CACHE_MS = 60_000;
const ITEM_MEMORY = 500;
const LETTER_EXCERPT = 240;

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

/** The sensor as the engine sees it: implemented in sensor.ts, absent in O1-only wiring. */
export interface SensorHook {
  leadTurn(input: { readonly id: string; readonly message: string; readonly facts: LeadTurnFacts; readonly seatName: string }): Promise<{ readonly assessment: Assessment; readonly mode: Exclude<SensorMode, 'off'>; readonly assist: boolean } | undefined>;
  peerReport?(input: { readonly id: string; readonly brief: string; readonly report: string }): Promise<unknown>;
}

export interface EngineDependencies {
  readonly paseo: PaseoPort;
  readonly recognition: Pick<Recognition, 'recognize'>;
  readonly git: Pick<GitEvidence, 'identity'>;
  readonly runtimeRoot: string;
  readonly now: () => Date;
  readonly settings: () => AttentionSettings;
  readonly sensor?: SensorHook;
  readonly log?: (message: string) => void;
  /** Whether Paseo's handle has arrived; the sweep waits for it rather than failing every pass. */
  readonly ready?: () => boolean;
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
  private readonly quiet = new Map<string, number>();
  /** The queued Lead-turn item of each Lead: a newer turn supersedes it. */
  private readonly queuedTurn = new Map<string, string>();
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
      const seat = await this.observer.onTurnStarted(agentId);
      if (seat !== undefined) this.quiet.delete(seat.project.key);
      await this.settle();
    });
  }

  onTurnEnded(agentId: string, outcome: Parameters<Observer['onTurnEnded']>[1], timeline: Parameters<Observer['onTurnEnded']>[2], turnId?: string | null): Promise<unknown> {
    return this.run(async () => {
      await this.ensureStarted();
      const previousEndedAt = this.observer.seat(agentId)?.lastTurn?.endedAt;
      const ended = await this.observer.onTurnEnded(agentId, outcome, timeline, turnId);
      const sensor = this.deps.sensor;
      if (ended !== undefined && ended.seat.role === 'peer' && ended.turn.outcome === 'completed' && sensor?.peerReport !== undefined) {
        // Shadow only: recorded for evaluation, never applied, so it does not hold the lane.
        const brief = ended.turn.firstMessage ?? '';
        const report = ended.turn.lastMessage ?? '';
        if (brief !== '' && report !== '') void sensor.peerReport({ id: letterId(), brief, report }).catch(() => undefined);
      }
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
    if (this.items.size > ITEM_MEMORY) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }

  // ── Conditions → incidents ──────────────────────────────────────────────────────────────────

  private async evaluate(): Promise<void> {
    const settings = this.deps.settings();
    const now = this.time;
    const current = conditions({
      observer: this.observer, delivery: settings.delivery, now, ledgerProjects: await this.ledgerProjects(), quiet: this.quiet,
    });
    const seen = new Set<string>();
    for (const condition of current) {
      seen.add(condition.key);
      const known = this.incidents.get(condition.key);
      if (known !== undefined && (known.closedAt === undefined || now - known.closedAt < REOPEN_MS)) {
        if (known.closedAt === undefined && known.evidence === condition.evidence) continue;
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
    if (await this.supervisorPrompted(supervisor, pending)) { await record('record', 'Paseo reports this turn to the Supervisor that prompted it'); return; }

    const message = pending.turn.lastMessage ?? await this.observer.lastMessage(lead.agentId) ?? '';
    const facts: LeadTurnFacts = {
      peersRunning: this.observer.descendants(lead.agentId).filter(seat => seat.state === 'running' || seat.state === 'permission').length,
      permissionPending: lead.pending.size > 0,
    };
    let triaged: Triaged = BASELINE;
    if (this.deps.sensor !== undefined && message.trim() !== '') {
      const sensed = await this.deps.sensor.leadTurn({ id: pending.id, message, facts, seatName: `Lead of ${project.name}` }).catch(() => undefined);
      if (sensed !== undefined && sensed.mode === 'assist' && sensed.assist) triaged = assistLeadTurn(sensed.assessment, facts);
    }
    await record(triaged.decision, triaged.reason);
    if (triaged.continuing === true) this.quiet.set(project.key, pending.turn.endedAt);
    else this.quiet.delete(project.key);
    if (triaged.decision === 'record' || !this.deps.settings().letters.enabled) return;

    this.remember(pending.id, { recipient: supervisor, projectKey: project.key, kind: 'lead-turn' });
    // The Supervisor needs the Lead's latest state, not every intermediate turn.
    const superseded = this.queuedTurn.get(lead.agentId);
    if (superseded !== undefined) this.delivery.withdraw(superseded);
    this.queuedTurn.set(lead.agentId, pending.id);
    const reason = triaged === BASELINE ? '' : ` [${triaged.reason}]`;
    const excerpt = message.trim() === '' ? '(no message)' : `"${tail(mask(message), LETTER_EXCERPT)}"`;
    this.delivery.enqueue(supervisor, {
      id: pending.id, level: triaged.decision,
      line: `${project.name} · ${seatLabel(lead)} ended a turn (${pending.turn.outcome})${reason}: ${excerpt}`,
      createdAt: pending.turn.endedAt,
    });
  }

  // ── Feedback and views ──────────────────────────────────────────────────────────────────────

  /** Records feedback on an incident or letter item; a Supervisor may only rate its own. */
  async feedback(id: string, verdict: Verdict, by: { readonly source: 'human' } | { readonly source: 'supervisor'; readonly agentId: string }): Promise<'recorded' | 'unknown' | 'forbidden'> {
    const item = this.items.get(id);
    const incident = [...this.incidents.values()].find(entry => entry.id === id);
    if (item === undefined && incident === undefined) return 'unknown';
    const recipient = item?.recipient ?? incident?.recipient;
    if (by.source === 'supervisor' && recipient !== by.agentId) return 'forbidden';
    if (incident !== undefined) incident.feedback = verdict;
    await this.log.append({ type: 'feedback.recorded', id, verdict, by: by.source === 'human' ? 'human' : by.agentId });
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
    const seatView = (seat: Seat): SeatView => ({
      agentId: seat.agentId, role: seat.role, provider: seat.provider, title: seat.title, state: seat.state, cwd: seat.cwd,
      displayCwd: homeRelative(seat.cwd), parentAgentId: seat.parentAgentId, pendingPermissions: seat.pending.size,
      ...(seat.lastTurn === undefined ? {} : {
        lastTurn: { outcome: seat.lastTurn.outcome, endedAgo: age(now - seat.lastTurn.endedAt), endedAt: new Date(seat.lastTurn.endedAt).toISOString() },
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
  readonly state: string;
  readonly cwd: string;
  readonly displayCwd: string;
  readonly parentAgentId: string | null;
  readonly pendingPermissions: number;
  readonly lastTurn?: { readonly outcome: string; readonly endedAgo: string; readonly endedAt: string };
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
