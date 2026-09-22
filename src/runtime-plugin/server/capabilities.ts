/**
 * Per-generation Peer capabilities (docs/design/runtime-coordination.md §3.4).
 *
 * Immediately before each turn the controller opens a reporting generation, records only the
 * hash of a fresh opaque capability, and then publishes the capability for the Peer's bridge.
 * The bridge embeds it in each call; the Peer never sees or submits it. A capability is scoped
 * routing evidence that makes a report attributable to one generation — it is not a security
 * boundary against another process running as the same user.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './domain/receipts.js';
import { ensurePrivateDirectory, publishOnce } from './store/publish.js';

export interface IssuedCapability {
  readonly generation: number;
  readonly capability: string;
  readonly hash: string;
}

export function mintCapability(generation: number): IssuedCapability {
  const capability = `cap_${randomBytes(24).toString('hex')}`;
  return { generation, capability, hash: sha256(capability) };
}

function fileName(correlationId: string, generation: number): string {
  return `${correlationId}.${String(generation).padStart(6, '0')}.json`;
}

/** Published once per generation; a generation's capability is never replaced. */
export async function publishCapability(directory: string, correlationId: string, issued: IssuedCapability): Promise<void> {
  await ensurePrivateDirectory(directory);
  await publishOnce(directory, fileName(correlationId, issued.generation), `${JSON.stringify({ schema: 1, generation: issued.generation, capability: issued.capability })}\n`);
}

/** The newest published capability for a correlation, as the bridge would read it. */
export async function latestCapability(directory: string, correlationId: string): Promise<{ generation: number; capability: string } | undefined> {
  let names: string[];
  try { names = await readdir(directory); } catch { return undefined; }
  const latest = names.filter(name => name.startsWith(`${correlationId}.`) && name.endsWith('.json')).sort().at(-1);
  if (latest === undefined) return undefined;
  const parsed = JSON.parse(await readFile(join(directory, latest), 'utf8')) as { generation: number; capability: string };
  return { generation: parsed.generation, capability: parsed.capability };
}
