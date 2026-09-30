/**
 * How attention and the Supervisor are used over a window (docs/design/runtime-coordination-attention.md §12.4).
 *
 *   npm run attention:report -- [--since 2026-09-24] [--until 2026-09-30] [--home ~/.paseo-room] [--json]
 *
 * Reads the room home read-only: the attention log, each project ledger's Supervisor messages, and
 * the Claude Supervisor and Lead transcripts. It prints counts and durations only, never message
 * text, so its output can be shared. The window defaults to the last seven days; a bare date means
 * the start of that day (UTC) for --since and its end for --until.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  formatReport, letterReport, logRecords, seatReport, supervisorMessage, transcriptTurns,
  type LogRecord, type SupervisorMessage, type Transcript, type Window,
} from './attention-report-lib.js';

const DAY = 86_400_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function instant(value: string | undefined, fallback: number, endOfDay: boolean): number {
  if (value === undefined) return fallback;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = Date.parse(bareDate ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(at)) throw new Error(`Not a date: ${value}`);
  return bareDate && endOfDay ? at + DAY - 1 : at;
}

const home = option('--home') ?? join(homedir(), '.paseo-room');
const now = Date.now();
const window: Window = { from: instant(option('--since'), now - 7 * DAY, false), to: instant(option('--until'), now, true) };

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[])).map(name => join(directory, name));
}

async function attentionLog(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  for (const file of await entries(join(home, 'runtime', 'v1', 'attention', 'log'))) {
    // Day files are named by their UTC date; one outside the window cannot hold a record inside it.
    const day = Date.parse(`${file.slice(-16, -6)}T00:00:00.000Z`);
    if (!file.endsWith('.jsonl') || (!Number.isNaN(day) && (day + DAY <= window.from || day > window.to))) continue;
    records.push(...logRecords(await readFile(file, 'utf8'), window));
  }
  return records;
}

async function supervisorMessages(): Promise<SupervisorMessage[]> {
  const messages: SupervisorMessage[] = [];
  for (const project of await entries(join(home, 'runtime', 'v1', 'projects'))) {
    for (const file of await entries(join(project, 'events'))) {
      const text = await readFile(file, 'utf8').catch(() => '');
      // Most events are not notices; skip the parse for them.
      if (!text.includes('"supervisor-message"')) continue;
      const message = supervisorMessage(text);
      if (message !== undefined) messages.push(message);
    }
  }
  return messages;
}

async function transcripts(role: string): Promise<Transcript[]> {
  const found: Transcript[] = [];
  for (const project of await entries(join(home, 'roles', 'claude', role, 'projects'))) {
    for (const file of await entries(project)) {
      if (!file.endsWith('.jsonl') || (await stat(file)).mtimeMs < window.from) continue;
      found.push(transcriptTurns(await readFile(file, 'utf8'), window));
    }
  }
  return found;
}

async function main(): Promise<void> {
  const letters = letterReport(await attentionLog(), await supervisorMessages(), window);
  const seats = { supervisor: seatReport(await transcripts('supervisor')), lead: seatReport(await transcripts('lead')) };
  console.log(process.argv.includes('--json') ? JSON.stringify({ window, letters, seats }, null, 2) : formatReport(window, letters, seats));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
