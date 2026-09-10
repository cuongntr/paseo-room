import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/command.js';
import { exitCodeFor } from '../src/cli/render.js';
import { COMMANDS } from '../src/core/intent.js';
import { OUTCOMES } from '../src/core/result.js';

const documents = ['README.md', 'src/cli/README.md', 'docs/operations/guide.md',
  'docs/operations/phase-1-acceptance.md'];
const load = (path: string) => readFile(resolve(path), 'utf8');

// These documents use inline links and unique ATX headings, not raw HTML anchors.
function headingIds(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(match => (match[1] ?? '')
    .toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-'));
}

describe('operator documentation contract', () => {
  it.each(documents)('%s has valid local Markdown links and anchors', async document => {
    const markdown = await load(document);
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1] ?? '';
      if (/^[a-z]+:/i.test(href)) continue;
      const [path = '', anchor] = href.split('#');
      const target = path ? resolve(dirname(document), decodeURIComponent(path)) : resolve(document);
      expect((await stat(target)).isFile(), `${document}: ${href}`).toBe(true);
      if (anchor) expect(headingIds(await load(target)), `${document}: ${href}`).toContain(decodeURIComponent(anchor));
    }
  });

  it('documents exactly the public lifecycle commands, help options and outcomes', async () => {
    const guide = await load('docs/operations/guide.md');
    let help = '';
    expect(await runCli(['--help'], { stdout: text => { help += text; }, stderr: () => {} })).toBe(0);
    const documentedCommands = [...guide.matchAll(/^\| `([a-z]+)` \|/gm)]
      .map(match => match[1]).filter(value => value !== 'ok' && value !== 'failed' && value !== 'conflict');
    expect(documentedCommands).toEqual([...COMMANDS]);
    for (const command of COMMANDS) expect(help).toContain(command);
    const helpOptions = [...help.matchAll(/--[a-z]+(?:-[a-z]+)*/g)].map(match => match[0]);
    const lifecycleOptions = [...new Set(helpOptions)].filter(option => !['--help', '--version'].includes(option)).sort();
    const documentedOptions = [...guide.matchAll(/^\| `(--[a-z-]+)/gm)].map(match => match[1]).sort();
    expect(documentedOptions).toEqual(lifecycleOptions);
    const documentedOutcomes = [...guide.matchAll(/^\| `([a-z][a-z-]*)` \|/gm)]
      .map(match => match[1]).filter(value => !COMMANDS.some(command => command === value));
    expect(documentedOutcomes.sort()).toEqual([...OUTCOMES].sort());
    for (const outcome of OUTCOMES) {
      const exit = exitCodeFor({ schemaVersion: 1, command: 'install', outcome,
        changed: false, checks: [], operations: [] });
      const row = guide.split('\n').find(line => line.startsWith(`| \`${outcome}\` |`));
      expect(row).toMatch(new RegExp(`\\| ${String(exit)} \\|$`));
    }
    const completionMarker = 'Phase 1 implementation acceptance complete on 2026-09-10; '
      + 'npm publication not performed and package remains `UNLICENSED`.';
    for (const document of documents.slice(0, 3)) {
      const text = await load(document);
      for (const command of COMMANDS) expect(text).toMatch(new RegExp(`\\b${command}\\b`));
      for (const outcome of OUTCOMES) expect(text).toContain(`\`${outcome}\``);
      expect(text).toContain(completionMarker);
    }
  });
});
