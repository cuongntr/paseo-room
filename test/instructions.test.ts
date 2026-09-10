import { describe, expect, it } from 'vitest';
import { instructionIds, renderInstructions } from '../src/room/instructions.js';
import { ROLES } from '../src/roles.js';
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
  it('carries the default workspace protocol in every role document', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const id of Object.keys(DEFAULT_PROTOCOL)) expect(document).toContain(`## ${id}`);
      for (const id of instructionIds(role)) expect(document).toContain(`## ${id}`);
    }
  });

  it('writes the protocol alone to the room copy, without the role contract', () => {
    const workspace = renderInstructions('workspace');
    for (const id of Object.keys(DEFAULT_PROTOCOL)) expect(workspace).toContain(`## ${id}`);
    expect(workspace).not.toContain('## RC-');
  });

  // A default nobody can override, or an override path nobody is told, is useless.
  it('tells every seat the path that replaces the default', () => {
    const path = 'docs/WORKSPACE_PROTOCOL.md';
    expect(renderInstructions('workspace')).toContain(path);
    for (const role of ROLES) expect(renderInstructions(role)).toContain(path);
  });
});
