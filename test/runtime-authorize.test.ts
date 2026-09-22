import { describe, expect, it } from 'vitest';
import { LEAD_OPERATIONS, PEER_REPORTING_TOOLS, RUNTIME_CAPABILITIES, runtimeRolePolicy, SUPERVISOR_OPERATIONS } from '../src/runtime-plugin/shared/policy.js';
import { authorizeProvider, authorizeRole } from '../src/runtime-plugin/server/domain/authorize.js';
import { validateAssignmentCreate } from '../src/runtime-plugin/server/domain/validate.js';
import { ROLE_PEER_REPORTING, ROLES } from '../src/roles.js';

const allowed: Record<(typeof ROLES)[number], readonly string[]> = {
  supervisor: SUPERVISOR_OPERATIONS,
  lead: LEAD_OPERATIONS,
  peer: PEER_REPORTING_TOOLS,
};

describe('runtime capability authorization', () => {
  it('grants each role exactly its own operations and refuses every cross-role call', () => {
    for (const role of ROLES) {
      for (const operation of RUNTIME_CAPABILITIES) {
        const result = authorizeRole(role, operation, ROLE_PEER_REPORTING[role]);
        expect(result.ok, `${role} → ${operation}`).toBe(allowed[role].includes(operation));
      }
    }
  });

  it('refuses the operations D4 names as explicitly absent', () => {
    const absent: [(typeof ROLES)[number], string][] = [
      ['supervisor', 'assignment_dispatch'], ['supervisor', 'assignment_accept'], ['supervisor', 'gate_run'],
      ['supervisor', 'ask'], ['lead', 'handoff'], ['lead', 'ask'],
      ['peer', 'assignment_accept'], ['peer', 'assignment_dispatch'], ['peer', 'room_status'],
      ['peer', 'runtime_findings'], ['peer', 'message_lead'], ['peer', 'assignment_close'], ['peer', 'gate_run'],
    ];
    for (const [role, operation] of absent) {
      expect(authorizeRole(role, operation, true)).toMatchObject({ ok: false, code: 'unauthorized' });
    }
    expect(authorizeRole('lead', 'create_agent', false)).toMatchObject({ ok: false, code: 'unknown_operation' });
  });

  it('gives an ineligible Peer nothing, and never trusts a manifest entry broader than policy', () => {
    for (const tool of PEER_REPORTING_TOOLS) expect(authorizeRole('peer', tool, false).ok).toBe(false);
    const forged = { agent: 'codex' as const, role: 'peer' as const, capabilities: ['ask', 'handoff', 'assignment_accept'] };
    expect(authorizeProvider(forged, 'assignment_accept').ok).toBe(false);
    // Without the reporting declaration even the pair is refused.
    expect(authorizeProvider({ agent: 'pi', role: 'peer', capabilities: ['ask'] }, 'ask').ok).toBe(false);
    const peer = runtimeRolePolicy('peer', true);
    expect(authorizeProvider({ agent: 'claude', role: 'peer', capabilities: [...peer.capabilities], peerReporting: { protocol: 1, tools: ['ask', 'handoff'], qualifiedVia: 'exact-room-provider' } }, 'handoff').ok).toBe(true);
  });
});

describe('assignment creation validation', () => {
  const writable = {
    mode: 'writable', kind: 'engineer', outcome: 'Add the export command', prerequisites: [], writeScope: ['src/export.ts'],
    exclusions: ['No change to setup'], invariants: [], acceptanceEvidence: ['tests'], expectedHandoff: ['a commit'],
    reopenConditions: [], baseCommit: 'd'.repeat(40),
    gate: { command: 'npm run verify', timeoutSeconds: 900, runtimeRerun: 'optional', processContractVersion: 1 },
  };
  const readOnly = { ...writable, mode: 'read-only', kind: 'reviewer', writeScope: [], gate: undefined };

  it('accepts complete writable and read-only briefs', () => {
    expect(validateAssignmentCreate(writable).ok).toBe(true);
    // JSON round-trip drops the undefined gate, as it would arrive over the bridge.
    expect(validateAssignmentCreate(JSON.parse(JSON.stringify(readOnly))).ok).toBe(true);
  });

  it('refuses each incomplete brief with an actionable code', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...writable, outcome: '   ' }, 'outcome_empty'],
      [{ ...writable, kind: 'scout' }, 'mode_kind_mismatch'],
      [{ ...readOnly, kind: 'engineer' }, 'mode_kind_mismatch'],
      [{ ...writable, writeScope: [] }, 'scope_missing'],
      [{ ...writable, writeScope: [' '] }, 'scope_missing'],
      [{ ...readOnly, writeScope: ['src/'] }, 'scope_on_read_only'],
      [{ ...writable, exclusions: [] }, 'exclusions_missing'],
      [{ ...writable, expectedHandoff: [] }, 'handoff_missing'],
      [{ ...writable, gate: undefined }, 'gate_missing'],
      [{ ...writable, gate: { ...writable.gate, command: '  ' } }, 'gate_missing'],
      [{ ...writable, model: 'gpt' }, 'assignment_malformed'],
      [{ ...writable, mode: undefined }, 'assignment_malformed'],
    ];
    for (const [input, code] of cases) {
      const result = validateAssignmentCreate(JSON.parse(JSON.stringify(input)));
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.errors.map(error => error.code), code).toContain(code);
    }
  });
});
