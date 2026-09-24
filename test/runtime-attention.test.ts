import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { DEFAULT_ATTENTION_SETTINGS, type AttentionSettings } from '../src/runtime-plugin/shared/attention.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { GitEvidence } from '../src/runtime-plugin/server/git.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';
import { FakePaseo, PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';

let root: string;
let repo: string;
let runtimeRoot: string;
let clock: Date;
let paseo: FakePaseo;
let settings: AttentionSettings;
let engine: AttentionEngine;

const MINUTE = 60_000;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function withSettings(change: (draft: { -readonly [K in keyof AttentionSettings]: { -readonly [P in keyof AttentionSettings[K]]: AttentionSettings[K][P] } }) => void): void {
  const draft: Parameters<typeof change>[0] = structuredClone(settings);
  change(draft);
  settings = draft;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-attention-')));
  repo = join(root, 'shop');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  await mkdir(join(root, 'desk'));
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, 'generated'), { recursive: true });
  await writeFile(join(plugin, 'generated', 'room-manifest.json'), renderRuntimeManifestFile(['codex', 'claude'], ROLES));
  const recognition = new Recognition(plugin);
  await recognition.load();
  runtimeRoot = join(root, 'runtime', 'v1');
  paseo = new FakePaseo();
  clock = new Date('2026-09-24T08:00:00.000Z');
  settings = DEFAULT_ATTENTION_SETTINGS;
  withSettings(draft => { draft.delivery.envelopeGraceSeconds = 0; });
  paseo.addAgent({ id: 'sup', provider: 'claude-supervisor', cwd: join(root, 'desk'), title: 'Room Supervisor' });
  paseo.addAgent({ id: 'lead', provider: 'claude-lead', cwd: repo, title: 'shop — Lead', labels: { [PARENT_AGENT_ID_LABEL]: 'sup' } });
  paseo.addAgent({ id: 'peer', provider: 'codex-peer', cwd: repo, title: 'Engineer', labels: { [PARENT_AGENT_ID_LABEL]: 'lead' } });
  engine = new AttentionEngine({ paseo, recognition, git: new GitEvidence(), runtimeRoot, now: () => clock, settings: () => settings, log: () => undefined });
});
afterEach(async () => { engine.dispose(); await rm(root, { recursive: true, force: true }); });

const advance = (ms: number): void => { clock = new Date(clock.getTime() + ms); };
const settle = async (): Promise<void> => { await engine.run(() => engine.sweep()); };
const letters = (agentId = 'sup') => paseo.agents.get(agentId)?.prompts ?? [];
/** Paseo and the Observer agree: the fake's snapshot is what a stale-fact refresh reads back. */
const setBusy = async (agentId: string): Promise<void> => {
  const agent = paseo.agents.get(agentId);
  if (agent !== undefined) { agent.status = 'running'; agent.activeTurn = true; }
  await engine.onTurnStarted(agentId);
};
const setIdle = async (agentId: string): Promise<void> => { paseo.endTurn(agentId); await engine.onTurnEnded(agentId, { kind: 'completed' }, []); };
const request = async (agentId: string, permissionId: string): Promise<void> => {
  paseo.agents.get(agentId)?.pendingPermissions.push({ id: permissionId, name: 'Bash' });
  await engine.onPermissionRequested(agentId, permissionId);
};
const resolve = async (agentId: string, permissionId: string): Promise<void> => {
  const agent = paseo.agents.get(agentId);
  if (agent !== undefined) agent.pendingPermissions = agent.pendingPermissions.filter(permission => permission.id !== permissionId);
  await engine.onPermissionResolved(agentId, permissionId);
};

async function logRecords(): Promise<{ type: string; [key: string]: unknown }[]> {
  const directory = join(runtimeRoot, 'attention', 'log');
  const files = await readdir(directory).catch(() => [] as string[]);
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(line => line !== '');
  return lines.map(line => JSON.parse(line) as { type: string });
}

describe('attention signals and letters', () => {
  it('writes a now letter for a waiting permission once the Supervisor is idle, and closes it when resolved', async () => {
    await settle();
    await request('peer', 'perm-1');
    advance(4 * MINUTE);
    await settle();
    expect(letters()).toEqual([]);
    advance(2 * MINUTE);
    await setBusy('sup');
    await settle();
    expect(letters()).toEqual([]);
    await setIdle('sup');
    expect(letters()).toHaveLength(1);
    const [letter] = letters();
    expect(letter?.behavior).toBe('steer');
    expect(letter?.text).toMatch(/^\[paseo-room attention att_[\w-]+\] shop · peer Engineer \(peer\) has waited 6 min on permission perm-1\. \[item att_/);

    await resolve('peer', 'perm-1');
    const closed = (await logRecords()).filter(record => record.type === 'incident.closed');
    expect(closed).toHaveLength(1);
  });

  it('never sends while the Supervisor holds a pending permission', async () => {
    await settle();
    await request('sup', 'perm-s');
    await request('peer', 'perm-1');
    advance(6 * MINUTE);
    await settle();
    expect(letters()).toEqual([]);
    expect(paseo.agents.get('sup')?.clearedPermissions).toEqual([]);
    await resolve('sup', 'perm-s');
    expect(letters()).toHaveLength(1);
  });

  it('pages the Supervisor when a Lead is archived with work running, steering after the hold', async () => {
    await settle();
    await engine.onTurnStarted('peer');
    await setBusy('sup');
    await engine.onArchived('lead', '2026-09-24T08:01:00.000Z');
    expect(letters()).toEqual([]);
    advance(61_000);
    await settle();
    expect(letters()).toHaveLength(1);
    expect(letters()[0]?.text).toContain('was archived while 1 of its seats still work');
    expect(paseo.agents.get('sup')?.interrupted).toBe(0);
  });

  it('keeps a Supervisor\'s own trouble on the panel', async () => {
    await settle();
    await request('sup', 'perm-s');
    advance(6 * MINUTE);
    await settle();
    await resolve('sup', 'perm-s');
    await request('sup', 'perm-t');
    advance(6 * MINUTE);
    await settle();
    const view = engine.roomView();
    expect(view.panelIncidents.concat(view.projects.flatMap(project => project.incidents)).some(incident => incident.recipient === 'panel' && incident.kind === 'permission-waiting')).toBe(true);
    expect(letters()).toEqual([]);
  });

  it('relays a Lead turn Paseo did not report as a digest line, and not one Paseo did', async () => {
    await settle();
    await engine.onTurnStarted('lead');
    await engine.onTurnEnded('lead', { kind: 'completed' }, [
      { type: 'user_message', text: 'Human: ship it' },
      { type: 'assistant_message', text: 'Deployed v1.2 to dev. Token=abc123secretvalue was rotated.' },
    ]);
    expect(letters()).toEqual([]);
    advance(16 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    const text = letters()[0]?.text ?? '';
    expect(text).toContain('1 item(s) from your portfolio');
    expect(text).toContain('shop · lead shop — Lead (lead) ended a turn (completed): "Deployed v1.2 to dev. Token=[secret] was rotated."');
    expect(text).not.toContain('abc123secretvalue');

    // The Supervisor prompted the Lead itself: Paseo reports that turn to it, so nothing is relayed.
    await setIdle('sup');
    const sup = paseo.agents.get('sup');
    advance(MINUTE);
    sup?.timeline.push({ kind: 'tool', text: '', timestamp: clock.toISOString(), prompts: { tool: 'send_agent_prompt', agentId: 'lead', notified: true } });
    advance(MINUTE);
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Pushed.' }]);
    advance(16 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    expect((await logRecords()).filter(record => record.type === 'lead-turn').map(record => record.reason)).toContain('Paseo reports this turn to the Supervisor that prompted it');

    // Only the first finish after that prompt is Paseo's to report; the next turn is relayed again.
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Also tagged v1.3.' }]);
    advance(16 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(2);
    expect(letters()[1]?.text).toContain('Also tagged v1.3.');
  });

  it('relays a prompted turn when the Supervisor opted out of being told', async () => {
    await settle();
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'First.' }]);
    advance(MINUTE);
    paseo.agents.get('sup')?.timeline.push({ kind: 'tool', text: '', timestamp: clock.toISOString(), prompts: { tool: 'send_agent_prompt', agentId: 'lead', notified: false } });
    advance(MINUTE);
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Fire and forget done.' }]);
    advance(16 * MINUTE);
    await settle();
    expect(letters().at(-1)?.text).toContain('Fire and forget done.');
  });

  it('keeps only a Lead\'s latest turn in a pending digest', async () => {
    await settle();
    for (let index = 0; index < 4; index += 1) {
      await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: `step ${String(index)}` }]);
    }
    advance(16 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    expect(letters()[0]?.text).toContain('1 item(s) from your portfolio');
    expect(letters()[0]?.text).toContain('"step 3"');
    expect(letters()[0]?.text).not.toContain('"step 2"');
  });

  it('sends a digest early at ten lines, and at most once per digest interval', async () => {
    await settle();
    // Ten Leads of ten projects, so no line supersedes another and no Lead duplicates another.
    for (let index = 0; index < 10; index += 1) {
      const cwd = join(root, `project-${String(index)}`);
      await mkdir(cwd);
      paseo.addAgent({ id: `lead-${String(index)}`, provider: 'claude-lead', cwd, labels: { [PARENT_AGENT_ID_LABEL]: 'sup' } });
      await engine.onCreated(`lead-${String(index)}`);
    }
    for (let index = 0; index < 10; index += 1) {
      await engine.onTurnEnded(`lead-${String(index)}`, { kind: 'completed' }, [{ type: 'assistant_message', text: `step ${String(index)}` }]);
    }
    advance(20 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    await setIdle('sup');
    await engine.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'step 10' }]);
    advance(MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    advance(15 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(2);
  });

  it('budgets now letters per hour and carries the overflow in the digest', async () => {
    withSettings(draft => { draft.delivery.wakesPerHour = 1; });
    await settle();
    await request('peer', 'perm-1');
    advance(6 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    await setIdle('sup');
    await request('lead', 'perm-2');
    advance(6 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(1);
    advance(16 * MINUTE);
    await settle();
    expect(letters()).toHaveLength(2);
    expect(letters()[1]?.text).toContain('item(s) from your portfolio');
    expect(letters()[1]?.text).toContain('permission perm-2');
  });

  it('counts a repeated failure on the open incident without writing again', async () => {
    await settle();
    const fail = { kind: 'failed' as const, error: { message: 'quota exceeded' } };
    await engine.onTurnEnded('peer', fail, []);
    await engine.onTurnEnded('peer', fail, []);
    expect(letters()).toHaveLength(1);
    expect(letters()[0]?.text).toContain('failed 2 turns with the same error: "quota exceeded"');
    await engine.onTurnEnded('peer', fail, []);
    expect(letters()).toHaveLength(1);
    const updated = (await logRecords()).filter(record => record.type === 'incident.updated');
    expect(updated.at(-1)?.count).toBe(2);
  });

  it('withdraws an item whose condition cleared before the Supervisor was free', async () => {
    await settle();
    await setBusy('sup');
    await request('peer', 'perm-1');
    advance(6 * MINUTE);
    await settle();
    await resolve('peer', 'perm-1');
    await setIdle('sup');
    expect(letters()).toEqual([]);
  });

  it('flags a Peer result its idle Lead has not read', async () => {
    await settle();
    await engine.onTurnStarted('peer');
    await engine.onTurnEnded('peer', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Done.' }]);
    advance(11 * MINUTE);
    await settle();
    expect(letters().some(letter => letter.text.includes('finished 11 min ago (completed) and its Lead'))).toBe(true);
  });

  it('observes two seats writing in one working tree during overlapping turns', async () => {
    await settle();
    await engine.onTurnStarted('lead');
    await engine.onTurnStarted('peer');
    advance(MINUTE);
    const edit = (path: string) => [
      { type: 'user_message' as const, text: `Change ${path}` },
      { type: 'tool_call' as const, callId: path, name: 'Edit', status: 'completed' as const, error: null, detail: { type: 'edit' as const, filePath: path } },
    ];
    await engine.onTurnEnded('peer', { kind: 'completed' }, edit('src/a.ts'));
    await engine.onTurnEnded('lead', { kind: 'completed' }, edit('src/b.ts'));
    expect(letters().some(letter => letter.text.includes('edited files in') && letter.text.includes('overlapping turns'))).toBe(true);
  });

  it('pages a duplicate Lead only where no runtime ledger already does', async () => {
    paseo.addAgent({ id: 'lead-2', provider: 'codex-lead', cwd: repo, labels: { [PARENT_AGENT_ID_LABEL]: 'sup' } });
    await settle();
    expect(letters().some(letter => letter.text.includes('2 Leads are live on shop'))).toBe(true);
  });

  it('sends nothing when letters are off, but still records incidents for the panel', async () => {
    withSettings(draft => { draft.letters.enabled = false; });
    await settle();
    await request('peer', 'perm-1');
    advance(6 * MINUTE);
    await settle();
    expect(letters()).toEqual([]);
    expect(engine.roomView().projects[0]?.incidents.map(incident => incident.kind)).toEqual(['permission-waiting']);
  });

  it('records feedback only from the incident\'s own Supervisor', async () => {
    await settle();
    await request('peer', 'perm-1');
    advance(6 * MINUTE);
    await settle();
    const [incident] = engine.openIncidents('sup');
    expect(incident).toBeDefined();
    const id = incident?.id ?? '';
    expect(await engine.feedback(id, 'noise', { source: 'supervisor', agentId: 'other' })).toBe('forbidden');
    expect(await engine.feedback(id, 'useful', { source: 'supervisor', agentId: 'sup' })).toBe('recorded');
    expect(await engine.feedback('att_missing', 'useful', { source: 'human' })).toBe('unknown');
    expect(engine.openIncidents('sup')[0]?.feedback).toBe('useful');
  });

  it('lets an assisting sensor wake the Supervisor for a dead wait, while a shadow one changes nothing', async () => {
    const recognition = new Recognition(join(root, 'plugin'));
    await recognition.load();
    const make = (assist: boolean) => new AttentionEngine({
      paseo, recognition, git: new GitEvidence(), runtimeRoot, now: () => clock, settings: () => settings, log: () => undefined,
      sensor: {
        leadTurn: () => Promise.resolve({
          assessment: { questionSet: 'lead-turn-v1', model: 'jev-1.13.0', choice: { value: 'waiting_for_peer', confidence: 0.92 }, nouls: {}, latencyMs: 80 },
          mode: assist ? 'assist' : 'shadow', assist,
        }),
      },
    });
    const shadow = make(false);
    await shadow.run(() => shadow.sweep());
    await shadow.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Waiting for the Engineer to finish.' }]);
    expect(letters()).toEqual([]);

    const assisted = make(true);
    await assisted.run(() => assisted.sweep());
    await assisted.onTurnEnded('lead', { kind: 'completed' }, [{ type: 'assistant_message', text: 'Waiting for the Engineer to finish.' }]);
    expect(letters()).toHaveLength(1);
    expect(letters()[0]?.text).toContain('[dead wait: Lead waits for a Peer and none is running]');
  });

  it('gives the panel a names-only summary of each incident, and letters the ids', async () => {
    paseo.addAgent({ id: 'lead-2', provider: 'codex-lead', cwd: repo, title: 'shop — second Lead', labels: { [PARENT_AGENT_ID_LABEL]: 'sup' } });
    await settle();
    const [incident] = engine.roomView().projects[0]?.incidents ?? [];
    expect(incident?.summary).toBe('2 Leads are live on shop: shop — Lead, shop — second Lead. Keep the established owner and stop new routing to the others.');
    expect(incident?.text).toContain('(lead-2)');
    expect(incident?.openedAt).toBe(clock.toISOString());
    expect(letters()[0]?.text).toContain('(lead-2)');
  });

  it('shows the room by project with its Supervisor and live seats', async () => {
    await settle();
    const view = engine.roomView();
    expect(view.started).toBe(true);
    expect(view.supervisors.map(seat => seat.agentId)).toEqual(['sup']);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]).toMatchObject({ name: 'shop', decidedBy: 'parentage', supervisor: { agentId: 'sup' } });
    expect(view.projects[0]?.seats.map(seat => seat.agentId).sort()).toEqual(['lead', 'peer']);
    expect(engine.portfolioOf('sup')).toEqual([view.projects[0]?.key]);
  });
});
