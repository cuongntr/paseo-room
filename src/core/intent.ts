import { z } from 'zod';

export const COMMANDS = ['plan', 'install', 'verify', 'doctor', 'recover', 'uninstall'] as const;
export const commandSchema = z.enum(COMMANDS);
export type LifecycleCommand = z.infer<typeof commandSchema>;
const pathInput = z.string().trim().min(1).refine((value) => !value.includes('\0'), 'NUL is not allowed');

/** Resolved options, not resolved filesystem paths. No credentials belong in intent. */
export const normalizedIntentSchema = z.strictObject({
  command: commandSchema,
  agent: z.literal('codex'),
  apply: z.boolean(),
  json: z.boolean(),
  nonInteractive: z.boolean(),
  roomHome: pathInput.optional(),
  codexHome: pathInput.optional(),
  codexBin: pathInput.optional(),
  paseoBin: pathInput.optional(),
  paseoUrl: z.url().refine((value) => {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  }, 'A local WebSocket endpoint without credentials is required').optional(),
}).refine((intent) => !intent.apply || ['install', 'recover', 'uninstall'].includes(intent.command), {
  message: 'This command is read-only', path: ['apply'],
});
export type NormalizedIntent = z.infer<typeof normalizedIntentSchema>;
