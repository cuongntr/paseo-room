import { describe, expect, it } from 'vitest';
import {
  formatReport, letterReport, logRecords, seatReport, supervisorMessage, transcriptTurns, triggerOf, type Window,
} from '../scripts/attention-report-lib.js';

const window: Window = { from: Date.parse('2026-09-24T00:00:00Z'), to: Date.parse('2026-09-25T00:00:00Z') };
const line = (value: unknown): string => JSON.stringify(value);
const at = (clock: string): string => `2026-09-24T${clock}Z`;

describe('attention usage report', () => {
  it('reads the attention log inside the window, skipping torn and outside lines', () => {
    const text = [
      line({ at: at('08:00:00'), type: 'lead-turn', id: 'a', decision: 'now', reason: 'Lead marked the turn NEEDS-HUMAN', leadAgentId: 'lead' }),
      '{ torn',
      line({ at: '2026-09-23T23:59:59Z', type: 'lead-turn', id: 'old', decision: 'digest', reason: 'baseline: x' }),
      line({ at: at('08:00:05'), type: 'letter.sent', id: 'L1', level: 'now', items: ['a', 7] }),
    ].join('\n');
    expect(logRecords(text, window).map(record => [record.type, record.id, record.items])).toEqual([['lead-turn', 'a', []], ['letter.sent', 'L1', ['a']]]);
  });

  it('finds a Supervisor message in a ledger event and nothing else', () => {
    const event = (type: string, kind: string) => line({ type, occurredAt: at('09:00:00'), data: { kind, recipientAgentId: 'lead' } });
    expect(supervisorMessage(event('notice.pending', 'supervisor-message'))).toEqual({ at: Date.parse(at('09:00:00')), leadAgentId: 'lead' });
    expect(supervisorMessage(event('notice.pending', 'gate-ended'))).toBeUndefined();
    expect(supervisorMessage(event('notice.sent', 'supervisor-message'))).toBeUndefined();
    expect(supervisorMessage('not json')).toBeUndefined();
  });

  it('measures letters, their delays, answers and what the sensor would change', () => {
    const records = logRecords([
      line({ at: at('08:00:00'), type: 'lead-turn', id: 'q', decision: 'now', reason: 'Lead marked the turn NEEDS-HUMAN', leadAgentId: 'lead' }),
      line({ at: at('08:00:00'), type: 'letter.sent', id: 'L1', level: 'now', items: ['q'] }),
      line({ at: at('09:00:00'), type: 'lead-turn', id: 'd1', decision: 'digest', reason: 'baseline: a Lead turn the Supervisor was not told about', leadAgentId: 'lead' }),
      line({ at: at('09:01:00'), type: 'lead-turn', id: 'd2', decision: 'digest', reason: 'progress: the Lead\'s loop still runs; it goes with the next letter', leadAgentId: 'lead' }),
      line({ at: at('09:06:00'), type: 'letter.sent', id: 'L2', level: 'digest', items: ['d2'] }),
      line({ at: at('09:06:01'), type: 'feedback.recorded', id: 'd2', verdict: 'noise' }),
      line({ at: at('09:06:02'), type: 'assessment.recorded', id: 'd1', questionSet: 'lead-turn-v1', latencyMs: 700, baseline: 'digest', decision: 'now' }),
    ].join('\n'), window);
    const report = letterReport(records, [{ at: Date.parse(at('08:59:00')), leadAgentId: 'lead' }, { at: Date.parse('2026-09-26T00:00:00Z'), leadAgentId: 'lead' }], window);
    expect(report.leadTurns).toEqual({ 'now · Lead marked the turn NEEDS-HUMAN': 1, 'digest · baseline': 1, 'digest · progress': 1 });
    expect(report.letters).toEqual({ total: 2, byLevel: { now: 1, digest: 1 }, itemsPerDigestP50: 1 });
    expect(report.delay.now).toMatchObject({ decided: 1, sent: 1, unsent: 0, p50: 0 });
    expect(report.delay.digest).toMatchObject({ decided: 2, sent: 1, unsent: 1, p50: 300 });
    // The message outside the window is not counted; the one inside was answered by d1, which never went.
    expect(report.answers).toMatchObject({ messages: 1, byDecision: { digest: 1 }, sent: 0, unsent: 1 });
    expect(report.feedback).toEqual({ noise: 1 });
    expect(report.sensor).toEqual({ assessments: 1, latencyP50: 700, wouldRaise: 1, wouldLower: 0 });
  });

  it('reads a seat\'s turns, what they cost, what they did and how long Human took to answer', () => {
    const assistant = (clock: string, id: string, input: number, tools: { name: string; id?: string }[]) => line({
      type: 'assistant', timestamp: at(clock),
      message: { id, usage: { input_tokens: 1, cache_read_input_tokens: input, cache_creation_input_tokens: 0 }, content: tools.map(tool => ({ type: 'tool_use', name: tool.name, id: tool.id ?? tool.name })) },
    });
    const user = (clock: string, content: unknown) => line({ type: 'user', timestamp: at(clock), message: { content } });
    const text = [
      user('10:00:00', '[paseo-room attention att_1] shop · Lead asks: keep the secret copy?'),
      assistant('10:00:05', 'm1', 1_000, [{ name: 'mcp__paseo_room__attention_feedback' }]),
      // The same model call written twice is counted once.
      assistant('10:00:05', 'm1', 1_000, []),
      assistant('10:00:20', 'm2', 2_000, [{ name: 'AskUserQuestion', id: 'ask-1' }]),
      user('10:12:20', [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'keep it' }]),
      user('10:13:00', 'How is shop doing?'),
      assistant('10:13:05', 'm3', 3_000, []),
    ].join('\n');
    const transcript = transcriptTurns(text, window);
    expect(transcript.turns.map(turn => [turn.trigger, turn.calls, turn.input])).toEqual([['letter', 2, 3_002], ['human', 1, 3_001]]);
    expect(transcript.asks).toEqual([{ trigger: 'letter', minutes: 12 }]);
    expect(transcript.ratingOnlyCalls).toBe(1);

    const seat = seatReport([transcript]);
    expect(seat).toMatchObject({ turns: { letter: 1, human: 1 }, input: 6_003, letterTurnsWithoutAction: 0, ratingOnlyCalls: 1, letterToAskP50: 20 });
    expect(seat.asks.letter).toEqual({ count: 1, medianMinutes: 12, overTen: 1, totalMinutes: 12 });

    // Counts only: nothing a seat or Human wrote reaches the report.
    const report = formatReport(window, letterReport([], [], window), { supervisor: seat });
    expect(report).toContain('rating-only model calls 1');
    expect(report).not.toContain('secret');
    expect(report).not.toContain('keep it');
  });

  it('tells what started a turn', () => {
    expect(triggerOf('[paseo-room notice ntc_a] Supervisor: go ahead')).toBe('supervisor-message');
    expect(triggerOf('[paseo-room notice ntc_a] Engineer handed back.')).toBe('notice');
    expect(triggerOf('[paseo-room notices ntc_a ntc_b]')).toBe('notice');
    expect(triggerOf('<paseo-system>finished</paseo-system>')).toBe('envelope');
    expect(triggerOf('Ship it')).toBe('human');
  });
});
