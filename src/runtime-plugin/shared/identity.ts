/**
 * Identity of the opt-in runtime coordination plugin. Shared by the server and client entries,
 * and by the CLI that provisions it, so the id and the supported Paseo range have one source.
 *
 * Separate from `paseo-room-claude-carrier` on purpose: a runtime fault must never remove or
 * rewrite the Claude contract carrier (docs/design/runtime-coordination.md D1).
 */
export const RUNTIME_PLUGIN_ID = 'paseo-room-runtime';

/**
 * The manifest's `requirements.paseo`: the CLI's compatibility floor, and no upper bound. Paseo
 * releases faster than each could be read before the room runs on it, so a new release is admitted
 * unread (docs/design/runtime-coordination.md §14, 2026-09-29). `0.8.0` and `0.9.1` are the
 * live-qualified points. Paseo still requires a range here: a plugin without one targets Paseo
 * before `0.8`.
 */
export const RUNTIME_PASEO_RANGE = '>=0.8.0';

/**
 * The first Paseo release worktree dispatch passed live qualification on
 * (docs/design/runtime-coordination-phase2.md §8, §9.2); there is no upper bound (§9.4). An earlier
 * release, a prerelease or build-stamped version, or a version the plugin cannot read refuses
 * `isolation: 'worktree'` with `worktree_unqualified`.
 */
export const WORKTREE_PASEO_FLOOR = '0.9.1';

/** Whether worktree dispatch is qualified on the daemon `version`: a release at or above `floor`. */
export function worktreeQualified(version: string | undefined, floor: string = WORKTREE_PASEO_FLOOR): boolean {
  const daemon = releaseVersion(version);
  const from = releaseVersion(floor);
  return daemon !== undefined && from !== undefined && !precedes(daemon, from);
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
