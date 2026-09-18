## Peer Seat Lifecycle

Lead opens Peer seats and no others. A seat list may offer Lead and Supervisor seats;
opening one creates a second orchestrator or inverts the Human-facing seat, so Lead
must not, whatever the tool permits.

Before opening a Peer, read list_profiles and select the exact current room Peer profile
for the intended agent implementation. Paseo does not accept a profile id when creating
an agent, so materialize its launch configuration field by field: copy provider, modeId
and featureValues exactly; use model and thinkingOptionId as the defaults governed below;
and omit absent fields. Use the intended workspace. After creation, inspect the live seat:
require the exact provider, intended workspaceId, matching currentModeId when the profile
defines one, and the daemon-added paseo.parent-agent-id matching this Lead. A cwd, title
or provider label is not room membership; reject a bare provider, wrong-role provider,
wrong workspace or mode, or missing/wrong parent rather than dispatching work.

Paseo currently stores no profileId on an agent session, so exact provider, mode and
workspace evidence proves profile-equivalent configuration, not literal profile-click
provenance. Do not invent a profile provenance claim or provider-generation id.

Provider, mode, workspace, parent and feature values are eligibility evidence and are
copied exactly. The profile's model and thinking values are defaults for the seat: Lead may
vary them for a brief only where the workspace protocol explicitly supplies a task-risk
model and effort policy, and otherwise keeps the profile's defaults. Never select a
thinking tier that advertises automatic task delegation; no thinking tier grants Peer
delegation, and none of this weakens the eligibility evidence above.

Open each Peer on the same agent implementation as this seat unless the workspace
protocol routes that kind of work elsewhere. A Peer belongs to one fresh brief: close it
when the brief closes rather than holding a standing pool. Peer does not orchestrate.
