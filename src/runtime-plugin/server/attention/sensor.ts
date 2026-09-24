/**
 * The attention sensor (docs/design/runtime-coordination-attention.md A-D5–A-D7, §6).
 *
 * One adapter speaks the System One HTTP shape — `POST {state, model, questions}` answered by typed
 * `answers` — so TypeSafe's Jev and any compatible or self-hosted endpoint work unchanged. Nothing
 * is sent unless the operator set the sensor to shadow or assist, acknowledged the endpoint's host
 * (loopback excepted) and stored a key; only the masked, bounded state leaves the host. Every
 * answer is recorded with its question set and the model that gave it. A wrong model, a timeout, an
 * error status or a malformed body is no answer; five failures in a row open a ten-minute circuit.
 * The sensor never decides anything: triage does, and only in assist mode, for opted-in sets.
 */
import { z } from 'zod';
import { egressRefusal, type AttentionSettings, type QuestionSetId } from '../../shared/attention.js';
import type { SensorHook } from './engine.js';
import type { AttentionKey } from './key.js';
import type { AttentionLog } from './log.js';
import { mask, tail } from './mask.js';
import { LEAD_TURN_V1, PEER_REPORT_V1, leadTurnRequest, peerReportRequest, type SystemOneRequest } from './questions.js';
import { BASELINE, assistLeadTurn, type Assessment, type Decision, type LeadTurnFacts } from './triage.js';

export const SENSOR_EXCERPT = 1_500;
const FAILURES_TO_OPEN = 5;
const CIRCUIT_MS = 10 * 60_000;

const answerSchema = z.union([
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number().min(0).max(1) }),
  z.object({ type: z.literal('score'), score: z.number(), confidence: z.number().min(0).max(1) }),
]);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export interface SensorDependencies {
  readonly settings: () => AttentionSettings;
  readonly key: Pick<AttentionKey, 'read'>;
  readonly log: Pick<AttentionLog, 'append'>;
  readonly now: () => Date;
  readonly fetch?: typeof fetch;
}

interface Tally { assessed: number; record: number; digest: number; now: number }

export interface SensorStatus {
  readonly day: string;
  readonly calls: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly circuitOpenUntil?: string;
  readonly lastError?: string;
  readonly shadow: Readonly<Record<string, Tally>>;
}

export class SystemOneSensor implements SensorHook {
  private day = '';
  private calls = 0;
  private failures = 0;
  private inputTokens = 0;
  private consecutive = 0;
  private openUntil = 0;
  private lastError: string | undefined;
  private shadow: Record<string, Tally> = {};

  constructor(private readonly deps: SensorDependencies) {}

  private get time(): number {
    return this.deps.now().getTime();
  }

  private rollover(): void {
    const day = this.deps.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.calls = 0;
    this.failures = 0;
    this.inputTokens = 0;
    this.shadow = {};
  }

  status(): SensorStatus {
    this.rollover();
    return {
      day: this.day, calls: this.calls, failures: this.failures, inputTokens: this.inputTokens,
      ...(this.openUntil > this.time ? { circuitOpenUntil: new Date(this.openUntil).toISOString() } : {}),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      shadow: structuredClone(this.shadow),
    };
  }

  /** Why the sensor would not send now, or undefined when it would. */
  async refusal(): Promise<string | undefined> {
    const settings = this.deps.settings().sensor;
    const refused = egressRefusal(settings);
    if (refused !== undefined) return refused;
    if (this.openUntil > this.time) return 'The sensor circuit is open after repeated failures.';
    return (await this.deps.key.read()) === undefined ? 'No sensor key is configured.' : undefined;
  }

  async leadTurn(input: { readonly id: string; readonly message: string; readonly facts: LeadTurnFacts; readonly seatName: string }): Promise<{ readonly assessment: Assessment; readonly mode: 'shadow' | 'assist'; readonly assist: boolean } | undefined> {
    const settings = this.deps.settings().sensor;
    const excerpt = tail(mask(input.message, { networkIdentifiers: settings.maskNetworkIdentifiers }), SENSOR_EXCERPT);
    const request = leadTurnRequest(input.seatName, excerpt, input.facts);
    const assessed = await this.assess(LEAD_TURN_V1, request);
    if (assessed === undefined || settings.mode === 'off') return undefined;
    const decision = assistLeadTurn(assessed.assessment, input.facts).decision;
    const assist = settings.mode === 'assist' && settings.assistQuestionSets.includes(LEAD_TURN_V1);
    await this.record(input.id, LEAD_TURN_V1, request, assessed, decision, settings.mode);
    return { assessment: assessed.assessment, mode: settings.mode, assist };
  }

  /** Peer reports are assessed in shadow only in this phase (delta Q-A04): recorded, never applied. */
  async peerReport(input: { readonly id: string; readonly brief: string; readonly report: string }): Promise<unknown> {
    const settings = this.deps.settings().sensor;
    const options = { networkIdentifiers: settings.maskNetworkIdentifiers };
    const request = peerReportRequest(tail(mask(input.brief, options), 800), tail(mask(input.report, options), SENSOR_EXCERPT));
    const assessed = await this.assess(PEER_REPORT_V1, request);
    if (assessed === undefined || settings.mode === 'off') return undefined;
    await this.record(input.id, PEER_REPORT_V1, request, assessed, 'record', settings.mode);
    return assessed.assessment;
  }

  private async record(id: string, questionSet: QuestionSetId, request: SystemOneRequest, assessed: { readonly assessment: Assessment; readonly answers: unknown }, decision: Decision, mode: string): Promise<void> {
    this.rollover();
    const tally = this.shadow[questionSet] ?? { assessed: 0, record: 0, digest: 0, now: 0 };
    tally.assessed += 1;
    tally[decision] += 1;
    this.shadow[questionSet] = tally;
    await this.deps.log.append({
      type: 'assessment.recorded', id, questionSet, model: assessed.assessment.model, mode, state: request.state, answers: assessed.answers,
      decision, baseline: BASELINE.decision, latencyMs: assessed.assessment.latencyMs,
      ...(assessed.assessment.inputTokens === undefined ? {} : { inputTokens: assessed.assessment.inputTokens }),
    });
  }

  private fail(reason: string): void {
    this.rollover();
    this.failures += 1;
    this.consecutive += 1;
    this.lastError = reason.slice(0, 300);
    if (this.consecutive >= FAILURES_TO_OPEN) {
      this.openUntil = this.time + CIRCUIT_MS;
      this.consecutive = 0;
    }
  }

  private async assess(questionSet: QuestionSetId, request: SystemOneRequest): Promise<{ readonly assessment: Assessment; readonly answers: unknown } | undefined> {
    if (await this.refusal() !== undefined) return undefined;
    const settings = this.deps.settings().sensor;
    const key = await this.deps.key.read();
    if (key === undefined) return undefined;
    const started = this.time;
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); }, settings.timeoutMs);
    let body: unknown;
    try {
      const response = await (this.deps.fetch ?? fetch)(settings.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: settings.model, ...request }),
        signal: abort.signal,
      });
      if (!response.ok) { this.fail(`HTTP ${String(response.status)}`); return undefined; }
      body = await response.json();
    } catch (error) {
      this.fail(abort.signal.aborted ? `timed out after ${String(settings.timeoutMs)} ms` : error instanceof Error ? error.name : 'request failed');
      return undefined;
    } finally {
      clearTimeout(timer);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) { this.fail('malformed response'); return undefined; }
    if (parsed.data.model !== settings.model) { this.fail(`answered by ${parsed.data.model}, not the pinned ${settings.model}`); return undefined; }
    this.rollover();
    this.consecutive = 0;
    this.calls += 1;
    this.inputTokens += parsed.data.usage?.input_tokens ?? 0;
    const nouls: Record<string, number> = {};
    let choice: Assessment['choice'];
    let probabilities: Assessment['probabilities'];
    for (const [name, answer] of Object.entries(parsed.data.answers)) {
      if (answer.type === 'noul') nouls[name] = answer.noul;
      else if (answer.type === 'choice' && name === 'outcome') {
        choice = { value: answer.choice, confidence: answer.confidence };
        probabilities = answer.probabilities;
      }
    }
    const assessment: Assessment = {
      questionSet, model: parsed.data.model, nouls, latencyMs: this.time - started,
      ...(choice === undefined ? {} : { choice }),
      ...(probabilities === undefined ? {} : { probabilities }),
      ...(parsed.data.usage?.input_tokens === undefined ? {} : { inputTokens: parsed.data.usage.input_tokens }),
    };
    return { assessment, answers: parsed.data.answers };
  }
}
