import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLayout } from '../src/layout.js';
import { readMarker, renderMarker } from '../src/room.js';
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
