# Desktop Computer Use Picture-in-Picture

Status: approved design direction, implementation not started

Related documents:

- [Desktop Shell](desktop-shell.md)
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

Build one shared React picture-in-picture experience inside an Electron desktop shell,
with a narrow platform adapter for capture and window integration.

```text
Computer Use runtime / plugin
  -> daemon session projection and control-plane event
  -> shared API client
  -> Desktop main-process preview coordinator
  -> platform preview adapter
       macOS: Electron capture first, ScreenCaptureKit optimization later
       Windows: Electron capture first, Windows Graphics Capture optimization later
  -> dedicated picture-in-picture BrowserWindow
  -> shared React preview renderer
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

Desktop-only windows
  -> Computer Use picture-in-picture renderer
  -> future quick panels or OS-owned surfaces
```

The picture-in-picture renderer is Desktop-specific because it lives in a separate
always-on-top operating-system window. It may reuse shared design tokens and focused
conversation UI primitives, but it must not copy the main conversation page.

### Stable before the main UI is final

| Stable contract | Why it can be implemented now |
| --- | --- |
| Computer Use daemon projection | It depends on runtime identity and status, not page layout. |
| Preview coordinator and visibility state machine | Show, Hide, Close, Stop, terminal, and recovery semantics are product rules. |
| Platform capture adapter | It depends on an approved source descriptor, not toolbar placement. |
| Dedicated PiP renderer snapshot | It receives sanitized state independent of the main page component tree. |
| Selected conversation bridge | It reports a structured conversation id from the route controller. |
| Host and obstacle rectangle contract | It accepts geometry without naming a specific current component. |

### Deferred until the main UI settles

- whether `Show preview` lives in the right dock, conversation toolbar, summary popover,
  or another current-session surface;
- the final DOM elements that report composer, dock, terminal, modal, and approval
  obstacle rectangles;
- exact PiP chrome, icon placement, shadows, animation, and final screenshot baselines;
- surface-specific copy that depends on the final conversation information architecture.

### Safe fallback while UI integration is incomplete

If the main UI has not reported a host layout, Desktop places the preview inside the
current display work area using the saved preferred corner. It does not inspect or infer
private Web DOM structure.

If the main UI does not yet expose `Show preview`, auto-show and the PiP window's own Hide
and Close controls still work. This fallback is for staged implementation only; the
release completion gate still requires a discoverable current-session Show/Hide entry.

With this boundary, later UI changes affect a small capability adapter and geometry
markers. They do not rewrite capture, runtime projection, window lifecycle, or
cross-platform behavior.

## User Experience

The user sees a small floating preview when the currently selected Ling conversation has
an active Computer Use session and the first valid frame is ready.

The preview:

- stays above ordinary application windows while the Computer Use session is active;
- can remain visible when the main Ling window is blurred, minimized, or behind another
  application;
- can be dragged, resized, and snapped to a screen corner;
- avoids the Ling composer, modal dialogs, and right dock while it is anchored to the
  main Ling window;
- shows the current target application, session status, and paused or approval-required
  overlays;
- exposes `Open task`, `Hide preview`, and a separate `Stop Computer Use` action;
- never treats the window close button as permission to stop the Computer Use session.

## Visibility Semantics

Three actions must remain distinct:

| Action | Preview window | Computer Use session | Reopen behavior |
| --- | --- | --- | --- |
| Hide | Hidden but reusable; local tracks are released | Continues | `Show preview` restores it. |
| Close window | Window is destroyed and session-suppressed | Continues | Explicit `Show preview` recreates it. |
| Stop Computer Use | Closes after stop is acknowledged | Stops or cancels through the runtime owner | A new Computer Use session is required. |

The native close button and the in-preview `Hide` action are intentionally equivalent in
session semantics: neither stops Computer Use. Close releases the window itself, while
Hide allows the coordinator to reuse it later. This prevents an ordinary window-management
gesture from terminating an external side effect.

Hide or Close suppression is scoped to the current `sessionId`. It survives a Desktop
restart while that session is still active, then clears on terminal acknowledgement or
after a 24-hour safety expiry. A new Computer Use session may auto-show normally.

## Automatic Show Rules

Automatically show the preview when all conditions are true:

1. Desktop picture-in-picture is enabled.
2. The selected Ling conversation owns the latest active Computer Use session.
3. The session is not terminal.
4. A valid preview source and first frame are available.
5. The user has not hidden or closed the preview for this session.

Do not open an empty floating window while capture is still starting. Starting state
belongs in the transcript or workspace status surface until the first frame arrives.

An explicit `Show preview` action overrides the global auto-show preference for the
current session only.

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

Closing the preview after a terminal event does not delete transcript, audit, approval,
or artifact records.

## Conversation Selection

The first version supports one visible picture-in-picture preview.

- Inside Ling, the currently selected conversation determines which active session may
  present.
- When Ling loses application focus, the last selected conversation remains selected so
  the preview can stay visible over another application.
- Switching to another Ling conversation hides the previous preview immediately.
- If the new conversation has a ready active session, the same window swaps content with
  a short cross-fade.
- Historical and completed Computer Use operations never reopen picture-in-picture.

Multiple simultaneous preview windows and a stacked preview history are out of scope for
the first version.

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

### Picture-in-picture renderer owns

- preview chrome and media presentation;
- loading, paused, approval-required, stalled, completed, and failed overlays;
- drag and resize affordances delegated to the Desktop main process;
- user commands such as show, hide, open task, and stop request;
- accessibility labels, keyboard focus, and reduced-motion behavior.

### Platform adapters own

- source enumeration and capture permission checks;
- opening and stopping a preview stream;
- optional target-window focus;
- platform-specific optimization without changing shared session semantics.

Platform adapters must not decide approval policy, terminal status, or whether a stop
request is authorized.

## Cross-Platform Strategy

### First implementation

Use Electron's public capture and BrowserWindow APIs on macOS and Windows. This gives the
same visual surface and state behavior on both platforms.

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
- Raw Node.js, filesystem, shell, Accessibility, UI Automation, and input-injection APIs
  must not be exposed through preload.
- Do not persist frames, thumbnails, clipboard contents, or source-window titles in
  SQLite solely for picture-in-picture.
- A visible recording indicator and operating-system permission UX must not be hidden.
- `Stop Computer Use` routes through the same approval, runtime, and audit boundaries as
  stopping from the owning conversation.
- The preview is view-only in the first version. User takeover and direct input forwarding
  require a separate design and explicit authorization model.

## Performance Targets

First-version targets on a supported laptop:

- preview open after first frame: under 300 ms;
- visual latency: under 250 ms for local capture;
- active preview CPU: under 8% of one performance core at 30 fps;
- memory growth after ten open/close cycles: under 20 MB;
- hidden preview releases active video tracks within 500 ms;
- position update during resize or dock changes: one update per animation frame at most;
- no main-conversation scroll or typing jank while the preview is active.

Native adapters may improve these targets later without changing the shared contracts.

## What Already Exists

- The future Desktop shell already owns OS window lifecycle, notifications, and narrow
  preload APIs.
- The local daemon and control-plane event model already own durable runtime state and
  client subscriptions.
- Conversation surfaces already distinguish current live state from historical operation
  records. Picture-in-picture must consume the latest active projection rather than
  reconstructing state from rendered transcript text.
- The right dock and transcript can host the `Show preview` control and status without
  becoming the preview owner.

## Non-Goals

- No browser-only floating window that pretends it can stay above other applications.
- No multi-preview stack in the first version.
- No direct mouse or keyboard control inside the preview.
- No frame recording or replay.
- No private macOS or Windows composition API dependency.
- No separate Desktop-owned Computer Use state machine.
- No inference of active Computer Use from prose, tool labels, or historical records.
- No Linux implementation in the first release; the adapter boundary should allow a
  later PipeWire implementation.

## Final Verdict

The product surface is Mac and Windows from the first implementation. The shared visual
and behavior layer should remain the dominant implementation. Platform-specific code is
restricted to capture, permission, window integration, and optional rendering
optimization.

NO UNRESOLVED DECISIONS
