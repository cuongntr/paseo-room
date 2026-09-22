/**
 * Durable report receipts (docs/design/runtime-coordination.md §3.4).
 *
 * An action fingerprint is the reporting generation, the tool and the canonical validated
 * payload. A retry of an accepted action — same request id, or the same fingerprint under a
 * new id — returns the original receipt and repeats no transition. Everything else aimed at a
 * consumed or foreign generation is refused without consuming anything.
 */
import { createHash } from 'node:crypto';
import type { PeerReportErrorCodeV1, PeerReportReceiptV1 } from '../contracts/peer.js';
import type { AssignmentView } from './state.js';

/** JSON with object keys sorted at every depth, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export function actionFingerprint(generation: number, tool: 'ask' | 'handoff', payload: unknown): string {
  return sha256(canonicalJson({ generation, tool, payload }));
}

export interface CapturedAction {
  /** The generation the bridge captured when it enqueued the call — never re-attributed. */
  readonly generation: number;
  readonly requestId: string;
  readonly fingerprint: string;
}

export type ReceiptResolution =
  | { readonly kind: 'replay'; readonly receipt: PeerReportReceiptV1 }
  | { readonly kind: 'refuse'; readonly code: PeerReportErrorCodeV1; readonly message: string }
  | { readonly kind: 'proceed' };

/**
 * Steps 4 and 5 of the §3.4 validation order: the durable-receipt lookup for this binding's
 * captured generation, then the current-generation check. Payload, binding and authorization
 * checks run before this; live and invariant checks run only after `proceed`.
 */
export function resolveReceipt(view: AssignmentView, action: CapturedAction): ReceiptResolution {
  const accepted = view.reports.filter(report => report.generation === action.generation);
  const sameRequest = accepted.find(report => report.requestId === action.requestId);
  if (sameRequest !== undefined) {
    return sameRequest.fingerprint === action.fingerprint
      ? { kind: 'replay', receipt: sameRequest.receipt }
      : { kind: 'refuse', code: 'report_conflict', message: 'This request id was already used for a different report.' };
  }
  const sameAction = accepted.find(report => report.fingerprint === action.fingerprint);
  if (sameAction !== undefined) return { kind: 'replay', receipt: sameAction.receipt };
  if (accepted.length > 0) {
    return { kind: 'refuse', code: 'report_stale', message: 'This turn already has an accepted report; a different report is not accepted.' };
  }
  if (action.generation !== view.reportingGeneration) {
    return { kind: 'refuse', code: 'report_stale', message: 'This report belongs to an earlier turn.' };
  }
  if (view.reportingState === 'uncertain') {
    return { kind: 'refuse', code: 'report_uncertain', message: 'An earlier report for this turn is still being confirmed. Retry shortly.' };
  }
  if (view.reportingState !== 'open') {
    return { kind: 'refuse', code: 'report_stale', message: 'No report is expected for this turn.' };
  }
  return { kind: 'proceed' };
}
