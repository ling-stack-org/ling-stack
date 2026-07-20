# Desktop App

Desktop packaging is in alpha implementation. The current branch has a minimal
Electron shell over the local daemon and shared Web UI, plus the first Computer Use
picture-in-picture slices. It is not release-ready: unsigned macOS real capture and
bounded daemon/renderer recovery, real Electron fake-source DOM tests, and zero-residue
process profiling are implemented. The current host also passes the unsigned packaged
fake/window/display provenance matrix, Cua native-window handoff, and real MediaStream
performance comparison. The unresolved release gates are Developer ID
signing/notarization and Gatekeeper,
clean-host TCC plus the operating-system capture indicator, Windows interactive
provider/DPI/dual-display acceptance, Authenticode/SmartScreen/signed NSIS, hosted signed CI,
clean-machine install/update/uninstall, external detached-signature review, deterministic
candidate `daemon/dist` provenance, and real VoiceOver/Narrator/NVDA acceptance.

The desktop app should be a shell over the local daemon and shared Web UI. It should own
daemon lifecycle, menu/tray, notifications, file picker, keychain, and update UX, but it
must not fork the Ling Stack product model or bypass daemon state machines.

AI Council health and badge state should come from `@ling-stack/core/ai-council-view`
plus daemon/API-client data, not from copied Web DOM labels or Web-only helpers.

Design source of truth:

- [Desktop Shell](../../docs/design/desktop-shell.md)
- [Bundled Embedded Cua Driver](../../docs/design/cua-driver-bundled-embedded.md)
- [Bundled Embedded Cua Driver Detailed Design](../../docs/design/cua-driver-bundled-embedded-detailed-design.md)
- [Bundled Embedded Cua Driver Implementation Plan](../../docs/design/cua-driver-bundled-embedded-implementation-plan.md)
- [Desktop Computer Use Picture-in-Picture](../../docs/design/desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](../../docs/design/desktop-computer-use-picture-in-picture-detailed-design.md)
- [Desktop Computer Use Picture-in-Picture Implementation Plan](../../docs/design/desktop-computer-use-picture-in-picture-implementation-plan.md)
- [Desktop Release Acceptance](../../docs/release/desktop.md)
- [Desktop Windows Release Decisions](../../docs/release/desktop-windows-release-decisions.md)

Electron is the selected Desktop shell for the current alpha. Tauri is not an active
implementation path for this slice; reconsidering it would be a separate architecture
decision after the daemon and capture contracts stabilize.

The presentation contract targets macOS and Windows, but real source support is gated
per platform. The current Windows implementation baseline resolves the exact reviewed
upstream `cua-driver-rs-v0.8.3` asset externally; that reference asset is an unsigned
prerelease and still requires separate installation. The approved target replaces that
distribution boundary with Ling's locked source-built and signed `0.8.3 (Ling build 1)`
inside packaged Desktop. Windows release readiness remains blocked until Windows
colleagues run the signed bundled x64 VM source/lifecycle matrix. The main window
reuses the shared React application while the PiP uses a small isolated renderer plus a
narrow capture adapter. Hide or window
close must never stop the underlying Computer Use session; stopping remains a separate
daemon command with approval and audit semantics.

Desktop keeps one fixed loopback daemon authority per workspace. A compatible daemon is
reused; an incompatible external daemon triggers a native Retry/Quit prompt before the Web
window opens. Desktop never kills that process or launches a second full daemon against the
same workspace. Startup is single-flight, and headless smoke remains fail-closed.

After a ten-second zero-frame deadline, V1 does not listen for resume/unlock/user-active.
Recovery requires explicit Show/Retry, a new descriptor identity, or an explicit Desktop
restart; the Computer Use task continues throughout.
This rule is only about PiP presentation. The bundled Windows provider readiness monitor
must still revoke tools on lock/session/input-desktop change and start a fresh provider
generation after unlock; that recovery never auto-opens PiP.

Packaged Desktop builds copy the bundled Cua Driver plugin shell into
`resources/bundled/cua-driver`. That resource contains only the Ling plugin
manifest, MCP configuration metadata, and README. It deliberately does not include the
user-installed `cua-driver` binary, native app bundles, credentials, or permission state.

The closed-gate runtime foundation now includes a fixed-path strict trust-policy loader,
one process-wide Darwin/Win32 platform owner and an authenticated non-ready availability
projection. The availability path may hide tools and report permission/session/platform
repair state; it cannot report ready or replace lease/activation authority. Current
packages still omit both `providers/cua-driver/runtime-trust-policy.json` and the final
native payload, so this foundation does not enable bundled mode by itself.

That paragraph describes the current implementation. The approved next macOS and Windows
Desktop direction is to package the locked `0.8.3 (Ling build 1)` source build, including
its managed-embedding patch series and platform post-sign seal/catalog contract, then run
the main provider as a Desktop-owned embedded child, as defined by the Bundled Embedded
Cua Driver documents above. Windows starts with the existing per-user/asInvoker standard
integrity tier; UIAccess-only elevated/UWP pixel input remains a separate secure-helper
release decision. Until those slices land, packaged artifacts remain plugin-shell-only.

The pre-sign package-staging path is deliberately opt-in while that lock remains closed:

```bash
corepack pnpm --filter @ling-stack/desktop stage:cua-driver-provider -- \
  --platform darwin \
  --source-root <verified-native-source-build-root> \
  --output-root <fresh-electron-staging-root>
```

This command is pre-sign staging only. It first runs the existing source-build verifier,
requires the source `provider-lock.json` bytes to match the independent checked-in lock,
and then validates that lock's enabled platform and pre-sign digest. The production
`stageCuaDriverProvider()` and `verifyCuaDriverSourceInput()` entry points always use that
committed lock root and the real verifier; caller-supplied `trustedResourceRoot` or
`sourceBuildVerifier` fields are rejected before use. Fixture trust is available only from
the test-only stager factory and is not reachable from the CLI or environment. The parent
stage passes its bounded provider snapshot digest to the child verifier, which compares that
digest with its own bounded snapshot. In package-staging mode the verifier does not execute
the provider candidate at all; locked version evidence must instead agree across the
attestation, promotion input and provider lock already bound to those exact bytes. The outer
source verifier uses the owned process-tree runner. Standalone source-build verification
retains an owned `--version` probe: Unix uses a detached process group and Windows uses the
native `KILL_ON_JOB_CLOSE` Job Object path, so timeout, abort or output overflow fences owned
descendants instead of settling with an orphan. Source-build attestation or promotion JSON
cannot enable packaging by itself. The command copies only the current platform binary
plus lock/license/notices into
`providers/cua-driver/0.8.3-ling.1`, and returns the exact Electron Builder
`extraResources` entry that keeps the provider outside `app.asar`. Publication uses the
checked-in Darwin/Win32 native no-replace publisher and fails closed instead of overwriting
an existing destination. The native helper is built and identity-preflighted before a temp
payload tree exists. Darwin invokes the held helper vnode through its volume/file identity;
the preflight executes a harmless probe through that path and fails before payload creation
when the platform cannot resolve it. Standalone preflight invocations recheck helper
identity afterward, and the held RPC helper is rechecked when its lease session closes. The
build-only helper root contains no provider/package bytes and is deliberately
left to OS temp reclamation; staging performs no path-based deletion of that root. The final
signed/prebuilt helper slice removes this temporary compiler root. After that preflight,
each production stage or explicit cleanup session holds one cross-process parent lease
while Node runs its ordered output-parent workflow. The lease holder is also a bounded
synchronous native RPC actor: the same process that owns `flock` or the Windows mutex
performs every native inspect, private-security, verification, publish and removal
operation. Production does not expose those mutators as standalone native CLI commands, so
no sibling native mutation helper can outlive the lease. This strong lifetime guarantee is
deliberately limited to native mutation. Node still performs JavaScript `mkdir`, copy and
write work; if Node exits between RPCs, an incomplete payload or quarantine may remain and
the next lease must inspect it under the normal bounded residue quota.

On macOS the helper opens the exact no-link output-parent directory and applies `flock`
directly to that already-open directory vnode. Staging creates no `.ling` lock file and
needs no lock-control entry or quota exclusion. On Windows a
`Global\\LingCuaStage-*` mutex is derived from the exact parent `FILE_ID`; its protected DACL
contains only the current user, SYSTEM and Administrators. `WAIT_ABANDONED` records only a
waiter that was already present when a Windows mutex owner died; it is not a persistent
crash journal and a later acquirer may
legitimately report `false`. Clean idle EOF or explicit release drains queued/in-flight RPC
work and unlocks normally. If the caller dies during an RPC, the holder keeps the lock until
that bounded operation finishes, then observes EOF and exits. If the holder dies during an
RPC, the in-process native mutation stops and the OS releases its lock. RPC timeout,
protocol failure or receipt mismatch invalidates the session by killing the holder and
waiting for its actual exit before the capability is discarded. Any payload or quarantine
residue stays on disk and every next lease performs the same bounded inspection regardless
of the abandonment flag. Each RPC has a fixed 30-second native watchdog so a stuck
in-flight operation cannot leave the parent locked indefinitely.

Publication also reopens the canonical parent path without following links immediately
before commit and again after observing the commit result. The named path must still match
the held vnode/`FILE_ID`: a pre-commit replacement is `not_committed`, while a replacement
observed after the rename is `ambiguous` and can never be reported as `committed`. The
replacement path is never mutated; if the rename already happened, the published identity
remains only under the displaced held parent for diagnosis.

Immediately after creating a payload temp root, staging reads the exact native parent/root
identities, requires the parent to equal the held lease identity, and passes both values as
mandatory expectations to `secure-private`. Each payload temp root is then secured and
reverified as current-EUID mode
`0700` on macOS or a protected current-user/SYSTEM/Administrators DACL on Windows before
publication. Native commit confirmation is recorded inside the guarded publish callback. If
the lease is lost by either the inner or outer guard after that confirmation, staging reports
an ambiguous `published=true` failure bound to the final output root, exposes no temporary
cleanup receipt and never removes the final root. A pre-commit failure retains the exact
tree for diagnosis. With a healthy lease, ordinary failures observe the retained root and
return its exact identity plus bounded inventory in `error.cleanup`. Lease loss after
identity capture may return only `residuePath` plus `residueIdentity`; lease loss after
`mkdir` but before capture may return only `residuePath`. The next lease can use the
read-only listing flow below to recover any missing identity or inventory. Residue count,
entry count and cumulative bytes are bounded, so repeated failures stop before creating
another tree when a quota is exhausted. Both original temp residues and retryable cleanup-
quarantine/rollback residues participate in that quota. Cleanup is explicit, never
path-only, and requires a recorded or freshly listed native identity:

```bash
corepack pnpm --filter @ling-stack/desktop stage:cua-driver-provider -- \
  --list-residue \
  --output-root <original-electron-staging-root>
```

`listCuaDriverStagingResidues()` and the matching CLI run under the same parent lease and
recover the exact identity, security state and bounded inventory for up to four retained
roots when a hard process exit prevented an `error.cleanup` receipt or lease loss left an
incomplete one. A larger legacy set is reported as truncated; clean one listed identity
and repeat. Listing never hardens or deletes a root.

```bash
corepack pnpm --filter @ling-stack/desktop stage:cua-driver-provider -- \
  --cleanup-residue <error.cleanup.residuePath> \
  --output-root <original-electron-staging-root> \
  --expected-residue-identity <error.cleanup.residueIdentity>
```

After the same output-bound path check, the corresponding
`cleanupCuaDriverStagingResidue()` API acquires the parent lease before reading or mutating
residue state. It first verifies the recorded parent/root identities and private-security
profile. If a failure occurred before `secure-private`
completed, cleanup retries identity-bound security hardening. If that also fails, the only
permitted fallback is native `remove-unsecured-empty`, which deletes only the exact
current-user-owned, no-reparse, completely empty root; a non-empty, replaced or otherwise
unsafe root is retained. Cleanup then performs the identity-bound native quarantine rename
and second inventory check. Final removal is a native handle-relative operation: it
completes a bounded deep-tree preflight against the expected root/parent identities, entry
count and total bytes before deleting any member, then returns matching
removed-entry/byte evidence.
If removal or quarantine commit fails, staging identity-checks and rolls the same tree back
when safe; an ambiguous quarantine is retained as a retryable, quota-counted receipt. An
identity mismatch is never deleted. A successful publication leaves no temp residue.
Staging never creates a provider lock, seal, catalog, signature, native final-identity
verdict or release claim. Its return value is descriptive
and is not wired into the default package configuration. The checked-in scaffold lock has
no enabled platform or native binary, so it intentionally cannot stage and normal package
commands remain unchanged with the Darwin and Win32 bundled-provider production gates off.
Final signing, `Ling Stack Setup.exe` inclusion, production runtime wiring, and Windows
hosted-runner/real-machine validation remain open; the Win32 path has not been validated on
a hosted Windows runner in this slice. In particular, neither the Windows native-helper
compile/`Global` parent-mutex/DACL/`WAIT_ABANDONED` path nor the Windows owned-process
runtime/Job Object path has hosted execution evidence yet. This pre-sign build tool trusts
the current build account plus the checked-in verifier/compiler inputs; it does not claim
protection from hostile code already executing
as that account. Final signed helper/bootstrap identity belongs to the signing-ladder slice.
Current `external_local`
installations, including one that resolves through
`/Applications/CuaDriver.app`, must remain installed until `bundled_embedded` is wired and
accepted on the active platform.

The Desktop main window must load the shared Web application instead of copying its page
tree. This lets the shell, contracts, coordinator, and fake PiP renderer land before the
final conversation UI is approved; later UI changes should touch only typed capability
slots, geometry reporters, and visual polish.

Focused verification commands:

```bash
corepack pnpm --filter @ling-stack/desktop test:renderer
corepack pnpm --filter @ling-stack/desktop test:cua-driver-package-staging
node --test apps/desktop/tests/cua-driver-package-publisher.test.mjs
node --test apps/desktop/tests/*.test.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
corepack pnpm --filter @ling-stack/desktop performance:computer-use:real
node apps/desktop/tests/run-computer-use-smoke.mjs --display
corepack pnpm --filter @ling-stack/desktop verify:windows-provider
corepack pnpm --filter @ling-stack/desktop smoke:computer-use:windows-provider
corepack pnpm --filter @ling-stack/desktop exec electron tests/screenshot-app
```

`smoke:computer-use:windows-provider` is intentionally Windows-only. On macOS/Linux it exits
with an explicit skip; on Windows it requires an unlocked interactive desktop and
an installed `cua-driver` (override the executable with
`LING_CUA_DRIVER_COMMAND`). It first requires a schema-v1 `health_report` with the
interactive-session, UIA, and screen-capture checks passing, then starts two isolated
targets and calls `cua-driver call list_windows {"pid": ...}` for each exact PID/HWND
pair. It verifies first frame, Hide/Show, descriptor revision replacement, isolation
when the old target closes, Desktop restart with descriptor replay, and bounded stall
recovery when the current target closes without stopping the runtime. The existing
`smoke:computer-use:real` command is a direct Electron source-ID smoke and must not be
used as Windows provider evidence.

`performance:computer-use:real` includes ten one-second Show/Hide churn cycles plus a
hidden-idle baseline and 30-second continuous-capture sample with per-process CPU and
working-set reporting. Together with the `--display` smoke it is current-host engineering
evidence only; neither replaces signed/notarized release, TCC-state, capture-indicator, or
Windows provider measurements.

Latest confirmed final pre-commit local evidence (2026-07-17, current worktree):

- Desktop Node passes **291/291**, PiP renderer passes **20/20**, and Web E2E passes
  **35/35**;
- contracts pass **5/5**, API client passes **48/48**, and the full daemon suite passes
  **629/629**;
- macOS release-focused cases pass **28/28**, Windows acceptance/provider/release focused
  cases pass **57/57**, and the strict Ajv Draft 2020-12 compiler validates all **11/11**
  release-evidence schemas;
- the Desktop production build, Web production build/typecheck/lint/i18n checks, workspace
  typecheck/lint, and actionlint all pass. `docs/release/evidence/**` is included in the Desktop
  artifact workflow path filters, so a schema-only pull request or `main` push runs the schema
  gate;
- packaged arm64/x64 `.app` bundles and both mounted DMGs pass fake, real-window, and
  primary-display provenance smokes;
- Cua native-window handoff passes in dev Electron and both packaged `.app` bundles.
  Electron source ID is used only as the test oracle; the Ling descriptor carries only
  the Cua provider PID and `nativeWindowId`, with no title, foreground-window, or z-order
  fallback;
- real MediaStream first decoded frame p50/p95 is **168.09 / 177.84 ms** and
  Hide-to-release p50/p95 is **2.16 / 3.65 ms**;
- the 30-second active-preview delta is **0.21%** of one CPU core with **11,763,712 bytes**
  working-set overhead; ten-cycle Show/Hide churn is **6.04%** main-process CPU with
  **17,661,952 bytes** app working-set growth;
- the fake ownership/crash lane records **415.27 ms p95**;
- twelve capture activations perform exactly **12 source enumerations**, reuse **1 renderer
  document**, and make **0 `applyConstraints()` calls**;
- final window, renderer, process, track, timer, subscription, IPC, adapter-source, and
  raw-listener residue is **0**;
- Vite empties the preview `outDir` before building, and packaged `app.asar` contains only
  the current seven preview-subtree entries (two directories and five files);
- macOS bundles carry the committed Ling `icon.icns`, while the Windows app and NSIS carry
  all nine frames from the committed Ling `icon.ico`; neither package uses Electron's
  default icon. The Windows installer is explicitly one-click, per-user, `asInvoker`, and
  contains no elevation helper.

Historical unsigned artifact SHA-256 baseline at `e20777f5` (not hashes of the current diff):

| Artifact | SHA-256 |
| --- | --- |
| arm64 DMG | `e42b944b84bf67174d18dec422637cbde6988c4d2283f503597b09aae50727fb` |
| x64 DMG | `a9e8aa208af6dc9baff96b9550166095660adc1b596c4f86544287ac0ca19258` |
| arm64 ZIP | `6c9ac51d212a7a4b930cf8bcb8c93f7e4b4f07bb17b93d1205f01b2ff99face5` |
| x64 ZIP | `49a8bc3d5dce9def59c49b7a53f9fb31fea72e960dd9e99f806809d995bb695e` |
| Windows x64 unpacked app | `3f6ad1bbb45816bb46b15d2e23eb7a60843eb2a8fbc25ae0e541fb29af1d596e` |
| Windows x64 NSIS | `52b115f2ef02394ed0e352c28f60052ec572eec02f708c2a942bd64d9b4de5e2` |

Both DMGs and ZIPs pass their integrity checks. The unpacked Windows application and NSIS
PE certificate-table sizes are both **0**, and no Apple Developer ID identity is installed.
Developer ID signing/notarization/Gatekeeper, clean-host TCC/capture-indicator evidence,
Windows interactive provider/DPI/dual-display execution,
Authenticode/SmartScreen/signed NSIS, hosted signed CI execution, clean-machine install/update/uninstall,
and VoiceOver/Narrator/NVDA evidence are still open release gates.

Local release tooling is present but deliberately cannot close those gates by itself:
`verify-macos-signed-candidate.mjs` requires a content-bound arm64/x86_64 app+DMG+ZIP matrix,
`run-macos-tcc-acceptance.mjs` live-reverifies that candidate and writes eight architecture-
specific case reports, `run-macos-tcc-revocation.mjs` derives the interactive revoke transition,
`run-macos-signed-performance.mjs` profiles the packaged signed executable, and
`finalize-macos-signed-acceptance.mjs` rehashes, live-reverifies, and cross-binds final evidence
while deliberately stopping at `MANUAL_REVIEW_REQUIRED`.
All macOS artifact/evidence paths are report-relative for clean-host portability. Every macOS
release-harness script is bound to its recorded harness-commit Git blob, current file bytes, and
SHA-256; a hidden `assume-unchanged` modification fails the binding check. The
  `run-windows-acceptance.ps1` keeps Full acceptance BLOCKED until the fixed reviewed
provider tuple, approved release policy, content-bound candidate, and six independent
host/session-bound visual/accessibility/SmartScreen/lifecycle evidence documents exist; it
  also verifies installer/uninstaller signatures before execution and binds its harness scripts
  to the candidate commit. Even with every Full gate PASS, its builder fixes `releaseReady=false`
  until detached reviewer and candidate-build attestations verify. Windows Full requires three
  caller-fixed external trust anchors:
the expected candidate commit, clean repository root, and release-policy SHA-256. This macOS
host has neither `pwsh` nor Windows PowerShell, so the PowerShell surface has only Node-based
static contract coverage; real PowerShell parsing/runtime and Windows execution remain
unverified. The independent Windows verifier now recomputes the canonical evidence digest and
checks both RSA signatures against SPKI fingerprints pinned by the externally anchored policy;
manual-evidence reviewer strings alone cannot promote a release. Real detached reviewer/build
signatures and deterministic candidate `daemon/dist` evidence remain external release gates, as
does macOS external reviewer-signature verification.
