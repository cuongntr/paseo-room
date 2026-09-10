import { Command, CommanderError } from 'commander';
import metadata from '../package.json' with { type: 'json' };
import { remove, setup, verify, type RunOptions } from './commands.js';
import { renderHuman, renderJson } from './render.js';
import { exitCode, fail, failed, type Result } from './result.js';
import { AGENT_IDS, type AgentId } from './roles.js';
import type { Prompts } from './wizard.js';

export interface Output {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
export interface CliContext {
  readonly isTTY?: boolean;
  readonly prompts?: Prompts;
  readonly options?: RunOptions;
}

/** Commander passes no initial value, so the first call starts the list. */
function collectAgent(value: string, previous: AgentId[] | undefined): AgentId[] {
  const agent = AGENT_IDS.find(id => id === value);
  if (!agent) throw new CommanderError(2, 'agent', `Unknown agent: ${value}`);
  const seated = previous ?? [];
  return seated.includes(agent) ? seated : [...seated, agent];
}

const PATH_FLAGS = ['roomHome', 'codexHome', 'claudeHome', 'codexBin', 'claudeBin', 'paseoBin'] as const;

function optionsFrom(raw: Record<string, unknown>, base: RunOptions): RunOptions {
  const paths: Record<string, string> = {};
  for (const flag of PATH_FLAGS) {
    const value = raw[flag];
    if (typeof value === 'string' && value.trim()) paths[flag] = value.trim();
  }
  const agents = Array.isArray(raw.agent) && raw.agent.length > 0 ? (raw.agent as AgentId[]) : undefined;
  return { ...base, ...paths, ...(agents ? { agents } : {}), ...(raw.apply === true ? { apply: true } : {}) };
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
  const isTTY = context.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  const base = context.options ?? {};

  if (argv.length === 0) {
    if (!isTTY) {
      output.stderr('paseo-room: no command given. Try: paseo-room setup, verify, remove, or --help.\n');
      return 2;
    }
    // @clack/prompts is only reachable here, so keep it off the scripted path.
    const { runWizard, terminalPrompts } = await import('./wizard.js');
    return runWizard(context.prompts ?? terminalPrompts, emit, text => { output.stdout(text); }, base);
  }

  const program = new Command()
    .name('paseo-room')
    .description('Configure Codex/Claude role homes in $HOME and register them with your local Paseo daemon.')
    .version(metadata.version)
    .argument('<command>', 'setup | verify | remove')
    .option('--agent <agent>', 'codex or claude; repeat for both (default: codex)', collectAgent)
    .option('--apply', 'actually make the changes (default: dry run)')
    .option('--json', 'machine-readable output')
    .option('--room-home <path>', 'where role homes are written (default: ~/.paseo-room)')
    .option('--codex-home <path>', 'source Codex config (default: ~/.codex)')
    .option('--claude-home <path>', 'source Claude Code config (default: ~/.claude)')
    .option('--codex-bin <path>', 'Codex executable (default: found on PATH)')
    .option('--claude-bin <path>', 'Claude Code executable (default: found on PATH)')
    .option('--paseo-bin <path>', 'Paseo executable (default: found on PATH)')
    .configureOutput({ writeOut: text => { output.stdout(text); }, writeErr: text => { output.stderr(text); } })
    .exitOverride();

  let command: string;
  let options: RunOptions;
  try {
    program.parse([...argv], { from: 'user' });
    const raw = program.opts<Record<string, unknown>>();
    json = raw.json === true;
    command = program.args[0] ?? '';
    options = optionsFrom(raw, base);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    return 2;
  }

  try {
    if (command === 'setup') return emit(await setup(options));
    if (command === 'verify') return emit(await verify(options));
    if (command === 'remove') return emit(await remove(options));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return emit(failed(command, [fail(`${command}.error`, redact(detail), 'Check that Paseo is running and reachable, then try again.')]));
  }
  output.stderr(`paseo-room: unknown command "${command}". Try: setup, verify, remove.\n`);
  return 2;
}
