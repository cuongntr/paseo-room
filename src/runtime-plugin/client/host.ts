/**
 * Host capabilities the client entry receives once and screens use later — today only opening
 * the plugin's own settings screens. Absent on hosts that do not offer it; callers hide the control.
 */
let openSettingsScreen: ((id: string) => void) | undefined;

export function bindHost(host: { readonly openSettings?: (id: string) => void }): void {
  openSettingsScreen = host.openSettings;
}

export function openSettings(id: string): (() => void) | undefined {
  const open = openSettingsScreen;
  return open === undefined ? undefined : () => { open(id); };
}

export const ATTENTION_SETTINGS_SCREEN = 'paseo-room-attention';
export const SEATS_SETTINGS_SCREEN = 'paseo-room-seats';
