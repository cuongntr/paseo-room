# Read-only local Paseo admission

`probePaseo` accepts a selected absolute CLI executable, canonical existing Paseo
home, operator HOME, optional local WebSocket URL, and injected filesystem,
process runner, current UID/hostname and live PID UID lookup. `connectPaseo`
adds a public-root SDK handshake and always closes the client. These are library
boundaries for the forthcoming lifecycle planner, not a new CLI command.

Only `daemon status --json` is executed, with shell disabled, an allowlisted
environment, a 5-second default timeout (maximum 30 seconds), and at most one
retry for EAGAIN/EINTR/timeout. JSON/schema, compatibility, admission and auth
failures are never retried. Status uses provider-free `PATH=/dev/null`, so the
pinned CLI's fallback probes cannot launch `claude`, `codex`, or `opencode`,
even on authentication failure. A validated canonical, single-link executable
with safe ownership/modes and parents is required. The exact npm shebang
`#!/usr/bin/env node` (or the pinned distribution’s exact
`#!/usr/bin/env -S node --disable-warning=DEP0040`) is run with absolute `process.execPath` plus the absolute
selected script, retaining only that fixed warning flag; native executables run directly. Other shebangs are rejected.
No shell or ambient Node options are passed. The probe and gateway take the caller's optional
`PASEO_PASSWORD` value separately in memory. It is allowlisted only as
`PASEO_PASSWORD` in the selected status subprocess environment and as `password`
in the public SDK config. It never enters argv, intent, results, diagnostics,
files, or provider/Codex environments. SDK logs are disabled and raw errors are
replaced with fixed actionable diagnostics. Missing and incorrect credentials
are classified as `auth_required` and `auth_failed`; successful status admission
is required before creating the SDK client.

Initialize/start/upgrade/authenticate Paseo yourself. Missing/unsafe state is
not repaired. In particular the pinned CLI status implementation creates an
absent/empty `server-id` or `cli-client-id`, may follow identity links, and
chmods an existing server identity. Before any identity read or status spawn,
admission requires both identities to be nonempty current-user, single-link
regular files with mode `0600`. Config must also exist as a current-user,
single-link regular file with exact mode `0600`; it is never created or chmodded.
PID metadata must also be safe and
free of symlink/hard-link aliases. Missing, empty, unsafe or linked state is
rejected, never created or repaired. No credential aliases are read. The
upstream identity/config chmod may still update ctime, but bytes and safe modes
must remain unchanged.

Status can contact its persisted target before emitting JSON. Preflight therefore
strictly parses the existing PID file, requires a positive PID, current UID,
exact local hostname and live process UID, and normalizes its required listen
endpoint to loopback. Missing listen/config fallback, remote, SSH, relay and
socket targets are rejected before status runs; an optional URL must match this
persisted endpoint. Returned status home, normalized listen, PID, owner and
hostname must match that preflight evidence, not merely appear independently
plausible. This prevents the pinned CLI's identity creation and remote-target
side effects before post-status validation could detect them. macOS callers
must pass canonical `/private/...` paths rather than symlink aliases such as
`/tmp/...`.

Normalized identity is SHA-256 of UTF-8 `JSON.stringify([localHome, listen])`.
Listen is `ws[s]://127.0.0.1:port` (localhost converges with IPv4) or
`ws[s]://[::1]:port`. IPv6 is not assumed to be IPv4. Root and `/ws` URL spellings
converge; the public SDK connects at `/ws`. Unknown non-admission status fields
are ignored and never returned; required admission fields have strict types.

This is **local admission, not connected-peer identity**. No `serverId` is
returned or trusted, and no internal SDK or raw protocol API is used. A loopback
process replacement between probes remains the owner-accepted R-005 risk.
Later mutation work must re-probe under the canonical home/listen lock and
verify full provider state immediately after mutation.

Verification: `npm run verify`; focused tests:
`npx vitest run test/paseo-probe.test.ts`. Explicit isolated npm-distribution proof:
`npx vitest run --config vitest.paseo.config.ts`. The latter installs pinned CLI
only under a new canonical temporary root (no repository dependency changes),
sets explicit temporary HOME/PASEO_HOME, reserves a unique loopback port,
disables relay/MCP/web UI, and connects through the public SDK. Before the very
first probe it snapshots server/client identities, PID and config bytes and safe
modes, then checks preservation after successful and failed auth probes (ignoring
daemon-owned logs/timestamps). It covers unauthenticated and password-protected
daemons with correct/missing/wrong passwords. Test-only auth provisioning uses only public `daemon start`, with a synthetic
`PASEO_PASSWORD` only in that fixture start environment. Install and general
helper environments remain password-free; no server imports or direct credential
config writes are used. It reports observed ctime
changes and stops only that temporary daemon before deleting its tree. It requires
network access to npm. It never uses Desktop Paseo or the operator's Paseo home.

### Isolated provider/session contract evidence

The same pinned suite patches and reads back all three fixed profiles, preserves
unrelated providers/config and synthetic credential bytes/mode, verifies readiness
and the exact live `true/true/false` policy, replaces a two-element launch prefix
with a one-element prefix, and removes only the managed IDs.

For **each role**, a protocol-only fake records its PID, role home, exact
`[process.execPath, script, 'app-server']` discovery argv (session launches add
the pinned daemon's `--enable goals` suffix), initialization parameters and
successful responses. It serves discovery/config/skills requests and synthetic
completed turns, never runs tools or performs project work. Captures exclude
thread config, instructions and other possible credential-bearing payloads.
Public `agents.create`, `agent.run`, `agent.refresh`, `agents.list` and
`agent.archive` prove session visibility, idle-session refusal by the production
transaction `sessionsSafe` gate, verification failure with the exact managed ID,
and safe inventory after explicit archive before provider update/removal.

Evidence boundaries on `0.8.0-beta.1`:

- **Refresh:** provider refresh/readiness and agent snapshot refetch are exercised.
  `agent.refresh()` is a refetch, not a daemon session restart or tool reinjection.
- **Resume:** the fake evicts its native thread between two completed turns;
  public `agent.run()` causes a captured `thread/resume` with the original thread
  ID. This proves native thread reload, not a persisted-agent resume after daemon
  restart. The root factory exposes no explicit `agents.resume` operation.
- **Import:** the root factory exposes no `agents.import` operation. Import and
  persisted-agent resume are **not verified**; no internal/low-level API bypass
  is used to manufacture evidence.
- **Archive:** the public archive result is observed through archived inventory
  and the safe transaction gate. A native `thread/archive` RPC was not observed
  for these derived providers; native archival is not claimed.
- **Tool delivery:** relay/MCP/injection stay disabled for isolation. Live config
  and readiness prove the fixed policy, not delivery or execution of individual
  Paseo tools. Full create/resume/refresh/import tool-delivery enforcement remains
  pinned downstream Paseo contract evidence as specified by the design, never
  agent self-report or an OS sandbox claim.

Each auth variant emits a structured summary of verified and unavailable paths.
Teardown stops only the explicitly selected fixture daemon and checks every
recorded fake PID has exited before removing the tree. Failure to establish
shutdown preserves the tree rather than deleting live process state.
