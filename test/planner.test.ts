import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planLifecycle, type PlannerInput, type PlannerPathFact } from '../src/core/planner.js';
import { buildManifestProviders, validateManifest, type ManifestArtifact } from '../src/core/manifest.js';
import type { OwnershipState } from '../src/core/observation.js';
import { sha256 } from '../src/core/hash.js';
import { endpointIdentitySha256 } from '../src/paseo/cli-probe.js';
import { MANAGED_PROVIDER_IDS } from '../src/room/roles.js';
import { commandResultSchema } from '../src/core/result.js';
import { renderJson } from '../src/cli/render.js';
import { policyFixture } from './helpers/provider-policy.js';
import { snapshotFixture } from './helpers/home.js';

const artifacts: ManifestArtifact[] = [
  { kind: 'directory', path: '/fixture/room', mode: 0o700 },
  { kind: 'directory', path: '/fixture/room/nested', mode: 0o700 },
  { kind: 'file', path: '/fixture/room/nested/file', mode: 0o600, sha256: sha256('authored') },
  { kind: 'symlink', path: '/fixture/room/link', mode: 0o777, target: '/fixture/canonical/skills' },
];
function fixture(command: PlannerInput['intent']['command'] = 'install', first = false): PlannerInput {
  const providers = policyFixture();
  const manifest = validateManifest({
    schemaVersion: 1, packageVersion: '0.1.0-alpha.0', installationId: 'installation-1', lastTransactionId: 'transaction-1',
    status: 'committed', adapter: 'codex',
    paseo: { localHome: '/fixture/paseo', listen: 'ws://127.0.0.1:6767', endpointIdentitySha256: endpointIdentitySha256('/fixture/paseo', 'ws://127.0.0.1:6767'),
      cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1', minimumVersion: '0.8.0-beta.1' },
    source: { canonicalHome: '/fixture/canonical', canonicalConfigSha256: sha256('config'), codexLaunchArgv: ['/opt/codex'], codexVersion: '1.0.0' },
    artifacts, providers: buildManifestProviders(providers), committedAt: '2026-09-09T09:00:00.000Z',
  }, { roomHome: '/fixture/room' });
  return {
    intent: { command, apply: false }, desired: { artifacts, providers },
    current: { paths: artifacts.map(item => ({ path: item.path, occupancy: first ? 'absent' : 'occupied' })), 
      ...first ? {} : { owned: { manifest, observation: { artifacts: artifacts.map(item => ({ path: item.path, state: 'unchanged' as const })),
        providers: MANAGED_PROVIDER_IDS.map(id => ({ id, state: 'unchanged' as const })), drift: [] } } },
      paseo: { mode: 'live', admission: 'pass', providers: first ? {} : providers, activeSessions: [],
        readiness: Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, 'ready' as const])) }, unfinishedJournal: false },
  };
}
function artifactState(input: PlannerInput, item: ManifestArtifact, state: OwnershipState | undefined): PlannerInput {
  const owned = input.current.owned;
  if (!owned) throw new Error('fixture requires ownership');
  return { ...input, current: { ...input.current, owned: { ...owned, observation: { ...owned.observation,
    artifacts: owned.observation.artifacts.filter(observation => observation.path !== item.path).concat(state ? [{ path: item.path, state }] : []),
  } } } };
}
function changed(item: ManifestArtifact): ManifestArtifact {
  return item.kind === 'file' ? { ...item, sha256: sha256('new') } : item.kind === 'symlink' ? { ...item, target: '/fixture/canonical/plugins' } : item;
}
const states = ['unchanged', 'customized', 'missing', 'wrong-type', 'unsafe', undefined] as const;
function result(input: PlannerInput) {
  const before = JSON.stringify(input);
  const planned = planLifecycle(input);
  expect(commandResultSchema.safeParse(planned).success).toBe(true);
  expect(planned.changed).toBe(false);
  expect(renderJson(planLifecycle(input))).toBe(renderJson(planned));
  expect(JSON.stringify(input)).toBe(before);
  return planned;
}

describe('artifact ownership decision table', () => {
  for (const item of artifacts) {
    it.each(['absent', 'occupied', 'unsafe', 'not-checked', undefined] as const)(`first install ${item.kind} ${item.path}: %s`, occupancy => {
      const input = fixture('install', true);
      const paths = input.current.paths.filter(fact => fact.path !== item.path);
      if (occupancy) paths.push({ path: item.path, occupancy, current: item });
      const planned = result({ ...input, current: { ...input.current, paths } });
      expect(planned.outcome).toBe(occupancy === 'absent' ? 'changes-planned' : 'conflict');
      expect(planned.operations.length).toBe(occupancy === 'absent' ? 7 : 0);
    });
    for (const command of ['install', 'uninstall', 'verify', 'doctor'] as const) {
      it.each(states)(`${command} ${item.kind} ${item.path}: %s`, state => {
        const planned = result(artifactState(fixture(command), item, state));
        const good = state === 'unchanged' || command === 'uninstall' && state === 'missing';
        expect(planned.outcome).toBe(good ? command === 'uninstall' ? 'changes-planned' : 'ok' : command === 'verify' || command === 'doctor' ? 'failed' : 'conflict');
        const operation = planned.operations.find(op => op.target.kind !== 'provider' && op.target.path === item.path);
        expect(operation?.action).toBe(command === 'uninstall' && state === 'unchanged' ? 'remove' : undefined);
        if (command === 'verify' || command === 'doctor') expect(planned.operations).toEqual([]);
        if (!good) {
          const check = planned.checks.find(check => check.id === `artifact.${item.kind}:${item.path}`);
          expect(check?.status).toBe('fail');
          expect(check?.message).toContain(state ?? 'not-checked');
        }
      });
    }
    if (item.kind !== 'directory') {
      it(`updates unchanged ${item.kind}, retains current-equals-desired, rejects unsafe equality`, () => {
        const input = fixture();
        const desired = { ...input.desired, artifacts: artifacts.map(value => value.path === item.path ? changed(value) : value) };
        expect(result({ ...input, desired }).operations).toEqual([{ action: 'update', target: { kind: item.kind, path: item.path }, description: `Update managed ${item.kind}.` }]);
        const current = { ...input.current, paths: input.current.paths.map(fact => fact.path === item.path ? { ...fact, current: changed(item) } : fact) };
        expect(result(artifactState({ ...input, desired, current }, item, 'customized')).outcome).toBe('ok');
        for (const state of ['missing', 'wrong-type', 'unsafe'] as const) expect(result(artifactState({ ...input, desired, current }, item, state)).outcome).toBe('conflict');
        expect(result(artifactState({ ...input, desired }, item, 'customized')).outcome).toBe('conflict');
      });
    }
  }
});

describe('provider ownership decision table', () => {
  for (const id of MANAGED_PROVIDER_IDS) {
    it(`never adopts ${id}, even an exact desired match`, () => {
      const input = fixture('install', true);
      if (input.current.paseo.mode !== 'live') throw new Error('live fixture');
      for (const entry of [input.desired.providers[id], {}, null, { unexpected: true }]) {
        expect(result({ ...input, current: { ...input.current, paseo: { ...input.current.paseo, providers: { [id]: entry } } } }).outcome).toBe('conflict');
      }
    });
    for (const command of ['install', 'uninstall', 'verify', 'doctor'] as const) {
      it.each(['unchanged', 'customized', 'missing', undefined] as const)(`${command} ${id}: %s`, state => {
        const input = fixture(command);
        const { owned, paseo } = input.current;
        if (!owned || paseo.mode !== 'live') throw new Error('owned fixture');
        const providers = Object.fromEntries(Object.entries(paseo.providers).filter(([key]) => state !== 'missing' || key !== id));
        if (state === 'customized') providers[id] = { ...input.desired.providers[id], extra: true };
        const planned = result({ ...input, current: { ...input.current, paseo: { ...paseo, providers }, owned: { ...owned, observation: { ...owned.observation,
          providers: owned.observation.providers.filter(item => item.id !== id).concat(state ? [{ id, state }] : []),
        } } } });
        const good = state === 'unchanged' || command === 'uninstall' && state === 'missing';
        expect(planned.outcome).toBe(good ? command === 'uninstall' ? 'changes-planned' : 'ok' : command === 'install' || command === 'uninstall' ? 'conflict' : 'failed');
        expect(planned.operations.find(op => op.target.kind === 'provider' && op.target.id === id)?.action).toBe(command === 'uninstall' && state === 'unchanged' ? 'remove' : undefined);
      });
    }
    it(`updates ${id} and retains ownership of desired equality`, () => {
      const input = fixture();
      const { owned, paseo } = input.current;
      if (!owned || paseo.mode !== 'live') throw new Error('owned fixture');
      const next = { ...policyFixture()[id], command: ['/opt/new-codex'] as [string] };
      const desired = { ...input.desired, providers: { ...input.desired.providers, [id]: next } };
      expect(result({ ...input, desired }).operations.map(op => op.action)).toEqual(['update']);
      expect(result({ ...input, desired, current: { ...input.current, paseo: { ...paseo, providers: { ...paseo.providers, [id]: next } },
        owned: { ...owned, observation: { ...owned.observation, providers: owned.observation.providers.map(item => item.id === id ? { id, state: 'customized' } : item) } },
      } }).outcome).toBe('ok');
    });
  }
});

it('residual uninstall considers only unresolved ownership and later discharges missing items', () => {
  const input = fixture('uninstall');
  const owned = input.current.owned;
  if (!owned) throw new Error('owned fixture');
  const item = artifacts[2];
  if (!item) throw new Error('file fixture');
  const residual = { ...input, current: { ...input.current, owned: { ...owned, manifest: { ...owned.manifest, status: 'uninstall-incomplete' as const, artifacts: [item], providers: {} } } } };
  expect(result(artifactState(residual, item, 'customized')).operations).toEqual([]);
  expect(result(artifactState(residual, item, 'customized')).outcome).toBe('conflict');
  expect(result(artifactState(residual, item, 'missing')).outcome).toBe('ok');
  expect(result(artifactState(residual, item, 'unchanged')).operations).toHaveLength(1);
  expect(result({ ...residual, intent: { command: 'install', apply: true } }).outcome).toBe('failed');
  for (const command of ['verify', 'doctor'] as const) {
    const inspected = result({ ...residual, intent: { command, apply: false } });
    expect(inspected.outcome).toBe('failed');
    expect(inspected.operations).toEqual([]);
    expect(inspected.checks).toContainEqual(expect.objectContaining({ id: 'manifest.residual', status: 'fail' }));
  }
});

it.each(['install', 'plan', 'uninstall', 'verify', 'doctor', 'recover'] as const)('journal blocks normal %s planning', command => {
  const input = fixture(command);
  const planned = result({ ...input, current: { ...input.current, unfinishedJournal: true } });
  expect(planned.outcome).toBe(command === 'verify' || command === 'doctor' ? 'ok' : 'recovery-required');
  expect(planned.operations).toEqual([]);
  expect(planned.checks).toContainEqual(expect.objectContaining({ id: 'journal.unfinished' }));
});
it.each(['install', 'plan', 'uninstall', 'verify', 'doctor'] as const)('offline %s never claims live proof or apply readiness', command => {
  const input = fixture(command);
  const planned = result({ ...input, current: { ...input.current, paseo: { mode: 'offline' } } });
  expect(planned.outcome).toBe('failed');
  expect(planned.operations).toEqual([]);
  expect(planned.checks.filter(check => check.id.startsWith('provider.')).every(check => check.status === 'not-checked')).toBe(true);
});
it.each(['adapter', 'source.canonicalHome', 'paseo.localHome', 'paseo.listen', 'paseo.endpointIdentitySha256', 'paseo.endpointBinding', 'paseo.cliVersion', 'paseo.daemonVersion'])('binding drift %s blocks mutation', field => {
  const input = fixture('uninstall');
  const owned = input.current.owned;
  if (!owned) throw new Error('owned fixture');
  const planned = result({ ...input, current: { ...input.current, owned: { ...owned, observation: { ...owned.observation, drift: [field] } } } });
  expect(planned.outcome).toBe('failed');
  expect(planned.operations).toEqual([]);
  expect(planned.checks).toContainEqual(expect.objectContaining({ id: `drift.${field}`, status: 'fail' }));
});
it.each(['packageVersion', 'source.canonicalConfigSha256', 'source.codexVersion', 'source.codexLaunchArgv'])('regeneration drift %s is explicit; verification reports stale source', field => {
  const input = fixture();
  const owned = input.current.owned;
  if (!owned) throw new Error('owned fixture');
  const drifted = { ...input, current: { ...input.current, owned: { ...owned, observation: { ...owned.observation, drift: [field, field] } } } };
  expect(result(drifted).checks).toContainEqual(expect.objectContaining({ id: `drift.${field}`, status: 'warn' }));
  expect(result({ ...drifted, intent: { command: 'verify', apply: false } }).outcome).toBe('failed');
});
it('blocks missing admission/session/readiness evidence, ignores unrelated sessions', () => {
  const input = fixture('uninstall');
  const paseo = input.current.paseo;
  if (paseo.mode !== 'live') throw new Error('live fixture');
  for (const facts of [{ ...paseo, admission: 'fail' as const }, { ...paseo, activeSessions: 'not-checked' as const },
    ...MANAGED_PROVIDER_IDS.map(providerId => ({ ...paseo, activeSessions: [{ providerId }] }))]) {
    expect(result({ ...input, current: { ...input.current, paseo: facts } }).operations).toEqual([]);
    expect(result({ ...input, current: { ...input.current, paseo: facts } }).outcome).toBe('failed');
  }
  expect(result({ ...input, current: { ...input.current, paseo: { ...paseo, activeSessions: [{ providerId: 'unrelated' }] } } }).outcome).toBe('changes-planned');
  for (const readiness of ['not-checked' as const, {}, { 'codex-peer': 'not-ready' as const }]) {
    expect(result({ ...input, intent: { command: 'verify', apply: false }, current: { ...input.current, paseo: { ...paseo, readiness } } }).outcome).toBe('failed');
  }
});
it('no ownership means no uninstall/verification targets; recover execution is excluded', () => {
  for (const command of ['verify', 'doctor', 'uninstall', 'recover'] as const) {
    const planned = result(fixture(command, true));
    expect(planned.outcome).toBe('failed');
    expect(planned.operations).toEqual([]);
  }
});
it('orders dependency publication/removal and fixed-ID conceptual provider sets', () => {
  const keys = (input: PlannerInput) => result(input).operations.map(op => op.target.kind === 'provider' ? op.target.id : op.target.path);
  expect(keys(fixture('install', true))).toEqual(['/fixture/room', '/fixture/room/nested', '/fixture/room/nested/file', '/fixture/room/link', ...MANAGED_PROVIDER_IDS]);
  expect(keys(fixture('uninstall'))).toEqual([...MANAGED_PROVIDER_IDS, '/fixture/room/nested/file', '/fixture/room/link', '/fixture/room/nested', '/fixture/room']);
  expect(result(fixture('uninstall')).operations.filter(op => op.target.kind === 'directory').every(op => op.description.includes('only if empty'))).toBe(true);
});

it('seeded unrelated-state and permutation properties preserve inputs, schemas, idempotency and render bytes', () => {
  let seed = 421;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  function shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = copy[i]; const b = copy[j];
      if (a !== undefined && b !== undefined) { copy[i] = b; copy[j] = a; }
    }
    return copy;
  }
  for (let iteration = 0; iteration < 80; iteration++) {
    for (const command of ['install', 'uninstall', 'verify'] as const) {
      const input = fixture(command);
      const { owned, paseo } = input.current;
      if (!owned || paseo.mode !== 'live') throw new Error('owned fixture');
      const unrelated: PlannerPathFact[] = Array.from({ length: 12 }, (_, i) => ({ path: `/fixture/room/runtime/${String(iteration)}-${String(i)}`, occupancy: random() < 0.5 ? 'occupied' : 'unsafe' }));
      const providers = Object.fromEntries(shuffle([...Object.entries(paseo.providers), ...unrelated.map(item => [item.path, { random: random(), nested: ['preserve'] }] as const)]));
      const permuted: PlannerInput = { ...input, desired: { artifacts: shuffle([...input.desired.artifacts, { kind: 'file', path: '/unowned', mode: 0o600, sha256: sha256('unrelated') }]), providers: input.desired.providers },
        current: { ...input.current, paths: shuffle([...input.current.paths, ...unrelated]), paseo: { ...paseo, providers }, owned: {
          manifest: { ...owned.manifest, artifacts: shuffle(owned.manifest.artifacts) },
          observation: { ...owned.observation, artifacts: shuffle([...owned.observation.artifacts, ...unrelated.map(item => ({ path: item.path, state: 'customized' as const }))]), providers: shuffle(owned.observation.providers) },
        } } };
      expect(renderJson(result(permuted))).toBe(renderJson(result(input)));
      if (command === 'install') expect(result(permuted).operations).toEqual([]);
    }
    const first = fixture('install', true);
    expect(renderJson(result({ ...first, desired: { ...first.desired, artifacts: shuffle(first.desired.artifacts) }, current: { ...first.current, paths: shuffle(first.current.paths) } }))).toBe(renderJson(result(first)));
  }
});
it('planner creates no filesystem, daemon, temporary, lock or cache state in disposable homes', () => {
  const root = mkdtempSync(join(tmpdir(), 'paseo-room-pq3-'));
  try {
    for (const directory of ['home', 'daemon', 'tmp', 'cache']) mkdirSync(join(root, directory));
    writeFileSync(join(root, 'home', 'mutable'), 'preserve');
    writeFileSync(join(root, 'daemon', 'config.json'), '{"unrelated":true}');
    symlinkSync('mutable', join(root, 'home', 'link'));
    const before = snapshotFixture(root);
    for (const command of ['plan', 'install', 'uninstall', 'verify', 'doctor', 'recover'] as const) {
      const input = fixture(command);
      for (const offline of [true, false]) {
        result({ ...input, current: { ...input.current, paths: [{ path: join(root, 'home', 'mutable'), occupancy: 'occupied' }, ...input.current.paths], paseo: offline ? { mode: 'offline' } : input.current.paseo } });
        expect(snapshotFixture(root)).toEqual(before);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects declaration omissions, type changes and duplicates without deleting or adopting', () => {
  const input = fixture();
  const file = artifacts[2];
  if (!file) throw new Error('file fixture');
  for (const desired of [
    { ...input.desired, artifacts: artifacts.filter(item => item.path !== file.path) },
    { ...input.desired, artifacts: artifacts.map(item => item.path === file.path ? { kind: 'directory' as const, path: item.path, mode: 0o700 as const } : item) },
    { ...input.desired, artifacts: [...artifacts, file] },
    { ...input.desired, providers: {} },
  ]) {
    const planned = result({ ...input, desired });
    expect(planned.outcome).toBe('conflict');
    expect(planned.operations).toEqual([]);
    expect(new Set(planned.checks.map(check => check.id)).size).toBe(planned.checks.length);
  }
  const first = fixture('install', true);
  expect(result({ ...first, desired: { ...first.desired, artifacts: [...artifacts, file] } }).outcome).toBe('failed');
  expect(result({ ...first, current: { ...first.current, paths: [...first.current.paths, { path: file.path, occupancy: 'absent' }] } }).outcome).toBe('conflict');
});
it('partial uninstall preserves customized items but keeps independent safe removals', () => {
  const file = artifacts[2];
  if (!file) throw new Error('file fixture');
  const planned = result(artifactState(fixture('uninstall'), file, 'customized'));
  expect(planned.outcome).toBe('conflict');
  expect(planned.operations).toHaveLength(6);
  expect(planned.operations.every(op => op.action === 'remove')).toBe(true);
  expect(planned.operations.some(op => op.target.kind !== 'provider' && op.target.path === file.path)).toBe(false);
});
it('only metadata enters results; desired/current provider values and link targets never leak', () => {
  const input = fixture();
  const desired = { ...input.desired, providers: { ...input.desired.providers,
    'codex-peer': { ...policyFixture()['codex-peer'], command: ['/private/launch-value'] as [string] },
  }, artifacts: input.desired.artifacts.map(item => item.kind === 'symlink' ? { ...item, target: '/private/link-value' } : item) };
  const rendered = renderJson(result({ ...input, desired }));
  for (const value of ['/private/launch-value', '/private/link-value', 'CODEX_HOME', 'sha256', 'paseoTools']) expect(rendered).not.toContain(value);
});
it('plans actual disposable-home destinations without publishing, staging, locking or caching', () => {
  const root = mkdtempSync(join(tmpdir(), 'paseo-room-pq3-destinations-'));
  try {
    const input = fixture('install', true);
    const desired = { ...input.desired, artifacts: input.desired.artifacts.map(item => ({ ...item, path: item.path.replace('/fixture/room', join(root, 'room')) })) };
    const current = { ...input.current, paths: desired.artifacts.map(item => ({ path: item.path, occupancy: 'absent' as const })) };
    const before = snapshotFixture(root);
    for (const apply of [true, false]) {
      for (const offline of [true, false]) {
        const planned = result({ ...input, intent: { command: 'install', apply }, desired, current: { ...current, paseo: offline ? { mode: 'offline' } : current.paseo } });
        expect(planned.outcome).toBe(offline ? 'failed' : 'changes-planned');
        expect(snapshotFixture(root)).toEqual(before);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('first install requires all fixed provider declarations and checks occupancy even if a declaration is missing', () => {
  const input = fixture('install', true);
  const paseo = input.current.paseo;
  if (paseo.mode !== 'live') throw new Error('live fixture');
  const desired = { ...input.desired, providers: {} };
  expect(result({ ...input, desired }).outcome).toBe('failed');
  expect(result({ ...input, desired, current: { ...input.current, paseo: { ...paseo, providers: policyFixture() } } }).outcome).toBe('conflict');
});
