# Plugin Manager

## Status

Design proposal. Stage 1 slices 1-3 are implemented in the current codebase:
catalog/read-only UI, MCP preset apply, and plugin state/health.

This document records the next plugin-management slice after the implemented internal
registry work. It deliberately targets Codex-like internal and bundled plugin governance
first. Third-party plugin APIs, marketplace installation, and untrusted sandboxing remain
later work.

The Codex source model should be treated as a layer model to borrow gradually, not as a
drop-in runtime replacement. Ling should keep its existing daemon, runner registry, MCP
broker, teammate bindings, and approval policy as the execution authority.

Related docs:

- [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin.md)
- [Office Documents Native Plugin](office-documents-native-plugin.md)
- [Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md)
- [Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Core Tools Runtime Boundary Implementation Plan](core-tools-runtime-boundary-implementation-plan.md)
- [Internal Registry and Plugin SDK](internal-registry-plugin-sdk.md)
- [Platform Architecture](platform-architecture.md)
- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md)
- [Runner Registry](runner-registry.md)
- [Runner Adapters](runner-adapters.md)
- [Secrets and Keychain](secrets-keychain.md)

## Problem

Ling Stack can already run MCP tools through teammate bindings and approval policy, and
`packages/plugin-sdk` already records internal extension metadata. That is enough for
manual capability wiring, but it is not enough for a Codex-like operator experience.

The missing product layer is a plugin manager that can answer:

- What built-in or bundled capabilities are available?
- What MCP servers, tools, skills, providers, runners, and UI modules does a capability
  contribute?
- Is the capability enabled, healthy, and assigned to any teammate?
- What approval defaults and secrets does it require?
- Can the user add a trusted local capability such as `cua-driver` without hand-writing
  every field?
- Can Ling show plugin status without granting execution authority?

Without this layer, every high-power tool looks like a raw MCP server. That is workable
for engineers, but it hides the trust model from normal operators.

## Decision

Build a plugin manager in three stages:

1. Internal and bundled plugin manager.
2. Isolated local plugin contract.
3. Third-party plugin API and marketplace.

Only stage 1 is in scope for the next slice.

Stage 1 should support built-in, bundled, and trusted local preset capabilities. It should
not support arbitrary third-party code loading, marketplace install, npm package install,
or external plugin SDK APIs.

Codex's plugin system splits this problem into manifest/schema, marketplace/source,
install cache, runtime capability injection, and policy overlays for MCP servers, apps,
and hooks. Stage 1-3 only needs the internal parts of those layers. Public source
resolution, third-party install APIs, and remote marketplaces stay deferred.

## Goals

- Provide a Codex-like plugin management surface for internal and bundled capabilities.
- Turn common MCP integrations into safe presets instead of raw hand-written config.
- Make capability, secret, approval, and health metadata visible before execution.
- Keep all execution authority in the daemon, runner registry, MCP broker, approval
  policy, resource leases, and state machines.
- Preserve the existing internal registry and MCP server APIs.
- Add `cua-driver` as the first high-risk trusted local preset.
- Add Chrome as the first user-facing product-managed built-in plugin. Chrome uses an explicitly
  installed Ling extension and contributes a logical MCP server; it does not load arbitrary plugin
  code inside the daemon.
- Add Office Documents as a Ling-installed built-in plugin. Its live Excel adapter ships with
  Desktop and never requires an Excel add-in, Office task pane, Marketplace install, or Office-side
  Ling sign-in.

The implemented trusted-local preset remains the external fallback. Packaged macOS and
Windows Desktop may project the same stable product id through `bundled_embedded`
distribution, while the daemon keeps MCP policy and audit authority. The
distribution-specific contract lives in the Bundled Embedded Cua Driver documents.

## Non-Goals

- No third-party plugin API.
- No marketplace or plugin store.
- No arbitrary npm/GitHub/plugin install.
- No untrusted plugin sandbox.
- No plugin direct database access.
- No plugin-owned state transitions.
- No bypass around MCP tool authorization, teammate bindings, approval policy, or audit.

## Trust Tiers

Stage 1 uses three product-facing tiers:

| Tier | Source | Code loading | Example | Default posture |
| --- | --- | --- | --- | --- |
| Built-in | Compiled into Ling packages | None | Product-managed built-in capability bundles | Enabled by product defaults |
| Bundled | Shipped with Ling distribution | Static manifest and optional local assets | Browser MCP preset, GitHub MCP preset | Installable/enabled by user |
| Trusted local preset | User confirms an installed local binary or endpoint | No plugin code loaded by Ling | `cua-driver mcp` | Disabled until explicitly added |

External trusted and external untrusted tiers are intentionally excluded from stage 1.

Core runner tools such as `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
are not Plugin Manager entries. They are governed by approval policy, allowed-tool
resolution, and runner metadata. See
[Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md).

## Architecture

```mermaid
flowchart TD
  UI[Settings: Plugins] --> API[Daemon Plugin API]
  API --> Store[(Workspace SQLite)]
  API --> Catalog[Plugin Catalog]
  Catalog --> BuiltIn[Built-in registry metadata]
  Catalog --> Bundled[Bundled manifests]
  Catalog --> Presets[Trusted local presets]
  API --> Registry[LingExtensionRegistry]
  API --> MCP[MCP server config and tool catalog]
  API --> Skills[Skill pack registry]
  API --> Runners[Runner registry]
  API --> Policy[Approval policy]
  MCP --> Broker[MCP broker]
  Broker --> Runner[Runner adapter]
  Runner --> Audit[Run events and approvals]
```

The plugin manager is a control plane. It describes, enables, disables, configures, and
audits capabilities. It does not execute plugin code directly.

## Modular Plugin Development

Plugin work should follow the framework's modular-first rule. The Plugin Manager should
not become a second application shell or a catch-all runtime host.

Each plugin contribution must map to an existing or planned feature boundary:

| Contribution | Owning boundary |
| --- | --- |
| MCP server | `features/mcp`, MCP broker, tool access snapshots |
| Tool | approval policy, runner/tool metadata, runtime permission checks |
| Skill pack | skill registry and Effective Skill read model |
| Runner | runner registry and runtime supervisor |
| Provider | provider presets, preflight, and secret resolution |
| Channel source | channel/external-work feature modules |
| Memory | memory scope, recall, review, and audit modules |
| Automation | automation definitions, drafts, scheduler, and approval gates |
| UI feature | Web feature module under `apps/web/src/features/*` |

Rules:

- A plugin descriptor can list multiple contributions, but each contribution should be
  compiled into its feature-owned record or runtime snapshot before execution.
- Plugin Manager routes own plugin lifecycle state only: catalog, enable/disable, health,
  linked contribution status, and audit events.
- Feature modules own behavior. For example, MCP calls still go through MCP broker and
  run approval hooks; runners still go through runner registry; UI contributions still
  render through feature modules.
- A plugin must not introduce a private persistence model when an existing feature store
  boundary exists. Add a feature-owned table or DTO instead.
- Package manifests should compile to descriptors and linked resources. Runtime execution
  should not parse arbitrary plugin files on every run.
- Tests should be contribution-scoped: plugin lifecycle tests plus feature-module tests
  for the contributed behavior.

This keeps plugin expansion incremental: Ling can add one plugin contribution kind
without rewriting unrelated plugin, daemon, or Web surfaces.

## Codex-Inspired Layer Model

OpenAI Codex's implementation treats plugins as local bundles that can contribute skills,
MCP servers, app connectors, hooks, and metadata. The runtime does not invoke a plugin
object directly; it exposes the enabled bundle's underlying capabilities to the session
under config and policy.

Ling should borrow the same separation of concerns:

| Layer | Ling meaning | Stage posture |
| --- | --- | --- |
| Manifest/schema | A package-level declaration of id, version, interface metadata, skills, MCP servers, apps, hooks, and assets. | Stage 1 descriptors cover managed metadata; a strict package manifest belongs to Stage 2. |
| Marketplace/source | An index of plugins and their built-in, bundled, trusted local, Git, or remote source. | Stage 1 uses built-in descriptors and trusted local presets only. Bundled/local indexes come next; Git and remote sources are later. |
| Install cache | A Ling-owned materialized plugin directory with versioned state. | Stage 1 persists managed state and linked resources; Stage 2 adds a package cache for trusted local and bundled bundles. |
| Runtime capability injection | Merge enabled plugin skills, MCP servers, apps, hooks, and summaries into session/runtime capabilities. | Stage 1 surfaces contributions and applies MCP presets; later stages inject package capabilities into run snapshots. |
| MCP/app/hook policy overlay | User/workspace/admin policy over plugin-provided MCP servers, app connectors, hooks, and tools. | Stage 1 preserves existing MCP and approval gates; later stages add per-plugin overlays. |

Important boundaries:

- Manifest paths and package metadata never grant authority by themselves.
- Installation is control-plane state, not automatic teammate authorization.
- Runtime injection must go through the same run snapshot, MCP broker, teammate binding,
  resource lease, and approval policy boundaries as hand-written configuration.
- Desktop automation such as `cua-driver` needs a policy overlay because screenshots,
  clicks, typing, app launch, recording, and replay are high-risk capabilities.
- Third-party plugin APIs can remain deferred until Ling has production evidence from
  internal, bundled, and trusted local plugins.

## Plugin Descriptor

Stage 1 should use a descriptor that is narrower than a future package manifest. It can
be generated for built-ins, loaded from controlled bundled assets, or defined as a trusted
local preset. It is intentionally not a third-party SDK contract.

Future package manifests should be stricter about filesystem shape and path resolution:
all contribution paths must be relative to the plugin root, must not escape the bundle,
and must declare their intended contribution type before any runtime loader reads them.
A likely package entry point is:

```text
.ling-plugin/plugin.json
```

```ts
export type PluginSourceKind = "built-in" | "bundled" | "trusted-local-preset";

export type PluginContributionKind =
  | "mcp-server"
  | "tool"
  | "skill-pack"
  | "runner"
  | "provider"
  | "channel-source"
  | "memory"
  | "automation"
  | "ui-feature";

export interface LingManagedPluginDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: PluginSourceKind;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly PluginContribution[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly healthChecks?: readonly ManagedPluginHealthCheck[];
}

export interface PluginContribution {
  readonly kind: PluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
}
```

Descriptors are metadata. They do not grant tools to a teammate by themselves.

When Stage 2 introduces package manifests, the manifest should compile into the same
managed descriptor and linked resource records. Runtime code should depend on the
compiled descriptor, not parse package files during every run.

## Persistent Model

Add plugin state only after descriptors are stable. Suggested tables:

```text
managed_plugins
- id
- source_kind
- version
- enabled
- installed_at
- updated_at
- disabled_reason
- descriptor_json

managed_plugin_contributions
- plugin_id
- contribution_kind
- contribution_id
- linked_resource_id
- enabled
- created_at
- updated_at

managed_plugin_health_snapshots
- plugin_id
- checked_at
- expires_at
- status
- message
- details_json

managed_plugin_events
- id
- plugin_id
- type
- actor
- message
- data_json
- created_at
```

`linked_resource_id` points to existing Ling resources such as MCP server id, runner id,
provider id, or skill pack id. It must not store secret values.

## API Shape

Initial daemon API:

```http
GET /plugins
GET /plugins/:id
POST /plugins/:id/enable
POST /plugins/:id/disable
POST /plugins/:id/check
POST /plugins/:id/apply-preset
```

`apply-preset` should be explicit and idempotent. For an MCP-backed preset, it creates or
updates the corresponding MCP server config, runs a check, and optionally syncs tools.

Future diagnostic API from the internal registry should remain separate:

```http
GET /runtime/extensions
```

`/runtime/extensions` reports safe internal registry metadata. `/plugins` reports
product-managed plugin state and contributions.

`/plugins` must not be a direct dump of the internal extension registry. Plain built-in
`tool:*` extensions belong to approval policy and runtime-extension diagnostics, not to
the product Plugin Manager catalog.

## Cua Driver Preset

`cua-driver` should be the first trusted local preset:

```json
{
  "id": "trusted-local:cua-driver",
  "displayName": "Cua Driver",
  "sourceKind": "trusted-local-preset",
  "version": "local",
  "trustSummary": "Controls native macOS apps through Accessibility and Screen Recording permissions.",
  "contributions": [
    {
      "kind": "mcp-server",
      "id": "mcp:cua-driver",
      "label": "cua-driver MCP",
      "capabilities": ["macos-accessibility", "screen-capture", "gui-automation"],
      "sideEffectLevel": "external"
    }
  ]
}
```

Preset transport:

```json
{
  "type": "stdio",
  "command": "<resolved cua-driver binary>",
  "args": ["mcp"]
}
```

The daemon should resolve the binary from an explicit user-selected path, `PATH`, or a
known local install path during preset application. The resolved path should be stored in
the MCP server config so later runs do not depend on a different daemon environment.

Default policy:

- Add the MCP server disabled until the user enables the plugin.
- Sync tools only after an explicit check succeeds.
- Do not bind any tool to a teammate automatically.
- Prefer selected-tool bindings over `all_current_tools`.
- Default GUI mutation tools to `ask`.
- Keep read/status tools allowed only when the MCP annotations or local override mark them
  read-only.
- Surface Screen Recording and Accessibility readiness as health details.

Suggested initial tool posture:

| Tool family | Default |
| --- | --- |
| Permission/status/config reads | Allow when read-only |
| Window/app inspection | Allow when read-only |
| Screenshot/page extraction | Ask unless scoped and intentionally enabled |
| Click/type/key/drag/scroll/set value | Ask |
| Launch/quit/config mutation/recording/replay | Ask or deny by default |

## UI Shape

Add a `Plugins` settings surface separate from raw MCP settings.

Plugin list row:

- name, source tier, version,
- enabled/disabled state,
- health status,
- contribution count,
- assigned teammates count,
- required approvals summary.

Plugin detail:

- descriptor summary,
- contributions,
- linked MCP servers/tools,
- required secrets and status only,
- default approval posture,
- health snapshots,
- audit/event history,
- actions: enable, disable, check, apply preset, open linked MCP server, assign tools.

MCP settings remain the lower-level advanced page. The plugin page should link into it
instead of duplicating every MCP control.

## Approval And Audit Rules

Enabling a plugin is not approval to run its tools.

Rules:

- `enable` records a plugin management event.
- `apply-preset` records which resources were created or updated.
- tool assignment records teammate id, selected tools, and approval overrides.
- every MCP tool call still routes through existing runner approval hooks.
- every side-effecting plugin management action should be visible in workspace audit.
- disabling a plugin should disable or detach its contributions without deleting historical
  run evidence.

## Rollout Plan

### Slice 1: Catalog and Read-Only UI

- Add built-in descriptor generation from `LingExtensionRegistry`.
- Add bundled/trusted-local preset descriptor type.
- Add `/plugins` and `/plugins/:id` read-only endpoints.
- Add Settings `Plugins` page.
- No enable/apply behavior yet.

### Slice 2: MCP Preset Apply

- Add `apply-preset` for MCP-backed presets.
- Add `cua-driver` preset.
- Link plugin contribution to created MCP server.
- Check and sync tools through existing MCP broker.
- Keep teammate tool authorization explicit.

### Slice 3: Plugin State And Health

- Persist enabled/disabled state.
- Persist health snapshots.
- Add disable behavior that disables linked contributions.
- Add audit events for enable, disable, apply, check.

### Slice 4: Manifest/Schema And Bundled Source

- Load manifests from a controlled bundled directory.
- Validate descriptors and Ling version compatibility.
- Support bundled MCP server, skill-pack, runner, and provider contributions.
- Still no arbitrary third-party install.

Detailed implementation notes are tracked in
Plugin Manager.

### Slice 5: Install Cache, Runtime Injection, And Isolated Local Contract

- Add a Ling-owned package cache for trusted local and bundled bundles.
- Compile manifests into managed descriptors and linked resources.
- Add worker/child-process host context for internal-isolated plugins.
- Expose only scoped context methods.
- Inject enabled package skills, MCP servers, apps, and hooks into run/session capability
  snapshots.
- Add per-plugin MCP/app/hook policy overlays before capabilities reach a run.
- Use high-risk built-in automation to pressure-test the boundary.

### Slice 6: Third-Party Plugin API

- Publish a stable external manifest and host context.
- Add version pinning, source trust review, source indexes, stronger sandboxing,
  uninstall cleanup, and compatibility checks.
- Consider marketplace only after the security model has production evidence.

## Test Plan

Required tests for stage 1:

- descriptors validate id, source kind, version, and contribution ids;
- duplicate plugin ids are rejected;
- built-in registry metadata appears in `/plugins`;
- `/plugins` never exposes secret values or raw dynamic code paths;
- `cua-driver` preset creates the expected stdio MCP server config;
- applying a preset is idempotent;
- plugin enable does not auto-authorize teammate tools;
- GUI mutation tools default to approval-required;
- disabling a plugin disables linked MCP contributions;
- health snapshots are short-lived and redacted;
- audit events are emitted for enable, disable, apply, and check.

Suggested validation commands:

```bash
corepack pnpm --filter @ling-stack/plugin-sdk test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm typecheck
git diff --check
```

## Open Questions

- Should plugin state be workspace-local only, or should desktop builds also keep a global
  installed-plugin catalog?
- Should `cua-driver` be visible only on macOS, or visible everywhere with a platform
  blocker?
- Should screenshot/page extraction be classified as read, external, or sensitive-read in
  the approval model?
- Should plugin descriptors be generated at daemon startup only, or hot-reloaded for
  bundled development builds?
- Should plugin health checks run on demand only, or periodically while Settings is open?
