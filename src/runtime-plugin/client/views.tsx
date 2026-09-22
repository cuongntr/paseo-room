/**
 * The runtime operations surface (docs/design/runtime-coordination.md §8.1): Overview, Project,
 * Assignment and Trust. React Native primitives only, colours from the host theme, and a
 * compact layout on narrow windows. It is an operator surface, never authority evidence for a seat.
 */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { idempotencyKey, usePolled, useRuntimeRpcs } from './data.js';

type Theme = PluginSurfaceProps['theme'];

interface Claim { readonly value: string; readonly evidence: string }
interface Finding { readonly kind: string; readonly message: string; readonly recoveryAction: string; readonly evidence: string }
interface Health { readonly plugin: { readonly manifest: string; readonly reason?: string }; readonly projects: readonly { readonly projectId: string; readonly canonicalRoot: string; readonly health: string; readonly findings: number }[] }
interface Project {
  readonly canonicalRoot: string;
  readonly health: Claim;
  readonly liveFacts: string;
  readonly writer?: { readonly assignmentId: string; readonly state: Claim };
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
      <Label theme={props.theme} muted>Runtime records stay under your room home. No external sensor or telemetry is enabled. Export omits gate output unless you ask for it.</Label>
    </Section>
  );
}

function Runtime(props: { readonly theme: Theme; readonly compact: boolean }) {
  const [route, setRoute] = useState<{ projectId?: string; assignmentId?: string }>({});
  const padding = props.compact ? 12 : 20;
  return (
    <ScrollView style={{ backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding }}>
      {route.projectId === undefined ? <Overview theme={props.theme} open={projectId => { setRoute({ projectId }); }} />
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
