import { describe, expect, it } from 'vitest';
import { instructionIds, renderInstructions } from '../src/room/instructions.js';
import { ROLES } from '../src/roles.js';
import { protocolIds } from '../src/room/instructions.js';
import { DEFAULT_PROTOCOL } from '../src/room/workspace.js';

describe('role instructions', () => {
  it('gives every role the shared authority contract', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const id of ['RC-001', 'RC-002', 'RC-003', 'RC-004']) expect(document).toContain(`## ${id}`);
    }
  });

  it('keeps orchestration out of the Peer document', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('## RC-303');
    expect(peer).not.toContain('## RC-103');
    expect(peer).not.toContain('## RC-202');
  });

  it('gives Lead acceptance authority and Supervisor routing only', () => {
    expect(renderInstructions('lead')).toContain('## RC-205');
    expect(renderInstructions('supervisor')).not.toContain('## RC-205');
  });

  // The default protocol ships in force, so no repository has to opt in to have one.
  it('carries the workspace protocol that bears on each role', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const id of protocolIds(role)) expect(document).toContain(`## ${id}`);
      for (const id of instructionIds(role)) expect(document).toContain(`## ${id}`);
    }
  });

  // RC-303 forbids Peer to infer room topology; handing it the topology rules
  // would contradict that in the same document.
  it('keeps topology out of the Peer document', () => {
    expect(renderInstructions('peer')).not.toContain('## WP-01');
    expect(renderInstructions('lead')).toContain('## WP-01');
    expect(renderInstructions('supervisor')).toContain('## WP-01');
  });

  it('writes the whole protocol to the room copy, without the role contract', () => {
    const workspace = renderInstructions('workspace');
    for (const id of Object.keys(DEFAULT_PROTOCOL)) expect(workspace).toContain(`## ${id}`);
    expect(workspace).not.toContain('## RC-');
  });

  // The default is worthless if a repository cannot displace it point by point.
  it('states that a repository rule wins where it speaks', () => {
    for (const document of [...ROLES.map(renderInstructions), renderInstructions('workspace')]) {
      expect(document).toContain('wherever it speaks to a point');
    }
  });

  // A default nobody can override, or an override path nobody is told, is useless.
  it('tells every seat the path that replaces the default', () => {
    const path = 'docs/WORKSPACE_PROTOCOL.md';
    expect(renderInstructions('workspace')).toContain(path);
    for (const role of ROLES) expect(renderInstructions(role)).toContain(path);
  });
});
