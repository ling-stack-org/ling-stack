# GStack Skill Source Sync

Status: Implementation-ready design
Date: 2026-06-22
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

## Definition Of Complete Embedding

For Ling, "complete gstack embedding" means source-faithful and governance-safe, not
vendoring the upstream runtime into this repository.

Complete embedding requires all of the following:

1. Registry coverage.
   Every supported upstream gstack skill has a Ling `SkillDefinition` or an explicit
   exclusion record with a reason. The existing `gstack-default` pack remains the default
   registry seed for workflow metadata.
2. Source preservation.
   A reviewed `SkillSourceSnapshot` stores the complete raw `SKILL.md` body, front matter,
   upstream name, upstream version, source checksum, warning evidence, and referenced file
   inventory for each published source-backed skill.
3. Drift detection.
   Ling can rescan configured local gstack/Codex skill roots, classify unchanged, changed,
   missing, new, dangerous, large, and orphaned sources, and show those results without
   mutating the executable registry.
4. Lazy runtime use.
   Full source text is loaded only after `selectedSkillId` is resolved and Effective Skill
   checks pass. Source text is added as bounded run context with truncation evidence.
5. UI and API visibility.
   Skill Library, source health, private teammate skill views, and run inspector surfaces
   show whether a skill is metadata-only, source-backed, stale, truncated, or warning-heavy.
6. Permission invariants.
   Source text never grants tools, MCP servers, credentials, browser access, deploy
   authority, external-send authority, memory authority, provider capability, or approval
   bypass. It can only inform the model after the existing policy gates allow the run.

This explicitly does not mean replaying gstack host hooks, auto-running upstream shell
blocks, or committing a local gstack checkout into Ling source control.

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

- built-in `gstack-default` skill metadata in `packages/core`, currently pinned to
  upstream taxonomy version `1.58.3.0`;
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

## MVP Decisions

The first implementation should make these decisions up front so the code does not leave
product policy to incidental parser behavior.

1. Scope.
   Source snapshots are workspace-scoped first. A user-global source cache can be added
   later, but workspace state must remain the authority for publish, review, and drift.
2. Source roots.
   Ling discovers from user-configured roots and detected Codex/gstack roots. Resolved
   absolute paths are local workspace state only, never public docs, templates, or bundled
   defaults.
3. Storage.
   Store raw `SKILL.md` in SQLite up to `MAX_SKILL_SOURCE_SNAPSHOT_BYTES`. If a source body
   is larger, block publish with `large_source` until a later artifact-backed storage slice
   exists.
4. Referenced files.
   MVP inventories `scripts/`, `assets/`, `references/`, and `agents/openai.yaml` by path,
   size, checksum, and kind. It does not execute scripts or store arbitrary referenced file
   contents. Future artifact import can selectively copy reviewed files.
5. `agents/openai.yaml`.
   MVP parses it for display metadata and invocation hints only. It does not create routing
   authority, tool grants, provider grants, or approval changes.
6. Publish shape.
   A source snapshot can be published only with an existing or newly normalized
   `SkillDefinition` in MVP. Reference-only snapshots stay draft or archived.
7. Drift review.
   MVP uses checksum diff, front matter diff, warning diff, and raw preview. Semantic diff
   and assisted migration can be added after the scanner and health loop are reliable.
8. Default pack compatibility.
   Existing `gstack-default` definitions remain stable. Source sync can attach snapshots to
   matching ids without changing teammate defaults, council membership, or channel
   bindings automatically.
9. Host behavior.
   Ling imports source instructions, not gstack host behavior. Host-specific steps become
   warnings unless Ling has a corresponding reviewed runtime capability.

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
    | "source_truncated"
    | "missing_metadata"
    | "drifted_upstream"
    | "missing_upstream"
    | "orphaned_snapshot";
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

Preview is read-only with respect to executable registry state:

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

Publish is the only operation that mutates source snapshot or registry state:

```text
POST /skills/sync/gstack/publish
  input: preview id, selected skill ids
  output:
    upserted registry entries
    upserted source snapshots
    control-plane invalidation events
```

Refresh recomputes source health without changing what can run:

```text
POST /skills/sync/gstack/refresh
  recompute drift against local source roots
  no registry mutation unless explicitly published
```

Existing `POST /skills/import-draft` remains valid for manual or one-off imports. The
gstack sync flow is the bulk, provenance-aware path.

### Preview Classification

The preview response should classify each discovered source:

| State | Meaning | Mutates registry? |
|-------|---------|-------------------|
| `attachable` | Matches an existing metadata skill id with no published snapshot. | No |
| `unchanged` | Published snapshot checksum matches local source. | No |
| `drifted` | Same skill id, different checksum or warnings. | No |
| `new` | Source has no matching Ling skill id. | No |
| `missing` | Published snapshot points at a source no longer present locally. | No |
| `blocked` | Source has publish-blocking warnings such as raw secret-like content. | No |
| `orphaned` | Snapshot exists for an archived or unknown skill id. | No |

Publish can then select `attachable`, `drifted`, or `new` records explicitly. `blocked`
records require editing the source or excluding the skill.

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

These surfaces must stay client-neutral. The web app, future desktop app, and CLI should
share daemon APIs and source-health state instead of embedding Web-only behavior.

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

## Implementation Slices

P0. Contracts and migration.
   Add `SkillSourceSnapshot`, source warnings, source health contracts, storage migration,
   and feature flag `skillSourceSnapshots`.

P1. Scanner and normalizer.
   Implement configured root discovery, `SKILL.md` front matter parsing,
   `agents/openai.yaml` display parsing, checksums, referenced file inventory, warning
   classification, and id matching against `gstack-default`.

P2. Preview, publish, and refresh APIs.
   Add read-only preview/refresh endpoints and explicit publish. Publish selected ids only,
   rechecks source bytes before write, and invalidates relevant read models.

P3. Lazy run context assembly.
   Load published source snapshots after Effective Skill passes, budget source text into
   runner context, record truncation evidence, and preserve existing permission checks.

P4. UI and health.
   Add Skill Library source viewer, sync preview, drift badges, source health findings,
   private teammate source state, and run inspector source metadata.

P5. Backfill and release hardening.
   Attach local gstack source snapshots to the existing built-in ids, document setup,
   add rollback controls, and verify no teammate/council/channel bindings change unless
   explicitly edited.

### Implementation Progress

- P0 foundation is implemented: contracts, SQLite source snapshot storage, source-health
  read APIs, API client methods, and focused storage/API tests.
- P1 scanner/normalizer is implemented in `packages/core/src/skill-source-sync.ts`:
  configured/detected root discovery, `SKILL.md` front matter parsing,
  `agents/openai.yaml` display metadata parsing, source checksums, referenced file
  inventory, warning classification, gstack id matching, and read-only preview
  classification. It does not publish snapshots or mutate teammate, council, or channel
  bindings.
- P2 sync APIs are implemented: `POST /skills/sync/gstack/preview`,
  `POST /skills/sync/gstack/refresh`, and `POST /skills/sync/gstack/publish`.
  Preview and refresh are read-only. Publish re-scans source bytes, requires explicit
  `selectedSkillIds`, rejects blocked/missing/orphaned records, and requires
  `allowNewSkills=true` before creating new registry skills.
- P3 lazy runtime context is implemented: published source snapshots are loaded only
  after the requested skill passes Effective Skill executable checks, raw `SKILL.md`
  text is added as bounded runner context, truncation/loading evidence is recorded in
  `skillSourceContext`, and both run snapshots and `run_created` events include the
  selected source snapshot id/checksum. Source text remains prompt context only and does
  not grant tools, credentials, deploy authority, provider capability, or approval bypass.
- P4 UI evidence is implemented for the shared Skill Library and run inspector surfaces:
  Skill Library loads source health, shows source-backed and missing-source summary counts,
  marks table rows as source-backed or metadata-only, exposes the published `SKILL.md`
  snapshot in the skill inspector, and provides a `Sync gstack source` panel for read-only
  preview/refresh plus explicit selected-id publish. The sync panel keeps new skills
  opt-in via `allowNewSkills` and leaves blocked/missing/orphaned records unselectable.
  Private teammate Skill settings show each bound or available skill's source-backed,
  metadata-only, drifted, missing-upstream, or warning state without exposing full source
  bodies. Run detail now shows the loaded `skillSourceContext` snapshot id, checksum,
  upstream path, truncation/loading state, warning count, and referenced files. Skill
  Library can archive a published source snapshot without deleting the registry skill,
  which makes runtime loading fall back to metadata-only until a later sync publish
  attaches a new reviewed snapshot.
  Drifted preview records now carry a compact field diff for checksum, upstream version,
  source path, source length, referenced files, warnings, front matter, and agent metadata;
  the Skill Library sync panel renders that diff inline without dumping the full source body.

Dependency order:

```text
P0 -> P1 -> P2 -> P3
       \           \
        -> P4 ------> P5
```

P3 depends on P2 because runtime loading must use published snapshots, not preview state.
P4 can start after P1/P2 contracts exist, but source health must not claim runtime loading
until P3 is shipped.

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

## Acceptance Criteria

1. Previewing the configured local gstack source root reports the discovered upstream
   version, which is `1.58.3.0` for the current local install and built-in pack, and
   classifies existing built-in ids as `attachable`, `unchanged`, or `drifted`.
2. Publishing a selected source-backed skill stores the complete raw `SKILL.md`, checksum,
   upstream metadata, warnings, and referenced file inventory.
3. Publishing a source snapshot does not change teammate skill bindings, Development
   Council membership, channel council attachments, or channel member state.
4. A run with a selected source-backed skill loads source only after Effective Skill
   executable checks pass.
5. A denied tool remains denied even if the loaded `SKILL.md` says to run the tool.
6. A source with raw secret-like content is blocked or quarantined before publish.
7. A large source over the configured byte cap is blocked with `large_source` until an
   artifact-backed storage path exists.
8. The sync preview shows deeper drift evidence for changed source snapshots without
   exposing the full `SKILL.md` body in the record list.
9. The run inspector shows source snapshot id, checksum, loaded/truncated state, and
   warning evidence for source-backed runs.
10. Refreshing drift health never mutates executable registry definitions.
11. Disabling the source-loading feature flag returns runtime behavior to existing
    prompt-fragment-only skill execution while leaving archived snapshots inert.

## Rollback Plan

- Disable `skillSourceSnapshots` to stop lazy source loading.
- Keep registry definitions and existing `gstack-default` metadata active.
- Leave stored snapshots inert for audit and future re-enable.
- Revert only the migration/API/UI slice if stored snapshots are corrupt; do not remove
  teammate bindings or council/channel memberships as part of rollback.

## Deferred Decisions

- Artifact-backed storage for large `SKILL.md` bodies and reviewed referenced-file
  contents.
- Assisted migration between upstream gstack versions beyond field-level drift evidence.
- User-global source cache with workspace overrides.
- Runtime support for specific reviewed helper scripts or assets.
- Remote marketplace, package-manager install, or automatic upstream upgrade.
