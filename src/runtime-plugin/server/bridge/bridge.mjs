#!/usr/bin/env node
/**
 * paseo-room runtime bridge: a dependency-free stdio MCP server launched by an agent provider.
 *
 * It advertises its seat's fixed tool list and relays each call to the runtime through the
 * spool; it performs no authoritative validation and never talks to Paseo. Identity travels
 * only in the hidden envelope (correlation and, for a Peer, the current generation's
 * capability), never in tool input. docs/design/runtime-coordination.md §3.4.
 *
 * Plain Node 22 with `node:` imports only: Paseo's plugin compiler never bundles this file.
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const runtimeRoot = process.env.PASEO_ROOM_RUNTIME_ROOT ?? '';
const correlation = process.env.PASEO_ROOM_CORRELATION ?? '';
const role = process.env.PASEO_ROOM_ROLE ?? '';
const workKind = process.env.PASEO_ROOM_WORK_KIND;
const replyWaitMs = Number(process.env.PASEO_ROOM_REPLY_WAIT_MS ?? 60_000);
const spool = join(runtimeRoot, 'spool');

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function tools() {
  const file = role === 'peer' ? `peer-${workKind ?? ''}.json` : `${role}.json`;
  try {
    return JSON.parse(await readFile(join(runtimeRoot, 'tools', file), 'utf8')).tools;
  } catch {
    return [];
  }
}

async function capability() {
  if (role !== 'peer') return undefined;
  try {
    const directory = join(runtimeRoot, 'capabilities');
    const latest = (await readdir(directory)).filter(name => name.startsWith(`${correlation}.`) && name.endsWith('.json')).sort().at(-1);
    if (latest === undefined) return undefined;
    return JSON.parse(await readFile(join(directory, latest), 'utf8')).capability;
  } catch {
    return undefined;
  }
}

/** Temp file, fsync, then link to a name that must not exist: never overwrites. */
async function publish(directory, name, content) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, join(directory, name));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function awaitReply(requestId) {
  const path = join(spool, 'replies', `${requestId}.json`);
  const deadline = Date.now() + replyWaitMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      if (Date.now() >= deadline) return undefined;
      await sleep(delay);
    }
  }
}

async function call(id, params) {
  const name = typeof params?.name === 'string' ? params.name : '';
  const requestId = `req_${randomBytes(12).toString('base64url')}`;
  const hidden = await capability();
  const envelope = {
    protocol: 1, requestId, operation: name, payload: params?.arguments ?? {}, correlation,
    ...(hidden === undefined ? {} : { capability: hidden }),
  };
  await publish(join(spool, 'requests'), `${requestId}.json`, `${JSON.stringify(envelope)}\n`);
  const reply = await awaitReply(requestId);
  if (reply === undefined) {
    const error = { schema: 1, error: { code: role === 'peer' ? 'report_uncertain' : 'runtime_unavailable', message: 'The runtime did not answer in time; the call may still be recorded. Retry the same call.', retryable: true } };
    respond(id, { content: [{ type: 'text', text: JSON.stringify(error) }], isError: true });
    return;
  }
  respond(id, { content: [{ type: 'text', text: JSON.stringify(reply.result) }], isError: reply.ok !== true });
}

async function onMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return; // notifications need no answer
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'paseo-room', version: '1' },
      });
    } else if (method === 'ping') {
      respond(id, {});
    } else if (method === 'tools/list') {
      respond(id, { tools: await tools() });
    } else if (method === 'tools/call') {
      await call(id, params);
    } else {
      fail(id, -32601, `Method not found: ${String(method)}`);
    }
  } catch (error) {
    fail(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

const pending = new Set();
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  if (line.trim() === '') return;
  const work = onMessage(line).finally(() => { pending.delete(work); });
  pending.add(work);
});
reader.on('close', () => { void Promise.allSettled([...pending]).then(() => { process.exit(0); }); });
