import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fail, type Check } from './result.js';
import type { AgentId, Role } from './roles.js';

export interface Options {
  readonly roomHome?: string;
  readonly codexHome?: string;
  readonly claudeHome?: string;
  readonly codexBin?: string;
  readonly claudeBin?: string;
  readonly paseoBin?: string;
}
export interface Layout {
  readonly home: string;
  readonly roomHome: string;
  readonly paseoHome: string;
  readonly agentHome: Record<AgentId, string>;
  readonly bin: Record<AgentId | 'paseo', string>;
}

function pick(...candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) if (candidate?.trim()) return candidate.trim();
  throw new Error('Could not determine HOME; pass explicit --room-home and --codex-home/--claude-home paths.');
}

/** Everything is derived from HOME; flags and environment only override defaults. */
export function resolveLayout(options: Options = {}, env: NodeJS.ProcessEnv = process.env): Layout {
  const home = pick(env.HOME, homedir());
  // Relative overrides resolve against the working directory, as a CLI flag should.
  return {
    home,
    roomHome: resolve(pick(options.roomHome, env.PASEO_ROOM_HOME, join(home, '.paseo-room'))),
    paseoHome: resolve(pick(env.PASEO_HOME, join(home, '.paseo'))),
    agentHome: {
      codex: resolve(pick(options.codexHome, env.CODEX_HOME, join(home, '.codex'))),
      claude: resolve(pick(options.claudeHome, env.CLAUDE_CONFIG_DIR, join(home, '.claude'))),
    },
    bin: {
      codex: pick(options.codexBin, env.CODEX_BIN, 'codex'),
      claude: pick(options.claudeBin, env.CLAUDE_BIN, 'claude'),
      paseo: pick(options.paseoBin, env.PASEO_BIN, 'paseo'),
    },
  };
}

/** True when `path` is the root itself or sits underneath it. */
export function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The room home must own its directory: no overlap with $HOME or a source agent home. */
export function layoutChecks(layout: Layout, agents: readonly AgentId[]): Check[] {
  const checks: Check[] = [];
  if (contains(layout.roomHome, layout.home)) {
    checks.push(fail('room.home', `Refusing to use ${layout.roomHome} as the room home: it contains your home directory.`,
      'Point --room-home at a dedicated directory, by default ~/.paseo-room.'));
  }
  for (const id of agents) {
    const home = layout.agentHome[id];
    if (contains(layout.roomHome, home) || contains(home, layout.roomHome)) {
      checks.push(fail(`${id}.home`, `The ${id} home ${home} overlaps the room home ${layout.roomHome}.`,
        `Pass --${id}-home pointing at your own ${id} configuration (this happens when setup runs inside a room seat).`));
    }
  }
  return checks;
}

export function roleHome(layout: Layout, agent: AgentId, role: Role): string {
  return join(layout.roomHome, 'roles', agent, role);
}
export function sharedRoom(layout: Layout): string {
  return join(layout.roomHome, 'room');
}
