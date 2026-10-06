/**
 * A project's runtime record (docs/design/runtime-panel-ux.md §4–§5): the writer in the Lead's
 * checkout and findings only when there are any, recent activity, assignments by day, and isolated
 * writers, with the Human's recovery forms; and one assignment in detail with its history.
 * Destructive actions ask for a reason in a confirmation modal.
 */
import { useToast } from '@getpaseo/plugin/client/react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { idempotencyKey, unwrap, usePolled, useRuntimeRpcs } from './data.js';
import { ConfirmModal } from './forms.js';
import type { Milestone } from '../shared/panel.js';
import { Button, Callout, Card, Empty, Facts, Glyph, GroupLabel, Loading, MutedText, Pill, Row, SPACE, SectionLabel, Segmented, Title, type Theme, type Tone } from './kit.js';
import {
  ASSIGNMENT_WORDS, assignmentGist, byDay, finishedAssignments, isFinished, openAssignments, providerLabel, sentence, workplace, type AssignmentEntry,
} from './model.js';
import { ago, duration, hourMinute, whenLabel } from './time.js';

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
interface ProjectRecord {
  readonly canonicalRoot: string; readonly health: Claim; readonly liveFacts: string;
  readonly writer?: { readonly assignmentId: string; readonly state: Claim };
  readonly leases: readonly Lease[]; readonly worktrees: readonly Worktree[]; readonly scopeStatement: string;
  readonly assignments: readonly (AssignmentEntry & { readonly state: Claim })[]; readonly findings: readonly Finding[];
  readonly activity?: readonly Milestone[];
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

export const stateWord = (state: string): string => ASSIGNMENT_WORDS[state] ?? state;

export const TONE_ICON: Readonly<Record<string, string>> = { success: 'CircleCheck', danger: 'CircleX', warning: 'TriangleAlert', accent: 'CircleDot', muted: 'Circle', neutral: 'Circle' };
const BY: Readonly<Record<Milestone['by'], string>> = { human: 'you', lead: 'Lead', peer: 'Peer', supervisor: 'Supervisor', runtime: 'runtime' };

const FINDING_LABEL: Readonly<Record<string, string>> = {
  'project-paused': 'Project paused', 'ownership-conflict': 'Two Leads claim this project', 'report-missing': 'A Peer ended without reporting',
  'awaiting-permission': 'A Peer waits for a permission', 'uncertain-effect': 'An action\'s outcome is uncertain', 'notice-failed': 'A notice was not delivered',
  'scope-exceeded': 'Changes outside the write scope', 'worktree-retained': 'Worktree kept with unrecorded work', 'worktree-cleanup': 'Worktree directory left behind',
};
const findingLabel = (kind: string): string => FINDING_LABEL[kind] ?? sentence(kind.replace(/-/g, ' '));
/** Finished assignments listed at first, and added per press. */
const PAGE = 20;
/** Recent milestones shown before *Show more*. */
const RECENT = 6;

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

/** How long a finished assignment took, from creation to decision. */
function took(entry: AssignmentEntry): string | undefined {
  if (entry.createdAt === undefined || entry.settledAt === undefined) return undefined;
  const spent = duration(Date.parse(entry.settledAt) - Date.parse(entry.createdAt));
  return spent === '' ? undefined : `took ${spent}`;
}

function AssignmentRow(props: { readonly theme: Theme; readonly entry: AssignmentEntry; readonly first: boolean; readonly onPress: () => void }) {
  const { theme, entry } = props;
  const finished = isFinished(entry);
  const tone = assignmentTone(entry.state.value);
  const when = finished
    ? [entry.settledAt === undefined ? undefined : hourMinute(entry.settledAt), took(entry)]
    : [entry.updatedAt === undefined ? undefined : `updated ${ago(entry.updatedAt)}`];
  return (
    <Row theme={theme} first={props.first} onPress={props.onPress} accessibilityLabel={`Open assignment ${assignmentGist(entry)}`}
      leading={<Glyph theme={theme} name={TONE_ICON[tone] ?? 'Circle'} tone={finished && entry.state.value === 'accepted' ? 'muted' : tone} size={15} />}
      title={assignmentGist(entry)}
      meta={[entry.kind, workplace(entry), ...when].filter(part => part !== undefined).join(' · ')}
      trailing={(
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          {finished && entry.state.value === 'accepted' ? null : <Pill theme={theme} tone={tone}>{stateWord(entry.state.value)}</Pill>}
          <Glyph theme={theme} name="ChevronRight" size={15} />
        </View>
      )} />
  );
}

export function RuntimeRecord(props: { readonly theme: Theme; readonly projectId: string; readonly openAssignment: (assignmentId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<ProjectRecord>(() => rpc.project({ projectId: props.projectId }), `project:${props.projectId}`);
  const act = useAction(polled.reload);
  const [pending, setPending] = useState<Pending>();
  const [chosenTab, setTab] = useState<'open' | 'finished'>();
  const [shown, setShown] = useState(PAGE);
  const [allActivity, setAllActivity] = useState(false);
  const { theme } = props;
  const record = polled.value?.data;
  if (record === undefined) return <Card theme={theme}><Loading theme={theme} label={polled.value?.error?.message ?? 'Loading the runtime record…'} /></Card>;
  const gist = new Map(record.assignments.map(entry => [entry.id, assignmentGist(entry)]));
  const nameOf = (assignmentId: string): string => gist.get(assignmentId) ?? assignmentId;
  const kept = record.worktrees.filter(worktree => worktree.disposition === 'retained' || worktree.disposition === 'leftover');
  const open = openAssignments(record.assignments);
  const finished = finishedAssignments(record.assignments);
  const tab = chosenTab ?? (open.length > 0 ? 'open' : 'finished');
  const activity = record.activity ?? [];
  const listedActivity = allActivity ? activity : activity.slice(0, RECENT);
  const page = finished.slice(0, shown);
  return (
    <View>
      {record.liveFacts === 'fresh' ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md }}>
          <Glyph theme={theme} name="CloudOff" size={14} />
          <MutedText theme={theme}>Paseo not reached yet — live facts may be stale.</MutedText>
        </View>
      )}

      {record.writer === undefined ? null : (
        <View style={{ marginTop: SPACE.lg }}>
          <Callout theme={theme} tone="accent" icon="PenLine" title={`${nameOf(record.writer.assignmentId)} writes in the Lead's checkout`}
            action={<Button theme={theme} small label="Open assignment" icon="ArrowRight" onPress={() => { if (record.writer !== undefined) props.openAssignment(record.writer.assignmentId); }} />}>
            {`${sentence(stateWord(record.writer.state.value))}. Other writable work waits for it, or runs in its own worktree.`}
          </Callout>
        </View>
      )}

      {record.findings.length + record.problems.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>{`Findings · runtime ${record.health.value}`}</SectionLabel>
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

      {activity.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>Recent activity</SectionLabel>
          <Card theme={theme}>
            {listedActivity.map((entry, index) => (
              <Row key={`${entry.at}-${String(index)}`} theme={theme} first={index === 0}
                {...(entry.assignmentId === undefined ? {} : { onPress: () => { if (entry.assignmentId !== undefined) props.openAssignment(entry.assignmentId); } })}
                leading={<Glyph theme={theme} name={TONE_ICON[entry.tone] ?? 'Circle'} tone={entry.tone} size={15} />}
                title={entry.label}
                {...(entry.assignmentId === undefined ? {} : { subtitle: nameOf(entry.assignmentId) })}
                trailing={<MutedText theme={theme}>{`${whenLabel(entry.at)} · ${BY[entry.by]}`}</MutedText>} />
            ))}
            {activity.length > RECENT ? (
              <Row theme={theme} onPress={() => { setAllActivity(!allActivity); }} accessibilityLabel="Toggle recent activity"
                leading={<Glyph theme={theme} name={allActivity ? 'ChevronUp' : 'ChevronDown'} size={15} />}
                title={allActivity ? 'Show less' : `Show ${String(activity.length - RECENT)} more`} />
            ) : null}
          </Card>
        </View>
      )}

      <SectionLabel theme={theme}
        trailing={record.assignments.length === 0 ? undefined : (
          <Segmented theme={theme} value={tab} onChange={next => { setTab(next); setShown(PAGE); }}
            options={[{ value: 'open', label: `Open ${String(open.length)}` }, { value: 'finished', label: `Finished ${String(finished.length)}` }]} />
        )}>Assignments</SectionLabel>
      <Card theme={theme}>
        {record.assignments.length === 0
          ? <Empty theme={theme} icon="ClipboardList" title="No runtime assignments">A Lead that delegates with assignment_create and assignment_dispatch records its work here.</Empty>
          : tab === 'open'
            ? (open.length === 0
              ? <Empty theme={theme} icon="CircleCheck" title="Nothing open">Every assignment has been decided. Finished work is under Finished.</Empty>
              : open.map((entry, index) => <AssignmentRow key={entry.id} theme={theme} entry={entry} first={index === 0} onPress={() => { props.openAssignment(entry.id); }} />))
            : (finished.length === 0
              ? <Empty theme={theme} icon="ClipboardList" title="Nothing finished yet" />
              : byDay(page, entry => entry.settledAt).map((group, groupIndex) => (
                <View key={group.day}>
                  <GroupLabel theme={theme} first={groupIndex === 0}>{group.day}</GroupLabel>
                  {group.entries.map(entry => <AssignmentRow key={entry.id} theme={theme} entry={entry} first={false} onPress={() => { props.openAssignment(entry.id); }} />)}
                </View>
              )))}
        {tab === 'finished' && finished.length > shown ? (
          <Row theme={theme} onPress={() => { setShown(shown + PAGE); }} accessibilityLabel="Show more finished assignments"
            leading={<Glyph theme={theme} name="ChevronDown" size={15} />}
            title={`Show ${String(Math.min(PAGE, finished.length - shown))} more`} subtitle={`${String(finished.length - shown)} older not shown`} />
        ) : null}
      </Card>

      {record.leases.length + kept.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>Isolated writers</SectionLabel>
          <Card theme={theme}>
            {record.leases.map((lease, index) => (
              <Row key={lease.assignmentId} theme={theme} first={index === 0} title={nameOf(lease.assignmentId)}
                subtitle={`${lease.branch} · scope ${lease.scopes.length === 0 ? 'whole repository' : lease.scopes.join(', ')}${lease.serialOnly.length === 0 ? '' : ` · one at a time: ${lease.serialOnly.join(', ')}`}`}
                meta={`Peer ${lease.peer} · lease ${lease.state.value}${lease.epoch > 1 ? ` · taken over ${String(lease.epoch - 1)}×` : ''}`}
                trailing={lease.reclaimable && (lease.peer === 'archived' || lease.peer === 'gone')
                  ? <Button theme={theme} small label="Reclaim" icon="RefreshCcw" onPress={() => {
                    setPending({ title: `Reclaim ${nameOf(lease.assignmentId)}`, body: 'A new Peer is dispatched into the same worktree at the next lease epoch. The old Peer is proven archived; its late reports will be refused.', actionLabel: 'Reclaim', reasonRequired: true,
                      run: reason => act(rpc.leaseReclaim({ projectId: props.projectId, assignmentId: lease.assignmentId, reason, idempotencyKey: idempotencyKey() }), 'Lease reclaimed') });
                  }} />
                  : undefined} />
            ))}
            {kept.map((worktree, index) => (
              <Row key={worktree.assignmentId} theme={theme} first={record.leases.length === 0 && index === 0} title={nameOf(worktree.assignmentId)}
                subtitle={worktree.disposition === 'retained' ? `${worktree.branch} · kept: it holds work no handoff recorded` : `${worktree.branch} · closed, but its directory was left behind — remove it by hand`}
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

/** Lead's choice and reason, or the default, and whether the Peer reports running something else. */
function thinkingLine(thinking: NonNullable<AssignmentDetail['thinking']>): string {
  const choice = thinking.chosen === undefined ? 'The Peer\'s default' : `Lead chose ${thinking.chosen}${thinking.reason === undefined ? '' : `: ${thinking.reason}`}`;
  return thinking.chosen !== undefined && thinking.observed !== undefined && thinking.observed !== thinking.chosen ? `${choice} · the Peer reports ${thinking.observed}` : choice;
}

interface AssignmentDetail {
  readonly id: string; readonly kind: string; readonly mode: string; readonly outcome: string; readonly state: Claim; readonly closure: Claim;
  readonly peerProviderId?: string; readonly candidate?: Claim; readonly peerAgentId?: string; readonly observedModel?: string; readonly reportingGeneration: number;
  readonly thinking?: { readonly chosen?: string; readonly reason?: string; readonly observed?: string };
  readonly brief: { readonly writeScope?: readonly string[]; readonly exclusions?: readonly string[]; readonly acceptanceEvidence?: readonly string[]; readonly baseCommit?: string; readonly gate?: { readonly command: string } };
  readonly peerVerification: readonly { readonly value: { readonly command: string; readonly outcome: string } }[];
  readonly runtimeGates: readonly { readonly value: { readonly gateRunId: string; readonly status: string; readonly exitCode?: number } }[];
  readonly scopeExceeded?: { readonly value: { readonly candidateCommit: string; readonly paths: readonly string[] } };
  readonly lease?: { readonly branch: string; readonly epoch: number };
  readonly history: readonly string[];
  readonly createdAt?: string; readonly updatedAt?: string; readonly settledAt?: string; readonly isolated?: boolean;
  readonly timeline?: readonly Milestone[];
}

const list = (items: readonly string[] | undefined, empty: string): string => (items === undefined || items.length === 0 ? empty : items.join(', '));

/** A runtime gate run: passed on exit 0, failed on any other end, else running or uncertain. */
function GatePill(props: { readonly theme: Theme; readonly status: string; readonly exitCode?: number }) {
  if (props.status !== 'finished') return <Pill theme={props.theme} tone={props.status === 'running' ? 'accent' : 'warning'}>{props.status}</Pill>;
  return props.exitCode === 0 ? <Pill theme={props.theme} tone="success">passed</Pill> : <Pill theme={props.theme} tone="danger">failed</Pill>;
}

/** Where the Peer's session stands once the assignment is decided. */
const CLOSURE: Readonly<Record<string, string>> = { open: 'session open', closing: 'being archived', closed: 'archived', uncertain: 'archive uncertain' };

export function AssignmentDetailView(props: { readonly theme: Theme; readonly projectId: string; readonly assignmentId: string; readonly openAgent?: (agentId: string) => void }) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<AssignmentDetail>(() => rpc.assignment({ projectId: props.projectId, assignmentId: props.assignmentId }), `assignment:${props.assignmentId}`);
  const act = useAction(polled.reload);
  const [confirming, setConfirming] = useState(false);
  const { theme } = props;
  const detail = polled.value?.data;
  if (detail === undefined) return <Card theme={theme}><Loading theme={theme} label={polled.value?.error?.message ?? 'Loading the assignment…'} /></Card>;
  const terminal = isFinished(detail);
  const spent = took(detail);
  const gateCommand = detail.brief.gate?.command;
  const timeline = detail.timeline ?? [];
  return (
    <View>
      <Title theme={theme} subtitle={`${sentence(detail.kind)} · ${workplace(detail)}`}
        trailing={<Pill theme={theme} tone={assignmentTone(detail.state.value)}>{stateWord(detail.state.value)}</Pill>}>{assignmentGist(detail)}</Title>
      <Card theme={theme}>
        <Facts theme={theme} items={[
          ['Outcome', detail.outcome],
          ['Assignment', detail.id],
          ['Write scope', list(detail.brief.writeScope, detail.mode === 'read-only' ? 'read-only' : 'whole repository')],
          ['Excluded', list(detail.brief.exclusions, 'nothing named')],
          ['Acceptance', list(detail.brief.acceptanceEvidence, '—')],
          ['Gate', gateCommand ?? 'none'],
          ['Base commit', detail.brief.baseCommit?.slice(0, 12) ?? '—'],
          ...(detail.createdAt === undefined ? [] : [['Created', whenLabel(detail.createdAt)] as const]),
          ...(detail.settledAt === undefined ? [] : [[sentence(stateWord(detail.state.value)), `${whenLabel(detail.settledAt)}${spent === undefined ? '' : ` · ${spent}`}`] as const]),
        ]} />
      </Card>
      <SectionLabel theme={theme}>Peer</SectionLabel>
      <Card theme={theme}>
        <Row theme={theme} first title={detail.peerProviderId === undefined ? 'Not dispatched' : `${providerLabel(detail.peerProviderId)} Peer`}
          subtitle={[detail.observedModel, detail.reportingGeneration > 1 ? `turn ${String(detail.reportingGeneration)}` : undefined, detail.peerAgentId === undefined ? undefined : CLOSURE[detail.closure.value] ?? detail.closure.value]
            .filter(part => part !== undefined).join(' · ') || 'No Peer yet'}
          trailing={detail.peerAgentId !== undefined && props.openAgent !== undefined
            ? <Button theme={theme} small label="Open Peer" icon="ExternalLink" onPress={() => { if (detail.peerAgentId !== undefined) props.openAgent?.(detail.peerAgentId); }} /> : undefined} />
        {detail.thinking === undefined ? null : <Row theme={theme} title={`Thinking ${detail.thinking.observed ?? detail.thinking.chosen ?? ''}`} subtitle={thinkingLine(detail.thinking)} />}
        {detail.lease === undefined ? null : (
          <Row theme={theme} title={`Worktree on ${detail.lease.branch}`}
            subtitle={detail.lease.epoch > 1 ? `Taken over by a new Peer ${String(detail.lease.epoch - 1)}×` : 'Its own worktree, separate from the Lead\'s checkout'} />
        )}
      </Card>
      <SectionLabel theme={theme}>Evidence</SectionLabel>
      <Card theme={theme}>
        <Row theme={theme} first title="Candidate" subtitle={detail.candidate === undefined ? 'No handoff yet' : `Commit ${detail.candidate.value.slice(0, 12)}`} />
        {detail.peerVerification.map((entry, index) => (
          <Row key={`v${String(index)}`} theme={theme} title={entry.value.command} subtitle="The Peer's own check — reported, not re-run"
            trailing={<Pill theme={theme} tone={entry.value.outcome === 'pass' ? 'success' : 'danger'}>{entry.value.outcome}</Pill>} />
        ))}
        {detail.runtimeGates.map(gate => (
          <Row key={gate.value.gateRunId} theme={theme} title={gateCommand ?? 'Runtime gate'}
            subtitle={`Run by the runtime${gate.value.exitCode === undefined ? '' : ` · exit ${String(gate.value.exitCode)}`}`}
            trailing={<GatePill theme={theme} status={gate.value.status} {...(gate.value.exitCode === undefined ? {} : { exitCode: gate.value.exitCode })} />} />
        ))}
      </Card>
      {detail.scopeExceeded === undefined ? null : (
        <View style={{ marginTop: SPACE.md }}>
          <Callout theme={theme} tone="warning" icon="TriangleAlert" title="Changes outside the write scope">{detail.scopeExceeded.value.paths.join(', ')} — accepting it needs an override.</Callout>
        </View>
      )}
      {timeline.length === 0 ? null : (
        <View>
          <SectionLabel theme={theme}>History</SectionLabel>
          <Card theme={theme}>
            {timeline.map((entry, index) => (
              <Row key={`${entry.at}-${String(index)}`} theme={theme} first={index === 0}
                leading={<Glyph theme={theme} name={TONE_ICON[entry.tone] ?? 'Circle'} tone={entry.tone} size={15} />}
                title={entry.label}
                trailing={<MutedText theme={theme}>{`${whenLabel(entry.at)} · ${BY[entry.by]}`}</MutedText>} />
            ))}
          </Card>
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
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: SPACE.md }}>{`${String(detail.history.length)} events recorded`}</Text>
      <ConfirmModal theme={theme} open={confirming} title={`Abandon ${assignmentGist(detail)}`} body="The assignment ends as abandoned. Its Peer is not archived by this; do that in Paseo if it should stop." actionLabel="Abandon" reasonRequired
        onClose={() => { setConfirming(false); }}
        onConfirm={reason => act(rpc.abandon({ projectId: props.projectId, assignmentId: props.assignmentId, reason, idempotencyKey: idempotencyKey() }), 'Assignment abandoned')} />
    </View>
  );
}
