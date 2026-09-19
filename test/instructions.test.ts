import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instructionKeys, protocolKeys, renderInstructions } from '../src/room/instructions.js';
import { PROMPT_ASSETS, loadPromptAsset } from '../src/room/prompts.js';
import { ROLES } from '../src/roles.js';

const AUTHORITY_HEADINGS = [
  'Human Authority',
  'Authority Floor',
  'Evidence and Event-Driven Waiting',
  'Scope and Unrelated Work',
] as const;
const WORKSPACE_HEADINGS = [
  'Status and Readers',
  'Topology',
  'Dispositions',
  'Routing',
  'Ownership and Candidates',
  'Review',
  'Verification',
  'Escalation',
  'Repository Conventions',
  'Anti-Patterns',
  'Protocol Evolution',
] as const;
const WORKSPACE_PROTOCOL_PATH = 'WORKSPACE_PROTOCOL.md';
const WORKSPACE_PREFACE_MARKER = '# Workspace protocol';

function headings(document: string): string[] {
  return [...document.matchAll(/^## (.+)$/gm)].map(match => match[1] ?? '');
}

describe('role instructions', () => {
  it('renders the exact layer and heading sequence for every document', () => {
    expect(headings(renderInstructions('supervisor'))).toEqual([
      ...AUTHORITY_HEADINGS,
      'Room Seat Identity',
      'Directive Integrity',
      'Technical Non-Interference',
      'Lead Discovery and Recovery',
      'Observation and Advice',
      'Workspace Protocol Mandate',
      'Escalation Boundaries',
    ]);
    expect(headings(renderInstructions('lead'))).toEqual([
      ...AUTHORITY_HEADINGS,
      'Room Seat Identity',
      'Challenge Signals',
      'Project Technical Ownership',
      'Workspace Protocol',
      'Moving Write Ownership',
      'Complete Peer Brief',
      'Technical Acceptance',
      'Independent Review',
      'Peer Seat Lifecycle',
      ...WORKSPACE_HEADINGS,
    ]);
    expect(headings(renderInstructions('peer'))).toEqual([
      ...AUTHORITY_HEADINGS,
      'Challenge Signals',
      'Bounded Outcome',
      'Independent Judgment',
      'Assignment Scope',
      'No Orchestration',
      'Reproducible Handoff',
      'No Self-Acceptance',
    ]);
    expect(headings(renderInstructions('workspace'))).toEqual([...WORKSPACE_HEADINGS]);
  });

  it('composes one role body plus only the independently distributed layers', () => {
    expect(instructionKeys('supervisor')).toEqual(['sharedAuthority', 'sharedSeatIdentity', 'supervisor']);
    expect(instructionKeys('lead')).toEqual(['sharedAuthority', 'sharedSeatIdentity', 'challengeSignals', 'lead']);
    expect(instructionKeys('peer')).toEqual(['sharedAuthority', 'challengeSignals', 'peer']);
    expect(protocolKeys('supervisor')).toEqual([]);
    expect(protocolKeys('lead')).toEqual(['default']);
    expect(protocolKeys('peer')).toEqual([]);

    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const key of instructionKeys(role)) expect(document).toContain(loadPromptAsset('contract', key));
      for (const key of protocolKeys(role)) expect(document).toContain(loadPromptAsset('workspace', key));
      for (const heading of AUTHORITY_HEADINGS) expect(document).toContain(`## ${heading}`);
    }
  });

  it('keeps the authority floor above repository workflow for every role', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      expect(document).toContain('They cannot enlarge or weaken the authority this contract grants');
      expect(document).toContain(
        'give Peer orchestration, give Supervisor or Peer technical acceptance, permit more than one writable Peer',
      );
      expect(document).toContain('report the conflict to Lead rather than choosing between them');
    }
    expect(renderInstructions('peer')).not.toContain(WORKSPACE_PROTOCOL_PATH);
  });

  it('shares common room-seat evidence without conflating role-specific parentage', () => {
    const shared = loadPromptAsset('contract', 'sharedSeatIdentity');
    expect(shared).toContain('select the exact current room profile');
    expect(shared).toContain('copy provider, modeId and featureValues exactly');
    expect(shared).toContain('A cwd, title or provider label is never room membership');
    expect(shared).toContain('Paseo currently stores no profileId on an agent session');
    expect(shared).not.toContain('paseo.parent-agent-id');

    expect(renderInstructions('supervisor')).toContain(shared);
    expect(renderInstructions('lead')).toContain(shared);
    expect(renderInstructions('peer')).not.toContain(shared);

    const supervisor = loadPromptAsset('contract', 'supervisor');
    expect(supervisor).toContain('Use parentage or known Human-opened ownership history');
    expect(supervisor).toContain('Supervisor opens Lead seats only');
    expect(supervisor).toContain('paseo.parent-agent-id to name this Supervisor');

    const lead = loadPromptAsset('contract', 'lead');
    expect(lead).toContain('Lead opens Peer seats and no others');
    expect(lead).toContain('paseo.parent-agent-id to name this Lead');
  });

  it('keeps Supervisor observational and protocol access mandate-bound', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain('Supervisor must not edit project work, run project validation, or decide technical acceptance');
    expect(supervisor).toContain('Advice carries no technical authority');
    expect(supervisor).toContain("Repository-local workflow policy is Lead's standing layer, not Supervisor's");
    expect(supervisor).toContain('only when Human explicitly assigns protocol audit, update, or maintenance');
    expect(supervisor).toContain('Supervisor proposes; it does not impose');
    expect(supervisor).not.toContain(WORKSPACE_PROTOCOL_PATH);
    expect(supervisor).not.toContain(WORKSPACE_PREFACE_MARKER);
    expect(headings(supervisor).filter(heading => WORKSPACE_HEADINGS.includes(
      heading as typeof WORKSPACE_HEADINGS[number],
    ))).toEqual([]);
  });

  it('keeps Lead project ownership, hard writer limits, and technical acceptance durable', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Lead owns one project across turns');
    expect(lead).toContain('at most one active writable Peer across the project at a time');
    expect(lead).toContain('No workspace protocol relaxes the limit');
    expect(lead).toContain('Among agents, Lead alone accepts; Human retains override authority');
    expect(lead).toContain('Lead opens Peer seats and no others');
  });

  it('keeps Peer bounded, independent, non-orchestrating, and reproducible', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('rather than adopting Lead\'s framing because Lead sent it');
    expect(peer).toContain('Agreement is a valid outcome when the evidence supports it');
    expect(peer).toContain('Peer receives no Paseo room tools');
    expect(peer).toContain('A read-only assignment changes no project file and no candidate');
    expect(peer).toContain('A candidate whose named verification was not run is not a candidate');
    expect(peer).toContain('add no top-level file, directory, dependency or tooling the brief did not ask for');
    expect(peer).toContain('Lead alone performs technical acceptance among agents');
    expect(peer).not.toContain('## Room Seat Identity');
    expect(peer).not.toContain(WORKSPACE_PREFACE_MARKER);
  });

  it('makes Lead the sole standing protocol reader with point-by-point precedence', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('resolve the repository root');
    expect(lead).toContain(`read ${WORKSPACE_PROTOCOL_PATH} at its root in full`);
    expect(lead).toContain('Lead is the only seat that reads it as a matter of course');
    expect(lead).toContain('A repository rule wins over the default wherever it speaks to a point');
    expect(lead).toContain('the default still holds on every point the repository leaves silent');
    expect(lead).toContain(WORKSPACE_PREFACE_MARKER);
    for (const heading of WORKSPACE_HEADINGS) expect(lead).toContain(`## ${heading}`);
  });

  it('keeps the brief schema durable while disposition meanings and routing stay in workspace policy', () => {
    const leadContract = loadPromptAsset('contract', 'lead');
    const workspace = loadPromptAsset('workspace', 'default');

    expect(leadContract).toContain('Every brief names exactly one disposition');
    expect(leadContract).toContain('quote the constraint into the brief as a brief term');
    expect(leadContract).toContain('it does not pre-solve the work or embed the verdict');
    expect(leadContract).not.toContain('Engineer is writable');
    expect(leadContract).not.toContain('When material uncertainty warrants independent review');
    expect(leadContract).not.toContain('raise it for architecture-sensitive');

    for (const marker of ['Engineer is writable', 'Architect is read-only', 'Reviewer is read-only', 'Scout is read-only']) {
      expect(workspace).toContain(marker);
    }
    expect(workspace).toContain('raise it for architecture-sensitive, high-consequence or weakly observable work');
    expect(workspace).toContain('Review is worth its cost where the change is hard to reverse');
    expect(leadContract).toContain('When the workspace protocol or Human requires independent review');
  });

  it('keeps seat tuning safety durable while workspace policy selects proportionate effort', () => {
    const leadContract = loadPromptAsset('contract', 'lead');
    expect(leadContract).toContain('The model stays the exact current Peer profile default unless the workspace');
    expect(leadContract).toContain("Select thinking effort under that protocol's routing policy");
    expect(leadContract).toContain('never invent an identifier');
    expect(leadContract).toContain('Never select a thinking tier that advertises automatic task delegation');
    expect(leadContract).toContain('A decision with material cost belongs to Human');
  });

  it('writes the complete default protocol as the room copy without role authority', () => {
    const workspace = renderInstructions('workspace');
    expect(workspace).toBe(loadPromptAsset('workspace', 'default') + '\n');
    expect(workspace).toContain('`WORKSPACE_PROTOCOL.md` at its root');
    expect(workspace).not.toContain('## Human Authority');
    expect(workspace).not.toContain('## Authority Floor');
  });

  it('renders repeatedly with byte-identical output and no retired heading patterns', () => {
    for (const kind of [...ROLES, 'workspace'] as const) {
      const first = renderInstructions(kind);
      expect(renderInstructions(kind)).toBe(first);
      expect(first).not.toMatch(/^## (?:RC-|WP-)/m);
    }
  });
});

describe('prompt assets', () => {
  it('has a manifest/filesystem bijection with one asset per distribution unit', async () => {
    const root = new URL('../src/room/prompts/', import.meta.url);
    const files = (await readdir(root, { recursive: true }))
      .filter(path => path.endsWith('.md'))
      .sort();
    const documentAssets = Object.values(PROMPT_ASSETS.documents);
    const contractAssets = Object.values(PROMPT_ASSETS.contract);
    const workspaceAssets = Object.values(PROMPT_ASSETS.workspace);
    const piAssets = Object.values(PROMPT_ASSETS.pi);
    const registered = [
      ...documentAssets,
      ...contractAssets,
      ...workspaceAssets,
      ...piAssets,
    ].map(asset => asset.path).sort();

    expect(registered).toEqual(files);
    expect(documentAssets.map(asset => asset.kind)).toEqual(Array(3).fill('head'));
    expect(contractAssets.map(asset => asset.kind)).toEqual([
      'body', 'section', 'section', 'body', 'body', 'body',
    ]);
    expect(workspaceAssets.map(asset => asset.kind)).toEqual(['document']);
    expect(piAssets.map(asset => asset.kind)).toEqual(Array(2).fill('capsule'));
  });

  it('normalizes bodies and sections while preserving document and capsule hard lines', () => {
    expect(loadPromptAsset('contract', 'sharedAuthority')).toMatch(
      /^## Human Authority\n- Human owns product goals/,
    );
    expect(loadPromptAsset('contract', 'lead')).toContain(
      '\n\n## Workspace Protocol\n- Repository-local workflow policy',
    );
    expect(loadPromptAsset('workspace', 'default')).toContain(
      'different rules\nprovides `WORKSPACE_PROTOCOL.md` at its root',
    );
    expect(loadPromptAsset('pi', 'communicationStyle')).toContain(
      'Prefer plain language\nand minimal formatting.',
    );
  });
});
