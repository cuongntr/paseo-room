/**
 * Role pills: which room seat is which, shown in each seat's composer without renaming it
 * (Paseo gives a custom provider no tab icon, and plugins cannot decorate tabs). Pure: derives
 * the pills from the room view, so the registrar only adds, updates and removes.
 */
import { launchLabel, type RoomView } from './model.js';

export type SeatRole = 'supervisor' | 'lead' | 'peer';

export interface RolePill {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly role: SeatRole;
  readonly label: string;
  readonly title: string;
  readonly lines: readonly (readonly [string, string])[];
}

export const ROLE_PILL: Readonly<Record<SeatRole, { readonly icon: string; readonly label: string }>> = {
  supervisor: { icon: 'Eye', label: 'Supervisor' },
  lead: { icon: 'Compass', label: 'Lead' },
  peer: { icon: 'Wrench', label: 'Peer' },
};

const isRole = (role: string): role is SeatRole => role === 'supervisor' || role === 'lead' || role === 'peer';
const titleOf = (seat: { readonly title: string | null; readonly role: string; readonly agentId: string }): string => seat.title ?? `${seat.role} ${seat.agentId.slice(0, 8)}`;

/** One pill per live room seat that sits in a Paseo workspace. */
export function rolePills(room: RoomView): readonly RolePill[] {
  const pills = new Map<string, RolePill>();
  for (const project of room.projects) {
    const byId = new Map(project.seats.map(seat => [seat.agentId, seat]));
    for (const seat of project.seats) {
      if (!isRole(seat.role) || seat.role === 'supervisor' || seat.workspaceId === undefined || seat.workspaceId === null) continue;
      const parent = seat.parentAgentId === null ? undefined : byId.get(seat.parentAgentId);
      const lines: [string, string][] = [['Project', `${project.name} · ${project.displayRoot}`]];
      if (seat.role === 'peer') lines.push(['Lead', parent === undefined ? 'not in this project' : titleOf(parent)]);
      lines.push(['Supervisor', project.supervisor === undefined ? 'none — assign one in Room runtime' : titleOf(project.supervisor)]);
      const runs = launchLabel(seat);
      if (runs !== '') lines.push(['Runs', runs]);
      pills.set(seat.agentId, {
        agentId: seat.agentId, workspaceId: seat.workspaceId, role: seat.role, label: ROLE_PILL[seat.role].label,
        title: `Room ${ROLE_PILL[seat.role].label} of ${project.name}`, lines,
      });
    }
  }
  for (const supervisor of room.supervisors) {
    if (supervisor.workspaceId === undefined || supervisor.workspaceId === null) continue;
    const watched = room.projects.filter(project => project.supervisor?.agentId === supervisor.agentId).map(project => project.name);
    const runs = launchLabel(supervisor);
    pills.set(supervisor.agentId, {
      agentId: supervisor.agentId, workspaceId: supervisor.workspaceId, role: 'supervisor', label: ROLE_PILL.supervisor.label,
      title: 'Room Supervisor',
      lines: [
        ['Watching', watched.length === 0 ? 'no project yet — assign projects in Room runtime' : watched.join(', ')], ['Folder', supervisor.displayCwd],
        ...(runs === '' ? [] : [['Runs', runs] as const]),
      ],
    });
  }
  return [...pills.values()];
}

/** Whether a registered pill must be redrawn. */
export const pillKey = (pill: RolePill): string => JSON.stringify([pill.workspaceId, pill.role, pill.title, pill.lines]);
