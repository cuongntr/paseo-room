import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { mintCapability, publishCapability } from '../src/runtime-plugin/server/capabilities.js';
import { Spool, type Registries } from '../src/runtime-plugin/server/spool.js';
import { toolDefinitions, writeToolFiles } from '../src/runtime-plugin/server/tools.js';

const bridgeScript = join(import.meta.dirname, '..', 'src', 'runtime-plugin', 'server', 'bridge', 'bridge.mjs');
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const spools: Spool[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const spool of spools.splice(0)) spool.stop();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paseo-room-bridge-'));
  roots.push(root);
  await writeToolFiles(root);
  return root;
}

/** A real bridge child process speaking newline-delimited JSON-RPC. */
function bridge(root: string, env: Record<string, string>): { request: (method: string, params?: unknown) => Promise<Record<string, unknown>> } {
  const child = spawn(process.execPath, [bridgeScript], { env: { PATH: process.env.PATH ?? '', PASEO_ROOM_RUNTIME_ROOT: root, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as Record<string, unknown>;
    waiting.get(message.id as number)?.(message);
  });
  let next = 0;
  return {
    request: (method, params) => new Promise(resolve => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    }),
  };
}

const echo = (name: string) => (request: { payload: unknown; capability?: string | undefined }) =>
  Promise.resolve({ ok: true, result: { handled: name, payload: request.payload, capability: request.capability ?? null } });

function registries(): Registries {
  return {
    supervisor: { room_status: echo('room_status') },
    lead: { assignment_status: echo('assignment_status') },
    peer: { ask: echo('ask'), handoff: echo('handoff') },
  };
}

async function spool(root: string, callers: Record<string, { kind: 'action' | 'peer'; role: 'supervisor' | 'lead' | 'peer' }>): Promise<Spool> {
  const created = new Spool({ root: join(root, 'spool'), resolve: correlation => Promise.resolve(callers[correlation]), registries: registries() });
  spools.push(created);
  await created.start();
  return created;
}

function content(message: Record<string, unknown>): { isError: boolean; body: Record<string, unknown> } {
  const result = message.result as { isError: boolean; content: { text: string }[] };
  return { isError: result.isError, body: JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown> };
}

describe('advertised tool lists', () => {
  it('keeps registries disjoint and gives each Peer kind its own handoff shape', () => {
    expect(toolDefinitions('supervisor').map(tool => tool.name)).toEqual(['room_status', 'runtime_findings', 'message_lead']);
    expect(toolDefinitions('lead')).toHaveLength(10);
    expect(toolDefinitions('peer')).toEqual([]);
    for (const kind of ['engineer', 'architect', 'reviewer', 'scout'] as const) {
      const tools = toolDefinitions('peer', kind);
      expect(tools.map(tool => tool.name)).toEqual(['ask', 'handoff']);
      for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const details = (tools[1]?.inputSchema.properties as Record<string, { properties?: { kind?: { const?: string } } }>).details;
      expect(details?.properties?.kind?.const).toBe(kind);
    }
  });
});

describe('bridge process over the spool', () => {
  it('initializes, lists its role\'s tools and relays a call with hidden identity only', async () => {
    const root = await runtimeRoot();
    const correlation = `cor_${'a'.repeat(32)}`;
    await spool(root, { [correlation]: { kind: 'peer', role: 'peer' } });
    const issued = mintCapability(1);
    await publishCapability(join(root, 'capabilities'), correlation, issued);
    const client = bridge(root, { PASEO_ROOM_CORRELATION: correlation, PASEO_ROOM_ROLE: 'peer', PASEO_ROOM_WORK_KIND: 'scout' });

    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    const listed = await client.request('tools/list');
    expect((listed.result as { tools: { name: string }[] }).tools.map(tool => tool.name)).toEqual(['ask', 'handoff']);

    const called = content(await client.request('tools/call', { name: 'ask', arguments: { question: 'q', blockingContext: 'c', evidence: [] } }));
    expect(called).toEqual({ isError: false, body: { handled: 'ask', payload: { question: 'q', blockingContext: 'c', evidence: [] }, capability: issued.capability } });

    const [request] = await readdir(join(root, 'spool', 'requests'));
    const envelope = JSON.parse(await readFile(join(root, 'spool', 'requests', request ?? ''), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['capability', 'correlation', 'operation', 'payload', 'protocol', 'requestId']);
  });

  it('refuses a forged operation, an unbound bridge and a malformed request', async () => {
    const root = await runtimeRoot();
    const peer = `cor_${'b'.repeat(32)}`;
    const lead = `cor_${'c'.repeat(32)}`;
    await spool(root, { [peer]: { kind: 'peer', role: 'peer' }, [lead]: { kind: 'action', role: 'lead' } });

    const forged = content(await bridge(root, { PASEO_ROOM_CORRELATION: peer, PASEO_ROOM_ROLE: 'peer', PASEO_ROOM_WORK_KIND: 'engineer' })
      .request('tools/call', { name: 'assignment_accept', arguments: { assignmentId: 'asg_abcdefgh', reason: 'x' } }));
    expect(forged).toMatchObject({ isError: true, body: { error: { code: 'report_unauthorized' } } });

    const leadCallsPeerTool = content(await bridge(root, { PASEO_ROOM_CORRELATION: lead, PASEO_ROOM_ROLE: 'lead' }).request('tools/call', { name: 'handoff', arguments: {} }));
    expect(leadCallsPeerTool).toMatchObject({ isError: true, body: { error: { code: 'unauthorized' } } });

    const unbound = content(await bridge(root, { PASEO_ROOM_CORRELATION: 'cor_unknown', PASEO_ROOM_ROLE: 'lead' }).request('tools/call', { name: 'assignment_status', arguments: {} }));
    expect(unbound).toMatchObject({ isError: true, body: { error: { code: 'unauthorized' } } });

    await writeFile(join(root, 'spool', 'requests', 'req_garbage1.json'), '{ nope');
    const running = spools[0];
    await running?.schedule();
    const reply = JSON.parse(await readFile(join(root, 'spool', 'replies', 'req_garbage1.json'), 'utf8')) as { ok: boolean; result: { error: { code: string } } };
    expect(reply).toMatchObject({ ok: false, result: { error: { code: 'request_malformed' } } });
  });

  it('drains a request published before the server started', async () => {
    const root = await runtimeRoot();
    const correlation = `cor_${'d'.repeat(32)}`;
    await mkdir(join(root, 'spool', 'requests'), { recursive: true });
    await writeFile(join(root, 'spool', 'requests', 'req_early0001.json'), JSON.stringify({ protocol: 1, requestId: 'req_early0001', operation: 'room_status', payload: {}, correlation }));
    const started = await spool(root, { [correlation]: { kind: 'action', role: 'supervisor' } });
    expect(await started.unresolved()).toEqual([]);
    expect(JSON.parse(await readFile(join(root, 'spool', 'replies', 'req_early0001.json'), 'utf8'))).toMatchObject({ ok: true, result: { handled: 'room_status' } });
  });

  it('returns a retryable uncertain result when the runtime does not answer', async () => {
    const root = await runtimeRoot();
    const client = bridge(root, { PASEO_ROOM_CORRELATION: `cor_${'e'.repeat(32)}`, PASEO_ROOM_ROLE: 'peer', PASEO_ROOM_WORK_KIND: 'engineer', PASEO_ROOM_REPLY_WAIT_MS: '200' });
    const result = content(await client.request('tools/call', { name: 'handoff', arguments: {} }));
    expect(result).toMatchObject({ isError: true, body: { error: { code: 'report_uncertain', retryable: true } } });
  });
});
