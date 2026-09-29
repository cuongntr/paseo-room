import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { DEFAULT_ATTENTION_SETTINGS, type AttentionSettings } from '../src/runtime-plugin/shared/attention.js';
import {
  COMPACT_WINDOW_ENV, DEFAULT_SEAT_CONTEXT_SETTINGS, appliedMark, contextPercent, formatTokens, markTokens, seatContextSettingsSchema, type SeatContextSettings,
} from '../src/runtime-plugin/shared/seat-context.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { Observer } from '../src/runtime-plugin/server/attention/observer.js';
import { GitEvidence } from '../src/runtime-plugin/server/git.js';
import { CORRELATION_ENV, compactMarkEnv, compactMarkOnCreate, type AgentCreateRequest, type CompactMarkDependencies } from '../src/runtime-plugin/server/hooks.js';
import { toSnapshot, toTimelineEntry } from '../src/runtime-plugin/server/paseo-port.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';
import { FakePaseo, PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';

const MINUTE = 60_000;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let clock: Date;
let paseo: FakePaseo;
let recognition: Recognition;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-seat-context-')));
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, 'generated'), { recursive: true });
  await writeFile(join(plugin, 'generated', 'room-manifest.json'), renderRuntimeManifestFile(['codex', 'claude'], ROLES));
  recognition = new Recognition(plugin);
  await recognition.load();
  paseo = new FakePaseo();
  clock = new Date('2026-09-26T08:00:00.000Z');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A Git repository and a folder outside it, for the tests that observe seats in projects. */
async function projects(): Promise<void> {
  repo = join(root, 'shop');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  await mkdir(join(root, 'desk'));
}

const advance = (ms: number): void => { clock = new Date(clock.getTime() + ms); };

function budgets(change: (draft: SeatContextSettings['budgets']) => void): SeatContextSettings {
  const draft = structuredClone(DEFAULT_SEAT_CONTEXT_SETTINGS);
  change(draft.budgets);
  return seatContextSettingsSchema.parse(draft);
}

describe('seat context settings', () => {
  it('defaults the Lead to rotate at 30% and compact at 50%, every other role off', () => {
    expect(DEFAULT_SEAT_CONTEXT_SETTINGS.budgets).toEqual({
      lead: { rotateAtPercent: 30, compactAtPercent: 50 }, supervisor: { compactAtPercent: null }, peer: { compactAtPercent: null },
    });
    expect(seatContextSettingsSchema.parse({ budgets: { lead: { rotateAtPercent: null } } }).budgets.lead).toEqual({ rotateAtPercent: null, compactAtPercent: 50 });
  });

  it('accepts whole percents from 10 to 95, and a rotation mark only below the compact mark', () => {
    const parse = (lead: unknown) => seatContextSettingsSchema.safeParse({ budgets: { lead } }).success;
    expect(parse({ rotateAtPercent: 10, compactAtPercent: 95 })).toBe(true);
    expect(parse({ rotateAtPercent: 9 })).toBe(false);
    expect(parse({ compactAtPercent: 96 })).toBe(false);
    expect(parse({ compactAtPercent: 50.5 })).toBe(false);
    expect(parse({ rotateAtPercent: 50, compactAtPercent: 50 })).toBe(false);
    expect(parse({ rotateAtPercent: 60, compactAtPercent: null })).toBe(true);
    expect(seatContextSettingsSchema.safeParse({ budgets: { supervisor: { compactAtPercent: 5 } } }).success).toBe(false);
  });

  it('converts a mark to tokens against the model window, rounded down, never below 150k', () => {
    expect(markTokens(50, 1_000_000)).toBe(500_000);
    expect(markTokens(29, 1_000_000)).toBe(290_000);
    expect(markTokens(15, 1_000_000)).toBe(150_000);
    expect(markTokens(14, 1_000_000)).toBeUndefined();
    expect(markTokens(60, 272_000)).toBe(163_000);
    expect(markTokens(40, 272_000)).toBeUndefined();
    expect(markTokens(75, 200_000)).toBe(150_000);
    expect(markTokens(50, 200_000)).toBeUndefined();
    expect(markTokens(75, 199_999)).toBeUndefined();
    expect(markTokens(50, 333_333)).toBe(166_000);
    expect(markTokens(50, undefined)).toBeUndefined();
    expect(markTokens(50, 0)).toBeUndefined();
    expect(markTokens(50, Number.NaN)).toBeUndefined();
  });

  it('keeps a mark only on a window it applies on', () => {
    expect(appliedMark(30, 1_000_000)).toBe(30);
    expect(appliedMark(30, 272_000)).toBeNull();
    expect(appliedMark(null, 1_000_000)).toBeNull();
    expect(appliedMark(30, undefined)).toBeNull();
  });

  it('shows a percent that has reached a mark only once it has, and tokens as people say them', () => {
    expect(contextPercent(299_999, 1_000_000)).toBe(29);
    expect(contextPercent(300_000, 1_000_000)).toBe(30);
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(312_456)).toBe('312k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});

describe('Claude compact mark at session open', () => {
  const open = (provider: string, reason: PluginSessionOpenRequest['reason'] = 'resume', extra: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest => ({
    agentId: 'agent-1', workspaceId: 'ws-1', provider, cwd: '/repo', reason, purpose: 'interactive', env: { [CORRELATION_ENV]: 'cor_x' }, ...extra,
  });
  const deps = (settings = DEFAULT_SEAT_CONTEXT_SETTINGS, logged: string[] = []): CompactMarkDependencies => ({
    recognition, paseo, settings: () => settings, log: message => { logged.push(message); },
  });

  beforeEach(() => {
    paseo.windowCatalog['claude-lead/claude-opus-5-5'] = 1_000_000;
    paseo.windowCatalog['claude-lead/claude-sonnet-5'] = 200_000;
    paseo.windowCatalog['claude-supervisor/claude-opus-5-5'] = 1_000_000;
    paseo.windowCatalog['codex-lead/gpt-5'] = 400_000;
  });

  it('gives an exact room Claude Lead its window on a resume, from the agent\'s own model, keeping the rest', async () => {
    paseo.addAgent({ id: 'agent-1', provider: 'claude-lead', model: 'claude-opus-5-5' });
    paseo.peerModels['claude-lead'] = 'claude-sonnet-5';
    const result = await compactMarkEnv(open('claude-lead'), deps());
    expect(result?.env).toEqual({ [CORRELATION_ENV]: 'cor_x', [COMPACT_WINDOW_ENV]: '500000' });
    expect(result).toMatchObject({ agentId: 'agent-1', provider: 'claude-lead', reason: 'resume', purpose: 'interactive', cwd: '/repo' });
  });

  it('leaves a session opened for creation to the creation hook, and falls back to the profile for an agent Paseo does not know', async () => {
    paseo.peerModels['claude-lead'] = 'claude-sonnet-5';
    expect(await compactMarkEnv(open('claude-lead', 'create'), deps())).toBeUndefined();
    expect(paseo.calls).toEqual([]);
    // The profile's 200k model: 80% of it is 160k.
    const settings = budgets(draft => { draft.lead.compactAtPercent = 80; });
    expect((await compactMarkEnv(open('claude-lead', 'refresh'), deps(settings)))?.env[COMPACT_WINDOW_ENV]).toBe('160000');
    expect((await compactMarkEnv(open('claude-lead', 'import'), deps(settings)))?.env[COMPACT_WINDOW_ENV]).toBe('160000');
  });

  it('leaves every other session exactly as it is', async () => {
    const agent = paseo.addAgent({ id: 'agent-1', provider: 'claude-lead', model: 'claude-opus-5-5' });
    // Codex, a foreign provider, a role without a mark, a history session, a value already set.
    expect(await compactMarkEnv(open('codex-lead'), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude'), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude-supervisor'), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude-lead', 'resume', { purpose: 'history' }), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude-lead', 'resume', { env: { [COMPACT_WINDOW_ENV]: '300000' } }), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude-lead'), deps(budgets(draft => { draft.lead.compactAtPercent = null; })))).toBeUndefined();
    // A mark below 150k on this model (the default 50% of 200k is 100k, 70% is 140k), and a model Paseo lists no window for.
    agent.model = 'claude-sonnet-5';
    expect(await compactMarkEnv(open('claude-lead'), deps())).toBeUndefined();
    expect(await compactMarkEnv(open('claude-lead'), deps(budgets(draft => { draft.lead.compactAtPercent = 70; })))).toBeUndefined();
    agent.model = 'claude-unlisted';
    expect(await compactMarkEnv(open('claude-lead'), deps())).toBeUndefined();
  });

  it('gives a Supervisor its own mark when the operator sets one', async () => {
    paseo.addAgent({ id: 'agent-1', provider: 'claude-supervisor', model: 'claude-opus-5-5' });
    const settings = budgets(draft => { draft.supervisor.compactAtPercent = 70; });
    expect((await compactMarkEnv(open('claude-supervisor'), deps(settings)))?.env[COMPACT_WINDOW_ENV]).toBe('700000');
  });

  it('never fails a session open over a budget, nor waits long on the lookup', async () => {
    paseo.addAgent({ id: 'agent-1', provider: 'claude-lead', model: 'claude-opus-5-5' });
    paseo.faults.set('getAgent', { when: 'before', error: new Error('socket closed') });
    const logged: string[] = [];
    expect(await compactMarkEnv(open('claude-lead'), deps(DEFAULT_SEAT_CONTEXT_SETTINGS, logged))).toBeUndefined();
    expect(logged).toEqual(['No compact mark for agent agent-1: socket closed']);

    // A model list that waits for a provider's warm-up: Paseo would fail the open after 30 s.
    paseo.modelWindow = () => new Promise(() => undefined);
    expect(await compactMarkEnv(open('claude-lead'), { ...deps(DEFAULT_SEAT_CONTEXT_SETTINGS, logged), lookupMs: 20 })).toBeUndefined();
    expect(logged.at(-1)).toBe('No compact mark for agent agent-1: the lookup took longer than 20 ms');
    // So does a settings store that does not answer.
    expect(await compactMarkOnCreate({ config: { provider: 'claude-lead', cwd: '/repo', model: 'claude-opus-5-5' } },
      { ...deps(), lookupMs: 20, settingsRead: () => new Promise(() => undefined) })).toBeUndefined();
  });

  it('sets the mark at creation from the model the agent is created with', async () => {
    paseo.peerModels['claude-lead'] = 'claude-sonnet-5';
    const create = (model?: string, env?: Record<string, string>): AgentCreateRequest => ({
      config: { provider: 'claude-lead', cwd: '/repo', ...(model === undefined ? {} : { model }) }, ...(env === undefined ? {} : { env }),
    });
    // Chosen in Paseo over the profile's 200k model: its own 1M window counts.
    expect((await compactMarkOnCreate(create('claude-opus-5-5', { KEEP: '1' }), deps()))?.env).toEqual({ KEEP: '1', [COMPACT_WINDOW_ENV]: '500000' });
    // The profile's 200k model: the default 50% comes to 100k, below the floor, and 80% to 160k.
    expect(await compactMarkOnCreate(create(), deps())).toBeUndefined();
    expect((await compactMarkOnCreate(create(), deps(budgets(draft => { draft.lead.compactAtPercent = 80; }))))?.env).toEqual({ [COMPACT_WINDOW_ENV]: '160000' });
    expect(await compactMarkOnCreate(create('claude-opus-5-5', { [COMPACT_WINDOW_ENV]: '300000' }), deps())).toBeUndefined();
    expect(await compactMarkOnCreate({ config: { provider: 'claude-lead', cwd: '/repo', model: 'claude-opus-5-5', internal: true } }, deps())).toBeUndefined();
    expect(await compactMarkOnCreate({ config: { provider: 'codex-lead', cwd: '/repo', model: 'gpt-5' } }, deps())).toBeUndefined();
  });
});

describe('Paseo usage and compactions', () => {
  beforeEach(projects);

  it('reads the context of the latest call, never the summed cached input', () => {
    const raw = {
      id: 'a', provider: 'claude-lead', model: 'claude-opus-5-5', cwd: '/repo', status: 'idle', labels: {}, pendingPermissions: [], updatedAt: '', lastUserMessageAt: null,
      lastUsage: { inputTokens: 2, cachedInputTokens: 798_966, outputTokens: 365, contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 133_663 },
    } as unknown as Parameters<typeof toSnapshot>[0];
    expect(toSnapshot(raw).usage).toEqual({ used: 133_663, max: 1_000_000 });
    expect(toSnapshot({ ...raw, lastUsage: { cachedInputTokens: 10 } }).usage).toBeNull();
    expect(toSnapshot({ ...raw, lastUsage: undefined }).usage).toBeNull();
  });

  it('keeps a completed compaction with its trigger and size, and nothing of one still running', () => {
    expect(toTimelineEntry({ type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 498_000 }, 't', 'turn-1'))
      .toEqual({ kind: 'compaction', text: '', timestamp: 't', turnId: 'turn-1', compaction: { trigger: 'auto', preTokens: 498_000 } });
    expect(toTimelineEntry({ type: 'compaction', status: 'completed' }, 't')).toEqual({ kind: 'compaction', text: '', timestamp: 't', compaction: {} });
    expect(toTimelineEntry({ type: 'compaction', status: 'loading' }, 't').kind).toBe('other');
  });

  it('reads a Lead\'s context at its turn end, counts its compactions, and keeps the figure a resumed session lacks', async () => {
    const lead = paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, usage: { used: 120_000, max: 1_000_000 } });
    const room = new Observer({ paseo, recognition, git: new GitEvidence(), now: () => clock });
    await room.rebuild();
    expect(room.seat('lead')?.usage).toEqual({ used: 120_000, max: 1_000_000 });

    lead.usage = { used: 180_000, max: 1_000_000 };
    lead.timeline = [
      { kind: 'user', text: 'Continue', timestamp: '2026-09-26T08:00:00.000Z', turnId: 't1' },
      { kind: 'compaction', text: '', timestamp: '2026-09-26T08:01:00.000Z', turnId: 't1', compaction: { trigger: 'auto', preTokens: 498_000 } },
      { kind: 'assistant', text: 'Done.', timestamp: '2026-09-26T08:02:00.000Z', turnId: 't1' },
    ];
    await room.onTurnEnded('lead', { kind: 'completed' }, [], 't1');
    expect(room.seat('lead')?.usage).toEqual({ used: 180_000, max: 1_000_000 });
    expect(room.seat('lead')?.compaction).toEqual({ lastAt: Date.parse('2026-09-26T08:01:00.000Z'), lastTrigger: 'auto', lastPreTokens: 498_000, seen: 1 });

    // A turn without a boundary counts no compaction from the whole timeline it is given.
    await room.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'compaction', status: 'completed', trigger: 'manual' }, { type: 'assistant_message', text: 'x' }]);
    expect(room.seat('lead')?.compaction?.seen).toBe(1);

    lead.usage = null;
    await room.rebuild();
    expect(room.seat('lead')?.usage).toEqual({ used: 180_000, max: 1_000_000 });
  });

  it('reads a seat first seen at its turn end once', async () => {
    paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, usage: { used: 120_000, max: 1_000_000 } });
    const room = new Observer({ paseo, recognition, git: new GitEvidence(), now: () => clock });
    await room.onTurnEnded('lead', { kind: 'completed' }, []);
    expect(room.seat('lead')?.usage).toEqual({ used: 120_000, max: 1_000_000 });
    expect(paseo.calls.filter(call => call.operation === 'getAgent')).toHaveLength(1);
  });

  it('leaves a Peer\'s figure to the stale sweep', async () => {
    const peer = paseo.addAgent({ id: 'peer', provider: 'codex-peer', cwd: repo, usage: { used: 10_000, max: 400_000 } });
    const room = new Observer({ paseo, recognition, git: new GitEvidence(), now: () => clock });
    await room.rebuild();
    peer.usage = { used: 90_000, max: 400_000 };
    await room.onTurnEnded('peer', { kind: 'completed' }, []);
    expect(room.seat('peer')?.usage).toEqual({ used: 10_000, max: 400_000 });
    expect(paseo.calls.filter(call => call.operation === 'getAgent')).toEqual([]);
  });
});

describe('context-high', () => {
  let attention: AttentionSettings;
  let context: SeatContextSettings;
  let engine: AttentionEngine;

  beforeEach(async () => {
    await projects();
    attention = structuredClone(DEFAULT_ATTENTION_SETTINGS);
    (attention.delivery as { envelopeGraceSeconds: number }).envelopeGraceSeconds = 0;
    context = DEFAULT_SEAT_CONTEXT_SETTINGS;
    paseo.addAgent({ id: 'sup', provider: 'claude-supervisor', cwd: join(root, 'desk'), title: 'Room Supervisor' });
    paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, title: 'shop — Lead', labels: { [PARENT_AGENT_ID_LABEL]: 'sup' }, usage: { used: 120_000, max: 1_000_000 } });
    engine = new AttentionEngine({
      paseo, recognition, git: new GitEvidence(), runtimeRoot: join(root, 'runtime', 'v1'), now: () => clock,
      settings: () => attention, contextSettings: () => context, log: () => undefined,
    });
  });
  afterEach(() => { engine.dispose(); });

  const settle = async (): Promise<void> => { await engine.run(() => engine.sweep()); };
  const leadTurn = async (used: number): Promise<void> => {
    const lead = paseo.agents.get('lead');
    if (lead !== undefined) lead.usage = { used, max: 1_000_000 };
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'progress' }]);
  };
  /** Lines of every letter the Supervisor received that report the Lead's context. */
  const contextLines = (): string[] => (paseo.agents.get('sup')?.prompts ?? []).flatMap(prompt => prompt.text.split('\n')).filter(line => line.includes('rotation mark'));
  const open = () => engine.openIncidents().filter(incident => incident.kind === 'context-high');

  it('tells the Supervisor once when a Lead crosses its rotation mark, restating the figure as it grows', async () => {
    await settle();
    await leadTurn(290_000);
    expect(open()).toEqual([]);
    await leadTurn(312_000);
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({ level: 'digest', recipient: 'sup', subjects: ['lead'], count: 1, summary: 'shop — Lead has used 31% of its context (312k of 1M), past the 30% rotation mark.' });
    advance(20 * MINUTE);
    await settle();
    expect(contextLines()).toEqual([expect.stringMatching(/shop · lead shop — Lead \(lead\) has used 31% of its context \(312k of 1M\), past the 30% rotation mark\./)]);

    await leadTurn(355_000);
    advance(20 * MINUTE);
    await settle();
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({ count: 1, summary: 'shop — Lead has used 35% of its context (355k of 1M), past the 30% rotation mark.' });
    expect(contextLines()).toHaveLength(1);

    // A compaction brings the context below the mark and closes the incident.
    const lead = paseo.agents.get('lead');
    lead?.timeline.push({ kind: 'compaction', text: '', timestamp: clock.toISOString(), turnId: 't9', compaction: { trigger: 'auto', preTokens: 498_000 } });
    if (lead !== undefined) lead.usage = { used: 60_000, max: 1_000_000 };
    await engine.onTurnEnded('lead', { kind: 'completed' }, [], 't9');
    expect(open()).toEqual([]);
    const view = engine.roomView().projects[0]?.seats.find(seat => seat.agentId === 'lead');
    expect(view?.context).toEqual({ used: 60_000, max: 1_000_000, percent: 6, rotateAtPercent: 30, compactAtPercent: 50 });
    expect(view?.compaction).toEqual({ lastAt: clock.toISOString(), lastAgo: '0 min', lastTrigger: 'auto', lastPreTokens: 498_000, seen: 1 });
  });

  it('shows a mark only on a seat it reaches and whose window it applies on', async () => {
    paseo.addAgent({ id: 'codex', provider: 'codex-lead', cwd: join(root, 'desk'), usage: { used: 330_000, max: 600_000 } });
    paseo.addAgent({ id: 'small', provider: 'claude-lead', cwd: join(root, 'desk'), usage: { used: 120_000, max: 200_000 } });
    await settle();
    const seats = engine.roomView().projects.flatMap(project => project.seats);
    const marks = (agentId: string) => seats.find(seat => seat.agentId === agentId)?.context;
    expect(marks('lead')).toMatchObject({ rotateAtPercent: 30, compactAtPercent: 50 });
    // Codex keeps its own compaction; on a 200k window 30% and 50% come to 60k and 100k, below the 150k floor.
    expect(marks('codex')).toMatchObject({ percent: 55, rotateAtPercent: 30, compactAtPercent: null });
    expect(marks('small')).toMatchObject({ percent: 60, rotateAtPercent: null, compactAtPercent: null });
  });

  it('never reports a Lead on a window its mark does not apply on', async () => {
    paseo.addAgent({ id: 'small', provider: 'codex-lead', cwd: join(root, 'desk'), title: 'desk — Lead', usage: { used: 200_000, max: 272_000 } });
    await engine.onCreated('small');
    await settle();
    expect(open()).toEqual([]);
    // Raised to 60%, the mark comes to 163k there and applies.
    context = seatContextSettingsSchema.parse({ budgets: { lead: { rotateAtPercent: 60, compactAtPercent: null } } });
    await settle();
    expect(open()).toMatchObject([{ subjects: ['small'] }]);
  });

  it('closes when the Lead is archived, tells the panel when there is no Supervisor, and stays silent with no mark', async () => {
    await settle();
    await leadTurn(400_000);
    expect(open()).toHaveLength(1);
    await engine.onArchived('lead', '2026-09-26T09:00:00.000Z');
    expect(open()).toEqual([]);

    paseo.addAgent({ id: 'orphan', provider: 'claude-lead', cwd: join(root, 'desk'), title: 'desk — Lead', usage: { used: 400_000, max: 1_000_000 } });
    await engine.onCreated('orphan');
    expect(open()).toMatchObject([{ recipient: 'panel', subjects: ['orphan'] }]);

    context = seatContextSettingsSchema.parse({ budgets: { lead: { rotateAtPercent: null } } });
    await settle();
    expect(open()).toEqual([]);
  });
});
