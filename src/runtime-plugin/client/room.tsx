/**
 * The Room view (docs/design/runtime-coordination-attention.md §8.4): every observed project with
 * its Supervisor, Lead and Peers, open attention incidents with feedback, and the Human's seat
 * actions — Start Supervisor, Start project, Assign Supervisor. React Native primitives only; an
 * operator surface, never authority evidence for a seat.
 */
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { idempotencyKey, usePolled, useRuntimeRpcs } from './data.js';

type Theme = PluginSurfaceProps['theme'];

interface SeatView {
  readonly agentId: string; readonly role: string; readonly provider: string; readonly title: string | null; readonly state: string;
  readonly cwd: string; readonly parentAgentId: string | null; readonly pendingPermissions: number;
  readonly lastTurn?: { readonly outcome: string; readonly endedAgo: string };
}
interface IncidentView { readonly id: string; readonly kind: string; readonly level: string; readonly text: string; readonly count: number; readonly recipient: string; readonly feedback?: string }
interface ProjectView {
  readonly key: string; readonly name: string; readonly root: string; readonly git: boolean; readonly decidedBy: string;
  readonly supervisor?: SeatView; readonly seats: readonly SeatView[]; readonly incidents: readonly IncidentView[];
}
interface Room {
  readonly started: boolean;
  readonly projects: readonly ProjectView[];
  readonly supervisors: readonly SeatView[];
  readonly panelIncidents: readonly IncidentView[];
  readonly providers: readonly { readonly providerId: string; readonly agent: string; readonly role: string }[];
}
interface Preflight {
  readonly root: string; readonly name: string; readonly git: boolean; readonly hasCommit: boolean; readonly protocol: boolean;
  readonly existingLead?: { readonly agentId: string; readonly title: string | null }; readonly findings: readonly string[];
}

function Label(props: { readonly theme: Theme; readonly muted?: boolean; readonly strong?: boolean; readonly tone?: string; readonly children: ReactNode }) {
  const color = props.tone ?? (props.muted === true ? props.theme.colors.foregroundMuted : props.theme.colors.foreground);
  return <Text style={{ color, fontWeight: props.strong === true ? '600' : '400', marginBottom: 4 }}>{props.children}</Text>;
}

function Chip(props: { readonly theme: Theme; readonly label: string; readonly onPress: () => void; readonly selected?: boolean; readonly danger?: boolean }) {
  const { colors } = props.theme;
  const border = props.selected === true ? colors.foreground : props.danger === true ? colors.statusDanger : colors.border;
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" accessibilityState={{ selected: props.selected === true }}
      style={{ borderWidth: 1, borderColor: border, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 9, marginRight: 6, marginBottom: 6 }}>
      <Text style={{ color: props.danger === true ? colors.statusDanger : colors.foreground, fontWeight: props.selected === true ? '600' : '400' }}>{props.label}</Text>
    </Pressable>
  );
}

function Input(props: { readonly theme: Theme; readonly value: string; readonly onChange: (text: string) => void; readonly placeholder: string; readonly multiline?: boolean }) {
  return (
    <TextInput value={props.value} onChangeText={props.onChange} placeholder={props.placeholder} placeholderTextColor={props.theme.colors.foregroundMuted}
      multiline={props.multiline === true} autoCapitalize="none" autoCorrect={false}
      style={{ color: props.theme.colors.foreground, borderWidth: 1, borderColor: props.theme.colors.border, borderRadius: 6, padding: 6, marginBottom: 8, minHeight: props.multiline === true ? 64 : undefined }} />
  );
}

const Row = (props: { readonly children: ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>{props.children}</View>;

const seatName = (seat: SeatView): string => seat.title ?? seat.agentId.slice(0, 8);

function stateTone(theme: Theme, state: string): string {
  if (state === 'permission') return theme.colors.statusWarning;
  if (state === 'running') return theme.colors.statusSuccess;
  return theme.colors.foregroundMuted;
}

function SeatLine(props: { readonly theme: Theme; readonly seat: SeatView; readonly depth: number }) {
  const { seat } = props;
  const permission = seat.pendingPermissions > 0 ? ` · ${String(seat.pendingPermissions)} permission(s) waiting` : '';
  const last = seat.lastTurn === undefined ? '' : ` · last turn ${seat.lastTurn.outcome} ${seat.lastTurn.endedAgo} ago`;
  return (
    <View style={{ paddingLeft: 12 * props.depth, paddingVertical: 2 }}>
      <Text style={{ color: props.theme.colors.foreground }}>
        {seat.role} · {seatName(seat)} <Text style={{ color: stateTone(props.theme, seat.state) }}>{seat.state}</Text>
        <Text style={{ color: props.theme.colors.foregroundMuted }}>{permission}{last}</Text>
      </Text>
    </View>
  );
}

/** Leads first, each followed by the seats it parents, depth-first. */
function SeatTree(props: { readonly theme: Theme; readonly seats: readonly SeatView[] }) {
  const byParent = new Map<string | null, SeatView[]>();
  const ids = new Set(props.seats.map(seat => seat.agentId));
  for (const seat of props.seats) {
    const parent = seat.parentAgentId !== null && ids.has(seat.parentAgentId) ? seat.parentAgentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), seat]);
  }
  const lines: ReactNode[] = [];
  const walk = (parent: string | null, depth: number): void => {
    const children = [...(byParent.get(parent) ?? [])].sort((a, b) => (a.role === b.role ? 0 : a.role === 'lead' ? -1 : 1));
    for (const seat of children) {
      lines.push(<SeatLine key={seat.agentId} theme={props.theme} seat={seat} depth={depth} />);
      walk(seat.agentId, depth + 1);
    }
  };
  walk(null, 0);
  return <View>{lines.length === 0 ? <Label theme={props.theme} muted>No live seats.</Label> : lines}</View>;
}

function Incidents(props: { readonly theme: Theme; readonly incidents: readonly IncidentView[]; readonly rate: (id: string, verdict: 'useful' | 'noise') => void }) {
  if (props.incidents.length === 0) return null;
  return (
    <View style={{ marginTop: 6 }}>
      {props.incidents.map(incident => (
        <View key={incident.id} style={{ marginBottom: 6 }}>
          <Label theme={props.theme} tone={incident.level === 'page' ? props.theme.colors.statusDanger : props.theme.colors.statusWarning}>
            {incident.kind}{incident.count > 1 ? ` ×${String(incident.count)}` : ''}{incident.recipient === 'panel' ? ' · for you (no Supervisor receives it)' : ''}: {incident.text}
          </Label>
          <Row>
            <Chip theme={props.theme} label="Useful" selected={incident.feedback === 'useful'} onPress={() => { props.rate(incident.id, 'useful'); }} />
            <Chip theme={props.theme} label="Noise" selected={incident.feedback === 'noise'} onPress={() => { props.rate(incident.id, 'noise'); }} />
          </Row>
        </View>
      ))}
    </View>
  );
}

function ProjectCard(props: { readonly theme: Theme; readonly project: ProjectView; readonly supervisors: readonly SeatView[]; readonly act: (work: Promise<unknown>) => void; readonly rate: (id: string, verdict: 'useful' | 'noise') => void }) {
  const rpc = useRuntimeRpcs();
  const [assigning, setAssigning] = useState(false);
  const { project, theme } = props;
  const supervisor = project.supervisor === undefined ? 'none — its signals come to this panel' : `${seatName(project.supervisor)} (${project.decidedBy === 'human' ? 'assigned' : 'parent of its Lead'})`;
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <Label theme={theme} strong>{project.name}</Label>
      <Label theme={theme} muted>{project.root}{project.git ? '' : ' (not Git)'}</Label>
      <Label theme={theme}>Supervisor: {supervisor}</Label>
      <SeatTree theme={theme} seats={project.seats} />
      <Incidents theme={theme} incidents={project.incidents} rate={props.rate} />
      {assigning ? (
        <Row>
          {props.supervisors.map(seat => (
            <Chip key={seat.agentId} theme={theme} label={seatName(seat)} selected={project.supervisor?.agentId === seat.agentId}
              onPress={() => { setAssigning(false); props.act(rpc.assignSupervisor({ projectKey: project.key, supervisorAgentId: seat.agentId, idempotencyKey: idempotencyKey() })); }} />
          ))}
          {project.decidedBy === 'human' ? <Chip theme={theme} label="Clear assignment" onPress={() => { setAssigning(false); props.act(rpc.assignSupervisor({ projectKey: project.key, supervisorAgentId: null, idempotencyKey: idempotencyKey() })); }} /> : null}
          <Chip theme={theme} label="Cancel" onPress={() => { setAssigning(false); }} />
        </Row>
      ) : props.supervisors.length > 0 ? <Row><Chip theme={theme} label="Assign Supervisor…" onPress={() => { setAssigning(true); }} /></Row> : null}
    </View>
  );
}

function StartSupervisor(props: { readonly theme: Theme; readonly providers: readonly string[]; readonly act: (work: Promise<unknown>) => void }) {
  const rpc = useRuntimeRpcs();
  const [provider, setProvider] = useState<string>();
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const chosen = provider ?? props.providers[0];
  return (
    <View>
      <Label theme={props.theme} muted>An existing directory outside every repository; the runtime creates none.</Label>
      <Row>{props.providers.map(id => <Chip key={id} theme={props.theme} label={id} selected={id === chosen} onPress={() => { setProvider(id); }} />)}</Row>
      <Input theme={props.theme} value={cwd} onChange={setCwd} placeholder="/home/you/room-desk" />
      <Input theme={props.theme} value={title} onChange={setTitle} placeholder="Title (optional)" />
      <Chip theme={props.theme} label="Start Supervisor" onPress={() => {
        if (chosen === undefined || cwd.trim() === '') return;
        props.act(rpc.startSupervisor({ provider: chosen, cwd: cwd.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }), idempotencyKey: idempotencyKey() }));
      }} />
    </View>
  );
}

function StartProject(props: { readonly theme: Theme; readonly providers: readonly string[]; readonly supervisors: readonly SeatView[]; readonly act: (work: Promise<unknown>) => void }) {
  const rpc = useRuntimeRpcs();
  const [path, setPath] = useState('');
  const [preflight, setPreflight] = useState<Preflight>();
  const [problem, setProblem] = useState<string>();
  const [provider, setProvider] = useState<string>();
  const [supervisor, setSupervisor] = useState<string>();
  const [directive, setDirective] = useState('');
  const { theme } = props;
  const chosenProvider = provider ?? props.providers[0];
  const chosenSupervisor = supervisor ?? props.supervisors[0]?.agentId;
  const check = (): void => {
    setPreflight(undefined);
    rpc.projectPreflight({ path: path.trim() }).then(answer => {
      const value = answer as { data?: Preflight; error?: { message: string } };
      setProblem(value.error?.message);
      setPreflight(value.data);
    }, (error: unknown) => { setProblem(String(error)); });
  };
  return (
    <View>
      <Input theme={theme} value={path} onChange={text => { setPath(text); setPreflight(undefined); }} placeholder="/home/you/Work/repository" />
      <Chip theme={theme} label="Check" onPress={check} />
      {problem === undefined ? null : <Label theme={theme} tone={theme.colors.statusDanger}>{problem}</Label>}
      {preflight === undefined ? null : (
        <View>
          <Label theme={theme}>{preflight.name}: {preflight.git ? (preflight.hasCommit ? 'Git, has commits' : 'Git, no commit yet') : 'not Git'} · protocol {preflight.protocol ? 'present' : 'absent'}</Label>
          {preflight.findings.map(finding => <Label key={finding} theme={theme} muted>• {finding}</Label>)}
          {preflight.existingLead !== undefined ? (
            <Label theme={theme} tone={theme.colors.statusWarning}>A Lead already owns it: {preflight.existingLead.title ?? preflight.existingLead.agentId}. Assign its Supervisor on its card instead.</Label>
          ) : (
            <View>
              <Label theme={theme} muted>Supervisor</Label>
              <Row>{props.supervisors.map(seat => <Chip key={seat.agentId} theme={theme} label={seatName(seat)} selected={seat.agentId === chosenSupervisor} onPress={() => { setSupervisor(seat.agentId); }} />)}</Row>
              <Label theme={theme} muted>Lead provider</Label>
              <Row>{props.providers.map(id => <Chip key={id} theme={theme} label={id} selected={id === chosenProvider} onPress={() => { setProvider(id); }} />)}</Row>
              <Input theme={theme} value={directive} onChange={setDirective} placeholder="First directive for the Lead (optional, sent verbatim)" multiline />
              <Chip theme={theme} label="Start project" onPress={() => {
                if (chosenProvider === undefined || chosenSupervisor === undefined) return;
                props.act(rpc.startProject({
                  path: preflight.root, supervisorAgentId: chosenSupervisor, provider: chosenProvider,
                  ...(directive.trim() === '' ? {} : { directive }), idempotencyKey: idempotencyKey(),
                }));
                setPreflight(undefined);
                setDirective('');
              }} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export function RoomView(props: { readonly theme: Theme }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<Room>(() => rpc.room({}), 'room');
  const [notice, setNotice] = useState<string>();
  const [form, setForm] = useState<'supervisor' | 'project'>();
  const { theme } = props;
  const room = polled.value?.data;
  const act = (work: Promise<unknown>): void => {
    work.then(answer => {
      const error = (answer as { error?: { message: string; recoveryAction: string } }).error;
      setNotice(error === undefined ? 'Done.' : `${error.message} ${error.recoveryAction}`);
      if (error === undefined) setForm(undefined);
      polled.reload();
    }, (error: unknown) => { setNotice(String(error)); });
  };
  const rate = (id: string, verdict: 'useful' | 'noise'): void => { act(rpc.incidentFeedback({ id, verdict, idempotencyKey: idempotencyKey() })); };
  const providers = (role: string): string[] => (room?.providers ?? []).filter(entry => entry.role === role).map(entry => entry.providerId);
  return (
    <View>
      <Label theme={theme} strong>Room</Label>
      {polled.value?.error === undefined ? null : <Label theme={theme} muted>{polled.value.error.message}</Label>}
      {room === undefined ? <Label theme={theme} muted>{polled.failed ?? 'Loading…'}</Label> : (
        <View>
          <Label theme={theme} muted>Supervisors: {room.supervisors.length === 0 ? 'none' : room.supervisors.map(seatName).join(', ')}</Label>
          {room.projects.length === 0 ? <Label theme={theme} muted>No project has a room Lead yet.</Label> : null}
          {room.projects.map(project => <ProjectCard key={project.key} theme={theme} project={project} supervisors={room.supervisors} act={act} rate={rate} />)}
          <Incidents theme={theme} incidents={room.panelIncidents} rate={rate} />
          <Row>
            <Chip theme={theme} label="Start Supervisor…" selected={form === 'supervisor'} onPress={() => { setForm(form === 'supervisor' ? undefined : 'supervisor'); }} />
            <Chip theme={theme} label="Start project…" selected={form === 'project'} onPress={() => { setForm(form === 'project' ? undefined : 'project'); }} />
          </Row>
          {form === 'supervisor' ? <StartSupervisor theme={theme} providers={providers('supervisor')} act={act} /> : null}
          {form === 'project' ? (room.supervisors.length === 0
            ? <Label theme={theme} muted>Start a Supervisor first: a project Lead is started under one.</Label>
            : <StartProject theme={theme} providers={providers('lead')} supervisors={room.supervisors} act={act} />) : null}
        </View>
      )}
      {notice === undefined ? null : <Label theme={theme} muted>{notice}</Label>}
    </View>
  );
}
