import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { resolveLayout } from './layout.js';
import { fail, failed, pass, warn, type Check, type Operation, type Result } from './result.js';
import type { RunOptions } from './commands.js';
import { readEvent } from './runtime-plugin/server/events/schema.js';
import { runtimeRoot } from './runtime-plugin/server/store/project.js';

export interface ExportOptions extends RunOptions {
  /** Destination directory; defaults to a new directory under the room's runtime exports. */
  readonly out?: string;
  readonly includeGateOutput?: boolean;
}

const LIMITATION = 'Briefs, answers, reports and gate commands are stored as written and cannot be proven secret-free; review the export before sharing it.';

async function isEmptyOrAbsent(path: string): Promise<boolean> {
  try { return (await readdir(path)).length === 0; } catch { return true; }
}

/**
 * Explicit, read-only export of runtime state (docs/design/runtime-coordination.md §10). Needs
 * no daemon. Only schema-valid events are copied; anything unreadable is listed by name, never
 * by content. Gate output tails stay out unless asked for. Nothing under `runtime/` changes.
 */
export async function exportRuntime(options: ExportOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const root = runtimeRoot(layout.roomHome);
  let projects: string[];
  try { projects = (await readdir(join(root, 'projects'))).sort(); } catch { projects = []; }
  if (projects.length === 0) {
    return failed('export', [fail('export.nothing', `No runtime state was found under ${root}.`, 'Runtime coordination records state only after setup --runtime and a first assignment.')]);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = resolve(options.out ?? join(root, 'exports', stamp));
  if (!await isEmptyOrAbsent(destination)) {
    return failed('export', [fail('export.destination', `${destination} already exists and is not empty.`, 'Choose a new or empty --out directory.')]);
  }

  const operations: Operation[] = [{ action: 'create', kind: 'dir', target: destination }];
  const summary: { projectId: string; canonicalRoot: string; events: number; omitted: string[]; gateOutputs: number }[] = [];
  const copies: [string, string][] = [];
  for (const name of projects) {
    const source = join(root, 'projects', name);
    const target = join(destination, 'projects', name);
    let meta: { projectId?: string; canonicalRoot?: string };
    try { meta = JSON.parse(await readFile(join(source, 'meta.json'), 'utf8')) as typeof meta; } catch { meta = {}; }
    const entry = { projectId: meta.projectId ?? name, canonicalRoot: meta.canonicalRoot ?? 'unknown', events: 0, omitted: [] as string[], gateOutputs: 0 };
    copies.push([join(source, 'meta.json'), join(target, 'meta.json')]);
    for (const file of (await readdir(join(source, 'events')).catch(() => [] as string[])).sort()) {
      if (file.startsWith('.tmp-')) continue;
      let valid: boolean;
      try { valid = readEvent(JSON.parse(await readFile(join(source, 'events', file), 'utf8'))).ok; } catch { valid = false; }
      if (valid) { entry.events += 1; copies.push([join(source, 'events', file), join(target, 'events', file)]); }
      else entry.omitted.push(file);
    }
    for (const file of (await readdir(join(source, 'gates')).catch(() => [] as string[])).sort()) {
      if (file.endsWith('.result.json')) copies.push([join(source, 'gates', file), join(target, 'gates', file)]);
      else if (file.endsWith('.log') && options.includeGateOutput === true) { entry.gateOutputs += 1; copies.push([join(source, 'gates', file), join(target, 'gates', file)]); }
    }
    summary.push(entry);
  }
  operations.push(...copies.map(([, target]) => ({ action: 'create', kind: 'file', target }) satisfies Operation));
  operations.push({ action: 'create', kind: 'file', target: join(destination, 'summary.json') });

  const checks: Check[] = [
    warn('export.limitation', LIMITATION),
    ...(options.includeGateOutput === true ? [warn('export.gate-output', 'Gate output tails are included; they are best-effort masked only.')] : []),
    ...summary.filter(entry => entry.omitted.length > 0).map(entry => warn('export.omitted', `Project ${entry.projectId}: ${String(entry.omitted.length)} unreadable event file(s) were left out by name: ${entry.omitted.join(', ')}.`)),
  ];
  if (!options.apply) return { command: 'export', outcome: 'changes-planned', changed: false, checks, operations };

  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [from, to] of copies) {
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
  }
  await writeFile(join(destination, 'summary.json'), `${JSON.stringify({
    schema: 1, exportedAt: new Date().toISOString(), packageVersion: metadata.version, gateOutputIncluded: options.includeGateOutput === true,
    limitation: LIMITATION, projects: summary,
  }, null, 2)}\n`, { mode: 0o600 });
  return { command: 'export', outcome: 'ok', changed: true, checks: [...checks, pass('export.written', `Exported ${String(summary.length)} project(s) to ${destination}.`)], operations };
}
