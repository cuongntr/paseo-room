import { basename, join } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import type { Layout } from '../layout.js';
import { roleHome } from '../layout.js';
import type { Entry } from '../fsops.js';
import { existingPaths, readIfPresent } from '../fsops.js';
import { fail, pass, type Check } from '../result.js';
import type { Role } from '../roles.js';
import { renderInstructions } from '../room/instructions.js';
import { probe, which } from '../which.js';
import type { Agent, AgentPlan } from './types.js';

/** Read-only operator resources every role shares by reference, never by copy. */
const SHARED = ['auth.json', 'AGENTS.md', 'skills', 'plugins', 'hooks.json'] as const;
const CATALOG = 'model-catalog.json';

function table(parent: TomlTable, key: string): TomlTable {
  const value = parent[key];
  if (value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return (parent[key] = {});
  }
  return value;
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
  // An active profile outranks the top-level keys, so the room's must land there too.
  if (typeof config.profile === 'string') {
    const profile = table(table(config, 'profiles'), config.profile);
    profile.sandbox_mode = 'danger-full-access';
    profile.approval_policy = 'never';
  }
  config.developer_instructions = input.roleDocument;
  if (input.catalogPath) config.model_catalog_json = input.catalogPath;
  // Codex's own multi-agent mode would compete with the room's role contract.
  table(config, 'agents').enabled = false;
  const features = table(config, 'features');
  features.multi_agent = false;
  // Newer configs represent v2 as a table; keep that shape rather than writing a
  // boolean at the same key, which would be a TOML conflict.
  if (typeof features.multi_agent_v2 === 'boolean' || features.multi_agent_v2 === undefined) features.multi_agent_v2 = false;
  else table(features, 'multi_agent_v2').enabled = false;
  return stringify(config) + '\n';
}

export function renderCatalog(catalog: unknown): string {
  return JSON.stringify(catalog, (key, value: unknown) => (key === 'multi_agent_version' ? null : value), 2) + '\n';
}

export const codexAgent: Agent = {
  id: 'codex',
  label: 'Codex',
  homeEnv: 'CODEX_HOME',
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

    const entries: Entry[] = [];

    // The catalog is optional: an older Codex simply keeps its built-in models.
    let catalogSource: string | undefined;
    const models = await probe(binary, ['debug', 'models'], { HOME: layout.home, CODEX_HOME: home, PATH: layout.searchPath });
    if (models.ok) {
      try { catalogSource = renderCatalog(JSON.parse(models.stdout)); } catch { catalogSource = undefined; }
    }
    if (!catalogSource) checks.push({ id: 'codex.catalog', status: 'warn', message: 'Codex model catalog unavailable; roles keep the default catalog.' });

    const shared = await existingPaths(home, SHARED);
    for (const role of roles) {
      const target = roleHome(layout, 'codex', role);
      const catalogPath = catalogSource ? join(target, CATALOG) : undefined;
      const roleDocument = renderInstructions(role);
      entries.push({ kind: 'dir', path: target });
      // Codex reads the brief from developer_instructions; this copy is for the operator.
      entries.push({ kind: 'file', path: join(target, 'role-instructions.md'), content: roleDocument });
      entries.push({
        kind: 'file',
        path: join(target, 'config.toml'),
        content: renderRoleConfig(source, { roleDocument, ...(catalogPath ? { catalogPath } : {}) }),
      });
      if (catalogSource && catalogPath) entries.push({ kind: 'file', path: catalogPath, content: catalogSource });
      for (const path of shared) entries.push({ kind: 'link', path: join(target, basename(path)), target: path });
    }
    return { entries, checks, binary };
  },
};
