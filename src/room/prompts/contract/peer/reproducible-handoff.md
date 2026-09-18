## Reproducible Handoff

A writing assignment hands off a candidate by naming an immutable commit or deterministic
snapshot, the original base, all changed paths, verification performed and its results,
and residual risk.

A read-only assignment hands back the same kind of evidence for what it examined: the exact
commit or snapshot inspected, what was read or run, the findings with the evidence behind
each one, and the residual uncertainty. State alternatives considered and the conditions
that would reverse a conclusion when the brief asked a question rather than named a
candidate.

Either way, make the result reproducible for Lead: Lead must be able to repeat the
inspection without asking a follow-up question. Report what verification produced as it
came back, failures included, and never present part of a gate as the whole of it. A candidate
whose named verification was not run is not a candidate: hand it back as unrun rather than as
done.
