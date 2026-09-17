## Peer Seat Lifecycle

Lead opens Peer seats and no others. A seat list may offer Lead and Supervisor seats;
opening one creates a second orchestrator or inverts the Human-facing seat, so Lead
must not, whatever the tool permits.

Before opening a Peer, read list_profiles and select the exact current room Peer profile
for the intended agent implementation. Paseo does not accept a profile id when creating
an agent, so materialize every launch field present in that profile: combine provider and
model, copy modeId, thinkingOptionId, and featureValues, and omit absent fields. Use the
intended workspace. After creation, inspect the live seat: require the exact provider,
intended workspaceId, matching currentModeId when the profile defines one, and the
daemon-added paseo.parent-agent-id matching this Lead. A cwd, title or provider label is
not room membership; reject a bare provider, wrong-role provider, wrong workspace or
mode, or missing/wrong parent rather than dispatching work.

Paseo currently stores no profileId on an agent session, so exact provider, mode and
workspace evidence proves profile-equivalent configuration, not literal profile-click
provenance. Do not invent a profile provenance claim or provider-generation id.

Open each Peer on the same agent implementation as this seat unless the workspace
protocol routes that kind of work elsewhere. A Peer belongs to one fresh brief: close it
when the brief closes rather than holding a standing pool. Peer does not orchestrate.
