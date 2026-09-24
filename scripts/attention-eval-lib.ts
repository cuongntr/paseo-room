/**
 * Offline evaluation of the attention sensor (docs/design/runtime-coordination-attention.md §12.3
 * step 1): extract end-of-turn Lead messages from Claude role-home transcripts, label each by what
 * followed it, and build the exact masked `lead-turn-v1` request the runtime would send. Pure
 * functions over transcript text; the runner decides whether anything is sent.
 */
import { mask, tail } from '../src/runtime-plugin/server/attention/mask.js';
import { leadTurnRequest, type SystemOneRequest } from '../src/runtime-plugin/server/attention/questions.js';
import { SENSOR_EXCERPT } from '../src/runtime-plugin/server/attention/sensor.js';

/** What followed a Lead's final message: the evidence the label rests on. */
export type FollowUp = 'child-finished' | 'runtime' | 'nudged' | 'directed' | 'none';

export interface Candidate {
  readonly file: string;
  readonly index: number;
  readonly text: string;
  readonly followUp: FollowUp;
  readonly language: 'vi' | 'en';
  readonly endsWithQuestion: boolean;
}

const NUDGE = /^(?:\s*)(kiểm tra|kiem tra|kiểm ta|tiếp tục|tiep tuc|tiếp đi|sao rồi|xong chưa|continue|go on|status\??|check|any update\??)\b/i;
const VIETNAMESE = /[ăâđêôơưàáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũỳýỵỷỹ]/i;

type Block = { readonly type?: string; readonly text?: string };
interface TranscriptRecord {
  readonly type?: string;
  readonly message?: { readonly role?: string; readonly content?: string | readonly Block[]; readonly stop_reason?: string | null };
}

function textOf(content: string | readonly Block[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text ?? '').join('\n');
}

/** A genuine next message: a user text, never a tool result. */
function userText(record: TranscriptRecord): string | undefined {
  if (record.type !== 'user' || record.message?.role !== 'user') return undefined;
  const content = record.message.content;
  if (typeof content === 'string') return content;
  if ((content ?? []).some(block => block.type === 'tool_result')) return undefined;
  const text = textOf(content);
  return text === '' ? undefined : text;
}

export function followUpOf(text: string | undefined): FollowUp {
  if (text === undefined) return 'none';
  if (text.startsWith('<paseo-system>')) return 'child-finished';
  if (text.startsWith('[paseo-room')) return 'runtime';
  return text.trim().length <= 40 && NUDGE.test(text) ? 'nudged' : 'directed';
}

/** End-of-turn Lead messages in one Claude transcript (JSONL), with their follow-ups. */
export function leadTurns(file: string, jsonl: string): Candidate[] {
  const records: TranscriptRecord[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    try { records.push(JSON.parse(line) as TranscriptRecord); } catch { /* a torn line is skipped */ }
  }
  const found: Candidate[] = [];
  records.forEach((record, index) => {
    if (record.type !== 'assistant' || record.message?.stop_reason !== 'end_turn') return;
    const text = textOf(record.message.content).trim();
    if (text === '') return;
    let next: string | undefined;
    for (const later of records.slice(index + 1)) {
      next = userText(later);
      if (next !== undefined) break;
    }
    found.push({
      file, index, text, followUp: followUpOf(next), language: VIETNAMESE.test(text) ? 'vi' : 'en',
      endsWithQuestion: /\?\s*$/.test(tail(text, 300)),
    });
  });
  return found;
}

/** The exact request the runtime would send for this message; Lead facts are unknown offline. */
export function requestFor(candidate: Candidate, maskNetworkIdentifiers = true): SystemOneRequest {
  const excerpt = tail(mask(candidate.text, { networkIdentifiers: maskNetworkIdentifiers }), SENSOR_EXCERPT);
  return leadTurnRequest('Lead of a project', excerpt, { peersRunning: 0, permissionPending: false });
}

/** Rough input-token estimate for planning: four characters per token. */
export function estimateTokens(request: SystemOneRequest): number {
  return Math.ceil(JSON.stringify(request).length / 4);
}

export interface Summary {
  readonly candidates: number;
  readonly byFollowUp: Readonly<Record<string, number>>;
  readonly byLanguage: Readonly<Record<string, number>>;
  readonly estimatedTokens: number;
}

export function summarize(candidates: readonly Candidate[]): Summary {
  const count = (key: (candidate: Candidate) => string): Record<string, number> => {
    const tally: Record<string, number> = {};
    for (const candidate of candidates) tally[key(candidate)] = (tally[key(candidate)] ?? 0) + 1;
    return tally;
  };
  return {
    candidates: candidates.length,
    byFollowUp: count(candidate => candidate.followUp),
    byLanguage: count(candidate => candidate.language),
    estimatedTokens: candidates.reduce((sum, candidate) => sum + estimateTokens(requestFor(candidate)), 0),
  };
}
