# Desktop Computer Use Picture-in-Picture Detailed Design

## Status

Implementation-shaped detailed design for
[Desktop Computer Use Picture-in-Picture](desktop-computer-use-picture-in-picture.md).

Implementation sequencing:
[Desktop Computer Use Picture-in-Picture Implementation Plan](desktop-computer-use-picture-in-picture-implementation-plan.md).

The current provider distribution baseline remains external. The approved packaged
macOS and Windows Desktop provider boundary is defined by
[Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md) and its
[Detailed Design](cua-driver-bundled-embedded-detailed-design.md); standalone/dev mode
retains explicit external provider support.

This document fixes the state model, selection rules, Desktop IPC, window behavior,
layout algorithm, platform adapter, recovery timers, and test cases. The local implementation
baseline is verified; the companion implementation plan is the source of truth for what is
verified, partial, blocked by platform prerequisites, or still pending.

## Current Code Anchors

Existing architectural anchors:

- `apps/desktop/README.md`
- `docs/design/desktop-shell.md`
- `packages/contracts/src/control-plane.ts`
- `packages/daemon/src/features/control-plane/events.ts`
- `packages/daemon/src/features/control-plane/snapshots.ts`
- `packages/daemon/src/server/rpc.ts`
- `packages/api-client/src`
- `packages/conversation-ui-core`
- `packages/conversation-ui-react`

The branch now contains a Desktop alpha application, first-class Computer Use preview
contracts, authenticated daemon compatibility with fixed-port Retry/Quit recovery,
shared-UI ownership/layout reports,
requester-bound single-use capture grants, typed obstacle transport, bounded first-frame
recovery, and fresh unsigned macOS arm64/x64 package smokes. It is not release-complete:
Apple Developer ID signing/notarization/Gatekeeper and the signed macOS clean-host
TCC/capture-indicator matrix, Windows interactive provider/real-source/DPI/dual-screen VM
evidence, Authenticode/SmartScreen/signed NSIS, hosted signed CI, clean-machine
install/update/uninstall, VoiceOver/Narrator/NVDA acceptance, and release distribution
remain open. The local macOS harness uses report-relative artifacts, live candidate
reverification, an eight-cell architecture/TCC matrix, machine-observed revocation,
two-launch restart evidence, artifact-bound notary logs, and packaged signed performance;
every harness script is bound to its recorded harness-commit Git blob, current file bytes, and
SHA-256, so an `assume-unchanged` worktree modification cannot hide from validation;
its finalizer rejects summary-only PASS reports and unbound nested evidence, and deliberately
returns `MANUAL_REVIEW_REQUIRED` until a separate detached-signature verifier is available.
Windows Preflight/Full applies the same fail-closed principle, including pre-execution
installer/uninstaller signature checks, candidate-commit harness binding, and three
caller-fixed external trust anchors: expected candidate commit, clean repository root, and
release-policy SHA-256. They do not authenticate the reviewer name self-reported by a manual
evidence JSON. Full therefore remains `releaseReady=false` until an independent verifier validates
the canonical report digest, detached reviewer signature, and candidate-build/daemon-tree
attestation against cross-role-disjoint policy-pinned identities, key IDs, and SPKI fingerprints.
The PowerShell surface is statically
contract-tested from Node, but this macOS host
has neither `pwsh` nor Windows PowerShell, so its parser/runtime and real VM execution remain
unverified. The strict Ajv Draft 2020-12 gate compiles all eleven evidence schemas, and
`docs/release/evidence/**` path filters make schema-only changes run the Desktop artifact
workflow. Current-host real MediaStream profiling
meets the product budgets. The shared
Web locale handoff, strict locale IPC validation, renderer-local `en-US`/`zh-CN` catalog,
and live copy refresh without window or media restart are implemented and verified.

The macOS two-launch restart check uses a production daemon registry/SSE fixture with one
seeded active projection. It verifies Desktop bridge handshakes, snapshot/replay, Hide/Show,
renderer recovery, and Stop acknowledgement against the same daemon identity; it is a
transport/restart acceptance fixture, not a substitute for a real provider run, clean-host
TCC/capture-indicator, VoiceOver, signing, or notarization gate.
Post-timeout reopen blocking, fail-safe disposal, and renderer media-release
acknowledgement are implemented and verified locally. Host-layout IPC bounds, full daemon
descriptor runtime validation, truthful visibility intent, eager terminal suppression cleanup,
the provenance-negative matrix, Desktop-local source generations, header capability slot,
PiP Close action, teammate-direct obstacle markers, debounced corner snapping, and native
source-aspect-ratio propagation are also closed locally. Starting and approval-waiting
sessions without a preview descriptor remain represented by the shared summary without
creating an empty PiP. Stop requests are independently single-flight per workspace/session;
provider ownership validation is deadline/cancellation bound; explicit window catalogs cannot
be bypassed by sibling structured output; and startup failure cleans Desktop-owned resources
before process exit. The feature must continue to consume structured projections rather
than infer state from transcript copy.

Local engineering evidence recorded across 2026-07-16 and 2026-07-17:

- Final pre-commit verification on the current worktree passes Desktop Node **291/291**, PiP
  renderer **20/20**, Web E2E **35/35**, contracts **5/5**, API client **48/48**, full daemon
  **629/629**, macOS release-focused **28/28**, Windows acceptance/provider/release focused
  **57/57**, and all **11/11** strict Draft 2020-12 release-evidence schemas. The Desktop
  production build, Web production build/typecheck/lint/i18n checks, workspace typecheck/lint,
  and actionlint also pass.
- The display-media grant binds the exact loaded main document's frame token, frame-tree
  node, renderer process id, routing id, webContents, dedicated Session, URL/origin,
  authorization expiry, descriptor identity, and prepare generation. Wrong URL or Session,
  a same-partition foreign renderer, audio, a subframe, main-document navigation/reload,
  requester destruction, release interruption, expiry, and replay are denied. The authorized
  document consumes the grant once; release invalidates it, and disposal also removes the
  Session handler.
- 25,000 layout decisions average about **6.37 microseconds**. The fake ownership/crash lane
  records **415.27 ms p95**. The full real performance lane records first decoded frame at
  **168.09 ms p50 / 177.84 ms p95**, Hide plus renderer media release at **2.16 ms p50 /
  3.65 ms p95**, a 30-second active-versus-hidden CPU delta of **0.21%**, and active
  working-set overhead of **11,763,712 B**. Activation churn is **6.04% CPU** with a
  **17,661,952 B** working-set delta. Twelve capture activations perform
  exactly **12** descriptor-matching source enumerations, reuse **1** renderer document, make
  **0** post-acquisition `applyConstraints()` calls, and leave **0** process/window/renderer/
  listener/IPC/timer/subscription/source residue.
- The baseline screenshot matrix passes **10/10** macOS arm64 baselines across light, dark, and an
  explicitly emulated `prefers-reduced-motion: reduce` media query. This is visual evidence
  for the PiP renderer only; Windows visual/DPI acceptance remains a VM gate.
- The renderer release protocol binds a 500 ms request to the exact webContents, session,
  and revision. It waits for pending `getDisplayMedia()` acquisition, stops late streams,
  acknowledges only after all observed tracks are ended, and force-destroys the exact
  BrowserWindow on timeout, negative acknowledgement, or send failure without sending Stop.
  Dev fake and real capture smokes preserve the same renderer across Hide -> Show, proving
  the normal path completed through acknowledgement rather than forced teardown. The real
  lane additionally verifies a live renderer MediaStream track before Hide, zero live tracks
  after the release acknowledgement, and a newly live track after Show.
- Fresh arm64/x64 `.app` and mounted-DMG fake, real-window, and primary-display lifecycle
  plus packaged provenance smokes pass. The provenance matrix rejects wrong URL, wrong
  partition, a foreign renderer, audio, a subframe or CSP-blocked request, main-document
  reload/navigation, release interruption, expired grants, and replay while allowing one
  authorized use. Both
  DMGs pass `hdiutil verify` and both ZIPs pass `unzip -t`. Real window and primary-display
  lanes retain the PiP across app blur/main-window minimize and recover a forced renderer
  crash with a live replacement track. The candidates remain unsigned or ad-hoc, have no
  Team ID, and are rejected by Gatekeeper, so they are engineering evidence only.
- The current-host Cua handoff smoke parses Cua Driver's numeric `window_id`, verifies its
  exact equality with the Electron source id used only as the test oracle, and passes only
  the Cua-derived native window id and provider-reported owner PID into the Ling descriptor.
  It never selects by title, foreground window, z-order, or candidate proximity. The arm64
  and x64 packaged real-window application lanes pass this handoff.
- A historical unsigned Windows x64 cross-package produces an unsigned PE32+ application and NSIS
  installer with the plugin shell and checksum present. Because neither artifact has run
  on Windows, installation, Authenticode, SmartScreen, and real provider behavior remain
  external release gates.

These final pre-commit counts are current local engineering evidence for the worktree. Fixed
artifact fingerprints explicitly labeled `baseline @ e20777f5` remain commit-bound historical
references rather than current candidate hashes. Signed clean-host, interactive Windows VM,
hosted signed CI, clean-machine lifecycle, detached-signature, and real candidate-daemon
provenance gates remain separate external evidence.

## Target Module Structure

```text
packages/contracts/src/
  computer-use.ts

packages/daemon/src/features/computer-use/
  registry.ts
  cua-driver-producer.ts
  routes.ts

packages/api-client/src/endpoints/
  computer-use.ts

apps/web/src/app/
  DesktopComputerUseBridge.tsx
  DesktopComputerUseControlSlot.tsx
  use-desktop-computer-use-host-layout-reporter.ts

apps/web/src/shared/current-session/
  CurrentSessionHeaderCapability.tsx

apps/desktop/
  main/
    computer-use/
      coordinator.ts
      selectors.ts
      recovery-timers.ts
      source-session.ts
      descriptor-registry.ts
      daemon-descriptor-resolver.ts
      display-media-grant.ts
      layout.ts
      platform-adapter.ts
      electron-platform-adapter.ts
      daemon-projection-client.ts
      telemetry.ts
      window-options.ts
      window.ts
  preload/
    computer-use-preview.ts
  renderer/
    computer-use-preview/
      main.ts
      messages.ts
      preview-view-model.ts
      styles.css
```

The current alpha intentionally uses a small vanilla renderer entry. Source revision/session
and recovery timers are already extracted, but the coordinator remains large. Stage A1
keeps post-timeout eligibility in the coordinator's recovery boundary and the release
request/ack state in `source-session.ts`; follow-up work must preserve that separation rather
than adding another state cluster to the coordinator or Desktop `main.ts`.

The shared Web integration is also intentionally split along lifecycle boundaries:

```text
DesktopComputerUseBridge
  -> optional Desktop capability, locale, selected-conversation, summary subscription
  -> Show/Hide/Stop pending/failure state and stale session/request invalidation

useDesktopNavigationIntents
  -> pending open-conversation intent delivery
  -> route selection and ACK only after getConversation succeeds

useDesktopComputerUseHostLayoutReporter
  -> requestAnimationFrame coalescing
  -> ResizeObserver / MutationObserver / scroll / visualViewport reporting
  -> modal auto-marking and complete observer/listener cleanup

DesktopComputerUseControlSlot
  -> current-session status, Show/Hide/Stop presentation, i18n, pending/failure, and ARIA
```

The final main-UI pass may move `DesktopComputerUseControlSlot` and adjust semantic marker
ownership. It must not pull layout observers or command request lifecycle back into `AppShell`
or change the Desktop coordinator, capture adapter, or daemon projection.

## Shared Main UI Integration Contract

The Desktop main window loads the same Web application build as the browser surface. It
does not maintain a parallel `DesktopWorkspaceView`, copied routes, or duplicated
conversation state.

Desktop injects capabilities through one renderer provider:

```ts
export interface LingDesktopCapabilities {
  readonly platform: "macos" | "windows" | "linux";
  readonly daemonBaseUrl: string;
  readonly navigation: {
    acknowledgeIntent(requestId: number): Promise<DesktopCommandResult>;
    onIntent(
      listener: (intent: {
        readonly kind: "open_conversation";
        readonly requestId: number;
        readonly conversationId: string;
      }) => void,
    ): () => void;
  };
  readonly daemon: {
    getStatus(): Promise<DesktopDaemonStatus>;
    restart(): Promise<DesktopDaemonStatus>;
  };
  readonly computerUse: {
    reportLocale(locale: "en-US" | "zh-CN"): void;
    reportSelectedConversation(conversationId?: string): void;
    reportHostLayout(layout: ComputerUseHostLayout): void;
    show(sessionId: string): Promise<DesktopCommandResult>;
    hide(sessionId: string): Promise<DesktopCommandResult>;
    stop(sessionId: string): Promise<DesktopCommandResult>;
    getPreferences(): Promise<{ readonly previewAutoShow: boolean }>;
    setAutoShow(enabled: boolean): Promise<DesktopCommandResult>;
    onSummaryChanged(
      listener: (summary: ComputerUsePreviewSummary | undefined) => void,
    ): () => void;
  };
}
```

The browser build receives no bridge and behaves normally. The current shared Web build
mounts one AppShell-level adapter rather than adding Desktop branches to each conversation
surface:

```tsx
<DesktopComputerUseBridge
  selectedConversationId={desktopSelectedConversationId}
  hostRef={workspaceSurfaceRef}
/>
```

Rules:

- Route or surface controllers report structured conversation ids. Desktop must not read
  breadcrumbs, headings, CSS selectors, or transcript text to determine selection.
- `open_conversation` intents are consumed by `useDesktopNavigationIntents`; the Web route
  controller ACKs only after the conversation lookup and selection succeed. A missing or
  failed target remains unacknowledged so a later renderer can retry it.
- The current shared adapter covers channel branch root threads, normal conversation
  threads, and AI-teammate direct threads. Settings or diagnostics views report no owner.
- Capability absence is normal browser behavior, not an error state.
- The bridge reports the initial locale and every runtime locale change. Only exact
  `en-US` and `zh-CN` values are accepted by Desktop main; browser-only surfaces safely
  no-op because the capability is absent.
- Locale changes update only renderer presentation state. They do not replace the session,
  bump descriptor revision, reload the BrowserWindow, or reacquire `getDisplayMedia()`.
- The shared Web application owns where the current-session Show/Hide control is mounted.
- An accepted Stop request remains visibly pending until the authoritative projection enters
  `stopping` or a terminal state. A route or session replacement invalidates late results.
- Show, Hide, and Stop suppress duplicate in-flight commands, fail with fixed safe copy, and
  leave authority with the structured projection. A command that does not settle within ten
  seconds becomes locally retryable; its eventual late result is ignored.
- Desktop main owns the effect of those commands.
- The capability surface stays small. Do not expose generic IPC, `desktopCapturer`, raw
  window handles, Node.js, filesystem, or shell access.
- The main Web build and Desktop shell should be produced from the same repository
  revision so contract drift cannot silently ship.

## Daemon Startup Compatibility

Desktop keeps one fixed loopback daemon authority for the selected workspace. It does not
automatically kill a daemon it did not start, and it does not launch a second full daemon on
an isolated port. Two full daemons over the same workspace would have separate in-memory
run registries, schedulers, Computer Use projections, and SSE hubs while sharing durable
state, creating a split-brain control plane.

Startup behavior is therefore:

```text
health unavailable
  -> single-flight spawn of the bundled daemon

health + authenticated bridge compatible
  -> reuse the existing daemon

health present + bridge incompatible
  -> structured bridge_incompatible status/error
  -> native Retry / Quit prompt before the main Web window exists
       Retry -> probe again; reuse an upgraded daemon or spawn after the port is released
       Quit  -> exit without killing the external daemon
```

Repeated `ensureStarted()` calls share one startup promise, and reusing an already connected
Desktop-owned child preserves `ownedByDesktop: true`. Headless smoke remains fail-closed and
never waits for an interactive prompt.

## UI-Independent Foundation

The following modules can land before the final main UI is chosen:

```text
contracts and daemon projection
  -> api-client subscription
  -> presentation selector
  -> visibility state machine
  -> Desktop preview coordinator
  -> fake preview adapter
  -> dedicated PiP renderer shell
```

They depend only on stable session and platform contracts.

The following integration remains UI-bound:

```text
shared route controller
  -> reportSelectedConversation()

conversation layout
  -> reportHostLayout(host + obstacles)

current-session action surface
  -> Show preview / Hide preview / Stop Computer Use

Desktop navigation intent
  -> open_conversation -> route selection -> acknowledgeIntent(requestId)
```

UI-bound integration uses one AppShell bridge fed by the structured ownership selector and
the workspace host ref. Conversation, channel, and teammate surfaces contribute semantic
obstacle markers only; they do not duplicate Desktop lifecycle state or command handling.

## Main UI Drift Rules

When the shared Web UI changes:

| Change | Required Desktop work |
| --- | --- |
| Visual restyle or token update | PiP inherits shared tokens where used; no main-window fork update. |
| Toolbar or right-dock relocation | Move only the current-session PiP control slot. |
| Composer/dock/modal DOM restructuring | Update geometry marker ownership, not layout math. |
| Conversation route refactor | Preserve the structured selected-conversation callback. |
| Desktop Open-task navigation refactor | Preserve `open_conversation` delivery, successful-selection-before-ACK, and latest-selection replay semantics. |
| Transcript rendering change | No PiP change; daemon projection remains authoritative. |
| New Desktop-only OS feature | Extend the narrow capability provider, not shared product state. |

A Web UI refactor must not require edits to platform capture adapters or the Computer Use
runtime projection unless the structured contract itself intentionally changes.

## State Model

Do not create one large enum that mixes runtime state, media readiness, user preference,
and window lifecycle. Keep the axes separate and derive presentation.

### Runtime status

```ts
export type ComputerUseRuntimeStatus =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled";
```

The daemon owns this status.

### Preview-source status

```ts
// V1 renderer-safe values currently emitted by the Desktop implementation.
export type ComputerUsePreviewSourceStatus =
  | "idle"
  | "connecting"
  | "live"
  | "stalled"
  | "permission_denied"
  | "ended"
  | "failed";
```

The Desktop main process owns this status and publishes a sanitized renderer view.

### Visibility intent

```ts
export type ComputerUsePipVisibilityIntent = "auto" | "shown" | "hidden";
```

- `auto`: follow the global auto-show preference.
- `shown`: explicit show for this session, overriding global auto-show off.
- `hidden`: explicit hide or window close for this session.

Visibility intent is scoped to `sessionId`. Explicit hidden suppression is stored in
Desktop-local preferences so a Desktop crash or restart does not unexpectedly reopen a
session the user hid. Terminal and removed sessions now clear their suppression and
explicit visibility state eagerly; the 24-hour expiry remains a crash/restart fallback.
The state is not written to daemon SQLite.

### Window lifecycle

```ts
type ComputerUsePipWindowState =
  | "closed"
  | "opening"
  | "visible"
  | "hiding"
  | "closing";
```

The Desktop preview coordinator owns this state.

## Public Projection Contract

```ts
export interface ComputerUsePreviewProjection {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly status: ComputerUseRuntimeStatus;
  readonly target: {
    readonly kind: "application" | "window" | "display" | "browser";
    readonly displayName: string;
    readonly applicationId?: string;
  };
  readonly preview?: {
    readonly descriptorId: string;
    readonly revision: number;
    readonly aspectRatio?: number;
    readonly cursorAvailable: boolean;
  };
  readonly approvalRequired?: {
    readonly approvalId: string;
    readonly summary: string;
  };
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
  };
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
}
```

`descriptorId` is an opaque reference. The API must not expose raw macOS window numbers,
Win32 handles, unrestricted Electron desktop source identifiers, native window handles,
or credentials to Web clients.

## Desktop Renderer Snapshot

The preload exposes a smaller renderer-safe snapshot:

```ts
export interface ComputerUsePipRendererSnapshot {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly locale: "en-US" | "zh-CN";
  readonly targetLabel: string;
  readonly runtimeStatus: ComputerUseRuntimeStatus;
  readonly sourceStatus: ComputerUsePreviewSourceStatus;
  readonly sourceKind: "fake" | "display_media";
  readonly sourceRevision: number;
  readonly sourceGeneration: number;
  readonly visibilityIntent: ComputerUsePipVisibilityIntent;
  readonly frameReady: boolean;
  readonly aspectRatio: number;
  readonly statusDetail?: string;
  readonly canStop: boolean;
  readonly canOpenSettings: boolean;
}
```

The renderer receives media through a dedicated, revocable channel owned by Desktop.
It does not receive capture credentials or enumerate arbitrary desktop sources.

`sourceGeneration` is a Desktop-local, renderer-safe monotonic identity. Increment it for
every source activation or prepare attempt, including a descriptor-id replacement that
reuses the same daemon revision and an explicit retry of the same descriptor. Renderer
media keys, first-frame/activity/ended/failure callbacks, and renderer media-release
request/ack identities must include the exact generation. Main rejects a callback whose
generation is not current. This prevents a delayed event from descriptor A/revision 1 from
marking descriptor B/revision 1 live without exposing either descriptor id to the renderer.

`runtimeStatus`, `sourceStatus`, and renderer-local transient state select catalog copy.
`statusDetail` is reserved for genuine runtime/provider detail such as an approval summary
or capture failure. Desktop main does not send default English state labels through this
field, so a Chinese renderer cannot accidentally show mixed canonical status copy. Missing
or unsupported locale values fail safe to `en-US` inside the isolated renderer.

The three-state `visibilityIntent` remains the product contract. Snapshots emit `auto` for
global preference-driven presentation, `shown` for an explicit per-session override, and
`hidden` for user suppression. Terminal and removed sessions clear their memory-only intent
and persisted suppression eagerly; the 24-hour expiry remains a crash/restart fallback.

## Presentation Selector

The selected presentation is derived from the Desktop route and daemon projection:

```ts
function selectComputerUsePresentation(input: {
  readonly selectedConversationId?: string;
  readonly projections: readonly ComputerUsePreviewProjection[];
}): ComputerUsePreviewProjection | undefined {
  return input.projections
    .filter((item) => item.conversationId === input.selectedConversationId)
    .filter((item) => !isTerminalComputerUseStatus(item.status))
    .sort(compareLatestComputerUseProjection)[0];
}
```

Rules:

- Use structured IDs, never rendered text.
- Select only the latest active session for the selected conversation.
- `waiting_for_approval`, `paused`, and `stopping` remain active.
- `starting` and `waiting_for_approval` remain eligible for the shared current-session summary
  even when `preview` is absent. In that state Desktop reports `visible: false`, destroys any
  obsolete preview surface, and does not allocate a source generation, prepare capture, load a
  preview renderer, or create an empty BrowserWindow.
- `paused` is authoritative-only. Desktop and Web may display it only when the structured
  daemon projection explicitly reports `paused`; missing run events, approval waits, capture
  stalls, hidden windows, and local inactivity must never be relabeled as paused.
- Terminal sessions are eligible only for their terminal linger timer.
- Application blur does not clear `selectedConversationId`.
- An internal Ling route change does update `selectedConversationId`.

## Effective Visibility Selector

```ts
function selectComputerUsePipPresentation(input: {
  readonly sessionSuppressed: boolean;
  readonly explicitlyShown: boolean;
  readonly previewAutoShow: boolean;
  readonly windowVisible: boolean;
  readonly stallTimeoutBlocked: boolean;
  readonly rendererCrashBlocked: boolean;
  readonly sourceStatus: ComputerUsePreviewSourceStatus;
  readonly frameReady: boolean;
}): {
  readonly visibilityIntent: ComputerUsePipVisibilityIntent;
  readonly sourceActivationAllowed: boolean;
  readonly shouldRevealOrRetainWindow: boolean;
  readonly blockReason?: "session_hidden" | "stall_timeout" | "renderer_crash" | "auto_show_disabled";
};
```

The selector is implemented and exhaustively covers all 896 input combinations. Suppression
wins first, followed by the exact stall-timeout latch, the bounded renderer-crash block,
and auto-show being disabled for a not-yet-visible surface. Explicit Show overrides only
auto-show; its command handler clears the stall/crash blocks before reconciliation.

A selected active projection without `preview` bypasses this PiP selector entirely. It keeps
the shared summary and Stop surface truthful while holding the native window and capture
source at zero allocation until an authoritative descriptor arrives.

Initial `idle`, `connecting`, and missing-first-frame `stalled` states remain hidden. A live
decoded frame may reveal the window. An already-visible `connecting`/`stalled` surface is
retained, while `permission_denied` and source `failed` may reveal actionable recovery UI
without a frame. Terminal linger only retains an existing visible surface and never creates
or reopens one. `ComputerUsePreviewSummary.visible` is derived from the actual BrowserWindow
visibility, not reconstructed from frame/status heuristics.

## State And Event Flow

```text
daemon projection arrives
  -> select active session for selected conversation
  -> resolve per-session visibility intent
  -> if preview descriptor is absent: publish shared summary only; do not open PiP
  -> otherwise:
  -> allocate a new Desktop-local source generation
  -> preview adapter connects to opaque descriptor
  -> first frame arrives
  -> evaluate shouldPresentComputerUsePip()
  -> open or reuse BrowserWindow
  -> render stream and status overlay

user hides
  -> visibilityIntent = hidden for session
  -> hide BrowserWindow
  -> stop local preview tracks
  -> persist suppression best-effort after the safety action
  -> Computer Use runtime continues

user closes
  -> visibilityIntent = hidden for session
  -> stop local preview tracks
  -> destroy BrowserWindow after release acknowledgement or forced teardown
  -> persist suppression best-effort after the safety action
  -> Computer Use runtime continues

user stops Computer Use
  -> send stop request to daemon/runtime owner
  -> keep stopping overlay until acknowledgement
  -> if no acknowledgement arrives: return controls to active, show retryable failure
  -> terminal event arrives
  -> release preview and close window
```

## Event Matrix

| Event | Visibility intent | Window action | Media action | Runtime action |
| --- | --- | --- | --- | --- |
| `starting` or `waiting_for_approval` without preview descriptor | unchanged | No PiP; shared summary only | None | None |
| Active projection, source connecting | unchanged | Stay closed | Connect | None |
| First valid frame | `auto` by default | Open if selector permits | Render | None |
| User selects Show | `shown` | Open or reveal | Connect if needed | None |
| User selects Hide | `hidden` | Hide | Stop tracks within 500 ms | None |
| User closes window | `hidden` | Destroy preview window | Stop tracks | None |
| User selects Stop | unchanged | Show `Stopping` | Continue last frame | Send audited stop request |
| Approval required | unchanged | Stay visible | Continue or freeze last frame | None |
| Authoritative runtime `paused` projection | unchanged | Stay visible | Continue or freeze last frame | None |
| Stop accepted but not acknowledged | unchanged | Return to active/retryable controls; keep existing preview | Continue last frame | Retry remains available; do not claim stopped |
| Selected conversation changes | new session intent or none | Destroy old; create new only after its first valid frame | Release old; connect new | None |
| Ling app loses focus | unchanged | Stay visible | Continue | None |
| Ling main window minimizes | unchanged | Stay visible | Continue | None |
| Stream stalls | unchanged | Show reconnect overlay | Retry | None |
| Stream recovers before timeout | unchanged | Stay visible or reopen | Resume | None |
| Session succeeds | unchanged | Show terminal overlay, close after 1.5 s | Freeze last frame | None |
| Session fails | unchanged | Show failure, close after 5 s unless hovered/focused | Freeze last frame | None |
| Session stops/cancels | unchanged | Close within 300 ms of acknowledgement | Release | None |
| Permission revoked | unchanged | Show permission error, close after 5 s if not acted on | Release | None |
| Desktop quits | clear | Destroy | Release | None |

## Stalled Stream Recovery

1. A missing first frame or frame gap longer than 1 second marks the source `stalled`.
2. Keep the last frame visible and show `Reconnecting`.
3. Retry the adapter with bounded exponential delays: 250 ms, 500 ms, 1 second, and then
   a 2-second cap that may repeat while time remains. Each prepare gets its own one-second
   first-frame gate, but no retry may extend or replace the absolute recovery deadline.
4. If no frame arrives within 10 seconds from entering `stalled`, hide and release the
   preview. Including the initial watchdog, first connect to final hide is about 11 seconds.
5. Do not stop the Computer Use session.
6. A valid frame before the deadline resumes presentation. After expiry, V1 recovers only
   through an explicit user Show/Retry, a new descriptor identity, or an explicit Desktop
   restart. It does not listen for resume/unlock/user-active and never wakes the display.

The renderer reports decoded-frame activity at most every 250 ms. First-frame readiness is
not allowed to depend solely on `loadeddata` or `requestVideoFrameCallback`, because hidden
or occluded BrowserWindows can defer both after Chromium already has decoded data. A 16 ms
poll may report ready only when `HTMLMediaElement.readyState >= HAVE_CURRENT_DATA`; every
iteration revalidates the exact media key, acquisition generation, stream identity, and
live track. Hide, revision replacement, reconnect, teardown, or a prior frame report ends
the loop, so it cannot reveal a stale source or survive release. A generation-guarded
one-second watchdog converts a real frame gap into the bounded reconnect path. Hover/focus
pause affects only five-second runtime/source/permission failure linger timers; it never
pauses frame-gap detection, reconnect backoff, 1.5-second success, or 300 ms cancellation.
Opening Screen Settings clears the permission/source-error linger because the user has
acted and needs the preview recovery entry to remain available.

Only one reconnect loop may exist per session and descriptor revision.

Implemented behavior: timeout cleanup writes a process-local
per-session/descriptor/revision block before release, hides the window, and leaves the
runtime running. Ordinary reconciliation cannot reopen that source. Explicit Show/Retry or
a new descriptor identity clears the block; restarting Desktop rebuilds presentation state
explicitly. There is no automatic wake listener in V1.

## Window Layout Contract

The main renderer reports host and obstacle geometry to Desktop main:

```ts
export interface ComputerUseHostLayout {
  readonly windowBounds: DesktopRect;
  readonly obstacles: readonly (DesktopRect & {
    readonly kind:
      | "composer"
      | "approval"
      | "dock"
      | "terminal"
      | "modal"
      | "popover"
      | "unknown"
      | "other";
  })[];
  readonly reportedAt: string;
}
```

Obstacle candidates:

- conversation composer;
- right dock;
- bottom terminal panel;
- modal dialogs and approval sheets;
- summary popovers;
- operating-system safe-area and taskbar/dock work area.

The shared Web reporter drops zero-size rectangles, maps `right-dock` to `dock`, maps
`summary` to `popover`, and fails unsupported values safe to `unknown`; Desktop IPC performs
the final bounded validation and normalizes invalid kinds to `other`. It automatically marks
ARIA modal dialogs that lack an explicit marker and removes only those auto-added attributes
during cleanup. Geometry changes from `ResizeObserver`, relevant `MutationObserver` updates,
window or visual-viewport resize/scroll, and route-driven DOM changes are coalesced to at
most one report per animation frame.

Host layout availability is explicit:

```ts
type ComputerUsePipHostLayoutState =
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly layout: ComputerUseHostLayout }
  | { readonly status: "stale"; readonly lastLayout: ComputerUseHostLayout };
```

- `unavailable`: use current display work-area fallback placement.
- `ready`: use host anchors and obstacles.
- `stale`: clamp the last position to the current work area, then wait for a new report.

Desktop must not query the Web renderer for arbitrary DOM rectangles or maintain a list
of current CSS selectors as a fallback.

## Placement Algorithm

Defaults:

- initial content size: `420 x 263` logical pixels (approximately 16:10);
- minimum size: `320 x 200`;
- maximum size: `480 x 300`;
- host inset: `20px`;
- obstacle padding: `12px`;
- screen work-area inset: `12px`;
- candidate corners: top-left, top-right, bottom-left, bottom-right;
- maximum collision-resolution iterations: 6.

For each corner:

1. Place the preview at the corner inset.
2. Clamp it to the display work area.
3. Detect overlap with padded obstacles.
4. Generate translations above, below, left, and right of the first collision.
5. Score candidates by:
   - collision area;
   - distance from the preferred corner;
   - displacement from the previous stable location;
   - whether the candidate covers the composer or approval surface.
6. Choose the lowest score and animate only when host geometry, not user dragging,
   caused the move.

Composer and approval overlap receive effectively blocking weight. Ordinary dock or
popover overlap receives a high but movable weight.

## Manual Placement

- Dragging the preview sets `placementMode = manual` for the current display topology.
- Every native `move` event replaces a single **180 ms** snap timer. The callback reads the
  latest bounds when it fires, so continued dragging cancels the older candidate and the last
  move wins. Native `resize` persists geometry but does not schedule a corner snap.
- After drag end, choose the nearest of the four corners through the existing obstacle-aware
  candidate scorer, animate to the winning bounds, and persist the winning
  `previewPreferredCorner`, per-display normalized placement, and legacy bounds fallback.
- Manual placement stays fixed when the Ling app loses focus.
- Resize preserves aspect ratio by default; holding the platform modifier may allow free
  resize if the source supports it.
- A display disconnect or work-area change clamps the window to the nearest remaining
  display.
- `Reset position` clears any pending snap timer and returns to automatic corner placement.
- Hide, Close, native window close, window destruction, coordinator disposal, and every reset
  path clear the pending snap timer before releasing or replacing window state. A delayed drag
  callback must never move or persist a hidden/replacement window.
- Persist width, preferred corner, and normalized manual position in Desktop-local
  preferences keyed by display identity. Do not persist absolute coordinates only.

## BrowserWindow Contract

Recommended first-version settings:

```ts
new BrowserWindow({
  frame: false,
  transparent: true,
  resizable: true,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  show: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: computerUsePreviewPreloadPath,
  },
});
```

Platform-specific window levels may be used through documented Electron APIs. Do not use
private AppKit or undocumented Windows composition levels.

The coordinator's window boundary includes `setAspectRatio(aspectRatio: number)`. Apply the
descriptor ratio immediately after BrowserWindow creation, reapply a metadata-only descriptor
ratio change without reacquiring the source, and finally prefer the adapter's prepared source
ratio when it becomes available. Every finite positive source ratio is preserved, including
portrait values below `1`; invalid or non-positive values fall back to `1.6`. Automatic
placement may separately bound its initial geometry for reachability, but that layout guard
must not clamp the native resize constraint or rewrite the renderer snapshot ratio.

## Preload API

```ts
interface ComputerUsePreviewReleaseMediaRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly sourceRevision: number;
  readonly sourceGeneration: number;
}

interface ComputerUsePreviewReleaseMediaResult {
  readonly status: "released" | "already_released" | "identity_mismatch";
  readonly releasedTrackCount: number;
  readonly allTracksEnded: boolean;
}

export interface LingComputerUsePreviewApi {
  getSnapshot(): Promise<ComputerUsePipRendererSnapshot | undefined>;
  onSnapshotChanged(
    listener: (snapshot: ComputerUsePipRendererSnapshot | undefined) => void,
  ): () => void;
  onReleaseMedia(
    listener: (
      request: ComputerUsePreviewReleaseMediaRequest,
    ) => Promise<ComputerUsePreviewReleaseMediaResult> | ComputerUsePreviewReleaseMediaResult,
  ): () => void;
  retryCapture(): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  resetPosition(): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  close(): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  hide(): Promise<void>;
  openOwnerConversation(): Promise<void>;
  requestStop(): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  openScreenPermissionSettings(): Promise<void>;
  reportFrameReady(sessionId: string, revision: number, generation: number): void;
  reportFrameActivity(sessionId: string, revision: number, generation: number): void;
  reportInteraction(input: { readonly kind: "hover" | "focus"; readonly active: boolean }): void;
  reportSourceEnded(sessionId: string, revision: number, generation: number, reason: string): void;
  reportSourceFailure(sessionId: string, revision: number, generation: number, reason: string): void;
}
```

The main application renderer receives only:

- `reportLocale(locale)`;
- `reportHostLayout(layout)`;
- `showComputerUsePreview(sessionId)`;
- `hideComputerUsePreview(sessionId)`;
- `stopComputerUse(sessionId)`;
- `getComputerUsePreferences()` and `setComputerUseAutoShow(enabled)`;
- `onComputerUsePreviewSummaryChanged(...)`.

Do not expose `desktopCapturer`, raw `MediaStream`, native handles, or arbitrary IPC send
methods through preload.

The main-window `reportHostLayout` boundary accepts positive dimensions up to 100,000 px,
keeps every rectangle edge within +/-1,000,000 px so negative-coordinate displays remain
valid, processes at most 128 obstacles, strips unknown fields, normalizes unknown kinds to
`other`, and replaces malformed/stale/future timestamps with a main-process timestamp.

## Platform Adapter

```ts
export interface ComputerUsePreviewPlatformAdapter {
  readonly platform: "macos" | "windows" | "fake";
  getPermissionState(): Promise<"granted" | "denied" | "prompt" | "restricted">;
  prepare(input: {
    readonly sessionId: string;
    readonly descriptorId: string;
    readonly revision: number;
    readonly sourceGeneration: number;
    readonly requesterWebContentsId: number;
    readonly maxFrameRate: number;
    readonly maxSize: { readonly width: number; readonly height: number };
  }): Promise<{
    readonly sourceKind: "fake" | "display_media";
    readonly aspectRatio?: number;
  }>;
  release(): Promise<void>;
  dispose(): Promise<void>;
  openPermissionSettings(): Promise<void>;
}
```

The V1 Electron adapter prepares a renderer-owned `getDisplayMedia` source and exposes
only a sanitized snapshot through preload; Desktop main releases the current source before
preparing a new descriptor revision. A future native adapter may implement the same
prepare/release lifecycle without changing the daemon projection or renderer contract.

Before the first `prepare()` for a BrowserWindow, the coordinator builds a provisional
`idle` snapshot, loads the isolated preview renderer, and sends that snapshot. The adapter
therefore binds the exact current loaded main document and its dedicated Session. It never
issues a capability for a renderer document that has not loaded yet, and later Show/Hide
cycles reuse that same document instead of reloading it.

The private daemon descriptor response crosses HTTP and is runtime-validated before the
adapter sees it. Desktop accepts only macOS/Windows window/display descriptors with canonical
identity, a non-negative safe revision, a usable native/electron source id, positive process
ids, a non-expired canonical authorization timestamp, and a non-empty grant id. It constructs
a fresh allowlisted object and fails closed on malformed or mismatched responses; daemon
responses cannot select the local-only `fake` source kind.

The V1 preview renderer and display-media handler use the same dedicated, non-persistent
Electron Session partition. Do not move the handler to `session.defaultSession` as a
production workaround: the main Ling window also uses that Session, while
`setDisplayMediaRequestHandler` is Session-scoped. The handler must bind an approved source
to the current PiP `WebFrameMain` frame token, frame-tree node id, renderer process id,
routing id, webContents, dedicated Session, exact preview URL/security origin, session id,
descriptor id/revision, authorization expiry, and prepare generation; reject every other
requester; consume the grant once; and remove the handler when the adapter is disposed. A
non-same-document main-frame navigation or reload, requester destruction, release,
descriptor replacement, or disposal invalidates the grant and removes its requester
listeners. The dedicated partition is defense in depth, not a substitute for request
provenance checks.

Electron 43 on the current file-backed PiP renderer reports
`request.securityOrigin = "file:///"` and `request.frame.origin = "file://"`. The
implementation accepts only the explicit file/null serialization combinations after the
same-webContents, current-main-frame, dedicated-Session, video-only, and exact-URL checks;
it stores the requester webContents id and validates the request frame against that
webContents' current `mainFrame` at consumption time.

Implementation status: the shared boundary and fake/macOS path are implemented and pass
the current dev plus unsigned arm64/x64 `.app` and mounted-DMG smoke matrix. The
display-media grant is exact-document-bound, generation-guarded, single-use, and disposed
with the adapter. The negative matrix covers subframes, foreign/missing webContents, wrong
URL/query/origin/Session, audio requests, detached/destroyed/navigated frames, expiry,
release/dispose interruption, late rearm, and replay.
The selected Windows identity/automation provider is the exact reviewed open-source
`trycua/cua-driver-rs` `v0.8.3` provider. It supplies explicit structured HWND and PID
identity; Electron remains the PiP video capture/presentation adapter. Ling now supports
the provider's Windows plugin/install/command boundary, requires canonical HWND+PID, binds
preflight to the exact descriptor, and fails stale/missing descriptors closed. The plugin
apply/check gate also requires exact-allowlisted Cua Driver `v0.8.3`, `health_report`,
`list_windows`, and `get_window_state`; the provider-owned schema-v1 report must pass `session_active`, UIA
(`ax_capability`), and DXGI/D3D (`screen_capture_capability`). Session 0, headless graphics,
missing tools, incompatible schemas, or degraded reports fail closed. This is not release
evidence: Windows x64 VM smoke must still prove HWND source mapping, first frame,
source-ended, revision replacement, restart, DPI/dual-display, and interactive-session
behavior before Ling claims Windows real capture.

The current-host native handoff smoke does not use visual heuristics. It parses Cua's
numeric `window_id`, requires exact equality with the Electron window source id used as a
test-only oracle, and then forwards only Cua's canonical native window id plus the
provider-reported owner PID. Title matching, active-window state, z-order, and nearest-candidate
fallback are forbidden because they can silently reveal the wrong source.

The current verified baseline packages only the Cua Driver plugin shell metadata. The
target distribution is now platform-specific:

| Platform/runtime | Provider boundary |
| --- | --- |
| Packaged macOS Desktop | Ling packages locked `0.8.3 (Ling build 1)`, Electron main spawns it in embedded mode, and Ling owns the TCC identity |
| macOS standalone/dev/external override | daemon resolves an explicit or supported external command and fails missing providers closed |
| Packaged Windows Desktop | bundled source-built x64 `0.8.3 (Ling build 1)` in Desktop-owned embedded mode; standard integrity tier, Windows-team VM acceptance required |
| Windows standalone/dev/external override | separately installed exact-reviewed provider remains available |

No renderer or public Computer Use contract may depend on a native installation path. The
cross-platform process/bridge details live in the Bundled Embedded Cua Driver detailed design.

## Visual Contract

Default preview chrome:

- 12px outer radius;
- one-pixel neutral border;
- platform-appropriate shadow;
- black or near-black letterbox background;
- ordinary live mode is content-first: title, live badge, and controls stay hidden until
  hover or keyboard focus;
- authoritative paused, approval, reconnect, permission, terminal, and failure states keep their status
  chrome visible;
- bottom-right resize affordance uses the operating-system window resize behavior;
- no permanent red border or recording decoration beyond the required operating-system
  recording indicator;
- reduced-motion mode disables cross-fade and animated repositioning.

Control order:

```text
Open task | Hide | More
More -> Reset position | conditional Screen settings / Retry | Close window
     -> separator -> Stop Computer Use
```

`Stop Computer Use` must be visually and semantically separate from Hide and window
close.

Stop command presentation is renderer-local transient state, not a daemon runtime status:

```text
idle -> pending -> runtime projection owns stopping/terminal
              \-> rejected / unavailable / no ACK -> active + explicit Try Stop again
```

- `pending` disables duplicate Stop requests.
- An accepted command remains pending until the structured projection enters `stopping`
  or a terminal status; the renderer does not invent a successful stop.
- A transport result that says accepted but is not authoritatively acknowledged is treated as
  not accepted. Reconcile the returned projection, preserve its active status and preview, clear
  the pending lock, and make Stop retryable instead of leaving the UI stuck on `Stopping`.
- A rejected or failed IPC result shows safe fixed copy and an assertive retry action;
  raw internal reasons are never rendered.
- Session changes and newer request identities invalidate stale asynchronous results.
- A renderer-local typed catalog covers status labels/details, actions, window title,
  permission/retry copy, and ARIA labels for `en-US` and `zh-CN`. Runtime target labels and
  genuine provider/runtime detail remain opaque data and are not translated.

## Accessibility

- Window title includes `Computer Use preview` and the target application.
- All icon-only controls have `aria-label` and tooltip text.
- Tab order reaches Open task, Hide, More, menu items, and failure recovery actions.
- Escape closes an open menu or returns focus; it does not stop the session.
- The window close shortcut destroys the preview window, releases media, suppresses the
  current session until explicit Show, and does not stop the session. It is not an alias for Hide.
- Status changes use polite live-region announcements, except stop failure and permission
  revocation, which use assertive announcements.
- Preview content itself is decorative unless the runtime supplies a safe textual target
  description.

## Persistence

Desktop-local durable preferences:

```ts
interface ComputerUsePipPreferences {
  readonly schemaVersion: 1;
  readonly previewAutoShow: boolean;
  readonly hiddenSessionSuppressions: Readonly<Record<string, string>>;
  readonly previewPreferredCorner?: ComputerUsePipCorner;
  readonly previewDisplayPlacements?: Readonly<Record<string, ComputerUsePipNormalizedPlacement>>;
  readonly previewBounds?: DesktopRect & { readonly displayId?: string };
}
```

`hiddenSessionSuppressions` maps `sessionId` to an ISO expiry timestamp. Load removes
expired entries. Terminal and removed sessions eagerly remove their entry and memory-only
visibility/recovery state. If the best-effort terminal persistence write fails, the in-memory
state is still clear and the existing 24-hour expiry remains the bounded disk fallback.

Memory-only state:

- explicit `shown` override and current effective visibility intent;
- reconnect attempts;
- terminal linger timers;
- current source handle;
- current frame and cursor position.

Never persist frame bytes, raw source identifiers, permission tokens, or cursor history.

## Daemon Route Authorization And Retention

The daemon keeps the browser and native trust boundaries explicit:

| Caller | Required boundary | Header exposure |
| --- | --- | --- |
| Shared Web page | Allowed loopback `Origin` (same-origin/CSRF boundary) | No native token in Web code |
| Desktop main or another trusted native client with no `Origin` | Installation-scoped `X-Ling-Computer-Use-Token` | Sent only to `/computer-use/sessions`, `/snapshot`, `/events`, `/stream`, and `/stop` |
| Private descriptor resolver | `X-Ling-Desktop-Bridge-Token` | Separate header; no CORS; main-process only |

Remote Origins are rejected even when a token is presented. A missing native route-token
configuration fails closed with `503`; a missing or incorrect token fails with `403`. The
token is never accepted in a query string or forwarded to unrelated daemon routes. The
alpha Desktop may use one generated per-installation secret for both capabilities, but the
HTTP header and route checks remain separate.

The in-memory projection registry applies bounded retention rather than keeping terminal
state forever:

- terminal projections are retained for 5 minutes after `terminalAt` so a reconnecting
  Desktop can consume the terminal event;
- event history is retained for 10 minutes and capped at 2,000 events per workspace;
- private descriptors start with a 15-minute lease, can slide while an authorized source
  is actively resolved, and cannot exceed a 24-hour absolute lifetime;
- terminal projection updates and explicit removal revoke the associated private descriptor;
- pruning is lazy at registry read/subscription boundaries and does not keep a daemon timer
  alive solely for this feature.

## Privacy-Safe Local Telemetry

Desktop writes a bounded local JSONL diagnostic stream under the application user-data
directory. The schema is allowlist-only and records lifecycle facts such as first-frame
latency, recovery latency, stall events, renderer crash/recreation counts, terminal close,
and Stop acknowledgement. The file truncates at 1 MiB so diagnostics cannot grow without
bound.

The serializer must never accept or write session ids, target labels, source titles,
descriptor ids, native window ids, clipboard data, frame content, local paths, or
user-authored text. Telemetry failure is swallowed and cannot alter preview lifecycle.
Unit tests inject forbidden fields into the JavaScript call boundary and verify they are
discarded before serialization.

`node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs` measures layout
cost, fake coordinator open/close latency, heap change, and zero-residue window/listener
cleanup. Adding `--real` runs ten current-host real MediaStream Show/Hide cycles with a
one-second live hold, then records a hidden-idle CPU baseline and a separate 30-second
continuous-capture sample. It reports first-frame, release, per-process CPU, memory, renderer
media phases, and track/process residue. The machine-readable checks also lock one
descriptor-matching source enumeration per activation, reuse of the loaded renderer
document, absence of a second post-acquisition `applyConstraints()` reconfiguration, a live
track throughout steady capture, and complete release afterward. Churn and steady-state
comparisons remain separate. The latest fake ownership/crash lane records **415.27 ms p95**.
The latest full real run records **168.09/177.84 ms** first-frame p50/p95,
**2.16/3.65 ms** Hide p50/p95, **0.21%** 30-second active CPU delta, **11,763,712 B**
active working-set overhead, **6.04%** churn CPU, and **17,661,952 B** churn working-set
delta. Its structural assertions record **12 activations = 12 source
enumerations**, **1 renderer document**, **0 `applyConstraints()` calls**, and **0** lifecycle
residue. Signed packaged per-process CPU/working-set, visual-latency, and capture-indicator
results remain separate G2/G3/G6 evidence.

## Failure Modes

| Failure | Handling | User-visible result | Required test |
| --- | --- | --- | --- |
| Active `starting` or approval-waiting projection has no descriptor | Keep the structured session in the shared summary, destroy any obsolete PiP, and skip source/window allocation until a descriptor arrives. | Current-session status and Stop remain available without an empty floating window. | Starting and `waiting_for_approval` projection without `preview`, followed by descriptor arrival. |
| Daemon disconnects | Freeze frame, mark stalled, reconnect subscription. | `Connection lost`. | Fake RPC disconnect and recovery. |
| Capture permission denied | Do not retry-loop capture. | Permission overlay and settings action. | Adapter permission denial. |
| Another renderer in the preview Session requests display media | Reject unless the requester matches the exact current PiP frame token/tree node/process/routing identity, webContents, URL/origin, Session, descriptor revision, unexpired grant, and prepare generation; consume a valid grant once. Navigation, requester destruction, or release invalidates it. | No prompt, source, or frame is exposed to the foreign renderer or a replaced document. | Wrong URL/partition, same-partition foreign renderer, audio, subframe, reload/navigation, destruction, release, expiry, authorized one-shot use, and replay denial. |
| Source descriptor id or revision changes | Allocate a new source generation, close the old handle, then open the replacement. Reject all old-generation frame/activity/ended/failure and release ACK events even when the daemon revision is reused. | Short reconnect overlay; no stale source can reveal or fail the replacement. | Rapid revision replacement plus same-revision descriptor-id replacement with delayed old callbacks. |
| Two sessions race for selection | Compare selected conversation and updated timestamp atomically. | Only selected latest session appears. | Concurrent projection update. |
| User hides during connect | Record hidden intent before first frame. | Window never flashes open. | Hide-before-first-frame regression. |
| Preference persistence fails or hangs during Hide/Close/auto-show-off | Apply the in-memory policy, hide/destroy the window, and release media before awaiting persistence. Return or log the persistence failure separately; persistence must not gate the privacy action. | The preview and capture stop immediately even if settings cannot be saved; the user may be told the preference might not survive restart. | Rejected and never-settling preference-save tests for Hide, Close, and auto-show-off. |
| Display is asleep or the capture source produces no first frame | After one second enter the normal bounded reconnect path. After at most ten seconds hide the preview and release media without sending Stop or waking the display. | The task continues; the preview stays hidden until explicit Show/Retry, a new descriptor identity, or an explicit Desktop restart. | Awake/asleep smoke precondition plus full first-frame exhaustion, blocked refresh/stale callbacks, explicit Show, and post-timeout revision recovery regressions. |
| Terminal event arrives during reconnect | Cancel retry and terminal-close once. | Correct terminal overlay or immediate close. | Timer race test. |
| A terminal/source-error linger fires while route or source replacement is in progress | Enqueue cleanup on the coordinator operation queue and bind it to the exact window, session, descriptor revision, and source generation captured when the timer was armed. | An expired old linger cannot destroy or clear the newly selected preview. | Timer-fired-then-switch regression with delayed renderer release ACK. |
| Display is disconnected | Clamp to remaining work area. | Preview remains reachable. | Display topology simulation. |
| Renderer crashes | Release the dead renderer's media, detach the old window listener, destroy the old BrowserWindow, and recreate once per still-eligible active session. A second crash blocks automatic looping and waits for explicit Show. | Preview briefly reconnects; after the bounded retry the runtime remains active but the preview stays hidden until the user asks to show it. | Fake renderer-crash lifecycle test covering media-send failure, listener cleanup, first recreation, second-crash bound, and explicit Show recovery. |
| Hidden renderer throttles the first-frame callback | Disable BrowserWindow background throttling and use the 16 ms identity-bounded decoded-ready poll. The poll still requires `HAVE_CURRENT_DATA` and ends on Hide/revision/reconnect/teardown; Hide releases the source, so no hidden capture remains active. Fake sources acknowledge with a timer rather than a paint-dependent animation frame. | Hide -> Show can reopen without flashing an empty window, including macOS x64 under Rosetta. | Packaged arm64/x64 first-frame -> Hide -> Show -> Stop smoke plus real first-frame performance lane. |
| Reconnect callback races Hide or descriptor replacement | Cancel pending retries before preference I/O, serialize retry work with projection reconciliation, and revalidate selection, suppression, terminal status, descriptor id, and revision after each async permission/prepare boundary. | A hidden preview stays hidden and an old source cannot overwrite a newer revision. | Slow preference, delayed permission, and delayed old-revision prepare regressions. |
| Shutdown cleanup throws or a late source event arrives while disposal awaits release | Mark the coordinator quiescing before any await; reject new projection/renderer/display events; run every fallible cleanup inside an outer fail-safe envelope; dispose the adapter exactly once; clear timers again after queue/window drain. | App exit completes without a hidden capture grant, timer, listener, or queued reopen. | Throwing subscription/unsubscribe plus deferred release with late `sourceEnded`/`sourceFailed`. |
| Renderer does not process the release-media IPC | Require a release identity acknowledgement after all renderer tracks are ended. Hide may update UI immediately, but timeout force-destroys the renderer/window before cleanup is considered complete. | Preview disappears and capture is guaranteed to stop even if the renderer hangs; runtime continues. | Real MediaStream Hide/stall/revision/shutdown plus injected lost-IPC/hung-renderer timeout. |
| Bundled daemon cold-starts near the readiness deadline | Keep health probing bounded but allow 20 seconds for packaged cold start. The observed x64/Rosetta mounted-DMG daemon needed about 7.98 seconds, making the prior 8-second boundary flaky. | Cold packaged launch succeeds instead of randomly showing a startup failure. | x64 mounted-DMG fake and real lifecycle smoke. |
| Stop request fails or is accepted without acknowledgement | Reconcile any returned projection, keep the authoritative active status and preview, clear pending state, and do not claim it stopped. | Error toast/overlay with an enabled retry action. | Rejected, transport-failed, timeout, and accepted-but-unacknowledged Stop regressions. |
| Producer has no authoritative pause event | Preserve the real starting/running/approval state; never synthesize `paused` from silence, capture state, or local UI inactivity. | No false `Paused` label. | Producer and run-integration histories assert approval and Stop never emit synthetic `paused`. |
| A stale drag-end snap fires after Hide, Reset, Close, replacement, or disposal | Replace the timer on every move and clear it on all lifecycle/reset paths before window state changes. | Hidden or replacement PiP is not moved and stale placement is not persisted. | Virtual-timer last-move-wins, corner persistence, and teardown/reset cancellation regressions. |
| Main window route changes rapidly | Coalesce selection and layout updates. | No stale preview flash. | Rapid route-switch E2E. |

## Test Coverage Map

```text
Pure state
  selectComputerUsePresentation
    latest active selected conversation
    ignores historical terminal sessions
    keeps waiting/paused/stopping active
    handles concurrent projection updates
  selectComputerUsePipPresentation [selectors.ts; 896 combinations covered]
    global auto show on/off
    explicit shown override
    explicit hidden suppression
    source/frame readiness
    policy denial
    terminal linger

Desktop main
  locale sender/allowlist validation -> snapshot propagation
  locale-only update preserves window, source revision, media, and first-frame state
  provisional idle renderer document loads before prepare and is reused across Hide/Show
  source open/revision replacement/cleanup
  exact document capture provenance plus navigation/destruction/release invalidation
  single-use grant consumption and listener/handler disposal
  hide-before-first-frame
  first-frame timeout -> bounded reconnect -> 10 s hide without Stop
  post-timeout ordinary reconcile remains blocked until Show/revision [verified]
  show/hide/close do not stop runtime
  renderer media release ack -> timeout force-destroy [verified]
  pending getDisplayMedia -> late stream stop -> ack [verified]
  dispose quiesces late events and always disposes adapter [verified]
  explicit stop waits for acknowledgement
  reconnect backoff and cancellation
  terminal timers and hover pause
  route selection and application blur
  display topology and bounds persistence
  drag-end 180 ms debounce -> last move wins -> four-corner snap
  snap persists preferred corner + normalized placement; lifecycle/reset clears timer
  descriptor and prepared-source aspect ratio updates, including portrait ratios
  starting/approval summary without descriptor -> zero BrowserWindow allocation
  accepted-but-unacknowledged Stop -> active summary and retryable command

Renderer
  en-US / zh-CN catalog key coverage and unsupported-locale fallback
  live locale switch updates title, actions, overlays, and ARIA without media reacquisition
  16 ms decoded-ready poll is media-identity bounded and still requires current decoded data
  status overlays and controls
  accessible labels and keyboard behavior
  reduced motion
  stop failure and permission recovery
  renderer crash cleanup, one-time recreation, and bounded second-crash behavior

E2E [fake adapter]
  active session -> first frame -> auto show
  switch to conversation without session -> hide
  switch back -> reopen unless session-hidden
  close window -> session continues
  explicit show -> visible
  explicit stop -> terminal close
  app blur/minimize -> preview remains visible
  stream stall -> recover or hide after timeout

Shared UI synchronization
  browser surface works with no Desktop bridge
  Desktop main window loads the same shared Web build
  initial and runtime locale changes report through the narrow Desktop capability
  route change reports structured conversation id
  duplicate Stop clicks create one in-flight request
  duplicate Show/Hide clicks create one in-flight request
  Show/Hide rejection and transport failure expose safe retryable feedback
  accepted Stop stays pending until projection ownership changes
  replaced session or route invalidates stale Stop results
  hung command times out after ten seconds and ignores late completion
  Stop failures expose safe assertive feedback without internal reasons
  missing host layout uses screen fallback without DOM inference
  later host layout report repositions without reopening media
  toolbar or right-dock relocation changes only the capability slot
  obstacle aliases canonicalize and unknown values fail safe before layout scoring
  dynamic ARIA modal auto-markers release when identity ends or the node detaches
  paused is displayed only from an authoritative structured projection
```

## NOT In Scope

- Direct user input forwarded through the preview.
- Multiple simultaneous picture-in-picture windows.
- A preview stack or historical carousel.
- Cloud relay or off-device video streaming.
- Frame recording, screenshots, or replay generated by the preview layer.
- Native capture optimization in the first cross-platform slice.
- Browser-only implementation.
- Linux packaging.

## Implementation Risk

The largest risk is not visual styling. It is accidentally creating a second Computer Use
state machine in Desktop. The implementation must treat daemon projections as authority
and keep Desktop state limited to presentation, capture resource lifecycle, and local
preference. Source-session and recovery-timer responsibilities are already separate, but
the coordinator remains about 1,500 lines. Stage A1 kept the release request/ack state in
`source-session.ts` and limited coordinator additions to eligibility and exact-window shell
teardown. Future work must preserve that split, keep trust-boundary parsing outside the
coordinator, and avoid turning product-surface polish into another lifecycle state cluster;
broader cosmetic refactoring remains out of scope.

## Open Decisions

- Exact Windows source/build lock and Ling distribution-revision advancement, including
  public risk acceptance for a prerelease source pin.
- Windows legal Publisher/signing service, minimum supported Windows build and
  policy-pinned VM matrix, whether full UIAccess is required, and whether enterprise
  distribution needs a separate per-machine artifact; the first standard candidate
  remains per-user.
