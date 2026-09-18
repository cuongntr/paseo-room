import { fail, type Check } from '../result.js';

/**
 * The bounded heuristic: `paseo` as a whole identifier or path token, including a
 * lower-to-upper camel-case boundary. It is not embedded in a larger word, so `paseo`,
 * `paseo-mcp`, `/opt/paseo/bin/serve` and `paseoRoom` match while `grapaseo`,
 * `paseonaut` and `PASEONAUT` do not.
 *
 * This recognizes an obvious configuration collision and says why it matched. It is not a
 * scanner for a hostile or obfuscated endpoint, and matching nothing proves nothing.
 */
const PASEO_TOKEN = /(?<![\p{L}\p{N}])[Pp][Aa][Ss][Ee][Oo](?=$|[^\p{L}\p{N}]|\p{Lu}\p{Ll})/u;

/** Declaration fields that name what a server runs or connects to. */
const VALUE_FIELDS = ['command', 'url', 'serverUrl', 'httpUrl', 'endpoint'] as const;
/** Declaration fields that carry a list of such values. */
const LIST_FIELDS = ['args'] as const;

/** One recognizable declaration, kept so the diagnostic can state its own evidence. */
export interface McpMatch {
  readonly server: string;
  /** `name`, or the declaration field that carried the token. */
  readonly field: 'name' | (typeof VALUE_FIELDS)[number] | (typeof LIST_FIELDS)[number];
  readonly value: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An MCP declaration map exactly as an already-parsed config carries it. */
export function serverTable(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

/** Names one side declares and the other does not, in both directions. */
export interface NameDivergence {
  /** Declared for the operator but absent from the compared side. */
  readonly missing: readonly string[];
  /** Declared by the compared side but no longer by the operator. */
  readonly extra: readonly string[];
}

/**
 * Compare two declaration maps by server name alone. Used for seed-once runtime state the
 * room must not synchronize: a name difference is reportable, and nothing about what those
 * servers run is compared, copied, or written back.
 */
export function serverNameDivergence(
  operator: Readonly<Record<string, unknown>>,
  compared: Readonly<Record<string, unknown>>,
): NameDivergence | undefined {
  const operatorNames = new Set(Object.keys(operator));
  const comparedNames = new Set(Object.keys(compared));
  const missing = [...operatorNames].filter(name => !comparedNames.has(name)).sort();
  const extra = [...comparedNames].filter(name => !operatorNames.has(name)).sort();
  return missing.length === 0 && extra.length === 0 ? undefined : { missing, extra };
}

/**
 * The declaration maps inside a JSON configuration file, read through the named keys only:
 * nothing else in the document — history, credentials, runtime state — is inspected.
 *
 * Every named key is merged, in the order given, because an agent that accepts more than one
 * key loads all of them: stopping at the first table would let a benign one hide a Paseo
 * declaration under a later key. A name declared twice keeps the earlier key's entry at its
 * own name and the later one under a key-qualified name, so no declaration is lost. Invalid
 * JSON, a non-object root, or a named declaration value that is not an object is rejected:
 * an unparseable source cannot truthfully be reported as inspected and clean.
 */
export function jsonServerTable(source: string | undefined, keys: readonly string[]): Record<string, unknown> {
  if (source === undefined) return {};
  const root = asRecord(JSON.parse(source));
  if (!root) throw new TypeError('MCP configuration must be a JSON object.');
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const value = root[key];
    if (value === undefined) continue;
    const table = asRecord(value);
    if (!table) throw new TypeError(`${key} must be a JSON object.`);
    for (const [server, declaration] of Object.entries(table)) {
      merged[server in merged ? `${server} (${key})` : server] = declaration;
    }
  }
  return merged;
}

/** Every recognizably Paseo-related declaration, with the evidence that recognized it. */
export function detectPaseoServers(servers: Readonly<Record<string, unknown>>): McpMatch[] {
  const matches: McpMatch[] = [];
  for (const [server, declaration] of Object.entries(servers)) {
    if (PASEO_TOKEN.test(server)) matches.push({ server, field: 'name', value: server });
    const fields = asRecord(declaration);
    if (!fields) continue;
    for (const field of VALUE_FIELDS) {
      const value = fields[field];
      if (typeof value === 'string' && PASEO_TOKEN.test(value)) matches.push({ server, field, value });
    }
    for (const field of LIST_FIELDS) {
      const list = fields[field];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === 'string' && PASEO_TOKEN.test(item)) matches.push({ server, field, value: item });
      }
    }
  }
  return matches;
}

function evidence(match: McpMatch): string {
  return match.field === 'name' ? `${match.server} (server name)` : `${match.server} (${match.field}: ${match.value})`;
}

/**
 * Paseo is the room's only control plane, so a Peer-visible MCP server that looks like a
 * second one fails before anything is applied. The room never edits operator configuration:
 * the fix names the source file and leaves the decision with the operator.
 */
export function paseoMcpCheck(id: string, path: string, servers: Readonly<Record<string, unknown>>): Check | undefined {
  const matches = detectPaseoServers(servers);
  if (matches.length === 0) return undefined;
  return fail(id,
    `${path} declares MCP servers that are recognizably Paseo-related: ${matches.map(evidence).join('; ')}.`,
    `Remove or rename those servers in ${path} so no room seat reaches Paseo outside its own seat, then run setup again. paseo-room never edits your MCP configuration, and this name check is a bounded heuristic rather than a sandbox.`);
}
