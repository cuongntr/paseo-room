/**
 * Read-only Git evidence (docs/design/runtime-coordination.md D5, §4.4).
 *
 * The runtime derives candidate identity from the repository itself and never copies a Peer's
 * claim into it. Every command here only reads: nothing merges, resets, cleans, stashes,
 * commits, pushes or deletes a branch. Status runs with optional locks off, so even observing
 * a workspace cannot rewrite its index.
 */
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CandidateRefV1 } from './contracts/assignment.js';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/** Runs `git` without a shell, with a fixed locale and no optional locks. */
export function gitRunner(executable = 'git'): GitRunner {
  return (cwd, args) => new Promise(resolvePromise => {
    execFile(executable, ['-c', 'core.quotepath=off', ...args], {
      cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export class GitEvidenceError extends Error {
  constructor(message: string, readonly code: 'not-a-repository' | 'git-failed' | 'unexpected-output') {
    super(message);
    this.name = 'GitEvidenceError';
  }
}

export interface RepositoryIdentity {
  readonly canonicalRoot: string;
  readonly gitCommonDir: string;
}

export type CandidateDerivation =
  | { readonly ok: true; readonly candidate: CandidateRefV1; readonly noChange: boolean }
  | { readonly ok: false; readonly code: 'dirty' | 'not-descendant' | 'wrong-repository'; readonly message: string };

export type DispatchPrecondition =
  | { readonly ok: true; readonly head: string }
  | { readonly ok: false; readonly code: 'wrong-repository' | 'base-mismatch' | 'dirty'; readonly message: string };

export type WorktreeProof =
  | { readonly ok: true; readonly root: string; readonly head: string; readonly branch?: string }
  | { readonly ok: false; readonly code: 'not-a-repository' | 'wrong-repository' | 'lead-directory' | 'not-linked' | 'head-mismatch' | 'dirty'; readonly message: string };

/** Whether a retained worktree may be closed without destroying anything unrecorded (P2-D7). */
export type CloseReadiness = 'clean-at-candidate' | 'clean-at-base' | 'dirty' | 'unrecorded-commits' | 'missing';

/** What `paseo.json` at a commit declares for worktree setup (P2-D5). */
export type SetupDeclaration = 'absent' | 'none' | 'declared' | 'unreadable';

/** Paseo's own reading of `worktree.setup`: a non-blank string, or the non-blank strings of an array. */
function setupCommands(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];
}

export class GitEvidence {
  constructor(private readonly git: GitRunner = gitRunner()) {}

  private async read(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.git(cwd, args);
    if (result.code !== 0) throw new GitEvidenceError(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`, 'git-failed');
    return result.stdout;
  }

  /**
   * The canonical worktree root and the canonical common directory. Every worktree of one
   * repository shares its common directory, which is what binds them to one runtime project.
   */
  async identity(cwd: string): Promise<RepositoryIdentity> {
    const probe = await this.git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    if (probe.code !== 0) throw new GitEvidenceError(`${cwd} is not inside a Git working tree.`, 'not-a-repository');
    const [top, common] = probe.stdout.split('\n');
    if (top === undefined || top === '' || common === undefined || common === '') {
      throw new GitEvidenceError('git rev-parse returned no repository paths.', 'unexpected-output');
    }
    const canonicalRoot = await realpath(top);
    const gitCommonDir = await realpath(isAbsolute(common) ? common : resolve(cwd, common));
    return { canonicalRoot, gitCommonDir };
  }

  async head(root: string): Promise<string> {
    const head = (await this.read(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!COMMIT.test(head)) throw new GitEvidenceError(`HEAD resolved to ${head}, not a full commit id.`, 'unexpected-output');
    return head;
  }

  async branch(root: string): Promise<string | undefined> {
    const result = await this.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const name = result.stdout.trim();
    return result.code === 0 && name !== '' ? name : undefined;
  }

  /** D5 cleanliness: no tracked change and no untracked file. Ignored files are out of scope. */
  async isClean(root: string): Promise<boolean> {
    return (await this.read(root, ['status', '--porcelain=v1', '--untracked-files=all'])).trim() === '';
  }

  async isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new GitEvidenceError(`git merge-base failed: ${result.stderr.trim()}`, 'git-failed');
  }

  /** Every path the committed range touches, renames split into their old and new names. */
  async changedPaths(root: string, base: string, candidate: string): Promise<string[]> {
    const output = await this.read(root, ['diff', '--name-only', '-z', '--no-renames', base, candidate, '--']);
    return [...new Set(output.split('\0').filter(path => path !== ''))].sort();
  }

  /** The single observed precondition for writable dispatch (D5). */
  async dispatchPrecondition(cwd: string, expected: { readonly gitCommonDir: string; readonly baseCommit: string }): Promise<DispatchPrecondition> {
    const identity = await this.identity(cwd);
    if (identity.gitCommonDir !== expected.gitCommonDir) {
      return { ok: false, code: 'wrong-repository', message: `The workspace belongs to ${identity.gitCommonDir}, not ${expected.gitCommonDir}.` };
    }
    const head = await this.head(identity.canonicalRoot);
    if (head !== expected.baseCommit) {
      return { ok: false, code: 'base-mismatch', message: `HEAD is ${head}, not the assignment base ${expected.baseCommit}.` };
    }
    if (!await this.isClean(identity.canonicalRoot)) {
      return { ok: false, code: 'dirty', message: 'The workspace has uncommitted or untracked changes; the runtime never cleans, resets or stashes them.' };
    }
    return { ok: true, head };
  }

  /** Whether a path exists at all; Paseo's worktree close may leave the directory behind. */
  async directoryPresent(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Proves a runtime-requested worktree before any Peer is placed in it (delta P2-D4): a linked
   * worktree of this repository, not Lead's directory, at exactly the base, with a clean tree.
   * Paseo may silently branch from an existing branch instead of the base, so this is mandatory.
   */
  async provesWorktree(dir: string, expected: { readonly gitCommonDir: string; readonly baseCommit: string; readonly leadRoot: string }): Promise<WorktreeProof> {
    let identity: RepositoryIdentity;
    try {
      identity = await this.identity(dir);
    } catch (error) {
      return { ok: false, code: 'not-a-repository', message: error instanceof Error ? error.message : String(error) };
    }
    if (identity.gitCommonDir !== expected.gitCommonDir) {
      return { ok: false, code: 'wrong-repository', message: `The worktree belongs to ${identity.gitCommonDir}, not ${expected.gitCommonDir}.` };
    }
    const leadRoot = await realpath(expected.leadRoot).catch(() => expected.leadRoot);
    if (identity.canonicalRoot === leadRoot) return { ok: false, code: 'lead-directory', message: 'The workspace is Lead\'s own directory, not a new worktree.' };
    const gitDir = (await this.read(identity.canonicalRoot, ['rev-parse', '--absolute-git-dir'])).trim();
    if (await realpath(gitDir).catch(() => gitDir) === identity.gitCommonDir) {
      return { ok: false, code: 'not-linked', message: `${identity.canonicalRoot} is a main checkout, not a linked worktree.` };
    }
    const head = await this.head(identity.canonicalRoot);
    if (head !== expected.baseCommit) {
      return { ok: false, code: 'head-mismatch', message: `The worktree HEAD is ${head}, not the assignment base ${expected.baseCommit}.` };
    }
    if (!await this.isClean(identity.canonicalRoot)) return { ok: false, code: 'dirty', message: 'The new worktree already has changes.' };
    const branch = await this.branch(identity.canonicalRoot);
    return { ok: true, root: identity.canonicalRoot, head, ...(branch === undefined ? {} : { branch }) };
  }

  /**
   * Close readiness of a worktree after its writer is released: clean at the recorded candidate
   * or the unchanged base may close; anything else is retained for Lead's decision.
   */
  async closeReadiness(dir: string, expected: { readonly candidate?: string; readonly base: string }): Promise<CloseReadiness> {
    if (!await this.directoryPresent(dir)) return 'missing';
    const root = (await this.identity(dir)).canonicalRoot;
    if (!await this.isClean(root)) return 'dirty';
    const head = await this.head(root);
    if (expected.candidate !== undefined && head === expected.candidate) return 'clean-at-candidate';
    return head === expected.base ? 'clean-at-base' : 'unrecorded-commits';
  }

  /**
   * Reads `paseo.json` exactly as committed at `commit`, never from any working tree. Setup
   * that cannot be read is treated as declared by the caller.
   */
  async setupDeclared(root: string, commit: string): Promise<SetupDeclaration> {
    const present = await this.git(root, ['cat-file', '-e', `${commit}:paseo.json`]);
    if (present.code !== 0) return 'absent';
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.read(root, ['show', `${commit}:paseo.json`]));
    } catch {
      return 'unreadable';
    }
    if (typeof parsed !== 'object' || parsed === null) return 'unreadable';
    const worktree = (parsed as { worktree?: unknown }).worktree;
    const setup = typeof worktree === 'object' && worktree !== null ? (worktree as { setup?: unknown }).setup : undefined;
    return setupCommands(setup).length > 0 ? 'declared' : 'none';
  }

  /**
   * Derives the immutable candidate for a writable handoff: HEAD of a clean workspace that
   * descends from the base. A no-change outcome resolves to the base itself.
   */
  async deriveCandidate(cwd: string, expected: { readonly gitCommonDir: string; readonly baseCommit: string; readonly workspaceId: string }): Promise<CandidateDerivation> {
    const identity = await this.identity(cwd);
    if (identity.gitCommonDir !== expected.gitCommonDir) {
      return { ok: false, code: 'wrong-repository', message: `The workspace belongs to ${identity.gitCommonDir}, not ${expected.gitCommonDir}.` };
    }
    const root = identity.canonicalRoot;
    if (!await this.isClean(root)) {
      return { ok: false, code: 'dirty', message: 'Commit or remove every change first: a handoff is an immutable commit in a clean workspace.' };
    }
    const head = await this.head(root);
    if (!await this.isAncestor(root, expected.baseCommit, head)) {
      return { ok: false, code: 'not-descendant', message: `HEAD ${head} does not descend from the assignment base ${expected.baseCommit}.` };
    }
    const branch = await this.branch(root);
    return {
      ok: true,
      noChange: head === expected.baseCommit,
      candidate: {
        kind: 'git-commit', commit: head, baseCommit: expected.baseCommit,
        changedPaths: head === expected.baseCommit ? [] : await this.changedPaths(root, expected.baseCommit, head),
        workspaceId: expected.workspaceId, ...(branch === undefined ? {} : { branch }),
      },
    };
  }
}
