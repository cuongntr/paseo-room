/**
 * Peer effort settings (docs/design/runtime-coordination-peer-effort.md §3). Shared by the server,
 * which validates a dispatch against them, and the Room seats screen, which edits them through
 * Paseo's host settings store. The envelope is the operator's cost decision: per room Peer provider,
 * the thinking options Lead may choose besides the profile's own, which is always allowed.
 */
import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * The thinking options Paseo advertises as including automatic task delegation — a second control
 * plane. Never a Lead choice and never offered in Settings, whatever the envelope says. Kept equal to
 * `DELEGATING_THINKING` in `src/roles.ts` by test, since the plugin may not import the CLI.
 */
export const DELEGATING_THINKING = ['ultra', 'ultracode'] as const;

export const isDelegating = (option: string): boolean => (DELEGATING_THINKING as readonly string[]).includes(option);

export const peerEffortSettingsSchema = z.object({
  allowedThinking: z.record(z.string().min(1).max(128), z.array(z.string().min(1).max(64)).max(16)).default({}),
});

export type PeerEffortSettings = z.output<typeof peerEffortSettingsSchema>;

export const PEER_EFFORT_SETTINGS = defineSettings({ id: 'peer-effort', scope: 'host', version: 1, schema: peerEffortSettingsSchema });

export const DEFAULT_PEER_EFFORT_SETTINGS: PeerEffortSettings = peerEffortSettingsSchema.parse({});
