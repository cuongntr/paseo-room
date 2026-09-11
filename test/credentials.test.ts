import { mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { codexAgent, codexCredentialStore } from '../src/agents/codex.js';
import { claudeAuthMethodNames, claudeCredentialDiagnostic } from '../src/agents/claude.js';
import { piCredentialDiagnostic } from '../src/agents/pi.js';
import { inspectCredentialPath, roleCommand } from '../src/credentials.js';
import { resolveLayout, roleHome } from '../src/layout.js';
import { makeFixture } from './helpers.js';

describe('credential metadata inspection', () => {
  it('classifies missing, regular, linked, dangling, and unsafe paths without reading contents', async () => {
    const fixture = await makeFixture();
    const root = join(fixture.roomHome, 'credential-shapes');
    await mkdir(root, { recursive: true });
    const regular = join(root, 'regular');
    const linked = join(root, 'linked');
    const dangling = join(root, 'dangling');
    const directory = join(root, 'directory');
    await writeFile(regular, Buffer.from([0, 1, 2, 255]));
    await symlink(regular, linked);
    await symlink(join(root, 'absent-target'), dangling);
    await mkdir(directory);

    expect(await inspectCredentialPath(join(root, 'missing'))).toEqual({ kind: 'missing' });
    expect(await inspectCredentialPath(regular)).toEqual({ kind: 'file' });
    expect(await inspectCredentialPath(linked)).toEqual({ kind: 'symlink', target: regular });
    expect(await inspectCredentialPath(dangling)).toEqual({ kind: 'symlink', target: join(root, 'absent-target') });
    expect(await inspectCredentialPath(directory)).toEqual({ kind: 'unsafe', fileType: 'directory' });
    expect(await readlink(linked)).toBe(regular);
  });

  it('quotes role homes in exact native login commands', () => {
    expect(roleCommand({ CODEX_HOME: "/tmp/role home/it's" }, '/tmp/bin dir/codex', ['login']))
      .toBe("CODEX_HOME='/tmp/role home/it'\"'\"'s' '/tmp/bin dir/codex' 'login'");
  });
});

describe('Codex credential diagnostics', () => {
  it('recognizes every configured credential store without reading credentials', () => {
    for (const store of ['file', 'ephemeral', 'auto', 'keyring'] as const) {
      expect(codexCredentialStore(parse(`cli_auth_credentials_store = "${store}"\n`))).toBe(store);
    }
    expect(codexCredentialStore(parse('model = "x"\n'))).toBe('unknown');
  });

  it('reports file/unknown and ephemeral stores as login-required when role auth is missing', async () => {
    for (const store of ['file', 'ephemeral', undefined] as const) {
      const fixture = await makeFixture();
      await writeFile(join(fixture.home, '.codex/config.toml'),
        store === undefined ? 'model = "x"\n' : `cli_auth_credentials_store = "${store}"\n`);
      const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
      expect(plan.credentials?.[0]?.checks[0]).toMatchObject({ status: 'warn' });
      expect(plan.credentials?.[0]?.checks[0]?.id).toContain('login-required');
    }
  });

  it('reports keyring and auto stores as unverifiable without querying them', async () => {
    for (const store of ['keyring', 'auto'] as const) {
      const fixture = await makeFixture();
      await writeFile(join(fixture.home, '.codex/config.toml'), `cli_auth_credentials_store = "${store}"\n`);
      const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['peer']);
      expect(plan.credentials?.[0]?.checks[0]?.id).toContain('native-keyring-unverifiable');
      expect(plan.credentials?.[0]?.checks[0]?.message).toContain('freshness were not checked');
    }
  });

  it('classifies a role file structurally without treating a setup-shell API key as stored auth', async () => {
    const fileFixture = await makeFixture();
    const fileLayout = resolveLayout({}, fileFixture.env);
    await mkdir(roleHome(fileLayout, 'codex', 'lead'), { recursive: true });
    await writeFile(join(roleHome(fileLayout, 'codex', 'lead'), 'auth.json'), '{not-even-json');
    const filePlan = await codexAgent.build(fileLayout, ['lead']);
    expect(filePlan.credentials?.[0]?.checks[0]?.id).toContain('diverged-file-preserve');
    expect(filePlan.credentials?.[0]?.checks[0]?.message).toContain('configured structurally');

    const envFixture = await makeFixture();
    const envLayout = resolveLayout({}, { ...envFixture.env, OPENAI_API_KEY: 'dummy-never-read' });
    const envPlan = await codexAgent.build(envLayout, ['lead']);
    expect(envPlan.credentials?.[0]?.checks[0]?.id).toContain('login-required');
    expect(envPlan.credentials?.[0]?.checks[0]?.message).toContain('present only in the setup process');
    expect(envPlan.credentials?.[0]?.checks[0]?.message).not.toContain('dummy-never-read');
  });
});

describe('Claude credential diagnostics', () => {
  it('recognizes supported environment and settings names only', () => {
    const names = claudeAuthMethodNames(JSON.stringify({
      apiKeyHelper: 'secret-command', env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'secret' },
    }), new Set(['CLAUDE_CODE_OAUTH_TOKEN']));
    expect(names).toEqual(expect.arrayContaining([
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY', 'apiKeyHelper',
    ]));
    expect(names).not.toContain('secret-command');
    expect(names).not.toContain('secret');
  });

  it('reports file, macOS keychain, and environment states conservatively', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    const home = roleHome(layout, 'claude', 'lead');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.credentials.json'), '{not-json');
    expect((await claudeCredentialDiagnostic(layout, 'lead', undefined, 'linux')).checks[0]?.id)
      .toContain('diverged-file-preserve');

    const missingFixture = await makeFixture();
    const missingLayout = resolveLayout({}, missingFixture.env);
    expect((await claudeCredentialDiagnostic(missingLayout, 'peer', undefined, 'darwin')).checks[0]?.id)
      .toContain('native-keyring-unverifiable');

    const envLayout = resolveLayout({}, { ...missingFixture.env, ANTHROPIC_AUTH_TOKEN: 'dummy-never-read' });
    const envCheck = (await claudeCredentialDiagnostic(envLayout, 'peer', undefined, 'linux')).checks[0];
    expect(envCheck?.id).toContain('ambient-auth-unverifiable');
    expect(envCheck?.message).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(envCheck?.message).not.toContain('dummy-never-read');
  });
});

describe('Pi credential diagnostics', () => {
  it('reports a role auth file structurally and known provider env names by presence', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    const home = roleHome(layout, 'pi', 'lead');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), '{not-json');
    expect((await piCredentialDiagnostic(layout, 'lead')).checks[0]?.id).toContain('diverged-file-preserve');

    const envFixture = await makeFixture();
    const envLayout = resolveLayout({}, { ...envFixture.env, GEMINI_API_KEY: 'dummy-never-read' });
    const check = (await piCredentialDiagnostic(envLayout, 'peer')).checks[0];
    expect(check?.id).toContain('ambient-auth-unverifiable');
    expect(check?.message).toContain('GEMINI_API_KEY');
    expect(check?.message).not.toContain('dummy-never-read');
  });
});
