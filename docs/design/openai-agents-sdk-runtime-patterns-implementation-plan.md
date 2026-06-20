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
- P12 adds a Docker backend doctor/run-plan adapter, but no runner is granted sandbox
  execution authority until a later runner-binding conformance slice passes.

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
  slice. Docker starts in P12.

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

## Slice P10: Runner-Native Deferred Tool Hydration

Purpose: design the safe runner-facing bridge from P8/P9 daemon materialization to
model-visible on-demand schemas without turning schema loading into execution approval.

Implementation status:

- this slice is no longer design-only. Embedded Pi can expose a runner-native
  `load_tools` / `hydrated_tool_call` surface behind explicit
  `runners.pi.toolHydration.enabled` and `conformancePassed` gates;
- the daemon remains the only hydration authority. Runners must call the daemon
  materialization path instead of reading MCP/plugin config directly;
- runner-native hydration requires a verified runner capability before selection:
  unsupported or unverified runners keep using the P8/P9 daemon/API/Web-only surface;
- hydrated schema payloads may be returned to the active runner turn, but durable runtime
  events and Web evidence continue storing only bounded summaries;
- the HTTP `/runs/:id/tool-load-requests` response remains summary-only. The runner-only
  daemon handler returns hydrated descriptors and schemas only to verified runners;
- sandbox backend selection remains a separate future decision and is not part of P10.

Decision update:

- P11 implementation order is fake conformance runner first, then embedded Pi. The fake
  runner proves the policy, budget, idempotency, trace, and denial behavior before the
  default product runner changes prompt assembly.
- P11 will introduce a runner-only hydrated-schema DTO. P8/P9 public materialization
  responses stay summary-only so Web/API evidence does not grow raw schema payloads.
- P12 landed a Docker doctor/run-plan adapter, but Docker is no longer the default sandbox
  direction. The product direction now follows Codex's local model: platform-native
  filesystem/process/network enforcement with approvals, then optional Docker/hosted
  adapters only when a workspace explicitly opts in.

Work:

1. Add runner capability metadata for `daemon_hydrated` tool search/hydration support.
2. Define the runner-to-daemon hydration request shape with run id, attempt id, scope,
   reason, and idempotency key.
3. Reuse `POST /runs/:id/tool-load-requests` for policy, context budget, and idempotency;
   extend only if the runner needs a sanitized schema payload separate from Web/API
   summaries.
4. Add runtime trace attributes that distinguish catalog search, hydration accepted,
   hydration rejected by policy, hydration rejected by budget, and execution approval.
5. Extend runner conformance with:

   - unmaterialized side-effect execution rejection;
   - hydration does not change `allow`/`ask`/`deny`;
   - denied tools can be described but not executed;
   - over-budget hydration returns a model-visible denial and writes no materialization
     event;
   - idempotent hydration retries do not duplicate runtime evidence.

6. Keep the first implementation behind a runner feature flag. Pi behavior remains
   unchanged until the adapter passes conformance.

Acceptance:

- current runner prompts do not receive hidden schema injection from P10 docs alone;
- a runner cannot hydrate schemas unless readiness reports verified hydration support;
- hydration success and failure are auditable through runtime events/trace summaries;
- tool execution authority still comes only from workspace approval policy and approval
  checkpoints;
- sandbox execution backends remain fail-closed.

## Slice P11: Runner Hydration Conformance Adapter

Purpose: land the first executable runner-native hydration contract without changing the
default Pi prompt path or granting any new tool execution authority.

Implementation status:

- `packages/contracts/src/tool-surfaces.ts` now defines runner-only hydration DTOs:
  capability metadata, runner hydration requests, hydrated tool descriptors, success
  payloads, and rejection payloads;
- the P8/P9 public materialization response remains summary-only. Raw schemas are still
  absent from Web/API evidence responses and durable runtime materialization events;
- `packages/runner-pi/src/types.ts` now accepts optional `runId`, `runnerAttemptId`, and
  an `onToolHydrationRequest` callback. The package keeps this structurally typed and does
  not add a contracts dependency;
- run event unions now include summary-only `tool_hydration_request` and
  `tool_hydration_end` events so orchestrators can audit hydration attempts without
  storing input schemas;
- the default Pi runner registry entry explicitly reports hydration as `unsupported` and
  `unverified`. A later productization slice keeps that default but enables embedded Pi
  hydration behind explicit config and conformance gates;
- the shared daemon conformance fake now proves:

  - daemon-hydrated schemas do not change `ask` approval behavior;
  - hydrated `deny` tools can be described but cannot execute or request approval;
  - policy-denied hydration fails closed before approval;
  - over-budget hydration fails closed and writes no successful materialization summary;
  - idempotent hydration retries do not duplicate the active-turn hydrated surface
    evidence.

Likely files:

- `packages/contracts/src/tool-surfaces.ts`
- `packages/runner-pi/src/types.ts`
- `packages/core/src/run-types.ts`
- `packages/contracts/src/runtime.ts`
- `packages/daemon/src/runtime/runners.ts`
- `packages/daemon/src/runtime/runner-conformance.ts`
- `packages/daemon/test/runner-conformance.test.mjs`

Acceptance:

- runner-only DTOs can carry sanitized schemas without expanding P8/P9 public responses;
- hydration events are summary-only and contain no input schema payload;
- hydration success never grants execution permission;
- denied or disabled hydrated tools fail before approval interception;
- current Pi remains unsupported by default; `daemon_hydrated` activates only behind a
  verified feature flag.

Non-goal:

- no default embedded Pi prompt hydration;
- no hosted OpenAI `ToolSearchTool` dependency;
- no Docker, hosted, or external sandbox backend activation.

## Slice P12: Optional Docker Sandbox Backend Adapter

Purpose: add an optional sandbox backend experiment while keeping sandbox execution
separate from runner selection and Ling state.

Direction update:

- Docker is not the default Ling sandbox path. It remains a disabled optional adapter and
  should not receive runner binding by default.
- The default path should mirror Codex's local sandbox model: platform-native enforcement
  selected by OS capability, explicit approval gates for escaped operations, and bounded
  artifact import back into Ling-owned roots.
- Future work should implement `platform_native` profiles before any Docker runner-binding
  work. Docker can stay useful for diagnostics or explicit isolated CI-style workspaces,
  but it is not the main desktop/local app strategy.

Implementation status:

- daemon config now has a `sandbox.docker` shape with `enabled`, `dockerBinary`, `image`,
  `artifactImportRoot`, `networkPolicy`, `cpus`, and `memoryMb`;
- `packages/daemon/src/runtime/sandbox/docker.ts` implements a Docker backend doctor that
  verifies the Docker daemon and configured image through the Docker CLI using an
  injectable command runner;
- the adapter builds a `docker` `LingSandboxProfile`, `LingSandboxManifest`, and
  readiness report through the existing core sandbox readiness evaluator;
- the adapter builds a `docker run` plan with:

  - `--network none` for the only P12 verified network mode;
  - a read-only workspace bind mount by default;
  - a Ling artifact bind mount under `.ling/artifacts/sandbox/docker`;
  - optional CPU and memory limits;
  - non-secret env values only, with secret refs carried as names rather than raw values.

- P12 does not execute containers during normal daemon operation. It provides a verified
  optional backend adapter and command plan for explicit opt-in use only;
- allowlist networking is intentionally blocked in P12. Docker allowlists need a separate
  network/proxy implementation before they can be marked verified;
- Docker artifacts still must import through Ling-owned artifact roots and pass redaction
  before they become Ling artifacts.

Likely files:

- `packages/daemon/src/config.ts`
- `packages/daemon/src/runtime/sandbox/docker.ts`
- `packages/daemon/test/docker-sandbox.test.mjs`
- `docs/design/openai-agents-sdk-runtime-patterns-implementation-plan.md`
- `docs/design/runner-adapters.md`

Acceptance:

- disabled Docker config or missing image keeps readiness blocked;
- Docker daemon/image failures keep `sandbox_backend_unverified`;
- non-disabled network policy keeps `sandbox_network_policy_unverified`;
- artifact import roots outside Ling artifact roots keep
  `sandbox_artifact_import_unverified`;
- raw secret-looking env values are rejected by the shared sandbox manifest readiness
  evaluator;
- generated Docker run plans do not expose raw secret refs or raw secret values.

Non-goal:

- no runner automatically uses Docker;
- no default Docker runner binding in the platform-native sandbox roadmap;
- no container execution endpoint;
- no Docker network allowlist implementation;
- no hosted or external sandbox provider.

## Slice P13: Platform-Native Sandbox Direction

Purpose: follow the Codex local sandbox direction rather than making Docker the default
execution boundary for desktop/local Ling.

Target behavior:

- add a `platform_native` sandbox profile kind for OS-enforced local sandboxing;
- select the concrete enforcement adapter by host platform:

  - macOS: native app/container or sandbox-exec-equivalent constraints where available;
  - Linux: namespace/seccomp-style process and filesystem boundaries where available;
  - Windows/WSL: platform-native filesystem and process isolation options, with explicit
    readiness blockers when unavailable.

- keep network disabled by default and model any network escape as a separate approval or
  allowlist gate;
- keep workspace writes outside the sandbox boundary as imported artifacts, not direct
  runtime truth;
- preserve the existing Ling approval model: sandbox readiness never grants tool execution
  authority.

Implementation status:

- daemon config now has a `sandbox.platformNative` shape with `enabled`,
  `artifactImportRoot`, `networkPolicy`, and a macOS `sandbox-exec` path override;
- `packages/daemon/src/runtime/sandbox/platform-native.ts` implements a fail-closed
  platform-native doctor and run-plan builder:

  - macOS verifies `sandbox-exec` availability and builds a disabled-network Seatbelt
    profile plan;
  - Linux and Windows/WSL intentionally return unsupported-platform diagnostics until
    their concrete OS adapters are implemented;
  - artifact import roots must live under `.ling/artifacts/sandbox/platform-native`;
  - allowlist networking remains blocked until an OS-specific network/proxy enforcement
    design lands.

- Pi runner sandbox binding is explicit via `runners.pi.sandboxBinding.enabled`. When
  enabled, runs require platform-native readiness before the runner starts and receive a
  sandbox profile/manifest/session DTO;
- the binding does not yet move embedded Pi execution into a sandboxed child process.
  That remains a separate execution-wrapper slice because the current Pi adapter runs
  in-process inside the daemon.

Acceptance:

- `platform_native` profiles use the same fail-closed readiness blocker family as other
  sandbox profiles;
- missing OS enforcement blocks readiness instead of falling back silently to
  `local_unix`;
- runner binding stays disabled until platform-native artifact import, network policy,
  and approval interception pass conformance;
- current runner binding is readiness/DTO gated only; real OS-enforced runner execution
  still requires a child-process/tool-execution wrapper;
- Docker remains optional and cannot become the default just because its adapter exists.

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
| P10 runner-native hydration design | no | optional | no | runner capability review |
| P11 runner hydration conformance adapter | required | no | no | conformance fake runner |
| P12 optional Docker sandbox backend adapter | required | no | no | Docker doctor/run-plan unit tests |
| P13 platform-native sandbox direction | required | optional | no | OS readiness diagnostics |

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
- P10 can keep runner hydration unsupported; P8/P9 daemon/API/Web materialization still
  works as a non-runner control surface.

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
| Runner-native tool hydration | Let only conformance-verified runners request daemon-hydrated schemas; never let runners self-load MCP/plugin schemas or treat hydration as approval. | Brokered capability / policy-preserving lazy loading | P10 start |
| First hydration runner | Implement fake conformance coverage first, then wire embedded Pi behind a feature flag. | Characterization test / adapter conformance | P11 start |
| Hydrated schema DTO | Add a runner-only DTO for sanitized schema payloads; keep P8/P9 Web/API responses as bounded summaries. | Interface segregation / least privilege | P11 start |
| First default sandbox backend | Target platform-native local sandboxing after contracts; keep `local_unix` for development diagnostics only and Docker as an explicit opt-in adapter. | Codex-like local sandbox / capability adapter | P13 start |

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
- P10 is the first point where deferred loading may become model-visible. That boundary
  belongs in the runner adapter contract, not in Web or ad hoc prompt assembly.
- P11 should prove the contract with a fake runner before touching embedded Pi. That keeps
  prompt changes, approval gates, and materialization idempotency testable in isolation.
- Runner-only DTOs keep prompt payloads separate from evidence payloads. This preserves
  P8/P9's no-raw-schema evidence boundary while still letting verified runners receive
  schemas for the next model turn.
- Platform-native sandboxing is the better default for Ling desktop/local usage because it
  matches Codex's local model: OS-enforced filesystem/process/network boundaries plus
  approval gates, without requiring Docker Desktop or changing the user's local workflow.
  Docker remains useful as an optional adapter, but it should not define the default
  product path.

## Remaining Implementation Gates After P9

Resolved gates:

- trace projection ownership: pure core projection plus daemon enrichers landed in P1;
- handoff storage: normalize existing channel/workflow records at read-model boundaries,
  defer unified-table migration;
- P8/P9 materialization: keep daemon/API/Web-only until a runner advertises verified
  hydration support.

Open gates:

1. Embedded Pi hydration is implemented behind `runners.pi.toolHydration` gates. The
   remaining gate is product rollout: decide which workspaces may enable the flag by
   default.
2. Hydrated schemas use a runner-only DTO and do not expand P8/P9 public summary
   responses. The remaining gate is UI/product copy for exposing when a runner loaded
   tools during a turn.
3. Platform-native sandbox readiness is implemented for macOS `sandbox-exec` run plans and
   Pi readiness DTO binding. The remaining gate is real OS-wrapped execution: the embedded
   Pi process still runs in daemon process space until a child-process/tool-execution
   wrapper lands.
4. Linux/Windows platform-native adapters remain unsupported and fail closed.

Current P10 answer: expose deferred loading to runner prompts only through a
conformance-verified runner hydration capability. P8/P9 materialization stays summary-only
for public API/Web responses; runner-only hydration may carry schemas to the active runner
turn.

Current P11/P12/P13 decision: P11 uses fake conformance coverage before embedded Pi, P12
keeps Docker as an optional disabled adapter, and P13 uses Codex-like platform-native
local sandboxing as the default direction. Current P13 is readiness/run-plan/binding only;
OS-wrapped execution is the next sandbox slice.

## Post-P13 Follow-Up Plan

The next work should not reopen the Docker decision or start a Desktop shell. The product
direction is:

1. keep the canonical local service checkout stable;
2. harden platform-native sandbox policy and evidence;
3. make runner-native hydration observable before defaulting it;
4. keep Desktop compatibility as an API/control-surface constraint until Web product
   surfaces settle.

### P14: Platform-Native Sandbox Policy And Evidence

Purpose: turn P13's platform-native doctor/run-plan foundation into a product-ready local
sandbox posture without claiming isolation that the runner does not yet enforce.

Codex design borrowed:

- separate agent freedom from host-enforced boundaries;
- represent the selected boundary as a policy profile, not as ad hoc prompt text;
- fail closed when the host cannot prove the policy;
- keep approvals as the escape hatch for operations outside the sandbox posture.

Work:

1. Add first-class platform-native policy profile ids:

   - `read_only`;
   - `workspace_write`;
   - `trusted_local`;
   - `danger_full_access`.

2. Extend sandbox readiness diagnostics with policy-level blockers:

   - `sandbox_policy_unverified`;
   - `sandbox_os_unsupported`;
   - `sandbox_execution_wrapper_missing`.

3. Record conformance evidence for each backend/profile pair:

   - allowed read succeeds;
   - blocked write fails;
   - blocked network fails when network policy is disabled;
   - artifact import lands under the Ling artifact root;
   - raw secret-looking values are rejected or converted to refs;
   - evidence stores only bounded summaries and opaque refs.

4. Keep Linux and Windows platform-native adapters fail-closed until they have real host
   enforcement and conformance evidence. Their UX should be explicit: unsupported host,
   no sandbox claim, and no runner binding.

5. Keep embedded Pi sandbox binding disabled by default until execution moves through a
   child-process/tool-execution wrapper. Passing a sandbox DTO into an in-process runner is
   readiness information, not isolation.

Acceptance:

- doctor output names the selected policy profile and every blocking reason;
- Web/API readiness surfaces can show policy and evidence summaries without raw manifests;
- macOS platform-native keeps producing run plans and conformance evidence;
- Linux/Windows return explicit unsupported blockers;
- no sandbox readiness result grants tool execution permission.

Non-goal:

- no Docker default path;
- no hosted sandbox provider;
- no Desktop shell implementation;
- no claim that embedded Pi is OS-isolated until the process wrapper lands.

### P15: Runner Hydration Defaulting And Observability

Purpose: make runner-native hydration usable by default for verified runners without
turning schema hydration into hidden prompt injection or tool execution authority.

Feature meaning:

- the runner starts with a compact tool catalog, not every schema;
- when the model asks to use a tool family, the runner sends a hydration request to the
  daemon;
- the daemon applies policy, budget, idempotency, and conformance checks;
- only a verified runner receives sanitized runner-only schema payloads for the active
  turn;
- durable Web/API evidence stores summaries, not raw schemas.

Rollout:

1. Keep `runners.pi.toolHydration.enabled` disabled by default for general workspaces.
2. Enable by default only when all are true:

   - runner capability is `daemon_hydrated`;
   - conformance is passed for the installed runner version;
   - the workspace approval policy can be projected into hydration decisions;
   - hydration evidence appears in run diagnostics;
   - failure fallback is model-visible and fail-closed.

3. Add Web observability before broad defaulting:

   - `load_tools` request count;
   - accepted/rejected status;
   - policy rejection reason;
   - budget rejection reason;
   - hydrated namespace/tool count;
   - schema hash or descriptor id, never raw schema;
   - whether a later tool call used a hydrated descriptor;
   - approval state for the actual execution.

4. Define fallback behavior:

   - policy denied: return a model-visible denial and no schema;
   - over budget: return a model-visible budget denial and no schema;
   - unsupported runner: omit hydration tools and keep the existing prompt path;
   - daemon hydration failure: continue the run without hydrated schemas when possible;
   - execution request for an unhydrated or denied tool: reject before approval.

Acceptance:

- hydration defaulting cannot bypass `allow`/`ask`/`deny`;
- Web can explain why a tool was loaded, rejected, or unavailable;
- successful hydration is idempotent and evidence-bounded;
- runner prompt size improves for large tool catalogs;
- disabling hydration returns to the existing non-hydrated runner behavior.

### Desktop Compatibility Boundary

Desktop is needed eventually, but it should not be implemented before Web product surfaces
settle. Current work should only preserve compatibility:

- daemon APIs use structured DTOs instead of browser-only assumptions;
- local service status exposes manager type, PID, URL, log path, and working directory;
- approval, sandbox, and hydration evidence are available through daemon APIs that a
  Desktop shell can render later;
- LaunchAgent/service repair stays a local-service-manager concern, not Web-only logic;
- Desktop-specific permission UI is deferred until the Web approval/sandbox surfaces are
  stable enough to reuse.
