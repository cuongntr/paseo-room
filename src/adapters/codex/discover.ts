import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { valid } from 'semver';
import type { DiscoveryContext } from '../contract.js';
import type { CheckResult } from '../../core/result.js';
import { containsPath, requireDisjointRoots, resolveManagedRoot } from '../../core/paths.js';

export interface CodexDiscovery {
  readonly canonicalHome: string;
  readonly roomHome: string;
  readonly configPath: string;
  readonly launchPrefix: readonly [string, ...string[]];
  readonly version: string;
  /** Raw catalog is consumed by the later runtime renderer, never diagnostic output. */
  readonly modelCatalog: unknown;
  readonly sharedTargets: Readonly<Record<string, string>>;
}

export class CodexDiscoveryError extends Error {
  readonly check: CheckResult;
  constructor(id: string, remediation: string) {
    super(remediation);
    this.name = 'CodexDiscoveryError';
    this.check = { id: `codex.${id}`, status: 'fail', message: 'Codex discovery failed.', remediation };
  }
}

function fail(id: string, remediation: string): never {
  throw new CodexDiscoveryError(id, remediation);
}

function sameFile(left: { readonly device: number; readonly inode: number }, right: { readonly device: number; readonly inode: number }): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function executable(context: DiscoveryContext, input: string): Promise<string> {
  const candidates = isAbsolute(input) || input.includes('/') ? [resolve(input)] :
    (context.environment.PATH ?? '').split(delimiter).filter(isAbsolute).map((entry) => join(entry, input));
  for (const candidate of candidates) {
    if (!(await context.filesystem.lstat(candidate))) continue;
    const path = await context.filesystem.realpath(candidate);
    const metadata = await context.filesystem.lstat(path);
    if (metadata?.kind === 'file' && (metadata.mode & 0o111) !== 0) {
      if (path.split('/').some((part) => part === '_npx' || part === '_cacache')) {
        fail('executable', 'Use a persistent Codex/Node installation outside npm caches.');
      }
      return path;
    }
  }
  return fail('executable', 'Install Codex/Node yourself and supply --codex-bin or an executable on PATH.');
}

function native(bytes: Uint8Array): boolean {
  const magic = Buffer.from(bytes.subarray(0, 4)).toString('hex');
  return ['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
}

/** Read-only discovery. Credentials are checked by metadata only, never read or hashed. */
export async function discoverCodex(context: DiscoveryContext, operatorUid: number | undefined = process.getuid?.()): Promise<CodexDiscovery> {
  try {
    return await discover(context, operatorUid);
  } catch (error) {
    if (error instanceof CodexDiscoveryError) throw error;
    // Filesystem/process errors can contain environment values or sensitive output.
    return fail('prerequisites', 'Check that Codex paths exist, are accessible, and have safe directory parents; choose disjoint --codex-home and --room-home paths.');
  }
}

async function discover(context: DiscoveryContext, operatorUid: number | undefined): Promise<CodexDiscovery> {
  const { filesystem, environment, intent } = context;
  const home = environment.HOME;
  const canonicalInput = intent.codexHome ?? environment.CODEX_HOME ?? (home ? join(home, '.codex') : undefined);
  const roomInput = intent.roomHome ?? environment.PASEO_ROOM_HOME ??
    (environment.XDG_DATA_HOME ? join(environment.XDG_DATA_HOME, 'paseo-room') :
      home ? join(home, '.local/share/paseo-room') : undefined);
  if (!canonicalInput || !roomInput) fail('home', 'Set HOME or supply --codex-home and --room-home.');
  if (!(await filesystem.lstat(resolve(canonicalInput)))) fail('home', 'Supply an existing usable --codex-home; initialize and authenticate Codex yourself.');
  const canonicalHome = await filesystem.realpath(resolve(canonicalInput));
  const rootMetadata = await filesystem.lstat(canonicalHome);
  if (rootMetadata?.kind !== 'directory' || rootMetadata.uid !== operatorUid || (rootMetadata.mode & 0o500) !== 0o500) {
    fail('home', 'Supply a readable, searchable, operator-owned canonical Codex directory on macOS or Linux.');
  }
  const roomHome = await resolveManagedRoot(filesystem, roomInput);
  requireDisjointRoots(canonicalHome, roomHome);
  const resourceSpecs = [
    ['config.toml', 'file', true], ['auth.json', 'file', true], ['AGENTS.md', 'file', true],
    ['skills', 'directory', true], ['plugins', 'directory', true], ['hooks.json', 'file', false],
  ] as const;
  const resolvedResources: Array<{
    readonly name: typeof resourceSpecs[number][0];
    readonly target: string;
    readonly metadata: NonNullable<Awaited<ReturnType<typeof filesystem.lstat>>>;
  }> = [];
  for (const [name, kind, required] of resourceSpecs) {
    const source = join(canonicalHome, name);
    if (!(await filesystem.lstat(source))) {
      if (required) fail('resources', `Provide required ${name} in the canonical Codex home; repair it yourself before retrying.`);
      continue;
    }
    const target = await filesystem.realpath(source);
    if (target === canonicalHome || !containsPath(canonicalHome, target) || containsPath(roomHome, target)) {
      fail('containment', `Keep ${name} inside the canonical home and outside the managed root; remove escaping aliases.`);
    }
    const metadata = await filesystem.lstat(target);
    if (metadata?.kind !== kind || metadata.uid !== rootMetadata.uid ||
        (metadata.mode & (kind === 'directory' ? 0o500 : 0o400)) !== (kind === 'directory' ? 0o500 : 0o400) ||
        (kind === 'file' && metadata.links !== 1)) {
      fail('resources', `Make ${name} readable, operator-owned, and of the expected type without hard-link aliases.`);
    }
    resolvedResources.push({ name, target, metadata });
  }
  const auth = resolvedResources.find((resource) => resource.name === 'auth.json');
  if (!auth) fail('resources', 'Provide required auth.json in the canonical Codex home; authenticate Codex yourself before retrying.');
  const sharedTargets: Record<string, string> = {};
  let configPath = '';
  for (const resource of resolvedResources) {
    if (resource.name !== 'auth.json' && sameFile(resource.metadata, auth.metadata)) {
      fail('credentials', `Keep ${resource.name} physically distinct from auth.json; credential aliases are forbidden.`);
    }
    if (resource.name === 'config.toml') configPath = resource.target;
    else if (resource.name !== 'auth.json') sharedTargets[resource.name] = resource.target;
    else sharedTargets[resource.name] = resource.target;
  }
  const codex = await executable(context, intent.codexBin ?? environment.CODEX_BIN ?? 'codex');
  const codexMetadata = await filesystem.lstat(codex);
  if (!codexMetadata || sameFile(codexMetadata, auth.metadata)) {
    fail('credentials', 'Use a Codex executable that is physically distinct from auth.json; credential aliases are forbidden.');
  }
  const bytes = await filesystem.readFile(codex);
  let launchPrefix: [string, ...string[]];
  if (Buffer.from(bytes.subarray(0, 2)).toString() === '#!') {
    const line = Buffer.from(bytes).toString('utf8').split('\n', 1)[0];
    if (line !== '#!/usr/bin/env node') fail('launcher', 'Use a native Codex executable or the supported npm launcher with exactly #!/usr/bin/env node; shell/interpreter wrappers are unsupported.');
    const node = await executable(context, 'node');
    const nodeMetadata = await filesystem.lstat(node);
    if (!nodeMetadata || sameFile(nodeMetadata, auth.metadata)) {
      fail('credentials', 'Use a Node executable that is physically distinct from auth.json; credential aliases are forbidden.');
    }
    if (!native(await filesystem.readFile(node))) fail('launcher', 'Resolve node on PATH to a native Node executable, not an interpreter wrapper.');
    launchPrefix = [node, codex];
  } else {
    if (!native(bytes)) fail('launcher', 'Use a native Codex executable or a supported npm Node launcher; unsupported scripts cannot be launched safely.');
    launchPrefix = [codex];
  }
  const env: Record<string, string> = { CODEX_HOME: canonicalHome, LANG: 'C', LC_ALL: 'C' };
  if (home) env.HOME = home;
  async function probe(args: readonly string[]): Promise<string> {
    const result = await context.process.run({ executable: launchPrefix[0], args: [...launchPrefix.slice(1), ...args], env, shell: false, timeoutMs: 10_000 });
    if (result.exitCode !== 0) fail('probe', 'Run Codex --version and Codex debug models yourself; fix the installation before retrying.');
    return result.stdout;
  }
  const versionOutput = (await probe(['--version'])).trim();
  const version = valid(versionOutput.replace(/^codex(?:-cli)?\s+/, ''));
  if (!version) fail('version', 'Use a Codex installation that reports a valid version with --version.');
  let modelCatalog: unknown;
  try { modelCatalog = JSON.parse(await probe(['debug', 'models'])); }
  catch (error) {
    if (error instanceof CodexDiscoveryError) throw error;
    fail('models', 'Use a Codex installation whose debug models command returns a JSON catalog.');
  }
  if (modelCatalog === null || typeof modelCatalog !== 'object') fail('models', 'Codex debug models must return a JSON catalog object or array.');
  return { canonicalHome, roomHome, configPath, launchPrefix, version, modelCatalog, sharedTargets };
}
