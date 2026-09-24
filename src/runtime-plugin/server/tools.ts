/**
 * The tool lists each bridge advertises (docs/design/runtime-coordination.md §3.4).
 *
 * Registries are disjoint by construction: Supervisor sees four tools, Lead twelve, and a Peer
 * exactly `ask` and `handoff`, with the one handoff detail shape for its bound work kind. The
 * advertised JSON Schemas are for the model's benefit only; the server validates every call
 * strictly and never trusts that a client respected them.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { boundedArray, boundedString } from '../shared/limits.js';
import { LEAD_OPERATIONS, SUPERVISOR_OPERATIONS, type RuntimeRole } from '../shared/policy.js';
import { LEAD_ACTION_SCHEMAS, SUPERVISOR_ACTION_SCHEMAS } from './contracts/actions.js';
import { ASSIGNMENT_KINDS, type AssignmentKind } from './contracts/assignment.js';
import { askInputSchema, HANDOFF_DETAILS, verificationReportSchema } from './contracts/peer.js';
import { ensurePrivateDirectory } from './store/publish.js';
import { writeFile, rename } from 'node:fs/promises';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  room_status: 'Read runtime status for the projects in your portfolio: assignment health, open assignments (settled ones are only counted) and writer ownership, and under `observed` each project with its Lead, Peers, their states and open attention incidents.',
  runtime_findings: 'List the conditions the runtime has detected in your portfolio that need attention, with evidence and a recovery action, and the open attention incidents addressed to you.',
  message_lead: 'Send one message to the Lead that owns a project in your portfolio. Name the project (its name or id) when you supervise more than one.',
  attention_feedback: 'Rate a runtime attention letter item by its item id, or every item of a letter by the letter\'s own id: useful, noise or unknown. It tunes what reaches you; it is not an instruction to anyone.',
  assignment_create: 'Create a typed assignment in your current project. It is not dispatched yet.',
  assignment_dispatch: 'Dispatch a draft assignment to a new Peer on an eligible room Peer provider. isolation "worktree" asks the runtime for the Peer\'s own worktree, so it may run beside other isolated writers; the runtime refuses it when scopes overlap, a serial-only path or a writer in your workspace collides, or the cap is reached, and that refusal is final for this dispatch. Scope checks prevent collisions; they do not contain the Peer.',
  assignment_answer: 'Answer a Peer question, or follow up on a blocked handback, with a new Peer turn.',
  assignment_rework: 'Send a handed-back candidate back to its Peer for rework.',
  assignment_accept: 'Accept a handed-back assignment. Red gate evidence, or changed paths outside an isolated assignment\'s write scope, needs an override.',
  assignment_reject: 'Reject a handed-back assignment.',
  assignment_abandon: 'Abandon an assignment.',
  assignment_close: 'Close a decided assignment by archiving its Peer. Your workspace is not closed.',
  assignment_status: 'Read one assignment in detail, or all of yours.',
  gate_run: 'Run the assignment\'s exact gate command independently against the handed-back candidate.',
  workspace_close: 'Close the worktree of a closed isolated assignment that the runtime retained. discardUncommitted with a reason destroys its uncommitted work; the branch is kept.',
  lease_reclaim: 'Reclaim an isolated assignment\'s worktree after its Peer is proven archived, and dispatch a new Peer into it at the next lease epoch.',
  ask: 'Ask Lead a blocking question about your current assignment. Your turn should end after this call.',
  handoff: 'Hand your current assignment back to Lead: complete, partial or blocked. This is the only way to report.',
};

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** One flat object schema per work kind, since MCP clients expect an object at the root. */
function handoffSchema(kind: AssignmentKind): Record<string, unknown> {
  const text = boundedString();
  return schemaOf(z.strictObject({
    completion: z.enum(['complete', 'partial', 'blocked']),
    summary: text,
    deliverables: boundedArray(text),
    verification: boundedArray(verificationReportSchema),
    residualRisks: boundedArray(text),
    evidence: boundedArray(text),
    blocker: text.optional().describe('Required when completion is partial or blocked; omitted when complete.'),
    details: HANDOFF_DETAILS[kind].optional().describe('Required when completion is complete; omitted otherwise.'),
  }));
}

export function toolDefinitions(role: RuntimeRole, kind?: AssignmentKind): ToolDefinition[] {
  const define = (name: string, schema: Record<string, unknown>): ToolDefinition => ({ name, description: DESCRIPTIONS[name] ?? name, inputSchema: schema });
  if (role === 'supervisor') return SUPERVISOR_OPERATIONS.map(name => define(name, schemaOf(SUPERVISOR_ACTION_SCHEMAS[name])));
  if (role === 'lead') return LEAD_OPERATIONS.map(name => define(name, schemaOf(LEAD_ACTION_SCHEMAS[name])));
  if (kind === undefined) return [];
  return [define('ask', schemaOf(askInputSchema)), define('handoff', handoffSchema(kind))];
}

export function toolsFile(role: RuntimeRole, kind?: AssignmentKind): string {
  return role === 'peer' ? `peer-${String(kind)}.json` : `${role}.json`;
}

/** Writes every role's tool list where the bridges read it. Rewritten on each plugin start. */
export async function writeToolFiles(runtimeRoot: string): Promise<void> {
  const directory = join(runtimeRoot, 'tools');
  await ensurePrivateDirectory(directory);
  const targets: [string, ToolDefinition[]][] = [
    [toolsFile('supervisor'), toolDefinitions('supervisor')],
    [toolsFile('lead'), toolDefinitions('lead')],
    ...ASSIGNMENT_KINDS.map(kind => [toolsFile('peer', kind), toolDefinitions('peer', kind)] as [string, ToolDefinition[]]),
  ];
  for (const [name, tools] of targets) {
    // Derived, regenerable data: replaced atomically rather than published once.
    const temporary = join(directory, `.tmp-${name}-${String(process.pid)}`);
    await writeFile(temporary, `${JSON.stringify({ schema: 1, tools })}\n`, { mode: 0o600 });
    await rename(temporary, join(directory, name));
  }
}
