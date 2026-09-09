import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, normalizedIntentSchema } from '../src/core/intent.js';
import { commandResultSchema, OUTCOMES, plannedOperationSchema, type CommandResult } from '../src/core/result.js';
import { exitCodeFor, renderHuman, renderJson } from '../src/cli/render.js';
import { MANAGED_PROVIDER_BY_ROLE, MANAGED_PROVIDER_IDS, ROOM_ROLES } from '../src/room/roles.js';
import { adapter, filesystem, gateway, processRunner, runtime } from './fakes/contracts.js';

const intent = { command: 'plan', agent: 'codex', apply: false, json: false, nonInteractive: true } as const;
const result: CommandResult = {
  schemaVersion: 1, command: 'plan', outcome: 'changes-planned', changed: false,
  checks: [
    { id: 'source', status: 'pass', message: 'Source validated' },
    { id: 'offline', status: 'not-checked', message: 'Daemon unavailable', remediation: 'Start your daemon' },
    { id: 'drift', status: 'warn', message: 'Review source drift' },
  ],
  operations: [
    { action: 'create', target: { kind: 'file', path: '/fixture/room/instructions.md' }, description: 'Write instructions' },
    { action: 'update', target: { kind: 'provider', id: 'codex-peer' }, description: 'Disable Paseo tools' },
  ],
};

describe('schema v1 contracts', () => {
  it.each(COMMANDS)('accepts command %s in intents and every outcome', (command) => {
    expect(normalizedIntentSchema.parse({ ...intent, command }).command).toBe(command);
    for (const outcome of OUTCOMES) {
      expect(commandResultSchema.parse({ ...result, command, outcome }).outcome).toBe(outcome);
    }
  });
  it.each([
    { command: 'update' }, { agent: 'pi' }, { apply: true }, { json: 'true' },
    { roomHome: '' }, { codexBin: 'x\0y' }, { password: 'synthetic' },
    { paseoUrl: 'https://localhost' }, { paseoUrl: 'ws://remote.example' },
    { paseoUrl: 'ws://user:synthetic@localhost' }, { paseoUrl: 'ws://localhost/?password=synthetic' },
  ])('rejects invalid intent %j', (patch) => {
    expect(normalizedIntentSchema.safeParse({ ...intent, ...patch }).success).toBe(false);
  });
  it('requires normalized fields and restricts apply to mutating commands', () => {
    expect(normalizedIntentSchema.safeParse({}).success).toBe(false);
    for (const command of COMMANDS) {
      expect(normalizedIntentSchema.safeParse({ ...intent, command, apply: true }).success)
        .toBe(['install', 'recover', 'uninstall'].includes(command));
    }
    expect(normalizedIntentSchema.safeParse({ ...intent, paseoUrl: 'ws://[::1]:1234' }).success).toBe(true);
  });
  it.each([
    { schemaVersion: 2 }, { command: 'update' }, { outcome: 'cancelled' }, { changed: true },
    { checks: [{ id: 'x', status: 'unknown', message: 'x' }] }, { operations: [{}] },
    { extra: true }, { checks: [{ id: '', status: 'pass', message: 'x' }] },
  ])('rejects invalid result %j', (patch) => {
    expect(commandResultSchema.safeParse({ ...result, ...patch }).success).toBe(false);
  });
  it('validates operation targets and all operation kinds', () => {
    for (const kind of ['file', 'symlink', 'directory']) {
      for (const action of ['create', 'update', 'remove', 'noop']) {
        expect(plannedOperationSchema.safeParse({ action, target: { kind, path: '/fixture' }, description: 'Fixture' }).success).toBe(true);
      }
    }
    expect(plannedOperationSchema.safeParse({ action: 'remove', target: { kind: 'provider', id: 'foreign' }, description: 'Fixture' }).success).toBe(false);
    expect(commandResultSchema.safeParse({ ...result, command: 'install', changed: true }).success).toBe(false);
    expect(commandResultSchema.safeParse({ ...result, command: 'install', outcome: 'ok', changed: true }).success).toBe(true);
  });
});

it('renders exact deterministic human and JSON goldens without changing operation order', () => {
  for (const [name, render] of [['result.json', renderJson], ['result.txt', renderHuman]] as const) {
    const golden = readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8');
    expect(render(result)).toBe(golden);
    expect(render({ operations: result.operations, checks: result.checks, changed: false,
      outcome: result.outcome, command: 'plan', schemaVersion: 1 })).toBe(golden);
  }
});
it('pins exit precedence, including usage and failed checks', () => {
  const lines: string[] = [];
  for (const outcome of OUTCOMES) {
    for (const status of ['pass', 'warn', 'fail', 'not-checked'] as const) {
      const value: CommandResult = { ...result, outcome, checks: [{ id: 'x', status, message: 'x' }] };
      lines.push(`${outcome}/${status}: ${String(exitCodeFor(value))}; usage: ${String(exitCodeFor(value, true))}`);
    }
  }
  expect(`${lines.join('\n')}\n`).toBe(readFileSync(new URL('./goldens/exits.txt', import.meta.url), 'utf8'));
  expect(exitCodeFor({ ...result, outcome: 'ok', checks: [] })).toBe(0);
});
it('injects typed read-only fakes through the generic adapter', async () => {
  const discovery = await adapter.discover({ intent, filesystem, process: processRunner, runtime, environment: {} });
  const input = { discovery, roomHome: '/fixture', roleHomes: {
    supervisor: '/fixture/supervisor', lead: '/fixture/lead', peer: '/fixture/peer',
  } };
  expect(await adapter.buildArtifacts(input)).toEqual([{ kind: 'directory', path: '/fixture', mode: 0o700 }]);
  expect(ROOM_ROLES.map((role) => MANAGED_PROVIDER_BY_ROLE[role])).toEqual(MANAGED_PROVIDER_IDS);
  expect(ROOM_ROLES.map((role) => adapter.buildProvider(role, input).paseoTools.enabled)).toEqual([true, true, false]);
  expect(await adapter.verifyRuntime({ ...input, filesystem, process: processRunner, gateway })).toEqual([
    { id: 'fixture', status: 'pass', message: 'Fixture only' },
  ]);
  await gateway.close();
});
