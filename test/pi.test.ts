import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piAgent, probePiMcp, renderPiAppend, renderPiSettings } from '../src/agents/pi.js';
import { loadPromptAsset } from '../src/room/prompts.js';
import { applyEntries, planEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { renderInstructions } from '../src/room/instructions.js';
import { leadSkillProjection, ROOM_SKILL_NAME, roomSkillSource } from '../src/room/skills.js';
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
  it('preserves the exact operator, style, runtime, and role-document order', () => {
    const roleDocument = renderInstructions('peer');
    const roomAppend = [
      loadPromptAsset('pi', 'communicationStyle'),
      loadPromptAsset('pi', 'runtime'),
      roleDocument,
    ].join('\n\n');
    const expected = `# Operator append\n\n${roomAppend}`;
    expect(renderPiAppend('# Operator append\n', 'peer')).toBe(expected);
    expect(renderPiAppend(undefined, 'peer')).toBe(roomAppend);
    expect(expected).not.toContain('--system-prompt');
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
    expect(await readFile(join(peer, 'APPEND_SYSTEM.md'), 'utf8')).toBe(renderPiAppend('# Operator append\n', 'peer'));
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

describe('piAgent.build resource distribution', () => {
  async function operatorResources(home: string): Promise<void> {
    const pi = join(home, '.pi/agent');
    await mkdir(join(pi, 'skills', 'formatting'), { recursive: true });
    await mkdir(join(pi, 'skills', 'paseo-advisor'), { recursive: true });
    await mkdir(join(pi, 'prompts'), { recursive: true });
    await writeFile(join(pi, 'keybindings.json'), '{}');
  }

  it('keeps Supervisor and Lead sharing while Peer omits executable prompts', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await piAgent.build(layout, ['supervisor', 'lead', 'peer'])).entries);

    const operator = layout.agentHome.pi;
    for (const role of ['supervisor', 'lead'] as const) {
      const home = join(layout.roomHome, 'roles/pi', role);
      expect(await realpath(join(home, 'prompts'))).toBe(await realpath(join(operator, 'prompts')));
    }
    // Supervisor keeps the whole-directory alias; Lead projects the operator skills plus the
    // room-owned one without modifying the operator home.
    expect(await realpath(join(layout.roomHome, 'roles/pi/supervisor/skills')))
      .toBe(await realpath(join(operator, 'skills')));
    const leadSkills = join(layout.roomHome, 'roles/pi/lead/skills');
    expect((await lstat(leadSkills)).isSymbolicLink()).toBe(true);
    expect(await readlink(leadSkills)).toBe(leadSkillProjection(layout, 'pi'));
    expect((await readdir(leadSkills)).sort()).toEqual(['formatting', ROOM_SKILL_NAME, 'paseo-advisor'].sort());
    expect(await readlink(join(leadSkills, ROOM_SKILL_NAME))).toBe(roomSkillSource(layout));
    expect((await readdir(join(operator, 'skills'))).sort()).toEqual(['formatting', 'paseo-advisor']);
    const peer = join(layout.roomHome, 'roles/pi/peer');
    await expect(stat(join(peer, 'prompts'))).rejects.toThrow();
    expect(await readFile(join(peer, 'keybindings.json'), 'utf8')).toBe('{}');
  });

  it('projects Peer skills exactly and repairs inventory drift', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await piAgent.build(layout, ['peer'])).entries);
    const skills = join(layout.roomHome, 'roles/pi/peer/skills');
    expect(await readdir(skills)).toEqual(['formatting']);

    await rm(join(layout.agentHome.pi, 'skills', 'formatting'), { recursive: true });
    await mkdir(join(layout.agentHome.pi, 'skills', 'reviewing'), { recursive: true });
    const drifted = await piAgent.build(layout, ['peer']);
    expect((await planEntries(drifted.entries)).filter(operation => operation.action !== 'noop'))
      .toEqual([
        { action: 'update', kind: 'dir', target: skills },
        { action: 'create', kind: 'link', target: join(skills, 'reviewing') },
      ]);
    await applyEntries(drifted.entries);
    expect(await readdir(skills)).toEqual(['reviewing']);
  });
});

describe('piAgent.build MCP conflict detection', () => {
  it('fails before apply for a recognizable adapter config server', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.pi/agent/mcp.json'), JSON.stringify({
      mcpServers: { room: { command: '/opt/paseo/bin/mcp' } },
    }));
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['supervisor', 'lead', 'peer']);
    const check = plan.checks.find(entry => entry.id === 'pi.mcp');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('mcp.json');
    expect(check?.message).toContain('room (command: /opt/paseo/bin/mcp)');
    expect(plan.entries).toHaveLength(0);
    expect(plan.binary).toBeUndefined();
  });

  it('reads the alternative servers key and passes benign declarations', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.pi/agent/mcp.json'), JSON.stringify({
      servers: { bridge: { url: 'http://127.0.0.1:6767/paseo/mcp' } },
    }));
    expect((await piAgent.build(resolveLayout({}, fixture.env), ['peer'])).checks.find(check => check.id === 'pi.mcp')?.status)
      .toBe('fail');

    const benign = await makeFixture();
    await writeFile(join(benign.home, '.pi/agent/mcp.json'), JSON.stringify({
      mcpServers: { docs: { command: 'uvx', args: ['mcp-server-docs'] } },
    }));
    const plan = await piAgent.build(resolveLayout({}, benign.env), ['peer']);
    expect(plan.checks.some(check => check.status === 'fail')).toBe(false);
  });

  // Pi loads both keys, so a benign first table must not shadow a conflict in the second.
  it('fails when a benign mcpServers table precedes a Paseo servers table', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.pi/agent/mcp.json'), JSON.stringify({
      mcpServers: { docs: { command: 'uvx', args: ['mcp-server-docs'] } },
      servers: { bridge: { url: 'http://127.0.0.1:6767/paseo/mcp' } },
    }));
    const check = (await piAgent.build(resolveLayout({}, fixture.env), ['peer'])).checks.find(entry => entry.id === 'pi.mcp');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('bridge (url: http://127.0.0.1:6767/paseo/mcp)');
  });

  it('fails when mcp.json cannot be read or parsed', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.home, '.pi/agent/mcp.json'));
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['peer']);
    expect(plan.checks.at(-1)).toMatchObject({ id: 'pi.mcp', status: 'fail' });
    expect(plan.checks.at(-1)?.fix).toContain('readable');

    const malformed = await makeFixture();
    await writeFile(join(malformed.home, '.pi/agent/mcp.json'), '{not json');
    const malformedPlan = await piAgent.build(resolveLayout({}, malformed.env), ['peer']);
    expect(malformedPlan.checks.at(-1)).toMatchObject({ id: 'pi.mcp', status: 'fail' });
    expect(malformedPlan.entries).toHaveLength(0);
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
