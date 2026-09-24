/**
 * The Human's seat actions as guided modal forms (docs/design/runtime-panel-ux.md §5): New
 * Supervisor, New project in two steps, and Assign Supervisor. Each form validates what it can
 * before sending, places a server refusal on the field it concerns, shows its progress on the
 * primary action, and confirms the outcome with a toast.
 */
import { Icon, Modal, useToast } from '@getpaseo/plugin/client/react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { idempotencyKey, unwrap, useRuntimeRpcs } from './data.js';
import { Actions, Button, Callout, Card, Choice, Field, Glyph, Input, Pill, SPACE, Segmented, type Theme, type Tone } from './kit.js';
import { agentLabel, providerLabel, seatName, type RoomView, type SupervisorView } from './model.js';

interface Failure { readonly code: string; readonly message: string; readonly recoveryAction: string }

/** Runs an RPC, returning its data or the refusal. */
async function call(work: Promise<unknown>): Promise<{ readonly data?: unknown; readonly failure?: Failure }> {
  try {
    const answer = unwrap(await work);
    return answer.error === undefined ? (answer.data === undefined ? {} : { data: answer.data }) : { failure: answer.error };
  } catch (error) {
    return { failure: { code: 'transport', message: error instanceof Error ? error.message : String(error), recoveryAction: 'Check that the runtime plugin is running, then retry.' } };
  }
}

function providerOptions(room: RoomView, role: string): { value: string; label: string; icon: string }[] {
  return room.providers.filter(entry => entry.role === role).map(entry => ({ value: entry.providerId, label: agentLabel(entry.agent), icon: 'Bot' }));
}

function ModalShell(props: { readonly theme: Theme; readonly title: string; readonly icon: string; readonly open: boolean; readonly onClose: () => void; readonly children: ReactNode }) {
  return (
    <Modal title={props.title} icon={<Icon name={props.icon} size={16} color={props.theme.colors.foreground} />} open={props.open} onOpenChange={open => { if (!open) props.onClose(); }}>
      <Modal.Content>{props.children}</Modal.Content>
    </Modal>
  );
}

export function NewSupervisorModal(props: { readonly theme: Theme; readonly room: RoomView; readonly open: boolean; readonly onClose: () => void; readonly onDone: () => void }) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const options = providerOptions(props.room, 'supervisor');
  const [provider, setProvider] = useState<string | undefined>(options[0]?.value);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const { theme } = props;
  useEffect(() => { if (props.open) { setFailure(undefined); setBusy(false); } }, [props.open]);
  const folderError = failure !== undefined && ['path_invalid', 'path_in_repository'].includes(failure.code) ? failure.message : undefined;
  const agentError = failure !== undefined && ['provider_invalid', 'model_unavailable'].includes(failure.code) ? failure.message : undefined;
  const submit = (): void => {
    if (provider === undefined || folder.trim() === '' || busy) return;
    setBusy(true);
    setFailure(undefined);
    void call(rpc.startSupervisor({ provider, cwd: folder.trim(), ...(name.trim() === '' ? {} : { title: name.trim() }), idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); return; }
      toast.show(`${name.trim() === '' ? 'Room Supervisor' : name.trim()} started`, { variant: 'success' });
      setFolder('');
      setName('');
      props.onDone();
      props.onClose();
    });
  };
  return (
    <ModalShell theme={theme} title="New Supervisor" icon="Eye" open={props.open} onClose={props.onClose}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACE.lg }}>
        A Supervisor watches the projects you give it, relays your decisions to their Leads, and is told when work stalls. One Supervisor can watch several repositories.
      </Text>
      <Field theme={theme} label="Agent" {...(agentError === undefined ? {} : { error: agentError })}>
        {options.length === 0
          ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>This room has no Supervisor provider. Run paseo-room setup first.</Text>
          : <Segmented theme={theme} value={provider} options={options} onChange={setProvider} />}
      </Field>
      <Field theme={theme} label="Folder" hint="An existing folder outside every repository — the runtime creates none. ~/ is fine." {...(folderError === undefined ? {} : { error: folderError })}>
        <Input theme={theme} value={folder} onChange={text => { setFolder(text); setFailure(undefined); }} placeholder="~/room-desk" invalid={folderError !== undefined} autoFocus onSubmit={submit} mono />
      </Field>
      <Field theme={theme} label="Name" optional>
        <Input theme={theme} value={name} onChange={setName} placeholder="Room Supervisor" onSubmit={submit} />
      </Field>
      {failure !== undefined && folderError === undefined && agentError === undefined
        ? <Callout theme={theme} tone="danger" icon="CircleX" title="Could not start the Supervisor">{failure.message} {failure.recoveryAction}</Callout> : null}
      <Actions>
        <Button theme={theme} label="Cancel" variant="ghost" onPress={props.onClose} />
        <Button theme={theme} label="Start Supervisor" variant="primary" icon="Play" onPress={submit} busy={busy} disabled={provider === undefined || folder.trim() === ''} />
      </Actions>
    </ModalShell>
  );
}

interface Preflight {
  readonly path: string; readonly root: string; readonly name: string; readonly git: boolean; readonly hasCommit: boolean; readonly protocol: boolean;
  readonly existingLead?: { readonly agentId: string; readonly title: string | null }; readonly findings: readonly string[];
}

function Check(props: { readonly theme: Theme; readonly tone: Tone; readonly icon: string; readonly title: string; readonly detail?: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: SPACE.md, paddingVertical: 7, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 1 }}><Glyph theme={props.theme} name={props.icon} tone={props.tone} size={15} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 13 }}>{props.title}</Text>
        {props.detail === undefined ? null : <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12, marginTop: 1 }}>{props.detail}</Text>}
      </View>
    </View>
  );
}

function Checklist(props: { readonly theme: Theme; readonly found: Preflight; readonly openAgent?: (agentId: string) => void; readonly onAssignInstead: () => void }) {
  const { theme, found } = props;
  return (
    <Card theme={theme} style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, marginBottom: SPACE.lg }}>
      <Check theme={theme} tone={found.git ? 'success' : 'warning'} icon={found.git ? 'CircleCheck' : 'TriangleAlert'} title={found.git ? 'Git repository' : 'Not a Git repository'}
        {...(found.git ? {} : { detail: 'The Lead can work here, but runtime assignments need Git.' })} />
      {found.git ? (
        <Check theme={theme} tone={found.hasCommit ? 'success' : 'warning'} icon={found.hasCommit ? 'CircleCheck' : 'TriangleAlert'} title={found.hasCommit ? 'Has commits' : 'No commit yet'}
          {...(found.hasCommit ? {} : { detail: 'Runtime assignments start from a commit; commit once before delegating through them.' })} />
      ) : null}
      <Check theme={theme} tone={found.protocol ? 'success' : 'muted'} icon={found.protocol ? 'CircleCheck' : 'Circle'} title={found.protocol ? 'Workspace protocol found' : 'No workspace protocol'}
        detail={found.protocol ? 'WORKSPACE_PROTOCOL.md — the Lead reads it first.' : 'Optional. The Lead can draft one with its onboarding skill.'} />
      {found.existingLead === undefined
        ? <Check theme={theme} tone="success" icon="CircleCheck" title="No Lead owns it yet" />
        : (
          <View>
            <Check theme={theme} tone="danger" icon="CircleX" title={`Already owned by ${found.existingLead.title ?? found.existingLead.agentId}`} detail="A project has one Lead. Put it under a Supervisor instead." />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, paddingLeft: 27, paddingBottom: SPACE.sm }}>
              {props.openAgent === undefined ? null : <Button theme={theme} small label="Open Lead" icon="ExternalLink" onPress={() => { if (found.existingLead !== undefined) props.openAgent?.(found.existingLead.agentId); }} />}
              <Button theme={theme} small label="Assign a Supervisor instead" icon="Eye" onPress={props.onAssignInstead} />
            </View>
          </View>
        )}
    </Card>
  );
}

export function NewProjectModal(props: {
  readonly theme: Theme; readonly room: RoomView; readonly open: boolean; readonly onClose: () => void; readonly onDone: () => void;
  readonly onNewSupervisor: () => void; readonly onAssign: (projectRoot: string) => void; readonly openAgent?: (agentId: string) => void;
}) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const { theme, room } = props;
  const leadOptions = providerOptions(room, 'lead');
  const [step, setStep] = useState<'repository' | 'lead'>('repository');
  const [folder, setFolder] = useState('');
  const [found, setFound] = useState<Preflight>();
  const [supervisor, setSupervisor] = useState<string | undefined>(room.supervisors[0]?.agentId);
  const [provider, setProvider] = useState<string | undefined>(leadOptions[0]?.value);
  const [directive, setDirective] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  useEffect(() => {
    if (!props.open) return;
    setStep('repository');
    setFound(undefined);
    setFailure(undefined);
    setBusy(false);
    if (supervisor === undefined || !room.supervisors.some(entry => entry.agentId === supervisor)) setSupervisor(room.supervisors[0]?.agentId);
  }, [props.open]);

  const check = (): void => {
    if (folder.trim() === '' || busy) return;
    setBusy(true);
    setFailure(undefined);
    void call(rpc.projectPreflight({ path: folder.trim() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); setFound(undefined); return; }
      setFound(result.data as Preflight | undefined);
    });
  };
  const start = (): void => {
    if (found === undefined || supervisor === undefined || provider === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    void call(rpc.startProject({ path: found.root, supervisorAgentId: supervisor, provider, ...(directive.trim() === '' ? {} : { directive }), idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); return; }
      toast.show(`Lead started for ${found.name}`, { variant: 'success' });
      setFolder('');
      setDirective('');
      props.onDone();
      props.onClose();
    });
  };

  const folderError = failure !== undefined && step === 'repository' && failure.code === 'path_invalid' ? failure.message : undefined;
  const chosen: SupervisorView | undefined = room.supervisors.find(entry => entry.agentId === supervisor);
  return (
    <ModalShell theme={theme} title="New project" icon="FolderPlus" open={props.open} onClose={props.onClose}>
      <View style={{ flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.lg }}>
        <Pill theme={theme} tone={step === 'repository' ? 'accent' : 'success'} icon={step === 'repository' ? 'Circle' : 'CircleCheck'}>1  Repository</Pill>
        <Pill theme={theme} tone={step === 'lead' ? 'accent' : 'muted'} icon="Circle">2  Lead</Pill>
      </View>
      {step === 'repository' ? (
        <View>
          <Field theme={theme} label="Repository folder" hint="The folder the Lead will own. ~/ is fine." {...(folderError === undefined ? {} : { error: folderError })}>
            <Input theme={theme} value={folder} onChange={text => { setFolder(text); setFound(undefined); setFailure(undefined); }} placeholder="~/Work/my-repository" invalid={folderError !== undefined} autoFocus onSubmit={check} mono />
          </Field>
          {found === undefined ? null : <Checklist theme={theme} found={found} {...(props.openAgent === undefined ? {} : { openAgent: props.openAgent })} onAssignInstead={() => { props.onClose(); props.onAssign(found.root); }} />}
          {failure !== undefined && folderError === undefined ? <Callout theme={theme} tone="danger" icon="CircleX" title="Could not check the folder">{failure.message}</Callout> : null}
          <Actions>
            <Button theme={theme} label="Cancel" variant="ghost" onPress={props.onClose} />
            {found === undefined
              ? <Button theme={theme} label="Check folder" variant="primary" icon="Search" onPress={check} busy={busy} disabled={folder.trim() === ''} />
              : <Button theme={theme} label="Continue" variant="primary" icon="ArrowRight" onPress={() => { setStep('lead'); setFailure(undefined); }} disabled={found.existingLead !== undefined} />}
          </Actions>
        </View>
      ) : found === undefined ? null : (
        <View>
          <Card theme={theme} style={{ padding: SPACE.md, marginBottom: SPACE.lg, flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            <Glyph theme={theme} name="FolderGit2" boxed />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: '600' }}>{found.name}</Text>
              <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{found.root}</Text>
            </View>
            <Button theme={theme} small variant="ghost" label="Change" onPress={() => { setStep('repository'); }} />
          </Card>
          <Field theme={theme} label="Supervisor" hint="It is told when this project stalls, and relays your decisions to the Lead." {...(failure?.code === 'supervisor_invalid' ? { error: failure.message } : {})}>
            {room.supervisors.length === 0 ? (
              <Callout theme={theme} tone="warning" icon="Eye" title="No Supervisor yet" action={<Button theme={theme} small label="New Supervisor" icon="Plus" onPress={props.onNewSupervisor} />}>
                A project Lead is started under a Supervisor. Start one first — it can watch many projects.
              </Callout>
            ) : (
              <Card theme={theme}>
                {room.supervisors.map((entry, index) => (
                  <Choice key={entry.agentId} theme={theme} first={index === 0} selected={entry.agentId === supervisor} onPress={() => { setSupervisor(entry.agentId); }}
                    title={seatName(entry)} subtitle={entry.portfolio === 0 ? 'Not watching any project yet' : `Watching ${String(entry.portfolio)} project${entry.portfolio === 1 ? '' : 's'}`} />
                ))}
              </Card>
            )}
          </Field>
          <Field theme={theme} label="Lead agent" {...(failure !== undefined && ['provider_invalid', 'model_unavailable'].includes(failure.code) ? { error: failure.message } : {})}>
            <Segmented theme={theme} value={provider} options={leadOptions} onChange={setProvider} />
          </Field>
          <Field theme={theme} label="First directive" optional hint="Sent to the Lead verbatim after its kickoff. Leave empty and it waits for you.">
            <Input theme={theme} value={directive} onChange={setDirective} placeholder="e.g. Review the checkout flow and propose a plan." multiline />
          </Field>
          {failure !== undefined && !['supervisor_invalid', 'provider_invalid', 'model_unavailable'].includes(failure.code)
            ? <Callout theme={theme} tone="danger" icon="CircleX" title="Could not start the Lead">{failure.message} {failure.recoveryAction}</Callout> : null}
          <Actions>
            <Button theme={theme} label="Back" variant="ghost" icon="ArrowLeft" onPress={() => { setStep('repository'); }} />
            <Button theme={theme} label={chosen === undefined ? 'Start Lead' : `Start Lead under ${seatName(chosen)}`} variant="primary" icon="Play" onPress={start} busy={busy} disabled={supervisor === undefined || provider === undefined} />
          </Actions>
        </View>
      )}
    </ModalShell>
  );
}

export function AssignSupervisorModal(props: {
  readonly theme: Theme; readonly room: RoomView; readonly projectKey: string | undefined; readonly open: boolean; readonly onClose: () => void; readonly onDone: () => void;
  readonly onNewSupervisor: () => void;
}) {
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const { theme, room } = props;
  const project = room.projects.find(entry => entry.key === props.projectKey);
  const [selected, setSelected] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  useEffect(() => { if (props.open) { setSelected(project?.supervisor?.agentId ?? room.supervisors[0]?.agentId ?? null); setFailure(undefined); setBusy(false); } }, [props.open, props.projectKey]);
  const submit = (): void => {
    if (project === undefined || selected === undefined || busy) return;
    setBusy(true);
    void call(rpc.assignSupervisor({ projectKey: project.key, supervisorAgentId: selected, idempotencyKey: idempotencyKey() })).then(result => {
      setBusy(false);
      if (result.failure !== undefined) { setFailure(result.failure); return; }
      const who = room.supervisors.find(entry => entry.agentId === selected);
      toast.show(who === undefined ? `${project.name} follows its Lead's parent again` : `${project.name} is now watched by ${seatName(who)}`, { variant: 'success' });
      props.onDone();
      props.onClose();
    });
  };
  return (
    <ModalShell theme={theme} title={project === undefined ? 'Assign Supervisor' : `Supervisor for ${project.name}`} icon="Eye" open={props.open} onClose={props.onClose}>
      {room.supervisors.length === 0 ? (
        <Callout theme={theme} tone="warning" icon="Eye" title="No Supervisor yet" action={<Button theme={theme} small label="New Supervisor" icon="Plus" onPress={props.onNewSupervisor} />}>
          Start a Supervisor first; it can watch many projects.
        </Callout>
      ) : (
        <View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACE.md }}>
            Attention letters for this project go to the Supervisor you choose. Your choice overrides the Lead's parent.
          </Text>
          <Card theme={theme} style={{ marginBottom: SPACE.lg }}>
            {room.supervisors.map((entry, index) => (
              <Choice key={entry.agentId} theme={theme} first={index === 0} selected={selected === entry.agentId} onPress={() => { setSelected(entry.agentId); }}
                title={seatName(entry)} subtitle={`${providerLabel(entry.provider)} · watching ${String(entry.portfolio)} project${entry.portfolio === 1 ? '' : 's'}`} />
            ))}
            {project?.decidedBy === 'human'
              ? <Choice theme={theme} selected={selected === null} onPress={() => { setSelected(null); }} title="No assignment" subtitle="Follow the Lead's parent, if it is a Supervisor" />
              : null}
          </Card>
          {failure === undefined ? null : <Callout theme={theme} tone="danger" icon="CircleX" title="Could not assign">{failure.message} {failure.recoveryAction}</Callout>}
          <Actions>
            <Button theme={theme} label="Cancel" variant="ghost" onPress={props.onClose} />
            <Button theme={theme} label="Assign" variant="primary" icon="Check" onPress={submit} busy={busy} disabled={selected === undefined || project === undefined} />
          </Actions>
        </View>
      )}
    </ModalShell>
  );
}

/** A destructive action behind a reason and a second, explicit press. */
export function ConfirmModal(props: {
  readonly theme: Theme; readonly open: boolean; readonly title: string; readonly body: string; readonly actionLabel: string; readonly reasonRequired: boolean;
  readonly onClose: () => void; readonly onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { theme } = props;
  useEffect(() => { if (props.open) { setReason(''); setBusy(false); } }, [props.open]);
  return (
    <ModalShell theme={theme} title={props.title} icon="TriangleAlert" open={props.open} onClose={props.onClose}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACE.lg }}>{props.body}</Text>
      <Field theme={theme} label="Reason" {...(props.reasonRequired ? {} : { optional: true })} hint="Recorded with the action.">
        <Input theme={theme} value={reason} onChange={setReason} placeholder="Why this is safe to do" autoFocus multiline />
      </Field>
      <Actions>
        <Button theme={theme} label="Cancel" variant="ghost" onPress={props.onClose} />
        <Button theme={theme} label={props.actionLabel} variant="danger" icon="TriangleAlert" busy={busy} disabled={props.reasonRequired && reason.trim() === ''}
          onPress={() => { setBusy(true); void props.onConfirm(reason.trim()).then(done => { setBusy(false); if (done) props.onClose(); }); }} />
      </Actions>
    </ModalShell>
  );
}
