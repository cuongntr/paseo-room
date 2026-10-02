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
  AlreadyPublishedError, ensurePrivateDirectory, PRIVATE_FILE_MODE, publishOnce, TEMPORARY_PREFIX,
} from './publish.js';

export const RUNTIME_LAYOUT_VERSION = 'v1';
const EVENT_FILE = /^(\d{12})\.json$/;
const MAX_SEQUENCE_ATTEMPTS = 64;
/** Event files read at once during replay; one at a time made every Lead action wait on each file's latency in turn. */
const REPLAY_READS_IN_FLIGHT = 32;

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

/** One event file as read and checked: the event, or why it cannot be one. */
type Checked = { readonly event: RuntimeEventV1 } | { readonly reason: ReplayProblem['reason']; readonly detail: string };

const NOT_READ: Checked = { reason: 'unreadable', detail: 'The event file was not read.' };

async function readChecked(path: string): Promise<Checked> {
  try {
    const read = readEvent(JSON.parse(await readFile(path, 'utf8')));
    return read.ok ? { event: read.event } : { reason: read.reason, detail: read.detail };
  } catch (error) {
    return { reason: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Event files already read and checked, per events directory, for the life of the plugin process. An
 * event file is published once and never rewritten, so a replay reads and checks only the files it
 * has not seen, and concurrent replays share one read of each, the same object for the same file.
 * Reading the whole ledger on every operation let replays pile up on a ledger of thousands of events
 * until the runtime stopped answering (cmdb, 2026-10-01); checking it again each time still cost 30 ms
 * of every load (2026-10-02). A file that could not be read is not kept, so the next replay tries it
 * again, and one that left the directory, such as one quarantined, is forgotten with it.
 */
const CHECKED = new Map<string, Map<string, Promise<Checked>>>();

async function checkedFiles(directory: string, names: readonly string[]): Promise<Map<string, Checked>> {
  const known = CHECKED.get(directory) ?? new Map<string, Promise<Checked>>();
  CHECKED.set(directory, known);
  const present = new Set(names);
  for (const name of known.keys()) if (!present.has(name)) known.delete(name);
  const missing = names.filter(name => !known.has(name)).map(name => {
    let settle!: (result: Checked) => void;
    const result = new Promise<Checked>(resolve => { settle = resolve; });
    known.set(name, result);
    void result.then(found => { if ('reason' in found && found.reason === 'unreadable' && known.get(name) === result) known.delete(name); });
    return { name, settle };
  });
  // Every reader draws from the one iterator, so each file is read exactly once.
  const queue = missing.values();
  const reader = async (): Promise<void> => {
    for (const { name, settle } of queue) settle(await readChecked(join(directory, name)));
  };
  void Promise.all(Array.from({ length: Math.min(REPLAY_READS_IN_FLIGHT, missing.length) }, reader));
  const results = await Promise.all(names.map(name => known.get(name) ?? Promise.resolve(NOT_READ)));
  return new Map(names.map((name, index) => [name, results[index] ?? NOT_READ]));
}

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
    const eventNames = names.filter(name => EVENT_FILE.test(name));
    const files = await checkedFiles(this.eventsDirectory, eventNames);
    const problems: ReplayProblem[] = [];
    const events: RuntimeEventV1[] = [];
    const ids = new Map<string, string>();
    for (const name of names) {
      if (name.startsWith(TEMPORARY_PREFIX)) continue;
      const match = EVENT_FILE.exec(name);
      if (!match) { problems.push({ file: name, reason: 'unexpected-file', detail: 'Not a runtime event file name.' }); continue; }
      const file = files.get(name) ?? NOT_READ;
      if ('reason' in file) { problems.push({ file: name, reason: file.reason, detail: file.detail }); continue; }
      const event = file.event;
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
    // Names are zero-padded and sorted, so the last event file name holds the highest sequence. Spreading
    // every sequence into Math.max would exceed the argument limit on a large ledger.
    const highest = Number(EVENT_FILE.exec(eventNames.at(-1) ?? '')?.[1] ?? 0);
    this.lastSequence = Math.max(this.lastSequence, highest);
    return {
      status: problems.length === 0 ? 'ok' : 'paused',
      events,
      problems,
      gaps,
      staleTemporaries: names.filter(name => name.startsWith(TEMPORARY_PREFIX)),
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
    if (!EVENT_FILE.test(file) && !file.startsWith(TEMPORARY_PREFIX)) throw new Error(`${file} is not a runtime event file.`);
    await ensurePrivateDirectory(this.quarantineDirectory);
    await rename(join(this.eventsDirectory, file), join(this.quarantineDirectory, file));
  }
}
