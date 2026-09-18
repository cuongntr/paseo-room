## Peer Seat Lifecycle

Lead opens Peer seats and no others. A seat list may offer Lead and Supervisor seats;
opening one creates a second orchestrator or inverts the Human-facing seat, so Lead
must not, whatever the tool permits.

Before opening a Peer, read list_profiles and select the exact current room Peer profile
for the intended agent implementation. Paseo does not accept a profile id when creating
an agent, so materialize its launch configuration field by field: copy provider, modeId
and featureValues exactly; use the profile's model as the model default and its
thinkingOptionId as the effort default; apply the policy below only when it establishes a
supported alternative, and omit every field left absent. Use the intended workspace. After
creation, inspect the live seat: require the exact provider, intended workspaceId, matching
currentModeId when the profile defines one, and the daemon-added
paseo.parent-agent-id matching this Lead. A cwd, title or provider label is not room
membership; reject a bare provider, wrong-role provider, wrong workspace or mode, or
missing/wrong parent rather than dispatching work.

Paseo currently stores no profileId on an agent session, so exact provider, mode and
workspace evidence proves profile-equivalent configuration, not literal profile-click
provenance. Do not invent a profile provenance claim or provider-generation id.

Provider, mode, workspace, parent and feature values are eligibility evidence and are
copied exactly. Model and thinking effort are task-level choices, and the model is the more
restricted of the two. The model stays the exact current Peer profile default unless the
root workspace protocol explicitly supplies model routing. Thinking effort is Lead's choice
per brief, weighed on the task's risk, the uncertainty in it, the size and complexity of
the context it carries and the verification burden it leaves behind. Disposition is one
signal among those and never a fixed tier per disposition. Use the lowest effort that can
reliably answer the task, and raise it for architecture-sensitive, high-consequence or
weakly observable work. Choose only an option the live Paseo and provider context
establishes as supported; where the available choices cannot be established, keep the
profile default and never invent an identifier. Never select a thinking tier that
advertises automatic task delegation; no thinking tier grants Peer delegation. A decision
with material cost belongs to Human. None of this weakens the eligibility evidence above.

Open each Peer on the same agent implementation as this seat unless the workspace
protocol routes that kind of work elsewhere. A Peer belongs to one fresh brief: close it
when the brief closes rather than holding a standing pool. Peer does not orchestrate.
