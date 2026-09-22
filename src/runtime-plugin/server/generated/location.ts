/**
 * Where this room's runtime lives. Setup rewrites this file for each room; the checked-in copy
 * is a placeholder so the plugin source typechecks, and a plugin built from it stays paused.
 * Paseo evaluates the compiled plugin from memory, so the plugin cannot discover its own path.
 */
export interface RoomLocation {
  readonly pluginDirectory: string;
  readonly runtimeRoot: string;
}

export const ROOM_LOCATION: RoomLocation | undefined = undefined;
