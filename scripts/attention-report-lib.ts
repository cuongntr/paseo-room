/**
 * How attention and the Supervisor are used (docs/design/runtime-coordination-attention.md §12.4):
 * letters by kind and delay, Lead answers to `message_lead`, and what the Supervisor and Lead seats
 * read. Pure functions over the attention log, ledger events and role-home transcripts; the runner
 * reads them. Only counts and durations come out, never message text.
 */

export interface Window {
  readonly from: number;
  readonly to: number;
}

/** One attention log line, as far as this report reads it. */
export interface LogRecord {
  readonly at: number;
  readonly type: string;
  readonly id?: string | undefined;
  readonly decision?: string | undefined;
  readonly reason?: string | undefined;
  readonly level?: string | undefined;
  readonly items: readonly string[];
  readonly verdict?: string | undefined;
  readonly leadAgentId?: string | undefined;
}

/** A Supervisor's `message_lead`, from a project ledger's `notice.pending` event. */
export interface SupervisorMessage {
  readonly at: number;
  readonly leadAgentId: string;
}

/** What started a seat's turn, from its first user message. */
export type Trigger = 'letter' | 'human' | 'envelope' | 'supervisor-message' | 'notice' | 'runtime-other';

export interface SeatTurn {
  readonly trigger: Trigger;
  readonly start: number;
  end: number;
  /** Model calls, one per assistant message id. */
  calls: number;
  /** Input tokens read, cache reads and writes included. */
  input: number;
  readonly tools: string[];
  askAt?: number;
}

export interface AskWait {
  readonly trigger: Trigger;
  readonly minutes: number;
}

export interface Transcript {
  readonly turns: readonly SeatTurn[];
  readonly asks: readonly AskWait[];
  /** Model calls whose only tool call was `attention_feedback`. */
  readonly ratingOnlyCalls: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The records of an attention log file inside the window; a torn or foreign line is skipped. */
export function logRecords(text: string, window: Window): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of text.split('\n')) {
    const raw = parse(line);
    const at = Date.parse(str(raw?.at) ?? '');
    const type = str(raw?.type);
    if (raw === undefined || type === undefined || Number.isNaN(at) || at < window.from || at > window.to) continue;
    const items = Array.isArray(raw.items) ? raw.items.filter((item): item is string => typeof item === 'string') : [];
    records.push({
      at, type, items,
      id: str(raw.id), decision: str(raw.decision), reason: str(raw.reason), level: str(raw.level), verdict: str(raw.verdict),
      leadAgentId: str(raw.leadAgentId),
    });
  }
  return records;
}

/** The Supervisor message a ledger event records, if it is one. */
export function supervisorMessage(eventText: string): SupervisorMessage | undefined {
  const event = parse(eventText);
  const data = isObject(event?.data) ? event.data : undefined;
  const at = Date.parse(str(event?.occurredAt) ?? '');
  const leadAgentId = str(data?.recipientAgentId);
  if (event?.type !== 'notice.pending' || data?.kind !== 'supervisor-message' || leadAgentId === undefined || Number.isNaN(at)) return undefined;
  return { at, leadAgentId };
}

export function triggerOf(text: string): Trigger {
  if (text.startsWith('[paseo-room attention ')) return 'letter';
  if (text.startsWith('<paseo-system>')) return 'envelope';
  if (/^\[paseo-room notice ntc_[\w-]+\] Supervisor: /.test(text)) return 'supervisor-message';
  if (text.startsWith('[paseo-room notice')) return 'notice';
  if (text.startsWith('[paseo-room')) return 'runtime-other';
  return 'human';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isObject).filter(block => block.type === 'text').map(block => str(block.text) ?? '').join('');
}

/** A seat's turns in one transcript, the waits on its `AskUserQuestion` calls, and its rating-only calls. */
export function transcriptTurns(text: string, window: Window): Transcript {
  const turns: SeatTurn[] = [];
  const asks: AskWait[] = [];
  const pendingAsks = new Map<string, { readonly at: number; readonly trigger: Trigger }>();
  const counted = new Set<string>();
  const toolsByCall = new Map<string, string[]>();
  let current: SeatTurn | undefined;
  for (const line of text.split('\n')) {
    const record = parse(line);
    const at = Date.parse(str(record?.timestamp) ?? '');
    if (record === undefined || Number.isNaN(at) || at < window.from || at > window.to) continue;
    const message = isObject(record.message) ? record.message : undefined;
    const content = message?.content;
    const blocks = Array.isArray(content) ? content.filter(isObject) : [];
    if (record.type === 'user' && record.isMeta !== true) {
      for (const block of blocks) {
        const ask = block.type === 'tool_result' ? pendingAsks.get(str(block.tool_use_id) ?? '') : undefined;
        if (ask !== undefined) {
          asks.push({ trigger: ask.trigger, minutes: (at - ask.at) / 60_000 });
          pendingAsks.delete(str(block.tool_use_id) ?? '');
        }
      }
      const said = textOf(content).trimStart();
      const result = blocks.some(block => block.type === 'tool_result');
      if (!result && said !== '' && !said.startsWith('<command-') && !said.startsWith('<local-command')) {
        current = { trigger: triggerOf(said), start: at, end: at, calls: 0, input: 0, tools: [] };
        turns.push(current);
      }
    }
    if (record.type === 'assistant' && current !== undefined) {
      current.end = at;
      const id = str(message?.id);
      const usage = isObject(message?.usage) ? message.usage : undefined;
      if (id !== undefined && usage !== undefined && !counted.has(id)) {
        counted.add(id);
        current.calls += 1;
        current.input += (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0);
      }
      for (const block of blocks.filter(entry => entry.type === 'tool_use')) {
        const name = str(block.name) ?? '';
        current.tools.push(name);
        if (id !== undefined) toolsByCall.set(id, [...(toolsByCall.get(id) ?? []), name]);
        if (name === 'AskUserQuestion') {
          current.askAt ??= at;
          pendingAsks.set(str(block.id) ?? '', { at, trigger: current.trigger });
        }
      }
    }
  }
  const ratingOnlyCalls = [...toolsByCall.values()].filter(names => names.length > 0 && names.every(name => name.endsWith('attention_feedback'))).length;
  return { turns, asks, ratingOnlyCalls };
}

export function quantile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Number.NaN;
}

function count<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}

/** A routing reason without its ids or its explanation: `baseline`, `progress`, `Lead marked the turn NEEDS-HUMAN`. */
function reasonClass(reason: string): string {
  return reason.split(':', 1)[0]?.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>') ?? reason;
}

export interface Delay {
  readonly decided: number;
  readonly sent: number;
  /** Never sent: superseded by a later turn or withdrawn. */
  readonly unsent: number;
  /** Sent in a letter of another level: a `now` moved to the digest, or a digest line that rode along. */
  readonly otherLevel: number;
  /** Seconds from the routing decision to the letter, p50 and p90. */
  readonly p50: number;
  readonly p90: number;
}

export interface LetterReport {
  readonly days: number;
  readonly leadTurns: Record<string, number>;
  readonly letters: { readonly total: number; readonly byLevel: Record<string, number>; readonly itemsPerDigestP50: number };
  readonly delay: Record<string, Delay>;
  readonly answers: { readonly messages: number; readonly byDecision: Record<string, number> } & Omit<Delay, 'decided' | 'otherLevel'>;
  readonly feedback: Record<string, number>;
}

function delayOf(decisions: readonly LogRecord[], sentIn: ReadonlyMap<string, LogRecord>, level?: string): Delay {
  const sent = decisions.filter(record => record.id !== undefined && sentIn.has(record.id));
  const seconds = sent.map(record => ((sentIn.get(record.id ?? '')?.at ?? record.at) - record.at) / 1_000);
  return {
    decided: decisions.length, sent: sent.length, unsent: decisions.length - sent.length,
    otherLevel: level === undefined ? 0 : sent.filter(record => sentIn.get(record.id ?? '')?.level !== level).length,
    p50: quantile(seconds, 0.5), p90: quantile(seconds, 0.9),
  };
}

/** Letters and Lead-turn routing over the window's attention log and ledger messages. */
export function letterReport(records: readonly LogRecord[], messages: readonly SupervisorMessage[], window: Window): LetterReport {
  const turns = records.filter(record => record.type === 'lead-turn').sort((a, b) => a.at - b.at);
  const letters = records.filter(record => record.type === 'letter.sent');
  const sentIn = new Map<string, LogRecord>();
  for (const letter of letters) for (const id of letter.items) if (!sentIn.has(id)) sentIn.set(id, letter);
  const delay: Record<string, Delay> = {};
  for (const level of ['page', 'now', 'digest']) delay[level] = delayOf(turns.filter(record => record.decision === level), sentIn, level);
  // The Lead's first turn to end after a Supervisor's message is its answer, before and after answers became replies.
  const answers = messages.filter(message => message.at >= window.from && message.at <= window.to)
    .map(message => turns.find(turn => turn.leadAgentId === message.leadAgentId && turn.at > message.at))
    .filter((turn): turn is LogRecord => turn !== undefined);
  const answerDelay = delayOf(answers, sentIn);
  return {
    days: (window.to - window.from) / 86_400_000,
    leadTurns: count(turns, record => `${record.decision ?? '?'} · ${reasonClass(record.reason ?? '')}`),
    letters: {
      total: letters.length, byLevel: count(letters, record => record.level ?? '?'),
      itemsPerDigestP50: quantile(letters.filter(record => record.level === 'digest').map(record => record.items.length), 0.5),
    },
    delay,
    answers: {
      messages: messages.filter(message => message.at >= window.from && message.at <= window.to).length,
      byDecision: count(answers, record => record.decision ?? '?'),
      sent: answerDelay.sent, unsent: answerDelay.unsent, p50: answerDelay.p50, p90: answerDelay.p90,
    },
    feedback: count(records.filter(record => record.type === 'feedback.recorded'), record => record.verdict ?? '?'),
  };
}

const ACTS = /message_lead|AskUserQuestion|lead_replace|send_agent_prompt|archive_agent|create_agent/;

export interface SeatReport {
  readonly turns: Record<string, number>;
  readonly input: number;
  readonly inputByTrigger: Record<string, number>;
  /** Letter-started turns that neither messaged a Lead, asked Human nor started or ended a seat. */
  readonly letterTurnsWithoutAction: number;
  readonly ratingOnlyCalls: number;
  /** Seconds from a letter to the Human question it led to, p50. */
  readonly letterToAskP50: number;
  readonly asks: Record<string, { readonly count: number; readonly medianMinutes: number; readonly overTen: number; readonly totalMinutes: number }>;
}

export function seatReport(transcripts: readonly Transcript[]): SeatReport {
  const turns = transcripts.flatMap(transcript => transcript.turns);
  const inputByTrigger: Record<string, number> = {};
  for (const turn of turns) inputByTrigger[turn.trigger] = (inputByTrigger[turn.trigger] ?? 0) + turn.input;
  const letterTurns = turns.filter(turn => turn.trigger === 'letter');
  const waits = new Map<string, number[]>();
  for (const wait of transcripts.flatMap(transcript => transcript.asks)) waits.set(wait.trigger, [...(waits.get(wait.trigger) ?? []), wait.minutes]);
  const asks: Record<string, SeatReport['asks'][string]> = {};
  for (const [trigger, minutes] of waits) {
    asks[trigger] = { count: minutes.length, medianMinutes: quantile(minutes, 0.5), overTen: minutes.filter(value => value >= 10).length, totalMinutes: minutes.reduce((sum, value) => sum + value, 0) };
  }
  return {
    turns: count(turns, turn => turn.trigger),
    input: turns.reduce((sum, turn) => sum + turn.input, 0),
    inputByTrigger,
    letterTurnsWithoutAction: letterTurns.filter(turn => !turn.tools.some(name => ACTS.test(name))).length,
    ratingOnlyCalls: transcripts.reduce((sum, transcript) => sum + transcript.ratingOnlyCalls, 0),
    letterToAskP50: quantile(letterTurns.filter(turn => turn.askAt !== undefined).map(turn => ((turn.askAt ?? turn.start) - turn.start) / 1_000), 0.5),
    asks,
  };
}

const n = (value: number, digits = 0): string => (Number.isNaN(value) ? '—' : value.toFixed(digits));
const tokens = (value: number): string => `${(value / 1e6).toFixed(1)}M`;
const pairs = (counts: Record<string, number>): string => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${String(value)}`).join(', ');

export function formatReport(window: Window, letters: LetterReport, seats: Readonly<Record<string, SeatReport>>): string {
  const perDay = (value: number): string => n(value / letters.days, 1);
  const lines = [
    `Attention report, ${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()} (${n(letters.days, 1)} days)`,
    '',
    'Lead turns by routing:',
    ...Object.entries(letters.leadTurns).sort((a, b) => b[1] - a[1]).map(([key, value]) => `  ${String(value).padStart(5)}  ${key}`),
    '',
    `Letters to Supervisors: ${String(letters.letters.total)} (${perDay(letters.letters.total)}/day); ${pairs(letters.letters.byLevel)}; items per digest p50 ${n(letters.letters.itemsPerDigestP50)}`,
    ...Object.entries(letters.delay).map(([level, delay]) => `  ${level.padEnd(6)} decided ${String(delay.decided)}, sent ${String(delay.sent)}, never sent ${String(delay.unsent)}, sent in another level ${String(delay.otherLevel)}; decision to letter p50 ${n(delay.p50)} s, p90 ${n(delay.p90)} s`),
    `Answers to message_lead: ${String(letters.answers.messages)} messages; answered as ${pairs(letters.answers.byDecision)}; sent ${String(letters.answers.sent)}, never sent ${String(letters.answers.unsent)}; decision to letter p50 ${n(letters.answers.p50)} s, p90 ${n(letters.answers.p90)} s`,
    `Feedback: ${pairs(letters.feedback) || 'none'}`,
  ];
  for (const [role, seat] of Object.entries(seats)) {
    lines.push('', `${role}: turns ${pairs(seat.turns)}; input read ${tokens(seat.input)} (${tokens(seat.input / letters.days)}/day): ${pairs(Object.fromEntries(Object.entries(seat.inputByTrigger).map(([key, value]) => [key, Math.round(value / 1e6)])))} (M)`);
    if (role === 'supervisor') {
      lines.push(`  letter turns without action ${String(seat.letterTurnsWithoutAction)} of ${String(seat.turns.letter ?? 0)}; rating-only model calls ${String(seat.ratingOnlyCalls)}; letter to AskUserQuestion p50 ${n(seat.letterToAskP50)} s`);
      for (const [trigger, ask] of Object.entries(seat.asks)) lines.push(`  AskUserQuestion after ${trigger}: ${String(ask.count)}, median wait ${n(ask.medianMinutes, 1)} min, ${String(ask.overTen)} of 10 min or more, ${n(ask.totalMinutes)} min in all`);
    }
  }
  return lines.join('\n');
}
