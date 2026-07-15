# Desktop Computer Use Picture-in-Picture Detailed Design

## Status

Implementation-shaped detailed design for
[Desktop Computer Use Picture-in-Picture](desktop-computer-use-picture-in-picture.md).

Implementation sequencing:
[Desktop Computer Use Picture-in-Picture Implementation Plan](desktop-computer-use-picture-in-picture-implementation-plan.md).

This document fixes the state model, selection rules, Desktop IPC, window behavior,
layout algorithm, platform adapter, recovery timers, and test cases before coding begins.

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

There is not yet a packaged Desktop application or first-class Computer Use preview
contract. The first implementation must add those boundaries instead of placing the
feature in the Web app or inferring it from transcript copy.

## Target Module Structure

```text
packages/contracts/src/
  computer-use.ts

packages/daemon/src/features/computer-use/
  preview-projection.ts
  routes.ts

packages/api-client/src/endpoints/
  computer-use.ts

apps/desktop/
  main/
    computer-use-preview/
      coordinator.ts
      layout.ts
      platform-adapter.ts
      electron-capture-adapter.ts
      window.ts
  preload/
    computer-use-preview.ts
  renderer/
    computer-use-preview/
      ComputerUsePreviewWindow.tsx
      ComputerUsePreviewControls.tsx
      ComputerUsePreviewStatusOverlay.tsx
      preview-state.ts
```

The exact file split may be compressed during implementation, but responsibilities must
not collapse into one Desktop `main.ts` or one large React component.

## Shared Main UI Integration Contract

The Desktop main window loads the same Web application build as the browser surface. It
does not maintain a parallel `DesktopWorkspaceView`, copied routes, or duplicated
conversation state.

Desktop injects capabilities through one renderer provider:

```ts
export interface LingDesktopCapabilities {
  readonly surface: "desktop";
  readonly computerUsePip: {
    reportSelectedConversation(conversationId: string | undefined): void;
    reportHostLayout(layout: ComputerUsePipHostLayout | undefined): void;
    show(sessionId: string): Promise<void>;
    hide(sessionId: string): Promise<void>;
    onSummaryChanged(
      listener: (summary: ComputerUsePipSummary | undefined) => void,
    ): () => void;
  };
}
```

The browser build receives no bridge and behaves normally. Shared components may read
capabilities through a provider or hook:

```ts
const desktop = useDesktopCapabilities();

desktop?.computerUsePip.reportSelectedConversation(selectedConversationId);
```

Rules:

- Route or surface controllers report structured conversation ids. Desktop must not read
  breadcrumbs, headings, CSS selectors, or transcript text to determine selection.
- Capability absence is normal browser behavior, not an error state.
- The shared Web application owns where the current-session Show/Hide control is mounted.
- Desktop main owns the effect of those commands.
- The capability surface stays small. Do not expose generic IPC, `desktopCapturer`, raw
  window handles, Node.js, filesystem, or shell access.
- The main Web build and Desktop shell should be produced from the same repository
  revision so contract drift cannot silently ship.

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
```

UI-bound integration should be one adapter per shared conversation surface, not copied
inside each channel, normal conversation, and teammate private chat implementation.

## Main UI Drift Rules

When the shared Web UI changes:

| Change | Required Desktop work |
| --- | --- |
| Visual restyle or token update | PiP inherits shared tokens where used; no main-window fork update. |
| Toolbar or right-dock relocation | Move only the current-session PiP control slot. |
| Composer/dock/modal DOM restructuring | Update geometry marker ownership, not layout math. |
| Conversation route refactor | Preserve the structured selected-conversation callback. |
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
export type ComputerUsePreviewSourceStatus =
  | "unavailable"
  | "connecting"
  | "ready"
  | "stalled"
  | "ended";
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
session the user hid. Suppression clears on terminal acknowledgement or after 24 hours.
It is not written to daemon SQLite.

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
  readonly targetLabel: string;
  readonly runtimeStatus: ComputerUseRuntimeStatus;
  readonly sourceStatus: ComputerUsePreviewSourceStatus;
  readonly visibilityIntent: ComputerUsePipVisibilityIntent;
  readonly frameReady: boolean;
  readonly aspectRatio: number;
  readonly cursor?: { readonly x: number; readonly y: number };
  readonly statusMessage?: string;
  readonly canStop: boolean;
  readonly canOpenSettings: boolean;
}
```

The renderer receives media through a dedicated, revocable channel owned by Desktop.
It does not receive capture credentials or enumerate arbitrary desktop sources.

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
- Terminal sessions are eligible only for their terminal linger timer.
- Application blur does not clear `selectedConversationId`.
- An internal Ling route change does update `selectedConversationId`.

## Effective Visibility Selector

```ts
function shouldPresentComputerUsePip(input: {
  readonly desktopFeatureEnabled: boolean;
  readonly globalAutoShowEnabled: boolean;
  readonly projection?: ComputerUsePreviewProjection;
  readonly sourceStatus: ComputerUsePreviewSourceStatus;
  readonly frameReady: boolean;
  readonly visibilityIntent: ComputerUsePipVisibilityIntent;
  readonly policyAllowsPresentation: boolean;
  readonly terminalLingerActive: boolean;
}): boolean {
  if (!input.desktopFeatureEnabled || !input.policyAllowsPresentation) return false;
  if (!input.projection) return false;
  if (input.sourceStatus !== "ready" && !input.terminalLingerActive) return false;
  if (!input.frameReady && !input.terminalLingerActive) return false;
  if (input.visibilityIntent === "hidden") return false;
  if (input.visibilityIntent === "shown") return true;
  return input.globalAutoShowEnabled;
}
```

This pure selector should live outside Electron-specific code and receive exhaustive unit
tests.

## State And Event Flow

```text
daemon projection arrives
  -> select active session for selected conversation
  -> resolve per-session visibility intent
  -> preview adapter connects to opaque descriptor
  -> first frame arrives
  -> evaluate shouldPresentComputerUsePip()
  -> open or reuse BrowserWindow
  -> render stream and status overlay

user hides or closes
  -> visibilityIntent = hidden for session
  -> hide BrowserWindow
  -> stop local preview tracks
  -> Computer Use runtime continues

user stops Computer Use
  -> send stop request to daemon/runtime owner
  -> keep stopping overlay until acknowledgement
  -> terminal event arrives
  -> release preview and close window
```

## Event Matrix

| Event | Visibility intent | Window action | Media action | Runtime action |
| --- | --- | --- | --- | --- |
| Active projection, source connecting | unchanged | Stay closed | Connect | None |
| First valid frame | `auto` by default | Open if selector permits | Render | None |
| User selects Show | `shown` | Open or reveal | Connect if needed | None |
| User selects Hide | `hidden` | Hide | Stop tracks within 500 ms | None |
| User closes window | `hidden` | Destroy preview window | Stop tracks | None |
| User selects Stop | unchanged | Show `Stopping` | Continue last frame | Send audited stop request |
| Approval required | unchanged | Stay visible | Continue or freeze last frame | None |
| Runtime paused | unchanged | Stay visible | Continue or freeze last frame | None |
| Selected conversation changes | new session intent or none | Hide or swap | Rebind | None |
| Ling app loses focus | unchanged | Stay visible | Continue | None |
| Ling main window minimizes | unchanged | Stay visible | Continue | None |
| Stream stalls | unchanged | Show reconnect overlay | Retry | None |
| Stream recovers before timeout | unchanged | Stay visible or reopen | Resume | None |
| Session succeeds | unchanged | Show terminal overlay, close after 1.5 s | Freeze last frame | None |
| Session fails | unchanged | Show failure, close after 5 s | Freeze last frame | None |
| Session stops/cancels | unchanged | Close within 300 ms of acknowledgement | Release | None |
| Permission revoked | unchanged | Show permission error, close after 5 s | Release | None |
| Desktop quits | clear | Destroy | Release | None |

## Stalled Stream Recovery

1. A frame gap longer than 1 second marks the source `stalled`.
2. Keep the last frame visible and show `Reconnecting`.
3. Retry the adapter with bounded exponential delays: 250 ms, 500 ms, 1 second, 2
   seconds, then stop.
4. If no frame arrives within 10 seconds, hide and release the preview window.
5. Do not stop the Computer Use session.
6. If a new valid frame later arrives and visibility intent is not `hidden`, automatic
   presentation may resume.

Only one reconnect loop may exist per session and descriptor revision.

## Window Layout Contract

The main renderer reports host and obstacle geometry to Desktop main:

```ts
export interface ComputerUsePipHostLayout {
  readonly hostId: string;
  readonly hostRect: Rectangle;
  readonly obstacleRects: readonly Rectangle[];
  readonly preferredCorner?: ComputerUsePipCorner;
  readonly source: "main-ui" | "screen-fallback";
  readonly revision: number;
}

export type ComputerUsePipCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
```

Obstacle candidates:

- conversation composer;
- right dock;
- bottom terminal panel;
- modal dialogs and approval sheets;
- summary popovers;
- operating-system safe-area and taskbar/dock work area.

The renderer reports geometry through `ResizeObserver`, relevant `MutationObserver`
updates, scroll, and route changes. Reports are coalesced to at most one per animation
frame.

Host layout availability is explicit:

```ts
type ComputerUsePipHostLayoutState =
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly layout: ComputerUsePipHostLayout }
  | { readonly status: "stale"; readonly lastLayout: ComputerUsePipHostLayout };
```

- `unavailable`: use current display work-area fallback placement.
- `ready`: use host anchors and obstacles.
- `stale`: clamp the last position to the current work area, then wait for a new report.

Desktop must not query the Web renderer for arbitrary DOM rectangles or maintain a list
of current CSS selectors as a fallback.

## Placement Algorithm

Defaults:

- initial content size: `320 x 200` logical pixels;
- minimum size: `240 x 150`;
- maximum size: `min(480 x 300, 35% of display work area width)`;
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
- Manual placement stays fixed when the Ling app loses focus.
- Resize preserves aspect ratio by default; holding the platform modifier may allow free
  resize if the source supports it.
- A display disconnect or work-area change clamps the window to the nearest remaining
  display.
- `Reset position` returns to automatic corner placement.
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

## Preload API

```ts
export interface LingComputerUsePreviewApi {
  getSnapshot(): Promise<ComputerUsePipRendererSnapshot | undefined>;
  onSnapshotChanged(
    listener: (snapshot: ComputerUsePipRendererSnapshot | undefined) => void,
  ): () => void;
  hide(): Promise<void>;
  show(): Promise<void>;
  openOwnerConversation(): Promise<void>;
  requestStop(): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  openScreenPermissionSettings(): Promise<void>;
  reportInteraction(input: { readonly kind: "hover" | "focus"; readonly active: boolean }): void;
}
```

The main application renderer receives only:

- `reportHostLayout(layout)`;
- `showComputerUsePreview(sessionId)`;
- `hideComputerUsePreview(sessionId)`;
- `onComputerUsePreviewSummaryChanged(...)`.

Do not expose `desktopCapturer`, raw `MediaStream`, native handles, or arbitrary IPC send
methods through preload.

## Platform Adapter

```ts
export interface ComputerUsePreviewPlatformAdapter {
  readonly platform: "macos" | "windows";
  getPermissionState(): Promise<"granted" | "denied" | "prompt" | "restricted">;
  open(input: {
    readonly descriptorId: string;
    readonly revision: number;
    readonly maxFrameRate: number;
    readonly maxSize: { readonly width: number; readonly height: number };
  }): Promise<ComputerUsePreviewStreamHandle>;
  focusTarget?(descriptorId: string): Promise<boolean>;
  openPermissionSettings(): Promise<void>;
}

export interface ComputerUsePreviewStreamHandle {
  readonly id: string;
  readonly aspectRatio?: number;
  close(): Promise<void>;
  onFrame(listener: (frame: ComputerUsePreviewFrame) => void): () => void;
  onEnded(listener: (reason: string) => void): () => void;
}
```

The first adapter may use Electron capture internally. The interface deliberately does
not encode Electron source IDs so native adapters can replace it.

## Visual Contract

Default preview chrome:

- 14-16px outer radius;
- one-pixel neutral border;
- platform-appropriate shadow;
- black or near-black letterbox background;
- compact top overlay with application name and live status;
- controls appear on hover, keyboard focus, paused state, approval required, or failure;
- bottom-right resize affordance uses the operating-system window resize behavior;
- no permanent red border or recording decoration beyond the required operating-system
  recording indicator;
- reduced-motion mode disables cross-fade and animated repositioning.

Control order:

```text
Open task | Hide | More
More -> Reset position | Screen permission settings | Stop Computer Use
```

`Stop Computer Use` must be visually and semantically separate from Hide and window
close.

## Accessibility

- Window title includes `Computer Use preview` and the target application.
- All icon-only controls have `aria-label` and tooltip text.
- Tab order reaches Open task, Hide, More, menu items, and failure recovery actions.
- Escape closes an open menu or returns focus; it does not stop the session.
- The window close shortcut hides the preview and does not stop the session.
- Status changes use polite live-region announcements, except stop failure and permission
  revocation, which use assertive announcements.
- Preview content itself is decorative unless the runtime supplies a safe textual target
  description.

## Persistence

Desktop-local durable preferences:

```ts
interface ComputerUsePipPreferences {
  readonly autoShowEnabled: boolean;
  readonly preferredCorner: ComputerUsePipCorner;
  readonly width: number;
  readonly displayPlacements: Readonly<Record<string, NormalizedWindowPlacement>>;
  readonly hiddenSessionSuppressions: Readonly<Record<string, string>>;
}
```

`hiddenSessionSuppressions` maps `sessionId` to an ISO expiry timestamp. Load removes
expired entries; terminal acknowledgement removes the matching session immediately.

Memory-only state:

- explicit `shown` override and current effective visibility intent;
- reconnect attempts;
- terminal linger timers;
- current source handle;
- current frame and cursor position.

Never persist frame bytes, raw source identifiers, permission tokens, or cursor history.

## Failure Modes

| Failure | Handling | User-visible result | Required test |
| --- | --- | --- | --- |
| Daemon disconnects | Freeze frame, mark stalled, reconnect subscription. | `Connection lost`. | Fake RPC disconnect and recovery. |
| Capture permission denied | Do not retry-loop capture. | Permission overlay and settings action. | Adapter permission denial. |
| Source descriptor revision changes | Close old handle before opening new one. | Short reconnect overlay. | Rapid revision replacement. |
| Two sessions race for selection | Compare selected conversation and updated timestamp atomically. | Only selected latest session appears. | Concurrent projection update. |
| User hides during connect | Record hidden intent before first frame. | Window never flashes open. | Hide-before-first-frame regression. |
| Terminal event arrives during reconnect | Cancel retry and terminal-close once. | Correct terminal overlay or immediate close. | Timer race test. |
| Display is disconnected | Clamp to remaining work area. | Preview remains reachable. | Display topology simulation. |
| Renderer crashes | Destroy tracks and recreate once if session remains eligible. | Preview briefly reconnects. | Renderer crash lifecycle test. |
| Stop request fails | Keep runtime active and do not claim it stopped. | Error toast/overlay with retry. | Failed stop acknowledgement. |
| Main window route changes rapidly | Coalesce selection and layout updates. | No stale preview flash. | Rapid route-switch E2E. |

## Test Coverage Map

```text
Pure state
  selectComputerUsePresentation
    latest active selected conversation
    ignores historical terminal sessions
    keeps waiting/paused/stopping active
    handles concurrent projection updates
  shouldPresentComputerUsePip
    global auto show on/off
    explicit shown override
    explicit hidden suppression
    source/frame readiness
    policy denial
    terminal linger

Desktop main
  source open/revision replacement/cleanup
  hide-before-first-frame
  show/hide/close do not stop runtime
  explicit stop waits for acknowledgement
  reconnect backoff and cancellation
  terminal timers and hover pause
  route selection and application blur
  display topology and bounds persistence

Renderer
  status overlays and controls
  accessible labels and keyboard behavior
  reduced motion
  stop failure and permission recovery

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
  route change reports structured conversation id
  missing host layout uses screen fallback without DOM inference
  later host layout report repositions without reopening media
  toolbar or right-dock relocation changes only the capability slot
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
preference.

NO UNRESOLVED DECISIONS
