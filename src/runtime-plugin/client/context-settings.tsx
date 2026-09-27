/**
 * Settings › Room seats › Seat context (docs/design/runtime-coordination-seat-context.md K-D2,
 * §8.4): per role, the share of its context window past which a Lead's Supervisor is told, and at
 * which a Claude seat compacts. Marks are percent; the hint shows what they come to in tokens.
 * Every change saves at once.
 */
import { useSettings } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import {
  DEFAULT_SEAT_CONTEXT_SETTINGS, MAX_MARK_PERCENT, MIN_COMPACT_WINDOW, MIN_MARK_PERCENT, SEAT_CONTEXT_SETTINGS, compactWindow, formatTokens,
  type SeatContextSettings,
} from '../shared/seat-context.js';

type Budgets = SeatContextSettings['budgets'];

const OFF = 'off';
const PRESETS = Array.from({ length: (MAX_MARK_PERCENT - MIN_MARK_PERCENT) / 5 + 1 }, (_, index) => MIN_MARK_PERCENT + index * 5);
/** The window sizes room Claude models come in. */
const WINDOWS = [1_000_000, 200_000];

function options(current: number | null): { label: string; value: string }[] {
  const marks = [...new Set([...PRESETS, ...(current === null ? [] : [current])])].sort((a, b) => a - b);
  return [{ label: 'Off', value: OFF }, ...marks.map(mark => ({ label: `${String(mark)}%`, value: String(mark) }))];
}

const parse = (value: string): number | null => (value === OFF ? null : Number(value));

function compactHint(percent: number | null): string {
  if (percent === null) return 'Off: the agent compacts at its own default.';
  const on = WINDOWS.map(window => {
    const tokens = compactWindow(percent, window);
    return tokens === undefined
      ? `not applied on a ${formatTokens(window)} model (below ${formatTokens(MIN_COMPACT_WINDOW)})`
      : `${formatTokens(tokens)} on a ${formatTokens(window)} model`;
  });
  return `Claude compacts at ${on.join(', ')}.`;
}

export function SeatContextSection() {
  const settings = useSettings(SEAT_CONTEXT_SETTINGS);
  const toast = useToast();
  // One save at a time: each save sends the whole document at the revision it read.
  const [saving, setSaving] = useState(false);
  const save = (change: (budgets: Budgets) => Budgets): void => {
    if (settings.status !== 'ready' || saving) return;
    const budgets = change(settings.values.budgets);
    const { rotateAtPercent, compactAtPercent } = budgets.lead;
    if (rotateAtPercent !== null && compactAtPercent !== null && rotateAtPercent >= compactAtPercent) {
      toast.error('The Lead\'s rotation mark must be below its compact mark.');
      return;
    }
    setSaving(true);
    settings.save({ ...settings.values, budgets }, settings.revision)
      .then(saved => { if (!saved) toast.error('Not saved; reload and try again.'); }, (error: unknown) => { toast.error(String(error)); })
      .finally(() => { setSaving(false); });
  };

  if (settings.status !== 'ready') {
    const fallback = DEFAULT_SEAT_CONTEXT_SETTINGS.budgets.lead;
    return (
      <SettingsSection title="Seat context">
        {settings.status === 'loading' ? <SettingsRow label="Loading…" /> : (
          <SettingsRow label="Unavailable"
            hint={`${settings.error} The runtime keeps its defaults: a Lead is reported at ${String(fallback.rotateAtPercent)}% and compacts at ${String(fallback.compactAtPercent)}%.`} />
        )}
      </SettingsSection>
    );
  }
  const { lead, supervisor, peer } = settings.values.budgets;
  /** One mark's select: `set` writes the chosen mark (null for Off) into the budgets. */
  const markRow = (label: string, mark: number | null, hint: string, set: (budgets: Budgets, mark: number | null) => Budgets) => (
    <SettingsSelect label={label} value={mark === null ? OFF : String(mark)} options={options(mark)} disabled={saving} hint={hint}
      onValueChange={value => { save(budgets => set(budgets, parse(value))); }} />
  );
  return (
    <SettingsSection title="Seat context" info="A share of each seat's own context window, applied to the model it runs.">
      {markRow('Lead · report at', lead.rotateAtPercent,
        'Past it, the Lead\'s Supervisor is told once and the panel shows it, so you can start a fresh Lead. Applies at once.',
        (budgets, rotateAtPercent) => ({ ...budgets, lead: { ...budgets.lead, rotateAtPercent } }))}
      {markRow('Lead · compact at', lead.compactAtPercent, compactHint(lead.compactAtPercent),
        (budgets, compactAtPercent) => ({ ...budgets, lead: { ...budgets.lead, compactAtPercent } }))}
      {markRow('Supervisor · compact at', supervisor.compactAtPercent,
        supervisor.compactAtPercent === null ? 'Off: compacting a Supervisor early loses your conversation with it.' : compactHint(supervisor.compactAtPercent),
        (budgets, compactAtPercent) => ({ ...budgets, supervisor: { compactAtPercent } }))}
      {markRow('Peer · compact at', peer.compactAtPercent, compactHint(peer.compactAtPercent),
        (budgets, compactAtPercent) => ({ ...budgets, peer: { compactAtPercent } }))}
      <SettingsRow label="When a compact mark applies"
        hint="A Claude seat receives its mark when its session next opens: when it is created, or resumed after a daemon restart. A seat already past a new mark compacts at its first turn after it reopens. Codex and Pi seats show their context but keep their own compaction." />
    </SettingsSection>
  );
}
