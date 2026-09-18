import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ambientNamesCheck, configuredByNamesCheck, inspectCredentialPath, presentNames, preservedCredentialCheck,
  roleCommand, type CredentialDiagnostic,
} from '../credentials.js';
import type { Layout } from '../layout.js';
import { roleHome } from '../layout.js';
import type { Entry } from '../fsops.js';
import { existingPaths, exists, readIfPresent } from '../fsops.js';
import { fail, pass, warn, type Check } from '../result.js';
import type { Role } from '../roles.js';
import { renderInstructions } from '../room/instructions.js';
import { which } from '../which.js';
import { jsonServerTable, paseoMcpCheck, serverNameDivergence, type NameDivergence } from './mcp.js';
import { roleResourceEntries } from './resources.js';
import type { Agent, AgentPlan, BuildOptions } from './types.js';

/** Operator-authored resources shared by reference; native agent definitions stay out. */
const SHARED = [
  'skills', 'plugins', 'commands', 'hooks', 'rules',
  'output-styles', 'keybindings.json', 'themes',
] as const;
/** These carry executable prompts, plugin code, and hook programs: never shared with Peer. */
const EXECUTABLE = ['plugins', 'commands', 'hooks'] as const;
/**
 * Claude's own runtime writes its downloaded skill bucket here, inside whichever home it runs
 * with. It is agent state rather than an operator-authored skill, so the room leaves the name
 * alone in both directions: it is never projected and never reconciled as stale.
 */
const RUNTIME_SKILLS = ['synced'] as const;
/** Claude keeps personal MCP declarations under this one key of its runtime state. */
const MCP_KEY = 'mcpServers';
const AUTH_ENV = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const;
const CONTROL_PLANE_ENV = {
  CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
} as const;
const SECURE_STORAGE_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
/** Copied once so a fresh role home does not re-run interactive onboarding. */
const SEEDED_KEYS = ['hasCompletedOnboarding', 'theme', 'installMethod', 'userID', MCP_KEY] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}
/** Any unreadable or non-object source is simply an empty starting point. */
function readObject(source: string | undefined): Record<string, unknown> {
  try { return asObject(source === undefined ? {} : JSON.parse(source)); } catch { return {}; }
}

/** Read optional runtime state, but do not turn an inspection failure into "no servers". */
async function readStateIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Keep operator configuration while closing non-Paseo inbound coordination. */
export function renderRoleSettings(source: string | undefined, role: Role, secureStorageDir?: string): string {
  const settings = readObject(source);
  // Claude applies settings.env after the launch environment, so repeat these
  // provider pins here after operator values to make them effective.
  settings.env = {
    ...asObject(settings.env),
    ...CONTROL_PLANE_ENV,
    PASEO_ROOM_ROLE: role,
    ...(secureStorageDir === undefined ? {} : { [SECURE_STORAGE_ENV]: secureStorageDir }),
  };
  // These restrictive settings cannot be weakened by another settings scope.
  settings.disableAgentView = true;
  settings.disableWorkflows = true;
  settings.crossSessionInbound = 'refuse';
  return JSON.stringify(settings, null, 2) + '\n';
}

export function renderRoleState(source: string | undefined): string {
  const root = readObject(source);
  const state: Record<string, unknown> = { hasCompletedOnboarding: true };
  for (const key of SEEDED_KEYS) if (key in root) state[key] = root[key];
  return JSON.stringify(state, null, 2) + '\n';
}

/**
 * Preserve the operator's global memory, then add the stronger room role contract.
 *
 * With the contract suppressed, the file carries the operator's memory alone: the plugin is
 * then the room's only Claude contract carrier. Returning `undefined` for an operator with no
 * global memory keeps the room from writing a file whose whole content it just removed.
 */
export function renderRoleMemory(source: string | undefined, role: Role, contract = true): string | undefined {
  const operator = source?.trim();
  if (!contract) return operator ? `${operator}\n` : undefined;
  return operator ? `${operator}\n\n${renderInstructions(role)}` : renderInstructions(role);
}

/** Detect only configuration names; never inspect environment or settings values. */
export function claudeAuthMethodNames(settingsSource: string | undefined, envNames: ReadonlySet<string>): string[] {
  const settings = readObject(settingsSource);
  const settingsEnv = asObject(settings.env);
  const names = new Set(presentNames(envNames, AUTH_ENV));
  for (const name of AUTH_ENV) if (Object.hasOwn(settingsEnv, name)) names.add(name);
  if (Object.hasOwn(settings, 'apiKeyHelper')) names.add('apiKeyHelper');
  return [...names];
}

export async function claudeCredentialDiagnostic(
  layout: Layout,
  role: Role,
  settingsSource: string | undefined,
  platform: NodeJS.Platform = process.platform,
  binary = 'claude',
): Promise<CredentialDiagnostic> {
  const home = roleHome(layout, 'claude', role);
  const path = join(home, '.credentials.json');
  const roleEnvironment = { CLAUDE_CONFIG_DIR: home, [SECURE_STORAGE_ENV]: home };
  const login = roleCommand(roleEnvironment, binary, ['auth', 'login']);
  const status = roleCommand(roleEnvironment, binary, ['auth', 'status']);
  const state = await inspectCredentialPath(path);
  const id = `claude.auth.${role}`;
  if (state.kind !== 'missing') {
    return { path, checks: [preservedCredentialCheck({ id, agent: 'Claude', role, path, state, login, status })] };
  }
  const configured = claudeAuthMethodNames(settingsSource, new Set());
  if (configured.length > 0) return { path, checks: [configuredByNamesCheck(id, 'Claude', role, configured)] };
  const ambient = presentNames(layout.envNames, AUTH_ENV);
  if (ambient.length > 0) return { path, checks: [ambientNamesCheck(id, 'Claude', role, ambient)] };
  if (platform === 'darwin') {
    return { path, checks: [{
      id: `${id}.native-keyring-unverifiable`, status: 'warn',
      message: `Claude ${role} auth: native-keyring unverifiable; the current runtime's secure-storage location is pinned to this role home, but no Keychain entry was queried and older runtime behavior was not assumed. Token validity and freshness were not checked.`,
      fix: `Authenticate this role with: ${login}. If that subcommand is unavailable, launch ${roleCommand(roleEnvironment, binary)} and run /login. Check status with: ${status}.`,
    }] };
  }
  return { path, checks: [{
    id: `${id}.login-required`, status: 'warn',
    message: `Claude ${role} auth: login-required; no role-owned .credentials.json or configured environment/static auth method was detected. Authentication was not attempted.`,
    fix: `Authenticate this role with: ${login}. If that subcommand is unavailable, launch ${roleCommand(roleEnvironment, binary)} and run /login. Check status with: ${status}.`,
  }] };
}

/**
 * `.claude.json` is seeded once and runtime-owned afterwards, so a later change to the
 * operator's own MCP inventory never reaches a role home. That is reported rather than
 * repaired: rewriting the file would discard whatever the runtime has since stored in it.
 * Only declared names are compared — no command, URL, argument, credential or history value
 * is read for this check.
 */
function mcpDriftCheck(role: Role, home: string, path: string, divergence: NameDivergence): Check {
  const parts = [
    ...(divergence.missing.length === 0 ? [] : [`not declared for this role: ${divergence.missing.join(', ')}`]),
    ...(divergence.extra.length === 0 ? [] : [`declared only for this role: ${divergence.extra.join(', ')}`]),
  ];
  return warn(`claude.mcp.drift.${role}`,
    `Claude ${role} MCP server names differ from your own Claude MCP servers (${parts.join('; ')}). ${path} is seeded once and owned by Claude afterwards, so paseo-room did not change it; only server names were compared.`,
    `If this role should have the same servers, add them with: CLAUDE_CONFIG_DIR=${home} claude mcp add ... — or delete ${path} and run setup --apply to reseed it from your current Claude state, which discards that role's other runtime state.`);
}

export const claudeAgent: Agent = {
  id: 'claude',
  label: 'Claude Code',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  // Agent View and dynamic workflows have entry points beyond model tool calls.
  providerEnv: CONTROL_PLANE_ENV,
  defaultModeId: 'bypassPermissions',
  // Keep the legacy Task name and block current native orchestration,
  // shared task/cron coordination, and cross-session paths. Paseo alone owns
  // agent lifecycle and coordination.
  pins: {
    disallowedTools: [
      'Task', 'Agent', 'Workflow', 'ListAgents', 'SendMessage', 'TeamCreate', 'TeamDelete',
      'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
      'CronCreate', 'CronDelete', 'CronList',
    ],
  },
  async build(layout: Layout, roles: readonly Role[], options: BuildOptions = {}): Promise<AgentPlan> {
    const home = layout.agentHome.claude;
    const binary = await which(layout.bin.claude, layout.searchPath);
    if (!binary) {
      return { entries: [], checks: [fail('claude.bin', 'Claude Code executable not found.', 'Install Claude Code, or pass --claude-bin /path/to/claude.')] };
    }
    if (!(await exists(home))) {
      return { entries: [], checks: [fail('claude.home', `No Claude config directory at ${home}.`, 'Run claude once to initialise it, or pass --claude-home.')] };
    }
    const checks: Check[] = [pass('claude.home', `Claude Code found at ${binary} using ${home}.`)];

    const settingsSource = await readIfPresent(join(home, 'settings.json'));
    const memorySource = await readIfPresent(join(home, 'CLAUDE.md'));
    let stateSource: string | undefined;
    let operatorServers: Record<string, unknown>;
    try {
      stateSource = await readStateIfPresent(layout.claudeState);
      // `.claude.json` is runtime-owned after the seed write, so only this one key is interpreted.
      operatorServers = jsonServerTable(stateSource, [MCP_KEY]);
    } catch {
      return { entries: [], checks: [...checks, fail('claude.mcp',
        `Could not read ${layout.claudeState} as a JSON object, so its MCP declarations could not be inspected.`,
        'Make your Claude state file readable and fix its JSON structure, then run setup again.')] };
    }
    const stateConflict = paseoMcpCheck('claude.mcp', layout.claudeState, operatorServers);
    if (stateConflict) return { entries: [], checks: [...checks, stateConflict] };
    const shared = await existingPaths(home, SHARED);
    const entries: Entry[] = [];
    const credentials: CredentialDiagnostic[] = [];
    const providerEnv: Partial<Record<Role, Readonly<Record<string, string>>>> = {};
    // Held back so a hard conflict found in a later role is never preceded by advice.
    const drift: Check[] = [];
    for (const role of roles) {
      const target = roleHome(layout, 'claude', role);
      const statePath = join(target, '.claude.json');
      // A seeded role home keeps its own copy, so its declarations are checked as well.
      let roleStateSource: string | undefined;
      let roleServers: Record<string, unknown>;
      try {
        roleStateSource = await readStateIfPresent(statePath);
        roleServers = jsonServerTable(roleStateSource, [MCP_KEY]);
      } catch {
        return { entries: [], checks: [...checks, fail(`claude.mcp.${role}`,
          `Could not read ${statePath} as a JSON object, so its MCP declarations could not be inspected.`,
          'Make that role-owned Claude state file readable and fix its JSON structure, then run setup again.')] };
      }
      const roleConflict = paseoMcpCheck(`claude.mcp.${role}`, statePath, roleServers);
      if (roleConflict) return { entries: [], checks: [...checks, roleConflict] };
      // Only an already-seeded role home can have drifted: an absent one is about to be
      // seeded from the same operator state this run just read.
      if (roleStateSource !== undefined) {
        const divergence = serverNameDivergence(operatorServers, roleServers);
        if (divergence) drift.push(mcpDriftCheck(role, target, statePath, divergence));
      }
      entries.push({ kind: 'dir', path: target });
      const memoryPath = join(target, 'CLAUDE.md');
      const memory = renderRoleMemory(memorySource, role, options.memoryContract ?? true);
      // Suppressed with no operator memory to carry: remove any file an earlier run wrote,
      // so a stale contract generation cannot outlive the option that turned it off.
      entries.push(memory === undefined
        ? { kind: 'absent', path: memoryPath }
        : { kind: 'file', path: memoryPath, content: memory });
      entries.push({ kind: 'file', path: join(target, 'settings.json'), content: renderRoleSettings(settingsSource, role, target) });
      entries.push({ kind: 'file', path: statePath, content: renderRoleState(stateSource), once: true });
      entries.push(...await roleResourceEntries({ role, target, home, names: SHARED, shared, executable: EXECUTABLE, reservedSkills: RUNTIME_SKILLS }));
      credentials.push(await claudeCredentialDiagnostic(layout, role, settingsSource, process.platform, binary));
      providerEnv[role] = { [SECURE_STORAGE_ENV]: target };
    }
    return { entries, credentials, checks: [...checks, ...drift], binary, providerEnv };
  },
};
