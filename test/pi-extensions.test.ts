import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizePiExtensions, parsePiExtensionSpec, piAgent } from '../src/agents/pi.js';
import { resolveLayout } from '../src/layout.js';
import { renderMarker } from '../src/room.js';
import { makeFixture } from './helpers.js';

async function installPackage(home: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const root = join(home, '.pi/agent/npm/node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '3.1.0', ...manifest }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('Pi extension selection', () => {
  it('defaults to the orchestrating seats and gives Peer an extension only when named', () => {
    expect(parsePiExtensionSpec('pi-blackbytes')).toEqual({ package: 'pi-blackbytes', roles: ['supervisor', 'lead'] });
    expect(parsePiExtensionSpec('@scope/tool=peer,lead')).toEqual({ package: '@scope/tool', roles: ['lead', 'peer'] });
  });

  it('refuses a malformed name, an unknown role, and the adapter itself', () => {
    expect(() => parsePiExtensionSpec('../escape')).toThrow('Not a Pi package selection');
    expect(() => parsePiExtensionSpec('pi-blackbytes=writer')).toThrow('Unknown role');
    expect(() => parsePiExtensionSpec('pi-blackbytes=')).toThrow('Unknown role');
    expect(() => parsePiExtensionSpec('pi-mcp-adapter')).toThrow('always loaded');
  });

  it('merges repeated selections into one stable, sorted record', () => {
    const merged = normalizePiExtensions([
      parsePiExtensionSpec('pi-vcc=lead'), parsePiExtensionSpec('pi-blackbytes=peer'), parsePiExtensionSpec('pi-vcc=supervisor'),
    ]);
    expect(merged).toEqual([
      { package: 'pi-blackbytes', roles: ['peer'] },
      { package: 'pi-vcc', roles: ['supervisor', 'lead'] },
    ]);
    const marker = JSON.parse(renderMarker('0.0.0', ['pi'], ['lead'], undefined, undefined, undefined, merged)) as { piExtensions: unknown };
    expect(marker.piExtensions).toEqual(merged);
    expect(JSON.parse(renderMarker('0.0.0', ['pi'], ['lead'], undefined, undefined, undefined, []))).not.toHaveProperty('piExtensions');
  });
});

describe('Pi seats with selected extensions', () => {
  it('loads every declared entry after the adapter for the selected roles and pins each seat role', async () => {
    const fixture = await makeFixture();
    const root = await installPackage(fixture.home, 'pi-blackbytes', { pi: { extensions: ['./dist/index.js'], prompts: ['./prompts'] } }, {
      'dist/index.js': 'export default function () {}\n',
    });
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['supervisor', 'lead', 'peer'], {
      piExtensions: [parsePiExtensionSpec('pi-blackbytes')],
    });
    expect(plan.checks.filter(check => check.status === 'fail')).toEqual([]);
    const entry = await realpath(join(root, 'dist/index.js'));
    const lead = plan.argv?.lead ?? [];
    // The adapter first, then the selected entry, both before the trust and prompt flags.
    expect(lead.slice(0, 5)).toEqual(['--no-extensions', '--extension', expect.stringContaining('pi-mcp-adapter'), '--extension', entry]);
    expect(lead.slice(5, 6)).toEqual(['--no-approve']);
    expect(plan.argv?.supervisor).toContain(entry);
    expect(plan.argv?.peer?.some(arg => arg.includes('pi-blackbytes'))).toBe(false);
    expect(plan.providerEnv).toEqual({
      supervisor: { PASEO_ROOM_ROLE: 'supervisor' }, lead: { PASEO_ROOM_ROLE: 'lead' }, peer: { PASEO_ROOM_ROLE: 'peer' },
    });
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'pi.extension.pi-blackbytes', status: 'pass' }));
    expect(plan.checks.some(check => check.id === 'pi.extension.pi-blackbytes.peer')).toBe(false);
  });

  it('warns about an extension given to Peer', async () => {
    const fixture = await makeFixture();
    await installPackage(fixture.home, 'pi-blackbytes', { pi: { extensions: ['./index.js'] } }, { 'index.js': '' });
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['peer'], { piExtensions: [parsePiExtensionSpec('pi-blackbytes=peer')] });
    expect(plan.argv?.peer?.some(arg => arg.includes('pi-blackbytes'))).toBe(true);
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'pi.extension.pi-blackbytes.peer', status: 'warn' }));
  });

  it('warns with the install command for a package that is not installed, and seats the role without it', async () => {
    const fixture = await makeFixture();
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['lead'], { piExtensions: [parsePiExtensionSpec('pi-provider-kiro')] });
    const missing = plan.checks.find(check => check.id === 'pi.extension.pi-provider-kiro.missing');
    expect(missing).toMatchObject({ status: 'warn' });
    expect(missing?.fix).toContain('pi install npm:pi-provider-kiro');
    expect(plan.binary).toBeDefined();
    expect(plan.argv?.lead?.filter(arg => arg === '--extension')).toHaveLength(1);
  });

  it('fails for a package that declares an entry outside itself or names another package', async () => {
    const escaping = await makeFixture();
    await installPackage(escaping.home, 'pi-bad', { pi: { extensions: ['../pi-mcp-adapter/index.ts'] } }, {});
    const escaped = await piAgent.build(resolveLayout({}, escaping.env), ['lead'], { piExtensions: [parsePiExtensionSpec('pi-bad')] });
    expect(escaped.checks).toContainEqual(expect.objectContaining({ id: 'pi.extension.pi-bad', status: 'fail' }));
    expect(escaped.entries).toHaveLength(0);

    const misnamed = await makeFixture();
    const root = join(misnamed.home, '.pi/agent/npm/node_modules/pi-other');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'not-pi-other', pi: { extensions: ['./index.js'] } }));
    await writeFile(join(root, 'index.js'), '');
    const wrong = await piAgent.build(resolveLayout({}, misnamed.env), ['lead'], { piExtensions: [parsePiExtensionSpec('pi-other')] });
    expect(wrong.checks).toContainEqual(expect.objectContaining({ id: 'pi.extension.pi-other', status: 'fail' }));
  });

  it('ignores a selection for a role this build does not seat', async () => {
    const fixture = await makeFixture();
    const plan = await piAgent.build(resolveLayout({}, fixture.env), ['lead'], { piExtensions: [parsePiExtensionSpec('pi-provider-kiro=peer')] });
    expect(plan.checks.some(check => check.id.startsWith('pi.extension.'))).toBe(false);
  });
});
