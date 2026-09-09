# Locked install/update execution

`executeTransaction` is an internal service, not CLI or recovery UX. Callers supply an authorized, admitted planner result, a private existing room root, and injected boundaries. `paseoExecutorDependencies` connects the production global lock and public SDK gateway. An explicit trusted `{ noop: true }` result makes no filesystem or daemon calls.

The fixed lock namespace is `/tmp/paseo-room-<uid>/daemon-<hash>.lock`, keyed only by canonical local home, normalized status listen and the fixed three provider IDs. macOS's system `/tmp` alias is resolved for anchored IO only. Lock files record current-user PID and process-start evidence. Contention never waits or retries. Stale, reused, foreign or uninterpretable ownership is retained rather than automatically stealing a lock; explicit recovery must reconcile it. The shared per-user directory is not removed on release.

Under the lock, admission, provider ownership and complete session inventory are checked again. Publishing files precedes one complete three-provider patch, immediate complete readback, refresh/readiness/policy verification, and verification of declared file values. A matching durable manifest is the commit point. Signals before that point use the same conditional compensation path as handled failures.

## Manifest evidence

`transactions/<transactionId>/manifest-publication.json` is a private, fsynced orchestrator sidecar, separate from `TransactionJournalV1.fileMutations`. It declares schema version 1, transaction ID, fixed destination, unpredictable same-parent prepared/capture names, exact before/after file values, and admitted parent metadata. `loadManifestPublication` validates restart evidence against independently selected context. It contains no credential bytes or arbitrary daemon config.

The old manifest is captured, not unlinked after a precheck. The new manifest is published with a no-clobber hard link, followed by prepared-name retirement and directory/file durability barriers. The destination may be briefly absent, as allowed by the accepted portable capture/no-clobber design. Exact interrupted hard-link pairs can be reconciled; unknown captures, symlinks, parent rebinding or concurrent destination winners are retained. Matching post-publication manifests are never rolled back even when completion or journal marking fails.

Before the commit point, only providers still equal to recorded after-values are reversed. A forward or reverse mutation without a resolved completion result can still finish later, so it goes directly to `recovery-required`; an immediate read cannot establish a transport ordering barrier and is never used to authorize file removal. Divergent or active providers retain recovery evidence and their role files. After old-manifest restoration, exact manifest temporaries are retired; only a resolved provider reversal followed by registry refresh, complete snapshot/config read-back, prior readiness-or-absence verification, and inactive-session verification permits conditional filesystem compensation. Failures preserve the transaction for explicit recovery.

Committed bundle cleanup is orchestrator-owned because manifest publication legitimately changes the root directory link count on macOS. It removes only validated private staging/before-image leaves and the matching terminal journal, never managed destinations. Unrecognized leaves block cleanup.

Recovery command wiring, reopening/finishing sidecars, stale-lock reconciliation and partial uninstall remain future-bead work. These modules do not edit Paseo configuration files, start dependencies or access operator Codex/Paseo homes. Public SDK admission still does not establish protocol-level connected peer identity.
