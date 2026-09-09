import { Command, CommanderError } from 'commander';
import metadata from '../../package.json' with { type: 'json' };
import { commandSchema, normalizedIntentSchema } from '../core/intent.js';
import { type CommandResult } from '../core/result.js';
import { failure, runLifecycle, type LifecycleServices } from './lifecycle.js';
import { exitCodeFor, renderHuman, renderJson } from './render.js';
import { runWizard, terminalPrompts, type WizardPrompts } from './wizard.js';

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
export interface CliInteraction {
  readonly isTTY: boolean;
  readonly prompts?: WizardPrompts;
}
/** Never echo raw parser/SDK/process failures or terminal control sequences. */
export async function runCli(argv: readonly string[], output: CliOutput, services?: LifecycleServices,
  interaction: CliInteraction = { isTTY: Object.is(process.stdin.isTTY, true) && Object.is(process.stdout.isTTY, true) },
): Promise<number> {
  const json = argv.includes('--json');
  const selected = commandSchema.safeParse(argv.find(arg => !arg.startsWith('-')));
  let command = selected.success ? selected.data : 'plan' as const;
  const sanitize = (text: string): string => {
    const password = process.env.PASEO_PASSWORD;
    return (password ? text.split(password).join('[redacted]') : text).replace(/[\p{Cc}]/gu, character => ['\n', '\t'].includes(character) ? character : '');
  };
  const emit = (result: CommandResult): number => {
    const safe: CommandResult = { ...result,
      checks: result.checks.map(check => ({ ...check, id: sanitize(check.id), message: sanitize(check.message),
        ...(check.remediation ? { remediation: sanitize(check.remediation) } : {}) })),
      operations: result.operations.map(operation => ({ ...operation, description: sanitize(operation.description),
        target: operation.target.kind === 'provider' ? operation.target : { ...operation.target, path: sanitize(operation.target.path) } })),
    };
    output.stdout(json ? renderJson(safe) : renderHuman(safe));
    return exitCodeFor(result);
  };
  if (argv.length === 0 && interaction.isTTY) {
    try { return await runWizard(interaction.prompts ?? terminalPrompts, emit, text => { output.stdout(sanitize(text)); }, services); }
    catch { return emit(failure({ command: 'install' })); }
  }
  const parser = new Command().name('paseo-room')
    .description('Manage a Codex Paseo Room. Dry-run is the default; use --apply to authorize mutation.')
    .version(metadata.version)
    .argument('<command>', 'plan | install | verify | doctor | recover | uninstall')
    .option('--agent <agent>', 'Room adapter', 'codex')
    .option('--apply', 'Explicitly authorize install, recover or uninstall')
    .option('--json', 'Emit one schema-v1 JSON document').option('--non-interactive', 'Never prompt')
    .option('--room-home <path>').option('--codex-home <path>')
    .option('--codex-bin <path>').option('--paseo-bin <path>').option('--paseo-url <ws-url>')
    .configureOutput({ writeOut: text => { if (!json) output.stdout(sanitize(text)); }, writeErr: () => {} })
    .exitOverride();
  let intent;
  try {
    for (const [index, arg] of argv.entries()) {
      if (['--agent', '--room-home', '--codex-home', '--codex-bin', '--paseo-bin', '--paseo-url'].includes(arg) &&
          (argv[index + 1] === undefined || argv[index + 1]?.startsWith('--'))) parser.error('Missing option value.');
    }
    parser.parse([...argv], { from: 'user' });
    const options = parser.opts<Record<string, unknown>>();
    intent = normalizedIntentSchema.parse({ ...options, command: parser.args[0],
      apply: options['apply'] === true, json, nonInteractive: options['nonInteractive'] === true });
    command = intent.command;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      if (json) emit({ schemaVersion: 1, command, outcome: 'ok', changed: false, operations: [],
        checks: [{ id: 'cli.information', status: 'pass', message: `paseo-room ${metadata.version}. Commands: plan, install, verify, doctor, recover, uninstall. Dry-run is the default.` }] });
      return 0;
    }
    const result: CommandResult = { schemaVersion: 1, command, outcome: 'failed', changed: false, operations: [],
      checks: [{ id: 'cli.usage', status: 'fail', message: 'Invalid or missing lifecycle command or option.',
        remediation: 'Use --help for supported commands and options, or run without arguments in a terminal for guided setup.' }] };
    if (json) emit(result);
    else output.stderr(`error: ${result.checks[0]?.message ?? 'Invalid usage.'}\n`);
    return 2;
  }
  try { return emit(await runLifecycle(intent, services)); }
  catch { return emit(failure(intent)); }
}
