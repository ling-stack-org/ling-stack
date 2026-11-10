# GStack Source Upgrade Lifecycle

Status: P6-P10 implemented
Date: 2026-06-22
Scope: first-run source onboarding, upstream drift upgrades, semantic migration
evidence, artifact-backed skill source storage, and Web/Desktop-neutral APIs

## Related Docs

- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [Managed Official Skill Source P16](managed-official-skill-source-p16.md)
- [External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md) —
  local shared `.agents/skills` adopts the same explicit-publish principles under a
  separate contract; it does not extend or relax this gstack lifecycle.

## Summary

Ling can now store reviewed gstack `SKILL.md` snapshots and load them lazily after
Effective Skill checks pass. The next problem is lifecycle: what happens when a user
installs Ling for the first time, when their local gstack install changes, or when a
skill source is too large to store inline.

The default answer must be conservative:

```text
Ling built-ins remain usable with metadata only
  -> local gstack is detected when present
  -> source preview is generated read-only
  -> drift and semantic risk are shown
  -> publish to runtime requires explicit confirmation
  -> rollback keeps prior published snapshots available
```

This design intentionally does not make Ling a silent gstack package manager. Ling may
detect, preview, and recommend upgrades. It must not silently mutate the user's global
gstack install or silently change the runtime behavior of the default Development
Council.

## Problem

Source-backed skills create three new lifecycle risks.

1. First install can be surprising.
   A new Ling user expects the built-in Development Council to work. If Ling requires a
   local gstack checkout before the default agents run, onboarding fails.
2. Upstream drift can change behavior.
   A new gstack `SKILL.md` can add approval gates, host-specific tool assumptions,
   external-send instructions, or destructive command language. Treating that as a
   simple checksum update makes the same built-in skill behave differently without user
   intent.
3. Full source is larger than `SKILL.md`.
   gstack skills may depend on `references/`, `scripts/`, `assets/`, and
   `agents/openai.yaml`. SQLite inline storage works for reviewed `SKILL.md` bodies, but
   not for large artifacts or reviewed helper material.

## Design Principles

- Built-in councils are always usable.
  Metadata-only `SkillDefinition` records remain the fallback for new installs and
  missing source.
- Source upgrades are workspace state.
  Published snapshots belong to a workspace and do not mutate the global gstack install.
- Preview is read-only.
  Detection, scanning, drift classification, and semantic diff generation must not change
  executable registry definitions.
- Publish is explicit.
  A new source snapshot affects runtime only after the user or a reviewed workspace policy
  publishes it.
- Global gstack upgrade is separate.
  Running `gstack upgrade` changes the user's tool installation. Ling may suggest or
  launch a guided flow, but must not do it silently.
- Source text is not authority.
  Neither upgraded source nor artifact content can grant tools, credentials, approvals,
  provider capabilities, external-send authority, deploy authority, or channel/council
  membership.
- Web and Desktop share daemon contracts.
  Upgrade lifecycle, source health, artifact refs, and publish policy live in daemon/core
  APIs, not Web-only state.

## Lifecycle Model

```text
Fresh Ling install
  -> seed gstack-default metadata
  -> create protected default Development Council
  -> detect local gstack roots
  -> if found: generate read-only source preview
  -> if safe: show "source available" upgrade prompt
  -> if confirmed: publish source snapshots

Later local gstack changes
  -> scheduled or manual read-only scan
  -> classify drift
  -> compute field diff + semantic diff
  -> show upgrade candidates
  -> publish selected snapshots after confirmation
  -> keep previous snapshots archived for rollback
```

### No Local GStack

If no local gstack install is found:

- built-in skills and the default Development Council still work from metadata;
- source health reports `metadata_only`;
- onboarding should show an optional `Connect gstack source` action;
- Ling should not install gstack automatically.

The user can still use default agents. The missing source affects instruction fidelity,
not base availability.

### Local GStack Present

If local gstack roots are detected:

- Ling can scan them automatically as a read-only operation;
- the first useful UI surface should show `Source available`;
- publishing snapshots remains a deliberate action;
- a workspace can remember that the user approved a specific source root, but not that
  all future versions can silently publish.

### Local GStack Updated

When local source differs from the published snapshot:

- health state becomes `drifted`;
- preview records include field-level diff and semantic diff;
- default councils and teammate bindings do not change;
- runs continue using the last published snapshot until a new one is published;
- publishing a newer snapshot records the prior snapshot as rollback evidence.

### Upstream Upgrade Discovery

There are three separate states that must not be collapsed:

1. A newer upstream gstack release exists.
2. The user's local gstack install or checkout has been updated.
3. Ling has published newer source snapshots into the workspace runtime.

`check-updates` may detect all three as read-only evidence. It can call local version
checkers, compare approved source roots with published snapshots, and report that a
global gstack upgrade is available. It must not run `gstack upgrade`, `git pull`, package
manager commands, or source publish operations.

If a global gstack upgrade is available, the UI should show a guided action that explains
the separation:

```text
gstack update available
Action 1: Open guided gstack upgrade
Action 2: Review Ling source snapshot changes after the upgrade
```

The guided upgrade can reuse the host's gstack upgrade workflow, but it remains
user-initiated. After the external upgrade completes, Ling performs another read-only
preview before any runtime source snapshot changes.

## Upgrade Policy

Add a workspace-scoped source upgrade policy. The default is `prompt`.

```ts
type SkillSourceUpgradeMode =
  | "manual"        // never background scan; user opens sync manually
  | "prompt"        // background scan allowed; publish requires confirmation
  | "auto-safe";    // publish only records with no semantic warnings

interface SkillSourceUpgradePolicy {
  workspaceId: string;
  mode: SkillSourceUpgradeMode;
  approvedRootIds: string[];
  allowNewSkills: boolean;
  allowGlobalGstackUpgrade: false;
  lastCheckedAt?: string;
}
```

`auto-safe` should not be the default. It is acceptable only for teams that explicitly
choose it, and even then it must refuse records with:

- new required tools;
- approval profile changes;
- external-send or deploy claims;
- destructive command warnings;
- raw secret-like content;
- missing or orphaned source state;
- new skills when `allowNewSkills=false`.

Global gstack upgrade remains out of policy by default. A future guided action can open a
separate `gstack-upgrade` workflow, but that must be user initiated.

## Semantic Diff

The current implementation reports field-level drift: checksum, upstream version, path,
source length, referenced files, warnings, front matter, and agent metadata. Semantic
diff adds a deterministic summary of behavior changes.

### Extracted Shape

```ts
interface SkillSourceSemanticProfile {
  sourceChecksum: string;
  title?: string;
  description?: string;
  sections: SkillSourceSection[];
  workflowVerbs: string[];
  stopGateCount: number;
  approvalGateClaims: string[];
  toolClaims: string[];
  hostClaims: string[];
  externalActionClaims: string[];
  destructiveClaims: string[];
  secretClaims: string[];
  referencedFileKinds: Record<SkillSourceFileKind, number>;
}

interface SkillSourceSemanticDiffItem {
  kind:
    | "copy_change"
    | "workflow_change"
    | "gate_change"
    | "tool_claim_change"
    | "host_claim_change"
    | "external_action_change"
    | "destructive_claim_change"
    | "secret_claim_change"
    | "referenced_file_change";
  severity: "info" | "warning" | "error";
  before?: string;
  after?: string;
  message: string;
}
```

This should be parser-first, not model-first. The first version can use headings,
front matter, fenced shell blocks, known approval vocabulary, host-specific keywords,
and existing warning classifiers. A model-generated explanation may be added later, but
it must be derived from stored semantic facts and cannot lower severity.

### Severity Rules

| Change | Default severity | Reason |
|--------|------------------|--------|
| Description or title only | `info` | Display/routing text changed. |
| Workflow section headings changed | `warning` | The steps a teammate follows may differ. |
| STOP or approval gate count changed | `warning` | Human-confirmation behavior may differ. |
| Tool or MCP claim changed | `warning` | Host capability assumptions may differ. |
| External-send/deploy/browser-cookie claim added | `warning` | Side-effect boundary changed. |
| Destructive command claim added | `error` | Publish should require source edit or override. |
| Raw secret-like content added | `error` | Publish blocked. |
| Referenced scripts/assets added | `warning` | Requires artifact review before runtime use. |

## Artifact-Backed Source Storage

Inline SQLite storage is enough for bounded `SKILL.md` snapshots. It is not enough for
large source bodies or reviewed referenced files.

Add a source artifact layer:

```ts
interface SkillSourceArtifact {
  id: string;
  workspaceId: string;
  snapshotId: string;
  path: string;
  kind: SkillSourceFileKind;
  checksum: string;
  sizeBytes: number;
  storageRef: string;
  mediaType?: string;
  reviewStatus: "draft" | "reviewed" | "published" | "archived";
  includedInRuntime: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Storage rules:

- artifacts are content-addressed by checksum;
- storage refs point to Ling-managed workspace data, not the upstream gstack path;
- `SKILL.md` can be inline or artifact-backed depending on size;
- referenced scripts are stored as evidence first, not executable code;
- runtime can include reviewed text references under a separate budget;
- scripts/assets require a later capability-specific design before execution or binary
  use.

This keeps the source snapshot durable even if the user deletes or upgrades their local
gstack checkout.

## API Surface

Extend the existing source sync APIs rather than adding Web-only flows.

```text
GET  /skills/source-upgrade-policy?cwd=...
PUT  /skills/source-upgrade-policy?cwd=...

POST /skills/sync/gstack/preview?cwd=...
  returns field diff + semantic diff + artifact inventory

POST /skills/sync/gstack/publish?cwd=...
  publishes selected snapshots and selected reviewed artifacts

POST /skills/sync/gstack/check-updates?cwd=...
  read-only background-safe scan; may report global upgrade availability

POST /skills/:id/source/rollback?cwd=...
  re-publishes a prior archived snapshot

GET  /skills/:id/source/artifacts?cwd=...
GET  /skills/source-artifacts/:artifactId/content?cwd=...
```

`check-updates` is a read-only convenience route for startup, scheduled checks, and
Desktop app menus. It must never publish.

## UI Surfaces

### First-Run Onboarding

Show one compact state in AI Teammates or Skill Library:

```text
Development Council
Source: metadata-only
Local gstack detected: yes
Action: Review source upgrade
```

Do not block council use. The action opens the same preview/publish panel used later.

### Upgrade Center

Skill Library should provide a source upgrade center:

- detected roots and upstream version;
- last checked time;
- summary counts: safe, drifted, blocked, missing, new;
- semantic risk filters;
- selected-id publish;
- rollback to previous snapshot;
- artifact review queue for large or referenced files.

### Run Inspector

Run detail should keep showing exactly which snapshot was loaded. After upgrades, old
runs should still point to the source snapshot they used.

### Desktop Compatibility

The Desktop app should call the same daemon routes. It may present native menus or
notifications, but it must not maintain a separate source-upgrade store.

## Default Council Behavior

The default Development Council uses the `gstack-default` metadata pack as its stable
identity. Source upgrades attach richer prompt context to existing skill ids. They do not
change:

- council id;
- teammate ids;
- teammate skill bindings;
- channel council attachment;
- channel members;
- workflow state-machine permissions.

Changing those requires a separate council-management action.

## Implementation Slices

P6. Upgrade policy and check route. Implemented.
   Add workspace policy storage, read-only `check-updates`, last checked evidence, and
   source upgrade summary state.

P7. Semantic profile and semantic diff. Implemented.
   Add deterministic semantic extraction, diff severity rules, tests for approval/tool/
   external-send/destructive/secret changes, and UI rendering in sync preview.

P8. Artifact-backed source storage. Implemented.
   Add source artifact contracts, storage migration, content-addressed blob writes,
   artifact list/content routes, and publish rules for reviewed referenced files.

P9. First-run and upgrade UX. Implemented for the shared Skill Library surface.
   Add a source upgrade center in Skill Library and rollback controls. Future
   Development Council, AI Teammates, and Desktop surfaces should reuse these daemon
   APIs instead of storing source-upgrade state locally.

P10. Optional guarded automation. Implemented.
   Add `auto-safe` workspace policy after P7 and P8 are stable. It can auto-publish only
   records with no warnings, no semantic risk, no new skills, and no artifact review
   requirement.

Implementation notes:

- The default Development Council remains metadata-first and source upgrades attach only
  reviewed source snapshots to existing skill ids.
- `check-updates` is read-only. It updates `lastCheckedAt` evidence but does not run
  `gstack upgrade`, `git pull`, package manager commands, or source publishing.
- Semantic summaries are deterministic and parser-first. No model-written explanation is
  used to lower severity.
- Source artifacts use the dedicated `skill_source_artifacts` namespace under Ling-managed
  workspace artifact storage.
- Source roots carry stable ids such as `local-gstack` or path-hashed configured root ids.
  `auto-safe` publish refuses records whose root id is not approved in workspace policy.
- Rollback re-publishes the selected archived snapshot id, preserving artifact links.
- The current Web implementation lives in Skill Library settings. Desktop and future AI
  Teammates surfaces should call the same daemon APIs rather than adding another store.

## Acceptance Criteria

1. A fresh Ling install works without local gstack source.
2. If local gstack exists, Ling can detect and preview source without publishing.
3. A gstack version/source change marks affected snapshots drifted without changing
   runtime behavior.
4. A newer global gstack release is reported as user-initiated guidance, not as an
   automatic `gstack upgrade`, `git pull`, or source publish.
5. Semantic diff flags workflow, gate, tool, host, external-send, destructive, and secret
   changes with deterministic severities.
6. Publishing an upgrade requires selected ids and records the prior snapshot for
   rollback.
7. Large `SKILL.md` bodies and referenced files can be stored as Ling-managed artifacts
   without copying upstream paths into public repo state.
8. Artifact content is evidence until reviewed. Scripts/assets are not executable by
   virtue of being stored.
9. The default Development Council keeps stable membership and bindings across source
   upgrades.
10. Web and Desktop can implement the same flow through daemon APIs.
11. No flow silently upgrades the user's global gstack install.

## Test Plan

Core:

- policy defaults to `prompt`;
- `check-updates` is read-only;
- global upgrade availability is reported without running upgrade commands;
- semantic diff classifies each risk category;
- artifact-backed snapshots survive local source deletion;
- rollback re-publishes the selected previous snapshot.

Daemon:

- policy routes persist workspace state;
- update checks do not mutate registry or snapshots;
- publish selected ids only;
- artifact content routes enforce workspace and review status;
- rollback emits source health invalidation.

Web:

- first-run council remains usable in metadata-only state;
- local source detected state opens preview;
- semantic risk filters work;
- artifact review queue shows size/checksum/path;
- rollback updates source status without changing teammate/council/channel bindings.

Desktop:

- native shell can call the same daemon APIs;
- no Desktop-only source state is required.

## Rollback Plan

- Disable background `check-updates` scheduler.
- Keep existing published source snapshots active.
- Archive newly published snapshots and re-publish prior snapshots by id.
- Leave artifact blobs inert for audit; do not delete them during rollback.
- Keep `gstack-default` metadata-only execution available as the safe fallback.

## Open Decisions

- Whether `auto-safe` should graduate from an advanced setting to a broader first-run
  recommendation after several manual upgrade cycles.
- Whether optional model-written semantic explanations are useful as display-only copy on
  top of deterministic facts.
- How much of `references/` can be included in runtime context before a separate context
  budget manager is required.
