import type { NormalizedIntent } from '../core/intent.js';
import type { CheckResult } from '../core/result.js';
import type { ManagedProvider, PaseoGateway, ProcessRunner, ReadonlyFileSystem, RuntimeIdentity } from '../core/seams.js';
import type { RoomRole } from '../room/roles.js';

export type { ManagedProvider } from '../core/seams.js';
export interface DiscoveryContext {
  readonly intent: NormalizedIntent;
  readonly filesystem: ReadonlyFileSystem;
  readonly process: ProcessRunner;
  readonly runtime: RuntimeIdentity;
  readonly environment: Readonly<Record<string, string | undefined>>;
}
/** Declarative managed artifacts, never credential bytes or hashes. */
export type ArtifactSpec =
  | { readonly kind: 'file'; readonly path: string; readonly mode: 0o600; readonly content: string }
  | { readonly kind: 'directory'; readonly path: string; readonly mode: 0o700 }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string };
export interface BuildArtifactsInput<Discovery> {
  readonly discovery: Discovery;
  readonly roomHome: string;
  readonly roleHomes: Readonly<Record<RoomRole, string>>;
}
export type ProviderInput<Discovery> = BuildArtifactsInput<Discovery>;
export interface VerifyRuntimeInput<Discovery> extends BuildArtifactsInput<Discovery> {
  readonly filesystem: ReadonlyFileSystem;
  readonly process: ProcessRunner;
  readonly gateway: PaseoGateway;
}
export interface AgentAdapter<Discovery> {
  readonly id: string;
  discover(context: DiscoveryContext): Promise<Discovery>;
  buildArtifacts(input: BuildArtifactsInput<Discovery>): Promise<ArtifactSpec[]>;
  buildProvider(role: RoomRole, input: ProviderInput<Discovery>): ManagedProvider;
  verifyRuntime(input: VerifyRuntimeInput<Discovery>): Promise<CheckResult[]>;
}
