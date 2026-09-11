import { basename, join } from 'node:path';
import type { Layout } from '../layout.js';
import { roleHome } from '../layout.js';
import type { Entry } from '../fsops.js';
import { existingPaths, exists, readIfPresent } from '../fsops.js';
import { fail, pass, type Check } from '../result.js';
import type { Role } from '../roles.js';
import { renderInstructions } from '../room/instructions.js';
import { which } from '../which.js';
import type { Agent, AgentPlan } from './types.js';

/** Operator-authored resources shared by reference; native agent definitions stay out. */
const SHARED = [
  '.credentials.json', 'skills', 'plugins', 'commands', 'hooks', 'rules',
  'output-styles', 'keybindings.json', 'themes',
] as const;
const CONTROL_PLANE_ENV = {
  CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
} as const;
/** Copied once so a fresh role home does not re-run interactive onboarding. */
const SEEDED_KEYS = ['hasCompletedOnboarding', 'theme', 'installMethod', 'userID', 'mcpServers'] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}
/** Any unreadable or non-object source is simply an empty starting point. */
function readObject(source: string | undefined): Record<string, unknown> {
  try { return asObject(source === undefined ? {} : JSON.parse(source)); } catch { return {}; }
}

/** Keep operator configuration while closing non-Paseo inbound coordination. */
export function renderRoleSettings(source: string | undefined, role: Role): string {
  const settings = readObject(source);
  // Claude applies settings.env after the launch environment, so repeat these
  // provider pins here after operator values to make them effective.
  settings.env = { ...asObject(settings.env), ...CONTROL_PLANE_ENV, PASEO_ROOM_ROLE: role };
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

/** Preserve the operator's global memory, then add the stronger room role contract. */
export function renderRoleMemory(source: string | undefined, role: Role): string {
  const operator = source?.trim();
  return operator ? `${operator}\n\n${renderInstructions(role)}` : renderInstructions(role);
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
  async build(layout: Layout, roles: readonly Role[]): Promise<AgentPlan> {
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
    const stateSource = await readIfPresent(layout.claudeState);
    const memorySource = await readIfPresent(join(home, 'CLAUDE.md'));
    const shared = await existingPaths(home, SHARED);
    const entries: Entry[] = [];
    for (const role of roles) {
      const target = roleHome(layout, 'claude', role);
      entries.push({ kind: 'dir', path: target });
      entries.push({ kind: 'file', path: join(target, 'CLAUDE.md'), content: renderRoleMemory(memorySource, role) });
      entries.push({ kind: 'file', path: join(target, 'settings.json'), content: renderRoleSettings(settingsSource, role) });
      entries.push({ kind: 'file', path: join(target, '.claude.json'), content: renderRoleState(stateSource), once: true });
      for (const path of shared) entries.push({ kind: 'link', path: join(target, basename(path)), target: path });
    }
    return { entries, checks, binary };
  },
};
