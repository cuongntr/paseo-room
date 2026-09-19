import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instructionKeys, renderInstructions } from '../src/room/instructions.js';
import { PROMPT_ASSETS, loadPromptAsset } from '../src/room/prompts.js';
import { ROOM_SKILL_NAME } from '../src/room/skills.js';
import { ROLES } from '../src/roles.js';

const AUTHORITY_HEADINGS = [
  'Human Authority',
  'Authority Floor',
  'Evidence and Event-Driven Waiting',
  'Scope and Unrelated Work',
] as const;
/** Headings the removed always-on default workspace document used to contribute to Lead. */
const RETIRED_WORKSPACE_HEADINGS = [
  'Status and Readers',
  'Topology',
  'Dispositions',
  'Routing',
  'Ownership and Candidates',
  'Review',
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
      'Assignment Vocabulary and Operating Baseline',
      'Moving Write Ownership',
      'Complete Peer Brief',
      'Technical Acceptance',
      'Independent Review',
      'Peer Seat Lifecycle',
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
  });

  it('composes one role body plus only the independently distributed layers', () => {
    expect(instructionKeys('supervisor')).toEqual(['sharedAuthority', 'sharedSeatIdentity', 'supervisor']);
    expect(instructionKeys('lead')).toEqual(['sharedAuthority', 'sharedSeatIdentity', 'challengeSignals', 'lead']);
    expect(instructionKeys('peer')).toEqual(['sharedAuthority', 'challengeSignals', 'peer']);

    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const key of instructionKeys(role)) expect(document).toContain(loadPromptAsset('contract', key));
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
    expect(supervisor).toContain('the room ships no default protocol for any seat to carry');
    expect(supervisor).not.toContain(WORKSPACE_PROTOCOL_PATH);
    expect(supervisor).not.toContain(WORKSPACE_PREFACE_MARKER);
    expect(supervisor).not.toContain(ROOM_SKILL_NAME);
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
    expect(peer).not.toContain(ROOM_SKILL_NAME);
  });

  it('makes Lead the sole standing reader of an optional, complete repository protocol', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('resolve the repository root');
    expect(lead).toContain(`read ${WORKSPACE_PROTOCOL_PATH} at its root in full`);
    expect(lead).toContain('Lead is the only seat that reads it as a matter of course');
    expect(lead).toContain("A repository protocol that exists is that repository's complete workflow policy");
    expect(lead).toContain('The room ships no default protocol');
    expect(lead).toContain('no second, hidden document to reconcile it against point by point');
    expect(lead).toContain('can never enlarge or weaken the authority this contract grants');
    expect(lead).toContain('Do not infer repository policy the repository never stated');
  });

  // The always-on default is gone: no Lead turn may carry the removed generic protocol.
  it('gives Lead no default workspace document, heading, or preface', () => {
    const lead = renderInstructions('lead');
    expect(lead).not.toContain(WORKSPACE_PREFACE_MARKER);
    for (const heading of RETIRED_WORKSPACE_HEADINGS) expect(lead).not.toContain(`## ${heading}`);
    expect(lead).not.toContain('Architecture lock-in is the only shape worth more than one read-only seat');
    expect(lead).not.toContain('A third correction to the same symptom');
    expect(lead).not.toContain('rather than editing this default, which ships with the room');
  });

  it('keeps only the minimum visible operating baseline Lead needs to act', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('## Assignment Vocabulary and Operating Baseline');
    expect(lead).toContain('not a hidden workspace protocol');
    expect(lead).toContain('its silence never erases these stated rules');
    for (const marker of ['Engineer is writable', 'Architect is read-only', 'Reviewer is read-only', 'Scout is read-only']) {
      expect(lead).toContain(marker);
    }
    expect(lead).toContain('Use the exact profile model and thinking defaults of the seat being opened');
    expect(lead).toContain("Name the repository's own verification gate and run it");
    expect(lead).toContain('a candidate whose gate was not run is not a candidate');
    expect(lead).toContain('Use a fresh read-only review when Human or a repository protocol requires one');
    expect(lead).toContain('when Lead identifies material technical risk');
  });

  it('advertises the Lead-only onboarding skill as proposal-first and explicit-write only', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain(`The room ships one Lead-only skill, ${ROOM_SKILL_NAME}`);
    expect(lead).toContain('It is proposal-first');
    expect(lead).toContain('writes the repository file only under an explicit Human instruction to apply that draft');
    expect(lead).toContain('It changes no authority, tool policy, writer limit, or provider identity');
  });

  it('keeps the brief schema durable and its disposition source explicit', () => {
    const leadContract = loadPromptAsset('contract', 'lead');
    expect(leadContract).toContain('Every brief names exactly one disposition');
    expect(leadContract).toContain('quote the constraint into the brief as a brief term');
    expect(leadContract).toContain('it does not pre-solve the work or embed the verdict');
    expect(leadContract).toContain('The assignment vocabulary above defines each disposition');
    expect(leadContract).toContain('cannot change its write mode or return contract');
  });

  it('keeps seat tuning safety durable while a repository protocol alone may route', () => {
    const leadContract = loadPromptAsset('contract', 'lead');
    expect(leadContract).toContain('The model stays the exact current Peer profile default unless a repository');
    expect(leadContract).toContain("Select thinking effort under that repository protocol's routing policy");
    expect(leadContract).toContain('never invent an identifier');
    expect(leadContract).toContain('Never select a thinking tier that advertises automatic task delegation');
    expect(leadContract).toContain('A decision with material cost belongs to Human');
  });

  it('renders repeatedly with byte-identical output and no retired heading patterns', () => {
    for (const kind of ROLES) {
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
    const piAssets = Object.values(PROMPT_ASSETS.pi);
    const registered = [
      ...documentAssets,
      ...contractAssets,
      ...piAssets,
    ].map(asset => asset.path).sort();

    expect(registered).toEqual(files);
    // The workspace group is gone: no prompt asset may reintroduce a default protocol.
    expect(Object.keys(PROMPT_ASSETS)).toEqual(['documents', 'contract', 'pi']);
    expect(files.some(path => path.startsWith('workspace/'))).toBe(false);
    expect(documentAssets.map(asset => asset.kind)).toEqual(Array(3).fill('head'));
    expect(contractAssets.map(asset => asset.kind)).toEqual([
      'body', 'section', 'section', 'body', 'body', 'body',
    ]);
    expect(piAssets.map(asset => asset.kind)).toEqual(Array(2).fill('capsule'));
  });

  it('normalizes bodies and sections while preserving head and capsule hard lines', () => {
    expect(loadPromptAsset('contract', 'sharedAuthority')).toMatch(
      /^## Human Authority\n- Human owns product goals/,
    );
    expect(loadPromptAsset('contract', 'lead')).toContain(
      '\n\n## Workspace Protocol\n- Repository-local workflow policy',
    );
    expect(loadPromptAsset('pi', 'communicationStyle')).toContain(
      'Prefer plain language\nand minimal formatting.',
    );
  });
});

describe('room-owned onboarding skill contract', () => {
  const root = new URL(`../src/room/skills/${ROOM_SKILL_NAME}/`, import.meta.url);
  const read = (path: string): Promise<string> => readFile(new URL(path, root), 'utf8');

  it('ships valid Agent Skill frontmatter naming its own directory and triggers', async () => {
    const source = await read('SKILL.md');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
    expect(frontmatter).toBeDefined();
    expect(frontmatter).toContain(`name: ${ROOM_SKILL_NAME}`);
    const description = /^description: (.+)$/m.exec(frontmatter ?? '')?.[1] ?? '';
    expect(description.length).toBeGreaterThan(80);
    for (const trigger of ['onboard', 'WORKSPACE_PROTOCOL.md', 'audit', 'update', 'repeated observed workflow failure']) {
      expect(description).toContain(trigger);
    }
    expect(description).toContain('Proposal-first');
  });

  it('is proposal-first and writes only under an explicit apply instruction', async () => {
    const source = await read('SKILL.md');
    expect(source).toContain('The skill writes nothing by default');
    expect(source).toContain('never writes any path other than the repository\'s\n  root `WORKSPACE_PROTOCOL.md`');
    expect(source).toContain('Write the root `WORKSPACE_PROTOCOL.md` only when Human explicitly instructs you to apply the');
    expect(source).toContain('An audit or review request is not an apply instruction');
    expect(source).toContain('refuse any other shape');
    expect(source).toContain('leave every unrelated change in the working tree untouched');
  });

  it('separates evidence from proposal and refuses to invent policy', async () => {
    const source = await read('SKILL.md');
    expect(source).toContain('Resolve the repository root');
    for (const evidence of ['AGENTS.md', 'CONTRIBUTING', 'package.json', 'CI and automation configuration', 'test and lint configuration', 'architecture, design, decision-record, and operations documentation']) {
      expect(source).toContain(evidence);
    }
    expect(source).toContain('**Evidence**');
    expect(source).toContain('**Proposal**');
    expect(source).toContain('**Unknown or conflicting**');
    expect(source).toContain('The skill cannot invent policy');
    expect(source).toContain('Drop a section rather than fill it with filler');
    expect(source).toContain('the draft has to be complete on its own');
  });

  it('cannot alter authority, tool policy, the writer cap, credentials, or Peer readership', async () => {
    const source = await read('SKILL.md');
    expect(source).toContain('cannot change Human, Supervisor, Lead, or Peer authority');
    expect(source).toContain('the Paseo tool policy');
    expect(source).toContain('the one-writable-Peer limit');
    expect(source).toContain('provider or profile identity, or credentials');
    expect(source).toContain('cannot give Peer the protocol');
    expect(source).toContain('adds no dependency, tooling, or other top-level file');
  });

  it('keeps the bundled template a scaffold loaded only during the skill', async () => {
    const skill = await read('SKILL.md');
    const template = await read('references/workspace-protocol-template.md');
    expect(skill).toContain('references/workspace-protocol-template.md');
    expect(skill).toContain('it is a reference loaded during this skill, never a default\nappended to a session');
    expect(template).toContain('A shape to start from, not content to ship');
    expect(template).toContain('Every section here is optional');
    // A scaffold must not restate role authority, or it becomes a second contract.
    for (const heading of ['## Human Authority', '## Authority Floor']) expect(template).not.toContain(heading);
  });
});
