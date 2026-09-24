/**
 * Registers a composer pill on every live room seat — Supervisor, Lead or Peer — so its role is
 * visible where the agent is used, without renaming it. The room is re-read every 20 s; a pill is
 * added, redrawn or removed only when its seat changes. A missing runtime simply means no pills.
 */
import type { PluginButton, PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Text, View } from 'react-native';
import { runtimeRoomRpc } from '../shared/rpc-contracts.js';
import { unwrap } from './data.js';
import { Button, Glyph, SPACE } from './kit.js';
import type { RoomView } from './model.js';
import { ROLE_PILL, pillKey, rolePills, type RolePill, type SeatRole } from './pills.js';

export const ROLE_REFRESH_MS = 20_000;

function roleIcon(role: SeatRole) {
  return function RoleIcon(props: PluginButtonIconProps) {
    const color = role === 'supervisor' ? props.theme.colors.accent : role === 'lead' ? props.theme.colors.foreground : props.color;
    return <Icon name={ROLE_PILL[role].icon} size={props.size} color={color} />;
  };
}

function popover(pill: RolePill, openRoom: () => void) {
  return function RolePopover(props: PluginButtonContentProps) {
    const { colors } = props.theme;
    return (
      <View style={{ padding: SPACE.md, minWidth: 260, maxWidth: 360, gap: SPACE.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <Glyph theme={props.theme} name={ROLE_PILL[pill.role].icon} tone={pill.role === 'supervisor' ? 'accent' : 'neutral'} boxed />
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600', flex: 1 }}>{pill.title}</Text>
        </View>
        {pill.lines.map(([label, value]) => (
          <View key={label} style={{ flexDirection: 'row', gap: SPACE.sm }}>
            <Text style={{ width: 78, color: colors.foregroundMuted, fontSize: 12.5 }}>{label}</Text>
            <Text style={{ flex: 1, color: colors.foreground, fontSize: 12.5 }}>{value}</Text>
          </View>
        ))}
        <View style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Button theme={props.theme} small label="Open Room runtime" icon="Workflow" onPress={() => { props.close(); openRoom(); }} />
        </View>
      </View>
    );
  };
}

function buttonFor(pill: RolePill, openRoom: () => void): PluginButton {
  return { title: pill.title, label: pill.label, icon: roleIcon(pill.role), behavior: { kind: 'popover', Content: popover(pill, openRoom) } };
}

/** Starts keeping role pills in step with the room; returns the cleanup. */
export function startRolePills(client: Pick<PluginClientContext, 'rpc' | 'addComposerPill' | 'openSurface'>, surfaceId: string): () => void {
  const registered = new Map<string, { readonly registration: PluginButtonRegistration; readonly key: string; readonly workspaceId: string }>();
  const openRoom = (): void => { client.openSurface(surfaceId); };
  const run = { stopped: false, busy: false };
  // Read through a call, so a stop during the awaited read is seen after it.
  const stopped = (): boolean => run.stopped;

  const sync = async (): Promise<void> => {
    if (stopped() || run.busy) return;
    run.busy = true;
    try {
      const room = unwrap<RoomView>(await client.rpc(runtimeRoomRpc, {})).data;
      if (room === undefined || stopped()) return;
      const pills = rolePills(room);
      const live = new Set(pills.map(pill => pill.agentId));
      for (const [agentId, entry] of registered) {
        if (!live.has(agentId)) { entry.registration.remove(); registered.delete(agentId); }
      }
      for (const pill of pills) {
        const key = pillKey(pill);
        const known = registered.get(pill.agentId);
        if (known !== undefined && known.workspaceId === pill.workspaceId) {
          if (known.key !== key) { known.registration.update(buttonFor(pill, openRoom)); registered.set(pill.agentId, { ...known, key }); }
          continue;
        }
        known?.registration.remove();
        const registration = client.addComposerPill({ id: `room-role-${pill.agentId}`, workspaceId: pill.workspaceId, agentId: pill.agentId, button: buttonFor(pill, openRoom) });
        registered.set(pill.agentId, { registration, key, workspaceId: pill.workspaceId });
      }
    } catch {
      // The runtime is not reachable yet; the next pass tries again.
    } finally {
      run.busy = false;
    }
  };

  void sync();
  const timer = setInterval(() => { void sync(); }, ROLE_REFRESH_MS);
  return () => {
    run.stopped = true;
    clearInterval(timer);
    for (const entry of registered.values()) entry.registration.remove();
    registered.clear();
  };
}
