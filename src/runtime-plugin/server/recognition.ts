/**
 * Exact room-provider recognition (docs/design/runtime-coordination.md §3.2, §3.3 Recognition).
 *
 * Only a provider id present verbatim in the generated manifest is a room seat. Titles, cwd,
 * labels and id prefixes never establish membership, and Paseo's internal agents are never
 * seats. Setup is the manifest's only writer; if it changes under a running plugin, new runtime
 * operations pause until the plugin is reloaded, while existing seats are left alone.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MANIFEST_FILE, runtimeRoomManifestSchema, type RuntimeManifestProvider, type RuntimeRoomManifestV1 } from '../shared/manifest.js';

export interface RecognizedSeat extends RuntimeManifestProvider {
  readonly providerId: string;
}

export type ManifestState =
  | { readonly status: 'ready'; readonly manifest: RuntimeRoomManifestV1 }
  | { readonly status: 'paused'; readonly reason: string; readonly manifest?: RuntimeRoomManifestV1 };

export async function readManifest(pluginDirectory: string): Promise<RuntimeRoomManifestV1> {
  const raw: unknown = JSON.parse(await readFile(join(pluginDirectory, MANIFEST_FILE), 'utf8'));
  const parsed = runtimeRoomManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The room manifest is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export class Recognition {
  private state: ManifestState = { status: 'paused', reason: 'The room manifest has not been loaded.' };

  constructor(private readonly pluginDirectory: string) {}

  get current(): ManifestState {
    return this.state;
  }

  /** Loads the manifest once, at plugin start. A missing or invalid one pauses the runtime. */
  async load(): Promise<ManifestState> {
    try {
      this.state = { status: 'ready', manifest: await readManifest(this.pluginDirectory) };
    } catch (error) {
      this.state = { status: 'paused', reason: error instanceof Error ? error.message : String(error) };
    }
    return this.state;
  }

  /**
   * Re-reads the manifest without adopting it. A different generation means setup rewrote it
   * under this running plugin: new operations pause until a reload, and nothing is discarded.
   */
  async checkDrift(): Promise<ManifestState> {
    if (this.state.status !== 'ready') return this.state;
    const loaded = this.state.manifest;
    let fresh: RuntimeRoomManifestV1;
    try {
      fresh = await readManifest(this.pluginDirectory);
    } catch (error) {
      this.state = { status: 'paused', reason: error instanceof Error ? error.message : String(error), manifest: loaded };
      return this.state;
    }
    if (fresh.roomGeneration !== loaded.roomGeneration || fresh.reportingPolicyGeneration !== loaded.reportingPolicyGeneration) {
      this.state = { status: 'paused', reason: 'The room manifest changed since this plugin started; reload the runtime plugin.', manifest: loaded };
    }
    return this.state;
  }

  /** The exact seat for a provider id, or undefined. Internal agents are never seats. */
  recognize(provider: string, internal = false): RecognizedSeat | undefined {
    if (internal || this.state.status !== 'ready') return undefined;
    const entry = Object.hasOwn(this.state.manifest.providers, provider) ? this.state.manifest.providers[provider] : undefined;
    return entry === undefined ? undefined : { ...entry, providerId: provider };
  }

  /** Exact Peer providers this room offers for dispatch. */
  peerProviders(): readonly string[] {
    if (this.state.status !== 'ready') return [];
    return Object.entries(this.state.manifest.providers).filter(([, entry]) => entry.role === 'peer' && entry.peerReporting !== undefined).map(([id]) => id);
  }
}
