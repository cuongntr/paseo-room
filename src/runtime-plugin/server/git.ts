/**
 * Read-only Git evidence (docs/design/runtime-coordination.md D5, §4.4).
 *
 * The runtime derives candidate identity from the repository itself and never copies a Peer's
 * claim into it. Every command here only reads: nothing merges, resets, cleans, stashes,
 * commits, pushes or deletes a branch. Status runs with optional locks off, so even observing
 * a workspace cannot rewrite its index.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
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
