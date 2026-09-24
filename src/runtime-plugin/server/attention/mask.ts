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

const RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [secret]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(?:sk|pk|rk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{12,}\b/g, '[secret]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[secret]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"'`,;]+\3/gi, '$1$2[secret]'],
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
  for (const [pattern, replacement] of RULES) masked = masked.replace(pattern, replacement);
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
