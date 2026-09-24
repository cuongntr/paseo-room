/**
 * The panel's visual kit (docs/design/runtime-panel-ux.md §3): Paseo's theme tokens, Lucide icons
 * and host controls, composed into the few shapes every screen uses — a centred page, section
 * labels, cards of rows, pills, buttons, fields and callouts. Nothing here knows the runtime.
 */
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, TextInput } from '@getpaseo/plugin/client/react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View, type PressableStateCallbackType, type ViewStyle } from 'react-native';
import type { Tone } from './tone.js';

export type Theme = PluginSurfaceProps['theme'];
export type { Tone } from './tone.js';

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const MAX_WIDTH = 760;

/** A translucent version of a theme colour, for tinted pills and callouts; opaque when not hex. */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) return color;
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  const channel = (index: number): number => Number.parseInt(full.slice(index, index + 2), 16);
  return `rgba(${String(channel(0))}, ${String(channel(2))}, ${String(channel(4))}, ${String(alpha)})`;
}

export function toneColor(theme: Theme, tone: Tone): string {
  const { colors } = theme;
  switch (tone) {
    case 'success': return colors.statusSuccess;
    case 'warning': return colors.statusWarning;
    case 'danger': return colors.statusDanger;
    case 'accent': return colors.accent;
    case 'muted': return colors.foregroundMuted;
    default: return colors.foreground;
  }
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return '';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}

const hovered = (state: PressableStateCallbackType): boolean => (state as { hovered?: boolean }).hovered === true;

export function Page(props: { readonly theme: Theme; readonly compact: boolean; readonly children: ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
      <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: props.compact ? SPACE.md : SPACE.xl, paddingTop: props.compact ? SPACE.md : SPACE.xl, paddingBottom: 48 }}>
        {props.children}
      </View>
    </View>
  );
}

export function Title(props: { readonly theme: Theme; readonly children: ReactNode; readonly subtitle?: ReactNode; readonly trailing?: ReactNode; readonly leading?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: SPACE.lg, gap: SPACE.md, flexWrap: 'wrap' }}>
      {props.leading}
      <View style={{ flex: 1, minWidth: 180 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 19, fontWeight: '600' }}>{props.children}</Text>
        {props.subtitle === undefined ? null : <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 }}>{props.subtitle}</Text>}
      </View>
      {props.trailing === undefined ? null : <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>{props.trailing}</View>}
    </View>
  );
}

export function SectionLabel(props: { readonly theme: Theme; readonly children: ReactNode; readonly trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: SPACE.xl, marginBottom: SPACE.sm, paddingHorizontal: 2 }}>
      <Text style={{ flex: 1, color: props.theme.colors.foregroundMuted, fontSize: 12.5, fontWeight: '500' }}>{props.children}</Text>
      {props.trailing}
    </View>
  );
}

export function Card(props: { readonly theme: Theme; readonly children: ReactNode; readonly tone?: Tone; readonly style?: ViewStyle }) {
  const border = props.tone === undefined || props.tone === 'neutral' ? props.theme.colors.border : toneColor(props.theme, props.tone);
  return (
    <View style={{ backgroundColor: props.theme.colors.surface1, borderWidth: 1, borderColor: border, borderRadius: 10, overflow: 'hidden', ...props.style }}>
      {props.children}
    </View>
  );
}

/** One row of a card; pressable when `onPress` is given, with a divider above all but the first. */
export function Row(props: {
  readonly theme: Theme; readonly first?: boolean; readonly onPress?: () => void; readonly accessibilityLabel?: string;
  readonly leading?: ReactNode; readonly title: ReactNode; readonly subtitle?: ReactNode; readonly meta?: ReactNode; readonly trailing?: ReactNode; readonly indent?: number;
}) {
  const { colors } = props.theme;
  const body = (pressedOrHovered: boolean) => (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 11, paddingRight: SPACE.lg, paddingLeft: SPACE.lg + (props.indent ?? 0) * 20,
      borderTopWidth: props.first === true ? 0 : 1, borderColor: colors.border, backgroundColor: pressedOrHovered ? colors.surface2 : 'transparent',
    }}>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>{props.title}</Text>
        {props.subtitle === undefined ? null : <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12.5, marginTop: 2 }}>{props.subtitle}</Text>}
        {props.meta === undefined ? null : <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11.5, marginTop: 2, opacity: 0.85 }}>{props.meta}</Text>}
      </View>
      {props.trailing === undefined ? null : <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>{props.trailing}</View>}
    </View>
  );
  if (props.onPress === undefined) return body(false);
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel}>
      {state => body(state.pressed || hovered(state))}
    </Pressable>
  );
}

export function Pill(props: { readonly theme: Theme; readonly tone?: Tone; readonly icon?: string; readonly children: ReactNode }) {
  const color = toneColor(props.theme, props.tone ?? 'muted');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint(color, 0.14), borderWidth: 1, borderColor: tint(color, 0.28) }}>
      {props.icon === undefined ? null : <Icon name={props.icon} size={11} color={color} />}
      <Text numberOfLines={1} style={{ color, fontSize: 11.5, fontWeight: '500' }}>{props.children}</Text>
    </View>
  );
}

export function Dot(props: { readonly theme: Theme; readonly tone: Tone; readonly size?: number }) {
  const size = props.size ?? 8;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor(props.theme, props.tone) }} />;
}

export function Glyph(props: { readonly theme: Theme; readonly name: string; readonly tone?: Tone; readonly size?: number; readonly boxed?: boolean }) {
  const color = toneColor(props.theme, props.tone ?? 'muted');
  if (props.boxed !== true) return <Icon name={props.name} size={props.size ?? 16} color={color} />;
  return (
    <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(color, 0.12) }}>
      <Icon name={props.name} size={props.size ?? 16} color={color} />
    </View>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button(props: {
  readonly theme: Theme; readonly label: string; readonly onPress: () => void; readonly variant?: ButtonVariant; readonly icon?: string;
  readonly disabled?: boolean; readonly busy?: boolean; readonly grow?: boolean; readonly small?: boolean;
}) {
  const { colors } = props.theme;
  const variant = props.variant ?? 'secondary';
  const inactive = props.disabled === true || props.busy === true;
  const foreground = variant === 'primary' ? colors.accentForeground : variant === 'danger' ? colors.statusDanger : colors.foreground;
  return (
    <Pressable onPress={inactive ? undefined : props.onPress} accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ disabled: inactive, busy: props.busy === true }}
      style={state => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flexGrow: props.grow === true ? 1 : 0,
        paddingHorizontal: props.small === true ? 10 : 14, paddingVertical: props.small === true ? 5 : 8, borderRadius: 8, opacity: inactive ? 0.5 : 1,
        borderWidth: variant === 'ghost' || variant === 'primary' ? 0 : 1,
        borderColor: variant === 'danger' ? tint(colors.statusDanger, 0.5) : colors.border,
        backgroundColor: variant === 'primary'
          ? colors.accent
          : (state.pressed || hovered(state)) && !inactive ? colors.surface2 : variant === 'ghost' ? 'transparent' : colors.surface1,
      })}>
      {props.busy === true ? <ActivityIndicator size="small" color={foreground} /> : props.icon === undefined ? null : <Icon name={props.icon} size={14} color={foreground} />}
      <Text style={{ color: foreground, fontSize: props.small === true ? 12.5 : 13.5, fontWeight: '500' }}>{props.label}</Text>
    </Pressable>
  );
}

export function IconButton(props: { readonly theme: Theme; readonly icon: string; readonly label: string; readonly onPress: () => void; readonly active?: boolean; readonly tone?: Tone }) {
  const color = props.active === true ? toneColor(props.theme, props.tone ?? 'accent') : props.theme.colors.foregroundMuted;
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ selected: props.active === true }}
      style={state => ({ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: state.pressed || hovered(state) || props.active === true ? props.theme.colors.surface2 : 'transparent' })}>
      <Icon name={props.icon} size={15} color={color} />
    </Pressable>
  );
}

export function Field(props: { readonly theme: Theme; readonly label: string; readonly hint?: string; readonly error?: string; readonly children: ReactNode; readonly optional?: boolean }) {
  const { colors } = props.theme;
  return (
    <View style={{ marginBottom: SPACE.lg }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '500', marginBottom: 6 }}>
        {props.label}{props.optional === true ? <Text style={{ color: colors.foregroundMuted, fontWeight: '400' }}>  optional</Text> : null}
      </Text>
      {props.children}
      {props.error !== undefined
        ? <Text style={{ color: colors.statusDanger, fontSize: 12, marginTop: 6 }}>{props.error}</Text>
        : props.hint === undefined ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>{props.hint}</Text>}
    </View>
  );
}

export function Input(props: {
  readonly theme: Theme; readonly value: string; readonly onChange: (text: string) => void; readonly placeholder?: string;
  readonly multiline?: boolean; readonly invalid?: boolean; readonly onSubmit?: () => void; readonly autoFocus?: boolean; readonly mono?: boolean;
}) {
  const { colors } = props.theme;
  return (
    <TextInput value={props.value} onChangeText={props.onChange} placeholder={props.placeholder} placeholderTextColor={colors.foregroundMuted}
      multiline={props.multiline === true} autoCapitalize="none" autoCorrect={false} autoFocus={props.autoFocus === true}
      {...(props.onSubmit === undefined ? {} : { onSubmitEditing: props.onSubmit })}
      style={{
        color: colors.foreground, backgroundColor: colors.surface2, borderWidth: 1, borderColor: props.invalid === true ? colors.statusDanger : colors.border,
        borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13.5, minHeight: props.multiline === true ? 88 : undefined,
        textAlignVertical: props.multiline === true ? 'top' : 'center', ...(props.mono === true ? { fontFamily: 'monospace' } : {}),
      }} />
  );
}

export function Segmented<Value extends string>(props: { readonly theme: Theme; readonly value: Value | undefined; readonly options: readonly { readonly value: Value; readonly label: string; readonly icon?: string }[]; readonly onChange: (value: Value) => void }) {
  const { colors } = props.theme;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.surface2, borderRadius: 8, padding: 3, gap: 3, alignSelf: 'flex-start' }}>
      {props.options.map(option => {
        const selected = option.value === props.value;
        return (
          <Pressable key={option.value} onPress={() => { props.onChange(option.value); }} accessibilityRole="button" accessibilityState={{ selected }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: selected ? colors.surface0 : 'transparent', borderWidth: selected ? 1 : 0, borderColor: colors.border }}>
            {option.icon === undefined ? null : <Icon name={option.icon} size={13} color={selected ? colors.foreground : colors.foregroundMuted} />}
            <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 13, fontWeight: selected ? '600' : '400' }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A selectable card row with a radio mark. */
export function Choice(props: { readonly theme: Theme; readonly selected: boolean; readonly onPress: () => void; readonly title: string; readonly subtitle?: string; readonly first?: boolean }) {
  const { colors } = props.theme;
  return (
    <Row theme={props.theme} first={props.first === true} onPress={props.onPress} accessibilityLabel={props.title} title={props.title}
      {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
      leading={(
        <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: props.selected ? 5 : 1.5, borderColor: props.selected ? colors.accent : colors.foregroundMuted }} />
      )} />
  );
}

export function Callout(props: { readonly theme: Theme; readonly tone: Tone; readonly icon: string; readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  const color = toneColor(props.theme, props.tone);
  return (
    <View style={{ flexDirection: 'row', gap: SPACE.md, padding: SPACE.md, borderRadius: 10, borderWidth: 1, borderColor: tint(color, 0.55), backgroundColor: tint(color, 0.07), marginBottom: SPACE.md }}>
      <View style={{ paddingTop: 1 }}><Icon name={props.icon} size={16} color={color} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color, fontSize: 13.5, fontWeight: '600' }}>{props.title}</Text>
        {props.children === undefined ? null : <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12.5, marginTop: 3, lineHeight: 18 }}>{props.children}</Text>}
        {props.action === undefined ? null : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm }}>{props.action}</View>}
      </View>
    </View>
  );
}

export function Empty(props: { readonly theme: Theme; readonly icon: string; readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  const { colors } = props.theme;
  return (
    <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: SPACE.lg }}>
      <Glyph theme={props.theme} name={props.icon} boxed size={18} />
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600', marginTop: SPACE.md }}>{props.title}</Text>
      {props.children === undefined ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 12.5, marginTop: 4, textAlign: 'center', maxWidth: 420, lineHeight: 18 }}>{props.children}</Text>}
      {props.action === undefined ? null : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.lg, justifyContent: 'center' }}>{props.action}</View>}
    </View>
  );
}

export function Loading(props: { readonly theme: Theme; readonly label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xl, justifyContent: 'center' }}>
      <ActivityIndicator size="small" color={props.theme.colors.foregroundMuted} />
      <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 13 }}>{props.label}</Text>
    </View>
  );
}

/** A modal's action bar: secondary actions left, the primary action last. */
export function Actions(props: { readonly children: ReactNode }) {
  return <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm }}>{props.children}</View>;
}

/** Short label/value pairs, for detail cards. */
export function Facts(props: { readonly theme: Theme; readonly items: readonly (readonly [string, ReactNode])[] }) {
  const { colors } = props.theme;
  return (
    <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, gap: 8 }}>
      {props.items.map(([label, value]) => (
        <View key={label} style={{ flexDirection: 'row', gap: SPACE.md }}>
          <Text style={{ width: 132, color: colors.foregroundMuted, fontSize: 12.5 }}>{label}</Text>
          <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: 12.5 }}>{value}</Text>
        </View>
      ))}
    </View>
  );
}
