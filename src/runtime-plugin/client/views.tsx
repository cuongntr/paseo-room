/**
 * The runtime operations surface (docs/design/runtime-coordination.md §8.1): Overview, Project,
 * Assignment and Trust. React Native primitives only, colours from the host theme, and a
 * compact layout on narrow windows. It is an operator surface, never authority evidence for a seat.
 */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { idempotencyKey, unwrap, usePolled, useRuntimeRpcs, type Unwrapped } from './data.js';
import { RoomView } from './room.js';

type Theme = PluginSurfaceProps['theme'];

interface Claim { readonly value: string; readonly evidence: string }
interface Finding { readonly kind: string; readonly message: string; readonly recoveryAction: string; readonly evidence: string }
interface Health { readonly plugin: { readonly manifest: string; readonly reason?: string }; readonly projects: readonly { readonly projectId: string; readonly canonicalRoot: string; readonly health: string; readonly findings: number }[] }
interface Lease {
  readonly assignmentId: string; readonly state: Claim; readonly epoch: number; readonly scopes: readonly string[]; readonly serialOnly: readonly string[];
  readonly branch: string; readonly worktreePath?: string; readonly reclaimable: boolean; readonly peer: 'archived' | 'gone' | 'live' | 'unknown';
}
interface Worktree {
  readonly assignmentId: string; readonly path?: string; readonly branch: string; readonly create: Claim; readonly close: Claim;
  readonly disposition: 'unresolved' | 'active' | 'retained' | 'leftover' | 'gone';
}
interface Project {
  readonly canonicalRoot: string;
  readonly health: Claim;
  readonly liveFacts: string;
  readonly writer?: { readonly assignmentId: string; readonly state: Claim };
  readonly leases: readonly Lease[];
  readonly worktrees: readonly Worktree[];
  readonly scopeStatement: string;
  readonly assignments: readonly { readonly id: string; readonly kind: string; readonly mode: string; readonly outcome: string; readonly state: Claim }[];
  readonly findings: readonly Finding[];
  readonly problems: readonly { readonly file: string; readonly reason: string }[];
}

function Label(props: { readonly theme: Theme; readonly muted?: boolean; readonly strong?: boolean; readonly children: ReactNode }) {
  return <Text style={{ color: props.muted === true ? props.theme.colors.foregroundMuted : props.theme.colors.foreground, fontWeight: props.strong === true ? '600' : '400', marginBottom: 4 }}>{props.children}</Text>;
}

function Button(props: { readonly theme: Theme; readonly label: string; readonly onPress: () => void; readonly danger?: boolean }) {
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" style={{ borderWidth: 1, borderColor: props.danger === true ? props.theme.colors.statusDanger : props.theme.colors.border, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 10, marginRight: 8, marginBottom: 8 }}>
      <Text style={{ color: props.danger === true ? props.theme.colors.statusDanger : props.theme.colors.foreground }}>{props.label}</Text>
    </Pressable>
  );
}

function Section(props: { readonly theme: Theme; readonly title: string; readonly children: ReactNode }) {
  return (
    <View style={{ borderTopWidth: 1, borderColor: props.theme.colors.border, paddingTop: 10, marginTop: 10 }}>
      <Label theme={props.theme} strong>{props.title}</Label>
      {props.children}
    </View>
  );
}

const tone = (theme: Theme, value: string): string =>
  value === 'healthy' ? theme.colors.statusSuccess : value === 'paused' ? theme.colors.statusDanger : theme.colors.statusWarning;

function Overview(props: { readonly theme: Theme; readonly open: (projectId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<Health>(() => rpc.health({}), 'health');
  const health = polled.value?.data;
  return (
    <View>
      <Label theme={props.theme} strong>Room runtime (preview)</Label>
      {polled.failed !== undefined ? <Label theme={props.theme} muted>Runtime unavailable: {polled.failed}</Label> : null}
      {health === undefined ? <Label theme={props.theme} muted>Loading…</Label> : (
        <View>
          <Label theme={props.theme} muted>Manifest: {health.plugin.manifest}{health.plugin.reason === undefined ? '' : ` — ${health.plugin.reason}`}</Label>
          {health.projects.length === 0 ? <Label theme={props.theme} muted>No runtime projects yet.</Label> : null}
          {health.projects.map(project => (
            <Pressable key={project.projectId} onPress={() => { props.open(project.projectId); }} style={{ paddingVertical: 6 }}>
              <Text style={{ color: props.theme.colors.foreground }}>{project.canonicalRoot}</Text>
              <Text style={{ color: tone(props.theme, project.health) }}>{project.health}{project.findings > 0 ? ` · ${String(project.findings)} finding(s)` : ''}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function ProjectView(props: { readonly theme: Theme; readonly projectId: string; readonly back: () => void; readonly open: (assignmentId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<Project>(() => rpc.project({ projectId: props.projectId }), `project:${props.projectId}`);
  const project = polled.value?.data;
  const [notice, setNotice] = useState<string>();
  const act = (work: Promise<unknown>): void => { work.then(answer => { const error = (answer as { error?: { message: string } }).error; setNotice(error?.message ?? 'Done.'); polled.reload(); }, (error: unknown) => { setNotice(String(error)); }); };
  return (
    <View>
      <Button theme={props.theme} label="← Projects" onPress={props.back} />
      {project === undefined ? <Label theme={props.theme} muted>{polled.value?.error?.message ?? 'Loading…'}</Label> : (
        <View>
          <Label theme={props.theme} strong>{project.canonicalRoot}</Label>
          <Text style={{ color: tone(props.theme, project.health.value) }}>{project.health.value} ({project.health.evidence}) · live facts {project.liveFacts}</Text>
          <Label theme={props.theme} muted>Writer: {project.writer === undefined ? 'none' : `${project.writer.assignmentId} (${project.writer.state.value}, ${project.writer.state.evidence})`}</Label>
          <Worktrees theme={props.theme} projectId={props.projectId} project={project} act={act} />
          <Section theme={props.theme} title="Assignments">
            {project.assignments.map(assignment => (
              <Pressable key={assignment.id} onPress={() => { props.open(assignment.id); }} style={{ paddingVertical: 4 }}>
                <Text style={{ color: props.theme.colors.foreground }}>{assignment.id} · {assignment.kind} · {assignment.state.value}</Text>
                <Text style={{ color: props.theme.colors.foregroundMuted }} numberOfLines={1}>{assignment.outcome}</Text>
              </Pressable>
            ))}
          </Section>
          <Section theme={props.theme} title="Findings">
            {project.findings.length === 0 ? <Label theme={props.theme} muted>None.</Label> : project.findings.map((finding, index) => (
              <View key={`${finding.kind}-${String(index)}`} style={{ marginBottom: 6 }}>
                <Label theme={props.theme}>{finding.kind} ({finding.evidence}): {finding.message}</Label>
                <Label theme={props.theme} muted>{finding.recoveryAction}</Label>
              </View>
            ))}
            {project.problems.map(problem => (
              <Button key={problem.file} theme={props.theme} danger label={`Quarantine ${problem.file} (${problem.reason})`}
                onPress={() => { act(rpc.quarantine({ projectId: props.projectId, file: problem.file, idempotencyKey: idempotencyKey() })); }} />
            ))}
            <Button theme={props.theme} label="Run recovery" onPress={() => { act(rpc.recover({ projectId: props.projectId, idempotencyKey: idempotencyKey() })); }} />
          </Section>
          {notice === undefined ? null : <Label theme={props.theme} muted>{notice}</Label>}
        </View>
      )}
    </View>
  );
}

/**
 * Isolated writers and the worktrees they leave. Human forms of workspace_close and lease_reclaim
 * appear only where the runtime would accept them: a retained worktree, or a lease the projection
 * allows to be reclaimed whose Peer Paseo shows archived (or no longer knows). Each row has its own
 * reason, cleared after use, and discarding work asks for a second press.
 */
function Worktrees(props: { readonly theme: Theme; readonly projectId: string; readonly project: Project; readonly act: (work: Promise<unknown>) => void }) {
  const rpc = useRuntimeRpcs();
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [armed, setArmed] = useState<string>();
  const [hint, setHint] = useState<string>();
  const { theme, project } = props;
  const shown = project.worktrees.filter(worktree => worktree.disposition === 'retained' || worktree.disposition === 'leftover');
  if (project.leases.length === 0 && shown.length === 0) return null;
  const reasonOf = (id: string): string => (reasons[id] ?? '').trim();
  /** Runs `run` with the row's reason; a destructive action (`confirm`) needs a second press. */
  const withReason = (id: string, run: (reason: string) => Promise<unknown>, confirm = false): void => {
    const reason = reasonOf(id);
    if (reason === '') { setHint(`State a reason for ${id} first.`); return; }
    setHint(undefined);
    if (confirm && armed !== id) { setArmed(id); return; }
    setArmed(undefined);
    setReasons({ ...reasons, [id]: '' });
    props.act(run(reason));
  };
  const reasonInput = (id: string, placeholder: string) => (
    <TextInput value={reasons[id] ?? ''} onChangeText={text => { setReasons({ ...reasons, [id]: text }); }} placeholder={placeholder} placeholderTextColor={theme.colors.foregroundMuted}
      style={{ color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 6, marginBottom: 8 }} />
  );
  return (
    <Section theme={theme} title="Isolated writers">
      <Label theme={theme} muted>{project.scopeStatement}</Label>
      {project.leases.map(lease => (
        <View key={lease.assignmentId} style={{ marginBottom: 6 }}>
          <Label theme={theme}>{lease.assignmentId} · lease {lease.state.value} ({lease.state.evidence}) · epoch {String(lease.epoch)} · {lease.branch}</Label>
          <Label theme={theme} muted>Scope: {lease.scopes.length === 0 ? 'whole repository' : lease.scopes.join(', ')}{lease.serialOnly.length === 0 ? '' : ` · serial-only: ${lease.serialOnly.join(', ')}`} · Peer {lease.peer}</Label>
          {lease.reclaimable && (lease.peer === 'archived' || lease.peer === 'gone') ? (
            <View>
              {reasonInput(lease.assignmentId, 'Reason for reclaiming')}
              <Button theme={theme} label="Reclaim into a new Peer" onPress={() => { withReason(lease.assignmentId, reason => rpc.leaseReclaim({ projectId: props.projectId, assignmentId: lease.assignmentId, reason, idempotencyKey: idempotencyKey() })); }} />
            </View>
          ) : null}
        </View>
      ))}
      {shown.map(worktree => (
        <View key={worktree.assignmentId} style={{ marginBottom: 6 }}>
          <Label theme={theme}>{worktree.assignmentId} · worktree {worktree.disposition === 'retained' ? 'retained' : 'closed, directory left — remove it by hand'} ({worktree.close.evidence}) · {worktree.branch}</Label>
          {worktree.path === undefined ? null : <Label theme={theme} muted>{worktree.path}</Label>}
          {worktree.disposition === 'retained' ? (
            <View>
              {reasonInput(worktree.assignmentId, 'Reason (required only to discard work)')}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                <Button theme={theme} label="Close if clean" onPress={() => { setArmed(undefined); props.act(rpc.workspaceClose({ projectId: props.projectId, assignmentId: worktree.assignmentId, idempotencyKey: idempotencyKey() })); }} />
                <Button theme={theme} danger label={armed === worktree.assignmentId ? 'Press again: destroy uncommitted work' : 'Discard work and close'} onPress={() => {
                  withReason(worktree.assignmentId, reason => rpc.workspaceClose({ projectId: props.projectId, assignmentId: worktree.assignmentId, discardUncommitted: true, reason, idempotencyKey: idempotencyKey() }), true);
                }} />
              </View>
            </View>
          ) : null}
        </View>
      ))}
      {hint === undefined ? null : <Label theme={theme} muted>{hint}</Label>}
    </Section>
  );
}

function AssignmentView(props: { readonly theme: Theme; readonly projectId: string; readonly assignmentId: string; readonly back: () => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<Record<string, unknown>>(() => rpc.assignment({ projectId: props.projectId, assignmentId: props.assignmentId }), `assignment:${props.assignmentId}`);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string>();
  const detail = polled.value?.data;
  return (
    <View>
      <Button theme={props.theme} label="← Project" onPress={props.back} />
      <Label theme={props.theme} strong>{props.assignmentId}</Label>
      {detail === undefined ? <Label theme={props.theme} muted>{polled.value?.error?.message ?? 'Loading…'}</Label> : (
        <View>
          <Text selectable style={{ color: props.theme.colors.foreground, fontFamily: 'monospace', fontSize: 12 }}>{JSON.stringify(detail, null, 2)}</Text>
          <Section theme={props.theme} title="Operator recovery">
            <TextInput value={reason} onChangeText={setReason} placeholder="Reason for abandoning" placeholderTextColor={props.theme.colors.foregroundMuted}
              style={{ color: props.theme.colors.foreground, borderWidth: 1, borderColor: props.theme.colors.border, borderRadius: 6, padding: 6, marginBottom: 8 }} />
            <Button theme={props.theme} danger label="Abandon" onPress={() => {
              if (reason.trim() === '') { setNotice('State a reason first.'); return; }
              rpc.abandon({ projectId: props.projectId, assignmentId: props.assignmentId, reason, idempotencyKey: idempotencyKey() }).then(answer => {
                setNotice((answer as { error?: { message: string } }).error?.message ?? 'Abandoned.');
                polled.reload();
              }, (error: unknown) => { setNotice(String(error)); });
            }} />
            {notice === undefined ? null : <Label theme={props.theme} muted>{notice}</Label>}
          </Section>
        </View>
      )}
    </View>
  );
}

function Trust(props: { readonly theme: Theme }) {
  return (
    <Section theme={props.theme} title="Trust and data">
      <Label theme={props.theme} muted>Runtime coordination is room-managed, trusted and unsandboxed plugin code. It is not an operating-system sandbox and cannot stop a process running as your user.</Label>
      <Label theme={props.theme} muted>Runtime records stay under your room home, and export omits gate output unless you ask for it. The attention sensor is off unless you turn it on in Settings › Room attention; when on, it sends masked, bounded excerpts of Lead messages to the endpoint you acknowledged there, and nothing else.</Label>
      <Label theme={props.theme} muted>Attention letters to a Supervisor are evidence, not instructions. They are never sent while it holds a permission, and they never interrupt its turn.</Label>
      <Label theme={props.theme} muted>Isolated writers work in worktrees Paseo creates. Their write scopes prevent collisions between them; they do not contain a Peer. Closing a worktree removes its directory and keeps its branch.</Label>
    </Section>
  );
}

function Runtime(props: { readonly theme: Theme; readonly compact: boolean }) {
  const [route, setRoute] = useState<{ projectId?: string; assignmentId?: string }>({});
  const padding = props.compact ? 12 : 20;
  return (
    <ScrollView style={{ backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding }}>
      {route.projectId === undefined ? (
        <View>
          <RoomView theme={props.theme} />
          <View style={{ borderTopWidth: 1, borderColor: props.theme.colors.border, paddingTop: 10, marginTop: 10 }}>
            <Overview theme={props.theme} open={projectId => { setRoute({ projectId }); }} />
          </View>
        </View>
      )
        : route.assignmentId === undefined
          ? <ProjectView theme={props.theme} projectId={route.projectId} back={() => { setRoute({}); }} open={assignmentId => { setRoute({ ...route, assignmentId }); }} />
          : <AssignmentView theme={props.theme} projectId={route.projectId} assignmentId={route.assignmentId} back={() => { setRoute({ ...(route.projectId === undefined ? {} : { projectId: route.projectId }) }); }} />}
      <Trust theme={props.theme} />
    </ScrollView>
  );
}

export function RuntimeSurface(props: PluginSurfaceProps) {
  return <Runtime theme={props.theme} compact={props.layout.compact} />;
}

export function RuntimeWorkspacePanel(props: PluginWorkspacePanelProps) {
  return <Runtime theme={props.theme} compact={props.layout.compact} />;
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
  if (seat.status === 'unknown') return 'Unknown';
  const who = seat.email ?? seat.method ?? 'Signed in';
  return seat.plan === undefined ? who : `${who} · ${seat.plan}`;
}

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
  return (
    <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 12 : 20 }}>
      <Label theme={theme} strong>Room seats</Label>
      <Label theme={theme} muted>Each seat's account, as its own CLI reports it for that role home. The room never reads a credential file.</Label>
      {failed === undefined ? null : <Label theme={theme} muted>Runtime unavailable: {failed}</Label>}
      {loaded?.error === undefined ? null : <Label theme={theme} muted>{loaded.error.message} {loaded.error.recoveryAction}</Label>}
      {data === undefined ? (busy ? <Label theme={theme} muted>Checking…</Label> : null) : data.seats.map(seat => (
        <View key={seat.providerId} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingVertical: 8, flexDirection: props.layout.compact ? 'column' : 'row' }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: '600', width: props.layout.compact ? undefined : 180 }}>{seat.agent} · {seat.role}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: seat.status === 'signed-in' ? theme.colors.foreground : theme.colors.statusWarning }}>{account(seat)}</Text>
            {seat.organization === undefined ? null : <Text style={{ color: theme.colors.foregroundMuted }}>{seat.organization}</Text>}
            {seat.shared === undefined ? null : <Text style={{ color: theme.colors.statusWarning }}>Linked to another home's login (legacy shared credential); run paseo-room verify for the fix.</Text>}
            {seat.note === undefined ? null : <Text style={{ color: theme.colors.foregroundMuted }}>{seat.note}</Text>}
          </View>
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
        <Button theme={theme} label={busy ? 'Checking…' : 'Refresh'} onPress={() => { if (!busy) setTick(tick + 1); }} />
        {data === undefined ? null : <Label theme={theme} muted>Checked {new Date(data.checkedAt).toLocaleTimeString()}</Label>}
      </View>
    </ScrollView>
  );
}
