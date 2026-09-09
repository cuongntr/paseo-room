import type { ManagedProviderId } from '../room/roles.js';

/** lstat metadata: implementations must not follow links to obtain this record. */
export interface FileMetadata {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly mode: number;
  readonly device: number;
  readonly inode: number;
  readonly links: number;
  readonly uid: number;
}
/** Hash only after child cwd matches the previously accepted immediate parent,
 * then O_NOFOLLOW open/fstat matches the leaf. No file bytes cross this seam. */
export interface GuardedFileHasher {
  hashFileNoFollow(path: string, parent: FileMetadata, expected: FileMetadata,
    forbidden: readonly Pick<FileMetadata, 'device' | 'inode'>[]): Promise<string>;
}
export interface ReadonlyFileSystem {
  lstat(path: string): Promise<FileMetadata | null>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<readonly string[]>;
  /** Callers must validate ownership/link safety before reading; never read credentials. */
  readFile(path: string): Promise<Uint8Array>;
}
export interface ProcessRunner {
  run(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly shell: false;
  }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}
export interface RuntimeIdentity {
  now(): Date;
  readonly pid: number;
  isProcessAlive(pid: number): Promise<boolean>;
}
/** Complete fixed-key entry, independent of SDK implementation types. */
export interface ManagedProvider {
  readonly extends: string;
  readonly label: string;
  readonly command: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  readonly paseoTools: { readonly enabled: boolean };
}
export interface GatewaySnapshot {
  readonly localHome: string;
  readonly listen: string;
  readonly endpointIdentitySha256: string;
  readonly cliVersion: string;
  readonly daemonVersion: string;
  /** Untrusted entries must be validated/compared before claiming ownership. */
  readonly providers: Readonly<Record<string, unknown>>;
  readonly readyProviderIds: readonly string[];
  readonly activeManagedProviderIds: readonly ManagedProviderId[];
}
/** Read-only initial seam. Mutation methods belong to the later transaction/gateway work. */
export interface PaseoGateway {
  snapshot(): Promise<GatewaySnapshot>;
  close(): Promise<void>;
}
