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

The V2 extension now implements a multi-page logical deck inside the existing native PiP
window. The local baseline includes exact scope reconciliation, the five-page resident cap,
inactive-LRU eviction, serialized one-stream switching, rollback and failover, stacked/tabs/
`View all` renderer states, the narrow preload/Web bridge, and zero-residue fake plus real
MediaStream validation. Signed packaged candidates and native screen-reader/platform matrices
remain release gates rather than local V2 completion claims.

The 2026-07-18 V2 matrix passes Desktop Node **337/338** with one environment-only unsigned-
candidate skip, PiP renderer **25/25**, focused shared-Web Desktop bridge E2E **19/19**, both
Desktop/Web typechecks, Web lint/i18n, real and fake smoke, and all **16** macOS arm64 Computer
Use screenshot baselines. Structured IPC regressions cover Open-task owner replay and replacement.

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
- `apps/desktop/main/computer-use/deck.ts`
- `apps/desktop/main/computer-use/deck-selectors.ts`
- `apps/desktop/main/computer-use/coordinator.ts`
- `apps/desktop/renderer/computer-use-preview/page-deck-view-model.ts`

The branch now contains a Desktop alpha application, first-class Computer Use preview
contracts, authenticated daemon compatibility with fixed-port Retry/Quit recovery,
shared-UI ownership/layout reports,
requester-bound single-use capture grants, typed obstacle transport, bounded first-frame
recovery, and fresh unsigned macOS arm64 package smokes. It is not release-complete:
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

Local run counts, performance samples, screenshots and artifact fingerprints are kept in
CI or Release artifacts. They are not part of this detailed design and cannot substitute
for signed clean-host macOS, interactive Windows, accessibility, installer lifecycle or
candidate-provenance gates.

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
      deck.ts
      deck-selectors.ts
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
      page-deck-view-model.ts
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
    reportSelectedDeckOwner(owner?: {
      readonly surfaceKind: ComputerUsePipSurfaceKind;
      readonly ownerId: string;
    }): void;
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
- V2 route controllers also report the exact `surfaceKind + ownerId` deck boundary. For the
  current channel, normal-conversation, and teammate-direct surfaces, `ownerId` is the
  structured selected conversation id. Desktop supplies the already-authoritative workspace
  identity; Web cannot choose another workspace. Absence clears the eligible deck just like
  an absent selected conversation clears V1.
- If `reportSelectedConversation()` and `reportSelectedDeckOwner()` disagree, Desktop fails
  closed for V2 deck eligibility until the structured reports converge; it never guesses which
  owner is authoritative from timing or rendered text.
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
- V2 PiP page activation and page close stay inside the isolated PiP preload boundary.
  Shared Web reports only the structured owner scope and cannot provide descriptor ids,
  native source ids, titles, or arbitrary page metadata.
- In V2, `ComputerUsePreviewSummary.sessionId` and its existing Stop action always refer to
  the active deck page. The additive summary fields `activePageId` and `pageCount` let shared
  UI show selection/count without duplicating deck order or thumbnails.
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

### V2 page-deck state

The page deck is a separate presentation axis. It must not be folded into runtime status,
source status, visibility intent, or native-window lifecycle.

```ts
export type ComputerUsePipSurfaceKind =
  | "channel"
  | "normal_conversation"
  | "teammate_direct";

export interface ComputerUsePipDeckScope {
  readonly workspaceId: string;
  readonly surfaceKind: ComputerUsePipSurfaceKind;
  readonly ownerId: string;
}

export type ComputerUsePipPagePresentationState =
  | "inactive"
  | "activating"
  | "active"
  | "unavailable"
  | "terminal";

export interface ComputerUsePipPageState {
  readonly pageId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly presentationState: ComputerUsePipPagePresentationState;
  readonly lastActivatedAt: number;
}

export interface ComputerUsePipDeckState {
  readonly scope: ComputerUsePipDeckScope;
  readonly availablePageIds: readonly string[];
  readonly pages: readonly ComputerUsePipPageState[];
  readonly dismissedPageIds: readonly string[];
  readonly activePageId?: string;
  readonly requestedPageId?: string;
  readonly switchGeneration: number;
}
```

Rules:

- `pageId` is a Desktop-local opaque identity derived one-to-one from `sessionId`. A
  descriptor revision or same-session target update changes the existing page; it does not
  append a new page.
- The deck contains at most five resident pages. A sixth open evicts the least-recently-used
  inactive page from the resident deck. It never stops that page's session and never evicts
  the active page.
- `availablePageIds` contains every eligible session in the current scope. The renderer's
  `View all` list shows metadata-only nonresident and dismissed pages. Explicitly opening one
  clears its dismissal and applies the inactive-LRU rule when the resident deck is full.
- Closing a page adds it to memory-only `dismissedPageIds`; ordinary projection reconciliation
  cannot immediately re-add it. Terminal/removal and exact scope replacement prune dismissal.
- The deck scope is exact `workspaceId + surfaceKind + ownerId`. Pages never cross channel,
  normal-conversation, or teammate-direct privacy boundaries.
- `activePageId` names the page whose source may own the single live capture stream.
  `requestedPageId` represents a serialized switch that has not passed its first-frame gate.
- Page ordering is most-recently-active first after a successful switch. A failed or stale
  switch does not reorder the deck.
- Inactive pages may own one downsampled last-frame thumbnail in renderer memory. They own
  no source handle, media track, capture grant, retry loop, or terminal timer in Desktop main.

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
  readonly deck?: {
    readonly activePageId: string;
    readonly requestedPageId?: string;
    readonly availablePageCount: number;
    readonly pages: readonly {
      readonly pageId: string;
      readonly targetLabel: string;
      readonly runtimeStatus: ComputerUseRuntimeStatus;
      readonly presentationState: ComputerUsePipPagePresentationState;
    }[];
    readonly availablePages: readonly {
      readonly pageId: string;
      readonly targetLabel: string;
      readonly runtimeStatus: ComputerUseRuntimeStatus;
      readonly resident: boolean;
    }[];
  };
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

The optional V2 `deck` block carries metadata only. `availablePages` powers `View all` and
contains only exact-current-scope structured metadata. Thumbnail pixels never cross preload or
daemon IPC. Before releasing the active media track, the isolated renderer may downsample
the current decoded frame into an in-memory thumbnail keyed by `pageId`. The renderer drops
that bitmap on page eviction, scope replacement, renderer crash, or process exit.

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

V2 replaces the one-result selector at the presentation edge with a deck selector while
leaving daemon projections unchanged:

```ts
function selectComputerUseDeckPages(input: {
  readonly scope: ComputerUsePipDeckScope;
  readonly projections: readonly ComputerUsePreviewProjection[];
}): readonly ComputerUsePreviewProjection[] {
  return input.projections
    .filter((item) => projectionBelongsToDeckScope(item, input.scope))
    .filter((item) => !isTerminalComputerUseStatus(item.status))
    .filter((item) => item.preview !== undefined)
    .sort(compareLatestComputerUseProjection);
}
```

The current `selectComputerUsePresentation()` remains the V1 compatibility path. V2 derives
one page per eligible session, reconciles it with the local resident deck, and chooses only
the active page for `selectComputerUsePipPresentation()`. Starting or approval-waiting
sessions without a descriptor remain summary-only and never become empty deck cards.

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

user activates another V2 page
  -> validate current deck scope, page eligibility, and opaque page id
  -> increment switchGeneration and coalesce rapid clicks to the latest request
  -> renderer captures a bounded memory-only thumbnail of the current frame
  -> release the current media track and consume/expire its exact grant
  -> prepare the requested page's authorized descriptor
  -> first frame arrives for the exact page/session/revision/generation
  -> atomically commit activePageId and move the page to the front
  -> if prepare or first-frame fails, invalidate the request and restore the prior page
     through the same single-stream queue while keeping its thumbnail visible

user closes a V2 page
  -> remove only the page from the resident deck
  -> add its pageId to memory-only dismissedPageIds
  -> if active, activate the next most-recent eligible page or hide the PiP
  -> release page thumbnail and local presentation state
  -> Computer Use runtime continues

user opens View all and selects a nonresident page
  -> validate exact current scope and clear its dismissedPageId
  -> evict only the least-recent inactive resident page if the five-page cap is full
  -> activate the selected page through the same release-before-prepare queue
```

At no point may the switch flow hold two live capture streams. Release acknowledgement or
forced exact-renderer teardown completes before the next adapter `prepare()` begins. This
trades a short frozen-frame transition for a much smaller privacy and resource boundary.

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
| V2 user activates inactive page | unchanged | Keep prior thumbnail visible until new first frame; then reorder deck | Release old before preparing new | None |
| V2 activation fails or becomes stale | unchanged | Keep/restore prior page and show safe retryable feedback | No stale track survives; reacquire prior page only through the serialized queue | None |
| V2 user closes inactive page | unchanged | Remove card/tab | Discard thumbnail only | None |
| V2 user closes active page | unchanged | Activate next MRU eligible page or hide | Release active track before any replacement prepare | None |
| V2 sixth page opens | unchanged | Evict least-recent inactive resident page; keep it available from page list | Discard evicted thumbnail | None |
| V2 user selects View all | unchanged | Show exact-scope metadata list; no full-page preview is mounted | No capture change | None |
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
  activatePage(pageId: string): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  closePage(pageId: string): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
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
- `reportSelectedDeckOwner({ surfaceKind, ownerId })`;
- `reportHostLayout(layout)`;
- `showComputerUsePreview(sessionId)`;
- `hideComputerUsePreview(sessionId)`;
- `stopComputerUse(sessionId)`;
- `getComputerUsePreferences()` and `setComputerUseAutoShow(enabled)`;
- `onComputerUsePreviewSummaryChanged(...)`.

The main-window summary may add `activePageId` and `pageCount`; `sessionId` continues to
name the active page's session. It never exposes deck order, thumbnails, dismissal state, or
nonresident page metadata to shared Web.

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
the current dev plus unsigned arm64 `.app` and mounted-DMG smoke matrix. The
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
- V2 page cards use real buttons with `aria-selected`, target label, runtime status, and
  position in the resident deck. Left/Right moves focus; Enter/Space activates; Delete or a
  labeled menu action closes the focused page without stopping its session.
- The `View all` control exposes the available-page count and a metadata-only list. It is
  keyboard reachable, announces the active scope, and never exposes a thumbnail for a page
  outside that scope.
- Reduced motion replaces card fan/reorder animation with an immediate state change. Focus
  remains on the activated card after reordering and moves to the next eligible card after
  close.

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
- V2 deck scope, resident page order, active/requested page ids, switch generation, and up
  to four inactive downsampled last-frame thumbnails.

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
comparisons remain separate. The latest fake ownership/crash lane records **383.38 ms
first-frame p95** and **11.32 ms page-switch p95**. It observes
`maxActiveAdapterSources = 1` and zero process/window/renderer/listener/IPC/timer/subscription/
source residue. The latest full real run records **153.73/164.31 ms** first-frame p50/p95,
**1.39/6.76 ms** Hide p50/p95, **0.23%** 30-second incremental active CPU,
**9,863,168 B** active working-set overhead, **4.9%** churn CPU, and **18,857,984 B** churn
working-set growth. Ten active samples each contain exactly one live track and every hidden
sample contains zero. Its structural assertions record **12 activations = 12 source
enumerations**, **1 renderer document**, **0 `applyConstraints()` calls**, and **0** final
lifecycle residue. Signed packaged per-process CPU/working-set, visual-latency, and
capture-indicator results remain separate G2/G3/G6 evidence.

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
| Hidden renderer throttles the first-frame callback | Disable BrowserWindow background throttling and use the 16 ms identity-bounded decoded-ready poll. The poll still requires `HAVE_CURRENT_DATA` and ends on Hide/revision/reconnect/teardown; Hide releases the source, so no hidden capture remains active. Fake sources acknowledge with a timer rather than a paint-dependent animation frame. | Hide -> Show can reopen without flashing an empty window on the supported arm64 build. | Packaged arm64 first-frame -> Hide -> Show -> Stop smoke plus real first-frame performance lane. |
| Reconnect callback races Hide or descriptor replacement | Cancel pending retries before preference I/O, serialize retry work with projection reconciliation, and revalidate selection, suppression, terminal status, descriptor id, and revision after each async permission/prepare boundary. | A hidden preview stays hidden and an old source cannot overwrite a newer revision. | Slow preference, delayed permission, and delayed old-revision prepare regressions. |
| Shutdown cleanup throws or a late source event arrives while disposal awaits release | Mark the coordinator quiescing before any await; reject new projection/renderer/display events; run every fallible cleanup inside an outer fail-safe envelope; dispose the adapter exactly once; clear timers again after queue/window drain. | App exit completes without a hidden capture grant, timer, listener, or queued reopen. | Throwing subscription/unsubscribe plus deferred release with late `sourceEnded`/`sourceFailed`. |
| Renderer does not process the release-media IPC | Require a release identity acknowledgement after all renderer tracks are ended. Hide may update UI immediately, but timeout force-destroys the renderer/window before cleanup is considered complete. | Preview disappears and capture is guaranteed to stop even if the renderer hangs; runtime continues. | Real MediaStream Hide/stall/revision/shutdown plus injected lost-IPC/hung-renderer timeout. |
| Bundled daemon cold-starts near the readiness deadline | Keep health probing bounded but allow 20 seconds for packaged cold start. Historical Rosetta validation exposed that the prior 8-second boundary was flaky; Rosetta is no longer a supported release target. | Cold packaged launch succeeds instead of randomly showing a startup failure. | arm64 mounted-DMG fake and real lifecycle smoke. |
| Stop request fails or is accepted without acknowledgement | Reconcile any returned projection, keep the authoritative active status and preview, clear pending state, and do not claim it stopped. | Error toast/overlay with an enabled retry action. | Rejected, transport-failed, timeout, and accepted-but-unacknowledged Stop regressions. |
| Producer has no authoritative pause event | Preserve the real starting/running/approval state; never synthesize `paused` from silence, capture state, or local UI inactivity. | No false `Paused` label. | Producer and run-integration histories assert approval and Stop never emit synthetic `paused`. |
| A stale drag-end snap fires after Hide, Reset, Close, replacement, or disposal | Replace the timer on every move and clear it on all lifecycle/reset paths before window state changes. | Hidden or replacement PiP is not moved and stale placement is not persisted. | Virtual-timer last-move-wins, corner persistence, and teardown/reset cancellation regressions. |
| Main window route changes rapidly | Coalesce selection and layout updates. | No stale preview flash. | Rapid route-switch E2E. |
| V2 page clicks race while a source is releasing or preparing | Serialize switches, increment `switchGeneration`, and coalesce to the latest eligible request after every async boundary. | Only the latest requested page may become active; no stale flash or leaked track. | A -> B -> C rapid-click regression with delayed release ACK and delayed B first frame. |
| Requested V2 page becomes terminal, hidden, or leaves scope before first frame | Revalidate scope, session, descriptor, and generation; cancel the request and restore the prior eligible page through the same queue. | Safe `Page no longer available` feedback; prior page remains or the PiP hides. | Terminal/scope-change during switch with stale callback denial. |
| V2 page activation fails permission or first-frame recovery | Preserve the prior memory thumbnail, release failed resources, and reacquire the prior page if still eligible. | Prior page returns live when possible; otherwise it remains frozen with explicit Retry/Open task. | Permission denial and ten-second zero-frame exhaustion during switch plus rollback. |
| V2 active page is closed or ends while inactive pages remain | Remove its local page state, select the next MRU eligible page, and use the normal single-stream switch path. | Next page activates without stopping any other session. | Active close and terminal linger with two remaining pages. |
| V2 renderer crashes with inactive thumbnails | Destroy all renderer-owned bitmaps and the exact live track; rebuild deck metadata from structured projections and auto-recreate only the still-active page under the existing one-recreation bound. | Inactive cards return without stale images; active page reconnects once. | Renderer crash with five pages and zero bitmap/track/listener residue. |

## Test Coverage Map

```text
Pure state
  selectComputerUsePresentation
    latest active selected conversation
    ignores historical terminal sessions
    keeps waiting/paused/stopping active
    handles concurrent projection updates
  reconcileComputerUsePipDeck [V2]
    one page per eligible session; descriptor revision updates in place
    exact workspace/surface/owner scope and privacy separation
    five-page resident cap and inactive-only LRU eviction
    active/requested identity and successful-switch MRU ordering
    terminal/removal pruning without runtime Stop
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
  V2 A -> B switch releases A before B prepare and commits only after B first frame
  V2 rapid A -> B -> C switch coalesces to C and rejects all stale generations
  V2 failed B switch restores A without two live tracks
  V2 active close/terminal selects next MRU page or hides with zero residue
  V2 View all lists nonresident/dismissed pages and explicit reopen clears dismissal

Renderer
  en-US / zh-CN catalog key coverage and unsupported-locale fallback
  live locale switch updates title, actions, overlays, and ARIA without media reacquisition
  16 ms decoded-ready poll is media-identity bounded and still requires current decoded data
  status overlays and controls
  accessible labels and keyboard behavior
  reduced motion
  stop failure and permission recovery
  renderer crash cleanup, one-time recreation, and bounded second-crash behavior
  V2 clickable/keyboard page cards, selected state, focus retention, and reduced motion
  V2 downsampled memory-only thumbnail cap, eviction, scope cleanup, and crash cleanup

E2E [fake adapter]
  active session -> first frame -> auto show
  switch to conversation without session -> hide
  switch back -> reopen unless session-hidden
  close window -> session continues
  explicit show -> visible
  explicit stop -> terminal close
  app blur/minimize -> preview remains visible
  stream stall -> recover or hide after timeout
  V2 open five pages -> click exposed cards -> correct active target and MRU order
  V2 open sixth page -> inactive LRU eviction without Stop
  V2 close -> refresh does not resurrect page; View all -> explicit reopen
  V2 rapid switch, failed switch rollback, active close, and terminal failover
  V2 route to a different surface/owner -> old deck and thumbnails disappear

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
- Multiple simultaneous live capture streams.
- Historical preview carousel, recorded frame history, or cross-surface deck sharing.
- Treating browser tabs or URLs as pages without an authorized Computer Use session and
  descriptor.
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

V2 must keep deck reconciliation in pure `deck.ts` / `deck-selectors.ts` modules and keep
serialized source switching in the existing coordinator operation queue. Do not add one
coordinator instance per page, one renderer per page, or page-owned retry loops. Those
approaches multiply the exact capture, recovery, and shutdown races the V1 coordinator
already closes.

## Open Decisions

V2 deck decisions are locked: one native PiP window, one live capture stream, five resident
pages, inactive memory-only thumbnails, exact owner-surface scoping, and inactive-LRU
eviction. No V2 product or architecture decision blocks implementation.

- Exact Windows source/build lock and Ling distribution-revision advancement, including
  public risk acceptance for a prerelease source pin.
- Windows legal Publisher/signing service, minimum supported Windows build and
  policy-pinned VM matrix, whether full UIAccess is required, and whether enterprise
  distribution needs a separate per-machine artifact; the first standard candidate
  remains per-user.
