import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Only use on synthetic fixture trees, never operator homes or credentials. */
export function snapshotFixture(path: string): unknown {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const metadata = { mode: stat.mode, mtimeMs: stat.mtimeMs };
  if (stat.isSymbolicLink()) {
    return { ...metadata, link: readlinkSync(path) };
  }
  if (stat.isDirectory()) {
    return {
      ...metadata,
      entries: readdirSync(path).sort().map((name) => [name, snapshotFixture(join(path, name))]),
    };
  }
  if (!stat.isFile()) throw new Error('Unexpected fixture file type');
  return { ...metadata, bytes: readFileSync(path).toString('base64') };
}

/** npm's own cache/logs live outside the home being checked for CLI mutation. */
export function fixtureEnvironment(root: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_RUNTIME_DIR: join(home, '.runtime'),
    CODEX_HOME: join(home, '.codex'),
    PASEO_HOME: join(home, '.paseo'),
    PASEO_ROOM_HOME: join(home, '.local/share/paseo-room'),
    TMPDIR: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'empty.npmrc'),
    npm_config_globalconfig: join(root, 'empty-global.npmrc'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
}
