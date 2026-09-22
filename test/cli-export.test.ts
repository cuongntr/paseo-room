import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { exportRuntime } from '../src/export.js';
import { ProjectStore } from '../src/runtime-plugin/server/store/project.js';
import { makeFixture } from './helpers.js';

async function roomWithState() {
  const fixture = await makeFixture();
  const root = join(fixture.roomHome, 'runtime', 'v1');
  const store = await ProjectStore.create(root, { canonicalRoot: '/work/repo', gitCommonDir: '/work/repo/.git' });
  await writeFile(join(store.gatesDirectory, 'gate-1.log'), 'TOKEN=[masked] output');
  await writeFile(join(store.gatesDirectory, 'gate-1.result.json'), '{"id":"gate-1"}');
  return { fixture, root, store };
}

describe('paseo-room export', () => {
  it('plans without writing unless applied, and needs no daemon', async () => {
    const { fixture } = await roomWithState();
    const out = join(fixture.home, 'export-a');
    // The fixture's paseo binary is never consulted: env has no working daemon requirement here.
    const planned = await exportRuntime({ env: fixture.env, out });
    expect(planned.outcome).toBe('changes-planned');
    expect(planned.checks.map(check => check.id)).toContain('export.limitation');
    await expect(stat(out)).rejects.toThrow();
  });

  it('copies meta, valid events and gate results, and leaves gate output out by default', async () => {
    const { fixture, store } = await roomWithState();
    await writeFile(join(store.eventsDirectory, '000000000009.json'), 'garbage');
    const out = join(fixture.home, 'export-b');
    const result = await exportRuntime({ env: fixture.env, out, apply: true });
    expect(result.outcome).toBe('ok');
    const project = join(out, 'projects', store.directory.split('/').at(-1) ?? '');
    expect((await readdir(join(project, 'events'))).sort()).toEqual(['000000000001.json']);
    expect(await readdir(join(project, 'gates'))).toEqual(['gate-1.result.json']);
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as { gateOutputIncluded: boolean; projects: { omitted: string[] }[]; limitation: string };
    expect(summary.gateOutputIncluded).toBe(false);
    expect(summary.projects[0]?.omitted).toEqual(['000000000009.json']);
    expect(summary.limitation).toContain('cannot be proven secret-free');
    expect((await stat(join(out, 'summary.json'))).mode & 0o777).toBe(0o600);
    // The runtime state itself is untouched.
    expect(await readFile(join(store.eventsDirectory, '000000000009.json'), 'utf8')).toBe('garbage');
  });

  it('includes gate output only on request, defaults under the room home and refuses a non-empty destination', async () => {
    const { fixture, root } = await roomWithState();
    const withOutput = await exportRuntime({ env: fixture.env, apply: true, includeGateOutput: true });
    expect(withOutput.checks.map(check => check.id)).toContain('export.gate-output');
    const exports = await readdir(join(root, 'exports'));
    expect(exports).toHaveLength(1);
    const exported = join(root, 'exports', exports[0] ?? '');
    const project = (await readdir(join(exported, 'projects')))[0] ?? '';
    expect((await readdir(join(exported, 'projects', project, 'gates'))).sort()).toEqual(['gate-1.log', 'gate-1.result.json']);
    expect((await exportRuntime({ env: fixture.env, out: exported, apply: true })).checks[0]?.id).toBe('export.destination');
  });

  it('reports nothing to export, and keeps export flags off other commands', async () => {
    const fixture = await makeFixture();
    expect((await exportRuntime({ env: fixture.env })).checks[0]?.id).toBe('export.nothing');
    let err = '';
    const code = await runCli(['setup', '--out', '/tmp/x'], { stdout: () => undefined, stderr: text => { err += text; } }, { isTTY: false, options: { env: fixture.env } });
    expect(code).toBe(2);
    expect(err).toContain('only apply to export');
  });
});
