import { join } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { inspectCredentialPath, preservedCredentialCheck, roleCommand, type CredentialDiagnostic } from '../credentials.js';
import type { Layout } from '../layout.js';
import { roleHome } from '../layout.js';
import type { Entry } from '../fsops.js';
import { existingPaths, readIfPresent } from '../fsops.js';
import { fail, pass, type Check } from '../result.js';
import type { Role } from '../roles.js';
import { renderInstructions } from '../room/instructions.js';
import { probe, which } from '../which.js';
import { paseoMcpCheck, serverTable } from './mcp.js';
import { roleResourceEntries } from './resources.js';
import type { Agent, AgentPlan } from './types.js';

/** Read-only operator resources every role shares by reference, never by copy. */
const SHARED = ['AGENTS.md', 'skills', 'plugins', 'hooks.json'] as const;
/** Plugins and hooks run operator code, so Peer — which has no room tools — never loads them. */
const EXECUTABLE = ['plugins', 'hooks.json'] as const;
const CATALOG = 'model-catalog.json';
export type CodexCredentialStore = 'file' | 'ephemeral' | 'auto' | 'keyring' | 'unknown';

function table(parent: TomlTable, key: string): TomlTable {
  const value = parent[key];
  if (value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return (parent[key] = {});
  }
  return value;
}

/**
 * Close Codex's native multi-agent features inside one scope: the top-level table, or an
 * active profile, which outranks it.
 */
function pinMultiAgentFeatures(scope: TomlTable): void {
  const features = table(scope, 'features');
  features.multi_agent = false;
  // Newer configs represent v2 as a table; keep that shape rather than writing a
  // boolean at the same key, which would be a TOML conflict.
  if (typeof features.multi_agent_v2 === 'boolean' || features.multi_agent_v2 === undefined) features.multi_agent_v2 = false;
  else table(features, 'multi_agent_v2').enabled = false;
}

export interface RoleConfigInput {
  readonly roleDocument: string;
  readonly catalogPath?: string;
}
/**
 * Copy the operator's config, then override only the keys the room owns.
 *
 * `model_instructions_file` is deliberately untouched: it *replaces* Codex's base
 * prompt, so writing it would mean vendoring and maintaining a full copy of that
 * prompt. The room contract is additive and belongs in `developer_instructions`.
 */
export function renderRoleConfig(source: TomlTable, input: RoleConfigInput): string {
  const config = structuredClone(source);
  config.sandbox_mode = 'danger-full-access';
  config.approval_policy = 'never';
  config.developer_instructions = input.roleDocument;
  if (input.catalogPath) config.model_catalog_json = input.catalogPath;
  // Codex's own multi-agent mode would compete with the room's role contract.
  // `[agents]` stays top-level only: Codex profiles have no such key.
  table(config, 'agents').enabled = false;
  pinMultiAgentFeatures(config);
  // An active profile outranks the top-level keys, so every room-owned key a profile can
  // also carry — sandbox, approval, catalog, features — has to land there too.
  if (typeof config.profile === 'string') {
    const profile = table(table(config, 'profiles'), config.profile);
    profile.sandbox_mode = 'danger-full-access';
    profile.approval_policy = 'never';
    if (input.catalogPath) profile.model_catalog_json = input.catalogPath;
    pinMultiAgentFeatures(profile);
  }
  return stringify(config) + '\n';
}

export function renderCatalog(catalog: unknown): string {
  return JSON.stringify(catalog, (key, value: unknown) => (key === 'multi_agent_version' ? null : value), 2) + '\n';
}

/** Facts the captured catalog itself carries. Nothing is inferred beyond them. */
export interface CatalogEvidence {
  /** Codex reads the catalog as a JSON object, so any other top-level shape is not one. */
  readonly object: boolean;
  /** How many `multi_agent_version` fields the capture carried, and the copy therefore nulls. */
  readonly markers: number;
}

export function catalogEvidence(catalog: unknown): CatalogEvidence {
  let markers = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'multi_agent_version') markers += 1;
      else walk(nested);
    }
  };
  walk(catalog);
  return { object: catalog !== null && typeof catalog === 'object' && !Array.isArray(catalog), markers };
}

/** Read only the generated config's non-secret store selector. */
export function codexCredentialStore(config: TomlTable): CodexCredentialStore {
  const value = config.cli_auth_credentials_store;
  return value === 'file' || value === 'ephemeral' || value === 'auto' || value === 'keyring'
    ? value
    : 'unknown';
}

async function credentialDiagnostic(
  layout: Layout,
  role: Role,
  store: CodexCredentialStore,
  binary: string,
): Promise<CredentialDiagnostic> {
  const home = roleHome(layout, 'codex', role);
  const path = join(home, 'auth.json');
  const login = roleCommand({ CODEX_HOME: home }, binary, ['login']);
  const status = roleCommand({ CODEX_HOME: home }, binary, ['login', 'status']);
  const state = await inspectCredentialPath(path);
  const id = `codex.auth.${role}`;
  const checks: Check[] = [];
  if (state.kind !== 'missing') {
    checks.push(preservedCredentialCheck({ id, agent: 'Codex', role, path, state, login, status }));
  } else {
    if (store === 'keyring' || store === 'auto') {
      checks.push({
        id: `${id}.native-keyring-unverifiable`, status: 'warn',
        message: `Codex ${role} auth: native-keyring unverifiable; cli_auth_credentials_store is ${store}, and no keyring was queried. Token validity and freshness were not checked.`,
        fix: `Authenticate this role with: ${login}. Check status with: ${status}.`,
      });
    } else {
      const apiKey = layout.envNames.has('OPENAI_API_KEY')
        ? ' OPENAI_API_KEY is present only in the setup process; Codex has not stored it for this role and paseo-room does not copy it into the provider.'
        : '';
      const detail = store === 'ephemeral'
        ? 'cli_auth_credentials_store is ephemeral, so no persistent credential file is expected'
        : `no role-owned auth.json exists${store === 'file' ? ' for the configured file store' : ''}`;
      checks.push({
        id: `${id}.login-required`, status: 'warn',
        message: `Codex ${role} auth: login-required; ${detail}.${apiKey} Authentication was not attempted.`,
        fix: `Authenticate this role with: ${login}. Check status with: ${status}.`,
      });
    }
  }
  if (state.kind !== 'missing' && (store === 'keyring' || store === 'auto')) {
    checks.push({
      id: `${id}.native-keyring-unverifiable`, status: 'warn',
      message: `Codex ${role} auth: native-keyring unverifiable; cli_auth_credentials_store is ${store}, and the preserved auth.json does not prove what the runtime will use. No keyring was queried.`,
      fix: `Check status without exposing credentials: ${status}.`,
    });
  }
  return { path, checks };
}

export const codexAgent: Agent = {
  id: 'codex',
  label: 'Codex',
  homeEnv: 'CODEX_HOME',
  defaultModeId: 'full-access',
  // Without these, Paseo's own mode preset (default auto-review) is sent to the
  // app-server and outranks the sandbox/approval keys in the generated config.
  pins: { params: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } },
  async build(layout: Layout, roles: readonly Role[]): Promise<AgentPlan> {
    const checks: Check[] = [];
    const home = layout.agentHome.codex;
    const binary = await which(layout.bin.codex, layout.searchPath);
    if (!binary) {
      return { entries: [], checks: [fail('codex.bin', 'Codex executable not found.', 'Install Codex, or pass --codex-bin /path/to/codex.')] };
    }
    const configPath = join(home, 'config.toml');
    const raw = await readIfPresent(configPath);
    if (raw === undefined) {
      return { entries: [], checks: [fail('codex.home', `No config.toml in ${home}.`, 'Run codex once to initialise it, or pass --codex-home.')] };
    }
    let source: TomlTable;
    try { source = parse(raw); } catch {
      return { entries: [], checks: [fail('codex.config', `Could not read ${configPath} as TOML.`, 'Fix the syntax in your Codex config, then run setup again.')] };
    }
    checks.push(pass('codex.home', `Codex found at ${binary} using ${home}.`));
    // Paseo is the room's only control plane, so a Paseo-looking MCP server fails here,
    // before any managed path is written, rather than being filtered out of the copy.
    const conflict = paseoMcpCheck('codex.mcp', configPath, serverTable(source.mcp_servers));
    if (conflict) return { entries: [], checks: [...checks, conflict] };
    const store = codexCredentialStore(source);

    const entries: Entry[] = [];
    const credentials: CredentialDiagnostic[] = [];

    // The scrubbed catalog is one of the room's three native multi-agent closures, so a
    // catalog it cannot capture is a build failure, not a silent fall back to the
    // built-in catalog and its collaboration metadata.
    const capture = roleCommand({ CODEX_HOME: home }, binary, ['debug', 'models']);
    const models = await probe(binary, ['debug', 'models'], { HOME: layout.home, CODEX_HOME: home, PATH: layout.searchPath });
    if (!models.ok) {
      return { entries: [], checks: [...checks, fail('codex.catalog',
        'Codex model catalog unavailable, so native multi-agent metadata cannot be removed.',
        `Run ${capture} to see why it failed, upgrade Codex to a version that prints the JSON catalog, then run setup again.`)] };
    }
    let catalogSource: string;
    let evidence: CatalogEvidence;
    try {
      const parsed: unknown = JSON.parse(models.stdout);
      evidence = catalogEvidence(parsed);
      catalogSource = renderCatalog(parsed);
    } catch {
      return { entries: [], checks: [...checks, fail('codex.catalog',
        'Codex model catalog was not valid JSON, so native multi-agent metadata cannot be removed.',
        `Check the output of ${capture}, upgrade Codex if it does not print a JSON catalog, then run setup again.`)] };
    }
    // A JSON scalar or array parses but is not a catalog: writing it would point every role
    // at a file Codex cannot load, which is the same closure failure as no catalog at all.
    if (!evidence.object) {
      return { entries: [], checks: [...checks, fail('codex.catalog',
        'Codex printed valid JSON that is not a model catalog object, so native multi-agent metadata cannot be removed.',
        `Check the output of ${capture}, upgrade Codex to a version that prints the JSON catalog object, then run setup again.`)] };
    }
    checks.push(pass('codex.catalog', evidence.markers === 0
      ? `Codex model catalog captured from ${capture}; it declared no multi_agent_version field, and each role home gets that generated copy instead of Codex's built-in catalog.`
      : `Codex model catalog captured from ${capture}; ${String(evidence.markers)} multi_agent_version field(s) are nulled in the generated copy in each role home.`));

    const shared = await existingPaths(home, SHARED);
    for (const role of roles) {
      const target = roleHome(layout, 'codex', role);
      const catalogPath = join(target, CATALOG);
      const roleDocument = renderInstructions(role);
      entries.push({ kind: 'dir', path: target });
      // Codex reads the brief from developer_instructions; this copy is for the operator.
      entries.push({ kind: 'file', path: join(target, 'role-instructions.md'), content: roleDocument });
      entries.push({
        kind: 'file',
        path: join(target, 'config.toml'),
        content: renderRoleConfig(source, { roleDocument, catalogPath }),
      });
      entries.push({ kind: 'file', path: catalogPath, content: catalogSource });
      entries.push(...await roleResourceEntries({ role, target, home, names: SHARED, shared, executable: EXECUTABLE }));
      credentials.push(await credentialDiagnostic(layout, role, store, binary));
    }
    return { entries, credentials, checks, binary };
  },
};
