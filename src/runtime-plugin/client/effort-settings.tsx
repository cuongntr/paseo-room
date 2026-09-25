/**
 * Settings › Room seats › Thinking Lead may choose (docs/design/runtime-coordination-peer-effort.md
 * §3): per room Peer provider, the thinking options Lead may pick for a dispatch besides the
 * profile's own. The profile's option is always allowed and shown fixed on; every toggle saves at
 * once. The options are the ones Paseo lists for the profile's model.
 */
import { useSettings } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { isDelegating, PEER_EFFORT_SETTINGS } from '../shared/effort.js';
import { unwrap, useRuntimeRpcs, type Unwrapped } from './data.js';
import { agentLabel } from './model.js';

interface PeerOptions {
  readonly providerId: string;
  readonly agent: string;
  readonly model: string | null;
  readonly defaultThinking: string | null;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

type Loaded = Unwrapped<{ readonly settingsAvailable: boolean; readonly providers: readonly PeerOptions[] }>;

export function PeerThinkingSection() {
  const settings = useSettings(PEER_EFFORT_SETTINGS);
  const rpc = useRuntimeRpcs();
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    rpc.peerEffort({}).then(answer => { if (!cancelled) setLoaded(unwrap(answer)); }, (error: unknown) => {
      if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, []);

  // One save at a time: each save sends the whole document at the revision it read.
  const [saving, setSaving] = useState(false);
  const toggle = (providerId: string, option: string, on: boolean): void => {
    if (settings.status !== 'ready' || saving) return;
    const current = settings.values.allowedThinking[providerId] ?? [];
    const next = on ? [...new Set([...current, option])] : current.filter(entry => entry !== option);
    setSaving(true);
    settings.save({ ...settings.values, allowedThinking: { ...settings.values.allowedThinking, [providerId]: next } }, settings.revision)
      .then(saved => { if (!saved) toast.error('Not saved; reload and try again.'); }, (error: unknown) => { toast.error(String(error)); })
      .finally(() => { setSaving(false); });
  };

  const values = settings.status === 'ready' ? settings.values : undefined;
  const data = loaded?.data;
  const problem = failed ?? loaded?.error?.message ?? (settings.status === 'error' || settings.status === 'invalid' ? settings.error : undefined);
  const rows = (provider: PeerOptions, saved: readonly string[]) => {
    const peer = `${agentLabel(provider.agent)} Peer`;
    const listed = provider.options.map(option => option.id);
    // Options allowed for an earlier model stay saved; shown so they can be turned off.
    const stale = saved.filter(option => !listed.includes(option));
    if (provider.options.length === 0 && stale.length === 0) {
      return [<SettingsRow key={provider.providerId} label={peer} hint={`${provider.model ?? 'No model'}: Paseo lists no thinking options for it, so its Peers keep their default.`} />];
    }
    return [
      ...provider.options.map(option => {
        const fixed = option.id === provider.defaultThinking;
        const delegates = isDelegating(option.id);
        const hint = fixed ? `${provider.model ?? 'Profile'} — the default, always allowed` : delegates ? 'Starts agents on its own — never offered to Lead' : provider.model ?? '';
        return (
          <SettingsSwitch key={`${provider.providerId}/${option.id}`} label={`${peer} · ${option.label}`} hint={hint}
            value={fixed || (!delegates && saved.includes(option.id))} disabled={fixed || delegates || saving}
            onValueChange={on => { toggle(provider.providerId, option.id, on); }} />
        );
      }),
      ...stale.map(option => (
        <SettingsSwitch key={`${provider.providerId}/${option}`} label={`${peer} · ${option}`} hint={`${provider.model ?? 'Its model'} does not offer this; turn it off`}
          value disabled={saving} onValueChange={on => { toggle(provider.providerId, option, on); }} />
      )),
    ];
  };
  return (
    <SettingsSection title="Thinking Lead may choose">
      <SettingsRow label="Per assignment, within what you allow"
        hint="Lead may choose a Peer's thinking per assignment, as its contract directs. The default is always allowed; any other option only when you turn it on." />
      {problem !== undefined ? <SettingsRow label="Unavailable" hint={problem} />
        : data === undefined || values === undefined ? <SettingsRow label="Loading…" />
          : !data.settingsAvailable ? <SettingsRow label="No settings store" hint="Paseo gives this plugin no settings store, so every Peer keeps its default." />
            : data.providers.flatMap(provider => rows(provider, values.allowedThinking[provider.providerId] ?? []))}
    </SettingsSection>
  );
}
