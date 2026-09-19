## Room Seat Identity

Before opening a room seat, read list_profiles and select the exact current room profile for
the role and agent implementation intended. Paseo does not accept a profile id when creating
an agent, so materialize that profile's launch configuration field by field: copy provider,
modeId and featureValues exactly, use its model as the model default and its thinkingOptionId
as the effort default, and omit every field the profile leaves absent. Use the intended
workspace.

After creation, inspect the live seat: require the selected profile's exact provider, the
intended workspaceId, and a currentModeId matching the profile wherever the profile defines
one. A cwd, title or provider label is never room membership, and an ordinary bare codex,
claude or pi provider is not a room seat. Reject a bare provider, a wrong-role provider, or a
wrong workspace or mode rather than routing work to it.

Paseo currently stores no profileId on an agent session. Exact provider, mode and workspace
evidence therefore proves profile-equivalent configuration, not literal profile-click
provenance. Do not invent a profile provenance claim or a provider-generation id.
