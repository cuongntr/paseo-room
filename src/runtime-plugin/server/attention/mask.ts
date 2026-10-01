/**
 * Masking of agent text before it leaves the runtime (docs/design/runtime-coordination-attention.md
 * §6.2, A-D7). Applied to every excerpt the runtime sends anywhere — a letter to a Supervisor, or
 * the sensor's state — so a credential an agent printed is never repeated by the room. The order
 * matters: whole secret blocks first, then shaped tokens, then assignments, then URLs, and network
 * identifiers last when asked.
 */

export interface MaskOptions {
  readonly networkIdentifiers: boolean;
}

type Replacement = string | ((match: string, ...groups: string[]) => string);

/**
 * A plain word a sentence uses for a credential, as opposed to a key naming one (`GITLAB_TOKEN`,
 * `apiKey`, or the same word in capitals, `TOKEN`).
 */
const PROSE_WORD = /^(?:tokens?|secrets?|passwords?|passwd|credentials?)$/i;

/**
 * Whether a value is shaped like a credential rather than a word: long, or with a digit, a capital
 * inside it or a base64 sign. "Keycloak" and "authentication" are words; `dXNlcjpwYXNz` is not.
 */
function credentialShaped(value: string): boolean {
  return value.length >= 24 || (value.length >= 6 && /\d|[a-z][A-Z]|[+/=]/.test(value));
}

/** An authorization scheme followed by a word is prose ("token Keycloak", "Basic authentication"). */
function scheme(match: string, name: string, value: string): string {
  return credentialShaped(value) ? `${name} [secret]` : match;
}

/**
 * `key: value`, `key=value` or `"key": value` naming a credential. A plain word before a bare colon
 * is prose unless the value is credential-shaped ("create a token: name it"), and a value with no
 * letter or digit is never one ("a token:**").
 */
function assignment(match: string, key: string, separator: string, _quote: string, value: string): string {
  const prose = PROSE_WORD.test(key) && key !== key.toUpperCase() && /^\s*:\s*$/.test(separator);
  return !/[A-Za-z0-9]/.test(value) || (prose && !credentialShaped(value)) ? match : `${key}${separator}[secret]`;
}

const RULES: readonly (readonly [RegExp, Replacement])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key]'],
  // A header carries a credential whatever its shape; elsewhere only a credential-shaped one counts.
  [/\b(Authorization:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[secret]'],
  [/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi, scheme],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(?:sk|pk|rk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{12,}\b/g, '[secret]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[secret]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;]+)\3/gi, assignment],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[user]@'],
  [/(\bhttps?:\/\/[^\s?#"'`<>]+)\?[^\s#"'`<>]*/gi, '$1?[query]'],
];

const NETWORK_RULES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]'],
  [/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}(?:internal|local|lan|corp|intra|vn|com|net|org|io|cloud)\b/gi, '[host]'],
];

export function mask(text: string, options: MaskOptions = { networkIdentifiers: true }): string {
  let masked = text;
  for (const [pattern, replacement] of RULES) masked = typeof replacement === 'string' ? masked.replace(pattern, replacement) : masked.replace(pattern, replacement);
  if (options.networkIdentifiers) for (const [pattern, replacement] of NETWORK_RULES) masked = masked.replace(pattern, replacement);
  return masked;
}

/** Collapses whitespace and keeps the first `max` characters, for a line whose point comes first. */
export function head(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Collapses whitespace and keeps the last `max` characters, where a turn's conclusion usually is. */
export function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `…${flat.slice(flat.length - max + 1)}`;
}
