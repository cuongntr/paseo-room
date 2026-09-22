import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA, EVENT_TYPES, readEvent, validateForWrite } from '../src/runtime-plugin/server/events/schema.js';

const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

function event(type: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: EVENT_SCHEMA, version: 1, type, payloadVersion: 1,
    id: 'evt_abcdefgh', sequence: 1, projectId: '6f1c1f3e-2a3b-4c5d-8e9f-0a1b2c3d4e5f',
    assignmentId: 'asg_abcdefgh', actor: { source: 'plugin' }, occurredAt: '2026-09-22T10:00:00.000Z',
    data, ...extra,
  };
}

const candidate = { kind: 'git-commit', commit: COMMIT, baseCommit: COMMIT, changedPaths: ['src/a.ts'], workspaceId: 'ws1' };

describe('runtime event union', () => {
  it('covers every Phase 1 lifecycle the store must record', () => {
    for (const type of [
      'project.bound', 'project.ownership-conflict', 'assignment.created', 'ownership.reserved', 'ownership.held',
      'ownership.released', 'ownership.uncertain', 'agent.create-requested', 'agent.create-uncertain', 'binding.published',
      'reporting.generation-opened', 'run.requested', 'run.uncertain', 'report.accepted', 'report.refused', 'report.missing',
      'report.uncertain', 'permission.awaiting', 'permission.resolved', 'assignment.accepted', 'archive.succeeded',
      'gate.requested', 'gate.finished', 'gate.uncertain', 'notice.pending', 'notice.sent', 'notice.uncertain',
    ]) expect(EVENT_TYPES).toContain(type);
  });

  it('accepts well-formed events for write', () => {
    expect(validateForWrite(event('ownership.reserved', { workspaceId: 'ws1', baseCommit: COMMIT })).type).toBe('ownership.reserved');
    expect(validateForWrite(event('run.requested', { intentId: 'i1', generation: 1, promptDigest: DIGEST })).type).toBe('run.requested');
    expect(validateForWrite(event('report.accepted', {
      generation: 2, tool: 'handoff', requestId: 'req_12345678', fingerprint: DIGEST,
      receipt: { schema: 1, receipt: 'rcpt_1', tool: 'handoff', status: 'accepted', assignmentState: 'handed-back' },
      report: { summary: 'Done' }, candidate,
    })).type).toBe('report.accepted');
    expect(validateForWrite(event('gate.finished', { result: {
      id: 'g1', assignmentId: 'asg_abcdefgh', candidate, command: 'npm test', startedAt: '2026-09-22T10:00:00Z',
      finishedAt: '2026-09-22T10:01:00Z', exitCode: 0, timedOut: false, termination: 'exited',
      processContractVersion: 1, environmentPolicyVersion: 1, outputDigest: DIGEST, workspaceMoved: false,
    } })).type).toBe('gate.finished');
  });

  it('refuses unknown types, versions and fields for write', () => {
    expect(() => validateForWrite(event('assignment.teleported', {}))).toThrow();
    expect(() => validateForWrite(event('ownership.held', { agentId: 'a' }, { payloadVersion: 2 }))).toThrow();
    expect(() => validateForWrite(event('ownership.held', { agentId: 'a', extra: 1 }))).toThrow();
    expect(() => validateForWrite(event('ownership.held', { agentId: 'a' }, { extra: 1 }))).toThrow();
    expect(() => validateForWrite(event('ownership.held', { agentId: 'a' }, { version: 2 }))).toThrow();
    expect(() => validateForWrite(event('ownership.held', { agentId: 'a' }, { sequence: 0 }))).toThrow();
    expect(() => validateForWrite(event('report.refused', { tool: 'ask', requestId: 'r', code: 'report_bogus', reason: 'x' }))).toThrow();
    expect(() => validateForWrite(event('notice.pending', {
      noticeId: 'n', kind: 'k', class: 'owner', disposition: 'lead-now', recipientRole: 'peer', text: 'x',
    }))).toThrow();
  });

  it('reads additive payload fields forward but fails closed on unknown types and versions', () => {
    const additive = readEvent(event('ownership.held', { agentId: 'a', futureField: true }));
    expect(additive.ok).toBe(true);
    if (additive.ok) expect(additive.event.data).toEqual({ agentId: 'a' });

    expect(readEvent(event('assignment.teleported', {}))).toMatchObject({ ok: false, reason: 'unknown-type' });
    expect(readEvent(event('ownership.held', { agentId: 'a' }, { payloadVersion: 2 }))).toMatchObject({ ok: false, reason: 'unsupported-version' });
    expect(readEvent(event('ownership.held', {}))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(readEvent(event('ownership.held', { agentId: 'a' }, { schema: 'other' }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(readEvent(null)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
