import { describe, expect, it } from 'vitest';
import {
  contextLine, hasLead, leadlessProjects, sentence, supervisorChoices, supervisorSummary, watchingLabel, type ProjectView, type RoomView, type SeatView,
} from '../src/runtime-plugin/client/model.js';
import { clockTime } from '../src/runtime-plugin/client/time.js';
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

describe('seat context on the panel', () => {
  const context = (percent: number) => ({ used: percent * 10_000, max: 1_000_000, percent, rotateAtPercent: 30, compactAtPercent: 50 });

  it('says a seat\'s context and last compaction in one line, toned at its marks', () => {
    expect(contextLine(seat('lead-1', 'lead'))).toBeUndefined();
    expect(contextLine(seat('lead-1', 'lead', { context: context(12) }))).toEqual({ text: 'context 12%', tone: 'neutral' });
    const before = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    expect(contextLine(seat('lead-1', 'lead', {
      context: context(31), compaction: { lastAt: before(180), lastTrigger: 'auto', lastPreTokens: 498_000, seen: 1 },
    }))).toEqual({ text: 'context 31% · last compacted 3 h ago (auto, at 498k)', tone: 'warning' });
    expect(contextLine(seat('lead-1', 'lead', { context: context(50), compaction: { lastAt: before(5), seen: 2 } })))
      .toEqual({ text: 'context 50% · last compacted 5 min ago', tone: 'danger' });
    expect(contextLine(seat('sup-1', 'supervisor', { context: { ...context(45), rotateAtPercent: null, compactAtPercent: null } }))?.tone).toBe('neutral');
  });

  it('adds the context to a seat\'s role pill, naming the compaction\'s time rather than its age', () => {
    const lastAt = new Date(2026, 8, 26, 14, 5).toISOString();
    expect(clockTime(lastAt)).toBe('2026-09-26 14:05');
    const [lead] = rolePills(room([project({ seats: [seat('lead-1', 'lead', { context: context(31), compaction: { lastAt, lastTrigger: 'auto', seen: 1 } })] })]));
    expect(lead?.lines.at(-1)).toEqual(['Context', 'context 31% · last compacted 2026-09-26 14:05 (auto)']);
  });

  it('lists running Supervisors first and defaults to the project\'s own', () => {
    const sup = (agentId: string, title: string, state: string) => ({ ...seat(agentId, 'supervisor', { title, state }), portfolio: 0 });
    const supervisors = [sup('s-closed', 'Archive desk', 'closed'), sup('s-b', 'Room B', 'idle'), sup('s-a', 'Room A', 'running')];
    expect(supervisorChoices(supervisors).choices.map(entry => entry.agentId)).toEqual(['s-a', 's-b', 's-closed']);
    expect(supervisorChoices(supervisors).initial).toBe('s-a');
    expect(supervisorChoices(supervisors, 's-closed').initial).toBe('s-closed');
    expect(supervisorChoices(supervisors, 'gone').initial).toBe('s-a');
    expect(supervisorChoices([]).initial).toBeUndefined();
    expect(supervisorSummary({ ...sup('s-b', 'Room B', 'idle'), portfolio: 2 })).toBe('Claude · idle · ~/w/shop · watching 2 projects');
    expect([0, 1].map(watchingLabel)).toEqual(['not watching any project yet', 'watching 1 project']);
  });

  it('offers the observed projects that have no live Lead', () => {
    expect(sentence('peer')).toBe('Peer');
    expect(hasLead(project({ seats: [seat('peer-1', 'peer')] }))).toBe(false);
    const listed = leadlessProjects(room([
      project({ key: 'a', name: 'zeta', seats: [seat('peer-1', 'peer')] }),
      project({ key: 'b', name: 'alpha', seats: [] }),
      project({ key: 'c', name: 'shop', seats: [seat('lead-1', 'lead')] }),
    ]));
    expect(listed.map(entry => entry.name)).toEqual(['alpha', 'zeta']);
  });
});
