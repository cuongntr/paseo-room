import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ambientNamesCheck, inspectCredentialPath, presentNames, preservedCredentialCheck,
  type CredentialDiagnostic,
} from '../credentials.js';
import { piLoginCommand } from '../auth.js';
import type { Entry } from '../fsops.js';
import { existingPaths } from '../fsops.js';
import type { Layout } from '../layout.js';
import { contains, roleHome } from '../layout.js';
import { fail, pass, warn, type Check } from '../result.js';
import { ROLES, type Role } from '../roles.js';
import { renderInstructions } from '../room/instructions.js';
import { loadPromptAsset } from '../room/prompts.js';
import { which } from '../which.js';
import { jsonServerTable, paseoMcpCheck } from './mcp.js';
import { roleResourceEntries } from './resources.js';
import { leadSkillProjection, ROOM_SKILL_NAME, roomSkillSource } from '../room/skills.js';
import type { Agent, AgentPlan, BuildOptions, PiExtensionChoice } from './types.js';

const PACKAGE_NAME = 'pi-mcp-adapter';
const PROBE_ID = 'paseo-room-pi-mcp-probe';
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 1024 * 1024;
const SHARED = ['models.json', 'AGENTS.md', 'skills', 'prompts', 'themes', 'keybindings.json', 'mcp.json'] as const;
/** Pi prompts are its slash commands, so they execute; Peer receives no such resource. */
const EXECUTABLE = ['prompts'] as const;
const MCP_FILE = 'mcp.json';
/** Pi accepts either key for its declaration map, so both are read and neither is rewritten. */
const MCP_KEYS = ['mcpServers', 'servers'] as const;
/** Built-in provider key names only; ambient cloud credential files are deliberately not probed. */
const AUTH_ENV = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_API_KEY',
  'MISTRAL_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'XAI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'FIREWORKS_API_KEY',
  'ZAI_API_KEY', 'MINIMAX_API_KEY', 'OPENCODE_API_KEY', 'KIMI_API_KEY',
  'COPILOT_GITHUB_TOKEN',
] as const;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : undefined;
}

/** Copy operator preferences but remove every declaration that can install or load packages. */
export function renderPiSettings(source: string | undefined): string {
  const parsed: unknown = source === undefined ? {} : JSON.parse(source);
  const settings = asObject(parsed);
  if (!settings) throw new Error('Pi settings must be a JSON object.');
  delete settings.packages;
  delete settings.extensions;
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Preserve the operator append first; room-specific guidance is additive and stronger. */
export function renderPiAppend(source: string | undefined, role: Role): string {
  return [
    source?.trim(),
    loadPromptAsset('pi', 'communicationStyle'),
    loadPromptAsset('pi', 'runtime'),
    renderInstructions(role),
  ].filter((part): part is string => Boolean(part)).join('\n\n');
}

interface ResolvedAdapter {
  readonly entry: string;
  readonly version: string;
}

/** Selected without roles, an extension goes to the orchestrating seats; Peer only when named. */
const DEFAULT_EXTENSION_ROLES: readonly Role[] = ['supervisor', 'lead'];
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** The environment variable every Pi seat carries, so an extension can tell it runs in a seat. */
export const SEAT_ROLE_ENV = 'PASEO_ROOM_ROLE';

/** Parses one `--pi-extension <package>[=<role>,...]` value. Throws a readable message. */
export function parsePiExtensionSpec(spec: string): PiExtensionChoice {
  const [name = '', roleList, ...rest] = spec.trim().split('=');
  if (rest.length > 0 || !NPM_NAME.test(name)) {
    throw new Error(`Not a Pi package selection: ${spec}. Use <npm package>[=<role>,<role>].`);
  }
  if (name === PACKAGE_NAME) throw new Error(`${PACKAGE_NAME} is always loaded and cannot be selected.`);
  if (roleList === undefined) return { package: name, roles: DEFAULT_EXTENSION_ROLES };
  const roles = roleList.split(',').map(role => role.trim());
  const unknown = roles.filter(role => !ROLES.some(known => known === role));
  if (unknown.length > 0 || roles.length === 0) {
    throw new Error(`Unknown role in ${spec}: ${unknown.join(', ') || '(none)'}. Roles are ${ROLES.join(', ')}.`);
  }
  return { package: name, roles: ROLES.filter(role => roles.includes(role)) };
}

/** One entry per package, roles merged and in room order, packages sorted: a stable marker. */
export function normalizePiExtensions(choices: readonly PiExtensionChoice[]): PiExtensionChoice[] {
  const merged = new Map<string, Set<Role>>();
  for (const choice of choices) {
    const roles = merged.get(choice.package) ?? new Set<Role>();
    for (const role of choice.roles) roles.add(role);
    merged.set(choice.package, roles);
  }
  return [...merged.entries()]
    // Code-unit order, not locale order, so the marker is byte-identical on every machine.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, roles]) => ({ package: name, roles: ROLES.filter(role => roles.has(role)) }));
}

type PackageResolution =
  | { readonly kind: 'resolved'; readonly entries: readonly string[]; readonly version: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsafe'; readonly detail: string };

/**
 * Resolve an operator-installed Pi package and every extension entry it declares, each a regular
 * file inside the canonical package root. Never installs, never follows a declaration outside it.
 */
async function resolvePiPackage(home: string, name: string): Promise<PackageResolution> {
  const packageRoot = join(home, 'npm', 'node_modules', name);
  const manifestPath = join(packageRoot, 'package.json');
  try {
    await stat(packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unsafe', detail: `Could not inspect ${packageRoot}.` };
  }
  try {
    const [canonicalRoot, manifestStat, raw] = await Promise.all([
      realpath(packageRoot), stat(manifestPath), readFile(manifestPath, 'utf8'),
    ]);
    if (!manifestStat.isFile()) return { kind: 'unsafe', detail: `${manifestPath} is not a regular file.` };
    const manifest = asObject(JSON.parse(raw));
    if (!manifest || manifest.name !== name) return { kind: 'unsafe', detail: `${manifestPath} does not identify ${name}.` };
    const declared = asObject(manifest.pi)?.extensions;
    if (!Array.isArray(declared) || declared.length === 0 || !declared.every(item => typeof item === 'string' && item.trim() !== '')) {
      return { kind: 'unsafe', detail: `${manifestPath} declares no Pi extension entry.` };
    }
    const entries: string[] = [];
    for (const declaration of declared as string[]) {
      if (isAbsolute(declaration)) return { kind: 'unsafe', detail: `${manifestPath} declares an unsafe absolute extension path.` };
      const candidate = resolve(packageRoot, declaration);
      const [canonicalEntry, entryStat] = await Promise.all([realpath(candidate), stat(candidate)]);
      if (!contains(canonicalRoot, canonicalEntry) || canonicalEntry === canonicalRoot || !entryStat.isFile()) {
        return { kind: 'unsafe', detail: `A declared ${name} extension escapes its package or is not a regular file.` };
      }
      entries.push(canonicalEntry);
    }
    const version = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : 'unknown';
    return { kind: 'resolved', entries, version };
  } catch {
    return { kind: 'unsafe', detail: `Could not safely resolve ${name} from ${manifestPath}.` };
  }
}

interface ResolvedExtensions {
  /** Canonical entries per role, in selection order; a role with none is absent. */
  readonly byRole: Partial<Record<Role, readonly string[]>>;
  readonly checks: readonly Check[];
}

/** PX-D2/PX-D3: installed packages load; a missing one warns; an unsafe one fails the build. */
export async function resolvePiExtensions(
  home: string,
  choices: readonly PiExtensionChoice[],
  roles: readonly Role[],
): Promise<ResolvedExtensions> {
  const byRole: Partial<Record<Role, string[]>> = {};
  const checks: Check[] = [];
  for (const choice of normalizePiExtensions(choices)) {
    const seated = choice.roles.filter(role => roles.includes(role));
    if (seated.length === 0) continue;
    const id = `pi.extension.${choice.package}`;
    const resolution = await resolvePiPackage(home, choice.package);
    if (resolution.kind === 'missing') {
      checks.push(warn(`${id}.missing`,
        `Pi package ${choice.package} is selected for ${seated.join(', ')} but is not installed in ${join(home, 'npm')}; those seats start without it.`,
        `Install it yourself with: pi install npm:${choice.package}, then run setup again. The room never installs Pi packages.`));
      continue;
    }
    if (resolution.kind === 'unsafe') {
      checks.push(fail(id, resolution.detail, `Reinstall ${choice.package} with Pi, or drop --pi-extension ${choice.package}, then run setup again.`));
      continue;
    }
    for (const role of seated) byRole[role] = [...(byRole[role] ?? []), ...resolution.entries];
    checks.push(pass(id, `${choice.package} ${resolution.version} loads for ${seated.join(', ')} from ${resolution.entries.join(', ')}.`));
    if (seated.includes('peer')) {
      checks.push(warn(`${id}.peer`,
        `Peer runs ${choice.package}'s extension code. The room cannot prove it opens no second multi-agent path; selecting it states that it does not, or that it closes that path when ${SEAT_ROLE_ENV} is set.`,
        `Drop peer from --pi-extension ${choice.package}=<roles> if that is not true.`));
    }
  }
  return { byRole, checks };
}

/**
 * Pi 1.0 ships a built-in `mcp` extension, but Paseo gives a Pi seat its MCP servers only through
 * this adapter: it recognises `/mcp` by the adapter's name and passes `--mcp-config`, a flag only
 * the adapter defines. Without it, Supervisor and Lead would run with no Paseo tools.
 */
function adapterFailure(home: string, detail: string): Check {
  return fail('pi.adapter', detail,
    `Install ${PACKAGE_NAME} into ${join(home, 'npm')} yourself with: pi install npm:${PACKAGE_NAME}. `
    + `Pi's built-in MCP extension is not a substitute: Paseo hands a Pi seat its tools only through ${PACKAGE_NAME}. `
    + 'The room never installs Pi packages. Then run setup again.');
}

/** Resolve only Pi's intended global package and its single declared extension entry. */
export async function resolvePiAdapter(home: string): Promise<{ readonly adapter?: ResolvedAdapter; readonly check: Check }> {
  const packageRoot = join(home, 'npm', 'node_modules', PACKAGE_NAME);
  const manifestPath = join(packageRoot, 'package.json');
  try {
    await stat(packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { check: adapterFailure(home, `${PACKAGE_NAME} is not installed in ${join(home, 'npm')}.`) };
    }
  }
  try {
    const [canonicalRoot, manifestStat, raw] = await Promise.all([
      realpath(packageRoot), stat(manifestPath), readFile(manifestPath, 'utf8'),
    ]);
    if (!manifestStat.isFile()) return { check: adapterFailure(home, `${manifestPath} is not a regular file.`) };
    const manifest = asObject(JSON.parse(raw));
    if (!manifest || manifest.name !== PACKAGE_NAME) {
      return { check: adapterFailure(home, `${manifestPath} does not identify ${PACKAGE_NAME}.`) };
    }
    const pi = asObject(manifest.pi);
    const declared = pi?.extensions;
    if (!Array.isArray(declared) || declared.length !== 1 || typeof declared[0] !== 'string' || !declared[0].trim()) {
      return { check: adapterFailure(home, `${manifestPath} must declare one Pi extension entry.`) };
    }
    const declaration = declared[0];
    if (isAbsolute(declaration)) {
      return { check: adapterFailure(home, `${manifestPath} declares an unsafe absolute extension path.`) };
    }
    const candidate = resolve(packageRoot, declaration);
    const [canonicalEntry, entryStat] = await Promise.all([realpath(candidate), stat(candidate)]);
    if (!contains(canonicalRoot, canonicalEntry) || canonicalEntry === canonicalRoot || !entryStat.isFile()) {
      return { check: adapterFailure(home, `The declared ${PACKAGE_NAME} extension escapes its package or is not a regular file.`) };
    }
    const version = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : 'unknown';
    return {
      adapter: { entry: canonicalEntry, version },
      check: pass('pi.adapter', `${PACKAGE_NAME} ${version} resolved to ${canonicalEntry}.`),
    };
  } catch {
    return { check: adapterFailure(home, `Could not safely resolve ${PACKAGE_NAME} from ${manifestPath}.`) };
  }
}

export interface PiProbeOptions {
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  /** Selected extension entries the seats load after the adapter, so the probe starts what they start. */
  readonly extensions?: readonly string[];
}
interface ProcessResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly reason?: 'failure' | 'timeout' | 'overflow';
}

function terminateProbe(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the process group may already be gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* the direct child may already be gone */ }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** One bounded JSONL request in its own process group and isolated working directory. */
function runProbeProcess(
  executable: string,
  adapterEntry: string,
  env: NodeJS.ProcessEnv,
  options: PiProbeOptions,
  cwd: string,
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? PROBE_OUTPUT_LIMIT;
  const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--extension', adapterEntry,
    ...(options.extensions ?? []).flatMap(entry => ['--extension', entry]), '--no-approve'];
  return new Promise(resolveResult => {
    const child = spawn(executable, args, { cwd, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const abort = (reason: NonNullable<ProcessResult['reason']>): void => {
      if (settled) return;
      terminateProbe(child);
      finish({ ok: false, stdout: Buffer.concat(stdout).toString('utf8'), reason });
    };
    const capture = (chunk: Buffer, keep: boolean): void => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > outputLimit) {
        abort('overflow');
        return;
      }
      if (keep) stdout.push(chunk);
    };
    const timer = setTimeout(() => { abort('timeout'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { capture(chunk, true); });
    child.stderr.on('data', (chunk: Buffer) => { capture(chunk, false); });
    child.stdout.on('error', () => { abort('failure'); });
    child.stderr.on('error', () => { abort('failure'); });
    child.on('error', () => { abort('failure'); });
    child.on('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      finish(code === 0 ? { ok: true, stdout: output } : { ok: false, stdout: output, reason: 'failure' });
    });
    child.stdin.on('error', () => { /* a failed child is reported by close/error */ });
    child.stdin.end(`${JSON.stringify({ id: PROBE_ID, type: 'get_commands' })}\n`);
  });
}

/** Pi runs migrations against cwd before RPC, so never probe in the caller's project. */
async function runProbe(
  executable: string,
  adapterEntry: string,
  env: NodeJS.ProcessEnv,
  options: PiProbeOptions,
): Promise<ProcessResult> {
  const createdCwd = await mkdtemp(join(tmpdir(), 'paseo-room-pi-probe-'));
  const cwd = await realpath(createdCwd);
  try {
    // An empty agent directory of its own rather than /dev/null: a selected extension may write
    // its log under the agent directory, and nothing here may reach an operator or role home.
    const agentDir = join(cwd, 'agent');
    await mkdir(agentDir);
    return await runProbeProcess(executable, adapterEntry, {
      ...env,
      HOME: cwd,
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_CONFIG_MODE: 'exclusive',
      PI_OFFLINE: '1',
      [SEAT_ROLE_ENV]: 'lead',
    }, options, cwd);
  } finally {
    await rm(createdCwd, { force: true, recursive: true });
  }
}

function probeFailure(message: string): Check {
  return fail('pi.capability', message,
    'Use a Pi and pi-mcp-adapter installation that exposes /mcp through the declared adapter entry.');
}

/** Authenticate the exact adapter path through Pi's correlated get_commands response. */
export async function probePiMcp(
  executable: string,
  adapterEntry: string,
  env: NodeJS.ProcessEnv,
  options: PiProbeOptions = {},
): Promise<Check> {
  let result: ProcessResult;
  try {
    result = await runProbe(executable, adapterEntry, env, options);
  } catch {
    return probeFailure('Pi capability probe could not create or clean its isolated working directory.');
  }
  if (!result.ok) {
    if (result.reason === 'timeout') return probeFailure('Pi capability probe timed out.');
    if (result.reason === 'overflow') return probeFailure('Pi capability probe exceeded its output limit.');
    return probeFailure('Pi capability probe failed.');
  }
  const correlated: Record<string, unknown>[] = [];
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return probeFailure('Pi capability probe returned malformed JSONL.'); }
    const event = asObject(parsed);
    if (!event) return probeFailure('Pi capability probe returned malformed JSONL.');
    if (event.type === 'response' && event.id === PROBE_ID) correlated.push(event);
  }
  if (correlated.length !== 1) return probeFailure('Pi capability probe did not return one correlated get_commands response.');
  const response = correlated[0];
  if (response?.command !== 'get_commands' || response.success !== true) {
    return probeFailure('Pi rejected the get_commands capability probe.');
  }
  const data = asObject(response.data);
  const commands = data?.commands;
  if (!Array.isArray(commands)) return probeFailure('Pi get_commands response was malformed.');
  const matches = commands.map(asObject).filter((command): command is Record<string, unknown> => command?.name === 'mcp');
  if (matches.length !== 1) return probeFailure('Pi did not expose exactly one /mcp command.');
  const command = matches[0];
  if (command?.source !== 'extension') return probeFailure('Pi exposed /mcp from the wrong source.');
  const sourceInfo = asObject(command.sourceInfo);
  if (typeof sourceInfo?.path !== 'string') return probeFailure('Pi did not report the /mcp extension path.');
  try {
    const sourcePath = await realpath(sourceInfo.path);
    if (sourcePath !== adapterEntry) return probeFailure('Pi loaded /mcp from a different extension path.');
  } catch {
    return probeFailure('Pi reported an unresolvable /mcp extension path.');
  }
  return pass('pi.capability', `Pi exposed /mcp from ${adapterEntry}.`);
}

async function readPiOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function piCredentialDiagnostic(layout: Layout, role: Role, binary = 'pi'): Promise<CredentialDiagnostic> {
  const home = roleHome(layout, 'pi', role);
  const path = join(home, 'auth.json');
  const launch = piLoginCommand(home, binary);
  const state = await inspectCredentialPath(path);
  const id = `pi.auth.${role}`;
  if (state.kind !== 'missing') {
    return {
      path,
      checks: [preservedCredentialCheck({
        id, agent: 'Pi', role, path, state,
        login: `${launch}; this starts a minimal, non-room-equivalent interactive login session. Run /login, then exit Pi`,
      })],
    };
  }
  const configured = presentNames(layout.envNames, AUTH_ENV);
  if (configured.length > 0) return { path, checks: [ambientNamesCheck(id, 'Pi', role, configured)] };
  return { path, checks: [{
    id: `${id}.login-required`, status: 'warn',
    message: `Pi ${role} auth: login-required; no role-owned auth.json or known provider environment name was detected. Ambient provider auth may exist, but it was not inspected or validated.`,
    fix: `Start a minimal, non-room-equivalent interactive login session with: ${launch}. Run /login, then exit Pi.`,
  }] };
}

export const piAgent: Agent = {
  id: 'pi',
  label: 'Pi',
  homeEnv: 'PI_CODING_AGENT_DIR',
  providerEnv: { PI_MCP_CONFIG_MODE: 'exclusive' },
  pins: {},
  async build(layout: Layout, roles: readonly Role[], options?: BuildOptions): Promise<AgentPlan> {
    const home = layout.agentHome.pi;
    const binary = await which(layout.bin.pi, layout.searchPath);
    if (!binary) {
      return { entries: [], checks: [fail('pi.bin', 'Pi executable not found.', 'Install Pi yourself, or pass --pi-bin /path/to/pi.')] };
    }
    try {
      if (!(await stat(home)).isDirectory()) throw new Error('not a directory');
    } catch {
      return { entries: [], checks: [fail('pi.home', `No Pi config directory at ${home}.`, 'Run Pi once to initialise it, or pass --pi-home.')] };
    }
    const resolved = await resolvePiAdapter(home);
    if (!resolved.adapter) return { entries: [], checks: [resolved.check] };
    const extensions = await resolvePiExtensions(home, options?.piExtensions ?? [], roles);
    if (extensions.checks.some(check => check.status === 'fail')) {
      return { entries: [], checks: [resolved.check, ...extensions.checks] };
    }
    const selected = [...new Set(Object.values(extensions.byRole).flat())];
    const capability = await probePiMcp(binary, resolved.adapter.entry, {
      HOME: layout.home,
      PATH: layout.searchPath,
      PI_OFFLINE: '1',
    }, { extensions: selected });
    if (capability.status === 'fail') {
      return { entries: [], checks: [resolved.check, ...extensions.checks, selected.length === 0 ? capability : {
        ...capability,
        fix: `${capability.fix ?? ''} A selected Pi extension may also be what stops Pi from starting; retry without --pi-extension to tell.`.trim(),
      }] };
    }

    const settingsPath = join(home, 'settings.json');
    let settings: string;
    try { settings = renderPiSettings(await readPiOptional(settingsPath)); } catch {
      return {
        entries: [], checks: [resolved.check, capability,
          fail('pi.settings', `Could not read ${settingsPath} as a JSON object.`,
            'Make your Pi settings readable and fix any JSON syntax, then run setup again.')],
      };
    }
    const operatorAppendPath = join(home, 'APPEND_SYSTEM.md');
    let operatorAppend: string | undefined;
    try {
      operatorAppend = await readPiOptional(operatorAppendPath);
    } catch {
      return {
        entries: [], checks: [resolved.check, capability,
          fail('pi.append', `Could not read ${operatorAppendPath}.`,
            'Make your Pi APPEND_SYSTEM.md readable, then run setup again.')],
      };
    }
    const shared = await existingPaths(home, SHARED);
    // The adapter reads this file as its only config source, so a Paseo-looking server here
    // would be a second control plane. Fail before apply; never edit the operator's file.
    const mcpPath = join(home, MCP_FILE);
    let servers: Record<string, unknown>;
    try {
      servers = jsonServerTable(await readPiOptional(mcpPath), MCP_KEYS);
    } catch {
      return {
        entries: [], checks: [resolved.check, capability,
          fail('pi.mcp', `Could not read ${mcpPath} as a JSON object, so its MCP declarations could not be inspected.`,
            'Make your Pi mcp.json readable and fix its JSON structure, then run setup again.')],
      };
    }
    const conflict = paseoMcpCheck('pi.mcp', mcpPath, servers);
    if (conflict) return { entries: [], checks: [resolved.check, capability, conflict] };
    const entries: Entry[] = [];
    const credentials: CredentialDiagnostic[] = [];
    const argv: Partial<Record<Role, readonly string[]>> = {};
    const providerEnv: Partial<Record<Role, Readonly<Record<string, string>>>> = {};
    const roomSkill = { name: ROOM_SKILL_NAME, source: roomSkillSource(layout) };
    for (const role of roles) {
      const target = roleHome(layout, 'pi', role);
      const appendPath = join(target, 'APPEND_SYSTEM.md');
      entries.push({ kind: 'dir', path: target });
      entries.push({ kind: 'file', path: join(target, 'settings.json'), content: settings });
      entries.push({ kind: 'file', path: appendPath, content: renderPiAppend(operatorAppend, role) });
      entries.push(...await roleResourceEntries({
        role, target, home, names: SHARED, shared, executable: EXECUTABLE, roomSkill,
        leadSkillProjection: leadSkillProjection(layout, 'pi'),
      }));
      credentials.push(await piCredentialDiagnostic(layout, role, binary));
      argv[role] = [
        '--no-extensions', '--extension', resolved.adapter.entry,
        ...(extensions.byRole[role] ?? []).flatMap(entry => ['--extension', entry]),
        '--no-approve', '--append-system-prompt', appendPath,
      ];
      providerEnv[role] = { [SEAT_ROLE_ENV]: role };
    }
    return {
      entries,
      credentials,
      checks: [pass('pi.home', `Pi found at ${binary} using ${home}.`), resolved.check, ...extensions.checks, capability],
      binary,
      argv,
      providerEnv,
    };
  },
};
