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
 * Daemon versions on which worktree dispatch passed live qualification
 * (docs/design/runtime-coordination-phase2.md §9). Any other version — or one the plugin cannot
 * read — refuses `isolation: 'worktree'` with `worktree_unqualified`; it is a runtime check, not a
 * change of the plugin's range. `0.9.1`: delta §9.2, 2026-09-23.
 */
export const QUALIFIED_WORKTREE_DAEMONS: readonly string[] = ['0.9.1'];
