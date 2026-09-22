/** Shared event fixtures for runtime domain tests: a monotonic ledger for one project. */
import { EVENT_SCHEMA, validateForWrite, type RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';

export const PROJECT = '6f1c1f3e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
export const DIGEST = `sha256:${'c'.repeat(64)}`;
export const A = 'asg_writable01';
export const B = 'asg_writable02';
export const R = 'asg_readonly01';

let sequence = 0;
export function ev(type: string, data: Record<string, unknown>, assignmentId?: string): RuntimeEventV1 {
  sequence += 1;
  return validateForWrite({
    schema: EVENT_SCHEMA, version: 1, type, payloadVersion: 1, id: `evt_test${String(sequence).padStart(6, '0')}`,
    sequence, projectId: PROJECT, actor: { source: 'plugin' }, occurredAt: '2026-09-22T10:00:00.000Z', data,
    ...(assignmentId === undefined ? {} : { assignmentId }),
  });
}

export const gate = { command: 'npm run verify', timeoutSeconds: 600, runtimeRerun: 'optional', processContractVersion: 1 };
export function created(id: string, mode: 'writable' | 'read-only' = 'writable'): RuntimeEventV1 {
  return ev('assignment.created', {
    input: {
      mode, kind: mode === 'writable' ? 'engineer' : 'reviewer', outcome: 'Do it', prerequisites: [],
      writeScope: mode === 'writable' ? ['src/'] : [], exclusions: ['none'], invariants: [], acceptanceEvidence: [],
      expectedHandoff: ['commit'], reopenConditions: [], baseCommit: BASE, ...(mode === 'writable' ? { gate } : {}),
    },
    leadAgentId: 'lead-1', leadProviderId: 'codex-lead',
  }, id);
}
export const candidate = { kind: 'git-commit', commit: HEAD, baseCommit: BASE, changedPaths: ['src/a.ts'], workspaceId: 'ws1' };
export const receipt = (tool: string, assignmentState: string): Record<string, unknown> => ({ schema: 1, receipt: `rcpt_${String(sequence)}`, tool, status: 'accepted', assignmentState });

/** Dispatch through binding, held ownership and the first run. */
export function dispatched(id: string, mode: 'writable' | 'read-only' = 'writable', agent = `peer-${id}`): RuntimeEventV1[] {
  return [
    created(id, mode),
    ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: 'ws1' }, id),
    ...(mode === 'writable' ? [ev('ownership.reserved', { workspaceId: 'ws1', baseCommit: BASE }, id)] : []),
    ev('agent.create-requested', { intentId: `create-${id}`, peerProviderId: 'codex-peer', workspaceId: 'ws1', parentAgentId: 'lead-1', label: id }, id),
    ev('agent.create-succeeded', { intentId: `create-${id}`, agentId: agent }, id),
    ev('binding.published', { agentId: agent, providerId: 'codex-peer', model: 'gpt-5', parentAgentId: 'lead-1', workspaceId: 'ws1', roomGeneration: 'g1' }, id),
    ...(mode === 'writable' ? [ev('ownership.held', { agentId: agent }, id)] : []),
    ev('reporting.generation-opened', { generation: 1, capabilityHash: DIGEST, turn: 'initial' }, id),
    ev('run.requested', { intentId: `run-${id}-1`, generation: 1, promptDigest: DIGEST }, id),
    ev('run.succeeded', { intentId: `run-${id}-1`, generation: 1 }, id),
  ];
}

