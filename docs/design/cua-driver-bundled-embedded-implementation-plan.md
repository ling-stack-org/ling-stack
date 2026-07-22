# Bundled Embedded Cua Driver Implementation Plan

## Status

Implementation in progress.

Current implementation baseline:

- Slice -1 signing feasibility, Slice 0 contracts/gates and Slice 1 source build are
  complete;
- the shared Slice 2 supervisor core and the durable Slice 3 activation/lease primitives
  are complete;
- the landed Slice 3 daemon-composition sub-slice wires the shared generation broker,
  startup reset, first-publish/replacement reconciliation, inert
  renewal, revoke/expiry invalidation, canonical plugin routes, generic MCP mutation fence,
  runner cancellation/result postcheck, reviewed pinned-tool filtering, retirement
  projection retry and Catalog requested/effective projection. A live lease plus exact
  host-platform authority is required before stale persisted capability can enter a run,
  private preview or Catalog effective state. The
  new composition is inert while the gate is off and leaves the external broker plus
  persisted external-provider behavior unchanged;
- the landed foundation closes daemon authority/instance/connection lease ingress and
  freezes the Darwin/Win32 platform-binding boundary;
- process-wide Desktop runtime composition has landed behind closed packaged-provider
  gates, including cached typed handshake authority, tuple rotation and ordered shutdown;
- the Desktop runtime now invokes idempotent coordinator availability enable, retries
  transient failures for the same authority tuple, and revokes the captured coordinator
  when daemon status or authority is lost during or after publication;
- the production composition boundary now has a strict fixed-path runtime trust-policy
  loader and one process-wide Darwin/Win32 platform owner. The owner is reused across
  authority rotation, Darwin permission changes rotate only the provider generation, and
  ordered shutdown disposes platform observers after coordinator cleanup. A transient
  monitor-start failure stays fail-closed and a later same-authority recovery replaces the
  unavailable coordinator binding;
- a separate authenticated Desktop availability report is implemented for non-ready state.
  Desktop instance/connection authority plus generation/sequence fencing prevents stale
  reports; non-ready reports can retire a lease and atomically project
  `permission_required`, `interactive_session_required` or `platform_unavailable`, while
  `ready` remains impossible without a live lease and activation CAS;
- the gate-off Darwin native adapter now supplies injected Mach-O/code-sign identity,
  direct-child lifecycle, host-owned TCC readiness and a retrying permission-change
  monitor, without enabling packaged runtime;
- the Win32 standard adapter now supplies policy-pinned identity, state-root ACL/reparse
  protection, direct-child lifecycle, active-child readiness and Electron recovery hints;
- opt-in pre-sign package staging and the Darwin/Win32 native no-replace atomic publisher
  core are implemented. The normal package commands now use a governed wrapper that leaves
  provider-disabled builds unchanged and, only with explicit package authority plus an
  absolute verified source-build root, stages one platform, generates runtime policy and
  capability documents, configures provider-aware signing/sealing/final verification, and
  cleans the temporary resource root. Per-output/architecture bindings prevent concurrent
  Electron Builder work from reusing another architecture's signing state. Package intent
  is stored in packaged `package.json` inside signed `app.asar`; Electron's ASAR-integrity
  fuse binds it to the host executable. Provider-bearing and external-only packages both
  enable `asar`, `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar`.
  Provider-bearing intent remains bundled-authoritative if loose capabilities/policy are
  absent, malformed or digest-mismatched, so runtime fails closed without consulting
  `PATH`, Homebrew or `/Applications/CuaDriver.app`. Production trust is fixed to the
  committed lock/resource root and real verifier. Each staging/cleanup session holds a
  native parent lease while Node runs its ordered workflow. The same holder performs all
  native inspect/security/verification/publish/removal RPCs, and production exposes no
  standalone native mutator. macOS flocks the already-open exact parent-directory vnode;
  it creates no `.ling` lock file or control entry that needs quota exclusion. Windows uses
  a parent-`FILE_ID`-derived `Global` mutex with the exact private DACL; `WAIT_ABANDONED` is
  observable recovery evidence only for an already-waiting contender, not durable state.
  RPC invalidation kills the holder and waits for actual exit. JavaScript
  `mkdir`/copy/write remain in Node rather than sharing the
  holder lifetime, so a crash may preserve payload residue and every next lease scans it
  under the normal bounded quota. Temp-root parent/root identities are captured after
  creation and bound into `secure-private`; cleanup can retry hardening, with native
  removal of an exact-owner, no-reparse empty root as the sole fallback. Secured roots
  receive/reverify macOS mode
  `0700` or the protected Windows DACL; package staging never executes the provider,
  while its outer verifier and standalone source-build probes use owned Unix process-group
  or Windows Job Object trees; retained failures have bounded, identity-bound native deep-
  delete/rollback cleanup rather than automatic path-recursive deletion;
- the review-only source-build promotion mechanism is implemented. Native macOS and
  Windows jobs upload candidates A/B first; dependent same-platform jobs download and
  independently reverify those artifacts, require identical bounded stable artifact maps,
  and upload a proposed platform lock plus receipt.
  Production cannot inject a verifier, checked-in lock/source-input bytes have independent
  anchors, an existing other-platform record is preserved, and UIAccess, mixed-lock,
  extra-file, toolchain, final-identity and self-opening-gate attempts fail closed. The
  output parent identity is captured before either verifier runs; proposal publication
  reuses the native parent lease, private-directory security and no-replace atomic publisher,
  so parent symlink/junction/reparse replacement fails closed. The proposal remains
  `MANUAL_REVIEW_REQUIRED`, does not mutate resources, and requires a
  second native A/B build after the reviewed lock/anchor commit;
- the final artifact fixture uses macOS `--mac dmg zip` with verified roles `outer-dmg` plus
  `outer-zip`, and Windows `--win nsis` with verified role `outer-nsis`; `.blockmap` sidecars
  never count as verified artifacts. The macOS run proves generated trust-policy/package
  capabilities, final-artifact provider membership and post-seal byte stability. The
  committed lock still enables no platform and contains no native executable, so promoted payloads, release
  signing, a real provider-bearing `Ling Stack Setup.exe`, final product states and
  evidence/handoff closure remain. The Win32 code and
  cross-platform tests have landed, but
  successful Windows hosted native-helper compilation, `Global` parent-mutex/private-DACL/
  `WAIT_ABANDONED`, owned-process runtime execution and real-machine validation remain
  open.
- Slice 7/T9 is complete at the renderer/contract boundary. One canonical Cua Driver row
  now consumes V2 provider states, keeps requested and effective enablement distinct, hides
  external installation guidance for bundled distributions, projects Windows standard
  coverage/limitations, and includes English/Chinese pure view-model plus Renderer E2E
  coverage. Packaged clean-host product smoke remains coupled to payload/signing/Setup
  closure in later slices.
- Slice 8/T10 is implemented at the local contract/handoff boundary. Candidate manifest v4,
  release policy v3, review/build attestation v2, internal/release verifiers, immutable cell
  reports, matrix finalizer and the two-phase candidate/handoff producer move as one atomic
  migration. The Full runner now accepts only one handoff manifest, pins tool minimums,
  verifies the installed private provider/seal/catalog plus vendor-native inventory before
  smoke, and rechecks the candidate uninstaller hash on cleanup before it can execute. The
  packaged smoke now performs a bridge-token-protected daemon `list_windows` call through
  the current bundled generation, binds the exact PID/HWND and lease digests to Desktop's
  child PID/nonce/path proof, observes the old child exit, and repeats with a new Desktop
  instance and child after restart. The installed verifier rejects extra members at the
  distribution root, platform root and two-file payload, and its real return value feeds a
  report-gate integration test with lock/seal/catalog/version/signature drift cases. Source
  and evidence references fail on parent-symlink escape, and the producer copies and rehashes
  every inventory member. The pipeline cannot self-promote.
  Cross-platform Node/schema tests are green locally; PowerShell parser/runtime and real
  test-signed Windows candidate evidence remain hosted/Windows-owner exit gates.

- A repository-scoped self-hosted native evidence lane is defined for accounts whose
  GitHub-hosted Actions allowance is exhausted. It is manual-dispatch only, binds the
  repository owner plus an exact caller-supplied commit, uses one custom runner label per
  platform with no generic self-hosted labels, and keeps the A/B upload/download promotion
  boundary. The current Mac profile pins Xcode 26.6 build 17F113 with SDK 26.5; the Windows
  profile pins the existing VS/MSVC/SDK tuple. This lane changes execution ownership, not
  the promotion verdict or feature-gate boundary. Each native source-build job also runs
  the production Desktop package wrapper against verified candidate A and uploads its
  final-artifact/signing trace with one-day retention. macOS covers arm64+x64 DMG+ZIP;
  Windows covers the x64 app, uninstaller and NSIS roles. macOS runs interactively in the logged-in
  Aqua session and rejects GitHub LaunchAgent service mode before source acquisition;
  Windows retains the reviewed service mode.

Both Darwin and Win32 packaged-provider production gates remain off. This status records
staged progress only and does not claim `bundled_embedded` runtime completion. The current
`external_local` path, including `/Applications/CuaDriver.app` when configured, must remain
available until the bundled path is wired and accepted.

This plan implements the approved macOS and Windows bundled-provider direction defined in:

- [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md)
- [Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)

The first Windows target is the initial bundled per-user/asInvoker `standard` integrity tier.
Windows real-machine acceptance is executed and signed off by the Windows team. Ling's
implementation scope includes the code, package, static and automated Windows-native
validation, evidence schemas, matrix finalizer, runner and handoff bundle; it does not
include self-attesting Windows internal or release verdict evidence.

Windows production signing credentials are not an implementation prerequisite. The
required implementation candidate is `test_signed_internal + internal`, uses real
Authenticode throughout the installed Ling tuple, and may close only
`INTERNAL_TEST_PASS` with `releaseReady=false`. A separately rebuilt
`production_signed + production` candidate is required later for public release.

## Delivery Outcome

After the required slices land:

- packaged macOS and Windows Desktop contain the locked `0.8.3 (Ling build 1)` provider;
- `Ling Stack Setup.exe` installs Windows `cua-driver.exe` only as a versioned private Ling
  resource, with no second product registration, PATH entry, Start-menu item, service,
  uninstaller or updater;
- normal users do not download or separately update Cua Driver;
- Desktop owns the provider process group, isolated state, MCP proxy and daemon lease;
- packaged mode never falls back to a random executable on `PATH`;
- macOS projects Ling-owned TCC readiness;
- Windows projects content-free interactive-session readiness and a ready
  `standard` integrity tier with explicit capability limitations;
- standalone/dev mode retains the existing explicit external-provider path;
- Windows colleagues receive a deterministic test-signed installed-candidate acceptance
  package and, later, a separately generated production-candidate package.

This plan does not claim full Windows elevated/UWP pixel-input parity. That requires the
conditional UIAccess slice described at the end.

## What Already Exists

The implementation should extend these shipped or already-tested boundaries instead of
creating parallel systems:

| Existing boundary | Reuse decision |
| --- | --- |
| Canonical `trusted-local:cua-driver` plugin, `mcp_cua_driver`, connect/enable rollback and external install guide | Keep ids and external behavior; add distribution-aware runtime and setup projection |
| Desktop authenticated daemon bridge and fixed workspace authority | Add provider lease publication to the existing authenticated bridge; do not add a second daemon |
| MCP broker, approvals, tool sync, audit and run snapshots | Keep all execution authority here; add the lease-generation client pool and activation fence |
| Computer Use descriptor/PiP coordinator and exact PID/HWND handoff | Reuse provider descriptors; bundled distribution must not create a second preview state machine |
| macOS release-evidence schemas and signed-candidate finalizers | Extend with provider lock/seal and embedded TCC identity rather than inventing a second evidence framework |
| Windows provider verifier, candidate manifest, PowerShell runner and acceptance report | Change input from separately installed upstream asset to bundled source-built candidate; reuse external reviewer/build-attestor promotion and trusted system verification tools, while replacing PID-only cleanup with retained-handle plus Rust Job Object ownership |
| Electron-builder macOS/NSIS packaging and bundled-resource assertions | Add versioned provider resources and platform signing order; keep one Ling release/rollback tuple |

## NOT In Scope

- Windows ARM64 and Linux provider support; neither is required for the first bundled
  release.
- Runtime provider download, public installer execution or an independent provider update
  channel.
- Full Windows UIAccess capability in the required slices; it remains Conditional Slice 9.
- Changing the whole Windows Desktop installer to per-machine solely for UIAccess.
- A renderer-to-provider API, a second daemon, a second Computer Use state machine or a
  bypass around approvals/audit.
- Importing or mutating external Cua Driver config/state.
- Our team generating or approving Windows real-machine PASS evidence; Windows colleagues
  own that acceptance.

## End-To-End Data Flow

```text
User Enable
   |
   v
daemon persists requestedEnabled + revision
   |
   v
Desktop validates lock + tier-appropriate final seal/catalog/signature policy
   |
   +-- invalid ------------------------------> corrupt / incompatible, tools hidden
   |
   v
Desktop publishes generation-scoped lease
   |
   v
daemon acquires one pooled MCP client
   |
   v
Desktop lazily starts platform provider process group
   |
   v
initialize -> health -> platform readiness -> list tools -> approval overlay
   |
   +-- macOS grant missing ------------------> permission_required, intent retained
   +-- Windows session invalid --------------> interactive_session_required, intent retained
   +-- Windows UIA/WGC unavailable ----------> platform_unavailable, intent retained
   +-- Windows standard tier ----------------> ready + standard coverage + limitations
   +-- stale generation / disable -----------x discard every result, no store write
   |
   v
single activation CAS commits tools + effective enabled flags
   |
   v
normal calls: daemon policy -> pooled client -> Desktop proxy -> bundled provider
```

Files that should carry short inline versions of this diagram during implementation:

- daemon activation service: requested versus effective state and final CAS;
- daemon lease-client pool: instance epoch/generation ownership and late-result fence;
- Desktop provider coordinator: lease/process-group lifecycle;
- Windows adapter: interactive-session and optional UIAccess tier decision.

## Non-Negotiable Boundaries

- Keep product ids `trusted-local:cua-driver` and `mcp_cua_driver` stable.
- Keep requested enablement separate from effective enablement.
- Persisted plugin, contribution and MCP `enabled` flags remain false until one final
  generation-fenced activation commit.
- One Desktop lease generation owns one initialized daemon MCP client and one provider
  stdio session.
- Every asynchronous result is fenced by Desktop instance id/epoch, bridge connection id,
  daemon authority epoch, lease generation, lock/seal/catalog digests, activation epoch
  and requested-enable revision.
- Request enable, not-ready status, retry, effective enable and disable use one
  `commitCuaDriverActivation()` Store API and one `BEGIN IMMEDIATE` transaction for
  tools/status plus plugin/contribution/MCP effective flags.
- Windows normal activation is content-free. Real WGC/UIA/input probes use a test-owned
  target only in Windows acceptance.
- The Windows standard user package contains no `cua-driver-uia.exe`.
- `bundled_embedded`, `standard`/`uiaccess`, and Windows signing tier are independent
  dimensions. The only allowed signing pairs are `unsigned_dev + development`,
  `test_signed_internal + internal`, and `production_signed + production`.
- Candidate-declared tier is evidence only. The runtime verifier derives the installed
  subset from the Ling main PE, private provider and signed-tier catalog; it cannot promote
  a candidate or attest to installer/uninstaller bytes. The promotion verifier separately
  derives the lowest effective tier from the full governed installer/installed-main-PE/
  uninstaller/provider/catalog tuple. Internal/production tuples fail on mixed/double
  signatures, test-root-in-production, an unsigned governed member or an unexpected
  executable in the private provider payload. Development is valid only when every expected
  governed PE derives as `unsigned_dev`, the catalog is absent and the compile-time dev gate
  is active.
- Electron/Chromium vendor DLLs outside the private provider payload retain the existing
  Electron Builder signing policy and appear in a separate normalized path/hash/
  observed-signer inventory. This slice does not silently enable `signDlls`; any new
  Ling-owned executable must be explicitly added to the governed tuple.
- Ling Setup never carries or installs an internal test root or private key. The external
  harness provisions trust only into disposable CI or isolated managed QA machines.
  `ephemeral-ci` trust is removed after each job or VM revert; `managed-internal` trust may
  persist only in a dedicated QA image/VM under external PKI lifecycle, never in a general
  developer image, product or production chain.
- Windows readiness comes from the active MCP child and must match its retained PID,
  memory-only nonce, generation, session, Medium integrity and Job Object boundary.
  One-shot diagnostics are build/preflight evidence only.
- Windows managed production mode never calls `taskkill /T`; graceful timeout terminates
  only the retained ChildProcess handle and Rust `KILL_ON_JOB_CLOSE` owns descendants.
- Lock, disconnect, fast-user-switch, session mismatch or input-desktop change revokes the
  call gate, lease, tools and effective flags. Unlock starts a fresh child/generation and
  never reuses prior readiness.
- Do not fetch provider assets or execute provider installers at runtime.
- Do not expose proxy secrets, screenshots, AX trees, typed text or raw MCP payloads in
  ordinary logs.
- Preserve the canonical dirty worktree; implementation slices should use clean shipping
  worktrees and merge independently.

## Recommended Slice Sequence

### Slice -1 — Electron Builder Provider-Signing Feasibility Gate

Goal: prove the actual `electron-builder@26.15.3` hook and signing order on both package
platforms before provider seals or catalogs depend on it.

Changes:

- add instrumented macOS and Windows package fixtures using disposable CI signing
  identities;
- freeze the Windows signing ladder, allowed tier/channel pairs and verdict ceilings before
  hook code is accepted;
- exercise `afterPack`, the platform signing hook, `afterSign`, and
  `artifactBuildCompleted`;
- in `afterPack`, sign the staged macOS provider and derive its seal from final Mach-O
  identity; on Windows sign the staged PE, derive `provider-seal.json`, generate the
  catalog over the exact payload, and sign the catalog;
- make the platform signing hook skip the canonical sealed provider path only after its
  expected digest matches, while signing/delegating outer Ling app, uninstaller,
  installer and other eligible executables normally;
- reject any second provider signing operation or provider mutation after seal generation;
- in `afterSign` and `artifactBuildCompleted`, rehash and reverify the unpacked provider,
  seal, platform identity/catalog membership and provider bytes extracted from final
  DMG/ZIP/NSIS artifacts;
- retain the ordered hook trace and every digest transition as CI evidence.
- run the real provider-bearing `package:mac` / `package:win` wrappers from verified
  source-build output rather than invoking Electron Builder directly; macOS must exercise
  both arm64 and x64 in the same governed wrapper invocation;
- bind every provider, seal, lock, catalog and package-authority document to a regular,
  single-link path beneath the reopened app root, and bind every test signer identity to
  the selected `ephemeral-ci` or `managed-internal` authority kind;
- prove Setup contains no root certificate/PFX, trust is provisioned only by the harness,
  ephemeral trust is removed/reverted, managed-internal trust remains isolated under its
  external lifecycle, and production policy rejects every test fingerprint;
- prove production signing starts from the same approved clean pre-sign payload rather
  than overwriting, appending to, or promoting test-signed bytes.

Exit criteria:

- the provider digest at seal generation, `afterSign`, unpacked verification and final
  artifact verification is identical;
- outer macOS app/DMG/ZIP and Windows app/uninstaller/NSIS remain correctly test-signed;
- the Windows Builder trace contains exactly `outer-app`, `outer-uninstaller` and
  `outer-nsis`, while each macOS architecture contains exactly one outer app plus its
  DMG/ZIP final-artifact roles;
- installer, app, uninstaller, provider and catalog have one derived test tier; mixed,
  unsigned, double-signed, mutated or mismatched-channel fixtures fail closed;
- hosted macOS/Windows jobs fail if Electron Builder changes hook order or mutates the
  provider after sealing, and fail if a governed trust file becomes a symlink/reparse
  point/hard link or a signer returns the wrong test-authority kind.

Estimated engineering time: 2–3 days.

### Slice 0 — Cross-Platform Contracts And Feature Flags

Goal: create the shared vocabulary without changing the active external runtime.

Changes:

- add `bundled_embedded` distribution and platform readiness contracts;
- retain `kind="local_binary"` and the legacy setup-state projection; add schema V2
  `providerState` values `included`, `permission_required`,
  `interactive_session_required`, `platform_unavailable`, `ready`, `incompatible`,
  `corrupt` and `desktop_unavailable`;
- add `platform`, `integrityCoverage`, `limitations[]`, provider revision,
  seal digest and optional Windows catalog digest fields;
- add `signingTier`, `distributionChannel`, `promotionStatus` and verdict-cap contracts:
  `INTERNAL_TEST_PASS` always has `releaseReady=false`, while only `RELEASE_PASS` may set
  it true;
- add a packaged-provider feature gate defaulting off until each platform package passes;
- version the Desktop lease and provider-lock schemas.

Likely files:

- `packages/contracts/src/plugins.ts`
- `packages/api-client/src/plugins.ts`
- `packages/daemon/src/features/plugins/*`
- `apps/desktop/main/*`
- contract, API client and daemon tests

Exit criteria:

- old clients continue to receive known `kind`/legacy-state values, while new clients use
  `providerState`;
- external provider behavior is unchanged while the feature gate is off;
- no second Cua Driver row or MCP server is created.

Estimated engineering time: 1–2 days.

### Slice 1 — Reproducible Provider Source Build

Goal: produce deterministic source-built provider inputs for macOS and Windows.

Changes:

- commit the cross-platform provider lock and exact upstream source provenance;
- add the locked `ling-managed-embedded-v1` patch series for state isolation, no-content
  active-child Windows readiness, host-death/stdio-EOF closure, Rust
  `KILL_ON_JOB_CLOSE` lifetime ownership, WTS/input-desktop invalidation and structured
  UIAccess capability errors;
- lock Rust/Cargo, Xcode/macOS SDK and MSVC/Windows SDK inputs;
- build macOS universal `cua-driver` and Windows x64 `cua-driver.exe` for shipped
  packages;
- emit the Windows clean pre-sign payload digest separately from every tier-specific final
  artifact digest so test and production signatures never share a candidate identity;
- build `cua-driver-uia.exe` only as a non-shipping CI audit output so upstream drift is
  visible; do not copy, sign or seal it into Desktop resources;
- compare upstream reference assets without copying them into the package;
- verify version, MCP response protocol `2025-06-18`, health schema, platform tool digest,
  PE manifests, architectures and state isolation;
- generate license, third-party notice and SBOM material.

New build artifacts:

```text
apps/desktop/resources/providers/cua-driver/0.8.3-ling.1/
  provider-lock.json
  LICENSE.md
  THIRD_PARTY_NOTICES.md
  darwin/cua-driver
  win32-x64/payload/cua-driver.exe
```

Exit criteria:

- repeated same-platform builds have stable pre-sign digests;
- embedded config writes only to `CUA_DRIVER_STATE_HOME`;
- one-shot `diagnostics --managed-readiness --json` remains preflight evidence, while the
  active embedded child answers `ling/managed_readiness` with the locked no-content
  PID/nonce/session/integrity/Job Object schema;
- main child and nested worker fixtures exit on stdin EOF, exact host-PID death and
  retained-handle termination with zero residue;
- macOS external home and Windows external profile state remain byte-identical;
- telemetry, startup update checks and updater tools are disabled in managed mode.

Estimated engineering time: 3–5 days. Signing credentials are not required for the
pre-sign build, but exact toolchain values are.

### Slice 2 — Shared Desktop Provider Supervisor

Goal: introduce the platform-neutral process, proxy and lease core.

Modules:

```text
apps/desktop/main/cua-driver/
  artifact-lock.ts
  provider-seal.ts
  windows-integrity.ts
  resource-path.ts
  state-root.ts
  provider-host.ts
  mcp-proxy.ts
  lease-publisher.ts
  readiness-controller.ts
  coordinator.ts
  telemetry.ts
```

Changes:

- validate the lock and platform seal before process start;
- on Windows, enforce the compile-time distribution channel and derive actual artifact
  tier before process start. Development may accept explicit `NotSigned` without a
  catalog; internal accepts only its policy-pinned test signer/catalog; production accepts
  only its production signer/catalog. Candidate-manifest JSON is not a runtime integrity
  anchor;
- resolve only the versioned resource path outside `app.asar`;
- create the isolated platform state root;
- own one lazy provider stdio session per lease generation;
- expose one authenticated loopback Streamable HTTP session;
- publish, renew, rotate and revoke an in-memory Desktop lease using daemon-issued
  `desktopInstanceEpoch` and `bridgeConnectionId`; generation is monotonic only inside
  one instance epoch;
- stop the provider group on disable, Desktop quit, authority-epoch change or unexpected
  MCP session loss;
- add Rust host-PID/stdio-EOF lifetime closure, a private non-inheritable
  `KILL_ON_JOB_CLOSE` Job Object with no breakaway descendants, retained-handle shutdown,
  bounded crash retry and residue checks;
- generate a random memory-only child nonce per spawn and serialize
  `ling/managed_readiness` with normal stdio requests;
- consume nonce/generation/sequence-bound WTS/input-desktop invalidation, close the proxy
  call gate immediately, and coordinate fresh-generation recovery after unlock;
- introduce no Node N-API addon and no PID-only process-tree kill.

Lifecycle behavior:

- Desktop/window open alone does not start the provider;
- explicit enable records requested intent;
- the first authenticated daemon session lazily starts the provider;
- hiding or closing a BrowserWindow does not stop an enabled provider while Desktop runs;
- disable, Desktop quit, incompatible lease or repeated crash stops it;
- no event selects an external executable automatically.

Exit criteria:

- one generation produces exactly one initialize and one child session;
- wrong token/origin/workspace/generation fails closed;
- daemon restart rotates the generation and cannot reuse the old stdio child;
- a new Desktop instance with generation `1` fences an older instance with a larger
  generation;
- graceful quit, unexpected child stdout EOF and hard Desktop kill leave zero
  child/grandchild/proxy/listener/pipe residue;
- ready -> locked/disconnected -> revoked -> fresh-generation recovery cannot expose the
  old client, tools, child or late readiness notification.

Estimated engineering time: 4–6 days.

### Slice 3 — Daemon Pool And Activation Transaction

Goal: keep daemon policy authoritative without exposing tools before readiness.

Current status: daemon-composition sub-slice implemented.

- the process-wide composition owner creates one shared generation broker and client pool;
- startup reset completes before route binding and fails daemon start closed;
- first publish and replacement hide old effective state then reconcile retained intent;
  renewal changes only the deadline and reuses the same generation HMAC/session/client;
- a durable projection exception or CAS miss clears the accepted lease, closes the pool,
  returns HTTP 503 for publication, retries the post-clear fence and prevents a
  same-generation renewal from bypassing that fence;
- revoke, expiry, handshake replacement and shutdown fence authority before bounded pool
  drain/abort/close;
- canonical plugin enable/check/disable use the activation service, while hidden compatibility
  action routes and generic MCP status/tool-sync routes cannot bypass the atomic transaction;
- normal runner tool calls forward cancellation and recheck generation, persisted
  monotonic server/tool authority revisions and bundled requested revision/activation
  epoch after the result, including same-millisecond disable/re-enable ABA;
- Computer Use run/private-preview eligibility recognizes the canonical activation row plus
  exact logical placeholder without requiring a legacy package-cache record, while gate-off
  package resolution retains its existing behavior;
- Catalog setup and actions separately project requested and effective enablement, and
  fail closed to waiting-for-Desktop without exact host-platform authority plus a live
  lease;
- gate-off `external_local` broker, routes and persisted command behavior remain unchanged.

The Slice 3 exact non-ready projection is implemented. Desktop publishes a distinct
authenticated availability record that cannot report `ready`; a current/newer non-ready
generation retires executable lease authority, while generation/sequence fencing rejects
late reports. Daemon activation then atomically persists `permission_required`,
`interactive_session_required` or `platform_unavailable` with tools and every effective
flag disabled. Final renderer copy/E2E remains in Product States rather than this transport
slice.

Focused validation covers startup reset failure, first publish, inert renewal,
replacement/revoke/expiry races, bounded call cancellation, shutdown cleanup, canonical
workspace/identity routing, generic MCP fencing, raw-fallback exclusion and late-result
rejection. It does not close Desktop platform-owner, final signing/Setup, Windows hosted or
Windows real-machine gates.

Changes:

- add the in-memory Desktop lease registry;
- resolve bundled runtime through the lease rather than the persisted command;
- add one pooled MCP client keyed by logical id, Desktop instance, authority epoch,
  instance epoch, bridge connection id, generation, endpoint and lock/seal/catalog
  digests;
- replace per-check client creation for bundled mode;
- add the durable `cua_driver_activation_state` migration with requested intent,
  requested revision and activation epoch;
- before daemon routes become ready, atomically advance every bundled activation epoch,
  empty tools, project `desktop_unavailable` or `included` from retained intent, and clear
  all effective flags;
- implement the single `commitCuaDriverActivation()` Store API using
  `BEGIN IMMEDIATE`;
- probe through an activation-local server view while all persisted effective flags stay
  false;
- run initialize, filtered health, platform readiness and tool sync;
- consume active-child readiness only through the current generation's pooled session;
- atomically commit tools, status and plugin/contribution/server enabled flags only after
  the full token compare-and-swap;
- route request-enable, not-ready, retry and disable through the same Store fence;
- return `202 Accepted` with the committed waiting projection when request-enable wins but
  no current Desktop lease exists; keep `409` for stale/racing attempts that did not win;
- discard every late result from an older generation or user intent.

Renderer completion criteria for this slice:

- `bundled_embedded` `external_*` projections normalize to invalid and never invoke the
  legacy external auto-connect path;
- enable preserves the complete V2 setup projection while moving through
  `included -> desktop_unavailable/permission_required -> ready`;
- closing the detail drawer has no lifecycle effect, while Disable clears requested intent
  and returns to `included`;
- `providerVersion=0.8.3` plus `providerDistributionRevision=ling.1` displays as
  `0.8.3 (Ling build 1)`;
- daemon composition, pure view-model and renderer E2E tests cover the above transitions.

Required race tests:

- generation G health finishes after G+1 is ready;
- disable races with list-tools and tool sync;
- daemon restart races with activation;
- daemon API snapshot/tool call arrives after process start but before Desktop bridge
  reconnect; old tools and effective flags remain unavailable while intent is retained;
- lock/unlock and fast-user-switch race with activation and a running tool call;
- generation G readiness/notification finishes after G+1 is ready;
- duplicate enable requests remain idempotent;
- stale health cannot overwrite current status or catalog;
- two SQLite connections race activation versus disable and only one CAS succeeds;
- inject a crash after tools, status, plugin flag, contribution flag, MCP flag and fence
  writes; every case rolls back completely.

Exit criteria:

- no run snapshot or tool catalog sees activation-local tools;
- raw HTTP tool-list fallback is unreachable in bundled mode;
- external mode retains current behavior.

Estimated engineering time: 3–5 days.

### Slice 4 — macOS Adapter And Signed Package Contract

Goal: implement the already-approved macOS embedded path.

Changes:

- direct `cua-driver mcp --embedded --host-bundle-id com.lingstack.desktop` spawn with
  matching locked environment values;
- host-owned Accessibility and Screen Recording controller;
- post-grant child restart and live capturability check;
- Mach-O architecture/minimum-version checks;
- nested Developer ID signing, exact entitlements, hardened runtime and post-sign seal;
- outer app/ZIP/DMG signing, notarization and Gatekeeper evidence;
- macOS 13/14/15/26 evidence-schema/finalizer updates.

Exit criteria:

- packaged app ignores `PATH` and external `CuaDriver.app`;
- only Ling appears in the TCC flow;
- denied/granted/revoked/re-granted transitions fence readiness correctly;
- current signed-matrix requirements remain release gates, not local-development claims.

Estimated engineering time: 3–5 days excluding access to signing/notary credentials and
external clean-host matrix execution.

### Slice 5 — Windows Standard Adapter

Goal: bundle Windows without changing the existing Ling per-user/asInvoker installer contract.

Changes:

- validate the final tier-appropriate `cua-driver.exe`, seal/catalog contract and exact
  package membership; internal/production signed tiers require the catalog, development
  explicitly omits it, and the standard package always contains no `cua-driver-uia.exe`;
- directly spawn `cua-driver.exe mcp --embedded --host-bundle-id com.lingstack.desktop`
  in the Desktop interactive session with matching locked environment values;
- keep one-shot diagnostics as preflight evidence only; after initialize call
  `ling/managed_readiness` over the active child session and verify retained PID,
  memory-only nonce, current generation, matching non-zero host/provider sessions,
  Medium integrity for both processes, Job Object flags, default/unlocked input desktop,
  UIA runtime, D3D11 and WGC API;
- own the retained ChildProcess handle, attempt bounded graceful shutdown, then terminate
  only through that handle; Rust `KILL_ON_JOB_CLOSE` removes descendants;
- consume WTS/input-desktop invalidation, atomically project
  `interactive_session_required`, stop the old generation and start a fresh probe only
  after a valid unlock/session-active hint;
- verify exact provider path, PE x64 identity, seal and catalog;
- project `providerState=ready`, `integrityCoverage=standard` and limitations
  `elevated_pixel_input` / `uwp_send_input`;
- reject UIAccess-only elevated/UWP pixel/SendInput actions with
  structured `cua_windows_uiaccess_required` details produced by target/action
  classification, never error-text matching;
- pre-bind incompatible fake servers on `\\.\pipe\cua-driver` and
  `\\.\pipe\cua-driver-uia`, put an old external provider first on `PATH`, and prove
  bundled initialize/list/call use the exact child stdio with zero fake-pipe connections;
- prove the child exits after hard Desktop kill through host-PID/stdio EOF and leaves no
  residue, including a provider-created grandchild.

Exit criteria on cross-platform CI:

- TypeScript, lock/seal/catalog/schema, PE parser and package-layout tests pass;
- Session 0, wrong session, locked desktop and bad no-content readiness fixtures fail
  closed;
- process-group, Job Object, nonce/generation, lock/unlock and error-mapping logic has
  deterministic unit tests;
- hosted or managed automated Windows CI builds the Rust target, uses a disposable test
  certificate for PE/catalog verification, proves embedded stdio ignores fake global
  pipes/PATH, exercises hard-kill plus grandchild cleanup, and runs test-owned Win32 and
  installable/removable MSIX/UWP targets. Windows colleagues are not the first native-code
  testers.
- the test certificate is externally provisioned and absent from Setup. Ephemeral CI trust
  is removed/reverted after the run; managed-internal trust is accepted only in its
  dedicated isolated QA pool; the production policy rejects both.

Real test-signed build/DPI/display/accessibility functional acceptance and the later
production-only Publisher/SmartScreen/WDAC acceptance remain owned by the Windows team in
Slice 8; the automated Windows-native gates above are owned by us.

Estimated engineering time: 4–6 days.

### Slice 6 — Packaging Staging, Migration And Rollback

Goal: stage the versioned provider and make bundled mode the packaged default without
coupling migration logic to signing credentials.

Changes:

- stage only the enabled platform resources through Electron packaging outside
  `app.asar`;
- make `Ling Stack Setup.exe` the only Windows installer: it extracts the helper under the
  versioned Ling `resources/providers/.../payload/` tree and creates no Cua Driver product
  registration, PATH entry, Start-menu entry, service, uninstaller or updater;
- update package assertions to reject missing, extra, symlinked, reparse-point or
  wrong-architecture provider files and to reject `cua-driver-uia.exe` in standard mode;
- keep candidate manifests as release provenance, not runtime integrity anchors;
- migrate packaged macOS and Windows to `bundled_embedded` by default behind independent
  platform gates;
- retain saved external commands for audit but do not silently prefer them;
- make explicit developer override reversible;
- keep provider version upgrade/rollback tied to the Ling release tuple.

Exit criteria:

- clean packaged machines need no provider download;
- installed smoke proves the actual Electron child path is the final private Setup payload,
  not a runner-temp or external provider;
- a conflicting external version does not affect packaged mode;
- upgrade and rollback restore the exact locked tuple;
- no runtime symlink/junction or independent provider updater is used.

Current package-staging sub-slice status:

- implemented: opt-in pre-sign allowlist staging outside `app.asar`, bounded source
  snapshots, independent committed lock anchor, real source-build verifier, parent-to-child
  expected provider digest fence, and receipt binding for all staged members. Package
  staging never executes the candidate; version evidence must match attestation, promotion
  and the committed lock. The outer verifier and standalone source-build version probe use
  owned detached/nested PGID fencing on Unix and native `KILL_ON_JOB_CLOSE` Job Object
  ownership on Windows;
- implemented: production `stageCuaDriverProvider()` and
  `verifyCuaDriverSourceInput()` reject caller-provided trust roots/verifiers. Fixture trust
  is closure-bound to `createCuaDriverPackageStagerForTest()` only;
- implemented: the fixed native helper builds/preflights before temp payload creation,
  feature-probes execution through a held Darwin vnode. Standalone calls recheck identity
  afterward, and held RPC sessions recheck it when the lease closes on both platforms; its
  build-only, payload-free temp root is retained for OS reclamation
  rather than deleted through a path, and disappears once Slice 6A supplies the signed/
  prebuilt helper;
- implemented: production staging and explicit cleanup serialize their ordered workflows
  under one cross-process native lease while the holder is healthy. The holder is also a
  bounded synchronous native RPC actor and performs every native inspect, security,
  verification, publish and removal operation in the same process that owns the lock;
  production exposes no standalone native mutator and mutating APIs fail closed without
  the module-private lease capability. macOS opens the exact no-link parent directory and
  applies `flock` directly to that vnode without creating a lock file or quota exclusion;
  Windows derives a `Global` named mutex from the parent `FILE_ID` and requires the exact
  current-user/SYSTEM/Administrators protected DACL. A contender already waiting when the
  owner dies may report `WAIT_ABANDONED`; a later acquisition is allowed to report false
  because this flag is not durable recovery state. Clean idle EOF or explicit release
  drains work and unlocks normally; caller death during an RPC leaves the holder locked
  until that bounded operation completes, and holder death stops the in-process native
  mutation with the lock-owning process. Timeout/protocol invalidation kills the holder and
  waits for actual exit before discarding its capability. JavaScript `mkdir`, copy and write
  work remains in Node and is not covered by the same-process lifetime guarantee; payload
  residue is always inspected and quota-counted by the next lease regardless of the
  abandonment flag;
- implemented: publication reopens the canonical parent path without links immediately
  before commit and after observing the rename result, and requires it to match the held
  vnode/`FILE_ID`. Replacement before commit is `not_committed`; replacement after a
  completed rename is `ambiguous`, never `committed`, and leaves the replacement parent
  untouched while the published identity remains under the displaced held parent;
- implemented: immediately after temp `mkdir`, staging captures the native parent/root
  identities, requires the parent to match the lease, then binds both expectations into
  `secure-private`. It applies and reverifies macOS current-EUID mode `0700` or the Windows
  protected current-user/SYSTEM/Administrators DACL, and publishes with parent/source
  identity-bound native no-replace semantics. Native commit confirmation is recorded inside
  the guarded callback, so inner or outer post-check lease loss reports an ambiguous final-root
  `published=true` failure without temporary cleanup authority;
- implemented: with a healthy lease, ordinary retained pre-commit failures are observed and
  expose path, native identity and bounded inventory metadata. Lease loss after identity
  capture may return only path plus identity; loss after `mkdir` but before capture may
  return only path. Streaming scans enforce fixed parent-entry, residue-count,
  aggregate-entry and total-byte limits. Hard-exit and incomplete-receipt recovery use the
  lease-bound, read-only `listCuaDriverStagingResidues()`/
  `--list-residue --output-root` path to recover exact identities and bounded inventory
  before cleanup. `cleanupCuaDriverStagingResidue()` and the matching
  `--cleanup-residue --output-root --expected-residue-identity` CLI quarantine the exact
  identity and reverify private security/inventory. Cleanup retries identity-bound hardening
  for failures before `secure-private`; if that still fails, only the exact
  current-user-owned, no-reparse, empty root can use native `remove-unsecured-empty`.
  Native handle-relative final removal completes a full bounded deep-tree preflight before
  deleting any member. Safe rollback
  restores a failed quarantine; ambiguous retryable quarantine receipts remain in the
  residue scan and consume the same quota; mismatches remain;
- implemented: the normal package commands route through a governed wrapper. With no package
  authority they retain the existing external-only configuration. Explicit authority plus
  an absolute verified source-build root invokes production staging, generates one-platform
  capability/runtime-policy files, copies one private resource root outside `app.asar`, and
  runs provider-aware signing/seal/final verification. State is isolated per packager output
  and architecture. The final fixture invokes macOS `--mac dmg zip` and Windows `--win nsis`,
  requires `outer-dmg` plus `outer-zip` or `outer-nsis` respectively, excludes `.blockmap`
  sidecars from verified roles, and the macOS run proves the generated documents/provider
  plus post-seal digest stability in final artifacts;
- implemented outside this staging sub-slice: deterministic review-only promotion proposal
  generation after a native artifact upload/download round trip, plus separate proposal
  artifact upload;
- not implemented by this sub-slice: committing promotion evidence for either platform,
  real native payload inclusion, release signer authority, a provider-bearing Windows Setup,
  migration/rollback activation and accepted production runtime binding;
- not validated: the Win32 implementation has no successful Windows hosted native-helper
  compile, `Global` parent-mutex/private-DACL/`WAIT_ABANDONED`, or owned-process/Job Object
  runtime result in this slice, and Windows real-machine acceptance remains assigned to the
  handoff owner.

### Slice 6A — Electron Builder Signing-Ladder Closure

Goal: implement the signing order and three-tier Windows ladder proven by Slice -1 without
allowing post-seal mutation or test-to-production promotion.

Dependencies: Slice -1, Slice 1, the active platform adapter and Slice 6 staging.

Changes:

- install platform-aware Electron Builder hooks and process only the currently enabled
  package platform;
- on macOS, sign the nested provider before generating its seal, then allow Electron
  Builder to sign the outer app;
- on Windows, enforce one allowed tier/channel pair. `unsigned_dev` writes an explicit
  `NotSigned` final seal and omits the catalog; signed tiers sign
  `payload/cua-driver.exe`, generate the seal from the final PE, generate/sign the outer
  `provider-integrity.cat`, then prevent the generic signer from touching the sealed
  provider;
- make the custom signing hook fail on any unexpected member under the provider
  payload instead of silently signing or ignoring it;
- reverify the provider tuple after outer-app signing and after each DMG/ZIP/NSIS artifact
  completes;
- use identical hook code with disposable CI certificates and release-policy credentials;
  only credential selection may differ;
- bind candidate evidence to `preSignPayloadSha256` plus tier-specific final hashes;
  production rebuilds from approved clean pre-sign bytes and rejects reused, overwritten
  or appended test-signed artifacts;
- verify the Windows catalog at runtime through the absolute in-box Windows PowerShell
  path with `-NoProfile -NonInteractive`, fixed UTF-8 locale-independent JSON and strict
  stdout/stderr byte limits. Missing/blocked PowerShell, WDAC/AppLocker denial, absent
  catalog cmdlets, oversized/malformed output or no verdict maps to
  `cua_windows_integrity_verifier_unavailable` / `platform_unavailable`; a successful
  verifier that reports invalid signature/signer/member/hash maps to `corrupt`;
- retain a future direct WinVerifyTrust binding as an implementation swap that preserves
  the same state/error contract.

Windows signing contract:

- main provider PE, catalog, Ling app, uninstaller and NSIS use one channel-policy-pinned
  effective tier; catalog signer matches the installed Ling app signer policy;
- candidate evidence binds pre-sign and tier-specific final artifact hashes; seal fields
  include final main-PE SHA, manifest digest, derived tier/channel, actual Authenticode
  subject, certificate SHA and timestamp policy/status without creating a seal/catalog
  self-reference;
- the catalog sits outside and covers only `payload/cua-driver.exe` plus
  `payload/provider-seal.json`; the covered seal anchors the root provider-lock digest;
- the unsigned upstream zip remains reference evidence only.

Exit criteria:

- no shipped provider byte changes after its seal is generated;
- final artifacts contain the exact verified tuple from the unpacked app;
- test-certificate signing/catalog/package tests pass on automated Windows CI;
- a final test-signed Setup installed on the Windows QA target is a genuine bundled
  candidate and can close implementation with `INTERNAL_TEST_PASS` / `releaseReady=false`;
- platform packaging gates remain independently switchable.

Estimated engineering time: Slice 6 plus Slice 6A remains 4–7 days, with release-signing
service availability required only for later `production_signed` promotion.

### Slice 7 — Plugin Manager And Product States

Goal: expose one honest cross-platform Cua Driver surface.

Changes:

- show one canonical Cua Driver row;
- packaged Desktop hides the external installation drawer;
- macOS shows included/permission/ready/corrupt/incompatible states;
- Windows shows included/interactive-session/platform-unavailable/ready/corrupt/
  incompatible states, with standard coverage and limitations as detail/badges;
- standalone/dev external mode keeps missing/detected/connected/ready/install-guide;
- enabling never grants permissions, creates teammate bindings or bypasses approvals;
- add Chinese/English copy and dark/reduced-motion coverage.

Exit criteria:

- no duplicate row, MCP server or contribution;
- install guidance appears only for `external_local + external_missing`;
- window hide/close does not imply provider disable;
- disable and Desktop quit are visibly and behaviorally distinct.

Estimated engineering time: 2–4 days.

### Slice 8 — CI, Evidence Schemas And Windows Handoff

Goal: finish our responsibility and hand a runnable acceptance package to Windows owners.

Changes:

- extend provider verifier from upstream-asset-only to source-build lock, final main-PE
  seal and tier-aware signed-catalog validation;
- atomically migrate candidate manifest v4, release policy v3, review/build attestation v2
  and release verification v2 together with JS, PowerShell, fixtures and the test-sign CI
  lane; do not land a schema-only partial migration;
- add `windows-internal-verification.schema.json` v1 and
  `verify-windows-internal-attestations.mjs`; fix kind/tier/channel/eligibility/verdict/
  release-ready/blocker to the internal constants, make the production verifier reject
  that kind, and update the strict expected schema filename set in the same change;
- make candidate v4 record tier/channel, production eligibility, test-authority kind,
  clean pre-sign digest, packaged provider path/seal/catalog, audit-only UIAccess hash,
  tier-specific final artifact hashes and observed actual Authenticode signer/timestamp
  fields under `tierGovernedArtifacts`, plus a separate normalized
  `vendorNativeInventory` path/hash/observed-signer inventory. Keep TryCua source/archive
  fields as provenance, not signer identity;
- require `productionEligible=false` for unsigned/dev and test/internal candidates; only
  production/production may set it true, and true means review-eligible rather than
  release-ready;
- version the release policy with explicit `requiredAcceptanceCells`; keep
  `supportedWindowsBuilds` as an allowlist, not proof that every build ran;
- produce one exclusive-create immutable report per exact Windows build/architecture/
  display-topology/DPI cell; a rerun gets a new `runId` and file;
- add `finalize-windows-signed-acceptance.mjs`, require every policy cell exactly once,
  reject missing/extra/duplicate/cross-cell evidence, and rehash every report/attachment;
- add a common `handoff-index.json` containing candidate/policy/artifact anchors and exact
  required cell definitions; require every cell report to bind the same index digest plus
  its own unique cell-manifest digest;
- require all cells to bind the same candidate commit, app/installer hashes, provider
  seal, catalog, policy, handoff-index digest and harness closure;
- extend `run-windows-acceptance.ps1` for bundled active-child identity, standard
  limitations, lock/revoke/unlock recovery, test-owned WGC/UIA/input targets, pre-bound
  global-pipe conflicts, hard Desktop kill, Job Object cleanup and residue evidence;
- produce a handoff root with the common index plus one manifest per cell containing
  `handoffIndexSha256`, required expected values, paths, hashes, evidence inputs, output
  and tool versions;
- update static schema tests plus automated Windows Rust/build/package/catalog/install/
  Win32/MSIX gates;
- keep cell and matrix outputs non-self-promoting. The profile-aware external verifier may
  emit `INTERNAL_TEST_PASS` with `releaseReady=false` for the exact internal tuple; only
  the exact production tuple with every production gate may emit `RELEASE_PASS` and
  `releaseReady=true`.

Full mode accepts one operator-supplied input:

```powershell
pwsh -File apps/desktop/tests/run-windows-acceptance.ps1 `
  -HandoffManifest <windows-cell-handoff.json>
```

Every manifest-relative path must remain beneath the handoff root without symlink or
reparse escape. The per-cell manifest is operator convenience, not a trust root: each
report binds the common `handoffIndexSha256` and its unique `cellManifestSha256`, while
the finalizer receives expected index/candidate/policy digests from the protected release
workflow or a policy-pinned detached signature.

Responsibility split:

| Gate | Ling implementation team | Windows colleagues |
| --- | --- | --- |
| Rust x64 build, injectable native readiness fixtures | Automated Windows CI | Not first-line debugging |
| Test-certificate PE/catalog and Electron Builder hook order | Automated Windows CI | Not responsible |
| Embedded stdio, fake global pipes, old PATH provider | Automated Windows CI | Reverify final candidate |
| Retained-handle hard kill, Job Object descendants, strict residue | Automated Windows CI | Reverify final candidate |
| Package allowlist, silent install/uninstall, Win32 and installable/removable MSIX | Automated Windows CI or managed pool | Reverify release lifecycle |
| Real Windows build cells, DPI/display, Narrator/NVDA, installed lifecycle | Do not self-attest PASS | Execute, review and sign internal/production evidence |
| Production Publisher, RFC 3161, SmartScreen and claimed WDAC policy | Produce fail-closed verifier/handoff only | Execute only for production candidate and sign evidence |

Required Windows evidence:

- signed installed app, NSIS, main-PE seal and signed provider catalog;
- Windows build/session/input desktop;
- WGC, UIA and ordinary input against test-owned Win32/UWP targets plus explicit
  structured UIAccess limitations;
- bundled stdio ignores conflicting global driver/UIA pipes and a PATH-first old provider;
- one/two displays and at least two DPI profiles;
- every explicit `requiredAcceptanceCells` entry, with at least one single-display and one
  dual-display mixed-DPI cell per supported build;
- Narrator and NVDA; production profile additionally requires candidate/environment-bound
  SmartScreen and any claimed exact WDAC policy evidence;
- install, update, rollback and uninstall;
- provider stdout EOF, hard Desktop crash, daemon restart and graceful-timeout recovery
  with zero process/pipe/state residue;
- independent reviewer and candidate-build attestor detached signatures.

Exit criteria for our team:

- all static and hosted build/package gates pass;
- automated Windows CI has already exercised native Rust fixtures, test-certificate
  provider/catalog signing, hook order, embedded stdio/global-pipe conflict, hard-kill and
  grandchild cleanup, PowerShell verifier failures, package allowlist, silent
  install/uninstall, and test-owned Win32 plus installable/removable MSIX/UWP targets;
- the cell handoff command, matrix finalizer and schemas are versioned and reproducible;
- macOS clean builds normalize only the locked Swift bridge `__swift_modhash` sections,
  then relink with fixed final metadata and Apple ld reproducible/no-dedup mode before A/B compare;
- no report can promote itself from local evidence to release PASS;
- test-signed success is capped at `INTERNAL_TEST_PASS` and the production workflow rejects
  any test root, mismatched channel or reused test-signed bytes;
- Windows owner is named in the release policy or handoff manifest.

Exit criteria for Windows support claim:

- Windows colleagues return a policy-complete reviewed acceptance bundle. This occurs
  after the implementation/handoff code is available and is not a blocker for merging that
  code behind the feature gate;
- Windows colleagues first own real build/DPI/display, Narrator/NVDA and
  installation-lifecycle `INTERNAL_TEST_PASS`, then separately own production
  Publisher/SmartScreen/WDAC and final release evidence. They are not the first testers of
  native code or packaging.

Estimated engineering time: 4–7 days for implementation/handoff; Windows execution time
is owned and scheduled separately by the Windows team.

## Conditional Slice 9 — Full Windows UIAccess Tier

Trigger: product/release owner decides Windows must drive elevated/UWP targets through
pixel/SendInput, not only the standard tier.

Recommended direction: ship a separately signed per-machine Computer Use helper under a
release-policy-approved `Program Files` path while keeping the main Desktop install
per-user. Do not weaken `EnableSecureUIAPaths` and do not silently change all Desktop
users to a per-machine install.

Required work:

- define install/update/rollback/uninstall ownership for the secure helper;
- sign the main/helper tuple and validate the UIAccess manifest;
- launch the helper through ShellExecute and obtain/verify its exact PID;
- patch or adapt the upstream worker contract to use a generation-scoped named pipe with
  server-PID validation and deterministic shutdown; if exact PID/pipe ownership is not
  sufficient, freeze a separate native lifecycle design before implementation rather
  than silently adding a Node addon;
- route only the intended tool calls through the helper without bypassing daemon policy;
- add elevated Win32/UWP acceptance and helper crash/residue tests;
- extend the package tuple and release evidence to include the helper installer.

This slice is not safe to implement as `extraResources` only. Without secure-path,
Authenticode, ShellExecute and lifecycle closure, Windows will reject UIAccess or Ling may
connect to the wrong global worker.

Estimated engineering time: 1–2 additional weeks plus signing/installer review and
Windows-team acceptance.

## Parallelization

Slice -1 closes signing/catalog feasibility. After Slice 0 freezes contracts, Slice 1
source build and Slice 2 supervisor interface can run in parallel; Slice 7 UI and Slice 8
schema work may scaffold, but their final E2E/runner closure waits for runtime semantics
and test-signed packages. Production credentials and production trust evidence are not on
this implementation critical path.

The required standard-capability path is approximately 6–10 engineering weeks for one
engineer, or 4–6 weeks for two engineers splitting shared/macOS and Windows/release lanes.
This includes automated Windows gates and handoff/finalizer implementation, but excludes
signing/notary queue time and Windows-team matrix scheduling. Re-estimate after Slice -1.

Dependency and conflict view:

| Step | Modules | Depends on |
| --- | --- | --- |
| Signing feasibility | Desktop package hooks, Windows test certificates | — |
| Contracts | contracts, API client, daemon plugin types | — |
| Source build | provider patches, Desktop resources, release workflow | Contracts lock schema |
| Shared supervisor | Desktop main, bridge | Contracts |
| Daemon activation | daemon plugins, MCP broker | Shared supervisor lease shape |
| macOS adapter | Desktop main, macOS release evidence | Shared supervisor + source build |
| Windows adapter | Desktop main, Windows acceptance | Shared supervisor + source build |
| Product states | Web Plugin Manager, i18n | Contracts scaffold; final E2E waits for daemon/platform states |
| Package staging | Desktop package resources, migration | Source build + active adapters |
| Signing closure | Desktop hooks, release workflows | Signing feasibility + source build + active adapters + staging |
| Evidence scaffold | Windows schemas | Contracts |
| Runner/finalizer/handoff | Windows release evidence | Windows adapter + signing closure |

Lane A: Slice -1 signing feasibility.

Lane B: Contracts -> shared supervisor -> daemon activation.

Lane C: Contracts -> source build -> macOS and Windows adapters in parallel -> package
staging -> signing closure.

Lane D: Contracts -> UI scaffold; final E2E waits for Lane B/C state semantics.

Lane E: Contracts -> evidence schema scaffold; runner/finalizer/handoff waits for Windows
adapter plus signing closure.

Conflict flags: macOS and Windows adapters both touch the Desktop coordinator and package
manifest. Freeze the adapter interface first, keep platform files separate, and merge the
shared coordinator before parallel platform work.

## Failure Modes And User Recovery

| Failure | Required test | Handling | User-visible result |
| --- | --- | --- | --- |
| Packaged bytes or signing identity differ from the seal | corrupted fixture for every platform identity field | refuse spawn and lease | `corrupt`; reinstall/update Ling |
| Generation G finishes after G+1 | delayed initialize/health/list race | compare-and-swap before every write | no stale status or tool flash |
| New daemon serves a snapshot before Desktop reconnect | startup ordering plus two-connection Store fixture | pre-route startup transaction advances epoch, empties tools, projects status from intent and clears effective flags | `desktop_unavailable` if requested, otherwise `included`; no stale tools |
| User disables during activation | disable at each await boundary plus crash injection | first atomically commit intent/tools/status/effective flags disabled, then drain/cancel/stop idempotently | disabled; no tools remain |
| State root escapes through symlink/reparse point | macOS symlink and Windows junction fixtures | reject before provider start | `corrupt`; no external state mutation |
| Windows launches in Session 0/locked desktop | session/input-desktop fixtures plus Windows host evidence | fail closed before tool sync | `interactive_session_required` |
| Windows locks, disconnects or switches input desktop after ready | WTS/heartbeat/pre-call fixtures plus automated Windows integration | close call gate, revoke lease/client, atomically hide tools, stop G, retain intent, probe fresh G+1 after unlock | `interactive_session_required`, then recover |
| One-shot diagnostics passes but active child PID/nonce/session/integrity differs | active-child mismatch fixtures | discard result and stop generation; one-shot evidence never makes runtime ready | `platform_unavailable`; no tools |
| Rust Job Object boundary cannot be established | injectable native failure fixture | exit before initialize; never spawn workers outside ownership | `platform_unavailable` |
| UIAccess helper unexpectedly appears in the standard package | extra-file package fixture | reject catalog/package before spawn | `corrupt`; reinstall/update Ling |
| Signed catalog, member hash or signer differs | catalog/signature/member fixtures | reject before reading loose lock/seal or spawning | `corrupt`; reinstall/update Ling |
| Trusted Windows PowerShell verifier is missing, blocked or cannot return bounded UTF-8 JSON | missing executable/access denied/WDAC/AppLocker/cmdlet/oversize fixtures | fail closed without calling the package corrupt or parsing localized stderr | `platform_unavailable`; repair Windows policy/update Ling |
| New Desktop instance starts at generation 1 after old generation 9 | instance-epoch race fixture | newer daemon-issued instance epoch fences the old instance | no stale renewal/status |
| Global driver/UIA pipes and old PATH provider already exist | pre-bound fake-pipe integration | exact sealed child stdio only; zero pipe connections | no visible error; conflicting install ignored |
| Desktop hard-crashes mid-call | child+grandchild kill-parent integration plus residue probe | child host-PID/stdio-EOF exit closes Rust Job Object, lease expires, no retry until residue clears | `desktop_unavailable`, then recover |
| Provider stdout closes unexpectedly | half-closed stdio fixture | fence lease first, cancel pool, bounded serialized restart | retryable unavailable state |
| Graceful stop times out while Desktop is alive | hung child plus grandchild fixture | terminate the retained ChildProcess handle; `KILL_ON_JOB_CLOSE` removes descendants; never issue PID-only kill | disabled/unavailable; zero residue |
| Local acceptance report edits itself to PASS | schema/finalizer negative fixtures | external detached-signature verifier only | remains `MANUAL_REVIEW_REQUIRED` |

No critical silent failure is accepted: every row must have a negative test, a stable
state/error and a recovery action before its slice is complete.

## Performance Budgets

The feature gate remains off until the implementation records a pinned-provider baseline.
The numeric thresholds below are provisional until one signed macOS and one signed
Windows standard candidate complete the protocol:

- one provider process group, one stdio session, one proxy session and one daemon MCP
  client per lease generation;
- `catalogVerifyMs` on Windows, `spawnToReadyMs`, and `endToEndEnableMs` are reported
  separately; `spawnToReadyMs` p95 is at or below 2 seconds after the platform is already
  permission/session ready;
- proxy overhead for non-image MCP requests: p95 at or below 10 ms versus direct stdio on
  the same host;
- enabled but idle provider: at or below 1% of one logical core;
- Desktop plus provider steady-state RSS increase: at or below 150 MB before image payloads;
- readiness content remains empty: one active-child probe per activation/recovery plus the
  locked WTS/input-desktop heartbeat and pre-call guard; real Windows WGC/UIA targets run
  only in automated/test acceptance lanes;
- zero residue has no tolerance for provider/helper processes, named-pipe endpoints,
  Desktop proxy listeners, unexpected install roots, registry entries, shortcuts or
  contract-owned state locks;
- generic Electron/Node handles, timers, JS heap and RSS are performance metrics rather
  than residue: after warmup they show no monotonic growth and remain inside a versioned
  finite platform tolerance.

Measurement protocol:

- record candidate commit, lock/catalog/seal digests, OS/build, CPU model/logical cores,
  RAM, power mode, display/DPI layout and signing state;
- PR smoke runs at least 30 process-cold activations and 30 warm recoveries;
- signed baseline and release gating run at least 100 cold and 100 warm samples per
  platform, retain raw samples, use documented nearest-rank percentiles and perform no
  silent outlier removal; report p50/p95/max for each named timing;
- measure proxy overhead after 50 warmups over at least 1,000 non-image requests against a
  direct-stdio baseline on the same host;
- after a 10-second settle, sample enabled-idle CPU and RSS once per second for 60 seconds;
  report mean/max CPU and baseline-delta/max RSS;
- run at least 30 enable/disable/restart cycles in PR smoke and 100 in release baseline;
  assert strict-zero owned residue separately from finite-tolerance handle/timer/heap/RSS
  metrics;
- extend the existing Computer Use performance harness instead of creating a second
  result format.

The first signed baselines may tune the provisional thresholds through a reviewed
release-policy change. After that freeze, thresholds and a greater-than-20% p95/RSS
regression both gate the platform; no silent threshold increase is allowed.

## Test Coverage Map

```text
LOCK / PACKAGE
  + exact source/tag/tree/Cargo.lock/toolchain ........ unit + hosted build
  + patch/state isolation ............................ Rust integration
  + Electron Builder hook/sign/mutation ordering ..... hosted Windows test-certificate package
  + macOS post-sign identity ......................... signed candidate verifier
  + Windows main-PE seal + signed catalog ............ PE/catalog + hosted package
  + PowerShell missing/blocked/malformed verdict ..... hosted Windows negative fixtures
  + UIAccess audit output excluded from package ...... build/package negative test

WINDOWS SIGNING LADDER
  + unsigned_dev/development, no catalog ............. dev-gate positive + cross-channel negatives
  + test_signed_internal/internal governed tuple ..... real Authenticode + installed Setup integration
  + production_signed/production governed tuple ...... production-policy positive + test-root negatives
  + productionEligible false/false/true .............. candidate/policy/schema discriminated fixtures
  + ephemeral cleanup / managed QA isolation ......... trust-store + package-content lifecycle tests
  + clean pre-sign -> distinct tier final hashes ..... append/overwrite/reuse tamper negatives
  + tierGovernedArtifacts exact allowlist ............ installer/app/uninstaller/provider/catalog checks
  + vendorNativeInventory stable and separate ........ package inventory + signDlls policy regression
  + installed private spawn path ..................... NSIS installed smoke; runner-temp path negative

RUNTIME
  + valid enable -> ready + capability metadata ...... daemon + Desktop integration
  + permission/session/capability not ready .......... platform fixture + host evidence
  + active-child PID/nonce/integrity/Job Object ....... Rust + Desktop integration
  + daemon boot before Desktop reconnect ............. SQLite startup transaction + API race
  + ready -> lock/revoke -> fresh unlock generation ... Windows integration + deterministic races
  + activation/disable two-writer CAS rollback ....... SQLite integration
  + disable/crash/restart/generation race ............ deterministic fake integration
  + hard Desktop kill / stdout EOF + grandchild ...... Job Object process integration
  + external override and rollback ................... daemon/Web E2E

USER FLOWS
  + packaged first enable ............................ Web/Desktop E2E
  + macOS permission repair .......................... signed clean-host acceptance
  + Windows standard limitation copy/error ........... Web E2E + Windows acceptance
  + Windows test-owned WGC/UIA/input target ........... Windows acceptance
  + automated Win32 + installable/removable MSIX ..... automated Windows CI
  + reinstall/update/rollback repair ................. release acceptance

SECURITY / RELEASE
  + PATH/junction/symlink substitution ............... negative package/runtime tests
  + signed-catalog/member substitution ................ Windows package/runtime tests
  + global named-pipe collision ignored ............... Windows integration
  + proxy token/origin/stale instance/lease ........... Desktop integration
  + self-attested evidence promotion ................. schema/finalizer negative tests
  + missing/duplicate/cross-cell matrix evidence ...... Windows matrix finalizer tests
  + handoff path/hash/reparse escape .................. schema + PowerShell negative tests
  + internal verification kind/constants ............. v1 schema + verifier exact-output fixtures
  + production verifier rejects internal kind ........ cross-profile promotion negative test
  + every production required cell reruns ............ no internal report/attachment reuse fixture
  + SmartScreen/WDAC environment binding ............. production evidence positive + tamper negatives
```

## Merge Strategy

Prefer small independently reviewable PRs:

1. Electron Builder signing/catalog feasibility spike;
2. contracts and lock schema;
3. source patch-series/build pipeline;
4. Desktop host/proxy/lease;
5. daemon pool/activation;
6. macOS adapter;
7. Windows standard adapter plus automated native gates;
8. package staging/migration;
9. signing closure;
10. Plugin Manager states;
11. CI/evidence cells/finalizer/handoff.

Keep the packaged feature gate off until source build, platform package assertions and
runtime fail-closed tests for that platform are all merged. macOS and Windows gates may
be enabled independently.

## Verification Commands

At minimum, every slice runs the narrow affected tests plus:

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
corepack pnpm --filter @ling-stack/desktop verify:release-schemas
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/daemon test
node --test apps/desktop/tests/*.test.mjs
corepack pnpm typecheck
corepack pnpm lint
git diff --check
```

Package slices additionally run macOS and Windows packaging workflows, platform
seal/catalog verifiers, bundled-resource assertions, smoke tests and actionlint. Real signed macOS and
Windows acceptance remains external machine evidence.

The macOS and Windows Desktop artifact jobs run the complete core, daemon and Pi runner
package tests in addition to Computer Use contract tests. They do not maintain duplicated
feature-file allowlists.

## Definition Of Done

### Bundled implementation complete

The required implementation is done when:

- cross-platform design, lock, seal and state contracts are implemented;
- the Electron Builder hook order is proven and every final artifact preserves the exact
  post-seal provider tuple;
- packaged macOS and Windows use bundled mode by default behind closed platform gates;
- shared lifecycle, proxy, instance-epoch lease, pooling and atomic activation races are
  tested, including SQLite crash injection;
- macOS and Windows standard adapters fail closed on their platform readiness rules;
- Windows active-child identity, Job Object ownership and lock/revoke/fresh-generation
  recovery pass automated Windows gates before colleague handoff;
- Plugin Manager and migration show one canonical provider;
- package/signing pipelines produce deterministic tier-aware provider seals and Windows
  signed catalogs, with no UIAccess helper in the standard package;
- `Ling Stack Setup.exe` installs and launches the exact private helper path without any
  second product/install/update surface;
- a real `test_signed_internal + internal` candidate passes the Windows automated/native,
  installed-package and declared standard functional matrix and the independent Windows
  acceptance boundary emits `INTERNAL_TEST_PASS` with `releaseReady=false`;
- Windows immutable cell runner, matrix finalizer, schemas and one-input handoff bundle are
  ready for the Windows team;
- no unresolved standard-tier architecture decision remains.

The implementation may be merged behind the Windows feature gate before colleague VM
sign-off, but it is not marked bundled-implementation-complete until that test-signed
acceptance returns. The production Publisher/certificate, SmartScreen, WDAC and public
detached attestations are not part of this verdict.

### Public release ready

Windows public release requires a separately rebuilt `production_signed + production`
candidate. It must pass the legal Publisher/certificate/EKU/RFC 3161 policy, complete
release VM matrix, candidate-bound SmartScreen, any claimed exact WDAC policy and detached
review/build verification. Only `RELEASE_PASS` may set `releaseReady=true`; functional gate
`PASS` or `INTERNAL_TEST_PASS` never does.

## Release Inputs And Optional Follow-Up

There is no unresolved decision for the required standard-capability implementation.

External public-release inputs still need concrete values: macOS Team ID/toolchain,
Windows legal Publisher/production certificate service/toolchain, supported Windows build
allowlist and Windows production acceptance owner identities. Missing Windows production
values block only `production_signed` candidates and `RELEASE_PASS`; they do not block the
test-signed implementation path.

The only optional architecture decision is whether to implement Conditional Slice 9.
Deferring it preserves the existing Ling per-user Windows installer and blocks only full
elevated/UWP pixel-input parity.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2–3 days / Codex: ~4–8 h)** — Prove Electron Builder hook order,
  test-identity provider/seal/catalog/app/installer signing, test-trust lifecycle/isolation,
  tier mismatch rejection and final-artifact byte stability on macOS and Windows.
- [ ] **T2 (P1, human: ~1–2 days / Codex: ~3–5 h)** — Freeze schema V2, signing ladder,
  verdict ceiling, signed-catalog, active-child readiness, Job Object, instance-epoch lease,
  activation fence and capability-limitation contracts.
- [ ] **T3 (P1, human: ~3–5 days / Codex: ~1–2 days)** — Build the locked Rust patch
  series and deterministic macOS/main-Windows outputs; retain UIAccess as audit-only.
  - Review-only dual-candidate promotion automation and dependent same-platform proposal
    jobs with artifact upload/download round trips have landed. The committed lock remains
    closed until hosted A/B evidence succeeds,
    independent invocation provenance is reviewed, and the lock plus digest anchor are
    committed together; a second native build must then bind the new lock.
- [ ] **T4 (P1, human: ~4–6 days / Codex: ~1–2 days)** — Implement Desktop artifact
  verification, host/proxy lifecycle, active-child nonce/readiness, WTS invalidation,
  host-death/stdio-EOF cleanup and lease publication.
  - Process-wide platform-owner composition, strict runtime trust-policy loading,
    authority reuse/disposal and authenticated non-ready availability publication have
    landed behind the closed gates. Package-authorized builds now generate and carry the
    policy/capability files; native payload promotion and accepted packaged runtime remain.
- [x] **T5 (P1, human: ~3–5 days / Codex: ~1 day)** — Implement daemon pooling and
  `commitCuaDriverActivation()` with two-connection CAS and crash-injection coverage.
  - Activation/store foundations and pool/broker/startup/lease/route/runner/Catalog
    composition have landed with focused race coverage. Exact Desktop non-ready reports
    now retire lease authority and persist recoverable state without exposing tools.
- [ ] **T6 (P1, human: ~3–5 days / Codex: ~1 day)** — Implement and package the macOS
  adapter/TCC/signing path.
  - The adapter is now selected by the process-wide owner and permission changes rotate
    only the provider generation. Package-authorized builds generate the exact Team-ID
    policy and the macOS Builder fixture closes plumbing/sign-seal stability; promoted native
    payload, release signing and clean-host acceptance remain.
- [ ] **T7 (P1, human: ~4–6 days / Codex: ~1–2 days)** — Implement the Windows standard
  adapter, content-free active-child readiness, Job Object lifecycle, structured
  limitations and global-pipe regression.
  - Adapter code and non-Windows automated contract coverage are complete behind the gate;
    the process-wide owner now injects policy, trusted SystemRoot and Electron powerMonitor.
    Real packaged policy/payload, Windows Authenticode/catalog/ACL/WTS/global-pipe and VM
    acceptance remain open.
- [ ] **T8 (P1, human: ~4–7 days / Codex: ~1–2 days)** — Add private-helper Setup staging,
  three-tier signing hooks, the Windows signed catalog, PowerShell tier classification,
  migration and tier-aware rollback tuple.
  - The opt-in pre-sign-only staging scaffold is implemented with an independent
    checked-in lock anchor, the existing source-build verifier and a native no-replace
    atomic publisher core for Darwin and Win32. Production APIs cannot inject trust;
    each staging/cleanup workflow holds one cross-process parent lease, and the same holder
    performs all native inspect/security/verification/publish/removal RPCs. The production
    helper exposes no standalone native mutator. macOS directly flocks the exact opened
    parent-directory vnode without a lock file; Windows retains the parent-`FILE_ID` mutex.
    JavaScript filesystem construction remains in Node, with crash residue handled by the
    next lease's unconditional bounded scan/quota. Platform-private identity-bound
    temp-root security, bounded residue quotas and cleanup API/CLI are implemented.
    Cleanup retries pre-security hardening and permits only exact current-user-owned,
    no-reparse empty-root removal when hardening cannot succeed. Cleanup otherwise uses
    native handle-relative complete-preflight deep deletion with rollback/retryable
    quarantine accounting. Package staging does not
    execute the provider candidate; the outer verifier and standalone source-build version
    probe use the owned PGID/Job Object runner. The governed package wrapper and generated
    authority documents are now connected without changing provider-disabled builds;
    fixture signing/seal/final verification and macOS final-app membership pass. The
    committed lock still enables no platform, so this does not yet produce real native
    payloads, release signing/catalog authority, a provider-bearing `Ling Stack Setup.exe`,
    accepted production runtime wiring or platform-native final-identity evidence. The
    Win32 publisher compile/parent-lease/DACL path and
    owned-process runtime still have no successful Windows hosted-runner evidence and
    require hosted plus real-machine validation.
- [x] **T9 (P2, human: ~2–4 days / Codex: ~4–8 h)** — Update the one-row Plugin Manager
  states, copy, i18n and E2E coverage.
  - The daemon Catalog requested/effective projection and bundled action semantics now feed
    a dedicated renderer view model. State copy, bundled-only repair guidance, Windows
    standard limitations, bilingual strings, pure mapper tests and Renderer E2E have
    landed. Real packaged smoke remains part of T8/T10 rather than this renderer slice.
- [ ] **T10 (P1, human: ~4–7 days / Codex: ~1–2 days)** — Atomically migrate Windows
  candidate/policy/attestation/verifier contracts, add immutable cells and the matrix
  finalizer, and produce deterministic internal and production one-input handoff bundles
  for Windows-team execution.
  - Candidate generation and handoff publication are separate exclusive-create phases so
    manual evidence can bind the exact v4 digest. The handoff phase recomputes the candidate,
    rejects artifact drift, clones the exact clean commit and emits one manifest per policy
    cell. Final publication uses an atomic no-replace directory claim and moves the index
    last as the ready boundary; a competing or crashed path is never overwritten. Internal
    verification remains capped at `INTERNAL_TEST_PASS` and
    `releaseReady=false`; production verification rejects the internal tuple. Hosted
    PowerShell/runtime execution and Windows-team VM acceptance remain external evidence,
    so T10 intentionally stays unchecked.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | ---: | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | Not run | Not required for this architecture-only expansion |
| Codex Review | `/codex review` | Independent second opinion | 0 | Not run | Two independent engineering subreviews were used instead |
| Eng Review | `/plan-eng-review` | Architecture, tests and performance | 2 | CLEAR | 9 signing-ladder/evidence gaps found and folded in; 0 critical gaps remain |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | Not run | No new visual system; state semantics are specified |
| DX Review | `/plan-devex-review` | Developer experience | 0 | Not run | Handoff and verification commands are in scope of implementation |

**VERDICT:** ENG CLEARED — signing ladder, internal/production evidence split and test
matrix are ready to implement behind independent macOS and Windows platform gates.

NO UNRESOLVED DECISIONS
