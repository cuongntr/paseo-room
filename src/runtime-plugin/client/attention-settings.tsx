/**
 * Settings › Room attention (docs/design/runtime-coordination-attention.md §8.3, runtime-panel-ux.md
 * §5), built from the host's settings controls. Switches and selects save at once; the endpoint and
 * model save together with Apply. The key is typed here, sent once, and never shown again.
 */
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { ATTENTION_SETTINGS, isLoopbackHost, type AttentionSettings } from '../shared/attention.js';
import { unwrap, useRuntimeRpcs } from './data.js';
import { Callout, Loading, Page, Pill, Title } from './kit.js';

interface Status {
  readonly settingsAvailable: boolean; readonly mode: string; readonly keyConfigured: boolean; readonly sending: string;
  readonly calls: number; readonly failures: number; readonly inputTokens: number; readonly circuitOpenUntil?: string; readonly lastError?: string;
  readonly shadow: Readonly<Record<string, { readonly assessed: number; readonly record: number; readonly digest: number; readonly now: number }>>;
}

type Delivery = AttentionSettings['delivery'];

/** Each threshold's choices; the stored value is always offered, even when it is not a preset. */
const STEPS: readonly (readonly [keyof Delivery, string, string, readonly number[], (value: number) => string])[] = [
  ['permissionMinutes', 'Permission waiting', 'Tell the Supervisor when any seat has waited this long on a permission.', [2, 5, 10, 15, 30], value => `${String(value)} min`],
  ['peerUnreadMinutes', 'Peer result unread', 'Tell it when a Peer finished and its idle Lead has not looked for this long.', [5, 10, 20, 30, 60], value => `${String(value)} min`],
  ['digestMinutes', 'Digest interval', 'Routine lines are batched and sent at most this often.', [5, 15, 30, 60], value => `${String(value)} min`],
  ['wakesPerHour', 'Wakes per hour', 'Non-urgent letters beyond this join the next digest. Urgent pages are never limited.', [2, 4, 6, 10, 20], value => String(value)],
  ['pageHoldSeconds', 'Urgent page hold', 'How long an urgent page waits for the Supervisor to be idle before steering into its turn.', [0, 30, 60, 120, 300], value => (value === 0 ? 'none' : `${String(value)} s`)],
  ['orphanHours', 'Orphaned Peer', 'Mention a Peer left idle this long after its Lead was archived.', [6, 12, 24, 48, 72], value => `${String(value)} h`],
];

const MODE_HINT: Readonly<Record<string, string>> = {
  off: 'Nothing leaves this machine. Lead turns reach the Supervisor as digest lines.',
  shadow: 'Lead messages are assessed and the answers recorded, but never acted on — for evaluation.',
  assist: 'Assessments decide, for the question sets enabled below, whether a Lead turn wakes the Supervisor, waits for a digest, or is only recorded.',
};

function hostOf(endpoint: string): string | undefined {
  try { return new URL(endpoint).hostname; } catch { return undefined; }
}

export function RoomAttentionSettings(props: PluginSurfaceProps) {
  const settings = useSettings(ATTENTION_SETTINGS);
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const [endpoint, setEndpoint] = useState<string>();
  const [model, setModel] = useState<string>();
  const [key, setKey] = useState('');
  const [keyField, setKeyField] = useState(0);
  const [status, setStatus] = useState<Status>();
  const [tick, setTick] = useState(0);
  const { theme } = props;

  useEffect(() => {
    let cancelled = false;
    rpc.attentionStatus({}).then(answer => { if (!cancelled) setStatus(unwrap<Status>(answer).data); }, () => undefined);
    return () => { cancelled = true; };
  }, [tick]);

  const values = settings.status === 'ready' ? settings.values : undefined;
  const save = (change: (current: AttentionSettings) => AttentionSettings, message?: string): void => {
    if (settings.status !== 'ready') return;
    settings.save(change(settings.values), settings.revision).then(saved => {
      if (!saved) { toast.error(settings.saveError ?? 'Not saved; reload and try again.'); return; }
      if (message !== undefined) toast.show(message, { variant: 'success' });
      setTick(tick + 1);
    }, (error: unknown) => { toast.error(String(error)); });
  };
  const sendKey = (input: { set: string } | { clear: true }): void => {
    rpc.attentionKey(input).then(answer => {
      const result = unwrap<{ configured: boolean }>(answer);
      if (result.error !== undefined) { toast.error(result.error.message); return; }
      toast.show(result.data?.configured === true ? 'Key stored' : 'Key removed', { variant: 'success' });
      setKey('');
      setKeyField(keyField + 1);
      setTick(tick + 1);
    }, (error: unknown) => { toast.error(String(error)); });
  };

  if (values === undefined) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <Page theme={theme} compact={props.layout.compact}>
          <Title theme={theme}>Room attention</Title>
          {settings.status === 'loading' ? <Loading theme={theme} label="Loading settings…" /> : (
            <Callout theme={theme} tone="danger" icon="CircleX" title="Settings are unavailable">{settings.status === 'error' || settings.status === 'invalid' ? settings.error : ''} The runtime keeps its defaults.</Callout>
          )}
        </Page>
      </ScrollView>
    );
  }

  const sensor = values.sensor;
  const host = hostOf(sensor.endpoint);
  const remote = host !== undefined && !isLoopbackHost(host);
  const acknowledged = remote && sensor.egressAcknowledgedHost === host;
  const draftEndpoint = endpoint ?? sensor.endpoint;
  const draftModel = model ?? sensor.model;
  const dirty = draftEndpoint.trim() !== sensor.endpoint || draftModel.trim() !== sensor.model;
  const assistLeadTurns = sensor.assistQuestionSets.includes('lead-turn-v1');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Page theme={theme} compact={props.layout.compact}>
        <Title theme={theme} subtitle="What reaches a Supervisor about the projects it watches, and the optional sensor that ranks Lead messages.">Room attention</Title>

        {sensor.mode !== 'off' && remote ? (
          <Callout theme={theme} tone={acknowledged ? 'warning' : 'danger'} icon={acknowledged ? 'Send' : 'ShieldAlert'}
            title={acknowledged ? `Masked excerpts of Lead messages go to ${host}` : `Sending to ${host} is not allowed yet`}>
            {acknowledged ? 'Only bounded, masked excerpts are sent; never timelines, tool output, source files or credentials.' : 'Allow it below, or set the mode back to Off. Until then nothing is sent.'}
          </Callout>
        ) : null}

        <SettingsSection title="Letters to Supervisors">
          <SettingsSwitch label="Send attention letters" hint="Off: incidents still show in the Room panel, but no Supervisor is prompted."
            value={values.letters.enabled} onValueChange={enabled => { save(current => ({ ...current, letters: { enabled } }), enabled ? 'Letters on' : 'Letters off'); }} />
          {STEPS.map(([name, label, hint, presets, format]) => {
            const value = values.delivery[name];
            const options = [...new Set([...presets, value])].sort((a, b) => a - b).map(entry => ({ label: format(entry), value: String(entry) }));
            return (
              <SettingsSelect key={name} label={label} hint={hint} value={String(value)} options={options}
                onValueChange={next => { save(current => ({ ...current, delivery: { ...current.delivery, [name]: Number(next) } })); }} />
            );
          })}
        </SettingsSection>

        <SettingsSection title="Attention sensor" info="System One compatible: TypeSafe Jev today, a self-hosted model later.">
          <SettingsSelect label="Mode" hint={MODE_HINT[sensor.mode] ?? ''} value={sensor.mode}
            options={[{ label: 'Off', value: 'off' }, { label: 'Shadow', value: 'shadow' }, { label: 'Assist', value: 'assist' }]}
            onValueChange={mode => { save(current => ({ ...current, sensor: { ...current.sensor, mode } }), `Sensor ${mode}`); }} />
          {remote ? (
            <SettingsSwitch label={`Allow sending to ${host}`} hint="Your consent for masked excerpts to leave this machine. Loopback endpoints need none."
              value={acknowledged} onValueChange={allow => { save(current => ({ ...current, sensor: { ...current.sensor, egressAcknowledgedHost: allow ? host : null } }), allow ? `Sending to ${host} allowed` : 'Sending withdrawn'); }} />
          ) : null}
          <SettingsSwitch label="Assist Lead turns" hint="Let the sensor decide for lead-turn-v1 in Assist mode. Enable after a shadow evaluation."
            value={assistLeadTurns} disabled={sensor.mode !== 'assist'}
            onValueChange={on => { save(current => ({ ...current, sensor: { ...current.sensor, assistQuestionSets: on ? ['lead-turn-v1'] : [] } })); }} />
          <SettingsSwitch label="Mask IP addresses and host names" hint="Credentials, tokens and URL queries are always masked."
            value={sensor.maskNetworkIdentifiers} onValueChange={mask => { save(current => ({ ...current, sensor: { ...current.sensor, maskNetworkIdentifiers: mask } })); }} />
          <SettingsInput label="Endpoint" hint="POST {state, model, questions}" initialValue={sensor.endpoint} onChangeText={setEndpoint} placeholder="https://api.typesafe.ai/v1/systemone" />
          <SettingsInput label="Pinned model" hint="A versioned id, never an alias, so thresholds stay calibrated." initialValue={sensor.model} onChangeText={setModel} placeholder="jev-1.13.0" />
          <SettingsAction label="Endpoint and model" hint={dirty ? 'Unsaved changes' : 'Saved'} actionLabel="Apply" disabled={!dirty}
            onPress={() => { save(current => ({ ...current, sensor: { ...current.sensor, endpoint: draftEndpoint.trim(), model: draftModel.trim() } }), 'Endpoint and model saved'); setEndpoint(undefined); setModel(undefined); }} />
        </SettingsSection>

        <SettingsSection title="Sensor key">
          <SettingsRow label={status?.keyConfigured === true ? 'A key is stored' : 'No key stored'} hint="Owner-only under the room's runtime secrets. It is never shown again, sent to the app, or exported.">
            <Pill theme={theme} tone={status?.keyConfigured === true ? 'success' : 'muted'}>{status?.keyConfigured === true ? 'stored' : 'none'}</Pill>
          </SettingsRow>
          <SettingsInput key={`key-${String(keyField)}`} label="New key" initialValue="" secureTextEntry onChangeText={setKey} placeholder="Paste the API key" />
          <SettingsAction label="Store the key" actionLabel="Store" disabled={key.trim() === ''} onPress={() => { sendKey({ set: key.trim() }); }} />
          {status?.keyConfigured === true ? <SettingsAction label="Remove the stored key" actionLabel="Remove" onPress={() => { sendKey({ clear: true }); }} /> : null}
        </SettingsSection>

        {status === undefined ? null : (
          <SettingsSection title="Status">
            <SettingsRow label="Sensor" hint={status.sending === 'ready' ? 'Ready to send' : status.sending}>
              <Pill theme={theme} tone={status.sending === 'ready' ? 'success' : 'muted'}>{status.mode}</Pill>
            </SettingsRow>
            <SettingsRow label="Today" hint={`${String(status.calls)} call(s) · ${String(status.failures)} failure(s) · ${String(status.inputTokens)} input tokens${status.lastError === undefined ? '' : ` · last error: ${status.lastError}`}`}>
              {status.circuitOpenUntil === undefined ? null : <Pill theme={theme} tone="warning">paused until {new Date(status.circuitOpenUntil).toLocaleTimeString()}</Pill>}
            </SettingsRow>
            {Object.entries(status.shadow).map(([set, tally]) => (
              <SettingsRow key={set} label={set} hint={`${String(tally.assessed)} assessed — would record ${String(tally.record)}, digest ${String(tally.digest)}, wake ${String(tally.now)}`} />
            ))}
            {status.settingsAvailable ? null : <SettingsRow label="Settings storage" hint="Paseo gave this plugin no settings storage; defaults apply." />}
            <SettingsAction label="Refresh status" actionLabel="Refresh" onPress={() => { setTick(tick + 1); }} />
          </SettingsSection>
        )}
      </Page>
    </ScrollView>
  );
}
