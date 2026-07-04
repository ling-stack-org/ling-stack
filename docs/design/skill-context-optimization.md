# Skill Context Optimization

Status: Design direction
Date: 2026-07-03
Scope: Skill source health, optional optimization previews, compiled runtime views, and
Ling-owned lazy skill context loading

Related docs:

- [Ling Framework](ling-framework.md)
- [Ling Skill Import v1](ling-skill-import-v1.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [Channel Context Budget Manager](channel-context-budget-manager.md)
- [AI Teammates and Skills](ai-teammates-and-skills.md)

## Summary

Ling should treat imported, built-in, and third-party skills as source assets that can be
diagnosed, normalized, and compiled into bounded runtime context. The goal is not to
silently rewrite skills or replace Ling's Effective Skill and approval model.

The product shape is:

```text
third-party or Ling skill source
  -> source snapshot
  -> read-only health findings
  -> optional optimization preview
  -> compiled Ling runtime view
  -> Context Budget Manager
  -> core rules plus lazy reference index
  -> run evidence and fallback
```

The original source remains the source of record. Optimized output is a Ling-managed
compiled view used only when policy allows it. Skill text remains a workflow template,
not a permission grant.

## Non-Goals

- No default automatic skill rewriting.
- No per-import confirmation requirement in the default mode.
- No change to teammate bindings, required tools, provider capabilities, approval
  profiles, secrets, MCP access, browser access, or external-send authority.
- No dependency on a third-party runtime's private skill loader for lazy loading.
- No requirement that every third-party skill author manually adapts to Ling.
- No LLM-judge-only release gate. Real Ling runs and task fixtures must validate runtime
  optimization before broad enablement.

## Policy Model

Skill optimization is controlled by user or workspace preference. Workspace policy may
restrict user policy, but user preference can opt into lower-friction experimental
behavior inside the workspace's allowed boundary.

```ts
type SkillOptimizationMode =
  | "no_operation"
  | "report_only"
  | "preview_on_demand"
  | "auto_safe"
  | "auto_runtime_experimental";
```

Default mode: `no_operation`.

Default behavior means:

- imports and publishes continue without an optimization gate;
- no optimized runtime view is used automatically;
- no source, registry entry, teammate binding, or approval profile is changed;
- P0 health can still show findings when the user opens health or diagnostics surfaces;
- users can request an optimization preview manually.

`report_only` enables visible findings and notifications, but still never changes runtime
context.

`preview_on_demand` adds a manual preview action for imports, publish flows, source
snapshots, and skill library detail pages. It must not block publish by default.

`auto_safe` may create and use a compiled runtime view only when all safe-mode invariants
hold:

- required tools are unchanged;
- required provider capabilities are unchanged;
- approval profile is unchanged;
- teammate and council bindings are unchanged;
- original source snapshot is retained;
- generated core rules are traceable to source spans;
- lazy references keep source refs, checksums, and token estimates;
- high-risk findings force fallback to `preview_on_demand`;
- every optimized run can fall back to the original source view.

`auto_runtime_experimental` allows the runtime to prefer compiled views by default for the
current user or workspace. It still must not rewrite original source. It must be visibly
experimental, reversible, and audited per run.

## P0: Read-Only Skill Source Health

P0 exists to let Ling see skill problems. It is observability, not remediation.

Inputs:

- built-in skill metadata;
- workspace custom skills;
- imported skill drafts;
- source snapshots from gstack, Codex-style, or Ling-native skill roots;
- referenced file inventory;
- usage events and selected/requested skill telemetry.

Outputs:

- `token_bloat`: the skill body or referenced files exceed configured warning budgets.
- `missing_or_weak_routing_description`: the routing description is absent, too short,
  too broad, or mostly non-routing text.
- `reference_duplication`: source body and references, or multiple references, repeat
  substantial content.
- `body_taxonomy_risk`: actionable rules, background, examples, and templates are mixed
  in a way that will likely overfill runtime context.
- `source_snapshot_gap`: an executable registry skill has no reviewed source snapshot.
- `optimization_unsafe`: rules appear embedded inside examples or templates, making
  automatic splitting unsafe.

P0 should extend the existing source-health and skill-health surfaces. It must not create
drafts, publish skills, archive skills, bind teammates, or change runtime behavior.

Suggested data shape:

```ts
interface SkillContextHealthFinding {
  readonly kind:
    | "token_bloat"
    | "missing_or_weak_routing_description"
    | "reference_duplication"
    | "body_taxonomy_risk"
    | "source_snapshot_gap"
    | "optimization_unsafe";
  readonly severity: "info" | "warning" | "critical";
  readonly skillId: string;
  readonly sourceSnapshotId?: string;
  readonly evidence: readonly SkillContextFindingEvidence[];
  readonly recommendation: string;
}

interface SkillContextFindingEvidence {
  readonly sourceRef: string;
  readonly byteStart?: number;
  readonly byteEnd?: number;
  readonly tokenEstimate?: number;
  readonly message: string;
}
```

Acceptance criteria:

- `GET /skills/source-health` and `GET /skills/health` can surface context health
  findings without mutating registry state.
- Skill Library can show which skills are bloated, weakly routed, duplicated, or hard to
  split.
- Findings include source refs so users can inspect why Ling produced the warning.

## P1: Optional Optimization Preview

P1 exists to show what Ling would optimize, without making the default workflow slower.

Default mode is `no_operation`, so P1 does not run automatically during import or publish.
The user can open a preview on demand, or opt into `auto_safe` or
`auto_runtime_experimental`.

Preview compares:

- original routing description vs. suggested routing description;
- original body vs. proposed core rules;
- original references vs. lazy reference index;
- token estimates before and after;
- source spans that justify each compiled rule;
- risks and blockers.

Preview output:

```ts
interface SkillOptimizationPreview {
  readonly skillId: string;
  readonly sourceSnapshotId: string;
  readonly mode: SkillOptimizationMode;
  readonly status:
    | "not_run"
    | "preview_ready"
    | "safe_for_auto_runtime"
    | "manual_review_required"
    | "blocked";
  readonly originalTokenEstimate: number;
  readonly compiledTokenEstimate: number;
  readonly routingDescription?: SkillDescriptionOptimization;
  readonly compiledView?: SkillCompiledRuntimeView;
  readonly risks: readonly SkillOptimizationRisk[];
}
```

P1 must preserve the authority boundary:

- preview can suggest prompt/context changes;
- preview cannot suggest new tool authority;
- preview cannot suggest lower approval requirements;
- preview cannot bind or unbind teammates;
- preview cannot change provider or runner access.

Acceptance criteria:

- Import and publish still work when optimization mode is `no_operation`.
- A user can request preview from an import draft, source snapshot, or skill detail page.
- `auto_safe` can apply only when risks are below threshold and all safe-mode invariants
  hold.
- All applied compiled views are rollbackable by disabling optimization mode or choosing
  original source view for the run.

### Import Path Integration

Skill import is the primary ingestion path for optimization metadata. Import must handle
context optimization without making the default import path slower or more fragile.

Manual import flow:

```text
POST /skills/import-draft
  -> parse source into draft SkillDefinition records
  -> preserve raw source snapshot candidate
  -> run P0 source health scan
  -> return warnings and context findings
  -> do not run optimization by default
  -> user may request P1 preview through POST /skills/import-draft/optimization-preview
  -> user publishes draft
  -> registry definition is written
  -> source snapshot is published when eligible
  -> compiled runtime view is created only if policy allows it
  -> teammate binding remains a separate explicit action
```

Built-in third-party source sync flow:

```text
Skill Library "Sync gstack source"
  -> user opens built-in third-party source sync panel
  -> UI calls read-only preview or refresh first
  -> Ling shows source changes plus P0 context findings
  -> no optimization runs by default
  -> user may request P1 preview for selected source-backed skills
  -> user explicitly publishes selected source snapshots

POST /skills/sync/gstack/preview
  -> discover local source roots
  -> classify new/changed/attachable/blocked sources
  -> run P0 health scan
  -> no registry mutation

POST /skills/sync/gstack/refresh
  -> recompute known source snapshots and source health
  -> surface drift and context findings
  -> no registry mutation unless existing refresh semantics explicitly publish nothing

POST /skills/sync/gstack/publish
  -> publish selected source snapshots
  -> attach to registry definitions
  -> create compiled view only under auto-safe or explicit preview/apply
  -> do not change teammate bindings
```

This path covers Ling's built-in third-party skill sync, such as the Skill Library
`Sync gstack source` action. It is not a separate authority path. It must still pass
through source snapshot review, source health, optimization policy, publish selection,
and Effective Skill checks before runtime use.

Default import behavior under `no_operation`:

- import draft still parses and returns ordinary import warnings;
- P0 findings may be returned or visible in health surfaces;
- no optimization preview is generated unless the user asks;
- no compiled runtime view is created;
- publish does not wait for optimization;
- bind remains explicit and separate from publish.

Behavior under `report_only`:

- P0 findings are more visible in import draft and Skill Library UI;
- publish still proceeds unless existing import warnings block it;
- no compiled runtime view is created.

Behavior under `preview_on_demand`:

- import draft shows a "Preview optimization" action;
- built-in source sync rows can expose the same action for selected third-party sources;
- preview is cached or job-backed if expensive;
- user can save a compiled view, but publish is not blocked by ignoring it.

Behavior under `auto_safe`:

- after draft parse or source sync publish, Ling may create a compiled runtime view only
  if all safe-mode invariants pass;
- built-in third-party source sync may auto-create compiled views only after selected
  source snapshots are published, never from preview-only rows;
- failures downgrade to `preview_on_demand` with blockers surfaced;
- original source snapshot remains the published source of record.

Behavior under `auto_runtime_experimental`:

- imported source can default to compiled runtime view after publish;
- users can still force original source per skill or per run;
- run evidence must show that compiled context was used.

Import blockers remain separate from optimization blockers. Raw secrets, invalid schema,
duplicate ids, unsupported authority claims, or unsafe source packaging can still block
import/publish according to existing import rules. Optimization blockers only prevent
automatic compiled-view use.

## P2: Core Plus Lazy References Runtime Loading

P2 is the runtime savings layer. It should run only after Effective Skill passes and only
through Ling-owned context assembly.

Runtime path:

```text
run starts with requestedSkillId or selectedSkillId
  -> Effective Skill validates teammate, channel, tools, provider, approval, state
  -> source-backed skill snapshot resolves
  -> optimization policy resolves
  -> compiled runtime view or original source view is selected
  -> Context Budget Manager builds skill context section
  -> runner receives core rules plus lazy reference index
  -> optional reference materialization happens through Ling evidence paths
  -> run records loaded source refs and fallback decisions
```

Compiled view:

```ts
interface SkillCompiledRuntimeView {
  readonly id: string;
  readonly skillId: string;
  readonly sourceSnapshotId: string;
  readonly createdAt: string;
  readonly compilerVersion: string;
  readonly coreRulesMarkdown: string;
  readonly lazyReferences: readonly SkillLazyReference[];
  readonly sourceMap: readonly SkillCompiledSourceMapEntry[];
  readonly tokenEstimate: number;
  readonly fallbackPolicy: "original_on_error" | "manual_only";
}

interface SkillLazyReference {
  readonly id: string;
  readonly title: string;
  readonly kind: "background" | "example" | "template" | "reference" | "script_note" | "asset_note";
  readonly sourceRef: string;
  readonly summary: string;
  readonly tokenEstimate: number;
  readonly loadPolicy: "on_request" | "on_retry" | "never_auto";
}
```

Third-party skills do not need per-skill adapters. Ling needs source importers by format:

- Ling-native JSON skill packs;
- gstack skill directories;
- Codex-style `SKILL.md` directories;
- workspace custom `SKILL.md`;
- future markdown command or persona formats, if explicitly supported.

Importer responsibility:

```text
external source format
  -> preserve raw source snapshot
  -> normalize metadata
  -> inventory references
  -> produce warnings
  -> produce optional compiled runtime view
```

If a third-party runner is a black box and loads its own skills internally, Ling cannot
guarantee P2 lazy loading. In that case Ling may still provide P0/P1 diagnostics over the
source, but P2 requires one of these integration modes:

1. Ling-managed mode.
   Ling imports the third-party skill source and passes compiled context to the runner.
2. Adapter contract mode.
   The runner adapter accepts Ling-provided compiled context and lazy reference ids.

If neither mode is available, the runner is not eligible for skill context optimization.

Acceptance criteria:

- Runtime can choose original source view or compiled view per run.
- The run inspector shows which source refs were included, deferred, materialized, or
  skipped.
- Context Budget Manager owns token budgeting and truncation evidence.
- Fallback to original source view is available for failed optimized runs when policy
  allows it.

## P3: Real Ling Run And Task Regression

P3 proves whether optimization helps Ling. It must use Ling-owned run and task evidence,
not only LLM judges.

Evaluation modes:

```text
A: original source view
B: compiled core plus lazy references
C: compressed routing description plus compiled core plus lazy references
```

Metrics:

- routing preservation: the same skill is selected for the same task class;
- task completion rate;
- user-visible success criteria pass rate;
- tool approval count and approval risk;
- fallback rate from compiled view to original view;
- extra clarification rate;
- input token estimate;
- latency;
- context truncation rate;
- loaded lazy reference count;
- regression signatures tied to missing references.

Lifecycle verdicts:

- `safe_to_keep_full`: optimization does not help enough.
- `safe_for_core_lazy`: P2 can be enabled for this skill.
- `needs_manual_review`: examples or templates likely contain hidden rules.
- `obsolete_or_low_value`: the skill is rarely selected or provides no measurable lift.
- `black_box_runtime_only`: source can be diagnosed, but runtime lazy loading is not
  enforceable.

P3 should start with a small fixture set from real Ling workflows before any broad
default is changed.

Current implementation slice:

- core exposes a deterministic regression harness that evaluates stored Ling task/run
  observations; it does not ask an LLM judge to grade the result;
- SQLite persists `skill_regression_runs` with fixtures, observations, case results,
  summary metrics, lifecycle verdict, and the `autoSafeEligible` gate result;
- the harness can promote `auto_safe` only when the persisted run has a
  `safe_for_core_lazy` verdict and the shadow guardrails prove it did not mutate skill
  definitions, source snapshots, compiled views, or runtime authority;
- HTTP regression run/result routes remain a follow-up API layer over the core store.

Acceptance criteria:

- A/B/C runs are reproducible from stored fixtures or anonymized real tasks.
- Regressions create source-linked findings instead of silently disabling optimization.
- Auto modes require a passing P3 gate per skill family or source format, not just per
  model.

## Detailed Architecture

### Ownership Boundaries

| Object | Owner | Purpose | Mutability |
| --- | --- | --- | --- |
| `SkillDefinition` | Skill registry | Lightweight routing, phase, tool, provider, and approval metadata | Mutated only by existing import/publish/archive flows |
| `SkillSourceSnapshot` | Source sync/import | Raw reviewed source, checksums, upstream metadata, reference inventory | Immutable after publish; superseded by new snapshots |
| `SkillContextHealthFinding` | Health engine | Read-only diagnosis over source and usage | Derived or cached; never authoritative |
| `SkillOptimizationPreview` | Optimization service | Proposed description/core/reference split and risk report | Ephemeral unless user saves/applies |
| `SkillCompiledRuntimeView` | Optimization service | Ling-owned runtime view for core plus lazy references | Versioned, rollbackable, never source of truth |
| `SkillOptimizationPolicy` | User/workspace settings | Controls whether optimization is off, visible, or automatic | Normal settings mutation rules |
| `SkillContextRunEvidence` | Run/control plane | Records which view and source refs were used | Append-only run evidence |
| `SkillRegressionResult` | Test/evaluation store | Captures P3 A/B/C outcomes | Append-only or replaced by newer suite run |

The compiled runtime view is deliberately not a `SkillDefinition`. It cannot grant tools,
approvals, memory access, provider capabilities, runner access, external-send authority,
or side effects. It is a context rendering artifact.

### Settings Resolution

Optimization settings should follow the existing Ling two-layer pattern:

```text
workspace skill optimization policy
  -> user default optimization preference
  -> built-in default: no_operation
```

Suggested shape:

```ts
interface SkillOptimizationSettings {
  readonly mode: SkillOptimizationMode;
  readonly allowAutoSafe: boolean;
  readonly allowExperimentalRuntime: boolean;
  readonly maxCompiledCoreTokens?: number;
  readonly maxLazyReferenceTokens?: number;
  readonly fallbackToOriginalOnFailure: boolean;
  readonly perSkillOverrides: readonly SkillOptimizationOverride[];
}

interface SkillOptimizationOverride {
  readonly skillId: string;
  readonly mode?: SkillOptimizationMode;
  readonly runtimeViewPreference?: "original" | "compiled" | "auto";
  readonly disabledReason?: string;
}
```

Resolution rules:

- workspace can force `no_operation` or `report_only` for the whole workspace;
- workspace can disallow `auto_runtime_experimental` even if the user enables it;
- per-skill override wins inside the workspace-allowed boundary;
- missing source snapshot always downgrades runtime behavior to original registry
  prompt fragments;
- high-risk findings downgrade `auto_safe` to `preview_on_demand`;
- black-box runner execution downgrades P2 to P0/P1 only.

### Storage Model

P0 can start as derived health output. Persistence becomes useful for compiled views and
regression evidence.

Candidate tables:

```sql
CREATE TABLE skill_compiled_runtime_views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  status TEXT NOT NULL,
  core_rules_markdown TEXT NOT NULL,
  lazy_references_json TEXT NOT NULL,
  source_map_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  original_token_estimate INTEGER NOT NULL,
  compiled_token_estimate INTEGER NOT NULL,
  fallback_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX idx_skill_compiled_runtime_views_skill
ON skill_compiled_runtime_views(workspace_id, skill_id, source_snapshot_id, status);

CREATE TABLE skill_context_run_evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source_snapshot_id TEXT,
  compiled_view_id TEXT,
  runtime_view TEXT NOT NULL,
  included_refs_json TEXT NOT NULL,
  deferred_refs_json TEXT NOT NULL,
  materialized_refs_json TEXT NOT NULL,
  fallback_reason TEXT,
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_skill_context_run_evidence_run
ON skill_context_run_evidence(workspace_id, run_id);

CREATE TABLE skill_regression_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  source_snapshot_id TEXT,
  compiled_view_id TEXT,
  suite_id TEXT,
  fixtures_json TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  lifecycle_verdict TEXT NOT NULL,
  auto_safe_eligible INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

Health findings can remain derived from source snapshots until there is a performance
reason to cache them. If cached, cache rows must include the source snapshot checksum and
scanner version so stale findings can be ignored.

### API Surface

Read APIs:

```http
GET /skills/source-health?cwd=/path/to/workspace&includeContextOptimization=true
GET /skills/:id/optimization?cwd=/path/to/workspace
GET /skills/:id/compiled-views?cwd=/path/to/workspace
GET /runs/:id/skill-context?cwd=/path/to/workspace
GET /skills/:id/regression-results?cwd=/path/to/workspace
```

Mutation APIs:

```http
POST /skills/import-draft/optimization-preview?cwd=/path/to/workspace
POST /skills/:id/optimization-preview?cwd=/path/to/workspace
POST /skills/:id/compiled-views?cwd=/path/to/workspace
POST /skills/:id/compiled-views/:viewId/archive?cwd=/path/to/workspace
PATCH /skill-optimization-settings?cwd=/path/to/workspace
POST /skills/:id/regression-runs?cwd=/path/to/workspace
```

Regression run/result HTTP routes are planned surfaces. The current P3 implementation
lands the core harness and SQLite store first so daemon routes can stay thin and reuse the
same persisted verdicts.

API rules:

- preview may be expensive, so it should accept an idempotency key or return a job id if
  implementation becomes async;
- creating a compiled view does not publish, bind, unbind, or edit a skill definition;
- compiled view creation must rebuild from the published source snapshot server-side;
- import-draft previews, source-sync preview rows, and other non-published source
  candidates cannot create persisted compiled views;
- archiving a compiled view hides it from default lists but keeps source-map evidence for
  audit and rollback;
- settings mutation follows normal workspace settings rules;
- run evidence APIs are read-only;
- regression run creation starts local evaluation only when the caller explicitly asks.

### Compiler Pipeline

The compiler should be deterministic where possible and model-assisted only where useful.
It must not rely on brittle keyword-only rules.

```text
source snapshot
  -> normalize line endings and front matter
  -> parse title, description, sections, code fences, lists, and headings
  -> inventory referenced files and artifact-backed source refs
  -> estimate tokens per source span
  -> classify spans
  -> build candidate core rules
  -> build lazy reference index
  -> source-map every emitted rule and reference
  -> run risk gates
  -> run faithfulness checks
  -> produce preview or compiled runtime view
```

Classification labels:

- `core_rule`: required instruction for successful execution;
- `decision_rule`: condition that changes what the agent should do;
- `tool_instruction`: how to use an allowed tool, without granting the tool;
- `safety_constraint`: negative rule, approval reminder, privacy or destructive-action
  boundary;
- `workflow_step`: phase or sequence instruction;
- `background`: explanatory context not needed every run;
- `example`: sample input/output or scenario;
- `template`: reusable output format;
- `reference_material`: detailed material that can be loaded by source ref;
- `script_or_asset_note`: inventory note for scripts/assets that are not runtime text;
- `authority_claim`: text that appears to grant tools, credentials, approvals, or side
  effects;
- `uncertain`: content that the classifier cannot safely split.

Auto-safe requires all emitted `core_rule`, `decision_rule`, `tool_instruction`,
`safety_constraint`, and `workflow_step` spans to have source-map coverage. Any
`authority_claim` or large `uncertain` span blocks auto-safe.

### Risk Gates

Risk gates decide whether a preview can become an automatic compiled view.

Blockers:

- source snapshot is missing, stale, or checksum-mismatched;
- source contains authority-changing claims;
- description compression removes unique routing terms;
- hidden rules appear inside examples or templates;
- core coverage is below the configured threshold;
- compiled token reduction is achieved mostly by dropping safety constraints;
- reference files are too large to summarize safely;
- source map is incomplete;
- generated view changes required tools, provider capabilities, approval profile, or
  binding metadata;
- runner is black-box-only for the selected execution path.

Warnings:

- source is long but well structured;
- examples are large but clearly examples;
- references duplicate body content;
- source has scripts or assets that are inventoried but not injected;
- classifier confidence is low for some background/example spans.

Auto modes may proceed only with warnings below threshold and no blockers.

### Runtime Context Assembly

P2 should integrate with the Context Budget Manager as a skill context section builder,
not as runner-specific prompt manipulation.

```text
RunRequestBuilder
  -> selectedSkillId
  -> EffectiveSkill check
  -> SkillSourceResolver
  -> SkillOptimizationPolicyResolver
  -> SkillRuntimeViewResolver
  -> Context Budget Manager
  -> Runner request
```

The `SkillRuntimeViewResolver` returns one of:

- `metadata_only`: no source snapshot exists; use current prompt fragments;
- `original_source`: include reviewed source under budget with truncation evidence;
- `compiled_view`: include core rules and lazy reference index;
- `disabled_for_runner`: black-box runner cannot honor compiled context;
- `fallback_original`: compiled view was attempted but the run retried with original
  source.

The Context Budget Manager should render:

```text
Skill: <name>
Runtime view: compiled
Core rules:
<bounded core markdown>

Available skill references:
- ref=<id>, title=<title>, kind=<example|template|reference>, summary=<summary>
```

Mid-run lazy loading should be phased:

1. P2A: deferred index only. The model sees references and may ask the user/runner to
   continue with a referenced module, but no hidden injection happens mid-run.
2. P2B: retry-time loading. If an optimized run fails with a missing-reference signature,
   retry can include the relevant lazy reference or original source.
3. P2C: explicit reference materialization tool. A future runner adapter may expose a
   Ling-controlled read-only source-ref loader, with run evidence for every load.

P2A is enough to reduce default context. P2C must not ship until approval, audit, and
runner adapter behavior are tested.

### Third-Party Source Handling

Ling should not maintain a hand-written fork of every third-party skill. It should store:

```text
source format adapter
  -> raw source snapshot
  -> normalized metadata
  -> compiled runtime view
```

Adapter responsibilities by format:

| Format | Importer responsibility | Runtime optimization eligibility |
| --- | --- | --- |
| Ling JSON skill pack | Parse structured fields and source refs | Full P0-P3 |
| gstack skill directory | Parse `SKILL.md`, references, scripts, assets, agent metadata | Full P0-P3 when Ling owns runtime context |
| Codex-style `SKILL.md` | Parse description/body and relative references | Full P0-P3 when imported into Ling |
| Workspace custom markdown | Parse as reviewed draft/source snapshot | P0-P2 after publish; P3 after fixtures |
| Black-box external runner skill | Diagnose only if source is available | P0/P1 only unless adapter accepts Ling context |

Scripts and assets are evidence/inventory first. They are not executed or injected because
the source text mentions them.

### UI Surfaces

Skill Library:

- health badges for token bloat, weak routing, duplication, taxonomy risk;
- source snapshot status;
- built-in third-party source sync panel, including `Sync gstack source`, preview,
  refresh, selected publish, and context optimization findings;
- optimization mode badge;
- preview button when mode allows manual preview;
- compiled view history and rollback/archive action;
- original vs compiled token estimate;
- source map drawer for emitted core rules.

Import draft:

- default path shows no optimization gate;
- optional "Preview optimization" action;
- clear warning that optimization does not grant tools or approvals;
- optional "Use auto-safe for low-risk skills" preference link.

Run inspector:

- selected skill id;
- source snapshot id;
- runtime view: metadata-only, original source, or compiled;
- included/deferred/materialized refs;
- token estimate and truncation evidence;
- fallback reason if original source was used after compiled failure.

Settings:

- global skill optimization mode;
- workspace restriction indicator;
- experimental runtime warning for `auto_runtime_experimental`;
- per-skill overrides.

### P3 Regression Harness

Regression fixtures should be small at first and tied to real Ling workflows:

```text
fixture
  -> user prompt
  -> workspace/channel/task metadata
  -> selected or expected skill
  -> allowed tools and provider profile
  -> expected visible result or artifact signature
  -> original source view run
  -> compiled view run
  -> comparison report
```

The first harness can run in simulation mode without real side effects:

- read-only tasks use fake workspaces;
- tool calls are captured and compared;
- write/edit/bash paths require normal approval stubs;
- provider outputs can be recorded fixtures for deterministic regression where possible.

Promotion rule:

```text
compiled view is eligible for auto_safe
  only if routing preservation passes
  and task success is not worse
  and approval/tool risk does not increase
  and fallback rate stays below threshold
```

### Implementation Slices

P0A. Contracts and scanner findings.

- Add context-optimization finding kinds to source health contracts.
- Add deterministic token estimate, description quality, duplicate chunk, and taxonomy
  risk scanners.
- Show findings in read-only API responses.

P0B. Skill Library visibility.

- Add badges and finding details.
- Link findings to source snapshot refs.
- Show P0 findings inside the built-in third-party source sync panel before publish.
- Keep all actions read-only.

P1A. Settings and manual preview.

- Add `SkillOptimizationMode` settings with default `no_operation`.
- Add preview route and API client method.
- Add manual preview button on skill detail and import draft.
- Add manual preview entry points from source sync rows such as `Sync gstack source`
  results.

P1B. Compiled view persistence.

- Store versioned compiled runtime views.
- Add archive/rollback behavior.
- Enforce authority invariants before save.
- Allow compiled view creation from published source snapshots produced by built-in
  third-party sync, not from preview-only source rows.

P2A. Runtime resolver and Context Budget Manager section.

- Resolve original vs compiled view per run.
- Render core rules plus lazy reference index.
- Record run evidence.
- Implemented first slice: `SkillRuntimeViewResolver` records `metadata_only`,
  `original_source`, `compiled_view`, or `disabled_for_runner` evidence in the run request
  snapshot. Default `no_operation` keeps using original source and does not read compiled
  views automatically. Run Inspector shows included and deferred refs. Mid-run reference
  materialization remains out of scope for P2A.

P2B. Retry fallback.

- Detect optimized-context failure signatures.
- Retry with relevant lazy reference or original source when policy allows.
- Record fallback reason.
- Implemented first slice: explicit per-run `auto_runtime_experimental` can select an
  active compiled runtime view. If that run fails with a missing-reference signature,
  Ling records `skillContextFallback` on the `run_error` event with
  `retryRuntimeViewKind: "original_source"` and matched deferred ref ids. It does not
  silently create a second run yet.

P2C. Explicit source-ref materialization.

- Add runner adapter support only when a Ling-controlled read-only loader can record every
  materialization event.
- Keep unavailable for black-box runners.

P3A. Fixture harness.

- Build A/B/C evaluation runner for a small skill family.
- Persist regression results and lifecycle verdicts.

P3B. Promotion gates.

- Allow `auto_safe` only for skill/source-format families with passing regression
  evidence.
- Keep `auto_runtime_experimental` gated behind explicit user/workspace opt-in.

### Failure Modes

- Treating a compiled view as a skill definition.
  The compiled view is context only and must never grant authority.
- Blocking import/publish by default.
  Default mode is `no_operation`; optimization is opt-in.
- Keyword-only classification.
  Use structure, source maps, token estimates, references, and risk gates.
- Silent mid-run injection.
  Lazy loading is explicit, evidenced, and phased.
- Trusting black-box runner skill loading.
  P2 requires Ling-managed context or an adapter contract.
- Optimizing away safety constraints.
  Safety and approval spans are core by default.
- Measuring only token savings.
  P3 must include task success, routing preservation, approval/tool risk, fallback, and
  user-visible quality.

## Rollout Order

1. Ship P0 health findings first.
2. Add P1 on-demand preview with default `no_operation`.
3. Add `auto_safe` only for compiled runtime views that preserve all authority fields.
4. Add P2 for Ling-managed source-backed skills.
5. Add P3 regression suites before broad `auto_runtime_experimental` rollout.

This keeps the default user path fast while still letting power users opt into
experimental automatic runtime optimization.
