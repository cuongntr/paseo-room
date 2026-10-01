/**
 * The Room and Project screens (docs/design/runtime-panel-ux.md §4–§5): attention first, then
 * projects by status and recent activity, then Supervisors; a project holds its Supervisor, its
 * seats and its runtime record. Every seat opens its agent in Paseo when the host offers
 * navigation, and a project's Lead can be replaced from its Seats header.
 */
import { useToast } from '@getpaseo/plugin/client/react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { idempotencyKey, unwrap, useClock, useRuntimeRpcs } from './data.js';
import { ModalShell } from './forms.js';
import { ATTENTION_SETTINGS_SCREEN, SEATS_SETTINGS_SCREEN, openSettings } from './host.js';
import { Button, Callout, Card, Empty, Glyph, IconButton, Meter, MutedText, Pill, Row, SPACE, SectionLabel, StatusMark, TextLink, Title, ago, type Theme } from './kit.js';
import {
  KIND_LABEL, LEVEL_STYLE, ROLE_ICON, STATE_LABEL, STATUS_LABEL, STATUS_TONE, checkoutLine, contextTone, hasLead, hasWork, lastActivity, launchLabel, projectStatus, projectSummary,
  providerLabel, seatName, sentence, shortList, sortIncidents, sortProjects, stateTone, successionHeadline, titleNamesRole, waitsOnHuman, watchedProjects, watchingLabel,
  type IncidentView, type ProjectView, type RoomView, type SeatView,
} from './model.js';
import { RuntimeRecord } from './record.js';

export interface RoomActions {
  readonly openProject: (key: string) => void;
  readonly openAssignment: (projectKey: string, projectId: string, assignmentId: string) => void;
  readonly newSupervisor: () => void;
  readonly newProject: () => void;
  readonly startLead: (projectKey: string) => void;
  /** Opens Replace Lead on a project: for `leadAgentId`, or to resume its replacement in progress. */
  readonly replaceLead: (projectKey: string, leadAgentId?: string) => void;
  readonly assign: (projectKey: string) => void;
  readonly openAgent?: (agentId: string) => void;
  readonly reload: () => void;
}

const ROLE_WORD: Readonly<Record<string, string>> = { lead: 'Lead', peer: 'Peer', supervisor: 'Supervisor' };

/** A seat's meta line: its last turn and its last compaction, whichever are known. */
function seatMeta(seat: SeatView): string | undefined {
  const { lastTurn, compaction } = seat;
  const parts = [
    lastTurn === undefined ? undefined : `Last turn ${lastTurn.outcome} ${ago(lastTurn.endedAt)}`,
    compaction === undefined ? undefined : `compacted ${ago(compaction.lastAt)}${compaction.lastTrigger === undefined ? '' : ` (${compaction.lastTrigger})`}`,
  ].filter(part => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** A seat's detail line: the worktree or main checkout it works in, and the branch there. */
function seatWhere(seat: SeatView): string | undefined {
  const line = checkoutLine(seat);
  return line === undefined ? undefined : sentence(line);
}

/** A seat's context as a bar with a tick at its role's mark; nothing while Paseo reports no figure. */
function ContextMeter(props: { readonly theme: Theme; readonly seat: SeatView }) {
  const { context } = props.seat;
  if (context === undefined) return null;
  return <Meter theme={props.theme} percent={context.percent} mark={context.rotateAtPercent ?? context.compactAtPercent} tone={contextTone(context)} />;
}

/** A context figure past its role's rotation or compact mark, as a pill; nothing below them. */
function ContextPill(props: { readonly theme: Theme; readonly seat: SeatView }) {
  const { context } = props.seat;
  const tone = context === undefined ? 'neutral' : contextTone(context);
  if (context === undefined || tone === 'neutral') return null;
  return <Pill theme={props.theme} tone={tone} icon="Gauge">{`context ${String(context.percent)}%`}</Pill>;
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

/** Dismisses a failed Lead replacement from its project's screen. */
function useDismissReplacement(reload: () => void) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  return (successionId: string): void => {
    rpc.successionCancel({ successionId, idempotencyKey: idempotencyKey() }).then(answer => {
      const error = unwrap(answer).error;
      if (error !== undefined) { toast.error(error.message); return; }
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
          {incident.kind === 'context-high' && subject !== undefined && props.project !== undefined
            ? <IconButton theme={theme} icon="RefreshCcw" label="Replace Lead…" onPress={() => { if (props.project !== undefined) props.actions.replaceLead(props.project.key, subject); }} /> : null}
          <IconButton theme={theme} icon="ThumbsUp" label="Useful" active={incident.feedback === 'useful'} tone="success" onPress={() => { props.rate(incident, 'useful'); }} />
          <IconButton theme={theme} icon="ThumbsDown" label="Noise" active={incident.feedback === 'noise'} tone="warning" onPress={() => { props.rate(incident, 'noise'); }} />
        </View>
      )} />
  );
}

/**
 * A project in two lines: its name, then what it is doing. Pills say only what is worth a glance —
 * incidents, a replacement, a Lead past its mark, a missing Supervisor while work is in flight, and
 * whose it is when the room has more than one Supervisor.
 */
function ProjectRow(props: { readonly theme: Theme; readonly room: RoomView; readonly project: ProjectView; readonly first: boolean; readonly onPress: () => void }) {
  const { theme, room, project } = props;
  const last = lastActivity(project);
  const lead = project.seats.find(seat => seat.role === 'lead');
  const namesake = room.projects.some(entry => entry.key !== project.key && entry.name === project.name);
  return (
    <Row theme={theme} first={props.first} onPress={props.onPress} accessibilityLabel={`Open ${project.name}`}
      leading={<StatusMark theme={theme} status={projectStatus(project)} />}
      title={project.name}
      subtitle={projectSummary(project)}
      {...(namesake ? { meta: project.displayRoot } : {})}
      trailing={(
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          {project.incidents.length > 0 ? <Pill theme={theme} tone="warning" icon="TriangleAlert">{String(project.incidents.length)}</Pill> : null}
          {project.succession === undefined ? null : <Pill theme={theme} tone={waitsOnHuman(project.succession) ? 'warning' : 'accent'} icon="RefreshCcw">replacing Lead</Pill>}
          {lead === undefined ? null : <ContextPill theme={theme} seat={lead} />}
          {project.supervisor === undefined
            ? (project.seats.length > 0 && hasWork(project) ? <Pill theme={theme} tone="warning" icon="EyeOff">No Supervisor</Pill> : null)
            : room.supervisors.length > 1 ? <Pill theme={theme} tone="muted" icon="Eye">{seatName(project.supervisor)}</Pill> : null}
          {last === undefined ? null : <MutedText theme={theme}>{ago(last)}</MutedText>}
          <Glyph theme={theme} name="ChevronRight" size={16} />
        </View>
      )} />
  );
}

const ABOUT: readonly (readonly [string, string])[] = [
  ['ShieldAlert', 'The runtime is trusted, unsandboxed plugin code. It cannot stop a process running as your user.'],
  ['Eye', 'Attention letters to a Supervisor are evidence, not instructions. A letter waits for the Supervisor to be idle and is never sent while it holds a permission.'],
  ['Moon', 'An asleep seat\'s session is closed. Opening it, or a message to it, resumes it.'],
  ['Lock', 'Records stay under your room home. Nothing about your projects leaves this machine.'],
  ['GitBranch', 'Isolated writers work in worktrees Paseo creates. Write scopes prevent collisions between them; they do not contain a Peer.'],
];

function About(props: { readonly theme: Theme }) {
  const [open, setOpen] = useState(false);
  const { colors } = props.theme;
  return (
    <View style={{ marginTop: SPACE.xl }}>
      <TextLink theme={props.theme} icon="Info" label="How the room runtime works" onPress={() => { setOpen(true); }} />
      <ModalShell theme={props.theme} title="How the room runtime works" icon="Info" open={open} onClose={() => { setOpen(false); }}>
        <View style={{ gap: SPACE.md }}>
          {ABOUT.map(([icon, text]) => (
            <View key={icon} style={{ flexDirection: 'row', gap: SPACE.md }}>
              <Glyph theme={props.theme} name={icon} size={15} />
              <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{text}</Text>
            </View>
          ))}
        </View>
      </ModalShell>
    </View>
  );
}

export function RoomScreen(props: { readonly theme: Theme; readonly room: RoomView; readonly actions: RoomActions }) {
  const { theme, room, actions } = props;
  const rate = useFeedback(actions.reload);
  const [showInactive, setShowInactive] = useState(false);
  useClock();
  const status = new Map(room.projects.map(project => [project.key, projectStatus(project)]));
  const projects = sortProjects(room.projects);
  const live = projects.filter(project => status.get(project.key) !== 'inactive');
  const inactive = projects.filter(project => status.get(project.key) === 'inactive');
  const incidents = sortIncidents([...room.projects.flatMap(project => project.incidents), ...room.panelIncidents]);
  const working = live.filter(project => status.get(project.key) === 'working').length;
  const attentionSettings = openSettings(ATTENTION_SETTINGS_SCREEN);
  const seatsSettings = openSettings(SEATS_SETTINGS_SCREEN);
  const summary = room.projects.length === 0
    ? 'Nothing observed yet'
    : `${String(live.length)} project${live.length === 1 ? '' : 's'} · ${String(working)} working · ${incidents.length === 0 ? 'all quiet' : `${String(incidents.length)} need${incidents.length === 1 ? 's' : ''} a look`}`;
  const empty = room.projects.length === 0 && room.supervisors.length === 0;
  return (
    <View>
      <Title theme={theme} subtitle={summary}
        trailing={(
          <>
            {attentionSettings === undefined ? null : <IconButton theme={theme} icon="Bell" label="Room attention settings" onPress={attentionSettings} />}
            {seatsSettings === undefined ? null : <IconButton theme={theme} icon="Users" label="Room seats settings" onPress={seatsSettings} />}
            {empty ? null : <Button theme={theme} small label="Add repository" icon="Plus" onPress={actions.newProject} />}
          </>
        )}>Room</Title>

      {empty ? (
        <Card theme={theme}>
          <Empty theme={theme} icon="Sparkles" title="Set up your room"
            action={(
              <>
                <Button theme={theme} label="1  New Supervisor" icon="Eye" onPress={actions.newSupervisor} />
                <Button theme={theme} label="2  Add repository" icon="FolderPlus" variant="primary" onPress={actions.newProject} />
              </>
            )}>
            Start a Supervisor in a folder outside your repositories, then start a Lead for each repository under it. The Supervisor is told when work stalls, so you don't have to ask.
          </Empty>
        </Card>
      ) : (
        <View>
          {incidents.length === 0 ? null : (
            <View>
              <SectionLabel theme={theme}>Needs attention</SectionLabel>
              <Card theme={theme} tone={incidents.some(incident => incident.level === 'page') ? 'danger' : 'neutral'}>
                {incidents.map((incident, index) => {
                  const project = room.projects.find(entry => entry.key === incident.projectKey);
                  return <IncidentRow key={incident.id} theme={theme} incident={incident} first={index === 0} room={room} actions={actions} rate={rate} {...(project === undefined ? {} : { project })} />;
                })}
              </Card>
            </View>
          )}

          <SectionLabel theme={theme}>Projects</SectionLabel>
          <Card theme={theme}>
            {projects.length === 0
              ? <Empty theme={theme} icon="FolderGit2" title="No projects yet" action={<Button theme={theme} small label="Add repository" icon="Plus" onPress={actions.newProject} />}>Start a Lead in a repository and it appears here.</Empty>
              : live.map((project, index) => <ProjectRow key={project.key} theme={theme} room={room} project={project} first={index === 0} onPress={() => { actions.openProject(project.key); }} />)}
            {inactive.length === 0 ? null : (
              <Row theme={theme} first={live.length === 0} onPress={() => { setShowInactive(!showInactive); }} accessibilityLabel="Toggle inactive projects"
                leading={<Glyph theme={theme} name={showInactive ? 'ChevronDown' : 'ChevronRight'} size={15} />}
                title={`${String(inactive.length)} inactive project${inactive.length === 1 ? '' : 's'}`}
                subtitle="No live seats; their runtime records are kept" />
            )}
            {showInactive ? inactive.map(project => <ProjectRow key={project.key} theme={theme} room={room} project={project} first={false} onPress={() => { actions.openProject(project.key); }} />) : null}
          </Card>

          <SectionLabel theme={theme} trailing={<Button theme={theme} small variant="ghost" label="New Supervisor" icon="Plus" onPress={actions.newSupervisor} />}>Supervisors</SectionLabel>
          <Card theme={theme}>
            {room.supervisors.length === 0
              ? <Empty theme={theme} icon="Eye" title="No Supervisor">A Supervisor watches your projects and is told when they stall. One can watch several repositories.</Empty>
              : room.supervisors.map((supervisor, index) => {
                const watched = watchedProjects(room, supervisor.agentId);
                const { compaction } = supervisor;
                return (
                  <Row key={supervisor.agentId} theme={theme} first={index === 0}
                    {...(actions.openAgent === undefined ? {} : { onPress: () => { actions.openAgent?.(supervisor.agentId); } })}
                    accessibilityLabel={`Open ${seatName(supervisor)}`}
                    leading={<Glyph theme={theme} name="Eye" boxed tone={supervisor.state === 'running' ? 'success' : 'muted'} />}
                    title={seatName(supervisor)}
                    subtitle={watched.length === 0 ? sentence(watchingLabel(supervisor.portfolio)) : `Watches ${shortList(watched)}`}
                    meta={[supervisor.displayCwd, compaction === undefined ? undefined : `compacted ${ago(compaction.lastAt)}`].filter(part => part !== undefined).join(' · ')}
                    trailing={(
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                        <ContextMeter theme={theme} seat={supervisor} />
                        <Pill theme={theme} tone={stateTone(supervisor.state)}>{STATE_LABEL[supervisor.state] ?? supervisor.state}</Pill>
                        {actions.openAgent === undefined ? null : <Glyph theme={theme} name="ExternalLink" size={14} />}
                      </View>
                    )} />
                );
              })}
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
      {rows.map(({ seat, depth }, index) => {
        const runs = launchLabel(seat);
        const subtitle = [
          titleNamesRole(seat) ? undefined : ROLE_WORD[seat.role] ?? seat.role, providerLabel(seat.provider), runs === '' ? undefined : runs,
          seat.pendingPermissions > 0 ? `${String(seat.pendingPermissions)} permission${seat.pendingPermissions === 1 ? '' : 's'} waiting` : undefined,
        ].filter(part => part !== undefined).join(' · ');
        return (
          <Row key={seat.agentId} theme={theme} first={index === 0} indent={depth}
            {...(props.openAgent === undefined ? {} : { onPress: () => { props.openAgent?.(seat.agentId); } })}
            accessibilityLabel={`Open ${seatName(seat)}`}
            leading={<Glyph theme={theme} name={ROLE_ICON[seat.role] ?? 'Bot'} boxed tone={seat.role === 'lead' ? 'accent' : 'muted'} />}
            title={seatName(seat)}
            subtitle={subtitle}
            detail={seatWhere(seat)}
            meta={seatMeta(seat)}
            trailing={(
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <ContextMeter theme={theme} seat={seat} />
                <Pill theme={theme} tone={stateTone(seat.state)}>{STATE_LABEL[seat.state] ?? seat.state}</Pill>
                {props.openAgent === undefined ? null : <Glyph theme={theme} name="ExternalLink" size={14} />}
              </View>
            )} />
        );
      })}
    </>
  );
}

/** Who watches the project, in one line under its name, with Open and Change. */
function SupervisorLine(props: { readonly theme: Theme; readonly project: ProjectView; readonly actions: RoomActions }) {
  const { theme, project, actions } = props;
  const { supervisor } = project;
  if (supervisor === undefined) {
    return (
      <Callout theme={theme} tone={hasWork(project) ? 'warning' : 'muted'} icon="EyeOff" title="No Supervisor watches this project"
        action={<Button theme={theme} small label="Assign a Supervisor" icon="Eye" onPress={() => { actions.assign(project.key); }} />}>
        Nobody is told when it stalls; its signals only appear here.
      </Callout>
    );
  }
  const decided = project.decidedBy === 'human' ? ' · assigned by you' : project.decidedBy === 'parentage' ? ' · it opened the Lead' : '';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm, marginTop: -SPACE.xs }}>
      <Glyph theme={theme} name="Eye" size={14} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
        Watched by <Text style={{ color: theme.colors.foreground, fontWeight: '500' }}>{seatName(supervisor)}</Text>{decided}
      </Text>
      <View style={{ flexDirection: 'row', gap: 2 }}>
        {actions.openAgent === undefined ? null : <Button theme={theme} small variant="ghost" label="Open" icon="ExternalLink" onPress={() => { actions.openAgent?.(supervisor.agentId); }} />}
        <Button theme={theme} small variant="ghost" label="Change…" onPress={() => { actions.assign(project.key); }} />
      </View>
    </View>
  );
}

export function ProjectScreen(props: { readonly theme: Theme; readonly room: RoomView; readonly project: ProjectView; readonly actions: RoomActions; readonly back?: () => void }) {
  const { theme, room, project, actions } = props;
  const rate = useFeedback(actions.reload);
  const dismiss = useDismissReplacement(actions.reload);
  // Ages on this screen and in its runtime record, which redraw only when their data changes.
  useClock();
  const status = projectStatus(project);
  const { succession } = project;
  const lead = project.seats.find(seat => seat.role === 'lead');
  // A replacement that archived the Lead is finished, not replaced by a second Lead.
  const startLead = succession?.canFinish === true
    ? <Button theme={theme} small label="Finish replacing Lead" icon="RefreshCcw" variant="primary" onPress={() => { actions.replaceLead(project.key); }} />
    : <Button theme={theme} small label="Start Lead" icon="Play" variant="primary" onPress={() => { actions.startLead(project.key); }} />;
  return (
    <View>
      {props.back === undefined ? null : <View style={{ alignSelf: 'flex-start', marginBottom: SPACE.md }}><Button theme={theme} small variant="ghost" label="Room" icon="ArrowLeft" onPress={props.back} /></View>}
      <Title theme={theme} leading={<Glyph theme={theme} name="FolderGit2" boxed tone={STATUS_TONE[status]} />} subtitle={`${project.displayRoot}${project.git ? '' : ' · not Git'}`}
        trailing={<Pill theme={theme} tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>}>{project.name}</Title>
      {project.seats.length === 0 ? null : <SupervisorLine theme={theme} project={project} actions={actions} />}

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

      {/* Beside the rows, not inside them: a row opens its agent when pressed. */}
      <SectionLabel theme={theme} trailing={lead === undefined || succession !== undefined ? undefined
        : <Button theme={theme} small variant="ghost" label="Replace Lead…" icon="RefreshCcw" onPress={() => { actions.replaceLead(project.key, lead.agentId); }} />}>Seats</SectionLabel>
      {succession === undefined ? null : succession.step === 'failed' ? (
        <Callout theme={theme} tone="danger" icon="CircleX" title={successionHeadline(succession)}
          action={(
            <>
              <Button theme={theme} small variant="primary" label="Try again" icon="RefreshCcw" onPress={() => { actions.replaceLead(project.key); }} />
              <Button theme={theme} small variant="ghost" label="Dismiss" onPress={() => { dismiss(succession.id); }} />
            </>
          )}>
          {`${succession.failure?.message ?? 'No usable handoff arrived.'} The Lead was asked to start no new work; tell it to continue, or try again.`}
        </Callout>
      ) : (
        <Callout theme={theme} tone={waitsOnHuman(succession) ? 'warning' : 'accent'} icon="RefreshCcw" title={successionHeadline(succession)}
          action={<Button theme={theme} small variant={waitsOnHuman(succession) ? 'primary' : 'secondary'}
            label={succession.canFinish ? 'Finish replacing Lead' : succession.step === 'received' ? 'Review handoff' : 'Show progress'}
            icon="RefreshCcw" onPress={() => { actions.replaceLead(project.key); }} />}>
          {succession.failure === undefined ? undefined : `It stopped: ${succession.failure.message}`}
        </Callout>
      )}
      {project.seats.length === 0 || hasLead(project) || succession?.canFinish === true ? null : (
        <Callout theme={theme} tone="warning" icon="Compass" title="No Lead runs this project" action={startLead}>
          Its Peers have no Lead to report to. Start one here; it is told which Supervisor watches it.
        </Callout>
      )}
      <Card theme={theme}>
        {project.seats.length === 0
          ? (
            <Empty theme={theme} icon="Archive" title="No live seats" action={startLead}>
              Every agent of this project is archived. Its runtime record is kept below.
            </Empty>
          )
          : <SeatTree theme={theme} seats={project.seats} {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />}
      </Card>

      {project.runtime === undefined ? (
        <View>
          <SectionLabel theme={theme}>Assignments</SectionLabel>
          <Card theme={theme}>
            <Empty theme={theme} icon="ClipboardList" title="No runtime record yet">
              It starts when this project's Lead first uses the runtime's assignment tools. Delegation through Paseo's own tools still shows above, under Seats.
            </Empty>
          </Card>
        </View>
      ) : (
        <RuntimeRecord key={project.runtime.projectId} theme={theme} projectId={project.runtime.projectId} openAssignment={assignmentId => { if (project.runtime !== undefined) actions.openAssignment(project.key, project.runtime.projectId, assignmentId); }} />
      )}
    </View>
  );
}
