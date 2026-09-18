import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instructionKeys, protocolKeys, renderInstructions } from '../src/room/instructions.js';
import { PROMPT_ASSETS, loadPromptAsset } from '../src/room/prompts.js';
import { ROLES } from '../src/roles.js';

const SHARED_HEADINGS = ['Human Authority', 'Evidence and Event-Driven Waiting', 'Scope and Unrelated Work'] as const;
const PROTOCOL_PRECEDENCE_HEADING = 'Workspace Protocol Precedence';
const PROTOCOL_HEADINGS = ['Topology', 'Verification', 'Review', 'Repository Conventions'] as const;
const WORKSPACE_PROTOCOL_PATH = 'WORKSPACE_PROTOCOL.md';
const WORKSPACE_PREFACE_MARKER = '# Workspace protocol';

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
      'Human Authority',
      PROTOCOL_PRECEDENCE_HEADING,
      'Evidence and Event-Driven Waiting',
      'Scope and Unrelated Work',
      'Directive Integrity',
      'Technical Non-Interference',
      'Lead Discovery and Recovery',
      'Observation and Advice',
      'Escalation Boundaries',
      ...PROTOCOL_HEADINGS,
    ]);
    expect(headings(renderInstructions('lead'))).toEqual([
      'Human Authority',
      PROTOCOL_PRECEDENCE_HEADING,
      'Evidence and Event-Driven Waiting',
      'Scope and Unrelated Work',
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
      'Assignment Scope',
      'No Orchestration',
      'Reproducible Handoff',
      'No Self-Acceptance',
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
    expect(lead).toContain("use the profile's model as the model default and its");
    expect(lead).toContain('thinkingOptionId as the effort default');
    expect(lead).toContain('apply the policy below only when it establishes a');
    expect(lead).toContain('supported alternative, and omit every field left absent');
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

  // One Peer profile stays, so the disposition has to arrive as an explicit mandate in the
  // brief; an implied one silently drops the mode and the return contract with it.
  it('requires one explicit Peer disposition and maps all four mandates', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Every brief names exactly one disposition');
    expect(lead).toContain('Engineer, Architect, Reviewer or Scout');
    expect(lead).toContain('from the question or outcome at hand rather than from job-title prestige');
    expect(lead).toContain('alongside the mode and every field above');
    expect(lead).toContain('Engineer is writable: implement one bounded');
    expect(lead).toContain('outcome and return a stable candidate, its verification and the residual risk');
    expect(lead).toContain('read-only: answer an ownership, lifecycle or design question and return the alternatives,');
    expect(lead).toContain('the strongest counterargument and the conditions that reverse the choice');
    expect(lead).toContain('read-only: falsify an exact stable candidate against named risks');
    expect(lead).toContain('Scout is read-only: establish what is true in a named unfamiliar area before');
    expect(lead).toContain('and return the evidence, the remaining unknowns and the confidence level');
    expect(lead).toContain('A disposition is the mandate of one assignment, not a seat identity or a second profile');
  });

  // Reviewer produces the evidence for acceptance and never the acceptance: technical
  // acceptance stays with Lead, so a read-only falsification brief must not read as a verdict.
  it('keeps Reviewer short of technical acceptance', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain(
      'supports the candidate or findings that block it; Lead alone decides technical acceptance.',
    );
  });

  // Eligibility evidence and tuning are different claims, and the two tuning knobs are not
  // symmetric: the model follows the profile unless routed, while effort is Lead's per-brief call.
  it('keeps Peer eligibility exact while restricting model more than thinking effort', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Provider, mode, workspace, parent and feature values are eligibility evidence');
    expect(lead).toContain('Model and thinking effort are task-level choices, and the model is the more');
    expect(lead).toContain('restricted of the two. The model stays the exact current Peer profile default unless the');
    expect(lead).toContain('root workspace protocol explicitly supplies model routing');
    expect(lead).toContain('Thinking effort is Lead\'s choice');
    expect(lead).toContain('per brief, weighed on the task\'s risk, the uncertainty in it, the size and complexity of');
    expect(lead).toContain('the context it carries and the verification burden it leaves behind');
    expect(lead).toContain('signal among those and never a fixed tier per disposition');
    expect(lead).toContain('Use the lowest effort that can');
    expect(lead).toContain('reliably answer the task, and raise it for architecture-sensitive, high-consequence or');
    expect(lead).toContain('Choose only an option the live Paseo and provider context');
    expect(lead).toContain('establishes as supported; where the available choices cannot be established, keep the');
    expect(lead).toContain('profile default and never invent an identifier');
    expect(lead).toContain('Never select a thinking tier that');
    expect(lead).toContain(
      'advertises automatic task delegation; no thinking tier grants Peer delegation. A decision with material cost belongs to Human',
    );
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
  // rules would contradict that in the same document. The rest of the workspace layer is
  // withheld for the same reason the model gives: Lead quotes what bears on the brief.
  it('keeps the whole workspace layer out of the Peer document', () => {
    const peer = renderInstructions('peer');
    expect(protocolKeys('peer')).toEqual([]);
    expect(peer).not.toContain(WORKSPACE_PREFACE_MARKER);
    for (const heading of PROTOCOL_HEADINGS) expect(peer).not.toContain(`## ${heading}`);
    expect(peer).not.toContain(`## ${PROTOCOL_PRECEDENCE_HEADING}`);
    for (const role of ['lead', 'supervisor'] as const) {
      const document = renderInstructions(role);
      expect(document).toContain(WORKSPACE_PREFACE_MARKER);
      for (const heading of PROTOCOL_HEADINGS) expect(document).toContain(`## ${heading}`);
    }
  });

  // Peer keeps the invariant without the file: a repository cannot enlarge its authority,
  // and a conflict is Lead's to resolve rather than Peer's to choose between.
  it('gives Peer the precedence invariant without the repository protocol path', () => {
    const peer = renderInstructions('peer');
    expect(peer).not.toContain(WORKSPACE_PROTOCOL_PATH);
    expect(peer).toContain('Repository instructions describe how work is done here');
    expect(peer).toContain('cannot enlarge or weaken the authority this contract gives Peer');
    expect(peer).toContain('report the conflict to Lead instead of choosing between them');
  });

  // The brief is the only channel that reaches Peer, so what the repository requires has to
  // arrive quoted inside it — including the command that produces the acceptance evidence.
  it('makes Lead quote repository constraints into the brief instead of broadcasting them', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('what is excluded from the assignment');
    expect(lead).toContain('the handoff Lead expects back');
    expect(lead).toContain('Name the exclusions rather than leaving them implied');
    expect(lead).toContain('Peer does not read the repository workspace protocol');
    // The quoting duty must reach the room default too, not only a repository's own file.
    expect(lead).toContain('Where the workspace protocol in force — the room default or the repository\'s own —');
    expect(lead).toContain('quote the constraint into the brief as a brief term');
    expect(lead).toContain('including the exact verification command Peer is to run');
    expect(lead).toContain('This is the reader\'s own layer, not a document to broadcast');
    // Lead and Supervisor now carry every workspace section, so the precedence section must
    // not still promise a role-filtered excerpt.
    expect(lead).toContain('reproduced in full at the end of this document');
    expect(lead).not.toContain('the part of it that bears on this role');
  });

  // One thin Peer profile has to carry Engineer, Architect, Reviewer and Scout briefs, so
  // scope and handoff speak about writable versus read-only rather than about a job title.
  it('supports writable and read-only Peer dispositions from one profile', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('A brief is either writable or read-only');
    expect(peer).toContain('A writable assignment owns only its assigned moving write scope');
    expect(peer).toContain('A read-only assignment changes no project file and no candidate');
    expect(peer).toContain('an exact candidate or snapshot when the question is whether that candidate holds');
    expect(peer).toContain('a named question, area or unfamiliar territory');
    expect(peer).toContain('widening the target is a new brief for Lead to decide');
    expect(peer).toContain('A read-only assignment hands back the same kind of evidence');
    expect(peer).toContain('the exact commit or snapshot inspected');
    expect(peer).toContain('State alternatives considered and the conditions that would reverse a conclusion');
    expect(peer).toContain('repeat the inspection without asking a follow-up question');
  });

  // Peer no longer carries the workspace Verification or Repository Conventions sections, so
  // faithful reporting, the unrun-gate bar and executor restraint live in its own contract.
  it('keeps faithful verification reporting in the Peer contract itself', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('Report what verification produced as it came back, failures included');
    expect(peer).toContain('never present part of a gate as the whole of it');
    expect(peer).toContain('A candidate whose named verification was not run is not a candidate');
    expect(peer).toContain('hand it back as unrun rather than as done');
  });

  it('keeps house-style and unrequested-addition restraint in the Peer contract', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('Work the way the files in scope already work');
    expect(peer).toContain('add no top-level file, directory, dependency or tooling the brief did not ask for');
    expect(peer).toContain('Raise DEPENDENCY_REQUEST when the outcome appears to need one');
  });

  it('bounds BLOCKED to in-scope progress and states the tool boundary without config detail', () => {
    const peer = renderInstructions('peer');
    expect(peer).toContain('BLOCKED reports that no safe in-scope progress is possible');
    expect(peer).toContain('Peer receives no Paseo room tools');
    expect(peer).not.toContain('enabled is false');
    expect(renderInstructions('lead')).toContain('no safe in-scope progress is possible');
  });

  // A direct-writing Lead is the topology the protocol recommends for small work, so the
  // gate cannot be written as something only a briefed Peer ever runs.
  it('lets a direct-writing Lead run the gate and keeps review conditional', () => {
    const lead = renderInstructions('lead');
    expect(lead).toContain('Whoever performs the work runs it: Lead when Lead writes the change itself');
    expect(lead).toContain('otherwise the Peer whose brief names the exact command');
    expect(lead).toContain('When independent review is required, it runs in a fresh session');
  });

  it('writes the whole protocol to the room copy, without the role contract', () => {
    const workspace = renderInstructions('workspace');
    expect(headings(workspace)).toEqual(PROTOCOL_HEADINGS);
    expect(workspace).not.toContain('## Human Authority');
  });

  // The default is worthless if a repository cannot displace it point by point. The preface
  // is a head asset, so its hard line breaks survive rendering: compare on collapsed space.
  it('states that a repository rule wins where it speaks', () => {
    const documents = [renderInstructions('supervisor'), renderInstructions('lead'), renderInstructions('workspace')];
    for (const document of documents) {
      expect(document.replace(/\s+/g, ' ')).toContain('wherever it speaks to a point');
    }
  });

  // A default nobody can override, or an override path nobody is told, is useless. The path
  // is the repository root because it is agent guidance, not project documentation.
  it('tells every protocol-reading seat the root path that replaces the default', () => {
    expect(renderInstructions('workspace')).toContain('`WORKSPACE_PROTOCOL.md` at its root');
    expect(renderInstructions('supervisor')).toContain('WORKSPACE_PROTOCOL.md at its root');
    expect(renderInstructions('lead')).toContain('WORKSPACE_PROTOCOL.md at its root');
    for (const document of [...ROLES.map(renderInstructions), renderInstructions('workspace')]) {
      expect(document).not.toContain('docs/WORKSPACE_PROTOCOL.md');
    }
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
      'different rules\nprovides `WORKSPACE_PROTOCOL.md` at its root',
    );
    expect(loadPromptAsset('documents', 'workspace')).toContain(
      'Quote what bears on a brief into the brief\nrather than handing this layer to a Peer.',
    );
    expect(loadPromptAsset('pi', 'communicationStyle')).toContain(
      'Prefer plain language\nand minimal formatting.',
    );
    expect(loadPromptAsset('pi', 'runtime')).toContain(
      'extension-provided mechanisms other than the Paseo room tools\nare not lifecycle channels here.',
    );
  });
});
