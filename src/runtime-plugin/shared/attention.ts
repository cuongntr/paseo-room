/**
 * Room attention settings (docs/design/runtime-coordination-attention.md §8.3). Shared by the
 * server, which reads them, and the Settings screen, which edits them through Paseo's host
 * settings store. A stored `sensor` object or `quietHours` from a release before 0.15.0 is ignored.
 */
import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

const minutes = (value: number) => z.number().int().min(1).max(24 * 60).default(value);

export const attentionSettingsSchema = z.object({
  letters: z.object({
    /** The Observer always runs for the panel; this gates letters to Supervisors. */
    enabled: z.boolean().default(true),
  }).prefault({}),
  delivery: z.object({
    permissionMinutes: minutes(5),
    peerUnreadMinutes: minutes(10),
    orphanHours: z.number().int().min(1).max(24 * 14).default(24),
    digestMinutes: minutes(15),
    wakesPerHour: z.number().int().min(1).max(60).default(6),
    pageHoldSeconds: z.number().int().min(0).max(3_600).default(60),
    envelopeGraceSeconds: z.number().int().min(0).max(600).default(20),
  }).prefault({}),
});

export type AttentionSettings = z.output<typeof attentionSettingsSchema>;

export const ATTENTION_SETTINGS = defineSettings({ id: 'attention', scope: 'host', version: 1, schema: attentionSettingsSchema });

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = attentionSettingsSchema.parse({});

