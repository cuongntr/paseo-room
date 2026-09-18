import { describe, expect, it } from 'vitest';
import { detectPaseoServers, jsonServerTable, paseoMcpCheck, serverNameDivergence, serverTable } from '../src/agents/mcp.js';

describe('detectPaseoServers', () => {
  it('recognizes the token in a server name, command, argument, and URL', () => {
    const matches = detectPaseoServers({
      paseo: { command: 'safe' },
      'notes-mcp': { command: '/opt/paseo/bin/serve' },
      runner: { command: 'npx', args: ['-y', 'paseo-mcp'] },
      remote: { url: 'http://127.0.0.1:6767/paseo/mcp' },
    });
    expect(matches).toEqual([
      { server: 'paseo', field: 'name', value: 'paseo' },
      { server: 'notes-mcp', field: 'command', value: '/opt/paseo/bin/serve' },
      { server: 'runner', field: 'args', value: 'paseo-mcp' },
      { server: 'remote', field: 'url', value: 'http://127.0.0.1:6767/paseo/mcp' },
    ]);
  });

  it('matches only at identifier, path, and camel-case boundaries', () => {
    expect(detectPaseoServers({
      grapaseo: { command: 'x' },
      paseonaut: { command: 'x' },
      upperWord: { command: 'PASEONAUT' },
      other: { command: 'paseo2-tool' },
      snake: { command: 'run_paseo_tool' },
      camel: { command: 'paseoRoom' },
      upper: { command: 'PASEO' },
    })).toEqual([
      { server: 'snake', field: 'command', value: 'run_paseo_tool' },
      { server: 'camel', field: 'command', value: 'paseoRoom' },
      { server: 'upper', field: 'command', value: 'PASEO' },
    ]);
  });

  it('ignores benign declarations and non-object shapes', () => {
    expect(detectPaseoServers({
      docs: { command: 'uvx', args: ['mcp-server-docs'], env: { TOKEN: 'paseo' } },
      broken: 'not-a-declaration',
    })).toEqual([]);
    expect(serverTable(undefined)).toEqual({});
    expect(serverTable([{ command: 'x' }])).toEqual({});
    expect(detectPaseoServers(serverTable({ paseo: { command: 'x' } }))).toHaveLength(1);
  });
});

describe('jsonServerTable', () => {
  it('reads only the named declaration keys and rejects malformed sources', () => {
    const source = JSON.stringify({
      mcpServers: { docs: { command: 'uvx' } },
      oauthAccount: { email: 'operator@example.test' },
      projects: { a: 1 },
    });
    expect(jsonServerTable(source, ['mcpServers'])).toEqual({ docs: { command: 'uvx' } });
    expect(jsonServerTable(source, ['servers'])).toEqual({});
    expect(jsonServerTable(JSON.stringify({ servers: { a: {} } }), ['mcpServers', 'servers'])).toEqual({ a: {} });
    expect(jsonServerTable(undefined, ['mcpServers'])).toEqual({});
    expect(() => jsonServerTable('{not json', ['mcpServers'])).toThrow();
    expect(() => jsonServerTable('[]', ['mcpServers'])).toThrow('must be a JSON object');
    expect(() => jsonServerTable('{"mcpServers":[]}', ['mcpServers'])).toThrow('mcpServers must be a JSON object');
  });

  // Pi loads both keys, so a benign first table must not hide what the second one declares.
  it('merges every named key rather than stopping at the first table', () => {
    const source = JSON.stringify({
      mcpServers: { docs: { command: 'uvx' } },
      servers: { room: { command: '/opt/paseo/bin/serve' } },
    });
    expect(jsonServerTable(source, ['mcpServers', 'servers'])).toEqual({
      docs: { command: 'uvx' },
      room: { command: '/opt/paseo/bin/serve' },
    });
    expect(detectPaseoServers(jsonServerTable(source, ['mcpServers', 'servers']))).toHaveLength(1);
    // Precedence is the declared key order, and a duplicated name keeps both declarations.
    expect(jsonServerTable(JSON.stringify({
      mcpServers: { bridge: { command: 'safe' } },
      servers: { bridge: { command: 'paseo' } },
    }), ['mcpServers', 'servers'])).toEqual({
      bridge: { command: 'safe' },
      'bridge (servers)': { command: 'paseo' },
    });
  });
});

describe('paseoMcpCheck', () => {
  it('passes benign servers and fails a recognizable one with its own evidence', () => {
    expect(paseoMcpCheck('codex.mcp', '/home/u/.codex/config.toml', { docs: { command: 'uvx' } })).toBeUndefined();
    const check = paseoMcpCheck('codex.mcp', '/home/u/.codex/config.toml', {
      docs: { command: 'uvx' },
      bridge: { args: ['--server', 'paseo'] },
    });
    expect(check).toMatchObject({ id: 'codex.mcp', status: 'fail' });
    expect(check?.message).toContain('/home/u/.codex/config.toml');
    expect(check?.message).toContain('bridge (args: paseo)');
    expect(check?.message).not.toContain('docs');
    expect(check?.fix).toContain('Remove or rename');
    expect(check?.fix).toContain('never edits your MCP configuration');
    // The diagnostic must not present a name heuristic as containment.
    expect(check?.fix).toContain('rather than a sandbox');
  });
});

describe('serverNameDivergence', () => {
  it('reports names each side declares alone, sorted, and nothing when they match', () => {
    expect(serverNameDivergence({ docs: { command: 'uvx' } }, { docs: { command: 'different' } })).toBeUndefined();
    expect(serverNameDivergence({}, {})).toBeUndefined();
    expect(serverNameDivergence(
      { docs: {}, sql: {}, notes: {} },
      { docs: {}, legacy: {} },
    )).toEqual({ missing: ['notes', 'sql'], extra: ['legacy'] });
  });

  // Only names are compared: what a server runs is never part of the comparison.
  it('ignores declaration values entirely', () => {
    expect(serverNameDivergence(
      { docs: { command: 'uvx', args: ['a'] } },
      { docs: { url: 'http://example.test' } },
    )).toBeUndefined();
  });
});
