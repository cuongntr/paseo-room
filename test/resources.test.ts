import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleResourceEntries } from '../src/agents/resources.js';
import { existingPaths } from '../src/fsops.js';
import { ROOM_SKILL_NAME } from '../src/room/skills.js';

const NAMES = ['skills', 'plugins'] as const;
const ROOM_SKILL = { name: ROOM_SKILL_NAME, source: '/room/room/skills/paseo-project-onboarding' } as const;
const LEAD_PROJECTION = '/room/room/skill-projections/codex/lead';

async function operatorHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'paseo-room-resources-'));
  await mkdir(join(home, 'skills', 'formatting'), { recursive: true });
  await mkdir(join(home, 'skills', 'Paseo-Advisor'), { recursive: true });
  await mkdir(join(home, 'plugins'), { recursive: true });
  return home;
}

describe('roleResourceEntries', () => {
  it('aliases every shared resource for Supervisor, including the whole skills directory', async () => {
    const home = await operatorHome();
    const shared = [join(home, 'skills'), join(home, 'plugins')];
    expect(await roleResourceEntries({
      role: 'supervisor', target: '/room/supervisor', home, names: NAMES, shared,
      executable: ['plugins'], roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      { kind: 'link', path: '/room/supervisor/skills', target: join(home, 'skills') },
      { kind: 'link', path: '/room/supervisor/plugins', target: join(home, 'plugins') },
    ]);
  });

  it('gives Lead an exact projection of every operator skill plus the room-owned one', async () => {
    const home = await operatorHome();
    const shared = [join(home, 'skills'), join(home, 'plugins')];
    expect(await roleResourceEntries({
      role: 'lead', target: '/room/lead', home, names: NAMES, shared,
      executable: ['plugins'], roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      {
        kind: 'managed-dir',
        path: LEAD_PROJECTION,
        children: ['Paseo-Advisor', 'formatting', ROOM_SKILL_NAME],
      },
      { kind: 'link', path: join(LEAD_PROJECTION, 'Paseo-Advisor'), target: join(home, 'skills', 'Paseo-Advisor') },
      { kind: 'link', path: join(LEAD_PROJECTION, 'formatting'), target: join(home, 'skills', 'formatting') },
      { kind: 'link', path: join(LEAD_PROJECTION, ROOM_SKILL_NAME), target: ROOM_SKILL.source },
      { kind: 'link', path: '/room/lead/skills', target: LEAD_PROJECTION },
      { kind: 'link', path: '/room/lead/plugins', target: join(home, 'plugins') },
    ]);
  });

  // The room-owned copy owns that name inside the Lead aggregate; the operator's own skill
  // stays exactly where it is, unlinked and unmodified.
  it.each([ROOM_SKILL_NAME, 'PASEO-PROJECT-ONBOARDING'])(
    'links the room-owned skill rather than a case-insensitively colliding operator skill named %s',
    async operatorName => {
      const home = await operatorHome();
      await mkdir(join(home, 'skills', operatorName), { recursive: true });
      const entries = await roleResourceEntries({
        role: 'lead', target: '/room/lead', home, names: ['skills'], shared: [join(home, 'skills')],
        executable: [], roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
      });
      const collision = join(LEAD_PROJECTION, ROOM_SKILL_NAME);
      expect(entries.filter(entry => entry.path === collision)).toEqual([
        { kind: 'link', path: collision, target: ROOM_SKILL.source },
      ]);
      expect(entries.some(entry => entry.path === join(LEAD_PROJECTION, operatorName)
        && entry.path !== collision)).toBe(false);
    },
  );

  it.each(['synced', 'Synced'])(
    'reserves an agent runtime skill bucket case-insensitively from operator skill %s',
    async operatorName => {
      const home = await operatorHome();
      await mkdir(join(home, 'skills', operatorName), { recursive: true });
      for (const role of ['lead', 'peer'] as const) {
        const entries = await roleResourceEntries({
          role, target: `/room/${role}`, home, names: ['skills'], shared: [join(home, 'skills')],
          executable: [], reservedSkills: ['synced'], roomSkill: ROOM_SKILL,
          leadSkillProjection: LEAD_PROJECTION,
        });
        expect(entries[0]).toMatchObject({ kind: 'managed-dir', reserved: ['synced'] });
        expect(entries.some(entry => entry.kind === 'link'
          && entry.path.toLowerCase().endsWith('/synced'))).toBe(false);
      }
    },
  );

  it('gives Peer an exact non-paseo skills projection, no room skill, and no executable resource', async () => {
    const home = await operatorHome();
    const entries = await roleResourceEntries({
      role: 'peer',
      target: '/room/peer',
      home,
      names: NAMES,
      shared: [join(home, 'skills'), join(home, 'plugins')],
      executable: ['plugins'],
      roomSkill: ROOM_SKILL,
      leadSkillProjection: LEAD_PROJECTION,
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
      roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      { kind: 'managed-dir', path: '/room/peer/skills', children: [], legacyLink: join(home, 'skills') },
    ]);
  });

  // A deleted source directory still has to be reconciled: without the declaration nothing
  // would remove yesterday's child links or migrate a legacy whole-directory symlink.
  it('still declares the projection when the operator deleted the whole directory', async () => {
    const home = await operatorHome();
    await rm(join(home, 'skills'), { recursive: true });
    const shared = await existingPaths(home, NAMES);
    expect(shared).toEqual([join(home, 'plugins')]);
    expect(await roleResourceEntries({
      role: 'peer', target: '/room/peer', home, names: NAMES, shared, executable: ['plugins'],
      roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      { kind: 'managed-dir', path: '/room/peer/skills', children: [], legacyLink: join(home, 'skills') },
    ]);
    // Lead still gets the room-owned skill: it does not depend on the operator directory.
    expect(await roleResourceEntries({
      role: 'lead', target: '/room/lead', home, names: NAMES, shared, executable: ['plugins'],
      roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      { kind: 'managed-dir', path: LEAD_PROJECTION, children: [ROOM_SKILL_NAME] },
      { kind: 'link', path: join(LEAD_PROJECTION, ROOM_SKILL_NAME), target: ROOM_SKILL.source },
      { kind: 'link', path: '/room/lead/skills', target: LEAD_PROJECTION },
      { kind: 'link', path: '/room/lead/plugins', target: join(home, 'plugins') },
    ]);
  });

  it('never aliases an absent resource for Supervisor', async () => {
    const home = await operatorHome();
    await rm(join(home, 'skills'), { recursive: true });
    const shared = await existingPaths(home, NAMES);
    expect(await roleResourceEntries({
      role: 'supervisor', target: '/room/supervisor', home, names: NAMES, shared, executable: [],
      roomSkill: ROOM_SKILL, leadSkillProjection: LEAD_PROJECTION,
    })).toEqual([
      { kind: 'link', path: '/room/supervisor/plugins', target: join(home, 'plugins') },
    ]);
  });
});
