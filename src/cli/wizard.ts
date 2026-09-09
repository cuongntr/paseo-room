import * as clack from '@clack/prompts';
import { normalizedIntentSchema, type NormalizedIntent } from '../core/intent.js';
import { type CommandResult } from '../core/result.js';
import { runLifecycle, type LifecycleServices } from './lifecycle.js';
import { exitCodeFor } from './render.js';

const overrides = [
  ['roomHome', 'Managed room home'],
  ['codexHome', 'Canonical Codex home'],
  ['codexBin', 'Codex executable'],
  ['paseoBin', 'Paseo executable'],
  ['paseoUrl', 'Local Paseo WebSocket URL'],
] as const;
type Override = typeof overrides[number][0];

/** Symbols represent prompt cancellation; only literal true authorizes apply. */
export interface WizardPrompts {
  text(options: { readonly key: Exclude<Override, 'paseoUrl'>; readonly message: string }): Promise<string | symbol>;
  masked(options: { readonly key: 'paseoUrl'; readonly message: string }): Promise<string | symbol>;
  confirm(options: { readonly message: string; readonly initialValue: false }): Promise<boolean | symbol>;
}
export const terminalPrompts: WizardPrompts = {
  text: ({ message }) => clack.text({ message, placeholder: 'Leave blank to use the default' }),
  // A malformed credential-bearing URL must not be echoed before validation rejects it.
  masked: ({ message }) => clack.password({ message, mask: '•', clearOnError: true }),
  confirm: options => clack.confirm(options),
};

/** Presentation only: both previews and confirmed execution use the flag lifecycle. */
export async function runWizard(
  prompts: WizardPrompts,
  emit: (result: CommandResult) => number,
  write: (text: string) => void,
  services?: LifecycleServices,
): Promise<number> {
  const noChange = (): number => { write('Setup cancelled; no changes made.\n'); return 0; };
  write('Codex room setup — leave optional overrides blank to use defaults.\n');
  const answers: Partial<Record<Override, string>> = {};
  for (const [key, label] of overrides) {
    const message = `${label} (optional${key === 'paseoUrl' ? '; input is masked' : ''})`;
    const answer = key === 'paseoUrl' ? await prompts.masked({ key, message }) : await prompts.text({ key, message });
    if (typeof answer === 'symbol') return noChange();
    if (answer.trim()) answers[key] = answer.trim();
  }
  const parsed = normalizedIntentSchema.safeParse({ command: 'install', agent: 'codex', apply: false,
    json: false, nonInteractive: false, ...answers });
  if (!parsed.success) return emit({ schemaVersion: 1, command: 'install', outcome: 'failed', changed: false, operations: [],
    checks: [{ id: 'wizard.input', status: 'fail', message: 'Invalid setup override.',
      remediation: 'Use safe paths and a local WebSocket URL without credentials, query or fragment.' }] });
  const intent: NormalizedIntent = parsed.data;
  const preview = await runLifecycle(intent, services);
  const status = emit(preview);
  if (exitCodeFor(preview) !== 0 || preview.outcome !== 'changes-planned' || !preview.operations.length) return status;
  const approved = await prompts.confirm({ message: 'Apply this Codex room setup?', initialValue: false });
  if (approved !== true) return noChange();
  // Re-prepare after consent so stale observations never become mutation authority.
  return emit(await runLifecycle({ ...intent, apply: true }, services));
}
