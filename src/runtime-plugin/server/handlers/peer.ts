/**
 * The Peer reporting handlers, `ask` and `handoff` (docs/design/runtime-coordination.md §3.4).
 *
 * Validation precedes mutation in the design's order: strict payload and size; a known durable
 * lifetime binding; the authorized tool and room generation; the durable receipt for the
 * captured generation; then the current generation, fresh live Peer facts, assignment state,
 * work kind and the operation's own invariants. Only then is the accepted action persisted —
 * with its request id, fingerprint and receipt — before the Peer hears success. Every refusal
 * is a bounded, versioned error plus redacted `report.refused` evidence, and changes nothing
 * else. Report content is evidence; identity and the candidate are derived, never copied.
 */
import { randomBytes } from 'node:crypto';
import type { BridgeRequestV1 } from '../contracts/envelope.js';
import { parsePeerToolInput, type PeerReportErrorCodeV1, type PeerReportReceiptV1 } from '../contracts/peer.js';
import type { Controller, LoadedProject } from '../controller.js';
import type { Association } from '../correlations.js';
import { actionFingerprint, resolveReceipt, sha256 } from '../domain/receipts.js';
import type { AssignmentView } from '../domain/state.js';
import { PARENT_AGENT_ID_LABEL } from '../paseo-port.js';
import type { HandlerReply, OperationHandler } from '../spool.js';

type Tool = 'ask' | 'handoff';

class Refusal extends Error {
  constructor(readonly code: PeerReportErrorCodeV1, message: string, readonly retryable = false) {
    super(message);
    this.name = 'Refusal';
  }
}

function reply(refusal: Refusal): HandlerReply {
  return { ok: false, result: { schema: 1, error: { code: refusal.code, message: refusal.message.slice(0, 1_000), retryable: refusal.retryable } } };
}

/** The generation a published capability belongs to, by the hash recorded when it was opened. */
function capturedGeneration(loaded: LoadedProject, assignmentId: string, capability: string | undefined): number | undefined {
  if (capability === undefined) return undefined;
  const hash = sha256(capability);
  const opened = loaded.events.find(event => event.type === 'reporting.generation-opened' && event.assignmentId === assignmentId && event.data.capabilityHash === hash);
  return opened?.type === 'reporting.generation-opened' ? opened.data.generation : undefined;
}

function bindingGeneration(loaded: LoadedProject, assignmentId: string): string | undefined {
  const published = loaded.events.filter(event => event.type === 'binding.published' && event.assignmentId === assignmentId).at(-1);
  return published?.type === 'binding.published' ? published.data.roomGeneration : undefined;
}

export function createPeerHandlers(controller: Controller): Record<Tool, OperationHandler> {
  const handle = (tool: Tool): OperationHandler => async request => {
    const association = await controller.deps.correlations.lookup(request.correlation);
    if (association?.kind !== 'peer' || association.assignmentId === undefined || association.workKind === undefined) {
      return reply(new Refusal('report_unauthorized', 'This bridge is not bound to a runtime assignment.'));
    }
    const store = await controller.locateAssignment(association.assignmentId);
    if (store === undefined) return reply(new Refusal('report_unauthorized', 'The bound assignment is unknown.'));
    return await controller.serial(store.meta.projectId, async () => {
      const loaded = await controller.load(store);
      if (!loaded.ok) return reply(new Refusal('report_uncertain', 'The runtime project is paused; nothing can be recorded now.', true));
      try {
        return await accept(controller, loaded.value, association, tool, request);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        await controller.append(loaded.value, {
          type: 'report.refused', payloadVersion: 1, assignmentId: association.assignmentId,
          actor: { source: 'seat', role: 'peer', agentId: association.agentId, providerId: association.providerId },
          data: { tool, requestId: request.requestId, code: error.code, reason: error.message.slice(0, 1_000) },
        }).catch(() => undefined);
        return reply(error);
      }
    });
  };
  return { ask: handle('ask'), handoff: handle('handoff') };
}

async function accept(controller: Controller, loaded: LoadedProject, association: Association, tool: Tool, request: BridgeRequestV1): Promise<HandlerReply> {
  const assignmentId = association.assignmentId ?? '';
  const workKind = association.workKind ?? 'engineer';
  // 1. Strict payload and size bounds, for the one work kind this binding was created for.
  const parsed = parsePeerToolInput(tool, workKind, request.payload);
  if (!parsed.ok) throw new Refusal('report_malformed', parsed.message);

  // 2. A known durable lifetime binding: this correlation's agent is the assignment's bound Peer.
  const view = loaded.state.assignments.get(assignmentId);
  if (view?.peerAgentId !== association.agentId || view.observedProviderId === undefined) {
    throw new Refusal('report_unauthorized', 'This report does not come from the assignment\'s bound Peer.');
  }

  // 3. The authorized tool on an exact room Peer provider, under the room generation it was bound in.
  const seat = controller.deps.recognition.recognize(association.providerId);
  if (controller.deps.recognition.current.status !== 'ready') throw new Refusal('report_uncertain', 'The runtime is paused until its plugin is reloaded.', true);
  if (seat?.role !== 'peer' || seat.peerReporting === undefined || !seat.capabilities.includes(tool)) {
    throw new Refusal('report_unauthorized', `${tool} is not available to this seat.`);
  }
  if (bindingGeneration(loaded, assignmentId) !== controller.roomGeneration()) {
    throw new Refusal('report_unauthorized', 'The room was set up again after this Peer was bound.');
  }

  // 4. The durable receipt for the captured generation: identical retries replay it.
  const generation = capturedGeneration(loaded, assignmentId, request.capability);
  if (generation === undefined) throw new Refusal('report_stale', 'This call carries no capability for any turn of this assignment.');
  const fingerprint = actionFingerprint(generation, tool, parsed.input);
  const receipt = resolveReceipt(view, { generation, requestId: request.requestId, fingerprint });
  if (receipt.kind === 'replay') return { ok: true, result: receipt.receipt };
  if (receipt.kind === 'refuse') throw new Refusal(receipt.code, receipt.message, receipt.code === 'report_uncertain');

  // 5. Fresh live facts for the bound Peer.
  const snapshot = await controller.deps.paseo.getAgent(association.agentId);
  if (snapshot === undefined || snapshot.archivedAt !== null || snapshot.status === 'closed') throw new Refusal('report_precondition', 'The Peer is no longer live.');
  if (snapshot.provider !== view.observedProviderId || (snapshot.model ?? 'provider-default') !== view.observedModel) {
    throw new Refusal('report_precondition', 'The Peer no longer runs the provider and model it was dispatched with.');
  }
  if (snapshot.labels[PARENT_AGENT_ID_LABEL] !== view.leadAgentId) throw new Refusal('report_precondition', 'The Peer is not the assignment Lead\'s child.');
  if (view.workspaceId !== undefined && view.workspaceId !== 'unknown' && snapshot.workspaceId !== view.workspaceId) {
    throw new Refusal('report_precondition', 'The Peer is not in the assigned workspace.');
  }

  // 6. Assignment state and the expected work kind.
  if (view.state !== 'active' && view.state !== 'awaiting-permission') throw new Refusal('report_state', `No report is expected while the assignment is ${view.state}.`);
  if (view.input.kind !== workKind) throw new Refusal('report_state', 'The report is for a different kind of work than the assignment.');

  // 7. Operation-specific invariants; source-control facts are derived here, never copied.
  let assignmentState: PeerReportReceiptV1['assignmentState'] = 'questioned';
  let candidate;
  let inspectedCommit: string | undefined;
  if (parsed.tool === 'handoff') {
    const input = parsed.input;
    if (input.completion !== 'complete') {
      assignmentState = 'blocked';
    } else {
      assignmentState = 'handed-back';
      if (view.input.mode === 'writable') {
        candidate = await writableCandidate(controller, loaded, view, snapshot.cwd, input.verification);
      } else {
        const identity = await controller.deps.git.identity(snapshot.cwd).catch(() => undefined);
        if (identity?.gitCommonDir !== loaded.store.meta.gitCommonDir) throw new Refusal('report_precondition', 'The Peer is not working in the assignment\'s repository.');
        inspectedCommit = await controller.deps.git.head(identity.canonicalRoot);
      }
    }
  }

  const accepted: PeerReportReceiptV1 = { schema: 1, receipt: `rcpt_${randomBytes(12).toString('base64url')}`, tool, status: 'accepted', assignmentState };
  await controller.append(loaded, {
    type: 'report.accepted', payloadVersion: 1, assignmentId,
    actor: { source: 'seat', role: 'peer', agentId: association.agentId, providerId: association.providerId },
    idempotencyKey: request.requestId,
    data: {
      generation, tool, requestId: request.requestId, fingerprint, receipt: accepted, report: parsed.input as unknown as Record<string, unknown>,
      ...(candidate === undefined ? {} : { candidate }),
      ...(inspectedCommit === undefined ? {} : { inspectedCommit }),
    },
  });
  // The report is already durable; a notice problem must never turn it into a refusal.
  await notifyLead(controller, loaded, view, parsed.tool, assignmentState, parsed.input).catch(() => undefined);
  return { ok: true, result: accepted };
}

async function writableCandidate(
  controller: Controller, loaded: LoadedProject, view: AssignmentView, cwd: string,
  verification: readonly { readonly command: string; readonly outcome: string }[],
) {
  const command = view.input.gate?.command;
  const reported = verification.filter(entry => entry.command === command).at(-1);
  if (command === undefined || reported === undefined) throw new Refusal('report_precondition', `Report the assignment's exact gate command: ${String(command)}.`);
  if (reported.outcome === 'not-run') throw new Refusal('report_precondition', 'A complete writable handoff needs the named gate run after your last write; hand back as blocked or partial instead.');
  const derived = await controller.deps.git.deriveCandidate(cwd, { gitCommonDir: loaded.store.meta.gitCommonDir, baseCommit: view.input.baseCommit, workspaceId: view.workspaceId ?? 'unknown' });
  if (!derived.ok) throw new Refusal('report_precondition', derived.message);
  return derived.candidate;
}

/** Assignment-local evidence goes to that assignment's Lead, never to Supervisor or a Peer. */
async function notifyLead(controller: Controller, loaded: LoadedProject, view: AssignmentView, tool: Tool, state: PeerReportReceiptV1['assignmentState'], input: unknown): Promise<void> {
  const report = input as { question?: string; summary?: string; blocker?: string; verification?: readonly { outcome: string }[] };
  const red = report.verification?.some(entry => entry.outcome === 'failed') === true;
  const text = tool === 'ask'
    ? `Peer on ${view.id} asks: ${report.question ?? ''}`
    : state === 'blocked'
      ? `Peer on ${view.id} handed back blocked: ${report.blocker ?? ''}`
      : `Peer on ${view.id} handed back: ${report.summary ?? ''}${red ? ' (its gate reported a failure)' : ''}`;
  await controller.notices.notify(loaded, {
    kind: tool === 'ask' ? 'peer-question' : state === 'blocked' ? 'blocked-handback' : 'handback', class: 'owner', disposition: 'lead-now',
    assignmentId: view.id, text, recipient: { agentId: view.leadAgentId, role: 'lead' },
  });
}
