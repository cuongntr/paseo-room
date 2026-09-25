/**
 * The Room and Project screens (docs/design/runtime-panel-ux.md §4–§5): attention first, then
 * projects by status, then Supervisors; a project holds its Supervisor, its seats and its runtime
 * record. Every seat opens its agent in Paseo when the host offers navigation.
 */
import { useToast } from '@getpaseo/plugin/client/react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { idempotencyKey, unwrap, useRuntimeRpcs } from './data.js';
import { ATTENTION_SETTINGS_SCREEN, openSettings } from './host.js';
import { Button, Callout, Card, Dot, Empty, Glyph, IconButton, Pill, Row, SPACE, SectionLabel, Title, ago, type Theme } from './kit.js';
import {
  KIND_LABEL, LEVEL_STYLE, ROLE_ICON, STATE_LABEL, STATUS_TONE, lastActivity, launchLabel, projectHeadline, projectStatus, providerLabel, seatName, sortIncidents, sortProjects, stateTone,
  type IncidentView, type ProjectView, type RoomView, type SeatView,
} from './model.js';
import { RuntimeRecord } from './record.js';

export interface RoomActions {
  readonly openProject: (key: string) => void;
  readonly openAssignment: (projectKey: string, projectId: string, assignmentId: string) => void;
  readonly newSupervisor: () => void;
  readonly newProject: () => void;
  readonly assign: (projectKey: string) => void;
  readonly openAgent?: (agentId: string) => void;
  readonly reload: () => void;
}

function useFeedback(reload: () => void) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  return (incident: IncidentView, verdict: 'useful' | 'noise'): void => {
    rpc.incidentFeedback({ id: incident.id, verdict, idempotencyKey: idempotencyKey() }).then(answer => {
      const error = unwrap(answer).error;
      if (error !== undefined) { toast.error(error.message); return; }
      toast.show(verdict === 'useful' ? 'Marked useful — thanks' : 'Marked as noise — it tunes what reaches you', { variant: 'success' });
      reload();
    }, (failure: unknown) => { toast.error(String(failure)); });
  };
}

function IncidentRow(props: { readonly theme: Theme; readonly incident: IncidentView; readonly first: boolean; readonly project?: ProjectView; readonly room: RoomView; readonly actions: RoomActions; readonly rate: (incident: IncidentView, verdict: 'useful' | 'noise') => void }) {
  const { theme, incident } = props;
  const style = LEVEL_STYLE[incident.level] ?? { icon: 'Info', tone: 'muted' as const, label: incident.level };
  const recipient = incident.recipient === 'panel' ? 'for you — no Supervisor receives it' : `sent to ${props.room.supervisors.find(entry => entry.agentId === incident.recipient)?.title ?? 'its Supervisor'}`;
  const subject = incident.subjects[0];
  return (
    <Row theme={theme} first={props.first}
      leading={<Glyph theme={theme} name={style.icon} tone={style.tone} size={17} />}
      title={`${props.project?.name ?? 'Room'} — ${KIND_LABEL[incident.kind] ?? incident.kind}`}
      subtitle={incident.summary ?? incident.text}
      meta={`${style.label} · ${ago(incident.openedAt)} · ${recipient}${incident.count > 1 ? ` · seen ${String(incident.count)}×` : ''}`}
      trailing={(
        <View style={{ flexDirection: 'row' }}>
          {subject !== undefined && props.actions.openAgent !== undefined
            ? <IconButton theme={theme} icon="ExternalLink" label="Open the agent" onPress={() => { props.actions.openAgent?.(subject); }} /> : null}
          <IconButton theme={theme} icon="ThumbsUp" label="Useful" active={incident.feedback === 'useful'} tone="success" onPress={() => { props.rate(incident, 'useful'); }} />
          <IconButton theme={theme} icon="ThumbsDown" label="Noise" active={incident.feedback === 'noise'} tone="warning" onPress={() => { props.rate(incident, 'noise'); }} />
        </View>
      )} />
  );
}

function ProjectRow(props: { readonly theme: Theme; readonly project: ProjectView; readonly first: boolean; readonly onPress: () => void }) {
  const { theme, project } = props;
  const status = projectStatus(project);
  const last = lastActivity(project);
  return (
    <Row theme={theme} first={props.first} onPress={props.onPress} accessibilityLabel={`Open ${project.name}`}
      leading={<Dot theme={theme} tone={STATUS_TONE[status]} />}
      title={project.name}
      subtitle={projectHeadline(project)}
      meta={`${project.displayRoot}${last === undefined ? '' : ` · active ${ago(last)}`}`}
      trailing={(
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          {project.incidents.length > 0 ? <Pill theme={theme} tone="warning" icon="TriangleAlert">{String(project.incidents.length)}</Pill> : null}
          {project.seats.length === 0
            ? <Pill theme={theme} tone="muted" icon="Archive">archived</Pill>
            : project.supervisor === undefined
              ? <Pill theme={theme} tone="warning" icon="EyeOff">No supervisor</Pill>
              : <Pill theme={theme} tone="muted" icon="Eye">{seatName(project.supervisor)}</Pill>}
          <Glyph theme={theme} name="ChevronRight" size={16} />
        </View>
      )} />
  );
}

function About(props: { readonly theme: Theme }) {
  const [open, setOpen] = useState(false);
  const { colors } = props.theme;
  const points: readonly (readonly [string, string])[] = [
    ['ShieldAlert', 'The runtime is trusted, unsandboxed plugin code. It cannot stop a process running as your user.'],
    ['Eye', 'Attention letters to a Supervisor are evidence, not instructions. A letter waits for the Supervisor to be idle and is never sent while it holds a permission.'],
    ['Lock', 'Records stay under your room home. The attention sensor is off unless you enable it; when on, it sends masked, bounded excerpts of Lead messages to the endpoint you acknowledged, and nothing else.'],
    ['GitBranch', 'Isolated writers work in worktrees Paseo creates. Write scopes prevent collisions between them; they do not contain a Peer.'],
  ];
  return (
    <View style={{ marginTop: SPACE.xl }}>
      <Pressable onPress={() => { setOpen(!open); }} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4 }}>
        <Glyph theme={props.theme} name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>How the room runtime works</Text>
      </Pressable>
      {open ? (
        <Card theme={props.theme} style={{ marginTop: SPACE.sm, padding: SPACE.lg, gap: SPACE.md }}>
          {points.map(([icon, text]) => (
            <View key={icon} style={{ flexDirection: 'row', gap: SPACE.md }}>
              <Glyph theme={props.theme} name={icon} size={15} />
              <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 }}>{text}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

export function RoomScreen(props: { readonly theme: Theme; readonly room: RoomView; readonly actions: RoomActions }) {
  const { theme, room, actions } = props;
  const rate = useFeedback(actions.reload);
  const projects = sortProjects(room.projects);
  const incidents = sortIncidents([...room.projects.flatMap(project => project.incidents), ...room.panelIncidents]);
  const working = room.projects.filter(project => projectStatus(project) === 'working').length;
  const settings = openSettings(ATTENTION_SETTINGS_SCREEN);
  const summary = room.projects.length === 0
    ? 'Nothing observed yet'
    : `${String(room.projects.length)} project${room.projects.length === 1 ? '' : 's'} · ${String(working)} working · ${incidents.length === 0 ? 'nothing needs you' : `${String(incidents.length)} need${incidents.length === 1 ? 's' : ''} a look`}`;
  const empty = room.projects.length === 0 && room.supervisors.length === 0;
  return (
    <View>
      <Title theme={theme} subtitle={summary}
        trailing={(
          <>
            {settings === undefined ? null : <IconButton theme={theme} icon="SlidersHorizontal" label="Room attention settings" onPress={settings} />}
            <Button theme={theme} label="New project" icon="Plus" variant="primary" onPress={actions.newProject} />
          </>
        )}>Room</Title>

      {empty ? (
        <Card theme={theme}>
          <Empty theme={theme} icon="Sparkles" title="Set up your room"
            action={(
              <>
                <Button theme={theme} label="1  New Supervisor" icon="Eye" onPress={actions.newSupervisor} />
                <Button theme={theme} label="2  New project" icon="FolderPlus" variant="primary" onPress={actions.newProject} />
              </>
            )}>
            Start a Supervisor in a folder outside your repositories, then start a Lead for each repository under it. The Supervisor is told when work stalls, so you don't have to ask.
          </Empty>
        </Card>
      ) : (
        <View>
          {incidents.length === 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: 2 }}>
              <Glyph theme={theme} name="CircleCheck" tone="success" size={15} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>All quiet — nothing is waiting on you or a Supervisor.</Text>
            </View>
          ) : (
            <View>
              <SectionLabel theme={theme}>Needs attention</SectionLabel>
              <Card theme={theme} tone={incidents.some(incident => incident.level === 'page') ? 'danger' : 'neutral'}>
                {incidents.map((incident, index) => (
                  <IncidentRow key={incident.id} theme={theme} incident={incident} first={index === 0} room={room} actions={actions} rate={rate}
                    {...(room.projects.find(project => project.key === incident.projectKey) === undefined ? {} : { project: room.projects.find(project => project.key === incident.projectKey) as ProjectView })} />
                ))}
              </Card>
            </View>
          )}

          <SectionLabel theme={theme}>Projects</SectionLabel>
          <Card theme={theme}>
            {projects.length === 0
              ? <Empty theme={theme} icon="FolderGit2" title="No projects yet" action={<Button theme={theme} small label="New project" icon="Plus" onPress={actions.newProject} />}>Start a Lead in a repository and it appears here.</Empty>
              : projects.map((project, index) => <ProjectRow key={project.key} theme={theme} project={project} first={index === 0} onPress={() => { actions.openProject(project.key); }} />)}
          </Card>

          <SectionLabel theme={theme} trailing={<Button theme={theme} small variant="ghost" label="New Supervisor" icon="Plus" onPress={actions.newSupervisor} />}>Supervisors</SectionLabel>
          <Card theme={theme}>
            {room.supervisors.length === 0
              ? <Empty theme={theme} icon="Eye" title="No Supervisor">A Supervisor watches your projects and is told when they stall. One can watch several repositories.</Empty>
              : room.supervisors.map((supervisor, index) => (
                <Row key={supervisor.agentId} theme={theme} first={index === 0}
                  {...(actions.openAgent === undefined ? {} : { onPress: () => { actions.openAgent?.(supervisor.agentId); } })}
                  leading={<Glyph theme={theme} name="Eye" boxed />}
                  title={seatName(supervisor)}
                  subtitle={supervisor.portfolio === 0 ? 'Not watching any project yet' : `Watching ${String(supervisor.portfolio)} project${supervisor.portfolio === 1 ? '' : 's'}`}
                  meta={supervisor.displayCwd}
                  trailing={<Pill theme={theme} tone={stateTone(supervisor.state)}>{STATE_LABEL[supervisor.state] ?? supervisor.state}</Pill>} />
              ))}
          </Card>
        </View>
      )}
      <About theme={theme} />
    </View>
  );
}

function SeatTree(props: { readonly theme: Theme; readonly seats: readonly SeatView[]; readonly openAgent?: (agentId: string) => void }) {
  const ids = new Set(props.seats.map(seat => seat.agentId));
  const children = new Map<string | null, SeatView[]>();
  for (const seat of props.seats) {
    const parent = seat.parentAgentId !== null && ids.has(seat.parentAgentId) ? seat.parentAgentId : null;
    children.set(parent, [...(children.get(parent) ?? []), seat]);
  }
  const rows: { readonly seat: SeatView; readonly depth: number }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    const sorted = [...(children.get(parent) ?? [])].sort((a, b) => (a.role === b.role ? seatName(a).localeCompare(seatName(b)) : a.role === 'lead' ? -1 : 1));
    for (const seat of sorted) { rows.push({ seat, depth }); walk(seat.agentId, depth + 1); }
  };
  walk(null, 0);
  const { theme } = props;
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map(({ seat, depth }, index) => (
        <Row key={seat.agentId} theme={theme} first={index === 0} indent={depth}
          {...(props.openAgent === undefined ? {} : { onPress: () => { props.openAgent?.(seat.agentId); } })}
          accessibilityLabel={`Open ${seatName(seat)}`}
          leading={<Glyph theme={theme} name={ROLE_ICON[seat.role] ?? 'Bot'} boxed tone={seat.role === 'lead' ? 'accent' : 'muted'} />}
          title={seatName(seat)}
          subtitle={`${seat.role === 'lead' ? 'Lead' : seat.role === 'peer' ? 'Peer' : 'Supervisor'} · ${providerLabel(seat.provider)}${launchLabel(seat) === '' ? '' : ` · ${launchLabel(seat)}`}${seat.pendingPermissions > 0 ? ` · ${String(seat.pendingPermissions)} permission${seat.pendingPermissions === 1 ? '' : 's'} waiting` : ''}`}
          {...(seat.lastTurn === undefined ? {} : { meta: `Last turn ${seat.lastTurn.outcome} ${ago(seat.lastTurn.endedAt)}` })}
          trailing={(
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <Pill theme={theme} tone={stateTone(seat.state)}>{STATE_LABEL[seat.state] ?? seat.state}</Pill>
              {props.openAgent === undefined ? null : <Glyph theme={theme} name="ExternalLink" size={14} />}
            </View>
          )} />
      ))}
    </>
  );
}

export function ProjectScreen(props: { readonly theme: Theme; readonly room: RoomView; readonly project: ProjectView; readonly actions: RoomActions; readonly back?: () => void }) {
  const { theme, room, project, actions } = props;
  const rate = useFeedback(actions.reload);
  const status = projectStatus(project);
  const decided = project.decidedBy === 'human' ? 'Assigned by you' : project.decidedBy === 'parentage' ? 'Opened its Lead' : 'Attention for this project comes to this panel only';
  return (
    <View>
      {props.back === undefined ? null : <View style={{ alignSelf: 'flex-start', marginBottom: SPACE.md }}><Button theme={theme} small variant="ghost" label="Room" icon="ArrowLeft" onPress={props.back} /></View>}
      <Title theme={theme} leading={<Glyph theme={theme} name="FolderGit2" boxed tone={STATUS_TONE[status]} />} subtitle={`${project.displayRoot}${project.git ? '' : ' · not Git'}`}
        trailing={<Pill theme={theme} tone={STATUS_TONE[status]}>{status === 'attention' ? 'needs a look' : status}</Pill>}>{project.name}</Title>

      {project.incidents.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>Needs attention</SectionLabel>
          <Card theme={theme}>
            {sortIncidents(project.incidents).map((incident, index) => (
              <IncidentRow key={incident.id} theme={theme} incident={incident} first={index === 0} project={project} room={room} actions={actions} rate={rate} />
            ))}
          </Card>
        </View>
      )}

      {project.seats.length === 0 ? null : <SectionLabel theme={theme}>Supervisor</SectionLabel>}
      {project.seats.length === 0 ? null : project.supervisor === undefined ? (
        <Callout theme={theme} tone="warning" icon="EyeOff" title="No Supervisor watches this project"
          action={<Button theme={theme} small label="Assign a Supervisor" icon="Eye" onPress={() => { actions.assign(project.key); }} />}>
          Nobody is told when it stalls; its signals only appear here.
        </Callout>
      ) : (
        <Card theme={theme}>
          <Row theme={theme} first leading={<Glyph theme={theme} name="Eye" boxed />} title={seatName(project.supervisor)} subtitle={decided}
            trailing={(
              <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
                {actions.openAgent === undefined ? null : <Button theme={theme} small label="Open" icon="ExternalLink" onPress={() => { if (project.supervisor !== undefined) actions.openAgent?.(project.supervisor.agentId); }} />}
                <Button theme={theme} small label="Change…" onPress={() => { actions.assign(project.key); }} />
              </View>
            )} />
        </Card>
      )}

      <SectionLabel theme={theme}>Seats</SectionLabel>
      <Card theme={theme}>
        {project.seats.length === 0
          ? <Empty theme={theme} icon="Archive" title="No live seats">Every agent of this project is archived. Its runtime record is kept below.</Empty>
          : <SeatTree theme={theme} seats={project.seats} {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />}
      </Card>

      <SectionLabel theme={theme}>Runtime record</SectionLabel>
      {project.runtime === undefined ? (
        <Card theme={theme}>
          <Empty theme={theme} icon="ClipboardList" title="No runtime record yet">
            It starts when this project's Lead first uses the runtime's assignment tools. Delegation through Paseo's own tools still shows above, under Seats.
          </Empty>
        </Card>
      ) : (
        <RuntimeRecord theme={theme} projectId={project.runtime.projectId} openAssignment={assignmentId => { if (project.runtime !== undefined) actions.openAssignment(project.key, project.runtime.projectId, assignmentId); }} />
      )}
    </View>
  );
}
