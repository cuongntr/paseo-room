import { describe, expect, it } from 'vitest';
import { assessStatus, normalizeUrl, providerMatches, MINIMUM_VERSION } from '../src/paseo.js';
import type { Provider } from '../src/agents/types.js';
import { RUNNING_STATUS as running } from './helpers.js';

describe('normalizeUrl', () => {
  it('accepts host:port and normalises wildcard hosts to loopback', () => {
    expect(normalizeUrl('127.0.0.1:6767')).toBe('ws://127.0.0.1:6767');
    expect(normalizeUrl('0.0.0.0:6767')).toBe('ws://127.0.0.1:6767');
    expect(normalizeUrl('nonsense')).toBeUndefined();
  });
});

describe('assessStatus', () => {
  it('passes a running, compatible daemon', () => {
    const result = assessStatus(running);
    expect(result.daemon).toEqual({ url: 'ws://127.0.0.1:6767', version: '0.8.1' });
    expect(result.checks[0]?.status).toBe('pass');
  });

  it('fails a stopped daemon', () => {
    const result = assessStatus({ ...running, localDaemon: 'stopped' });
    expect(result.daemon).toBeUndefined();
    expect(result.checks[0]?.message).toContain('stopped');
  });

  it('fails when the daemon is older than the minimum', () => {
    const result = assessStatus({ ...running, cliVersion: '0.7.0', daemonVersion: '0.7.0' });
    expect(result.daemon).toBeUndefined();
    expect(result.checks[0]?.message).toContain(MINIMUM_VERSION);
  });

  it('fails when CLI and daemon versions differ', () => {
    const result = assessStatus({ ...running, daemonVersion: '0.8.0' });
    expect(result.checks[0]?.message).toContain('running daemon is 0.8.0');
  });

  it('fails on unreadable status output', () => {
    expect(assessStatus({ nope: true }).checks[0]?.id).toBe('paseo.status');
  });
});

describe('providerMatches', () => {
  const desired: Provider = {
    extends: 'codex', label: 'Codex Lead', command: ['/usr/bin/codex'],
    env: { CODEX_HOME: '/home/u/.paseo-room/roles/codex/lead' }, paseoTools: { enabled: true },
  };

  it('ignores unrelated live fields', () => {
    expect(providerMatches(desired, { ...desired, label: 'renamed by user', extraField: 1 })).toBe(true);
  });

  it('rejects a different tool policy or home', () => {
    expect(providerMatches(desired, { ...desired, paseoTools: { enabled: false } })).toBe(false);
    expect(providerMatches(desired, { ...desired, env: { CODEX_HOME: '/elsewhere' } })).toBe(false);
    expect(providerMatches(desired, undefined)).toBe(false);
  });
});
