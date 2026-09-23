import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { renderRoleMemory } from '../src/agents/claude.js';
import { renderPiAppend } from '../src/agents/pi.js';
import { runCli } from '../src/cli.js';
import metadata from '../package.json' with { type: 'json' };
import { renderMarker } from '../src/room.js';
import { contractDigest, renderInstructions } from '../src/room/instructions.js';
import { ROOM_SKILL_NAME } from '../src/room/skills.js';
import type { AgentId, Role } from '../src/roles.js';
import { emptyDaemon, fakeClient, makeFixture, RUNNING_STATUS, RUNNING_STATUS_09, script, type FakeDaemon } from './helpers.js';

async function run(argv: readonly string[], env: NodeJS.ProcessEnv, daemon: FakeDaemon): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, { stdout: text => { out += text; }, stderr: text => { err += text; } }, {
    isTTY: false,
    options: { env, factory: fakeClient(daemon) },
  });
  return { code, out, err };
}

const version = metadata.version;

/** Headings the removed always-on default workspace document used to contribute to Lead. */
const RETIRED_WORKSPACE_HEADINGS = [
  'Status and Readers',
  'Topology',
  'Dispositions',
  'Routing',
  'Ownership and Candidates',
  'Anti-Patterns',
  'Protocol Evolution',
] as const;

function retiredWorkspaceHeadings(document: string): string[] {
  return [...document.matchAll(/^## (.+)$/gm)]
    .map(match => match[1] ?? '')
    .filter(heading => RETIRED_WORKSPACE_HEADINGS.includes(heading as typeof RETIRED_WORKSPACE_HEADINGS[number]));
}

describe('paseo-room CLI', () => {
  it('reports a refused path with its own remedy, not the daemon hint', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    // A directory where the room owns a link: reached the filesystem, so the daemon is fine.
    const alias = join(fixture.roomHome, 'roles/codex/peer/skills/formatting');
    await rm(alias, { recursive: true, force: true });
    await mkdir(alias, { recursive: true });

    const refused = await run(['setup', '--apply'], fixture.env, daemon);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('Refusing to remove');
    expect(refused.out).toContain('move it aside manually');
    expect(refused.out).not.toContain('Check that Paseo is running');
  });

  it('is a dry run by default and writes nothing', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run(['setup'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Planned changes');
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('carries the Claude memory-contract choice only on setup', async () => {
    const fixture = await makeFixture();
    const operatorMemory = '# Operator Claude memory\n';
    await writeFile(join(fixture.home, '.claude/CLAUDE.md'), operatorMemory);
    const daemon = emptyDaemon();
    const leadMemory = join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md');

    const applied = await run(['setup', '--agent', 'claude', '--no-claude-memory-contract', '--apply'], fixture.env, daemon);
    expect(applied.code).toBe(0);
    expect(await readFile(leadMemory, 'utf8')).toBe(operatorMemory);
    expect(applied.out).toContain('global memory only');

    // verify and remove read the choice from the marker, so repeating it is a usage error
    // rather than a silently ignored flag.
    for (const command of ['verify', 'remove'] as const) {
      const rejected = await run([command, '--no-claude-memory-contract'], fixture.env, daemon);
      expect(rejected.code).toBe(2);
      expect(rejected.err).toContain('recorded in the room marker');
    }
    // auth reads no marker, so it must not claim to: its own rejection names what it does.
    const authRejected = await run(
      ['auth', 'login', 'claude', 'lead', '--no-claude-memory-contract'], fixture.env, daemon,
    );
    expect(authRejected.code).toBe(2);
    expect(authRejected.err).toContain('only authenticates a role');
    expect(authRejected.err).not.toContain('room marker');
    // Without the flag, verify still agrees with the room it recorded.
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(0);
    // The default remains the fallback: no flag restores the contract.
    expect((await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon)).code).toBe(0);
    expect(await readFile(leadMemory, 'utf8')).toBe(`${operatorMemory}\n${renderInstructions('lead')}`);
  });

  it('applies both agents and registers six providers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers).sort()).toEqual([
      'claude-lead', 'claude-peer', 'claude-supervisor', 'codex-lead', 'codex-peer', 'codex-supervisor',
    ]);
    expect(daemon.refreshed).toHaveLength(6);
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as { agents: string[] };
    expect(marker.agents).toEqual(['codex', 'claude']);
    // The Peer-gets-no-room-tools rule, checked where it actually lands.
    const tools = (id: string): unknown => (daemon.providers[id] as { paseoTools: { enabled: boolean } }).paseoTools.enabled;
    expect([tools('codex-supervisor'), tools('codex-lead'), tools('codex-peer')]).toEqual([true, true, false]);
    expect([tools('claude-supervisor'), tools('claude-lead'), tools('claude-peer')]).toEqual([true, true, false]);
  });

  it('connects every profile and provider to the exact role home and complete role document', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const claudeMemory = '# Operator Claude memory\n';
    const piAppend = '# Operator Pi append\n';
    await writeFile(join(fixture.home, '.claude/CLAUDE.md'), claudeMemory);
    await writeFile(join(fixture.home, '.pi/agent/APPEND_SYSTEM.md'), piAppend);
    const agents: readonly AgentId[] = ['codex', 'claude', 'pi'];
    const roles: readonly Role[] = ['supervisor', 'lead', 'peer'];
    const homeEnv: Record<AgentId, string> = {
      codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', pi: 'PI_CODING_AGENT_DIR',
    };
    const mode: Partial<Record<AgentId, string>> = {
      codex: 'full-access', claude: 'bypassPermissions',
    };
    const result = await run([
      'setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply',
    ], fixture.env, daemon);
    expect(result.code).toBe(0);

    for (const agent of agents) {
      for (const role of roles) {
        const providerId = `${agent}-${role}`;
        const rolePath = join(fixture.roomHome, `roles/${agent}/${role}`);
        const provider = daemon.providers[providerId] as { command: string[]; env: Record<string, string> };
        const profile = daemon.agentProfiles.find(entry => entry.id === `room-${agent}-${role}`);
        expect(profile?.provider).toBe(providerId);
        expect(profile?.modeId).toBe(mode[agent]);
        expect(Object.hasOwn(profile ?? {}, 'modeId')).toBe(agent !== 'pi');
        expect(provider.env[homeEnv[agent]]).toBe(rolePath);

        const expected = renderInstructions(role);
        let delivered: string;
        if (agent === 'codex') {
          const config = parse(await readFile(join(rolePath, 'config.toml'), 'utf8')) as Record<string, unknown>;
          expect(config.developer_instructions).toBe(expected);
          expect(await readFile(join(rolePath, 'role-instructions.md'), 'utf8')).toBe(expected);
          delivered = String(config.developer_instructions);
        } else if (agent === 'claude') {
          delivered = await readFile(join(rolePath, 'CLAUDE.md'), 'utf8');
          expect(delivered).toBe(renderRoleMemory(claudeMemory, role));
          expect(delivered.endsWith(expected)).toBe(true);
        } else {
          const appendPath = join(rolePath, 'APPEND_SYSTEM.md');
          delivered = await readFile(appendPath, 'utf8');
          expect(delivered).toBe(renderPiAppend(piAppend, role));
          expect(delivered.endsWith(expected)).toBe(true);
          const flag = provider.command.indexOf('--append-system-prompt');
          expect(flag).toBeGreaterThan(-1);
          expect(provider.command[flag + 1]).toBe(appendPath);
        }
        // No seat carries the removed default workspace document.
        expect(retiredWorkspaceHeadings(delivered)).toEqual([]);
        expect(delivered).not.toContain('# Workspace protocol');
      }
    }

    // The room no longer generates a protocol template of its own.
    await expect(stat(join(fixture.roomHome, 'room/WORKSPACE_PROTOCOL.md'))).rejects.toThrow();
  });

  it('is idempotent: a second run plans no changes and verify passes', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const second = await run(['setup'], fixture.env, daemon);
    expect(second.out).toContain('already up to date');
    const verified = await run(['verify', '--json'], fixture.env, daemon);
    expect(verified.code).toBe(0);
    expect((JSON.parse(verified.out) as { outcome: string }).outcome).toBe('ok');
  });

  it('creates no role credential artifacts and leaves dummy operator credentials unread/copied', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await writeFile(join(fixture.home, '.claude/.credentials.json'), Buffer.from([0, 1, 2, 255]));
    const result = await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    for (const role of ['supervisor', 'lead', 'peer']) {
      await expect(lstat(join(fixture.roomHome, `roles/codex/${role}/auth.json`))).rejects.toThrow();
      await expect(lstat(join(fixture.roomHome, `roles/claude/${role}/.credentials.json`))).rejects.toThrow();
      await expect(lstat(join(fixture.roomHome, `roles/pi/${role}/auth.json`))).rejects.toThrow();
    }
    expect(await readFile(join(fixture.home, '.codex/auth.json'), 'utf8')).toBe('{"token":"secret"}');
    expect(await readFile(join(fixture.home, '.claude/.credentials.json'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(fixture.home, '.pi/agent/auth.json'), 'utf8')).toBe('{"token":"pi-secret"}');
  });

  it('preserves every credential path shape across apply, verify, and repeated update', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const codexSupervisor = join(fixture.roomHome, 'roles/codex/supervisor/auth.json');
    const codexLead = join(fixture.roomHome, 'roles/codex/lead/auth.json');
    const codexPeer = join(fixture.roomHome, 'roles/codex/peer/auth.json');
    const claudeLead = join(fixture.roomHome, 'roles/claude/lead/.credentials.json');
    const claudePeer = join(fixture.roomHome, 'roles/claude/peer/.credentials.json');
    const piPeer = join(fixture.roomHome, 'roles/pi/peer/auth.json');
    const sharedTarget = join(fixture.home, '.codex/auth.json');
    const danglingTarget = join(fixture.home, 'never-created-auth.json');
    const codexBytes = Buffer.from([0, 10, 255, 42]);
    const claudeBytes = Buffer.from([9, 8, 7, 0]);
    for (const path of [codexSupervisor, codexLead, codexPeer, claudeLead, claudePeer, piPeer]) {
      await mkdir(join(path, '..'), { recursive: true });
    }
    await symlink(sharedTarget, codexSupervisor);
    await symlink(danglingTarget, codexLead);
    await writeFile(codexPeer, codexBytes);
    await writeFile(claudeLead, claudeBytes);
    await mkdir(claudePeer);
    await symlink(join(fixture.home, '.pi/agent/auth.json'), piPeer);

    const argv = ['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'] as const;
    const applied = await run(argv, fixture.env, daemon);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('legacy-shared-risk');
    expect(applied.out).toContain('Its target was not inspected, followed, or changed');
    expect(applied.out).toContain('configured structurally (diverged-file-preserve)');
    expect(applied.out).toContain('diverged-file-preserve/manual-recovery');
    expect(await readlink(codexSupervisor)).toBe(sharedTarget);
    expect(await readlink(codexLead)).toBe(danglingTarget);
    expect(await readFile(codexPeer)).toEqual(codexBytes);
    expect(await readFile(claudeLead)).toEqual(claudeBytes);
    expect((await lstat(claudePeer)).isDirectory()).toBe(true);
    expect(await readlink(piPeer)).toBe(join(fixture.home, '.pi/agent/auth.json'));

    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(0);
    expect(verified.out).toContain('verify: ok');
    const repeated = await run(argv, fixture.env, daemon);
    expect(repeated.code).toBe(0);
    expect(await readlink(codexSupervisor)).toBe(sharedTarget);
    expect(await readlink(codexLead)).toBe(danglingTarget);
    expect(await readFile(codexPeer)).toEqual(codexBytes);
    expect(await readFile(claudeLead)).toEqual(claudeBytes);
    expect((await lstat(claudePeer)).isDirectory()).toBe(true);
    expect(await readlink(piPeer)).toBe(join(fixture.home, '.pi/agent/auth.json'));
  });

  it('verify fails when a managed file or provider drifts', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    daemon.providers['codex-peer'] = { ...(daemon.providers['codex-peer'] as object), paseoTools: { enabled: true } };
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });

  it('detects, describes, repairs, and stabilizes drift in every managed prompt carrier', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const argv = ['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi'] as const;
    expect((await run([...argv, '--apply'], fixture.env, daemon)).code).toBe(0);

    const carriers = [
      join(fixture.roomHome, 'roles/codex/lead/config.toml'),
      join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md'),
      join(fixture.roomHome, 'roles/pi/lead/APPEND_SYSTEM.md'),
      join(fixture.roomHome, `room/skills/${ROOM_SKILL_NAME}/SKILL.md`),
      join(fixture.roomHome, `room/skills/${ROOM_SKILL_NAME}/references/workspace-protocol-template.md`),
    ];
    const originals = new Map<string, string>();
    for (const path of carriers) {
      const original = await readFile(path, 'utf8');
      originals.set(path, original);
      await writeFile(path, `${original}\ndrift\n`);
    }
    const expectedCarrier = (path: string): string => {
      const content = originals.get(path);
      if (content === undefined) throw new Error(`missing original carrier for ${path}`);
      return content;
    };
    const roleCredential = join(fixture.roomHome, 'roles/pi/lead/auth.json');
    const credentialBytes = Buffer.from([5, 0, 255, 8]);
    await writeFile(roleCredential, credentialBytes);
    const operatorCredentials = new Map([
      [join(fixture.home, '.codex/auth.json'), await readFile(join(fixture.home, '.codex/auth.json'))],
      [join(fixture.home, '.pi/agent/auth.json'), await readFile(join(fixture.home, '.pi/agent/auth.json'))],
    ]);
    const providersBefore = JSON.stringify(daemon.providers);
    const profilesBefore = JSON.stringify(daemon.agentProfiles);

    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('managed role files are missing or outdated');

    const preview = await run(argv, fixture.env, daemon);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('Planned changes');
    for (const path of carriers) {
      expect(preview.out).toContain(`update file ${path}`);
      expect(await readFile(path, 'utf8')).toBe(`${expectedCarrier(path)}\ndrift\n`);
    }
    expect(JSON.stringify(daemon.providers)).toBe(providersBefore);
    expect(JSON.stringify(daemon.agentProfiles)).toBe(profilesBefore);

    const repaired = await run([...argv, '--apply'], fixture.env, daemon);
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain('Applied:');
    for (const path of carriers) expect(await readFile(path, 'utf8')).toBe(expectedCarrier(path));
    expect(await readFile(roleCredential)).toEqual(credentialBytes);
    for (const [path, bytes] of operatorCredentials) expect(await readFile(path)).toEqual(bytes);
    expect(JSON.stringify(daemon.providers)).toBe(providersBefore);
    expect(JSON.stringify(daemon.agentProfiles)).toBe(profilesBefore);
    for (const agent of ['codex', 'claude', 'pi']) {
      expect((daemon.providers[`${agent}-peer`] as { paseoTools: { enabled: boolean } }).paseoTools.enabled).toBe(false);
      expect(daemon.agentProfiles.find(profile => profile.id === `room-${agent}-peer`)?.provider).toBe(`${agent}-peer`);
    }

    const stable = await run(argv, fixture.env, daemon);
    expect(stable.out).toContain('Everything is already up to date.');
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(0);
  });

  it('removes only the room home and its providers', async () => {
    const fixture = await makeFixture();
    const daemon = { ...emptyDaemon(), providers: { unrelated: { extends: 'pi' } } as Record<string, unknown> };
    await run(['setup', '--apply'], fixture.env, daemon);
    const roleCredential = join(fixture.roomHome, 'roles/codex/lead/auth.json');
    const roleBytes = Buffer.from([7, 0, 9, 255]);
    await writeFile(roleCredential, roleBytes);
    const preview = await run(['remove'], fixture.env, daemon);
    expect(preview.out).toContain('role-owned credential files');
    expect(preview.out).toContain('Native OS keyring entries');
    expect(await readFile(roleCredential)).toEqual(roleBytes);
    const removed = await run(['remove', '--apply'], fixture.env, daemon);
    expect(removed.out).toContain('role-owned credential files');
    expect(Object.keys(daemon.providers)).toEqual(['unrelated']);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    await expect(stat(join(fixture.home, '.codex', 'config.toml'))).resolves.toBeDefined();
    expect(await readFile(join(fixture.home, '.codex/auth.json'), 'utf8')).toBe('{"token":"secret"}');
  });

  it('refuses to run when Paseo is too old, before touching anything', async () => {
    const fixture = await makeFixture({ paseoStatus: { ...RUNNING_STATUS, cliVersion: '0.7.0', daemonVersion: '0.7.0' } });
    const daemon = emptyDaemon();
    const result = await run(['setup', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(1);
    expect(result.out).toContain('older than the required');
    expect(daemon.connects).toBe(0);
  });

  it('sets up against a Paseo 0.9 daemon, whose status no longer states the CLI version', async () => {
    const fixture = await makeFixture({ paseoStatus: RUNNING_STATUS_09, paseoCliVersion: '0.9.1' });
    const daemon = emptyDaemon();
    const result = await run(['setup', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Paseo 0.9.1 is running');
    expect(daemon.connects).toBe(1);

    // The CLI/daemon comparison survives the shape change: it now reads the executable's own
    // version, so a CLI upgraded past its unrestarted daemon is still caught.
    const stale = await makeFixture({ paseoStatus: RUNNING_STATUS_09, paseoCliVersion: '0.9.2' });
    const staleDaemon = emptyDaemon();
    const refused = await run(['setup', '--apply'], stale.env, staleDaemon);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('running daemon is 0.9.1');
    expect(staleDaemon.connects).toBe(0);
  });

  it('rejects an unknown command and reports an unknown agent', async () => {
    const fixture = await makeFixture();
    expect((await run(['nope'], fixture.env, emptyDaemon())).code).toBe(2);
    const unknownAgent = await run(['setup', '--agent', 'omp'], fixture.env, emptyDaemon());
    expect(unknownAgent.code).toBe(2);
    expect(unknownAgent.out).toBe('');
    expect(unknownAgent.err).toContain('Unknown agent: omp');
  });
});

describe('Pi rooms', () => {
  it('accepts Pi, uses strict role argv, omits profile mode, and keeps Peer room tools off', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run([
      'setup', '--agent', 'pi', '--pi-home', join(fixture.home, '.pi/agent'),
      '--pi-bin', join(fixture.home, 'bin/pi'), '--apply',
    ], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers).sort()).toEqual(['pi-lead', 'pi-peer', 'pi-supervisor']);
    const peer = daemon.providers['pi-peer'] as { command: string[]; env: Record<string, string>; paseoTools: { enabled: boolean } };
    const adapter = await realpath(join(fixture.home, '.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts'));
    const append = join(fixture.roomHome, 'roles/pi/peer/APPEND_SYSTEM.md');
    expect(peer.command).toEqual([
      join(fixture.home, 'bin/pi'), '--no-extensions', '--extension', adapter,
      '--no-approve', '--append-system-prompt', append,
    ]);
    expect(peer.command).not.toContain('--no-context-files');
    for (const role of ['supervisor', 'lead', 'peer']) {
      const provider = daemon.providers[`pi-${role}`] as { env: Record<string, string> };
      expect(provider.env).toMatchObject({
        PI_CODING_AGENT_DIR: join(fixture.roomHome, `roles/pi/${role}`),
        PI_MCP_CONFIG_MODE: 'exclusive',
      });
    }
    expect(peer.paseoTools.enabled).toBe(false);
    expect((daemon.providers['pi-lead'] as { paseoTools: { enabled: boolean } }).paseoTools.enabled).toBe(true);
    for (const profile of daemon.agentProfiles) expect(profile.modeId).toBeUndefined();
  });

  it('runs Pi setup as a write-free dry run', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const settingsPath = join(fixture.home, '.pi/agent/settings.json');
    const before = await readFile(settingsPath, 'utf8');
    const result = await run(['setup', '--agent', 'pi'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Planned changes');
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('requires stable Paseo for Pi without raising the Codex and Claude floor', async () => {
    const status = { ...RUNNING_STATUS, cliVersion: '0.8.0-beta.2', daemonVersion: '0.8.0-beta.2' };
    const fixture = await makeFixture({ paseoStatus: status });
    expect((await run(['setup', '--agent', 'codex'], fixture.env, emptyDaemon())).code).toBe(0);
    const pi = await run(['setup', '--agent', 'pi'], fixture.env, emptyDaemon());
    expect(pi.code).toBe(1);
    expect(pi.out).toContain('required 0.8.0');
  });

  it('removes stale Pi providers and profiles while preserving its role homes', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'pi', '--apply'], fixture.env, daemon);
    const credential = join(fixture.roomHome, 'roles/pi/lead/auth.json');
    const credentialBytes = Buffer.from([1, 2, 0, 255]);
    await writeFile(credential, credentialBytes);
    const updated = await run(['setup', '--agent', 'codex', '--apply'], fixture.env, daemon);
    expect(Object.keys(daemon.providers).sort()).toEqual(['codex-lead', 'codex-peer', 'codex-supervisor']);
    expect(daemon.agentProfiles.some(entry => String(entry.id).startsWith('room-pi-'))).toBe(false);
    await expect(stat(join(fixture.roomHome, 'roles/pi/lead'))).resolves.toBeDefined();
    expect(await readFile(credential)).toEqual(credentialBytes);
    expect(updated.out).toContain('deselected role homes');
    await run(['setup', '--agent', 'codex', '--agent', 'pi', '--apply'], fixture.env, daemon);
    expect(await readFile(credential)).toEqual(credentialBytes);
  });

  it('pins Claude secure storage to each role home despite operator and ambient overrides', async () => {
    const fixture = await makeFixture();
    const operatorSettings = JSON.stringify({
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/operator/shared-auth', OPERATOR_ONLY: '1' },
      hooks: { SessionStart: [] }, apiKeyHelper: 'operator-helper',
      permissions: { allow: ['Agent'], deny: ['Bash(rm *)'] },
    });
    await writeFile(join(fixture.home, '.claude/settings.json'), operatorSettings);
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], {
      ...fixture.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/ambient/shared-auth',
    }, daemon);
    for (const role of ['supervisor', 'lead', 'peer']) {
      const home = join(fixture.roomHome, `roles/claude/${role}`);
      const provider = daemon.providers[`claude-${role}`] as { env: Record<string, string> };
      expect(provider.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home);
      const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as {
        env: Record<string, string>; permissions: { deny: string[] };
      };
      expect(Object.keys(settings).sort()).toEqual([
        'crossSessionInbound', 'disableAgentView', 'disableWorkflows', 'env', 'permissions',
      ]);
      expect(settings.env).toEqual({
        CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
        CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
        PASEO_ROOM_ROLE: role,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
      });
      expect(settings.permissions).toEqual({
        deny: (daemon.providers[`claude-${role}`] as { disallowedTools: string[] }).disallowedTools,
      });
    }
    expect(await readFile(join(fixture.home, '.claude/settings.json'), 'utf8')).toBe(operatorSettings);
  });

  it('removes a stale owned modeId from Pi profiles while preserving operator tuning', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'pi', '--apply'], fixture.env, daemon);
    const peer = daemon.agentProfiles.find(entry => entry.id === 'room-pi-peer');
    if (!peer) throw new Error('expected the Pi Peer profile');
    Object.assign(peer, { modeId: 'full-access', model: 'operator/model', thinkingOptionId: 'max' });
    await run(['setup', '--agent', 'pi', '--apply'], fixture.env, daemon);
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-pi-peer')).toMatchObject({
      model: 'operator/model', thinkingOptionId: 'max', provider: 'pi-peer',
    });
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-pi-peer')?.modeId).toBeUndefined();
  });
});

describe('changing the seated agents', () => {
  it('drops providers but preserves role homes the new selection no longer covers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    const result = await run(['setup', '--agent', 'codex', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers).sort()).toEqual(['codex-lead', 'codex-peer', 'codex-supervisor']);
    await expect(stat(join(fixture.roomHome, 'roles/claude/lead'))).resolves.toBeDefined();
    await expect(stat(join(fixture.roomHome, 'roles/codex/lead'))).resolves.toBeDefined();
  });

  it('refuses a room home that overlaps the agent home', async () => {
    const fixture = await makeFixture();
    const result = await run(['setup', '--room-home', join(fixture.home, '.codex', 'room'), '--apply'], fixture.env, emptyDaemon());
    expect(result.code).toBe(1);
    expect(result.out).toContain('overlaps the room home');
  });
});

describe('remove safety', () => {
  it('preserves the room marker when Paseo is unavailable so a later remove can finish', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const marker = join(fixture.roomHome, 'room.json');
    await script(join(fixture.home, 'bin/paseo'), JSON.stringify({
      ...RUNNING_STATUS, localDaemon: 'stopped',
    }));

    const unavailable = await run(['remove', '--apply'], fixture.env, daemon);
    expect(unavailable.code).toBe(1);
    expect(unavailable.out).toContain(`Preserved ${fixture.roomHome}, including its room marker`);
    expect(unavailable.out).toContain('Start Paseo, then run: paseo-room remove --apply');
    await expect(stat(marker)).resolves.toBeDefined();
    await expect(stat(join(fixture.roomHome, 'roles/codex/lead'))).resolves.toBeDefined();
    expect(Object.keys(daemon.providers)).toHaveLength(3);

    await script(join(fixture.home, 'bin/paseo'), JSON.stringify(RUNNING_STATUS));
    const recovered = await run(['remove', '--apply'], fixture.env, daemon);
    expect(recovered.code).toBe(0);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    expect(daemon.providers).toEqual({});
    expect(daemon.agentProfiles.filter(profile => String(profile.id).startsWith('room-'))).toEqual([]);
  });

  it('preserves local state after partial daemon cleanup so retry can finish safely', async () => {
    const fixture = await makeFixture();
    const unrelatedProfile = { id: 'mine', provider: 'unrelated' };
    const daemon: FakeDaemon = {
      ...emptyDaemon(),
      providers: { unrelated: { extends: 'pi' } },
      agentProfiles: [unrelatedProfile],
    };
    await run(['setup', '--apply'], fixture.env, daemon);
    const marker = join(fixture.roomHome, 'room.json');
    const roleCredential = join(fixture.roomHome, 'roles/codex/lead/auth.json');
    await writeFile(roleCredential, 'dummy role-owned credential fixture');

    daemon.failNextConfigGet = true;
    const interrupted = await run(['remove', '--apply'], fixture.env, daemon);
    expect(interrupted.code).toBe(1);
    expect(interrupted.out).toContain('Paseo provider/profile cleanup did not complete');
    expect(interrupted.out).toContain('Restore Paseo connectivity, then run: paseo-room remove --apply');
    await expect(stat(marker)).resolves.toBeDefined();
    await expect(readFile(roleCredential, 'utf8')).resolves.toBe('dummy role-owned credential fixture');
    expect(daemon.providers).toEqual({ unrelated: { extends: 'pi' } });
    expect(daemon.agentProfiles).toContainEqual(unrelatedProfile);
    expect(daemon.agentProfiles.some(profile => String(profile.id).startsWith('room-'))).toBe(true);

    const recovered = await run(['remove', '--apply'], fixture.env, daemon);
    expect(recovered.code).toBe(0);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    expect(daemon.providers).toEqual({ unrelated: { extends: 'pi' } });
    expect(daemon.agentProfiles).toEqual([unrelatedProfile]);
  });

  it('fails before traversing symlinked agent or role-home directories', async () => {
    for (const seam of ['agent', 'role'] as const) {
      const fixture = await makeFixture();
      const external = join(fixture.home, `external-${seam}`);
      await mkdir(external, { recursive: true });
      await writeFile(join(external, 'sentinel'), seam);
      if (seam === 'agent') {
        await mkdir(join(fixture.roomHome, 'roles'), { recursive: true });
        await symlink(external, join(fixture.roomHome, 'roles/codex'));
      } else {
        await mkdir(join(fixture.roomHome, 'roles/codex'), { recursive: true });
        await symlink(external, join(fixture.roomHome, 'roles/codex/lead'));
      }
      const result = await run(['setup', '--apply'], fixture.env, emptyDaemon());
      expect(result.code).toBe(1);
      expect(result.out).toContain('every existing room directory ancestor must be a real directory');
      expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe(seam);
      await expect(stat(join(external, 'config.toml'))).rejects.toThrow();
    }
  });

  it('fails before traversing a symlink at any room-skill directory layer', async () => {
    const seams = [
      'room/skills',
      `room/skills/${ROOM_SKILL_NAME}`,
      `room/skills/${ROOM_SKILL_NAME}/references`,
      'room/skill-projections',
      'room/skill-projections/codex',
      'room/skill-projections/codex/lead',
    ] as const;
    for (const [index, seam] of seams.entries()) {
      const fixture = await makeFixture();
      const external = join(fixture.home, `external-room-skill-${String(index)}`);
      const path = join(fixture.roomHome, seam);
      await mkdir(external, { recursive: true });
      await writeFile(join(external, 'sentinel'), seam);
      await mkdir(dirname(path), { recursive: true });
      await symlink(external, path);

      const result = await run(['setup', '--apply'], fixture.env, emptyDaemon());

      expect(result.code).toBe(1);
      expect(result.out).toContain(`Refusing to traverse ${path}`);
      expect(result.out).toContain('every existing room directory ancestor must be a real directory');
      expect(await readdir(external)).toEqual(['sentinel']);
      expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe(seam);
    }
  });

  it('removes a broken room without following a nested skill-source symlink', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    expect((await run(['setup', '--apply'], fixture.env, daemon)).code).toBe(0);
    const source = join(fixture.roomHome, 'room/skills', ROOM_SKILL_NAME);
    const external = join(fixture.home, 'external-remove-target');
    await rm(source, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'sentinel'), 'keep');
    await symlink(external, source);

    const result = await run(['remove', '--apply'], fixture.env, daemon);

    expect(result.code).toBe(0);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    expect(await readdir(external)).toEqual(['sentinel']);
    expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('refuses to delete a room home that contains the user home', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    // A room marker at $HOME itself must never authorise deleting $HOME.
    await writeFile(join(fixture.home, 'room.json'), JSON.stringify({ version: '0.0.0', agents: ['codex'], roles: ['lead'] }));
    const result = await run(['remove', '--room-home', fixture.home, '--apply'], fixture.env, daemon);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Refusing to use');
    await expect(stat(join(fixture.home, '.codex'))).resolves.toBeDefined();
  });
});

describe('runtime enforcement pins', () => {
  it('pins Codex sandbox and approval so Paseo mode presets cannot outrank the config', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    for (const id of ['codex-supervisor', 'codex-lead', 'codex-peer']) {
      expect(daemon.providers[id]).toMatchObject({ params: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } });
    }
  });

  it('denies Claude native orchestration tools in both role settings and Paseo providers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const denied = [
      'Task', 'Agent', 'Workflow', 'ListAgents', 'SendMessage', 'TeamCreate', 'TeamDelete',
      'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
      'CronCreate', 'CronDelete', 'CronList',
    ];
    await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon);
    for (const role of ['supervisor', 'lead', 'peer']) {
      expect(daemon.providers[`claude-${role}`]).toMatchObject({
        env: {
          CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
          CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
        },
        disallowedTools: denied,
      });
      const settings = JSON.parse(await readFile(
        join(fixture.roomHome, `roles/claude/${role}/settings.json`), 'utf8',
      )) as { permissions: { deny: string[] } };
      expect(settings.permissions.deny).toEqual(denied);
    }
  });

  it('verify fails when a pin is removed from the live config', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const live = { ...(daemon.providers['codex-lead'] as Record<string, unknown>) };
    delete live.params;
    daemon.providers['codex-lead'] = live;
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });

  it('verify fails when a Claude control-plane environment pin is removed', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon);
    const live = daemon.providers['claude-lead'] as { env: Record<string, string> };
    delete live.env.CLAUDE_CODE_DISABLE_WORKFLOWS;
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });

  it('verify detects either Claude deny drift and setup restores minimal role settings', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon);
    const path = join(fixture.roomHome, 'roles/claude/lead/settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as {
      env: Record<string, string>; permissions: { deny: string[]; allow?: string[] }; hooks?: unknown;
    };
    settings.permissions.deny = settings.permissions.deny.filter(tool => tool !== 'Agent');
    settings.permissions.allow = ['Agent'];
    settings.env.OPERATOR_ONLY = '1';
    settings.hooks = { SessionStart: [] };
    await writeFile(path, JSON.stringify(settings, null, 2) + '\n');

    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('managed role file is missing or outdated');

    expect((await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon)).code).toBe(0);
    const repaired = JSON.parse(await readFile(path, 'utf8')) as {
      env: Record<string, string>; permissions: { deny: string[]; allow?: string[] }; hooks?: unknown;
    };
    expect(repaired.permissions.deny).toContain('Agent');
    expect(repaired.permissions.allow).toBeUndefined();
    expect(repaired.env.OPERATOR_ONLY).toBeUndefined();
    expect(repaired.hooks).toBeUndefined();

    const provider = daemon.providers['claude-lead'] as { disallowedTools: string[] };
    provider.disallowedTools = provider.disallowedTools.filter(tool => tool !== 'Agent');
    const providerVerified = await run(['verify'], fixture.env, daemon);
    expect(providerVerified.code).toBe(1);
    expect(providerVerified.out).toContain('Paseo providers are missing or differ');
  });

  it('verify detects each vendor role-home environment drifting from its generated home', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    for (const [providerId, envName] of [
      ['codex-lead', 'CODEX_HOME'],
      ['claude-lead', 'CLAUDE_CONFIG_DIR'],
      ['pi-lead', 'PI_CODING_AGENT_DIR'],
    ] as const) {
      const provider = daemon.providers[providerId] as { env: Record<string, string> };
      const expected = provider.env[envName];
      provider.env[envName] = '/wrong-role-home';
      const verified = await run(['verify'], fixture.env, daemon);
      expect(verified.code).toBe(1);
      expect(verified.out).toContain('Paseo providers are missing or differ');
      if (expected !== undefined) provider.env[envName] = expected;
    }
  });

  it('verify detects a Pi provider no longer appending its generated role prompt', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'pi', '--apply'], fixture.env, daemon);
    const provider = daemon.providers['pi-peer'] as { command: string[] };
    const flag = provider.command.indexOf('--append-system-prompt');
    provider.command[flag + 1] = '/wrong/APPEND_SYSTEM.md';
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });
});

describe('agent profiles', () => {
  const ids = (daemon: FakeDaemon): string[] => daemon.agentProfiles.map(entry => String(entry.id)).sort();

  it('seats one picker preset per seat, pointing at that seat provider', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    expect(ids(daemon)).toEqual([
      'room-claude-lead', 'room-claude-peer', 'room-claude-supervisor',
      'room-codex-lead', 'room-codex-peer', 'room-codex-supervisor',
    ]);
    const lead = daemon.agentProfiles.find(entry => entry.id === 'room-codex-lead');
    expect(lead).toMatchObject({
      name: 'Codex Lead', provider: 'codex-lead', modeId: 'full-access', icon: 'compass', color: 'blue',
    });
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-claude-lead'))
      .toMatchObject({ modeId: 'bypassPermissions', icon: 'compass', color: 'blue' });
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-codex-supervisor'))
      .toMatchObject({ icon: 'eye', color: 'violet' });
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-codex-peer'))
      .toMatchObject({ icon: 'code', color: 'emerald' });
    for (const entry of daemon.agentProfiles) expect(entry.model).toBeUndefined();
    // Effort is a per-seat policy: Supervisor only routes, so it starts cheap.
    const effort = (id: string): unknown => daemon.agentProfiles.find(entry => entry.id === id)?.thinkingOptionId;
    expect([effort('room-codex-supervisor'), effort('room-codex-lead'), effort('room-codex-peer')])
      .toEqual(['low', 'high', 'high']);
    // Neither seat starts on the delegating top option.
    for (const entry of daemon.agentProfiles) expect(['ultra', 'ultracode']).not.toContain(entry.thinkingOptionId);
    // Orchestrators read these through list_profiles before choosing a seat to open.
    const leadNotes = String(daemon.agentProfiles.find(entry => entry.id === 'room-codex-lead')?.notes);
    expect(leadNotes).toContain('Sole project technical owner');
    expect(leadNotes).toContain('copy every present profile launch field');
    expect(leadNotes).toContain('exact current room Lead provider/mode/workspace evidence');
    expect(leadNotes).toContain('Cwd, title and provider label are not membership');
    expect(leadNotes).toContain('Creates Peer seats only');
    const peerNotes = String(daemon.agentProfiles.find(entry => entry.id === 'room-codex-peer')?.notes);
    expect(peerNotes).toContain('copying every present profile launch field');
    expect(peerNotes).toContain('exact current room Peer provider/mode/workspace');
    expect(peerNotes).toContain('paseo.parent-agent-id for its Lead');
    expect(peerNotes).toContain('Cwd, title and provider label are not membership');
  });

  it('leaves profiles it does not own alone, and keeps operator tuning on the ones it does', async () => {
    const fixture = await makeFixture();
    const daemon = { ...emptyDaemon(), agentProfiles: [{ id: 'mine', name: 'My preset', provider: 'codex' }] };
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(daemon.agentProfiles[0]).toEqual({ id: 'mine', name: 'My preset', provider: 'codex' });

    // The operator retunes a room seat and renames it; setup restores the room identity
    // and permission default, while keeping model and effort as operator choices.
    const seat = daemon.agentProfiles.find(entry => entry.id === 'room-codex-peer');
    if (!seat) throw new Error('expected the Peer profile');
    Object.assign(seat, {
      name: 'renamed', model: 'gpt-5.5', thinkingOptionId: 'max', modeId: 'auto', icon: 'bolt', color: 'red',
    });
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-codex-peer'))
      .toMatchObject({
        name: 'Codex Peer', model: 'gpt-5.5', thinkingOptionId: 'max',
        modeId: 'full-access', icon: 'code', color: 'emerald',
      });
    expect(ids(daemon)).toEqual(['mine', 'room-codex-lead', 'room-codex-peer', 'room-codex-supervisor']);
  });

  it('drops the profiles of a seat the new selection no longer covers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    await run(['setup', '--agent', 'codex', '--apply'], fixture.env, daemon);
    expect(ids(daemon)).toEqual(['room-codex-lead', 'room-codex-peer', 'room-codex-supervisor']);
  });

  it('verify fails when a room profile is deleted, and remove clears only the room profiles', async () => {
    const fixture = await makeFixture();
    const daemon = { ...emptyDaemon(), agentProfiles: [{ id: 'mine', name: 'My preset', provider: 'codex' }] };
    await run(['setup', '--apply'], fixture.env, daemon);
    daemon.agentProfiles = daemon.agentProfiles.filter(entry => entry.id !== 'room-codex-lead');
    const drifted = await run(['verify'], fixture.env, daemon);
    expect(drifted.code).toBe(1);
    expect(drifted.out).toContain('agent profiles are missing or differ');

    await run(['remove', '--apply'], fixture.env, daemon);
    expect(ids(daemon)).toEqual(['mine']);
  });

  it('verify detects a room profile pointing at the wrong provider', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const profile = daemon.agentProfiles.find(entry => entry.id === 'room-codex-lead');
    if (!profile) throw new Error('expected the Codex Lead profile');
    profile.provider = 'codex';
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('agent profiles are missing or differ');
  });
});

describe('agent profiles', () => {
  // One write replaces the whole host array, so an unchanged room must not issue one.
  it('does not rewrite the host profile array when nothing about them changed', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const written = daemon.agentProfiles;
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(daemon.agentProfiles).toBe(written);
  });
});

describe('role resource projection', () => {
  async function operatorResources(home: string): Promise<void> {
    for (const [agent, executable] of [
      ['.codex', ['plugins']],
      ['.claude', ['plugins', 'commands', 'hooks']],
      ['.pi/agent', ['prompts']],
    ] as const) {
      const root = join(home, agent);
      await mkdir(join(root, 'skills', 'formatting'), { recursive: true });
      await mkdir(join(root, 'skills', 'paseo-committee'), { recursive: true });
      for (const name of executable) await mkdir(join(root, name), { recursive: true });
    }
    await writeFile(join(home, '.codex', 'hooks.json'), '{}');
  }

  it('gives Supervisor aliases, Lead every operator skill plus the room skill, and Peer an exact non-paseo projection', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    const applied = await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    expect(applied.code).toBe(0);

    const executable: Record<AgentId, readonly string[]> = {
      codex: ['plugins', 'hooks.json'],
      claude: ['plugins', 'commands', 'hooks'],
      pi: ['prompts'],
    };
    const roomSkill = join(fixture.roomHome, 'room/skills', ROOM_SKILL_NAME);
    for (const agent of ['codex', 'claude', 'pi'] as const) {
      const supervisor = join(fixture.roomHome, 'roles', agent, 'supervisor');
      expect((await lstat(join(supervisor, 'skills'))).isSymbolicLink()).toBe(true);
      const lead = join(fixture.roomHome, 'roles', agent, 'lead');
      for (const role of [supervisor, lead]) {
        for (const name of executable[agent]) expect((await lstat(join(role, name))).isSymbolicLink()).toBe(true);
      }
      // Lead reaches an exact room-owned projection through a rollback-compatible role symlink.
      const leadSkills = join(lead, 'skills');
      expect((await lstat(leadSkills)).isSymbolicLink()).toBe(true);
      expect(await readlink(leadSkills)).toBe(join(fixture.roomHome, 'room/skill-projections', agent, 'lead'));
      expect((await readdir(leadSkills)).sort()).toEqual(['formatting', ROOM_SKILL_NAME, 'paseo-committee'].sort());
      expect(await readlink(join(leadSkills, ROOM_SKILL_NAME))).toBe(roomSkill);
      expect(await readFile(join(leadSkills, ROOM_SKILL_NAME, 'SKILL.md'), 'utf8'))
        .toContain(`name: ${ROOM_SKILL_NAME}`);

      const peer = join(fixture.roomHome, 'roles', agent, 'peer');
      for (const name of executable[agent]) await expect(lstat(join(peer, name))).rejects.toThrow();
      const skills = join(peer, 'skills');
      expect((await lstat(skills)).isSymbolicLink()).toBe(false);
      // Peer receives neither the room skill nor any operator paseo* skill.
      expect(await readdir(skills)).toEqual(['formatting']);
    }
    // The operator's own inventories are untouched in every home.
    for (const agent of ['.codex', '.claude', '.pi/agent'] as const) {
      expect((await readdir(join(fixture.home, agent, 'skills'))).sort()).toEqual(['formatting', 'paseo-committee']);
    }
    // Room tools stay the single policy source, and Peer never receives them.
    const tools = (id: string): unknown => (daemon.providers[id] as { paseoTools: { enabled: boolean } }).paseoTools.enabled;
    expect(['codex', 'claude', 'pi'].map(agent => tools(`${agent}-peer`))).toEqual([false, false, false]);
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
    // A second run is stable: nothing about the projection or the skill source drifts.
    expect((await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi'], fixture.env, daemon)).out)
      .toContain('already up to date');
  });

  // A case-insensitive collision resolves to the room-owned copy, and the operator copy is untouched.
  it('links the room-owned skill over a case-insensitively colliding operator skill', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const operatorName = 'PASEO-PROJECT-ONBOARDING';
    const operatorCopy = join(fixture.home, '.codex/skills', operatorName);
    await mkdir(operatorCopy, { recursive: true });
    await writeFile(join(operatorCopy, 'SKILL.md'), '# operator copy\n');
    const daemon = emptyDaemon();

    expect((await run(['setup', '--apply'], fixture.env, daemon)).code).toBe(0);
    const skills = join(fixture.roomHome, 'roles/codex/lead/skills');
    const link = join(skills, ROOM_SKILL_NAME);
    expect(await readlink(link)).toBe(join(fixture.roomHome, 'room/skills', ROOM_SKILL_NAME));
    expect(await readdir(skills)).not.toContain(operatorName);
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).not.toContain('operator copy');
    expect(await readFile(join(operatorCopy, 'SKILL.md'), 'utf8')).toBe('# operator copy\n');
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
  });

  // An upgrade over a room that generated the old template removes exactly that regular file.
  it('removes the room-generated workspace protocol template left by an older package', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const legacy = join(fixture.roomHome, 'room/WORKSPACE_PROTOCOL.md');
    await writeFile(legacy, '# Workspace protocol\n\nGenerated by an older package.\n');

    const drifted = await run(['verify'], fixture.env, daemon);
    expect(drifted.code).toBe(1);
    expect(drifted.out).toContain('present but suppressed by this room');
    const repaired = await run(['setup', '--apply'], fixture.env, daemon);
    expect(repaired.code).toBe(0);
    await expect(stat(legacy)).rejects.toThrow();
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
  });

  it('migrates a legacy whole-directory Lead skills symlink without touching the operator home', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    const lead = join(fixture.roomHome, 'roles/codex/lead');
    await mkdir(lead, { recursive: true });
    await symlink(join(fixture.home, '.codex/skills'), join(lead, 'skills'));

    expect((await run(['setup', '--apply'], fixture.env, daemon)).code).toBe(0);
    const skills = join(lead, 'skills');
    expect((await lstat(skills)).isSymbolicLink()).toBe(true);
    expect(await readlink(skills)).toBe(join(fixture.roomHome, 'room/skill-projections/codex/lead'));
    expect((await readdir(skills)).sort()).toEqual(['formatting', ROOM_SKILL_NAME, 'paseo-committee'].sort());
    expect((await readdir(join(fixture.home, '.codex/skills'))).sort()).toEqual(['formatting', 'paseo-committee']);
  });

  // Symlink shape is preserved, so old and new packages can replace the target during rollback.
  it('replaces an existing Lead skills symlink without touching its prior target', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const elsewhere = join(fixture.home, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const lead = join(fixture.roomHome, 'roles/codex/lead');
    await mkdir(lead, { recursive: true });
    await symlink(elsewhere, join(lead, 'skills'));

    const repaired = await run(['setup', '--apply'], fixture.env, emptyDaemon());
    expect(repaired.code).toBe(0);
    expect(await readlink(join(lead, 'skills'))).toBe(join(fixture.roomHome, 'room/skill-projections/codex/lead'));
    expect((await stat(elsewhere)).isDirectory()).toBe(true);
  });

  it('reports and repairs Lead skill inventory drift through verify and setup', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const skills = join(fixture.roomHome, 'roles/codex/lead/skills');

    await mkdir(join(fixture.home, '.codex/skills/reviewing'), { recursive: true });
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(1);
    await run(['setup', '--apply'], fixture.env, daemon);
    expect((await readdir(skills)).sort()).toEqual(['formatting', ROOM_SKILL_NAME, 'paseo-committee', 'reviewing'].sort());

    // Room-owned skill drift is live managed state: verify compares its exact bytes and child shape.
    const roomSkill = join(fixture.roomHome, 'room/skills', ROOM_SKILL_NAME);
    await writeFile(join(roomSkill, 'SKILL.md'), 'drifted\n');
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(1);
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(await readFile(join(skills, ROOM_SKILL_NAME, 'SKILL.md'), 'utf8')).toContain(`name: ${ROOM_SKILL_NAME}`);

    await writeFile(join(roomSkill, 'stale.md'), '# stale\n');
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(1);
    await run(['setup', '--apply'], fixture.env, daemon);
    await expect(stat(join(roomSkill, 'stale.md'))).rejects.toThrow();
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
  });

  it('reports and repairs Peer skill inventory drift through verify and setup', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const skills = join(fixture.roomHome, 'roles/codex/peer/skills');

    await mkdir(join(fixture.home, '.codex/skills/reviewing'), { recursive: true });
    const added = await run(['verify'], fixture.env, daemon);
    expect(added.code).toBe(1);
    // Lead and Peer both project that inventory exactly, so both report the new child.
    expect(added.out).toContain('2 managed role files are missing or outdated');
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(await readdir(skills)).toEqual(['formatting', 'reviewing']);

    await rm(join(fixture.home, '.codex/skills/reviewing'), { recursive: true });
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(1);
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(await readdir(skills)).toEqual(['formatting']);
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
    // Reconciliation only ever removed the room's own aliases.
    expect((await readdir(join(fixture.home, '.codex/skills'))).sort()).toEqual(['formatting', 'paseo-committee']);
  });

  it('migrates a legacy whole-directory Peer skills symlink on the next setup', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    const peer = join(fixture.roomHome, 'roles/codex/peer');
    await mkdir(peer, { recursive: true });
    await symlink(join(fixture.home, '.codex/skills'), join(peer, 'skills'));

    expect((await run(['setup', '--apply'], fixture.env, daemon)).code).toBe(0);
    expect((await lstat(join(peer, 'skills'))).isSymbolicLink()).toBe(false);
    expect(await readdir(join(peer, 'skills'))).toEqual(['formatting']);
    expect((await readdir(join(fixture.home, '.codex/skills'))).sort()).toEqual(['formatting', 'paseo-committee']);
  });

  // Deleting the source directory is inventory drift like any other: Peer's projection must
  // still be declared so verify reports it and setup empties it, and no seat keeps a broken link.
  it('empties the Peer projection when the operator deletes the whole skills directory', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    const agents = ['--agent', 'codex', '--agent', 'claude', '--agent', 'pi'] as const;
    await run(['setup', ...agents, '--apply'], fixture.env, daemon);
    for (const agent of ['codex', 'claude', 'pi'] as const) {
      await rm(join(fixture.home, agent === 'pi' ? '.pi/agent/skills' : `.${agent}/skills`), { recursive: true });
    }

    const drifted = await run(['verify'], fixture.env, daemon);
    expect(drifted.code).toBe(1);
    expect(drifted.out).toContain('managed role files are missing or outdated');
    expect((await run(['setup', ...agents, '--apply'], fixture.env, daemon)).code).toBe(0);

    for (const agent of ['codex', 'claude', 'pi'] as const) {
      const skills = join(fixture.roomHome, 'roles', agent, 'peer', 'skills');
      expect((await lstat(skills)).isSymbolicLink()).toBe(false);
      expect(await readdir(skills)).toEqual([]);
      // Lead's projection is managed, so it empties down to the room-owned skill alone.
      const leadSkills = join(fixture.roomHome, 'roles', agent, 'lead', 'skills');
      expect((await lstat(leadSkills)).isSymbolicLink()).toBe(true);
      expect(await readdir(leadSkills)).toEqual([ROOM_SKILL_NAME]);
      // Supervisor is never given a fresh alias to the deleted directory; the one left from
      // the previous run simply resolves nowhere, since a role home's child inventory is not
      // room-owned and may hold role credentials.
      const alias = join(fixture.roomHome, 'roles', agent, 'supervisor', 'skills');
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      await expect(stat(alias)).rejects.toThrow();
    }
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
  });

  // The same deletion must also retire the legacy whole-directory alias.
  it('removes a legacy Peer skills symlink whose target the operator deleted', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const daemon = emptyDaemon();
    const peer = join(fixture.roomHome, 'roles/codex/peer');
    const source = join(fixture.home, '.codex/skills');
    await mkdir(peer, { recursive: true });
    await symlink(source, join(peer, 'skills'));
    await rm(source, { recursive: true });

    expect((await run(['setup', '--agent', 'codex', '--apply'], fixture.env, daemon)).code).toBe(0);
    expect((await lstat(join(peer, 'skills'))).isSymbolicLink()).toBe(false);
    expect(await readdir(join(peer, 'skills'))).toEqual([]);
    await expect(stat(source)).rejects.toThrow();
  });

  it('fails setup and verify before apply for a recognizable Paseo MCP server in any source', async () => {
    for (const [agent, write] of [
      ['codex', async (home: string): Promise<void> => {
        await writeFile(join(home, '.codex/config.toml'), 'model = "m"\n[mcp_servers.paseo-bridge]\ncommand = "serve"\n');
      }],
      ['claude', async (home: string): Promise<void> => {
        await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { bridge: { command: 'paseo' } } }));
      }],
      ['pi', async (home: string): Promise<void> => {
        await writeFile(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { room: { url: 'http://x/paseo' } } }));
      }],
    ] as const) {
      const fixture = await makeFixture();
      const daemon = emptyDaemon();
      await run(['setup', '--agent', agent, '--apply'], fixture.env, daemon);
      await write(fixture.home);

      const blocked = await run(['setup', '--agent', agent, '--apply'], fixture.env, daemon);
      expect(blocked.code).toBe(1);
      expect(blocked.out).toContain('recognizably Paseo-related');
      expect(blocked.out).toContain('Remove or rename');
      const verified = await run(['verify'], fixture.env, daemon);
      expect(verified.code).toBe(1);
      expect(verified.out).toContain('recognizably Paseo-related');
    }
  });

  it('accepts benign operator MCP declarations in every source', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await writeFile(join(fixture.home, '.codex/config.toml'), 'model = "m"\n[mcp_servers.docs]\ncommand = "uvx"\nargs = ["mcp-server-docs"]\n');
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'notes-mcp' } } }));
    await writeFile(join(fixture.home, '.pi/agent/mcp.json'), JSON.stringify({ servers: { grapaseo: { command: 'paseonaut' } } }));

    const applied = await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    expect(applied.code).toBe(0);
    expect(applied.out).not.toContain('recognizably Paseo-related');
    expect((await run(['verify', '--json'], fixture.env, daemon)).code).toBe(0);
  });
});

interface JsonCheck { readonly id: string; readonly status: string; readonly message: string; readonly fix?: string }

/** The checks of one --json run, by id, so a diagnostic is asserted on rather than searched for. */
function checks(result: { out: string }): Record<string, JsonCheck | undefined> {
  const parsed = JSON.parse(result.out) as { checks: JsonCheck[] };
  return Object.fromEntries(parsed.checks.map(check => [check.id, check]));
}

describe('contract provenance and bounded diagnostics', () => {
  it('records the rendered contract generation in the marker without inventing drift on rerun', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const markerPath = join(fixture.roomHome, 'room.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { contract?: string };
    expect(marker.contract).toBe(contractDigest());

    const rerun = await run(['setup', '--apply'], fixture.env, daemon);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain(`Role contract generation ${contractDigest()} matches this package`);
    expect(await readFile(markerPath, 'utf8')).toBe(renderMarker(version, ['codex'], ['supervisor', 'lead', 'peer'], contractDigest()));
    expect((await run(['verify'], fixture.env, daemon)).code).toBe(0);
  });

  it('warns without failing when the installed room holds an older or missing contract generation', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const markerPath = join(fixture.roomHome, 'room.json');
    const roles = ['supervisor', 'lead', 'peer'] as const;

    // A room installed by an older package, before provenance existed. The marker itself is
    // managed, so it also reports as outdated; the provenance check is the warning beside it.
    await writeFile(markerPath, renderMarker('0.0.1', ['codex'], roles));
    const legacy = checks(await run(['verify', '--json'], fixture.env, daemon));
    expect(legacy['room.contract']?.status).toBe('warn');
    expect(legacy['room.contract']?.message).toContain('installed before the room recorded its contract generation (package 0.0.1)');
    expect(String(legacy['room.contract']?.fix)).toContain('restart the affected seats');

    // A room installed from a different rendered contract.
    await writeFile(markerPath, renderMarker(version, ['codex'], roles, 'sha256:0000000000000000'));
    const stale = checks(await run(['verify', '--json'], fixture.env, daemon));
    expect(stale['room.contract']?.status).toBe('warn');
    expect(stale['room.contract']?.message).toContain('holds contract generation sha256:0000000000000000');
    expect(stale['room.contract']?.message).toContain(contractDigest());

    // Provenance alone never fails a command, and a successful apply reports the generation
    // that is now installed rather than repeating an already-resolved warning.
    const repaired = checks(await run(['setup', '--apply', '--json'], fixture.env, daemon));
    expect(repaired['room.contract']?.status).toBe('pass');
    expect(repaired['room.contract']?.message).toContain('matches this package');
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(0);
    expect(verified.out).toContain('matches this package');
  });

  it('warns that delegation is unverified for a top reasoning option without changing the seat', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const lead = daemon.agentProfiles.find(entry => entry.id === 'room-codex-lead');
    if (!lead) throw new Error('expected the Lead profile');
    lead.thinkingOptionId = 'ultra';

    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(0);
    expect(verified.out).toContain('room-codex-lead (ultra)');
    expect(verified.out).toContain('automatic task delegation');
    expect(verified.out).toContain('is unverified');
    expect(verified.out).toContain('has not verified whether those closures prevent that option from delegating');
    // Warning only: the operator's selection and the provider set are untouched.
    const applied = await run(['setup', '--apply', '--json'], fixture.env, daemon);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('room-codex-lead (ultra)');
    const appliedChecks = (JSON.parse(applied.out) as { checks: JsonCheck[] }).checks;
    expect(appliedChecks.findIndex(check => check.id === 'room.applied'))
      .toBeLessThan(appliedChecks.findIndex(check => check.id === 'room.thinking'));
    expect(daemon.agentProfiles.find(entry => entry.id === 'room-codex-lead')?.thinkingOptionId).toBe('ultra');
    expect(Object.keys(daemon.providers).sort()).toEqual(['codex-lead', 'codex-peer', 'codex-supervisor']);
    // A profile the room does not own is not diagnosed, whatever it is set to.
    daemon.agentProfiles.push({ id: 'mine', provider: 'codex', thinkingOptionId: 'ultracode' });
    const others = await run(['verify'], fixture.env, daemon);
    expect(others.out).not.toContain('mine (ultracode)');
  });

  it('names a missing scrubbed catalog as its own closure gap in the file drift failure', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    await rm(join(fixture.roomHome, 'roles/codex/peer/model-catalog.json'));
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('1 managed role file is missing or outdated');
    expect(verified.out).toContain('One of them is a generated Codex model catalog');
    expect(verified.out).toContain('lack the scrubbed catalog closure');

    await rm(join(fixture.roomHome, 'roles/codex/lead/model-catalog.json'));
    expect((await run(['verify'], fixture.env, daemon)).out).toContain('2 of them are generated Codex model catalogs');

    // Ordinary contract drift says nothing about catalogs.
    await run(['setup', '--apply'], fixture.env, daemon);
    await writeFile(join(fixture.roomHome, 'roles/codex/peer/role-instructions.md'), 'stale\n');
    const prompt = await run(['verify'], fixture.env, daemon);
    expect(prompt.code).toBe(1);
    expect(prompt.out).not.toContain('scrubbed catalog closure');
  });
});
