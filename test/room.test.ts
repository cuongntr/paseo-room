import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLayout } from '../src/layout.js';
import { readMarker, renderMarker } from '../src/room.js';
import { contractDigest, INSTRUCTION_KINDS, renderInstructions } from '../src/room/instructions.js';
import { makeFixture } from './helpers.js';

describe('room marker agent set', () => {
  it('round-trips Pi as a supported agent and rejects retired or arbitrary adapters', async () => {
    expect(JSON.parse(renderMarker('1.0.0', ['pi'], ['lead']))).toMatchObject({ agents: ['pi'] });
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await mkdir(layout.roomHome);
    await writeFile(join(layout.roomHome, 'room.json'), JSON.stringify({ version: '1.0.0', agents: ['omp'], roles: ['lead'] }));
    expect(await readMarker(layout)).toBeUndefined();
  });

  it('records an optional contract digest and still reads a marker written without one', async () => {
    const digest = contractDigest();
    expect(JSON.parse(renderMarker('1.0.0', ['codex'], ['lead'], digest))).toEqual({
      version: '1.0.0', agents: ['codex'], roles: ['lead'], contract: digest,
    });
    // The field is omitted rather than written empty when no digest is supplied.
    expect(JSON.parse(renderMarker('1.0.0', ['codex'], ['lead']))).toEqual({
      version: '1.0.0', agents: ['codex'], roles: ['lead'],
    });

    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await mkdir(layout.roomHome);
    const marker = join(layout.roomHome, 'room.json');
    await writeFile(marker, renderMarker('0.0.1', ['codex'], ['lead']));
    expect(await readMarker(layout)).toEqual({ version: '0.0.1', agents: ['codex'], roles: ['lead'] });
    await writeFile(marker, renderMarker('0.0.1', ['codex'], ['lead'], digest));
    expect((await readMarker(layout))?.contract).toBe(digest);
    // An empty digest is not a digest: the field is either absent or meaningful.
    await writeFile(marker, JSON.stringify({ version: '0.0.1', agents: ['codex'], roles: ['lead'], contract: '' }));
    expect(await readMarker(layout)).toBeUndefined();
  });

  it('records a suppressed Claude memory contract only when it differs from the default', async () => {
    const digest = contractDigest();
    // The default is not written, so an unchanged room's marker stays byte-identical.
    expect(JSON.parse(renderMarker('1.0.0', ['claude'], ['lead'], digest, true))).toEqual({
      version: '1.0.0', agents: ['claude'], roles: ['lead'], contract: digest,
    });
    expect(JSON.parse(renderMarker('1.0.0', ['claude'], ['lead'], digest, undefined))).toEqual({
      version: '1.0.0', agents: ['claude'], roles: ['lead'], contract: digest,
    });
    expect(JSON.parse(renderMarker('1.0.0', ['claude'], ['lead'], digest, false))).toEqual({
      version: '1.0.0', agents: ['claude'], roles: ['lead'], contract: digest, claudeMemoryContract: false,
    });

    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await mkdir(layout.roomHome);
    const path = join(layout.roomHome, 'room.json');
    await writeFile(path, renderMarker('0.0.1', ['claude'], ['lead'], digest, false));
    expect((await readMarker(layout))?.claudeMemoryContract).toBe(false);
    // A room written before the option existed still parses, and defaults to the fallback.
    await writeFile(path, renderMarker('0.0.1', ['claude'], ['lead'], digest));
    expect((await readMarker(layout))?.claudeMemoryContract).toBeUndefined();
  });

  it('derives the digest from the rendered documents, deterministically and not from the package version', () => {
    expect(contractDigest()).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(contractDigest()).toBe(contractDigest());
    // The digest covers the three rendered role documents only; the room composes nothing else.
    expect(INSTRUCTION_KINDS).toEqual(['supervisor', 'lead', 'peer']);
    // Same inputs, same algorithm: recomputing it by hand over every rendered document
    // must reproduce the marker value, so no package metadata can be feeding it.
    const hash = createHash('sha256');
    for (const kind of INSTRUCTION_KINDS) hash.update(`${kind}\u0000${renderInstructions(kind)}\u0000`);
    expect(contractDigest()).toBe(`sha256:${hash.digest('hex').slice(0, 16)}`);
  });

  it('resolves Pi defaults and environment overrides', () => {
    const defaults = resolveLayout({}, { HOME: '/home/operator', PATH: '/bin' });
    expect(defaults.agentHome.pi).toBe('/home/operator/.pi/agent');
    expect(defaults.bin.pi).toBe('pi');
    const overridden = resolveLayout({}, {
      HOME: '/home/operator', PATH: '/bin', PI_CODING_AGENT_DIR: '/opt/pi-home', PI_BIN: '/opt/bin/pi',
    });
    expect(overridden.agentHome.pi).toBe('/opt/pi-home');
    expect(overridden.bin.pi).toBe('/opt/bin/pi');
  });
});
