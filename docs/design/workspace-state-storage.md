# Workspace State Storage

Status: Proposed design; Slice 1 registry, Slice 2 resolver, daemon path wiring, and Slice 3 opt-in foundation implemented
Date: 2026-06-18
Scope: Workspace runtime state, user-level registry, memory storage, artifact paths,
Markdown projections, storage-location modes, migration, and diagnostics.

## Summary

Ling Stack should use a two-layer storage model with one clear rule:

```text
<workspace>/.ling-stack/ling-stack.sqlite
  = default workspace source of truth

~/.ling-stack/global.sqlite
  = user-level registry, defaults, cache indexes, and cross-workspace lookup

Markdown files
  = human-readable instructions, drafts, imports, exports, and review material
```

The default mode remains workspace-local. A workspace's runs, channels, tasks, work
items, approvals, teammates, memory objects, memory usage audit, sessions, artifacts,
attachments, and logs belong with the workspace. This keeps Ling local-first,
inspectable, copyable, and debuggable.

The user data directory is still needed, but it should not become the hidden authority
for every workspace by default. It stores user defaults and a registry of workspaces.
It may also host full workspace state only when a workspace explicitly opts in through
`workspaceStateLocation=user-data-dir`.

## Problem

Ling has two competing needs:

1. Workspace evidence should travel with the workspace.
2. User-level defaults, provider templates, plugin caches, recent workspace lists, and
   desktop-app state should be shared across workspaces.

Moving all data into `~/.ling-stack` would make desktop management easier, but it would
separate a workspace from its run evidence. Keeping everything inside each repo makes
the evidence clear, but it duplicates user-level data and cannot handle read-only or
policy-controlled repos well.

The storage design needs an explicit split instead of one directory pretending to serve
both jobs.

## Goals

- Keep `<workspace>/.ling-stack/ling-stack.sqlite` as the default authority for
  workspace facts.
- Add `~/.ling-stack/global.sqlite` for user-level registry and cache data.
- Support an opt-in `user-data-dir` mode for workspaces that cannot or should not write
  `.ling-stack` into the repo.
- Keep all API and CLI calls addressable by `cwd`, with storage paths resolved behind a
  single resolver.
- Make memory storage SQL-first while allowing Markdown import, export, and review
  projections.
- Preserve source refs from memory and review records back to sessions, artifacts, and
  runs.
- Keep secrets and authority decisions out of Markdown exports by default.

## Non-Goals

- No default migration of all existing workspace state into `~/.ling-stack`.
- No global database as the default source of truth for workspace runs, memory, tasks, or
  approvals.
- No raw secret values in SQLite examples, Markdown exports, logs, or artifacts.
- No cloud sync or team sync in this design.
- No new third source of truth in browser localStorage.
- No silent cross-workspace memory recall based only on a shared global index.

## Directory Layout

Default user layer:

```text
~/.ling-stack/
  config.json
  settings.json
  global.sqlite
  providers/
    profiles.json
  plugins/
    cache/
  state/
    recent-workspaces.json
    daemon.json
  logs/
```

Default workspace layer:

```text
<workspace>/.ling-stack/
  config.json
  ling-stack.sqlite
  runtime-settings.json
  sessions/
  artifacts/
  attachments/
  logs/
  pi/
  plugins/
    enabled.json
    lock.json
  worktrees/
  exports/
    memory/
```

Opt-in user-data-dir workspace layer:

```text
~/.ling-stack/workspaces/<workspace-id>/
  config.json
  ling-stack.sqlite
  runtime-settings.json
  sessions/
  artifacts/
  attachments/
  logs/
  pi/
  plugins/
    enabled.json
    lock.json
  worktrees/
  exports/
    memory/
```

`~/.ling-stack/workspaces/<workspace-id>/` is not the same thing as
`~/.ling-stack/global.sqlite`. The first is a relocated workspace root. The second is a
user-level registry and cache database.

## Storage Location Modes

### repo-local

`repo-local` is the default.

```json
{
  "workspaceStateLocation": "repo-local"
}
```

For `cwd=/path/to/project`, state resolves to:

```text
/path/to/project/.ling-stack/
```

Use this mode when the workspace path is writable and the user benefits from local
evidence living beside project files.

### user-data-dir

`user-data-dir` is explicit opt-in.

```json
{
  "workspaceStateLocation": "user-data-dir"
}
```

For `cwd=/path/to/project`, state resolves to:

```text
~/.ling-stack/workspaces/<workspace-id>/
```

Use this mode when:

- the repo is read-only;
- company policy forbids local tool state inside the repo;
- the workspace lives in a synced directory that should not carry Ling runtime data;
- the desktop app needs central management for a specific workspace;
- the user wants sessions, artifacts, memory, and logs under the user profile only.

The tradeoff is real: workspace state no longer travels with the repo path. Doctor,
export, backup, and handoff flows must make that visible.

## Ownership Matrix

| Data | repo-local workspace DB | user-data-dir workspace DB | `~/.ling-stack/global.sqlite` | Markdown |
| --- | --- | --- | --- | --- |
| Workspace identity | Yes | Yes | Registry copy | Optional summary |
| Channels | Yes | Yes | No | Export only |
| Tasks and work items | Yes | Yes | No | Export only |
| Runs and run events | Yes | Yes | No | Export only |
| Sessions JSONL | Workspace root | User workspace root | No | No |
| Artifacts and attachments | Workspace root | User workspace root | No | No |
| Approvals and review actions | Yes | Yes | No | Export only |
| Teammate records | Yes | Yes | Templates only | Draft persona |
| Memory objects | Yes | Yes | Optional index summary | Export/import |
| Memory used events | Yes | Yes | No | Export only |
| Memory consolidation jobs | Yes | Yes | No | Export only |
| Provider preset templates | Imported snapshot | Imported snapshot | Yes | Optional docs |
| Provider presets used by records | Yes | Yes | No | No |
| Secret values | No | No | No | No |
| Plugin cache bytes | No | No | Optional metadata | No |
| Plugin enablement and lock | Yes | Yes | No | Optional docs |
| Recent workspaces | No | No | Yes | No |
| User settings | No | No | Yes | Optional docs |

## Global Database

`~/.ling-stack/global.sqlite` should be a registry and cache database. It should not be
the default workspace run store.

Draft tables:

```sql
CREATE TABLE workspaces_registry (
  workspace_id TEXT PRIMARY KEY,
  canonical_cwd TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state_location TEXT NOT NULL,
  state_root TEXT NOT NULL,
  git_root TEXT,
  git_remote_url TEXT,
  fingerprint_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE UNIQUE INDEX idx_workspaces_registry_canonical_cwd
  ON workspaces_registry(canonical_cwd)
  WHERE archived_at IS NULL;

CREATE TABLE user_default_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_profile_templates (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  config_json TEXT NOT NULL,
  secret_ref_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plugin_cache_index (
  package_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  integrity TEXT,
  updated_at TEXT NOT NULL
);
```

Global rows may point to a workspace root. They must not be treated as proof that a
workspace DB is healthy. Doctor must still open the resolved workspace DB and inspect
its migrations.

## Workspace Database

Workspace SQLite remains the authority for product state. The existing
`ling-stack.sqlite` schema already owns runs, channels, tasks, approvals, teammate
records, memory records, review actions, and related state.

The storage-location design does not change the meaning of workspace tables. It changes
where the workspace root is located.

```text
repo-local:
  <cwd>/.ling-stack/ling-stack.sqlite

user-data-dir:
  ~/.ling-stack/workspaces/<workspace-id>/ling-stack.sqlite
```

All code should treat the resolved workspace database path as the authority, not string
concatenate `<cwd>/.ling-stack/ling-stack.sqlite` at call sites.

## Resolver Contract

Current code has `resolveUserConfigPaths()` and `resolveRuntimePaths(cwd)`. The next
boundary should be a storage resolver that returns user paths, workspace identity, and
the effective workspace state root together.

Draft API:

```ts
export type WorkspaceStateLocation = "repo-local" | "user-data-dir";

export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly displayName: string;
  readonly gitRoot?: string;
  readonly gitRemoteUrl?: string;
  readonly fingerprint: Record<string, unknown>;
}

export interface WorkspaceStatePaths {
  readonly location: WorkspaceStateLocation;
  readonly identity: WorkspaceIdentity;
  readonly rootDir: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly runtimeSettingsPath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly piDir: string;
  readonly pluginsDir: string;
  readonly pluginCacheDir: string;
  readonly worktreesDir: string;
  readonly memoryExportsDir: string;
}

export interface LingStoragePaths {
  readonly user: LingStackUserConfigPaths & {
    readonly globalDatabasePath: string;
    readonly workspacesDir: string;
  };
  readonly workspace: WorkspaceStatePaths;
}

export function resolveStoragePaths(cwd: string, options?: ResolveConfigPathsOptions): LingStoragePaths;
```

Rules:

- API routes and CLI commands keep accepting `cwd`.
- The resolver canonicalizes `cwd` before opening any store.
- The resolver reads workspace config, global registry, and defaults before deciding the
  state root.
- Store construction accepts `paths.workspace.databasePath`; it never recomputes a
  `.ling-stack` path.
- Any direct path helper that assumes `<cwd>/.ling-stack` should become a wrapper around
  `resolveStoragePaths()`.

## Workspace Identity

Workspace identity must survive process restarts and must not collapse multiple clones
into one state root accidentally.

Recommended identity fields:

```text
workspace_id      stable generated id
canonical_cwd     resolved workspace path used by this machine
display_name      user-visible name
git_root          resolved git root, if present
git_remote_url    origin URL, if present
fingerprint       path, git root, remote, package name, and optional manual alias
created_at
updated_at
```

Identity rules:

- A new workspace gets a generated `workspace_id`.
- Moving a workspace path should update `canonical_cwd` only after user confirmation or
  a clear registry repair command.
- Two clones with the same remote but different paths should not share state by default.
- A manual alias may help humans recognize a workspace, but it must not be the only key.
- `workspace_id` is the directory name for user-data-dir state roots.

## Memory Boundary

Memory remains SQL-first.

The authoritative tables stay in the resolved workspace database:

```text
memory_objects
memory_used_events
memory_review_policy
memory_review_decisions
memory_review_actions
memory_consolidation_jobs
memory_self_improving_metadata
```

Memory consolidation and reflection jobs may create candidates. They must not:

- silently write active memory;
- silently write workspace shared memory;
- mutate teammate persona;
- grant tools, approvals, provider access, deploy access, credentials, or external-send
  permission;
- index or export secret-adjacent content by default;
- leak private teammate or channel context across scopes.

`~/.ling-stack/global.sqlite` may store search summaries or registry hints later, but
global summaries are not active memory. Active recall must read from the resolved
workspace DB and apply workspace, channel, teammate, sensitivity, and review policy.

## Markdown Projection

Markdown is a projection layer, not the source of truth for active Ling memory.

Good Markdown uses:

```text
AGENTS.md
docs/design/*.md
<workspace-state-root>/exports/memory/*.md
<workspace-state-root>/teammates/<teammate-id>/AGENT.md
```

Rules:

- `AGENTS.md` can define workflow, style, and technical conventions.
- Per-teammate `AGENT.md` can become source material for a profile draft.
- Markdown memory exports should include ids, scope, review state, source refs, and
  sensitivity labels.
- Imports from Markdown create candidates unless an explicit user action approves them.
- Markdown cannot grant authority, tools, secrets, provider access, or approval policy.
- Markdown exports must redact or omit secret-adjacent content by default.

Example export shape:

```markdown
# Memory Export

Workspace: workspace_...
Generated: 2026-06-18T00:00:00.000Z
Source DB: <resolved workspace database path>

## memory_...

Scope: workspace
Review state: candidate
Sensitivity: normal
Confidence: high
Source refs:
- run: run_...
- event: evt_...

Body:
Runner backend defaults to embedded Pi coding-agent library mode.
```

## Migration And Compatibility

Migration should be additive.

1. Keep existing repo-local workspaces working.
2. Add `global.sqlite` and registry writes without changing workspace DB paths.
3. Add `workspace_id` to workspace config if missing.
4. Add `resolveStoragePaths(cwd)` and route new code through it.
5. Switch existing direct `.ling-stack` path creation to use resolved workspace paths.
6. Add `workspaceStateLocation` support, still defaulting to `repo-local`.
7. Add explicit migration command for `repo-local -> user-data-dir`.
8. Add explicit migration command for `user-data-dir -> repo-local`.

No migration should silently move sessions, artifacts, attachments, logs, or memory. A
move must be user-initiated, logged, and reversible by backup.

### Explicit Migration Command

Slice 4 adds:

```bash
ling-stack workspace migrate-state --to user-data-dir
ling-stack workspace migrate-state --to repo-local
ling-stack workspace migrate-state --to user-data-dir --dry-run --json
```

The command:

- supports `--dry-run`, which reports source, target, preview manifest path, preview
  backup path, daemon state, source DB presence, target replacement behavior, migration
  metadata writability, repo pointer writability, and registry update status without
  copying files or writing manifests;
- refuses no-op migrations where the active state location already matches `--to`;
- refuses to run while the Ling Stack daemon pid is alive, because copying SQLite plus
  JSONL/log files during live writes is not a safe snapshot;
- copies the resolved source workspace state root to a staging directory next to the
  target root;
- rewrites the staged `config.json` so the target state root is internally consistent;
- backs up any existing target root under
  `~/.ling-stack/state/migrations/<migration-id>/backup/target-existing/`;
- replaces the target root only after staging copy and target config rewrite succeed;
- for `repo-local -> user-data-dir`, leaves the repo-local state files in place but
  rewrites repo `.ling-stack/config.json` as a pointer to the relocated state root;
- for `user-data-dir -> repo-local`, backs up the old repo-local pointer directory and
  writes a full repo-local state root at `<workspace>/.ling-stack/`;
- writes `manifest.json` under
  `~/.ling-stack/state/migrations/<migration-id>/manifest.json`, including source mode,
  target mode, workspace id, copied top-level paths, backup paths, and status.

The command does not delete the source state root after success. If a later step fails
after target replacement or repo pointer rewrite, it attempts to restore the target root
and source config from the migration backup before returning an error.

### Explicit Registry Repair

Slice 4 also adds:

```bash
ling-stack workspace repair-registry --dry-run --json
ling-stack workspace repair-registry
ling-stack workspace registry repair
```

The command:

- resolves the current workspace using normal resolver precedence;
- compares the resolved workspace id, canonical cwd, state location, and state root with
  the global registry row;
- in `--dry-run` mode, reports whether it would write and which fields differ;
- in execution mode, updates only `~/.ling-stack/global.sqlite` through the registry
  store;
- does not edit repo `.ling-stack/config.json`, does not copy or delete state roots, and
  does not migrate sessions, artifacts, logs, or memory.

This is intentionally narrower than migration. It is for stale or missing registry rows
after the user has confirmed the active state root through `doctor config` or migration
dry-run.

## Doctor And Diagnostics

Doctor should report both layers.

Suggested checks:

```text
config.user_root
config.global_sqlite
workspace.registry
workspace.identity
workspace.cwd_writable
workspace.state_location
workspace.state_root
workspace.sqlite
workspace.sessions
workspace.artifacts
workspace.attachments
workspace.logs
workspace.path_mapping
memory.review_policy
memory.tables
registry.consistency
```

Doctor output should answer:

- Which `cwd` was requested?
- Which workspace id was resolved?
- Which state location is active?
- Which SQLite database is authoritative?
- Does the global registry point to the same state root?
- Is the repo cwd writable, and if not, is `user-data-dir` selected?
- Are session and artifact paths under the resolved state root?
- Is the workspace DB migrated and readable?
- Are memory tables present?

For user-data-dir workspaces, doctor should call out that state will not travel with the
repo unless exported or backed up separately.

## Backup, Export, And Handoff

Repo-local backup can copy:

```text
<workspace>/.ling-stack/
```

User-data-dir backup must copy:

```text
~/.ling-stack/workspaces/<workspace-id>/
```

and the relevant registry row from:

```text
~/.ling-stack/global.sqlite
```

Handoff packages should include:

- workspace identity;
- workspace config;
- workspace SQLite dump or database copy;
- sessions JSONL;
- artifacts and attachments;
- memory Markdown export, when requested;
- a manifest describing whether the source mode was `repo-local` or `user-data-dir`.

## Failure Modes

| Failure | Required behavior |
| --- | --- |
| `cwd` is not writable | Offer `user-data-dir` or fail before starting a run. |
| Global registry row is stale | Repair registry, do not open a guessed workspace DB silently. |
| Workspace id collision | Stop and require user repair. |
| user-data-dir state root missing | Report missing state root and offer restore or reinitialize. |
| repo-local `.ling-stack` exists but config says user-data-dir | Prefer explicit config, warn about unused local state. |
| Session path outside resolved state root | Block artifact/session serving. |
| Markdown import changes authority | Store candidate only, require review. |
| Memory source refs missing | Mark memory health warning; do not auto-promote. |
| Secret-like content in export | Redact or block export depending on policy. |

## Security Boundary

Storage location must not weaken authority boundaries.

- Secret values stay outside JSON config, SQLite examples, Markdown exports, logs, and
  artifacts.
- Provider profile templates may store secret refs, not raw values.
- Workspace approval policy remains workspace-owned.
- Memory cannot grant tools, provider access, deploy access, or external-send
  permission.
- Global indexes must not make cross-workspace recall active by default.
- Artifacts and attachments must be served only from the resolved workspace state root.

## Implementation Slices

### Slice 1: Registry And Identity

- Add `global.sqlite` path to user config paths.
- Create `workspaces_registry`.
- Ensure each workspace has a stable `workspace_id`.
- Register workspace opens without changing existing repo-local behavior.
- Add doctor checks for registry and identity consistency.

### Slice 2: Resolver Abstraction

- Add `resolveStoragePaths(cwd)`.
- Route daemon store registry, CLI init, doctor, artifacts, attachments, sessions, and
  runtime paths through the resolver.
- Keep `resolveRuntimePaths(cwd)` as a compatibility wrapper if needed.
- Add tests for default repo-local paths.

### Slice 3: user-data-dir Opt-In

- Add `workspaceStateLocation`.
- Resolve opted-in workspaces to `~/.ling-stack/workspaces/<workspace-id>/`.
- Add init and doctor support for read-only workspace paths.
- Add tests for repo-local and user-data-dir path mapping.

### Slice 4: Migration Commands

- Add explicit `repo-local -> user-data-dir` migration.
- Add explicit `user-data-dir -> repo-local` migration.
- Copy SQLite, sessions, artifacts, attachments, logs, runtime settings, plugins, and
  worktrees.
- Write a migration manifest and backup path.
- Never remove the source state root until verification passes.

### Slice 5: Markdown Memory Projection

- Add memory export command and Web action.
- Add candidate-only Markdown import.
- Export preserves source refs, review state, sensitivity, confidence, tags, and review
  metadata for inspection.
- Import preserves source refs, tags, sensitivity, and verify-before-use hints, but always
  creates review candidates and drops retrieval/review authority fields.
- Add redaction scan for exported content.

## Test Plan

Unit tests:

- `resolveStoragePaths()` returns repo-local paths by default.
- `resolveStoragePaths()` returns user-data-dir paths when configured.
- Workspace id generation is stable across repeated opens.
- Two clones with the same remote and different paths do not share workspace ids by
  default.
- Store construction uses resolved `databasePath`.
- Artifact, attachment, and session helpers stay under the resolved state root.

Daemon tests:

- `GET /config/effective` reports user and workspace path sources.
- `ling-stack doctor config` reports global registry and workspace state root.
- Run creation fails before runner start if state root is missing or unwritable.
- user-data-dir workspace can run when the repo path is read-only.
- Memory routes read and write from the resolved workspace DB.

Migration tests:

- repo-local migration copies DB and files to user-data-dir.
- user-data-dir migration copies DB and files back to repo-local.
- Failed migration leaves source state untouched.
- Migration manifest records source mode, target mode, workspace id, and copied paths.

Manual smoke:

```bash
corepack pnpm --filter @ling-stack/cli test -- --grep doctor
corepack pnpm --filter @ling-stack/core test -- --grep runtime-paths
sqlite3 .ling-stack/ling-stack.sqlite '.tables'
```

## Open Decisions

1. Whether Slice 3 should ship in the first implementation, or whether v1 should stop
   after registry plus resolver.
2. The exact `workspace_id` fingerprint fields and repair command UX for moved repos.
3. Whether global memory search summaries should exist in `global.sqlite`, and if so,
   which fields are safe to duplicate.
4. Whether desktop app backup should copy full workspace roots by default or only write
   manifests that point at state roots.

2026-06-18 implementation note: the first cut adds `resolveStoragePaths()`,
workspace storage identity, user `global.sqlite` paths, a SQLite
`workspaces_registry` store, `ling-stack init` registry writes, doctor config visibility,
and effective-config path projection. The second cut wires daemon default store
construction, bundled plugin cache materialization, managed channel and teammate
worktrees, Pi runner path projection, external-agent artifact import, and runtime lock
cleanup through resolved workspace paths. The third cut adds
`ling-stack init --workspace-state-location user-data-dir`, repo-local pointer config
discovery, global registry fallback discovery, daemon lifecycle path resolution, and
doctor config visibility for relocated state roots. `repo-local` remains the only
default. Runtime migration is handled by Slice 4 below.

2026-06-18 migration implementation note: Slice 4 adds
`ling-stack workspace migrate-state --to user-data-dir|repo-local`, manifest-backed
target replacement, repo-local pointer rewrite for relocated state, registry updates, and
CLI tests for both directions. The source state root is retained after success.

2026-06-18 diagnostics implementation note: `ling-stack doctor config` now includes
read-only checks for the global workspace registry row and workspace cwd writability.
It reports stale registry fields without repairing them and treats read-only cwd as ok
when `user-data-dir` state is selected.

2026-06-18 migration preflight implementation note: `ling-stack workspace migrate-state`
supports `--dry-run`, returning `canMigrate`, preview manifest/backup/staging paths, and
per-check diagnostics. Dry-run is read-only: it does not create target roots, manifests,
backups, staging directories, or registry rows.

2026-06-18 registry repair implementation note: `ling-stack workspace repair-registry`
and `ling-stack workspace registry repair` repair only the user-level registry row for
the current resolved workspace. `--dry-run` reports mismatches without writing.

2026-06-18 run startup guard implementation note: daemon run creation now preflights
the resolved workspace state root before startup warmup or store opening. `repo-local`
workspaces must have a writable cwd and writable runtime state directories; missing
repo-local state directories may be created for first-run compatibility. Explicit
`user-data-dir` workspaces do not require a writable repo cwd, but the selected user data
state root must already exist and be writable; missing user data roots block the run
instead of silently creating an empty workspace database.

2026-06-18 Markdown memory export implementation note: Slice 5 now has a read-only
Markdown projection builder, `ling-stack memory export`, and daemon
`GET|POST /memory/export`. Exports preserve source refs, review state, sensitivity,
latest decision confidence, tags, and self-improving metadata in per-memory JSON blocks.
`secret-adjacent` memories are skipped by default, and secret-like values in exported
text are redacted. The generated Markdown is a projection only; the resolved workspace
SQLite database remains authoritative.

2026-06-18 Markdown memory import implementation note: Slice 5 also adds
candidate-only Markdown import through `parseMemoryMarkdownImport()`, daemon
`POST /memory/import`, and `ling-stack memory import --file memory.md [--dry-run]`.
Import reads Ling memory Markdown projections back into the resolved workspace
database as new `reviewState: "candidate"` rows only. It does not reuse exported ids and
does not restore active, disabled, archived, rejected, retrieval, latest review decision,
or self-improving authority fields. Imported candidates keep normalized tags,
sourceRefs, sensitivity, and verify-before-use hints, and receive an extra
`type: "import"` sourceRef for traceability. `secret-adjacent` imports are disabled and
must be verified before use.

## Related

- [Two-Layer Configuration](two-layer-configuration.md)
- [Session Persistence](session-persistence.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Memory Health and Multi-Agent Memory Fan-In](memory-health-and-fanin.md)
- [Daemon lifecycle and doctor P0](daemon-lifecycle-p0.md)
