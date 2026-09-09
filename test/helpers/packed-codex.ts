/** Credential-free protocol fixture shared in behavior with the isolated contract. */
export function packedCodex(launchLog: string, rpcLog: string, barrier: string): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, argv: process.argv, home: process.env.CODEX_HOME }) + '\\n');
if (process.argv[2] === '--version') { console.log('codex-cli 1.0.0'); process.exit(0); }
if (process.argv[2] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', multi_agent_version: null }] })); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(1);
if (fs.existsSync(${JSON.stringify(barrier)}) && process.env.CODEX_HOME?.includes('/roles/')) {
  fs.writeFileSync(${JSON.stringify(barrier + '.reached')}, 'ready');
  while (fs.existsSync(${JSON.stringify(barrier)})) await new Promise(resolve => setTimeout(resolve, 25));
}
process.stdin.on('end', () => process.exit(0));
const record = value => fs.appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ pid: process.pid, home: process.env.CODEX_HOME, ...value }) + '\\n');
const send = value => console.log(JSON.stringify(value));
const threadId = 'fixture-thread-' + process.pid;
let loaded = true;
const model = { id: 'fixture', model: 'fixture', displayName: 'Fixture', description: 'Discovery fixture', hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Fixture' }], defaultReasoningEffort: 'medium', isDefault: true };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  // Store only protocol parameters known not to contain daemon MCP credentials.
  const params = request.method === 'thread/start' ? { cwd: request.params.cwd, model: request.params.model }
    : ['turn/start', 'thread/resume'].includes(request.method) ? { threadId: request.params.threadId }
    : ['initialize', 'initialized', 'config/read', 'skills/list', 'collaborationMode/list'].includes(request.method) ? request.params : {};
  record({ method: request.method, params });
  if (request.id === undefined) return;
  const results = { initialize: { userAgent: 'fixture' }, 'model/list': { data: [model], nextCursor: null },
    'account/read': { account: null, requiresOpenaiAuth: false },
    'getUserSavedConfig': { config: {} }, 'thread/loaded/list': { data: loaded ? [threadId] : [], nextCursor: null },
    'config/read': { config: {} }, 'collaborationMode/list': { data: [] }, 'skills/list': { data: [] },
    'thread/start': { thread: { id: threadId } }, 'thread/resume': { thread: { id: request.params?.threadId } }, 'turn/start': { turn: { id: 'fixture-turn' } }, 'thread/archive': {} };
  const result = results[request.method];
  record({ responseTo: request.method, success: result !== undefined });
  send(result === undefined ? { id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } } : { id: request.id, result });
  if (request.method === 'turn/start') {
    // Simulate native thread eviction between turns to exercise public send -> resume.
    loaded = false;
    const threadId = request.params.threadId;
    send({ method: 'turn/started', params: { threadId, turn: { id: 'fixture-turn' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: 'fixture-turn', status: 'completed' } } }), 50);
  }
});
`;
}
