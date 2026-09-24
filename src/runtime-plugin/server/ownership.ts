/**
 * Duplicate Lead detection (docs/design/runtime-coordination.md §5.2).
 *
 * The creation hook cannot prove parentage or uniqueness, so two Leads on one project are
 * detected from live evidence and contained: dispatch pauses, nothing is deleted, and the
 * authority recipient is paged. The runtime never resolves the conflict by creation time,
 * title or "latest wins"; it clears it only when evidence is unambiguous, otherwise Human decides.
 */
import type { Controller, LoadedProject } from './controller.js';
import type { Notices } from './notices.js';

const plugin = { source: 'plugin' as const };

export interface LeadEvidence {
  readonly leadAgentIds: readonly string[];
  readonly leadProviderIds: readonly string[];
}

/** Every live, unarchived room Lead whose workspace resolves to this project's repository. */
export async function projectLeads(controller: Controller, loaded: LoadedProject): Promise<LeadEvidence> {
  const agents = await controller.deps.paseo.listAgents();
  const leads: { agentId: string; providerId: string }[] = [];
  for (const agent of agents) {
    if (agent.archivedAt !== null || agent.status === 'closed') continue;
    if (controller.deps.recognition.recognize(agent.provider)?.role !== 'lead') continue;
    const identity = await controller.deps.git.identity(agent.cwd).catch(() => undefined);
    if (identity?.gitCommonDir === loaded.store.meta.gitCommonDir) leads.push({ agentId: agent.id, providerId: agent.provider });
  }
  return { leadAgentIds: leads.map(lead => lead.agentId).sort(), leadProviderIds: [...new Set(leads.map(lead => lead.providerId))].sort() };
}

/** Records and pages a new conflict, or clears one the evidence now settles. Call inside the project's queue. */
export async function checkLeadOwnership(controller: Controller, notices: Notices, loaded: LoadedProject): Promise<'clear' | 'conflict' | 'resolved'> {
  const evidence = await projectLeads(controller, loaded);
  const open = loaded.state.ownershipConflict;
  if (evidence.leadAgentIds.length > 1) {
    if (open !== undefined && JSON.stringify(open.leadAgentIds) === JSON.stringify(evidence.leadAgentIds)) return 'conflict';
    await controller.append(loaded, { type: 'project.ownership-conflict', payloadVersion: 1, actor: plugin, data: { ...evidence, leadAgentIds: [...evidence.leadAgentIds], leadProviderIds: [...evidence.leadProviderIds] } });
    const supervisor = controller.supervisorFor?.(loaded.store.meta.gitCommonDir) ?? await findSupervisor(controller);
    await notices.notify(loaded, {
      kind: 'duplicate-lead', class: 'page', disposition: supervisor === undefined ? 'human-required' : 'supervisor-now',
      text: `Leads ${evidence.leadAgentIds.join(', ')} are both active on project ${loaded.store.meta.canonicalRoot}. Runtime dispatch is paused; confirm the one Lead that owns this project.`,
      ...(supervisor === undefined ? {} : { recipient: { agentId: supervisor, role: 'supervisor' as const } }),
    });
    return 'conflict';
  }
  if (open === undefined) return 'clear';
  // Unambiguous only when exactly one Lead remains and it is the one that owns recorded work.
  const [remaining] = evidence.leadAgentIds;
  const owners = new Set([...loaded.state.assignments.values()].map(view => view.leadAgentId));
  if (remaining !== undefined && evidence.leadAgentIds.length === 1 && (owners.size === 0 || (owners.size === 1 && owners.has(remaining)))) {
    await controller.append(loaded, { type: 'project.ownership-resolved', payloadVersion: 1, actor: plugin, data: { keptLeadAgentId: remaining, decidedBy: 'evidence' } });
    return 'resolved';
  }
  return 'conflict';
}

async function findSupervisor(controller: Controller): Promise<string | undefined> {
  const supervisors = (await controller.deps.paseo.listAgents())
    .filter(agent => agent.archivedAt === null && agent.status !== 'closed' && controller.deps.recognition.recognize(agent.provider)?.role === 'supervisor');
  // One unambiguous Supervisor, or nobody: an ambiguous audience goes to the operator instead.
  return supervisors.length === 1 ? supervisors[0]?.id : undefined;
}
