import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPromptAsset } from '../src/room/prompts.js';
import { DEFAULT_ATTENTION_SETTINGS, type AttentionSettings } from '../src/runtime-plugin/shared/attention.js';
import { MAX_HANDOFF_BYTES } from '../src/runtime-plugin/shared/limits.js';
import { DEFAULT_SEAT_CONTEXT_SETTINGS, type SeatContextSettings } from '../src/runtime-plugin/shared/seat-context.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { SeatStarter } from '../src/runtime-plugin/server/attention/seat-starter.js';
import { controllerLedger, handoffReply, Succession } from '../src/runtime-plugin/server/attention/succession.js';
import { SuccessionStore } from '../src/runtime-plugin/server/attention/succession-store.js';
import { compactMarkEnv, type CompactMarkDependencies } from '../src/runtime-plugin/server/hooks.js';
import { projectLeads } from '../src/runtime-plugin/server/ownership.js';
import { PaseoHandle } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { createRpcHandlers } from '../src/runtime-plugin/server/rpc.js';
import { SUCCESSION_LABEL, type TimelineEntry } from '../src/runtime-plugin/server/paseo-port.js';
import { PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const TEXT = { request: loadPromptAsset('runtime', 'handoffRequest'), kickoff: loadPromptAsset('runtime', 'successorKickoff') };
const MINUTE = 60_000;

let h: Harness;
let clock: Date;
let settings: AttentionSettings;
let engine: AttentionEngine;
let store: SuccessionStore;
let succession: Succession;
let context: SeatContextSettings;

const make = (text: typeof TEXT | null = TEXT): Succession => new Succession({
  paseo: h.paseo, attention: engine, ledger: controllerLedger(h.controller), store, text: text ?? undefined,
  starter: new SeatStarter({ paseo: h.paseo, git: h.controller.deps.git, recognition: h.controller.deps.recognition, attention: engine }),
  contextSettings: () => context, now: () => clock,
});

beforeEach(async () => {
  h = await harness();
  clock = new Date('2026-09-27T08:00:00.000Z');
  context = DEFAULT_SEAT_CONTEXT_SETTINGS;
  settings = { ...DEFAULT_ATTENTION_SETTINGS, delivery: { ...DEFAULT_ATTENTION_SETTINGS.delivery, envelopeGraceSeconds: 0 } };
  const desk = join(h.root, 'desk');
  await mkdir(desk);
  h.paseo.addAgent({ id: 'sup', provider: 'claude-supervisor', cwd: desk, workspaceId: 'ws-desk', title: 'Room Supervisor' });
  const lead = h.paseo.agents.get('lead-1');
  if (lead === undefined) throw new Error('the harness has no Lead');
  lead.title = 'repo — Lead';
  lead.labels = { [PARENT_AGENT_ID_LABEL]: 'sup' };
  engine = new AttentionEngine({
    paseo: h.paseo, recognition: h.controller.deps.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot,
    now: () => clock, settings: () => settings, log: () => undefined,
  });
  store = SuccessionStore.at(h.runtimeRoot, () => clock);
  succession = make();
});
afterEach(async () => { engine.dispose(); await h.cleanup(); });

const agent = (id: string) => {
  const found = h.paseo.agents.get(id);
  if (found === undefined) throw new Error(`no agent ${id}`);
  return found;
};

async function started(note?: string): Promise<string> {
  const result = await succession.start({ leadAgentId: 'lead-1', reason: 'context', ...(note === undefined ? {} : { note }) });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value.successionId;
}

/** Asks for the handoff and has the Lead answer with `entries`. */
async function received(entries: Parameters<Harness['paseo']['reply']>[1] = ['# Handoff\n\nAll verified.']): Promise<string> {
  const id = await started();
  h.paseo.reply('lead-1', entries);
  await succession.onTurnEnded('lead-1');
  return id;
}

async function statusOf(id: string) {
  const status = await succession.status(id);
  if (!status.ok) throw new Error(status.message);
  return status.value;
}

const successors = () => [...h.paseo.agents.values()].filter(entry => entry.provider === 'codex-lead' && entry.id !== 'lead-1');

describe('succession preflight', () => {
  it('finds nothing blocking an idle Lead and names its Supervisor and successor', async () => {
    const found = await succession.preflight('lead-1');
    if (!found.ok) throw new Error(found.message);
    expect(found.value.blockers).toEqual([]);
    expect(found.value.supervisor).toEqual({ agentId: 'sup', title: 'Room Supervisor' });
    expect(found.value.successor).toEqual({ provider: 'codex-lead', model: 'model-x' });
    expect(found.value.project.root).toBe(h.repo);
  });

  it('shows each descendant\'s fate under Paseo\'s archive', async () => {
    h.paseo.addAgent({ id: 'same', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-1', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    h.paseo.addAgent({ id: 'grandchild', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-1', labels: { [PARENT_AGENT_ID_LABEL]: 'same' } });
    h.paseo.addAgent({ id: 'elsewhere', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-2', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    h.paseo.addAgent({ id: 'under-elsewhere', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-2', labels: { [PARENT_AGENT_ID_LABEL]: 'elsewhere' } });
    h.paseo.addAgent({ id: 'watched', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-1', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1', 'paseo.open-agent-tab.client-1': 'true' } });
    const found = await succession.preflight('lead-1');
    if (!found.ok) throw new Error(found.message);
    const fates = Object.fromEntries(found.value.descendants.map(seat => [seat.agentId, [seat.fate, seat.why]]));
    expect(fates).toEqual({
      same: ['archived-with-lead', undefined], grandchild: ['archived-with-lead', undefined],
      elsewhere: ['detached', 'another workspace'], 'under-elsewhere': ['kept', 'its parent stays'], watched: ['detached', 'open in a tab'],
    });
    // The fake archives as Paseo does, so the preflight's account is what happens.
    await h.paseo.archive('lead-1');
    expect(['same', 'grandchild'].map(id => agent(id).archivedAt !== null)).toEqual([true, true]);
    expect(['elsewhere', 'under-elsewhere', 'watched'].map(id => agent(id).archivedAt)).toEqual([null, null, null]);
    expect(agent('elsewhere').labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    expect(agent('under-elsewhere').labels[PARENT_AGENT_ID_LABEL]).toBe('elsewhere');
  });

  it('keeps what Paseo would detach when the Lead is not running, and archives what it showed as archived', async () => {
    h.paseo.addAgent({ id: 'same', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-1', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    h.paseo.addAgent({ id: 'elsewhere', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-2', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    const id = await received();
    // Paseo unloads the Lead while Human reviews: its archive then takes no child with it.
    agent('lead-1').status = 'closed';
    const found = await succession.preflight('lead-1');
    if (!found.ok) throw new Error(found.message);
    expect(found.value.descendants.map(seat => [seat.agentId, seat.fate, seat.why])).toEqual([
      ['same', 'archived-with-lead', undefined], ['elsewhere', 'kept', 'its parent is not running'],
    ]);
    expect((await succession.complete(id, '# Handoff')).ok).toBe(true);
    expect(agent('same').archivedAt).not.toBeNull();
    expect(agent('elsewhere')).toMatchObject({ archivedAt: null, labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
  });

  it('names every blocker with its code, and accepts a closed Lead', async () => {
    agent('lead-1').status = 'closed';
    const clear = await succession.preflight('lead-1');
    expect(clear.ok && clear.value.blockers).toEqual([]);

    agent('lead-1').status = 'running';
    agent('lead-1').activeTurn = true;
    await h.controller.createAssignment(h.lead, writableBrief(h.base));
    h.paseo.addAgent({ id: 'worker', provider: 'codex-peer', cwd: h.repo, status: 'running', activeTurn: true, labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    h.paseo.peerModels['codex-lead'] = null;
    const blocked = await succession.preflight('lead-1');
    if (!blocked.ok) throw new Error(blocked.message);
    expect(blocked.value.blockers.map(blocker => blocker.code)).toEqual(['lead_busy', 'assignments_open', 'descendants_running', 'model_unavailable']);
    expect((await succession.start({ leadAgentId: 'lead-1', reason: 'other' })).ok).toBe(false);
    expect(h.paseo.calls.some(call => call.operation === 'send')).toBe(false);
  });

  it('refuses while a runtime notice to the Lead is undelivered', async () => {
    const store = await h.controller.projectFor(h.repo);
    await h.controller.serial(store.meta.projectId, async () => {
      const loaded = await h.controller.load(store);
      if (!loaded.ok) throw new Error(loaded.message);
      h.paseo.faults.set('send', { when: 'before' });
      await h.controller.notices.notify(loaded.value, { kind: 'test', class: 'owner', disposition: 'lead-now', text: 'hello', recipient: { agentId: 'lead-1', role: 'lead' } });
    });
    const found = await succession.preflight('lead-1');
    expect(found.ok && found.value.blockers.map(blocker => blocker.code)).toEqual(['notices_pending']);
  });

  it('re-reads the room without forgetting an archived Lead whose seats still work', async () => {
    const other = join(h.root, 'other');
    await mkdir(other);
    h.paseo.addAgent({ id: 'lead-2', provider: 'codex-lead', cwd: other, workspaceId: 'ws-other' });
    h.paseo.addAgent({ id: 'worker', provider: 'codex-peer', cwd: other, workspaceId: 'ws-other', status: 'running', activeTurn: true, labels: { [PARENT_AGENT_ID_LABEL]: 'lead-2' } });
    await engine.run(() => engine.sweep());
    // Archived without Paseo's cascade reaching the worker, as when it is not loaded: it keeps running.
    Object.assign(agent('lead-2'), { archivedAt: '2026-09-27T07:59:00.000Z', status: 'closed', activeTurn: false });
    await engine.onArchived('lead-2', '2026-09-27T07:59:00.000Z');
    expect(engine.openIncidents().map(incident => incident.kind)).toEqual(['lead-gone-with-work']);
    expect((await succession.preflight('lead-1')).ok).toBe(true);
    expect(engine.openIncidents().map(incident => incident.kind)).toEqual(['lead-gone-with-work']);
  });

  it('refuses what is not a live room Lead, and everything without the generated text', async () => {
    expect(await succession.preflight('sup')).toMatchObject({ ok: false, code: 'lead_unknown' });
    expect(await succession.preflight('nobody')).toMatchObject({ ok: false, code: 'lead_unknown' });
    expect(await make(null).preflight('lead-1')).toMatchObject({ ok: false, code: 'succession_unavailable' });
  });

  it('refuses on facts it could not read afresh', async () => {
    await engine.run(() => engine.sweep());
    h.paseo.faults.set('listAgents', { when: 'before' });
    expect(await succession.preflight('lead-1')).toMatchObject({ ok: false, code: 'paseo_unavailable' });
  });
});

describe('handoff request', () => {
  it('steers the fixed request, with Human\'s note, into the Lead under its own message id', async () => {
    const id = await started('Include the chart finding.');
    const [prompt] = agent('lead-1').prompts;
    expect(prompt?.behavior).toBe('steer');
    expect(prompt?.messageId).toBe(`succession-request-${id}`);
    expect(prompt?.text).toBe(`[paseo-room succession ${id}]\n\n${TEXT.request}\n\nHuman's note: Include the chart finding.`);
    expect((await statusOf(id)).step).toBe('requested');
    // One replacement per project at a time.
    expect(await succession.start({ leadAgentId: 'lead-1', reason: 'context' })).toMatchObject({ ok: false });
  });

  it('reads the trailing answer whole once the turn ends, and stores it privately', async () => {
    const id = await received(['I will check Git first.', { kind: 'tool' }, '# Handoff\n\nPart one.', 'Part two.']);
    const status = await statusOf(id);
    expect(status.step).toBe('received');
    expect(status.handoff).toBe('# Handoff\n\nPart one.\n\nPart two.');
    expect(status.receivedBytes).toBe(Buffer.byteLength('# Handoff\n\nPart one.\n\nPart two.'));
    const file = join(store.directory, `${id}.handoff.md`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(store.directory, `${id}.json`))).mode & 0o777).toBe(0o600);
    // The log records the step, never the text.
    const log = (await readdir(join(h.runtimeRoot, 'attention', 'log'))).map(name => join(h.runtimeRoot, 'attention', 'log', name));
    const lines = (await Promise.all(log.map(path => readFile(path, 'utf8')))).join('');
    expect(lines).toContain('"type":"succession.handoff-received"');
    expect(lines).not.toContain('Part one');
  });

  it('is read on status too, so a lost turn-end event only delays it', async () => {
    const id = await started();
    h.paseo.reply('lead-1', ['# Handoff']);
    expect((await statusOf(id)).step).toBe('received');
  });

  it('fails a turn with an error, an empty answer, an oversized one, and a request that never appeared', async () => {
    expect((await statusOf(await received([{ kind: 'error', text: 'quota' }]))).failure?.code).toBe('handoff_failed');
    expect((await statusOf(await received([{ kind: 'tool' }]))).failure?.code).toBe('handoff_empty');
    const big = await received(['x'.repeat(MAX_HANDOFF_BYTES + 1)]);
    expect(await statusOf(big)).toMatchObject({ step: 'failed', failure: { code: 'handoff_too_large' } });
    expect(await store.readHandoff(big)).toBeUndefined();

    // A read that fails is not a lost request: the handoff the Lead wrote is still read later.
    const unread = await started();
    h.paseo.reply('lead-1', ['# Handoff']);
    const timeline = agent('lead-1').timeline;
    agent('lead-1').timeline = [];
    h.paseo.timelineOverride = 'unknown';
    clock = new Date(clock.getTime() + 2 * MINUTE);
    expect((await statusOf(unread)).step).toBe('requested');
    agent('lead-1').timeline = timeline;
    delete h.paseo.timelineOverride;
    expect((await statusOf(unread)).step).toBe('received');
    await succession.cancel(unread);

    const lost = await started();
    agent('lead-1').timeline = [];
    agent('lead-1').prompts = [];
    h.paseo.endTurn('lead-1');
    expect((await statusOf(lost)).step).toBe('requested');
    clock = new Date(clock.getTime() + 2 * MINUTE);
    expect((await statusOf(lost)).failure).toEqual({ code: 'handoff_failed', message: 'The request never reached the Lead; ask again.' });
  });

  it('keeps a handoff out of letters and the sensor, while a marker line still goes', async () => {
    let sensed = 0;
    engine = new AttentionEngine({
      paseo: h.paseo, recognition: h.controller.deps.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot, now: () => clock,
      settings: () => settings, log: () => undefined,
      sensor: { leadTurn: () => { sensed += 1; return Promise.resolve(undefined); } },
    });
    const turn = (said: string) => [
      { type: 'user_message' as const, text: '[paseo-room succession suc_AAAAAAAAAAAAAAAA]\n\n## Handoff to Your Successor' },
      { type: 'assistant_message' as const, text: said },
    ];
    const told = (): string => [...engine.delivery.held('sup').map(item => item.line), ...agent('sup').prompts.map(prompt => prompt.text)].join('\n');
    await engine.onTurnEnded('lead-1', { kind: 'completed' }, turn('# Handoff\n\nhost 10.0.0.1, password in vault'));
    expect(told()).toBe('');
    expect(sensed).toBe(0);
    // Steered into a turn already running: the request is not the turn's first message.
    await engine.onTurnEnded('lead-1', { kind: 'completed' }, [{ type: 'user_message' as const, text: 'Earlier work' }, ...turn('# Handoff\n\nhost 10.0.0.2')]);
    expect(told()).toBe('');
    await engine.onTurnEnded('lead-1', { kind: 'completed' }, turn('# Handoff\nNEEDS-HUMAN: Approve the chart change?'));
    expect(told()).toContain('NEEDS-HUMAN: "Approve the chart change?"');
    expect(told()).not.toContain('# Handoff');
    expect(sensed).toBe(0);
  });

  it('resumes a Lead asked for its handoff without a compact mark', async () => {
    h.paseo.windowCatalog['codex-lead/model-x'] = 1_000_000;
    const deps: CompactMarkDependencies = {
      recognition: h.controller.deps.recognition, paseo: h.paseo, settings: () => DEFAULT_SEAT_CONTEXT_SETTINGS,
      exempt: agentId => succession.handingOver(agentId),
    };
    const resume = { agentId: 'lead-1', workspaceId: 'ws-1', provider: 'claude-lead', cwd: h.repo, reason: 'resume' as const, purpose: 'interactive' as const, env: {} };
    agent('lead-1').provider = 'claude-lead';
    h.paseo.windowCatalog['claude-lead/model-x'] = 1_000_000;
    expect((await compactMarkEnv(resume, deps))?.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
    await started();
    expect(await compactMarkEnv(resume, deps)).toBeUndefined();
    h.paseo.reply('lead-1', ['# Handoff']);
    await succession.onTurnEnded('lead-1');
    expect((await compactMarkEnv(resume, deps))?.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
  });
});

describe('handoffReply', () => {
  const entry = (kind: TimelineEntry['kind'], text = '', extra: Partial<TimelineEntry> = {}): TimelineEntry => ({ kind, text, timestamp: 't', ...extra });

  it('takes only the request\'s own turn, after the request', () => {
    const entries = [
      entry('assistant', 'earlier work', { turnId: 't1' }),
      entry('user', 'request', { turnId: 't1', messageId: 'm' }),
      entry('assistant', 'narration', { turnId: 't1' }),
      entry('tool', '', { turnId: 't1' }),
      entry('assistant', 'handoff', { turnId: 't1' }),
      entry('assistant', 'next turn', { turnId: 't2' }),
    ];
    expect(handoffReply(entries, 'm')).toEqual({ kind: 'reply', text: 'handoff' });
    expect(handoffReply(entries, 'other')).toEqual({ kind: 'absent' });
    // Without turn ids, the turn ends at the next user message.
    const unmarked = entries.slice(0, 5).map(({ kind, text, timestamp, messageId }) => ({ kind, text, timestamp, ...(messageId === undefined ? {} : { messageId }) }))
      .concat([entry('user', 'later'), entry('assistant', 'reply to later')]);
    expect(handoffReply(unmarked, 'm')).toEqual({ kind: 'reply', text: 'handoff' });
  });
});

describe('complete', () => {
  it('archives the Lead, creates its successor under the same Supervisor and hands the reviewed handoff over', async () => {
    h.paseo.addAgent({ id: 'helper', provider: 'codex-peer', cwd: h.repo, workspaceId: 'ws-1', labels: { [PARENT_AGENT_ID_LABEL]: 'lead-1' } });
    const id = await received();
    const done = await succession.complete(id, '# Handoff\n\nReviewed by Human.');
    if (!done.ok) throw new Error(`${done.code}: ${done.message}`);
    const successor = agent(done.value.successorAgentId);
    expect(agent('lead-1').archivedAt).not.toBeNull();
    expect(agent('helper').archivedAt).not.toBeNull();
    expect(successor).toMatchObject({ provider: 'codex-lead', title: 'repo — Lead', cwd: h.repo, archivedAt: null });
    expect(successor.labels[PARENT_AGENT_ID_LABEL]).toBe('sup');
    expect(successor.labels[SUCCESSION_LABEL]).toBe(id);
    const [kickoff] = successor.prompts;
    expect(kickoff?.messageId).toBe(`succession-kickoff-${id}`);
    expect(kickoff?.text.startsWith(`[paseo-room succession ${id}] You are the Lead of repo (${h.repo}). Your Supervisor is Room Supervisor (sup).`)).toBe(true);
    expect(kickoff?.text).toContain('Your predecessor repo — Lead (lead-1) handed over; its handoff follows verbatim.');
    expect(kickoff?.text).toContain(TEXT.kickoff);
    expect(kickoff?.text).toContain('----- handoff from repo — Lead (lead-1) -----\n\n# Handoff\n\nReviewed by Human.\n\n----- end of handoff -----');
    expect(await store.readHandoff(id)).toBe('# Handoff\n\nReviewed by Human.');
    expect((await statusOf(id)).step).toBe('completed');

    // No portfolio record, one digest line for the Supervisor, and no page about the gap.
    await expect(stat(join(h.runtimeRoot, 'attention', 'portfolio.json'))).rejects.toThrow();
    expect(engine.delivery.held('sup').map(item => item.line)).toEqual([
      `repo · Lead replaced: repo — Lead (${successor.id}) succeeds repo — Lead (lead-1).`,
    ]);
    await engine.run(() => engine.sweep());
    expect(engine.openIncidents().map(incident => incident.kind)).toEqual([]);
    // Idempotent once done.
    expect(await succession.complete(id, 'anything')).toEqual({ ok: true, value: { successorAgentId: successor.id } });
    expect(successors()).toHaveLength(1);
  });

  it('leaves the project without a Lead between the archive and the creation, and finishes with exactly one successor', async () => {
    const id = await received();
    h.paseo.faults.set('createAgentInWorkspace', { when: 'before' });
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_failed' });
    expect((await statusOf(id)).step).toBe('archived');
    const project = await h.controller.load(await h.controller.projectFor(h.repo));
    if (!project.ok) throw new Error(project.message);
    // message_lead resolves the project's Lead this way: none in the gap, the successor after it.
    expect((await projectLeads(h.controller, project.value)).leadAgentIds).toEqual([]);
    expect((await succession.summaries()).map(summary => [summary.step, summary.canFinish, summary.canCancel])).toEqual([['archived', true, true]]);
    const starter = new SeatStarter({
      paseo: h.paseo, git: h.controller.deps.git, recognition: h.controller.deps.recognition, attention: engine, successionPending: key => succession.pending(key),
    });
    expect(await starter.startProject({ path: h.repo, supervisorAgentId: 'sup', provider: 'codex-lead', idempotencyKey: 'start-project-1' }))
      .toMatchObject({ ok: false, code: 'succession_pending' });

    // The creation's response is lost: the retry replays Paseo's receipt instead of creating twice.
    h.paseo.faults.set('createAgentInWorkspace', { when: 'after' });
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_failed' });
    const done = await succession.complete(id, '# Handoff');
    expect(done.ok).toBe(true);
    expect(successors()).toHaveLength(1);
    expect(successors()[0]?.prompts).toHaveLength(1);
    expect((await projectLeads(h.controller, project.value)).leadAgentIds).toEqual(successors().map(entry => entry.id));
  });

  it('creates no second Lead when another one took the project in the gap', async () => {
    const id = await received();
    h.paseo.faults.set('createAgentInWorkspace', { when: 'before' });
    await succession.complete(id, '# Handoff');
    h.paseo.addAgent({ id: 'lead-other', provider: 'codex-lead', cwd: h.repo, workspaceId: 'ws-1' });
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'lead_exists' });
    expect(successors().map(entry => entry.id)).toEqual(['lead-other']);
  });

  it('resends no kickoff that already arrived, nor one Paseo cannot account for', async () => {
    const id = await received();
    h.paseo.faults.set('run', { when: 'after' });
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_failed' });
    h.paseo.timelineOverride = 'unknown';
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_failed' });
    delete h.paseo.timelineOverride;
    expect((await succession.complete(id, '# Handoff')).ok).toBe(true);
    expect(successors()[0]?.prompts).toHaveLength(1);
  });

  it('never strands a project whose successor cannot take its kickoff', async () => {
    const id = await received();
    h.paseo.faults.set('run', { when: 'before' });
    await succession.complete(id, '# Handoff');
    const [successor] = successors();
    if (successor === undefined) throw new Error('no successor');
    await h.paseo.archive(successor.id);
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'successor_gone' });
    expect(await succession.cancel(id)).toEqual({ ok: true, value: { cancelled: true } });
    expect(await succession.pending((await engine.observer.projectOf(h.repo)).key)).toBe(false);
  });

  it('re-checks at confirmation: a new blocker or another Supervisor archives nothing', async () => {
    const id = await received();
    agent('lead-1').status = 'running';
    agent('lead-1').activeTurn = true;
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'lead_busy' });
    h.paseo.endTurn('lead-1');
    h.paseo.addAgent({ id: 'sup-2', provider: 'claude-supervisor', cwd: join(h.root, 'desk'), workspaceId: 'ws-desk', title: 'Second Supervisor' });
    await engine.run(() => engine.sweep());
    await engine.portfolio.assign((await engine.observer.projectOf(h.repo)).key, 'sup-2');
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_conflict' });
    expect(agent('lead-1').archivedAt).toBeNull();
  });

  it('refuses before the handoff arrives, and an empty review', async () => {
    const id = await started();
    expect(await succession.complete(id, '# Handoff')).toMatchObject({ ok: false, code: 'step_conflict' });
    h.paseo.reply('lead-1', ['# Handoff']);
    expect(await succession.complete(id, '   ')).toMatchObject({ ok: false, code: 'handoff_empty' });
    expect(await succession.complete('suc_BBBBBBBBBBBBBBBB', '# Handoff')).toMatchObject({ ok: false, code: 'succession_unknown' });
  });

  it('takes a Lead Human archived in Paseo after reading its handoff as archived', async () => {
    const id = await received();
    await h.paseo.archive('lead-1');
    const done = await succession.complete(id, '# Handoff');
    expect(done.ok).toBe(true);
    expect(successors()).toHaveLength(1);
  });

  it('resumes from its record in a new process', async () => {
    const id = await received();
    const reloaded = make();
    expect((await reloaded.status(id))).toMatchObject({ ok: true, value: { step: 'received', handoff: '# Handoff\n\nAll verified.' } });
    expect((await reloaded.complete(id, '# Handoff')).ok).toBe(true);
  });
});

describe('a Supervisor replacing its Lead (K-D9)', () => {
  const projectKey = () => join(h.repo, '.git');
  /** The Lead's context as Paseo reports it, read afresh by the room. */
  const usedPercent = async (percent: number): Promise<void> => {
    agent('lead-1').usage = { used: percent * 10_000, max: 1_000_000 };
    await engine.resync(['lead-1']);
  };
  /** What reached the Supervisor, sent or still held for it. */
  const told = (): string => [...agent('sup').prompts.map(prompt => prompt.text), ...engine.delivery.held('sup').map(item => item.line)].join('\n');
  async function startedBySupervisor(note?: string): Promise<string> {
    await usedPercent(45);
    const result = await succession.startForSupervisor('sup', projectKey(), note);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value.successionId;
  }

  it('starts only for the project\'s own Supervisor, and only for a Lead past its rotation mark', async () => {
    await usedPercent(29);
    expect(await succession.startForSupervisor('sup', projectKey())).toMatchObject({ ok: false, code: 'rotation_not_reached' });
    await usedPercent(45);
    expect(await succession.startForSupervisor('another-sup', projectKey())).toMatchObject({ ok: false, code: 'unauthorized' });
    context = { ...context, budgets: { ...context.budgets, lead: { ...context.budgets.lead, rotateAtPercent: null } } };
    expect(await succession.startForSupervisor('sup', projectKey())).toMatchObject({ ok: false, code: 'rotation_off' });
    expect(agent('lead-1').prompts).toEqual([]);

    context = DEFAULT_SEAT_CONTEXT_SETTINGS;
    const id = await startedBySupervisor('Keep the chart finding.');
    expect(agent('lead-1').prompts.at(-1)?.text).toBe(`[paseo-room succession ${id}]\n\n${TEXT.request}\n\nSupervisor's note: Keep the chart finding.`);
    expect(await succession.startedBy(id, 'sup')).toBe(true);
    expect(await succession.startedBy(id, 'another-sup')).toBe(false);
    expect(await succession.summaries()).toEqual([expect.objectContaining({ id, step: 'requested', startedBy: 'supervisor' })]);
  });

  it('still waits for a quiet point', async () => {
    await usedPercent(45);
    agent('lead-1').status = 'running';
    agent('lead-1').activeTurn = true;
    expect(await succession.startForSupervisor('sup', projectKey())).toMatchObject({ ok: false, code: 'lead_busy' });
  });

  it('tells the Supervisor the handoff arrived, and confirms it as it arrived', async () => {
    const id = await startedBySupervisor();
    h.paseo.reply('lead-1', ['# Handoff\n\nChecked against Git.']);
    await succession.onTurnEnded('lead-1');
    expect(told()).toContain(`repo · Lead replacement ${id}: the handoff of repo — Lead (lead-1) arrived, `);
    const done = await succession.complete(id);
    if (!done.ok) throw new Error(`${done.code}: ${done.message}`);
    const successor = agent(done.value.successorAgentId);
    expect(successor.labels[PARENT_AGENT_ID_LABEL]).toBe('sup');
    expect(successor.prompts[0]?.text).toContain('----- handoff from repo — Lead (lead-1) -----\n\n# Handoff\n\nChecked against Git.\n\n----- end of handoff -----');
    expect(agent('lead-1').archivedAt).not.toBeNull();
  });

  it('sends that answer with letters off and past the wake budget, since the Supervisor waits for it', async () => {
    settings = { ...settings, letters: { ...settings.letters, enabled: false }, delivery: { ...settings.delivery, wakesPerHour: 0 } };
    const id = await startedBySupervisor();
    h.paseo.reply('lead-1', ['# Handoff']);
    await succession.onTurnEnded('lead-1');
    expect(agent('sup').prompts.map(prompt => prompt.text).join('\n')).toContain(`repo · Lead replacement ${id}: the handoff of repo — Lead (lead-1) arrived, `);
    expect(engine.delivery.held('sup')).toEqual([]);
  });

  it('tells the Supervisor when no usable handoff arrives', async () => {
    const id = await startedBySupervisor();
    h.paseo.reply('lead-1', ['']);
    await succession.onTurnEnded('lead-1');
    expect(told()).toContain(`repo · Lead replacement ${id} failed: The Lead answered without a handoff; ask again.`);
  });

  it('leaves a replacement Human started to Human', async () => {
    const id = await started();
    expect(await succession.startedBy(id, 'sup')).toBe(false);
    expect((await succession.summaries())[0]).not.toHaveProperty('startedBy');
    h.paseo.reply('lead-1', ['# Handoff']);
    await succession.onTurnEnded('lead-1');
    expect(told()).not.toContain('Lead replacement');
  });
});

describe('cancel', () => {
  it('ends a replacement before its successor exists, and not after', async () => {
    const asked = await started();
    expect(await succession.cancel(asked)).toEqual({ ok: true, value: { cancelled: true } });
    expect(agent('lead-1').archivedAt).toBeNull();
    expect(await succession.cancel(asked)).toEqual({ ok: true, value: { cancelled: true } });
    // The Lead finishes the turn it was asked in; its answer is no longer read.
    h.paseo.reply('lead-1', ['# Handoff']);
    expect((await statusOf(asked)).step).toBe('cancelled');

    const archived = await received();
    h.paseo.faults.set('createAgentInWorkspace', { when: 'before' });
    await succession.complete(archived, '# Handoff');
    expect(await succession.cancel(archived)).toEqual({ ok: true, value: { cancelled: true } });
    expect(await succession.pending((await engine.observer.projectOf(h.repo)).key)).toBe(false);
    expect(await succession.summaries()).toEqual([]);
    expect(await store.readHandoff(archived)).toBe('# Handoff');
  });

  it('dismisses a failed replacement, and refuses only once one is complete', async () => {
    const failed = await received([{ kind: 'tool' }]);
    expect((await succession.summaries()).map(summary => [summary.id, summary.step])).toEqual([[failed, 'failed']]);
    await succession.cancel(failed);
    expect(await succession.summaries()).toEqual([]);

    const id = await received();
    expect((await succession.complete(id, '# Handoff')).ok).toBe(true);
    expect(await succession.cancel(id)).toMatchObject({ ok: false, code: 'step_conflict' });
  });
});

describe('room summaries', () => {
  it('show a failed replacement for a day, or until a newer one starts', async () => {
    const failed = await received([{ kind: 'tool' }]);
    expect((await succession.summaries()).map(summary => [summary.id, summary.canCancel])).toEqual([[failed, true]]);
    clock = new Date(clock.getTime() + 25 * 60 * MINUTE);
    expect(await succession.summaries()).toEqual([]);
    clock = new Date(clock.getTime() - 25 * 60 * MINUTE);
    const next = await started();
    expect((await succession.summaries()).map(summary => [summary.id, summary.step])).toEqual([[next, 'requested']]);
  });

  it('read a handoff in the background without waiting for it', async () => {
    const id = await started();
    h.paseo.reply('lead-1', ['# Handoff']);
    // Answered from what is recorded; the handoff is read behind it.
    expect((await succession.summaries())[0]?.step).toBe('requested');
    await succession.status(id);
    expect((await succession.summaries())[0]?.step).toBe('received');
  });
});

describe('succession records', () => {
  it('prunes finished records after the retention window and keeps one that waits', async () => {
    const done = await received();
    await succession.cancel(done);
    const waiting = await received();
    h.paseo.faults.set('createAgentInWorkspace', { when: 'before' });
    await succession.complete(waiting, '# Handoff');
    await writeFile(join(store.directory, `${waiting}.json.tmp-1-abcd`), '{');
    await writeFile(join(store.directory, 'suc_CCCCCCCCCCCCCCCC.json'), '{ not json');
    clock = new Date(clock.getTime() + 31 * 24 * 60 * MINUTE);
    expect(await store.prune()).toBe(1);
    expect((await store.list()).map(record => record.id)).toEqual([waiting]);
    expect(await store.readHandoff(done)).toBeUndefined();
  });
});

describe('runtime.room', () => {
  it('shows a replacement waiting to be finished on its project, even once the project has no seat', async () => {
    const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle(), attention: engine, succession });
    const id = await received();
    h.paseo.faults.set('createAgentInWorkspace', { when: 'before' });
    await succession.complete(id, '# Handoff');
    const projects = async () => ((await rpc.room()) as { data: { projects: { root: string; succession?: { id: string; step: string; canFinish: boolean } }[] } }).data.projects;
    expect((await projects()).find(project => project.root === h.repo)?.succession).toMatchObject({ id, step: 'archived', canFinish: true });
    // After a restart the Observer knows only what Paseo lists, and it lists no archived agent.
    h.paseo.agents.delete('lead-1');
    engine.dispose();
    engine = new AttentionEngine({
      paseo: h.paseo, recognition: h.controller.deps.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot, now: () => clock, settings: () => settings, log: () => undefined,
    });
    const restarted = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle(), attention: engine, succession: make() });
    const listed = ((await restarted.room()) as { data: { projects: { root: string; seats: unknown[]; succession?: { id: string } }[] } }).data.projects.filter(project => project.root === h.repo);
    expect(listed.map(project => [project.seats.length, project.succession?.id])).toEqual([[0, id]]);
  });
});
