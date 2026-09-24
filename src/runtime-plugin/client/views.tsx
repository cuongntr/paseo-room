/**
 * The runtime surfaces (docs/design/runtime-panel-ux.md): the Room runtime sidebar surface and the
 * workspace panel share one navigator — Room → Project → Assignment — and the Human's seat forms.
 * The workspace panel opens on its own project. Settings › Room seats uses the host's settings
 * controls. React Native primitives only; an operator surface, never authority evidence for a seat.
 */
import { useWorkspace, type PluginSurfaceProps, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { SettingsAction, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { unwrap, usePolled, useRuntimeRpcs, type Unwrapped } from './data.js';
import { AssignSupervisorModal, NewProjectModal, NewSupervisorModal } from './forms.js';
import { Button, Callout, Card, Loading, Page, Pill, SPACE, Title, type Theme } from './kit.js';
import { agentLabel, type RoomView } from './model.js';
import { AssignmentDetailView } from './record.js';
import { ProjectScreen, RoomScreen, type RoomActions } from './room.js';

type Route =
  | { readonly screen: 'room' }
  | { readonly screen: 'project'; readonly key: string }
  | { readonly screen: 'assignment'; readonly key: string; readonly projectId: string; readonly assignmentId: string };

type ModalState = { readonly kind: 'supervisor' } | { readonly kind: 'project' } | { readonly kind: 'assign'; readonly key: string } | undefined;

type Navigation = PluginSurfaceProps['navigation'];

function Runtime(props: { readonly theme: Theme; readonly compact: boolean; readonly navigation: Navigation; readonly focusRoot?: string | null }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<RoomView>(() => rpc.room({}), 'room');
  const [route, setRoute] = useState<Route>({ screen: 'room' });
  const [modal, setModal] = useState<ModalState>();
  const [focused, setFocused] = useState(false);
  const { theme } = props;
  const room = polled.value?.data;

  // The workspace panel opens on the project of its workspace, once, when there is one.
  useEffect(() => {
    if (focused || room === undefined || props.focusRoot === undefined || props.focusRoot === null) return;
    const root = props.focusRoot.replace(/\/+$/, '');
    const project = room.projects.find(entry => entry.root === root);
    if (project !== undefined) setRoute({ screen: 'project', key: project.key });
    setFocused(true);
  }, [room, props.focusRoot, focused]);

  const openAgent = props.navigation?.openAgent;
  const actions: RoomActions = {
    openProject: key => { setRoute({ screen: 'project', key }); },
    openAssignment: (key, projectId, assignmentId) => { setRoute({ screen: 'assignment', key, projectId, assignmentId }); },
    newSupervisor: () => { setModal({ kind: 'supervisor' }); },
    newProject: () => { setModal({ kind: 'project' }); },
    assign: key => { setModal({ kind: 'assign', key }); },
    reload: polled.reload,
    ...(openAgent === undefined ? {} : { openAgent: (agentId: string) => { openAgent({ agentId }); } }),
  };

  let body;
  if (room === undefined) {
    const error = polled.value?.error;
    body = error === undefined && polled.failed === undefined
      ? <Loading theme={theme} label="Loading the room…" />
      : (
        <Callout theme={theme} tone="danger" icon="CircleX" title="The room runtime is unavailable" action={<Button theme={theme} small label="Retry" icon="RotateCcw" onPress={polled.reload} />}>
          {error === undefined ? polled.failed : `${error.message} ${error.recoveryAction}`}
        </Callout>
      );
  } else if (route.screen === 'room') {
    body = <RoomScreen theme={theme} room={room} actions={actions} />;
  } else {
    const project = room.projects.find(entry => entry.key === route.key);
    if (project === undefined) {
      body = (
        <Callout theme={theme} tone="muted" icon="FolderX" title="This project is no longer observed" action={<Button theme={theme} small label="Back to the room" icon="ArrowLeft" onPress={() => { setRoute({ screen: 'room' }); }} />}>
          Its last live seat was archived.
        </Callout>
      );
    } else if (route.screen === 'project') {
      body = <ProjectScreen theme={theme} room={room} project={project} actions={actions} back={() => { setRoute({ screen: 'room' }); }} />;
    } else {
      body = (
        <View>
          <View style={{ alignSelf: 'flex-start', marginBottom: SPACE.md }}>
            <Button theme={theme} small variant="ghost" label={project.name} icon="ArrowLeft" onPress={() => { setRoute({ screen: 'project', key: project.key }); }} />
          </View>
          <Title theme={theme} subtitle={`Runtime assignment in ${project.name}`}>{route.assignmentId}</Title>
          <AssignmentDetailView theme={theme} projectId={route.projectId} assignmentId={route.assignmentId} {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />
        </View>
      );
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ flexGrow: 1 }}>
      <Page theme={theme} compact={props.compact}>{body}</Page>
      {room === undefined ? null : (
        <>
          <NewSupervisorModal theme={theme} room={room} open={modal?.kind === 'supervisor'} onClose={() => { setModal(undefined); }} onDone={polled.reload} />
          <NewProjectModal theme={theme} room={room} open={modal?.kind === 'project'} onClose={() => { setModal(undefined); }} onDone={polled.reload}
            onNewSupervisor={() => { setModal({ kind: 'supervisor' }); }}
            onAssign={root => { const project = room.projects.find(entry => entry.root === root); setModal(project === undefined ? undefined : { kind: 'assign', key: project.key }); }}
            {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />
          <AssignSupervisorModal theme={theme} room={room} projectKey={modal?.kind === 'assign' ? modal.key : undefined} open={modal?.kind === 'assign'}
            onClose={() => { setModal(undefined); }} onDone={polled.reload} onNewSupervisor={() => { setModal({ kind: 'supervisor' }); }} />
        </>
      )}
    </ScrollView>
  );
}

export function RuntimeSurface(props: PluginSurfaceProps) {
  return <Runtime theme={props.theme} compact={props.layout.compact} navigation={props.navigation} />;
}

export function RuntimeWorkspacePanel(props: PluginWorkspacePanelProps) {
  const root = useWorkspace(props.workspaceId, workspace => workspace.projectRootPath);
  return <Runtime theme={props.theme} compact={props.layout.compact} navigation={props.navigation} focusRoot={root} />;
}

interface SeatAccount {
  readonly providerId: string; readonly agent: string; readonly role: string;
  readonly status: 'signed-in' | 'signed-out' | 'present' | 'unknown';
  readonly method?: string; readonly email?: string; readonly plan?: string; readonly organization?: string;
  readonly shared?: true; readonly note?: string;
}

function account(seat: SeatAccount): string {
  if (seat.status === 'signed-out') return 'Not signed in';
  if (seat.status === 'present') return 'Credential file present';
  if (seat.status === 'unknown') return seat.note ?? 'Unknown';
  const who = seat.email ?? seat.method ?? 'Signed in';
  return [who, seat.plan, seat.organization].filter(part => part !== undefined).join(' · ');
}

const SEAT_TONE = { 'signed-in': 'success', 'signed-out': 'danger', present: 'muted', unknown: 'warning' } as const;
const SEAT_WORD = { 'signed-in': 'signed in', 'signed-out': 'signed out', present: 'file present', unknown: 'unknown' } as const;

/**
 * Settings › Room seats: which account each room seat is signed in to. Loaded on open and on
 * Refresh only, never polled, because each load runs every seat's vendor status command.
 */
export function RoomSeatsSettings(props: PluginSurfaceProps) {
  const rpc = useRuntimeRpcs();
  const [loaded, setLoaded] = useState<Unwrapped<{ readonly checkedAt: string; readonly seats: readonly SeatAccount[] }>>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    rpc.seats({}).then(answer => {
      if (cancelled) return;
      setFailed(undefined);
      setLoaded(unwrap(answer));
      setBusy(false);
    }, (error: unknown) => {
      if (cancelled) return;
      setFailed(error instanceof Error ? error.message : String(error));
      setBusy(false);
    });
    return () => { cancelled = true; };
  }, [tick]);
  const { theme } = props;
  const data = loaded?.data;
  const roles = ['supervisor', 'lead', 'peer'];
  const seats = [...(data?.seats ?? [])].sort((a, b) => a.agent.localeCompare(b.agent) || roles.indexOf(a.role) - roles.indexOf(b.role));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Page theme={theme} compact={props.layout.compact}>
        <Title theme={theme} subtitle="The account each seat's own CLI reports for its role home. The room never reads a credential file.">Room seats</Title>
        {failed === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title="The runtime is unavailable">{failed}</Callout>}
        {loaded?.error === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title={loaded.error.message}>{loaded.error.recoveryAction}</Callout>}
        <SettingsSection title="Seats" trailing={<Button theme={theme} small variant="ghost" label={busy ? 'Checking…' : 'Refresh'} icon="RotateCcw" busy={busy} onPress={() => { setTick(tick + 1); }} />}>
          {data === undefined
            ? <SettingsRow label={busy ? 'Checking every seat…' : 'No answer yet'} />
            : seats.map(seat => (
              <SettingsRow key={seat.providerId} label={`${agentLabel(seat.agent)} · ${seat.role[0]?.toUpperCase() ?? ''}${seat.role.slice(1)}`}
                hint={seat.shared === undefined ? account(seat) : `${account(seat)} — linked to another home's login; run paseo-room verify`}>
                <Pill theme={theme} tone={SEAT_TONE[seat.status]}>{SEAT_WORD[seat.status]}</Pill>
              </SettingsRow>
            ))}
          {data === undefined ? null : <SettingsAction label="Checked" hint={new Date(data.checkedAt).toLocaleString()} actionLabel="Check again" disabled={busy} onPress={() => { setTick(tick + 1); }} />}
        </SettingsSection>
        {data === undefined || data.seats.length > 0 ? null : <Card theme={theme}><Text style={{ color: theme.colors.foregroundMuted, padding: SPACE.lg }}>The room manifest lists no seats.</Text></Card>}
      </Page>
    </ScrollView>
  );
}
