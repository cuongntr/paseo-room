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
 * A qualified minor line: from the patch that passed live qualification up to, but excluding,
 * `below` — a later patch found to change a surface the qualification relied on.
 */
export interface WorktreeLine {
  readonly from: string;
  readonly below?: string;
}

/**
 * Minor lines on which worktree dispatch is qualified (docs/design/runtime-coordination-phase2.md
 * §8, §9). A daemon qualifies at a line's `from` patch or a later release of the same minor, below
 * its `below`; an earlier patch, a prerelease or build-stamped version, another minor, or a version
 * the plugin cannot read refuses `isolation: 'worktree'` with `worktree_unqualified`. It is a
 * runtime check, not a change of the plugin's range. `0.9.1`: delta §9.2, 2026-09-23; its line,
 * §9.3, 2026-09-28.
 */
export const QUALIFIED_WORKTREE_LINES: readonly WorktreeLine[] = [{ from: '0.9.1' }];

/** Whether worktree dispatch is qualified on the daemon `version`. A line it cannot read qualifies nothing. */
export function worktreeQualified(version: string | undefined, lines: readonly WorktreeLine[] = QUALIFIED_WORKTREE_LINES): boolean {
  const daemon = releaseVersion(version);
  if (daemon === undefined) return false;
  return lines.some(line => {
    const from = releaseVersion(line.from);
    const below = line.below === undefined ? undefined : releaseVersion(line.below);
    if (from === undefined || (line.below !== undefined && below === undefined)) return false;
    return from[0] === daemon[0] && from[1] === daemon[1] && !precedes(daemon, from) && (below === undefined || precedes(daemon, below));
  });
}

type Release = readonly [number, number, number];

/** `major.minor.patch` of a release version; a prerelease, build or malformed version has none. */
function releaseVersion(version: string | undefined): Release | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether release `a` comes before release `b`. */
function precedes(a: Release, b: Release): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}
