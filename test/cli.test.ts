import { lstat, mkdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { renderRoleMemory } from '../src/agents/claude.js';
import { renderPiAppend } from '../src/agents/pi.js';
import { runCli } from '../src/cli.js';
import { protocolKeys, renderInstructions } from '../src/room/instructions.js';
import { loadPromptAsset, type WorkspaceKey } from '../src/room/prompts.js';
import type { AgentId, Role } from '../src/roles.js';
import { emptyDaemon, fakeClient, makeFixture, RUNNING_STATUS, script, type FakeDaemon } from './helpers.js';

async function run(argv: readonly string[], env: NodeJS.ProcessEnv, daemon: FakeDaemon): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, { stdout: text => { out += text; }, stderr: text => { err += text; } }, {
    isTTY: false,
    options: { env, factory: fakeClient(daemon) },
  });
  return { code, out, err };
}

const PROTOCOL_HEADINGS = ['Topology', 'Verification', 'Review', 'Repository Conventions'] as const;

function protocolHeadings(document: string): string[] {
  return [...document.matchAll(/^## (.+)$/gm)]
    .map(match => match[1] ?? '')
    .filter(heading => PROTOCOL_HEADINGS.includes(heading as typeof PROTOCOL_HEADINGS[number]));
}

function protocolHeading(key: WorkspaceKey): string {
  return loadPromptAsset('workspace', key).split('\n', 1)[0]?.slice(3) ?? '';
}

describe('paseo-room CLI', () => {
  it('is a dry run by default and writes nothing', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run(['setup'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Planned changes');
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
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
        expect(protocolHeadings(delivered)).toEqual(protocolKeys(role).map(protocolHeading));
      }
    }

    const workspace = await readFile(join(fixture.roomHome, 'room/WORKSPACE_PROTOCOL.md'), 'utf8');
    expect(workspace).toBe(renderInstructions('workspace'));
    expect(protocolHeadings(workspace)).toEqual(PROTOCOL_HEADINGS);
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
      join(fixture.roomHome, 'room/WORKSPACE_PROTOCOL.md'),
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
    await writeFile(join(fixture.home, '.claude/settings.json'), JSON.stringify({
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/operator/shared-auth' },
    }));
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], {
      ...fixture.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/ambient/shared-auth',
    }, daemon);
    for (const role of ['supervisor', 'lead', 'peer']) {
      const home = join(fixture.roomHome, `roles/claude/${role}`);
      const provider = daemon.providers[`claude-${role}`] as { env: Record<string, string> };
      expect(provider.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home);
      const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as {
        env: Record<string, string>;
      };
      expect(settings.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home);
    }
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

describe('provider-level pins', () => {
  it('pins Codex sandbox and approval so Paseo mode presets cannot outrank the config', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    for (const id of ['codex-supervisor', 'codex-lead', 'codex-peer']) {
      expect(daemon.providers[id]).toMatchObject({ params: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } });
    }
  });

  it('denies Claude native orchestration tools so Paseo stays the only control plane', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon);
    for (const id of ['claude-supervisor', 'claude-lead', 'claude-peer']) {
      expect(daemon.providers[id]).toMatchObject({
        env: {
          CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
          CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
        },
        disallowedTools: [
          'Task', 'Agent', 'Workflow', 'ListAgents', 'SendMessage', 'TeamCreate', 'TeamDelete',
          'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
          'CronCreate', 'CronDelete', 'CronList',
        ],
      });
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
