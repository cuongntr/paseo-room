import { describe, expect, it } from 'vitest';
import { AGENT_IDS, ROLES } from '../src/roles.js';
import { MAX_AGGREGATE_BYTES, MAX_ARRAY_ITEMS, MAX_COMMAND_BYTES, MAX_STRING_BYTES } from '../src/runtime-plugin/shared/limits.js';
import { runtimeRoomManifestSchema } from '../src/runtime-plugin/shared/manifest.js';
import {
  LEAD_OPERATIONS, PEER_REPORTING_TOOLS, RUNTIME_AGENTS, RUNTIME_ROLES, runtimeRolePolicy, SUPERVISOR_OPERATIONS,
} from '../src/runtime-plugin/shared/policy.js';
import { runtimeRpcErrorSchema, runtimeRpcResponseSchema } from '../src/runtime-plugin/shared/rpc.js';
import { LEAD_ACTION_SCHEMAS, SUPERVISOR_ACTION_SCHEMAS } from '../src/runtime-plugin/server/contracts/actions.js';
import { assignmentCreateSchema } from '../src/runtime-plugin/server/contracts/assignment.js';
import { bridgeRequestSchema } from '../src/runtime-plugin/server/contracts/envelope.js';
import {
  askInputSchema, parsePeerToolInput, peerReportErrorSchema, peerReportReceiptSchema,
} from '../src/runtime-plugin/server/contracts/peer.js';
import { z } from 'zod';

const COMMIT = 'a'.repeat(40);

function manifest(providers: Record<string, unknown>): unknown {
  return { schema: 1, roomGeneration: 'r1', contractGeneration: 'c1', reportingPolicyGeneration: 'p1', providers };
}

const peerEntry = { agent: 'codex', role: 'peer', ...runtimeRolePolicy('peer', true) };

const ask = { question: 'Which base?', blockingContext: 'Two candidates exist.', evidence: ['git log'] };
const handoffBase = {
  summary: 'Done', deliverables: ['src/x.ts'], residualRisks: [], evidence: ['npm run verify'],
  verification: [{ command: 'npm run verify', outcome: 'passed' }],
};

describe('runtime role policy projection', () => {
  it('uses the same role and agent vocabulary as the CLI', () => {
    expect([...RUNTIME_ROLES]).toEqual([...ROLES]);
    expect([...RUNTIME_AGENTS]).toEqual([...AGENT_IDS]);
  });

  it('gives Peer at most the closed reporting pair and nothing when not eligible', () => {
    expect(runtimeRolePolicy('peer', true).capabilities).toEqual(['ask', 'handoff']);
    expect(runtimeRolePolicy('peer', false)).toEqual({ capabilities: [] });
    expect(runtimeRolePolicy('supervisor', true).capabilities).toEqual([...SUPERVISOR_OPERATIONS]);
    expect(runtimeRolePolicy('lead', true).capabilities).toEqual([...LEAD_OPERATIONS]);
    expect(runtimeRolePolicy('lead', true).peerReporting).toBeUndefined();
    expect(LEAD_OPERATIONS).toHaveLength(12);
    expect(PEER_REPORTING_TOOLS).toEqual(['ask', 'handoff']);
  });
});

describe('room manifest schema', () => {
  it('accepts the exact projection for every role', () => {
    expect(runtimeRoomManifestSchema.safeParse(manifest({
      'codex-supervisor': { agent: 'codex', role: 'supervisor', ...runtimeRolePolicy('supervisor', false) },
      'codex-lead': { agent: 'codex', role: 'lead', ...runtimeRolePolicy('lead', false) },
      'codex-peer': peerEntry,
    })).success).toBe(true);
  });

  it('refuses broader, foreign or misplaced declarations', () => {
    const refused = [
      { ...peerEntry, peerReporting: { ...peerEntry.peerReporting, tools: ['ask', 'handoff', 'room_status'] } },
      { ...peerEntry, peerReporting: { ...peerEntry.peerReporting, tools: ['handoff', 'ask'] } },
      { ...peerEntry, capabilities: ['ask', 'handoff', 'assignment_accept'] },
      { ...peerEntry, peerReporting: undefined },
      { agent: 'codex', role: 'lead', capabilities: [...LEAD_OPERATIONS], peerReporting: peerEntry.peerReporting },
      { agent: 'codex', role: 'supervisor', capabilities: ['room_status'] },
      { ...peerEntry, extra: true },
    ];
    for (const entry of refused) {
      expect(runtimeRoomManifestSchema.safeParse(manifest({ 'codex-peer': entry })).success).toBe(false);
    }
    expect(runtimeRoomManifestSchema.safeParse(manifest({ 'Codex Peer*': peerEntry })).success).toBe(false);
    expect(runtimeRoomManifestSchema.safeParse({ ...(manifest({}) as object), schema: 2 }).success).toBe(false);
  });
});

describe('Peer reporting tool contracts', () => {
  it('accepts a valid ask and a valid handoff for the bound kind', () => {
    expect(parsePeerToolInput('ask', 'engineer', ask).ok).toBe(true);
    expect(parsePeerToolInput('handoff', 'engineer', { ...handoffBase, completion: 'complete', details: { kind: 'engineer' } }).ok).toBe(true);
    expect(parsePeerToolInput('handoff', 'scout', {
      ...handoffBase, completion: 'complete',
      details: { kind: 'scout', evidence: ['a'], remainingUnknowns: [], confidence: 'medium' },
    }).ok).toBe(true);
    expect(parsePeerToolInput('handoff', 'reviewer', { ...handoffBase, completion: 'blocked', blocker: 'No access' }).ok).toBe(true);
  });

  it('rejects identity, unknown fields, wrong kinds and misplaced blockers', () => {
    const refused: [Parameters<typeof parsePeerToolInput>[0], Parameters<typeof parsePeerToolInput>[1], unknown][] = [
      ['ask', 'engineer', { ...ask, assignmentId: 'asg_12345678' }],
      ['ask', 'engineer', { ...ask, recipient: 'lead' }],
      ['ask', 'engineer', { question: 'x', blockingContext: 'y' }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'complete', details: { kind: 'architect' } }],
      ['handoff', 'architect', { ...handoffBase, completion: 'complete', details: { kind: 'engineer' } }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'complete', details: { kind: 'engineer' }, blocker: 'x' }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'partial' }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'complete', details: { kind: 'engineer' }, candidate: COMMIT }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'done', details: { kind: 'engineer' } }],
      ['handoff', 'engineer', { ...handoffBase, completion: 'complete', details: { kind: 'engineer' }, verification: [{ command: 'x', outcome: 'skipped' }] }],
    ];
    for (const [tool, kind, raw] of refused) expect(parsePeerToolInput(tool, kind, raw).ok).toBe(false);
  });

  it('enforces string, array, command and aggregate bounds in UTF-8 bytes', () => {
    expect(askInputSchema.safeParse({ ...ask, question: '' }).success).toBe(false);
    expect(askInputSchema.safeParse({ ...ask, question: 'x'.repeat(MAX_STRING_BYTES) }).success).toBe(true);
    expect(askInputSchema.safeParse({ ...ask, question: 'x'.repeat(MAX_STRING_BYTES + 1) }).success).toBe(false);
    // Three bytes per character: counted in bytes, not code units.
    expect(askInputSchema.safeParse({ ...ask, question: '€'.repeat(Math.floor(MAX_STRING_BYTES / 3) + 1) }).success).toBe(false);
    expect(askInputSchema.safeParse({ ...ask, evidence: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, () => 'e') }).success).toBe(false);

    const longCommand = { ...handoffBase, completion: 'blocked', blocker: 'b', verification: [{ command: 'x'.repeat(MAX_COMMAND_BYTES), outcome: 'failed' }] };
    expect(parsePeerToolInput('handoff', 'engineer', longCommand).ok).toBe(true);
    const tooLongCommand = { ...longCommand, verification: [{ command: 'x'.repeat(MAX_COMMAND_BYTES + 1), outcome: 'failed' }] };
    expect(parsePeerToolInput('handoff', 'engineer', tooLongCommand).ok).toBe(false);

    const big = { ...ask, evidence: Array.from({ length: 9 }, () => 'x'.repeat(MAX_STRING_BYTES)) };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_AGGREGATE_BYTES);
    expect(parsePeerToolInput('ask', 'engineer', big)).toEqual({ ok: false, message: 'Report exceeds the 64 KiB aggregate limit.' });
  });

  it('keeps receipts and errors closed and versioned', () => {
    expect(peerReportReceiptSchema.safeParse({ schema: 1, receipt: 'rcpt_1', tool: 'ask', status: 'accepted', assignmentState: 'questioned' }).success).toBe(true);
    expect(peerReportReceiptSchema.safeParse({ schema: 1, receipt: 'rcpt_1', tool: 'ask', status: 'accepted', assignmentState: 'questioned', assignmentId: 'x' }).success).toBe(false);
    expect(peerReportErrorSchema.safeParse({ schema: 1, error: { code: 'report_stale', message: 'Stale.', retryable: false } }).success).toBe(true);
    expect(peerReportErrorSchema.safeParse({ schema: 1, error: { code: 'report_other', message: 'x', retryable: false } }).success).toBe(false);
  });
});

describe('Phase 2 Lead action contracts', () => {
  const assignmentId = 'asg_abcdefgh';

  it('takes an optional isolation and serial-only paths on dispatch, and nothing else new', () => {
    const dispatch = LEAD_ACTION_SCHEMAS.assignment_dispatch;
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer' }).success).toBe(true);
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer', isolation: 'worktree', serialOnly: ['package-lock.json'] }).success).toBe(true);
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer', isolation: 'lead-workspace' }).success).toBe(true);
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer', isolation: 'container' }).success).toBe(false);
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer', workspaceId: 'wks_0000000000000000' }).success).toBe(false);
    expect(dispatch.safeParse({ assignmentId, peerProvider: 'codex-peer', serialOnly: Array.from({ length: 65 }, () => 'a') }).success).toBe(false);
  });

  it('closes a retained worktree, discarding its work only with a reason', () => {
    const close = LEAD_ACTION_SCHEMAS.workspace_close;
    expect(close.safeParse({ assignmentId }).success).toBe(true);
    expect(close.safeParse({ assignmentId, discardUncommitted: true, reason: 'The Peer\'s draft is superseded.' }).success).toBe(true);
    expect(close.safeParse({ assignmentId, discardUncommitted: true }).success).toBe(false);
    expect(close.safeParse({ assignmentId, discardUncommitted: false, reason: 'x' }).success).toBe(false);
    expect(close.safeParse({ assignmentId, force: true }).success).toBe(false);
  });

  it('reclaims a lease only with a reason', () => {
    const reclaim = LEAD_ACTION_SCHEMAS.lease_reclaim;
    expect(reclaim.safeParse({ assignmentId, reason: 'The Peer was archived mid-turn.' }).success).toBe(true);
    expect(reclaim.safeParse({ assignmentId }).success).toBe(false);
    expect(reclaim.safeParse({ assignmentId, reason: 'x', epoch: 2 }).success).toBe(false);
  });

  it('adds the two operations to Lead only, leaving Supervisor and Peer unchanged', () => {
    expect(LEAD_OPERATIONS.slice(-2)).toEqual(['workspace_close', 'lease_reclaim']);
    expect(SUPERVISOR_OPERATIONS).toEqual(['room_status', 'runtime_findings', 'message_lead', 'attention_feedback']);
    expect(PEER_REPORTING_TOOLS).toEqual(['ask', 'handoff']);
  });
});

describe('action and transport contracts', () => {
  const create = {
    mode: 'writable', kind: 'engineer', outcome: 'Add X', prerequisites: [], writeScope: ['src/x.ts'],
    exclusions: ['docs/'], invariants: [], acceptanceEvidence: ['tests'], expectedHandoff: ['commit'],
    reopenConditions: [], baseCommit: COMMIT,
    gate: { command: 'npm run verify', timeoutSeconds: 600, runtimeRerun: 'optional', processContractVersion: 1 },
  };

  it('types assignment creation strictly', () => {
    expect(assignmentCreateSchema.safeParse(create).success).toBe(true);
    expect(assignmentCreateSchema.safeParse({ ...create, model: 'x' }).success).toBe(false);
    expect(assignmentCreateSchema.safeParse({ ...create, baseCommit: 'abc123' }).success).toBe(false);
    expect(assignmentCreateSchema.safeParse({ ...create, gate: { ...create.gate, timeoutSeconds: 3_601 } }).success).toBe(false);
    expect(assignmentCreateSchema.safeParse({ ...create, gate: { ...create.gate, timeoutSeconds: 0 } }).success).toBe(false);
  });

  it('has exactly one payload schema per policy operation', () => {
    expect(Object.keys(LEAD_ACTION_SCHEMAS).sort()).toEqual([...LEAD_OPERATIONS].sort());
    expect(Object.keys(SUPERVISOR_ACTION_SCHEMAS).sort()).toEqual([...SUPERVISOR_OPERATIONS].sort());
    expect(LEAD_ACTION_SCHEMAS.assignment_dispatch.safeParse({ assignmentId: 'asg_abcdefgh', peerProvider: 'codex-peer', model: 'x' }).success).toBe(false);
    expect(LEAD_ACTION_SCHEMAS.assignment_accept.safeParse({ assignmentId: 'asg_abcdefgh', reason: 'ok', override: { reason: 'red', residualRiskAcknowledged: false } }).success).toBe(false);
  });

  it('versions the bridge envelope and the RPC envelopes', () => {
    const request = { protocol: 1, requestId: 'req_12345678', operation: 'ask', payload: ask, correlation: 'c' };
    expect(bridgeRequestSchema.safeParse(request).success).toBe(true);
    expect(bridgeRequestSchema.safeParse({ ...request, protocol: 2 }).success).toBe(false);
    expect(bridgeRequestSchema.safeParse({ ...request, agentId: 'x' }).success).toBe(false);

    const response = runtimeRpcResponseSchema(z.strictObject({ ok: z.boolean() }));
    expect(response.safeParse({ schema: 1, revision: 'r', data: { ok: true }, warnings: [] }).success).toBe(true);
    expect(response.safeParse({ schema: 1, revision: 'r', data: { ok: true, extra: 1 }, warnings: [] }).success).toBe(false);
    expect(runtimeRpcErrorSchema.safeParse({
      schema: 1, revision: 'r', warnings: [],
      error: { code: 'project_paused', message: 'Paused.', recoveryAction: 'Export, then inspect the event.', retryable: false },
    }).success).toBe(true);
  });
});
