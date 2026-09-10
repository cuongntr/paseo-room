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

/** Operator resources shared by reference; credentials stay where Claude put them. */
const SHARED = ['.credentials.json', 'skills', 'plugins', 'commands', 'hooks'] as const;
/** Copied once so a fresh role home does not re-run interactive onboarding. */
const SEEDED_KEYS = ['hasCompletedOnboarding', 'theme', 'installMethod', 'userID', 'oauthAccount'] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}
/** Any unreadable or non-object source is simply an empty starting point. */
function readObject(source: string | undefined): Record<string, unknown> {
  try { return asObject(source === undefined ? {} : JSON.parse(source)); } catch { return {}; }
}

/** Keep the operator's hooks and env (Paseo installs its own), override nothing else. */
export function renderRoleSettings(source: string | undefined, role: Role): string {
  const settings = readObject(source);
  settings.env = { ...asObject(settings.env), PASEO_ROOM_ROLE: role };
  return JSON.stringify(settings, null, 2) + '\n';
}

export function renderRoleState(source: string | undefined): string {
  const root = readObject(source);
  const state: Record<string, unknown> = { hasCompletedOnboarding: true };
  for (const key of SEEDED_KEYS) if (key in root) state[key] = root[key];
  return JSON.stringify(state, null, 2) + '\n';
}

export const claudeAgent: Agent = {
  id: 'claude',
  label: 'Claude Code',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  // Claude's own subagents would be a second control plane; Paseo owns agent
  // lifecycle. This is the Claude counterpart of Codex's [agents] enabled = false.
  pins: { disallowedTools: ['Task'] },
  async build(layout: Layout, roles: readonly Role[]): Promise<AgentPlan> {
    const home = layout.agentHome.claude;
    const binary = await which(layout.bin.claude, layout.path);
    if (!binary) {
      return { entries: [], checks: [fail('claude.bin', 'Claude Code executable not found.', 'Install Claude Code, or pass --claude-bin /path/to/claude.')] };
    }
    if (!(await exists(home))) {
      return { entries: [], checks: [fail('claude.home', `No Claude config directory at ${home}.`, 'Run claude once to initialise it, or pass --claude-home.')] };
    }
    const checks: Check[] = [pass('claude.home', `Claude Code found at ${binary} using ${home}.`)];

    const settingsSource = await readIfPresent(join(home, 'settings.json'));
    const stateSource = await readIfPresent(join(layout.home, '.claude.json'));
    const shared = await existingPaths(home, SHARED);
    const entries: Entry[] = [];
    for (const role of roles) {
      const target = roleHome(layout, 'claude', role);
      entries.push({ kind: 'dir', path: target });
      entries.push({ kind: 'file', path: join(target, 'CLAUDE.md'), content: renderInstructions(role) });
      entries.push({ kind: 'file', path: join(target, 'settings.json'), content: renderRoleSettings(settingsSource, role) });
      entries.push({ kind: 'file', path: join(target, '.claude.json'), content: renderRoleState(stateSource), once: true });
      for (const path of shared) entries.push({ kind: 'link', path: join(target, basename(path)), target: path });
    }
    return { entries, checks, binary };
  },
};
