import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderCommand } from '../src/runtime-plugin/server/paseo-port.js';
import { readSeatAccounts, type RunStatus, type SeatDependencies, type SeatProvider } from '../src/runtime-plugin/server/seats.js';

const ROOM = '/home/op/.paseo-room';
const home = (agent: string, role: string): string => join(ROOM, 'roles', agent, role);

const CLAUDE_STATUS = JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', configDirectory: home('claude', 'lead'),
  email: 'seat@example.com', orgId: 'org-1', orgName: 'Seat Org', subscriptionType: 'max',
});

interface Call { readonly binary: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }

function deps(options: {
  readonly commands: Record<string, ProviderCommand>;
  readonly outputs?: Record<string, string>;
  readonly files?: Record<string, 'file' | 'link'>;
}): { readonly deps: SeatDependencies; readonly calls: Call[] } {
  const calls: Call[] = [];
  const run: RunStatus = (binary, args, env) => {
    calls.push({ binary, args, env });
    const configured = env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? '';
    return Promise.resolve({ exitCode: 0, output: options.outputs?.[configured] ?? '' });
  };
  return {
    calls,
    deps: {
      roomHome: ROOM,
      command: provider => Promise.resolve(options.commands[provider]),
      run,
      lstat: path => {
        const kind = options.files?.[path];
        return Promise.resolve(kind === undefined ? undefined : { isSymbolicLink: () => kind === 'link' });
      },
    },
  };
}

const seat = (agent: SeatProvider['agent'], role: SeatProvider['role']): SeatProvider => ({ providerId: `${agent}-${role}`, agent, role });

describe('room seat accounts', () => {
  it('asks Claude for its status with only the seat homes, and keeps the account fields', async () => {
    const lead = home('claude', 'lead');
    const { deps: seatDeps, calls } = deps({
      commands: { 'claude-lead': { binary: '/bin/claude', env: { CLAUDE_CONFIG_DIR: lead, CLAUDE_SECURESTORAGE_CONFIG_DIR: lead, CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } } },
      outputs: { [lead]: CLAUDE_STATUS },
    });
    const [account] = await readSeatAccounts(seatDeps, [seat('claude', 'lead')]);
    expect(account).toEqual({
      providerId: 'claude-lead', agent: 'claude', role: 'lead', status: 'signed-in',
      method: 'claude.ai', email: 'seat@example.com', plan: 'max', organization: 'Seat Org',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binary).toBe('/bin/claude');
    expect(calls[0]?.args).toEqual(['auth', 'status']);
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(lead);
    expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(lead);
    // Only the home variables are applied; the rest of the launch environment is not.
    expect(calls[0]?.env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBeUndefined();
  });

  it('reports a signed-out or unreadable Claude seat without inventing an account', async () => {
    const peer = home('claude', 'peer');
    const supervisor = home('claude', 'supervisor');
    const { deps: seatDeps } = deps({
      commands: {
        'claude-peer': { binary: '/bin/claude', env: { CLAUDE_CONFIG_DIR: peer } },
        'claude-supervisor': { binary: '/bin/claude', env: { CLAUDE_CONFIG_DIR: supervisor } },
      },
      outputs: { [peer]: JSON.stringify({ loggedIn: false }), [supervisor]: 'error: something broke' },
    });
    const accounts = await readSeatAccounts(seatDeps, [seat('claude', 'peer'), seat('claude', 'supervisor')]);
    expect(accounts.map(account => account.status)).toEqual(['signed-out', 'unknown']);
    expect(accounts[0]?.email).toBeUndefined();
  });

  it('keeps only the Codex login method, never the printed text, and flags a linked credential', async () => {
    const lead = home('codex', 'lead');
    const peer = home('codex', 'peer');
    const { deps: seatDeps, calls } = deps({
      commands: {
        'codex-lead': { binary: '/bin/codex', env: { CODEX_HOME: lead } },
        'codex-peer': { binary: '/bin/codex', env: { CODEX_HOME: peer } },
      },
      outputs: { [lead]: 'Logged in using ChatGPT', [peer]: 'Logged in using an API key - sk-proj-***abcd' },
      files: { [join(lead, 'auth.json')]: 'link', [join(peer, 'auth.json')]: 'file' },
    });
    const accounts = await readSeatAccounts(seatDeps, [seat('codex', 'lead'), seat('codex', 'peer')]);
    expect(accounts[0]).toMatchObject({ status: 'signed-in', method: 'chatgpt', shared: true });
    expect(accounts[1]).toMatchObject({ status: 'signed-in', method: 'api-key' });
    expect(accounts[1]?.shared).toBeUndefined();
    expect(JSON.stringify(accounts)).not.toContain('sk-proj');
    expect(calls.map(call => call.args)).toEqual([['login', 'status'], ['login', 'status']]);
  });

  it('reports only whether a Pi credential file exists, running nothing', async () => {
    const lead = home('pi', 'lead');
    const peer = home('pi', 'peer');
    const { deps: seatDeps, calls } = deps({
      commands: {
        'pi-lead': { binary: '/bin/pi', env: { PI_CODING_AGENT_DIR: lead } },
        'pi-peer': { binary: '/bin/pi', env: { PI_CODING_AGENT_DIR: peer } },
      },
      files: { [join(lead, 'auth.json')]: 'file' },
    });
    const accounts = await readSeatAccounts(seatDeps, [seat('pi', 'lead'), seat('pi', 'peer')]);
    expect(accounts.map(account => account.status)).toEqual(['present', 'signed-out']);
    expect(calls).toHaveLength(0);
  });

  it('never queries a provider whose home is not this room role home, or that has no launch entry', async () => {
    const { deps: seatDeps, calls } = deps({
      commands: { 'claude-lead': { binary: '/bin/claude', env: { CLAUDE_CONFIG_DIR: '/home/op/.claude' } } },
    });
    const accounts = await readSeatAccounts(seatDeps, [seat('claude', 'lead'), seat('codex', 'lead')]);
    expect(accounts.map(account => account.status)).toEqual(['unknown', 'unknown']);
    expect(accounts[0]?.note).toMatch(/not this room's role home/);
    expect(accounts[1]?.note).toMatch(/no launch entry/);
    expect(calls).toHaveLength(0);
  });
});
