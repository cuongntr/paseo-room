import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_PASEO_RANGE, RUNTIME_PLUGIN_ID } from '../src/runtime-plugin/shared/identity.js';
import { runtimePluginInventory } from './package-inventory.js';

const pluginRoot = join(import.meta.dirname, '..', 'src', 'runtime-plugin');

/**
 * Paseo 0.8.0's plugin compiler keeps exactly these specifiers external and supplies them at
 * run time; the installed plugin has no `node_modules`, so any other package import would fail
 * to load on the operator's daemon.
 */
const SHARED_SPECIFIERS = ['@getpaseo/plugin', 'zod'];
const SERVER_SPECIFIERS = [...SHARED_SPECIFIERS, '@getpaseo/plugin/server'];
const CLIENT_SPECIFIERS = [
  ...SHARED_SPECIFIERS, '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui',
  '@getpaseo/plugin/client/react-native', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query',
];
const ROOT_FILES = ['index.client.tsx', 'index.server.ts', 'package.json', 'paseo-plugin.json', 'tsconfig.json'];
const CODE = /\.(?:ts|tsx|mjs)$/;

type Area = 'server' | 'client' | 'shared' | 'bridge';

function areaOf(path: string): Area {
  if (path.endsWith('.mjs')) return 'bridge';
  if (path === 'index.server.ts' || path.startsWith('server/')) return 'server';
  if (path === 'index.client.tsx' || path.startsWith('client/')) return 'client';
  return 'shared';
}

export function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map(match => match[1] ?? '');
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

/** Every rule the Paseo compiler or the room's own boundary imposes on one module's imports. */
export function boundaryViolations(path: string, source: string): string[] {
  const area = areaOf(path);
  const violations: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const target = resolveRelative(path, specifier);
      if (target === undefined) violations.push(`${path}: ${specifier} escapes the plugin tree`);
      else if (area === 'client' && (target === 'index.server' || target.startsWith('server/'))) violations.push(`${path}: client imports server code ${specifier}`);
      else if (area === 'server' && (target === 'index.client' || target.startsWith('client/'))) violations.push(`${path}: server imports client code ${specifier}`);
      else if (area === 'shared' && !target.startsWith('shared/')) violations.push(`${path}: shared module imports ${specifier}`);
      else if (area === 'bridge') violations.push(`${path}: the bridge process must be self-contained, found ${specifier}`);
      continue;
    }
    if (specifier.startsWith('node:')) {
      if (area === 'client' || area === 'shared') violations.push(`${path}: ${area} code must not import ${specifier}`);
      continue;
    }
    const allowed = area === 'server' ? SERVER_SPECIFIERS : area === 'client' ? CLIENT_SPECIFIERS : area === 'shared' ? SHARED_SPECIFIERS : [];
    if (!allowed.includes(specifier)) violations.push(`${path}: ${specifier} is not supplied by the Paseo host for ${area} code`);
  }
  return violations;
}

describe('runtime plugin module boundary', () => {
  it('declares its own plugin id and the qualified Paseo range', async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, 'paseo-plugin.json'), 'utf8')) as unknown;
    expect(manifest).toEqual({ id: RUNTIME_PLUGIN_ID, requirements: { paseo: RUNTIME_PASEO_RANGE } });
    expect(RUNTIME_PLUGIN_ID).not.toBe('paseo-room-claude-carrier');
  });

  it('keeps code modules out of the plugin root and inside the host-supplied import set', async () => {
    const files = await runtimePluginInventory(pluginRoot);
    const rootCode = files.filter(path => !path.includes('/') && !ROOT_FILES.includes(path));
    expect(rootCode).toEqual([]);

    const violations: string[] = [];
    for (const path of files.filter(file => CODE.test(file))) {
      violations.push(...boundaryViolations(path, await readFile(join(pluginRoot, path), 'utf8')));
    }
    expect(violations).toEqual([]);
  });

  it('uses no DOM API or HTML element in client code', async () => {
    const files = (await runtimePluginInventory(pluginRoot)).filter(path => areaOf(path) === 'client' && CODE.test(path));
    expect(files.length).toBeGreaterThan(1);
    const dom = /\b(?:document|window|localStorage|navigator)\.|className=|onClick=|<(?:div|span|p|a|button|input|img|ul|ol|li|section|header|footer|form|label|table|h[1-6])[\s>/]/;
    for (const path of files) expect(dom.test(await readFile(join(pluginRoot, path), 'utf8')), path).toBe(false);
  });

  it('rejects each planted violation the compiler or the room boundary would refuse', () => {
    expect(boundaryViolations('server/a.ts', "import { x } from 'lodash';")).toHaveLength(1);
    expect(boundaryViolations('client/a.tsx', "import { readFile } from 'node:fs';")).toHaveLength(1);
    expect(boundaryViolations('client/a.tsx', "import { handler } from '../server/rpc.js';")).toHaveLength(1);
    expect(boundaryViolations('index.client.tsx', "import x from './server/rpc.js';")).toHaveLength(1);
    expect(boundaryViolations('server/a.ts', "import { View } from './../client/view.js';")).toHaveLength(1);
    expect(boundaryViolations('shared/a.ts', "import { z } from 'zod'; import { readFile } from 'node:fs';")).toHaveLength(1);
    expect(boundaryViolations('shared/a.ts', "import { run } from '../server/run.js';")).toHaveLength(1);
    expect(boundaryViolations('server/a.ts', "const x = await import('../../outside.js');")).toHaveLength(1);
    expect(boundaryViolations('server/bridge/bridge.mjs', "import { z } from 'zod';")).toHaveLength(1);
    // The permitted shapes stay permitted.
    expect(boundaryViolations('server/a.ts', "import { z } from 'zod';\nimport { readFile } from 'node:fs/promises';\nimport type { PluginServerContext } from '@getpaseo/plugin/server';\nimport { ID } from '../shared/identity.js';")).toEqual([]);
    expect(boundaryViolations('client/a.tsx', "import { Text } from 'react-native';\nimport { useRpc } from '@getpaseo/plugin/client';\nimport { ID } from '../shared/identity.js';")).toEqual([]);
    expect(boundaryViolations('server/bridge/bridge.mjs', "import { createInterface } from 'node:readline';")).toEqual([]);
  });
});
