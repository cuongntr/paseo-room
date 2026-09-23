/**
 * Supervisor and Lead action handlers (docs/design/runtime-coordination.md D4, D9, §3.4).
 *
 * The caller is established from the correlation's durable association and corroborated by a
 * fresh Paseo snapshot of that exact agent — never from tool input. Lead's operations go through
 * the controller; Supervisor observes status and findings and may route one message to the
 * project's Lead, but cannot transition any assignment.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { LEAD_ACTION_SCHEMAS, SUPERVISOR_ACTION_SCHEMAS } from '../contracts/actions.js';
import type { BridgeRequestV1 } from '../contracts/envelope.js';
import type { Caller, Controller, ControllerResult } from '../controller.js';
import { project } from '../domain/state.js';
import { assignmentDetailView, findings, projectStatusView, revision, type StatusInput } from '../domain/views.js';
import { projectLeads } from '../ownership.js';
import type { HandlerReply, OperationHandler } from '../spool.js';
import { ProjectStore } from '../store/project.js';

const failure = (code: string, message: string, retryable = false): HandlerReply => ({ ok: false, result: { schema: 1, error: { code, message: message.slice(0, 1_000), retryable } } });
const success = (value: unknown): HandlerReply => ({ ok: true, result: { schema: 1, ...(value as object) } });

function fromResult<T>(result: ControllerResult<T>): HandlerReply {
  return result.ok ? success(result.value) : failure(result.code, result.message, result.retryable);
}

/** Resolves and corroborates the calling seat. */
export async function callerOf(controller: Controller, request: BridgeRequestV1, role: 'supervisor' | 'lead'): Promise<Caller | HandlerReply> {
  const association = await controller.deps.correlations.lookup(request.correlation);
  if (association?.kind !== 'action' || association.role !== role) return failure('unauthorized', 'This bridge is not bound to that seat.');
  const snapshot = await controller.deps.paseo.getAgent(association.agentId).catch(() => undefined);
  if (snapshot === undefined) return failure('runtime_unavailable', 'Paseo could not confirm this seat right now.', true);
  if (snapshot.provider !== association.providerId || snapshot.archivedAt !== null || controller.deps.recognition.recognize(snapshot.provider)?.role !== role) {
    return failure('unauthorized', 'This seat no longer matches its room binding.');
  }
  return { agentId: snapshot.id, providerId: snapshot.provider, role, workspaceId: snapshot.workspaceId, cwd: snapshot.cwd };
}

function parse<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> | HandlerReply {
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : failure('invalid_input', z.prettifyError(parsed.error));
}

const isReply = (value: unknown): value is HandlerReply =>
  typeof value === 'object' && value !== null && 'ok' in value && 'result' in value && Object.keys(value).length === 2;

async function statusInputs(controller: Controller): Promise<StatusInput[]> {
  const inputs: StatusInput[] = [];
  for (const store of await ProjectStore.list(controller.deps.runtimeRoot, controller.deps.now)) {
    const replay = await store.replay();
    const projection = project(store.meta.projectId, replay.events);
    inputs.push({
      projectId: store.meta.projectId, canonicalRoot: store.meta.canonicalRoot, replay, violations: projection.violations,
      state: projection.state, events: replay.events, liveAvailable: true, present: existsSync,
    });
  }
  return inputs;
}

export function createLeadHandlers(controller: Controller): Record<string, OperationHandler> {
  const lead = <K extends keyof typeof LEAD_ACTION_SCHEMAS>(name: K, run: (caller: Caller, input: z.infer<(typeof LEAD_ACTION_SCHEMAS)[K]>) => Promise<HandlerReply>): OperationHandler =>
    async request => {
      const caller = await callerOf(controller, request, 'lead');
      if (isReply(caller)) return caller;
      const input = parse(LEAD_ACTION_SCHEMAS[name], request.payload);
      if (isReply(input)) return input;
      return await run(caller, input as z.infer<(typeof LEAD_ACTION_SCHEMAS)[K]>);
    };
  return {
    assignment_create: lead('assignment_create', async (caller, input) => fromResult(await controller.createAssignment(caller, input))),
    assignment_dispatch: lead('assignment_dispatch', async (caller, input) => fromResult(await controller.dispatch(caller, input))),
    assignment_answer: lead('assignment_answer', async (caller, input) => fromResult(await controller.answer(caller, input))),
    assignment_rework: lead('assignment_rework', async (caller, input) => fromResult(await controller.rework(caller, input))),
    assignment_accept: lead('assignment_accept', async (caller, input) => fromResult(await controller.accept(caller, {
      assignmentId: input.assignmentId, reason: input.reason, ...(input.override === undefined ? {} : { override: input.override }),
    }))),
    assignment_reject: lead('assignment_reject', async (caller, input) => fromResult(await controller.reject(caller, input))),
    assignment_abandon: lead('assignment_abandon', async (caller, input) => fromResult(await controller.abandon(caller, input))),
    assignment_close: lead('assignment_close', async (caller, input) => fromResult(await controller.close(caller, input))),
    gate_run: lead('gate_run', async (caller, input) => fromResult(await controller.gateRun(caller, input))),
    workspace_close: lead('workspace_close', async (caller, input) => fromResult(await controller.workspaceClose(caller, input))),
    lease_reclaim: lead('lease_reclaim', async (caller, input) => fromResult(await controller.leaseReclaim(caller, input))),
    assignment_status: lead('assignment_status', async (caller, input) => {
      const store = await controller.projectFor(caller.cwd);
      const loaded = await controller.load(store);
      if (!loaded.ok) return failure(loaded.code, loaded.message);
      const mine = [...loaded.value.state.assignments.values()].filter(view => view.leadAgentId === caller.agentId);
      if (input.assignmentId !== undefined) {
        if (!mine.some(view => view.id === input.assignmentId)) return failure('assignment_unknown', `No assignment ${input.assignmentId} of yours in this project.`);
        const detail = assignmentDetailView(loaded.value.state, input.assignmentId, 'lead');
        return success({ revision: revision(detail), assignment: detail });
      }
      const details = mine.map(view => assignmentDetailView(loaded.value.state, view.id, 'lead'));
      return success({ revision: revision(details), assignments: details });
    }),
  };
}

export function createSupervisorHandlers(controller: Controller): Record<string, OperationHandler> {
  const supervisor = <K extends keyof typeof SUPERVISOR_ACTION_SCHEMAS>(name: K, run: (caller: Caller, input: z.infer<(typeof SUPERVISOR_ACTION_SCHEMAS)[K]>) => Promise<HandlerReply>): OperationHandler =>
    async request => {
      const caller = await callerOf(controller, request, 'supervisor');
      if (isReply(caller)) return caller;
      const input = parse(SUPERVISOR_ACTION_SCHEMAS[name], request.payload);
      if (isReply(input)) return input;
      return await run(caller, input as z.infer<(typeof SUPERVISOR_ACTION_SCHEMAS)[K]>);
    };
  return {
    room_status: supervisor('room_status', async () => {
      const projects = (await statusInputs(controller)).map(input => projectStatusView(input));
      return success({ revision: revision(projects), projects });
    }),
    runtime_findings: supervisor('runtime_findings', async () => {
      const all = (await statusInputs(controller)).flatMap(input => findings(input).map(finding => ({ projectId: input.projectId, ...finding })));
      return success({ revision: revision(all), findings: all });
    }),
    message_lead: supervisor('message_lead', async (caller, input) => {
      const store = await controller.projectFor(caller.cwd).catch(() => undefined);
      if (store === undefined) return failure('project_unknown', 'Your workspace is not a Git project the runtime knows.');
      return await controller.serial(store.meta.projectId, async () => {
        const loaded = await controller.load(store);
        if (!loaded.ok) return failure(loaded.code, loaded.message);
        const leads = (await projectLeads(controller, loaded.value)).leadAgentIds;
        const [lead] = leads;
        if (leads.length !== 1 || lead === undefined) return failure(leads.length === 0 ? 'lead_unavailable' : 'lead_ambiguous', leads.length === 0 ? 'No active Lead owns this project.' : 'More than one Lead is active on this project.');
        const noticeId = await controller.notices.notify(loaded.value, {
          kind: 'supervisor-message', class: 'owner', disposition: 'lead-now', text: `Supervisor: ${input.message}`, recipient: { agentId: lead, role: 'lead' },
        });
        return success({ noticeId });
      });
    }),
  };
}
