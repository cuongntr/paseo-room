import { expect, it, vi } from 'vitest';
import { withTransactionGateway, type TransactionClient, type TransactionClientFactory } from '../src/paseo/transaction-gateway.js';
import { observePaseo } from '../src/paseo/observation.js';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';
import { policyFixture, probeFixture, probeInput } from './helpers/provider-policy.js';

function fixture() {
  const providers: Record<string, unknown> = { unrelated: { custom: 'preserve' } };
  const config = { get: vi.fn<TransactionClient['config']['get']>(() => Promise.resolve({ config: { providers } })),
    patch: vi.fn<TransactionClient['config']['patch']>(patch => {
      Object.assign(providers, patch.providers);
      for (const id of patch.removeProviders ?? []) Reflect.deleteProperty(providers, id);
      return Promise.resolve({ config: { providers } });
    }) };
  const sdk = { config,
    connect: vi.fn<TransactionClient['connect']>().mockResolvedValue(), close: vi.fn<TransactionClient['close']>().mockResolvedValue(),
    getConnectionState: () => ({ status: 'connected' as const }),
    agents: { list: vi.fn<TransactionClient['agents']['list']>().mockResolvedValue({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) },
    providers: { refresh: vi.fn<TransactionClient['providers']['refresh']>().mockResolvedValue({ acknowledged: true }),
      waitForReady: vi.fn<TransactionClient['providers']['waitForReady']>().mockResolvedValue({ entries: MANAGED_PROVIDER_IDS.map(provider => ({ provider, status: 'ready' })) }),
      snapshot: vi.fn<TransactionClient['providers']['snapshot']>(() => Promise.resolve({ entries: MANAGED_PROVIDER_IDS
        .filter(provider => Object.hasOwn(providers, provider)).map(provider => ({ provider, status: 'ready' })) })) },
  };
  const factory = vi.fn<TransactionClientFactory>().mockReturnValue(sdk);
  return { providers, sdk, factory };
}
it('composes admitted config, complete sessions, ready verification and selective reverse RPC', async () => {
  const f = fixture();
  const desired = policyFixture();
  await withTransactionGateway(probeInput, probeFixture(), undefined, async gateway => {
    expect(await gateway.sessionsSafe(desired)).toBe(true);
    await gateway.patchProviders(desired);
    expect((await gateway.verify(desired)).ok).toBe(true);
    await gateway.restoreProviders({ 'codex-peer': null, 'codex-lead': desired['codex-lead'] });
    expect((await gateway.readConfig()).providers).toEqual({ unrelated: { custom: 'preserve' },
      'codex-supervisor': desired['codex-supervisor'], 'codex-lead': desired['codex-lead'] });
  }, f.factory);
  expect(f.sdk.config.patch.mock.calls).toEqual([[{ providers: desired }], [{ providers: { 'codex-lead': desired['codex-lead'] }, removeProviders: ['codex-peer'] }]]);
  expect(f.sdk.providers.refresh).toHaveBeenCalledOnce();
  expect(f.sdk.close).toHaveBeenCalledTimes(2);
  expect(f.factory.mock.calls.every(([config]) => config.appVersion === '0.8.0-beta.1' && config.reconnect?.enabled === false)).toBe(true);
});
it.each(['running', 'idle', 'error', 'initializing', 'unknown', 'pagination', 'malformed'])('blocks %s sessions without patch/refresh', async status => {
  const f = fixture();
  f.sdk.agents.list.mockResolvedValue(status === 'malformed' ? {} : { entries: [{ agent: { provider: 'codex-peer', id: 'fixture', status } }],
    pageInfo: { hasMore: status === 'pagination', nextCursor: null, prevCursor: null } });
  await withTransactionGateway(probeInput, probeFixture(), undefined, async gateway => {
    expect(await gateway.sessionsSafe(policyFixture())).toBe(false);
  }, f.factory);
  expect(f.sdk.config.patch).not.toHaveBeenCalled();
  expect(f.sdk.providers.refresh).not.toHaveBeenCalled();
  expect(f.sdk.close).toHaveBeenCalledOnce();
});
it('refreshes and verifies exact restored absence before permitting file compensation', async () => {
  const f = fixture();
  const desired = policyFixture();
  await withTransactionGateway(probeInput, probeFixture(), undefined, async gateway => {
    expect(await gateway.verifyRestored({ 'codex-supervisor': null, 'codex-lead': null, 'codex-peer': null }, desired)).toBe(true);
    f.providers['codex-peer'] = desired['codex-peer'];
    expect(await gateway.verifyRestored({ 'codex-supervisor': null, 'codex-lead': null, 'codex-peer': null }, desired)).toBe(false);
  }, f.factory);
  expect(f.sdk.providers.refresh).toHaveBeenCalledTimes(2);
  expect(f.sdk.providers.snapshot).toHaveBeenCalledTimes(2);
});
it('does not retry an ambiguous selective patch and closes on failure', async () => {
  const f = fixture();
  f.sdk.config.patch.mockRejectedValue(new Error('synthetic-private'));
  await expect(withTransactionGateway(probeInput, probeFixture(), undefined,
    gateway => gateway.restoreProviders({ 'codex-peer': null }), f.factory)).rejects.not.toThrow('synthetic-private');
  expect(f.sdk.config.patch).toHaveBeenCalledOnce();
  expect(f.sdk.close).toHaveBeenCalledOnce();
});
it.each([true, false])('observes live readiness read-only (installed=%s), without patch or refresh', async installed => {
  const f = fixture();
  const policy = policyFixture();
  if (installed) Object.assign(f.providers, policy);
  const before = structuredClone(f.providers);
  const result = await observePaseo(probeInput, probeFixture(), undefined, policy, f.factory);
  expect(result.verification.ok).toBe(installed);
  expect(f.providers).toEqual(before);
  expect(f.sdk.config.patch).not.toHaveBeenCalled();
  expect(f.sdk.providers.refresh).not.toHaveBeenCalled();
  expect(f.sdk.providers.waitForReady).not.toHaveBeenCalled();
  expect(f.sdk.providers.snapshot).toHaveBeenCalledOnce();
  expect(f.sdk.close).toHaveBeenCalledOnce();
});
