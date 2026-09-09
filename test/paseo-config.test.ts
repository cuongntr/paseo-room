import { expect, it, vi } from 'vitest';
import { withPaseoConfig, type ConfigClient, type ConfigClientFactory } from '../src/paseo/gateway.js';
import { providerPoliciesEqual } from '../src/paseo/provider-policy.js';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';
import { policyFixture, probeFixture, probeInput } from './helpers/provider-policy.js';

function sdkFixture() {
  const response = { requestId: 'fixture', config: { providers: { unrelated: { label: 'preserve' } } } };
  const config = { get: vi.fn<ConfigClient['config']['get']>().mockResolvedValue(response),
    patch: vi.fn<ConfigClient['config']['patch']>().mockImplementation(patch => {
      if (patch.providers) Object.assign(response.config.providers, patch.providers);
      if (patch.removeProviders) for (const id of patch.removeProviders) Reflect.deleteProperty(response.config.providers, id);
      return Promise.resolve(response);
    }) };
  const sdk = { connect: vi.fn<ConfigClient['connect']>().mockResolvedValue(), close: vi.fn<ConfigClient['close']>().mockResolvedValue(),
    getConnectionState: () => ({ status: 'connected' as const }), config };
  const factory = vi.fn<ConfigClientFactory>().mockReturnValue(sdk);
  return { sdk, factory };
}
it('reads, patches all three once and removes exactly three once with public config RPCs', async () => {
  const { sdk, factory } = sdkFixture();
  const policy = policyFixture(['/opt/node', '/opt/codex.js']);
  await withPaseoConfig(probeInput, probeFixture(), 'synthetic-private', async factoryGateway => {
    expect(await factoryGateway.readConfig()).toEqual({ providers: { unrelated: { label: 'preserve' } } });
    expect(await factoryGateway.patchProviders(policy)).toEqual({ providers: { unrelated: { label: 'preserve' }, ...policy } });
    const { providers } = await factoryGateway.readConfig();
    expect(providerPoliciesEqual(Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, providers[id]])), policy)).toBe(true);
    expect(await factoryGateway.removeProviders()).toEqual({ providers: { unrelated: { label: 'preserve' } } });
  }, factory);
  expect(sdk.config.patch.mock.calls).toEqual([[{ providers: policy }], [{ removeProviders: [...MANAGED_PROVIDER_IDS] }]]);
  expect(JSON.stringify(sdk.config.patch.mock.calls)).not.toContain('synthetic-private');
  expect(sdk.config.get).toHaveBeenCalledTimes(2);
  expect(sdk.connect).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce();
  expect(factory.mock.calls[0]?.[0]).toMatchObject({ password: 'synthetic-private', reconnect: { enabled: false } });
});
it.each(['get', 'patch', 'remove', 'invalid', 'callback', 'timeout', 'malformed', 'close', 'connect'])('sanitizes %s failure and closes without mutation retries', async kind => {
  const { sdk, factory } = sdkFixture();
  const secret = 'synthetic-private';
  if (kind === 'get') sdk.config.get.mockRejectedValue(new Error(secret));
  if (kind === 'patch' || kind === 'remove') sdk.config.patch.mockRejectedValue(new Error(secret));
  if (kind === 'timeout') sdk.config.patch.mockImplementation(() => new Promise(() => {}));
  if (kind === 'malformed') sdk.config.get.mockResolvedValue({ requestId: 'fixture', config: { providers: null } });
  if (kind === 'close') sdk.close.mockRejectedValue(new Error(secret));
  if (kind === 'connect') sdk.connect.mockRejectedValue(new Error(secret));
  const operation = withPaseoConfig({ ...probeInput, timeoutMs: 10 }, probeFixture(), secret, async gateway => {
    if (kind === 'callback') throw new Error(secret);
    if (kind === 'remove') return gateway.removeProviders();
    if (kind === 'invalid') return gateway.patchProviders({ ...policyFixture(), extra: secret });
    if (kind === 'patch' || kind === 'timeout') return gateway.patchProviders(policyFixture());
    return gateway.readConfig();
  }, factory);
  await expect(operation).rejects.toMatchObject({ check: { id: `paseo.${kind === 'close' ? 'cleanup' : kind === 'connect' ? 'unreachable' : 'config'}` } });
  await expect(operation).rejects.not.toThrow(secret);
  if (!['close', 'connect'].includes(kind)) await expect(operation).rejects.toThrow('SDK config operation failed; reconcile live state before retrying any mutation.');
  expect(sdk.close).toHaveBeenCalledOnce();
  expect(sdk.config.patch).toHaveBeenCalledTimes(['patch', 'remove', 'timeout'].includes(kind) ? 1 : 0);
});
it('leaves unknown managed entry keys intact so read-back cannot manufacture ownership', async () => {
  const { sdk, factory } = sdkFixture();
  sdk.config.get.mockResolvedValue({ requestId: 'fixture', config: { providers: { ...policyFixture(),
    'codex-peer': { ...policyFixture()['codex-peer'], extra: true } }, privateConfig: 'synthetic-private' } });
  await withPaseoConfig(probeInput, probeFixture(), undefined, async gateway => {
    const result = await gateway.readConfig();
    expect(result.providers['codex-peer']).toHaveProperty('extra', true);
    expect(providerPoliciesEqual(result.providers, policyFixture())).toBe(false);
    expect(result).not.toHaveProperty('privateConfig');
  }, factory);
});
it('sanitizes errors before callback code can observe them, including ambiguous patch responses', async () => {
  const { sdk, factory } = sdkFixture();
  sdk.config.get.mockRejectedValue(new Error('synthetic-private'));
  sdk.config.patch.mockResolvedValue({ config: { providers: null }, detail: 'synthetic-private' });
  await withPaseoConfig(probeInput, probeFixture(), 'synthetic-private', async gateway => {
    await expect(gateway.readConfig()).rejects.toThrow('SDK config operation failed');
    await expect(gateway.patchProviders(policyFixture())).rejects.not.toThrow('synthetic-private');
  }, factory);
  expect(sdk.config.patch).toHaveBeenCalledOnce();
  expect(sdk.close).toHaveBeenCalledOnce();
});
