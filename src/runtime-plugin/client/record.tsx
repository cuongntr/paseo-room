/**
 * A project's runtime record (docs/design/runtime-panel-ux.md §4): health, the writer, assignments,
 * isolated writers and findings, with the Human's recovery forms; and one assignment in detail.
 * Destructive actions ask for a reason in a confirmation modal.
 */
import { useToast } from '@getpaseo/plugin/client/react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { idempotencyKey, unwrap, usePolled, useRuntimeRpcs } from './data.js';
import { ConfirmModal } from './forms.js';
import { Button, Callout, Card, Empty, Facts, Glyph, Loading, Pill, Row, SPACE, SectionLabel, type Theme, type Tone } from './kit.js';

interface Claim { readonly value: string; readonly evidence: string }
interface Finding { readonly kind: string; readonly message: string; readonly recoveryAction: string; readonly evidence: string }
interface Lease {
  readonly assignmentId: string; readonly state: Claim; readonly epoch: number; readonly scopes: readonly string[]; readonly serialOnly: readonly string[];
  readonly branch: string; readonly worktreePath?: string; readonly reclaimable: boolean; readonly peer: 'archived' | 'gone' | 'live' | 'unknown';
}
interface Worktree {
  readonly assignmentId: string; readonly path?: string; readonly branch: string; readonly create: Claim; readonly close: Claim;
  readonly disposition: 'unresolved' | 'active' | 'retained' | 'leftover' | 'gone';
}
interface Summary { readonly id: string; readonly kind: string; readonly mode: string; readonly outcome: string; readonly state: Claim }
interface ProjectRecord {
  readonly canonicalRoot: string; readonly health: Claim; readonly liveFacts: string;
  readonly writer?: { readonly assignmentId: string; readonly state: Claim };
  readonly leases: readonly Lease[]; readonly worktrees: readonly Worktree[]; readonly scopeStatement: string;
  readonly assignments: readonly Summary[]; readonly findings: readonly Finding[];
  readonly problems: readonly { readonly file: string; readonly reason: string }[];
}

export function assignmentTone(state: string): Tone {
  if (state === 'accepted') return 'success';
  if (state === 'rejected' || state === 'abandoned' || state === 'uncertain') return 'danger';
  if (state === 'handed-back' || state === 'questioned' || state === 'awaiting-permission' || state === 'blocked') return 'warning';
  if (state === 'active' || state === 'dispatching' || state === 'rework') return 'accent';
  return 'muted';
}

export const healthTone = (health: string): Tone => (health === 'healthy' ? 'success' : health === 'paused' ? 'danger' : 'warning');

const FINDING_LABEL: Readonly<Record<string, string>> = {
  'project-paused': 'Project paused', 'ownership-conflict': 'Two Leads claim this project', 'report-missing': 'A Peer ended without reporting',
  'awaiting-permission': 'A Peer waits for a permission', 'uncertain-effect': 'An action\'s outcome is uncertain', 'notice-failed': 'A notice was not delivered',
  'scope-exceeded': 'Changes outside the write scope', 'worktree-retained': 'Worktree kept with unrecorded work', 'worktree-cleanup': 'Worktree directory left behind',
};
const findingLabel = (kind: string): string => FINDING_LABEL[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replace(/-/g, ' ')}`;
const FINISHED = ['accepted', 'rejected', 'abandoned'];
const SHOWN_FINISHED = 5;

type Pending = { readonly title: string; readonly body: string; readonly actionLabel: string; readonly reasonRequired: boolean; readonly run: (reason: string) => Promise<unknown> };

function useAction(reload: () => void) {
  const toast = useToast();
  return (work: Promise<unknown>, success: string): Promise<boolean> => work.then(answer => {
    const error = unwrap(answer).error;
    if (error !== undefined) { toast.error(`${error.message} ${error.recoveryAction}`); return false; }
    toast.show(success, { variant: 'success' });
    reload();
    return true;
  }, (failure: unknown) => { toast.error(String(failure)); return false; });
}

export function RuntimeRecord(props: { readonly theme: Theme; readonly projectId: string; readonly openAssignment: (assignmentId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<ProjectRecord>(() => rpc.project({ projectId: props.projectId }), `project:${props.projectId}`);
  const act = useAction(polled.reload);
  const [pending, setPending] = useState<Pending>();
  const [allFinished, setAllFinished] = useState(false);
  const { theme } = props;
  const record = polled.value?.data;
  if (record === undefined) return <Card theme={theme}><Loading theme={theme} label={polled.value?.error?.message ?? 'Loading the runtime record…'} /></Card>;
  const shown = record.worktrees.filter(worktree => worktree.disposition === 'retained' || worktree.disposition === 'leftover');
  const open = record.assignments.filter(entry => !FINISHED.includes(entry.state.value)).sort((a, b) => (a.state.value === 'draft' ? 1 : 0) - (b.state.value === 'draft' ? 1 : 0));
  const finished = record.assignments.filter(entry => FINISHED.includes(entry.state.value));
  const listed = [...open, ...(allFinished ? finished : finished.slice(0, SHOWN_FINISHED))];
  return (
    <View>
      <Card theme={theme}>
        <Row theme={theme} first title="Health" subtitle={record.liveFacts === 'fresh' ? 'Live facts are fresh' : 'Paseo not reached yet — live facts may be stale'}
          trailing={<Pill theme={theme} tone={healthTone(record.health.value)}>{record.health.value}</Pill>} />
        <Row theme={theme} title="Writer in the Lead's workspace"
          subtitle={record.writer === undefined ? 'None — the workspace is free for one writer' : `${record.writer.assignmentId} · ${record.writer.state.value}`} />
      </Card>

      {record.findings.length + record.problems.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>Findings</SectionLabel>
          {record.findings.map((finding, index) => (
            <Callout key={`${finding.kind}-${String(index)}`} theme={theme} tone={finding.kind === 'project-paused' ? 'danger' : 'warning'} icon="TriangleAlert" title={findingLabel(finding.kind)}>
              {`${finding.message}\n${finding.recoveryAction}`}
            </Callout>
          ))}
          {record.problems.map(problem => (
            <Callout key={problem.file} theme={theme} tone="danger" icon="FileWarning" title={`Unreadable event ${problem.file}`}
              action={<Button theme={theme} small variant="danger" label="Quarantine" onPress={() => {
                setPending({ title: `Quarantine ${problem.file}`, body: 'The file is moved aside so the project can replay without it. Export the project first if you may need it.', actionLabel: 'Quarantine', reasonRequired: false,
                  run: () => act(rpc.quarantine({ projectId: props.projectId, file: problem.file, idempotencyKey: idempotencyKey() }), `${problem.file} quarantined`) });
              }} />}>{problem.reason}</Callout>
          ))}
          <View style={{ alignSelf: 'flex-start' }}>
            <Button theme={theme} small label="Run recovery" icon="RotateCcw" onPress={() => { void act(rpc.recover({ projectId: props.projectId, idempotencyKey: idempotencyKey() }), 'Recovery ran'); }} />
          </View>
        </View>
      )}

      <SectionLabel theme={theme}>{`Assignments${record.assignments.length === 0 ? '' : ` · ${String(open.length)} open, ${String(finished.length)} finished`}`}</SectionLabel>
      <Card theme={theme}>
        {record.assignments.length === 0
          ? <Empty theme={theme} icon="ClipboardList" title="No runtime assignments">A Lead that delegates with assignment_create and assignment_dispatch records its work here.</Empty>
          : listed.map((assignment, index) => (
            <Row key={assignment.id} theme={theme} first={index === 0} onPress={() => { props.openAssignment(assignment.id); }} accessibilityLabel={`Assignment ${assignment.id}`}
              title={assignment.outcome} meta={`${assignment.kind} · ${assignment.mode} · ${assignment.id}`}
              trailing={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                  <Pill theme={theme} tone={assignmentTone(assignment.state.value)}>{assignment.state.value}</Pill>
                  <Glyph theme={theme} name="ChevronRight" size={15} />
                </View>
              )} />
          ))}
        {finished.length > SHOWN_FINISHED ? (
          <Row theme={theme} onPress={() => { setAllFinished(!allFinished); }} accessibilityLabel="Toggle finished assignments"
            leading={<Glyph theme={theme} name={allFinished ? 'ChevronUp' : 'ChevronDown'} size={15} />}
            title={allFinished ? 'Show fewer' : `Show all ${String(finished.length)} finished`} />
        ) : null}
      </Card>

      {record.leases.length + shown.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>Isolated writers</SectionLabel>
          <Card theme={theme}>
            {record.leases.map((lease, index) => (
              <Row key={lease.assignmentId} theme={theme} first={index === 0} title={`${lease.assignmentId} · ${lease.branch}`}
                subtitle={`Scope ${lease.scopes.length === 0 ? 'whole repository' : lease.scopes.join(', ')}${lease.serialOnly.length === 0 ? '' : ` · serial-only ${lease.serialOnly.join(', ')}`}`}
                meta={`lease ${lease.state.value} · epoch ${String(lease.epoch)} · Peer ${lease.peer}`}
                trailing={lease.reclaimable && (lease.peer === 'archived' || lease.peer === 'gone')
                  ? <Button theme={theme} small label="Reclaim" icon="RefreshCcw" onPress={() => {
                    setPending({ title: `Reclaim ${lease.assignmentId}`, body: 'A new Peer is dispatched into the same worktree at the next lease epoch. The old Peer is proven archived; its late reports will be refused.', actionLabel: 'Reclaim', reasonRequired: true,
                      run: reason => act(rpc.leaseReclaim({ projectId: props.projectId, assignmentId: lease.assignmentId, reason, idempotencyKey: idempotencyKey() }), 'Lease reclaimed') });
                  }} />
                  : undefined} />
            ))}
            {shown.map((worktree, index) => (
              <Row key={worktree.assignmentId} theme={theme} first={record.leases.length === 0 && index === 0} title={`${worktree.assignmentId} · ${worktree.branch}`}
                subtitle={worktree.disposition === 'retained' ? 'Worktree kept: it holds work no handoff recorded' : 'Closed, but its directory was left behind — remove it by hand'}
                {...(worktree.path === undefined ? {} : { meta: worktree.path })}
                trailing={worktree.disposition === 'retained' ? (
                  <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
                    <Button theme={theme} small label="Close if clean" onPress={() => { void act(rpc.workspaceClose({ projectId: props.projectId, assignmentId: worktree.assignmentId, idempotencyKey: idempotencyKey() }), 'Worktree closed'); }} />
                    <Button theme={theme} small variant="danger" label="Discard…" onPress={() => {
                      setPending({ title: 'Discard work and close', body: 'This destroys the worktree\'s uncommitted work and removes its directory. The branch is kept.', actionLabel: 'Discard and close', reasonRequired: true,
                        run: reason => act(rpc.workspaceClose({ projectId: props.projectId, assignmentId: worktree.assignmentId, discardUncommitted: true, reason, idempotencyKey: idempotencyKey() }), 'Worktree discarded and closed') });
                    }} />
                  </View>
                ) : undefined} />
            ))}
          </Card>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: SPACE.sm }}>{record.scopeStatement}</Text>
        </View>
      )}
      <ConfirmModal theme={theme} open={pending !== undefined} title={pending?.title ?? ''} body={pending?.body ?? ''} actionLabel={pending?.actionLabel ?? ''} reasonRequired={pending?.reasonRequired ?? true}
        onClose={() => { setPending(undefined); }} onConfirm={async reason => (pending === undefined ? false : Boolean(await pending.run(reason)))} />
    </View>
  );
}

interface AssignmentDetail {
  readonly id: string; readonly kind: string; readonly mode: string; readonly outcome: string; readonly state: Claim; readonly closure: Claim;
  readonly peerProviderId?: string; readonly candidate?: Claim; readonly peerAgentId?: string; readonly observedModel?: string; readonly reportingGeneration: number;
  readonly brief: { readonly writeScope?: readonly string[]; readonly exclusions?: readonly string[]; readonly acceptanceEvidence?: readonly string[]; readonly baseCommit?: string; readonly gate?: { readonly command: string } };
  readonly peerVerification: readonly { readonly value: { readonly command: string; readonly outcome: string } }[];
  readonly runtimeGates: readonly { readonly value: { readonly gateRunId: string; readonly status: string; readonly exitCode?: number } }[];
  readonly scopeExceeded?: { readonly value: { readonly candidateCommit: string; readonly paths: readonly string[] } };
  readonly lease?: { readonly branch: string; readonly epoch: number };
  readonly history: readonly string[];
}

const list = (items: readonly string[] | undefined, empty: string): string => (items === undefined || items.length === 0 ? empty : items.join(', '));

export function AssignmentDetailView(props: { readonly theme: Theme; readonly projectId: string; readonly assignmentId: string; readonly openAgent?: (agentId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<AssignmentDetail>(() => rpc.assignment({ projectId: props.projectId, assignmentId: props.assignmentId }), `assignment:${props.assignmentId}`);
  const act = useAction(polled.reload);
  const [confirming, setConfirming] = useState(false);
  const { theme } = props;
  const detail = polled.value?.data;
  if (detail === undefined) return <Card theme={theme}><Loading theme={theme} label={polled.value?.error?.message ?? 'Loading the assignment…'} /></Card>;
  const terminal = ['accepted', 'rejected', 'abandoned'].includes(detail.state.value);
  return (
    <View>
      <Card theme={theme}>
        <Facts theme={theme} items={[
          ['Outcome', detail.outcome],
          ['Kind', `${detail.kind} · ${detail.mode}`],
          ['Write scope', list(detail.brief.writeScope, detail.mode === 'read-only' ? 'read-only' : 'whole repository')],
          ['Excluded', list(detail.brief.exclusions, 'nothing named')],
          ['Acceptance', list(detail.brief.acceptanceEvidence, '—')],
          ['Gate', detail.brief.gate?.command ?? 'none'],
          ['Base commit', detail.brief.baseCommit?.slice(0, 12) ?? '—'],
        ]} />
      </Card>
      <SectionLabel theme={theme}>Peer</SectionLabel>
      <Card theme={theme}>
        <Row theme={theme} first title={detail.peerProviderId ?? 'Not dispatched'} subtitle={detail.observedModel === undefined ? `Report generation ${String(detail.reportingGeneration)}` : `Model ${detail.observedModel} · report generation ${String(detail.reportingGeneration)}`}
          trailing={detail.peerAgentId !== undefined && props.openAgent !== undefined
            ? <Button theme={theme} small label="Open Peer" icon="ExternalLink" onPress={() => { if (detail.peerAgentId !== undefined) props.openAgent?.(detail.peerAgentId); }} /> : undefined} />
        {detail.lease === undefined ? null : <Row theme={theme} title={`Worktree ${detail.lease.branch}`} subtitle={`Lease epoch ${String(detail.lease.epoch)}`} />}
      </Card>
      <SectionLabel theme={theme}>Evidence</SectionLabel>
      <Card theme={theme}>
        <Row theme={theme} first title="Candidate" subtitle={detail.candidate === undefined ? 'No handoff yet' : `Commit ${detail.candidate.value.slice(0, 12)}`} />
        {detail.peerVerification.map((entry, index) => (
          <Row key={`v${String(index)}`} theme={theme} title={entry.value.command} subtitle="Peer's own check (reported, not re-run)"
            trailing={<Pill theme={theme} tone={entry.value.outcome === 'pass' ? 'success' : 'danger'}>{entry.value.outcome}</Pill>} />
        ))}
        {detail.runtimeGates.map(gate => (
          <Row key={gate.value.gateRunId} theme={theme} title={`Runtime gate ${gate.value.gateRunId}`} subtitle={gate.value.exitCode === undefined ? gate.value.status : `exit ${String(gate.value.exitCode)}`}
            trailing={<Pill theme={theme} tone={gate.value.status === 'finished' && gate.value.exitCode === 0 ? 'success' : gate.value.status === 'running' ? 'accent' : 'warning'}>{gate.value.status}</Pill>} />
        ))}
      </Card>
      {detail.scopeExceeded === undefined ? null : (
        <View style={{ marginTop: SPACE.md }}>
          <Callout theme={theme} tone="warning" icon="TriangleAlert" title="Changes outside the write scope">{detail.scopeExceeded.value.paths.join(', ')} — accepting it needs an override.</Callout>
        </View>
      )}
      {terminal ? null : (
        <View>
          <SectionLabel theme={theme}>Operator recovery</SectionLabel>
          <Card theme={theme}>
            <Row theme={theme} first title="Abandon this assignment" subtitle="Stops the runtime's record of it. Lead is told; nothing is deleted."
              trailing={<Button theme={theme} small variant="danger" label="Abandon…" onPress={() => { setConfirming(true); }} />} />
          </Card>
        </View>
      )}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: SPACE.md }}>{`${String(detail.history.length)} recorded events · closure ${detail.closure.value}`}</Text>
      <ConfirmModal theme={theme} open={confirming} title={`Abandon ${detail.id}`} body="The assignment ends as abandoned. Its Peer is not archived by this; do that in Paseo if it should stop." actionLabel="Abandon" reasonRequired
        onClose={() => { setConfirming(false); }}
        onConfirm={reason => act(rpc.abandon({ projectId: props.projectId, assignmentId: props.assignmentId, reason, idempotencyKey: idempotencyKey() }), 'Assignment abandoned')} />
    </View>
  );
}
