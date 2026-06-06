# Plugin Manager Implementation Plan

## Status

Implemented plan for [Plugin Manager](plugin-manager.md), limited to slices 1-3:

1. catalog and read-only UI,
2. MCP preset apply,
3. plugin state and health.

This plan intentionally excludes bundled manifest loading, isolated local plugin runtime,
third-party plugin APIs, marketplace installation, and untrusted sandboxing.

## Outcome

After slices 1-3, Ling Stack should let a user:

- open Settings and see managed plugins,
- distinguish built-in, bundled, and trusted local preset capabilities,
- inspect each plugin's contributions, trust summary, linked MCP server, health, and
  approval posture,
- apply the `cua-driver` preset without hand-writing MCP config,
- check and sync the created MCP server through the existing MCP broker,
- enable or disable the plugin and linked contributions,
- keep teammate MCP tool authorization explicit,
- see plugin management audit events.

This is enough for the current plugin-management need. It does not create an external
plugin ecosystem.

## Existing Code To Reuse

Do not build a parallel plugin runtime. Reuse these existing layers:

| Concern | Existing code |
| --- | --- |
| Internal extension metadata | `packages/plugin-sdk/src/registry.ts` |
| Built-in tool and skill metadata | `packages/core/src/builtin-extensions.ts` |
| Daemon default registry assembly | `packages/daemon/src/index.ts` |
| MCP server config and tool catalog types | `packages/core/src/mcp-types.ts` |
| MCP store methods | `packages/core/src/run-types.ts`, `packages/core/src/storage/sqlite-run-store.ts` |
| MCP broker check/sync/call | `packages/daemon/src/features/mcp/broker.ts` |
| MCP HTTP routes | `packages/daemon/src/features/mcp/routes.ts` |
| MCP API client methods | `packages/api-client/src/client.ts` |
| Web MCP domain | `apps/web/src/domains/mcp/use-mcp-domain.ts` |
| Settings shell | `apps/web/src/features/settings/SettingsPage.tsx` |

One current gap: `createDaemonServer()` creates `extensionRegistry`, but
`DaemonContext` does not expose it to routes. Slice 1 must add
`extensionRegistry` to `DaemonContext` and pass it through `routeRequest`.

## Package And File Plan

### Core

Add managed plugin types:

```text
packages/core/src/plugin-manager-types.ts
```

Export them from:

```text
packages/core/src/index.ts
```

Add store interface methods to `RunStore` in:

```text
packages/core/src/run-types.ts
```

Implement persistence in:

```text
packages/core/src/storage/sqlite-run-store.ts
```

### Daemon

Add a new feature folder:

```text
packages/daemon/src/features/plugins/
  catalog.ts
  presets.ts
  routes.ts
  schemas.ts
  types.ts
```

Wire routes through:

```text
packages/daemon/src/context.ts
packages/daemon/src/server/router.ts
packages/daemon/src/server/routes.ts
```

### API Client

Add plugin DTO exports and methods in:

```text
packages/api-client/src/client.ts
packages/api-client/src/index.ts
```

### Web

Add a plugin domain and settings panel:

```text
apps/web/src/domains/plugins/use-plugins-domain.ts
apps/web/src/features/settings/PluginManagerSettingsPanel.tsx
```

Wire through:

```text
apps/web/src/api.ts
apps/web/src/types.ts
apps/web/src/features/settings/SettingsPage.tsx
apps/web/src/app/AppShell.tsx
apps/web/src/i18n.tsx
```

Use the existing MCP page for advanced linked-server editing. The plugin page should link
to or open the MCP page instead of duplicating all MCP controls.

## Core Types

Suggested initial types:

```ts
export type ManagedPluginSourceKind = "built-in" | "bundled" | "trusted-local-preset";
export type ManagedPluginStatus = "available" | "enabled" | "disabled" | "blocked";
export type ManagedPluginHealthStatus = "unknown" | "ready" | "failed" | "disabled" | "expired";

export type ManagedPluginContributionKind =
  | "mcp-server"
  | "tool"
  | "skill-pack"
  | "runner"
  | "provider"
  | "channel-source"
  | "memory"
  | "automation"
  | "ui-feature";

export interface ManagedPluginDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly description?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionDescriptor[];
  readonly defaultEnabled?: boolean;
}

export interface ManagedPluginContributionDescriptor {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
  readonly defaultApproval?: "allow" | "ask" | "deny";
}

export interface ManagedPluginRecord {
  readonly id: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly version: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly descriptor: ManagedPluginDescriptor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedPluginContributionRecord {
  readonly pluginId: string;
  readonly contributionKind: ManagedPluginContributionKind;
  readonly contributionId: string;
  readonly linkedResourceId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedPluginHealthSnapshot {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: ManagedPluginHealthStatus;
  readonly message?: string;
  readonly details?: unknown;
}

export interface ManagedPluginEvent {
  readonly id: string;
  readonly pluginId: string;
  readonly type: "enabled" | "disabled" | "preset_applied" | "checked" | "contribution_linked" | "contribution_disabled";
  readonly actor: "local-user" | "system";
  readonly message?: string;
  readonly data?: unknown;
  readonly createdAt: string;
}
```

Keep descriptors separate from records. Descriptors are catalog truth. Records are
workspace state.

## Store Model

Add tables in the next SQLite migration after the current migration constants:

```sql
CREATE TABLE IF NOT EXISTS managed_plugins (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  disabled_reason TEXT,
  descriptor_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_plugin_contributions (
  plugin_id TEXT NOT NULL,
  contribution_kind TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  linked_resource_id TEXT,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plugin_id, contribution_kind, contribution_id),
  FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_managed_plugin_contributions_linked
ON managed_plugin_contributions(linked_resource_id);

CREATE TABLE IF NOT EXISTS managed_plugin_health_snapshots (
  plugin_id TEXT PRIMARY KEY,
  status_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_managed_plugin_health_expires
ON managed_plugin_health_snapshots(expires_at);

CREATE TABLE IF NOT EXISTS managed_plugin_events (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_managed_plugin_events_plugin_created
ON managed_plugin_events(plugin_id, created_at);
```

Do not store secret values. Do not store arbitrary executable code paths except resolved
MCP server transport command paths already required by MCP server config.

Suggested `RunStore` additions:

```ts
listManagedPlugins(options?: ListManagedPluginsOptions): ManagedPluginRecord[];
getManagedPlugin(pluginId: string): ManagedPluginRecord | undefined;
upsertManagedPlugin(input: UpsertManagedPluginInput, now: string): ManagedPluginRecord;
updateManagedPlugin(pluginId: string, input: UpdateManagedPluginInput, now: string): ManagedPluginRecord | undefined;
replaceManagedPluginContributions(
  pluginId: string,
  contributions: readonly UpsertManagedPluginContributionInput[],
  now: string,
): ManagedPluginContributionRecord[];
listManagedPluginContributions(pluginId?: string): ManagedPluginContributionRecord[];
upsertManagedPluginHealthSnapshot(snapshot: ManagedPluginHealthSnapshot, now: string): ManagedPluginHealthSnapshot;
getManagedPluginHealthSnapshot(pluginId: string, now?: string): ManagedPluginHealthSnapshot | undefined;
appendManagedPluginEvent(input: CreateManagedPluginEventInput, now: string): ManagedPluginEvent;
listManagedPluginEvents(options?: ListManagedPluginEventsOptions): ManagedPluginEvent[];
```

## Catalog Assembly

Implement catalog assembly in:

```text
packages/daemon/src/features/plugins/catalog.ts
```

Inputs:

- `LingExtensionRegistry` from `DaemonContext`,
- managed plugin records from `RunStore`,
- trusted local preset descriptors from `presets.ts`,
- linked contribution records,
- health snapshots.

Rules:

- Built-in registry entries produce available descriptors even before persistence exists.
- Trusted local presets produce available descriptors until applied.
- Persisted record state overlays descriptor defaults.
- Missing persisted state does not mean missing plugin.
- A plugin is `blocked` when the descriptor exists but a platform or binary requirement is
  missing.
- Catalog output must be deterministic: sort by source tier, then display name, then id.
- Never include secret values or raw process env values.

Suggested response view:

```ts
export interface ManagedPluginView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly status: ManagedPluginStatus;
  readonly description?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionView[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly linkedResources: readonly ManagedPluginLinkedResource[];
  readonly events?: readonly ManagedPluginEvent[];
  readonly actions: {
    readonly canEnable: boolean;
    readonly canDisable: boolean;
    readonly canCheck: boolean;
    readonly canApplyPreset: boolean;
  };
}
```

## API Contract

Routes:

```http
GET /plugins?cwd=/path/to/workspace
GET /plugins/:id?cwd=/path/to/workspace
POST /plugins/:id/enable?cwd=/path/to/workspace
POST /plugins/:id/disable?cwd=/path/to/workspace
POST /plugins/:id/check?cwd=/path/to/workspace
POST /plugins/:id/apply-preset?cwd=/path/to/workspace
```

### `GET /plugins`

Returns:

```json
{
  "cwd": "/path/to/workspace",
  "plugins": []
}
```

### `GET /plugins/:id`

Returns:

```json
{
  "plugin": {
    "id": "trusted-local:cua-driver",
    "displayName": "Cua Driver",
    "sourceKind": "trusted-local-preset",
    "status": "available",
    "contributions": [],
    "linkedResources": [],
    "actions": {
      "canEnable": true,
      "canDisable": false,
      "canCheck": true,
      "canApplyPreset": true
    }
  }
}
```

### `POST /plugins/:id/enable`

Behavior:

- upserts the plugin record with `enabled = true`,
- enables linked contributions that belong to the plugin,
- if a linked MCP server exists, updates that MCP server to `enabled = true`,
- records `managed_plugin_events.enabled`,
- does not authorize teammate tools.

Returns the refreshed plugin view.

### `POST /plugins/:id/disable`

Body:

```json
{
  "reason": "No longer needed"
}
```

Behavior:

- updates the plugin record with `enabled = false`,
- disables linked contributions,
- disables linked MCP server config instead of deleting it,
- keeps MCP tool catalog and teammate bindings for historical/debug visibility,
- records `managed_plugin_events.disabled`.

Returns the refreshed plugin view.

### `POST /plugins/:id/check`

Behavior:

- for an MCP-backed plugin, delegates to the linked MCP server check when linked,
- for `cua-driver` before apply, validates platform and binary resolution,
- stores a managed plugin health snapshot,
- records `managed_plugin_events.checked`.

Returns:

```json
{
  "plugin": {},
  "health": {}
}
```

### `POST /plugins/:id/apply-preset`

Body:

```json
{
  "options": {}
}
```

Behavior:

- validates this plugin is a trusted local preset,
- creates or updates the linked MCP server config idempotently,
- stores contribution links,
- checks the MCP server,
- syncs tools only when check succeeds,
- overlays default approval posture on synced tools if needed,
- records `managed_plugin_events.preset_applied`.

Returns:

```json
{
  "plugin": {},
  "linkedMcpServer": {},
  "tools": []
}
```

Failure should return a normal daemon error response with a stable error code such as
`plugin_not_found`, `plugin_preset_not_applicable`, `plugin_binary_not_found`, or
`plugin_apply_failed`.

## Cua Driver Preset Implementation

Implement in:

```text
packages/daemon/src/features/plugins/presets.ts
```

Descriptor id:

```text
trusted-local:cua-driver
```

Linked MCP server id:

```text
mcp_cua_driver
```

Binary resolution order:

1. explicit `options.command` from `apply-preset` body,
2. `process.env.PATH` lookup for `cua-driver`,
3. known local install paths:
   - `~/.local/bin/cua-driver`,
   - `/opt/homebrew/bin/cua-driver`,
   - `/usr/local/bin/cua-driver`.

Rules:

- Store the resolved absolute command path in MCP server config.
- Do not rely on shell expansion in `transport.command`.
- Use `args: ["mcp"]`.
- Treat a successful Apply preset action as explicit user add/enable for the trusted
  local preset. Preserve disabled state only when the plugin already has linked
  contributions that the user disabled.
- Use `required: false`.
- Use conservative timeouts, for example `startupTimeoutSec: 30` and
  `toolTimeoutSec: 60`.
- Never create teammate bindings automatically.

Tool posture after sync:

- Keep MCP broker inference as the baseline.
- If `cua-driver` does not provide read-only annotations for status tools, apply a local
  allowlist override only for clearly read-only tools:
  - `check_permissions`,
  - `get_config`,
  - `get_agent_cursor_state`,
  - `get_recording_state`,
  - `get_screen_size`,
  - `list_apps`,
  - `list_windows`.
- Keep screenshot, page extraction, GUI input, app launch, config mutation, recording,
  and replay at `ask` or stronger.
- Do not classify any `cua-driver` tool as `allow` merely because it returns text.

Platform blockers:

- On non-macOS, keep the plugin visible but `blocked` with a platform message.
- If the binary is missing, `check` should fail with `plugin_binary_not_found` and include
  install guidance in `message`, not stack traces.
- If TCC permissions are missing, health should be `failed` with status-only details.

## Slice 1: Catalog And Read-Only UI

Backend:

- Add core plugin manager types.
- Add `extensionRegistry` to `DaemonContext`.
- Add `GET /plugins` and `GET /plugins/:id`.
- Generate built-in plugin views from `LingExtensionRegistry`.
- Add trusted local `cua-driver` descriptor.
- Return no secret values and no executable plugin code paths.

Frontend:

- Add API client methods and Web `api.ts` wrappers.
- Add `usePluginsDomain`.
- Add Settings `Plugins` nav item.
- Add `PluginManagerSettingsPanel`.
- Show rows for built-in capabilities and `cua-driver`.
- Keep all mutation buttons disabled or hidden in this slice.

Tests:

- daemon route test for `/plugins`,
- descriptor validation test,
- UI typecheck.

Definition of done:

- User can see plugin catalog in Settings.
- `cua-driver` appears as a trusted local preset.
- No plugin state mutation exists yet.

## Slice 2: MCP Preset Apply

Backend:

- Add `POST /plugins/:id/apply-preset`.
- Implement `cua-driver` binary resolution.
- Create or update `mcp_cua_driver` through existing `RunStore.createMcpServer` or
  `updateMcpServer`.
- Check the server through `mcpBroker.checkServer`.
- Sync tools through `mcpBroker.listTools` only if check is ready.
- Use `replaceMcpServerTools` for the synced catalog.
- Return linked MCP server and tools in response.

Frontend:

- Add "Apply preset" action on `cua-driver`.
- Show linked MCP server once created.
- Show check/sync result and tool count.
- Link to MCP settings for advanced edits.

Tests:

- preset apply creates the expected stdio MCP server,
- repeated apply is idempotent,
- missing binary returns stable error,
- apply does not create teammate MCP bindings,
- synced GUI mutation tools require approval.

Definition of done:

- User can click Apply on `cua-driver` and get a linked MCP server plus tool catalog.
- No teammate can use those tools until explicitly authorized.

## Slice 3: Plugin State And Health

Backend:

- Add SQLite tables and store methods.
- Persist plugin enabled/disabled state.
- Persist linked contributions.
- Persist health snapshots.
- Add `enable`, `disable`, and `check` routes.
- Disable linked MCP server when plugin is disabled.
- Enable linked MCP server when plugin is enabled.
- Append plugin events for enable, disable, check, apply, and contribution changes.

Frontend:

- Enable `Enable`, `Disable`, and `Check` actions.
- Show health status and latest event summary.
- Show disabled reason.
- Show linked contribution state.
- Keep teammate authorization in AI teammate/MCP assignment UI.

Tests:

- enable and disable are idempotent,
- disable keeps historical MCP tool rows but prevents runtime access through disabled
  server state,
- expired health snapshots render as expired/unknown,
- event list is chronological and redacted,
- plugin enable still does not authorize teammate tools.

Definition of done:

- User can manage plugin state and health from Settings.
- Linked MCP state follows plugin enable/disable.
- Audit evidence exists for plugin management actions.

## Safety Rules

- Enabling a plugin is not approval to run its tools.
- Applying a preset is not teammate authorization.
- Disabling a plugin should stop future access but not delete historical run evidence.
- Plugin management routes must require `cwd`.
- Plugin catalog responses must never expose secret values.
- Plugin check output must be status-only and redacted.
- MCP server deletion from the advanced MCP page should leave plugin contributions in a
  missing-linked-resource state instead of crashing catalog rendering.
- Every side-effecting plugin management route must be idempotent where possible.

## Failure Modes

| Failure | Expected behavior |
| --- | --- |
| `cua-driver` binary missing | Plugin check/apply fails with `plugin_binary_not_found` |
| macOS TCC permission missing | Health is failed with permission status details only |
| linked MCP server deleted manually | Plugin view shows missing linked resource and offers apply again |
| MCP check fails | Health snapshot is failed; apply does not sync tools |
| MCP tool schema changes | Next sync replaces tool catalog, teammate selected tools remain explicit |
| plugin disabled during a run | Current run keeps its captured access snapshot; new runs cannot resolve disabled server |
| stale health snapshot | Render expired status; do not run live checks from read-only list |

## Test Matrix

Backend:

```bash
corepack pnpm --filter @ling-stack/plugin-sdk test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/daemon typecheck
```

Frontend:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
```

Workspace:

```bash
corepack pnpm typecheck
git diff --check
```

Targeted browser smoke after UI exists:

- open Settings,
- switch to Plugins,
- verify `cua-driver` row,
- apply preset,
- verify linked MCP server/tool count,
- disable plugin,
- verify linked MCP server is disabled.

## Implementation Order

Recommended PR sequence:

1. Core types plus read-only daemon catalog.
2. API client plus Web read-only panel.
3. `cua-driver` apply-preset backend.
4. Web apply-preset action.
5. Plugin persistence, health, and events.
6. Web enable/disable/check actions.

Do not combine slices 4-6 from the main design into this implementation unless stage
1-3 is already stable and covered by tests.
