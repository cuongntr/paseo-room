/**
 * Settings › Room attention (docs/design/runtime-coordination-attention.md §8.3, runtime-panel-ux.md
 * §5), built from the host's settings controls. Letters come first, with what reached Supervisors
 * in the last day, then when to tell and how often. Switches and selects save at once.
 */
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsAction, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { ATTENTION_SETTINGS, type AttentionSettings } from '../shared/attention.js';
import type { LetterTally } from '../shared/panel.js';
import { unwrap, useRuntimeRpcs } from './data.js';
import { Callout, Loading, Page, Title } from './kit.js';
import { lettersLine } from './model.js';

interface Status {
  readonly settingsAvailable: boolean;
  readonly letters?: LetterTally;
}

type Delivery = AttentionSettings['delivery'];
type Step = readonly [keyof Delivery, string, string, readonly number[], (value: number) => string];

const minutes = (value: number): string => `${String(value)} min`;

/** When a Supervisor is told; each threshold's choices, and the stored value is always offered. */
const WHEN: readonly Step[] = [
  ['permissionMinutes', 'Permission waiting', 'A seat has waited this long on a permission.', [2, 5, 10, 15, 30], minutes],
  ['peerUnreadMinutes', 'Peer result unread', 'A Peer finished and its idle Lead has not looked for this long.', [5, 10, 20, 30, 60], minutes],
  ['orphanHours', 'Orphaned Peer', 'A Peer is left idle this long after its Lead was archived.', [6, 12, 24, 48, 72], value => `${String(value)} h`],
];

/** How often a Supervisor is woken. */
const PACE: readonly Step[] = [
  ['digestMinutes', 'Digest interval', 'Routine lines are batched and sent at most this often.', [5, 15, 30, 60], minutes],
  ['wakesPerHour', 'Wakes per hour', 'Non-urgent letters beyond this join the next digest. Pages, a Lead\'s question for you and its answer to the Supervisor are never limited.', [2, 4, 6, 10, 20], value => String(value)],
  ['pageHoldSeconds', 'Urgent page hold', 'How long an urgent page waits for the Supervisor to be idle before steering into its turn.', [0, 30, 60, 120, 300], value => (value === 0 ? 'none' : `${String(value)} s`)],
];

export function RoomAttentionSettings(props: PluginSurfaceProps) {
  const settings = useSettings(ATTENTION_SETTINGS);
  const rpc = useRuntimeRpcs();
  const toast = useToast();
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

  const step = ([name, label, hint, presets, format]: Step) => {
    const value = values.delivery[name];
    const options = [...new Set([...presets, value])].sort((a, b) => a - b).map(entry => ({ label: format(entry), value: String(entry) }));
    return (
      <SettingsSelect key={name} label={label} hint={hint} value={String(value)} options={options}
        onValueChange={next => { save(current => ({ ...current, delivery: { ...current.delivery, [name]: Number(next) } })); }} />
    );
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Page theme={theme} compact={props.layout.compact}>
        <Title theme={theme} subtitle="What reaches a Supervisor about the projects it watches.">Room attention</Title>

        <SettingsSection title="Letters to Supervisors">
          <SettingsSwitch label="Send attention letters" hint="Off: incidents still show in the Room panel, but no Supervisor is prompted."
            value={values.letters.enabled} onValueChange={enabled => { save(current => ({ ...current, letters: { enabled } }), enabled ? 'Letters on' : 'Letters off'); }} />
          {status?.letters === undefined ? null : <SettingsRow label={`Last ${String(status.letters.hours)} hours`} hint={lettersLine(status.letters)} />}
        </SettingsSection>

        <SettingsSection title="When to tell a Supervisor">{WHEN.map(step)}</SettingsSection>
        <SettingsSection title="How often">{PACE.map(step)}</SettingsSection>

        <SettingsSection title="Status">
          {status?.settingsAvailable === false ? <SettingsRow label="Settings storage" hint="Paseo gave this plugin no settings storage; defaults apply." /> : null}
          <SettingsAction label="Letter counts" hint="Read again from the runtime." actionLabel="Refresh" onPress={() => { setTick(tick + 1); }} />
        </SettingsSection>
      </Page>
    </ScrollView>
  );
}
