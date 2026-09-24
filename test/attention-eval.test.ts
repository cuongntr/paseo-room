import { describe, expect, it } from 'vitest';
import { followUpOf, leadTurns, requestFor, summarize } from '../scripts/attention-eval-lib.js';

const line = (value: unknown): string => JSON.stringify(value);
const assistant = (text: string, stop = 'end_turn') => line({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
const user = (content: unknown) => line({ type: 'user', message: { role: 'user', content } });

describe('offline attention evaluation', () => {
  it('extracts end-of-turn Lead messages and labels them by what followed', () => {
    const transcript = [
      user('Triển khai tính năng OBO'),
      assistant('Đang đọc mã.', 'tool_use'),
      user([{ type: 'tool_result', content: 'ok' }]),
      assistant('Đang chờ Peer hoàn thành. DB_PASSWORD=hunter2 đã xoay.'),
      user('<paseo-system>\nAgent p (Engineer) finished.\n</paseo-system>'),
      assistant('Done: pushed 1a2b3c. Should I deploy to dev?'),
      user('Kiểm tra'),
      assistant('All green.'),
      user('Merge main into dev, then review MR !2'),
      assistant('Reviewed.'),
      '{ torn',
    ].join('\n');
    const turns = leadTurns('t.jsonl', transcript);
    expect(turns.map(turn => [turn.followUp, turn.language, turn.endsWithQuestion])).toEqual([
      ['child-finished', 'vi', false],
      ['nudged', 'en', true],
      ['directed', 'en', false],
      ['none', 'en', false],
    ]);
    const request = requestFor(turns[0] ?? { file: '', index: 0, text: '', followUp: 'none', language: 'en', endsWithQuestion: false });
    expect(request.state.last_message).toBe('Đang chờ Peer hoàn thành. DB_PASSWORD=[secret] đã xoay.');
    expect(Object.keys(request.questions)).toEqual(['outcome', 'asks_human', 'done_unverified']);
    expect(summarize(turns)).toMatchObject({ candidates: 4, byFollowUp: { 'child-finished': 1, nudged: 1, directed: 1, none: 1 }, byLanguage: { vi: 1, en: 3 } });
  });

  it('treats only short nudges as nudges', () => {
    expect(followUpOf('kiểm tra')).toBe('nudged');
    expect(followUpOf('Tiếp tục đi')).toBe('nudged');
    expect(followUpOf('Kiểm tra lại toàn bộ luồng thanh toán và viết báo cáo chi tiết cho tôi')).toBe('directed');
    expect(followUpOf('[paseo-room notice ntc_x] hi')).toBe('runtime');
    expect(followUpOf(undefined)).toBe('none');
  });
});
