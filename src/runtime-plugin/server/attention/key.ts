/**
 * The sensor key (docs/design/runtime-coordination-attention.md A-D7). Written through a
 * write-only RPC to one owner-only file under the runtime root, or supplied in the daemon's
 * environment; never a setting, since Paseo returns host settings to every client, and never
 * returned by any call. Only the sensor adapter reads it, to set one request header.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory } from '../store/publish.js';

export const KEY_ENV = 'PASEO_ROOM_ATTENTION_KEY';

export class AttentionKey {
  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  static at(runtimeRoot: string, env?: NodeJS.ProcessEnv): AttentionKey {
    return new AttentionKey(join(runtimeRoot, 'secrets', 'attention-key'), env);
  }

  async set(key: string): Promise<void> {
    const value = key.trim();
    if (value === '' || value.length > 4_096 || /\s/.test(value)) throw new Error('The key must be one non-empty token.');
    await ensurePrivateDirectory(dirname(this.file));
    const temporary = `${this.file}.tmp-${String(process.pid)}`;
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }

  /** The stored key, else the environment's; undefined when neither exists. */
  async read(): Promise<string | undefined> {
    const stored = await readFile(this.file, 'utf8').then(text => text.trim(), () => '');
    if (stored !== '') return stored;
    const fromEnv = this.env[KEY_ENV]?.trim();
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  }

  async configured(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }
}
