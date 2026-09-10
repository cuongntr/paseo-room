import { describe, expect, it } from 'vitest';
import { instructionIds, renderInstructions } from '../src/room/instructions.js';
import { ROLES } from '../src/roles.js';

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

  it('renders every clause into the workspace template', () => {
    const workspace = renderInstructions('workspace');
    for (const id of instructionIds('workspace')) expect(workspace).toContain(`## ${id}`);
  });

  // The template is useless if it does not name the path the seats are told to read.
  it('names the same protocol path the shared contract names', () => {
    const path = 'docs/WORKSPACE_PROTOCOL.md';
    expect(renderInstructions('workspace')).toContain(path);
    for (const role of ROLES) expect(renderInstructions(role)).toContain(path);
  });
});
