import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountLetters, accountLine, byDay, finishedAssignments, lastActivity, lettersLine, openAssignments, projectStatus, projectSummary, sortProjects, titleNamesRole, workplace,
  type AssignmentEntry, type ProjectView, type SeatView,
} from '../src/runtime-plugin/client/model.js';
import { dayLabel, duration, whenLabel } from '../src/runtime-plugin/client/time.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { AttentionLog, TALLIED, tallyLetters } from '../src/runtime-plugin/server/attention/log.js';
import type { RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';
import { assignmentTimes, milestones, recentActivity } from '../src/runtime-plugin/server/panel.js';
import { PaseoHandle } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { createRpcHandlers } from '../src/runtime-plugin/server/rpc.js';
import { outcomeGist } from '../src/runtime-plugin/shared/names.js';
import { DEFAULT_ATTENTION_SETTINGS } from '../src/runtime-plugin/shared/attention.js';
import { A, B, HEAD, candidate, created, dispatched, ev, leased } from './runtime-fixtures.js';
import { dispatchAndHandBack, harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(entry => entry.cleanup()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const at = (event: RuntimeEventV1, occurredAt: string): RuntimeEventV1 => ({ ...event, occurredAt });
const data = (answer: unknown): Record<string, unknown> => (answer as { data: Record<string, unknown> }).data;

describe('what the panel reads from a ledger', () => {
  it('times each assignment from its own events, and knows which ran in a worktree', () => {
    const events = [
      at(created(A), '2026-09-22T10:00:00.000Z'),
      ...leased(B, ['src/']).map(event => at(event, '2026-09-22T10:05:00.000Z')),
      at(ev('assignment.accepted', { reason: 'Gate passed.' }, B), '2026-09-22T11:00:00.000Z'),
      at(ev('assignment.close-requested', {}, B), '2026-09-22T11:01:00.000Z'),
      // The runtime telling A's Lead something is not A moving.
      at(ev('notice.pending', { noticeId: 'ntc_AAAAAAAA', kind: 'handback', class: 'owner', disposition: 'lead-now', text: 'x' }, A), '2026-09-22T12:00:00.000Z'),
    ];
    const times = assignmentTimes(events);
    // A is not dispatched, so where it will work is not known yet.
    expect(times.get(A)).toEqual({ createdAt: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-22T10:00:00.000Z' });
    expect(times.get(B)).toEqual({ createdAt: '2026-09-22T10:05:00.000Z', updatedAt: '2026-09-22T11:01:00.000Z', settledAt: '2026-09-22T11:00:00.000Z', isolated: true });
  });

  it('names the steps a reader cares about, and keeps only the major ones for recent activity', () => {
    const events = [
      ...dispatched(A),
      ev('report.accepted', { generation: 1, tool: 'handoff', requestId: 'req_a1', fingerprint: `sha256:${'d'.repeat(64)}`, receipt: { schema: 1, receipt: 'r', tool: 'handoff', status: 'accepted', assignmentState: 'handed-back' }, report: {}, candidate }, A),
      ev('gate.finished', { result: { id: 'gate_1', assignmentId: A, candidate, command: 'npm test', startedAt: '2026-09-22T10:00:00.000Z', exitCode: 1, timedOut: false, termination: 'exited', outputDigest: `sha256:${'e'.repeat(64)}`, workspaceMoved: false, processContractVersion: 1, environmentPolicyVersion: 1 } }, A),
      ev('assignment.rework-requested', { instructions: 'Fix the test.' }, A),
      { ...ev('assignment.abandoned', { reason: 'Superseded.' }, A), actor: { source: 'human' as const } },
    ];
    expect(milestones(events).map(entry => [entry.label, entry.major])).toEqual([
      ['Created', false], ['Dispatched', true], ['Peer started', false], [`Handed back commit ${HEAD.slice(0, 7)}`, true],
      ['Gate failed (exit 1)', true], ['Rework requested', true], ['Abandoned', true],
    ]);
    const recent = recentActivity(events, 3);
    expect(recent.map(entry => entry.label)).toEqual(['Abandoned', 'Rework requested', 'Gate failed (exit 1)']);
    expect(recent[0]).toMatchObject({ assignmentId: A, tone: 'danger', by: 'human' });
  });

  it('answers the project with times and recent activity, and the assignment with its history', async () => {
    const h = await harness();
    open.push(h);
    const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle() });
    const { id } = await dispatchAndHandBack(h, writableBrief(h.base));
    const projectId = (await h.controller.projectFor(h.repo)).meta.projectId;
    const project = data(await rpc.project({ projectId }));
    const [entry] = project.assignments as (AssignmentEntry & { settledAt?: string })[];
    expect(entry).toMatchObject({ id, createdAt: expect.any(String) as unknown, updatedAt: expect.any(String) as unknown, isolated: false });
    expect(entry?.settledAt).toBeUndefined();
    expect((project.activity as { label: string; by: string }[]).map(step => [step.label, step.by])).toEqual([
      [expect.stringMatching(/^Handed back commit [0-9a-f]{7}$/) as unknown, 'peer'], ['Dispatched', 'lead'],
    ]);
    const detail = data(await rpc.assignment({ projectId, assignmentId: id }));
    expect((detail.timeline as { label: string }[]).map(step => step.label)).toEqual(['Created', 'Dispatched', 'Peer started', expect.stringMatching(/^Handed back/) as unknown]);
    expect(detail.createdAt).toEqual(entry?.createdAt);
  });

  it('counts, per project in the room, the open assignments that wait on their Lead', async () => {
    const h = await harness();
    open.push(h);
    const attention = new AttentionEngine({
      paseo: h.paseo, recognition: h.hooks.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot,
      now: () => new Date(), settings: () => DEFAULT_ATTENTION_SETTINGS, log: () => undefined,
    });
    const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle(), attention });
    await dispatchAndHandBack(h, writableBrief(h.base));
    const [project] = data(await rpc.room()).projects as { runtime?: Record<string, unknown> }[];
    expect(project?.runtime).toMatchObject({ assignments: 1, active: 1, undecided: 1, waiting: 1, lastEventAt: expect.any(String) as unknown });
    await h.controller.createAssignment(h.lead, writableBrief(h.base));
    const [again] = data(await rpc.room()).projects as { runtime?: Record<string, unknown> }[];
    // A draft is undecided, as the project's Open tab counts it, but not yet work in flight.
    expect(again?.runtime).toMatchObject({ assignments: 2, active: 1, undecided: 2, waiting: 1 });
  });
});

describe('letters over the last day', () => {
  async function log(now: () => Date) {
    const root = await mkdtemp(join(tmpdir(), 'paseo-room-letters-'));
    roots.push(root);
    await mkdir(join(root, 'attention'), { recursive: true });
    return AttentionLog.at(root, now);
  }

  it('reads back only the window, across day files, and counts each rated item once by its latest verdict', async () => {
    let clock = new Date('2026-09-28T20:00:00.000Z');
    const attention = await log(() => clock);
    await attention.append({ type: 'letter.sent', id: 'ltr_old', level: 'now', items: [] });
    clock = new Date('2026-09-28T23:30:00.000Z');
    await attention.append({ type: 'letter.sent', id: 'ltr_1', level: 'page', items: ['att_1'] });
    await attention.append({ type: 'incident.opened', id: 'att_1', kind: 'permission-waiting', level: 'page', projectKey: 'k', subjects: [], count: 1 });
    clock = new Date('2026-09-29T09:00:00.000Z');
    await attention.append({ type: 'letter.sent', id: 'ltr_2', level: 'digest', items: ['att_2'] });
    await attention.append({ type: 'letter.failed', id: 'ltr_3', level: 'now', items: [], reason: 'busy' });
    await attention.append({ type: 'lead-turn', id: 'lt_1', projectKey: 'k', leadAgentId: 'lead-1', decision: 'now', reason: 'marker' });
    await attention.append({ type: 'lead-turn', id: 'lt_2', projectKey: 'k', leadAgentId: 'lead-1', decision: 'record', reason: 'routine' });
    await attention.append({ type: 'feedback.recorded', id: 'att_1', verdict: 'noise', by: 'human' });
    await attention.append({ type: 'feedback.recorded', id: 'att_1', verdict: 'useful', by: 'human' });
    await attention.append({ type: 'feedback.recorded', id: 'att_2', verdict: 'noise', by: 'sup-1' });
    // A record built with its type after other fields is still read back by its head.
    await attention.append({ id: 'ltr_4', type: 'letter.sent', level: 'now', items: [] });
    await attention.append({ type: 'incident.closed', id: 'att_1', kind: 'permission-waiting', level: 'page', projectKey: 'k', subjects: [], count: 1 });
    clock = new Date('2026-09-29T21:00:00.000Z');
    const recent = await attention.recent(24, TALLIED);
    expect(recent.records.map(record => record.type)).not.toContain('incident.closed');
    expect(recent.partial).toBe(false);
    const tally = tallyLetters(recent.records, 24);
    expect(tally).toEqual({ hours: 24, sent: { page: 1, digest: 1, now: 1 }, failed: 1, incidents: 1, leadTurns: { now: 1, record: 1 }, useful: 1, noise: 1 });
    expect(lettersLine(tally)).toBe('3 letters sent (1 urgent, 1 now, 1 digest) · 1 failed · 1 incident · 2 Lead turns: 1 woke the Supervisor, 1 only recorded · rated 1 useful, 1 noise');
    expect(lettersLine(tallyLetters([], 24))).toBe('No letters sent');
  });

  it('adds the tally to the status the settings screen reads', async () => {
    const clock = new Date('2026-09-29T09:00:00.000Z');
    const attention = await log(() => clock);
    await attention.append({ type: 'letter.sent', id: 'ltr_1', level: 'now', items: [] });
    const status = await createRpcHandlers({
      controller: {} as never, recovery: {} as never, handle: new PaseoHandle(), attention: { log: attention } as unknown as AttentionEngine,
      attentionSettings: { current: DEFAULT_ATTENTION_SETTINGS, available: true },
    }).attentionStatus();
    expect(data(status)).toMatchObject({ settingsAvailable: true, lettersEnabled: true, letters: { hours: 24, sent: { now: 1 } } });
  });
});

describe('the panel\'s lists', () => {
  const seat = (agentId: string, role: string, change: Partial<SeatView> = {}): SeatView => ({
    agentId, role, provider: `claude-${role}`, title: null, state: 'idle', cwd: '/w/shop', displayCwd: '~/w/shop', workspaceId: 'ws-shop',
    parentAgentId: null, pendingPermissions: 0, ...change,
  });
  const project = (name: string, change: Partial<ProjectView> = {}): ProjectView => ({
    key: name, name, root: `/w/${name}`, displayRoot: `~/w/${name}`, git: true, decidedBy: 'parentage', seats: [], incidents: [], ...change,
  });
  const record = { projectId: 'p', health: 'healthy', assignments: 12, active: 3, waiting: 1, findings: 0 };

  it('tells an asleep project from an idle one and one with no live seat', () => {
    expect(projectStatus(project('a', { seats: [seat('lead-1', 'lead', { state: 'closed' })] }))).toBe('asleep');
    expect(projectStatus(project('a', { seats: [seat('lead-1', 'lead', { state: 'closed' }), seat('peer-1', 'peer')] }))).toBe('idle');
    expect(projectStatus(project('a'))).toBe('inactive');
    // Archived seats with dispatched work still undecided keep the project in view; a leftover draft does not.
    expect(projectStatus(project('a', { runtime: { ...record, active: 1, undecided: 1, waiting: 1 } }))).toBe('idle');
    expect(projectStatus(project('a', { runtime: { ...record, active: 0, undecided: 1, waiting: 0 } }))).toBe('inactive');
    expect(projectStatus(project('a', { seats: [seat('lead-1', 'lead', { state: 'running' })] }))).toBe('working');
  });

  it('sums a project up in one line, naming a missing Supervisor only when nothing is in flight', () => {
    const sup = seat('sup-1', 'supervisor');
    expect(projectSummary(project('a', { supervisor: sup, runtime: record, seats: [seat('lead-1', 'lead'), seat('peer-1', 'peer', { state: 'running' }), seat('peer-2', 'peer', { pendingPermissions: 1 })] })))
      .toBe('Lead idle · 1 of 2 Peers working · 3 open · 1 waiting on Lead · 1 permission waiting');
    expect(projectSummary(project('a', { seats: [seat('lead-1', 'lead', { state: 'closed' })] }))).toBe('Lead asleep · no Supervisor');
    expect(projectSummary(project('a', { runtime: { ...record, active: 0, waiting: 0 } }))).toBe('No live seats · 12 assignments recorded');
    expect(projectSummary(project('a', { runtime: { ...record, active: 1, undecided: 1, waiting: 1 } }))).toBe('No live seats · 1 open · 1 waiting on Lead');
    expect(projectSummary(project('a', { supervisor: sup, runtime: { ...record, active: 2, undecided: 3, waiting: 0 }, seats: [seat('lead-1', 'lead')] }))).toBe('Lead idle · 3 open');
  });

  it('lists projects by status, then the most recently active first', () => {
    const turn = (endedAt: string) => ({ outcome: 'completed', endedAgo: '', endedAt });
    const sorted = sortProjects([
      project('zeta', { seats: [seat('l1', 'lead', { lastTurn: turn('2026-09-29T08:00:00.000Z') })] }),
      project('alpha', { seats: [seat('l2', 'lead', { lastTurn: turn('2026-09-29T07:00:00.000Z') })] }),
      project('quiet', { seats: [seat('l3', 'lead', { state: 'closed' })] }),
      project('gone', { runtime: { ...record, active: 0, undecided: 0, waiting: 0, lastEventAt: '2026-09-29T09:00:00.000Z' } }),
      project('busy', { seats: [seat('l4', 'lead', { state: 'running' })] }),
    ]);
    expect(sorted.map(entry => entry.name)).toEqual(['busy', 'zeta', 'alpha', 'quiet', 'gone']);
    expect(lastActivity(sorted[4] as ProjectView)).toBe('2026-09-29T09:00:00.000Z');
  });

  it('orders assignments by when they last moved or settled, and groups finished ones by day', () => {
    const entry = (id: string, state: string, change: Partial<AssignmentEntry> = {}): AssignmentEntry => ({ id, kind: 'engineer', mode: 'writable', outcome: id, state: { value: state }, ...change });
    // Local times, so the day groups hold in every timezone.
    const local = (day: number, hour: number): string => new Date(2026, 8, day, hour).toISOString();
    const entries = [
      entry('first', 'accepted', { settledAt: local(27, 10) }),
      entry('draft', 'draft', { updatedAt: local(29, 11) }),
      entry('active', 'active', { updatedAt: local(29, 9) }),
      entry('asked', 'questioned', { updatedAt: local(29, 10) }),
      entry('latest', 'abandoned', { settledAt: local(29, 8) }),
      entry('middle', 'accepted', { settledAt: local(29, 7) }),
    ];
    expect(openAssignments(entries).map(item => item.id)).toEqual(['asked', 'active', 'draft']);
    const finished = finishedAssignments(entries);
    expect(finished.map(item => item.id)).toEqual(['latest', 'middle', 'first']);
    const now = new Date(2026, 8, 29, 12).getTime();
    expect(byDay(finished, item => item.settledAt, now).map(group => [group.day, group.entries.length])).toEqual([['Today', 2], ['Sun 27 Sep', 1]]);
    // A ledger recorded before times lists its newest last; that one comes first.
    expect(finishedAssignments([entry('old', 'accepted'), entry('new', 'rejected')]).map(item => item.id)).toEqual(['new', 'old']);
    expect([workplace({ mode: 'read-only' }), workplace({ mode: 'writable', isolated: true }), workplace({ mode: 'writable', isolated: false }), workplace({ mode: 'writable' })])
      .toEqual(['read-only', 'worktree', 'main checkout', 'writable']);
    expect(outcomeGist('Bead cmdb-469.2.1 (đọc đầy đủ bằng `br show cmdb-469.2.1` — đó là đặc tả chính)')).toBe('Bead cmdb-469.2.1 (đọc đầy đủ bằng `br show…');
  });

  it('leaves the role out of a seat line only when the title ends with it', () => {
    expect(titleNamesRole({ title: 'cmdb — Lead', role: 'lead' })).toBe(true);
    expect(titleNamesRole({ title: 'Engineer · Fix peer reporting · asg_AAAAAAAA', role: 'peer' })).toBe(false);
    expect(titleNamesRole({ title: 'leaderboard', role: 'lead' })).toBe(false);
    expect(titleNamesRole({ title: null, role: 'peer' })).toBe(false);
  });

  it('says days, times and durations as a list reads them', () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    expect(dayLabel(new Date(2026, 8, 29, 8).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 28, 23).toISOString(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 26, 9).toISOString(), now)).toBe('Sat 26 Sep');
    expect(dayLabel(new Date(2026, 7, 2, 9).toISOString(), now)).toBe('2 Aug');
    expect(dayLabel(new Date(2025, 7, 2, 9).toISOString(), now)).toBe('2 Aug 2025');
    expect(whenLabel(new Date(2026, 8, 29, 8, 5).toISOString(), now)).toBe('08:05');
    expect(whenLabel(new Date(2026, 8, 28, 23, 40).toISOString(), now)).toBe('Yesterday 23:40');
    expect([40_000, 42 * 60_000, 185 * 60_000, 52 * 3_600_000, -1].map(duration)).toEqual(['40 s', '42 min', '3 h 5 min', '2 d 4 h', '']);
  });

  it('shows an account without the personal organization, and letters when seats use more than one', () => {
    const signedIn = (providerId: string, role: string, email: string) => ({ providerId, role, status: 'signed-in', email, plan: 'max', organization: `${email}'s Organization` });
    expect(accountLine(signedIn('claude-lead', 'lead', 'a@example.invalid'))).toBe('a@example.invalid · Max');
    expect(accountLine({ ...signedIn('claude-lead', 'lead', 'a@example.invalid'), organization: 'Acme' })).toBe('a@example.invalid · Max · Acme');
    const seats = [signedIn('claude-supervisor', 'supervisor', 'a@example.invalid'), signedIn('claude-lead', 'lead', 'a@example.invalid'), signedIn('claude-peer', 'peer', 'b@example.invalid')];
    expect([...accountLetters(seats)]).toEqual([['claude-supervisor', 'A'], ['claude-lead', 'A'], ['claude-peer', 'B']]);
    expect(accountLetters(seats.slice(0, 2)).size).toBe(0);
  });
});
