import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleResourceEntries } from '../src/agents/resources.js';
import { existingPaths } from '../src/fsops.js';

const NAMES = ['skills', 'plugins'] as const;

async function operatorHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'paseo-room-resources-'));
  await mkdir(join(home, 'skills', 'formatting'), { recursive: true });
  await mkdir(join(home, 'skills', 'Paseo-Advisor'), { recursive: true });
  await mkdir(join(home, 'plugins'), { recursive: true });
  return home;
}

describe('roleResourceEntries', () => {
  it('aliases every shared resource for Supervisor and Lead', async () => {
    const home = await operatorHome();
    const shared = [join(home, 'skills'), join(home, 'plugins')];
    for (const role of ['supervisor', 'lead'] as const) {
      expect(await roleResourceEntries({ role, target: '/room/peer', home, names: NAMES, shared, executable: ['plugins'] })).toEqual([
        { kind: 'link', path: '/room/peer/skills', target: join(home, 'skills') },
        { kind: 'link', path: '/room/peer/plugins', target: join(home, 'plugins') },
      ]);
    }
  });

  it('gives Peer an exact managed skills projection and no executable resource', async () => {
    const home = await operatorHome();
    const entries = await roleResourceEntries({
      role: 'peer',
      target: '/room/peer',
      home,
      names: NAMES,
      shared: [join(home, 'skills'), join(home, 'plugins')],
      executable: ['plugins'],
    });
    expect(entries).toEqual([
      { kind: 'managed-dir', path: '/room/peer/skills', children: ['formatting'], legacyLink: join(home, 'skills') },
      { kind: 'link', path: '/room/peer/skills/formatting', target: join(home, 'skills', 'formatting') },
    ]);
  });

  it('projects an empty directory when every operator skill is a room skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'paseo-room-resources-'));
    await mkdir(join(home, 'skills', 'paseo-help'), { recursive: true });
    expect(await roleResourceEntries({
      role: 'peer', target: '/room/peer', home, names: ['skills'], shared: [join(home, 'skills')], executable: [],
    })).toEqual([
      { kind: 'managed-dir', path: '/room/peer/skills', children: [], legacyLink: join(home, 'skills') },
    ]);
  });

  // A deleted source directory still has to be reconciled: without the declaration nothing
  // would remove yesterday's child links or migrate a legacy whole-directory symlink.
  it('still declares Peer skills when the operator deleted the whole directory', async () => {
    const home = await operatorHome();
    await rm(join(home, 'skills'), { recursive: true });
    const shared = await existingPaths(home, NAMES);
    expect(shared).toEqual([join(home, 'plugins')]);
    expect(await roleResourceEntries({
      role: 'peer', target: '/room/peer', home, names: NAMES, shared, executable: ['plugins'],
    })).toEqual([
      { kind: 'managed-dir', path: '/room/peer/skills', children: [], legacyLink: join(home, 'skills') },
    ]);
  });

  it('never aliases an absent resource for Supervisor and Lead', async () => {
    const home = await operatorHome();
    await rm(join(home, 'skills'), { recursive: true });
    const shared = await existingPaths(home, NAMES);
    for (const role of ['supervisor', 'lead'] as const) {
      expect(await roleResourceEntries({ role, target: '/room/lead', home, names: NAMES, shared, executable: [] })).toEqual([
        { kind: 'link', path: '/room/lead/plugins', target: join(home, 'plugins') },
      ]);
    }
  });
});
