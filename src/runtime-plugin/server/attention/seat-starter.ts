/**
 * Human-started seats (docs/design/runtime-coordination-attention.md A-D9, §8.1, §8.2).
 *
 * The operator starts a Supervisor in an existing non-Git directory, or a project Lead under a
 * chosen Supervisor, from the panel. Paseo creates both; the runtime chooses no model and creates
 * no directory. A project Lead gets a fixed kickoff naming its project, its Supervisor, the
 * preflight findings and the Human's directive verbatim, and the choice of Supervisor is recorded
 * in the portfolio.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { GitEvidence } from '../git.js';
import type { PaseoPort, PeerLaunch } from '../paseo-port.js';
import type { Recognition } from '../recognition.js';
import type { AttentionEngine } from './engine.js';

export const PROTOCOL_FILE = 'WORKSPACE_PROTOCOL.md';

export type StartResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

export interface Preflight {
  readonly path: string;
  readonly root: string;
  readonly name: string;
  readonly git: boolean;
  readonly hasCommit: boolean;
  readonly protocol: boolean;
  readonly existingLead?: { readonly agentId: string; readonly title: string | null };
  /** Facts the Lead is told in its kickoff; none of them refuses the start. */
  readonly findings: readonly string[];
}

export interface SeatStarterDependencies {
  readonly paseo: Pick<PaseoPort, 'resolveLaunch' | 'createAgent' | 'createAgentInWorkspace' | 'openWorkspace' | 'run'>;
  readonly git: Pick<GitEvidence, 'identity' | 'head'>;
  readonly recognition: Pick<Recognition, 'recognize'>;
  readonly attention: AttentionEngine;
}

const refuse = (code: string, message: string): StartResult<never> => ({ ok: false, code, message });

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then(entry => entry.isDirectory(), () => false);
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

export class SeatStarter {
  constructor(private readonly deps: SeatStarterDependencies) {}

  /** What starting a Lead at `path` would find. Refuses only a path that is not a directory. */
  async preflight(path: string): Promise<StartResult<Preflight>> {
    if (!isAbsolute(path)) return refuse('path_invalid', 'Give an absolute path.');
    const target = resolve(path);
    if (!(await isDirectory(target))) return refuse('path_invalid', `${target} is not an existing directory.`);
    const findings: string[] = [];
    const identity = await this.deps.git.identity(target).catch(() => undefined);
    const root = identity?.canonicalRoot ?? target;
    let hasCommit = false;
    if (identity === undefined) {
      findings.push('not a Git repository: runtime assignments are unavailable here');
    } else {
      hasCommit = await this.deps.git.head(identity.canonicalRoot).then(() => true, () => false);
      if (!hasCommit) findings.push('the repository has no commit yet: runtime assignments need one');
    }
    const protocol = await exists(join(root, PROTOCOL_FILE));
    const attention = this.deps.attention;
    await attention.run(() => attention.sweep());
    const project = await attention.observer.projectOf(root);
    const lead = attention.observer.live(project.key, 'lead')[0];
    return {
      ok: true,
      value: {
        path: target, root, name: basename(root), git: identity !== undefined, hasCommit, protocol, findings,
        ...(lead === undefined ? {} : { existingLead: { agentId: lead.agentId, title: lead.title } }),
      },
    };
  }

  private async launch(provider: string, role: 'supervisor' | 'lead'): Promise<StartResult<PeerLaunch>> {
    if (this.deps.recognition.recognize(provider)?.role !== role) return refuse('provider_invalid', `${provider} is not a room ${role} provider.`);
    const launch = await this.deps.paseo.resolveLaunch(provider);
    if (launch === undefined) return refuse('model_unavailable', `No model is configured for ${provider}; set one in its room profile.`);
    return { ok: true, value: launch };
  }

  /** Starts a Supervisor with no parent and no prompt, in an existing directory outside Git. */
  async startSupervisor(input: { readonly provider: string; readonly cwd: string; readonly title?: string | undefined; readonly idempotencyKey: string }): Promise<StartResult<{ readonly agentId: string }>> {
    const launch = await this.launch(input.provider, 'supervisor');
    if (!launch.ok) return launch;
    if (!isAbsolute(input.cwd) || !(await isDirectory(input.cwd))) return refuse('path_invalid', `${input.cwd} is not an existing directory; the runtime creates none.`);
    if (await this.deps.git.identity(input.cwd).then(() => true, () => false)) {
      return refuse('path_in_repository', `${input.cwd} is inside a Git repository; a Supervisor stands outside the projects it supervises.`);
    }
    const created = await this.deps.paseo.createAgent({
      provider: input.provider, cwd: resolve(input.cwd), title: input.title?.trim() || 'Room Supervisor', labels: {},
      ...launch.value, idempotencyKey: `supervisor-${input.idempotencyKey}`,
    });
    await this.deps.attention.onCreated(created.agentId);
    return { ok: true, value: created };
  }

  /** Starts a project Lead under a live room Supervisor and sends its kickoff. */
  async startProject(input: { readonly path: string; readonly supervisorAgentId: string; readonly provider: string; readonly directive?: string | undefined; readonly idempotencyKey: string }): Promise<StartResult<{ readonly agentId: string }>> {
    const launch = await this.launch(input.provider, 'lead');
    if (!launch.ok) return launch;
    // Preflight also brings the Observer up to date, so the Supervisor check reads current seats.
    const checked = await this.preflight(input.path);
    if (!checked.ok) return checked;
    const supervisor = this.deps.attention.observer.seat(input.supervisorAgentId);
    if (supervisor?.role !== 'supervisor' || supervisor.state === 'archived') return refuse('supervisor_invalid', `${input.supervisorAgentId} is not a live room Supervisor.`);
    const found = checked.value;
    if (found.existingLead !== undefined) {
      return refuse('lead_exists', `Lead ${found.existingLead.title ?? found.existingLead.agentId} (${found.existingLead.agentId}) already owns ${found.name}; assign its Supervisor instead.`);
    }
    // Through the project's own workspace: a parented agent created by cwd alone lands in its
    // parent's workspace, which for a Supervisor is outside every project.
    const workspace = await this.deps.paseo.openWorkspace(found.root);
    if (workspace.directory !== null && resolve(workspace.directory) !== found.root) {
      return refuse('workspace_mismatch', `Paseo opened ${workspace.directory} for ${found.root}; start the Lead from Paseo instead.`);
    }
    const created = await this.deps.paseo.createAgentInWorkspace(workspace.id, {
      provider: input.provider, parentAgentId: supervisor.agentId, title: `${found.name} — Lead`, labels: {},
      ...launch.value, idempotencyKey: `lead-${input.idempotencyKey}`,
    });
    await this.deps.paseo.run(created.agentId, kickoff(found, supervisor.title ?? 'Room Supervisor', supervisor.agentId, input.directive), `kickoff-${input.idempotencyKey}`);
    const attention = this.deps.attention;
    await attention.onCreated(created.agentId);
    const project = await attention.observer.projectOf(found.root);
    await attention.portfolio.assign(project.key, supervisor.agentId);
    return { ok: true, value: created };
  }

  /** Records (or clears) the Human's choice of Supervisor for an observed project. */
  async assignSupervisor(projectKey: string, supervisorAgentId: string | null): Promise<StartResult<{ readonly assigned: boolean }>> {
    const attention = this.deps.attention;
    await attention.run(() => attention.sweep());
    if (!attention.observer.projects().has(projectKey)) return refuse('project_unknown', 'No observed project has that key.');
    if (supervisorAgentId !== null) {
      const seat = attention.observer.seat(supervisorAgentId);
      if (seat?.role !== 'supervisor' || seat.state === 'archived') return refuse('supervisor_invalid', `${supervisorAgentId} is not a live room Supervisor.`);
    }
    await attention.portfolio.assign(projectKey, supervisorAgentId);
    return { ok: true, value: { assigned: supervisorAgentId !== null } };
  }
}

/** The fixed kickoff a Human-started Lead receives (delta §8.2). */
export function kickoff(found: Preflight, supervisorTitle: string, supervisorAgentId: string, directive: string | undefined): string {
  const protocol = found.protocol ? `present at ${PROTOCOL_FILE}` : 'absent';
  const findings = found.findings.length === 0 ? 'no findings' : found.findings.join('; ');
  const next = directive === undefined || directive.trim() === '' ? 'Wait for a directive.' : directive;
  return `[paseo-room] You are the Lead of ${found.name} (${found.root}). Your Supervisor is ${supervisorTitle} (${supervisorAgentId}). Repository protocol: ${protocol}. Preflight: ${findings}.\n\n${next}`;
}
