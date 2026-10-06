/**
 * What the server derives for the operator's panel alone (docs/design/runtime-panel-ux.md §6), as
 * the server writes it and the panel reads it. `runtime.project`, `runtime.assignment` and
 * `runtime.attention-status` carry these inside untyped views, so this is their one declaration.
 */

export type MilestoneTone = 'success' | 'warning' | 'danger' | 'accent' | 'muted';

/** One step a reader would name, for example `Gate failed (exit 1)` by the runtime at 14:02. */
export interface Milestone {
  readonly at: string;
  readonly assignmentId?: string;
  readonly label: string;
  readonly tone: MilestoneTone;
  readonly by: 'human' | 'lead' | 'peer' | 'supervisor' | 'runtime';
  /** A step worth a line in the project's recent activity, not only in the assignment's own history. */
  readonly major: boolean;
}

/** What reached Supervisors over a window, from the attention log, for the settings screen. */
export interface LetterTally {
  readonly hours: number;
  /** Letters sent, by level: `page`, `now`, `digest`. */
  readonly sent: Readonly<Record<string, number>>;
  readonly failed: number;
  readonly incidents: number;
  /** Lead turns by what was decided for them: `record`, `digest`, `now`. */
  readonly leadTurns: Readonly<Record<string, number>>;
  /** Rated items by their latest verdict, whether you or a Supervisor gave it. */
  readonly useful: number;
  readonly noise: number;
  /** Set when a day file was too large to read back, so the counts are short. */
  readonly partial?: true;
}

/**
 * One assignment as the room and a seat's view list it (panel delta 2026-10-02): what it is for,
 * where it stands, its Peer and its latest runtime gate.
 */
export interface AssignmentLine {
  readonly id: string;
  readonly gist: string;
  readonly kind: string;
  readonly state: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly settledAt?: string;
  readonly isolated?: boolean;
  readonly peerAgentId?: string;
  readonly gate?: 'running' | 'passed' | 'failed' | 'unknown';
}
