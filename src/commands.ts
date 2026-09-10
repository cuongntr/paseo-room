import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import metadata from '../package.json' with { type: 'json' };
import { claudeAgent } from './agents/claude.js';
import { codexAgent } from './agents/codex.js';
import type { Agent, Profile, Provider } from './agents/types.js';
import { applyEntries, exists, planEntries, type Entry } from './fsops.js';
import { layoutChecks, resolveLayout, roleHome, sharedRoom, type Layout, type Options } from './layout.js';
import { checkDaemon, mergeProfiles, profileMatches, providerMatches, withSession, type ClientFactory, type LiveProfile, type Session } from './paseo.js';
import { fail, failed, hasFailure, pass, type Check, type Operation, type Result } from './result.js';
import { renderInstructions } from './room/instructions.js';
import { MARKER, readMarker, renderMarker, type Marker } from './room.js';
import { profileId, providerId, providerLabel, ROLES, ROLE_NOTES, ROLE_PASEO_TOOLS, ROLE_THINKING, type AgentId, type Role } from './roles.js';

export const AGENTS: Record<AgentId, Agent> = { codex: codexAgent, claude: claudeAgent };

export interface RunOptions extends Options {
  readonly agents?: readonly AgentId[];
  readonly apply?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factory?: ClientFactory;
}

function sessionOptions(options: RunOptions): { password?: string; factory?: ClientFactory } {
  const password = (options.env ?? process.env).PASEO_PASSWORD;
  return { ...(password === undefined ? {} : { password }), ...(options.factory ? { factory: options.factory } : {}) };
}

/** The only per-agent differences are the home variable and the provider pins. */
function roleProviders(layout: Layout, agent: Agent, binary: string, roles: readonly Role[]): Record<string, Provider> {
  return Object.fromEntries(roles.map(role => [providerId(agent.id, role), {
    extends: agent.id,
    label: providerLabel(agent.id, role),
    command: [binary],
    env: { [agent.homeEnv]: roleHome(layout, agent.id, role) },
    paseoTools: { enabled: ROLE_PASEO_TOOLS[role] },
    ...agent.pins,
  }]));
}

/** The picker preset that points at a provider, so a seat is one click rather than four. */
function roleProfiles(agent: Agent, roles: readonly Role[]): Profile[] {
  return roles.map(role => ({
    id: profileId(agent.id, role),
    name: providerLabel(agent.id, role),
    provider: providerId(agent.id, role),
    thinkingOptionId: ROLE_THINKING[role],
    notes: ROLE_NOTES[role],
  }));
}

interface Desired {
  readonly entries: readonly Entry[];
  readonly providers: Readonly<Record<string, Provider>>;
  readonly profiles: readonly Profile[];
  readonly checks: readonly Check[];
}
async function buildDesired(layout: Layout, agents: readonly AgentId[], roles: readonly Role[]): Promise<Desired> {
  // Template, not linked into any seat: each repo owns its own docs/WORKSPACE_PROTOCOL.md.
  // Named exactly as RC-002 names it, so a copy needs no rename.
  const entries: Entry[] = [
    { kind: 'dir', path: layout.roomHome },
    { kind: 'dir', path: sharedRoom(layout) },
    { kind: 'file', path: join(sharedRoom(layout), 'WORKSPACE_PROTOCOL.md'), content: renderInstructions('workspace') },
  ];
  const providers: Record<string, Provider> = {};
  const profiles: Profile[] = [];
  const checks: Check[] = [];
  for (const id of agents) {
    const agent = AGENTS[id];
    const plan = await agent.build(layout, roles);
    entries.push(...plan.entries);
    checks.push(...plan.checks);
    if (plan.binary === undefined) continue;
    Object.assign(providers, roleProviders(layout, agent, plan.binary, roles));
    profiles.push(...roleProfiles(agent, roles));
  }
  entries.push({ kind: 'file', path: join(layout.roomHome, MARKER), content: renderMarker(metadata.version, agents, roles) });
  return { entries, providers, profiles, checks };
}

interface Stale {
  readonly providerIds: readonly string[];
  readonly profileIds: readonly string[];
  readonly directories: readonly string[];
}
const NOTHING_STALE: Stale = { providerIds: [], profileIds: [], directories: [] };

/** A previous setup may have seated agents or roles this one does not: drop those. */
async function staleFrom(layout: Layout, previous: Marker | undefined, agents: readonly AgentId[], roles: readonly Role[]): Promise<Stale> {
  if (!previous) return NOTHING_STALE;
  const kept = new Set(agents.flatMap(agent => roles.map(role => providerId(agent, role))));
  const providerIds: string[] = [];
  const profileIds: string[] = [];
  const directories: string[] = [];
  for (const agent of previous.agents) {
    for (const role of previous.roles) {
      if (kept.has(providerId(agent, role))) continue;
      providerIds.push(providerId(agent, role));
      profileIds.push(profileId(agent, role));
      const path = roleHome(layout, agent, role);
      if (await exists(path)) directories.push(path);
    }
  }
  return { providerIds, profileIds, directories };
}

interface Plan {
  readonly operations: readonly Operation[];
  /** Carried out of the plan so apply rewrites the array it actually compared against. */
  readonly liveProfiles: readonly LiveProfile[];
}

/** One definition of drift, shared by the command that fixes it and the one that reports it. */
async function planRoom(session: Session, desired: Desired, stale: Stale): Promise<Plan> {
  const live = await session.readProviders();
  const liveProfiles = await session.readProfiles();
  const byId = new Map(liveProfiles.map(entry => [String(entry.id), entry]));
  return {
    liveProfiles,
    operations: [
      ...await planEntries(desired.entries),
      ...Object.entries(desired.providers).map(([id, provider]) => ({
        action: !(id in live) ? 'create' : providerMatches(provider, live[id]) ? 'noop' : 'update',
        kind: 'provider',
        target: id,
      }) satisfies Operation),
      ...desired.profiles.map(profile => ({
        action: !byId.has(profile.id) ? 'create' : profileMatches(profile, byId.get(profile.id)) ? 'noop' : 'update',
        kind: 'profile',
        target: profile.id,
      }) satisfies Operation),
      ...stale.providerIds.filter(id => id in live).map(id => ({ action: 'remove', kind: 'provider', target: id }) satisfies Operation),
      ...stale.profileIds.filter(id => byId.has(id)).map(id => ({ action: 'remove', kind: 'profile', target: id }) satisfies Operation),
      ...stale.directories.map(path => ({ action: 'remove', kind: 'dir', target: path }) satisfies Operation),
    ],
  };
}

/** The whole product: write the role homes, then register them with Paseo. */
export async function setup(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const agents = options.agents ?? ['codex'];
  const invalid = layoutChecks(layout, agents);
  if (invalid.length > 0) return failed('setup', invalid);
  const daemon = await checkDaemon(layout, options.env);
  if (!daemon.daemon) return failed('setup', daemon.checks);
  const desired = await buildDesired(layout, agents, ROLES);
  const checks = [...daemon.checks, ...desired.checks];
  if (hasFailure(checks)) return failed('setup', checks);
  const stale = await staleFrom(layout, await readMarker(layout), agents, ROLES);

  return withSession(daemon.daemon, async session => {
    const { operations, liveProfiles } = await planRoom(session, desired, stale);
    const pending = operations.filter(operation => operation.action !== 'noop');
    if (!options.apply) {
      return {
        command: 'setup', outcome: pending.length > 0 ? 'changes-planned' : 'ok', changed: false, checks, operations,
      } satisfies Result;
    }
    await applyEntries(desired.entries);
    for (const path of stale.directories) await rm(path, { recursive: true, force: true });
    const ids = Object.keys(desired.providers);
    await session.writeProviders(desired.providers);
    if (stale.providerIds.length > 0) await session.removeProviders(stale.providerIds);
    // Profiles point at providers, so they are written once the providers exist — and
    // only when something changed, since one write replaces the host's whole array.
    if (pending.some(operation => operation.kind === 'profile')) {
      await session.writeProfiles(mergeProfiles(liveProfiles, desired.profiles, stale.profileIds));
    }
    await session.refresh(ids);
    return {
      command: 'setup', outcome: 'ok', changed: pending.length > 0,
      checks: [...checks, pass('room.applied', `Room ready at ${layout.roomHome} with ${String(ids.length)} Paseo providers.`)],
      operations,
    } satisfies Result;
  }, sessionOptions(options));
}

export async function verify(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const marker = await readMarker(layout);
  if (!marker) {
    return failed('verify', [fail('room.marker', `No room found at ${layout.roomHome}.`, 'Run: paseo-room setup --apply')]);
  }
  const invalid = layoutChecks(layout, marker.agents);
  if (invalid.length > 0) return failed('verify', invalid);
  const daemon = await checkDaemon(layout, options.env);
  if (!daemon.daemon) return failed('verify', daemon.checks);
  const desired = await buildDesired(layout, marker.agents, marker.roles);
  const checks = [...daemon.checks, ...desired.checks];
  if (hasFailure(checks)) return failed('verify', checks);

  return withSession(daemon.daemon, async session => {
    const { operations } = await planRoom(session, desired, NOTHING_STALE);
    const drifted = operations.filter(operation => operation.action !== 'noop');
    const count = (kind: Operation['kind']): number => drifted.filter(operation => operation.kind === kind).length;
    const providers = count('provider');
    const profiles = count('profile');
    const files = drifted.length - providers - profiles;
    const all: Check[] = [...checks,
      files === 0
        ? pass('room.files', 'Every managed role file matches the current definition.')
        : fail('room.files', `${String(files)} managed role files are missing or outdated.`, 'Run: paseo-room setup --apply'),
      providers === 0
        ? pass('room.providers', `All ${String(Object.keys(desired.providers).length)} Paseo providers are registered as expected.`)
        : fail('room.providers', `${String(providers)} Paseo providers are missing or differ.`, 'Run: paseo-room setup --apply'),
      profiles === 0
        ? pass('room.profiles', `All ${String(desired.profiles.length)} Paseo agent profiles are registered as expected.`)
        : fail('room.profiles', `${String(profiles)} Paseo agent profiles are missing or differ.`, 'Run: paseo-room setup --apply'),
    ];
    return {
      command: 'verify', outcome: hasFailure(all) ? 'failed' : 'ok', changed: false, checks: all, operations,
    } satisfies Result;
  }, sessionOptions(options));
}

export async function remove(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const marker = await readMarker(layout);
  if (!marker) {
    return failed('remove', [fail('room.marker', `No room found at ${layout.roomHome}.`, 'Nothing to remove; the room home was never created here.')]);
  }
  // A recursive delete needs a floor, so the layout rules gate this command too.
  const invalid = layoutChecks(layout, marker.agents);
  if (invalid.length > 0) return failed('remove', invalid);
  const ids = marker.agents.flatMap(agent => marker.roles.map(role => providerId(agent, role)));
  const profiles = new Set(marker.agents.flatMap(agent => marker.roles.map(role => profileId(agent, role))));
  const operations: Operation[] = [
    ...ids.map(id => ({ action: 'remove', kind: 'provider', target: id }) satisfies Operation),
    ...[...profiles].map(id => ({ action: 'remove', kind: 'profile', target: id }) satisfies Operation),
    { action: 'remove', kind: 'dir', target: layout.roomHome },
  ];
  if (!options.apply) {
    return { command: 'remove', outcome: 'changes-planned', changed: false, checks: [], operations };
  }
  const daemon = await checkDaemon(layout, options.env);
  const checks: Check[] = [];
  if (daemon.daemon) {
    await withSession(daemon.daemon, async session => {
      await session.removeProviders(ids);
      const live = await session.readProfiles();
      const kept = live.filter(entry => !profiles.has(String(entry.id)));
      if (kept.length !== live.length) await session.writeProfiles(kept);
    }, sessionOptions(options));
    checks.push(pass('room.providers', `Removed ${String(ids.length)} Paseo providers and their agent profiles.`));
  } else {
    checks.push({ id: 'room.providers', status: 'warn', message: 'Paseo is unreachable; provider and profile entries were left in place.', fix: 'Start Paseo and run remove again to clear them.' });
  }
  // Only the room home is deleted; agent homes were never written to.
  await rm(layout.roomHome, { recursive: true, force: true });
  checks.push(pass('room.files', `Deleted ${layout.roomHome}.`));
  return { command: 'remove', outcome: 'ok', changed: true, checks, operations };
}
