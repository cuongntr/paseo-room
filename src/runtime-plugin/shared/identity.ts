/**
 * Identity of the opt-in runtime coordination plugin. Shared by the server and client entries,
 * and by the CLI that provisions it, so the id and the supported Paseo range have one source.
 *
 * Separate from `paseo-room-claude-carrier` on purpose: a runtime fault must never remove or
 * rewrite the Claude contract carrier (docs/design/runtime-coordination.md D1).
 */
export const RUNTIME_PLUGIN_ID = 'paseo-room-runtime';

/** `0.8.0` is the only live-qualified point; `0.9.0` is unqualified, so the bound is exclusive. */
export const RUNTIME_PASEO_RANGE = '>=0.8.0 <0.9.0';
