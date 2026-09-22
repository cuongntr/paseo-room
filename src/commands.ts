import { join, sep } from 'node:path';
import { lstat, rm } from 'node:fs/promises';
import { satisfies } from 'semver';
import metadata from '../package.json' with { type: 'json' };
import { claudeAgent } from './agents/claude.js';
import { codexAgent } from './agents/codex.js';
import { piAgent } from './agents/pi.js';
import type { Agent, AgentPlan, BuildOptions, Profile, Provider } from './agents/types.js';
import { AUTHENTICATION_GUIDE, renderAuthenticationGuide } from './auth.js';
import { applyEntries, exists, planEntries, type Entry } from './fsops.js';
import { layoutChecks, resolveLayout, roleHome, sharedRoom, type Layout, type Options } from './layout.js';
import { checkDaemon, mergeProfiles, minimumPaseoVersion, profileMatches, providerMatches, withSession, type ClientFactory, type LivePlugin, type LiveProfile, type Session } from './paseo.js';
import { CLAUDE_CARRIER_PASEO_RANGE, CLAUDE_CARRIER_PLUGIN_ID, claudeCarrierEntries, claudeCarrierPluginDir } from './plugin.js';
import { fail, failed, hasFailure, pass, warn, type Check, type Operation, type Result } from './result.js';
import { contractDigest } from './room/instructions.js';
import {
  agentSkillProjectionRoot, leadSkillProjection, roomSkillEntries, roomSkillSource, skillProjectionRoot,
} from './room/skills.js';
import { MARKER, readMarker, renderMarker, type Marker, type RuntimeMarker } from './room.js';
import {
  renderRuntimeManifest, RUNTIME_PASEO_RANGE, RUNTIME_PLUGIN_ID, runtimePluginDir, runtimePluginEntries,
} from './runtime.js';
import { describeBlockers, inspectRuntimeState } from './runtime-state.js';
import { DELEGATING_THINKING, profileId, providerId, providerLabel, ROLES, ROLE_COLOR, ROLE_ICON, ROLE_NOTES, ROLE_PASEO_TOOLS, ROLE_THINKING, type AgentId, type Role } from './roles.js';

export const AGENTS: Record<AgentId, Agent> = { codex: codexAgent, claude: claudeAgent, pi: piAgent };

export interface RunOptions extends Options {
  readonly agents?: readonly AgentId[];
  readonly apply?: boolean;
  /**
   * Write the role contract into Claude's `CLAUDE.md` as well as the plugin. Defaults to true:
   * the plugin is the strong carrier, but whether a resumed session re-enters its creation hook
   * is unproven, so the file fallback is only dropped when asked for.
   */
  readonly claudeMemoryContract?: boolean;
  /** Opt in to runtime coordination (preview). A per-run setup choice, recorded in the marker. */
  readonly runtime?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly factory?: ClientFactory;
}

function sessionOptions(options: RunOptions): { password?: string; factory?: ClientFactory } {
  const password = (options.env ?? process.env).PASEO_PASSWORD;
  return { ...(password === undefined ? {} : { password }), ...(options.factory ? { factory: options.factory } : {}) };
}

/** The only per-agent differences are the home variable and the provider pins. */
function roleProviders(
  layout: Layout,
  agent: Agent,
  plan: { readonly binary: string; readonly argv?: AgentPlan['argv']; readonly providerEnv?: AgentPlan['providerEnv'] },
  roles: readonly Role[],
): Record<string, Provider> {
  return Object.fromEntries(roles.map(role => [providerId(agent.id, role), {
    extends: agent.id,
    label: providerLabel(agent.id, role),
    command: [plan.binary, ...(plan.argv?.[role] ?? [])],
    env: { ...agent.providerEnv, ...plan.providerEnv?.[role], [agent.homeEnv]: roleHome(layout, agent.id, role) },
    paseoTools: { enabled: ROLE_PASEO_TOOLS[role] },
    ...agent.pins,
  }]));
}

/** The picker preset that points at a provider, so a seat is one click rather than four. */
function roleProfiles(agent: Agent, roles: readonly Role[]): Profile[] {
  return roles.map(role => ({
    id: profileId(agent.id, role),
    name: providerLabel(agent.id, role),
    icon: ROLE_ICON[role],
    color: ROLE_COLOR[role],
    provider: providerId(agent.id, role),
    ...(agent.defaultModeId === undefined ? {} : { modeId: agent.defaultModeId }),
    thinkingOptionId: ROLE_THINKING[role],
    notes: ROLE_NOTES[role],
  }));
}

/**
 * A trusted Paseo plugin the room owns. The Claude carrier and the runtime are separate
 * plugins with separate ids, paths and diagnostics, so a fault in one never names or touches the
 * other (docs/design/runtime-coordination.md D1).
 */
interface PluginSpec {
  readonly id: string;
  readonly path: string;
  /** Check id prefix: `<prefix>.enabled`, `<prefix>.path`, `<prefix>.runtime`. */
  readonly check: string;
  readonly running: string;
  readonly enabledPass: string;
  readonly enabledFail: string;
  /**
   * The manifest's `requirements.paseo`. Paseo refuses to install a plugin outside it, so the
   * room states the same bound as its own check rather than letting `--apply` surface the
   * daemon's error. Its id is explicit because the two plugins were named independently.
   */
  readonly paseoRange: string;
  readonly rangeCheck: string;
  readonly rangeRemedy: string;
}

function carrierSpec(layout: Layout): PluginSpec {
  return {
    id: CLAUDE_CARRIER_PLUGIN_ID, path: claudeCarrierPluginDir(layout), check: 'claude.plugin',
    running: 'Claude contract carrier plugin',
    enabledPass: 'Paseo plugins are enabled for the required Claude contract carrier.',
    enabledFail: 'Claude rooms require the paseo-room trusted server plugin, but Paseo plugins are disabled. Plugins are trusted, unsandboxed code with access to the daemon machine.',
    paseoRange: CLAUDE_CARRIER_PASEO_RANGE, rangeCheck: 'claude.paseo-range',
    rangeRemedy: 'Use a Paseo release inside that range, or upgrade paseo-room, then run setup again.',
  };
}

function runtimeSpec(layout: Layout): PluginSpec {
  return {
    id: RUNTIME_PLUGIN_ID, path: runtimePluginDir(layout), check: 'runtime.plugin',
    running: 'Runtime coordination plugin (preview)',
    enabledPass: 'Paseo plugins are enabled for the runtime coordination plugin.',
    enabledFail: 'Runtime coordination is a trusted server plugin, but Paseo plugins are disabled. Plugins are trusted, unsandboxed code with access to the daemon machine.',
    paseoRange: RUNTIME_PASEO_RANGE, rangeCheck: 'runtime.paseo-range',
    rangeRemedy: 'Use a Paseo release inside that range, or run setup without --runtime.',
  };
}

interface Desired {
  readonly entries: readonly Entry[];
  readonly providers: Readonly<Record<string, Provider>>;
  readonly profiles: readonly Profile[];
  readonly checks: readonly Check[];
  /** Room plugins this selection requires, carrier first. */
  readonly plugins: readonly PluginSpec[];
  readonly runtime?: RuntimeMarker;
}
async function buildDesired(
  layout: Layout,
  agents: readonly AgentId[],
  roles: readonly Role[],
  build: BuildOptions & { readonly runtime?: boolean } = {},
): Promise<Desired> {
  // The room-owned skill source is composed once here rather than per adapter, so three
  // seated agents cannot declare the same managed paths three times.
  const entries: Entry[] = [
    { kind: 'dir', path: layout.roomHome },
    { kind: 'dir', path: sharedRoom(layout) },
    // Earlier versions generated a default workspace protocol template here. The room ships no
    // default protocol now, so the old generated regular file is declared absent and removed.
    { kind: 'absent', path: join(sharedRoom(layout), 'WORKSPACE_PROTOCOL.md') },
    ...roomSkillEntries(layout, agents),
  ];
  const providers: Record<string, Provider> = {};
  const profiles: Profile[] = [];
  const checks: Check[] = [];
  const binaries: Partial<Record<AgentId, string>> = {};
  for (const id of agents) {
    const agent = AGENTS[id];
    const plan = await agent.build(layout, roles, build);
    entries.push(...plan.entries);
    checks.push(...plan.checks);
    const credentials = plan.credentials ?? [];
    checks.push(...credentials.flatMap(credential => credential.checks));
    const credentialPaths = new Set(credentials.map(credential => credential.path));
    const collisions = plan.entries.filter(entry => credentialPaths.has(entry.path));
    if (collisions.length > 0) {
      checks.push(fail(`${id}.credentials`,
        `${agent.label} produced managed entries for preserve-only credential paths: ${collisions.map(entry => entry.path).join(', ')}.`,
        'This is an adapter defect; do not apply the plan.'));
    }
    if (plan.binary === undefined) continue;
    binaries[id] = plan.binary;
    Object.assign(providers, roleProviders(layout, agent, {
      binary: plan.binary,
      ...(plan.argv ? { argv: plan.argv } : {}),
      ...(plan.providerEnv ? { providerEnv: plan.providerEnv } : {}),
    }, roles));
    profiles.push(...roleProfiles(agent, roles));
  }
  if (agents.every(id => binaries[id] !== undefined)) {
    entries.push({
      kind: 'file',
      path: join(layout.roomHome, AUTHENTICATION_GUIDE),
      content: renderAuthenticationGuide(layout.roomHome, binaries, agents, roles),
    });
    checks.push(warn('room.authentication-not-validated',
      `Role authentication was not validated. Login instructions are managed at ${join(layout.roomHome, AUTHENTICATION_GUIDE)}.`,
      'After setup --apply, follow that guide or run: paseo-room auth login <agent> <role>'));
  }
  const plugins: PluginSpec[] = [];
  if (agents.includes('claude')) {
    plugins.push(carrierSpec(layout));
    entries.push(...claudeCarrierEntries(layout, roles));
  }
  let runtime: RuntimeMarker | undefined;
  if (build.runtime === true) {
    plugins.push(runtimeSpec(layout));
    entries.push(...runtimePluginEntries(layout, agents, roles));
    runtime = { enabled: true, generation: renderRuntimeManifest(agents, roles).roomGeneration, schema: 1 };
  }
  entries.push({ kind: 'file', path: join(layout.roomHome, MARKER), content: renderMarker(metadata.version, agents, roles, contractDigest(), markerMemoryContract(agents, build.memoryContract ?? true), runtime) });
  return { entries, providers, profiles, checks, plugins, ...(runtime === undefined ? {} : { runtime }) };
}

/**
 * The marker records which rendered contract generation installed this room, so an operator
 * who upgrades the package can see that the seats now hold older text. A room installed
 * before provenance existed has no digest, which is reported the same way rather than
 * treated as a broken marker.
 */
function contractProvenance(previous: Marker | undefined): Check[] {
  const digest = contractDigest();
  if (!previous) return [];
  if (previous.contract === digest) {
    return [pass('room.contract', `Role contract generation ${digest} matches this package.`)];
  }
  const held = previous.contract === undefined
    ? `was installed before the room recorded its contract generation (package ${previous.version})`
    : `holds contract generation ${previous.contract}`;
  return [warn('room.contract',
    `This room ${held}; this package renders ${digest}. Managed role documents are rewritten by setup, and a running seat keeps the text it started with.`,
    'Run: paseo-room setup --apply, then restart the affected seats.')];
}

/**
 * `thinkingOptionId` is seeded once and the operator's afterwards, so a risky selection is
 * reported rather than corrected. Nothing here changes provider selection, profile writes, or
 * exit status.
 */
function thinkingDiagnostics(live: readonly LiveProfile[], desired: readonly Profile[]): Check[] {
  const owned = new Set(desired.map(profile => profile.id));
  const selected = live
    .filter(entry => owned.has(String(entry.id)))
    .filter(entry => DELEGATING_THINKING.some(option => option === entry.thinkingOptionId))
    .map(entry => `${String(entry.id)} (${String(entry.thinkingOptionId)})`)
    .sort();
  if (selected.length === 0) return [];
  return [warn('room.thinking',
    `${String(selected.length)} room seats are set to a top reasoning option that Paseo describes as including automatic task delegation: ${selected.join(', ')}. Whether that option can actually delegate once the room has closed the native multi-agent paths is unverified: paseo-room has not verified whether those closures prevent that option from delegating, and left your selection in place.`,
    `Choose a lower reasoning option for those seats in Paseo if you want the room's own defaults (${ROLE_THINKING.supervisor} for Supervisor, ${ROLE_THINKING.lead} for Lead and Peer).`)];
}

/**
 * Names what kind of drift was found. A path the room suppressed needs deleting rather than
 * rewriting, so reporting every difference as "missing or outdated" would name the wrong fix.
 */
function fileDriftSummary(drifted: readonly Operation[]): string {
  const removals = drifted.filter(operation => operation.action === 'remove').length;
  const count = String(drifted.length);
  const subject = drifted.length === 1 ? 'managed role file is' : 'managed role files are';
  if (removals === 0) return `${count} ${subject} missing or outdated.`;
  if (removals === drifted.length) return `${count} ${subject} present but suppressed by this room.`;
  return `${count} ${subject} missing or outdated, and ${String(removals)} of them are present but suppressed by this room.`;
}

/** Catalog copies are one of the room's three native multi-agent closures, so their drift is named. */
function fileDriftDetail(targets: readonly string[]): string {
  const catalogs = targets.filter(target => target.endsWith(`${sep}model-catalog.json`));
  if (catalogs.length === 0) return '';
  const count = catalogs.length === 1 ? 'One of them is a generated Codex model catalog' : `${String(catalogs.length)} of them are generated Codex model catalogs`;
  return ` ${count}, so those seats currently lack the scrubbed catalog closure rather than only older contract text.`;
}

interface Stale {
  readonly providerIds: readonly string[];
  readonly profileIds: readonly string[];
  /** Room plugins a previous selection registered that this one does not. */
  readonly removePlugins: readonly PluginSpec[];
  /** Role homes are retained during setup because runtime-owned credentials may be inside. */
  readonly retainedDirectories: readonly string[];
}
const NOTHING_STALE: Stale = { providerIds: [], profileIds: [], removePlugins: [], retainedDirectories: [] };

async function safeDirectory(path: string, checks: Check[]): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) return true;
    checks.push(fail('room.path-safety',
      `Refusing to traverse ${path}: every existing room directory ancestor must be a real directory, not a symbolic link or another file type.`,
      'Move the path aside manually after checking it for role-owned credentials, then run the command again.'));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    checks.push(fail('room.path-safety', `Could not inspect room directory ${path} without following links.`,
      'Fix its parent permissions or move the path manually, then run the command again.'));
    return false;
  }
}

/** Refuse managed writes through any existing room-relative directory alias. */
async function roomPathSafety(layout: Layout, agents: readonly AgentId[], roles: readonly Role[]): Promise<Check[]> {
  const checks: Check[] = [];
  if (!await safeDirectory(layout.roomHome, checks)) return checks;

  const room = sharedRoom(layout);
  const roomIsSafe = await safeDirectory(room, checks);
  // Calls with no agents are root-only checks used before marker discovery and by explicit remove.
  // Recursive removal unlinks nested symlinks without following them, so it must remain able to
  // delete a broken room; setup and verify make a later full pass with the affected agents.
  if (roomIsSafe && agents.length > 0) {
    const skills = join(room, 'skills');
    if (await safeDirectory(skills, checks)) {
      const source = roomSkillSource(layout);
      if (await safeDirectory(source, checks)) await safeDirectory(join(source, 'references'), checks);
    }
    const projections = skillProjectionRoot(layout);
    if (await safeDirectory(projections, checks)) {
      for (const agent of agents) {
        const agentRoot = agentSkillProjectionRoot(layout, agent);
        if (await safeDirectory(agentRoot, checks)) await safeDirectory(leadSkillProjection(layout, agent), checks);
      }
    }
  }

  const rolesHome = join(layout.roomHome, 'roles');
  if (!await safeDirectory(rolesHome, checks)) return checks;
  for (const agent of agents) {
    const agentHome = join(rolesHome, agent);
    if (!await safeDirectory(agentHome, checks)) continue;
    for (const role of roles) await safeDirectory(roleHome(layout, agent, role), checks);
  }
  return checks;
}

/** A previous setup may have seated agents or roles this one does not: drop those. */
async function staleFrom(
  layout: Layout, previous: Marker | undefined, agents: readonly AgentId[], roles: readonly Role[], runtime: boolean,
): Promise<Stale> {
  if (!previous) return NOTHING_STALE;
  const kept = new Set(agents.flatMap(agent => roles.map(role => providerId(agent, role))));
  const providerIds: string[] = [];
  const profileIds: string[] = [];
  const retainedDirectories: string[] = [];
  for (const agent of previous.agents) {
    for (const role of previous.roles) {
      if (kept.has(providerId(agent, role))) continue;
      providerIds.push(providerId(agent, role));
      profileIds.push(profileId(agent, role));
      const path = roleHome(layout, agent, role);
      if (await exists(path)) retainedDirectories.push(path);
    }
  }
  return {
    providerIds,
    profileIds,
    removePlugins: [
      ...(previous.agents.includes('claude') && !agents.includes('claude') ? [carrierSpec(layout)] : []),
      ...(previous.runtime?.enabled === true && !runtime ? [runtimeSpec(layout)] : []),
    ],
    retainedDirectories,
  };
}

interface Plan {
  readonly operations: readonly Operation[];
  /** Carried out of the plan so apply rewrites the array it actually compared against. */
  readonly liveProfiles: readonly LiveProfile[];
  readonly livePlugins: ReadonlyMap<string, LivePlugin>;
  readonly pluginChecks: readonly Check[];
}

function pluginPlan(spec: PluginSpec, wanted: boolean, plugins: readonly LivePlugin[]): {
  operation?: Operation; livePlugin?: LivePlugin; checks: Check[];
} {
  const livePlugin = plugins.find(plugin => plugin.id === spec.id);
  if (livePlugin !== undefined && livePlugin.path !== spec.path) {
    return {
      livePlugin,
      checks: [fail(`${spec.check}.path`,
        `Plugin ${spec.id} is registered from ${livePlugin.path}, not the room-owned path ${spec.path}.`,
        'Move or remove that conflicting plugin registration manually, then run setup again.')],
    };
  }
  if (wanted) {
    const healthy = livePlugin?.enabled === true && livePlugin.status === 'running' && livePlugin.error === undefined;
    return {
      ...(livePlugin === undefined ? {} : { livePlugin }),
      operation: { action: livePlugin === undefined ? 'create' : healthy ? 'noop' : 'update', kind: 'plugin', target: spec.id },
      checks: [],
    };
  }
  return {
    ...(livePlugin === undefined ? {} : { livePlugin }),
    operation: { action: livePlugin === undefined ? 'noop' : 'remove', kind: 'plugin', target: spec.id },
    checks: [],
  };
}

/** One definition of drift, shared by the command that fixes it and the one that reports it. */
async function planRoom(session: Session, desired: Desired, stale: Stale): Promise<Plan> {
  const inspectPlugins = desired.plugins.length > 0 || stale.removePlugins.length > 0;
  const [live, liveProfiles, plugins] = await Promise.all([
    session.readProviders(), session.readProfiles(), inspectPlugins ? session.listPlugins() : Promise.resolve([]),
  ]);
  const byId = new Map(liveProfiles.map(entry => [String(entry.id), entry]));
  const planned = [
    ...desired.plugins.map(spec => pluginPlan(spec, true, plugins)),
    ...stale.removePlugins.map(spec => pluginPlan(spec, false, plugins)),
  ];
  const livePlugins = new Map<string, LivePlugin>();
  for (const plugin of planned) if (plugin.livePlugin !== undefined) livePlugins.set(plugin.livePlugin.id, plugin.livePlugin);
  return {
    liveProfiles,
    livePlugins,
    pluginChecks: planned.flatMap(plugin => plugin.checks),
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
      ...planned.flatMap(plugin => (plugin.operation === undefined ? [] : [plugin.operation])),
    ],
  };
}

function pluginsEnabledCheck(spec: PluginSpec, enabled: boolean): Check {
  return enabled
    ? pass(`${spec.check}.enabled`, spec.enabledPass)
    : fail(`${spec.check}.enabled`, spec.enabledFail,
      'Review that trust boundary, enable plugins in Paseo Settings, reload Paseo, then run setup again.');
}

function pluginRuntimeCheck(spec: PluginSpec, plugin: LivePlugin | undefined): Check {
  if (plugin === undefined) {
    return fail(`${spec.check}.runtime`, `Plugin ${spec.id} is not registered.`, 'Run: paseo-room setup --apply');
  }
  if (plugin.path !== spec.path) {
    return fail(`${spec.check}.runtime`, `Plugin ${spec.id} is registered from ${plugin.path}, not ${spec.path}.`,
      'Move or remove that conflicting plugin registration manually, then run setup again.');
  }
  if (!plugin.enabled || plugin.status !== 'running' || plugin.error !== undefined) {
    const detail = plugin.error === undefined ? `status ${plugin.status}` : `${plugin.status}: ${plugin.error}`;
    return fail(`${spec.check}.runtime`, `Plugin ${spec.id} is not running (${detail}).`, 'Run: paseo-room setup --apply');
  }
  return pass(`${spec.check}.runtime`, `${spec.running} is running from ${spec.path}.`);
}

async function reconcilePlugins(session: Session, desired: Desired, stale: Stale, plan: Plan, pending: readonly Operation[]): Promise<Check[]> {
  for (const spec of stale.removePlugins) {
    if (plan.livePlugins.has(spec.id)) await session.removePlugin(spec.id);
  }
  const checks: Check[] = [];
  for (const spec of desired.plugins) {
    let plugin = plan.livePlugins.get(spec.id);
    if (plugin === undefined) {
      plugin = await session.installPlugin(spec.path, spec.id);
    } else {
      if (!plugin.enabled) plugin = await session.enablePlugin(spec.id);
      const filesChanged = pending.some(operation =>
        (operation.kind === 'file' || operation.kind === 'dir') && operation.target.startsWith(`${spec.path}${sep}`),
      );
      const needsReload = filesChanged || plugin.status !== 'running' || plugin.error !== undefined;
      if (needsReload) plugin = await session.reloadPlugin(spec.id);
    }
    checks.push(pluginRuntimeCheck(spec, plugin));
  }
  return checks;
}

/**
 * A room plugin's range is exact on both ends: `0.8.0` and `0.9.1` are live-qualified and
 * `0.10.0` is unqualified. Selecting the plugin accepts that bound; not selecting it never
 * raises the baseline, which stays the floor `minimumPaseoVersion` reports.
 */
function pluginRangeCheck(spec: PluginSpec, version: string): Check {
  return satisfies(version, spec.paseoRange)
    ? pass(spec.rangeCheck, `Paseo ${version} is inside the ${spec.running} range ${spec.paseoRange}.`)
    : fail(spec.rangeCheck, `${spec.running} supports Paseo ${spec.paseoRange}; the running daemon is ${version}.`, spec.rangeRemedy);
}

/**
 * Deselecting runtime must not strand work it recorded: it is refused while any assignment,
 * writer ownership, managed Peer archive, gate or delivery is active or uncertain. Once quiet,
 * the plugin is unregistered and the recorded state is kept for export or a later re-enable.
 */
async function runtimeDeselectionCheck(layout: Layout): Promise<Check[]> {
  const summary = await inspectRuntimeState(layout.roomHome);
  if (summary.projects === 0) return [];
  if (summary.blockers.length > 0) {
    return [fail('runtime.deselect',
      `Runtime coordination still has active or uncertain work: ${describeBlockers(summary)}.`,
      'Keep --runtime and finish, close or abandon that work first; the runtime state is preserved either way.')];
  }
  return [warn('runtime.state-retained',
    `Runtime coordination is quiet; its recorded state for ${String(summary.projects)} project(s) stays at ${summary.root}.`,
    'Export it with: paseo-room export --out <dir>, or keep it for a later --runtime.')];
}

/** Whole-room removal keeps its destructive meaning, but says what runtime history it deletes. */
async function runtimeRemovalWarning(layout: Layout): Promise<Check[]> {
  const summary = await inspectRuntimeState(layout.roomHome).catch(() => undefined);
  if (summary === undefined || summary.projects === 0) return [];
  const active = summary.blockers.length > 0 ? ` It still has active or uncertain work: ${describeBlockers(summary)}.` : '';
  return [warn('room.remove.runtime-state',
    `Deleting ${layout.roomHome} also deletes runtime coordination history for ${String(summary.projects)} project(s).${active}`,
    'Export it first with: paseo-room export --out <dir>')];
}

/**
 * The marker value for the Claude memory-contract choice. A room with no Claude seat records
 * nothing: the choice only describes Claude's `CLAUDE.md`, and storing it anyway would leave
 * state in the marker that nothing generated and nothing reads.
 */
function markerMemoryContract(agents: readonly AgentId[], memoryContract: boolean): boolean | undefined {
  return agents.includes('claude') ? memoryContract : undefined;
}

/**
 * With the file carrier suppressed, the plugin is the room's only Claude carrier. The plugin
 * is verified, so this is not a silent risk — but whether a resumed session re-enters the
 * creation hook is unproven, so the operator is told what they gave up rather than reassured.
 */
function memoryContractDiagnostic(agents: readonly AgentId[], memoryContract: boolean): Check[] {
  if (memoryContract || !agents.includes('claude')) return [];
  return [warn('claude.memory-contract',
    'Claude role CLAUDE.md files carry your global memory only: the role contract was not written to them, so the trusted server plugin is this room\'s only Claude carrier. Only a newly created agent passes through its creation hook, and whether a resumed session re-enters that hook is unproven.',
    'Drop --no-claude-memory-contract and run setup --apply to restore the file fallback.')];
}

/** The whole product: write the role homes, then register them with Paseo. */
export async function setup(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const agents = options.agents ?? ['codex'];
  const memoryContract = options.claudeMemoryContract ?? true;
  const invalid = layoutChecks(layout, agents);
  if (invalid.length > 0) return failed('setup', invalid);
  const rootSafety = await roomPathSafety(layout, [], []);
  if (hasFailure(rootSafety)) return failed('setup', rootSafety);
  const previous = await readMarker(layout);
  const safetyAgents = [...new Set([...agents, ...(previous?.agents ?? [])])];
  const pathSafety = await roomPathSafety(layout, safetyAgents, ROLES);
  if (hasFailure(pathSafety)) return failed('setup', pathSafety);
  // Cleanup uses the APIs required by the old selection too (notably Claude's plugin API).
  const compatibilityAgents = [...new Set([...agents, ...(previous?.agents ?? [])])];
  const runtime = options.runtime === true;
  const daemon = await checkDaemon(layout, options.env, minimumPaseoVersion(compatibilityAgents, runtime || previous?.runtime?.enabled === true));
  if (!daemon.daemon) return failed('setup', daemon.checks);
  const version = daemon.daemon.version;
  const desired = await buildDesired(layout, agents, ROLES, { memoryContract, runtime });
  const stale = await staleFrom(layout, previous, agents, ROLES, runtime);
  const runtimeChecks = [
    ...desired.plugins.map(spec => pluginRangeCheck(spec, version)),
    ...(stale.removePlugins.some(spec => spec.id === RUNTIME_PLUGIN_ID) ? await runtimeDeselectionCheck(layout) : []),
  ];
  const retained = stale.retainedDirectories.length === 0 ? [] : [warn(
    'room.stale-role-homes-preserved',
    `Preserved ${String(stale.retainedDirectories.length)} deselected role homes because they may contain role-owned credentials or runtime state.`,
    `Use paseo-room remove --apply to delete the entire room after reviewing its credential warning, or remove deselected homes manually: ${stale.retainedDirectories.join(', ')}`,
  )];
  const checks = [...daemon.checks, ...runtimeChecks, ...desired.checks, ...retained];
  if (hasFailure(checks)) return failed('setup', checks);

  return withSession(daemon.daemon, async session => {
    const plan = await planRoom(session, desired, stale);
    const { operations, liveProfiles } = plan;
    const pending = operations.filter(operation => operation.action !== 'noop');
    const enabled = desired.plugins.length === 0 ? true : await session.pluginsEnabled();
    const pluginPreconditions = [...desired.plugins.map(spec => pluginsEnabledCheck(spec, enabled)), ...plan.pluginChecks];
    // Diagnostics last: nothing above may be reached only through a warning.
    const preApplyDiagnostics = [...checks, ...pluginPreconditions, ...memoryContractDiagnostic(agents, memoryContract), ...contractProvenance(previous), ...thinkingDiagnostics(liveProfiles, desired.profiles)];
    if (hasFailure(preApplyDiagnostics) || !options.apply) {
      return {
        command: 'setup',
        outcome: hasFailure(preApplyDiagnostics) ? 'failed' : pending.length > 0 ? 'changes-planned' : 'ok',
        changed: false, checks: preApplyDiagnostics, operations,
      } satisfies Result;
    }
    // Keep the old marker until daemon reconciliation succeeds. If a remote write fails,
    // rerunning setup can still discover every stale provider/profile/plugin it must remove.
    const markerPath = join(layout.roomHome, MARKER);
    const markerEntries = desired.entries.filter(entry => entry.path === markerPath);
    await applyEntries(desired.entries.filter(entry => entry.path !== markerPath));
    const ids = Object.keys(desired.providers);
    await session.writeProviders(desired.providers);
    if (stale.providerIds.length > 0) await session.removeProviders(stale.providerIds);
    // Profiles point at providers, so they are written once the providers exist — and
    // only when something changed, since one write replaces the host's whole array.
    let appliedProfiles = liveProfiles;
    if (pending.some(operation => operation.kind === 'profile')) {
      appliedProfiles = mergeProfiles(liveProfiles, desired.profiles, stale.profileIds);
      await session.writeProfiles(appliedProfiles);
    }
    await session.refresh(ids);
    const pluginChecks = await reconcilePlugins(session, desired, stale, plan, pending);
    await applyEntries(markerEntries);
    const appliedMarker: Marker = {
      version: metadata.version, agents: [...agents], roles: [...ROLES], contract: contractDigest(),
      ...(markerMemoryContract(agents, memoryContract) === false ? { claudeMemoryContract: false } : {}),
      ...(desired.runtime === undefined ? {} : { runtime: desired.runtime }),
    };
    const appliedChecks = [...checks, ...pluginPreconditions, ...pluginChecks,
      pass('room.applied', `Room ready at ${layout.roomHome} with ${String(ids.length)} Paseo providers.`),
      ...memoryContractDiagnostic(agents, memoryContract),
      ...contractProvenance(appliedMarker), ...thinkingDiagnostics(appliedProfiles, desired.profiles)];
    return {
      command: 'setup', outcome: hasFailure(appliedChecks) ? 'failed' : 'ok', changed: pending.length > 0,
      checks: appliedChecks, operations,
    } satisfies Result;
  }, sessionOptions(options));
}

export async function verify(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const rootSafety = await roomPathSafety(layout, [], []);
  if (hasFailure(rootSafety)) return failed('verify', rootSafety);
  const marker = await readMarker(layout);
  if (!marker) {
    return failed('verify', [fail('room.marker', `No room found at ${layout.roomHome}.`, 'Run: paseo-room setup --apply')]);
  }
  const invalid = layoutChecks(layout, marker.agents);
  if (invalid.length > 0) return failed('verify', invalid);
  const pathSafety = await roomPathSafety(layout, marker.agents, marker.roles);
  if (hasFailure(pathSafety)) return failed('verify', pathSafety);
  const runtime = marker.runtime?.enabled === true;
  const daemon = await checkDaemon(layout, options.env, minimumPaseoVersion(marker.agents, runtime));
  if (!daemon.daemon) return failed('verify', daemon.checks);
  const version = daemon.daemon.version;
  const desired = await buildDesired(layout, marker.agents, marker.roles, {
    // The room's own recorded choices, so verify compares against what setup wrote.
    memoryContract: marker.claudeMemoryContract ?? true,
    runtime,
  });
  const runtimeChecks = [
    ...desired.plugins.map(spec => pluginRangeCheck(spec, version)),
    ...(runtime ? [marker.runtime?.generation === desired.runtime?.generation
      ? pass('runtime.generation', `Runtime manifest generation ${String(desired.runtime?.generation)} matches this package.`)
      : fail('runtime.generation', `This room was set up with runtime generation ${String(marker.runtime?.generation)}; this package generates ${String(desired.runtime?.generation)}.`, 'Run: paseo-room setup --runtime --apply')] : []),
  ];
  const checks = [...daemon.checks, ...runtimeChecks, ...desired.checks];
  if (hasFailure(daemon.checks) || hasFailure(desired.checks)) return failed('verify', checks);

  return withSession(daemon.daemon, async session => {
    const plan = await planRoom(session, desired, NOTHING_STALE);
    const { operations, liveProfiles } = plan;
    const drifted = operations.filter(operation => operation.action !== 'noop');
    const count = (kind: Operation['kind']): number => drifted.filter(operation => operation.kind === kind).length;
    const providers = count('provider');
    const profiles = count('profile');
    const driftedFiles = drifted.filter(operation => !['provider', 'profile', 'plugin'].includes(operation.kind));
    const files = driftedFiles.length;
    const enabled = desired.plugins.length === 0 ? true : await session.pluginsEnabled();
    const pluginChecks = desired.plugins.flatMap(spec => [
      pluginsEnabledCheck(spec, enabled),
      ...plan.pluginChecks.filter(check => check.id.startsWith(`${spec.check}.`)),
      pluginRuntimeCheck(spec, plan.livePlugins.get(spec.id)),
    ]);
    const all: Check[] = [...checks,
      files === 0
        ? pass('room.files', 'Every managed role file matches the current definition.')
        : fail('room.files', `${fileDriftSummary(driftedFiles)}${fileDriftDetail(driftedFiles.map(operation => operation.target))}`, 'Run: paseo-room setup --apply'),
      providers === 0
        ? pass('room.providers', `All ${String(Object.keys(desired.providers).length)} Paseo providers are registered as expected.`)
        : fail('room.providers', `${String(providers)} Paseo providers are missing or differ.`, 'Run: paseo-room setup --apply'),
      profiles === 0
        ? pass('room.profiles', `All ${String(desired.profiles.length)} Paseo agent profiles are registered as expected.`)
        : fail('room.profiles', `${String(profiles)} Paseo agent profiles are missing or differ.`, 'Run: paseo-room setup --apply'),
      ...pluginChecks,
      // Diagnostics last: a warning never precedes the failure it might be mistaken for.
      ...memoryContractDiagnostic(marker.agents, marker.claudeMemoryContract ?? true),
      ...contractProvenance(marker),
      ...thinkingDiagnostics(liveProfiles, desired.profiles),
    ];
    return {
      command: 'verify', outcome: hasFailure(all) ? 'failed' : 'ok', changed: false, checks: all, operations,
    } satisfies Result;
  }, sessionOptions(options));
}

export async function remove(options: RunOptions = {}): Promise<Result> {
  const layout = resolveLayout(options, options.env);
  const rootSafety = await roomPathSafety(layout, [], []);
  if (hasFailure(rootSafety)) return failed('remove', rootSafety);
  const marker = await readMarker(layout);
  if (!marker) {
    return failed('remove', [fail('room.marker', `No room found at ${layout.roomHome}.`, 'Nothing to remove; the room home was never created here.')]);
  }
  // A recursive delete needs a floor, so the layout rules gate this command too.
  const invalid = layoutChecks(layout, marker.agents);
  if (invalid.length > 0) return failed('remove', invalid);
  const ids = marker.agents.flatMap(agent => marker.roles.map(role => providerId(agent, role)));
  const profiles = new Set(marker.agents.flatMap(agent => marker.roles.map(role => profileId(agent, role))));
  const plugins = [
    ...(marker.agents.includes('claude') ? [carrierSpec(layout)] : []),
    ...(marker.runtime?.enabled === true ? [runtimeSpec(layout)] : []),
  ];
  const operations: Operation[] = [
    ...ids.map(id => ({ action: 'remove', kind: 'provider', target: id }) satisfies Operation),
    ...[...profiles].map(id => ({ action: 'remove', kind: 'profile', target: id }) satisfies Operation),
    ...plugins.map(spec => ({ action: 'remove', kind: 'plugin', target: spec.id }) satisfies Operation),
    { action: 'remove', kind: 'dir', target: layout.roomHome },
  ];
  const credentialWarning = warn('room.remove.credentials',
    `Deleting ${layout.roomHome} will delete role-owned credential files stored inside it. Native OS keyring entries are not inspected or deleted and may remain. Operator agent-home credentials are untouched.`);
  const runtimeWarnings = await runtimeRemovalWarning(layout);
  if (!options.apply) {
    return { command: 'remove', outcome: 'changes-planned', changed: false, checks: [credentialWarning, ...runtimeWarnings], operations };
  }
  const daemon = await checkDaemon(layout, options.env);
  const checks: Check[] = [credentialWarning, ...runtimeWarnings];
  if (!daemon.daemon) {
    return failed('remove', [
      credentialWarning,
      ...daemon.checks,
      fail(
        'room.files',
        `Preserved ${layout.roomHome}, including its room marker, because Paseo cleanup could not start.`,
        'Start Paseo, then run: paseo-room remove --apply',
      ),
    ]);
  }
  try {
    await withSession(daemon.daemon, async session => {
      if (plugins.length > 0) {
        const live = await session.listPlugins();
        // Deregister before the room home is deleted, and never a registration from a foreign path.
        for (const spec of plugins) {
          const plugin = live.find(entry => entry.id === spec.id);
          if (plugin !== undefined && plugin.path !== spec.path) throw new Error(`refusing to remove foreign plugin path ${plugin.path}`);
        }
        for (const spec of plugins) {
          if (live.some(entry => entry.id === spec.id)) await session.removePlugin(spec.id);
        }
      }
      await session.removeProviders(ids);
      const live = await session.readProfiles();
      const kept = live.filter(entry => !profiles.has(String(entry.id)));
      if (kept.length !== live.length) await session.writeProfiles(kept);
    }, sessionOptions(options));
    checks.push(pass('room.providers', `Removed ${String(ids.length)} Paseo providers and their agent profiles.`));
  } catch {
    return failed('remove', [
      credentialWarning,
      fail(
        'room.providers',
        `Paseo provider/profile cleanup did not complete; ${layout.roomHome} and its room marker were preserved.`,
        'Restore Paseo connectivity, then run: paseo-room remove --apply',
      ),
    ]);
  }
  // Explicit remove owns the whole room home, including runtime-owned role credentials.
  try {
    await rm(layout.roomHome, { recursive: true, force: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown filesystem error';
    checks.push(fail(
      'room.files',
      `Removed the Paseo providers and profiles, but could not fully delete ${layout.roomHome}: ${detail}`,
      'Delete that directory manually after reviewing it for role-owned credentials; the Paseo side is already clean.',
    ));
    const completedOperations = operations.filter(operation => operation.kind !== 'dir');
    return { command: 'remove', outcome: 'failed', changed: true, checks, operations: completedOperations };
  }
  checks.push(pass('room.files', `Deleted ${layout.roomHome}.`));
  return { command: 'remove', outcome: 'ok', changed: true, checks, operations };
}
