# Desktop Shell

## Status

Approved architecture direction. The minimal Electron shell and Computer Use
picture-in-picture packaging baseline are implemented; signed release closure, tray,
updater, full keychain UX, and bundled native-provider hosting remain later shell slices.

## Purpose

This document records the future desktop shell design.

Desktop should make Ling Stack feel like a local app, but it should not fork the product
model. The product state remains in the local daemon and Web feature modules. Desktop
owns OS integration.

Desktop keeps the macOS client visual treatment. Web may use a stricter platform-console
treatment, but both surfaces share the same navigation terms, state semantics, daemon
contracts, and approval boundaries.

## Goals

- Package the local Ling Stack experience.
- Start, stop, and monitor the local daemon.
- Reuse the same Web UI and daemon API.
- Add OS keychain, tray/menu bar, notifications, file picker, and update UX.
- Add cross-platform floating Computer Use preview windows without owning Computer Use
  runtime state or approval policy.
- Host reviewed embedded native providers when macOS process responsibility and TCC
  identity require the signed Desktop app to own the direct child process.
- Keep Desktop downstream of daemon state machines, approvals, leases, and audit logs.
- Render the shared `ConversationTranscript` contract from the daemon instead of copying
  Web-only conversation grouping logic.
- Reuse the shared conversation UI packages where practical:
  `packages/conversation-ui-core` for semantics and `packages/conversation-ui-react` for
  React renderer primitives.

## Default Choice

Use Electron for the first alpha.

Reasoning:

- The repo is already TypeScript, Vite, and React.
- Electron is faster for a TypeScript-first alpha.
- The Web UI can be reused with minimal platform work.
- Tauri remains a later evaluation when package size and native boundaries matter more
  than speed of iteration.

## Shared Main UI Synchronization Contract

Desktop must load the same built Web application as the browser surface. It must not keep
a copied Desktop page tree that needs manual synchronization after every Web UI change.

```text
apps/web shared build
  -> browser
  -> Desktop main BrowserWindow

apps/desktop Desktop-only renderers
  -> Computer Use PiP
  -> future OS-owned utility windows
```

Desktop differences enter through a narrow capability provider exposed by preload. A
shared component may show an OS-specific action only when that capability exists, but
the underlying conversation, dock, task, settings, and transcript models remain shared.

Rules:

- Build the Web UI and Desktop shell from the same repository revision.
- Do not copy `WorkspaceClientView`, conversation routes, dock pages, or provider/settings
  pages into `apps/desktop`.
- Do not expose generic IPC to make shared components Desktop-aware.
- Keep Desktop-specific commands behind typed capability groups.
- Keep shared semantic tokens and browser-safe renderer primitives in shared packages.
- Keep separate Desktop windows small and purpose-specific; they consume shared
  contracts but do not become a second application model.
- A main UI restyle or navigation change should normally require zero Desktop-main
  changes and at most a small capability-slot or geometry-marker update.

This allows Desktop shell and Computer Use infrastructure to start before final main UI
placement is approved.

## Target Structure

```text
apps/desktop/
  main/
    daemon-lifecycle.ts
    main.ts
    menu.ts
    notifications.ts
    tray.ts
    updates.ts
  preload/
    index.ts
  renderer/
    main-window/
      # loads the built Web UI
    computer-use-preview/
      # dedicated Desktop-only PiP renderer
  resources/
    icons/
    providers/
      cua-driver/
  tests/
```

## Embedded Native Provider Boundary

Desktop may own a native provider process when the operating system binds permissions to
the GUI application's process responsibility chain. This does not move MCP authorization
or tool policy into Desktop.

For Cua Driver on packaged macOS:

- Desktop packages and directly spawns the locked provider;
- Desktop owns permission UX, bridge publication, and process cleanup;
- the daemon owns plugin state, MCP health, tool synchronization, approvals, bindings,
  audit, and run snapshots;
- the shared renderer never receives provider stdio, path, endpoint, or secrets;
- provider enablement remains an explicit user action.

See [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md) and its
[Detailed Design](cua-driver-bundled-embedded-detailed-design.md).

## Responsibilities

Desktop owns:

- app window lifecycle,
- daemon lifecycle,
- local daemon URL injection,
- tray/menu bar,
- file picker,
- OS notifications,
- OS keychain access,
- update UX,
- crash/restart affordances.
- Computer Use picture-in-picture BrowserWindow lifecycle, screen placement, local
  visibility preferences, capture-adapter lifecycle, and media cleanup.

Desktop does not own:

- task/run/channel/provider CRUD,
- AI council CRUD, council membership projection, channel council policy, or effective
  council resolution,
- approval decisions outside daemon APIs,
- state machine transitions,
- conversation transcript projection,
- intent routing or target resolution,
- runner execution,
- provider adapters,
- GitHub automation logic,
- workspace persistence schema.
- Computer Use session legality, stop authorization, approval state, durable audit state,
  or terminal status.

## Computer Use Picture-in-Picture Boundary

Desktop presents active Computer Use state but does not reconstruct or own it.

```text
Computer Use runtime/plugin
  -> daemon projection and control-plane event
  -> Desktop preview coordinator
  -> macOS/Windows capture adapter
  -> picture-in-picture BrowserWindow
```

The shared visual and behavior layer is cross-platform. macOS and Windows differ only in
capture, permission, source focus, and optional native rendering optimization.

Hide and Close affect the preview only. `Stop Computer Use` is a separate audited runtime
command. The first version must not use private `CAContext`/`CALayerHost`, private
CoreGraphics virtual-display APIs, or undocumented Windows composition APIs.

Detailed contracts and sequencing:

- [Desktop Computer Use Picture-in-Picture](desktop-computer-use-picture-in-picture.md)
- [Desktop Computer Use Picture-in-Picture Detailed Design](desktop-computer-use-picture-in-picture-detailed-design.md)
- [Desktop Computer Use Picture-in-Picture Implementation Plan](desktop-computer-use-picture-in-picture-implementation-plan.md)

## Conversation Transcript Boundary

Desktop may style the conversation differently from Web, but it consumes the same semantic
transcript:

```text
local daemon
  -> ConversationTranscript snapshot/delta
  -> Desktop renderer
```

Desktop must not:

- parse coordinator prose to decide whether a turn is start, terminal, blocked, or
  delegated;
- regroup workflow/run/work-unit records into its own competing transcript model;
- turn raw run events into first-level conversation rows;
- own active work state after the daemon has marked the turn terminal.

Desktop may:

- render the same `OperationCell` and `AgentActivitySpan` blocks with native macOS visual
  treatment;
- reuse `conversation-ui-react` components in an Electron/Tauri renderer when the shared
  components do not depend on Web route state;
- show OS notifications for transcript state changes such as approval required, blocked,
  succeeded, or failed;
- deep-link notification clicks to the relevant transcript turn or raw/detail view.

## AI Councils Boundary

Desktop consumes the same AI council contract as Web:

```text
Desktop renderer
  -> packages/api-client
  -> local daemon
  -> ai_councils / channel_council_policies / workflow metadata
```

Desktop must not keep a separate council roster, infer council membership from rendered
Web labels, or resolve workflow specialists locally. It should call the shared client for:

- `listAiCouncils`, `getAiCouncil`, `createAiCouncil`, `cloneAiCouncil`, and
  `updateAiCouncil`;
- `getAiCouncilHealth` and `listAiCouncilMembers`;
- `getChannelCouncilPolicy`, `updateChannelCouncilPolicy`, and
  `getChannelEffectiveCouncil`;
- workflow APIs whose step metadata may include `councilSlotKey` and
  `proposalStepSources`.

Desktop council health chips should also use the browser-safe client-neutral helpers
exported from `@ling-stack/core/ai-council-view`:

- `buildAiCouncilHealthView` for one council row or inspector;
- `buildAiCouncilHealthOverviewView` for navigation/sidebar counts;
- `aiCouncilHealthViewMatchesState` for local filtering.

Renderer copy, iconography, and macOS visual treatment stay client-specific. Severity
counts, clear/unknown state, and badge ordering stay shared so Web and Desktop do not
drift.

Council endpoints remain restrict-only. Desktop native affordances such as menus,
notifications, and future keychain integration cannot turn a council selection into tool,
credential, provider, or approval authority. The daemon remains the source of truth for
source attribution and effective specialist resolution.

## Visual And Theme Model

Desktop uses the same Ling Stack product model as Web, but a different surface
treatment:

| Surface | Light treatment | Dark treatment | Theme control |
| --- | --- | --- | --- |
| Web | Strict optical-white developer console | Strict dark technical console | system / light / dark |
| Desktop | macOS glass workspace | macOS dark glass workspace | system / light / dark |

Desktop theme behavior:

- Default to `system` so the app follows macOS appearance.
- Let users manually choose `light` or `dark`; manual choice takes precedence over
  system until reset to `system`.
- Keep glass, blur, rounded app-window surfaces, macOS traffic-light chrome, and local
  client affordances in Desktop.
- Do not copy Web's strict rectangular console chrome into Desktop unless the user is in
  a dense inspector/table subview where platform-console density is useful.
- Use shared semantic tokens for status, approval, run, provider, and health states so
  screenshots remain comparable across Web and Desktop.

## Daemon Lifecycle

Startup behavior:

1. Check `http://127.0.0.1:17891/health`.
2. If a compatible daemon is already running, reuse it.
3. If no daemon is running, start the bundled/local daemon child process.
4. Mark whether the daemon was started by Desktop.
5. Inject the daemon base URL into the renderer.

Shutdown behavior:

- Stop only the daemon process started by Desktop.
- Do not kill a daemon that was already running before Desktop launched.
- If the daemon crashes, show disconnected state and a restart action.

Browser or renderer disconnect does not imply run cancellation. Durable run state remains
owned by the daemon.

## Preload API

Expose a narrow desktop API:

```ts
export interface LingDesktopApi {
  getDaemonStatus(): Promise<DaemonDesktopStatus>;
  restartDaemon(): Promise<DaemonDesktopStatus>;
  selectWorkspaceDirectory(): Promise<{ readonly path?: string; readonly cancelled: boolean }>;
  getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatus>;
  openExternal(url: string): Promise<void>;
  showNotification(input: DesktopNotificationInput): Promise<void>;
  onDaemonStatusChanged(listener: (status: DaemonDesktopStatus) => void): () => void;
}
```

Do not expose raw Node APIs, arbitrary filesystem reads/writes, shell execution, or raw
secret values to the renderer.

## Keychain Boundary

Desktop main process owns OS keychain operations. Renderer can request set/delete/status
through preload, but cannot read secret values.

The daemon should receive keychain access through a secret resolver boundary, not through
renderer IPC.

## Notifications

Notification candidates:

- pending approval,
- run succeeded,
- run failed,
- daemon crashed,
- provider check failed,
- GitHub proposed action awaiting approval.

Clicking a notification may open the relevant route. It must not approve, deny, merge,
deploy, or post externally.

## Tray and Menu

Recommended actions:

- Open Ling Stack,
- Start daemon,
- Restart daemon,
- Open workspace,
- Open logs,
- Check for updates,
- Quit.

Tray/menu actions should not perform destructive workflow actions.

## Auto-Update

v0.1 only needs the update model documented:

- stable, beta, and dev channels,
- update checks should not silently migrate SQLite without backup/checks,
- failed update must leave the previous version usable,
- release notes should mention daemon/schema compatibility.

Actual updater implementation can wait until packaging exists.

## Test Plan

When implementation starts:

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/core test -- ai-council-view
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Desktop smoke tests:

- launch with daemon already running reuses it,
- launch with daemon stopped starts it,
- quit stops only daemon started by Desktop,
- daemon crash shows disconnected state,
- restart daemon works,
- workspace picker returns an absolute path,
- renderer cannot access Node filesystem or shell APIs,
- keychain status does not expose secret value,
- notification click opens a route only.
- council health chips render from `@ling-stack/core/ai-council-view`, not duplicated Web
  label parsing or the Node-heavy `@ling-stack/core` top-level entrypoint.

## Assumptions

- Web modularization and contracts/api-client extraction should happen before serious
  desktop implementation.
- Desktop is a shell over daemon and Web, not a second client model.
- Desktop is a client over shared semantic contracts, not a second conversation
  projection implementation.
- Tauri is a later evaluation, not the v0.1 default.
