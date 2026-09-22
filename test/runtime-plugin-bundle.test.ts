/**
 * Compiles the plugin entries the way Paseo 0.8.0 does — esbuild CommonJS with host modules
 * external, the eager interop rewrite, and the CommonJS wrapper — and evaluates the result.
 * The eager rewrite copies exports before a `const` initializer runs, which is why the entries
 * must default-export hoisted function declarations.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(import.meta.dirname, '..', 'src', 'runtime-plugin');
const SDK = ['@getpaseo/plugin', '@getpaseo/plugin/server', '@getpaseo/plugin/server/provider', '@getpaseo/plugin/server/acp', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native'];

async function compile(entry: string, target: 'server' | 'client'): Promise<string> {
  const result = await build({
    entryPoints: [join(pluginRoot, entry)], bundle: true, format: 'cjs', jsx: 'automatic', write: false, logLevel: 'silent',
    platform: target === 'server' ? 'node' : 'neutral', target: target === 'server' ? 'node20' : 'es2020',
    external: target === 'server' ? [...SDK, 'zod'] : [...SDK, '@tanstack/react-query', 'react', 'react/jsx-runtime', 'react-native', 'zod'],
    ...(target === 'client' ? { supported: { 'async-await': false } } : {}),
  });
  const code = (result.outputFiles[0]?.text ?? '').replaceAll('get: () => from[key]', 'value: from[key]');
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

async function evaluate(bundle: string): Promise<unknown> {
  const shared = await import('@getpaseo/plugin');
  const require = createRequire(import.meta.url);
  const host = (name: string): unknown => (name === '@getpaseo/plugin' ? shared : name === 'zod' ? require('zod') : name.startsWith('@getpaseo/plugin') || name.startsWith('react') || name.startsWith('@tanstack') ? {} : require(name));
  const factory = (0, eval)(bundle) as (require: (name: string) => unknown) => unknown;
  return Reflect.get(factory(host) as object, 'default');
}

describe('runtime plugin as Paseo compiles it', () => {
  it('default-exports a function from the server entry', async () => {
    expect(typeof await evaluate(await compile('index.server.ts', 'server'))).toBe('function');
  }, 30_000);

  it('default-exports a function from the client entry', async () => {
    expect(typeof await evaluate(await compile('index.client.tsx', 'client'))).toBe('function');
  }, 30_000);
});
