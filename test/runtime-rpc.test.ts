import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PaseoHandle, type PaseoApi } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { createRpcHandlers, registerRpcs, type RpcRuntime } from '../src/runtime-plugin/server/rpc.js';
import {
  RUNTIME_RPCS, runtimeAbandonRpc, runtimeAssignmentRpc, runtimeHealthRpc, runtimeProjectRpc,
} from '../src/runtime-plugin/shared/rpc-contracts.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function room(options: { handle?: boolean } = {}) {
  const h = await harness();
  open.push(h);
  const handle = new PaseoHandle();
  if (options.handle !== false) handle.supply({} as PaseoApi);
  const runtime: RpcRuntime = { controller: h.controller, recovery: new Recovery(h.controller), handle };
  const created = await h.controller.createAssignment(h.lead, writableBrief(h.base));
  if (!created.ok) throw new Error(created.message);
  const store = await h.controller.projectFor(h.repo);
  return { h, rpc: createRpcHandlers(runtime), runtime, projectId: store.meta.projectId, assignmentId: created.value.assignmentId, store };
}

const data = (answer: unknown): Record<string, unknown> => (answer as { data: Record<string, unknown> }).data;
const failure = (answer: unknown): string | undefined => (answer as { error?: { code: string } }).error?.code;

describe('runtime RPC contracts', () => {
  it('registers every contract and rejects unknown input fields', () => {
    const names: string[] = [];
    registerRpcs({ handle: ((contract: { name: string }) => { names.push(contract.name); }) }, { controller: {} as never, recovery: {} as never, handle: new PaseoHandle() });
    expect(names).toEqual(RUNTIME_RPCS.map(contract => contract.name));
    expect(runtimeProjectRpc.input.safeParse({ projectId: '6f1c1f3e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', extra: 1 }).success).toBe(false);
    expect(runtimeAbandonRpc.input.safeParse({ projectId: '6f1c1f3e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', assignmentId: 'asg_abcdefgh', reason: 'x' }).success).toBe(false);
  });
});

describe('read RPCs', () => {
  it('reports plugin and project health, and labels live facts stale without Paseo', async () => {
    const { rpc, projectId } = await room({ handle: false });
    const health = await rpc.health();
    expect(runtimeHealthRpc.output.safeParse(health).success).toBe(true);
    expect(data(health)).toEqual({ plugin: { id: 'paseo-room-runtime', manifest: 'ready' }, projects: [{ projectId, canonicalRoot: expect.any(String) as unknown, health: 'healthy', findings: 0 }] });
    expect((health as { warnings: { code: string }[] }).warnings).toEqual([expect.objectContaining({ code: 'live-facts-stale' })]);
  });

  it('keeps an unchanged view on one revision, quickly, and changes it after any event', async () => {
    const { h, rpc, projectId } = await room();
    for (let index = 0; index < 30; index += 1) await h.controller.createAssignment(h.lead, writableBrief(h.base));
    const first = await rpc.project({ projectId });
    const started = performance.now();
    const second = await rpc.project({ projectId });
    expect(performance.now() - started).toBeLessThan(250);
    expect(runtimeProjectRpc.output.safeParse(second).success).toBe(true);
    expect((second as { revision: string }).revision).toBe((first as { revision: string }).revision);
    await h.controller.createAssignment(h.lead, writableBrief(h.base));
    expect(((await rpc.project({ projectId })) as { revision: string }).revision).not.toBe((first as { revision: string }).revision);
  });

  it('shows the operator the full assignment and names unknown ids with a recovery action', async () => {
    const { rpc, projectId, assignmentId } = await room();
    const detail = await rpc.assignment({ projectId, assignmentId });
    expect(runtimeAssignmentRpc.output.safeParse(detail).success).toBe(true);
    expect(data(detail)).toMatchObject({ id: assignmentId, brief: { outcome: 'Add the feature' } });
    const unknown = await rpc.assignment({ projectId, assignmentId: 'asg_missing01' });
    expect(unknown).toMatchObject({ schema: 1, error: { code: 'assignment_unknown', recoveryAction: expect.any(String) as unknown } });
    expect(failure(await rpc.project({ projectId: '00000000-0000-4000-8000-000000000000' }))).toBe('project_unknown');
  });
});

describe('operator mutation RPCs', () => {
  it('abandons as a human actor, once per idempotency key, and refuses an illegal abandon', async () => {
    const { h, rpc, projectId, assignmentId, store } = await room();
    const first = await rpc.abandon({ projectId, assignmentId, reason: 'Superseded.', idempotencyKey: 'key-abandon-1' });
    expect(data(first)).toEqual({ state: 'abandoned' });
    expect(await rpc.abandon({ projectId, assignmentId, reason: 'Superseded.', idempotencyKey: 'key-abandon-1' })).toEqual(first);
    const events = (await store.replay()).events.filter(event => event.type === 'assignment.abandoned');
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toEqual({ source: 'human' });

    const active = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    if (!active.ok) throw new Error(active.message);
    await h.controller.dispatch(h.lead, { assignmentId: active.value.assignmentId, peerProvider: 'codex-peer' });
    expect(failure(await rpc.abandon({ projectId, assignmentId: active.value.assignmentId, reason: 'x', idempotencyKey: 'key-abandon-2' }))).toBe('assignment_state');
  });

  it('lets the operator confirm the owning Lead of an open conflict', async () => {
    const { h, rpc, projectId } = await room();
    expect(failure(await rpc.resolveOwnership({ projectId, keptLeadAgentId: 'lead-1', idempotencyKey: 'key-owner-01' }))).toBe('ownership_not_in_conflict');
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    await new Recovery(h.controller).recoverAll();
    expect(data(await rpc.resolveOwnership({ projectId, keptLeadAgentId: 'lead-1', idempotencyKey: 'key-owner-02' }))).toEqual({ resolved: true });
  });

  it('quarantines an unreadable event only on request and runs recovery once per key', async () => {
    const { rpc, projectId, store } = await room();
    await writeFile(join(store.eventsDirectory, '000000000009.json'), 'garbage');
    expect(data(await rpc.health())).toMatchObject({ projects: [{ health: 'paused' }] });
    expect(failure(await rpc.recover({ projectId, idempotencyKey: 'key-recover-1' }))).toBe('project_paused');
    expect(data(await rpc.quarantine({ projectId, file: '000000000009.json', idempotencyKey: 'key-quarantine' }))).toEqual({ quarantined: '000000000009.json' });
    expect(data(await rpc.health())).toMatchObject({ projects: [{ health: 'healthy' }] });
    const recovered = await rpc.recover({ projectId, idempotencyKey: 'key-recover-2' });
    expect(data(recovered)).toEqual({ actions: [] });
  });
});
