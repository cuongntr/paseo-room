import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PI_RUNTIME_CAPSULE, PI_STYLE_CAPSULE, piAgent, probePiMcp, renderPiAppend, renderPiSettings,
} from '../src/agents/pi.js';
import { applyEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { makeFixture, nodeScript, script } from './helpers.js';

const probeId = 'paseo-room-pi-mcp-probe';

function response(commands: unknown[]): string {
  return JSON.stringify({ id: probeId, type: 'response', command: 'get_commands', success: true, data: { commands } });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`Did not settle within ${String(timeoutMs)}ms.`)); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>(resolveDelay => { setTimeout(resolveDelay, 10); });
  }
  throw new Error(`File did not appear within ${String(timeoutMs)}ms: ${path}`);
}

describe('Pi prompt and settings composition', () => {
  it('preserves operator append content before style, runtime, and the role contract', () => {
    const rendered = renderPiAppend('# Operator append', 'peer');
    const positions = [
      rendered.indexOf('# Operator append'), rendered.indexOf(PI_STYLE_CAPSULE),
      rendered.indexOf(PI_RUNTIME_CAPSULE), rendered.indexOf('You are Peer'),
    ];
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(rendered).not.toContain('--system-prompt');
  });

  it('copies preferences while removing package and extension declarations', () => {
    const settings = JSON.parse(renderPiSettings(JSON.stringify({
      defaultModel: 'keep-me', packages: ['npm:pi-mcp-adapter'], extensions: ['./other.ts'], custom: { enabled: true },
    }))) as Record<string, unknown>;
    expect(settings).toMatchObject({ defaultModel: 'keep-me', custom: { enabled: true } });
    expect(settings.packages).toBeUndefined();
    expect(settings.extensions).toBeUndefined();
    expect(() => renderPiSettings('[]')).toThrow('JSON object');
  });
});

describe('piAgent.build', () => {
  it('creates isolated role homes, shares safe resources, and excludes extension stores and trust', async () => {
    const fixture = await makeFixture();
    const piHome = join(fixture.home, '.pi/agent');
    const operatorMcpPath = join(piHome, 'mcp.json');
    const operatorMcp = '{"mcpServers":{"operator":{"command":"safe"}}}\n';
    await writeFile(join(piHome, 'APPEND_SYSTEM.md'), '# Operator append\n');
    await writeFile(operatorMcpPath, operatorMcp);
    await writeFile(join(piHome, 'trust.json'), '{}');
    const operatorSettings = await readFile(join(piHome, 'settings.json'), 'utf8');
    const layout = resolveLayout({}, fixture.env);
    const plan = await piAgent.build(layout, ['supervisor', 'lead', 'peer']);
    expect(plan.checks.every(check => check.status === 'pass')).toBe(true);
    await applyEntries(plan.entries);

    const peer = join(fixture.roomHome, 'roles/pi/peer');
    const settings = JSON.parse(await readFile(join(peer, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings.defaultProvider).toBe('openai');
    expect(settings.packages).toBeUndefined();
    expect(settings.extensions).toBeUndefined();
    await expect(readFile(join(peer, 'auth.json'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(piHome, 'auth.json'), 'utf8')).toBe('{"token":"pi-secret"}');
    expect(await readFile(join(peer, 'APPEND_SYSTEM.md'), 'utf8')).toContain('You are Peer');
    for (const role of ['supervisor', 'lead', 'peer']) {
      const roleMcp = join(fixture.roomHome, `roles/pi/${role}/mcp.json`);
      expect(await realpath(roleMcp)).toBe(await realpath(operatorMcpPath));
      expect(await readFile(roleMcp, 'utf8')).toBe(operatorMcp);
    }
    await expect(stat(join(peer, 'npm'))).rejects.toThrow();
    await expect(stat(join(peer, 'extensions'))).rejects.toThrow();
    await expect(stat(join(peer, 'trust.json'))).rejects.toThrow();
    await expect(stat(join(peer, 'SYSTEM.md'))).rejects.toThrow();
    expect(await readFile(join(piHome, 'settings.json'), 'utf8')).toBe(operatorSettings);
    expect(plan.credentials).toHaveLength(3);
  });

  it('fails closed for a missing or malformed adapter package', async () => {
    const missing = await makeFixture();
    await rm(join(missing.home, '.pi/agent/npm/node_modules/pi-mcp-adapter'), { recursive: true });
    expect((await piAgent.build(resolveLayout({}, missing.env), ['lead'])).checks[0]?.id).toBe('pi.adapter');

    const malformed = await makeFixture();
    await writeFile(join(malformed.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/package.json'), '{bad json');
    expect((await piAgent.build(resolveLayout({}, malformed.env), ['lead'])).checks[0]?.status).toBe('fail');

    const wrongIdentity = await makeFixture();
    await writeFile(join(wrongIdentity.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/package.json'), JSON.stringify({
      name: 'not-pi-mcp-adapter', pi: { extensions: ['./index.ts'] },
    }));
    expect((await piAgent.build(resolveLayout({}, wrongIdentity.env), ['lead'])).checks[0]?.message)
      .toContain('does not identify');
  });

  it('rejects an adapter entry whose canonical path escapes the package', async () => {
    const fixture = await makeFixture();
    const root = join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter');
    const outside = join(fixture.home, 'outside.ts');
    await writeFile(outside, 'export default function adapter() {}\n');
    await rm(join(root, 'index.ts'));
    await symlink(outside, join(root, 'index.ts'));
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['lead']);
    expect(plan.checks[0]?.message).toContain('escapes');
    expect(plan.binary).toBeUndefined();
  });

  it('probes with an isolated home, exclusive adapter config, offline mode, and strict extension flags', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    await nodeScript(binary, `
const args = process.argv.slice(2);
const expected = ['--mode', 'rpc', '--no-session', '--no-extensions', '--extension', args[5], '--no-approve'];
if (JSON.stringify(args) !== JSON.stringify(expected) || process.env.HOME !== process.cwd() || process.env.PI_CODING_AGENT_DIR !== '/dev/null' || process.env.PI_MCP_CONFIG_MODE !== 'exclusive' || process.env.PI_OFFLINE !== '1') process.exit(2);
console.log(JSON.stringify({ id: '${probeId}', type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'mcp', source: 'extension', sourceInfo: { path: args[5] } }] } }));
`);
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['lead']);
    expect(plan.checks.every(check => check.status === 'pass')).toBe(true);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('fails when optional Pi configuration exists but cannot be read as a file', async () => {
    const settingsFixture = await makeFixture();
    const settingsPath = join(settingsFixture.home, '.pi/agent/settings.json');
    await rm(settingsPath);
    await mkdir(settingsPath);
    const settingsPlan = await piAgent.build(resolveLayout({}, settingsFixture.env), ['lead']);
    expect(settingsPlan.checks.at(-1)).toMatchObject({ id: 'pi.settings', status: 'fail' });
    expect(settingsPlan.checks.at(-1)?.fix).toContain('readable');

    const appendFixture = await makeFixture();
    const appendPath = join(appendFixture.home, '.pi/agent/APPEND_SYSTEM.md');
    await mkdir(appendPath);
    const appendPlan = await piAgent.build(resolveLayout({}, appendFixture.env), ['lead']);
    expect(appendPlan.checks.at(-1)).toMatchObject({ id: 'pi.append', status: 'fail' });
    expect(appendPlan.checks.at(-1)?.fix).toContain('readable');
  });
});

describe('Pi capability probe', () => {
  it('isolates HOME and excludes global and project MCP discovery inputs', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    const entry = await realpath(join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts'));
    const callerPath = join(fixture.home, 'caller');
    await mkdir(callerPath);
    const caller = await realpath(callerPath);
    const commands = join(caller, '.pi/commands');
    const command = join(commands, 'keep.bin');
    const probeRecord = join(fixture.home, 'probe-record');
    const discoveryInputs = [
      join(fixture.home, '.config/mcp/mcp.json'),
      join(fixture.home, '.agents/mcp.json'),
      join(caller, '.mcp.json'),
      join(caller, '.pi/mcp.json'),
    ];
    const original = Buffer.from([0, 1, 2, 255]);
    await mkdir(commands, { recursive: true });
    await writeFile(command, original);
    for (const path of discoveryInputs) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{}\n');
    }
    await nodeScript(binary, `
const { existsSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const caller = process.env.PROBE_CALLER_CWD;
if (process.cwd() === caller && existsSync(join(caller, '.pi/commands'))) {
  renameSync(join(caller, '.pi/commands'), join(caller, '.pi/prompts'));
}
const automaticSources = [
  join(process.env.HOME, '.config/mcp/mcp.json'),
  join(process.env.HOME, '.agents/mcp.json'),
  join(process.cwd(), '.mcp.json'),
  join(process.cwd(), '.pi/mcp.json'),
].filter(existsSync);
const selectedSources = process.env.PI_MCP_CONFIG_MODE === 'exclusive'
  ? [join(process.env.PI_CODING_AGENT_DIR, 'mcp.json')]
  : automaticSources;
writeFileSync(process.env.PROBE_RECORD, JSON.stringify({
  cwd: process.cwd(), home: process.env.HOME, mode: process.env.PI_MCP_CONFIG_MODE,
  agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE,
  automaticSources, selectedSources,
}));
console.log(${JSON.stringify(response([{ name: 'mcp', source: 'extension', sourceInfo: { path: entry } }]))});
`);

    const previous = process.cwd();
    let check;
    try {
      process.chdir(caller);
      check = await probePiMcp(binary, entry, {
        HOME: fixture.home,
        PATH: join(fixture.home, 'bin'),
        PROBE_CALLER_CWD: caller,
        PROBE_RECORD: probeRecord,
      });
    } finally {
      process.chdir(previous);
    }

    expect(check.status).toBe('pass');
    expect(await readFile(command)).toEqual(original);
    expect((await stat(commands)).isDirectory()).toBe(true);
    await expect(stat(join(caller, '.pi/prompts'))).rejects.toThrow();
    const record = JSON.parse(await readFile(probeRecord, 'utf8')) as {
      cwd: string; home: string; mode: string; agentDir: string; offline: string;
      automaticSources: string[]; selectedSources: string[];
    };
    expect(record).toMatchObject({
      home: record.cwd, mode: 'exclusive', agentDir: '/dev/null', offline: '1',
      automaticSources: [], selectedSources: ['/dev/null/mcp.json'],
    });
    expect(record.cwd).not.toBe(caller);
    expect(record.selectedSources).not.toEqual(expect.arrayContaining(discoveryInputs));
    await expect(stat(record.cwd)).rejects.toThrow();
  });

  it('rejects absent /mcp and the wrong command source', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    const entry = join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts');
    const env = { HOME: fixture.home, PATH: join(fixture.home, 'bin') };
    await script(binary, response([]));
    expect((await probePiMcp(binary, entry, env)).status).toBe('fail');
    await script(binary, response([{ name: 'mcp', source: 'prompt', sourceInfo: { path: entry } }]));
    expect((await probePiMcp(binary, entry, env)).message).toContain('wrong source');
  });

  it('rejects malformed output, process failure, excess output, and timeout', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    const entry = join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts');
    const env = { HOME: fixture.home, PATH: join(fixture.home, 'bin') };
    await script(binary, 'not-json');
    expect((await probePiMcp(binary, entry, env)).message).toContain('malformed JSONL');
    await script(binary, response([{ name: 'mcp', source: 'extension', sourceInfo: { path: entry } }]), 1);
    expect((await probePiMcp(binary, entry, env)).message).toContain('probe failed');
    await script(binary, 'x'.repeat(128));
    expect((await probePiMcp(binary, entry, env, { outputLimit: 32 })).message).toContain('output limit');
    await nodeScript(binary, 'setInterval(() => {}, 1000);');
    expect((await probePiMcp(binary, entry, env, { timeoutMs: 20 })).message).toContain('timed out');
  });

  it('settles timeout and overflow when a descendant retains the output pipes', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    const entry = join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts');
    const env = { HOME: fixture.home, PATH: join(fixture.home, 'bin') };
    const timeoutReady = join(fixture.home, 'timeout-ready');
    const timeoutSentinel = join(fixture.home, 'timeout-descendant-survived');
    const overflowReady = join(fixture.home, 'overflow-ready');
    const overflowSentinel = join(fixture.home, 'overflow-descendant-survived');
    const retainPipes = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = "setTimeout(() => require('node:fs').writeFileSync(process.env.DESCENDANT_SENTINEL, 'alive'), 3000); setTimeout(() => {}, 5000);";
spawn(process.execPath, ['-e', descendant], { stdio: ['ignore', process.stdout, process.stderr] });
writeFileSync(process.env.DESCENDANT_READY, 'ready');
`;

    await nodeScript(binary, `${retainPipes}\nprocess.exit(0);`);
    const timeoutProbe = probePiMcp(binary, entry, {
      ...env, DESCENDANT_READY: timeoutReady, DESCENDANT_SENTINEL: timeoutSentinel,
    }, { timeoutMs: 2000 });
    await waitForFile(timeoutReady, 1500);
    const timedOut = await settleWithin(timeoutProbe, 2500);
    expect(timedOut.message).toContain('timed out');
    expect(await readFile(timeoutReady, 'utf8')).toBe('ready');

    await nodeScript(binary, `${retainPipes}\nprocess.stdout.write('x'.repeat(128));`);
    const overflowProbe = probePiMcp(binary, entry, {
      ...env, DESCENDANT_READY: overflowReady, DESCENDANT_SENTINEL: overflowSentinel,
    }, { outputLimit: 32 });
    await waitForFile(overflowReady, 1500);
    const overflowed = await settleWithin(overflowProbe, 1500);
    expect(overflowed.message).toContain('output limit');
    expect(await readFile(overflowReady, 'utf8')).toBe('ready');

    await new Promise<void>(resolveDelay => { setTimeout(resolveDelay, 3200); });
    await expect(stat(timeoutSentinel)).rejects.toThrow();
    await expect(stat(overflowSentinel)).rejects.toThrow();
  }, 10_000);

  it('rejects /mcp attributed to a different canonical extension path', async () => {
    const fixture = await makeFixture();
    const binary = join(fixture.home, 'bin/pi');
    const entry = join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts');
    const other = join(fixture.home, 'other.ts');
    await writeFile(other, 'export default function other() {}\n');
    await script(binary, response([{ name: 'mcp', source: 'extension', sourceInfo: { path: other } }]));
    expect((await probePiMcp(binary, entry, { HOME: fixture.home, PATH: join(fixture.home, 'bin') })).message)
      .toContain('different extension path');
  });
});
