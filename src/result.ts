export type Status = 'pass' | 'warn' | 'fail';
export interface Check {
  readonly id: string;
  readonly status: Status;
  readonly message: string;
  readonly fix?: string;
}
export interface Operation {
  readonly action: 'create' | 'update' | 'remove' | 'noop';
  readonly kind: 'dir' | 'file' | 'link' | 'provider' | 'profile';
  readonly target: string;
}
export type Outcome = 'ok' | 'changes-planned' | 'failed';
export interface Result {
  readonly command: string;
  readonly outcome: Outcome;
  readonly changed: boolean;
  readonly checks: readonly Check[];
  readonly operations: readonly Operation[];
}

export function pass(id: string, message: string): Check {
  return { id, status: 'pass', message };
}
export function fail(id: string, message: string, fix: string): Check {
  return { id, status: 'fail', message, fix };
}
export function failed(command: string, checks: readonly Check[]): Result {
  return { command, outcome: 'failed', changed: false, checks, operations: [] };
}
export function hasFailure(checks: readonly Check[]): boolean {
  return checks.some(check => check.status === 'fail');
}
export function exitCode(result: Result): number {
  return result.outcome === 'failed' || hasFailure(result.checks) ? 1 : 0;
}
