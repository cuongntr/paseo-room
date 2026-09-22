import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitEvidence, GitEvidenceError } from '../src/runtime-plugin/server/git.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout.trim();
}

async function repository(): Promise<{ root: string; base: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-git-')));
  roots.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'hello\n');
  await writeFile(join(root, '.gitignore'), 'build/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'base');
  return { root, base: await git(root, 'rev-parse', 'HEAD') };
}

const evidence = new GitEvidence();

describe('read-only Git evidence', () => {
  it('binds main checkout and linked worktrees to one canonical common directory', async () => {
    const { root } = await repository();
    const identity = await evidence.identity(join(root));
    expect(identity).toEqual({ canonicalRoot: root, gitCommonDir: join(root, '.git') });
    await mkdir(join(root, 'nested'));
    expect((await evidence.identity(join(root, 'nested'))).canonicalRoot).toBe(root);

    const tree = join(root, '..', `${root.split('/').at(-1) ?? 'x'}-wt`);
    roots.push(tree);
    await git(root, 'worktree', 'add', '-q', tree, '-b', 'lane');
    const linked = await evidence.identity(tree);
    expect(linked.gitCommonDir).toBe(identity.gitCommonDir);
    expect(linked.canonicalRoot).toBe(await realpath(tree));

    const outside = await mkdtemp(join(tmpdir(), 'paseo-room-nogit-'));
    roots.push(outside);
    await expect(evidence.identity(outside)).rejects.toBeInstanceOf(GitEvidenceError);
  });

  it('allows dispatch only from a clean workspace at the exact base', async () => {
    const { root, base } = await repository();
    const expected = { gitCommonDir: join(root, '.git'), baseCommit: base };
    expect(await evidence.dispatchPrecondition(root, expected)).toEqual({ ok: true, head: base });

    await writeFile(join(root, 'README.md'), 'changed\n');
    expect(await evidence.dispatchPrecondition(root, expected)).toMatchObject({ ok: false, code: 'dirty' });
    await git(root, 'checkout', '--', 'README.md');

    await writeFile(join(root, 'untracked.txt'), 'x');
    expect(await evidence.dispatchPrecondition(root, expected)).toMatchObject({ ok: false, code: 'dirty' });
    await rm(join(root, 'untracked.txt'));

    // Ignored files are outside the evidence contract.
    await mkdir(join(root, 'build'));
    await writeFile(join(root, 'build', 'out.js'), 'x');
    expect((await evidence.dispatchPrecondition(root, expected)).ok).toBe(true);

    await writeFile(join(root, 'a.ts'), 'a');
    await git(root, 'add', 'a.ts');
    await git(root, 'commit', '-q', '-m', 'moved');
    expect(await evidence.dispatchPrecondition(root, expected)).toMatchObject({ ok: false, code: 'base-mismatch' });
    expect(await evidence.dispatchPrecondition(root, { ...expected, gitCommonDir: '/elsewhere/.git' })).toMatchObject({ ok: false, code: 'wrong-repository' });
  });

  it('derives the candidate and exact changed paths from committed history', async () => {
    const { root, base } = await repository();
    const expected = { gitCommonDir: join(root, '.git'), baseCommit: base, workspaceId: 'ws1' };
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'new.ts'), 'x');
    await git(root, 'mv', 'README.md', 'GUIDE.md');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'work');
    const head = await git(root, 'rev-parse', 'HEAD');

    const derived = await evidence.deriveCandidate(root, expected);
    expect(derived).toEqual({
      ok: true, noChange: false,
      candidate: { kind: 'git-commit', commit: head, baseCommit: base, changedPaths: ['GUIDE.md', 'README.md', 'src/new.ts'], workspaceId: 'ws1', branch: 'main' },
    });
  });

  it('resolves a no-change handoff to the base and refuses dirty or unrelated history', async () => {
    const { root, base } = await repository();
    const expected = { gitCommonDir: join(root, '.git'), baseCommit: base, workspaceId: 'ws1' };
    expect(await evidence.deriveCandidate(root, expected)).toMatchObject({ ok: true, noChange: true, candidate: { commit: base, changedPaths: [] } });

    await writeFile(join(root, 'wip.ts'), 'x');
    expect(await evidence.deriveCandidate(root, expected)).toMatchObject({ ok: false, code: 'dirty' });
    await rm(join(root, 'wip.ts'));

    await git(root, 'checkout', '-q', '--orphan', 'other');
    await git(root, 'commit', '-q', '-m', 'unrelated');
    expect(await evidence.deriveCandidate(root, expected)).toMatchObject({ ok: false, code: 'not-descendant' });
  });

  it('never writes to the repository while observing it', async () => {
    const { root } = await repository();
    const index = await readFile(join(root, '.git', 'index'));
    await writeFile(join(root, 'README.md'), 'touched\n');
    await evidence.isClean(root);
    await evidence.head(root);
    // GIT_OPTIONAL_LOCKS=0: status does not refresh and rewrite the index.
    expect(await readFile(join(root, '.git', 'index'))).toEqual(index);
    expect(await git(root, 'stash', 'list')).toBe('');
  });
});
