# Desktop Shell

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
- Keep Desktop downstream of daemon state machines, approvals, leases, and audit logs.

## Default Choice

Use Electron for the first alpha.

Reasoning:

- The repo is already TypeScript, Vite, and React.
- Electron is faster for a TypeScript-first alpha.
- The Web UI can be reused with minimal platform work.
- Tauri remains a later evaluation when package size and native boundaries matter more
  than speed of iteration.

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
    # loads the built Web UI
  resources/
    icons/
  tests/
```

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

Desktop does not own:

- task/run/channel/provider CRUD,
- approval decisions outside daemon APIs,
- state machine transitions,
- runner execution,
- provider adapters,
- GitHub automation logic,
- workspace persistence schema.

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

## Assumptions

- Web modularization and contracts/api-client extraction should happen before serious
  desktop implementation.
- Desktop is a shell over daemon and Web, not a second client model.
- Tauri is a later evaluation, not the v0.1 default.
