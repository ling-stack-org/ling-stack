# Plugin Manager Implementation Plan

## Status

Implemented plan for [Plugin Manager](plugin-manager.md), limited to slices 1-3:

1. catalog and read-only UI,
2. MCP preset apply,
3. plugin state and health.

This plan intentionally excludes bundled manifest loading, isolated local plugin runtime,
third-party plugin APIs, marketplace installation, and untrusted sandboxing.

This document also records the follow-up Stage 4-5 implementation design so the later
work can be picked up without reopening the product boundary.

The Stage 4-5 Cua Driver package-shell text describes the implemented external baseline.
It is not the target packaged Desktop provider boundary. The superseding macOS and
Windows target is [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md), while
standalone/dev and explicit external fallback keep the existing shell/preset behavior.

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

## Codex-Derived Follow-Up Layers

Codex's open-source plugin manager is useful as a reference because it separates plugin
governance into five layers: manifest/schema, marketplace/source, install cache, runtime
capability injection, and MCP/app/hook policy overlay. Stage 1-3 intentionally implements
only the current Ling need: managed catalog state, safe MCP preset application, and health
visibility.

The remaining layers should be sequenced after Stage 1-3 is stable:

| Layer | Next Ling step | Not in Stage 1-3 |
| --- | --- | --- |
| Manifest/schema | Define `.ling-plugin/plugin.json`, validate id/version/interface/contribution paths, and compile it into `ManagedPluginDescriptor`. | No external SDK contract yet. |
| Marketplace/source | Add a local/bundled index for trusted packages. | No public marketplace, Git install, remote source resolver, or third-party API. |
| Install cache | Materialize trusted local and bundled packages under a Ling-owned versioned cache. | No arbitrary npm/package manager install. |
| Runtime capability injection | Inject enabled package skills, MCP servers, apps, and hooks into session/run capability snapshots. | No bypass around teammate bindings or approval policy. |
| MCP/app/hook policy overlay | Add per-plugin policy overrides for contributed MCP servers, app connectors, hooks, and tools. | No automatic authorization from install or enable. |

This backlog is deliberately narrower than copying Codex wholesale. Ling should continue
to use its daemon APIs, runner registry, MCP broker, and approval policy as the authority
boundary.

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

Stage 1-3 descriptors are not package manifests. A future manifest should compile into
these descriptors and records after validation, rather than becoming a second runtime
truth source.

Future manifest fields should cover:

- stable plugin id, display name, version, and compatible Ling interface version;
- source tier and trust level;
- declared contribution paths for skills, MCP servers, apps, hooks, providers, runners,
  memory, automations, or UI features;
- required secrets by name only, never secret values;
- default approval posture and side-effect classifications;
- platform requirements and health-check declarations.

Manifest path rules should be strict:

- contribution paths must be relative to the plugin root;
- paths must not escape the package through `..`, symlinks, or absolute paths;
- manifest parsing should produce redacted diagnostics;
- parsed manifests should grant no execution authority until enabled and policy-checked.

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
- Package manifest parsing must not grant authority, execute code, or read secrets.
- Install/cache operations must materialize packages into Ling-owned directories before
  runtime injection reads package files.
- Runtime capability injection must happen through a captured run/session capability
  snapshot so disabling a plugin affects new runs predictably.
- Per-plugin MCP/app/hook policy overlays must be applied before capabilities reach a
  teammate or runner.

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

## Stage 4-5 Detailed Design

Stage 4-5 turns the Stage 1-3 control plane into a package-aware plugin system for
built-in, bundled, and trusted local plugins. It still does not create a third-party
marketplace or allow arbitrary remote code loading.

### Shared Principles

- Keep Stage 1-3 managed plugin records as the product-facing state model.
- Treat package manifests as inputs that compile into managed descriptors, linked
  resources, and policy defaults.
- Materialize package contents into a Ling-owned cache before runtime injection reads
  package files.
- Freeze enabled plugin capabilities into a run/session snapshot before the runner starts.
- Apply per-plugin MCP/app/hook policy overlays before capabilities reach teammates,
  runners, or model context.
- Keep install, enable, runtime injection, and teammate authorization separate.
- Do not silently install or update external binaries such as `CuaDriver.app`.

### Stage 4: Manifest/Schema And Bundled Source

Stage 4 introduces the package format and trusted source index. It should not execute
package code.

Suggested files:

```text
packages/core/src/plugin-package-types.ts
packages/plugin-sdk/src/manifest.ts
packages/daemon/src/features/plugins/manifest.ts
packages/daemon/src/features/plugins/source-index.ts
packages/daemon/src/features/plugins/bundled-index.ts
packages/daemon/src/features/plugins/bundled/cua-driver/.ling-plugin/plugin.json
packages/daemon/src/features/plugins/bundled/cua-driver/README.md
```

The package entry point is:

```text
.ling-plugin/plugin.json
```

Initial manifest shape:

```ts
export interface LingPluginPackageManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly lingInterfaceVersion: string;
  readonly sourceKind: "bundled" | "trusted-local";
  readonly trustLevel: "internal" | "internal-isolated" | "trusted-local-preset";
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly platforms?: readonly ("darwin" | "linux" | "win32")[];
  readonly contributions: readonly LingPluginPackageContribution[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly healthChecks?: readonly ManagedPluginHealthCheck[];
}

export type LingPluginPackageContribution =
  | { readonly kind: "mcp-server"; readonly id: string; readonly path: string }
  | { readonly kind: "skill-pack"; readonly id: string; readonly path: string }
  | { readonly kind: "app"; readonly id: string; readonly path: string }
  | { readonly kind: "hook"; readonly id: string; readonly path: string }
  | { readonly kind: "runner"; readonly id: string; readonly path: string }
  | { readonly kind: "provider"; readonly id: string; readonly path: string }
  | { readonly kind: "ui-feature"; readonly id: string; readonly path: string };
```

Validation rules:

- `id` must be stable and globally unique within Ling's plugin catalog.
- `version` must be semver-compatible for bundled packages.
- `lingInterfaceVersion` must match a supported loader version.
- contribution ids must be unique within the plugin.
- contribution paths must start inside the plugin root and must not be absolute.
- `..`, empty path segments, and symlink escapes are rejected after canonicalization.
- manifests may declare secret names but must never contain secret values.
- unknown contribution kinds are rejected in Stage 4.
- parse errors return redacted diagnostics and do not expose raw env, tokens, or absolute
  user paths unless the path is already a user-selected local plugin root.

Bundled source index:

```ts
export interface BundledPluginIndex {
  readonly version: 1;
  readonly plugins: readonly BundledPluginIndexEntry[];
}

export interface BundledPluginIndexEntry {
  readonly id: string;
  readonly sourceKind: "bundled";
  readonly packageRoot: string;
  readonly pinnedVersion: string;
  readonly sha256?: string;
  readonly defaultInstalled?: boolean;
}
```

Source rules:

- bundled package roots are controlled by the Ling distribution;
- trusted local package roots must be user-selected or explicitly configured;
- Git, remote URL, npm, and marketplace source resolvers are out of scope;
- duplicate source entries resolve deterministically by source tier, package id, then
  version;
- Stage 4 can show installable bundled plugins even before Stage 5 cache materialization.

Daemon API additions:

```http
GET /plugins/sources?cwd=/path/to/workspace
GET /plugins/packages/:id?cwd=/path/to/workspace
POST /plugins/:id/validate-package?cwd=/path/to/workspace
```

`validate-package` should parse and validate only. It must not create MCP servers, install
packages, enable plugins, or authorize tools.

Stage 4 definition of done:

- bundled package manifests parse into `ManagedPluginDescriptor`;
- invalid paths, duplicate ids, incompatible interface versions, and unsupported
  contribution kinds are rejected;
- bundled CUA plugin shell appears as installable metadata;
- no package code executes during listing or validation;
- Stage 1-3 plugin UI can display package-derived descriptors.

### Stage 4 CUA Bundled Plugin Shell

The implemented CUA plugin package remains a metadata-only Ling plugin shell. The plugin
package itself does not contain `CuaDriver.app` or a `cua-driver` binary. The approved
packaged macOS and Windows providers are separate Desktop resources owned by the Bundled
Embedded Cua Driver boundary; standalone/dev and explicit external fallback continue to
link this shell to an external binary.

Example manifest:

```json
{
  "id": "bundled:cua-driver",
  "displayName": "Cua Driver",
  "version": "0.1.0",
  "lingInterfaceVersion": "1",
  "sourceKind": "bundled",
  "trustLevel": "trusted-local-preset",
  "description": "Connects Ling to an already installed Cua Driver MCP server.",
  "trustSummary": "Controls native macOS apps through Accessibility and Screen Recording permissions.",
  "platforms": ["darwin"],
  "contributions": [
    {
      "kind": "mcp-server",
      "id": "mcp:cua-driver",
      "path": "./mcp-server.json"
    }
  ],
  "healthChecks": [
    {
      "id": "cua-driver-binary",
      "kind": "command",
      "label": "cua-driver binary"
    },
    {
      "id": "macos-tcc",
      "kind": "platform-permission",
      "label": "Accessibility and Screen Recording"
    }
  ]
}
```

The package may include a `README.md` with install guidance, but Ling should expose it as
help text only. Any download/open-link action must be user-confirmed.

### Stage 5: Install Cache

Stage 5 materializes validated packages into a Ling-owned cache and links workspace state
to the cached package. The cache should be content-addressed or version-pinned enough to
make rollbacks and audit possible.

Suggested files:

```text
packages/daemon/src/features/plugins/package-cache.ts
packages/daemon/src/features/plugins/install.ts
packages/daemon/src/features/plugins/runtime-injection.ts
packages/daemon/src/features/plugins/policy-overlay.ts
```

Suggested cache layout:

```text
<ling-data-root>/plugins/cache/
  bundled/
    cua-driver/
      0.1.0/
        package/
        manifest.compiled.json
        install.json
```

Cache install rules:

- install into a temporary staging directory first;
- validate manifest and contribution paths from the staged directory;
- compute a package hash before activation;
- atomically move staged content into the final cache path;
- never execute package files during install;
- store only redacted install diagnostics;
- uninstall disables future resolution but keeps historical run evidence;
- package cache deletion must not delete MCP audit history or teammate assignment history.

Suggested store additions:

```ts
export interface ManagedPluginPackageRecord {
  readonly pluginId: string;
  readonly sourceKind: "bundled" | "trusted-local";
  readonly version: string;
  readonly cachePath: string;
  readonly packageHash?: string;
  readonly manifestJson: string;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface ManagedPluginRuntimeSnapshot {
  readonly id: string;
  readonly runId?: string;
  readonly cwd: string;
  readonly pluginIds: readonly string[];
  readonly mcpServerIds: readonly string[];
  readonly skillPackIds: readonly string[];
  readonly appIds: readonly string[];
  readonly hookIds: readonly string[];
  readonly policyOverlayIds: readonly string[];
  readonly createdAt: string;
}
```

Potential SQLite tables:

```sql
CREATE TABLE IF NOT EXISTS managed_plugin_packages (
  plugin_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  version TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  package_hash TEXT,
  manifest_json TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_plugin_runtime_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  cwd TEXT NOT NULL,
  plugin_ids_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  policy_overlays_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Daemon API additions:

```http
POST /plugins/:id/install?cwd=/path/to/workspace
POST /plugins/:id/uninstall?cwd=/path/to/workspace
POST /plugins/:id/refresh-package?cwd=/path/to/workspace
GET /plugins/:id/runtime-preview?cwd=/path/to/workspace
```

`install` materializes the package and creates managed package state. It does not enable
the plugin, create teammate bindings, or grant tool permission.

### Stage 5: Runtime Capability Injection

Runtime injection converts enabled installed packages into a run/session capability
snapshot.

Injection sequence:

1. Resolve enabled managed plugins for the workspace.
2. Load compiled package descriptors from cache.
3. Resolve linked MCP servers, skill packs, apps, and hooks.
4. Apply platform blockers and health expiry rules.
5. Apply per-plugin policy overlays.
6. Build a `ManagedPluginRuntimeSnapshot`.
7. Attach the snapshot to the run/session before the runner starts.
8. Use the snapshot for model context, MCP server availability, tool policy, and audit.

Runtime rules:

- disabled plugins are excluded from new snapshots;
- existing runs keep their captured snapshot for audit stability;
- missing cached packages mark the plugin as `blocked` for new runs;
- runtime injection never reads unvalidated package paths;
- package-provided MCP servers still initialize through the MCP broker;
- package-provided tools still route through approval policy;
- skill packs and hooks are capabilities, not permissions.

Suggested runtime preview response:

```ts
export interface ManagedPluginRuntimePreview {
  readonly pluginId: string;
  readonly status: "injectable" | "blocked" | "disabled";
  readonly mcpServers: readonly ManagedPluginLinkedResource[];
  readonly skillPacks: readonly ManagedPluginLinkedResource[];
  readonly apps: readonly ManagedPluginLinkedResource[];
  readonly hooks: readonly ManagedPluginLinkedResource[];
  readonly policyOverlays: readonly ManagedPluginPolicyOverlayView[];
  readonly blockers: readonly string[];
}
```

### Stage 5: MCP/App/Hook Policy Overlay

Policy overlays let a package provide defaults while the workspace and user keep final
authority.

Precedence:

1. admin or workspace deny rules,
2. user/team override,
3. teammate explicit assignment,
4. plugin policy overlay,
5. MCP broker/tool annotations,
6. package defaults.

Suggested policy overlay shape:

```ts
export interface ManagedPluginPolicyOverlay {
  readonly id: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly targetKind: "mcp-server" | "mcp-tool" | "app" | "hook";
  readonly targetId: string;
  readonly defaultApproval: "allow" | "ask" | "deny";
  readonly sideEffectLevel: ManagedPluginSideEffectLevel;
  readonly reason: string;
}
```

Hard rules:

- `allow` is valid only for clearly read-only operations.
- screenshots and screen extraction are sensitive read operations and should default to
  `ask` unless explicitly scoped later.
- GUI mutation, app launch, recording, replay, config mutation, filesystem writes,
  credential access, deploy, and external network mutation default to `ask` or `deny`.
- hooks must declare when they run and whether they can block a run.
- app connectors must respect app-level enablement before exposing actions.

CUA policy overlay:

| Capability family | Default |
| --- | --- |
| binary/version/status checks | `allow` when read-only |
| permission status checks | `allow` when read-only |
| app/window listing | `allow` only when read-only annotations are present |
| screenshot/screen extraction | `ask` |
| click/type/key/drag/scroll/set value | `ask` |
| launch/quit/config mutation | `ask` or `deny` |
| recording/replay | `ask` or `deny` |

### Stage 5: Isolated Local Contract

`internal-isolated` plugins should run in a child process or worker host only after the
manifest/cache path is stable. This is not needed for the CUA shell if it only contributes
an MCP server descriptor.

Allowed host context:

- read declared package assets;
- request declared secret values at execution time only;
- emit health/status events;
- propose linked resources;
- call scoped MCP/app/hook registration helpers.

Denied host context:

- direct SQLite handles;
- raw Keychain access;
- direct task/run state mutation;
- bypassing resource leases;
- bypassing approval policy;
- unscoped filesystem or network access;
- modifying teammate bindings.

Stage 5 definition of done:

- bundled package install is idempotent and auditable;
- cache activation is atomic;
- package uninstall disables future runtime resolution without deleting history;
- enabled installed packages appear in runtime previews;
- new runs receive plugin capability snapshots;
- disabled plugins are absent from new snapshots;
- CUA bundled shell installs and injects the linked MCP server only after binary/path
  confirmation;
- CUA tools keep conservative approval defaults.

### Stage 4-5 Test Plan

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

Required tests:

- valid bundled manifest compiles into a managed descriptor;
- path traversal, absolute paths, symlink escapes, duplicate ids, and incompatible
  interface versions are rejected;
- source index ordering is deterministic;
- install writes through a staging directory and activates atomically;
- repeated install is idempotent;
- uninstall disables future runtime resolution but keeps historical records;
- runtime preview excludes disabled plugins;
- run/session snapshot freezes enabled plugin capabilities;
- policy overlay precedence cannot weaken workspace/user deny rules;
- CUA shell install does not require or contain native provider binaries; packaged macOS
  and Windows provider resources are validated separately by Desktop release gates;
- missing CUA binary produces a redacted blocker;
- CUA screenshot and GUI mutation tools default to `ask`;
- no install path creates teammate tool bindings automatically.

Suggested PR sequence:

1. Manifest types and validator.
2. Bundled source index and CUA package shell.
3. Package cache install/uninstall.
4. Runtime preview and capability snapshot.
5. Policy overlay resolver.
6. CUA bundled install flow wired through existing plugin UI.

## Post Stage 1-3 Backlog

After the implemented Stage 1-3 surface is stable, the next work should be:

1. Define `.ling-plugin/plugin.json` and schema validation.
2. Add a local/bundled source index and versioned install cache.
3. Compile package manifests into managed descriptors, linked resources, and redacted
   health metadata.
4. Inject enabled package skills, MCP servers, apps, and hooks into run/session snapshots.
5. Add per-plugin MCP/app/hook policy overlays.
6. Only then consider Git/remote marketplaces and third-party plugin APIs.
