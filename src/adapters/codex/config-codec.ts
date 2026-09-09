import { parse, stringify, type TomlTable } from 'smol-toml';
import type { RoomRole } from '../../room/roles.js';
import { renderDeveloperInstructions } from '../../room/instructions/index.js';

function table(parent: TomlTable, key: string): TomlTable {
  const value = parent[key];
  if (value === undefined) return parent[key] = {};
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw new Error('Unsupported Codex native-agent settings representation.');
  }
  return value;
}

/** Semantic copy; only the contract allowlist is overwritten. Never emits source diagnostics. */
export function renderRoleConfig(source: string, role: RoomRole, instructionsPath: string, catalogPath: string): string {
  try {
    const config = parse(source);
    if (config.profile !== undefined) throw new Error('Active legacy profiles are incompatible with managed role overlays.');
    config.model = 'gpt-5.6-sol';
    config.model_reasoning_effort = 'medium';
    config.sandbox_mode = 'danger-full-access';
    config.approval_policy = 'never';
    config.model_instructions_file = instructionsPath;
    config.developer_instructions = renderDeveloperInstructions(role);
    config.model_catalog_json = catalogPath;
    table(config, 'agents').enabled = false;
    const features = table(config, 'features');
    features.multi_agent = false;
    if (typeof features.multi_agent_v2 === 'boolean') features.multi_agent_v2 = false;
    else table(features, 'multi_agent_v2').enabled = false;
    return stringify(config) + '\n';
  } catch {
    throw new Error('Cannot render canonical Codex config; check TOML syntax and native-agent settings compatibility.');
  }
}

/** Traverse JSON metadata without dropping fields or mutating the discovery catalog. */
export function renderModelCatalog(catalog: unknown): string {
  try {
    if (catalog === null || typeof catalog !== 'object') throw new Error();
    return JSON.stringify(catalog, (key: string, value: unknown) => key === 'multi_agent_version' ? null : value, 2) + '\n';
  } catch {
    throw new Error('Cannot render Codex model catalog; repeat compatible debug models discovery.');
  }
}
