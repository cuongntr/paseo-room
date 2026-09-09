import { describe, expect, it } from 'vitest';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';
import { providerEntriesEqual, providerPoliciesEqual, validateProviderEntry, validateProviderPolicy } from '../src/paseo/provider-policy.js';
import { policyFixture } from './helpers/provider-policy.js';

describe('fixed Phase 1 provider policy', () => {
  it.each<[string, ...string[]]>([['/opt/codex'], ['/opt/node', '/opt/codex.js']])('preserves adapter launch prefix %s', (...prefix) => {
    const policy = policyFixture(prefix);
    expect(Object.keys(policy)).toEqual([...MANAGED_PROVIDER_IDS]);
    for (const [index, id] of MANAGED_PROVIDER_IDS.entries()) {
      const role = id.slice(6);
      expect(policy[id]).toEqual({ extends: 'codex', label: `Codex ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
        command: prefix, env: { CODEX_HOME: `/fixture/room/roles/codex/${role}` }, paseoTools: { enabled: index < 2 } });
      expect(policy[id].command).not.toBe(prefix);
    }
    expect(providerPoliciesEqual(policy, structuredClone(policy))).toBe(true);
  });
  it.each(['extends', 'label', 'command', 'env', 'paseoTools'])('rejects missing %s and extra keys without ownership matches', key => {
    const good = policyFixture()['codex-peer'];
    const missing = Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    for (const value of [missing, { ...good, extra: true }]) {
      expect(() => validateProviderEntry('codex-peer', value)).toThrow('Invalid managed provider entry');
      expect(providerEntriesEqual('codex-peer', good, value)).toBe(false);
      expect(providerEntriesEqual('codex-peer', value, value)).toBe(false);
    }
  });
  it.each([
    { command: [] }, { command: ['codex'] }, { command: ['/node', 'script.js'] },
    { command: ['/node', '/script', '/extra'] }, { command: ['/a/../codex'] }, { command: ['/opt/_npx/id/codex'] },
    { command: ['/opt/_cacache/codex'] }, { command: ['/node', '/cache/_npx/codex.js'] }, { command: ['/bin/codex\u0000'] },
    { env: {} }, { env: { CODEX_HOME: 'relative' } }, { env: { CODEX_HOME: '/a/../b' } }, { env: { CODEX_HOME: '/' } },
    { env: { CODEX_HOME: '/a', PASEO_PASSWORD: 'synthetic-private' } },
    { paseoTools: {} }, { paseoTools: { enabled: true } }, { paseoTools: { enabled: false, disabledTools: [] } },
    { paseoTools: { enabled: false, extra: true } }, { extends: 'claude' }, { label: 'Other' },
  ])('rejects invalid entry %j', patch => {
    const policy = policyFixture();
    const invalid = { ...policy, 'codex-peer': { ...policy['codex-peer'], ...patch } };
    expect(() => validateProviderPolicy(invalid)).toThrow('Invalid managed provider policy');
    expect(providerPoliciesEqual(invalid, invalid)).toBe(false);
  });
  it('rejects wrong/missing IDs, duplicate homes and wrong enabled policy for every role', () => {
    const policy = policyFixture();
    expect(() => validateProviderPolicy({ ...policy, other: policy['codex-peer'] })).toThrow();
    expect(() => validateProviderPolicy({ ...policy, 'codex-peer': undefined })).toThrow();
    for (const id of MANAGED_PROVIDER_IDS) {
      expect(() => validateProviderPolicy({ ...policy, [id]: { ...policy[id], paseoTools: { enabled: !policy[id].paseoTools.enabled } } })).toThrow();
    }
    expect(() => validateProviderPolicy({ ...policy, 'codex-peer': { ...policy['codex-peer'], env: policy['codex-lead'].env } })).toThrow();
  });
  it('compares all values, not object insertion order', () => {
    const a = policyFixture()['codex-peer'];
    expect(providerEntriesEqual('codex-peer', a, Object.fromEntries(Object.entries(a).reverse()))).toBe(true);
    expect(providerEntriesEqual('codex-peer', a, { ...a, command: ['/other'] })).toBe(false);
    expect(providerEntriesEqual('codex-peer', a, { ...a, env: { CODEX_HOME: '/other' } })).toBe(false);
  });
});
