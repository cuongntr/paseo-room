import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_SETTINGS, attentionSettingsSchema, egressRefusal, type AttentionSettings } from '../src/runtime-plugin/shared/attention.js';
import { AttentionKey, KEY_ENV } from '../src/runtime-plugin/server/attention/key.js';
import { AttentionLog } from '../src/runtime-plugin/server/attention/log.js';
import { mask, tail } from '../src/runtime-plugin/server/attention/mask.js';
import { SystemOneSensor } from '../src/runtime-plugin/server/attention/sensor.js';
import { assistLeadTurn, type Assessment } from '../src/runtime-plugin/server/attention/triage.js';
import { PaseoHandle } from '../src/runtime-plugin/server/paseo-port.js';
import { createRpcHandlers } from '../src/runtime-plugin/server/rpc.js';

let root: string;
let server: Server | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'paseo-room-sensor-')); });
afterEach(async () => {
  await new Promise<void>(resolve => { if (server === undefined) resolve(); else server.close(() => { resolve(); }); });
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

interface Received { readonly authorization?: string; readonly body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> } }

/** A local System One stand-in; `reply` decides each answer. */
async function stub(reply: (request: Received) => { status?: number; body?: unknown; delayMs?: number }): Promise<{ readonly endpoint: string; readonly received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request: IncomingMessage, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    request.on('end', () => {
      const entry: Received = { ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }), body: JSON.parse(text) as Received['body'] };
      received.push(entry);
      const answer = reply(entry);
      setTimeout(() => {
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body ?? {}));
      }, answer.delayMs ?? 0);
    });
  });
  const listening = server;
  await new Promise<void>(resolve => { listening.listen(0, '127.0.0.1', () => { resolve(); }); });
  return { endpoint: `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}/v1/systemone`, received };
}

const answer = (outcome: string, confidence: number, nouls: Record<string, number> = {}, model = 'jev-1.13.0') => ({
  model,
  answers: {
    outcome: { type: 'choice', choice: outcome, probabilities: { [outcome]: confidence }, confidence },
    ...Object.fromEntries(Object.entries(nouls).map(([name, value]) => [name, { type: 'noul', noul: value }])),
  },
  usage: { input_tokens: 321, output_tokens: 20 },
});

function sensorWith(sensor: Partial<AttentionSettings['sensor']>, options: { readonly key?: string; readonly fetch?: typeof fetch; readonly now?: () => Date } = {}) {
  const settings: AttentionSettings = { ...DEFAULT_ATTENTION_SETTINGS, sensor: { ...DEFAULT_ATTENTION_SETTINGS.sensor, ...sensor } };
  const key = AttentionKey.at(root, {});
  const log = AttentionLog.at(root);
  const instance = new SystemOneSensor({ settings: () => settings, key, log, now: options.now ?? (() => new Date()), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  return { sensor: instance, key, log, ready: options.key === undefined ? Promise.resolve() : key.set(options.key) };
}

const facts = { peersRunning: 0, permissionPending: false };

describe('masking', () => {
  it('masks credentials, tokens, secrets in assignments, URL user-info and queries', () => {
    const cases: [string, string][] = [
      ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [secret]'],
      ['key sk-proj-AbCdEfGhIjKlMnOpQrSt used', 'key [secret] used'],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [secret]'],
      ['glpat-abcdefghijklmnopqrst1', '[secret]'],
      ['DATAGERRY_PASSWORD=hunter2hunter2', 'DATAGERRY_PASSWORD=[secret]'],
      ['api_key: "abc123"', 'api_key: [secret]'],
      ['https://user:pass@git.example.test/repo.git', 'https://[user]@git.example.test/repo.git'],
      ['see https://ci.example.test/run?token=zzz&x=1 now', 'see https://ci.example.test/run?[query] now'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', '[jwt]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[private key]'],
    ];
    for (const [input, expected] of cases) expect(mask(input, { networkIdentifiers: false })).toBe(expected);
  });

  it('masks network identifiers only when asked, and leaves ordinary prose alone', () => {
    expect(mask('deploy to 10.20.30.40:8080 and dx-cmdb.cmctelecom.vn', { networkIdentifiers: true })).toBe('deploy to [ip] and [host]');
    expect(mask('deploy to 10.20.30.40', { networkIdentifiers: false })).toBe('deploy to 10.20.30.40');
    const prose = 'Đã xong v0.1.12: sửa README.md, chạy npm run verify (594 tests pass). Chờ Human duyệt.';
    expect(mask(prose)).toBe(prose);
    expect(tail('a\n\n  b  c', 10)).toBe('a b c');
    expect(tail('0123456789abcdef', 6)).toBe('…bcdef');
  });
});

describe('settings and consent', () => {
  it('defaults to letters on and the sensor off, pinned to jev-1.13.0', () => {
    expect(DEFAULT_ATTENTION_SETTINGS.letters.enabled).toBe(true);
    expect(DEFAULT_ATTENTION_SETTINGS.sensor).toMatchObject({ mode: 'off', model: 'jev-1.13.0', endpoint: 'https://api.typesafe.ai/v1/systemone', egressAcknowledgedHost: null, assistQuestionSets: [] });
    expect(attentionSettingsSchema.safeParse({ sensor: { mode: 'always' } }).success).toBe(false);
  });

  it('refuses egress until the endpoint host is acknowledged, except on loopback', () => {
    const sensor = DEFAULT_ATTENTION_SETTINGS.sensor;
    expect(egressRefusal(sensor)).toBe('The sensor is off.');
    expect(egressRefusal({ ...sensor, mode: 'shadow' })).toBe('Sending to api.typesafe.ai has not been acknowledged in Settings.');
    expect(egressRefusal({ ...sensor, mode: 'shadow', egressAcknowledgedHost: 'api.typesafe.ai' })).toBeUndefined();
    expect(egressRefusal({ ...sensor, mode: 'shadow', egressAcknowledgedHost: 'api.typesafe.ai', endpoint: 'https://jev.internal.example/v1' })).toContain('jev.internal.example');
    expect(egressRefusal({ ...sensor, mode: 'assist', endpoint: 'http://127.0.0.1:9000/v1/systemone' })).toBeUndefined();
  });

  it('makes no request while off, unacknowledged or without a key', async () => {
    let calls = 0;
    const counting: typeof fetch = () => { calls += 1; return Promise.reject(new Error('should not be called')); };
    for (const [sensorSettings, key] of [
      [{ mode: 'off' as const }, 'k'],
      [{ mode: 'shadow' as const }, 'k'],
      [{ mode: 'shadow' as const, endpoint: 'http://127.0.0.1:1/v1' }, undefined],
    ] as const) {
      const { sensor, ready, key: store } = sensorWith(sensorSettings, { fetch: counting, ...(key === undefined ? {} : { key }) });
      await ready;
      if (key === undefined) await store.clear();
      expect(await sensor.leadTurn({ id: 'att_x', message: 'Done.', facts, seatName: 'Lead of shop' })).toBeUndefined();
    }
    expect(calls).toBe(0);
  });
});

describe('System One adapter', () => {
  it('sends the masked, bounded lead-turn-v1 state and reads typed answers', async () => {
    const { endpoint, received } = await stub(() => ({ body: answer('waiting_for_peer', 0.9, { asks_human: 0.1, done_unverified: 0.2 }) }));
    const { sensor, ready } = sensorWith({ mode: 'shadow', endpoint }, { key: 'secret-key-1' });
    await ready;
    const result = await sensor.leadTurn({ id: 'att_one', message: `${'x'.repeat(3_000)} Token=abc123secret đang chờ Peer`, facts, seatName: 'Lead of shop' });
    expect(result).toMatchObject({ mode: 'shadow', assist: false, assessment: { model: 'jev-1.13.0', choice: { value: 'waiting_for_peer', confidence: 0.9 }, nouls: { asks_human: 0.1 }, inputTokens: 321 } });
    const [request] = received;
    expect(request?.authorization).toBe('Bearer secret-key-1');
    expect(request?.body.model).toBe('jev-1.13.0');
    expect(Object.keys(request?.body.questions ?? {})).toEqual(['outcome', 'asks_human', 'done_unverified']);
    const message = String(request?.body.state.last_message);
    expect(message.length).toBeLessThanOrEqual(1_500);
    expect(message).toContain('Token=[secret] đang chờ Peer');
    expect(request?.body.state.facts).toEqual({ peers_running: 'none', permission_pending: 'no' });
    const log = await readFile(join(root, 'attention', 'log', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(log).toContain('"type":"assessment.recorded"');
    expect(log).not.toContain('secret-key-1');
    expect(log).not.toContain('abc123secret');
    expect(sensor.status()).toMatchObject({ calls: 1, failures: 0, inputTokens: 321, shadow: { 'lead-turn-v1': { assessed: 1, now: 1 } } });
  });

  it('applies assist only for opted-in question sets', async () => {
    const { endpoint } = await stub(() => ({ body: answer('completed', 0.95) }));
    const off = sensorWith({ mode: 'assist', endpoint }, { key: 'k' });
    await off.ready;
    expect((await off.sensor.leadTurn({ id: 'att_a', message: 'Done', facts, seatName: 'Lead' }))?.assist).toBe(false);
    const on = sensorWith({ mode: 'assist', endpoint, assistQuestionSets: ['lead-turn-v1'] }, { key: 'k' });
    await on.ready;
    expect((await on.sensor.leadTurn({ id: 'att_b', message: 'Done', facts, seatName: 'Lead' }))?.assist).toBe(true);
  });

  it('treats an error status, a wrong model, a malformed body and a timeout as no answer, then opens the circuit', async () => {
    const replies = [{ status: 429 }, { body: answer('completed', 0.9, {}, 'jev-latest-9') }, { body: { nope: true } }, { delayMs: 400 }, { status: 500 }];
    let index = 0;
    const { endpoint, received } = await stub(() => replies[index++] ?? {});
    const { sensor, ready } = sensorWith({ mode: 'shadow', endpoint, timeoutMs: 200 }, { key: 'k' });
    await ready;
    for (let attempt = 0; attempt < replies.length; attempt += 1) {
      expect(await sensor.leadTurn({ id: `att_${String(attempt)}xxxxxxxx`, message: 'Done', facts, seatName: 'Lead' })).toBeUndefined();
    }
    expect(sensor.status()).toMatchObject({ calls: 0, failures: 5 });
    expect(sensor.status().circuitOpenUntil).toBeDefined();
    expect(await sensor.refusal()).toBe('The sensor circuit is open after repeated failures.');
    const before = received.length;
    expect(await sensor.leadTurn({ id: 'att_zzzzzzzzzz', message: 'Done', facts, seatName: 'Lead' })).toBeUndefined();
    expect(received.length).toBe(before);
  });
});

describe('assist table (delta §6.4)', () => {
  const assessed = (value: string, confidence: number, nouls: Record<string, number> = {}): Assessment => ({ questionSet: 'lead-turn-v1', model: 'jev-1.13.0', choice: { value, confidence }, nouls, latencyMs: 1 });
  it('raises dead waits and Human questions, lowers only a continuing Lead with work running', () => {
    expect(assistLeadTurn(assessed('waiting_for_peer', 0.9), facts).decision).toBe('now');
    expect(assistLeadTurn(assessed('waiting_for_peer', 0.9), { peersRunning: 1, permissionPending: false }).decision).toBe('digest');
    expect(assistLeadTurn(assessed('needs_human_decision', 0.7), facts).decision).toBe('now');
    expect(assistLeadTurn(assessed('completed', 0.9, { asks_human: 0.8 }), facts).decision).toBe('now');
    expect(assistLeadTurn(assessed('completed', 0.9, { done_unverified: 0.9 }), facts)).toMatchObject({ decision: 'digest', reason: 'completed; status-as-acceptance?' });
    expect(assistLeadTurn(assessed('continuing', 0.9), { peersRunning: 2, permissionPending: false })).toMatchObject({ decision: 'record', continuing: true });
    expect(assistLeadTurn(assessed('continuing', 0.9), facts).decision).toBe('digest');
    expect(assistLeadTurn(assessed('continuing', 0.5), { peersRunning: 2, permissionPending: false }).decision).toBe('digest');
    expect(assistLeadTurn(assessed('unclear', 0.99), facts).decision).toBe('digest');
  });
});

describe('sensor key', () => {
  it('stores the key owner-only, never answers it, and falls back to the environment', async () => {
    const key = AttentionKey.at(root, { [KEY_ENV]: 'from-env' });
    expect(await key.read()).toBe('from-env');
    const rpc = createRpcHandlers({
      controller: {} as never, recovery: {} as never, handle: new PaseoHandle(), attentionKey: key,
      sensor: new SystemOneSensor({ settings: () => DEFAULT_ATTENTION_SETTINGS, key, log: AttentionLog.at(root), now: () => new Date() }),
      attentionSettings: { current: DEFAULT_ATTENTION_SETTINGS, available: true },
    });
    const stored = await rpc.attentionKey({ set: 'stored-secret-9' });
    expect(JSON.stringify(stored)).not.toContain('stored-secret-9');
    expect((stored as { data: unknown }).data).toEqual({ configured: true });
    expect((await stat(join(root, 'secrets', 'attention-key'))).mode & 0o777).toBe(0o600);
    expect(await key.read()).toBe('stored-secret-9');
    const status = await rpc.attentionStatus();
    expect(JSON.stringify(status)).not.toContain('stored-secret-9');
    expect((status as { data: Record<string, unknown> }).data).toMatchObject({ mode: 'off', keyConfigured: true, egress: 'The sensor is off.', settingsAvailable: true });
    expect((await rpc.attentionKey({ set: 'has space' }) as { error?: { code: string } }).error?.code).toBe('key_invalid');
    await rpc.attentionKey({ clear: true });
    expect(await key.read()).toBe('from-env');
  });
});
