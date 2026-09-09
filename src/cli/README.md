# Non-interactive lifecycle CLI

`plan`, `install`, `verify`, `doctor`, `recover`, and `uninstall` route through the shared adapter, observation/planner, admitted public SDK and transaction services. No-argument invocations return usage exit 2 until the separate wizard Bead lands.

`--agent codex`, `--apply`, `--json`, `--non-interactive`, `--room-home`, `--codex-home`, `--codex-bin`, `--paseo-bin`, and `--paseo-url` are the supported options. There is no `--node-bin` or password option. Explicit selections take precedence over supported environment defaults. The immediate room parent must already exist and pass anchored safety admission; the CLI does not create an arbitrary parent tree.

`runLifecycle` is the central mutation authorization point: read-only preparation returns a result and optional mutation closure. Only an explicit apply intent for install/recover/uninstall invokes that closure. Planning and inspection use SDK snapshots/config reads/agent inventory without registry refresh. Transaction execution re-probes under lock and performs refresh/read-back only after explicit authorization. Dependency installation, authentication and daemon lifecycle remain operator responsibilities.

JSON emits one schema-v1 document, including usage and operational errors. Exit codes are 0 success, 1 validation/compatibility/verification/operation failure, 2 usage, 3 conflict, and 4 recovery-required. Raw parser/process/SDK failures are not reflected; known password values and terminal controls are removed from rendered diagnostics. Operations contain metadata, never file or credential contents.

First-install execution creates a deterministic private sibling bootstrap sidecar before the absent 0700 root. The sidecar survives crashes, serializes by room path across endpoints, and transfers authority only to a matching durable internal journal. Recovery never adopts pre-existing roots or removes unknown children. Interrupted pre-journal infrastructure that is not an exact empty root remains recovery-required rather than being guessed away.

Tests cover centralized authorization and exit mapping, real disposable filesystem composition with an injected public-SDK-shaped boundary, anchored bootstrap crash injection, and packed/unpacked prerequisite-failure and usage goldens. A complete packed live-daemon outcome matrix remains release evidence, not a claim made by mocked transport tests.
