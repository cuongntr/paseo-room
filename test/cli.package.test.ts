import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import metadata from '../package.json' with { type: 'json' };
import { fixtureEnvironment, snapshotFixture } from './helpers/home.js';

it('packs and runs through npm exec without creating or changing home state', () => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !isAbsolute(npmCli)) throw new Error('Run this gate with npm run test:package');
  const npmExecutable: string = npmCli;
  const root = mkdtempSync(join(tmpdir(), 'paseo-room-package-'));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  mkdirSync(join(root, 'tmp'));

  function npm(args: string[], home: string, workingDirectory = cwd, expectedStatus = 0) {
    const result = spawnSync(process.execPath, [npmExecutable, ...args], {
      cwd: workingDirectory,
      env: fixtureEnvironment(root, home),
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(expectedStatus);
    return result;
  }

  try {
    const packed = npm([
      'pack', '--json', '--ignore-scripts', '--pack-destination', root,
    ], join(root, 'pack-home'), repository);
    const archiveSchema = z.object({
      filename: z.string(),
      files: z.array(z.object({ path: z.string() })),
    });
    // npm <=11 returns an array; npm 12 keys the report by package name.
    const archive = z.union([
      z.tuple([archiveSchema]).transform(([archive]) => archive),
      z.object({ 'paseo-room': archiveSchema }).transform((packages) => packages['paseo-room']),
    ]).parse(JSON.parse(packed.stdout));
    expect(archive.files.map((file) => file.path).sort()).toEqual([
      'README.md', 'dist/cli/index.js', 'dist/cli/index.js.map', 'package.json',
    ]);

    const tarball = join(root, archive.filename);
    // Read metadata from the actual packed artifact, not only the source manifest.
    const unpack = spawnSync('/usr/bin/tar', ['-xOf', tarball, 'package/package.json'], {
      cwd, env: fixtureEnvironment(root, join(root, 'pack-home')),
      encoding: 'utf8', shell: false, timeout: 10_000,
    });
    expect(unpack.status, unpack.stderr).toBe(0);
    const packedMetadata = z.object({
      name: z.literal('paseo-room'),
      version: z.literal(metadata.version),
      type: z.literal('module'),
      engines: z.object({ node: z.literal('>=22') }),
      bin: z.object({ 'paseo-room': z.literal('dist/cli/index.js') }),
      dependencies: z.object({ '@getpaseo/client': z.literal('0.8.0-beta.1') }),
    }).parse(JSON.parse(unpack.stdout));
    expect(packedMetadata.name).toBe('paseo-room');

    for (const state of ['absent', 'empty', 'populated']) {
      const home = join(root, `${state}-home`);
      if (state === 'empty') mkdirSync(home);
      if (state === 'populated') {
        cpSync(fileURLToPath(new URL('./fixtures/home', import.meta.url)), home, { recursive: true });
        symlinkSync('untouched.txt', join(home, 'unrelated-link'));
      }
      const before = snapshotFixture(home);
      for (const flag of ['--help', '--version']) {
        const result = npm(['exec', '--yes', '--package', tarball, '--', 'paseo-room', flag], home);
        expect(result.stderr).toBe('');
        if (flag === '--help') expect(result.stdout).toContain('Usage: paseo-room');
        else expect(result.stdout).toBe(`${metadata.version}\n`);
        expect(snapshotFixture(home)).toEqual(before);
      }
      for (const command of ['plan', 'install', 'verify', 'doctor', 'recover', 'uninstall']) {
        const args = [command, '--json', '--non-interactive', '--room-home', join(home, 'room'),
          '--codex-home', join(home, 'missing-codex-home'), '--codex-bin', join(home, 'missing-codex'),
          '--paseo-bin', join(home, 'missing-paseo')];
        const result = npm(['exec', '--yes', '--package', tarball, '--', 'paseo-room', ...args], home, cwd, 1);
        expect(result.stderr).toBe('');
        const unpacked = spawnSync(process.execPath, [join(repository, 'dist/cli/index.js'), ...args], {
          cwd, env: fixtureEnvironment(root, home), encoding: 'utf8', shell: false, timeout: 10000,
        });
        expect(unpacked.status).toBe(1); expect(unpacked.stderr).toBe('');
        expect(unpacked.stdout).toBe(result.stdout);
        expect(JSON.parse(result.stdout)).toMatchObject({
          schemaVersion: 1, command, outcome: 'failed', changed: false, operations: [],
        });
        expect(snapshotFixture(home)).toEqual(before);
      }
      const missing = npm(['exec', '--yes', '--package', tarball, '--', 'paseo-room', '--json'], home, cwd, 2);
      expect(JSON.parse(missing.stdout)).toMatchObject({ schemaVersion: 1, outcome: 'failed', changed: false });

    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
