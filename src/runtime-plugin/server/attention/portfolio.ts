/**
 * The Supervisor portfolio (docs/design/runtime-coordination-attention.md A-D3, §11).
 *
 * Each observed project has at most one Supervisor: the Human's explicit assignment, when that
 * Supervisor is still a live room seat; otherwise the Supervisor that parents every live Lead of
 * the project (every Lead, when none is live); otherwise none, and the project's signals go to the
 * panel. Only the explicit
 * assignments are stored, in one small file replaced atomically.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDirectory } from '../store/publish.js';
import type { Observer } from './observer.js';

const fileSchema = z.object({
  schema: z.literal(1),
  projects: z.record(z.string(), z.object({ supervisorAgentId: z.string().min(1), at: z.string() })),
});

export type PortfolioDecision = 'human' | 'parentage' | 'none';

export interface Resolution {
  readonly supervisorAgentId?: string;
  readonly decidedBy: PortfolioDecision;
}

export class Portfolio {
  private assignments = new Map<string, { readonly supervisorAgentId: string; readonly at: string }>();

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  static at(runtimeRoot: string, now?: () => Date): Portfolio {
    return new Portfolio(join(runtimeRoot, 'attention', 'portfolio.json'), now);
  }

  /** Loads the stored assignments; a missing or unreadable file means none. */
  async load(): Promise<void> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      this.assignments = new Map(parsed.success ? Object.entries(parsed.data.projects) : []);
    } catch {
      this.assignments = new Map();
    }
  }

  explicit(projectKey: string): string | undefined {
    return this.assignments.get(projectKey)?.supervisorAgentId;
  }

  /** Records (or, with null, removes) the Human's choice of Supervisor for a project. */
  async assign(projectKey: string, supervisorAgentId: string | null): Promise<void> {
    if (supervisorAgentId === null) this.assignments.delete(projectKey);
    else this.assignments.set(projectKey, { supervisorAgentId, at: this.now().toISOString() });
    await ensurePrivateDirectory(dirname(this.file));
    const temporary = `${this.file}.tmp-${String(process.pid)}`;
    await writeFile(temporary, `${JSON.stringify({ schema: 1, projects: Object.fromEntries(this.assignments) })}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  /** The Supervisor of a project, by A-D3 precedence. */
  resolve(projectKey: string, observer: Pick<Observer, 'seat' | 'live' | 'seats'>): Resolution {
    const liveSupervisor = (agentId: string | null | undefined): agentId is string => {
      const seat = agentId === null || agentId === undefined ? undefined : observer.seat(agentId);
      return seat !== undefined && seat.role === 'supervisor' && seat.state !== 'archived';
    };
    const chosen = this.explicit(projectKey);
    if (chosen !== undefined) return liveSupervisor(chosen) ? { supervisorAgentId: chosen, decidedBy: 'human' } : { decidedBy: 'none' };
    // A project whose Leads are all archived keeps their Supervisor, so a Lead archived with work
    // still running reaches the Supervisor that opened it.
    const live = observer.live(projectKey, 'lead');
    const leads = live.length > 0 ? live : observer.seats().filter(seat => seat.project.key === projectKey && seat.role === 'lead');
    const parents = new Set(leads.map(lead => lead.parentAgentId));
    const [parent] = [...parents];
    return parents.size === 1 && liveSupervisor(parent) ? { supervisorAgentId: parent, decidedBy: 'parentage' } : { decidedBy: 'none' };
  }
}
