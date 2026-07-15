# Desktop Computer Use Picture-in-Picture Implementation Plan

## Status

Proposed on 2026-07-12. Ready for staged implementation after the minimal Electron
Desktop shell can launch the shared Web UI.

Depends on:

- [Desktop Shell](desktop-shell.md)
- [Desktop Computer Use Picture-in-Picture](desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](desktop-computer-use-picture-in-picture-detailed-design.md)
- [Runtime Control Plane Detailed Design](runtime-control-plane-detailed-design.md)

## Implementation Verdict

Implement one cross-platform presentation shell with public APIs first. Keep Computer Use
runtime authority in the daemon and capture/window resource ownership in Desktop.

The first complete release target is macOS and Windows with:

- one active preview for the selected conversation;
- real approved-source capture;
- automatic show after first frame;
- deterministic hide, close, stop, terminal, and recovery behavior;
- no private macOS or Windows APIs;
- exhaustive selector, lifecycle, timer, and fake-adapter E2E coverage.

## Prerequisites

The repository currently documents Desktop but does not package it. Before picture-in-
picture integration, the minimal Desktop alpha must provide:

- Electron main, preload, and renderer entry points;
- a main BrowserWindow that loads the shared Web UI;
- context isolation, renderer sandboxing, and a narrow preload bridge;
- daemon base-URL injection and compatible daemon reuse/startup;
- Desktop-local preference storage;
- a testable BrowserWindow factory.

Do not block this feature on tray, keychain, updates, pets, or a complete Desktop settings
surface.

## UI-Independent And UI-Bound Work

The main Ling UI is not a prerequisite for most implementation work.

### Implement now

- minimal Electron main/preload/renderer shell;
- same-build Web application loading in the Desktop main window;
- Desktop capability provider with no generic IPC escape hatch;
- Computer Use contracts, daemon projection, and API-client subscription;
- selectors, visibility state machine, coordinator, timers, and persistence;
- fake adapter and dedicated PiP renderer shell;
- platform adapter boundary and lifecycle tests;
- fallback screen-corner placement when no host layout exists.

### Bind after the shared UI settles

- final current-session Show/Hide entry location;
- actual host and obstacle marker owners;
- PiP chrome and final design-token treatment;
- final screenshot baselines and motion polish.

This partition is a sequencing rule, not permission to ship an undiscoverable feature.
The final completion gate still requires shared-UI entry points and real obstacle reports.

## Foundation Slice: Minimal Desktop Shell

Goal: create only the Desktop infrastructure required for shared UI reuse and PiP.

Tasks:

1. Scaffold `@ling-stack/desktop` with Electron main, preload, renderer bootstrap, tests,
   and packaging placeholders.
2. Load the existing built Web application in the main BrowserWindow rather than copying
   its routes or feature components.
3. Inject a narrow `LingDesktopCapabilities` bridge with capability absence as the normal
   browser path.
4. Add daemon base-URL injection, reuse/start behavior, and clean shutdown ownership.
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
   - stop acknowledgement.
5. Define Desktop-local authority:
   - visibility intent;
   - window state;
   - source handle;
   - layout and preferences.
6. Add contract serialization tests for every status and optional field.

Done when:

- Desktop can consume one structured projection without parsing transcript content.
- Raw native handles and unrestricted desktop source IDs are absent from public DTOs.
- Hide, close, and stop semantics are represented separately.

## Slice 1: Daemon Preview Projection

Goal: expose the latest active Computer Use presentation state through the existing local
control plane.

Tasks:

1. Add `features/computer-use/preview-projection.ts`.
2. Accept normalized Computer Use runtime events from a runtime or plugin adapter.
3. Maintain one latest projection per `sessionId` and index active sessions by
   `conversationId`.
4. Publish projection changes through the control-plane event stream.
5. Add snapshot/read support for reconnecting clients.
6. Add an audited stop endpoint or RPC method that delegates to the runtime owner.
7. On daemon restart, restore only durable active-session identity supported by the
   runtime supervisor. Do not restore frame descriptors that are no longer valid.
8. Add tests for:
   - start -> running -> terminal;
   - waiting approval and paused states;
   - descriptor revision replacement;
   - duplicate and out-of-order events;
   - stop accepted, rejected, and failed;
   - control-plane subscriber reconnect.

Done when:

- Web or Desktop clients can obtain the authoritative current projection.
- Terminal sessions do not appear as active after the linger information has been
  delivered.
- A stop request is attributable and auditable.

## Slice 2: Shared Selection And Visibility Logic

Goal: make all show/hide decisions pure, deterministic, and testable without Electron.

Tasks:

1. Add pure functions for:
   - active presentation selection;
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
   - approval, pause, and stopping;
   - success, failure, cancellation, and permission timers;
   - hide-before-first-frame;
   - hidden suppression across Desktop restart and expiry;
   - terminal event during reconnect.

Done when:

- No BrowserWindow code contains independent visibility policy.
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
4. Open only after source readiness and first frame.
5. Reuse the same window across eligible session swaps.
6. Hide and release tracks when user-hidden or route-ineligible.
7. Destroy on Desktop quit and after terminal linger.
8. Add main-process tests with fake BrowserWindow and fake adapter.

Done when:

- Window close destroys the preview window without sending stop.
- Stop is sent only from the explicit stop command.
- Ten open/close cycles leave no live tracks, listeners, timers, or orphan windows.

## Slice 4: Cross-Platform Electron Capture Adapter

Goal: ship one public-API capture implementation on macOS and Windows.

Tasks:

1. Add `ElectronComputerUsePreviewAdapter` behind
   `ComputerUsePreviewPlatformAdapter`.
2. Resolve only the opaque descriptor supplied by the trusted runtime bridge.
3. Check capture permission before opening.
4. Limit first-version capture to:
   - 30 fps;
   - 960 x 600 maximum source size before presentation scaling;
   - cursor metadata only when the source already provides it safely.
5. Send the media channel to the dedicated preview renderer without exposing source
   enumeration to the renderer.
6. Close old tracks before opening a new descriptor revision.
7. Normalize macOS and Windows errors into shared codes.
8. Add platform smoke tests:
   - macOS permission granted/denied;
   - Windows source open/end;
   - source window closes during capture;
   - display topology changes;
   - app shutdown cleanup.

Done when:

- A real approved window or display can be previewed on macOS and Windows.
- Renderer code is identical across both platforms.
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

1. Render source with aspect-fit letterboxing.
2. Add live, approval-required, paused, stopping, reconnecting, completed, failed, and
   permission-required overlays.
3. Add controls:
   - Open task;
   - Hide preview;
   - More;
   - Reset position;
   - Screen permission settings;
   - Stop Computer Use.
4. Keep controls hidden during ordinary live viewing and reveal them on hover, keyboard
   focus, or non-running states.
5. Add accessible labels, keyboard order, live regions, and reduced motion.
6. Ensure Escape closes menus only.
7. Add component tests and screenshot coverage at the default, minimum, and maximum
   sizes in light and dark modes.

Done when:

- Hide, Close, and Stop are visually distinguishable.
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
3. Add the four-corner candidate and six-iteration collision algorithm.
4. Persist preferred corner, width, and normalized manual position per display.
5. Support drag, resize, Reset position, display disconnect, taskbar/dock work-area
   changes, and main-window movement.
6. Add deterministic geometry tests and Desktop E2E tests at:
   - 1280 x 800;
   - 1440 x 900;
   - 1920 x 1080;
   - two-display topology.

Done when:

- The preview never covers the composer or an approval sheet in automatic mode.
- Manual placement remains reachable after a display is disconnected.
- Window movement does not cause continuous position oscillation.

## Slice 7: Settings And Conversation Entry Points

Goal: let users understand and control preview visibility even when the window is hidden.

Tasks:

1. Add Desktop setting:
   - `Automatically show Computer Use picture-in-picture`;
   - default on;
   - Desktop-local, not a daemon execution policy.
2. Add current-session control to the owning conversation or right dock:
   - `Show preview` when hidden;
   - `Hide preview` when visible;
   - live status and target application;
   - separate `Stop Computer Use` action.
3. Hide the section when no active Computer Use session exists.
4. Do not render historical completed sessions as available previews.
5. Add i18n strings in the shared Desktop/Web locale path used by the renderer.
6. Add tests for current-session-only visibility and global-setting override behavior.

Done when:

- The user can always recover a hidden preview from the active conversation.
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
- projection ordering and idempotency;
- presentation selection;
- effective visibility;
- terminal timers;
- reconnect backoff;
- collision scoring and clamping;
- preference normalization.

### Integration

- daemon event -> API client -> Desktop coordinator;
- descriptor revision -> adapter replacement -> renderer snapshot;
- explicit stop -> daemon acknowledgement -> terminal close;
- permission denial -> settings recovery action;
- renderer crash -> cleanup and bounded recreation.

### Desktop E2E

```text
active session
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
  -> acknowledgement
  -> preview closes
```

Additional E2E cases:

- switching between active and inactive conversations;
- waiting approval and paused overlays;
- hide-before-first-frame;
- source stall recovery and timeout;
- completed and failed linger timers;
- two-display disconnect;
- right dock, composer, modal, and approval obstacle avoidance;
- keyboard-only control navigation;
- light, dark, and reduced-motion modes.

## Verification Commands

Exact commands should be finalized when `@ling-stack/desktop` is scaffolded. Expected
shape:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/daemon test -- computer-use
corepack pnpm --filter @ling-stack/api-client test -- computer-use
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop test
corepack pnpm --filter @ling-stack/desktop test:e2e -- computer-use-preview
corepack pnpm --filter @ling-stack/web build
git diff --check
```

## Parallelization Strategy

| Lane | Work | Depends on |
| --- | --- | --- |
| A | Contract and daemon projection | Slice 0 contract lock |
| B | Desktop shell/window coordinator and fake adapter | Slice 0 contract lock |
| C | Preview renderer and visual tests | Renderer snapshot contract from Slice 2 |
| D | Layout algorithm and geometry tests | BrowserWindow boundary from Slice 3 |
| E | Real Electron capture adapters | Platform adapter contract from Slice 4 |

Recommended order:

```text
Foundation Slice
  -> Slice 0
  -> Lane A + Lane B in parallel
  -> Lane C + Lane D in parallel after coordinator snapshot stabilizes
  -> Lane E after adapter lifecycle tests pass with the fake adapter
  -> settings, recovery, cross-platform smoke, and performance closure
```

Potential conflict:

- Lanes B and D both touch `apps/desktop/main/computer-use-preview`; keep layout math in
  its own module or implement them sequentially.
- Lanes A and settings work may both touch contract exports and API-client indexes; land
  contract exports first.

## NOT In Scope

- Direct interaction with the target app through the preview.
- Native ScreenCaptureKit, Metal, Windows Graphics Capture, or Direct3D optimization in
  the first cross-platform release.
- Multiple simultaneous previews.
- Remote/cloud video relay.
- Linux packaging.
- Recording or replay.
- Desktop tray, updater, keychain, and unrelated shell completion.
- Copying Codex native assets, private APIs, or bundled implementation.

## Implementation Tasks

- [ ] **T0 (P1, human: ~2 days / Codex: ~2 h)** — desktop-shell — Scaffold the minimal Electron shell, shared Web loading, capability provider, and fake PiP renderer entry.
- [ ] **T1 (P1, human: ~1 day / Codex: ~45 min)** — contracts — Add the structured Computer Use preview projection and status contracts.
- [ ] **T2 (P1, human: ~2 days / Codex: ~2 h)** — daemon — Publish authoritative preview projections and audited stop commands.
- [ ] **T3 (P1, human: ~2 days / Codex: ~2 h)** — desktop-main — Build the preview coordinator, window lifecycle, selectors, and fake adapter.
- [ ] **T4 (P1, human: ~2 days / Codex: ~2 h)** — desktop-renderer — Build the accessible preview surface and state overlays.
- [ ] **T5 (P1, human: ~2 days / Codex: ~2 h)** — capture — Add public-API Electron capture on macOS and Windows.
- [ ] **T6 (P2, human: ~1 day / Codex: ~1 h)** — layout — Add collision avoidance, manual placement, persistence, and topology recovery.
- [ ] **T7 (P2, human: ~1 day / Codex: ~1 h)** — product-surface — Add settings and current-session Show/Hide controls.
- [ ] **T8 (P1, human: ~2 days / Codex: ~2 h)** — verification — Close lifecycle, failure, E2E, platform smoke, and performance gaps.

## Completion Definition

The feature is complete only when:

- Desktop and browser use the same shared Web application rather than forked pages;
- an unfinished or later-refactored main UI affects only capability slots and geometry
  reporters, not the preview coordinator or capture adapters;
- macOS and Windows both show a real approved Computer Use source;
- first-frame, Show, Hide, Close, Stop, route switch, app blur, terminal, permission, and
  stall behavior match the detailed event matrix;
- closing the preview never stops the session;
- explicit stop is acknowledged before the UI claims termination;
- private APIs are absent;
- media tracks and windows clean up under repeat and crash tests;
- all specified unit, integration, E2E, accessibility, and performance checks pass.

NO UNRESOLVED DECISIONS
