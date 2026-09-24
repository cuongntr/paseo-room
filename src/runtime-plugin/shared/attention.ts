/**
 * Room attention settings (docs/design/runtime-coordination-attention.md §8.3). Shared by the
 * server, which reads them, and the Settings screen, which edits them through Paseo's host
 * settings store. The sensor key is never a setting: it is written through its own write-only RPC.
 */
import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const SENSOR_MODES = ['off', 'shadow', 'assist'] as const;
export type SensorMode = (typeof SENSOR_MODES)[number];

export const QUESTION_SETS = ['lead-turn-v1', 'peer-report-v1'] as const;
export type QuestionSetId = (typeof QUESTION_SETS)[number];

export const DEFAULT_SENSOR_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_SENSOR_MODEL = 'jev-1.13.0';

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
    quietHours: z.number().int().min(1).max(24 * 7).default(4),
    digestMinutes: minutes(15),
    wakesPerHour: z.number().int().min(1).max(60).default(6),
    pageHoldSeconds: z.number().int().min(0).max(3_600).default(60),
    envelopeGraceSeconds: z.number().int().min(0).max(600).default(20),
  }).prefault({}),
  sensor: z.object({
    mode: z.enum(SENSOR_MODES).default('off'),
    endpoint: z.url().default(DEFAULT_SENSOR_ENDPOINT),
    model: z.string().min(1).max(128).default(DEFAULT_SENSOR_MODEL),
    timeoutMs: z.number().int().min(200).max(60_000).default(3_000),
    maskNetworkIdentifiers: z.boolean().default(true),
    /** The endpoint host the operator acknowledged sending masked excerpts to; null until then. */
    egressAcknowledgedHost: z.string().max(253).nullable().default(null),
    assistQuestionSets: z.array(z.enum(QUESTION_SETS)).max(QUESTION_SETS.length).default([]),
  }).prefault({}),
});

export type AttentionSettings = z.output<typeof attentionSettingsSchema>;

export const ATTENTION_SETTINGS = defineSettings({ id: 'attention', scope: 'host', version: 1, schema: attentionSettingsSchema });

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = attentionSettingsSchema.parse({});

/** Whether a host is this machine: a loopback endpoint needs no egress acknowledgement. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** Why the sensor may not send, or undefined when it may. The key is checked by the caller. */
export function egressRefusal(sensor: AttentionSettings['sensor']): string | undefined {
  if (sensor.mode === 'off') return 'The sensor is off.';
  let host: string;
  try {
    host = new URL(sensor.endpoint).hostname;
  } catch {
    return 'The sensor endpoint is not a valid URL.';
  }
  if (isLoopbackHost(host)) return undefined;
  return sensor.egressAcknowledgedHost === host ? undefined : `Sending to ${host} has not been acknowledged in Settings.`;
}
