import { createPaseoClient } from '@getpaseo/client';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { connectPaseo, verifyPaseo, withPaseoConfig, type ConfigClientFactory } from '../src/paseo/gateway.js';
import { localProbeDependencies } from '../src/paseo/runtime.js';
import { policyFixture } from './helpers/provider-policy.js';
import { providerPoliciesEqual, validateProviderPolicy } from '../src/paseo/provider-policy.js';
import { withTransactionGateway } from '../src/paseo/transaction-gateway.js';
import { z } from 'zod';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';

const exec = promisify(execFile);
it.each([false, true])('npm-distributed 0.8.0-beta.1 isolated handshake (password protected: %s)', async (authenticated) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-contract-')));
  const home = join(root, 'home');
  const localHome = join(home, '.paseo');
  await mkdir(localHome, { recursive: true, mode: 0o700 });
  // Explicit fixture initialization models user-owned state, never a probe repair.
  await writeFile(join(localHome, 'cli-client-id'), `cid_${randomUUID()}`, { mode: 0o600 });
  const password = authenticated ? randomUUID() : undefined;
  const unrelated = { extends: 'codex', label: 'Unrelated fixture provider', enabled: false };
  await writeFile(join(localHome, 'config.json'), JSON.stringify({ agents: { providers: { unrelated } }, daemon: { appendSystemPrompt: 'preserve-me' } }), { mode: 0o600 });
  const canonicalHome = join(home, '.codex');
  await mkdir(canonicalHome, { mode: 0o700 });
  const credentialPath = join(canonicalHome, 'auth.json');
  // Synthetic fixture only; never inspect real credentials or emit sentinel bytes.
  const credentialBytes = Buffer.from(JSON.stringify({ fixture: randomUUID() }));
  await writeFile(credentialPath, credentialBytes, { mode: 0o600 });
  const credentialMode = (await lstat(credentialPath)).mode;

  const env = { HOME: home, PASEO_HOME: localHome, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'empty.npmrc'),
    npm_config_globalconfig: join(root, 'empty-global.npmrc'), TMPDIR: root };
  const executable = join(root, 'install/node_modules/@getpaseo/cli/bin/paseo');
  const launchLog = join(root, 'fixture-launches.jsonl');
  const rpcLog = join(root, 'fixture-rpc.jsonl');
  const readLines = async (path: string): Promise<unknown[]> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line): unknown => JSON.parse(line));
  let started = false;
  const run = (binary: string, args: string[], timeout = 30_000) => exec(binary, args, { env, shell: false, timeout, maxBuffer: 1024 * 1024 });
  try {
    await run(join(dirname(process.execPath), 'npm'), ['install', '--prefix', join(root, 'install'), '--ignore-scripts', '--no-audit', '--no-fund', '@getpaseo/cli@0.8.0-beta.1'], 180_000);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('No isolated port')); return; }
        server.close((error) => { if (error) reject(error); else resolve(address.port); });
      });
    });
    expect(port).not.toBe(6767);
    // Both explicit --home and environment are isolated; never fall back to operator defaults.
    started = true;
    await exec(executable, ['daemon', 'start', '--home', localHome, '--listen', `127.0.0.1:${String(port)}`, '--no-relay', '--no-mcp', '--no-inject-mcp', '--no-web-ui'], { env: { ...env, ...(password === undefined ? {} : { PASEO_PASSWORD: password }) }, shell: false, timeout: 30_000 }).catch(() => { throw new Error('Isolated daemon start failed'); });
    await expect.poll(async () => {
      try {
        await Promise.all(['server-id', 'paseo.pid'].map(name => lstat(join(localHome, name))));
        return true;
      } catch { return false; }
    }, { timeout: 15_000, interval: 100 }).toBe(true);
    const input = { executable, home, localHome, paseoUrl: `ws://localhost:${String(port)}`, timeoutMs: 10_000 };
    const snapshot = async () => Promise.all(['server-id', 'cli-client-id', 'paseo.pid', 'config.json'].map(async (name) => {
      const path = join(localHome, name);
      const metadata = await lstat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.uid).toBe(process.getuid?.());
      expect(metadata.mode & 0o022).toBe(0);
      if (name.endsWith('-id') || name === 'config.json') expect(metadata.mode & 0o7777).toBe(0o600);
      return { name, bytes: await readFile(path), mode: metadata.mode, ctimeMs: metadata.ctimeMs };
    }));
    // Snapshot before the FIRST probe (no handshake warm-up that could hide writes).
    const before = await snapshot();
    const unchanged = async () => {
      const after = await snapshot();
      expect(after.map(({ name, bytes, mode }) => ({ name, bytes, mode })))
        .toEqual(before.map(({ name, bytes, mode }) => ({ name, bytes, mode })));
      return after;
    };
    const deps = localProbeDependencies();
    const admitted = await connectPaseo(input, deps, password);
    const afterFirst = await unchanged();
    console.info(`isolated password-protected=${String(authenticated)}: bytes/modes unchanged; ctime changed: ${afterFirst.filter((file, index) => file.ctimeMs !== before[index]?.ctimeMs).map((file) => file.name).join(', ') || 'none'}`);
    expect(admitted).toMatchObject({ localHome, listen: `ws://127.0.0.1:${String(port)}`, cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' });
    if (password !== undefined) {
      for (const [supplied, id] of [[undefined, 'auth_required'], [randomUUID(), 'auth_failed']] as const) {
        const factory = vi.fn();
        await expect(connectPaseo(input, deps, supplied, factory)).rejects.toMatchObject({ check: { id: `paseo.${id}` } });
        expect(factory).not.toHaveBeenCalled();
        await unchanged();
        // Exercise the public SDK rejection too; status gating above must not hide it.
        const sdk = createPaseoClient({ url: `ws://127.0.0.1:${String(port)}/ws`,
          ...(supplied === undefined ? {} : { password: supplied }), connectTimeoutMs: 5000,
          reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
        try {
          await expect(sdk.connect()).rejects.toThrow(id === 'auth_required' ? 'Password required' : 'Incorrect password');
        } finally { await sdk.close(); }
        await unchanged();
      }
    }
    await connectPaseo(input, deps, password);
    await unchanged();
    const beforeConfig: unknown = JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'));
    const patches: unknown[] = [];
    const factory: ConfigClientFactory = config => {
      const client = createPaseoClient(config);
      return { connect: () => client.connect(), close: () => client.close(), getConnectionState: () => client.getConnectionState(),
        config: { get: () => client.config.get(), patch: patch => { patches.push(structuredClone(patch)); return client.config.patch(patch); } } };
    };
    // Protocol-only fake: synthetic turns, no tools, credentials, or project work.
    const script = join(root, 'codex.mjs');
    await writeFile(script, `import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, argv: process.argv, home: process.env.CODEX_HOME }) + '\\n');
if (process.argv[2] === '--version') { console.log('codex-cli 1.0.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(1);
process.stdin.on('end', () => process.exit(0));
const record = value => fs.appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ pid: process.pid, home: process.env.CODEX_HOME, ...value }) + '\\n');
const send = value => console.log(JSON.stringify(value));
const threadId = 'fixture-thread-' + process.pid;
let loaded = true;
const model = { id: 'fixture', model: 'fixture', displayName: 'Fixture', description: 'Discovery fixture', hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Fixture' }], defaultReasoningEffort: 'medium', isDefault: true };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  // Store only protocol parameters known not to contain daemon MCP credentials.
  const params = request.method === 'thread/start' ? { cwd: request.params.cwd, model: request.params.model }
    : ['turn/start', 'thread/resume'].includes(request.method) ? { threadId: request.params.threadId }
    : ['initialize', 'initialized', 'config/read', 'skills/list', 'collaborationMode/list'].includes(request.method) ? request.params : {};
  record({ method: request.method, params });
  if (request.id === undefined) return;
  const results = { initialize: { userAgent: 'fixture' }, 'model/list': { data: [model], nextCursor: null },
    'account/read': { account: null, requiresOpenaiAuth: false },
    'getUserSavedConfig': { config: {} }, 'thread/loaded/list': { data: loaded ? [threadId] : [], nextCursor: null },
    'config/read': { config: {} }, 'collaborationMode/list': { data: [] }, 'skills/list': { data: [] },
    'thread/start': { thread: { id: threadId } }, 'thread/resume': { thread: { id: request.params?.threadId } }, 'turn/start': { turn: { id: 'fixture-turn' } }, 'thread/archive': {} };
  const result = results[request.method];
  record({ responseTo: request.method, success: result !== undefined });
  send(result === undefined ? { id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } } : { id: request.id, result });
  if (request.method === 'turn/start') {
    // Simulate native thread eviction between turns to exercise public send -> resume.
    loaded = false;
    const threadId = request.params.threadId;
    send({ method: 'turn/started', params: { threadId, turn: { id: 'fixture-turn' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: 'fixture-turn', status: 'completed' } } }), 50);
  }
});
`, { mode: 0o600 });
    const policy = policyFixture([process.execPath, script], root);
    for (const id of MANAGED_PROVIDER_IDS) await mkdir(policy[id].env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const updatedPolicy = policyFixture(['/opt/paseo-room-fixture/codex'], join(root, 'updated'));
    await withPaseoConfig(input, deps, password, async gateway => {
      expect((await gateway.readConfig()).providers.unrelated).toEqual(unrelated);
      await gateway.patchProviders(policy);
      expect(patches).toEqual([{ providers: policy }]);
      const live = await gateway.readConfig();
      const managed = Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, live.providers[id]]));
      expect(validateProviderPolicy(managed)).toEqual(policy);
      expect(providerPoliciesEqual(managed, policy)).toBe(true);
      expect(live.providers.unrelated).toEqual(unrelated);
      const disk: unknown = JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'));
      expect(disk).toMatchObject({ daemon: { appendSystemPrompt: 'preserve-me' }, agents: { providers: { unrelated, ...policy } } });
      expect(await readFile(credentialPath)).toEqual(credentialBytes);
      expect((await lstat(credentialPath)).mode).toBe(credentialMode);
      const beforeVerification = await readFile(join(localHome, 'config.json'));
      const beforeVerificationMode = (await lstat(join(localHome, 'config.json'))).mode;
      const verified = await verifyPaseo(input, deps, password, policy);
      expect(verified.checks.filter(check => check.status !== 'pass')).toEqual([]);
      expect(verified.ok).toBe(true);
      expect(verified.readyProviderIds).toEqual([...MANAGED_PROVIDER_IDS].sort());
      expect(verified.activeManagedProviderIds).toEqual([]);
      expect(await readFile(join(localHome, 'config.json'))).toEqual(beforeVerification);
      expect((await lstat(join(localHome, 'config.json'))).mode).toBe(beforeVerificationMode);
      const launches = z.array(z.object({ argv: z.array(z.string()) })).parse(await readLines(launchLog));
      expect(launches.map(launch => launch.argv)).toContainEqual([process.execPath, script, 'app-server']);
      expect(launches.every(({ argv }) => argv.length === 3 && argv[0] === process.execPath && argv[1] === script && ['app-server', '--version'].includes(argv[2] ?? ''))).toBe(true);
      const sdk = createPaseoClient({ url: `${admitted.listen}/ws`, appVersion: '0.8.0-beta.1',
        ...(password === undefined ? {} : { password }), reconnect: { enabled: false },
        logger: { debug() {}, info() {}, warn() {}, error() {} } });
      try {
        await sdk.connect();
        // The root factory deliberately does not expose the low-level resume/import RPCs.
        expect('resume' in sdk.agents).toBe(false);
        expect('import' in sdk.agents).toBe(false);
        for (const id of MANAGED_PROVIDER_IDS) {
          const agent = await sdk.agents.create({ config: { provider: `${id}/fixture`, thinkingOptionId: 'medium' }, cwd: root, title: 'Isolated contract fixture' });
          try {
            for (const prompt of ['Synthetic fixture turn; no work.', 'Resume synthetic fixture; no work.']) {
              const completed = await agent.run(prompt, { timeoutMs: 10_000 });
              expect(completed).toMatchObject({ status: 'idle', error: null,
                final: { id: agent.id, provider: id, status: 'idle' } });
            }
            expect((await agent.refresh())?.agent).toMatchObject({ id: agent.id, provider: id, status: 'idle' });
            const inventory = await sdk.agents.list();
            expect(inventory.pageInfo.hasMore).toBe(false);
            expect(inventory.entries.map(entry => entry.agent)).toContainEqual(expect.objectContaining({ id: agent.id, provider: id, status: 'idle' }));
            expect(await withTransactionGateway(input, deps, password, transaction => transaction.sessionsSafe(policy))).toBe(false);
            const blocked = await verifyPaseo(input, deps, password, policy);
            expect(blocked.ok).toBe(false);
            expect(blocked.activeManagedProviderIds).toEqual([id]);
            expect(blocked.checks.filter(check => check.status !== 'pass').map(check => check.id)).toEqual([`paseo.agents.${id}.inactive`]);
          } finally { await agent.archive(); }
          expect((await agent.refresh())?.agent.archivedAt).toEqual(expect.any(String));
          expect(await withTransactionGateway(input, deps, password, transaction => transaction.sessionsSafe(policy))).toBe(true);
        }
        const rpc = await readLines(rpcLog);
        const sessionStarts = z.array(z.object({ pid: z.number(), home: z.string(), method: z.string().optional() }))
          .parse(rpc).filter(entry => entry.method === 'thread/start');
        expect(sessionStarts).toHaveLength(3);
        const allLaunches = z.array(z.object({ pid: z.number(), argv: z.array(z.string()), home: z.string() })).parse(await readLines(launchLog));
        // The pinned daemon enables goals on session launches, but not discovery.
        for (const { pid, home } of sessionStarts) {
          expect(allLaunches).toContainEqual({ pid, home, argv: [process.execPath, script, 'app-server', '--enable', 'goals'] });
          expect(rpc).toContainEqual(expect.objectContaining({ pid, home, method: 'thread/resume', params: { threadId: `fixture-thread-${String(pid)}` } }));
          expect(rpc).toContainEqual(expect.objectContaining({ pid, home, method: 'turn/start', params: { threadId: `fixture-thread-${String(pid)}` } }));
        }
        for (const id of MANAGED_PROVIDER_IDS) {
          const home = policy[id].env.CODEX_HOME;
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'initialize', params: {
            clientInfo: { name: 'codex_app_server_daemon', title: 'Codex App Server Daemon', version: '0.0.0' },
            capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } } }));
          for (const method of ['initialize', 'config/read', 'collaborationMode/list', 'skills/list', 'thread/start', 'turn/start', 'thread/resume']) {
            expect(rpc).toContainEqual(expect.objectContaining({ home, responseTo: method, success: true }));
          }
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'initialized', params: {} }));
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'config/read', params: { cwd: root } }));
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'collaborationMode/list', params: {} }));
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'skills/list', params: { cwds: [root] } }));
          expect(rpc).toContainEqual(expect.objectContaining({ home, method: 'thread/start', params: { cwd: root, model: 'fixture' } }));
        }
        expect(rpc).not.toContainEqual(expect.objectContaining({ success: false }));
        expect((await verifyPaseo(input, deps, password, policy)).ok).toBe(true);
        console.info(JSON.stringify({ authenticated, create: [...MANAGED_PROVIDER_IDS], initialization: 'acknowledged', turn: 'completed', sessionGate: 'unsafe-then-safe', refresh: 'registry-and-agent-refetch', resume: 'native-thread-reload-on-second-turn', import: 'not-exposed-by-root-factory', archive: 'paseo-inventory-verified-native-rpc-not-observed' }));
      } catch (error) {
        // Only a bounded source location, never raw SDK payloads or credentials.
        console.error(error instanceof Error ? { name: error.name, location: error.stack?.split('\n').find(line => line.includes('paseo-isolated.contract.ts')) } : { name: 'Unknown failure' });
        throw error;
      } finally { await sdk.close(); }
      // Exercise Paseo's deep-merge path with complete replacement values, including
      // shortening a Node/script command tuple to one native executable.
      await gateway.patchProviders(updatedPolicy);
      expect(patches).toEqual([{ providers: policy }, { providers: updatedPolicy }]);
      const updatedLive = await gateway.readConfig();
      const updatedManaged = Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, updatedLive.providers[id]]));
      expect(validateProviderPolicy(updatedManaged)).toEqual(updatedPolicy);
      expect(providerPoliciesEqual(updatedManaged, updatedPolicy)).toBe(true);
      expect(updatedLive.providers.unrelated).toEqual(unrelated);
      await gateway.removeProviders();
      expect(patches).toEqual([{ providers: policy }, { providers: updatedPolicy }, { removeProviders: [...MANAGED_PROVIDER_IDS] }]);
      expect((await gateway.readConfig()).providers).toEqual({ unrelated });
    }, factory);
    expect(JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'))).toEqual(beforeConfig);
    expect(await readFile(credentialPath)).toEqual(credentialBytes);
    expect((await lstat(credentialPath)).mode).toBe(credentialMode);
    console.info(`isolated password-protected=${String(authenticated)}: all three providers ready, live true/true/false policy, no active managed sessions, exact removal; unrelated config/providers and credential bytes/mode preserved`);
  } finally {
    if (started) {
      await run(executable, ['daemon', 'stop', '--home', localHome]);
      const status: unknown = JSON.parse((await run(executable, ['daemon', 'status', '--json'])).stdout);
      expect(status).toMatchObject({ home: localHome, localDaemon: 'stopped' });
    }
    // Refuse tree deletion if any recorded fixture process survives daemon shutdown.
    const launches = await readLines(launchLog).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const { pid } of z.array(z.object({ pid: z.number().int().positive() })).parse(launches)) {
      await expect.poll(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error; }
      }, { timeout: 10_000 }).toBe(true);
    }
    // Preserve evidence rather than deleting a live daemon's home if stop failed.
    await rm(root, { recursive: true, force: true });
  }
});
