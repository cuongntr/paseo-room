/**
 * Settings › Room attention (docs/design/runtime-coordination-attention.md §8.3): letters to
 * Supervisors, their thresholds, and the optional attention sensor — mode, endpoint, pinned model,
 * the operator's egress acknowledgement, and the write-only key. The key is typed here and sent
 * once; no answer ever carries it back.
 */
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { ATTENTION_SETTINGS, QUESTION_SETS, SENSOR_MODES, isLoopbackHost, type AttentionSettings } from '../shared/attention.js';
import { unwrap, useRuntimeRpcs } from './data.js';

type Theme = PluginSurfaceProps['theme'];

interface Status {
  readonly settingsAvailable: boolean; readonly mode: string; readonly endpointHost: string | null; readonly model: string;
  readonly keyConfigured: boolean; readonly egress: string; readonly sending: string;
  readonly calls: number; readonly failures: number; readonly inputTokens: number; readonly circuitOpenUntil?: string; readonly lastError?: string;
  readonly shadow: Readonly<Record<string, { readonly assessed: number; readonly record: number; readonly digest: number; readonly now: number }>>;
}

function Label(props: { readonly theme: Theme; readonly muted?: boolean; readonly strong?: boolean; readonly tone?: string; readonly children: ReactNode }) {
  const color = props.tone ?? (props.muted === true ? props.theme.colors.foregroundMuted : props.theme.colors.foreground);
  return <Text style={{ color, fontWeight: props.strong === true ? '600' : '400', marginBottom: 4 }}>{props.children}</Text>;
}

function Chip(props: { readonly theme: Theme; readonly label: string; readonly onPress: () => void; readonly selected?: boolean }) {
  const { colors } = props.theme;
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" accessibilityState={{ selected: props.selected === true }}
      style={{ borderWidth: 1, borderColor: props.selected === true ? colors.foreground : colors.border, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 9, marginRight: 6, marginBottom: 6 }}>
      <Text style={{ color: colors.foreground, fontWeight: props.selected === true ? '600' : '400' }}>{props.label}</Text>
    </Pressable>
  );
}

function Field(props: { readonly theme: Theme; readonly label: string; readonly value: string; readonly onChange: (text: string) => void; readonly secure?: boolean; readonly numeric?: boolean }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Label theme={props.theme} muted>{props.label}</Label>
      <TextInput value={props.value} onChangeText={props.onChange} secureTextEntry={props.secure === true} autoCapitalize="none" autoCorrect={false}
        keyboardType={props.numeric === true ? 'numeric' : 'default'} placeholderTextColor={props.theme.colors.foregroundMuted}
        style={{ color: props.theme.colors.foreground, borderWidth: 1, borderColor: props.theme.colors.border, borderRadius: 6, padding: 6 }} />
    </View>
  );
}

const Row = (props: { readonly children: ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>{props.children}</View>;

function Section(props: { readonly theme: Theme; readonly title: string; readonly children: ReactNode }) {
  return (
    <View style={{ borderTopWidth: 1, borderColor: props.theme.colors.border, paddingTop: 10, marginTop: 10 }}>
      <Label theme={props.theme} strong>{props.title}</Label>
      {props.children}
    </View>
  );
}

function hostOf(endpoint: string): string | undefined {
  try { return new URL(endpoint).hostname; } catch { return undefined; }
}

const THRESHOLDS: readonly (readonly [keyof AttentionSettings['delivery'], string])[] = [
  ['permissionMinutes', 'Permission waiting (minutes)'],
  ['peerUnreadMinutes', 'Peer result unread (minutes)'],
  ['digestMinutes', 'Digest interval (minutes)'],
  ['wakesPerHour', 'Supervisor wakes per hour'],
  ['pageHoldSeconds', 'Page hold before steering (seconds)'],
  ['orphanHours', 'Orphaned Peer (hours)'],
];

export function RoomAttentionSettings(props: PluginSurfaceProps) {
  const settings = useSettings(ATTENTION_SETTINGS);
  const rpc = useRuntimeRpcs();
  const [draft, setDraft] = useState<AttentionSettings>();
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<Status>();
  const [notice, setNotice] = useState<string>();
  const [tick, setTick] = useState(0);
  const { theme } = props;

  useEffect(() => {
    let cancelled = false;
    rpc.attentionStatus({}).then(answer => { if (!cancelled) setStatus(unwrap<Status>(answer).data); }, () => undefined);
    return () => { cancelled = true; };
  }, [tick]);
  useEffect(() => {
    if (settings.status === 'ready' && draft === undefined) setDraft(settings.values);
  }, [settings.status]);

  const current = draft ?? (settings.status === 'ready' ? settings.values : undefined);
  const update = (change: (next: AttentionSettings) => AttentionSettings): void => { if (current !== undefined) setDraft(change(current)); };
  const save = (): void => {
    if (settings.status !== 'ready' || current === undefined) return;
    settings.save(current, settings.revision).then(saved => {
      setNotice(saved ? 'Saved.' : settings.saveError ?? 'Not saved.');
      setTick(tick + 1);
    }, (error: unknown) => { setNotice(String(error)); });
  };
  const sendKey = (input: { set: string } | { clear: true }): void => {
    rpc.attentionKey(input).then(answer => {
      const value = unwrap<{ configured: boolean }>(answer);
      setNotice(value.error?.message ?? (value.data?.configured === true ? 'Key stored.' : 'No key stored.'));
      setKey('');
      setTick(tick + 1);
    }, (error: unknown) => { setNotice(String(error)); });
  };

  const host = current === undefined ? undefined : hostOf(current.sensor.endpoint);
  const acknowledged = current !== undefined && host !== undefined && (isLoopbackHost(host) || current.sensor.egressAcknowledgedHost === host);
  return (
    <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 12 : 20 }}>
      <Label theme={theme} strong>Room attention</Label>
      <Label theme={theme} muted>What reaches a Supervisor about the projects it supervises, and the optional sensor that ranks Lead messages.</Label>
      {settings.status === 'loading' ? <Label theme={theme} muted>Loading…</Label> : null}
      {settings.status === 'error' || settings.status === 'invalid' ? <Label theme={theme} tone={theme.colors.statusDanger}>Settings unavailable: {settings.error}. Defaults apply.</Label> : null}
      {current === undefined ? null : (
        <View>
          <Section theme={theme} title="Letters to Supervisors">
            <Row>
              <Switch value={current.letters.enabled} onValueChange={value => { update(next => ({ ...next, letters: { enabled: value } })); }} />
              <Label theme={theme}> Send attention letters</Label>
            </Row>
            {THRESHOLDS.map(([name, label]) => (
              <Field key={name} theme={theme} label={label} numeric value={String(current.delivery[name])}
                onChange={text => { const value = Number.parseInt(text, 10); if (!Number.isNaN(value)) update(next => ({ ...next, delivery: { ...next.delivery, [name]: value } })); }} />
            ))}
          </Section>
          <Section theme={theme} title="Attention sensor">
            <Label theme={theme} muted>Off: nothing leaves this machine. Shadow: masked excerpts are assessed and recorded, never applied. Assist: assessments decide letters for the question sets you enable.</Label>
            <Row>{SENSOR_MODES.map(mode => <Chip key={mode} theme={theme} label={mode} selected={current.sensor.mode === mode} onPress={() => { update(next => ({ ...next, sensor: { ...next.sensor, mode } })); }} />)}</Row>
            <Field theme={theme} label="Endpoint (System One compatible)" value={current.sensor.endpoint} onChange={text => { update(next => ({ ...next, sensor: { ...next.sensor, endpoint: text.trim() } })); }} />
            <Field theme={theme} label="Pinned model" value={current.sensor.model} onChange={text => { update(next => ({ ...next, sensor: { ...next.sensor, model: text.trim() } })); }} />
            <Row>
              <Switch value={current.sensor.maskNetworkIdentifiers} onValueChange={value => { update(next => ({ ...next, sensor: { ...next.sensor, maskNetworkIdentifiers: value } })); }} />
              <Label theme={theme}> Mask IP addresses and host names</Label>
            </Row>
            {host === undefined || isLoopbackHost(host) ? null : (
              <Row>
                <Switch value={acknowledged} onValueChange={value => { update(next => ({ ...next, sensor: { ...next.sensor, egressAcknowledgedHost: value ? host : null } })); }} />
                <Label theme={theme}> I allow masked excerpts of Lead messages to be sent to {host}</Label>
              </Row>
            )}
            <Label theme={theme} muted>Assist for</Label>
            <Row>{QUESTION_SETS.filter(set => set !== 'peer-report-v1').map(set => {
              const on = current.sensor.assistQuestionSets.includes(set);
              return <Chip key={set} theme={theme} label={set} selected={on} onPress={() => {
                update(next => ({ ...next, sensor: { ...next.sensor, assistQuestionSets: on ? next.sensor.assistQuestionSets.filter(entry => entry !== set) : [...next.sensor.assistQuestionSets, set] } }));
              }} />;
            })}</Row>
          </Section>
          <Row>
            <Chip theme={theme} label={settings.saving ? 'Saving…' : 'Save'} onPress={save} />
            <Chip theme={theme} label="Discard changes" onPress={() => { setDraft(undefined); }} />
          </Row>
        </View>
      )}
      <Section theme={theme} title="Sensor key">
        <Label theme={theme} muted>{status?.keyConfigured === true ? 'A key is stored. It is never shown again.' : 'No key is stored.'}</Label>
        <Field theme={theme} label="New key" secure value={key} onChange={setKey} />
        <Row>
          <Chip theme={theme} label="Store key" onPress={() => { if (key.trim() !== '') sendKey({ set: key.trim() }); }} />
          <Chip theme={theme} label="Remove key" onPress={() => { sendKey({ clear: true }); }} />
        </Row>
      </Section>
      {status === undefined ? null : (
        <Section theme={theme} title="Status">
          <Label theme={theme}>Sensor: {status.mode} · {status.sending === 'ready' ? 'ready to send' : status.sending}</Label>
          <Label theme={theme} muted>Today: {String(status.calls)} call(s), {String(status.failures)} failure(s), {String(status.inputTokens)} input tokens{status.circuitOpenUntil === undefined ? '' : ` · circuit open until ${new Date(status.circuitOpenUntil).toLocaleTimeString()}`}</Label>
          {status.lastError === undefined ? null : <Label theme={theme} muted>Last error: {status.lastError}</Label>}
          {Object.entries(status.shadow).map(([set, tally]) => (
            <Label key={set} theme={theme} muted>{set}: {String(tally.assessed)} assessed — would record {String(tally.record)}, digest {String(tally.digest)}, wake {String(tally.now)}</Label>
          ))}
          {status.settingsAvailable ? null : <Label theme={theme} tone={theme.colors.statusWarning}>Paseo gave this plugin no settings storage; defaults apply.</Label>}
          <Chip theme={theme} label="Refresh" onPress={() => { setTick(tick + 1); }} />
        </Section>
      )}
      {notice === undefined ? null : <Label theme={theme} muted>{notice}</Label>}
    </ScrollView>
  );
}
