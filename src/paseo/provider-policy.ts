import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { ManagedProvider } from '../core/seams.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';

// Discovery owns filesystem realpath/ownership checks. This boundary only accepts
// already-canonical declarations; it never resolves paths or reads credentials.
const canonicalPath = z.string().refine(path => isAbsolute(path) && normalize(path) === path &&
  path !== '/' && !/\p{Cc}/u.test(path));
const executablePath = canonicalPath.refine(path => !path.split('/').some(part => part === '_npx' || part === '_cacache'));
const command = z.union([z.tuple([executablePath]), z.tuple([executablePath, executablePath])]);
function entry<const Label extends string, const Enabled extends boolean>(label: Label, enabled: Enabled) {
  return z.strictObject({ extends: z.literal('codex'), label: z.literal(label), command,
    env: z.strictObject({ CODEX_HOME: canonicalPath }), paseoTools: z.strictObject({ enabled: z.literal(enabled) }) });
}
const entries = {
  'codex-supervisor': entry('Codex Supervisor', true),
  'codex-lead': entry('Codex Lead', true),
  'codex-peer': entry('Codex Peer', false),
};
const policySchema = z.strictObject(entries).refine(policy =>
  new Set(MANAGED_PROVIDER_IDS.map(id => policy[id].env.CODEX_HOME)).size === MANAGED_PROVIDER_IDS.length);
export type ProviderPolicy = z.infer<typeof policySchema>;
export type ProviderOverrideV1 = ProviderPolicy[ManagedProviderId];

/** Unknown/missing keys fail, rather than being stripped into an ownership match. */
export function validateProviderEntry(id: ManagedProviderId, value: unknown): ProviderOverrideV1 {
  if (!Object.hasOwn(entries, id)) throw new Error('Invalid managed provider ID.');
  const result = entries[id].safeParse(value);
  if (!result.success) throw new Error('Invalid managed provider entry; rediscover the fixed Phase 1 profile.');
  return result.data;
}
export function validateProviderPolicy(value: unknown): ProviderPolicy {
  const result = policySchema.safeParse(value);
  if (!result.success) throw new Error('Invalid managed provider policy; supply exactly three fixed profiles with distinct canonical homes.');
  return result.data;
}
/** Adapter declarations are cloned and checked without truncating launch tuples. */
export function buildProviderPolicy(providers: Readonly<Record<ManagedProviderId, ManagedProvider>>): ProviderPolicy {
  return validateProviderPolicy(providers);
}
/** Schema parsing fixes object key order but preserves array order and every value. */
export function providerEntriesEqual(id: ManagedProviderId, left: unknown, right: unknown): boolean {
  try { return JSON.stringify(validateProviderEntry(id, left)) === JSON.stringify(validateProviderEntry(id, right)); }
  catch { return false; }
}
export function providerPoliciesEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(validateProviderPolicy(left)) === JSON.stringify(validateProviderPolicy(right)); }
  catch { return false; }
}
