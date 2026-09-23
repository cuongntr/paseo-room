import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DispatchInput } from '../src/runtime-plugin/server/controller.js';
import { CreationConflictError } from '../src/runtime-plugin/server/paseo-port.js';
import { harness, readOnlyBrief, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
async function room(options: Parameters<typeof harness>[0] = { worktrees: true }): Promise<Harness> {
  const created = await harness(options);
  open.push(created);
  return created;
}
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function assignment(h: Harness, change: Record<string, unknown> = {}, brief = writableBrief(h.base, change)): Promise<string> {
  const result = await h.controller.createAssignment(h.lead, brief);
  if (!result.ok) throw new Error(result.message);
  return result.value.assignmentId;
}

async function ledger(h: Harness) {
  const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.value;
}

const isolated = (assignmentId: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({ assignmentId, peerProvider: 'codex-peer', isolation: 'worktree', ...extra });

async function dispatchIsolated(h: Harness, scope: string[], extra: Partial<DispatchInput> = {}): Promise<string> {
  const id = await assignment(h, { writeScope: scope });
  const result = await h.controller.dispatch(h.lead, isolated(id, extra));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return id;
}

/** Runs `attempt` and proves it recorded nothing and asked Paseo nothing. */
async function refusedQuietly(h: Harness, attempt: () => Promise<{ ok: boolean; code?: string }>): Promise<string | undefined> {
  const events = (await ledger(h)).events.length;
  const calls = h.paseo.calls.length;
  const result = await attempt();
  expect(result.ok).toBe(false);
  expect((await ledger(h)).events.length).toBe(events);
  expect(h.paseo.calls.slice(calls)).toEqual([]);
  return result.code;
}

describe('worktree dispatch refusals', () => {
  it('refuses on a daemon that has not been qualified', async () => {
    const h = await room({});
    const id = await assignment(h);
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(id)))).toBe('worktree_unqualified');
  });

  it('refuses a repository whose base declares worktree setup, or whose base is not a commit', async () => {
    const h = await room();
    await writeFile(join(h.repo, 'paseo.json'), JSON.stringify({ worktree: { setup: ['npm ci'] } }));
    await h.git('add', '.');
    await h.git('commit', '-q', '-m', 'setup');
    const withSetup = await assignment(h, {}, writableBrief(await h.git('rev-parse', 'HEAD')));
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(withSetup)))).toBe('worktree_setup_unobservable');
    // The declaration at the assignment's base is what counts, not the checkout's.
    const before = await assignment(h, { writeScope: ['src'] });
    expect((await h.controller.dispatch(h.lead, isolated(before))).ok).toBe(true);
    const unknown = await assignment(h, {}, writableBrief('f'.repeat(40)));
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(unknown)))).toBe('base_unknown');
  });

  it('refuses non-canonical scopes and names the item', async () => {
    const h = await room();
    const absolute = await assignment(h, { writeScope: ['/etc/passwd'] });
    const result = await h.controller.dispatch(h.lead, isolated(absolute));
    expect(result).toMatchObject({ ok: false, code: 'scope_not_canonical' });
    expect(!result.ok && result.message).toContain('writeScope item "/etc/passwd" is absolute');
    const serial = await assignment(h, { writeScope: ['src'] });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(serial, { serialOnly: ['{a,b}'] })))).toBe('scope_not_canonical');
    // Free text stays legal without isolation.
    const free = await assignment(h, { writeScope: ['the API layer'] });
    expect((await h.controller.dispatch(h.lead, { assignmentId: free, peerProvider: 'codex-peer' })).ok).toBe(true);
  });

  it('refuses overlap, serial paths, the cap and an uncertain writer before any Paseo call', async () => {
    const h = await room();
    const api = await dispatchIsolated(h, ['src/api'], { serialOnly: ['generated'] });
    const overlapping = await assignment(h, { writeScope: ['src'] });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(overlapping)))).toBe('scope_overlap');
    // A serial-only path admits one writer at a time: the first writer under it is free.
    await dispatchIsolated(h, ['src/web', 'generated/web']);
    const generated = await assignment(h, { writeScope: ['generated/docs'] });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(generated)))).toBe('serial_path');
    await dispatchIsolated(h, ['docs']);
    const fourth = await assignment(h, { writeScope: ['test'] });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(fourth)))).toBe('lease_cap');

    const loaded = await ledger(h);
    await h.controller.append(loaded, { type: 'ownership.uncertain', payloadVersion: 1, assignmentId: api, actor: { source: 'plugin' }, data: { reason: 'archive unconfirmed' } });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(fourth)))).toBe('writer_uncertain');
  });

  it('keeps a writer in Lead\'s workspace exclusive in both directions', async () => {
    const h = await room();
    const shared = await assignment(h, { writeScope: ['src'] });
    expect((await h.controller.dispatch(h.lead, { assignmentId: shared, peerProvider: 'codex-peer' })).ok).toBe(true);
    const worktree = await assignment(h, { writeScope: ['docs'] });
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(worktree)))).toBe('writer_exclusive');

    const other = await room();
    await dispatchIsolated(other, ['docs']);
    const lateShared = await assignment(other, { writeScope: ['src'] });
    expect(await refusedQuietly(other, () => other.controller.dispatch(other.lead, { assignmentId: lateShared, peerProvider: 'codex-peer' }))).toBe('writer_exclusive');
  });

  it('refuses serial-only paths without isolation and isolation for read-only work', async () => {
    const h = await room();
    const writable = await assignment(h);
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, { assignmentId: writable, peerProvider: 'codex-peer', serialOnly: ['a'] }))).toBe('isolation_required');
    const reader = await assignment(h, {}, readOnlyBrief(h.base));
    expect(await refusedQuietly(h, () => h.controller.dispatch(h.lead, isolated(reader)))).toBe('isolation_not_writable');
  });
});

describe('worktree dispatch', () => {
  it('holds three disjoint writers at once, each in its own proven worktree under Lead', async () => {
    const h = await room();
    // Lead keeps working in its own workspace: its state does not gate isolated dispatch.
    await writeFile(join(h.repo, 'lead-wip.txt'), 'integration in progress');
    const ids = [await dispatchIsolated(h, ['src/api']), await dispatchIsolated(h, ['src/web']), await dispatchIsolated(h, ['docs'])];
    const loaded = await ledger(h);
    expect(loaded.events.filter(event => event.assignmentId === ids[0]).map(event => event.type)).toEqual([
      'assignment.created', 'assignment.dispatch-requested', 'ownership.reserved', 'lease.reserved', 'workspace.create-requested',
      'workspace.create-succeeded', 'agent.create-requested', 'agent.create-succeeded', 'binding.published', 'ownership.held',
      'reporting.generation-opened', 'run.requested', 'run.succeeded',
    ]);
    const directories = new Set<string>();
    for (const id of ids) {
      const owner = loaded.state.ownership.get(id);
      const record = loaded.state.workspaces.get(id);
      expect(owner).toMatchObject({ state: 'held', lease: { epoch: 1, branch: `paseo-room/${id}` } });
      expect(owner?.workspaceId).toMatch(/^wks_[0-9a-f]{16}$/);
      expect(record).toMatchObject({ create: 'succeeded', close: 'open', headCommit: h.base, idempotencyKey: `ws-${id}-e1`, worktreeSlug: id.toLowerCase() });
      const peer = h.paseo.agents.get(owner?.agentId ?? '');
      expect(peer).toMatchObject({ workspaceId: owner?.workspaceId, cwd: record?.worktreePath, labels: { 'paseo.parent-agent-id': 'lead-1', 'paseo-room.assignment': id } });
      expect(peer?.prompts[0]?.text).toContain(`Workspace: your own worktree ${String(record?.worktreePath)} on branch paseo-room/${id}.`);
      expect(await h.git('-C', record?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(h.base);
      directories.add(record?.worktreePath ?? '');
    }
    expect(directories.size).toBe(3);
    expect(h.paseo.calls.filter(call => call.operation === 'createAgent')).toEqual([]);
    expect(await h.git('status', '--porcelain')).toBe('?? lead-wip.txt');
    expect(await h.git('rev-parse', 'HEAD')).toBe(h.base);
  });

  it('names serial-only paths in the brief', async () => {
    const h = await room();
    const id = await dispatchIsolated(h, ['src'], { serialOnly: ['package-lock.json'] });
    const owner = (await ledger(h)).state.ownership.get(id);
    expect(h.paseo.agents.get(owner?.agentId ?? '')?.prompts[0]?.text).toContain('Serial-only paths (one writer at a time):\n- package-lock.json');
  });

  it('refuses and closes a worktree Paseo cut from the wrong commit, and never places a Peer in it', async () => {
    const h = await room();
    await writeFile(join(h.repo, 'next.txt'), 'x');
    await h.git('add', '.');
    await h.git('commit', '-q', '-m', 'next');
    const moved = await h.git('rev-parse', 'HEAD');
    // Another plugin rewrote the request; only the Git proof can tell.
    h.paseo.transformWorkspace = request => ({ ...request, baseCommit: moved });
    const id = await assignment(h, { writeScope: ['src'] });
    const result = await h.controller.dispatch(h.lead, isolated(id));
    expect(result).toMatchObject({ ok: false, code: 'workspace_refused' });
    expect(!result.ok && result.message).toContain('head-mismatch');
    const loaded = await ledger(h);
    expect(loaded.events.filter(event => event.assignmentId === id).map(event => event.type).slice(-5)).toEqual([
      'lease.reserved', 'workspace.create-requested', 'workspace.create-refused', 'workspace.close-requested', 'workspace.close-succeeded',
    ]);
    expect(loaded.state.workspaces.get(id)).toMatchObject({ create: 'refused', close: 'succeeded', directoryRemoved: true });
    expect(loaded.state.ownership.get(id)?.state).toBe('released');
    expect(loaded.state.assignments.get(id)?.state).toBe('blocked');
    expect(h.paseo.calls.filter(call => call.operation === 'createAgentInWorkspace')).toEqual([]);
  });

  it('catches Paseo branching from an existing branch of the same name', async () => {
    const h = await room();
    const id = await assignment(h, { writeScope: ['src'] });
    await writeFile(join(h.repo, 'other.txt'), 'x');
    await h.git('add', '.');
    await h.git('commit', '-q', '-m', 'other');
    await h.git('branch', `paseo-room/${id}`);
    await h.git('reset', '-q', '--hard', h.base);
    const result = await h.controller.dispatch(h.lead, isolated(id));
    expect(result).toMatchObject({ ok: false, code: 'workspace_refused' });
    expect((await ledger(h)).state.workspaces.get(id)).toMatchObject({ create: 'refused', close: 'succeeded' });
  });

  it('records a lost worktree response as uncertain and a receipt conflict as failed, never retrying with a new key', async () => {
    const h = await room();
    const lost = await assignment(h, { writeScope: ['src'] });
    h.paseo.faults.set('createWorktreeWorkspace', { when: 'after' });
    expect(await h.controller.dispatch(h.lead, isolated(lost))).toMatchObject({ ok: false, code: 'workspace_uncertain', retryable: true });
    const loaded = await ledger(h);
    expect(loaded.state.workspaces.get(lost)?.create).toBe('uncertain');
    expect(loaded.state.ownership.get(lost)?.state).toBe('uncertain');
    expect(h.paseo.calls.filter(call => call.operation === 'createWorktreeWorkspace')).toHaveLength(1);

    const other = await room();
    const conflict = await assignment(other, { writeScope: ['src'] });
    other.paseo.faults.set('createWorktreeWorkspace', { when: 'before', error: new CreationConflictError('workspace_request_key_conflict') });
    expect(await other.controller.dispatch(other.lead, isolated(conflict))).toMatchObject({ ok: false, code: 'workspace_failed' });
    const after = await ledger(other);
    expect(after.state.workspaces.get(conflict)?.create).toBe('failed');
    expect(after.state.ownership.get(conflict)?.state).toBe('released');
    expect(other.paseo.calls.filter(call => call.operation === 'createWorktreeWorkspace')).toHaveLength(1);
  });
});
