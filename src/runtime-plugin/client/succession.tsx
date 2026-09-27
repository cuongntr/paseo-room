/**
 * Replace Lead (docs/design/runtime-coordination-seat-context.md §8.3): why and preflight, the
 * handoff the Lead writes and Human reviews, then the confirmation that archives the Lead and
 * starts its successor. The server keeps the replacement, so closing this modal loses nothing:
 * reopening it on the project resumes at its step, and one that stopped after the archive is
 * finished from here too.
 */
import { useToast } from '@getpaseo/plugin/client/react-native';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { idempotencyKey, useRuntimeRpcs } from './data.js';
import { call, Check, ModalShell, type Failure } from './forms.js';
import { Actions, Button, Callout, Card, Facts, Field, Input, Loading, Segmented, SPACE, type Theme } from './kit.js';
import { fateLine, handoffSize, providerLabel, seatName, type RoomView, type SuccessionPreflightView } from './model.js';

/** How often the modal asks whether the handoff has arrived. */
const STATUS_POLL_MS = 3_000;

type Reason = 'context' | 'contract' | 'other';
const REASONS: readonly { readonly value: Reason; readonly label: string }[] = [
  { value: 'context', label: 'Context is high' }, { value: 'contract', label: 'New contract' }, { value: 'other', label: 'Other' },
];

interface Status {
  readonly id: string; readonly step: string; readonly name: string; readonly fromAgentId: string; readonly fromTitle: string | null; readonly provider: string;
  readonly supervisorAgentId: string | null; readonly toAgentId?: string; readonly failure?: { readonly code: string; readonly message: string }; readonly handoff?: string;
}

type Phase = 'why' | 'handoff' | 'confirm' | 'done';

export function ReplaceLeadModal(props: {
  readonly theme: Theme; readonly room: RoomView; readonly projectKey: string | undefined; readonly leadAgentId: string | undefined; readonly open: boolean;
  readonly onClose: () => void; readonly onDone: () => void; readonly openAgent?: (agentId: string) => void;
}) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const { theme, room } = props;
  const project = room.projects.find(entry => entry.key === props.projectKey);
  const [phase, setPhase] = useState<Phase>('why');
  // The Lead the modal opened on: the project's Lead changes under it once the replacement succeeds.
  const [leadAgentId, setLeadAgentId] = useState<string>();
  // Bumped to read the replacement's status again, after an action that may have moved it.
  const [tick, setTick] = useState(0);
  const [successionId, setSuccessionId] = useState<string>();
  const [preflight, setPreflight] = useState<SuccessionPreflightView>();
  const [status, setStatus] = useState<Status>();
  const [draft, setDraft] = useState<string>();
  const [reason, setReason] = useState<Reason>('context');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const [successor, setSuccessor] = useState<string>();

  // On open: resume the project's replacement at its step, or check the Lead afresh.
  useEffect(() => {
    if (!props.open) return;
    // A failed replacement is over: opening again starts a new one.
    const inflight = project?.succession?.step === 'failed' ? undefined : project?.succession;
    const lead = props.leadAgentId ?? project?.seats.find(seat => seat.role === 'lead')?.agentId;
    setLeadAgentId(lead);
    setFailure(undefined);
    setBusy(false);
    setStatus(undefined);
    setDraft(undefined);
    setSuccessor(undefined);
    setPreflight(undefined);
    setNote('');
    setReason('context');
    if (inflight !== undefined) {
      setSuccessionId(inflight.id);
      setPhase(inflight.canFinish ? 'confirm' : 'handoff');
    } else {
      setSuccessionId(undefined);
      setPhase('why');
    }
    if (lead !== undefined && (inflight === undefined || !inflight.canFinish)) {
      void call(rpc.successionPreflight({ leadAgentId: lead })).then(result => {
        if (result.failure !== undefined) { setFailure(result.failure); return; }
        setPreflight(result.data as SuccessionPreflightView);
      });
    }
  }, [props.open, props.projectKey, props.leadAgentId]);

  // While a replacement is open, follow it: every few seconds until the handoff arrives, once after.
  useEffect(() => {
    if (!props.open || successionId === undefined) return;
    let cancelled = false;
    const load = (): void => {
      void call(rpc.successionStatus({ successionId })).then(result => {
        if (cancelled) return;
        if (result.failure !== undefined) { setFailure(result.failure); return; }
        const next = result.data as Status;
        setStatus(next);
        setDraft(current => current ?? next.handoff);
      });
    };
    load();
    const timer = setInterval(() => { if (status?.step === undefined || status.step === 'requested') load(); }, STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.open, successionId, status?.step, tick]);

  const ask = (): void => {
    if (leadAgentId === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    void call(rpc.successionStart({ leadAgentId, reason, ...(note.trim() === '' ? {} : { note: note.trim() }), idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); return; }
      setSuccessionId((result.data as { successionId: string }).successionId);
      setPhase('handoff');
      props.onDone();
    });
  };

  const cancel = (): void => {
    if (successionId === undefined || busy) return;
    setBusy(true);
    const after = status?.step === 'archived' ? 'The project has no Lead; start one from its screen.'
      : status?.step === 'created' ? 'The new Lead keeps running without its kickoff; the handoff stays stored.'
        : 'The Lead was asked to start no new work; tell it to continue.';
    void call(rpc.successionCancel({ successionId, idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); setTick(tick + 1); return; }
      toast.show(`Replacement cancelled. ${after}`, { variant: 'success' });
      props.onDone();
      props.onClose();
    });
  };

  const replace = (): void => {
    if (successionId === undefined || draft === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    void call(rpc.successionComplete({ successionId, handoff: draft, idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      props.onDone();
      // A failure may have come after the archive: the step shown must follow it.
      if (result.failure !== undefined) { setFailure(result.failure); setTick(tick + 1); return; }
      setSuccessor((result.data as { successorAgentId: string }).successorAgentId);
      setPhase('done');
    });
  };

  const lead = preflight?.lead;
  const leadName = lead?.title ?? status?.fromTitle ?? 'the Lead';
  const supervisorId = preflight?.supervisor?.agentId ?? status?.supervisorAgentId ?? null;
  const supervisorName = supervisorId === null ? 'none: the new Lead is started without a Supervisor'
    : (() => { const found = room.supervisors.find(entry => entry.agentId === supervisorId); return found === undefined ? supervisorId : seatName(found); })();
  const size = draft === undefined ? undefined : handoffSize(draft);
  const archived = preflight?.descendants.filter(seat => seat.fate === 'archived-with-lead') ?? [];
  const kept = preflight?.descendants.filter(seat => seat.fate !== 'archived-with-lead') ?? [];
  const finishing = status?.step === 'archived' || status?.step === 'created';
  const errorCallout = failure === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title="The runtime refused">{failure.message} {failure.recoveryAction}</Callout>;

  let body;
  if (project === undefined) {
    body = <Callout theme={theme} tone="muted" icon="FolderX" title="This project is no longer observed" />;
  } else if (phase === 'why') {
    const blocked = preflight === undefined || preflight.blockers.length > 0;
    body = (
      <View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACE.lg }}>
          {`${leadName} is asked to start no new work and write a handoff for a fresh Lead. You review it; nothing is archived until you confirm.`}
        </Text>
        <Field theme={theme} label="Why">
          <Segmented theme={theme} value={reason} options={REASONS} onChange={setReason} />
        </Field>
        <Field theme={theme} label="Note to the Lead" optional hint="Added to the request verbatim, e.g. what the handoff must not leave out.">
          <Input theme={theme} value={note} onChange={setNote} placeholder="e.g. Include the chart template finding." multiline />
        </Field>
        {preflight === undefined ? (failure === undefined ? <Loading theme={theme} label="Checking the Lead…" /> : null) : (
          <Card theme={theme} style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, marginBottom: SPACE.lg }}>
            {preflight.blockers.length === 0
              ? <Check theme={theme} tone="success" icon="CircleCheck" title="At a quiet point" detail="Idle, every assignment settled, no notice waiting, no seat of it working." />
              : preflight.blockers.map(blocker => <Check key={`${blocker.code}:${blocker.message}`} theme={theme} tone="danger" icon="CircleX" title={blocker.message} />)}
            {preflight.notes.map(line => <Check key={line} theme={theme} tone="warning" icon="TriangleAlert" title={line} />)}
            {preflight.descendants.map(seat => (
              <Check key={seat.agentId} theme={theme} tone={seat.fate === 'archived-with-lead' ? 'muted' : 'warning'} icon={seat.fate === 'archived-with-lead' ? 'Archive' : 'Unlink'} title={fateLine(seat)} />
            ))}
          </Card>
        )}
        {errorCallout}
        <Actions>
          <Button theme={theme} label="Cancel" variant="ghost" onPress={props.onClose} />
          <Button theme={theme} label="Ask the Lead for a handoff" variant="primary" icon="Send" onPress={ask} busy={busy} disabled={blocked} />
        </Actions>
      </View>
    );
  } else if (phase === 'handoff') {
    const step = status?.step;
    body = (
      <View>
        {step === undefined || step === 'requested' ? (
          <Card theme={theme} style={{ marginBottom: SPACE.lg }}>
            <Loading theme={theme} label={`${leadName} is writing its handoff…`} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: 'center', paddingBottom: SPACE.lg, paddingHorizontal: SPACE.lg }}>
              You can close this: the project screen shows when it is ready.
            </Text>
          </Card>
        ) : step === 'failed' || step === 'cancelled' ? (
          <Callout theme={theme} tone="danger" icon="CircleX" title={step === 'failed' ? 'No usable handoff' : 'This replacement was cancelled'}>
            {status?.failure?.message ?? 'Close this and start again.'}
          </Callout>
        ) : (
          <Field theme={theme} label="Handoff" {...(size === undefined ? {} : { hint: `${size.label}. Edit freely: the new Lead receives exactly this text.` })}
            {...(size?.over === true ? { error: `${size.label}: shorten it to fit.` } : {})}>
            <Input theme={theme} value={draft ?? ''} onChange={setDraft} multiline mono invalid={size?.over === true} />
          </Field>
        )}
        {errorCallout}
        <Actions>
          {step === 'failed' || step === 'cancelled'
            ? <Button theme={theme} label="Close" variant="ghost" onPress={props.onClose} />
            : <Button theme={theme} label="Cancel replacement" variant="danger" onPress={cancel} busy={busy} />}
          {step === 'received'
            ? <Button theme={theme} label="Continue" variant="primary" icon="ArrowRight" onPress={() => { setPhase('confirm'); setFailure(undefined); }} disabled={draft === undefined || draft.trim() === '' || size?.over === true} />
            : null}
        </Actions>
      </View>
    );
  } else if (phase === 'confirm') {
    const model = preflight?.successor.model ?? null;
    const facts: [string, string][] = [
      ['Archived', finishing ? `${leadName} (done)` : leadName],
      ...(archived.length === 0 ? [] : [['Archived with it', archived.map(fateLine).join('\n')] satisfies [string, string]]),
      ...(kept.length === 0 ? [] : [['Kept', kept.map(fateLine).join('\n')] satisfies [string, string]]),
      ['New Lead', `${project.name} — Lead · ${providerLabel(preflight?.successor.provider ?? status?.provider ?? '')}${model === null ? '' : ` · ${model}`}`],
      ['Supervisor', supervisorName],
      ['Handoff', size === undefined ? 'loading…' : size.label],
    ];
    body = (
      <View>
        {finishing ? (
          <Callout theme={theme} tone="warning" icon="TriangleAlert" title={`${leadName} is archived; its successor is not running yet`}>
            {status.failure === undefined ? 'Finish to start the new Lead with the handoff below.' : `It stopped: ${status.failure.message}`}
          </Callout>
        ) : null}
        <Card theme={theme} style={{ marginBottom: SPACE.lg }}>
          <Facts theme={theme} items={facts} />
        </Card>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5, lineHeight: 18, marginBottom: SPACE.md }}>
          The new Lead reads the handoff, verifies it against the repository and reports to you before it acts outside the repository.
        </Text>
        {finishing && draft !== undefined ? (
          <Field theme={theme} label="Handoff" {...(size?.over === true ? { error: `${size.label}: shorten it to fit.` } : {})}>
            <Input theme={theme} value={draft} onChange={setDraft} multiline mono invalid={size?.over === true} />
          </Field>
        ) : null}
        {errorCallout}
        <Actions>
          {finishing
            ? <Button theme={theme} label="Cancel replacement" variant="danger" onPress={cancel} busy={busy} />
            : <Button theme={theme} label="Back" variant="ghost" icon="ArrowLeft" onPress={() => { setPhase('handoff'); }} />}
          <Button theme={theme} label={finishing ? 'Finish replacing Lead' : 'Replace Lead'} variant="primary" icon="RefreshCcw" onPress={replace} busy={busy}
            disabled={draft === undefined || draft.trim() === '' || size?.over === true} />
        </Actions>
      </View>
    );
  } else {
    body = (
      <View>
        <Callout theme={theme} tone="success" icon="CircleCheck" title={`${project.name} has a new Lead`}>
          It received the handoff and reports to you once it has checked it.
        </Callout>
        <Actions>
          <Button theme={theme} label="Close" variant="ghost" onPress={props.onClose} />
          {successor === undefined || props.openAgent === undefined ? null
            : <Button theme={theme} label="Open new Lead" variant="primary" icon="ExternalLink" onPress={() => { props.openAgent?.(successor); props.onClose(); }} />}
        </Actions>
      </View>
    );
  }

  return (
    <ModalShell theme={theme} title={project === undefined ? 'Replace Lead' : `Replace the Lead of ${project.name}`} icon="RefreshCcw" open={props.open} onClose={props.onClose}>
      {body}
    </ModalShell>
  );
}
