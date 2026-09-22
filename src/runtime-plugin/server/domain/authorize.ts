/**
 * Capability authorization (docs/design/runtime-coordination.md D4).
 *
 * Every decision is derived from the shared role-policy projection — the same data the CLI
 * writes into the room manifest — never from a second hand-written table, a label or a title.
 */
import type { RuntimeManifestProvider } from '../../shared/manifest.js';
import { RUNTIME_CAPABILITIES, runtimeRolePolicy, type RuntimeCapability, type RuntimeRole } from '../../shared/policy.js';

export type Authorization =
  | { readonly ok: true; readonly operation: RuntimeCapability }
  | { readonly ok: false; readonly code: 'unknown_operation' | 'unauthorized'; readonly message: string };

export function isRuntimeCapability(operation: string): operation is RuntimeCapability {
  return (RUNTIME_CAPABILITIES as readonly string[]).includes(operation);
}

/** May an exact room provider, as declared in the generated manifest, invoke this operation? */
export function authorizeProvider(entry: RuntimeManifestProvider, operation: string): Authorization {
  if (!isRuntimeCapability(operation)) return { ok: false, code: 'unknown_operation', message: `${operation} is not a runtime operation.` };
  // The manifest entry is re-derived from policy, so a tampered or stale capability list that
  // is broader than the role's projection still cannot authorize anything outside it.
  const policy = runtimeRolePolicy(entry.role, entry.peerReporting !== undefined);
  if (!policy.capabilities.includes(operation) || !entry.capabilities.includes(operation)) {
    return { ok: false, code: 'unauthorized', message: `The ${entry.role} seat may not invoke ${operation}.` };
  }
  return { ok: true, operation };
}

/** The role-level form used by operator surfaces and tests. */
export function authorizeRole(role: RuntimeRole, operation: string, peerReportingEligible: boolean): Authorization {
  const policy = runtimeRolePolicy(role, peerReportingEligible);
  return authorizeProvider({
    agent: 'codex', role, capabilities: [...policy.capabilities],
    ...(policy.peerReporting === undefined ? {} : { peerReporting: { ...policy.peerReporting, tools: ['ask', 'handoff'] } }),
  }, operation);
}
