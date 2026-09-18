/**
 * Composition rule for the room's Claude creation-time contract carrier.
 *
 * Kept free of every import — including the plugin SDK — so the daemon's plugin compiler
 * needs no installed dependency inside the room plugin directory, and so this repository can
 * unit-test the rule directly.
 */

/** Opens the room-owned block, so an already-carried prompt is recognisable without parsing. */
export const CONTRACT_MARKER_PREFIX = '<!-- paseo-room-contract:';

export function contractMarker(generation: string): string {
  return `${CONTRACT_MARKER_PREFIX}${generation} -->`;
}

/** True only when the prompt ends with the complete current room-owned block. */
export function hasExactContract(
  existing: string | undefined,
  contract: string,
  generation: string,
): boolean {
  return existing?.endsWith(`${contractMarker(generation)}\n${contract}`) === true;
}

/**
 * Appends the role contract to whatever prompt the caller already asked for, rather than
 * replacing it. The room block is always last and always marked, so a prompt that already
 * carries one is rewritten in place instead of gaining a second copy.
 */
export function composeSystemPrompt(
  existing: string | undefined,
  contract: string,
  generation: string,
): string {
  const raw = existing ?? '';
  const marker = CONTRACT_MARKER_PREFIX;
  const index = raw.indexOf(marker);
  const base = (index === -1 ? raw : raw.slice(0, index)).trimEnd();
  const block = `${contractMarker(generation)}\n${contract}`;
  return base ? `${base}\n\n${block}` : block;
}
