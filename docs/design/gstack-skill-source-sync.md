# GStack Skill Source Sync

Status: Design draft
Scope: Codex-style skill source snapshots, gstack skill sync, lazy skill loading,
and permission boundaries for full `SKILL.md` content

## Summary

Ling already has a durable skill registry and Effective Skill checks. The current
`SkillDefinition` model is intentionally lightweight: it records what a workflow is,
which roles it fits, which tools it may need, and which approval profile constrains it.

That is not enough to preserve the full behavior of a Codex or gstack skill. Codex treats
skills as file-backed instruction packs:

```text
startup
  -> discover skill index: name, description, path
  -> expose the index to the model
  -> when a skill matches, read its SKILL.md completely
  -> resolve relative scripts/assets only when needed
  -> execute under the host's current tools, sandbox, and approval policy
```

Ling should adopt the same shape, but keep Ling's stronger product boundaries:

```text
SkillDefinition
  lightweight registry metadata for routing, display, and Effective Skill checks

SkillSourceSnapshot
  reviewed source snapshot containing raw SKILL.md, optional agent metadata,
  checksums, upstream version, warnings, and referenced file inventory

Lazy Skill Load
  selected skill source is loaded into the run context only after the skill is selected

Runtime Permission Boundary
  source text cannot grant tools, MCP, credentials, deploy authority, external-send
  authority, memory authority, or approval bypass
```

## Goals

- Preserve full gstack `SKILL.md` content as reviewed source snapshots.
- Keep `SkillDefinition` small enough for registry listing, routing, and UI.
- Let Ling detect drift between the stored snapshot and local upstream gstack.
- Load full skill source lazily only for a selected skill/run.
- Keep all existing Effective Skill, approval, runner, tool, and state-machine gates.
- Support local gstack installs without vendoring gstack into Ling's public repo.
- Make stale, risky, unsupported, or authority-like skill content visible in health UI.

## Non-Goals

- No automatic execution of imported `SKILL.md` shell blocks.
- No automatic tool, MCP, browser, credential, provider, deploy, or external-send grant.
- No global marketplace, remote install, or package manager in this slice.
- No copying local gstack repo contents into Ling source control.
- No hidden mid-run prompt injection. Skill source is part of a run context view selected
  before execution or at an explicit continuation boundary.
- No attempt to emulate every host-specific gstack hook inside Ling.

## Current State

Ling has:

- built-in `gstack-default` skill metadata in `packages/core`;
- SQLite-backed skill registry entries and import drafts;
- reviewed `POST /skills/import-draft` and publish routes;
- teammate skill bindings;
- Effective Skill read models;
- run start validation for selected/requested skills;
- selected skill prompt fragments merged into the runtime request.

The gap:

- raw `SKILL.md` source is currently collapsed into bounded prompt fragments;
- source checksums, upstream versions, and related files are not retained;
- `agents/openai.yaml` style metadata is not modeled;
- gstack drift cannot be detected without re-reading local files manually;
- runtime cannot lazily attach complete source instructions to a selected skill.

## Source Discovery

Ling should discover local gstack skill sources from explicit, user-controlled roots.

Candidate roots, in priority order:

```text
workspace .agents/skills/
user-configured gstack repo root
user-configured Codex skill root
detected global Codex skill root
```

Discovery must not assume a personal absolute path. A local install can be symlinked,
vendored, or generated. The sync layer should persist resolved paths only in workspace
state, not in public docs or templates.

Supported source shapes:

```text
skill-name/
  SKILL.md
  agents/openai.yaml        optional
  scripts/                  optional
  assets/                   optional
  references/               optional
```

The sync scanner should read only metadata and bounded source previews during preview.
Large referenced files are inventoried by path, size, checksum, and type. Their full
content is loaded only when a later run context explicitly needs them.

## Data Model

`SkillDefinition` remains the executable registry contract:

```ts
interface SkillDefinition {
  id: string;
  name: string;
  summary: string;
  roleAffinity: AiTeammateRoleKey[];
  workflowPhase: SkillWorkflowPhase;
  promptFragments: string[];
  requiredTools: RunTool[];
  requiredProviderCapabilities: ProviderCapability[];
  approvalProfile: SkillApprovalProfile;
  stateEffects: SkillStateEffect[];
}
```

Add source snapshots as a separate provenance model:

```ts
type SkillSourceKind =
  | "gstack-skill-directory"
  | "codex-skill-directory"
  | "workspace-skill-directory"
  | "manual-markdown";

interface SkillSourceSnapshot {
  id: string;
  workspaceId: string;
  skillId: string;
  sourceKind: SkillSourceKind;
  sourcePath?: string;
  upstreamName?: string;
  upstreamVersion?: string;
  upstreamSkillPath?: string;
  sourceChecksum: string;
  rawSkillMarkdown: string;
  agentMetadata?: SkillAgentMetadata;
  referencedFiles: SkillSourceFileRef[];
  warnings: SkillSourceWarning[];
  reviewStatus: "draft" | "reviewed" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface SkillAgentMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  allowImplicitInvocation?: boolean;
}

interface SkillSourceFileRef {
  path: string;
  kind: "script" | "asset" | "reference" | "agent-metadata" | "other";
  checksum?: string;
  sizeBytes?: number;
  includedInSnapshot: boolean;
}

interface SkillSourceWarning {
  code:
    | "permission_like_instruction"
    | "secret_reference"
    | "external_send_claim"
    | "destructive_command"
    | "host_specific_tool"
    | "unsupported_tool"
    | "large_source"
    | "missing_metadata"
    | "drifted_upstream";
  severity: "info" | "warning" | "error";
  message: string;
  location?: string;
}
```

The key boundary is that `SkillSourceSnapshot` is evidence and prompt context. It is not
an authorization object.

## Normalization

Sync should produce both:

1. `SkillDefinition`, normalized for Ling.
2. `SkillSourceSnapshot`, preserving the upstream source.

Normalization rules:

- Parse front matter `name` and `description` from `SKILL.md`.
- Parse `agents/openai.yaml` when present for display metadata and invocation hints.
- Derive stable Ling ids by removing a `gstack-` prefix only for registry ids where that
  matches existing `gstack-default` ids.
- Preserve upstream names and paths in the source snapshot.
- Infer required tools conservatively from known workflow class and detected commands.
- Treat shell blocks, hook claims, MCP claims, external-send language, browser-cookie
  language, deploy language, and credential language as warnings or strict approval hints.
- Never infer approval bypass from source text.

## Sync Flow

Preview:

```text
POST /skills/sync/gstack/preview
  input: source root, optional include/exclude ids
  output:
    upstream version if available
    discovered skills
    new/changed/unchanged/missing records
    warnings
    normalized SkillDefinition previews
    SkillSourceSnapshot previews
```

Publish:

```text
POST /skills/sync/gstack/publish
  input: preview id, selected skill ids
  output:
    upserted registry entries
    upserted source snapshots
    control-plane invalidation events
```

Refresh:

```text
POST /skills/sync/gstack/refresh
  recompute drift against local source roots
  no registry mutation unless explicitly published
```

Existing `POST /skills/import-draft` remains valid for manual or one-off imports. The
gstack sync flow is the bulk, provenance-aware path.

## Storage Sketch

```sql
CREATE TABLE skill_source_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  upstream_name TEXT,
  upstream_version TEXT,
  upstream_skill_path TEXT,
  source_checksum TEXT NOT NULL,
  raw_skill_markdown TEXT NOT NULL,
  agent_metadata_json TEXT NOT NULL,
  referenced_files_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  review_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX skill_source_snapshots_skill_idx
  ON skill_source_snapshots (workspace_id, skill_id, review_status);
```

The table stores reviewed text snapshots, not executable scripts. Referenced scripts can
be inventoried without storing content in v1. A later artifact-import step can copy
specific referenced files into Ling-managed storage after review if runtime use requires
it.

## Runtime Lazy Loading

Run context assembly should follow this order:

```text
resolve selectedSkillId
  -> build Effective Skill
  -> verify executable
  -> load published SkillSourceSnapshot if present
  -> budget raw SKILL.md into a skill-source context section
  -> include agent metadata summary
  -> include referenced file inventory
  -> start runner with the same approval/tool policy as today
```

Budgeting:

- Full `SKILL.md` is preferred when it fits.
- If it does not fit, include front matter, routing/usage section, safety notes, step
  headings, and any explicit STOP/gate sections.
- Do not silently include large scripts or assets.
- Record truncation in run evidence.

This mirrors Codex's "read the skill after selection" behavior without making every
skill source global prompt context.

## Permission Boundary

The runtime must enforce this invariant:

```text
allowed actions =
  teammate allowed tools
  + channel policy
  + workspace approval policy
  + provider capability
  + runner capability
  + state-machine legality

skill source text is not part of this equation
```

If a source says "run this command", the model can request the command only through the
normal tool path. If policy says `bash=ask`, the command creates an approval. If policy
says `bash=deny`, the request is blocked.

If a source says "use this secret", the source should produce a warning and the runtime
must require an existing secret ref and approval path. Raw secrets in skill source should
be quarantined or blocked before publish.

## UI Surfaces

Settings `Skill Library`:

- show registry metadata and source snapshot side by side;
- show upstream version, checksum, last synced time, and drift state;
- show `SKILL.md` preview with warnings;
- show `agents/openai.yaml` metadata when present;
- show referenced file inventory;
- allow publish/archive of source snapshots separately from teammate bindings.

Private Workspace `Skills` tab:

- keep Effective Skill executable/blocked status as the primary run decision;
- show "source available", "source stale", or "metadata only";
- do not let binding a skill publish a source snapshot.

Run inspector:

- show selected skill id;
- show source snapshot id/checksum when loaded;
- show truncation and referenced-file evidence;
- show warnings that affected run context.

Health:

- `missing_source_snapshot`: registry skill has no raw source when it should.
- `drifted_source_snapshot`: local upstream checksum differs from published snapshot.
- `dangerous_source_warning`: source contains high-risk claims.
- `large_source_unbudgeted`: selected skill source was truncated.
- `orphaned_source_snapshot`: source exists for a missing or archived skill.

## API Sketch

```text
GET /skills/:id/source?cwd=...
GET /skills/source-health?cwd=...
POST /skills/sync/gstack/preview?cwd=...
POST /skills/sync/gstack/publish?cwd=...
POST /skills/sync/gstack/refresh?cwd=...
```

Preview and refresh are read-only with respect to active registry definitions. Publish is
the only sync action that mutates registry/source state.

## Rollout Plan

1. Documentation and contracts.
   Add source snapshot types, warnings, and API shape.

2. Storage and read APIs.
   Persist snapshots, list source health, expose source preview.

3. GStack preview scanner.
   Read local skill roots, parse `SKILL.md`, parse `agents/openai.yaml`, compute
   checksums, and report drift without mutation.

4. Publish flow.
   Upsert selected snapshots and normalized definitions through the reviewed registry
   path. Do not bind teammates automatically.

5. Lazy runtime context.
   Load published source for selected skills and add a bounded skill-source context
   section to run requests.

6. UI.
   Add Skill Library source viewer, sync preview, drift badges, and run inspector links.

7. Health and governance.
   Add source health findings and warnings to skill health.

## Test Plan

Core:

- snapshot checksum is stable;
- source warnings detect permission-like and secret-like content;
- source snapshot publish does not grant tools or bindings;
- drift detection separates unchanged, changed, missing, and new sources.

Daemon:

- preview sync is read-only;
- publish requires explicit selected ids;
- source APIs redact or block raw secrets;
- run start still rejects non-executable requested skills even when source exists.

Web:

- Skill Library can preview raw source and warnings;
- source drift is visible but does not mutate bindings;
- run inspector shows loaded snapshot metadata.

Runtime:

- selected skill loads source only after Effective Skill passes;
- denied tools remain denied even when source text asks for them;
- truncated source records evidence.

## Open Questions

- Should raw `SKILL.md` snapshots live in SQLite only, or should large source bodies be
  stored as Ling artifacts with SQLite metadata?
- Should gstack source sync be workspace-scoped or user-global with workspace overrides?
- Should a source snapshot be publishable without a normalized `SkillDefinition` when it
  is reference-only?
- How much of `agents/openai.yaml` should influence automatic routing versus UI display?
- Should Ling support source snapshot diff review before publish in v1, or only checksum
  and preview?
