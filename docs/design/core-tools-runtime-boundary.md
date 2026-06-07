# Core Tools, Runners, MCP Tools, and Plugin Boundary

## Status

Design decision.

Ling Stack should keep core execution tools, runner capabilities, MCP tools, and managed
plugins as separate product concepts. This document records the boundary so the Plugin
Manager does not become a catch-all list for every internal capability.

Related docs:

- [Core Tools Runtime Boundary Implementation Plan](core-tools-runtime-boundary-implementation-plan.md)
- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Approval Policy](approval-policy.md)
- [Runner Registry](runner-registry.md)
- [Runner Adapters](runner-adapters.md)
- [Internal Registry and Plugin SDK](internal-registry-plugin-sdk.md)
- [Plugin Manager](plugin-manager.md)
- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md)

## Problem

Ling has seven built-in run tools:

```ts
type RunTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";
```

They are also represented as internal extension metadata so the daemon can describe
capabilities consistently. That metadata shape is useful for diagnostics and future
runtime capability snapshots, but it creates a product risk: if every internal extension
is rendered as a plugin, basic tools such as `Find`, `Bash`, and `Edit` look like
installable plugin packages.

That is the wrong mental model. These tools are part of the local runner permission
surface. They should be configured through allowed tools and approval policy, not through
Plugin Manager install/enable/disable controls.

## Decision

Use four user-facing capability surfaces:

| Surface | Owns | Examples | User action |
| --- | --- | --- | --- |
| Core tools and approval policy | Ling run-tool allowlist and side-effect decisions | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | Allow, ask, deny; configure write scopes |
| Runtime runners | Execution backends and their supported core tools | Pi runner, future Codex runner | Select default/allowed runner; inspect supported tools |
| MCP tools | Tools discovered from configured MCP servers | Browser MCP, GitHub MCP, Cua Driver MCP tools | Bind selected tools to teammates; apply approval overrides |
| Plugin Manager | Managed capability bundles and presets | Browser preset, GitHub preset, Cua Driver preset | Install, enable, check, apply preset, sync linked resources |

The Plugin Manager should not list plain `tool:*` internal extensions as plugin cards.
It may list a product-managed plugin that contributes MCP servers, skills, providers,
runners, or UI modules, but the underlying core tools remain governed by run policy.

## Core Tool Taxonomy

The core tool set is intentionally small:

| Tool | Category | Default decision | Notes |
| --- | --- | --- | --- |
| `read` | read-only filesystem/context read | allow | No direct mutation |
| `grep` | read-only search | allow | Should prefer fast indexed/local search when available |
| `find` | read-only file discovery | allow | Product label can be "Find files" |
| `ls` | read-only directory listing | allow | Product label can be "List files" |
| `bash` | arbitrary shell execution | ask | Can mutate local state, network, Git, or external systems |
| `edit` | targeted file edit | ask | Must be interceptable before mutation |
| `write` | file creation/replacement | ask | Must respect allowed write paths |

`read`, `grep`, `find`, and `ls` are read-only by default. `bash`, `edit`, and `write`
are side-effect-capable by default. Future tools should not be added to this list unless
they are part of the runner contract and can be evaluated by the same approval policy.

## Product Model

### Core Tools

Core tools are Ling-owned run permissions. They appear in:

- workspace approval policy,
- channel allowed tools,
- teammate allowed tools,
- skill required tools,
- run request snapshots,
- runner supported-tool metadata.

They do not have package state, install state, health checks, source indexes, or plugin
enablement lifecycle.

### Runners

A runner is an execution backend. The runner declares which core tools it can support,
but it does not own authorization. Ling still owns:

- allowed-tool resolution,
- approval policy,
- side-effect interception requirements,
- MCP broker mediation,
- resource leases,
- durable run and approval audit.

Runner detail screens may show supported tools as read-only metadata. They should not
offer per-tool install or plugin lifecycle controls.

### MCP Tools

MCP tools are discovered through MCP server configuration. They are not core tools,
because their schemas, side-effect levels, and default approvals come from the MCP server
or Ling's policy overlay.

MCP tools should be shown in MCP settings and teammate tool bindings, grouped by server.
Plugin Manager can apply a preset that creates or updates an MCP server, but after that
the individual tools are governed by MCP binding and approval policy.

### Plugins

A managed plugin is a product-managed capability bundle. It may contribute resources such
as:

- MCP server presets,
- skill packs,
- runners,
- providers,
- UI features,
- hooks or policy overlays in later slices.

Plugin enablement does not authorize a teammate to use a tool. It only makes the linked
resources available for explicit binding and policy evaluation.

## API Boundary

Keep these API meanings distinct:

| API area | Meaning |
| --- | --- |
| `/approval-policy` | Workspace decisions for core tools and write paths |
| `/runtime/runners` and `/runtime/settings` | Registered runners and workspace runner defaults |
| `/mcp/*` | MCP server config, runtime status, and discovered MCP tools |
| `/plugins/*` | Managed plugin packages, presets, linked resources, health, and lifecycle |
| `/runtime/extensions` | Diagnostic view of internal extension metadata, not product plugin state |

`/plugins` should not be implemented as a direct dump of `LingExtensionRegistry.list()`.
It should compile only product-managed plugin descriptors. Internal extension metadata
belongs in `/runtime/extensions` or in the owning settings surface.

## UI Boundary

Settings should use separate sections:

1. **Approval policy**: grouped core tools with `allow`, `ask`, and `deny`.
2. **Runtime runners**: default runner, allowed runners, fallback policy, supported
   provider APIs, and supported core tools.
3. **MCP tools**: server status, discovered tools, side-effect levels, selected teammate
   bindings, and policy overlays.
4. **Plugin Manager**: installable or enableable capability bundles and presets.

The same tool name may appear as read-only metadata in more than one place. For example,
Pi Runner can show `bash` as a supported tool, and Approval policy can show `bash` as an
approval-controlled tool. Only Approval policy controls whether `bash` is allowed during
a run.

## Current Implementation Notes

The current codebase already has most primitives:

- `RunTool` covers the seven core tools.
- `readOnlyRunTools` and `riskyRunTools` split read-only and side-effect-capable tools.
- Default approval policy allows read-only tools and asks for `bash`, `edit`, and
  `write`.
- Pi runner exposes the same tools through `DEFAULT_TOOLS`.
- The Web approval settings form already renders decisions for all seven tools.
- The internal registry can register `tool:*` metadata.

The risky part is catalog projection. Any code that maps all internal extensions into
managed plugin views should either:

1. exclude plain `tool:*` descriptors from `/plugins`, or
2. split the endpoint into product plugins and runtime extension diagnostics.

The second option is cleaner long term because it preserves internal registry
observability without polluting the Plugin Manager.

## Acceptance Criteria

- Plugin Manager does not show `Read`, `Grep`, `Find`, `List`, `Bash`, `Edit`, or
  `Write` as plugin cards.
- Approval policy still shows all seven core tools.
- Runner settings can show supported core tools as metadata.
- MCP settings and teammate bindings show MCP tools separately from core tools.
- Enabling a plugin never changes core tool approval decisions by itself.
- A run snapshot records the actual core tools and MCP tools made available to that run.
- Documentation and UI copy consistently use "core tools" for built-in run tools and
  "plugins" for managed capability bundles.

## Follow-Up Implementation Slices

The concrete implementation sequence is tracked in
[Core Tools Runtime Boundary Implementation Plan](core-tools-runtime-boundary-implementation-plan.md).

1. Add a Plugin Manager catalog filter so plain built-in `tool:*` extensions do not
   render as plugin cards.
2. Add or formalize `/runtime/extensions` as a read-only diagnostic endpoint for internal
   extension metadata.
3. Add compact runner detail metadata for supported core tools.
4. Add MCP tool copy that clearly distinguishes server-provided tools from core tools.
5. Add tests that assert Plugin Manager excludes core tools while approval policy includes
   them.
