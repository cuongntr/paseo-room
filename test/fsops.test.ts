import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyEntries, ManagedPathError, planEntries, type Entry } from '../src/fsops.js';

async function makeRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'paseo-room-fsops-'));
}

/** Temporary siblings are dot-prefixed and carry this marker. */
async function temporaries(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter(name => name.includes('paseo-room-'));
}

describe('managed file and link replacement', () => {
  it('creates, updates, and stays idempotent for regular files', async () => {
    const root = await makeRoot();
    const path = join(root, 'settings.json');
    const entry: Entry = { kind: 'file', path, content: 'one' };

    expect(await planEntries([entry])).toEqual([{ action: 'create', kind: 'file', target: path }]);
    await applyEntries([entry]);
    expect(await readFile(path, 'utf8')).toBe('one');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await planEntries([entry])).toEqual([{ action: 'noop', kind: 'file', target: path }]);

    const updated: Entry = { kind: 'file', path, content: 'two' };
    expect(await planEntries([updated])).toEqual([{ action: 'update', kind: 'file', target: path }]);
    await applyEntries([updated]);
    expect(await readFile(path, 'utf8')).toBe('two');
    expect(await temporaries(root)).toEqual([]);
  });

  it('repoints an existing symlink and leaves no temporary sibling', async () => {
    const root = await makeRoot();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const path = join(root, 'skills');

    await applyEntries([{ kind: 'link', path, target: first }]);
    expect(await readlink(path)).toBe(first);
    await applyEntries([{ kind: 'link', path, target: second }]);
    expect(await readlink(path)).toBe(second);
    expect(await temporaries(root)).toEqual([]);
  });

  it('refuses to replace a directory standing where a managed file belongs', async () => {
    const root = await makeRoot();
    const path = join(root, 'CLAUDE.md');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'operator-data'), 'keep me');

    await expect(applyEntries([{ kind: 'file', path, content: 'role memory' }]))
      .rejects.toThrow(/Refusing to replace .*CLAUDE\.md: expected a regular file but found a directory/);
    expect(await readFile(join(path, 'operator-data'), 'utf8')).toBe('keep me');
  });

  it('refuses to replace a symlink standing where a managed file belongs', async () => {
    const root = await makeRoot();
    const operator = join(root, 'operator.md');
    await writeFile(operator, 'operator');
    const path = join(root, 'CLAUDE.md');
    await symlink(operator, path);

    await expect(applyEntries([{ kind: 'file', path, content: 'role memory' }]))
      .rejects.toThrow(/expected a regular file but found a symbolic link/);
    expect(await readlink(path)).toBe(operator);
    expect(await readFile(operator, 'utf8')).toBe('operator');
  });

  it('refuses to replace a regular file or directory standing where a managed link belongs', async () => {
    const root = await makeRoot();
    const filePath = join(root, 'skills');
    await writeFile(filePath, 'operator file');
    await expect(applyEntries([{ kind: 'link', path: filePath, target: root }]))
      .rejects.toThrow(/expected a symbolic link but found a regular file/);
    expect(await readFile(filePath, 'utf8')).toBe('operator file');

    const dirPath = join(root, 'plugins');
    await mkdir(dirPath, { recursive: true });
    await writeFile(join(dirPath, 'keep'), 'keep');
    await expect(applyEntries([{ kind: 'link', path: dirPath, target: root }]))
      .rejects.toThrow(/expected a symbolic link but found a directory/);
    expect(await readFile(join(dirPath, 'keep'), 'utf8')).toBe('keep');
  });

  it('reports an actionable fix and the offending path on refusal', async () => {
    const root = await makeRoot();
    const path = join(root, 'settings.json');
    await mkdir(path, { recursive: true });

    const error = await applyEntries([{ kind: 'file', path, content: '{}' }]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ManagedPathError);
    expect((error as ManagedPathError).path).toBe(path);
    expect((error as ManagedPathError).fix).toContain('move it aside manually');
  });

  it('refuses to replace a non-directory standing where a plain managed directory belongs', async () => {
    const root = await makeRoot();
    const path = join(root, 'peer');
    await writeFile(path, 'operator file');

    await expect(applyEntries([{ kind: 'dir', path }]))
      .rejects.toThrow(/expected a directory but found a regular file/);
    expect(await readFile(path, 'utf8')).toBe('operator file');
  });

  it('writes a once file only when absent and never rewrites it', async () => {
    const root = await makeRoot();
    const path = join(root, '.claude.json');
    await applyEntries([{ kind: 'file', path, content: 'seed', once: true }]);
    await writeFile(path, 'runtime state');
    await applyEntries([{ kind: 'file', path, content: 'seed', once: true }]);
    expect(await readFile(path, 'utf8')).toBe('runtime state');
  });
});

describe('temporary cleanup on failure', () => {
  it('removes the temporary sibling when the rename fails', async () => {
    vi.resetModules();
    const root = await makeRoot();
    const path = join(root, 'settings.json');

    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return { ...actual, rename: () => Promise.reject(new Error('synthetic EXDEV')) };
    });
    try {
      const { applyEntries: apply } = await import('../src/fsops.js');
      await expect(apply([{ kind: 'file', path, content: 'one' }])).rejects.toThrow('synthetic EXDEV');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(await temporaries(root)).toEqual([]);
    await expect(lstat(path)).rejects.toThrow();
  });

  it('removes the temporary sibling when the write fails', async () => {
    vi.resetModules();
    const root = await makeRoot();
    const path = join(root, 'settings.json');

    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return { ...actual, chmod: () => Promise.reject(new Error('synthetic EPERM')) };
    });
    try {
      const { applyEntries: apply } = await import('../src/fsops.js');
      await expect(apply([{ kind: 'file', path, content: 'one' }])).rejects.toThrow('synthetic EPERM');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(await temporaries(root)).toEqual([]);
  });
});

describe('exact managed directory', () => {
  async function operatorSkills(root: string): Promise<string> {
    const skills = join(root, 'operator-skills');
    await mkdir(join(skills, 'alpha'), { recursive: true });
    await mkdir(join(skills, 'beta'), { recursive: true });
    return skills;
  }

  function projection(path: string, children: readonly string[], legacyLink?: string): Entry[] {
    return [
      { kind: 'managed-dir', path, children, ...(legacyLink === undefined ? {} : { legacyLink }) },
      ...children.map((name): Entry => ({ kind: 'link', path: join(path, name), target: join(legacyLink ?? path, name) })),
    ];
  }

  it('plans as a directory and creates the declared children', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    const entries = projection(path, ['alpha', 'beta'], skills);

    expect(await planEntries(entries)).toEqual([
      { action: 'create', kind: 'dir', target: path },
      { action: 'create', kind: 'link', target: join(path, 'alpha') },
      { action: 'create', kind: 'link', target: join(path, 'beta') },
    ]);
    await applyEntries(entries);
    expect((await readdir(path)).sort()).toEqual(['alpha', 'beta']);
    expect(await planEntries(entries)).toEqual([
      { action: 'noop', kind: 'dir', target: path },
      { action: 'noop', kind: 'link', target: join(path, 'alpha') },
      { action: 'noop', kind: 'link', target: join(path, 'beta') },
    ]);
  });

  it('removes only undeclared children', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    await applyEntries(projection(path, ['alpha', 'beta'], skills));
    await symlink(join(skills, 'alpha'), join(path, 'gamma'));

    const narrowed = projection(path, ['alpha'], skills);
    expect(await planEntries(narrowed)).toEqual([
      { action: 'update', kind: 'dir', target: path },
      { action: 'noop', kind: 'link', target: join(path, 'alpha') },
    ]);
    await applyEntries(narrowed);
    expect(await readdir(path)).toEqual(['alpha']);
    // Reconciliation removed the room's own aliases, never the operator skills.
    expect((await readdir(skills)).sort()).toEqual(['alpha', 'beta']);
  });

  it('migrates the declared legacy directory symlink without touching its target', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    await mkdir(join(root, 'peer'), { recursive: true });
    await symlink(skills, path);

    const entries = projection(path, ['alpha', 'beta'], skills);
    // Through the legacy alias each child resolves to the operator directory itself,
    // so the projection reads as drift until the alias is replaced by real child links.
    expect(await planEntries(entries)).toEqual([
      { action: 'update', kind: 'dir', target: path },
      { action: 'update', kind: 'link', target: join(path, 'alpha') },
      { action: 'update', kind: 'link', target: join(path, 'beta') },
    ]);
    await applyEntries(entries);

    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect((await readdir(path)).sort()).toEqual(['alpha', 'beta']);
    expect((await readdir(skills)).sort()).toEqual(['alpha', 'beta']);
    expect((await lstat(join(skills, 'alpha'))).isDirectory()).toBe(true);
  });

  it('refuses a symlink that is not the declared legacy link', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'keep'), 'keep');
    const path = join(root, 'peer', 'skills');
    await mkdir(join(root, 'peer'), { recursive: true });
    await symlink(elsewhere, path);

    await expect(applyEntries([{ kind: 'managed-dir', path, children: ['alpha'], legacyLink: skills }]))
      .rejects.toThrow(/this room owns that directory, but it is a symbolic link to/);
    expect(await readlink(path)).toBe(elsewhere);
    expect(await readFile(join(elsewhere, 'keep'), 'utf8')).toBe('keep');
  });

  it('refuses a symlink when no legacy migration is declared', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    await mkdir(join(root, 'peer'), { recursive: true });
    await symlink(skills, path);

    await expect(applyEntries([{ kind: 'managed-dir', path, children: ['alpha'] }]))
      .rejects.toThrow(/symbolic link to/);
    expect(await readlink(path)).toBe(skills);
  });

  it('refuses a stale child that is a real directory instead of deleting it recursively', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    await applyEntries(projection(path, ['alpha'], skills));
    const intruder = join(path, 'unexpected');
    await mkdir(intruder, { recursive: true });
    await writeFile(join(intruder, 'data'), 'do not delete');

    await expect(applyEntries([{ kind: 'managed-dir', path, children: ['alpha'], legacyLink: skills }]))
      .rejects.toThrow(/that stale child is a directory rather than a generated file or link/);
    expect(await readFile(join(intruder, 'data'), 'utf8')).toBe('do not delete');
  });

  it('refuses a regular file standing where the managed directory belongs', async () => {
    const root = await makeRoot();
    const path = join(root, 'peer-skills');
    await writeFile(path, 'operator file');

    await expect(applyEntries([{ kind: 'managed-dir', path, children: [] }]))
      .rejects.toThrow(/expected a directory this room owns but found a regular file/);
    expect(await readFile(path, 'utf8')).toBe('operator file');
  });

  it('cleans a leaked temporary sibling as a stale child', async () => {
    const root = await makeRoot();
    const skills = await operatorSkills(root);
    const path = join(root, 'peer', 'skills');
    await applyEntries(projection(path, ['alpha'], skills));
    const leaked = join(path, '.alpha.paseo-room-deadbeef');
    await writeFile(leaked, 'leftover');
    await chmod(leaked, 0o600);

    await applyEntries(projection(path, ['alpha'], skills));
    expect(await readdir(path)).toEqual(['alpha']);
  });
});

describe('managed directory containment', () => {
  it('never removes children of an ordinary managed directory', async () => {
    const root = await makeRoot();
    const path = join(root, 'roles', 'codex', 'peer');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'auth.json'), '{"token":"role-owned"}');

    await applyEntries([{ kind: 'dir', path }]);
    expect(await readFile(join(path, 'auth.json'), 'utf8')).toBe('{"token":"role-owned"}');
    await rm(root, { recursive: true, force: true });
  });
});
