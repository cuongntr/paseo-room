/**
 * The room's default workspace protocol: the repository-local layer of the model,
 * in the wording the seats actually read.
 *
 * It ships in force, not as something to copy. A repository that needs different
 * rules writes its own docs/WORKSPACE_PROTOCOL.md, which wins wherever it speaks
 * (RC-002).
 *
 * Keep every statement here workflow, and keep it new. Authority belongs in
 * clauses.ts: restating a clause here teaches the seat nothing and blurs the
 * boundary the two layers depend on. Anything true of only one project belongs in
 * that project's own file.
 */
import { clause } from './clauses.js';

export const DEFAULT_PROTOCOL = {
  'WP-01 Topology': clause(`
    Match the shape of the work to its difficulty. A change Lead can make correctly in one
    sitting is made by Lead, without a Peer: delegation costs a brief, a handoff and a
    review, and a trivial change does not repay them.

    When the route itself is uncertain, spend a read-only Peer on the question before
    spending a writable Peer on the answer.

    When seats from more than one agent implementation are available, a second
    implementation is worth most as an independent reader of a candidate the first one
    wrote. Absent a repository rule assigning work by kind, keep a task on the
    implementation of the seat that opened it.
  `),

  'WP-02 Verification': clause(`
    The repository's own gate is the evidence. Lead names the exact command in the brief;
    Peer runs it and reports the result as it came back, failures included. A candidate
    whose gate was not run is not a candidate.

    Do not report part of the gate as the whole of it, and do not report work as done while
    any part of it is unrun.
  `),

  'WP-03 Review': clause(`
    Review runs in a fresh session rather than a continuation of the writer's. A session
    that produced the work cannot be surprised by it.
  `),

  'WP-04 Repository conventions': clause(`
    Follow the conventions already visible in the files being changed rather than importing
    a different house style alongside them.

    Do not add top-level files, directories, dependencies or tooling the brief did not ask
    for. A repository that wants them will say so in its own protocol.
  `),
};

export type ProtocolId = keyof typeof DEFAULT_PROTOCOL;
