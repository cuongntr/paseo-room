import * as clack from '@clack/prompts';
import { AGENTS, remove, setup, verify, type RunOptions } from './commands.js';
import type { Result } from './result.js';
import { AGENT_IDS, type AgentId } from './roles.js';

export interface Prompts {
  select(options: { readonly message: string; readonly options: readonly { readonly value: string; readonly label: string }[] }): Promise<string | symbol>;
  multiselect(options: { readonly message: string; readonly options: readonly { readonly value: AgentId; readonly label: string }[] }): Promise<AgentId[] | symbol>;
  confirm(options: { readonly message: string }): Promise<boolean | symbol>;
}
export const terminalPrompts: Prompts = {
  select: options => clack.select({ message: options.message, options: [...options.options] }),
  multiselect: options => clack.multiselect({ message: options.message, options: [...options.options], required: true }),
  confirm: options => clack.confirm({ message: options.message, initialValue: false }),
};

/** Guided path over the same commands the flags use; nothing extra happens here. */
export async function runWizard(
  prompts: Prompts,
  emit: (result: Result) => number,
  write: (text: string) => void,
  options: RunOptions = {},
  onAction?: (action: string) => void,
): Promise<number> {
  const cancelled = (): number => { write('Cancelled; nothing was changed.\n'); return 0; };
  const action = await prompts.select({
    message: 'What do you want to do?',
    options: [
      { value: 'setup', label: 'Set up / update the room (login stays separate)' },
      { value: 'verify', label: 'Verify the current room' },
      { value: 'remove', label: 'Remove the room' },
    ],
  });
  if (typeof action === 'symbol') return cancelled();
  onAction?.(action);
  if (action === 'verify') return emit(await verify(options));
  if (action === 'remove') {
    const preview = await remove(options);
    const status = emit(preview);
    if (preview.outcome !== 'changes-planned') return status;
    const approved = await prompts.confirm({ message: 'Delete the room home, including role credentials, and its Paseo providers?' });
    return approved === true ? emit(await remove({ ...options, apply: true })) : cancelled();
  }
  const agents = await prompts.multiselect({
    message: 'Which coding agents should the room use?',
    options: AGENT_IDS.map(value => ({ value, label: AGENTS[value].label })),
  });
  if (typeof agents === 'symbol' || agents.length === 0) return cancelled();
  // Only meaningful for Claude: the other adapters have no plugin carrier to fall back from.
  let claudeMemoryContract = true;
  if (agents.includes('claude')) {
    const carrier = await prompts.select({
      message: 'Claude role contract carrier: the room plugin is always used. Also write the contract into each role CLAUDE.md?',
      options: [
        { value: 'both', label: 'Yes — keep it as a fallback (recommended; resume behaviour is unproven)' },
        { value: 'plugin', label: 'No — plugin only; CLAUDE.md keeps your global memory alone' },
      ],
    });
    if (typeof carrier === 'symbol') return cancelled();
    claudeMemoryContract = carrier === 'both';
  }
  // Runtime coordination is an explicit opt-in, never a default: it installs trusted plugin code.
  const coordination = await prompts.select({
    message: 'Runtime coordination (preview): track assignments, Peer reports and writer ownership through a trusted Paseo plugin?',
    options: [
      { value: 'off', label: 'No — keep the room as it is (default)' },
      { value: 'runtime', label: 'Yes — install the paseo-room-runtime plugin (trusted, unsandboxed code)' },
    ],
  });
  if (typeof coordination === 'symbol') return cancelled();
  const setupOptions = { ...options, agents, claudeMemoryContract, ...(coordination === 'runtime' ? { runtime: true } : {}) };
  const preview = await setup(setupOptions);
  const status = emit(preview);
  if (preview.outcome !== 'changes-planned') return status;
  const approved = await prompts.confirm({ message: 'Apply these changes? Authentication will not be validated or started.' });
  if (approved !== true) return cancelled();
  return emit(await setup({ ...setupOptions, apply: true }));
}
