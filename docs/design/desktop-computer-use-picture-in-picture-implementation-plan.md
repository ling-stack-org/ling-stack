# Desktop Computer Use Picture-in-Picture Implementation Plan

## Status

Local implementation baseline verified on 2026-07-16/17. The design and detailed design are complete. Original Slices 0-6
are complete locally, and Slice 7 has closed its local G4, unsigned-artifact, performance,
and packaged-provenance work. The remaining work is external release evidence: Developer ID
signing/notarization/Gatekeeper, clean-host TCC and operating-system capture-indicator states,
Windows x64 interactive provider/DPI/dual-display execution, Authenticode/SmartScreen/signed
NSIS, real VoiceOver/Narrator/NVDA acceptance, hosted signed CI, clean-machine
install/update/uninstall, external detached signatures, and real candidate-daemon provenance.

The local release-acceptance harness is now implemented and fail-closed. macOS candidate
verification requires a content-bound arm64/x86_64 app+DMG+ZIP matrix; TCC cases live-reverify
the candidate and write atomic failure reports; arm64/x86_64 each require all four TCC cases,
granted includes a two-launch restart gate, revoked is machine-observed, and packaged signed
performance is candidate-bound. Report-relative paths keep the retained artifact tree portable.
Every macOS release-harness script is bound to its recorded harness-commit Git blob, current file bytes,
and SHA-256; hidden `assume-unchanged` modifications fail closed. The finalizer reruns candidate
verification, parses artifact-bound notary logs, and rehashes every nested artifact, but
deliberately stops at `MANUAL_REVIEW_REQUIRED`; a separate trusted
detached-signature verifier is required to promote the evidence externally. Windows
Preflight/Full reports bind the app,
installer, both provider executables, signer identities, candidate manifest, real dual-screen/
DPI, Narrator/NVDA, SmartScreen, install/update/uninstall, and smoke evidence. Full validation
also requires caller-fixed expected candidate commit, clean repository root, and release-policy
SHA-256 trust anchors. Those anchors do not authenticate a reviewer self-reported in manual
evidence. Full now stays `releaseReady=false` until an independent verifier validates the canonical
evidence digest, detached reviewer signature, and candidate-build/daemon-tree attestation against
cross-role-disjoint policy-pinned identities, key IDs, and SPKI fingerprints. The PowerShell
surface is only statically contract-tested from Node on this macOS
host because neither `pwsh` nor Windows PowerShell is installed. The strict Ajv Draft 2020-12
gate compiles all eleven evidence schemas, and schema-only changes under
`docs/release/evidence/**` trigger the Desktop artifact workflow. Missing external evidence
remains `BLOCKED`; the unsigned hosted workflow uploads a diagnostic Preflight without mistaking
it for release closure.

The granted-case restart fixture starts the production daemon registry once, seeds one active
projection, and runs two Desktop launches against that same daemon/workspace/token. This proves
transport-level projection replay and Stop acknowledgement; it does not close the separate
provider, clean-host TCC, capture-indicator, accessibility, signing, or notarization gates.

Status legend: `[x]` verified complete, `[~]` implemented but not release-complete,
`[ ]` pending, `[!]` blocked by an external/platform prerequisite.

### Current implementation baseline

| Area | Status | Evidence / remaining gate |
| --- | --- | --- |
| Source spike and opaque descriptor boundary | [x] | `desktop-computer-use-picture-in-picture-source-spike.md`; `cua-driver` has no continuous stream or stable session API, so Ling consumes its exact native-window identity while Electron owns presentation capture |
| Electron Desktop shell and shared Web loading | [x] | shared Web loading, sandbox/preload boundaries, daemon ownership, bounded cold-start handling, fixed-port incompatible-daemon Retry/Quit recovery, startup single-flight, bundled plugin metadata, macOS arm64/x64 packages, and the unsigned Windows x64 cross-package pass locally. The Vite preview build empties its dedicated `outDir`; the packaged `app.asar` preview subtree contains only the current seven entries |
| Contracts, daemon projection, SSE/API, Stop acknowledgement | [x] | structured projection is driven only by trusted authorized MCP definitions and run approval events; the current authoritative sequence is `starting -> waiting_for_approval -> starting -> running -> terminal`, `paused` is reserved, the lifecycle `rawName` whitelist is removed, and revision, atomic snapshot/subscribe replay, SSE epoch, bridge handshake, scoped native route token, bounded terminal/event retention, descriptor lease/revocation, and Stop acknowledgement pass. A negative Stop acknowledgement restores the active projection and returns HTTP 504 |
| Coordinator, selectors, fake lifecycle | [x] | IPC ownership, truthful auto/shown/hidden intent, eager terminal suppression cleanup, first-frame, Hide/Show/Close/Stop, exact Desktop-local source generations and exact-window mismatch fail-closed handling, serialized reconnect/revision replacement, post-timeout session/revision blocking, one-second frame-gap watchdog, fail-safe/quiescent disposal, exact renderer media-release acknowledgement with forced teardown, summary-only `starting`/`waiting_for_approval` handling without an empty PiP window, placement, Reset, display recovery, bounded renderer-crash recreation, preference-failure safety, queued linger ownership, fake-source zero-residue profiling, and unsigned packaged renderer-crash recovery pass locally |
| Renderer, shared UI, and layout | [x] | runtime overlays, direct Open/Hide/More controls, PiP-only Close window, structured Stop pending/failure/retry, safe menu grouping, hover/focus reporting, keyboard/a11y, themes, reduced motion, typed obstacle priority across channel/normal/teammate-direct surfaces, drag/resize, 180 ms drag-end four-corner snap with preferred-corner persistence, source `setAspectRatio` handling including portrait inputs, display persistence, dedicated `en-US`/`zh-CN` locale catalog and hot-switch transport, Electron DOM/media coverage, the final pre-commit PiP renderer **20/20**, and the ten-case macOS arm64 screenshot matrix pass locally; Windows DPI/dual-display visual acceptance is external |
| macOS current-host real capture and provenance | [x] | the dedicated non-persistent partition passes dev plus fresh unsigned arm64/x64 `.app` and mounted-DMG fake, real-window, primary-display, and provenance smokes. Exact document/navigation-bound grants, provisional idle loading before `prepare()`, the 16 ms decoded-ready poll, live-track release, crash recovery, and Cua native-window handoff in both packaged `.app` architectures pass. Signed TCC/capture-indicator/restart evidence remains external |
| Windows provider/plugin/package boundary | [x] | exact reviewed `trycua/cua-driver-rs` `v0.8.3` asset/SHA is allowlisted; unreviewed newer versions fail closed. Ling plugin, command, descriptor, provider verifier, branded unsigned PE32+ x64 application, and explicit per-user/asInvoker NSIS cross-package gates pass locally. The upstream provider is currently an unsigned prerelease, and interactive Windows x64 provider/source lifecycle, DPI, and dual-display evidence remains external |
| Local production closure | [x] | G4 recovery/security, packaged provenance, bounded privacy-safe telemetry, fake and real performance harnesses, unsigned macOS arm64/x64 DMG+ZIP integrity, unsigned Windows x64 packaging, SHA-256 generation, and zero-residue checks pass |
| Release acceptance harness | [~] | macOS signed candidate/TCC/finalizer plus Windows Preflight/Full builder, PowerShell runner, bundle-tree/CDHash, notary job/artifact, candidate-commit/harness, pre-execution Authenticode, immutable-manifest, and manual-evidence gates are implemented locally. macOS scripts are Git-blob/worktree/SHA-bound; Windows Full has caller-fixed commit/root/policy-SHA anchors, a fail-closed `releaseReady=false` builder, and an independent verifier for policy-pinned reviewer plus candidate-build detached signatures; the eleven-schema Draft 2020-12 compiler and schema-only CI trigger are complete. External signed attestations, PowerShell parser/runtime, and real deterministic/signed-candidate daemon provenance evidence remain pending |
| External release closure | [!] | Apple Developer ID signing/notarization/Gatekeeper and denied/prompt/granted/revoked clean-host TCC/capture-indicator evidence, Windows interactive VM/provider/DPI/dual-display execution, Authenticode/SmartScreen/signed NSIS, VoiceOver/Narrator/NVDA, hosted signed CI execution, clean-machine install/update/uninstall, external detached signatures, and real candidate-daemon provenance remain unavailable or undecided |

### Latest confirmed local verification (2026-07-17, current worktree)

The final pre-commit matrix passes Desktop Node **291/291**, PiP renderer **20/20**, Web E2E
**35/35**, contracts **5/5**, API client **48/48**, full daemon **629/629**, macOS
release-focused **28/28**, Windows acceptance/provider/release focused **57/57**, and all
**11/11** strict Ajv Draft 2020-12 release-evidence schemas. The Desktop production build, Web
production build/typecheck/lint/i18n checks, workspace typecheck/lint, and actionlint also pass.
`docs/release/evidence/**` is in the workflow path filters, so schema-only pull requests and
`main` pushes execute the schema gate.

These results are current local engineering evidence against the final pre-commit diff, not a
cross-platform release closure. Fixed artifact hashes labeled `baseline @ e20777f5` remain
historical references; signed clean-host macOS, interactive Windows, hosted signed CI,
clean-machine lifecycle, detached-signature, and candidate-daemon provenance evidence remains
external and pending.

- Desktop Node coverage includes the branded application-icon contract,
  locale allowlist/snapshot propagation,
  renderer message catalog/fallback, renderer-crash recreation, hide-before-frame,
  route-switch, terminal-during-reconnect, delayed reconnect versus Hide/revision races,
  one-second first-frame and frame-gap detection, full ten-second exhaustion without Stop,
  post-timeout reopen blocking, throwing and racing disposal, exact renderer release ACK,
  timeout/negative ACK forced teardown, exact-window mismatch fail-closed handling,
  pending-acquisition cleanup, requester-bound
  single-use grants, host-layout bounds, descriptor runtime validation, provenance-negative
  coverage, terminal suppression pruning, post-timeout new-revision recovery, daemon startup
  single-flight/ownership, incompatible-daemon Retry/Quit recovery, adapter disposal, scoped
  route-token, telemetry privacy, the 896-combination presentation selector, auto-show
  cancellation while connecting, terminal route switching, late failure isolation,
  native-Close persistence, stall/crash block composition, same-revision descriptor
  replacement with exact source generation, preference-failure safety, queued linger
  ownership, foreign fixed-port detection, early child exit, startup-failure cleanup of an
  owned daemon/window/coordinator, descriptor revision versus user suppression, independent
  Stop single-flight ownership, provider-call cancellation/deadline cleanup, and catalog-first
  exact window/PID matching.
- Release acceptance cases add signed candidate matrix/content binding, live signed-candidate
  re-verification, distinct revoked transition evidence, atomic TCC failure reports, hash-based
  final evidence derivation, Windows probe-invariant rejection, expected Publisher binding,
  provider-helper coverage, and mandatory visual/accessibility/SmartScreen/install lifecycle
  evidence. A hand-edited PASS cannot validate against contradictory or missing inputs.
- Real Electron renderer DOM/keyboard/media coverage exercises live
  `en-US` -> `zh-CN` title/action/status/ARIA switching without media reacquisition,
  direct action
  order, Close-window separation from Stop, menu grouping/navigation and focus retention,
  Escape safety, interaction-edge
  reporting, Stop not-accepted/rejected/pending/stale results, aria-live, dynamic title,
  serialized display-media startup, decoded-data gating when
  `requestVideoFrameCallback` is unavailable, live-track release, late pending stream cleanup
  before ACK, and identity mismatch without stopping a newer revision.
- Shared Web Desktop bridge, workspace, and app-shell selector E2E coverage includes
  initial/runtime locale reporting,
  Show/Hide/Stop duplicate suppression, safe assertive failure copy, accepted-pending
  projection ownership, stale session/request isolation, bounded command timeout with late
  result rejection, current-session header placement across channel/normal/teammate-direct
  surfaces, responsive action targets, teammate-direct composer/summary/dock/terminal
  geometry, obstacle-kind normalization, dynamic modal-marker release, and the three
  app-shell selector cases, plus latest-intent-wins navigation while an older lookup succeeds
  late.
- The final pre-commit contracts suite passes **5/5**, API client passes **48/48**, and the full
  daemon suite passes **629/629**, including Cua Driver preset, provider schema/health, Stop
  single-flight, provider cancellation/deadline, and exact catalog ownership coverage.
  API-client and Desktop projection tests also verify the scoped
  `X-Ling-Computer-Use-Token` header and the absence of the private bridge token on native routes.
- Lifecycle projection now derives only from a trusted authorized MCP definition plus run
  approval events. The observed path is `starting -> waiting_for_approval -> starting ->
  running -> terminal`; the lifecycle `rawName` whitelist is gone, and `paused` remains a
  reserved contract value because no authoritative runtime event currently emits it. Hide
  changes presentation/media only, and `interrupt_redirect` follows `stopping -> cancelled`;
  neither path may be projected as paused.
- A Stop negative acknowledgement restores the projection to active and returns HTTP 504.
  Desktop surfaces the command as failed, does not claim termination, and leaves Stop
  available for retry.
- A `starting` or `waiting_for_approval` projection without a preview descriptor remains
  visible in the shared current-session summary. Desktop does not create a BrowserWindow or
  show an empty PiP until a preview source is available.
- Desktop production build, Web production build/typecheck/lint/i18n checks, workspace
  typecheck/lint, and actionlint: passed. Only pre-existing Web Rollup circular-chunk and
  large-chunk warnings remain.
- Built Electron fake and real smokes: first frame -> Hide -> Show -> first frame ->
  app blur/main-window minimize -> forced renderer crash/recreation -> acknowledged Stop ->
  terminal close passed. Hide -> Show preserves the same preview
  webContents, proving the normal release path received the renderer ACK instead of falling
  through the 500 ms forced-teardown fallback. The real lane also observes at least one live
  renderer MediaStream track before Hide, zero live tracks after the release ACK, and a live
  track again after Show.
- Fresh unsigned packaged macOS smoke: fake, real-window, primary-display, and the full
  capture-provenance matrix pass in both arm64 and x64 `.app` bundles and both mounted DMGs.
  Every real lane also proves app blur and main-window minimize retain the PiP, then
  force-crashes the renderer and requires a new renderer with a live MediaStream before
  continuing. The x64/Rosetta lane exposed hidden-renderer frame throttling and a cold
  mounted-DMG daemon startup that reached ready at about 7.98 seconds against the old
  8-second deadline. The preview now disables background throttling during connection,
  Hide still releases media, and the bounded daemon startup window is 20 seconds.
- The preview renderer is loaded with a provisional `idle` snapshot before
  `platformAdapter.prepare()`. This lets the adapter bind the actual loaded main document's
  frame token, frame-tree node, renderer process/routing ids, webContents, dedicated Session,
  exact URL/origin, authorization expiry, descriptor identity, and prepare generation.
  A non-same-document main-frame navigation or requester destruction invalidates the grant.
- Packaged provenance denies wrong URL, wrong partition, a same-partition foreign renderer,
  audio, subframe/CSP escape, main-document reload/navigation, release interruption, expiry,
  and replay while permitting one authorized use. The adapter removes its navigation and
  destruction listeners after consumption/release/disposal; lifecycle profiling reports no
  residual listeners.
- Fresh unsigned macOS artifacts and SHA-256 (fixed artifact baseline @ `e20777f5`, not current-candidate hashes):
  - arm64 DMG: `e42b944b84bf67174d18dec422637cbde6988c4d2283f503597b09aae50727fb`;
  - x64 DMG: `a9e8aa208af6dc9baff96b9550166095660adc1b596c4f86544287ac0ca19258`;
  - arm64 ZIP: `6c9ac51d212a7a4b930cf8bcb8c93f7e4b4f07bb17b93d1205f01b2ff99face5`;
  - x64 ZIP: `49a8bc3d5dce9def59c49b7a53f9fb31fea72e960dd9e99f806809d995bb695e`.
- A historical unsigned Windows cross-package produced a PE32+ x86_64 `Ling Stack.exe`
  and an NSIS installer with no embedded certificate table. The bundled Cua Driver
  plugin shell is present. Its fixed application and installer SHA-256 values are retained
  as `baseline @ e20777f5`: the unpacked application hash is
  `3f6ad1bbb45816bb46b15d2e23eb7a60843eb2a8fbc25ae0e541fb29af1d596e`, and the
  installer SHA-256 is `52b115f2ef02394ed0e352c28f60052ec572eec02f708c2a942bd64d9b4de5e2`.
  This is static cross-package evidence only; it does not prove Authenticode,
  installation, execution, provider capture, or SmartScreen behavior on Windows.
- Branded artifact chrome: both macOS bundles embed the committed Ling `icon.icns`; the
  Windows app and NSIS embed all nine committed `icon.ico` frames instead of Electron's
  default icon. Windows is explicitly one-click/per-user/asInvoker with no elevation helper.
  Both DMGs pass `hdiutil verify`; both ZIPs pass `unzip -t`; mounted DMGs pass fake and
  real capture plus provenance. `CFBundleIdentifier` is `com.lingstack.desktop` and
  architectures match. The Vite preview build empties its dedicated `outDir`; the final
  `app.asar` preview subtree contains exactly seven current entries and no stale hashed asset.
- macOS real-window smoke: current dev Electron plus fresh packaged arm64/x64 and
  mounted arm64/x64 DMG runs pass first frame -> Hide -> Show -> descriptor revision 1 to 2 -> stale old
  source close isolation -> native current-track `ended` -> stalled without stopping the
  runtime -> acknowledged Stop -> terminal close. Separate current-host dev, packaged `.app`,
  and mounted-DMG runs capture the primary display through an explicit display source and
  pass first frame, Hide/Show, blur/minimize retention, renderer crash/recreation, and Stop.
  The Cua Driver native-window handoff passes in dev Electron and both packaged arm64/x64
  `.app` lanes. Electron's source id is used only as the test oracle; the Ling descriptor
  receives only Cua's numeric `nativeWindowId` and provider-reported owner PID, with no title,
  foreground-window, or z-order fallback. Signed TCC, capture indicator, and app restart are
  still separate release evidence.
- Screen permission probe: dev Electron and unsigned arm64/x64 packaged candidates report
  `granted` on the current machine. This is current-host evidence, not a signed release TCC
  guarantee, and the implementation does not mutate TCC.
- Renderer visual baseline: min/default/max (`320x200`, `420x263`, `480x300`), the
  default-size Stop-failed recovery state, and an explicitly emulated reduced-motion state
  in light and dark modes, **10/10 screenshots**, verified on macOS arm64. Live chrome
  is content-first and appears on hover/focus;
  non-live recovery states remain persistent.
- In-process performance harness: 25,000 layout placements averaged about **6.37 µs** on
  the current machine; 100 coordinator open/close cycles left **0 windows**, **0 listeners**,
  and about **257 KB** heap growth.
- Real Electron fake-source harness: five measured lifecycles produced 25 first-frame
  samples with a latest local p95 of **415.27 ms**, created 15 measured BrowserWindows,
  forced five renderer crashes, and ended with zero process, BrowserWindow, renderer,
  listener, IPC, timer, subscription, or adapter-source residue. Adapter disposal passed
  **5/5**. Heap grew about **288 KiB**, RSS about **5.7 MiB**, and aggregate Electron working
  set about **11.8 MiB**, all below explicit harness thresholds. This is the fake-source
  ownership/crash lane only; it is not the real capture latency result.
- Current-host real MediaStream harness: the first decoded frame measures **168.09 ms p50 /
  177.84 ms p95**, and Hide-to-release measures **2.16 ms p50 / 3.65 ms p95**. The renderer
  passes 30 fps / 960×600 constraints in the initial `getDisplayMedia()` call, reuses one
  loaded document, and uses an identity-bounded 16 ms `readyState >= HAVE_CURRENT_DATA` poll
  so hidden/occluded windows do not wait on delayed `loadeddata` or
  `requestVideoFrameCallback`. Hide, revision replacement, reconnect, and teardown cancel the
  poll without weakening the decoded-frame gate.
- The real lane's 30-second active-versus-hidden measurement records **0.21%** summed positive
  per-process CPU delta and **11,763,712 B** active working-set overhead. Ten-cycle Show/Hide
  churn records **6.04%** main-process CPU and **17,661,952 B** app working-set growth. Twelve
  source activations perform exactly **12** descriptor-matching source enumerations, reuse
  **1** renderer document, make **0** post-acquisition `applyConstraints()` calls, and finish
  with **0** process, BrowserWindow, renderer, raw-listener, IPC, timer, subscription,
  adapter-source, or live-track residue. This remains current-host development-Electron
  evidence; signed packaged macOS and Windows profiling remain G6 release gates.
- Package signatures are not release-valid: arm64 is ad-hoc/linker-signed with
  `Identifier=Electron`, x64 is unsigned, neither has a Team ID, strict verification fails,
  and `spctl` rejects them. A Developer ID identity is still required.
- `git diff --check`: passed.

These close the local G4, unsigned-artifact, packaged-provenance, and current-host performance
work. They do not close signed macOS TCC/capture-indicator evidence, the Windows interactive
provider/DPI/dual-display matrix, Developer ID/notarization/Gatekeeper,
Authenticode/SmartScreen/signed NSIS, hosted CI, clean-machine install/update/uninstall, or
VoiceOver/Narrator/NVDA, external detached-signature, or real candidate-daemon provenance gates.

### Capture stability decision (2026-07-16)

- [x] Keep the preview renderer and Electron capture handler on the same dedicated,
  non-persistent `ling-computer-use-preview` partition for V1. With the display explicitly
  awake, the current code passes the real first-frame/Hide/Show/Stop smoke on this partition.
- [x] Treat `session.defaultSession` as a diagnostic A/B only, not the production fix. The
  main Ling window already uses the default Session, and Electron's display-media handler is
  Session-scoped. Moving the capture grant there without request provenance would expand the
  capture permission surface to every default-Session renderer.
- [x] Load a provisional `idle` snapshot before `prepare()` so the adapter authorizes the
  actual loaded PiP document rather than a future renderer identity.
- [x] Bind each display-media request to the exact current main document: frame token,
  frame-tree node, renderer process id, routing id, webContents, dedicated Session, exact
  frame URL/security origin, session and descriptor identity, authorization expiry, and
  prepare generation. A non-same-document main-frame navigation/reload or requester
  destruction invalidates the grant. The grant is single-use; release or disposal
  invalidates it, while adapter disposal also calls `setDisplayMediaRequestHandler(null)`.
  Dev, both unsigned `.app` architectures, and both mounted DMGs deny the full packaged
  provenance matrix, authorize one exact use, and deny replay.
- [x] Keep the first-frame gate tied to decoded current data. A 16 ms identity-bounded
  `readyState >= HAVE_CURRENT_DATA` poll covers hidden/occluded Chromium scheduling without
  accepting an undecoded frame; Hide, revision replacement, reconnect, and teardown stop it.
- [x] A sleeping display is a supported zero-frame condition: ScreenCaptureKit can leave the
  MediaStream track `live` while delivering no frames. Do not wake the user's display or Stop
  the runtime. The one-second first-frame watchdog enters bounded reconnect; after at most ten
  seconds the preview hides and releases media while Computer Use continues.
- [x] Cover full ten-second first-frame exhaustion: 250 ms, 500 ms, 1 second, and 2 second
  bounded retries cannot extend the absolute recovery deadline; expiry releases and hides
  without Stop. Hide, terminal, and a new descriptor revision cancel retained callbacks.
- [x] V1 does not listen for `resume`/`unlock`/user-active events and never wakes the
  display. After expiry, recovery requires explicit Show/Retry, a new descriptor identity,
  or an explicit Desktop restart.

### Renderer crash recovery slice (2026-07-16)

- [x] Subscribe to Electron `render-process-gone` through the Desktop window boundary;
  renderer details never cross preload or the shared Web surface.
- [x] On a crash, tolerate a dead `webContents`, release the platform source, detach the
  old crash listener, destroy the old BrowserWindow, and re-enter the normal first-frame
  gate.
- [x] Allow at most one automatic recreation per active `sessionId`; a second crash leaves
  the runtime running but blocks an automatic loop. Explicit `Show preview` clears only
  that block and remains a manual recovery path.
- [x] A real Electron fake-source harness now covers native Close/reopen, revision,
  force-crash, one-time recreation, first-frame latency, and zero active-resource residue.
- [x] Fresh unsigned arm64/x64 `.app` and mounted-DMG fake/real smokes force one renderer
  crash, require bounded recreation, and continue only after the replacement first frame;
  real lanes additionally require a live replacement MediaStream track.
- [~] Signed/notarized real MediaStream process and capture-indicator profiling remains part
  of Stage C/D release hardening.

### Windows provider audit (2026-07-16)

The provider decision is now closed in favor of the maintained open-source
`trycua/cua-driver-rs` provider, pinned for the Ling integration at the exact reviewed
`v0.8.3` asset and SHA-256. Unreviewed newer versions fail closed until a provider-upgrade PR
replaces the allowlist and evidence atomically.
Its published Windows x86_64 artifact contains `cua-driver.exe`, its MCP entrypoint is
`cua-driver mcp`, and its Windows `list_windows` structured output carries explicit
`window_id` (HWND) and `pid` values. The provider implements the native UIA/Win32/DXGI
capture and automation path; Ling does not copy or bundle that implementation.

Electron 43.1.1 `desktopCapturer` remains the PiP presentation/capture adapter. The Ling
plugin manifest, catalog/install/apply gates, Windows `PATH`/`PATHEXT` command resolution
limited to direct-spawn `.exe`/`.com` files, exact source-ID matching, canonical HWND/PID
validation, descriptor-bound Windows preflight, and a health/A-B revision/restart smoke
runner are now integrated. The current
machine still cannot execute the Windows provider path or prove source-ID mapping,
source-ended handling, topology changes, interactive-session health, or provider signing,
so G3 remains a VM/release gate rather than a local green check.

Do not claim cross-platform real capture until the Windows x64 matrix passes. Do not use
`useSystemPicker`, foreground-window inference, z-order, or title matching as a fallback.

### P0 blocker closure and local semantic follow-up

1. **Preview IPC ownership:** closed in the current branch; Stop accepts the preview
   sender and Hide/Reset are sender-scoped.
2. **Event-loss race:** closed for the current projection path with atomic snapshot/sequence
   handling and subscribe-before-replay tests.
3. **Source-failure cleanup:** closed for stale revisions, media release, retry cancellation,
   and terminal error linger.
4. **Daemon compatibility:** closed for authenticated bridge handshake and fail-closed reuse.
5. **Computer Use route exposure:** closed for the current boundary; local Origin/no-CORS
   checks protect browser calls, and native no-Origin calls require
   `X-Ling-Computer-Use-Token`. The private descriptor endpoint retains its separate bridge
   token and no-CORS policy.
6. **Provider distribution boundary:** closed for V1. Ling packages only the public Cua
   Driver plugin shell metadata; the executable, native application, permissions, and update
   channel remain separately installed provider responsibilities. Resource resolution and
   structured missing-binary failure are covered; clean-machine provider installation and
   signed real-capture verification remain release gates.
7. **Reconnect lifecycle race:** closed for pending and in-flight retries. Hide records
   suppression before async persistence, reconnect work is serialized with projection
   reconciliation, and permission/prepare awaits revalidate session, descriptor revision,
   selection, and suppression before changing source state.
8. **Packaged x64 cold start:** closed for the reproduced Rosetta/DMG boundary. The bundled
   daemon remains bounded but now has a 20-second readiness window instead of racing an
   observed 7.98-second cold start at an 8-second deadline.
9. **Capture request provenance:** closed. The single-use grant is bound to the current PiP
   requester, source revision, URL/origin, Session, expiry, and prepare generation; release
   and disposal invalidate it, and a foreign same-partition renderer is denied.
10. **Obstacle priority transport:** closed. Web kinds survive preload/types/IPC sanitizer
    into layout scoring; `right-dock` canonicalizes to `dock`, `summary` to `popover`, and
    malformed or unknown input is filtered or normalized safely.
11. **Post-timeout reopen eligibility:** closed for the safe V1 baseline. Ten-second expiry
    writes a session/descriptor/revision block before release, hides without Stop, and
    ordinary reconciliation cannot reopen it. Explicit Show and a new descriptor revision
    clear the block; explicit Retry and Desktop restart are also user-driven recovery paths.
    V1 intentionally has no resume/unlock/user-active automatic retry.
12. **Fail-safe coordinator disposal:** closed. The coordinator enters quiescing before any
    await, rejects late ingress, contains throwing subscription/display cleanup, drains the
    serialized queue, disposes the adapter exactly once, and clears timers/listeners/state
    again after teardown. Desktop shutdown keeps IPC registered until disposal completes and
    continues all later cleanup before rethrowing the first error.
13. **Renderer media-release acknowledgement:** closed for the local privacy protocol. Main
    sends an exact request identity and waits at most 500 ms. The renderer invalidates the
    acquisition generation, stops current and late-arriving streams, verifies every observed
    track is ended, and ACKs through sender-validated IPC. Timeout, negative ACK, conflict,
    send failure, or adapter failure destroys the exact BrowserWindow without sending Stop.
    Signed macOS capture-indicator evidence remains part of the platform release gate.
14. **Host-layout IPC bounds:** closed locally. Main rejects non-positive/extreme dimensions
    and out-of-range extents while preserving legitimate negative multi-display coordinates,
    caps input at 128 obstacles, strips unknown fields, normalizes unknown kinds, and replaces
    malformed, stale, or excessive-future timestamps with a main-process timestamp.
15. **Descriptor response validation:** closed. The private HTTP response is parsed through
    a complete runtime schema for platform, source kind, usable target identity, grant id,
    canonical non-expired authorization, descriptor id, and safe revision. A fresh allowlisted
    object reaches the adapter; malformed or mismatched input fails closed.
16. **Provenance negative matrix:** closed at the deterministic unit boundary. Coverage now
    includes subframe, missing/foreign webContents, URL/query/origin, partition, audio shape,
    expiry, detached/navigation identity, release/dispose interruption, late rearm, and replay.
    The packaged real Electron form of the full matrix remains G4/G6 evidence.
17. **Same-revision descriptor replacement:** closed. Desktop allocates a monotonic local
    `sourceGeneration` for every activation, carries it through snapshot/media/release and
    frame/activity/ended/failure IPC, and rejects every stale-generation callback without
    exposing `descriptorId` to the renderer.
18. **Preference persistence on safety actions:** closed. Hide/Close/auto-show-off apply
    media/window safety first and persist best-effort afterward. Rejected persistence returns
    `desktop_preferences_not_persisted` without undoing the privacy action.
19. **Linger cleanup ownership:** closed. Terminal and source-error callbacks run through the
    serialized coordinator queue and bind to the exact captured window/session/descriptor/
    revision/generation. A newer active session preempts an older terminal linger, while an
    older active projection cannot destroy the newer terminal surface.
20. **Final local product surface:** closed. Show/Hide/Stop lives in the current-session header
    for channel, normal conversation, and teammate-direct surfaces. `Close window` exists only
    in PiP More, destroys the preview without Stop, and is separated visually from the Stop
    action. Teammate-direct composer/summary/dock/terminal geometry is reported and covered by
    focused Web E2E.
21. **Authoritative lifecycle source:** closed. Projection state comes from the trusted,
    authorized MCP definition and run approval events rather than a lifecycle `rawName`
    whitelist. The implemented sequence is `starting -> waiting_for_approval -> starting ->
    running -> terminal`. `paused` remains reserved and must not be inferred from Hide,
    approval wait, or intervention behavior. Hide changes presentation/media only, while
    `interrupt_redirect` follows `stopping -> cancelled`.
22. **Stop negative acknowledgement:** closed. If the runtime returns `ACK=false`, daemon
    projection returns to active and the endpoint returns HTTP 504. Desktop reports failure,
    keeps the current session truthful, and allows the user to retry Stop.
23. **Preview availability and exact-window identity:** closed. Active `starting` and
    `waiting_for_approval` sessions remain in the shared summary when no preview descriptor
    exists, but Desktop never creates an empty PiP. Any source, release, or acknowledgement
    carrying a mismatched exact window identity fails closed without touching a replacement.
24. **Drag snap and source shape:** closed locally. Drag end starts a 180 ms settle timer,
    snaps to the best of four corners, and persists the preferred corner. Window aspect-ratio
    updates use `setAspectRatio`, and portrait source dimensions remain bounded and visible.

### Remaining delivery plan and timebox

The local security, lifecycle, state-hygiene, renderer-locale, Close semantics, and shared-UI
placement are frozen by tests. Remaining work is platform and release evidence that depends
on external identities, VMs, providers, or certificates; its timeboxes are calendar estimates
rather than promises.

| Stage | Timebox | Deliverable | Exit gate |
| --- | --- | --- | --- |
| A0. Local security and unsigned baseline | complete | requester-bound capture grant and handler disposal, obstacle-kind transport, absolute ten-second exhaustion, fixed-port daemon recovery, fresh G0/G1/G4 rerun, and fresh unsigned macOS arm64/x64 packages | foreign renderer denied; grant replay denied; final pre-commit local matrix is green; fixed `e20777f5` artifact hashes remain historical baselines rather than current candidate hashes |
| A1. Lifecycle semantic and privacy lock | complete locally | post-timeout session/revision block; fail-safe/quiescent coordinator and Desktop shutdown; exact renderer media-release request/ack with pending-acquisition drain, 500 ms timeout, exact-window mismatch denial, forced exact-window destroy, and Stop negative-ack recovery | ordinary projection updates cannot reopen after timeout; Show/revision recovery works; shutdown leaves zero timers/sources; Hide/Close waits for ACK or forced teardown; `ACK=false` restores active, returns 504, and leaves Desktop retryable; fake and real smoke reuse the acknowledged renderer |
| A2. Local contract and state hygiene | complete | trusted authorized MCP plus approval-event lifecycle projection, no `rawName` whitelist, reserved `paused`, truthful visibility snapshot/intent, pure activation/presentation selector, summary-only active states without empty PiP, terminal suppression pruning, bounded host-layout input, full descriptor runtime schema, and expanded provenance-negative matrix | all 896 selector combinations pass; `starting`/`waiting_for_approval` summary remains visible without a preview window; initial first-frame recovery stays hidden; visible reconnect and summary remain aligned; revision-stale callbacks fail closed |
| A3. Source identity and coordinator hardening | complete locally | Desktop-local source generation across snapshot/media/release/lifecycle IPC; stale same-revision descriptor events and exact-window mismatches rejected; safety actions precede preference persistence; linger cleanup is serialized and exact-source-bound; crash cleanup reconciles after release errors; newer active session preempts old terminal linger; fixed-port foreign-service and early-child-exit detection | source-generation renderer/IPC/coordinator regressions pass; no old descriptor event can reveal/fail the replacement or destroy a newer session; media hides/releases even if preference save fails; active summary survives cleanup errors; startup fails fast on occupied port or child exit |
| B1. Shared UI and PiP control acceptance | complete locally | current-session header Show/Hide/Stop, summary-only starting/approval states, PiP-only Close window, menu separation, responsive 34 px actions, 180 ms drag-end four-corner snap, preferred-corner persistence, source aspect-ratio/portrait handling, and channel/normal/teammate-direct obstacle reporting | G1/G4/G5 non-platform cases pass; no preview descriptor means no empty PiP; Close destroys PiP and never sends Stop; capability stays a narrow shared-Web slot rather than a Desktop UI fork |
| B2. Windows visual acceptance | blocked with G3 | Windows screenshot, DPI, dual-display, placement, and real-source acceptance | Windows x64 VM visual and geometry matrix passes with the selected real provider |
| C1. Signed macOS acceptance | ~1 day after identity and clean hosts are available | Developer ID arm64/x64 candidates, notarization, TCC denied/prompt/granted/revoked, window/display/restart, OS capture indicator, VoiceOver, and signed real-media profiling | G2 plus the macOS half of G5/G6 pass with archived logs, screenshots, profiles, and signed artifacts |
| C2. Windows VM/provider acceptance | ~1–3 days after provider and VM are available | pinned separately installed Cua Driver provider, x64 real-source lifecycle, DPI/dual-display visuals, Narrator/NVDA, restart, source-ended, Authenticode/SmartScreen evidence | G3 plus the Windows half of G5/G6 pass with VM logs, screenshots, accessibility notes, and signed artifacts |
| D. Release hardening | ~1 day after C1 and C2 | hosted CI, signed DMG/ZIP and NSIS, checksums, clean-machine install/update/uninstall, final cross-platform performance and accessibility evidence | G6 artifacts install and meet security, latency, CPU, memory, visual, and accessibility budgets |

Do not call the feature cross-platform complete after B1. A working Electron package on
Windows is not evidence of a Windows Computer Use source provider or B2 visual acceptance.

### Acceptance gates

1. **G0 基础绿**：contracts/API/daemon/Desktop unit tests and typechecks are green.
2. **G1 Fake lifecycle**：`starting`/`waiting_for_approval` summary without empty PiP → active → first frame → Hide/Close (no Stop) → Show → Stop ack → terminal, plus Stop `ACK=false` → active/HTTP 504/Desktop retry, revision, route, stall, crash, exact-window mismatch, and leak cases.
3. **G2 macOS capture**：clean-machine external Cua Driver resolution/health, TCC denied/prompt/granted/revoked, approved window/display, visible OS capture indicator, source-ended, revision replacement, and app restart.
4. **G3 Windows provider**：the selected Cua Driver Windows provider, descriptor-bound preflight, and x64 VM smoke; Electron packaging alone is not evidence of Computer Use support.
5. **G4 Recovery/security**：daemon restart/SSE epoch, renderer crash, one-second watchdog plus ten-second absolute deadline, no ordinary reconcile reopen after expiry, Hide/terminal/revision cancellation, exact source-generation and exact-window mismatch rejection across same-revision descriptor replacement, fail-safe quiescent disposal under throwing cleanup, release acknowledgement or forced renderer teardown, Stop negative-ack active restoration, navigation/CSP, bridge-token compatibility, descriptor runtime validation, IPC sender ownership, subframe/wrong-URL/wrong-partition/expired/navigation provenance denial, single-use grant/replay denial, and adapter disposal.
6. **G5 UI/layout**：typed obstacle markers with preserved priority; `right-dock -> dock` and `summary -> popover`; malformed/unknown input filtering; positive/bounded geometry and obstacle-count limits; four-corner collision avoidance; 180 ms drag-end snap and preferred-corner persistence; drag/resize/two-display persistence; `setAspectRatio` and portrait-source handling; truthful visibility intent; keyboard semantics; light/dark/reduced-motion; real VoiceOver on macOS and Narrator plus NVDA on Windows.
7. **G6 Release**：macOS arm64/x64 and Windows x64 artifacts, strict code-sign verification, Team ID and bundle identifier, Gatekeeper/notary/NSIS checks, SHA-256, CI, clean install/update/uninstall, measured performance budgets, OS capture-indicator evidence, and archived platform accessibility acceptance.

Depends on:

- [Desktop Shell](desktop-shell.md)
- [Desktop Computer Use Picture-in-Picture](desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](desktop-computer-use-picture-in-picture-detailed-design.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)
- [Desktop Release Acceptance](../release/desktop.md)

## Implementation Verdict

Implement one cross-platform presentation shell with public APIs first. Keep Computer Use
runtime authority in the daemon and capture/window resource ownership in Desktop.

The intended complete release target remains macOS and Windows, but support is
provider-gated: macOS is the current real-capture candidate; Windows stays behind the
selected provider installation and x64 smoke gate. The target release must provide:

- one active preview for the selected conversation;
- real approved-source capture;
- automatic show after first frame;
- deterministic hide, close, stop, terminal, and recovery behavior;
- current-session summary visibility before a preview descriptor exists, without an empty
  BrowserWindow;
- no private macOS or Windows APIs;
- exhaustive selector, lifecycle, timer, and fake-adapter E2E coverage.

## Foundation Prerequisites

The minimal Desktop foundation is now satisfied and retained as a regression boundary:

- Electron main, preload, and renderer entry points;
- a main BrowserWindow that loads the shared Web UI;
- context isolation, renderer sandboxing, and a narrow preload bridge;
- daemon base-URL injection and compatible daemon reuse/startup;
- Desktop-local preference storage;
- a testable BrowserWindow factory.

Unsigned macOS arm64/x64 `.app`, DMG, and ZIP production builds now exercise this
foundation. Signing, notarization, Windows packaging, and clean-machine distribution are
release gates, not missing shell prerequisites.

Do not block this feature on tray, keychain, updates, pets, or a complete Desktop settings
surface.

## What Already Exists

- The Desktop alpha already loads the same Web build used by the browser; the plan reuses
  that surface and does not create a parallel conversation UI.
- The daemon control plane already provides structured Computer Use projections sourced from
  trusted authorized MCP definitions plus run approval events, snapshot and SSE recovery,
  negative-acknowledgement active restoration with HTTP 504, and an authenticated Desktop
  bridge handshake. `paused` remains reserved and no lifecycle `rawName` whitelist remains.
- Desktop daemon startup is single-flight. A healthy but incompatible external daemon is
  never killed and never bypassed with a second workspace control plane; Desktop shows a
  native Retry/Quit recovery prompt on the fixed port.
- The Desktop main process already owns the PiP BrowserWindow, source revisions, exact-window
  fail-closed checks, media cleanup, visibility suppression, stall retry, placement, Reset,
  display topology, and the rule that summary-only active states do not create an empty PiP.
- The dedicated renderer already covers runtime/source overlays, controls, keyboard/a11y,
  light/dark/high-contrast, reduced-motion presentation, aspect-fit portrait sources, and a
  typed local `en-US`/`zh-CN` catalog driven by locale in the sanitized snapshot. Desktop
  applies source shape through `setAspectRatio`.
- The shared Web surface already reports the selected conversation, exposes current-session
  Show/Hide/Stop, reports initial/runtime locale changes through the narrow Desktop bridge,
  keeps `starting`/`waiting_for_approval` visible in the current-session summary even when no
  preview descriptor exists, and publishes real composer/dock/terminal/approval/modal
  obstacles. Its implementation is
  split into a lifecycle/summary/stale-command bridge, a host-layout observer hook, and a movable
  presentational control slot so final UI placement does not disturb Desktop lifecycle code.
- The current Cua Driver bundle contributes macOS/Windows plugin metadata and an opaque
  approved source descriptor, but it does not provide a continuous stream or bundle the
  external provider binary.

The remaining plan extends these paths. It must not introduce a second state store, infer
session state from transcript text, or guess the capture target from a window title.

## UI-Independent And UI-Bound Work

The main Ling UI is not a prerequisite for most implementation work.

### Implemented foundation

- minimal Electron main/preload/renderer shell;
- same-build Web application loading in the Desktop main window;
- Desktop capability provider with no generic IPC escape hatch;
- Computer Use contracts, daemon projection, and API-client subscription;
- selectors, visibility state machine, coordinator, timers, and persistence;
- authoritative MCP/approval lifecycle projection with reserved `paused` semantics;
- fake adapter and dedicated PiP renderer shell;
- normalized Web-to-Desktop locale transport and renderer-local `en-US`/`zh-CN` catalog;
- modular shared-Web bridge, host-layout reporter, and current-session header control slot;
- structured Desktop navigation-intent delivery with successful-selection-before-ACK semantics;
- PiP-only Close window action with preview-sender-scoped IPC and no Stop side effect;
- typed channel, normal-conversation, and teammate-direct obstacle markers;
- platform adapter boundary and lifecycle tests;
- fallback screen-corner placement when no host layout exists;
- 180 ms drag-end corner snapping, preferred-corner persistence, and source aspect-ratio/
  portrait handling.

### Remaining local work

- No known local product-function gap. Re-run the focused and full local matrix whenever the
  shared header, PiP menu, coordinator, IPC, or geometry markers change.
- Before release evidence can be trusted, build the ignored `packages/daemon/dist` tree from
  the clean candidate commit and bind its deterministic fingerprint, or execute only the
  daemon embedded in the signed candidate package.

### Future shared-UI synchronization

- Keep Show/Hide/Stop in the current-session header unless product design intentionally
  selects a replacement current-session surface.
- Preserve `useDesktopNavigationIntents`, structured `open_conversation` selection, and
  successful-selection-before-ACK behavior during route refactors; move only the capability
  slot and typed geometry markers otherwise.
- Keep Close inside PiP More and separate from Stop.
- Treat PiP token/motion polish and Windows screenshot baselines as acceptance work, not a
  reason to reopen daemon, coordinator, or capture contracts.

This partition is a sequencing rule. The local shared-UI entry and obstacle reports now pass;
release completion still requires real platform and distribution evidence.

The real-source capability check and selected adapter path are recorded in
[Desktop Computer Use PiP Source Spike](./desktop-computer-use-picture-in-picture-source-spike.md).

## Original Slice 0–7 Traceability

The historical product slices remain the scope boundary. Slices 0-6 are complete locally.
Slice 7 has also completed its local G4, unsigned packaging, provenance, and performance
work; only external platform and distribution evidence remains.

| Original slice | Current evidence | Status |
| --- | --- | --- |
| Slice 0 — source spike | Source-spike decision, opaque descriptor contract, provider archive verifier, schema-v1 health parser, and current-host Cua native-window identity mapping | Complete locally |
| Slice 1 — Desktop shell | Shared Web loading, daemon ownership, preload bridge, PiP BrowserWindow, build and typecheck | Complete locally |
| Slice 2 — contracts and daemon projection | Trusted authorized MCP/approval-event projection, reserved `paused`, snapshot/SSE replay, scoped native routes, Stop acknowledgement including negative-ack active restoration/HTTP 504; final pre-commit contracts **5/5**, API client **48/48**, and full daemon **629/629** | Complete locally |
| Slice 3 — coordinator and fake lifecycle | Show/Hide/Close/Stop state machine, summary-only active states without empty PiP, first-frame gate, recovery, exact-window/revision identity, leak checks, Desktop Node **291/291**, fake smoke | Complete locally |
| Slice 4 — renderer and layout | PiP renderer **20/20**, 10/10 light/dark/reduced-motion screenshots, collision/obstacle reporting, 180 ms drag-end corner snap, preferred-corner persistence, source aspect-ratio/portrait handling, display persistence, provisional-idle startup, and decoded-ready polling | Complete locally; Windows visual/DPI evidence is an external acceptance gate |
| Slice 5 — real cross-platform capture | Exact document/navigation-bound grants; dev and unsigned arm64/x64 `.app` plus mounted-DMG window/display/provenance smokes; both packaged `.app` Cua native handoffs; Windows descriptor/provider boundary | Complete locally; signed TCC and Windows interactive provider execution remain external |
| Slice 6 — shared UI binding | Current-session capability slot for channel, normal conversation, and teammate-direct surfaces; final pre-commit Web E2E **35/35** | Complete locally |
| Slice 7 — production closure | Local G4 recovery/security, fake and real performance, packaged provenance, final unsigned macOS/Windows artifacts, integrity checks, release manual, and SHA-256 files | Local closure complete; signing/TCC, Windows VM/provider/DPI, legal Publisher/signing service, any separate enterprise per-machine artifact, hosted CI, clean-machine acceptance, external detached signatures, and real candidate-daemon provenance remain external |

## Foundation Slice: Minimal Desktop Shell

Goal: create only the Desktop infrastructure required for shared UI reuse and PiP.

Tasks:

1. Scaffold `@ling-stack/desktop` with Electron main, preload, renderer bootstrap, tests,
   and packaging placeholders.
2. Load the existing built Web application in the main BrowserWindow rather than copying
   its routes or feature components.
3. Inject a narrow `LingDesktopCapabilities` bridge with capability absence as the normal
   browser path.
4. Add daemon base-URL injection, compatible reuse/start behavior, clean shutdown ownership,
   and fixed-port Retry/Quit recovery for an incompatible external daemon.
5. Add Desktop-local preference storage and a testable BrowserWindow factory.
6. Add a dedicated PiP renderer entry that initially uses shared tokens and fake media.
7. Verify browser Web still builds and runs without Desktop globals.

Done when:

- Browser and Desktop main window use the same shared Web UI revision.
- No copied conversation page or Desktop-owned product state exists.
- PiP can be opened with fake state without depending on final toolbar or dock layout.
- Renderer sandbox and preload boundaries are covered by tests.

## Slice 0: Preflight And Contract Lock

Goal: prevent implementation from deriving Computer Use state from UI text or tool labels.

Tasks:

1. Confirm the minimal Desktop shell branch and packaging targets: macOS arm64/x64 and
   Windows x64.
2. Add `packages/contracts/src/computer-use.ts` with runtime status, preview projection,
   target metadata, and opaque descriptor contracts.
3. Export the contract from `packages/contracts/src/index.ts`.
4. Define daemon authority:
   - runtime/session status;
   - conversation/run/work-unit attribution;
   - approval state;
   - preview descriptor revision;
   - stop acknowledgement, including `ACK=false` active restoration and HTTP 504.
5. Bind lifecycle status to trusted authorized MCP definitions and run approval events. The
   current sequence is `starting -> waiting_for_approval -> starting -> running -> terminal`;
   remove lifecycle `rawName` allowlisting and keep `paused` reserved until an authoritative
   runtime event exists. Hide is presentation-only, and `interrupt_redirect` maps through
   `stopping -> cancelled`, not pause.
6. Define Desktop-local authority:
   - visibility intent;
   - window state;
   - source handle;
   - layout and preferences.
7. Add contract serialization tests for every status and optional field without synthesizing
   a production `paused` event.

Done when:

- Desktop can consume one structured projection without parsing transcript content.
- `starting` and `waiting_for_approval` can remain visible as summary-only active states when
  no preview descriptor exists.
- Raw native handles and unrestricted desktop source IDs are absent from public DTOs.
- Hide, close, and stop semantics are represented separately.

## Slice 1: Daemon Preview Projection

Goal: expose the latest active Computer Use presentation state through the existing local
control plane.

Tasks:

1. Add the daemon feature boundary implemented by `features/computer-use/registry.ts`,
   `cua-driver-producer.ts`, and `routes.ts`.
2. Accept normalized Computer Use runtime events only from a trusted authorized MCP
   definition and run approval events; do not classify lifecycle from `rawName`.
3. Maintain one latest projection per `sessionId` and index active sessions by
   `conversationId`.
4. Publish projection changes through the control-plane event stream.
5. Add snapshot/read support for reconnecting clients.
6. Add an audited stop endpoint or RPC method that delegates to the runtime owner.
   A negative acknowledgement restores the projection to active and returns HTTP 504 so
   Desktop reports failure and permits retry.
7. On daemon restart, restore only durable active-session identity supported by the
   runtime supervisor. Do not restore frame descriptors that are no longer valid.
8. Add tests for:
   - `starting -> waiting_for_approval -> starting -> running -> terminal`;
   - reserved `paused` remains unselected without an authoritative runtime event;
   - active summary projection with no preview descriptor;
   - descriptor revision replacement;
   - duplicate and out-of-order events;
   - stop accepted, `ACK=false` active restoration/HTTP 504, rejected, and failed;
   - control-plane subscriber reconnect.

Done when:

- Web or Desktop clients can obtain the authoritative current projection.
- Terminal sessions do not appear as active after the linger information has been
  delivered.
- Starting/approval-wait sessions remain discoverable to shared UI without claiming a
  preview source.
- A stop request is attributable and auditable.

## Slice 2: Shared Selection And Visibility Logic

Goal: make all show/hide decisions pure, deterministic, and testable without Electron.

Tasks:

1. Add pure functions for:
   - active presentation selection;
   - active-summary versus preview-window eligibility;
   - terminal-status classification;
   - effective visibility;
   - terminal linger duration;
   - reconnect eligibility.
2. Keep per-session visibility intent in a small Desktop state store.
3. Persist only hidden session suppression with a 24-hour expiry; clear it on terminal
   acknowledgement.
4. Add fake-clock tests covering:
   - first frame auto show;
   - global auto show disabled;
   - explicit Show override;
   - user Hide and window Close suppression;
   - route switch;
   - app blur and minimize;
   - starting, approval wait, running, stopping, and reserved-paused non-synthesis;
   - success, failure, cancellation, and permission timers;
   - hide-before-first-frame;
   - hidden suppression across Desktop restart and expiry;
   - terminal event during reconnect.

Done when:

- No BrowserWindow code contains independent visibility policy.
- Summary visibility and PiP eligibility are separate outputs, so a missing descriptor never
  produces an empty window.
- Every row in the detailed-design event matrix has a test.

## Slice 3: Desktop Preview Coordinator And Window

Goal: create a secure, reusable picture-in-picture BrowserWindow lifecycle.

Tasks:

1. Add `ComputerUsePreviewCoordinator` in Desktop main.
2. Add a BrowserWindow factory with:
   - context isolation;
   - renderer sandbox;
   - no Node integration;
   - no taskbar entry;
   - documented always-on-top level;
   - deterministic destroy and renderer-crash cleanup.
3. Subscribe to daemon projections and main-window route selection.
4. Keep `starting`/`waiting_for_approval` in the shared summary when no preview descriptor
   exists, but create no BrowserWindow until descriptor, source readiness, and first frame are
   available.
5. On an eligible conversation/session switch, hide and destroy the previous preview, then
   recreate it for the new session. Same-window cross-fade/reuse is deferred visual polish.
6. Hide and release tracks when user-hidden or route-ineligible.
7. Destroy on Desktop quit and after terminal linger.
8. Add main-process tests with fake BrowserWindow and fake adapter.
9. Fail closed on exact-window identity mismatch for source callbacks, media release, and
   acknowledgement; never mutate or destroy a newer replacement window.

Done when:

- Window close destroys the preview window without sending stop.
- Stop is sent only from the explicit stop command.
- A summary-only active session never opens a blank PiP.
- Exact-window mismatch cannot release, fail, or destroy the replacement source.
- Ten open/close cycles leave no live tracks, listeners, timers, or orphan windows.

## Slice 4: Shared Electron Capture Boundary

Goal: stabilize one public-API capture boundary and close the macOS path first. The
Windows implementation uses the selected Cua Driver provider and remains conditional on
real x64 VM evidence; an Electron package alone is not an exit criterion.

Tasks:

1. Add `ElectronComputerUsePreviewAdapter` behind
   `ComputerUsePreviewPlatformAdapter`.
2. Resolve only the opaque descriptor supplied by the trusted runtime bridge and fail closed
   when the resolved native-window identity does not exactly match it.
3. Check capture permission before opening.
4. Limit first-version capture to:
   - 30 fps;
   - 960 x 600 maximum source size before presentation scaling;
   - cursor metadata only when the source already provides it safely.
5. Send the media channel to the dedicated preview renderer without exposing source
   enumeration to the renderer.
6. Close old tracks before opening a new descriptor revision.
7. Propagate trusted source dimensions so Desktop can apply `setAspectRatio`; portrait sources
   must remain bounded inside the same cross-platform renderer.
8. Normalize macOS and Windows errors into shared codes.
9. Add platform smoke tests:
   - macOS permission granted/denied;
   - Windows source open/end;
   - source window closes during capture;
   - display topology changes;
   - app shutdown cleanup.

Done when:

- A real approved window or display can be previewed on macOS.
- The selected Cua Driver Windows provider remains release-blocked until its VM evidence exists.
- Renderer code is identical across both platforms.
- Exact window mismatch is denied rather than falling back to title, foreground, or z-order
  matching.
- No private API is required.

## Slice 5: Preview Renderer And Controls

Goal: implement the Codex-like visual surface without copying proprietary assets or
platform-private behavior.

Components:

```text
ComputerUsePreviewWindow
  PreviewMediaSurface
  PreviewHeader
  ComputerUsePreviewStatusOverlay
  ComputerUsePreviewControls
  PreviewOverflowMenu
```

Tasks:

1. Render source with aspect-fit letterboxing, including portrait sources, while Desktop
   applies the trusted source shape through `setAspectRatio`.
2. Add live, approval-required, reserved paused, stopping, reconnecting, completed, failed,
   and permission-required overlays. The paused visual contract remains available for a future
   authoritative runtime event, but current lifecycle adapters must not synthesize it.
3. Add controls:
   - Open task;
   - Hide preview;
   - More;
   - Reset position;
   - Screen permission settings;
   - Close window;
   - Stop Computer Use.
4. Keep controls hidden during ordinary live viewing and reveal them on hover, keyboard
   focus, or non-running states.
5. Add accessible labels, keyboard order, live regions, and reduced motion.
6. Ensure Escape closes menus only.
7. Add component tests and screenshot coverage at the default, minimum, and maximum
   sizes in light and dark modes.

Done when:

- Hide, Close, and Stop are visually distinguishable.
- No renderer is created solely to display a `starting` or `waiting_for_approval` state with
  no preview descriptor; those states stay in the shared summary.
- All non-live states remain understandable without relying on color.
- The preview works with keyboard-only navigation.

## Slice 6: Host Layout And Collision Avoidance

Goal: anchor the preview near the active conversation while avoiding important Ling UI.

Tasks:

1. Add main-renderer host and obstacle markers for:
   - conversation viewport;
   - composer;
   - right dock;
   - terminal panel;
   - modal and approval surfaces;
   - summary popovers.
2. Report geometry at most once per animation frame.
3. Add the four-corner candidate and six-iteration collision algorithm. After drag end, wait
   180 ms for movement to settle, snap to the best corner, and cancel stale snap timers when a
   new drag, display change, reset, hide, or teardown supersedes them.
4. Persist the snapped preferred corner, width, and normalized manual position per display.
5. Support drag, resize, Reset position, display disconnect, taskbar/dock work-area
   changes, and main-window movement.
6. Add deterministic geometry tests and Desktop E2E tests at:
   - 1280 x 800;
   - 1440 x 900;
   - 1920 x 1080;
   - two-display topology.

Current implementation note: `useDesktopComputerUseHostLayoutReporter` owns rAF
coalescing, ResizeObserver, MutationObserver, window/visualViewport resize and scroll,
ARIA-modal auto-marking, and full cleanup. Real dual-display/DPI and oscillation acceptance
remain open.

Done when:

- The preview never covers the composer or an approval sheet in automatic mode.
- Drag end snaps after 180 ms and the selected preferred corner survives reopening.
- Manual placement remains reachable after a display is disconnected.
- Window movement does not cause continuous position oscillation.

## Slice 7: Settings And Conversation Entry Points

Goal: let users understand and control preview visibility even when the window is hidden.

Tasks:

1. Add Desktop setting:
   - `Automatically show Computer Use picture-in-picture`;
   - default on;
   - Desktop-local, not a daemon execution policy.
2. Add the current-session control to the owning conversation header toolbar:
   - `Show preview` when hidden;
   - `Hide preview` when visible;
   - live status and target application, including summary-only `starting` and
     `waiting_for_approval` before a preview descriptor exists;
   - separate `Stop Computer Use` action.
3. Hide the section only when no active Computer Use session exists. A missing preview
   descriptor hides/disables preview presentation controls but does not remove the active
   summary or create an empty PiP.
4. Do not render historical completed sessions as available previews.
5. Report `en-US | zh-CN` through the narrow Desktop capability, validate it in main,
   include it in the PiP snapshot, and resolve renderer title/status/action/ARIA copy from
   the dedicated local catalog without restarting media.
6. Add tests for current-session-only visibility and global-setting override behavior.

Current implementation note: `DesktopComputerUseControlSlot` is presented through the
generic current-session header capability portal in channel, normal conversation, and
teammate-direct headers. `DesktopComputerUseBridge` retains capability subscription,
locale/selection reporting, and stale Stop request invalidation. Future movement of the slot
must not merge observer or Stop lifecycle state back into `AppShell` or the large workspace
views.

Done when:

- The user can always recover a hidden preview from the active conversation.
- The user can see that Computer Use is starting or waiting for approval even before a
  preview source exists.
- Settings off prevents auto-show but does not block explicit Show.

## Slice 8: Recovery, Telemetry, And Performance

Goal: make preview failures visible and prevent media leaks.

Tasks:

1. Add bounded reconnect backoff and one-loop-per-revision protection.
2. Add renderer-crash recreation once per active session.
3. Record privacy-safe local events:
   - preview_opened;
   - preview_hidden;
   - preview_closed;
   - preview_source_stalled;
   - preview_recovered;
   - preview_terminal_closed;
   - preview_stop_requested;
   - preview_stop_failed.
4. Do not include frame content, source titles beyond approved display label, clipboard
   content, or raw native identifiers.
5. Add performance harnesses for frame latency, CPU, memory, and cleanup.
6. Verify targets from the product design on both platforms.

Done when:

- Stalls recover or fail visibly.
- No silent terminal or permission failure exists.
- Performance and cleanup targets are measured, not assumed.

## Test Plan

### Unit

- contracts and serialization;
- trusted MCP/approval-event lifecycle mapping and absence of `rawName` classification;
- reserved `paused` is not synthesized by current lifecycle inputs;
- Hide and `interrupt_redirect` remain presentation-only and `stopping -> cancelled`
  respectively, never synthetic pause inputs;
- projection ordering and idempotency;
- Stop `ACK=false` restores active projection and maps to HTTP 504;
- presentation selection;
- active-summary versus preview-window eligibility with no descriptor;
- effective visibility;
- post-timeout eligibility clearing on Show/revision only;
- dispose/quiescing guards and exactly-once adapter disposal;
- terminal timers;
- reconnect backoff;
- collision scoring and clamping;
- 180 ms drag-end snap cancellation, corner choice, and preferred-corner persistence;
- `setAspectRatio` updates and portrait-source bounds;
- preference normalization.

### Integration

- daemon event -> API client -> Desktop coordinator;
- descriptor revision -> adapter replacement -> renderer snapshot;
- explicit stop -> daemon acknowledgement -> terminal close;
- explicit stop -> `ACK=false` -> active projection -> HTTP 504 -> Desktop failure and retry;
- permission denial -> settings recovery action;
- renderer crash -> cleanup and bounded recreation;
- Web locale report -> main allowlist -> renderer snapshot -> local catalog rerender without
  window reload, source revision change, or media reacquisition;
- renderer release request -> all tracks ended -> acknowledgement;
- exact-window mismatch -> fail closed without releasing or destroying the replacement;
- lost release acknowledgement -> bounded forced renderer/window teardown;
- throwing subscription/unsubscribe plus late renderer events during dispose.

### Desktop E2E

```text
active session
  -> starting / waiting for approval
  -> shared summary visible
  -> no preview descriptor: no PiP window
  -> preview descriptor available
  -> source connecting
  -> first frame
  -> preview visible
  -> app blur/minimize
  -> preview remains visible
  -> user closes preview
  -> session remains running
  -> Show preview
  -> visible again
  -> Stop Computer Use
      |-> ACK=true -> terminal -> preview closes
      \-> ACK=false -> HTTP 504 -> projection active -> failure visible -> retry enabled
```

Additional E2E cases:

- switching between active and inactive conversations;
- starting and waiting-approval overlays; renderer-only reserved `paused` contract coverage
  without a daemon/runtime E2E synthesizing pause;
- no-preview `starting`/`waiting_for_approval` remains in the shared summary and opens no
  BrowserWindow;
- hide-before-first-frame;
- sleeping-display/no-first-frame -> bounded reconnect -> hide without Stop;
- ordinary projection update after timeout remains hidden; explicit Show and new revision recover;
- display-media request from a non-preview renderer is denied;
- subframe, wrong URL/partition, expired, navigated, released, and disposed capture requests are denied;
- real MediaStream Hide/Close/stall/revision/dispose leaves zero live tracks and clears the OS capture indicator;
- source stall recovery and timeout;
- completed and failed linger timers;
- two-display disconnect;
- drag end -> 180 ms settle -> four-corner snap -> preferred corner persists;
- landscape-to-portrait source change updates `setAspectRatio` without clipping or reopening
  the renderer document;
- right dock, composer, modal, and approval obstacle avoidance with obstacle kinds preserved;
- keyboard-only control navigation;
- light, dark, and reduced-motion modes.
- initial English/Chinese locale, runtime locale switch, fallback, title/actions/status/ARIA,
  and browser operation with no Desktop bridge.

## Verification Commands

Current narrow verification commands:

```bash
node --test packages/contracts/test/computer-use.test.mjs
node --test packages/api-client/test/computer-use.test.mjs \
  packages/daemon/test/computer-use-api.test.mjs \
  packages/daemon/test/computer-use-producer.test.mjs \
  packages/daemon/test/computer-use-registry-retention.test.mjs \
  packages/daemon/test/computer-use-run-integration.test.mjs \
  packages/daemon/test/cua-driver-preset.test.mjs \
  packages/daemon/test/cua-driver.test.mjs \
  packages/daemon/test/provider-health.test.mjs \
  packages/daemon/test/plugin-manager-api.test.mjs
corepack pnpm --filter @ling-stack/desktop typecheck
node --test apps/desktop/tests/*.test.mjs
corepack pnpm --filter @ling-stack/desktop exec playwright test \
  --config tests/playwright.renderer.config.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
node apps/desktop/tests/run-computer-use-smoke.mjs
caffeinate -u -t 180 &
LING_DESKTOP_SMOKE_TIMEOUT_MS=50000 \
  node apps/desktop/tests/run-computer-use-smoke.mjs --real
LING_DESKTOP_CUA_NATIVE_HANDOFF_SMOKE=1 \
  node apps/desktop/tests/run-computer-use-smoke.mjs --real
LING_DESKTOP_SMOKE_TIMEOUT_MS=50000 \
  node apps/desktop/tests/run-computer-use-smoke.mjs --display
corepack pnpm --filter @ling-stack/desktop performance:computer-use:real
corepack pnpm --filter @ling-stack/desktop exec electron tests/screenshot-app
corepack pnpm --filter @ling-stack/desktop verify:windows-provider
corepack pnpm --filter @ling-stack/desktop build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web exec playwright test e2e/app-shell-selectors.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/desktop-computer-use-bridge.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test e2e/workspace.spec.ts
corepack pnpm --filter @ling-stack/desktop package:mac
for executable in \
  "apps/desktop/release/mac-arm64/Ling Stack.app/Contents/MacOS/Ling Stack" \
  "apps/desktop/release/mac/Ling Stack.app/Contents/MacOS/Ling Stack"; do
  LING_DESKTOP_SMOKE_EXECUTABLE="$executable" node apps/desktop/tests/run-computer-use-smoke.mjs
  LING_DESKTOP_SMOKE_EXECUTABLE="$executable" LING_DESKTOP_SMOKE_TIMEOUT_MS=60000 \
    node apps/desktop/tests/run-computer-use-smoke.mjs --real
  LING_DESKTOP_SMOKE_EXECUTABLE="$executable" LING_DESKTOP_SMOKE_TIMEOUT_MS=60000 \
    node apps/desktop/tests/run-computer-use-smoke.mjs --display
  LING_DESKTOP_SMOKE_EXECUTABLE="$executable" LING_DESKTOP_CUA_NATIVE_HANDOFF_SMOKE=1 \
    LING_DESKTOP_SMOKE_TIMEOUT_MS=60000 node apps/desktop/tests/run-computer-use-smoke.mjs --real
done
# Repeat fake/real/display for each mounted arm64/x64 DMG executable; real includes provenance.
for artifact in apps/desktop/release/*.dmg; do hdiutil verify "$artifact"; done
for artifact in apps/desktop/release/*-mac.zip; do unzip -t "$artifact"; done
corepack pnpm --filter @ling-stack/desktop exec electron-builder --win nsis --x64
shasum -a 256 apps/desktop/release/*.dmg apps/desktop/release/*-mac.zip \
  "apps/desktop/release/win-unpacked/Ling Stack.exe" \
  "apps/desktop/release/Ling Stack Setup 0.0.0.exe"
# Release candidates must pass these after Developer ID signing/notarization:
codesign --verify --deep --strict apps/desktop/release/mac-arm64/Ling\ Stack.app
codesign --verify --deep --strict apps/desktop/release/mac/Ling\ Stack.app
spctl -a -vv apps/desktop/release/mac-arm64/Ling\ Stack.app
spctl -a -vv apps/desktop/release/mac/Ling\ Stack.app
# Run on an unlocked Windows x64 VM with the selected Cua Driver provider installed:
corepack pnpm --filter @ling-stack/desktop package:win
corepack pnpm --filter @ling-stack/desktop smoke:computer-use:windows-provider
python3 -c 'import json; from pathlib import Path; from jsonschema import Draft202012Validator; [Draft202012Validator.check_schema(json.loads(p.read_text())) for p in Path("docs/release/evidence").glob("*.schema.json")]'
go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/desktop-artifacts.yml
git diff --check
```

The local dev and fresh unsigned arm64/x64 `.app`/mounted-DMG fake, window, display,
provenance, Cua handoff, and real MediaStream performance evidence are current for this
source. They are engineering candidates only: strict signature checks and Gatekeeper still
fail. Add the signed macOS TCC/display/restart/capture-indicator matrix, Windows provider/VM
capture plus DPI/dual-display smoke, legal Publisher/signing service and enterprise-artifact
decision, hosted CI, and clean-machine acceptance before G2/G3/G6 can close.

## Parallelization Strategy

The foundation contracts are frozen enough for two platform-acceptance lanes to run in
parallel, followed by one release lane:

| Lane | Work | Depends on |
| --- | --- | --- |
| macOS acceptance | Developer ID signing/notarization, denied/prompt/granted/revoked TCC, window/display/restart, OS capture indicator, VoiceOver, signed real-media profiling | signing identity and clean arm64/x64 test hosts |
| Windows acceptance | provider pin/install, x64 VM real-source lifecycle, DPI/dual-display visuals, Narrator/NVDA, restart/source-ended, Authenticode/SmartScreen | Cua Driver provider, unlocked Windows VM, certificate decision |
| Release | hosted CI, final checksums, signed DMG/ZIP and NSIS, clean-machine install/update/uninstall, final evidence archive | macOS acceptance + Windows acceptance |

Recommended order:

```text
local P0 and unsigned macOS baseline [complete]
  ├─> macOS acceptance lane
  └─> Windows acceptance lane
          \______________________________/
                         -> release lane
```

The macOS and Windows acceptance lanes should use separate worktrees and must not reopen
shared contracts or coordinator behavior. Any evidence-driven code fix lands first in one
small shared patch, then both platform lanes rebase before resuming acceptance.

## NOT In Scope

- Direct interaction with the target app through the preview.
- Zero-copy or performance-oriented ScreenCaptureKit, Metal, Windows Graphics Capture, or
  Direct3D rendering optimization in the first cross-platform release. The selected
  provider's public HWND/PID handoff and Windows VM evidence remain in scope.
- Multiple simultaneous previews.
- Remote/cloud video relay.
- Linux packaging.
- Recording or replay.
- Desktop tray, updater, keychain, and unrelated shell completion.
- Copying Codex native assets, private APIs, or bundled implementation.

## Implementation Tasks

- [x] **T0 (P1, human: ~2 days / Codex: ~2 h)** — desktop-shell — Scaffold the minimal Electron shell, shared Web loading, capability provider, and fake PiP renderer entry.
- [x] **T1 (P1, human: ~1 day / Codex: ~45 min)** — contracts — Add the structured Computer Use preview projection and status contracts, bind lifecycle to trusted authorized MCP definitions plus run approval events, remove lifecycle `rawName` allowlisting, and reserve `paused` until an authoritative event exists.
- [x] **T2 (P1, human: ~2 days / Codex: ~2 h)** — daemon — Atomic snapshot/SSE ordering, bridge compatibility, authoritative `starting -> waiting_for_approval -> starting -> running -> terminal` projection, Stop acknowledgement including `ACK=false` active restoration/HTTP 504, Origin checks, scoped native route tokens, bounded terminal/event pruning, and descriptor lease/revocation policy are implemented and verified.
- [x] **T3 (P1, human: ~2 days / Codex: ~2 h)** — desktop-main-local — IPC ownership, truthful visibility intent, eager terminal suppression cleanup, summary-only active state without empty PiP, one-second first-frame/frame-gap watchdogs, absolute ten-second exhaustion without Stop, post-timeout reopen blocking, fail-safe/quiescent disposal, exact-window mismatch rejection, exact release ACK/forced teardown, serialized reconnect/revision replacement, placement, persistence, Reset, display recovery, bounded renderer recreation, real Electron zero-residue profiling, and unsigned packaged renderer-crash recovery are implemented and locally verified.
- [x] **T4 (P1, human: ~2 days / Codex: ~2 h)** — desktop-renderer-local — Runtime overlays with reserved-paused semantics, Codex-like hover-only live chrome, direct Open/Hide/More controls, PiP-only Close window separated from Stop, structured Stop failure/retry, stable menu focus, keyboard/a11y semantics, themes, high contrast, reduced motion, portrait/aspect-fit rendering, generation-safe track release and pending-acquisition ACK, typed `en-US`/`zh-CN` catalog and hot-switch transport, Electron DOM/media coverage, final pre-commit PiP renderer **20/20**, and the macOS arm64 10/10 screenshot matrix are implemented and locally verified.
- [x] **T5 (P1, human: ~2 days / Codex: ~2 h)** — capture-boundary-local — The dedicated non-persistent Session, exact loaded-document/navigation-bound single-use grant, provisional-idle load before `prepare()`, generation/revision validation, descriptor runtime schema, adapter disposal, and full real Electron provenance-negative matrix are verified. Dev plus unsigned arm64/x64 `.app` and both mounted DMGs pass fake/window/display/provenance; both packaged `.app` architectures pass Cua native-window handoff using only Cua's numeric window id and provider PID. The 16 ms identity-bounded decoded-ready poll keeps first-frame truth while avoiding hidden-window callback delay.
- [x] **T6 (P2, human: ~1 day / Codex: ~1 h)** — layout-local — Four-corner collision avoidance, six-offset search, manual placement, 180 ms drag-end snap, preferred-corner persistence, `setAspectRatio`, portrait-source bounds, Reset, typed obstacle priority, bounded geometry/timestamps/128-obstacle IPC input, and topology recovery are implemented and locally verified.
- [x] **T7 (P2, human: ~1 day / Codex: ~1 h)** — product-surface — Current-session Show/Hide/Stop lives in the header capability slot for channel, normal conversation, and teammate-direct surfaces. `starting`/`waiting_for_approval` remains visible as a summary without creating an empty PiP when no descriptor exists. PiP More owns Close window, which is preview-sender-scoped, releases/destroys without Stop, and is separated from the destructive Stop action. Safe visible command failure/pending feedback, ten-second hung-command timeout, Stop negative-ack failure/retry, truthful renderer `visibilityIntent`, formal Desktop auto-show control, shared-Web i18n/PiP locale handoff, and composer/dock/terminal/approval/modal/summary obstacle markers are implemented. The activation/presentation selector owns suppression, explicit Show, auto-show, preview availability, stall-timeout, renderer-crash, first-frame, reconnect, and actionable-error semantics; all 896 combinations plus focused header/geometry and coordinator race regressions pass.
- [x] **T8 (P1, human: ~2 days / Codex: ~2 h)** — local-verification — Final pre-commit verification passes Desktop Node **291/291**, PiP renderer **20/20**, Web E2E **35/35**, contracts **5/5**, API client **48/48**, full daemon **629/629**, macOS release-focused **28/28**, Windows acceptance/provider/release focused **57/57**, and all **11/11** release-evidence schema compilations. Desktop production build, Web production build/typecheck/lint/i18n checks, workspace typecheck/lint, and actionlint pass. Fresh unsigned arm64/x64 `.app` and mounted-DMG fake/window/display/provenance smokes, both packaged `.app` Cua handoffs, renderer-crash recovery, branded macOS/Windows application icons, DMG/ZIP integrity, PE certificate-table inspection, and zero-residue fake/real lanes pass. Real first-frame p50/p95 is **168.09/177.84 ms**, Hide p50/p95 is **2.16/3.65 ms**, 30-second CPU delta is **0.21%**, active overhead is **11,763,712 B**, and churn is **6.04% / 17,661,952 B**. Twelve activations equal twelve enumerations, with one renderer document, zero `applyConstraints()` calls, and zero residue. Fake p95 is **415.27 ms** and applies only to the fake ownership/crash lane. These are local engineering results; external signed/interactive release gates remain open.
- [x] **T9 (P1, human: ~0.5 day / Codex: ~30 min)** — recovery-semantics — An expired zero-frame recovery is blocked by session/descriptor/revision; ordinary projection updates cannot reopen it, while explicit user Show/Retry, a new descriptor identity, or an explicit Desktop restart can recover. V1 intentionally has no resume/unlock/user-active listener. Regression coverage locks timeout, blocked refresh/stale callbacks, explicit Show, and post-timeout revision recovery; terminal/removed sessions eagerly prune visibility and suppression state.
- [x] **T10 (P1, human: ~0.5 day / Codex: ~30 min)** — shutdown-safety — Fallible subscription/display cleanup is contained in a fail-safe envelope; the coordinator quiesces before awaits, rejects late ingress, disposes the adapter exactly once, clears residue, and Desktop keeps IPC alive through dispose while continuing later cleanup after failures.
- [x] **T11 (P1, human: ~1 day / Codex: ~45 min)** — media-release-local — Exact request/ack identity, async pending-acquisition drain, late-stream stop, replay/wrong-sender rejection, 500 ms timeout, renderer-gone release, and exact-window forced teardown are implemented. Fake and real Electron Hide/Show smokes reuse the acknowledged renderer.
- [x] **T12 (P2, human: ~0.5 day / Codex: ~30 min)** — trust-boundaries — Host-layout rects/count/timestamps are bounded, the complete descriptor HTTP payload is runtime-validated and sanitized, and the grant binds exact frame token/tree node/process/routing identity, webContents, Session, URL/origin, expiry, and generation. Unit, dev Electron, unsigned arm64/x64 `.app`, and mounted-DMG provenance deny wrong URL/partition, foreign renderer, audio, subframe/CSP escape, navigation/reload, requester destruction, release, expiry, disposal, and replay while allowing one exact authorized use. G4 trust-boundary closure is complete locally; signed distribution evidence remains a G6 gate.
- [x] **T13 (P1, human: ~0.5 day / Codex: ~45 min)** — source-identity — Desktop allocates a monotonic `sourceGeneration` for every prepare/activation, including retries and same-revision descriptor-id replacement. Snapshot/media key, frame/activity/ended/failure IPC, and release request/ACK carry it; regressions prove every old-source callback fails closed.
- [x] **T14 (P1, human: ~0.5 day / Codex: ~45 min)** — coordinator-fail-safety — Hide/Close/auto-show-off apply safety before best-effort persistence; terminal/source-error cleanup is serialized and exact-source-bound; crash cleanup reconciles after release errors; a newer active session preempts older terminal linger; recreation telemetry matches actual recreation.
- [x] **T15 (P2, human: ~0.25 day / Codex: ~20 min)** — daemon-startup — Fixed-port probing distinguishes a foreign service from a free port, never spawns into an occupied port, permits an owned child to bind before health becomes ready, and aborts immediately when the owned child exits.
- [~] **T15.5 (P1, human: ~0.5 day / Codex: ~15 min)** — windows-release-decisions — Exact provider allowlisting, per-user/asInvoker NSIS policy, certificate boundary, and tuple rollback are implemented and recorded. Product/release owners must still decide public acceptance of the prerelease unsigned provider, the legal Publisher/signing service, the Windows client floor, and whether an enterprise per-machine artifact is required.
  - Owner/timebox: product owner plus Windows release owner; resolve in one decision review before Stage C2, not during VM execution.
  - Evidence artifact: `docs/release/desktop-windows-release-decisions.md` records the exact provider pin, engineering certificate boundary, install scope, rollback rule, and four remaining owner choices.
- [~] **T16 (P1, human: ~1 day / Codex: ~1 h after credentials)** — macos-signed-acceptance — The local signed-candidate verifier, eight-case TCC runner, interactive machine-observed revoke runner, two-launch restart evidence, packaged signed performance producer, bundle-tree/CDHash binding, unique artifact-bound notary jobs, report-relative evidence contracts, and live-reverifying finalizer are implemented and tested. Every harness script is bound to its recorded harness-commit Git blob, current file bytes, and SHA-256, including detection of hidden `assume-unchanged` edits. The finalizer deliberately returns `MANUAL_REVIEW_REQUIRED`; external execution must still produce Developer ID arm64/x64 candidates, run the clean-host capture-indicator/VoiceOver gates, and verify a detached reviewer signature outside the self-reporting process.
  - Owner/environment: Desktop release owner on clean arm64 and x64/Rosetta macOS hosts with Developer ID and notary credentials.
  - Entry condition: local T0-T15 baseline is green and the exact candidate hashes are frozen.
  - Evidence artifact: signed DMG/ZIP, Team ID/codesign/notary logs, TCC matrix, capture-indicator recording, VoiceOver notes, smoke JSON, and performance report.
- [~] **T17 (P1, human: ~1–3 days / Codex: ~2 h after environment)** — windows-vm-acceptance — The local Preflight/Full report builder and PowerShell runner are implemented and statically contract-tested from Node. Installer and uninstaller signatures are checked before either executable runs; the installed app must match the manifest, and harness scripts are bound to the candidate commit and rehashed against Git blobs. Full also requires the release orchestrator to supply fixed expected candidate commit, clean repository root, and release-policy SHA-256 anchors; the validator cross-checks all three independently from report-owned paths. The builder cannot self-promote: even with Full gates PASS it emits `releaseReady=false` until the separate verifier checks a detached reviewer signature and candidate-build/daemon-tree attestation against policy-pinned SPKI fingerprints. This macOS host has neither `pwsh` nor Windows PowerShell, so real PowerShell parsing/runtime remains unverified. Full still cannot pass without an x64 host, both provider executables, cross-display/two-DPI visual evidence, Narrator/NVDA acceptance, SmartScreen without warning/Run anyway, install/update/uninstall, and zero residue. The real VM execution and real detached signatures remain pending.
  - Owner/environment: Windows/Desktop owner on an unlocked Windows x64 VM with the provider, two-display/DPI profiles, and the selected certificate policy.
  - Entry condition: T15.5 is accepted; local unsigned package and verifier are green.
  - Evidence artifact: provider health/descriptor logs, VM smoke output, screenshots, Narrator/NVDA notes, PE signature inspection, and install/update/uninstall transcript.
- [~] **T18 (P1, human: ~1 day / Codex: ~2 h after T16/T17)** — release-closure — The unsigned artifact workflow emits and uploads a diagnostic Windows Preflight while asserting it cannot claim Full acceptance. Its path filters include `docs/release/evidence/**`, and the strict eleven-schema Draft 2020-12 compile step makes schema-only changes run a real CI gate. Both macOS and Windows hosted daemon matrices include provider-eligibility and Windows target-validation coverage. Signed jobs, secrets, hosted execution, macOS external reviewer-signature verification, real Windows detached reviewer/build attestations, clean-commit daemon provenance evidence, and clean-machine distribution acceptance remain pending.
  - Owner/environment: release owner with CI signing/notary secrets and disposable clean macOS/Windows machines.
  - Entry condition: T16 and T17 evidence is accepted with immutable candidate hashes.
  - Evidence artifact: CI run links, signed SHA-256 manifest, install/update/uninstall results, final performance comparison, accessibility acceptance index, and release checklist sign-off.

### Next execution order

```text
Local P0 + unsigned macOS baseline [complete]
  -> Stage A1: recovery latch + shutdown/release safety [complete locally]
  -> Stage A2: state/trust-boundary hygiene [complete locally]
  -> Stage A3: source generation + coordinator/daemon fail-safety [complete locally]
  -> Stage B1: header entry + PiP Close + teammate geometry [complete locally]
      ├─> Stage C1: Developer ID signed macOS TCC/window/display/restart matrix
      └─> Stage C2: T15.5 decisions -> Cua Driver install/pin -> x64 VM + DPI smoke
          \___________________________________________________________________/
                              -> Stage D: hosted CI, immutable signed hashes,
                                 clean-machine install/update/uninstall,
                                 and final evidence archive
```

C1 and C2 may run in parallel because A3 and B1 have frozen the local contracts and product
surface. Release hardening cannot close until both platform evidence sets, Windows visual
acceptance, and signing identities exist.

### Release acceptance and merge boundaries

The detailed build sections above retain their historical Foundation/Slice 0-8 labels.
The table below uses release batches `M0`-`M7` so those labels cannot be confused with
the original product Slice 0-7 plan.

| Batch | Merge boundary | Required evidence |
| --- | --- | --- |
| M0 | One canonical source-status/adapter/IPC contract; lifecycle is driven by trusted authorized MCP definitions and approval events, `paused` is reserved, no lifecycle `rawName` whitelist remains, and the threat boundary plus Session-scoped capture provenance are documented | contract tests, lifecycle-source tests, IPC permission table, request-origin denial tests, design/docs aligned |
| M1 | No SSE/snapshot event-loss window; incompatible external daemon stays on the fixed port and gets native Retry/Quit recovery without kill or split-brain | deterministic race tests, startup single-flight/ownership tests, token/capability handshake tests, scoped route auth tests |
| M2 | Preview Stop/Hide ownership correct; Stop `ACK=false` restores active, returns HTTP 504, and remains retryable; preview-source failure releases media and closes after 5 s; coordinator modules separated | accepted/negative-ack/stale revision/failure, listener, internal close, Retry, sender-ownership tests |
| M3 | Fake lifecycle is stable under summary-only starting/approval wait, restart, crash, route switch, stall, exact-window mismatch, same-revision descriptor replacement, persistence failure, and ten repeated cycles | no-empty-PiP, source-generation/window-identity IPC/renderer/coordinator regressions, fail-safe visibility persistence tests, queued linger ownership tests, packaged fake E2E, and zero live window/track/timer/listener residue |
| M4 | Signed macOS candidate completes TCC and real-source matrix | denied/prompt/granted/revoked, first frame, ended, revision, restart on arm64/x64 |
| M5 | Windows has a real authorized source provider, not only an Electron installer | Windows x64 VM real-source, permission, ended, revision, restart smoke |
| M6 | Final PiP surface and main-UI capability slot are usable and layout-safe | typed obstacle priority, 180 ms drag-end four-corner snap, preferred-corner persistence, drag/resize, source aspect-ratio/portrait handling, dual display/DPI, a11y, `en-US`/`zh-CN` initial and live-switch i18n, visual matrix |
| M7 | Installable artifacts carry and validate provider contract metadata and meet recovery/performance/security budgets | signed/notarized DMG+ZIP, signed NSIS, CI, external-provider resolution, clean-machine install/E2E |

## Completion Definition

The feature is complete only when:

- Desktop and browser use the same shared Web application rather than forked pages;
- an unfinished or later-refactored main UI affects only capability slots and geometry
  reporters, not the preview coordinator or capture adapters;
- macOS and Windows both show a real approved Computer Use source;
- first-frame, Show, Hide, Close, Stop, route switch, app blur, terminal, permission, and
  stall behavior match the detailed event matrix;
- starting and approval-wait remain visible in the shared summary without opening an empty
  PiP when no preview descriptor exists;
- closing the preview never stops the session;
- explicit stop is acknowledged before the UI claims termination;
- a negative Stop acknowledgement leaves the projection active, returns HTTP 504, and keeps
  retry available;
- signed macOS proves the operating-system capture indicator appears and clears with media
  acquisition/release, without hiding or spoofing the platform permission UX;
- VoiceOver on macOS and Narrator plus NVDA on Windows can identify status and controls,
  traverse actions in order, and recover from permission/Stop failures;
- private APIs are absent;
- media tracks and windows clean up under repeat and crash tests;
- all specified unit, integration, E2E, accessibility, and performance checks pass.

## External Dependencies And Release Gates

| Dependency | Why it is external | What closes it |
| --- | --- | --- |
| Separately installed Cua Driver provider | Ling ships plugin shell metadata only; it does not own the provider binary, native application, permissions, or update channel | clean-machine install resolves the pinned Cua Driver provider on macOS/Windows, plugin health passes, required macOS permissions are granted without Ling modifying TCC, and both approved-window real-source lifecycles pass |
| Apple Developer ID and notarization credentials | no usable signing identity is installed on the current machine | signed arm64/x64 candidates with Team ID, strict codesign, Gatekeeper, notarization, and clean-host TCC evidence |
| Clean macOS TCC test environments | current host already reports Screen Recording `granted` | denied/prompt/granted/revoked plus window/display, restart, OS capture-indicator, VoiceOver, and track-cleanup matrix without mutating TCC |
| Maintained Windows source provider and x64 VM | The selected Cua Driver `v0.8.3` asset is an unsigned prerelease and the current machine has no Windows interactive desktop | exact allowlisted provider install, explicit beta-risk acceptance or a signed stable upstream asset, descriptor handoff, real authorized source lifecycle, DPI/dual-screen, Narrator/NVDA, restart, and source-ended smoke |
| Real platform accessibility hosts | DOM/ARIA and screenshot tests cannot prove native screen-reader focus, names, ordering, or announcements | VoiceOver acceptance on signed macOS plus Narrator and NVDA acceptance on installed Windows, with status/control/failure-recovery evidence |
| External macOS review trust anchor | the finalizer cannot safely accept a caller-supplied assertion that its own manual evidence is trusted | a separate verifier recomputes the evidence digest and verifies a detached signature against a release-policy-pinned reviewer key |
| Candidate daemon build provenance | the v3 manifest and detached build-attestation verifier now define the fail-closed trust contract, but no real release attestor has signed clean-candidate daemon bytes | deterministically rebuild and fingerprint the dist tree from the clean candidate commit, or use only the daemon embedded in the signed candidate, then sign that exact manifest with a policy-pinned build key |
| Windows certificate and NSIS policy | legal Publisher/signing service, supported Windows floor, and any separate enterprise per-machine artifact remain unselected; the first candidate is already fixed to per-user/asInvoker | signed x64 per-user installer, explicit enterprise-artifact decision, install/uninstall/upgrade smoke, checksum, and clean-machine acceptance |
| Release CI secrets and clean machines | local engineering smokes do not prove repeatable distribution | CI artifact matrix, notarization/signing jobs, integrity metadata, and clean install/update E2E |

## Unresolved Decisions

1. **Windows provider allowlist advancement:** keep the exact reviewed
   `cua-driver-rs-v0.8.3` allowlist and decide when a separately reviewed provider-upgrade PR
   may advance it; accepting a newer version without the x64 regression matrix can invalidate
   the HWND and source-lifecycle evidence.
2. **Windows release identity:** select the legal Publisher/signing service and supported
   Windows floor, then decide whether enterprise distribution requires a separate per-machine
   artifact. The first candidate remains fixed to per-user/asInvoker.
3. **macOS reviewer trust anchor:** choose the detached-signature format and the
   release-policy-pinned reviewer key set. Until this exists, the local finalizer must remain
   `MANUAL_REVIEW_REQUIRED` even when every machine-produced case passes.
4. **release daemon provenance:** choose deterministic clean-commit `daemon/dist` rebuild plus
   tree fingerprint, or candidate-package-only daemon execution. Deferring this leaves a gap
   between reviewed source/harness scripts and the daemon bytes exercised by release smokes.
