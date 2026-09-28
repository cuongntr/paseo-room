/**
 * Identity of the opt-in runtime coordination plugin. Shared by the server and client entries,
 * and by the CLI that provisions it, so the id and the supported Paseo range have one source.
 *
 * Separate from `paseo-room-claude-carrier` on purpose: a runtime fault must never remove or
 * rewrite the Claude contract carrier (docs/design/runtime-coordination.md D1).
 */
export const RUNTIME_PLUGIN_ID = 'paseo-room-runtime';

/**
 * `0.8.0` and `0.9.1` are the live-qualified points. `0.9.x` carries a byte-identical plugin
 * compiler, unchanged lifecycle hooks and an unchanged provider/profile config schema, so the
 * host contract this plugin depends on is the same one `0.8.0` was qualified against. `0.10.0`
 * is unqualified, so the bound stays exclusive.
 */
export const RUNTIME_PASEO_RANGE = '>=0.8.0 <0.10.0';

/**
 * Minor lines on which worktree dispatch is qualified, each named by the patch that passed live
 * qualification (docs/design/runtime-coordination-phase2.md §8, §9). A daemon qualifies at that
 * patch or a later release of the same minor; an earlier patch, a prerelease, another minor, or a
 * version the plugin cannot read refuses `isolation: 'worktree'` with `worktree_unqualified`. It is
 * a runtime check, not a change of the plugin's range. `0.9.1`: delta §9.2, 2026-09-23; its line,
 * §9.3, 2026-09-28.
 */
export const QUALIFIED_WORKTREE_LINES: readonly string[] = ['0.9.1'];

/** Whether worktree dispatch is qualified on the daemon `version`. */
export function worktreeQualified(version: string | undefined, lines: readonly string[] = QUALIFIED_WORKTREE_LINES): boolean {
  const daemon = releaseVersion(version);
  if (daemon === undefined) return false;
  return lines.some(line => {
    const floor = releaseVersion(line);
    return floor !== undefined && floor[0] === daemon[0] && floor[1] === daemon[1] && daemon[2] >= floor[2];
  });
}

/** `major.minor.patch` of a release version; a prerelease, build or malformed version has none. */
function releaseVersion(version: string | undefined): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}
