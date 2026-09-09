import { expect, it, vi } from 'vitest';
import { verifyPaseo, type VerificationClient, type VerificationClientFactory } from '../src/paseo/gateway.js';
import { assessLiveVerification } from '../src/paseo/verification.js';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';
import { checkResultSchema } from '../src/core/result.js';
import { policyFixture, probeFixture, probeInput } from './helpers/provider-policy.js';

const ids = [...MANAGED_PROVIDER_IDS].sort();
const policy = policyFixture();
const ready = () => ({ entries: [...MANAGED_PROVIDER_IDS.map(provider => ({ provider, status: 'ready', enabled: true })),
  { provider: 'unrelated', status: 'error', enabled: false }] });
const config = () => ({ config: { providers: { unrelated: { private: 'synthetic-private' }, ...policy } } });
const inventory = (entries: unknown[] = []) => ({ entries, pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
const agent = (provider: string, status: unknown, archivedAt: unknown = null) => ({ agent: { id: 'fixture', provider, status, archivedAt } });
function fixture() {
  const sdk = { connect: vi.fn<VerificationClient['connect']>().mockResolvedValue(),
    close: vi.fn<VerificationClient['close']>().mockResolvedValue(), getConnectionState: () => ({ status: 'connected' as const }),
    providers: { refresh: vi.fn<VerificationClient['providers']['refresh']>().mockResolvedValue({ acknowledged: true }),
      waitForReady: vi.fn<VerificationClient['providers']['waitForReady']>().mockResolvedValue(ready()) },
    config: { get: vi.fn<VerificationClient['config']['get']>().mockResolvedValue(config()) },
    agents: { list: vi.fn<VerificationClient['agents']['list']>().mockResolvedValue(inventory()) } };
  const factory = vi.fn<VerificationClientFactory>().mockReturnValue(sdk);
  return { sdk, factory };
}
it('verifies true/true/false live complete policy and unrelated inventories with one bounded session', async () => {
  const { sdk, factory } = fixture();
  const result = await verifyPaseo(probeInput, probeFixture(), 'synthetic-private', policy, factory);
  expect(result.ok).toBe(true); expect(result.readyProviderIds).toEqual(ids); expect(result.activeManagedProviderIds).toEqual([]);
  expect(result.checks.every(check => checkResultSchema.safeParse(check).success)).toBe(true);
  expect(result.checks.filter(check => check.id.endsWith('.policy')).map(check => check.message)).toEqual([
    'codex-lead must exactly match the desired fixed entry (paseoTools.enabled=true).',
    'codex-peer must exactly match the desired fixed entry (paseoTools.enabled=false).',
    'codex-supervisor must exactly match the desired fixed entry (paseoTools.enabled=true).',
  ]);
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
  expect(factory.mock.calls[0]?.[0]).toMatchObject({ appVersion: '0.8.0-beta.1', password: 'synthetic-private', reconnect: { enabled: false } });
  expect(sdk.providers.refresh.mock.calls).toEqual([[{ providers: [...MANAGED_PROVIDER_IDS] }]]);
  expect(sdk.providers.waitForReady.mock.calls).toEqual([[{ timeoutMs: probeInput.timeoutMs }]]);
  for (const method of [sdk.connect, sdk.close, sdk.config.get, sdk.agents.list]) expect(method).toHaveBeenCalledOnce();
});
it.each(['loading', 'error', 'unavailable', 'unknown', null, 1, undefined])('fails closed on managed status %s', status => {
  const result = assessLiveVerification(policy, { entries: [...ready().entries.filter(e => e.provider !== 'codex-peer'),
    { provider: 'codex-peer', status, error: 'synthetic-private' }] }, config(), inventory());
  expect(result.ok).toBe(false); expect(result.readyProviderIds).toEqual(['codex-lead', 'codex-supervisor']);
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
});
it.each(['missing', 'duplicate', 'null', 'unidentified', 'disabled', 'wrong-enabled', 'wrong-error', 'bad-envelope'])('rejects %s provider evidence', kind => {
  const entries: unknown[] = ready().entries;
  if (kind === 'missing') entries.splice(0, 1);
  if (kind === 'duplicate') entries.push(entries[0]);
  if (kind === 'null') entries.push(null);
  if (kind === 'unidentified') entries.push({ status: 'ready' });
  if (kind === 'disabled') entries[0] = { provider: 'codex-supervisor', status: 'ready', enabled: false };
  if (kind === 'wrong-enabled') entries[0] = { provider: 'codex-supervisor', status: 'ready', enabled: 'true' };
  if (kind === 'wrong-error') entries[0] = { provider: 'codex-supervisor', status: 'ready', error: {} };
  expect(assessLiveVerification(policy, kind === 'bad-envelope' ? null : { entries }, config(), inventory()).ok).toBe(false);
});
it.each(['missing', 'extra', 'enabled', 'disabledTools', 'command', 'env', 'label', 'extends', 'absent', 'inherited', 'bad-config'])('rejects %s policy for every role', kind => {
  for (const id of ids) {
    const value: Record<string, unknown> = structuredClone(policy[id]);
    if (kind === 'missing') Reflect.deleteProperty(value, 'paseoTools');
    if (kind === 'extra') value.extra = 'synthetic-private';
    if (kind === 'enabled') value.paseoTools = { enabled: !policy[id].paseoTools.enabled };
    if (kind === 'disabledTools') value.paseoTools = { ...policy[id].paseoTools, disabledTools: [] };
    if (kind === 'command') value.command = ['/opt/wrong'];
    if (kind === 'env') value.env = { CODEX_HOME: '/wrong' };
    if (kind === 'label' || kind === 'extends') value[kind] = 'wrong';
    if (kind === 'inherited') value.paseoTools = {};
    const providers: Record<string, unknown> = { ...policy, [id]: value };
    if (kind === 'absent') Reflect.deleteProperty(providers, id);
    const result = assessLiveVerification(policy, ready(), kind === 'bad-config' ? null : { config: { providers } }, inventory());
    expect(result.ok).toBe(false);
    expect(result.checks.find(check => check.id === `paseo.providers.${id}.policy`)?.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  }
});
it.each(['initializing', 'idle', 'running', 'error', 'unknown', null, undefined, 42])('blocks managed agents in %s state', status => {
  const result = assessLiveVerification(policy, ready(), config(), inventory([
    ...ids.flatMap(id => [agent(id, status), agent(id, status)]), agent('unrelated', 'running'),
  ]));
  expect(result.ok).toBe(false); expect(result.activeManagedProviderIds).toEqual(ids);
});
it.each(['closed', 'archived'])('allows %s managed agents and unrelated active agents', kind => {
  const result = assessLiveVerification(policy, ready(), config(), inventory([
    ...ids.map(id => agent(id, kind === 'closed' ? 'closed' : 'error', kind === 'archived' ? '2026-09-09T00:00:00Z' : null)),
    agent('unrelated', 'running'),
  ]));
  expect(result.ok).toBe(true); expect(result.activeManagedProviderIds).toEqual([]);
});
it.each([null, { entries: [] }, inventory([null]), inventory([{ agent: {} }]), inventory([agent('codex-peer', 'idle', 12)]),
  { ...inventory(), pageInfo: { hasMore: true, nextCursor: 'private', prevCursor: null } },
])('fails closed on malformed or incomplete inventory %#', agents => {
  expect(assessLiveVerification(policy, ready(), config(), agents).ok).toBe(false);
});
it('is deterministic under provider/agent order and duplicate active agents', () => {
  const entries = ids.flatMap(id => [agent(id, 'running'), agent(id, 'error')]);
  expect(assessLiveVerification(policy, ready(), config(), inventory(entries))).toEqual(
    assessLiveVerification(policy, { entries: ready().entries.reverse() }, config(), inventory(entries.reverse())));
});
it.each(['refresh', 'wait', 'config', 'agents', 'connect', 'close'] as const)('bounds and sanitizes %s errors/timeouts and always closes', async name => {
  for (const timeout of [false, true]) {
    const { sdk, factory } = fixture();
    const method = { refresh: sdk.providers.refresh, wait: sdk.providers.waitForReady,
      config: sdk.config.get, agents: sdk.agents.list, connect: sdk.connect, close: sdk.close }[name];
    if (timeout) method.mockImplementation(() => new Promise<never>(() => {}));
    else method.mockRejectedValue(new Error('synthetic-private'));
    const operation = verifyPaseo({ ...probeInput, timeoutMs: 5 }, probeFixture(), 'synthetic-private', policy, factory);
    if (name === 'connect' || name === 'close') {
      await expect(operation).rejects.toMatchObject({ check: { id: name === 'connect' ? 'paseo.unreachable' : 'paseo.cleanup' } });
      await expect(operation).rejects.not.toThrow('synthetic-private');
    } else {
      const result = await operation;
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('synthetic-private');
      expect(result.checks[0]?.id).toBe(`paseo.verification.${name}`);
      if (name === 'refresh' || name === 'wait') expect(result.readyProviderIds).toEqual([]);
    }
    expect(method).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce();
    expect(sdk.providers.refresh).toHaveBeenCalledTimes(name === 'connect' ? 0 : 1);
  }
});
it.each([null, {}, { acknowledged: false }, { acknowledged: 'true' }])('rejects malformed refresh acknowledgement %# without retry', async response => {
  const { sdk, factory } = fixture();
  sdk.providers.refresh.mockResolvedValue(response);
  const result = await verifyPaseo(probeInput, probeFixture(), undefined, policy, factory);
  expect(result.ok).toBe(false); expect(result.readyProviderIds).toEqual([]);
  expect(result.checks[0]?.id).toBe('paseo.verification.refresh');
  expect(sdk.providers.refresh).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce();
});
it('rejects invalid desired policy before connecting or refreshing', async () => {
  const { factory } = fixture();
  await expect(verifyPaseo(probeInput, probeFixture(), undefined, {}, factory)).rejects.toMatchObject({ check: { id: 'paseo.verification_policy' } });
  expect(factory).not.toHaveBeenCalled();
});
