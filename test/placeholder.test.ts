import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runCli } from '../src/cli/command.js';
import { COMMANDS } from '../src/core/intent.js';
import { commandResultSchema } from '../src/core/result.js';
import { snapshotFixture } from './helpers/home.js';

it.each(['absent', 'empty', 'populated'])('real read-only routing preserves %s disposable homes', async state => {
  const root = mkdtempSync(join(tmpdir(), 'paseo-room-plan-'));
  const home = join(root, 'home');
  try {
    if (state === 'empty') mkdirSync(home);
    if (state === 'populated') {
      cpSync(fileURLToPath(new URL('./fixtures/home', import.meta.url)), home, { recursive: true });
      symlinkSync('untouched.txt', join(home, 'link'));
    }
    const before = snapshotFixture(root);
    for (const command of COMMANDS) {
      let stdout = ''; let stderr = '';
      const status = await runCli([command, '--json', '--non-interactive', '--room-home', join(home, 'room'),
        '--codex-home', join(home, '.codex'), '--codex-bin', join(home, 'missing-codex'), '--paseo-bin', join(home, 'missing-paseo')],
      { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
      expect(status).toBe(1); expect(stderr).toBe('');
      expect(commandResultSchema.parse(JSON.parse(stdout))).toMatchObject({ command, changed: false, outcome: 'failed' });
      expect(snapshotFixture(root)).toEqual(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
