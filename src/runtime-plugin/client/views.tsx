/**
 * The runtime surfaces (docs/design/runtime-panel-ux.md): the Room runtime sidebar surface and the
 * workspace panel share one navigator — Room → Project → Assignment — and the Human's seat forms.
 * The workspace panel opens on its own project. Settings › Room seats uses the host's settings
 * controls: accounts, the thinking Lead may choose, and seat context budgets. React Native
 * primitives only; an operator surface, never authority evidence for a seat.
 */
import { useWorkspace, type PluginSurfaceProps, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SeatContextSection } from './context-settings.js';
import { unwrap, usePolled, useRuntimeRpcs, type Unwrapped } from './data.js';
import { PeerThinkingSection } from './effort-settings.js';
import { AssignSupervisorModal, NewProjectModal, NewSupervisorModal, StartLeadModal } from './forms.js';
import { Button, Callout, Loading, Page, Pill, SPACE, Title, type Theme } from './kit.js';
import { ACTION_START_DEADLINE_MS } from '../shared/limits.js';
import { accountLetters, accountLine, agentLabel, plural, sentence, type AccountView, type RoomView } from './model.js';
import { AssignmentDetailView } from './record.js';
import { ProjectScreen, RoomScreen, type RoomActions } from './room.js';
import { ReplaceLeadModal } from './succession.js';
import { duration, whenLabel } from './time.js';

type Route =
  | { readonly screen: 'room' }
  | { readonly screen: 'project'; readonly key: string }
  | { readonly screen: 'assignment'; readonly key: string; readonly projectId: string; readonly assignmentId: string };

type ModalState =
  | { readonly kind: 'supervisor' } | { readonly kind: 'project' } | { readonly kind: 'start-lead'; readonly key: string } | { readonly kind: 'assign'; readonly key: string }
  | { readonly kind: 'replace-lead'; readonly key: string; readonly leadAgentId?: string } | undefined;

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
    startLead: key => { setModal({ kind: 'start-lead', key }); },
    replaceLead: (key, leadAgentId) => { setModal({ kind: 'replace-lead', key, ...(leadAgentId === undefined ? {} : { leadAgentId }) }); },
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
          <AssignmentDetailView theme={theme} projectId={route.projectId} assignmentId={route.assignmentId} {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />
        </View>
      );
    }
  }

  const stalled = room?.spool === undefined ? null : (
    <Callout theme={theme} tone="danger" icon="TriangleAlert" title="The runtime is not answering its seats">
      {`${plural(room.spool.unanswered, 'bridge call')} unanswered; the oldest has waited ${duration(room.spool.oldestSeconds * 1_000)}. Seats are told the runtime is unavailable, and a Supervisor or Lead call not started within ${duration(ACTION_START_DEADLINE_MS)} is not run later. Reload the runtime plugin if this lasts.`}
    </Callout>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ flexGrow: 1 }}>
      <Page theme={theme} compact={props.compact}>{stalled}{body}</Page>
      {room === undefined ? null : (
        <>
          <NewSupervisorModal theme={theme} room={room} open={modal?.kind === 'supervisor'} onClose={() => { setModal(undefined); }} onDone={polled.reload} />
          <NewProjectModal theme={theme} room={room} open={modal?.kind === 'project'} onClose={() => { setModal(undefined); }} onDone={polled.reload}
            onNewSupervisor={() => { setModal({ kind: 'supervisor' }); }}
            onAssign={root => { const project = room.projects.find(entry => entry.root === root); setModal(project === undefined ? undefined : { kind: 'assign', key: project.key }); }}
            {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />
          <StartLeadModal theme={theme} room={room} projectKey={modal?.kind === 'start-lead' ? modal.key : undefined} open={modal?.kind === 'start-lead'}
            onClose={() => { setModal(undefined); }} onDone={polled.reload} onNewSupervisor={() => { setModal({ kind: 'supervisor' }); }} />
          <AssignSupervisorModal theme={theme} room={room} projectKey={modal?.kind === 'assign' ? modal.key : undefined} open={modal?.kind === 'assign'}
            onClose={() => { setModal(undefined); }} onDone={polled.reload} onNewSupervisor={() => { setModal({ kind: 'supervisor' }); }} />
          <ReplaceLeadModal theme={theme} room={room} projectKey={modal?.kind === 'replace-lead' ? modal.key : undefined} leadAgentId={modal?.kind === 'replace-lead' ? modal.leadAgentId : undefined}
            open={modal?.kind === 'replace-lead'} onClose={() => { setModal(undefined); }} onDone={polled.reload}
            {...(actions.openAgent === undefined ? {} : { openAgent: actions.openAgent })} />
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

interface SeatAccount extends AccountView {
  readonly agent: string;
  readonly status: 'signed-in' | 'signed-out' | 'present' | 'unknown';
  readonly shared?: true;
}

const SEAT_TONE = { 'signed-in': 'success', 'signed-out': 'danger', present: 'muted', unknown: 'warning' } as const;
const SEAT_WORD = { 'signed-in': 'signed in', 'signed-out': 'signed out', present: 'file present', unknown: 'unknown' } as const;
const ROLE_ORDER = ['supervisor', 'lead', 'peer'];

/** `A: Supervisor, Lead · B: Peer` — which seats share which account, when they do not all share one. */
function accountSplit(seats: readonly SeatAccount[], letters: ReadonlyMap<string, string>): string {
  const groups = new Map<string, string[]>();
  for (const seat of seats) {
    const letter = letters.get(seat.providerId);
    if (letter !== undefined) groups.set(letter, [...(groups.get(letter) ?? []), `${agentLabel(seat.agent)} ${sentence(seat.role)}`]);
  }
  return [...groups].map(([letter, names]) => `${letter}: ${names.join(', ')}`).join(' · ');
}

/**
 * Settings › Room seats: which account each room seat is signed in to, the thinking Lead may choose
 * for a Peer, and the context marks. Accounts load on open and on Refresh only, never polled,
 * because each load runs every seat's vendor status command.
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
  const seats = [...(data?.seats ?? [])].sort((a, b) => a.agent.localeCompare(b.agent) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const letters = accountLetters(seats);
  const refresh = busy ? 'Checking…' : data === undefined ? 'Check' : `Checked ${whenLabel(data.checkedAt)}`;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Page theme={theme} compact={props.layout.compact}>
        <Title theme={theme} subtitle="Who each seat signs in as, which thinking Lead may choose for a Peer, and when seats report or compact their context.">Room seats</Title>
        {failed === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title="The runtime is unavailable">{failed}</Callout>}
        {loaded?.error === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title={loaded.error.message}>{loaded.error.recoveryAction}</Callout>}
        <SettingsSection title="Accounts" info="What each seat's own CLI reports for its role home. The room never reads a credential file."
          trailing={<Button theme={theme} small variant="ghost" label={refresh} icon="RotateCcw" busy={busy} onPress={() => { setTick(tick + 1); }} />}>
          {data === undefined
            ? <SettingsRow label={busy ? 'Checking every seat…' : 'No answer yet'} />
            : seats.map(seat => {
              const letter = letters.get(seat.providerId);
              const line = `${accountLine(seat)}${letter === undefined ? '' : ` · account ${letter}`}`;
              return (
                <SettingsRow key={seat.providerId} label={`${sentence(seat.role)} · ${agentLabel(seat.agent)}`}
                  hint={seat.shared === undefined ? line : `${line} — linked to another home's login; run paseo-room verify`}>
                  <Pill theme={theme} tone={SEAT_TONE[seat.status]}>{SEAT_WORD[seat.status]}</Pill>
                </SettingsRow>
              );
            })}
          {letters.size === 0 ? null : <SettingsRow label={`${String(new Set(letters.values()).size)} accounts`} hint={accountSplit(seats, letters)} />}
          {data === undefined || data.seats.length > 0 ? null : <SettingsRow label="No seats" hint="The room manifest lists no seats." />}
        </SettingsSection>
        <PeerThinkingSection theme={theme} />
        <SeatContextSection theme={theme} />
      </Page>
    </ScrollView>
  );
}
