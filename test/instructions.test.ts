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

  // Paseo takes the seat to open as a free-form provider id, so nothing below the
  // contract stops Lead from opening a second Lead. The rule has to reach the seats
  // that hold the tool, and only those.
  it('tells each seat with room tools which seat it may open', () => {
    expect(renderInstructions('lead')).toContain('Lead opens Peer seats and no others');
    expect(renderInstructions('supervisor')).toContain('Supervisor opens Lead seats');
    expect(renderInstructions('peer')).not.toContain('## RC-207');
  });

  it('discovers and reuses the sole project Lead across lifecycle states', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain('checks whether a healthy Lead already owns the project');
    expect(supervisor).toContain('inspecting its current and recent agents');
    expect(supervisor).toContain('An initializing or running Lead, an idle Lead after a completed turn');
    expect(supervisor).toContain('a closed but unarchived, resumable Lead are the same project owner');
    expect(supervisor).toContain('route the directive, question, evidence, or review request to that Lead');
    expect(supervisor).toContain('resuming it when necessary');
    expect(supervisor).toContain('Only when no Lead owns the project may Supervisor open exactly one Lead as its child');
    expect(supervisor).toContain('Workspace placement does not change parentage');
    expect(supervisor).toContain('never open another Lead for freshness or convenience');
  });

  it('routes fresh independent review through the existing Lead to a fresh Peer', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain("A fresh-session review is Lead's to arrange with a fresh read-only Peer");
    expect(supervisor).toContain('Route that request to the existing Lead');
    expect(supervisor).toContain('not a reason for Supervisor to open a fresh Lead');
    expect(supervisor).toContain('or direct the Peer');

    const lead = renderInstructions('lead');
    expect(lead).toContain("The fresh session is the review Peer's session");
    expect(lead).toContain('never a replacement or duplicate project Lead');
    expect(lead).toContain('Lead remains the owner, receives the review evidence');
  });

  it('treats pending permission as state and bounds duplicate recovery', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain('A pending creation, run, or permission request is unresolved state, not an absent Lead');
    expect(supervisor).toContain('Resolve a permission only within authority already granted by Human');
    expect(supervisor).toContain('otherwise escalate it to Human');
    expect(supervisor).toContain('If duplicate Leads exist, stop new parallel routing');
    expect(supervisor).toContain('Keep the previously established healthy Lead as project owner');
    expect(supervisor).toContain("route the duplicate's stable handoff and evidence to it");
    expect(supervisor).toContain('close the duplicate only after moving work has stopped and a stable handoff exists');
    expect(supervisor).toContain('escalate to Human instead of choosing, merging, accepting, or directing a Peer');
  });

  it('keeps Lead ownership through completed turns until an explicit lifecycle change', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Lead owns one project across turns');
    expect(lead).toContain('A completed turn, idle state, or closed but unarchived, resumable session does not end that ownership');
    expect(lead).toContain('Human closes or reassigns the project');
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
