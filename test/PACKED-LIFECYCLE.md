# Packed lifecycle evidence (`paseo-room-spu`)

Focused gates:

```sh
npm run build
npm exec -- vitest run --config vitest.package.config.ts test/lifecycle.package.test.ts
npm run typecheck
npm run lint
```

`npm run test:package` discovers this suite. The test executes only the packed
`dist/cli/index.js`; repository source is used solely to validate each child
process's single JSON document against result schema v1. It installs dependencies
outside the disposable artifact/cache tree and supplies an isolated Paseo
`0.8.0-beta.1` daemon plus a credential-free fake Codex app-server. It never
uses operator homes, credentials, real Codex, or internal Paseo imports.

The packed suite proves:

- A real pseudo-terminal wizard invocation and equivalent explicit flags produce
  the same ordered human/JSON plan. Declining the default-no confirmation leaves
  managed, canonical, and daemon configuration state unchanged. The PTY harness
  uses the standard `expect` utility; Linux CI installs it explicitly.
- Default install is dry-run, explicit apply installs, `verify`/`doctor` pass,
  and a second apply is an exact no-op with an unchanged managed tree.
- Provider commands are persistent absolute Node/fake-Codex prefixes with the
  true/true/false Supervisor/Lead/Peer policy. After deleting the extracted and
  installed package copies and npm cache, every provider still completes a
  synthetic public-SDK turn. Captured argv contains no artifact/cache path.
- Semantic canonical configuration drift produces doctor exit 1; explicit apply
  regenerates ownership and verify returns to success.
- Full uninstall removes unchanged state and preserves unrelated provider state.
  Customized owned files and mutable children produce exit 3, survive partial
  uninstall under `uninstall-incomplete`, and are discharged only after explicit
  fixture-owner reconciliation.
- A real installer is stopped with `SIGKILL` after provider publication while
  fake discovery is externally paused. Normal apply exits 4, recovery dry-run is
  byte-for-byte read-only, and `recover --apply` conditionally restores the absent
  prior room, exact unrelated daemon config, and canonical state. A repeated
  applied recovery is non-mutating and releases its lock.
- Usage exit 2 and all lifecycle exits are asserted exactly. Every JSON lifecycle
  result is schema-v1 parsed.

The SIGKILL case is the packed interruption proof. The source-level transaction
and recovery suites remain the exhaustive evidence for every filesystem/provider
commit boundary and handled signals; this document does not relabel those as
packed cases. Comment-only source drift is detected but is not claimed to require
artifact regeneration when rendered semantics are unchanged.

Teardown independently closes the public SDK, stops only the fixture daemon,
checks every recorded fake PID, validates any fixture-keyed dead lock before
removal, removes the fixture-keyed empty recovery guard, and deletes only the
explicit temporary root. Failed cleanup is reported as a bounded aggregate.

Latest full `npm run verify`: typecheck and lint passed; 22 unit/integration files
with 1,140 tests passed; build and pack dry-run passed; both packed suites passed.
The lifecycle package case completed in 346.80 seconds in its final focused run.
Independent R2 security review approved the recovery-lock and packed acceptance
proof with no High or Medium findings.

## Platform automation (`paseo-room-89o`)

`.github/workflows/ci.yml` runs a Node 22 matrix on `ubuntu-latest` and
`macos-latest`. Each job fails closed in this order:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
npm run test:package
npm run test:paseo
# macOS matrix job only:
npm run test:macos
```

`npm test` contains both unit/property and integration/failure-injection tests.
The standalone pinned contract is deliberately not part of `npm run verify`;
it runs explicitly after the packed suites in CI. Ubuntu installs `expect`
with `sudo apt-get update && sudo apt-get install -y expect`; both platforms
require `test -x /usr/bin/expect && /usr/bin/expect -v`. The packed TTY test is
never conditionally skipped. CI step/test names identify the failed command;
no fixture homes or raw daemon logs are uploaded as artifacts.

### Focused macOS smoke

```sh
npm run typecheck
npm run lint
npm run test:macos
```

`test/macos-gui.smoke.ts` is selected only by `vitest.macos.config.ts`, not the
ordinary or packed suites. Explicit invocation on non-macOS fails, not skips.
The command builds, packs, and installs the actual artifact in a fresh private
temporary root containing spaces. It installs `@getpaseo/cli@0.8.0-beta.1`
under that root and starts only that isolated daemon on an OS-selected loopback
port (never the default port), without relay, MCP listener, or web UI. Registry
access is required; port reservation is released before daemon binding, so an
unlikely competing bind fails the smoke rather than targeting another daemon.

The daemon receives only `HOME`, `PASEO_HOME`, `TMPDIR`, and
`PATH=/usr/bin:/bin`; it is invoked with absolute Node and public CLI paths.
The packed installer uses the same explicit environment with one private
`bin/node` link added for supported Codex launcher discovery. It receives
explicit disposable room/Codex/Paseo paths; neither process inherits the
operator's environment or shell initialization. npm setup separately uses the
shared isolated fixture environment/cache configuration.

Assertions cover packed schema-v1 install/verify/uninstall, exact persisted
absolute Node/script prefixes, complete true/true/false policy read-back,
three successful public-SDK synthetic agent turns, and captured per-role
app-server argv/home. The canonical synthetic home remains unchanged. Only
fixture initialization writes synthetic auth `{}`; no real credentials are used.
Teardown independently closes the SDK, stops and checks the fixture daemon,
waits for every recorded fake PID to disappear without signaling arbitrary
PIDs, and removes only a validated fixture-keyed dead installer lock if
necessary. It removes the exact temporary root only after termination and lock
cleanup are confirmed; otherwise it preserves private evidence and reports
sanitized check IDs, never raw SDK/daemon output.

Local focused evidence: macOS typecheck and lint passed; system `expect` 5.45
was present; the final focused `npm run test:macos` passed (one test, 99.39
seconds). Hosted GitHub Actions run
[`34424578281`](https://github.com/cuongntr/paseo-room/actions/runs/34424578281)
passed the complete ordered Node 22 matrix: Ubuntu in 18m00s and macOS in 19m36s.
Both jobs passed typecheck, lint, 1,142 unit/integration tests, build, pack
inspection, both packed suites, and both isolated Paseo contracts; macOS also
passed the focused GUI-like smoke. Bounded fixture readiness waits account for
the pinned daemon publishing its WebSocket and PID/listen authority
asynchronously without weakening or skipping either platform.

Limitations: this is a GUI-like environment simulation, not a launchd/Desktop
installation or the owner-approved real user-home R3 rehearsal. It covers the
Node-script prefix, not a native Codex binary. Fake turns and configuration
read-back do not prove real Codex compatibility or tool-delivery enforcement;
Peer policy is not an OS sandbox. Real Codex/native launch and user-managed
Desktop/R3 release evidence remain separate gates.
