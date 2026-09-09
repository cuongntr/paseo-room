import { describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  text: vi.fn(() => Promise.resolve('text')),
  password: vi.fn(() => Promise.resolve('masked')),
  confirm: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@clack/prompts', () => clack);

import { terminalPrompts } from '../src/cli/wizard.js';

describe('terminal wizard prompt confidentiality', () => {
  it('routes Paseo URL input through Clack password masking rather than echoing text', async () => {
    await expect(terminalPrompts.masked({ key: 'paseoUrl', message: 'Local URL' })).resolves.toBe('masked');
    expect(clack.password).toHaveBeenCalledWith({ message: 'Local URL', mask: '•', clearOnError: true });
    expect(clack.text).not.toHaveBeenCalled();
  });
});
