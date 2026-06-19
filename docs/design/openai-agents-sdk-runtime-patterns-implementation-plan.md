# OpenAI Agents SDK Runtime Patterns Implementation Plan

## Status

Implementation planning document. No code is implemented by this document.

This plan breaks [OpenAI Agents SDK Runtime Patterns](openai-agents-sdk-runtime-patterns.md)
into small slices. The goal is to prepare implementation work without changing the
current runner backend or importing OpenAI Agents SDK into the daemon.

## Scope

Implement Ling-owned contracts inspired by OpenAI Agents SDK:

- trace/span projection;
- approval checkpoints and resume handles;
- structured handoff intents and input packets;
- tool namespaces and deferred loading;
- sandbox profiles, session refs, and artifact import boundaries.

Out of scope:

- replacing Pi as the default runner;
- adding Python Agents SDK to the main daemon;
- enabling a hosted sandbox provider;
- changing provider preset semantics;
- allowing any runner to bypass Ling approval policy.

## Implementation Principles

- Read models first, write paths later.
- Additive contracts only. Do not migrate existing run/thread/workflow records until the
  new projection proves useful.
- Every new side-effect-capable path must use existing approval policy.
- Every runner-native feature must have a conformance test before user selection.
- Web surfaces should render existing durable state, not maintain their own runtime truth.

## Slice P0: Baseline Documentation And Decision Record

Purpose: establish the product boundary before implementation starts.

Work:

- add this design and implementation plan;
- cross-link from architecture, runner, runtime, and tool-boundary docs;
- record that OpenAI Agents SDK is a pattern source, not a runtime dependency.

Acceptance:

- docs name all five borrowed patterns;
- docs state that Ling remains the durable runtime owner;
- no code changes are required.

## Slice P1: Trace Projection Read Model

Purpose: give Ling one end-to-end diagnostic shape without creating a new state source.

Implementation status:

- core trace DTOs and pure projection live in `packages/core/src/runtime-trace-types.ts`
  and `packages/core/src/runtime-trace-projection.ts`;
- read-only daemon routes expose `GET /traces`, `GET /traces/:id`, and
  `GET /traces/:id/spans`;
- the first PR intentionally leaves the Web evidence panel for a follow-up slice so the
  read model can land independently of presentation work.

Likely files:

- `packages/core/src/runtime-trace-types.ts`
- `packages/core/src/runtime-trace-projection.ts`
- `packages/daemon/src/features/runtime/traces-routes.ts`
- `packages/contracts/src/runtime.ts`
- `apps/web/src/features/runtime` or existing evidence panels

Work:

1. Define `LingTrace` and `LingTraceSpan` DTOs.
2. Build a projector from existing run events, runtime events, approvals, artifacts,
   execution actions, workflow steps, and state transitions.
3. Add read-only daemon endpoints:

   ```text
   GET /traces?cwd=...&threadId=...
   GET /traces/:id?cwd=...
   GET /traces/:id/spans?cwd=...
   ```

4. Add tests that compare known run/workflow fixtures to deterministic trace spans.
5. Render trace spans inside the existing thread evidence panel before creating a new page.

Acceptance:

- trace projection is reproducible from durable records;
- trace spans include refs back to source records;
- redaction is applied before API output;
- missing optional records do not fail trace generation.

Non-goal:

- no `trace_spans` persistence table in this slice.

## Slice P2: Approval Checkpoints And Resume Handles

Purpose: make "waiting for approval" explicitly resumable and auditable.

Implementation status:

- durable checkpoint contracts live in `packages/core/src/approval-checkpoints.ts`;
- SQLite persists `approval_checkpoints` and backfills legacy approvals best-effort from
  existing approval request payloads;
- new approval requests create checkpoints automatically, and approve/deny/expire/cancel
  decisions synchronize checkpoint status;
- runner-native resume handles are modeled but not yet granted execution authority;
- daemon API and Web evidence surfaces remain follow-up work so this slice stays focused
  on durable state.

Likely files:

- `packages/core/src/approval-checkpoints.ts`
- `packages/core/src/approval-types.ts`
- `packages/core/src/state-machines.ts`
- `packages/daemon/src/features/runs/approvals.ts`
- `packages/daemon/test/approval-policy-run.test.mjs`
- `packages/daemon/test/runtime-permission-requests.test.mjs`

Work:

1. Add `LingApprovalCheckpoint` types.
2. Create checkpoints when a run or workflow step pauses for a side-effect approval.
3. Link checkpoints to preview and result artifacts where available.
4. Add optional `RunnerResumeHandle` metadata to runner attempts.
5. Keep Ling continuation resume as the fallback when no verified runner-native handle
   exists.
6. Add tests for approve, deny, expire, cancel, partial approval, and idempotent resume.

Acceptance:

- every new side-effect approval has a checkpoint, and legacy approvals are backfilled
  during SQLite migration where payloads are available;
- checkpoint status follows approval decisions;
- denied approvals continue to use existing approval policy behavior and record
  decision text on the approval request;
- late success after denial or cancel remains a follow-up runner/conformance behavior;
- runner-native resume is disabled unless conformance marks it verified.

Non-goal:

- no OpenAI Agents SDK `RunState` storage in Ling records.

## Slice P3: Unified Structured Handoff Intents

Purpose: make handoff proposals explicit, typed, and safe before workflow execution.

Implementation status:

- shared `LingHandoffIntent` and `LingHandoffInputPacket` DTOs live in
  `packages/core/src/handoff-intents.ts`;
- existing `ChannelHandoff` and `WorkflowHandoffIntent` records normalize into the shared
  read model without a storage migration;
- source refs are derived or preserved so downstream API/Web surfaces can link back to
  messages, tasks, runs, workflows, steps, and artifacts;
- daemon API consolidation and Web rendering remain follow-up work.

Likely files:

- `packages/core/src/workspace-types.ts`
- `packages/core/src/workflow-graph-types.ts`
- `packages/core/src/handoff-intents.ts`
- `packages/daemon/src/features/channels/workflow-handoffs.ts`
- `packages/daemon/src/features/channels/workflow-step-packets.ts`
- `packages/daemon/src/features/channels/workflow-selector.ts`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`

Work:

1. Define a shared `LingHandoffIntent` interface that covers channel and workflow handoffs.
2. Normalize existing channel handoffs and workflow handoff intents into that interface.
3. Add `LingHandoffInputPacket` as the durable context-filter output.
4. Ensure workflow compilation writes handoff/workflow/step records before any runner starts.
5. Update Web handoff rows to show reason, expected output, target role, input packet, and
   workflow linkage.

Acceptance:

- a model-produced handoff cannot start hidden work through this read model;
- handoff input is bounded and reviewable through a normalized input packet;
- receiving teammate does not get unbounded hidden transcript from the normalized DTO;
- existing handoff status transitions stay persisted on their source records.

Non-goal:

- no model-driven graph rewriting in this slice.

## Slice P4: Tool Namespace Catalog And Deferred Loading

Purpose: reduce large tool surfaces while preserving approval policy.

Implementation status:

- `LingToolNamespaceCatalog` contracts and pure catalog builder live in
  `packages/core/src/tool-surface-types.ts`, with API DTOs mirrored in
  `packages/contracts/src/tool-surfaces.ts`;
- the catalog compiles core tools, MCP tools, skill-required tool references, runner
  support metadata, and approval policy decisions into one read model;
- schema visibility never changes `executionApproval`, so deferred loading cannot upgrade
  `ask` or `deny` into execution authority;
- daemon `GET /tool-surfaces` and `POST /runs/:id/tool-load-requests` endpoints now expose
  the catalog and record materialization summary evidence without granting execution
  approval.

Likely files:

- `packages/core/src/tool-surface-types.ts`
- `packages/core/src/session-permissions.ts`
- `packages/daemon/src/runtime/external-agent/tool-surface.ts`
- `packages/daemon/src/features/mcp/routes.ts`
- `packages/daemon/src/features/runs/orchestrator.ts`
- `apps/web/src/features/providers` or runtime settings panels

Work:

1. Define `LingToolNamespace`, `LingToolDescriptor`, and `LingToolLoadRequest`.
2. Compile namespaces from core tools, MCP bindings, skill-required tools, runner metadata,
   and plugin-contributed resources.
3. Add read-only catalog endpoint:

   ```text
   GET /tool-surfaces?cwd=...&runId=...
   ```

4. Add controlled materialization endpoint:

   ```text
   POST /runs/:id/tool-load-requests
   ```

5. Log namespace/tool materialization as runtime events.
6. Add policy checks so deferred loading cannot grant execution authority.

Acceptance:

- loading a schema does not approve the tool call;
- denied tools are marked disabled in the catalog and cannot be treated as materialized
  execution authority by this read model;
- MCP server identity stays visible on MCP tools;
- core tools remain governed by approval policy;
- context budget enforcement happens in the daemon before materialization evidence is
  written.

Non-goal:

- no hosted OpenAI `ToolSearchTool` dependency in the first Ling implementation.

## Slice P5: Sandbox Profiles And Session Refs

Purpose: define sandbox execution boundaries without enabling a sandbox backend.

Implementation status:

- sandbox contracts and the fail-closed readiness evaluator live in
  `packages/core/src/sandbox-types.ts`;
- daemon runner readiness can now name sandbox blocker codes, but no runner is granted
  sandbox execution authority by this slice;
- manifests reject raw secret-looking env values and require secret refs for injected
  secrets;
- network policy defaults to disabled and only accepts explicit allowlists when enabled;
- sandbox session refs are opaque and runner-native resume tokens must remain secret refs;
- all Docker, hosted, and external sandbox backends remain disabled until a future adapter
  passes conformance.

Likely files:

- `packages/core/src/sandbox-types.ts`
- `packages/daemon/src/runtime/runner-readiness.ts`
- `packages/daemon/src/runtime/runner-conformance.ts`
- `packages/daemon/src/runtime/external-agent/workspace-boundary.ts`
- `docs/design/runner-adapters.md`

Work:

1. Define `LingSandboxProfile`, `LingSandboxManifest`, `LingSandboxCapability`, and
   `LingSandboxSessionRef`.
2. Add readiness blockers for sandbox-backed runners:

   ```text
   sandbox_profile_missing
   sandbox_backend_unverified
   sandbox_artifact_import_unverified
   sandbox_network_policy_unverified
   ```

3. Add readiness helpers that assert sandbox artifacts import into Ling artifact roots.
4. Add docs for local Unix, Docker, hosted, and external sandbox backend semantics.
5. Keep every sandbox backend disabled until a later adapter implementation.

Acceptance:

- sandbox manifest cannot contain raw secrets;
- network policy defaults to disabled or allowlist;
- sandbox session refs are opaque;
- sandbox artifacts require import and redaction before appearing as Ling artifacts.

Non-goal:

- no Docker, E2B, Modal, Runloop, Vercel, Cloudflare, or OpenAI sandbox integration in this
  slice.

## Slice P6: Runner Adapter Conformance Extensions

Purpose: make future Agents-SDK-like adapters prove they can fit Ling.

Implementation status:

- the shared daemon conformance suite now asserts stronger tool-event pairing,
  approval pause ordering, approval denial failure, cancellation failure, unmaterialized
  side-effect tool rejection, sandbox readiness failure, artifact redaction, and workspace
  boundary failure behavior;
- the slice still uses fake runners only. It does not enable `codex-app-server`,
  `openclaw-acp`, Docker, hosted sandbox, or external sandbox execution;
- later real adapters must wire their own fake/fault injection harnesses into this suite
  before becoming selectable.

Likely files:

- `packages/daemon/src/runtime/runner-conformance.ts`
- `packages/daemon/test/runner-conformance.test.mjs`
- `packages/daemon/test/external-agent-adapters.test.mjs`
- `packages/daemon/src/runtime/external-agent/approval-bridge.ts`
- `packages/daemon/src/runtime/external-agent/artifact-importer.ts`

Work:

1. Extend conformance with trace import assertions.
2. Add approval/resume test cases:

   - approval pause before side effect;
   - approve then resume;
   - deny then model-visible denial;
   - stale completion after cancel.

3. Add handoff proposal normalization test cases.
4. Add deferred tool materialization policy test cases.
5. Add sandbox artifact import and secret redaction test cases.

Acceptance:

- disabled runners cannot be selected without passing conformance;
- conformance output includes blocking reasons that Settings can render;
- a runner with unverified approval interception cannot expose `bash`, `edit`, `write`,
  external-send, deploy, or provider mutation tools.

## Slice P7: Web Evidence And Control Surfaces

Purpose: expose the new contracts without turning the UI into a second runtime.

Implementation status:

- thread work-cell evidence now fetches the daemon trace read model opportunistically and
  appends safe trace span summaries to the existing evidence group;
- missing or failing trace reads degrade to the existing thread evidence view;
- runtime runner settings render daemon-provided readiness status and blocking reasons,
  including sandbox blocker codes, as read-only diagnostics;
- thread and workflow evidence read models expose durable approval checkpoints, and Web
  renders them as bounded checkpoint rows with action/risk/status/resume verification
  while hiding checkpoint ids, approval ids, resume payloads, and handle refs;
- workflow evidence renders handoff intent packet detail rows with reason, required
  input, expected output, risk summary, and validation blockers;
- trace tool-call rows render bounded tool namespace/materialization summaries when the
  trace read model provides safe redacted attributes;
- full daemon tool catalog/materialization endpoints are handled by P8. P7 intentionally
  does not add mutating runtime controls.

Likely files:

- `apps/web/src/lib/conversation-work-cell.ts`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/features/settings/SettingsPage.tsx`
- `apps/web/e2e/channel.spec.ts`
- `apps/web/e2e/support/mock-daemon.ts`

Work:

1. Show trace spans in thread/run evidence.
2. Show approval checkpoint status on approval cards.
3. Show handoff input/output packets in workflow detail.
4. Show tool namespace materialization in run activity.
5. Show sandbox profile/session refs in runner diagnostics only, not as primary user labels.

Acceptance:

- Web never mutates trace or runtime state directly;
- every UI action calls daemon APIs;
- stale or missing trace data degrades to existing evidence views;
- approval and sandbox details link back to source artifacts.

## Slice P8: Daemon Tool Surface Materialization Endpoint

Purpose: make the P4 tool catalog usable by daemon clients without treating schema loading
as execution permission.

Implementation status:

- `packages/contracts/src/tool-surfaces.ts` defines the public catalog, namespace,
  descriptor, load request, and materialization response DTOs;
- `packages/daemon/src/features/runs/tool-surfaces.ts` serves:

  ```text
  GET /tool-surfaces?cwd=...&runId=...
  POST /runs/:id/tool-load-requests?cwd=...
  ```

- the GET endpoint builds a catalog from the workspace approval policy, core tools, MCP
  servers/tools, skill requirements, and runner support metadata;
- the POST endpoint resolves either a namespace or one tool, returns the same catalog plus
  a bounded `ToolMaterializationSummary`, and appends `tool_namespace_materialized` runtime
  evidence when the run has a work unit;
- runtime evidence stores only ids, counts, approval distribution, scope kind, and boolean
  request metadata. It does not store input schemas, raw reason text, or idempotency key
  values; retry dedupe stores only an idempotency digest;
- materialization now includes a bounded context budget summary and rejects requests that
  cannot fit the selected namespace/tool payload before any runtime evidence is appended;
- `packages/api-client/src/endpoints/runs.ts` exposes `getToolSurface` and
  `createToolLoadRequest` helpers.

Acceptance:

- loading a namespace/tool schema does not change workspace approval policy;
- denied or otherwise disabled tools stay disabled in the returned catalog and may still
  be counted in materialization evidence;
- MCP server identity remains visible through namespace ids and owner ids;
- materialization is observable by trace/runtime readers, but it is not a runner prompt
  injection path and not an execution grant;
- context budget enforcement happens before runtime event append; over-budget requests
  return `tool_materialization_over_budget` and do not create materialization evidence.

## Slice P9: Tool Materialization Context Budget Enforcement

Purpose: close the remaining P8 runtime gap by making daemon-controlled tool schema
materialization budget-aware before it can become prompt-eligible evidence.

Implementation status:

- `ToolMaterializationSummary` now carries a bounded `budget` object with the decision,
  estimated tokens, input budget, remaining budget, requested tool count, max tool count,
  tokenizer mode, and provider capability source/confidence;
- `POST /runs/:id/tool-load-requests` resolves the run provider preset through the same
  context budget machinery used by channel/workflow context packs;
- the daemon estimates the selected namespace/tool descriptor and schema payload before
  materialization, then rejects over-budget requests with HTTP 413
  `tool_materialization_over_budget`;
- successful runtime evidence stores only the budget summary plus ids/counts/approval
  distribution. It still omits input schemas, raw reason text, and raw idempotency keys;
- rejected requests do not append `tool_namespace_materialized` events and do not change
  workspace approval policy.

Acceptance:

- loading a namespace/tool schema still does not approve tool execution;
- over-budget selection is blocked before materialization evidence is written;
- idempotent retries of accepted materialization return the original budget summary;
- budget errors expose only budget metadata, not schemas, reason text, or idempotency
  values.

## Migration Strategy

No broad migration is needed initially.

Recommended order:

1. Add new types and projections.
2. Backfill read models from existing records.
3. Use feature flags for all new write paths.
4. Add optional storage only after projections become expensive or write durability is
   required.
5. Keep old APIs until Web and CLI read paths move to the new DTOs.

## Verification Matrix

| Slice | Unit tests | API tests | Web e2e | Manual smoke |
| --- | --- | --- | --- | --- |
| P1 trace projection | required | required | optional | evidence panel |
| P2 approval checkpoints | required | required | required | approve/deny/resume |
| P3 handoff intents | required | required | required | handoff -> workflow |
| P4 tool catalog | required | required | optional | MCP/core tool catalog |
| P5 sandbox profiles | required | optional | no | readiness diagnostics |
| P6 conformance | required | no | no | disabled runner reasons |
| P7 Web surfaces | optional | no | required | run evidence review |
| P8 tool materialization API | optional | required | optional | tool catalog endpoint |
| P9 materialization budget enforcement | optional | required | no | over-budget namespace rejection |

## Rollback

Each slice should be separately reversible:

- P1 can disable trace endpoints and keep existing evidence surfaces.
- P2 can fall back to existing approval records without runner-native resume.
- P3 can keep existing channel/workflow handoff records.
- P4 can materialize all currently allowed tools as today.
- P5 has no enabled backend, so rollback removes types and diagnostics only.
- P6 only tightens future runner gates.
- P7 can hide new panels behind existing feature flags.
- P8 can disable `/tool-surfaces` and `/runs/:id/tool-load-requests`; existing runner
  execution paths continue using approval policy directly.
- P9 can remove the budget gate and budget DTO field while keeping P8 catalog/materialization
  endpoints intact.

## Recommended Decisions

These are the default decisions for the implementation series. They can be revisited at
the start of each slice if code evidence contradicts them.

| Decision | Recommendation | Pattern | Decide by |
| --- | --- | --- | --- |
| Trace projection ownership | Put pure projection in `packages/core`; let `packages/daemon` add artifact paths, Web links, and runtime-only enrichments. | CQRS read model plus daemon enricher | P1 start |
| Approval checkpoint storage | Create a durable `approval_checkpoints` table in P2 instead of inferring checkpoint state only from approvals and execution actions. | Saga checkpoint / durable pause | P2 start |
| Handoff storage | Normalize `ChannelHandoff` and workflow handoff intent records at API/read-model boundaries first; defer table migration. | Strangler fig / anti-corruption layer | P3 start |
| Tool namespace exposure | Build an internal daemon/Web catalog first; do not expose deferred tool loading to the model prompt until a runner supports it cleanly. | Capability catalog / lazy loading | P4 start |
| Sandbox backend | Land only contracts, readiness blockers, and conformance expectations first; keep all concrete sandbox backends fail-closed. | Capability-based security / fail closed | P5 start |

Rationale:

- P1 is a read model, so keeping projection pure in `packages/core` preserves the existing
  core/daemon boundary while still letting the daemon add URLs and artifact access facts.
- P2 needs durable state because approval resume is not just display. It has status,
  idempotency, runner resume handles, and failure recovery.
- P3 should not start with a storage migration. Existing channel and workflow handoff
  records already carry product semantics, so normalize them before deciding whether a
  unified table is worth the migration cost.
- P4 should separate tool discovery from tool execution authority. Materializing a schema
  must never imply that the model may execute the tool.
- P5 is the riskiest boundary. A sandbox is an execution environment, not Ling state. No
  backend should be enabled until artifact import, network policy, and secret redaction
  pass conformance.

## Open Decisions Before Implementation

These are the same decision points expressed as implementation gates:

1. Whether trace projection should live entirely in `packages/core` or have daemon-specific
   enrichers for artifact paths and Web URLs.
2. Whether existing `ChannelHandoff` and workflow handoff intent records should be migrated
   into one storage table or normalized only at API boundaries.
3. Whether tool namespace materialization is exposed to the model through the current runner
   prompt or only used internally by the daemon until a runner supports tool search.
4. Which sandbox backend, if any, is worth implementing first after the contract lands.

Current P8 answer: keep materialization internal to daemon/API clients only. Do not expose
deferred tool loading to the current runner prompt until a runner supports tool search and
approval-preserving schema hydration cleanly.
