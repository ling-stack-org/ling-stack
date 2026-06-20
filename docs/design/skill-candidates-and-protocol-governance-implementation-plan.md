# Skill Candidates And Protocol Governance Implementation Plan

Status: Implementation breakdown; Skill Health, manual SkillCandidate review,
candidate-to-draft flow, channel protocol candidate alias, and structured
ProcedureObservation observe route implemented
Date: 2026-06-20
Source design: [Skill Candidates And Protocol Governance](skill-candidates-and-protocol-governance.md)

## Purpose

This plan breaks reusable workflow governance into small, reviewable slices.

The goal is to let Ling observe repeated procedures, surface candidate skills and channel
protocols, and diagnose skill health without turning the Skill Registry into an
uncontrolled generated-skill pile.

The implementation must preserve this data flow:

```text
run / message / workflow output
  -> ProcedureObservation
  -> router
  -> candidate
  -> review
  -> optional registry draft / channel protocol
  -> existing execution and approval gates
```

It must not become:

```text
run transcript
  -> generated active skill
  -> automatic teammate binding
  -> bypassed approval / tool / provider checks
```

## Guardrails

- No generated skill is published automatically.
- Built-in and externally imported skills are never rewritten automatically.
- Generated skills cannot grant tools, approvals, provider access, secrets, memory scope,
  external-send authority, or deploy authority.
- `ProcedureObservation` is persisted before any destination-specific candidate.
- Weak signals append evidence; they do not create review noise by default.
- Duplicate/conflict checks block publication.
- Channel protocol rules render as coordination context only.
- Skill health is read-only until a route explicitly performs a review action.
- Desktop and future PC app clients must consume the same daemon contracts and API client
  as Web.

## Existing Surfaces To Reuse

Core:

```text
packages/core/src/skill-types.ts
packages/core/src/builtin-skill-packs.ts
packages/core/src/effective-skills.ts
packages/core/src/storage/sqlite/skill-registry-store.ts
packages/core/src/memory-health.ts
packages/core/src/run-types.ts
```

Contracts and client:

```text
packages/contracts/src/skills.ts
packages/contracts/src/index.ts
packages/api-client/src/endpoints/skills.ts
packages/api-client/src/client.ts
```

Daemon:

```text
packages/daemon/src/features/skills/*
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/src/features/channels/workflow-fanin.ts
packages/daemon/src/server/router.ts
```

Web:

```text
apps/web/src/api/skills.ts
apps/web/src/features/teammates/*
apps/web/e2e/support/mock-daemon.ts
```

Reference patterns:

```text
packages/core/src/memory-health.ts
packages/daemon/src/features/memory/routes.ts
apps/web/src/features/teammates/*
docs/design/memory-health-and-fanin-implementation-plan.md
docs/design/contracts-api-client.md
docs/design/desktop-shell.md
```

## Platform And PC App Compatibility

Treat the future PC/Desktop app as a first-class client from the first slice.

Desktop should not need a separate candidate store, duplicate classifier, or skill health
model. It should reuse:

- `packages/contracts` for DTOs;
- `packages/api-client` for daemon calls;
- daemon routes for all mutations and read models;
- shared review state names and reason codes;
- source refs that can open a route or detail panel in Web or Desktop.

Do:

- add all public DTOs to `packages/contracts`;
- add client helpers to `packages/api-client`;
- keep Web wrappers thin over the shared client;
- use route-friendly ids and `sourceRefs`;
- return enough structured state for Web, Desktop, CLI, and future TUI to render without
  parsing prose;
- keep file paths and local actions behind daemon validation;
- ensure errors use stable `error` and `message` fields.

Do not:

- put Web-only form state in shared contracts;
- let Web own daemon wire shapes for the new module;
- let Desktop call SQLite or core stores directly;
- rely on browser-only APIs for review state or source refs;
- require Electron/Tauri to interpret raw run transcripts;
- expose secret values, raw Node APIs, or shell execution through a desktop renderer.

Compatibility target:

```text
apps/web
apps/desktop
packages/cli
  -> packages/api-client
  -> packages/contracts
  -> packages/daemon
  -> packages/core storage/read models
```

## Recommended First Cut

The first useful cut is read-only Skill Health.

Include:

- SG.0 baseline verification;
- SG.1 contracts and core types;
- SG.2 duplicate/conflict classifier;
- SG.3 `buildSkillHealthReport`;
- SG.4 `GET /skills/health`;
- SG.5 minimal Web health panel.

Exclude:

- candidate persistence;
- observation jobs;
- channel protocol canvas;
- registry draft publication from candidates;
- generated skill usage telemetry;
- embedding-based similarity.

Reason:

- It answers the biggest product risk first: duplicate and conflicting skills.
- It is behavior-preserving.

Implemented in this slice:

- health-focused DTO subset in `packages/contracts/src/skills.ts`;
- `packages/core/src/skill-health.ts`;
- `LingDaemonClient.getSkillHealth`;
- `apps/web/src/api/skills.ts` thin wrapper;
- daemon `GET /skills/health`;
- minimal Web Skill Health panel in Settings > Skill Library;
- core, API client, daemon integration, and settings e2e tests.
- durable `SkillCandidate` core types, SQLite store, migration, and RunStore facet;
- shared candidate DTOs in `packages/contracts/src/skills.ts`;
- `LingDaemonClient` candidate list/get/create/review helpers;
- `LingDaemonClient.createSkillCandidateDraft`;
- daemon `GET/POST /skill-candidates`, `GET/POST /skill-candidates/:id/review`,
  and `POST /skill-candidates/:id/draft`;
- candidate health integration, duplicate analysis at create time, review audit records,
  and approval gate checks for negative triggers, validation steps, and critical findings.
- candidate-to-import-draft generation for `approved_for_draft` candidates, while publish
  remains the existing separate import draft action.
- Web Candidate Review panel in Settings > Skill Library, with candidate review actions
  and draft creation wired through the shared daemon client.
- Web/Desktop now have stable shared read and mutation contracts before automated
  observation flows exist.
- structured `ProcedureObservation` contracts, conservative candidate router, SQLite
  store/migration, RunStore facet, shared API client helpers, daemon
  `GET/POST /procedure-observations`, daemon `POST /procedure-observations/jobs`, and
  daemon `POST /skill-candidates/observe`;
- observe route persists observation first, creates a pending `SkillCandidate` only for
  unblocked skill routes with `no_overlap`, and returns `evidence_recorded` or `blocked`
  for duplicate/conflicting or authority-changing observations.
- observation job route computes an idempotent `jobKey`, reuses an existing observation
  for repeated job keys, and only creates pending candidates for explicit/user-confirmed
  save or recording signals.
- event-first skill usage telemetry with SQLite storage, RunStore facet, shared
  contracts/API client helpers, daemon `GET /skills/usage-events`, daemon
  `GET /skills/usage-stats`, and daemon `POST /skills/:id/corrections`;
- run lifecycle, candidate draft creation, import draft publication, and manual
  correction events feed Skill Health findings for never-used generated skills, high
  failure rates, and repeated corrections.
- `ProcedureObservationCluster` read model in core storage and RunStore, with shared
  contracts/API client helpers plus daemon `GET /procedure-observation-clusters` and
  `GET /procedure-observation-clusters/:id`;
- `playbook` route kind for channel-scoped workflow output procedures that should stay
  local to a channel/project before any skill promotion review;
- read-only Channel Protocol Canvas API at `GET /channels/:id/protocol/canvas`, returning
  the effective protocol, protocol draft candidates, channel-scoped protocol/playbook
  clusters, and compact section summaries;
- manual cluster-to-protocol candidate API at
  `POST /channels/:id/protocol-candidates/from-cluster/:clusterId` for same-channel
  ready `channel_protocol` clusters only;
- Settings > Skill Library shows candidate clusters and exposes manual protocol-candidate
  creation only for ready same-channel `channel_protocol` clusters.
- channel-local playbook candidate table, RunStore facet, shared contracts/API client
  helpers, daemon list/from-cluster/review routes under
  `/channels/:id/playbook-candidates`, and Settings > Skill Library manual playbook
  candidate creation for ready same-channel `playbook` clusters.
- Settings > Skill Library playbook candidate review panel lists channel-local candidates,
  shows steps, validation checks, positive/negative triggers, source refs, and review
  reason, and supports approve/reject for draft playbook candidates.

Still not implemented:

- automatic post-run observation hooks; this document now defines the next implementation
  slice, but no code has landed for it yet;
- native Desktop candidate review UI;
- direct candidate-to-registry publish without the import draft review step;
- transcript-derived or post-run automatic candidate creation for channel protocol or
  playbook destinations; next-slice generation must go through bounded observations,
  cluster dedupe, and review candidates only;
- dedicated Web channel protocol candidate queue beyond the existing protocol draft
  surface and Settings cluster action;
- automatic correction-to-update-candidate generation;
- superseded active generated skill automation beyond the reserved `superseded` event kind.

## Phase SG.0: Baseline Verification

Type: read-only preparation.

Tasks:

- Confirm current skill registry routes and tests pass.
- Confirm built-in skills are projected from code and not duplicated into SQLite.
- Confirm run start still validates `requestedSkillId` through Effective Skill checks.
- Confirm Web and API client already expose Skill Registry list/archive paths.

Commands:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test -- channel-workspace
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

Exit criteria:

- Existing skill registry behavior is understood.
- No schema migration is started before baseline results are known.

## Phase SG.1: Contracts And Core Types

Type: additive types only.

Files:

```text
packages/contracts/src/skills.ts
packages/contracts/src/index.ts
packages/core/src/skill-health.ts
packages/core/src/index.ts
```

Add:

```ts
export type SkillGovernanceSeverity = "info" | "warning" | "critical";

export type SkillDuplicateDecision =
  | "no_overlap"
  | "append_evidence"
  | "update_existing"
  | "conflict_review"
  | "reject_duplicate";

export interface SkillDuplicateAnalysis {
  readonly decision: SkillDuplicateDecision;
  readonly similarityScore: number;
  readonly matchedSkillIds: readonly string[];
  readonly matchedCandidateIds: readonly string[];
  readonly triggerOverlap: readonly string[];
  readonly conflictingFields: readonly string[];
  readonly rationale: string;
}

export type SkillHealthFindingKind =
  | "duplicate_clusters"
  | "conflicting_triggers"
  | "shadowed_skill"
  | "never_used_skill"
  | "stale_candidate"
  | "high_failure_rate_skill"
  | "high_user_correction_skill"
  | "external_overlap_generated_skill"
  | "superseded_but_active"
  | "missing_validation_steps"
  | "missing_negative_triggers";

export interface SkillHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: SkillHealthSummary;
  readonly findings: readonly SkillHealthFinding[];
}
```

Do not:

- add persistence yet;
- add route handlers yet;
- add Web-only fields to shared contracts.

Tests:

- Type export smoke test if needed.
- Existing package builds still pass.

Exit criteria:

- Shared DTOs can be imported by Web, Desktop, CLI, daemon tests, and core tests without
  circular dependencies.

## Phase SG.2: Duplicate And Conflict Classifier

Type: pure core logic.

Files:

```text
packages/core/src/skill-health.ts
packages/core/src/skill-signatures.ts
packages/core/test/skill-health.test.mjs
```

Inputs:

```ts
interface AnalyzeSkillDuplicateInput {
  readonly candidate: SkillCandidateLike;
  readonly activeSkills: readonly SkillRegistryEntry[];
  readonly pendingCandidates?: readonly SkillCandidateLike[];
}
```

Start with deterministic lexical logic:

- normalize title, summary, positive triggers, workflow phase, required tools, and step
  titles;
- identity duplicate by id/title/checksum;
- trigger duplicate by overlapping normalized trigger tokens;
- procedure duplicate by normalized goal, phase, required tools, and procedure step titles;
- scope conflict by same trigger cluster with incompatible tool, approval, provider, or
  validation expectations.

Persist or recompute two signatures:

```ts
interface SkillSignatureSet {
  readonly identitySignature: string;
  readonly procedureSignature: string;
  readonly triggerSignature: string;
  readonly scopeSignature: string;
}
```

`identitySignature` should use canonical title plus source kind and source path/checksum
when present. `procedureSignature` should use normalized goal, trigger set, non-trigger
set, ordered step titles, required tool set, validation checks, and scope tuple. Review
UIs and health findings should display the matched signature reason instead of exposing a
bare numeric similarity.

Thresholds:

```text
>= 0.85  -> append_evidence / update_existing
0.65-0.85 -> conflict_review
< 0.65 -> no_overlap or create candidate allowed
```

Do not:

- call a model;
- require embeddings;
- treat similarity as publication approval;
- compare hidden prompt fragments as the primary signal.

Tests:

- exact duplicate returns `reject_duplicate` or `update_existing`;
- duplicate `procedureSignature` appends evidence to the existing candidate instead of
  creating a second pending candidate;
- trigger overlap returns `conflict_review`;
- same procedure with renamed title returns high similarity;
- same title but different procedure produces conflict, not automatic merge;
- builtin/external source match blocks direct mutation.

Exit criteria:

- The classifier is deterministic and stable enough for health findings and publish
  blockers.

## Phase SG.3: Skill Health Engine

Type: read-only core report.

Files:

```text
packages/core/src/skill-health.ts
packages/core/src/index.ts
packages/core/test/skill-health.test.mjs
```

Add:

```ts
interface BuildSkillHealthReportInput {
  readonly workspaceId: string;
  readonly skills: readonly SkillRegistryEntry[];
  readonly candidates?: readonly SkillCandidateLike[];
  readonly generatedAt: string;
  readonly staleCandidateDays?: number;
  readonly limit?: number;
}
```

First findings:

- `duplicate_clusters`
- `conflicting_triggers`
- `shadowed_skill`
- `stale_candidate`
- `missing_validation_steps`
- `missing_negative_triggers`
- `external_overlap_generated_skill`

Later findings:

- `never_used_skill`
- `high_failure_rate_skill`
- `high_user_correction_skill`
- `superseded_but_active`

Implementation detail:

- Use deterministic finding ids from kind + related skill/candidate ids.
- Sort by severity, kind, and id.
- Mark findings as `critical` only when they block publish or active runtime selection.
- Keep report read-only.

Tests:

- one test per first finding kind;
- report summary counts;
- deterministic ordering;
- limit behavior.

Exit criteria:

- Health report can be produced from current Skill Registry entries without new tables.

## Phase SG.4: `GET /skills/health`

Type: read-only daemon/API-client route.

Files:

```text
packages/contracts/src/skills.ts
packages/api-client/src/endpoints/skills.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/server/router.ts
packages/daemon/test/channel-workspace.test.mjs
apps/web/src/api/skills.ts
```

Route:

```http
GET /skills/health?cwd=/path/to/workspace
GET /skills/health?cwd=/path/to/workspace&limit=50
```

Behavior:

- Resolve store from `cwd`.
- Load effective registry entries through the same route source as `GET /skills`.
- Build health report.
- Return structured findings and summary.

Do not:

- create candidates;
- publish drafts;
- archive skills;
- mutate review state.

Tests:

- missing `cwd` behavior matches existing skills routes;
- method-not-allowed for mutation verbs;
- built-in skills appear in summary;
- archived skills are excluded unless a later request flag explicitly includes them;
- response uses shared contract shape.

Exit criteria:

- Web/Desktop/CLI clients can fetch a read-only skill health report through the shared
  daemon API.

## Phase SG.5: Minimal Web Health Surface

Type: read-only UI.
Status: implemented for Settings > Skill Library on 2026-06-20.

Files:

```text
apps/web/src/api/skills.ts
apps/web/src/features/teammates/*
apps/web/src/styles/teammates.css
apps/web/e2e/support/mock-daemon.ts
apps/web/e2e/teammates.spec.ts
```

Surface:

- Add a compact Skill Health panel near the existing Skills or AI Teammates surface.
- Show summary counts.
- Show top findings with severity, related skill ids, and recommended action.
- Deep-link to existing skill registry rows where possible.

Do not:

- add mutation actions;
- add a new full-screen workbench;
- show generated-skill marketing language.

Tests:

- mock daemon returns findings and panel renders them;
- empty health report renders a stable empty state;
- critical finding uses visible severity treatment;
- no horizontal overflow at desktop and narrower widths.

Exit criteria:

- User can see why generated skill work is blocked before any candidate mutation exists.

## Phase SG.6: Candidate Persistence

Status: Implemented for manual `SkillCandidate` persistence; `ProcedureObservation`
storage is deferred.

Type: additive SQLite tables and core APIs.

Files:

```text
packages/core/src/skill-candidate-types.ts
packages/core/src/storage/sqlite/skill-candidate-store.ts
packages/core/src/storage/sqlite-run-store.ts
packages/core/src/storage/sqlite/migrations.ts
packages/core/test/skill-candidate-store.test.mjs
```

Tables:

```sql
CREATE TABLE IF NOT EXISTS procedure_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT,
  teammate_id TEXT,
  task_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  normalized_goal TEXT NOT NULL,
  positive_triggers_json TEXT NOT NULL,
  negative_triggers_json TEXT NOT NULL,
  procedure_steps_json TEXT NOT NULL,
  validation_steps_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  target_skill_id TEXT,
  proposed_action TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  duplicate_analysis_json TEXT NOT NULL,
  safety_findings_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  review_notes_json TEXT NOT NULL,
  expires_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_candidate_review_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

Implemented table subset:

- `skill_candidates`;
- `skill_candidate_review_records`.

Deferred table:

- `procedure_observations`, because this slice intentionally does not run observation
  jobs or infer candidates from transcripts.

Validation:

- `positiveTriggers` and `negativeTriggers` must be non-empty before publish eligibility.
- `validationSteps` must be non-empty before publish eligibility.
- `sourceRefs` must be present.
- status transitions must be explicit.
- `supersededBy` cannot point to the same candidate.

Do not:

- convert candidates into registry drafts in this phase;
- run observation jobs;
- mutate built-in or external skill files.

Tests:

- create/list/get candidate;
- review status transition;
- reject invalid transitions;
- reject draft approval when negative triggers, validation steps, or critical safety
  gates fail;
- migration idempotency.

Exit criteria:

- Manual candidate review can be built on durable state.

## Phase SG.7: Candidate APIs And Manual Review

Status: Implemented for direct manual candidate create/list/get/review; observe route and
router are deferred.

Type: daemon/API-client mutation routes.

Files:

```text
packages/contracts/src/skills.ts
packages/api-client/src/endpoints/skills.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/server/routes.ts
packages/daemon/src/server/router.ts
packages/daemon/test/channel-workspace.test.mjs
```

Routes:

```http
GET /skill-candidates?cwd=/path/to/workspace&status=pending
GET /skill-candidates/:id?cwd=/path/to/workspace
POST /skill-candidates?cwd=/path/to/workspace
POST /skill-candidates/:id/review?cwd=/path/to/workspace
POST /skill-candidates/:id/draft?cwd=/path/to/workspace
```

Behavior:

- `POST /skill-candidates` accepts explicit manual candidate JSON only.
- Public review routes force `actor: "user"`; clients cannot submit `system` actor.
- Duplicate classifier runs before candidate creation when the client did not provide
  duplicate analysis.
- Review actions are auditable.
- `GET /skills/health` includes durable candidates in its read-only findings.
- `POST /skill-candidates/:id/draft` creates a normal `SkillImportDraft` only when the
  candidate is `approved_for_draft`.
- Draft creation is blocked for duplicate decisions that require update, conflict, or
  duplicate rejection review.

Do not:

- accept raw transcript blobs;
- auto-publish;
- allow `system` actor from public HTTP routes;
- allow permission expansion through candidate text.
- infer candidate creation from live runs in this phase.

Tests:

- explicit manual request creates pending candidate;
- list/detail routes expose candidate and review records;
- review action records previous and next status;
- missing negative triggers block draft approval;
- pending candidates cannot create drafts;
- duplicate-conflict candidates cannot create drafts;
- approved candidates create import drafts that can still be published only through the
  existing import draft publish endpoint;
- health includes durable candidate findings.

Exit criteria:

- A user can manually save a reusable procedure as a pending candidate, review it,
  create a registry import draft, and leave final publication to the existing draft gate.

## Phase SG.8: Channel Protocol Canvas

Status: Implemented as a governance API alias over existing channel protocol drafts plus
a read-only Channel Protocol Canvas read model. Automatic observation-to-protocol-draft
creation and an explicit pending-candidate channel UI remain deferred.

Type: channel governance API alias and read-only canvas over existing protocol, draft,
and observation-cluster models.

Files:

```text
packages/contracts/src/skills.ts
packages/contracts/src/channels.ts
packages/core/src/procedure-observation-types.ts
packages/core/src/storage/sqlite/procedure-observation-store.ts
packages/api-client/src/endpoints/channels.ts
packages/api-client/src/endpoints/skills.ts
packages/daemon/src/features/channels/collaboration-protocol.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/server/routes.ts
apps/web/src/features/settings/SkillLibrarySettingsPanel.tsx
packages/daemon/test/channel-workspace.test.mjs
```

Existing storage:

```text
channel_collaboration_protocols
channel_collaboration_protocol_drafts
procedure_observations
```

Do not add a second `channel_protocol_candidates` table in this slice.
`ChannelCollaborationProtocolDraft` is already the channel protocol candidate model:
it has source refs, status, base version, proposed patch, and apply/cancel review state.
Do not add a separate cluster table. `ProcedureObservationCluster` is a read model over
existing `procedure_observations` rows.

Routes:

```http
GET /channels/:id/protocol-candidates?cwd=/path/to/workspace
POST /channels/:id/protocol-candidates?cwd=/path/to/workspace
POST /channels/:id/protocol-candidates/from-cluster/:clusterId?cwd=/path/to/workspace
POST /channels/:id/protocol-candidates/:candidateId/review?cwd=/path/to/workspace
GET /channels/:id/protocol?cwd=/path/to/workspace
GET /channels/:id/protocol/canvas?cwd=/path/to/workspace&limit=50
GET /channels/:id/playbook-candidates?cwd=/path/to/workspace&status=draft&limit=50
POST /channels/:id/playbook-candidates/from-cluster/:clusterId?cwd=/path/to/workspace
POST /channels/:id/playbook-candidates/:candidateId/review?cwd=/path/to/workspace
GET /procedure-observation-clusters?cwd=/path/to/workspace&channelId=channel_...&routeKind=playbook&status=ready_for_review
GET /procedure-observation-clusters/:id?cwd=/path/to/workspace
```

Behavior:

- `GET/POST /protocol-candidates` map to existing protocol draft list/create behavior.
- `POST /protocol-candidates/from-cluster/:clusterId` manually creates a protocol draft
  from a same-channel `ready_for_review` `channel_protocol` cluster; non-protocol,
  blocked, and cross-channel clusters are rejected.
- review `approve` applies the protocol draft.
- review `reject` marks the draft `cancelled`.
- `GET /protocol/canvas` returns effective protocol state, protocol draft candidates,
  channel-scoped protocol/playbook clusters, and compact canvas sections.
- `GET /playbook-candidates` lists channel-local playbook candidates by status.
- `POST /playbook-candidates/from-cluster/:clusterId` creates a channel-local playbook
  candidate from a same-channel `ready_for_review` `playbook` cluster; non-playbook,
  blocked, and cross-channel clusters are rejected.
- playbook candidate review `approve` marks the candidate `active`; review `reject`
  marks it `cancelled`. Approval does not publish a Skill, write Memory, or grant
  authority.
- Settings > Skill Library can review playbook candidates after they are created by the
  cluster action or any other manual caller of the same API.
- `ProcedureObservationCluster` groups observations by deterministic `clusterId` and
  recommends review actions such as `create_channel_protocol_candidate`,
  `create_playbook_candidate`, or `append_evidence`.
- `playbook` is channel/project-local procedure evidence, not a global skill.
- Protocol candidates cover role division, handoff rules, review rules, default workflow,
  communication norms, and artifact policy.
- Active protocols render into channel context.
- Protocols never grant authority.

Do not:

- mix protocol candidates into memory promotion inbox in the first slice;
- convert every protocol into a skill;
- add external-send behavior.

Tests:

- create/list protocol candidate through the alias route;
- reject candidate without changing the active protocol;
- approve candidate and render as active protocol override;
- create a channel-scoped workflow-step observation and list its playbook cluster;
- create a channel protocol observation cluster, manually convert it into a protocol
  candidate, and reject playbook cluster conversion through the protocol endpoint;
- click the Settings > Skill Library cluster action and verify it creates a protocol
  draft candidate through the shared API client;
- canvas response includes protocol/playbook clusters and section summaries;
- source refs visible in API response;
- existing Context protocol panel continues to show active protocol state.

Exit criteria:

- Channels can own reviewed collaboration rules without polluting the skill registry.

## Phase SG.9: Observation Jobs

Status: Implemented for structured manual observations, conservative routing,
`POST /skill-candidates/observe`, and explicit/idempotent `POST
/procedure-observations/jobs`, including channel-scoped `playbook` routing. Automatic
post-run hooks and transcript-derived generation remain deferred.

Type: conservative semi-automation.

Files:

```text
packages/contracts/src/skills.ts
packages/core/src/procedure-observation-types.ts
packages/core/src/candidate-router.ts
packages/core/src/storage/sqlite/procedure-observation-store.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/features/skills/schemas.ts
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/src/features/channels/workflow-fanin.ts
packages/daemon/test/channel-workspace.test.mjs
```

Initial signal lanes:

- manual observation through `POST /procedure-observations`;
- explicit post-run save phrases such as "save as skill/protocol";
- user-approved recording sessions;
- repeated pattern evidence from structured run metadata;
- user corrections with repeatable procedure shape;
- multi-agent handoff stabilization for channel protocol candidates.

Add contracts:

```ts
interface ProcedureObservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly clusterId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly ProcedureStep[];
  readonly validationSteps: readonly ProcedureValidationStep[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly confidence: "low" | "medium" | "high";
  readonly reusableScore: number;
  readonly createdAt: string;
}

type CandidateRouteKind =
  | "memory"
  | "channel_protocol"
  | "automation"
  | "skill"
  | "approval_policy_review"
  | "reject";
```

Add durable tables:

```sql
CREATE TABLE IF NOT EXISTS procedure_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  channel_id TEXT,
  teammate_id TEXT,
  task_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  normalized_goal TEXT NOT NULL,
  positive_triggers_json TEXT NOT NULL,
  negative_triggers_json TEXT NOT NULL,
  procedure_steps_json TEXT NOT NULL,
  validation_steps_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reusable_score REAL NOT NULL,
  route_kind TEXT,
  route_reason_code TEXT,
  route_blockers_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_procedure_observations_cluster
  ON procedure_observations(workspace_id, cluster_id, created_at);
```

Routes:

```http
GET /procedure-observations?cwd=/path/to/workspace&clusterId=...&limit=50
POST /procedure-observations?cwd=/path/to/workspace
POST /skill-candidates/observe?cwd=/path/to/workspace
```

`POST /procedure-observations` is the explicit/manual path. It persists a bounded
observation and returns the router recommendation without creating a destination
candidate unless the caller asks for a review action.

`POST /skill-candidates/observe` is the compatibility path for skill governance. It
accepts a structured observation request, persists the observation, runs routing,
duplicate analysis, and safety checks, then either appends evidence or creates a pending
candidate. It never accepts raw transcript blobs.

Implemented explicit job slice:

```text
explicit recording/save action
  -> build bounded ObservationJobInput from durable metadata
  -> compute observationJobKey
  -> if existing job result exists, return it
  -> create ProcedureObservation
  -> route
  -> create only pending destination candidate when explicit gates pass
```

`ObservationJobInput` should be daemon-owned and should not be exported to renderers as a
raw transcript view:

```ts
interface ObservationJobInput {
  readonly workspaceId: string;
  readonly source:
    | "explicit_user_request"
    | "user_correction"
    | "successful_tool_chain"
    | "repeated_pattern"
    | "workflow_step_output"
    | "multi_agent_handoff"
    | "manual_recording";
  readonly signals: readonly ProcedureObservationSignal[];
  readonly runId?: string;
  readonly messageId?: string;
  readonly reviewActionId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly selectedSkillId?: string;
  readonly terminalStatus?: "succeeded" | "failed" | "cancelled";
  readonly toolLabels: readonly string[];
  readonly validationLabels: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly userConfirmed: boolean;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
}
```

Idempotency:

```text
observationJobKey =
  workspaceId
  + source
  + runId/messageId/reviewActionId
  + destination hint
  + normalized goal signature
```

The first implementation stores the job key as a `sourceRef` with
`type: "observation-job"` and checks for an existing matching observation before writing.
A dedicated job table can be added later only if source-ref lookup becomes insufficient.

Candidate gates:

| Signal | Observation | Candidate |
| --- | --- | --- |
| Explicit "save this as a skill" | create | pending skill candidate if duplicate decision is `no_overlap` |
| Explicit "save this as channel protocol" | create | channel protocol draft/candidate |
| Workflow step output with channel-local procedure steps | create | playbook cluster; draft creation requires later review action |
| User-approved recording | create | pending skill candidate if validation and negative triggers exist |
| Single successful run without explicit save | optional when feature flag is on | evidence-only |
| Two or more successful runs in same cluster | append evidence | pending candidate only after stable validation evidence |
| User correction with one-off preference | optional memory/reject observation | no skill candidate |
| Repeated correction against same skill | usage health finding | reviewer chooses whether to create update candidate |
| Any permission expansion text | optional policy-review observation | no skill/protocol candidate |

Behavior:

- Observation jobs write `ProcedureObservation` first.
- A deterministic cluster key merges repeated observations before candidate creation:
  `workspaceId + destination hint + scope hint + normalized goal + trigger signature +
  procedure step signature + required tool signature`.
- Weak signals append evidence to an existing observation cluster.
- Candidate creation remains conservative and pending.
- Candidate creation is allowed for explicit user save/protocol save/recording,
  user-confirmed selected run extraction, or repeated successful clusters with stable
  validation evidence.
- Router output includes `kind`, `reasonCode`, `confidence`, and blockers such as
  `insufficient_evidence`, `missing_validation`, `duplicate_existing_skill`, and
  `permission_expansion`.
- Skill routing requires positive triggers, negative triggers, procedure steps,
  validation steps, stable required tools, and no permission expansion.
- Channel protocol routing is the default for multi-agent coordination rules.
- Playbook routing is the default for `workflow_step_output` observations that have a
  `channelId` and concrete procedure steps.
- Desktop/PC renderers call daemon APIs only and must not parse transcripts or write
  SQLite-backed governance tables directly.

Do not:

- scan every transcript in the background;
- create active skills;
- infer permission changes;
- inject observations into active runs.
- store raw prompt, transcript, secret, or artifact body text in observation records.
- create one pending candidate per teammate when the repeated evidence belongs to one
  channel-level protocol cluster.

Tests:

- explicit save phrase creates observation;
- repeated explicit save with the same job key returns the existing observation;
- correction phrase with one-off preference routes to memory or reject;
- repeated weak signal increments evidence only;
- explicit save phrase with duplicate signature appends evidence instead of creating a
  second pending skill candidate;
- permission-expanding text routes to approval policy review or reject;
- multi-agent handoff rule routes to channel protocol candidate rather than skill;
- selected run manual extraction does not create a candidate until user confirmation;
- active run prompt is unchanged by observation job.

Exit criteria:

- Ling can propose candidates from clear signals without changing runtime behavior.

## Phase SG.10: Advanced Publish, Wrapper, And Supersede Flow

Type: reviewed publication into existing Skill Registry.

Files:

```text
packages/daemon/src/features/skill-governance/publish.ts
packages/daemon/src/features/skills/routes.ts
packages/core/src/storage/sqlite/skill-registry-store.ts
packages/daemon/test/channel-workspace.test.mjs
```

Flow:

```text
SkillCandidate approved_for_draft
  -> SkillImportDraft or registry draft
  -> publish
  -> teammate binding
  -> Effective Skill validates runtime executability
```

Rules:

- Built-in skills can only receive patch suggestions or wrapper candidates.
- External/imported skills can only receive wrapper/overlay candidates.
- Ling-generated skills can be superseded after review.
- Publish is blocked if similarity is `>= 0.65` without conflict resolution.
- Publish is blocked without validation steps and negative triggers.

Tests:

- wrapper candidates create import drafts without mutating the external target;
- imported draft publication marks the candidate published after successful registry write;
- built-in target direct mutation is rejected;
- external target creates wrapper draft only;
- duplicate/conflict publish blocker works;
- effective skill checks still decide executability after publish.

Exit criteria:

- Candidate publication reuses existing registry and binding gates.

## Phase SG.11: Usage, Failure, And Expiry Feedback

Type: telemetry-backed diagnostics.

Files:

```text
packages/core/src/skill-health.ts
packages/core/src/storage/sqlite/skill-usage-store.ts
packages/core/src/storage/sqlite/skill-usage-event-store.ts
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/test/channel-workspace.test.mjs
```

Add event-first local telemetry:

```ts
type SkillUsageEventKind =
  | "selected"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "user_corrected"
  | "draft_created"
  | "published"
  | "superseded";

interface SkillUsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly kind: SkillUsageEventKind;
  readonly reason?: string;
  readonly createdAt: string;
}
```

Aggregate events into local stats:

```ts
interface SkillUsageStats {
  readonly skillId: string;
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt?: string;
  readonly lastFailureAt?: string;
  readonly lastUserCorrectionAt?: string;
  readonly correctionCount: number;
}
```

Tables:

```sql
CREATE TABLE IF NOT EXISTS skill_usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT,
  candidate_id TEXT,
  run_id TEXT,
  teammate_id TEXT,
  channel_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_events_skill
  ON skill_usage_events(workspace_id, skill_id, created_at);

CREATE INDEX IF NOT EXISTS idx_skill_usage_events_candidate
  ON skill_usage_events(workspace_id, candidate_id, created_at);
```

Rules:

- generated candidates stale after 30 days without review;
- generated active skills stale after 90 days without use unless pinned;
- high failure/correction rates appear as health findings;
- repeated corrections create a health finding; creating or updating a candidate stays
  review-backed and must not mutate the active skill automatically;
- superseded active generated skills appear as health findings until reviewed;
- dashboards may window stats by time, but source events remain the rebuildable record;
- telemetry never auto-deletes or auto-disables skills.

Tests:

- selected skill usage increments on run terminal state;
- usage stats can be rebuilt from events after deleting derived aggregates;
- failure counts appear in health report;
- repeated correction events create a health finding;
- stale generated skills are findings, not automatic archives.

Exit criteria:

- Operators can see whether generated skills are useful or harmful over time.

## Phase SG.12: Automatic Observation Hook And Candidate Generation

Type: bounded evidence-to-review automation.

This is the next implementation phase for automatic generation. It should automate
candidate creation only after the current explicit observation and cluster pipeline has
enough bounded evidence. It must not crawl raw transcripts or create executable skills.

Files:

```text
packages/contracts/src/skills.ts
packages/api-client/src/endpoints/skills.ts
apps/web/src/api/skills.ts
packages/core/src/procedure-observations.ts
packages/core/src/procedure-observation-job.ts
packages/core/src/skill-candidate-types.ts
packages/core/src/storage/sqlite/procedure-observation-store.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/features/skills/schemas.ts
packages/daemon/src/server/router.ts
packages/daemon/src/features/runs/orchestrator.ts
packages/daemon/src/features/channels/workflow-fanin.ts
packages/api-client/test/client.test.mjs
packages/core/test/procedure-observation-store.test.mjs
packages/daemon/test/channel-workspace.test.mjs
```

Current implementation status:

- `POST /procedure-observations/jobs` persists a generation decision for every new
  observation job outcome, including evidence-only decisions.
- `GET /candidate-generation-decisions` lists audit decisions by observation, cluster,
  decision, and limit.
- Post-run terminal jobs with `terminalStatus: "succeeded"` can create a pending
  `ling-generated` skill candidate only after two successful observations in the same
  cluster share stable validation evidence and duplicate analysis returns `no_overlap`.
- Failed, cancelled, non-skill, blocked-route, single-observation, and unstable-validation
  post-run jobs remain evidence-only.
- Selected skill ids and terminal status are stored as source refs for audit only; they
  do not inject `requestedSkillId`, alter an active prompt, bind a skill, or publish a
  candidate.
- Selected transcript snippets, workflow fan-in, and correction-health automatic
  candidate creation remain explicit follow-up wiring points unless they enter through
  the existing structured observation/review APIs.

Add a generation decision DTO:

```ts
interface CandidateGenerationDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly source:
    | "explicit_user_save"
    | "approved_recording"
    | "post_run_terminal"
    | "selected_transcript_snippet"
    | "workflow_fanin"
    | "correction_health";
  readonly route: CandidateRoute;
  readonly decision:
    | "append_evidence"
    | "create_skill_candidate"
    | "create_channel_protocol_candidate"
    | "create_playbook_candidate"
    | "create_memory_candidate"
    | "create_automation_candidate"
    | "policy_review"
    | "reject";
  readonly blockers: readonly CandidateRouteBlocker[];
  readonly duplicateDecision?: SkillDuplicateDecision;
  readonly reason: string;
  readonly createdCandidateId?: string;
  readonly createdAt: string;
}
```

Store generation decisions for audit and replay:

```sql
CREATE TABLE IF NOT EXISTS candidate_generation_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  source TEXT NOT NULL,
  route_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  duplicate_decision TEXT,
  reason TEXT NOT NULL,
  created_candidate_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidate_generation_decisions_cluster
  ON candidate_generation_decisions(workspace_id, cluster_id, created_at);
```

`duplicate_decision` is nullable because duplicate analysis only runs for skill-candidate
creation paths. Policy-review, reject, memory, automation, and playbook routes must not
claim a `no_overlap` result they did not compute.

Accepted source events:

| Source | Input allowed | Candidate behavior |
| --- | --- | --- |
| `explicit_user_save` | message id, run id, bounded structured summary, user confirmation | create pending destination candidate only if gates pass |
| `approved_recording` | recording id, source refs, steps, triggers, validation labels | create pending skill candidate when duplicate decision allows |
| `post_run_terminal` | run id, terminal status, selected skill id, tool labels, validation labels, artifact refs | append evidence; create only after repeated stable cluster |
| `selected_transcript_snippet` | snippet ref and user confirmation, never full transcript body | create observation; candidate only after user confirms extraction |
| `workflow_fanin` | channel id, participant roles, workflow step refs, bounded summary | route to channel protocol or playbook by default |
| `correction_health` | health finding id, skill id, correction count, summary | create update candidate only after reviewer action |

Generation gates:

- Observation is persisted first.
- Cluster key is computed before destination choice.
- Duplicate/conflict analysis runs before any candidate write.
- Positive triggers, negative triggers, procedure steps, validation steps, and stable
  required tools are mandatory for skill candidate creation.
- Single post-run success without explicit user save remains evidence-only.
- Repeated post-run success can create a candidate only when the same cluster has at
  least two successful observations and stable validation evidence.
- Similarity `>= 0.65` against active or pending skill blocks new candidate creation and
  produces `append_evidence`, `policy_review`, or an update/supersede review path.
- Permission, provider, secret, deploy, external-send, or approval expansion text never
  creates a skill/protocol/playbook candidate.

Runtime behavior:

- No active run prompt is changed by SG.12.
- No `requestedSkillId` is injected into a run by SG.12.
- No candidate is published, bound, archived, or superseded automatically.
- Built-in and external/imported skills receive patch/wrapper suggestions only.
- All created destination records stay in their existing review queues.

Tests:

- post-run terminal event without explicit save appends evidence only;
- two successful terminal events in the same cluster can create one pending candidate;
- repeated job key returns the same observation and does not duplicate decisions;
- exact procedure signature appends evidence to existing candidate instead of creating a
  second candidate;
- similarity `>= 0.65` blocks new skill candidate creation;
- workflow fan-in routes to channel protocol or playbook rather than global skill;
- selected transcript snippet requires user confirmation before candidate creation;
- permission expansion routes to policy review or reject;
- created decision records include route, duplicate decision, blockers, and source refs.

Exit criteria:

- Ling can create pending review candidates from bounded evidence without changing active
  runtime behavior.

## Phase SG.13: Runtime Suggestion Boundary

Type: read-only suggestion and feedback loop, not automatic invocation.

SG.13 should make generated and reviewed skills easier to choose without letting the
generation system run them silently.

Files:

```text
packages/contracts/src/skills.ts
packages/core/src/effective-skills.ts
packages/core/src/skill-health.ts
packages/core/src/skill-suggestions.ts
packages/daemon/src/features/skills/routes.ts
packages/daemon/src/features/skills/schemas.ts
packages/daemon/src/server/router.ts
packages/api-client/src/endpoints/skills.ts
apps/web/src/api/skills.ts
apps/web/src/features/teammates/*
apps/web/e2e/settings.spec.ts
```

Add a suggestion DTO:

```ts
interface SkillInvocationSuggestion {
  readonly skillId: string;
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
  readonly blockers: readonly (
    | "disabled_binding"
    | "missing_tools"
    | "missing_provider_capability"
    | "channel_policy"
    | "approval_mismatch"
    | SkillHealthFindingKind
  )[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}
```

Current implementation status:

- `POST /skills/suggestions` returns visible recommendations for a teammate/channel/task
  context.
- Suggestions are computed from executable effective skills only, using teammate
  bindings, channel tool policy, provider capabilities, approval profile, and skill
  health findings.
- Existing `requestedSkillId` is excluded from suggestions so an explicit user choice is
  not echoed back as an automated recommendation.
- Skill health findings appear as visible blockers on the suggestion; they do not mutate
  the skill, disable it, or change execution policy.
- Suggestions are read-only: the runtime continues to invoke a skill only when the run
  request explicitly carries an approved/configured `requestedSkillId`.

Rules:

- Suggestions are derived from published registry skills, active channel/playbook context,
  and health state.
- Suggestions do not mutate `requestedSkillId`.
- Suggestions never bypass teammate binding, channel allowed tools, provider capability,
  approval profile, or Effective Skill checks.
- A stale, high-failure, high-correction, duplicate, or conflicting generated skill can be
  suggested only with visible blockers.
- User selection records normal `selected` usage events.
- Failed or corrected suggested-skill runs feed Skill Health; they do not disable or
  rewrite skills automatically.

Tests:

- suggestion excludes unbound or non-executable skills;
- suggestion includes blockers for stale or conflicting generated skills;
- selecting a suggestion goes through the existing run request validation path;
- run without user skill selection is unchanged;
- failure and correction events appear in usage stats and health findings.

Exit criteria:

- Users can see why a reviewed skill might apply, while runtime execution remains
  user-visible and policy-gated.

## Test Matrix

Core:

```bash
corepack pnpm --filter @ling-stack/core test
```

Required coverage:

- duplicate classifier;
- safety scanner;
- skill health report;
- candidate store;
- protocol store;
- usage stats;
- candidate generation decisions;
- post-run observation idempotency;
- runtime suggestions without automatic invocation.

Daemon:

```bash
corepack pnpm --filter @ling-stack/daemon test -- channel-workspace
corepack pnpm --filter @ling-stack/daemon test -- control-plane-api
```

Required coverage:

- health route;
- candidate routes;
- review transitions;
- migration idempotency;
- method-not-allowed;
- missing `cwd`;
- invalid status/action;
- publish blockers.

Contracts and API client:

```bash
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/api-client test
```

Required coverage:

- URL/query construction for skill health and candidates;
- typed request/response exports;
- stable error handling.

Web:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/teammates.spec.ts
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts
```

Required coverage:

- health empty state;
- critical finding display;
- candidate pending/review/quarantined state;
- channel protocol active/pending surface;
- no layout overflow on desktop and narrow widths.

Desktop compatibility smoke once `apps/desktop` exists:

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
```

Required coverage:

- Desktop imports shared contracts and API client only;
- renderer cannot access stores or SQLite directly;
- notification/deep-link targets use route/source refs.

## Parallelization Strategy

Recommended order:

```text
Lane A: SG.1 -> SG.2 -> SG.3
Lane B: SG.4 after SG.3
Lane C: SG.5 after SG.4
Lane D: SG.6 -> SG.7 after SG.3
Lane E: SG.8 after SG.6
Lane F: SG.9 -> SG.10 -> SG.11 after SG.7
Lane G: SG.12 after SG.9 and SG.11
Lane H: SG.13 after SG.10 and SG.11
```

Dependency table:

| Phase | Modules touched | Depends on |
| --- | --- | --- |
| SG.1 | `packages/contracts`, `packages/core` | SG.0 |
| SG.2 | `packages/core` | SG.1 |
| SG.3 | `packages/core` | SG.2 |
| SG.4 | `packages/daemon`, `packages/api-client`, `apps/web/src/api` | SG.3 |
| SG.5 | `apps/web`, `apps/web/e2e` | SG.4 |
| SG.6 | `packages/core/storage` | SG.3 |
| SG.7 | `packages/daemon`, `packages/api-client` | SG.6 |
| SG.8 | `packages/core/storage`, `packages/daemon`, `apps/web` | SG.6 |
| SG.9 | `packages/daemon` run/channel jobs | SG.7 |
| SG.10 | `packages/daemon`, Skill Registry store | SG.7 |
| SG.11 | `packages/core/storage`, run terminal events | SG.10 |
| SG.12 | `packages/core/storage`, `packages/daemon` observation jobs | SG.9, SG.11 |
| SG.13 | `packages/contracts`, `packages/core`, `packages/daemon`, `apps/web` | SG.10, SG.11 |

Do not parallelize SG.6 and SG.8 in separate worktrees if both edit SQLite migrations.
Keep schema-bearing phases sequential unless each phase has already landed on main.

## Not In Scope

- No embedding dependency for MVP similarity.
- No automatic publication.
- No direct mutation of built-in or external skill sources.
- No marketplace, sync, or cloud review queue.
- No Desktop implementation in this feature branch.
- No CLI/TUI surface unless the shared API stabilizes early and a small read-only command
  is worth adding later.
- No background transcript crawler.
- No automatic runtime invocation or hidden `requestedSkillId` injection.
- No policy or approval editor hidden inside candidate review.

## Open Decisions Before Implementation

- Are generated skills workspace-wide by default, or channel-scoped until promoted?
  Recommendation: channel-scoped until promoted.
- Should channel protocol candidates share memory promotion UI?
  Recommendation: no for MVP; keep a channel protocol panel to avoid mixed semantics.
- Should manual recording create a `SkillCandidate` directly?
  Recommendation: no; always create `ProcedureObservation` first.
- Should generated skills require a human-authored summary before publication?
  Recommendation: yes for publish, no for pending candidates.
- Should PC/Desktop ship a native candidate review UI in the first desktop alpha?
  Recommendation: no; reuse Web renderer over the shared daemon API first.

## Completion Definition

The module is implementation-ready when:

- Skill Health works as a read-only report.
- Candidate persistence has explicit review state.
- Approved candidates can create import drafts without auto-publication.
- Channel protocols are separate from skills and memory.
- Publication reuses the existing Skill Registry and Effective Skill gates.
- Desktop compatibility is protected by shared contracts and API client coverage.
- No slice requires hidden authority changes or client-specific product state.
