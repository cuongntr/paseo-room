import { Command, CommanderError, InvalidArgumentError } from 'commander';
import metadata from '../package.json' with { type: 'json' };
import { loginRole, type LoginSpawner } from './auth.js';
import { remove, setup, verify, type RunOptions } from './commands.js';
import { renderHuman, renderJson } from './render.js';
import { exitCode, fail, failed, type Result } from './result.js';
import { AGENT_IDS, type AgentId } from './roles.js';
import { PromptAssetError } from './room/prompts.js';
import type { Prompts } from './wizard.js';

export interface Output {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
export interface CliContext {
  readonly isTTY?: boolean;
  readonly prompts?: Prompts;
  readonly options?: RunOptions;
  readonly loginSpawn?: LoginSpawner;
}

/** Commander passes no initial value, so the first call starts the list. */
function collectAgent(value: string, previous: AgentId[] | undefined): AgentId[] {
  const agent = AGENT_IDS.find(id => id === value);
  if (!agent) throw new InvalidArgumentError(`Unknown agent: ${value}`);
  const seated = previous ?? [];
  return seated.includes(agent) ? seated : [...seated, agent];
}

const PATH_FLAGS = ['roomHome', 'codexHome', 'claudeHome', 'piHome', 'codexBin', 'claudeBin', 'piBin', 'paseoBin'] as const;

function optionsFrom(raw: Record<string, unknown>, base: RunOptions): RunOptions {
  const paths: Record<string, string> = {};
  for (const flag of PATH_FLAGS) {
    const value = raw[flag];
    if (typeof value === 'string' && value.trim()) paths[flag] = value.trim();
  }
  const agents = Array.isArray(raw.agent) && raw.agent.length > 0 ? (raw.agent as AgentId[]) : undefined;
  return { ...base, ...paths, ...(agents ? { agents } : {}), ...(raw.apply === true ? { apply: true } : {}) };
}

function failedFromThrown(command: string, error: unknown): Result {
  if (error instanceof PromptAssetError) {
    return failed(command, [fail(
      `${command}.prompt-asset`,
      error.message,
      'Reinstall paseo-room, then try again.',
    )]);
  }
  const detail = error instanceof Error ? error.message : 'unknown error';
  return failed(command, [fail(
    `${command}.error`,
    detail,
    'Check that Paseo is running and reachable, then try again.',
  )]);
}

export async function runCli(argv: readonly string[], output: Output, context: CliContext = {}): Promise<number> {
  const password = (context.options?.env ?? process.env).PASEO_PASSWORD;
  const redact = (text: string): string => (password ? text.split(password).join('[redacted]') : text);
  // Set once the flags are parsed; the wizard path never sees flags, so text output is right there.
  let json = false;
  const emit = (result: Result): number => {
    output.stdout(redact(json ? renderJson(result) : renderHuman(result)));
    return exitCode(result);
  };
  const isTTY = context.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
  const base = context.options ?? {};

  if (argv.length === 0) {
    if (!isTTY) {
      output.stderr('paseo-room: no command given. Try: paseo-room setup, verify, remove, auth login, or --help.\n');
      return 2;
    }
    let wizardCommand = 'wizard';
    try {
      // @clack/prompts is only reachable here, so keep it off the scripted path.
      const { runWizard, terminalPrompts } = await import('./wizard.js');
      return await runWizard(
        context.prompts ?? terminalPrompts,
        emit,
        text => { output.stdout(text); },
        base,
        action => { wizardCommand = action; },
      );
    } catch (error) {
      return emit(failedFromThrown(wizardCommand, error));
    }
  }
  const program = new Command()
    .name('paseo-room')
    .description('Configure Codex/Claude/Pi role homes in $HOME and register them with your local Paseo daemon.')
    .version(metadata.version)
    .usage('<setup|verify|remove> [options]\n       auth login <codex|claude|pi> <supervisor|lead|peer> [options]')
    .argument('<command>', 'setup | verify | remove | auth')
    .argument('[command-arguments...]', 'auth login <agent> <role>')
    .option('--agent <agent>', 'codex, claude, or pi; repeat to combine (default: codex)', collectAgent)
    .option('--apply', 'actually make the changes (default: dry run)')
    .option('--json', 'machine-readable output')
    .option('--room-home <path>', 'where role homes are written (default: ~/.paseo-room)')
    .option('--codex-home <path>', 'source Codex config (default: ~/.codex)')
    .option('--claude-home <path>', 'source Claude Code config (default: ~/.claude)')
    .option('--pi-home <path>', 'source Pi config (default: ~/.pi/agent)')
    .option('--codex-bin <path>', 'Codex executable (default: found on PATH)')
    .option('--claude-bin <path>', 'Claude Code executable (default: found on PATH)')
    .option('--pi-bin <path>', 'Pi executable (default: found on PATH)')
    .option('--paseo-bin <path>', 'Paseo executable (default: found on PATH)')
    .configureOutput({ writeOut: text => { output.stdout(text); }, writeErr: text => { output.stderr(text); } })
    .exitOverride();

  let command: string;
  let commandArguments: string[];
  let options: RunOptions;
  let raw: Record<string, unknown>;
  try {
    program.parse([...argv], { from: 'user' });
    raw = program.opts<Record<string, unknown>>();
    json = raw.json === true;
    command = program.args[0] ?? '';
    commandArguments = program.args.slice(1);
    options = optionsFrom(raw, base);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    return 2;
  }

  try {
    if (command === 'auth') {
      if (raw.apply === true) {
        output.stderr('paseo-room auth login is already explicit and does not use --apply.\n');
        return 2;
      }
      if (raw.json === true) {
        output.stderr('paseo-room auth login is interactive and does not support --json.\n');
        return 2;
      }
      if (raw.agent !== undefined) {
        output.stderr('paseo-room auth login takes exactly one positional agent and does not use --agent.\n');
        return 2;
      }
      if (commandArguments.length !== 3 || commandArguments[0] !== 'login') {
        output.stderr('Usage: paseo-room auth login <codex|claude|pi> <supervisor|lead|peer>\n');
        return 2;
      }
      return await loginRole(commandArguments[1] ?? '', commandArguments[2] ?? '', {
        ...options,
        isTTY,
        ...(context.loginSpawn ? { spawn: context.loginSpawn } : {}),
      }, output);
    }
    if (commandArguments.length > 0) {
      output.stderr(`paseo-room ${command}: unexpected arguments: ${commandArguments.join(' ')}\n`);
      return 2;
    }
    if (command === 'setup') return emit(await setup(options));
    if (command === 'verify') return emit(await verify(options));
    if (command === 'remove') return emit(await remove(options));
  } catch (error) {
    return emit(failedFromThrown(command, error));
  }
  output.stderr(`paseo-room: unknown command "${command}". Try: setup, verify, remove, or auth login.\n`);
  return 2;
}
