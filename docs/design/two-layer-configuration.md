# Two-Layer Configuration

Status: Proposed design, Slices 1, 3, and 4 runtime inheritance implemented; provider profiles and keychain cleanup pending
Date: 2026-06-14
Scope: User-level and workspace-level configuration, settings, provider profiles,
runner defaults, local state, and migration rules.

## Summary

Ling Stack should use a Codex-like two-layer configuration model:

```text
~/.ling-stack/                 user and machine defaults
<workspace>/.ling-stack/       workspace state, overrides, runs, artifacts, audit
```

The user layer answers "what does this person prefer on this machine?" The workspace
layer answers "what is true for this workspace and its durable runs?"

The workspace layer remains the authority for executable product state: channels,
tasks, runs, teammates, approvals, provider presets used by workspace records, runtime
settings, sessions, artifacts, and audit logs. The user layer can provide defaults and
templates, but it must not silently mutate existing workspace behavior after a run has
been created.

This is a design direction. Slices 1, 3, and the runtime inheritance part of Slice
4 are implemented at the current boundary:

- `resolveUserConfigPaths()` resolves user-level `~/.ling-stack` paths.
- `resolveConfigPaths()` returns user and workspace layers together.
- `LING_STACK_HOME` can override the user root for tests and local operator workflows.
- `ling-stack doctor config` reports user config, user settings, and user provider
  profile paths without requiring them to exist.
- `GET /config/effective` reports user/workspace paths and source metadata for
  workspace cwd, theme, locale, response language, and runtime runner settings.
- `@ling-stack/api-client` and Web API exports expose `getEffectiveConfig()`.
- Web reads interface preferences through daemon-owned effective config.
- Web Settings displays interface preference sources as workspace, user default, or
  built-in.
- Browser localStorage is now only a legacy bootstrap/migration input for workspace
  cwd, theme, locale, channel notifications, and channel activity saved views. Web
  no longer writes those values back to localStorage.
- User-level runtime defaults in `~/.ling-stack/config.json` now apply field by field
  when a workspace runtime settings file is missing a field.

Current code is still mostly workspace-local:

- `resolveRuntimePaths(cwd)` points to `<cwd>/.ling-stack`.
- `ling-stack init` writes `<cwd>/.ling-stack/config.json`.
- SQLite lives at `<cwd>/.ling-stack/ling-stack.sqlite`.
- workspace UI settings live in SQLite table `workspace_settings`.
- runner defaults live in `<cwd>/.ling-stack/runtime-settings.json`.
- User-level runtime defaults can seed execution until the workspace writes explicit
  runtime settings. Runtime source metadata is field-level: `workspace`, `user`, or
  `built_in`.

The target is not a new `.longstack` directory. The product directory should be
`.ling-stack`, with one copy under the user home and one copy inside each workspace.

## Problem

A single workspace-local `.ling-stack` directory makes early development simple, but it
creates product and implementation problems as soon as one user opens multiple
workspaces:

- The same UI defaults, daemon defaults, provider profile templates, and plugin caches
  get duplicated per workspace.
- Workspace settings and user preferences become hard to distinguish in the Web UI.
- Browser localStorage starts acting like a third, implicit config layer.
- Provider presets mix two concepts: reusable personal provider setup and workspace
  records referenced by channels, teammates, and runs.
- Runtime defaults cannot cleanly express "use Pi everywhere unless this workspace
  overrides it."
- Secret refs and secret values need a stricter boundary before desktop/keychain work
  expands.

The fix is not to move everything global. Ling's workspace state is valuable exactly
because it is local, inspectable, and tied to durable run evidence. The fix is to split
defaults from workspace truth.

## Goals

- Keep the current workspace `.ling-stack` state model working.
- Add a stable user-level `~/.ling-stack` for cross-workspace defaults and caches.
- Make config precedence deterministic and visible in CLI, daemon, and Web settings.
- Remove localStorage as a source of truth. Keep it only as a short migration fallback.
- Preserve secret boundaries. Persistent config stores refs, not raw secret values.
- Let provider profiles be reusable without making workspace runs depend on mutable
  global state.
- Keep Pi as the built-in runner default unless user or workspace settings explicitly
  choose something else.

## Non-Goals

- No team or cloud sync in this design.
- No wholesale copy of Codex app-server JSON-RPC or config internals.
- No switch from embedded Pi library mode to Pi CLI.
- No raw API keys in user config, workspace config, run snapshots, logs, or artifacts.
- No silent background migration that changes the effective provider or runner for an
  existing workspace.

## Directory Layout

Target user layer:

```text
~/.ling-stack/
  config.json                  stable user config and daemon defaults
  settings.json                user UI defaults
  providers/
    profiles.json              reusable provider profile templates, refs only
  plugins/
    cache/                     downloaded plugin bundles shared across workspaces
  state/
    recent-workspaces.json     local MRU and last-opened workspace state
    daemon.json                local daemon process metadata
  logs/                        user-level CLI/daemon operator logs
```

Target workspace layer:

```text
<workspace>/.ling-stack/
  config.json                  workspace identity and workspace overrides
  ling-stack.sqlite            durable workspace metadata
  runtime-settings.json        workspace runner defaults and fallback policy
  sessions/                    run event logs and summaries
  artifacts/                   run artifacts, packet artifacts, media artifacts
  attachments/                 copied or materialized user inputs
  pi/                          Pi runtime workspace data
  plugins/
    enabled.json               workspace plugin enablement and pins
    lock.json                  resolved plugin versions for this workspace
  logs/                        workspace-scoped daemon/runtime logs
```

The current code already owns most workspace paths. The main new code path should be a
shared resolver that returns both layers:

```ts
interface LingConfigPaths {
  readonly userRootDir: string;
  readonly userConfigPath: string;
  readonly userSettingsPath: string;
  readonly userProviderProfilesPath: string;
  readonly workspaceRootDir: string;
  readonly workspaceConfigPath: string;
  readonly workspaceDatabasePath: string;
  readonly workspaceRuntimeSettingsPath: string;
}
```

## Ownership Matrix

| Data | User layer | Workspace layer | Notes |
| --- | --- | --- | --- |
| Daemon host/port default | Yes | Optional override | CLI flags still win. |
| Recent workspaces | Yes | No | Local machine state, not project state. |
| Theme and locale defaults | Yes | Optional override in `workspace_settings` | Web should show effective value and source. |
| Response language default | Yes | Optional channel/workspace override | Channel policy remains workspace state. |
| Channel notification levels | No | Yes | Scoped to workspace/channel identity. |
| Channel activity views | No | Yes | These are workspace information architecture choices. |
| Provider profile templates | Yes | Imported snapshot | Global updates must not silently alter existing workspace presets. |
| Provider presets used by records | No | Yes, SQLite | Channels, teammates, and runs reference workspace preset ids. |
| Provider secret refs | Yes for templates, Yes for workspace presets | Values never live in JSON config. |
| Local provider secret values | No target ownership | Current compatibility path only | See "Secret model". |
| Runner default preference | Yes | Override in `runtime-settings.json` | Workspace setting wins for runs in that workspace. |
| Allowed runner ids | Optional default | Yes | Workspace policy is the execution authority. |
| Approval policy | Optional default template | Yes | Actual approval decisions and state are workspace audit. |
| Tasks, runs, approvals | No | Yes, SQLite and artifacts | Never user-global. |
| Sessions and artifacts | No | Yes | Evidence must travel with workspace state. |
| Plugin cache | Yes | Workspace lock/enablement | Share bytes globally, pin behavior per workspace. |
| MCP server definitions | Optional templates | Yes | Effective tool availability is workspace policy. |

## Effective Resolution

The general precedence order is:

```text
request / CLI flag
-> environment variable
-> workspace config or workspace SQLite setting
-> user config or user setting
-> built-in default
```

Each domain should name its exact chain. Do not apply the generic order blindly when it
would weaken safety.

### Workspace Discovery

Target discovery for CLI and daemon calls:

1. Explicit `--cwd` or API `cwd`.
2. Nearest ancestor containing `.ling-stack/config.json`.
3. Git root, if one exists.
4. Current process directory.

The first implementation can keep the current explicit-cwd behavior and add discovery
behind a small helper. The important rule is that all clients must agree on the
canonical workspace cwd before opening the SQLite database.

### UI Settings

Effective UI settings should be computed as:

```text
workspace_settings.settings_json value
-> ~/.ling-stack/settings.json value
-> browser/system default
```

Web localStorage should not be treated as a durable layer. It can be read once for
migration, written into daemon-owned settings, and then ignored for source-of-truth
purposes.

### Runtime Runner Settings

Runner settings should stay workspace-owned for execution:

```text
run request runnerId
-> teammate runnerId
-> <workspace>/.ling-stack/runtime-settings.json defaultRunnerId
-> ~/.ling-stack/config.json runtimeDefaults.defaultRunnerId
-> built-in "pi"
```

Fallback policy remains workspace-owned:

```text
<workspace>/.ling-stack/runtime-settings.json explicitRunnerFallback
-> built-in "disabled"

<workspace>/.ling-stack/runtime-settings.json implicitRunnerFallback
-> user runtime default, if present
-> built-in "allow_to_default"
```

If a workflow or user explicitly requests an unsupported runner, the default behavior
must fail closed. A user-level default may select a runner for new workspaces, but it
must not override a workspace policy that already exists.

Detailed field-level runtime inheritance, provider profile import boundaries, and
secret/keychain split rules are tracked in
[Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md).

### Startup Loading Contract

The daemon should load the two-layer configuration on every process start for the
default workspace. The startup chain is:

```text
process config
-> user config/settings
-> workspace store/settings
-> effective config snapshot
-> runtime policy validation
-> secret resolver capability status
-> optional provider/scheduler/plugin warmups
```

The contract is intentionally not "HTTP listen means all settings are ready." `/health`
stays process-focused; richer readiness belongs to the startup status surface described
in [Startup Readiness Chain](startup-readiness-chain.md).

Restart behavior:

- a daemon restart discards in-memory effective config snapshots,
- the default workspace snapshot is recomputed from current disk state,
- malformed optional user config creates diagnostics but does not kill the process,
- invalid workspace runtime policy blocks run creation for that workspace,
- optional warmups may leave the workspace degraded without blocking the daemon.

### Provider Profiles and Presets

Use two names deliberately:

- Provider profile: user-level reusable template.
- Provider preset: workspace-level record referenced by channels, teammates, and runs.

Applying a profile to a workspace creates or updates a workspace preset snapshot:

```text
~/.ling-stack/providers/profiles.json profile
-> POST /providers/import-profile
-> provider_presets row in <workspace>/.ling-stack/ling-stack.sqlite
```

Workspace presets should record optional provenance:

```ts
interface ProviderPresetProvenance {
  readonly sourceKind: "user_profile" | "template" | "manual";
  readonly sourceId?: string;
  readonly importedAt?: string;
}
```

Do not make active workspace runs depend on a mutable global provider profile. If the
user changes a global profile, the Web UI can show "profile changed, refresh this
workspace preset?" and require an explicit update.

## Secret Model

Persistent config stores secret refs only:

```text
env:OPENAI_API_KEY
keychain:provider_openai_codex
```

The resolver decides whether a ref is configured at execution time. API clients may see
configured/missing status. They must not receive raw values.

Current code also supports provider-local refs like:

```text
local:provider_...
```

That path stores provider secret values in the workspace SQLite database through the
provider secret compatibility table. Treat it as a current local-only compatibility
path, not as the target configuration architecture. The target model should prefer:

- `env:` for development and CI-style local shells,
- `keychain:` for desktop and normal user setup,
- migration/doctor warnings for workspace-local raw provider secrets when keychain
  support is available.

Do not expand `local:` to GitHub tokens, MCP secrets, automation tokens, webhook
secrets, or plugin secrets.

## Config File Shapes

User config example:

```json
{
  "schemaVersion": 1,
  "product": "ling-stack",
  "daemon": {
    "host": "127.0.0.1",
    "port": 17891
  },
  "runtimeDefaults": {
    "defaultRunnerId": "pi",
    "implicitRunnerFallback": "allow_to_default"
  },
  "pluginCache": {
    "enabled": true
  }
}
```

User settings example:

```json
{
  "schemaVersion": 1,
  "theme": "system",
  "locale": "system",
  "responseLanguage": "follow_user",
  "updatedAt": "2026-06-13T00:00:00.000Z"
}
```

User provider profile example:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "openai-codex",
      "displayName": "OpenAI Codex",
      "kind": "openai",
      "providerId": "openai",
      "model": "gpt-5",
      "api": "openai-responses",
      "apiKeyRef": "keychain:provider_openai_codex",
      "capabilities": ["chat", "tool_call", "reasoning"]
    }
  ]
}
```

Workspace config example:

```json
{
  "schemaVersion": 1,
  "product": "ling-stack",
  "workspaceId": "workspace_default",
  "workspaceName": "ling-stack",
  "providerTemplates": "sqlite",
  "secrets": "refs-only",
  "createdBy": "ling-stack init"
}
```

Workspace runtime settings should continue to use the existing shape:

```json
{
  "workspaceId": "workspace_default",
  "defaultRunnerId": "pi",
  "allowedRunnerIds": ["pi"],
  "explicitRunnerFallback": "disabled",
  "implicitRunnerFallback": "allow_to_default",
  "updatedAt": "2026-06-13T00:00:00.000Z"
}
```

## API and CLI Surface

Target CLI commands:

```bash
ling-stack config get --scope user
ling-stack config get --scope workspace
ling-stack config set ui.theme system --scope user
ling-stack config set runtime.defaultRunnerId pi --scope workspace
ling-stack config doctor
```

Target daemon endpoints:

```http
GET /config/effective?cwd=/path/to/workspace
GET /config/user
PATCH /config/user
GET /config/workspace?cwd=/path/to/workspace
PATCH /config/workspace?cwd=/path/to/workspace
GET /providers/profiles
POST /providers/import-profile?cwd=/path/to/workspace
```

Rules:

- `GET /config/effective` returns value, source, and overridden-by metadata.
- Workspace-scoped endpoints require canonical `cwd`.
- User-scoped writes should be local-only and should not be exposed as runner tools.
- Runner/model output must never be able to write config directly.
- Provider profile import writes a workspace preset snapshot and emits audit evidence.

Effective config response shape:

```ts
interface EffectiveConfigValue<T> {
  readonly value: T;
  readonly source: "request" | "env" | "workspace" | "user" | "built_in";
  readonly path: string;
  readonly overriddenBy?: readonly string[];
}
```

## Web Settings UX

Settings should show the source of each effective value.

Suggested grouping:

- General
  - User defaults: theme, locale, response language.
  - Workspace overrides: same fields with "use user default" reset.
- Runtime
  - Effective runner default.
  - Workspace override controls.
  - User default controls behind "set as default for new workspaces".
- Models
  - Workspace Model Workbench remains the main table.
  - User provider profiles appear as importable templates, not active rows.
- Secrets
  - Show ref kind and configured status.
  - Offer keychain setup where supported.
  - Flag `local:` provider secrets as local-only compatibility.
- Storage
  - Show user root and workspace root.
  - Show SQLite path, sessions path, artifacts path, plugin cache path.

No in-app prompt should explain this model on every launch. The settings screen should
make the sources inspectable when the user needs them.

## Migration Plan

### Slice 1: Shared path resolver and doctor

- Add a core path resolver for user and workspace config paths.
- Keep existing `resolveRuntimePaths(cwd)` behavior as a compatibility wrapper.
- Add `ling-stack config doctor` or extend `doctor` to report:
  - user root path,
  - workspace root path,
  - workspace database path,
  - runtime settings path,
  - localStorage migration status if called from Web diagnostics.

### Slice 2: User config bootstrap

- Create `~/.ling-stack/config.json` only on explicit write or first settings save.
- Do not require the user layer for existing workspaces.
- Load user defaults read-only when present.
- Preserve existing `.ling-stack/config.json` fields.

### Slice 3: Effective settings API

- Add `GET /config/effective`. Implemented for user/workspace paths, UI settings
  source metadata, sanitized user config layers, diagnostics, and current runtime
  runner source metadata.
- Return source metadata for UI settings and runtime defaults. Runtime settings now
  report source metadata field by field.
- Move Web reads from localStorage fallback to daemon-owned settings. Implemented for
  workspace cwd, theme, locale, response language, channel notifications, and channel
  activity saved views.
- Add one-time localStorage migration for:
  - theme preference,
  - locale,
  - workspace cwd,
  - channel notification fallback keys,
  - channel activity view fallback keys.
  Implemented as a best-effort import into workspace settings followed by legacy key
  cleanup after daemon state exists.

### Slice 4: Runtime settings inheritance

- Load user runtime defaults only when workspace `runtime-settings.json` is missing or
  leaves a field unset. Implemented for `defaultRunnerId`, `explicitRunnerFallback`,
  and `implicitRunnerFallback`.
- Once a workspace runtime settings file is written, it becomes the execution policy for
  that workspace. `PATCH /runtime/settings` writes the complete effective settings,
  so inherited values become workspace-owned after save.
- Keep explicit runner fallback fail-closed unless user or workspace config explicitly
  changes the field.
- Treat invalid user runtime defaults as non-fatal diagnostics. Workspace runtime files
  remain strict because they are executable policy.

### Slice 5: Provider profiles

- Add user-level provider profiles as templates.
- Add import-to-workspace flow.
- Store imported provider preset snapshots in SQLite.
- Add provenance metadata if needed for refresh prompts.
- Do not auto-update workspace presets when a user profile changes.

### Slice 6: Secret cleanup

- Keep `local:` provider secret refs readable.
- Prefer `keychain:` for new desktop setup when available.
- Add doctor warning when `local:` provider secrets exist and keychain support is
  available.
- Never migrate secret values without explicit user action.

## Tests

Core and daemon tests:

- path resolver returns stable user and workspace paths,
- missing user config falls back to built-ins,
- workspace config overrides user config,
- request/CLI override wins over both config layers,
- effective config response includes source metadata,
- existing workspace without `~/.ling-stack` still runs,
- runtime settings keep explicit fallback disabled,
- provider profile import creates a workspace preset snapshot,
- changing a user profile does not change existing workspace presets,
- `local:` provider secrets remain readable but are flagged as compatibility,
- malformed config files fail with actionable errors.

Web tests:

- settings page shows effective value and source,
- "use user default" clears workspace override,
- localStorage migration writes daemon settings once,
- model workbench distinguishes user profile templates from workspace presets,
- storage/settings view shows both root paths.

CLI tests:

- `config get --scope user`,
- `config get --scope workspace`,
- `config set ... --scope user`,
- `config doctor` on a workspace without user config,
- `config doctor` with malformed JSON.

## Trade-Offs

Keeping provider presets workspace-local means the user may need to import the same
profile into multiple workspaces. That is intentional. It prevents a global model edit
from changing old runs, channel defaults, or teammate behavior without an audit trail.

Keeping artifacts and sessions workspace-local duplicates storage across workspaces.
That is also intentional. Evidence should stay close to the work that created it.

Adding source metadata to settings APIs costs extra plumbing, but it avoids a common
settings failure mode where the UI shows a value and nobody can tell whether it came
from user defaults, workspace overrides, or built-ins.

## Open Decisions

- Should the Web renderer be allowed to patch `~/.ling-stack/config.json` directly
  through daemon endpoints, or should user-level writes be desktop/CLI-only until the
  desktop trust boundary is finished?
- Should workspace discovery scan ancestors by default in the first implementation, or
  should it remain explicit-cwd until all APIs pass canonical cwd consistently?
- What is the non-macOS target for `keychain:` before desktop packaging ships?
- Should imported provider preset provenance be a SQLite column or live inside an
  existing JSON field until refresh flows exist?

## Related

- [Architecture](../architecture.md)
- [Runner Registry](runner-registry.md)
- [Provider Presets Design](provider-presets.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md)
- [Startup Readiness Chain](startup-readiness-chain.md)
- [Execution And Orchestration Hardening](execution-orchestration-hardening.md)
- [CLI v0.1](cli-v0.1.md)
