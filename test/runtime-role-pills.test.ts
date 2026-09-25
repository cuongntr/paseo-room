import { describe, expect, it } from 'vitest';
import type { ProjectView, RoomView, SeatView } from '../src/runtime-plugin/client/model.js';
import { pillKey, rolePills } from '../src/runtime-plugin/client/pills.js';

const seat = (agentId: string, role: string, change: Partial<SeatView> = {}): SeatView => ({
  agentId, role, provider: `claude-${role}`, title: null, state: 'idle', cwd: '/w/shop', displayCwd: '~/w/shop', workspaceId: 'ws-shop',
  parentAgentId: null, pendingPermissions: 0, ...change,
});
const project = (change: Partial<ProjectView> = {}): ProjectView => ({
  key: 'shop', name: 'shop', root: '/w/shop', displayRoot: '~/w/shop', git: true, decidedBy: 'parentage', seats: [], incidents: [], ...change,
});
const room = (projects: readonly ProjectView[], supervisors: RoomView['supervisors'] = []): RoomView => ({ started: true, projects, supervisors, panelIncidents: [], providers: [] });

describe('role pills', () => {
  it('labels each seat by role and names its project, Lead and Supervisor', () => {
    const sup = { ...seat('sup-1', 'supervisor', { title: 'Desk', workspaceId: 'ws-desk', displayCwd: '~/desk' }), portfolio: 1 };
    const pills = rolePills(room([project({
      supervisor: sup,
      seats: [seat('lead-1', 'lead', { title: 'shop — Lead' }), seat('peer-1', 'peer', { parentAgentId: 'lead-1' })],
    })], [sup]));
    expect(pills.map(pill => [pill.agentId, pill.label, pill.workspaceId])).toEqual([
      ['lead-1', 'Lead', 'ws-shop'], ['peer-1', 'Peer', 'ws-shop'], ['sup-1', 'Supervisor', 'ws-desk'],
    ]);
    expect(pills[0]).toMatchObject({ title: 'Room Lead of shop', lines: [['Project', 'shop · ~/w/shop'], ['Supervisor', 'Desk']] });
    expect(pills[1]?.lines).toEqual([['Project', 'shop · ~/w/shop'], ['Lead', 'shop — Lead'], ['Supervisor', 'Desk']]);
    expect(pills[2]?.lines).toEqual([['Watching', 'shop'], ['Folder', '~/desk']]);
  });

  it('says what a seat runs on when Paseo reports it', () => {
    const [peer] = rolePills(room([project({ seats: [seat('peer-1', 'peer', { model: 'claude-opus-5-5', thinking: 'medium' })] })]));
    expect(peer?.lines.at(-1)).toEqual(['Runs', 'claude-opus-5-5 · thinking medium']);
    const [bare] = rolePills(room([project({ seats: [seat('peer-2', 'peer', { model: null, thinking: null })] })]));
    expect(bare?.lines.map(([key]) => key)).not.toContain('Runs');
  });

  it('says when a project has no Supervisor and a Peer has no Lead here', () => {
    const [peer] = rolePills(room([project({ seats: [seat('peer-1', 'peer', { parentAgentId: 'gone' })] })]));
    expect(peer?.lines).toEqual([['Project', 'shop · ~/w/shop'], ['Lead', 'not in this project'], ['Supervisor', 'none — assign one in Room runtime']]);
  });

  it('skips a seat outside any workspace and a role it does not know', () => {
    expect(rolePills(room([project({ seats: [seat('lead-1', 'lead', { workspaceId: null }), seat('x', 'observer')] })]))).toEqual([]);
  });

  it('redraws only when what a pill shows changes', () => {
    const before = rolePills(room([project({ seats: [seat('lead-1', 'lead', { state: 'idle' })] })]));
    const working = rolePills(room([project({ seats: [seat('lead-1', 'lead', { state: 'running' })] })]));
    const renamed = rolePills(room([project({ name: 'store', seats: [seat('lead-1', 'lead')] })]));
    expect(working.map(pillKey)).toEqual(before.map(pillKey));
    expect(renamed.map(pillKey)).not.toEqual(before.map(pillKey));
  });
});
