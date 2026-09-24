import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { Observer, errorKey, triggerOf } from '../src/runtime-plugin/server/attention/observer.js';
import { Portfolio } from '../src/runtime-plugin/server/attention/portfolio.js';
import { GitEvidence } from '../src/runtime-plugin/server/git.js';
import { toTimelineEntry } from '../src/runtime-plugin/server/paseo-port.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';
import { FakePaseo, PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';

let root: string;
let repo: string;
let clock: Date;
let paseo: FakePaseo;
let recognition: Recognition;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-observer-')));
  repo = join(root, 'shop');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, 'generated'), { recursive: true });
  await writeFile(join(plugin, 'generated', 'room-manifest.json'), renderRuntimeManifestFile(['codex', 'claude'], ROLES));
  recognition = new Recognition(plugin);
  await recognition.load();
  paseo = new FakePaseo();
  clock = new Date('2026-09-24T08:00:00.000Z');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const observer = (): Observer => new Observer({ paseo, recognition, git: new GitEvidence(), now: () => clock });
const advance = (ms: number): void => { clock = new Date(clock.getTime() + ms); };

describe('Room Observer', () => {
  it('rebuilds recognised seats only, with Git and non-Git project keys', async () => {
    const desk = join(root, 'desk');
    await mkdir(desk);
    paseo.addAgent({ id: 'sup', provider: 'claude-supervisor', cwd: desk, title: 'Room Supervisor' });
    paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, labels: { [PARENT_AGENT_ID_LABEL]: 'sup' } });
    paseo.addAgent({ id: 'stranger', provider: 'claude', cwd: repo });
    const room = observer();
    await room.rebuild();
    expect(room.seats().map(seat => seat.agentId).sort()).toEqual(['lead', 'sup']);
    const lead = room.seat('lead');
    expect(lead?.role).toBe('lead');
    expect(lead?.project).toMatchObject({ root: repo, name: 'shop', git: true });
    expect(lead?.parentAgentId).toBe('sup');
    expect(room.seat('sup')?.project).toEqual({ key: `dir:${desk}`, root: desk, name: 'desk', git: false });
    expect([...room.projects().keys()]).toEqual([lead?.project.key]);
  });

  it('puts a linked worktree in its repository project', async () => {
    const tree = join(root, 'tree');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', tree);
    paseo.addAgent({ id: 'lead', provider: 'codex-lead', cwd: repo });
    paseo.addAgent({ id: 'peer', provider: 'codex-peer', cwd: tree, labels: { [PARENT_AGENT_ID_LABEL]: 'lead' } });
    const room = observer();
    await room.rebuild();
    expect(room.seat('peer')?.project.key).toBe(room.seat('lead')?.project.key);
    expect(room.seat('peer')?.project.name).toBe('shop');
    expect(room.descendants('lead').map(seat => seat.agentId)).toEqual(['peer']);
  });

  it('tracks turns, the last message, write evidence, triggers and repeated failures', async () => {
    paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo });
    const room = observer();
    await room.rebuild();
    await room.onTurnStarted('lead');
    expect(room.seat('lead')?.state).toBe('running');
    advance(60_000);
    const ended = await room.onTurnEnded('lead', { kind: 'completed' }, [
      { type: 'user_message', text: '<paseo-system>\nAgent p (Peer) finished.\n</paseo-system>' },
      { type: 'tool_call', callId: 'c1', name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: 'src/a.ts' } },
      { type: 'tool_call', callId: 'c2', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: 'src/b.ts' } },
      { type: 'assistant_message', text: 'Đang chờ Peer hoàn thành.' },
    ]);
    expect(ended?.turn).toMatchObject({ outcome: 'completed', trigger: 'envelope', writes: ['src/a.ts'], lastMessage: 'Đang chờ Peer hoàn thành.' });
    expect((ended?.turn.endedAt ?? 0) - (ended?.turn.startedAt ?? 0)).toBe(60_000);
    expect(room.seat('lead')?.state).toBe('idle');
    expect(room.seat('lead')?.writeTurns).toHaveLength(1);

    await room.onTurnEnded('lead', { kind: 'failed', error: { message: 'Rate  limit exceeded' } }, []);
    await room.onTurnEnded('lead', { kind: 'failed', error: { message: 'rate limit exceeded' } }, []);
    expect(room.seat('lead')?.failures.map(failure => failure.key)).toEqual(['rate limit exceeded', 'rate limit exceeded']);
    await room.onTurnEnded('lead', { kind: 'completed' }, []);
    expect(room.seat('lead')?.failures).toEqual([]);
  });

  it('reads a turn\'s own items by its id, since Paseo passes the whole timeline on turn end', async () => {
    const agent = paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo });
    const room = observer();
    await room.rebuild();
    // The whole timeline: an earlier turn that wrote a file, then this turn, started by Paseo's
    // (timeline-suppressed) finish envelope, which only reads and reports.
    const whole = [
      { type: 'user_message' as const, text: 'Implement the parser' },
      { type: 'tool_call' as const, callId: 'c1', name: 'Edit', status: 'completed' as const, error: null, detail: { type: 'edit' as const, filePath: 'src/parser.ts' } },
      { type: 'assistant_message' as const, text: 'Parser done.' },
      { type: 'tool_call' as const, callId: 'c2', name: 'Read', status: 'completed' as const, error: null, detail: { type: 'read' as const, filePath: 'src/parser.ts' } },
      { type: 'assistant_message' as const, text: 'Peer finished; waiting for review.' },
    ];
    agent.timeline = [
      { kind: 'user', text: 'Implement the parser', timestamp: '2026-09-24T07:00:00.000Z', turnId: 't1' },
      { kind: 'tool', text: '', timestamp: '2026-09-24T07:01:00.000Z', turnId: 't1', writes: 'src/parser.ts' },
      { kind: 'assistant', text: 'Parser done.', timestamp: '2026-09-24T07:02:00.000Z', turnId: 't1' },
      { kind: 'tool', text: '', timestamp: '2026-09-24T07:30:00.000Z', turnId: 't2' },
      { kind: 'assistant', text: 'Peer finished; waiting for review.', timestamp: '2026-09-24T07:31:00.000Z', turnId: 't2' },
    ];
    const ended = await room.onTurnEnded('lead', { kind: 'completed' }, whole, 't2');
    expect(ended?.turn).toMatchObject({ writes: [], trigger: 'unknown', lastMessage: 'Peer finished; waiting for review.' });
    expect(ended?.turn.firstMessage).toBeUndefined();
    expect(room.seat('lead')?.writeTurns).toEqual([]);

    // Without a turn id, only what follows the last user message counts.
    const fallback = await room.onTurnEnded('lead', { kind: 'completed' }, [...whole, { type: 'user_message', text: 'Now the docs' }, { type: 'assistant_message', text: 'Docs updated.' }]);
    expect(fallback?.turn).toMatchObject({ writes: [], trigger: 'message', lastMessage: 'Docs updated.', firstMessage: 'Now the docs' });
  });

  it('tracks permissions and archive, and refreshes stale snapshots', async () => {
    const agent = paseo.addAgent({ id: 'peer', provider: 'codex-peer', cwd: repo });
    const room = observer();
    await room.rebuild();
    await room.onTurnStarted('peer');
    await room.onPermissionRequested('peer', 'perm-1');
    expect(room.seat('peer')?.state).toBe('permission');
    expect(room.seat('peer')?.pending.get('perm-1')).toBe(clock.getTime());
    await room.onPermissionResolved('peer', 'perm-1');
    expect(room.seat('peer')?.state).toBe('running');

    agent.pendingPermissions = [{ id: 'perm-2', name: 'Bash' }];
    advance(10 * 60_000);
    await room.refreshStale(5 * 60_000);
    expect(room.seat('peer')?.state).toBe('permission');
    room.onArchived('peer', '2026-09-24T09:00:00.000Z');
    expect(room.seat('peer')).toMatchObject({ state: 'archived', archivedAt: '2026-09-24T09:00:00.000Z' });
    expect(room.seat('peer')?.pending.size).toBe(0);
  });

  it('reads the last message from Paseo when no turn event carried one', async () => {
    const agent = paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo });
    agent.timeline = [
      { kind: 'user', text: 'Do it', timestamp: '2026-09-24T07:00:00.000Z' },
      { kind: 'assistant', text: 'Done: pushed 1a2b3c.', timestamp: '2026-09-24T07:01:00.000Z' },
    ];
    const room = observer();
    await room.rebuild();
    expect(await room.lastMessage('lead')).toBe('Done: pushed 1a2b3c.');
  });

  it('reads Paseo prompt tool calls from a timeline, with their notification choice', () => {
    const entry = (input: unknown) => toTimelineEntry({ type: 'tool_call', name: 'mcp__paseo__send_agent_prompt', detail: { type: 'unknown', input, output: null } }, '2026-09-24T08:00:00.000Z');
    expect(entry({ agentId: 'lead-1', prompt: 'Push', notifyOnFinish: true }).prompts).toEqual({ tool: 'send_agent_prompt', agentId: 'lead-1', notified: true });
    expect(entry({ agentId: 'lead-1', prompt: 'Push' }).prompts).toEqual({ tool: 'send_agent_prompt', agentId: 'lead-1', notified: true });
    expect(entry({ agentId: 'lead-1', prompt: 'Push', notifyOnFinish: false }).prompts?.notified).toBe(false);
    // A call that waited for the finish returned it to the caller: told, whatever notifyOnFinish says.
    expect(entry({ agentId: 'lead-1', prompt: 'Push', notifyOnFinish: false, background: false }).prompts?.notified).toBe(true);
    expect(toTimelineEntry({ type: 'tool_call', name: 'Bash', detail: { type: 'shell', command: 'ls' } }, 't').prompts).toBeUndefined();
  });

  it('classifies triggers and failure keys', () => {
    expect(triggerOf(undefined)).toBe('unknown');
    expect(triggerOf('<paseo-system>\nAgent x finished.\n</paseo-system>')).toBe('envelope');
    expect(triggerOf('[paseo-room notice ntc_x] hi')).toBe('runtime');
    expect(triggerOf('[paseo-room attention att_x] hi')).toBe('runtime');
    expect(triggerOf('Push')).toBe('message');
    expect(errorKey({ message: 'x', code: 'E_QUOTA' })).toBe('E_QUOTA');
  });
});

describe('Supervisor portfolio', () => {
  it('prefers the Human assignment, then the parent of every live Lead, else none', async () => {
    const desk = join(root, 'desk');
    await mkdir(desk);
    paseo.addAgent({ id: 'sup-a', provider: 'claude-supervisor', cwd: desk });
    paseo.addAgent({ id: 'sup-b', provider: 'codex-supervisor', cwd: desk });
    paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, labels: { [PARENT_AGENT_ID_LABEL]: 'sup-a' } });
    const room = observer();
    await room.rebuild();
    const key = room.seat('lead')?.project.key ?? '';
    const portfolio = Portfolio.at(join(root, 'runtime'), () => clock);
    await portfolio.load();
    expect(portfolio.resolve(key, room)).toEqual({ supervisorAgentId: 'sup-a', decidedBy: 'parentage' });

    await portfolio.assign(key, 'sup-b');
    expect(portfolio.resolve(key, room)).toEqual({ supervisorAgentId: 'sup-b', decidedBy: 'human' });
    const file = join(root, 'runtime', 'attention', 'portfolio.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema: 1, projects: { [key]: { supervisorAgentId: 'sup-b', at: clock.toISOString() } } });

    const reloaded = Portfolio.at(join(root, 'runtime'));
    await reloaded.load();
    expect(reloaded.explicit(key)).toBe('sup-b');

    // An assigned Supervisor that is gone leaves the project unsupervised, not silently re-routed.
    room.onArchived('sup-b', '2026-09-24T09:00:00.000Z');
    expect(portfolio.resolve(key, room)).toEqual({ decidedBy: 'none' });
    await portfolio.assign(key, null);
    expect(portfolio.resolve(key, room)).toEqual({ supervisorAgentId: 'sup-a', decidedBy: 'parentage' });
  });

  it('ignores a parent that is not a live room Supervisor, and disagreeing parents', async () => {
    paseo.addAgent({ id: 'lead-1', provider: 'claude-lead', cwd: repo, labels: { [PARENT_AGENT_ID_LABEL]: 'somebody' } });
    const room = observer();
    await room.rebuild();
    const key = room.seat('lead-1')?.project.key ?? '';
    const portfolio = Portfolio.at(join(root, 'runtime'));
    await portfolio.load();
    expect(portfolio.resolve(key, room)).toEqual({ decidedBy: 'none' });

    paseo.addAgent({ id: 'sup-a', provider: 'claude-supervisor', cwd: root });
    paseo.addAgent({ id: 'lead-2', provider: 'codex-lead', cwd: repo, labels: { [PARENT_AGENT_ID_LABEL]: 'sup-a' } });
    await room.rebuild();
    expect(portfolio.resolve(key, room)).toEqual({ decidedBy: 'none' });
  });
});
