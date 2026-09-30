/**
 * Settings › Room seats › Seat context (docs/design/runtime-coordination-seat-context.md K-D2,
 * §8.4): per role, the share of its context window past which a Lead's Supervisor is told, and at
 * which a Claude seat compacts. Marks are percent; the hint shows what they come to in tokens, and
 * a bar shows the Lead's two marks as zones of its context. Every change saves at once.
 */
import { useSettings } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  DEFAULT_SEAT_CONTEXT_SETTINGS, MAX_MARK_PERCENT, MIN_MARK_PERCENT, MIN_MARK_TOKENS, SEAT_CONTEXT_SETTINGS, formatTokens, markTokens,
  type SeatContextSettings,
} from '../shared/seat-context.js';
import { tint, type Theme } from './kit.js';

type Budgets = SeatContextSettings['budgets'];

const OFF = 'off';
const PRESETS = Array.from({ length: (MAX_MARK_PERCENT - MIN_MARK_PERCENT) / 5 + 1 }, (_, index) => MIN_MARK_PERCENT + index * 5);
/** The window sizes room Claude models come in. */
const CLAUDE_WINDOWS = [1_000_000, 200_000];
/** The Lead's report mark reaches every agent; today's Codex models run 272k, in Codex or in Pi. */
const LEAD_WINDOWS = [1_000_000, 272_000, 200_000];

function options(current: number | null): { label: string; value: string }[] {
  const marks = [...new Set([...PRESETS, ...(current === null ? [] : [current])])].sort((a, b) => a - b);
  return [{ label: 'Off', value: OFF }, ...marks.map(mark => ({ label: `${String(mark)}%`, value: String(mark) }))];
}

const parse = (value: string): number | null => (value === OFF ? null : Number(value));

/** `a, b or c`. */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}

/** What a mark comes to on each window: `400k on a 1M model; not applied on a 272k or 200k model (below 150k)`. */
function onWindows(percent: number, windows: readonly number[]): string {
  const applied: string[] = [];
  const not: string[] = [];
  for (const size of windows) {
    const tokens = markTokens(percent, size);
    if (tokens === undefined) not.push(formatTokens(size));
    else applied.push(`${formatTokens(tokens)} on a ${formatTokens(size)} model`);
  }
  const skipped = not.length === 0 ? [] : [`not applied on a ${orList(not)} model (below ${formatTokens(MIN_MARK_TOKENS)})`];
  return [applied.join(', '), ...skipped].filter(part => part !== '').join('; ');
}

function reportHint(percent: number | null): string {
  if (percent === null) return 'Off: no Lead is reported, and only you replace one.';
  return `Past it, the Lead's Supervisor is told once and the panel shows it, so you can start a fresh Lead. Applies at once: ${onWindows(percent, LEAD_WINDOWS)}.`;
}

function compactHint(percent: number | null): string {
  if (percent === null) return 'Off: the agent compacts at its own default.';
  return `Claude compacts at ${onWindows(percent, CLAUDE_WINDOWS)}.`;
}

/** A window as zones: calm below the report mark, amber to the compact mark, red past it. */
function MarkScale(props: { readonly theme: Theme; readonly report: number | null; readonly compact: number | null }) {
  const { colors } = props.theme;
  const width = 180;
  const at = (percent: number): number => Math.round((width * percent) / 100);
  const report = props.report ?? props.compact ?? 100;
  const compact = props.compact ?? 100;
  const zone = (from: number, to: number, color: string) => (to <= from ? null : <View style={{ position: 'absolute', left: at(from), width: at(to) - at(from), top: 0, bottom: 0, backgroundColor: color }} />);
  const label = [props.report === null ? undefined : `report ${String(props.report)}%`, props.compact === null ? undefined : `compact ${String(props.compact)}%`].filter(part => part !== undefined).join(' · ');
  return (
    <View accessibilityLabel={`Lead marks: ${label === '' ? 'none' : label}`} style={{ alignItems: 'flex-end', gap: 4 }}>
      <View style={{ width, height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}>
        {zone(report, compact, tint(colors.statusWarning, 0.55))}
        {zone(compact, 100, tint(colors.statusDanger, 0.55))}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{label === '' ? 'No marks' : label}</Text>
    </View>
  );
}

export function SeatContextSection(props: { readonly theme: Theme }) {
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
    <SettingsSection title="Seat context" info={`A share of each seat's own context window, applied to the model it runs. A mark that comes to less than ${formatTokens(MIN_MARK_TOKENS)} there does not apply: the seat keeps its agent's own compaction, and a Lead is not reported.`}>
      <SettingsRow label="Lead" hint="Past the report mark its Supervisor is told and the panel shows it; at the compact mark Claude compacts.">
        <MarkScale theme={props.theme} report={lead.rotateAtPercent} compact={lead.compactAtPercent} />
      </SettingsRow>
      {markRow('Lead · report at', lead.rotateAtPercent, reportHint(lead.rotateAtPercent),
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
