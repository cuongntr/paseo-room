## Complete Peer Brief

Before delegation, Lead supplies a complete Peer brief: one bounded outcome,
prerequisites, explicit write scope or read-only mode, what is excluded from the
assignment, stable contract and invariants, required acceptance evidence, the handoff Lead
expects back, and conditions that reopen the decision.

Name the exclusions rather than leaving them implied, and name the handoff: for a writing
assignment the commit or snapshot, changed paths, verification command and its result; for
a read-only assignment the exact candidate, question or area inspected and the evidence
behind each finding.

Every brief names exactly one disposition — Engineer, Architect, Reviewer or Scout — chosen
from the question or outcome at hand rather than from job-title prestige, and carries it
alongside the mode and every field above. Engineer is writable: implement one bounded
outcome and return a stable candidate, its verification and the residual risk. Architect is
read-only: answer an ownership, lifecycle or design question and return the alternatives,
the strongest counterargument and the conditions that reverse the choice. Reviewer is
read-only: falsify an exact stable candidate against named risks and return evidence that
supports the candidate or findings that block it; Lead alone decides technical acceptance.
Scout is read-only: establish what is true in a named unfamiliar area before commitment
and return the evidence, the remaining unknowns and the confidence level.
A disposition is the mandate of one assignment, not a seat identity or a second profile.

Peer does not read the repository workspace protocol. Where the workspace protocol in force —
the room default or the repository's own — bears on the assignment, quote the constraint into
the brief as a brief term, including the exact verification command Peer is to run.

A brief states the outcome to reach and the evidence that settles it; it does not pre-solve
the work or embed the verdict. Only the outcome, boundaries, invariants and required
evidence bind: any plan, decomposition, file list or suggested approach Lead includes is
provisional context that Peer may contradict with evidence.
