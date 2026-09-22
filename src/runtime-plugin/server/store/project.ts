/**
 * Per-project runtime store (docs/design/runtime-coordination.md §4.1, §4.2).
 *
 * Immutable `meta.json` and immutable event files are the only authority. Everything under
 * `cache/` is disposable and rebuilt from replay. A project whose events cannot be read in full
 * is paused with its evidence preserved — never read as an empty ledger, never auto-repaired.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EVENT_SCHEMA, readEvent, validateForWrite, type RuntimeEventV1 } from '../events/schema.js';
import {
  AlreadyPublishedError, ensurePrivateDirectory, PRIVATE_FILE_MODE, publishOnce, staleTemporaries,
} from './publish.js';

export const RUNTIME_LAYOUT_VERSION = 'v1';
const EVENT_FILE = /^(\d{12})\.json$/;
const MAX_SEQUENCE_ATTEMPTS = 64;

export function runtimeRoot(roomHome: string): string {
  return join(roomHome, 'runtime', RUNTIME_LAYOUT_VERSION);
}

const metaSchema = z.strictObject({
  schema: z.literal(1),
  projectId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  canonicalRoot: z.string().min(1),
  gitCommonDir: z.string().min(1),
});
export type ProjectMeta = z.infer<typeof metaSchema>;

export interface ReplayProblem {
  readonly file: string;
  readonly reason: 'unknown-type' | 'unsupported-version' | 'invalid' | 'unreadable' | 'sequence-mismatch' | 'duplicate-id' | 'foreign-project' | 'unexpected-file';
  readonly detail: string;
}

export interface ReplayResult {
  /** `paused` means the ledger is not fully readable; callers must refuse every mutation. */
  readonly status: 'ok' | 'paused';
  readonly events: readonly RuntimeEventV1[];
  readonly problems: readonly ReplayProblem[];
  /** Sequence numbers absent between 1 and the last event. Allowed and reported. */
  readonly gaps: readonly number[];
  readonly staleTemporaries: readonly string[];
}

/** An event as a writer supplies it; the store assigns envelope identity and order. */
export type NewEvent = Omit<RuntimeEventV1, 'schema' | 'version' | 'id' | 'sequence' | 'projectId' | 'occurredAt'>;

function eventName(sequence: number): string {
  return `${String(sequence).padStart(12, '0')}.json`;
}

function slug(root: string): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return name === '' ? 'project' : name;
}

export class ProjectStore {
  private lastSequence = 0;

  private constructor(readonly directory: string, readonly meta: ProjectMeta, private readonly now: () => Date) {}

  get eventsDirectory(): string { return join(this.directory, 'events'); }
  get cacheDirectory(): string { return join(this.directory, 'cache'); }
  get gatesDirectory(): string { return join(this.directory, 'gates'); }
  get quarantineDirectory(): string { return join(this.directory, 'quarantine'); }

  /** Opens an existing project directory; refuses one whose `meta.json` is not exactly v1. */
  static async open(directory: string, now: () => Date = () => new Date()): Promise<ProjectStore> {
    const meta = metaSchema.parse(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')));
    return new ProjectStore(directory, meta, now);
  }

  /**
   * Binds a new project to its canonical Git common directory. Identity is a minted UUID, never
   * a hash of a movable path; a moved repository is rebound only by an explicit operator action.
   */
  static async create(
    root: string,
    binding: { readonly canonicalRoot: string; readonly gitCommonDir: string },
    now: () => Date = () => new Date(),
  ): Promise<ProjectStore> {
    const projects = join(root, 'projects');
    await ensurePrivateDirectory(projects);
    const projectId = randomUUID();
    const directory = join(projects, `${slug(binding.canonicalRoot)}-${projectId}`);
    await ensurePrivateDirectory(directory);
    for (const child of ['events', 'cache', 'gates', 'quarantine']) await ensurePrivateDirectory(join(directory, child));
    const meta: ProjectMeta = { schema: 1, projectId, createdAt: now().toISOString(), ...binding };
    await publishOnce(directory, 'meta.json', `${JSON.stringify(meta, null, 2)}\n`);
    const store = new ProjectStore(directory, meta, now);
    await store.append({ type: 'project.bound', payloadVersion: 1, actor: { source: 'plugin' }, data: { ...binding } });
    return store;
  }

  /** Finds the project bound to this Git common directory. Never matches by name, remote or cwd. */
  static async find(root: string, gitCommonDir: string, now?: () => Date): Promise<ProjectStore | undefined> {
    for (const store of await ProjectStore.list(root, now)) {
      if (store.meta.gitCommonDir === gitCommonDir) return store;
    }
    return undefined;
  }

  static async list(root: string, now?: () => Date): Promise<ProjectStore[]> {
    const projects = join(root, 'projects');
    let names: string[];
    try { names = await readdir(projects); } catch { return []; }
    const stores: ProjectStore[] = [];
    for (const name of names.sort()) {
      try { stores.push(await ProjectStore.open(join(projects, name), now)); } catch { /* reported by diagnostics, never adopted */ }
    }
    return stores;
  }

  /** Reads every event strictly. Any unreadable file pauses the project; nothing is moved. */
  async replay(): Promise<ReplayResult> {
    const names = (await readdir(this.eventsDirectory)).sort();
    const problems: ReplayProblem[] = [];
    const events: RuntimeEventV1[] = [];
    const ids = new Map<string, string>();
    for (const name of names) {
      if (name.startsWith('.tmp-')) continue;
      const match = EVENT_FILE.exec(name);
      if (!match) { problems.push({ file: name, reason: 'unexpected-file', detail: 'Not a runtime event file name.' }); continue; }
      let raw: string;
      let value: unknown;
      try {
        raw = await readFile(join(this.eventsDirectory, name), 'utf8');
        value = JSON.parse(raw);
      } catch (error) {
        problems.push({ file: name, reason: 'unreadable', detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const read = readEvent(value);
      if (!read.ok) { problems.push({ file: name, reason: read.reason, detail: read.detail }); continue; }
      const event = read.event;
      if (event.sequence !== Number(match[1])) {
        problems.push({ file: name, reason: 'sequence-mismatch', detail: `File name does not match sequence ${String(event.sequence)}.` });
        continue;
      }
      if (event.projectId !== this.meta.projectId) {
        problems.push({ file: name, reason: 'foreign-project', detail: `Event belongs to project ${event.projectId}.` });
        continue;
      }
      const previous = ids.get(event.id);
      if (previous !== undefined) {
        problems.push({ file: name, reason: 'duplicate-id', detail: `Event id ${event.id} is also used by ${previous}.` });
        continue;
      }
      ids.set(event.id, name);
      events.push(event);
    }
    const gaps: number[] = [];
    let expected = 1;
    for (const event of events) {
      for (; expected < event.sequence; expected += 1) gaps.push(expected);
      expected = event.sequence + 1;
    }
    const highest = names.map(name => EVENT_FILE.exec(name)?.[1]).filter((value): value is string => value !== undefined).map(Number);
    this.lastSequence = Math.max(this.lastSequence, 0, ...highest);
    return {
      status: problems.length === 0 ? 'ok' : 'paused',
      events,
      problems,
      gaps,
      staleTemporaries: await staleTemporaries(this.eventsDirectory),
    };
  }

  /**
   * Validates and publishes one event at the next free sequence. A concurrent writer that took
   * that sequence causes reallocation, never replacement.
   */
  async append(event: NewEvent): Promise<RuntimeEventV1> {
    if (this.lastSequence === 0) await this.replay();
    // Fixed per call, so concurrent appends probe successive free sequences instead of skipping.
    const base = this.lastSequence;
    for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
      const sequence = base + 1 + attempt;
      const full = validateForWrite({
        ...event,
        schema: EVENT_SCHEMA,
        version: 1,
        id: `evt_${randomBytes(12).toString('hex')}`,
        sequence,
        projectId: this.meta.projectId,
        occurredAt: this.now().toISOString(),
      });
      try {
        await publishOnce(this.eventsDirectory, eventName(sequence), `${JSON.stringify(full)}\n`);
        this.lastSequence = Math.max(this.lastSequence, sequence);
        return full;
      } catch (error) {
        if (!(error instanceof AlreadyPublishedError)) throw error;
      }
    }
    throw new Error(`Could not allocate an event sequence in ${this.eventsDirectory}.`);
  }

  /** Writes one disposable derived view. Cache files may be replaced; they are never authority. */
  async writeCache(name: string, content: string): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.cacheDirectory, `.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`);
    await writeFile(temporary, content, { mode: PRIVATE_FILE_MODE });
    await rename(temporary, join(this.cacheDirectory, name));
  }

  async readCache(name: string): Promise<string | undefined> {
    try { return await readFile(join(this.cacheDirectory, name), 'utf8'); } catch { return undefined; }
  }

  /** Deletes every cached view; the next replay rebuilds them. */
  async clearCache(): Promise<void> {
    await rm(this.cacheDirectory, { recursive: true, force: true });
    await ensurePrivateDirectory(this.cacheDirectory);
  }

  /** Moves one named event file aside. Only an explicit operator action calls this. */
  async quarantine(file: string): Promise<void> {
    if (!EVENT_FILE.test(file) && !file.startsWith('.tmp-')) throw new Error(`${file} is not a runtime event file.`);
    await ensurePrivateDirectory(this.quarantineDirectory);
    await rename(join(this.eventsDirectory, file), join(this.quarantineDirectory, file));
  }
}
