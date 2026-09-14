import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { roleCommand } from './credentials.js';
import { resolveLayout, roleHome, type Options } from './layout.js';
import { MARKER, readMarker } from './room.js';
import { AGENT_IDS, ROLES, type AgentId, type Role } from './roles.js';
import { which } from './which.js';

export const AUTHENTICATION_GUIDE = 'AUTHENTICATION.md';
/** A truthy empty override suppresses Pi's role-home APPEND_SYSTEM.md discovery. */
export const PI_AUTH_ARGV = ['--no-extensions', '--no-approve', '--append-system-prompt', ''] as const;

/** A copy-paste-safe Pi login command that cannot inherit the caller repository cwd. */
export function piLoginCommand(rolePath: string, binary: string): string {
  const command = roleCommand({ PI_CODING_AGENT_DIR: rolePath }, binary, PI_AUTH_ARGV);
  return `cd ${roleCommand({}, rolePath)} && ${command}`;
}

export interface LoginOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface LoginSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly shell: false;
  readonly stdio: 'inherit';
}

export interface LoginChild {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type LoginSpawner = (executable: string, argv: readonly string[], options: LoginSpawnOptions) => LoginChild;

const spawnLogin: LoginSpawner = (executable, argv, options) => spawn(executable, [...argv], options);

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function loginInvocation(agent: AgentId, rolePath: string, binary: string): {
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly command: string;
} {
  if (agent === 'codex') {
    const env = { CODEX_HOME: rolePath };
    const argv = ['login'] as const;
    return { env, argv, command: roleCommand(env, binary, argv) };
  }
  if (agent === 'claude') {
    const env = { CLAUDE_CONFIG_DIR: rolePath, CLAUDE_SECURESTORAGE_CONFIG_DIR: rolePath };
    const argv = ['auth', 'login'] as const;
    return { env, argv, command: roleCommand(env, binary, argv) };
  }
  const env = { PI_CODING_AGENT_DIR: rolePath };
  const argv = PI_AUTH_ARGV;
  return { env, argv, cwd: rolePath, command: piLoginCommand(rolePath, binary) };
}

/** Deterministic, secret-free instructions using setup's resolved executables. */
export function renderAuthenticationGuide(
  roomHome: string,
  binaries: Readonly<Partial<Record<AgentId, string>>>,
  agents: readonly AgentId[],
  roles: readonly Role[],
): string {
  const lines = [
    '# Role authentication',
    '',
    'Setup and verify do not validate authentication, inspect credential contents, query keyrings,',
    'or test token freshness. Run the command for each role you want to authenticate.',
    '',
  ];
  for (const agent of agents) {
    const binary = binaries[agent];
    if (!binary) throw new Error(`Cannot render authentication guidance without the resolved ${agent} executable.`);
    lines.push(`## ${agent === 'claude' ? 'Claude Code' : title(agent)}`, '');
    for (const role of roles) {
      const invocation = loginInvocation(agent, join(roomHome, 'roles', agent, role), binary);
      lines.push(`### ${title(role)}`, '', '```sh', invocation.command, '```', '');
      if (agent === 'pi') {
        lines.push('Run `/login`, then exit Pi when authentication completes. This minimal interactive',
          'login session starts in the role home, not the caller repository, disables extension discovery and',
          'approval files, and suppresses role-home APPEND_SYSTEM.md discovery;',
          'it is not equivalent to launching the room seat through Paseo.', '');
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function realDirectory(path: string): Promise<'directory' | 'missing' | 'unsafe'> {
  try {
    return (await lstat(path)).isDirectory() ? 'directory' : 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

function usageError(output: LoginOutput, detail: string): number {
  output.stderr(`paseo-room auth login: ${detail}\n`);
  return 2;
}

export interface LoginOptions extends Options {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
  readonly spawn?: LoginSpawner;
}

/** Launch one vendor's normal interactive login without touching credential stores itself. */
export async function loginRole(
  agentValue: string,
  roleValue: string,
  options: LoginOptions,
  output: LoginOutput,
): Promise<number> {
  const agent = AGENT_IDS.find(value => value === agentValue);
  if (!agent) return usageError(output, `unknown agent "${agentValue}"; expected codex, claude, or pi.`);
  const role = ROLES.find(value => value === roleValue);
  if (!role) return usageError(output, `unknown role "${roleValue}"; expected supervisor, lead, or peer.`);
  if (!options.isTTY) {
    output.stderr('paseo-room auth login requires interactive stdin, stdout, and stderr terminals.\n');
    return 1;
  }

  const env = options.env ?? process.env;
  const layout = resolveLayout(options, env);
  if (await realDirectory(layout.roomHome) !== 'directory') {
    output.stderr(`No room found at ${layout.roomHome}. Run: paseo-room setup --apply\n`);
    return 1;
  }
  try {
    if (!(await lstat(join(layout.roomHome, MARKER))).isFile()) throw new Error('not a regular marker');
  } catch {
    output.stderr(`No valid room marker found at ${join(layout.roomHome, MARKER)}. Run: paseo-room setup --apply\n`);
    return 1;
  }
  const marker = await readMarker(layout);
  if (!marker) {
    output.stderr(`No valid room marker found at ${join(layout.roomHome, MARKER)}. Run: paseo-room setup --apply\n`);
    return 1;
  }
  if (!marker.agents.includes(agent)) {
    output.stderr(`${title(agent)} is not selected in this room. Re-run setup with --agent ${agent} --apply.\n`);
    return 1;
  }
  if (!marker.roles.includes(role)) {
    output.stderr(`${title(role)} is not installed for ${agent} in this room. Re-run setup --apply.\n`);
    return 1;
  }
  const rolePath = roleHome(layout, agent, role);
  for (const path of [join(layout.roomHome, 'roles'), join(layout.roomHome, 'roles', agent), rolePath]) {
    if (await realDirectory(path) !== 'directory') {
      output.stderr(`The selected ${agent} ${role} role is not safely installed at ${rolePath}. Run: paseo-room setup --apply\n`);
      return 1;
    }
  }

  const binary = await which(layout.bin[agent], layout.searchPath);
  if (!binary) {
    output.stderr(`${title(agent)} executable not found. Install it, or pass --${agent}-bin /path/to/${agent}.\n`);
    return 1;
  }
  const invocation = loginInvocation(agent, rolePath, binary);
  if (agent === 'pi') {
    output.stdout(`Starting a minimal interactive Pi login session for ${role} in its role home. Run /login, then exit Pi when authentication completes.\n`);
    output.stdout('Extensions and approval files are disabled, and role APPEND_SYSTEM.md discovery is suppressed.\n');
    output.stdout('This is not a room-equivalent Paseo launch.\n');
  } else {
    output.stdout(`Starting ${agent === 'claude' ? 'Claude Code' : 'Codex'} login for ${role}.\n`);
  }

  const childEnv = { ...env, ...invocation.env };
  const launch = options.spawn ?? spawnLogin;
  return new Promise(resolve => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child: LoginChild;
    try {
      child = launch(binary, invocation.argv, {
        env: childEnv,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        shell: false,
        stdio: 'inherit',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      output.stderr(`Could not start ${agent} login: ${detail}\n`);
      finish(1);
      return;
    }
    child.once('error', error => {
      output.stderr(`Could not start ${agent} login: ${error.message}\n`);
      finish(1);
    });
    child.once('close', (code, signal) => {
      if (code !== null) {
        finish(code);
        return;
      }
      if (signal) {
        const signalNumber = constants.signals[signal];
        const mapped = typeof signalNumber === 'number' ? 128 + signalNumber : 1;
        output.stderr(`${title(agent)} login ended from signal ${signal}; returning ${String(mapped)}.\n`);
        finish(mapped);
        return;
      }
      output.stderr(`${title(agent)} login ended without an exit code or signal.\n`);
      finish(1);
    });
  });
}
