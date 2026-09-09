import { commandResultSchema, type CommandResult } from '../core/result.js';

export type ExitCode = 0 | 1 | 2 | 3 | 4;
export function exitCodeFor(result: CommandResult, usageError = false): ExitCode {
  if (usageError) return 2;
  if (result.outcome === 'recovery-required') return 4;
  if (result.outcome === 'conflict') return 3;
  if (result.outcome === 'failed' || result.checks.some((check) => check.status === 'fail')) return 1;
  return 0;
}

/** Schema parsing fixes object-key order; array order preserves planner execution order. */
export function renderJson(result: CommandResult): string {
  return `${JSON.stringify(commandResultSchema.parse(result), null, 2)}\n`;
}
export function renderHuman(result: CommandResult): string {
  const parsed = commandResultSchema.parse(result);
  const lines = [`${parsed.command}: ${parsed.outcome} (changed: ${parsed.changed ? 'yes' : 'no'})`];
  for (const check of parsed.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.message}`);
    if (check.remediation) lines.push(`  Remediation: ${check.remediation}`);
  }
  for (const operation of parsed.operations) {
    const target = operation.target.kind === 'provider' ? operation.target.id : operation.target.path;
    lines.push(`${operation.action} ${operation.target.kind} ${target}: ${operation.description}`);
  }
  return `${lines.join('\n')}\n`;
}
