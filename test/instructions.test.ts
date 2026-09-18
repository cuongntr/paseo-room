import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instructionKeys, protocolKeys, renderInstructions } from '../src/room/instructions.js';
import { PROMPT_ASSETS, loadPromptAsset } from '../src/room/prompts.js';
import { ROLES } from '../src/roles.js';

const SHARED_HEADINGS = [
  'Human Authority',
  'Workspace Protocol Precedence',
  'Evidence and Event-Driven Waiting',
  'Scope and Unrelated Work',
] as const;
const PROTOCOL_HEADINGS = ['Topology', 'Verification', 'Review', 'Repository Conventions'] as const;

function headings(document: string): string[] {
  return [...document.matchAll(/^## (.+)$/gm)].map(match => match[1] ?? '');
}

describe('role instructions', () => {
  it('gives every role the shared authority contract', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const heading of SHARED_HEADINGS) expect(document).toContain(`## ${heading}`);
    }
  });

  it('renders the exact semantic heading sequence for every document', () => {
    expect(headings(renderInstructions('supervisor'))).toEqual([
      ...SHARED_HEADINGS,
      'Directive Integrity',
      'Technical Non-Interference',
      'Lead Discovery and Recovery',
      'Observation and Advice',
      'Escalation Boundaries',
      ...PROTOCOL_HEADINGS,
    ]);
    expect(headings(renderInstructions('lead'))).toEqual([
      ...SHARED_HEADINGS,
      'Project Technical Ownership',
      'Moving Write Ownership',
      'Complete Peer Brief',
      'Challenge Signals',
      'Technical Acceptance',
      'Independent Review',
      'Peer Seat Lifecycle',
      ...PROTOCOL_HEADINGS,
    ]);
    expect(headings(renderInstructions('peer'))).toEqual([
      ...SHARED_HEADINGS,
      'Challenge Signals',
      'Bounded Outcome',
      'Independent Judgment',
      'Writing and Review Scope',
      'No Orchestration',
      'Reproducible Handoff',
      'No Self-Acceptance',
      ...PROTOCOL_HEADINGS.slice(1),
    ]);
    expect(headings(renderInstructions('workspace'))).toEqual(PROTOCOL_HEADINGS);
  });

  it('keeps orchestration out of the Peer document', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('## No Orchestration');
    expect(peer).not.toContain('## Lead Discovery and Recovery');
    expect(peer).not.toContain('## Moving Write Ownership');
  });

  // Paseo takes the seat to open as a free-form provider id, so nothing below the
  // contract stops Lead from opening a second Lead. The rule has to reach the seats
  // that hold the tool, and only those.
  it('tells each seat with room tools which seat it may open', () => {
    expect(renderInstructions('lead')).toContain('Lead opens Peer seats and no others');
    expect(renderInstructions('supervisor')).toContain('Supervisor opens Lead seats');
    expect(renderInstructions('peer')).not.toContain('## Peer Seat Lifecycle');
  });

  it('discovers and reuses the sole project Lead across lifecycle states', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain('read list_profiles and select the exact current room Lead profile');
    expect(supervisor).toContain('materialize every launch field present in that profile');
    expect(supervisor).toContain('combine provider and model');
    expect(supervisor).toContain('copy modeId, thinkingOptionId, and featureValues');
    expect(supervisor).toContain('omit fields the profile does not define');
    expect(supervisor).toContain('A cwd, title or provider label is never room membership');
    expect(supervisor).toContain('Use list_agents(cwd) only to discover current and recent candidates');
    expect(supervisor).toContain('also returns descendant working directories');
    expect(supervisor).toContain('post-filter candidates whose cwd is not exactly the intended project cwd');
    expect(supervisor).toContain('Reject archived candidates');
    expect(supervisor).toContain("selected current room Lead profile's exact provider");
    expect(supervisor).toContain('Inspect every remaining candidate with get_agent_status');
    expect(supervisor).toContain('require the status workspaceId to match it');
    expect(supervisor).toContain('require currentModeId to equal it');
    expect(supervisor).toContain('Paseo currently stores no profileId on an agent session');
    expect(supervisor).toContain('proves only that a direct launch is profile-equivalent');
    expect(supervisor).toContain('parentage or known Human-opened ownership history');
    expect(supervisor).toContain('Never silently adopt an unparented candidate');
    expect(supervisor).toContain('An eligible initializing or running Lead, an idle Lead after a completed turn');
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
    expect(lead).toContain('read list_profiles and select the exact current room Peer profile');
    expect(lead).toContain('materialize its launch configuration field by field');
    expect(lead).toContain('copy provider, modeId and featureValues exactly');
    expect(lead).toContain('use model and thinkingOptionId as the defaults governed below');
    expect(lead).toContain('omit absent fields');
    expect(lead).toContain('daemon-added paseo.parent-agent-id matching this Lead');
    expect(lead).toContain('A cwd, title or provider label is not room membership');
    expect(lead).toContain('proves profile-equivalent configuration, not literal profile-click provenance');
    expect(lead).toContain('Do not invent a profile provenance claim or provider-generation id');
    expect(lead).toContain('A Peer belongs to one fresh brief');
    expect(lead).toContain('Peer does not orchestrate');
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

  // The brief carries the question, not the answer: a plan read as binding turns Peer into
  // a typist and loses the independent judgment the second seat exists for.
  it('keeps the Lead brief from pre-solving the work', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('it does not pre-solve the work or embed the verdict');
    expect(lead).toContain('Only the outcome, boundaries, invariants and required evidence bind');
    expect(lead).toContain('provisional context that Peer may contradict with evidence');
  });

  it('tells Peer to form an independent, evidence-backed position', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('## Independent Judgment');
    expect(peer).toContain('rather than adopting Lead\'s framing because Lead sent it');
    expect(peer).toContain('is provisional context, not the answer');
    expect(peer).toContain('Agreement is a valid outcome when the evidence supports it');
    expect(peer).toContain('do not manufacture objections to look independent');
    expect(peer).toContain('it never becomes orchestration or self-acceptance');
  });

  // Observation is the positive half of Technical Non-Interference: Supervisor watches the
  // process and advises, and still decides nothing technical.
  it('gives Supervisor observation and advice without technical authority', () => {
    const supervisor = renderInstructions('supervisor');
    expect(supervisor).toContain('## Observation and Advice');
    expect(supervisor).toContain('an authority gradient that suppresses Peer judgment');
    expect(supervisor).toContain('a brief that pre-solves the work');
    expect(supervisor).toContain('framing capture, moving scope, polling instead of event-driven waiting');
    expect(supervisor).toContain('ask Lead an evidence-backed question');
    expect(supervisor).toContain('Advice carries no technical authority');
    expect(supervisor).toContain('propose a workspace protocol change to Human instead of imposing one');
    expect(renderInstructions('peer')).not.toContain('## Observation and Advice');
  });

  // The room has no writer isolation, so the stricter local limit is stated as a divergence
  // rather than quietly implying the model's per-scope rule.
  it('states the one-writable-Peer limit as an unrelaxable local rule', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('at most one active writable Peer across the project at a time');
    expect(lead).toContain('deliberately stricter than one writer per moving scope');
    expect(lead).toContain('No workspace protocol relaxes the limit');
    expect(lead).toContain('concurrent writable Peers in isolated worktrees are not available here');
  });

  // Eligibility evidence and tuning are different claims: copying a profile exactly must not
  // read as forbidding the task-risk policy the workspace protocol owns.
  it('keeps Peer eligibility exact while model and thinking stay protocol-governed defaults', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Provider, mode, workspace, parent and feature values are eligibility evidence');
    expect(lead).toContain("The profile's model and thinking values are defaults for the seat");
    expect(lead).toContain('only where the workspace protocol explicitly supplies a task-risk model and effort policy');
    expect(lead).toContain('Never select a thinking tier that advertises automatic task delegation');
    expect(lead).toContain('no thinking tier grants Peer delegation');
  });

  it('gives Lead acceptance authority and Supervisor routing only', () => {
    expect(renderInstructions('lead')).toContain('## Technical Acceptance');
    expect(renderInstructions('supervisor')).not.toContain('## Technical Acceptance');
  });

  // The default protocol ships in force, so no repository has to opt in to have one.
  it('carries the workspace protocol that bears on each role', () => {
    for (const role of ROLES) {
      const document = renderInstructions(role);
      for (const key of protocolKeys(role)) expect(document).toContain(loadPromptAsset('workspace', key));
      for (const key of instructionKeys(role)) expect(document).toContain(loadPromptAsset('contract', key));
    }
  });

  // No Orchestration forbids Peer to infer room topology; handing it the topology
  // rules would contradict that in the same document.
  it('keeps topology out of the Peer document', () => {
    expect(renderInstructions('peer')).not.toContain('## Topology');
    expect(renderInstructions('lead')).toContain('## Topology');
    expect(renderInstructions('supervisor')).toContain('## Topology');
  });

  it('writes the whole protocol to the room copy, without the role contract', () => {
    const workspace = renderInstructions('workspace');
    expect(headings(workspace)).toEqual(PROTOCOL_HEADINGS);
    expect(workspace).not.toContain('## Human Authority');
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

  it('renders repeatedly with byte-identical output and no retired heading patterns', () => {
    for (const kind of [...ROLES, 'workspace'] as const) {
      const first = renderInstructions(kind);
      expect(renderInstructions(kind)).toBe(first);
      expect(first).not.toMatch(/^## (?:RC-|WP-)/m);
    }
    for (const role of ROLES) {
      expect([...instructionKeys(role), ...protocolKeys(role)].join('\n')).not.toMatch(/^(?:RC-|WP-)/m);
    }
  });
});

describe('prompt assets', () => {
  it('has a manifest/filesystem bijection with the expected fragment kinds', async () => {
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
    expect(documentAssets.map(asset => asset.kind)).toEqual(Array(4).fill('head'));
    expect(contractAssets.map(asset => asset.kind)).toEqual(Array(22).fill('section'));
    expect(workspaceAssets.map(asset => asset.kind)).toEqual(Array(4).fill('section'));
    expect(piAssets.map(asset => asset.kind)).toEqual(Array(2).fill('capsule'));
  });

  it('validates and normalizes sections while preserving heads and Pi capsule hard lines', () => {
    expect(loadPromptAsset('contract', 'humanAuthority')).toMatch(
      /^## Human Authority\n- Human owns product goals/,
    );
    expect(loadPromptAsset('workspace', 'verification')).toContain(
      '## Verification\n- The repository\'s own gate is the evidence.',
    );
    expect(loadPromptAsset('documents', 'workspace')).toContain(
      'different rules\nprovides `docs/WORKSPACE_PROTOCOL.md`',
    );
    expect(loadPromptAsset('pi', 'communicationStyle')).toContain(
      'Prefer plain language\nand minimal formatting.',
    );
    expect(loadPromptAsset('pi', 'runtime')).toContain(
      'through Pi, shell\ncommands, or extensions.',
    );
  });
});
