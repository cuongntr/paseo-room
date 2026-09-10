import type { Result } from './result.js';

export function renderJson(result: Result): string {
  return `${JSON.stringify({ schemaVersion: 2, ...result }, null, 2)}\n`;
}

const ICONS = { pass: '✓', warn: '!', fail: '✗' } as const;

export function renderHuman(result: Result): string {
  const lines: string[] = [];
  for (const check of result.checks) {
    lines.push(`${ICONS[check.status]} ${check.message}`);
    if (check.fix) lines.push(`  → ${check.fix}`);
  }
  const changes = result.operations.filter(operation => operation.action !== 'noop');
  if (changes.length > 0) {
    lines.push('', result.changed ? 'Applied:' : 'Planned changes:');
    for (const operation of changes) lines.push(`  ${operation.action} ${operation.kind} ${operation.target}`);
    const unchanged = result.operations.length - changes.length;
    if (unchanged > 0) lines.push(`  (${String(unchanged)} already up to date)`);
  } else if (result.operations.length > 0) {
    lines.push('', 'Everything is already up to date.');
  }
  lines.push('', `${result.command}: ${result.outcome}`);
  return `${lines.join('\n')}\n`;
}
