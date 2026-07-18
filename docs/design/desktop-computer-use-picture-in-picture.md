# Desktop Computer Use Picture-in-Picture

Status: approved design direction; the local implementation baseline is verified and release
acceptance remains in progress. Capture-request provenance,
exact loaded-document and navigation binding, provisional-idle renderer startup, bounded
zero-frame recovery, decoded-frame readiness polling, fail-safe media release, Desktop-local
source generations, current-session controls, Cua native-window identity handoff, current-host
real-capture performance, and the unsigned macOS arm64/x64 `.app` plus mounted-DMG packaged
provenance matrix are verified. Fail-closed signed-candidate/TCC/final-evidence and Windows
Preflight/Full acceptance harnesses are also implemented locally. The macOS harness binds each
release script to its recorded harness-commit Git blob, current file bytes, and SHA-256; Windows Full
requires caller-fixed candidate-commit, clean-repository-root, and release-policy-SHA trust
anchors. Those anchors do not authenticate a reviewer self-reported inside Windows manual
evidence. The builder therefore keeps `releaseReady=false`; the independent verifier must validate
both a detached reviewer signature and a candidate-build/daemon-tree attestation against
cross-role-disjoint policy-pinned identities, key IDs, and SPKI fingerprints. The strict
eleven-schema Draft 2020-12 compiler is wired into CI,
including schema-only workflow path changes.
The macOS finalizer cannot self-promote manual evidence to PASS, this macOS host cannot execute
the PowerShell runner because neither `pwsh` nor Windows PowerShell is installed, and release
smokes still need real signed deterministic provenance for the candidate `daemon/dist` bytes.
Apple Developer ID
signing/notarization and Gatekeeper,
signed-app clean-host TCC and operating-system capture-indicator evidence, Windows x64
interactive provider/real-source/DPI/dual-screen VM acceptance,
Authenticode/SmartScreen/signed NSIS, hosted signed CI execution, clean-machine install/update/uninstall,
and real VoiceOver/Narrator/NVDA acceptance remain open release gates.

The multi-page logical deck described below is now implemented and locally verified as V2.
It reuses one native PiP window and one live capture stream while switching among at most
five exact-scope logical pages. Inactive thumbnails remain renderer-memory-only. This local
completion does not promote unsigned development evidence into signed cross-platform release
acceptance.

Related documents:

- [Desktop Shell](desktop-shell.md)
- [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md)
- [Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](desktop-computer-use-picture-in-picture-detailed-design.md)
- [Desktop Computer Use Picture-in-Picture Implementation Plan](desktop-computer-use-picture-in-picture-implementation-plan.md)
- [Platform Architecture](platform-architecture.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Approval Policy](approval-policy.md)

## Purpose

Ling Desktop should let the user watch an active Computer Use session without keeping the
target conversation or the main Ling window in front. The preview should feel close to
the Codex desktop picture-in-picture surface while remaining portable across macOS and
Windows and avoiding private operating-system APIs.

The picture-in-picture surface is a view over an existing Computer Use session. It is not
the session owner, input-control owner, approval owner, or audit owner.

## Product Decision

Build one dedicated picture-in-picture renderer inside the Electron desktop shell, reuse
shared visual tokens where practical, and keep a narrow platform adapter for capture and
window integration. The main Ling conversation UI remains the shared Web application;
the small PiP renderer is not a second product state store.

```text
Computer Use runtime / plugin
  -> daemon session projection and control-plane event
  -> shared API client
  -> Desktop main-process preview coordinator
  -> platform preview adapter
       macOS: Electron capture first, ScreenCaptureKit optimization later
       Windows: Cua Driver supplies an exact numeric native window id and provider PID;
                Electron capture remains the presentation adapter
  -> dedicated picture-in-picture BrowserWindow
  -> dedicated isolated preview renderer
```

The visual and behavior layers are shared across macOS and Windows. Only capture,
window enumeration, permission checks, source focus, and later low-latency rendering are
platform-specific.

## UI Finalization And Synchronization Decision

The final Ling conversation page does not need to be settled before picture-in-picture
foundation work begins.

Desktop must not fork the main Ling UI. Its main BrowserWindow loads the same built Web
application and injects a narrow Desktop capability bridge. Shared routes, conversation
components, right dock behavior, design tokens, and daemon-backed state therefore update
together when the Web UI changes.

```text
shared Web application
  -> browser surface: no Desktop capability bridge
  -> Desktop main window: Desktop capability bridge available
       -> report normalized en-US / zh-CN locale
       -> Desktop main forwards locale in the sanitized PiP snapshot
       -> dedicated PiP renderer resolves its small local message catalog

Desktop-only windows
  -> Computer Use picture-in-picture renderer
  -> future quick panels or OS-owned surfaces
```

The current shared-Web boundary is already modularized for later UI synchronization:

```text
DesktopComputerUseBridge
  -> capability + locale + selected owner + summary + stale command lifecycle
  -> useDesktopNavigationIntents -> structured open-conversation route + ACK after selection succeeds
  -> useDesktopComputerUseHostLayoutReporter
       -> geometry observers + modal auto-marker + cleanup
  -> DesktopComputerUseControlSlot
       -> movable current-session Show/Hide/Stop + status + pending/failure + ARIA
```

The current product placement is the current-session header toolbar for channel, normal
conversation, and teammate-direct surfaces. Future conversation-UI changes may move only
that control slot, adjust semantic marker ownership, and preserve the structured navigation
intent hook. Capture, coordinator, daemon state, and platform adapters do not move with it.

The picture-in-picture renderer is Desktop-specific because it lives in a separate
always-on-top operating-system window. It may reuse shared design tokens and focused
conversation UI primitives, but it must not copy the main conversation page.

### Stable before the main UI is final

| Stable contract | Why it can be implemented now |
| --- | --- |
| Computer Use daemon projection | It depends on runtime identity and status, not page layout. |
| Preview coordinator and visibility state machine | Show, Hide, Close, Stop, terminal, and recovery semantics are product rules. |
| Platform capture adapter | It depends on an approved source descriptor, not toolbar placement. |
| Dedicated PiP renderer snapshot | It receives sanitized state plus normalized locale independent of the main page component tree. Locale-only updates do not reload the window or media source. |
| Selected conversation bridge | It reports a structured conversation id from the route controller. |
| Open-task navigation intent | It carries an opaque conversation id and is ACKed only after the route controller successfully selects it. |
| Host and obstacle rectangle contract | It accepts geometry without naming a specific current component. |

### Settled shared-UI placement and deferred polish

- `Show preview`, `Hide`, and `Stop` live in the current-session header toolbar.
- `Open task` uses the Desktop navigation intent bridge; the intent is acknowledged only after
  the target conversation is actually selected. A missing conversation remains pending for a
  later renderer instead of being falsely acknowledged.
- `Close window` lives only in the PiP More menu. It destroys the preview and releases
  capture without stopping Computer Use.
- composer, dock, terminal, modal, approval, and summary surfaces report typed obstacle
  geometry across channel, normal conversation, and teammate-direct layouts.
- Windows DPI/dual-display screenshots, real-platform capture visuals, and later token/motion
  polish remain acceptance work rather than architecture decisions.

### Safe fallback while UI integration is incomplete

If the main UI has not reported a host layout, Desktop places the preview inside the
current display work area using the saved preferred corner. It does not inspect or infer
private Web DOM structure.

If a future UI refactor temporarily relocates the current working `Show preview` slot,
auto-show, the PiP renderer's Hide control, and the native window-close path still work.
This is a migration fallback only; release still requires broader cross-platform
visual/accessibility acceptance.

With this boundary, later UI changes affect a small capability adapter, navigation hook, and
geometry markers. They do not rewrite capture, runtime projection, window lifecycle, or
cross-platform behavior.

## User Experience

The user sees a small floating preview when the currently selected Ling conversation has
an active Computer Use session and the first valid frame is ready. If capture permission or
the source fails before a frame, Desktop may instead show a bounded actionable recovery
surface (for example, Screen access required) without claiming that a live frame exists.

The preview:

- stays above ordinary application windows while the Computer Use session is active;
- can remain visible when the main Ling window is blurred, minimized, or behind another
  application;
- can be dragged, resized, and snapped to a screen corner;
- avoids the Ling composer, modal dialogs, and right dock while it is anchored to the
  main Ling window;
- shows the current target application, session status, approval-required overlays, and a
  paused overlay only when the daemon emits an authoritative `paused` projection;
- exposes `Open task`, `Hide preview`, and a separate `Stop Computer Use` action;
- never treats the window close button as permission to stop the Computer Use session.

### Proposed V2: one PiP window, multiple logical pages

V1 remains a single-page preview. The next product slice adds a logical page deck inside
the same native PiP `BrowserWindow`; it does not create several native windows and it does
not keep several capture streams alive at once. This is the behavior represented by the
stacked-window reference image.

```text
eligible structured projections
  -> page deck (maximum 5 resident pages, scoped to one owner surface)
       -> active page: one live capture stream + full-size preview
       -> inactive pages: memory-only last-frame thumbnails, no live capture
  -> click exposed page/card
       -> serialized source switch
       -> first-frame gate
       -> new active page
```

Page means an authorized Computer Use preview source backed by a structured session and
descriptor. It does not mean an arbitrary browser tab, an untrusted URL, or a second
Desktop product state store. A page switch changes presentation only; the underlying
Computer Use sessions continue according to daemon authority.

Interaction rules:

| Action | Result | Runtime effect |
| --- | --- | --- |
| Click an exposed inactive card or page tab | Activate that page after the first-frame gate | No Stop, pause, or approval change |
| Escape while a page control or menu is focused | Close the menu or return focus; do not switch pages | No deck mutation |
| Close page | Remove the page from the resident deck and release its preview resources | Session continues |
| Hide/close PiP window | Hide or destroy the whole deck | Active and inactive sessions continue |
| Stop Computer Use | Stop only the active page's session through the existing audited path | Other pages remain untouched |
| Open a sixth page | Evict the least-recently-used inactive resident page; never evict the active page | Evicted session continues and can be reopened from the page list |
| Select `View all` | Open a metadata-only list of every eligible page in the current owner scope | No capture or runtime change until a page is selected |

The deck is scoped by `workspaceId + surfaceKind + ownerId`. Route changes hide the old
deck and bind a new scope; channel, normal conversation, and teammate-direct pages never
share a deck. This prevents a page from a private teammate surface appearing in a channel
or another user's conversation. A page's title, runtime status, and target label come from
the structured projection; the preview never infers page identity from transcript text.

The active page moves to the front of the visual deck after a successful switch. The
expanded view may use the fan/overlap treatment from the reference image. The narrow
right-dock form uses a compact tab strip or page chips instead of overlapping full pages.
Inactive thumbnails are downsampled, held in renderer memory only, and discarded on page
close, scope change, renderer crash, or process exit. They are never persisted, sent to the
daemon, or included in telemetry.

Closing a page dismisses only its local resident entry. Normal projection refresh cannot
immediately add it again. `View all` continues to list the active session as available; an
explicit reopen clears the memory-only dismissal and applies the inactive-LRU rule if the
resident deck is full.

## Visibility Semantics

Three actions must remain distinct:

| Action | Preview window | Computer Use session | Reopen behavior |
| --- | --- | --- | --- |
| Hide | Hidden but reusable; local tracks are released | Continues | `Show preview` restores it. |
| Close window | Window is destroyed and session-suppressed | Continues | Explicit `Show preview` recreates it. |
| Stop Computer Use | Closes after stop is acknowledged | Stops or cancels through the runtime owner | A new Computer Use session is required. |

The native close event/window-close shortcut and the in-preview `Hide` action are
intentionally equivalent in session semantics: neither stops Computer Use. Close releases the window itself, while
Hide allows the coordinator to reuse it later. This prevents an ordinary window-management
gesture from terminating an external side effect.

Hide or Close suppression is scoped to the current `sessionId`. It survives a Desktop
restart while that session is still active. At terminal acknowledgement it becomes
behaviorally irrelevant because a new run uses a new session id. The current implementation
eagerly removes terminal-session suppression and explicit visibility state; the existing
24-hour safety expiry remains the fallback for abandoned local state. A new Computer Use
session may auto-show normally.

### Lifecycle trigger matrix

| Trigger | Window and media action | Persistent session suppression | Runtime | Next presentation |
| --- | --- | --- | --- | --- |
| First valid frame for selected active session, auto-show enabled | Show/reveal after the frame gate | No | Continues | Already visible |
| Explicit `Show preview` | Create/reveal and connect | Clear current-session suppression | Continues | Immediate after first valid frame |
| User `Hide preview` | Hide reusable window; release media | Yes, up to 24 hours | Continues | Explicit Show |
| Native close event or window-close shortcut | Destroy window; release media | Yes, up to 24 hours | Continues | Explicit Show recreates |
| Route/session switch | Destroy or rebind the old preview; release old media | No user suppression | Continues | New selected session may auto-show after first frame |
| Ten-second zero-frame deadline | Hide and release media | No user suppression | Continues; never Stop | Explicit user Show/Retry, new descriptor identity, or explicit Desktop restart |
| Terminal projection | Freeze/linger as specified, then destroy and release | Entry becomes irrelevant and should be pruned | Ends in daemon/runtime | A new session is required |
| Desktop quit or owner deletion | Destroy and release immediately | Clear local ownership state | Runtime follows its owner, not the PiP window | Normal startup/new session flow |

Current implementation: the ten-second deadline writes a process-local
session/descriptor/revision latch before hiding and releasing, so ordinary reconciliation
cannot reconnect it. Explicit Show/Retry or a new descriptor identity clears the latch;
restarting Desktop explicitly rebuilds presentation state. Desktop main also waits for an exact renderer
release acknowledgement; the renderer drains pending acquisition and stops late streams
before ACK. A 500 ms timeout or negative acknowledgement destroys the exact renderer/window,
so a hung renderer cannot keep capturing behind a hidden window. V1 has no
resume/unlock/user-active listener and never wakes the display.

## Automatic Show Rules

Automatically show the preview when all conditions are true:

1. Desktop picture-in-picture is enabled.
2. The selected Ling conversation owns the latest active Computer Use session.
3. The session is not terminal.
4. A valid preview source and first frame are available.
5. The user has not hidden or closed the preview for this session.

Do not open an empty floating window while capture is still starting. Starting state
belongs in the transcript or workspace status surface until the first frame arrives.
Because hidden BrowserWindows may defer paint-driven callbacks, the renderer also checks
decoded readiness every 16 ms and may pass the gate only at `HAVE_CURRENT_DATA` or later.
That poll is bound to the exact media identity and ends on Hide, revision replacement,
reconnect, teardown, or an already reported frame.

An explicit `Show preview` action overrides the global auto-show preference for the
current session only.

Turning auto-show off applies to future automatic reveals. It releases a source that is
still connecting behind a hidden window, and late first-frame callbacks cannot reveal it.
It does not abruptly hide a preview that is already visible; `Hide preview` remains the
explicit action for that.

## Automatic Hide Rules

Hide without stopping the session when:

- the user selects `Hide preview`;
- the user closes the floating window;
- the user navigates inside Ling to a conversation without an active Computer Use
  session;
- the selected conversation changes to a different active Computer Use session and the
  new preview is not ready yet;
- a privacy or workspace policy temporarily forbids presentation;
- the preview source stalls beyond the recovery grace period.

Losing operating-system focus does not hide the preview. The purpose of picture-in-picture
is to remain visible while the user works in another application.

A sleeping display may leave the operating-system capture track alive without producing
frames. Ling must not wake the display or stop Computer Use. After a one-second first-frame
or frame-gap watchdog fires, it enters bounded recovery and uses a ten-second absolute
deadline. Expiry hides the preview and releases media while the task continues.
Recovery is explicit user Show/Retry, a new descriptor identity, or an explicit Desktop
restart; sleep, resume, unlock, and user-active signals never auto-reopen V1.

## Automatic Close Rules

Close the preview window and release its media resources when:

- the Computer Use session succeeds, fails, is cancelled, or is stopped;
- the source is permanently invalidated;
- screen-capture permission is revoked and recovery fails;
- the Desktop process is quitting;
- the owning conversation or workspace is deleted.

Terminal presentation timing:

| Terminal event | Visible terminal treatment | Close timing |
| --- | --- | --- |
| Succeeded | Freeze the last frame and show `Completed`. | 1.5 seconds. |
| Stopped or cancelled | Show `Stopped` only if an acknowledgement frame exists. | Within 300 ms of terminal acknowledgement. |
| Failed | Freeze the last frame and show the failure plus `Open task`. | 5 seconds; pause the timer while hovered or keyboard-focused. |
| Permission revoked | Show `Screen access required` and `Open settings`. | 5 seconds if not acted on. |

Only the actionable five-second failure and permission treatments pause while hovered or
keyboard-focused. Success, cancellation, frame-gap detection, and reconnect backoff do
not pause. Choosing `Open settings` counts as acting: it cancels automatic close and keeps
the recovery entry available. A rejected Stop request keeps the task and preview running,
shows safe assertive feedback, and offers `Try Stop again` without displaying internal
runtime or IPC reasons.

Closing the preview after a terminal event does not delete transcript, audit, approval,
or artifact records.

## Conversation Selection

The first version supports one visible picture-in-picture preview. The proposed V2 deck
extends this to several logical pages inside the same preview window.

- Inside Ling, the currently selected conversation determines which active session may
  present.
- When Ling loses application focus, the last selected conversation remains selected so
  the preview can stay visible over another application.
- Switching to another Ling conversation hides the previous preview immediately.
- If the new conversation has a ready active session, the current implementation destroys
  the previous preview and recreates it for the new session. Same-window cross-fade is a
  later visual optimization, not a lifecycle requirement.
- Historical and completed Computer Use operations never reopen picture-in-picture.
- V2 pages are eligible only while their structured session remains active or in its
  authoritative terminal linger. A terminal page is removed after its existing linger
  treatment and cannot be silently resurrected by a stale deck entry.

Multiple simultaneous native preview windows remain out of scope. V2 deliberately keeps
one active capture stream and uses last-frame thumbnails for inactive pages.

## Responsibility Boundary

### Daemon owns

- Computer Use session identity and lifecycle;
- conversation, turn, run, and work-unit attribution;
- approval and policy state;
- durable audit events;
- the latest preview-source descriptor allowed for a client;
- stop or cancel commands and their acknowledgements.

### Desktop main process owns

- platform capture adapter lifecycle;
- picture-in-picture BrowserWindow lifecycle;
- source selection and media-resource cleanup;
- active conversation selection for the local Desktop window;
- global auto-show preference and per-session suppression;
- window bounds, screen selection, always-on-top behavior, and repositioning;
- trusted IPC between the daemon projection, main process, preload, and renderer.
- the latest normalized `en-US | zh-CN` presentation locale reported by the shared Web UI;

### Shared Web application owns

- route-derived current conversation ownership and locale reporting;
- semantic host/obstacle markers and bounded geometry reporting;
- the movable current-session control slot and its translated status/ARIA presentation;
- local Show/Hide/Stop pending/failure feedback, bounded command timeout, and stale
  route/session result suppression;
- browser-safe no-op behavior when the Desktop capability is absent.

The daemon projection remains the Stop and terminal-status authority. Shared Web feedback
must not invent a second execution lifecycle.

### Picture-in-picture renderer owns

- preview chrome and media presentation;
- loading, paused, approval-required, stalled, completed, and failed overlays;
- drag and resize affordances delegated to the Desktop main process;
- user commands such as show, hide, open task, and stop request;
- accessibility labels, keyboard focus, and reduced-motion behavior.
- a small local message catalog for window title, status, controls, recovery, and ARIA copy;

### Platform adapters own

- source enumeration and capture permission checks;
- opening and stopping a preview stream;
- optional target-window focus;
- platform-specific optimization without changing shared session semantics.

Platform adapters must not decide approval policy, terminal status, or whether a stop
request is authorized.

## Cross-Platform Strategy

### First implementation

Use Electron's public capture and BrowserWindow APIs for the presentation layer. macOS
real capture is gated on a signed-app TCC verification. Windows uses the selected
open-source Cua Driver Rust provider for explicit HWND/PID target identity and Electron
for PiP capture; real support remains gated on the Windows x64 provider/source lifecycle
matrix. An Electron installer by itself is not evidence of Windows Computer Use support.

The Electron V1 keeps preview capture in a dedicated non-persistent Session partition.
`session.defaultSession` is diagnostic-only because the display-media handler is
Session-scoped and the main Ling window already uses the default Session. Each capture
grant is single-use and bound to the exact loaded PiP document: frame token, frame-tree node,
renderer process id, frame routing id, webContents, dedicated Session, frame URL/security
origin, session id, descriptor id/revision, authorization expiry, and prepare generation.
The coordinator loads a provisional `idle` snapshot before `prepare()` so the adapter binds
the real current main document rather than a future or replaced renderer. Main-document
navigation/reload, requester destruction, release, descriptor replacement, or adapter
disposal invalidates the outstanding grant; disposal also removes the Session-wide handler.

For native-window handoff, Ling matches the exact numeric `window_id` returned by Cua Driver
and carries only Cua's native window id plus provider-reported owner PID into the descriptor.
The Electron source id is a smoke-test oracle, not the production handoff. Selection never
falls back to title matching, foreground-window state, z-order, or nearest-candidate guesses.

### Native optimization path

Keep native acceleration behind the same adapter interface:

| Platform | Capture optimization | Rendering optimization |
| --- | --- | --- |
| macOS | ScreenCaptureKit | AVSampleBufferDisplayLayer or Metal |
| Windows | Windows Graphics Capture | Direct3D shared texture or Media Foundation path |

The first implementation must not depend on `CAContext`, `CALayerHost`, private
CoreGraphics APIs, undocumented Win32 composition APIs, or an App Store-incompatible
capture path.

## Safety And Privacy

- The preview may display only the source already approved for the Computer Use session.
- Do not expose arbitrary `desktopCapturer` source selection to an untrusted renderer.
- Reject display-media requests that do not originate from the current PiP renderer frame;
  Session isolation alone is not an authorization check.
- Raw Node.js, filesystem, shell, Accessibility, UI Automation, and input-injection APIs
  must not be exposed through preload.
- Do not persist frames, thumbnails, clipboard contents, or source-window titles in
  SQLite solely for picture-in-picture.
- A visible recording indicator and operating-system permission UX must not be hidden.
- `Stop Computer Use` routes through the same approval, runtime, and audit boundaries as
  stopping from the owning conversation.
- Computer Use list/events/stream/stop routes must use a scoped local authorization or
  same-origin/CSRF boundary; loopback plus `Access-Control-Allow-Origin: *` is not enough
  for a destructive Stop action.
- Browser requests with a local `Origin` use the local-origin/CSRF boundary. Native
  requests with no `Origin` must carry the installation-scoped
  `X-Ling-Computer-Use-Token`; the token is never accepted from a query string and is
  attached only to Computer Use projection/control routes. The descriptor handoff keeps
  its separate `X-Ling-Desktop-Bridge-Token` header.
- The alpha may derive both scoped capabilities from the same per-installation secret, but
  the HTTP headers and route checks remain separate so a bridge token is not accidentally
  propagated to unrelated daemon APIs.
- The preview is view-only in the first version. User takeover and direct input forwarding
  require a separate design and explicit authorization model.

## Performance Targets

First-version targets on a supported laptop:

- preview open after first frame: under 300 ms;
- visual latency: under 250 ms for local capture;
- active preview CPU: under 8% of one performance core at 30 fps;
- memory growth after ten open/close cycles: under 20 MB;
- hidden preview receives renderer track-release acknowledgement within 500 ms, or
  force-destroys the renderer/window to guarantee capture stops;
- V2 page-switch input shows selected/switching feedback within 100 ms and reaches a new
  decoded frame within 500 ms p95 on the current supported-host performance lane;
- V2 never reports more than one live preview track, and four inactive downsampled
  thumbnails stay within a combined 20 MB working-set budget;
- position update during resize or dock changes: one update per animation frame at most;
- no main-conversation scroll or typing jank while the preview is active.

The 2026-07-18 current-host Electron measurements meet the local budgets. Final V2 verification
on the current worktree passes Desktop Node **337/338** with one environment-only unsigned-
candidate skip, PiP renderer **25/25**, focused shared-Web Desktop bridge E2E **19/19**, Desktop
and Web typechecks, Web lint/i18n, fake and real smoke, `git diff --check`, and all **16** macOS
arm64 Computer Use screenshot baselines. The implementation plan retains the broader V1 release-
harness counts and evidence boundaries.

This is current local engineering evidence against the final pre-commit diff. The fixed artifact
fingerprints labeled `baseline @ e20777f5` remain historical references rather than current
candidate hashes. None of this closes Developer ID/TCC/capture-indicator/VoiceOver or Windows
VM/provider/DPI/SmartScreen/Narrator/NVDA, hosted signed CI, clean-machine lifecycle, detached
signature, or real candidate-daemon provenance gates.

| Measure | Verified result |
| --- | --- |
| First decoded frame | **153.73 ms p50**, **164.31 ms p95** |
| Hide and renderer media release | **1.39 ms p50**, **6.76 ms p95** |
| V2 fake-source page switch | **11.32 ms p95**, `maxActiveAdapterSources = 1` |
| 30-second active capture versus hidden idle | **0.23% incremental CPU**, **9,863,168 B** working-set overhead |
| Repeated activation churn | **4.9% CPU**, **18,857,984 B** working-set growth |
| Capture lifecycle invariants | **10/10 active samples = 1 live track**, every hidden sample = **0**, **12 activations = 12 source enumerations**, **1 renderer document**, **0 `applyConstraints()` calls**, **0 final process/window/renderer/track/listener/IPC/timer/subscription/source residue** |

The final full daemon suite passes **629/629** on the current worktree, so the earlier isolated
`channel auto_route` scheduling fluctuation is not an open local pre-commit verification gap.

These are current-host engineering results, not substitutes for Developer ID,
notarization, Gatekeeper, clean-host TCC/capture-indicator, Windows interactive
provider/DPI/dual-display, Authenticode/SmartScreen/signed NSIS, hosted signed CI execution, clean-machine
install/update/uninstall, VoiceOver/Narrator/NVDA, external detached signatures, or real
candidate-daemon provenance evidence.

Native adapters may improve these targets later without changing the shared contracts.

## What Already Exists

- The Desktop alpha shell already owns OS window lifecycle and narrow preload APIs;
  notifications remain separate Desktop-shell scope, while packaging and release
  hardening are still open.
- Desktop daemon startup preserves one fixed workspace authority: compatible services are
  reused, incompatible external services receive native Retry/Quit recovery, and Ling never
  kills or bypasses them with a second full daemon.
- The current verified package baseline contains only the public Cua Driver plugin shell
  metadata. That remains the current implementation and explicit external fallback
  boundary. The approved packaged macOS and Windows targets instead carry the locked
  provider and run it as a Desktop-owned embedded child; until those slices land, a
  missing external provider still fails closed with `plugin_binary_not_found`.
- The local daemon and control-plane event model already own durable runtime state and
  client subscriptions.
- Conversation surfaces already distinguish current live state from historical operation
  records. Picture-in-picture must consume the latest active projection rather than
  reconstructing state from rendered transcript text.
- The right dock and transcript can host the `Show preview` control and status without
  becoming the preview owner.

## Non-Goals

- No browser-only floating window that pretends it can stay above other applications.
- No multiple simultaneous native preview windows.
- No multiple simultaneous live capture streams. V2 switches one stream between logical
  pages and freezes inactive pages as memory-only thumbnails.
- No arbitrary browser-tab controller or cross-surface page sharing.
- No direct mouse or keyboard control inside the preview.
- No frame recording or replay.
- No private macOS or Windows composition API dependency.
- No separate Desktop-owned Computer Use state machine.
- No inference of active Computer Use from prose, tool labels, or historical records.
- No Linux implementation in the first release; the adapter boundary should allow a
  later PipeWire implementation.

## Final Verdict

The intended product surface is Mac and Windows, but platform support is gated independently:
the local unsigned macOS arm64/x64 application and mounted-DMG matrix is closed, but macOS
release still requires Developer ID/notarization/Gatekeeper plus the signed-app clean-host
TCC/source/capture-indicator and VoiceOver matrix; the selected Cua Driver Windows provider
still requires the interactive x64 HWND/source, DPI, dual-screen, Narrator/NVDA,
Authenticode/SmartScreen, and signed-NSIS matrix. Hosted CI and clean-machine
install/update/uninstall remain release gates. The shared visual and behavior layer remains
the dominant implementation; platform-specific code is restricted to capture, permission,
window integration, and optional rendering optimization.

## Open Decisions

No V2 page-deck decision remains open: one native PiP window, one live capture stream,
five resident pages, exact owner-surface scope, inactive-LRU eviction, and memory-only
inactive thumbnails are fixed for implementation.

- Exact Windows source/build lock and Ling distribution-revision advancement, including
  public risk acceptance for a prerelease source pin.
- Windows legal Publisher/signing service, minimum supported Windows build and
  policy-pinned VM matrix, whether full UIAccess is required, and whether enterprise
  distribution needs a separate per-machine artifact; the first standard candidate
  remains per-user.
