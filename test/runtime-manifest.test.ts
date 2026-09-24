import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLayout } from '../src/layout.js';
import { contractDigest } from '../src/room/instructions.js';
import { ROLES } from '../src/roles.js';
import {
  renderRuntimeManifest, renderRuntimeManifestFile, reportingPolicyGeneration, RUNTIME_PASEO_RANGE, RUNTIME_PLUGIN_ID,
  runtimePluginDir, runtimePluginEntries,
} from '../src/runtime.js';
import { runtimeRoomManifestSchema } from '../src/runtime-plugin/shared/manifest.js';
import { runtimePluginInventory } from './package-inventory.js';

const layout = resolveLayout({ roomHome: '/home/op/.paseo-room' }, { HOME: '/home/op' });
const source = join(import.meta.dirname, '..', 'src', 'runtime-plugin');

describe('runtime room manifest', () => {
  it('maps exact provider ids for each selected agent and grants reporting only to Peer', () => {
    for (const agents of [['codex'], ['claude'], ['pi'], ['codex', 'claude', 'pi']] as const) {
      const manifest = renderRuntimeManifest(agents, ROLES);
      expect(Object.keys(manifest.providers).sort()).toEqual(agents.flatMap(agent => ROLES.map(role => `${agent}-${role}`)).sort());
      for (const [id, entry] of Object.entries(manifest.providers)) {
        expect(id).toBe(`${entry.agent}-${entry.role}`);
        expect(entry.peerReporting !== undefined).toBe(entry.role === 'peer');
      }
    }
    const peer = renderRuntimeManifest(['pi'], ROLES).providers['pi-peer'];
    expect(peer).toEqual({
      agent: 'pi', role: 'peer', capabilities: ['ask', 'handoff'],
      peerReporting: { protocol: 1, tools: ['ask', 'handoff'], qualifiedVia: 'exact-room-provider' },
    });
    expect(renderRuntimeManifest(['codex'], ROLES).providers['codex-supervisor']?.capabilities).toEqual(['room_status', 'runtime_findings', 'message_lead', 'attention_feedback']);
  });

  it('is deterministic, schema-valid and carries its generations', () => {
    const first = renderRuntimeManifestFile(['codex', 'claude'], ROLES);
    expect(renderRuntimeManifestFile(['codex', 'claude'], ROLES)).toBe(first);
    const parsed = runtimeRoomManifestSchema.parse(JSON.parse(first));
    expect(parsed.contractGeneration).toBe(contractDigest());
    expect(parsed.reportingPolicyGeneration).toBe(reportingPolicyGeneration());
    expect(renderRuntimeManifest(['codex'], ROLES).roomGeneration).not.toBe(parsed.roomGeneration);
    // No path, credential, command, agent or assignment id ever enters the manifest.
    expect(first).not.toMatch(/\/home|token|password|asg_|"command"/);
  });
});

describe('runtime plugin managed entries', () => {
  it('plans the whole bundled tree plus the generated manifest under the room home', async () => {
    const entries = runtimePluginEntries(layout, ['codex'], ROLES);
    const root = runtimePluginDir(layout);
    expect(root).toBe('/home/op/.paseo-room/runtime-plugin');
    const files = entries.filter(entry => entry.kind === 'file').map(entry => entry.path);
    const expected = [...(await runtimePluginInventory(source)).map(path => join(root, path)), join(root, 'generated', 'room-manifest.json')].sort();
    expect([...files].sort()).toEqual(expected);
    for (const entry of entries) {
      expect(entry.path.startsWith(root)).toBe(true);
      expect(entry.kind === 'dir' || entry.kind === 'file').toBe(true);
    }
    const index = entries.find(entry => entry.path === join(root, 'index.server.ts'));
    expect(index?.kind === 'file' ? index.content : '').toBe(await readFile(join(source, 'index.server.ts'), 'utf8'));
    // The per-room locator replaces the inactive placeholder shipped in the bundle.
    const location = entries.find(entry => entry.path === join(root, 'server', 'generated', 'location.ts'));
    expect(location?.kind === 'file' ? location.content : '').toContain('"pluginDirectory":"/home/op/.paseo-room/runtime-plugin","runtimeRoot":"/home/op/.paseo-room/runtime/v1"');
    expect(await readFile(join(source, 'server', 'generated', 'location.ts'), 'utf8')).toContain('ROOM_LOCATION: RoomLocation | undefined = undefined');
    // Plugin-owned runtime state is never a managed entry.
    expect(entries.some(entry => entry.path.startsWith('/home/op/.paseo-room/runtime/'))).toBe(false);
  });

  it('keeps the runtime plugin distinct from the Claude carrier', () => {
    expect(RUNTIME_PLUGIN_ID).toBe('paseo-room-runtime');
    expect(RUNTIME_PASEO_RANGE).toBe('>=0.8.0 <0.10.0');
    expect(runtimePluginDir(layout)).not.toBe(join(layout.roomHome, 'plugin'));
  });
});
