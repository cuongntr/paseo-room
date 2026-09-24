/**
 * Offline attention evaluation (docs/design/runtime-coordination-attention.md §12.3 step 1).
 *
 *   npm run attention:eval -- [--send] [--limit N] [--out report.jsonl] [--home ~/.paseo-room]
 *                             [--endpoint URL] [--model jev-1.13.0] [--no-mask-network]
 *
 * Reads Claude Lead transcripts under the room home read-only and prints what an evaluation would
 * send. Nothing leaves this machine unless `--send` is given: that flag is the operator's consent
 * for this run. The key comes from the runtime key file or PASEO_ROOM_ATTENTION_KEY. The report
 * holds only the masked state, the answers and the follow-up label — never the raw message.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ATTENTION_SETTINGS, DEFAULT_SENSOR_ENDPOINT, DEFAULT_SENSOR_MODEL, type AttentionSettings } from '../src/runtime-plugin/shared/attention.js';
import { AttentionKey } from '../src/runtime-plugin/server/attention/key.js';
import { SystemOneSensor } from '../src/runtime-plugin/server/attention/sensor.js';
import { assistLeadTurn } from '../src/runtime-plugin/server/attention/triage.js';
import { leadTurns, requestFor, summarize, type Candidate } from './attention-eval-lib.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const home = option('--home') ?? join(homedir(), '.paseo-room');
const send = process.argv.includes('--send');
const limit = Number.parseInt(option('--limit') ?? '0', 10);
const out = option('--out');
const endpoint = option('--endpoint') ?? DEFAULT_SENSOR_ENDPOINT;
const model = option('--model') ?? DEFAULT_SENSOR_MODEL;
const maskNetwork = !process.argv.includes('--no-mask-network');

async function transcripts(): Promise<string[]> {
  const projects = join(home, 'roles', 'claude', 'lead', 'projects');
  const files: string[] = [];
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    for (const name of await readdir(join(projects, project)).catch(() => [] as string[])) {
      if (name.endsWith('.jsonl')) files.push(join(projects, project, name));
    }
  }
  return files;
}

async function main(): Promise<void> {
  let candidates: Candidate[] = [];
  for (const file of await transcripts()) candidates.push(...leadTurns(file, await readFile(file, 'utf8')));
  if (limit > 0) candidates = candidates.slice(-limit);
  console.log(JSON.stringify(summarize(candidates), null, 2));
  if (!send) {
    console.log('Dry run: nothing was sent. Add --send to assess these with the endpoint above.');
    return;
  }

  const host = new URL(endpoint).hostname;
  const settings: AttentionSettings = {
    ...DEFAULT_ATTENTION_SETTINGS,
    // --send is this run's consent for the endpoint host.
    sensor: { ...DEFAULT_ATTENTION_SETTINGS.sensor, mode: 'shadow', endpoint, model, maskNetworkIdentifiers: maskNetwork, egressAcknowledgedHost: host },
  };
  const sensor = new SystemOneSensor({
    settings: () => settings, key: AttentionKey.at(join(home, 'runtime', 'v1')), now: () => new Date(),
    log: { append: () => Promise.resolve() },
  });
  const refusal = await sensor.refusal();
  if (refusal !== undefined) throw new Error(refusal);

  const lines: string[] = [];
  const table: Record<string, Record<string, number>> = {};
  for (const [index, candidate] of candidates.entries()) {
    const request = requestFor(candidate, maskNetwork);
    const facts = { peersRunning: 0, permissionPending: false };
    const result = await sensor.leadTurn({ id: `eval-${String(index)}`, message: candidate.text, facts, seatName: 'Lead of a project' });
    const outcome = result?.assessment.choice?.value ?? 'no-answer';
    const decision = result === undefined ? 'baseline' : assistLeadTurn(result.assessment, facts).decision;
    const row = `${candidate.followUp}/${candidate.language}`;
    table[row] ??= {};
    table[row][`${outcome}→${decision}`] = (table[row][`${outcome}→${decision}`] ?? 0) + 1;
    lines.push(JSON.stringify({
      followUp: candidate.followUp, language: candidate.language, endsWithQuestion: candidate.endsWithQuestion,
      state: request.state, outcome, confidence: result?.assessment.choice?.confidence, nouls: result?.assessment.nouls, decision,
    }));
  }
  console.log(JSON.stringify({ outcomesByFollowUp: table, sensor: sensor.status() }, null, 2));
  if (out !== undefined) {
    await writeFile(out, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`Wrote ${String(lines.length)} rows to ${out}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
