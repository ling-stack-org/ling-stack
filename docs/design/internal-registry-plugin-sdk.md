# Internal Registry and Plugin SDK

## Purpose

This document records the v0.1 internal registry and plugin SDK plan.

Ling Stack should become extensible, but v0.1 should not start with an external plugin
marketplace or dynamic code loading. The first step is to make internal capabilities use
one typed registration model.

The next product-facing layer is [Plugin Manager](plugin-manager.md). Its Stage 1-3
implementation is detailed in [Plugin Manager Implementation Plan](plugin-manager-implementation-plan.md).
Together, those documents define Codex-like management for internal, bundled, and
trusted local capabilities without opening a third-party plugin API yet.
The Plugin Manager design also tracks the Codex-derived follow-up layers for package
manifests, source indexes, install cache, runtime capability injection, and MCP/app/hook
policy overlays.

Current local extension points already exist in different forms:

- `packages/providers` has `MediaAdapterRegistry`.
- `packages/runner-pi` has `PiRunnerAdapter`.
- `packages/core` has built-in skill packs such as `gstack-default`.
- tools are represented as allowed run tools and approval policy decisions.

The registry layer should unify discovery and capability metadata before external plugin
loading exists.

## Goals

- Define one internal extension vocabulary.
- Register built-in providers, runners, channel sources, skill packs, tools, memory
  providers, and automations.
- Keep execution authority in daemon/coordinator/kernel state machines.
- Make future GitHub automation and alternative runners easier to add.
- Avoid external plugin install UX in v0.1.

## Package Shape

```text
packages/plugin-sdk/
  src/
    automation.ts
    channel-source.ts
    index.ts
    manifest.ts
    memory.ts
    registry.ts
    runner.ts
    skill-pack.ts
    tool.ts
```

The SDK package should contain interfaces and lightweight registry helpers only. It must
not import daemon internals, SQLite stores, React, or concrete provider SDKs.

## Modular Contribution Contract

The registry is the typed metadata layer for modular development. It should make each
capability discoverable without turning plugins into a monolithic runtime framework.

Rules:

- Keep one registry module per contribution kind. Do not add a single generic plugin
  executor that handles providers, runners, tools, memory, automations, and UI features
  through ad hoc strings.
- Registry records describe capabilities, side effects, required secrets, and required
  approvals. They do not execute code or mutate workspace state.
- Concrete behavior stays in the owning package or daemon feature module:
  `packages/providers`, `packages/runner-pi`, `packages/core`, `packages/daemon/src/features/*`,
  or `apps/web/src/features/*`.
- New extension kinds must define their contract, trust level, side-effect model, and
  tests before they are added to `LingExtensionKind`.
- A future package manifest should compile into these per-kind records. Runtime code
  should consume compiled records, not parse package files during execution.
- UI-facing plugin surfaces should depend on safe registry projections and linked
  resource ids, never raw code paths or secret values.

The expected shape for a new feature is:

```text
typed registry metadata
  -> feature-owned daemon/store/runtime module
  -> optional Web feature module
  -> plugin manager projection
  -> tests for the registry record and the feature behavior
```

## Extension Kinds

```ts
export type LingExtensionKind =
  | "provider"
  | "runner"
  | "channel-source"
  | "skill-pack"
  | "tool"
  | "memory"
  | "automation";

export type ExtensionTrustLevel = "internal" | "internal-isolated";

export interface LingExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: LingExtensionKind;
  readonly trustLevel: ExtensionTrustLevel;
  readonly capabilities: readonly string[];
  readonly requiredSecrets?: readonly string[];
  readonly requiredApprovals?: readonly ApprovalRequirement[];
}
```

v0.1 uses only `internal` and `internal-isolated`. External trust levels wait until a
real sandbox and install UX exists.

## Registries

Recommended registries:

- `ProviderExtensionRegistry`
- `RunnerExtensionRegistry`
- `ChannelSourceRegistry`
- `SkillPackRegistry`
- `ToolRegistry`
- `MemoryProviderRegistry`
- `AutomationRegistry`
- `LingExtensionRegistry`

Base behavior:

- reject duplicate extension ids,
- expose `get(id)` and `list()`,
- return read-only arrays,
- validate manifest id/kind/version,
- never execute state transitions.

## Built-In Registration

`createDefaultLingExtensionRegistry()` should register:

- `runner:pi`,
- `channel-source:local`,
- tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`,
- skill pack: `gstack-default`,
- built-in media/provider adapter bridges,
- empty memory and automation registries.

Existing APIs should remain compatible:

- keep `MediaAdapterRegistry`,
- keep `createPiRunner()`,
- keep built-in skill pack helpers,
- add bridge helpers rather than deleting existing entry points.

## Security Boundary

Registries describe capabilities. They do not grant authority.

Hard rules:

- Extensions do not get SQLite handles.
- Extensions do not directly update task/run/approval/media/workflow state.
- Extensions do not bypass resource leases.
- Extensions do not bypass approval policy.
- Extensions do not receive raw secrets unless the daemon explicitly resolves a declared
  secret for a concrete execution boundary.
- Skill packs are workflow templates, not permissions.
- Automation extensions create proposed work/actions; coordinator and kernel decide what
  can run.

## Tool Definitions

Built-in tools should declare side effect level and default approval:

| Tool | Side effect | Default approval |
| --- | --- | --- |
| `read` | read | allow |
| `grep` | read | allow |
| `find` | read | allow |
| `ls` | read | allow |
| `bash` | write/network possible | ask |
| `edit` | write | ask |
| `write` | write | ask |

Future tools such as browser, GitHub comment, Slack send, deploy, and release must carry
explicit approval requirements.

## Daemon Integration

The daemon should create the default registry at startup.

Initial integration is read-only:

- use registry for diagnostics,
- verify built-in capabilities,
- later use it to select runner/provider/channel/automation implementations.

The diagnostic endpoint exposes safe metadata:

```http
GET /runtime/extensions
```

It must not expose secrets or dynamic code paths.

## Implementation Status

- `packages/plugin-sdk` now provides the v0.1 manifest types, extension metadata
  interfaces, typed kind registries, and the global `LingExtensionRegistry`.
- Core exports built-in tool extension metadata and `skill-pack:gstack-default`
  metadata. Tool defaults are derived from the existing approval policy constants.
- Providers export built-in media provider metadata for `jimeng`, `seedream`, and
  `seedance` while preserving `MediaAdapterRegistry`.
- `runner-pi` exports `runner:pi` metadata while preserving `createPiRunner()` and
  `PiRunnerAdapter`.
- Daemon creates a default registry at server construction through
  `createDefaultLingExtensionRegistry()`. This is read-only metadata in v0.1 and does
  not change runner/provider selection or execution authority.
- Daemon exposes `GET /runtime/extensions` as a read-only diagnostic view of safe
  internal extension metadata. This endpoint is separate from `/plugins`, which reports
  product-managed plugin lifecycle state.

## Non-Goals

- No external plugin marketplace.
- No plugin install UI.
- No dynamic loading from arbitrary disk paths.
- No third-party sandbox.
- No third-party plugin API.
- No plugin direct database access.
- No plugin direct state mutation.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/plugin-sdk build
corepack pnpm --filter @ling-stack/plugin-sdk test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/providers test
corepack pnpm --filter @ling-stack/runner-pi build
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm typecheck
git diff --check
```

Required tests:

- duplicate extension id is rejected,
- wrong kind registration is rejected,
- invalid manifest fields are rejected,
- `get()` and `list()` work,
- built-in tools have expected approval defaults,
- `runner:pi` is registered,
- `gstack-default` is discoverable through `SkillPackRegistry`,
- media adapter bridge preserves current `jimeng`, `seedream`, and `seedance` behavior.

## Assumptions

- Internal registry comes before external plugin support.
- Internal and bundled plugin management comes before third-party plugin APIs.
- Package boundaries may later require a new ADR when implementation starts.
- Registry metadata is useful even before all execution paths are routed through it.
