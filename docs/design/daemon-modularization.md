# Daemon Modularization

## Purpose

This document records the next daemon refactor plan. The goal is to make
`packages/daemon` maintainable before adding more external work orchestration,
runtime diagnostics, desktop control surfaces, MCP integration, and provider/media
capabilities.

Pressure points at the start of this refactor:

- `packages/daemon/src/index.ts` was 15,812 lines before the first extraction slice.
  After the shared/runtime/MCP/provider/memory/skills/task CRUD/channel CRUD/channel
  proposal/channel decision/channel handoff/channel context summary/channel brief and
  channel workflow collection/item/steps, link preview, attachment, and message route
  extraction plus teammate collection/item, channel membership, memory-scope, skill
  binding, MCP binding, persona draft, task projection, activity, direct-thread, and
  direct-message collection/stream/private attachment/avatar/hard-delete route
  extraction plus task run, workflow step start, and media job route-shell extraction,
  plus external work list/detail/status/background list-stop and action list/detail
  route extraction, external work setup/secret/action request parser extraction, and
  external work workflow/secret route-shell and helper extraction, and external work
  background start route-shell extraction, external work import/poll/reconcile/CI request
  parser extraction, external work action propose/cancel route-shell extraction, external
  work workflow/token helper extraction, external work import/poll/reconcile/ordinary CI
  route-shell extraction, external work background scheduler registry extraction, and CI
  triage run route-shell extraction behind an explicit run callback, plus external work
  action execute route-shell extraction behind explicit runtime/action hooks, and media
  executor extraction behind explicit runtime/approval hooks, plus run request schema
  extraction, run artifact helper extraction, run approval helper extraction, and run
  approval plus run/artifact route-shell extraction, plus run concurrency seam
  extraction, run provider config seam extraction, and run MCP access seam extraction,
  plus queued-run conflict seam extraction, run terminal helper extraction, and memory
  prompt helper extraction and dead linked-task helper removal, plus runtime work-unit
  terminal/cancel/resource-release helper extraction, runtime/work-unit route-shell
  extraction, run cancellation helper extraction, state-transition diagnostics route
  extraction, secret-status route extraction, runtime work-unit start helper extraction,
  assistant-text/prompt/proposal/teammate-identity helper extraction, channel/direct AI
  reply orchestration extraction, run-event work-unit projection extraction, run
  orchestrator extraction, run intervention/continuation route extraction, session
  permission snapshot handling, and async channel AI reply background completion, daemon
  context extraction, route dispatcher extraction, and keychain secret-store extraction,
  it is down to 161 lines.
- The file owns daemon startup, dependency construction, extension registry setup,
  lifecycle cleanup, and public exports. HTTP dispatch now lives in
  `server/router.ts`; run orchestration lives in `features/runs/orchestrator.ts`; the
  system keychain secret store lives in `features/providers/keychain-secret-store.ts`.
- `packages/daemon/src/cli.ts` is only 26 lines, and `packages/daemon/src/index.ts` is
  now a small public entrypoint rather than the daemon behavior sink.
- Future changes to one capability should start in the relevant feature module or in
  `server/router.ts` for route ordering and cross-feature hook wiring.

This is a behavior-preserving modularization. It is not a rewrite.

## Goals

- Keep the daemon API, request bodies, response shapes, SSE events, and persisted state
  behavior unchanged.
- Keep `node:http` as the serving layer for the first refactor slice.
- Make `index.ts` a small composition root that wires config, dependencies, context,
  router modules, and daemon lifecycle.
- Split daemon code by product capability first, not by generic technical buckets.
- Keep runtime ownership in the daemon. Web, desktop, and CLI remain control surfaces.
- Keep the Pi runner behind `packages/runner-pi` and the existing `RunnerAdapter`
  boundary.
- Preserve approval policy, provider preflight, MCP access checks, resource leases,
  runtime semaphore behavior, idempotency, and artifact redaction.
- Make later changes easier to test with narrow module-level coverage.

## Non-Goals

- No HTTP framework migration in the first slice.
- No API contract changes.
- No SQLite schema change.
- No store package split.
- No provider model redesign.
- No switch from embedded `@earendil-works/pi-coding-agent` library mode to the Pi CLI.
- No visual or Web UI changes.
- No broad cleanup of runtime files, generated artifacts, or local workspace state.

## Current Shape

The daemon currently has several distinct systems in one process, split across feature
modules with a central route dispatcher:

| Area | Current examples |
| --- | --- |
| Startup and composition | `createDaemonServer`, default config, extension registry |
| HTTP routing | `server/router.ts` dispatcher and `server/routes.ts` route matching helpers |
| Runs | `handleRun`, `executeRunRequest`, cancellation, approvals, artifacts |
| Runtime | `RuntimeSupervisor`, `ActiveRunRegistry`, work unit diagnostics |
| Channels | channel CRUD, messages, proposals, workflows, handoffs, decisions |
| Teammates | teammate CRUD, bindings, persona draft, direct messages |
| Providers | provider presets, preflight, secret resolution, model listing |
| MCP | MCP broker, server checks, tool sync, tool access snapshots |
| External work | GitHub/Linear import, poll, reconcile, actions, CI triage, scheduler |
| Media | media jobs, live vendor adapters, cost approval, media artifacts |
| Memory and skills | memory CRUD/recall, skill import drafts, skill registry projection |
| Shared utilities | request parsing, response helpers, path checks, content type inference |

The remaining risk is not one giant entrypoint anymore. The main coupling point is now
the centralized route order and explicit hook wiring in `server/router.ts`.

## Target Structure

```text
packages/daemon/src/
  index.ts
  config.ts
  context.ts
  errors.ts

  server/
    create-server.ts
    router.ts
    routes.ts
    http.ts

  runtime/
    active-runs.ts
    routes.ts
    supervisor.ts
    work-units.ts
    store-registry.ts

  features/
    runs/
      routes.ts
      orchestrator.ts
      interventions.ts
      concurrency.ts
      cancellation.ts
      work-units.ts
      approvals.ts
      artifacts.ts
      schemas.ts

    channels/
      routes.ts
      ai-replies.ts
      ai-prompts.ts
      ai-proposals.ts
      messages.ts
      attachments.ts
      link-previews.ts
      workflows.ts
      schemas.ts

    teammates/
      routes.ts
      direct-replies.ts
      direct-messages.ts
      direct-prompts.ts
      identity.ts
      persona.ts
      activity.ts
      schemas.ts

    providers/
      routes.ts
      preflight.ts
      models.ts
      secrets.ts
      schemas.ts

    mcp/
      routes.ts
      broker.ts
      transport.ts
      tool-access.ts
      schemas.ts

    external-work/
      routes.ts
      workflow.ts
      github.ts
      linear.ts
      background-scheduler.ts
      actions.ts
      ci-triage.ts
      artifacts.ts
      schemas.ts

    media/
      routes.ts
      executor.ts
      approvals.ts
      artifacts.ts
      schemas.ts

    memory/
      routes.ts
      schemas.ts

    skills/
      routes.ts
      import-drafts.ts
      registry.ts
      schemas.ts

  shared/
    request.ts
    response.ts
    assistant-text.ts
    path.ts
    validation.ts
    artifacts.ts
    time.ts
```

`index.ts` should become the stable public entrypoint for `startDaemon`,
`createDaemonServer`, public daemon types, and default config re-exports.

## Remote Merge Notes

The 2026-06 remote merge added run-session controls while daemon modularization was in
progress. The merged shape keeps those behaviors out of `index.ts`:

- Session permission modes and effective policy snapshots are parsed in run/task schemas
  and resolved inside `features/runs/orchestrator.ts` before work units and runs are
  persisted.
- Full access confirmation remains enforced at the run orchestration boundary, so direct
  `/runs` requests and task-run bridge requests share the same safety check.
- Run interventions and continuation runs live in `features/runs/interventions.ts`; the
  route dispatcher only wires HTTP routes and the `afterRunTerminal` continuation hook.
- Cancellation still has a small compatibility helper, but pending run approvals are
  cancelled before the run reaches a terminal cancelled state.
- Channel AI replies create a pending message synchronously in
  `features/channels/ai-replies.ts` and finish the runner work in the background, so
  message persistence is decoupled from model latency or provider blockage.

## Architectural Pattern

Use a small composition root plus feature modules.

```text
index.ts
-> createDaemonServer(config, dependencies)
-> createDaemonContext(...)
-> createRouter()
-> registerRuntimeRoutes(router, ctx)
-> registerRunRoutes(router, ctx)
-> registerChannelRoutes(router, ctx)
-> registerExternalWorkRoutes(router, ctx)
-> server listens through node:http
```

The pattern has four rules:

1. Route modules translate HTTP requests into typed inputs and call feature services.
2. Feature services own orchestration and durable state transitions for their capability.
3. Shared helpers stay generic and must not import feature modules.
4. Runtime ownership stays centralized under `runtime/`; features request work through
   explicit runtime and store boundaries.

## Extraction Contract

Each extraction slice must preserve behavior first and reduce coupling second. A slice is
acceptable only when it follows these rules:

- Move one boundary at a time. A route extraction should not also redesign store writes,
  runner options, SSE events, or route precedence.
- Keep parser error strings stable unless the affected tests and Web behavior are updated
  in the same change.
- Move schema parsing with the route handler that uses it, so feature request validation
  stays close to the HTTP surface.
- Do not let feature modules import `index.ts`. If a route needs run orchestration or
  cross-feature runtime hooks, pass an explicit callback from `server/router.ts`.
- Keep route modules thin: read the request, validate input, call stores or feature
  services, and write the response.
- Keep shared modules feature-agnostic. `shared/` can know about generic JSON, paths,
  redaction, markdown, and validation, but not about channels, runs, media, or external
  work.
- Keep runtime modules feature-agnostic. They own leases, semaphores, active runs, and
  diagnostics, but not product-specific state transitions.

## Daemon Context

Route modules should receive one explicit context object instead of a long argument list.

```ts
export interface DaemonContext {
  readonly config: ResolvedDaemonConfig;
  readonly runner: RunnerAdapter;
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly externalSecretStore: ExternalSecretStore;
  readonly mcpBroker: McpBroker;
  readonly externalWorkFetch?: typeof globalThis.fetch;
  readonly backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry;
}
```

The context should be built once in `createDaemonServer`. Tests can pass a partial or
mocked context through existing dependency seams.

## Router Shape

Keep the first router local and small. Do not introduce Express or Fastify just to split
files.

Suggested minimum API:

```ts
router.get("/health", handleHealth);
router.all("/channels", handleChannelsCollection);
router.match(parseChannelRoute, handleChannelRoute);
```

The router should preserve:

- Current route precedence.
- Current 404 and 405 behavior.
- Current CORS and OPTIONS behavior.
- Current direct `ServerResponse` streaming for `/runs` and other SSE flows.
- Current query parsing and `cwd` requirements.

## Feature Boundaries

| Feature | Owns | Does not own |
| --- | --- | --- |
| `runs` | run creation, SSE event stream, cancellation, approval bridge, artifact extraction | provider CRUD, channel CRUD |
| `runtime` | runtime lock, startup reconciliation, work unit diagnostics, active run registry | feature-specific business decisions |
| `channels` | channels, messages, proposals, attachments, previews, briefs, decisions, handoffs, workflows | runner internals |
| `teammates` | teammate CRUD, bindings, direct messages, persona draft, activity projection | channel workflow state machine |
| `providers` | presets, preflight checks, model list, provider secrets | generic secret store implementation |
| `mcp` | server transport, checks, tool sync, tool access snapshots, tool call bridge | teammate binding policy outside MCP access |
| `external-work` | workflow file parsing, GitHub/Linear import and poll, actions, CI triage, background scheduler | core work unit state machine |
| `media` | media job execution, media cost approval, media artifacts | generic run artifact extraction; runtime terminal helpers |
| `memory` | memory CRUD, recall, used-memory event listing | runner prompt assembly beyond memory prompt text |
| `skills` | skill import drafts, registry projection, teammate skill binding validation | runner tool implementation |

## Migration Order

1. Move pure shared utilities:
   - `errors.ts`
   - `shared/request.ts`
   - `shared/response.ts`
   - `shared/path.ts`
   - `shared/validation.ts`
2. Move config and public types:
   - `config.ts`
   - `context.ts`
   - `server/create-server.ts`
3. Move runtime classes:
   - `RuntimeSupervisor`
   - `ActiveRunRegistry`
   - `RunStoreRegistry`
   - work unit diagnostics helpers
4. Move MCP and provider modules. These have clear boundaries and useful tests.
5. Move memory and skills modules.
6. Move channels, teammates, and tasks. Keep route behavior stable while splitting.
7. Move external work. Split scheduler, workflow file handling, source adapters, action
   execution, and CI triage separately.
8. Move media jobs and media artifacts.
9. Split runs last. `executeRunRequest` is the highest-risk state machine and should only
   move after shared context, runtime, approval, MCP, provider, and artifact boundaries
   are stable.

Each step should be a mechanical extraction when possible. Do not mix behavior changes
with module moves.

## Next Slice Plan

The composition-root slice is complete. The next useful slices should reduce
`server/router.ts` coupling without changing route precedence or runtime hook semantics.

1. Router grouping helpers
   - Extract route-group functions only when the current `if` order can be preserved
     mechanically.
   - Keep CORS/OPTIONS, 404/405 responses, and `/runs` SSE streaming behavior in the
     same observable order.
2. Hook factory cleanup
   - Move repeated run/external-work/media callback assembly into small private helpers
     inside `server/router.ts` before considering another file split.
3. Module-level coverage
   - Add focused tests around route precedence, `/runs` ready SSE behavior, workflow
     step start, CI triage run bridge, media execution bridge, and external work action
     execution before further router restructuring.

## Implementation Status

Current slice:

- `config.ts` owns `DaemonConfig`, `ResolvedDaemonConfig`, `defaultDaemonConfig`, and
  `resolveConfig`.
- `context.ts` owns daemon dependency interfaces and request-time wiring context:
  `RunnerAdapter`, `McpBroker`, `ExternalSecretStore`, `DaemonDependencies`, and
  `DaemonContext`.
- `errors.ts` owns shared daemon HTTP errors.
- `shared/request.ts` owns JSON body reading.
- `shared/response.ts` owns JSON, SSE, and CORS response helpers.
- `shared/path.ts` owns root containment and artifact path normalization helpers.
- `shared/http.ts` owns bounded response text reads.
- `shared/approval-profile.ts` owns skill approval profile parsing.
- `shared/markdown.ts` owns markdown frontmatter, title, and first-paragraph helpers.
- `shared/redaction.ts` owns text redaction for provider, run, and media errors.
- `shared/assistant-text.ts` owns generic assistant response text fallback extraction
  used by channel and direct AI replies.
- `shared/time.ts` owns timestamp slug formatting used by artifact and attachment
  filenames.
- `shared/validation.ts` owns the generic record guard, common JSON field readers, URL
  validation, and undefined-field pruning.
- `runtime/active-runs.ts`, `runtime/routes.ts`, `runtime/store-registry.ts`,
  `runtime/work-units.ts`, and `runtime/supervisor.ts` own runtime registry, runtime and
  work-unit HTTP route shells, state-transition diagnostics, store registry, work unit
  diagnostics, stale reconciliation, terminal/cancel transitions, semaphore/lease
  cleanup, runtime work-unit creation/claim/start transitions, the default runner id,
  and runtime lock supervision. Work-unit route cancellation reaches the run cancellation
  state machine through an explicit callback supplied by `server/router.ts`.
- `server/router.ts` owns the central HTTP dispatcher, CORS/OPTIONS handling, route
  precedence, 404/405 fallthroughs, and explicit cross-feature hook wiring through
  `DaemonContext`.
- `server/routes.ts` owns pure path parser helpers and single-segment route matching.
- `features/mcp/broker.ts` owns the default MCP broker, MCP protocol operations,
  HTTP fallback tool listing, SDK tool conversion, and runner-facing tool result
  conversion.
- `features/mcp/transport-factory.ts` owns MCP SDK transport construction from
  server config plus trusted secret resolution.
- `features/mcp/stdio-launcher.ts` owns stdio child process placement and
  `StdioClientTransport` construction.
- `features/mcp/status.ts` owns runtime status snapshot construction and projection
  into legacy status badges.
- `features/mcp/routes.ts` owns MCP server, tool listing, check, sync, status,
  update, and delete HTTP handlers. The removed raw-secret endpoint is represented
  only as a `410 Gone` compatibility response.
- `features/mcp/secrets.ts` owns MCP server public projection and secret ref/status
  helpers. It must not read or return raw MCP secret values.
- `features/mcp/schemas.ts` owns MCP server create/update request parsing and MCP
  transport/status validation.
- `features/providers/routes.ts` owns provider preset, draft check, model listing,
  `/secrets/status`, and provider secret HTTP handlers.
- `features/providers/schemas.ts` owns provider preset create/update parsing, provider
  model-list request parsing, local API-key update mapping, and provider shape
  validation.
- `features/providers/secrets.ts` owns provider public projection, local provider
  secret references, draft-secret resolution, and provider secret status/lookup.
- `features/providers/keychain-secret-store.ts` owns the macOS system keychain-backed
  default `ExternalSecretStore` used by daemon dependency construction.
- `features/providers/preflight.ts` owns provider static/live preflight checks.
- `features/providers/models.ts` owns provider model discovery and response parsing.
- `features/memory/routes.ts` owns memory object CRUD, recall, and used-memory event
  HTTP handlers.
- `features/memory/prompt.ts` owns the scoped used-memory prompt renderer shared by
  runs, channel replies, and teammate direct replies.
- `features/memory/schemas.ts` owns memory object create/update parsing, memory recall
  request parsing, and memory query validation.
- `features/skills/routes.ts` owns skill registry, import draft, publish, and archive
  HTTP handlers.
- `features/skills/schemas.ts` owns skill import draft parsing for JSON and Markdown
  sources.
- `features/skills/registry.ts` owns effective skill registry projection, executable
  skill listing, and teammate skill binding validation.
- `features/channels/routes.ts` owns `/channels` collection and `/channels/:id` item
  CRUD HTTP handlers plus channel execution proposal, decision, and handoff
  collection/item HTTP handlers, plus context summary collection/item and channel brief
  HTTP handlers.
- `features/channels/workflows.ts` owns channel workflow collection/item HTTP handlers,
  `/handoffs/:id/workflow`, workflow steps collection handlers, and ordinary workflow
  step item GET/PATCH handlers plus `/steps/:id/start`. Step start validates and starts
  runs through explicit callbacks supplied by `server/router.ts`; it does not import the
  daemon entrypoint or own `executeRunRequest`.
- `features/channels/link-previews.ts` owns channel link preview collection/item HTTP
  handlers plus preview fetching, redirect handling, HTML metadata parsing, and private
  network blocking.
- `features/channels/attachments.ts` owns channel attachment collection/item HTTP
  handlers plus attachment file persistence, content serving, deletion, content-type
  inference, and the teammate private attachment helper shared with teammate private
  attachment routes.
- `features/channels/ai-replies.ts` owns channel AI reply orchestration, including
  pending reply creation, channel reply work-unit startup, provider resolution, memory
  recall audit, runtime progress projection, terminal message updates, and hidden task
  proposal creation.
- `features/channels/ai-prompts.ts` owns channel discussion prompt formatting.
- `features/channels/ai-proposals.ts` owns hidden `<ling_task_proposal>` extraction from
  AI channel replies.
- `features/channels/messages.ts` owns channel message collection HTTP handlers and
  delegates AI reply creation through an explicit callback supplied by
  `server/router.ts`.
- `features/channels/schemas.ts` owns channel create/update parsing, channel CRUD
  runtime policy validation, channel execution proposal create/update/status parsing, and
  channel decision, handoff, context summary create/update/status, channel brief, and
  workflow create/update/step, link preview, attachment, and message parsing. Workflow
  step start parsing also lives here; run orchestration is injected into the route
  handler from `server/router.ts`.
- `features/channels/protocol.ts` owns channel-local protocol validation helpers that
  need to be shared by the remaining channel subroutes, including brief reference
  validation and shared channel message asset ownership checks.
- `features/teammates/routes.ts` owns the `/teammates` collection and `/teammates/:id`
  item CRUD HTTP handlers plus teammate channel membership, memory-scope, skill binding,
  MCP binding, persona draft, task projection, and activity action handlers.
- `features/teammates/direct-replies.ts` owns teammate direct AI reply orchestration,
  including pending private reply creation, direct-reply work-unit startup, provider
  resolution, memory recall audit, streaming deltas, runtime progress projection, and
  terminal direct-message updates.
- `features/teammates/direct-messages.ts` owns teammate direct-thread, ordinary
  direct-message collection, and direct-message stream HTTP handlers. It delegates AI
  reply creation through an explicit callback supplied by `server/router.ts`.
- `features/teammates/direct-prompts.ts` owns teammate private chat prompt formatting.
- `features/teammates/identity.ts` owns builtin/custom teammate id resolution.
- `features/teammates/private-attachments.ts` owns teammate direct attachment, avatar,
  and hard-delete HTTP handlers. It reuses the existing channel attachment persistence
  and deletion helpers to preserve storage paths and cleanup behavior.
- `features/teammates/activity.ts` owns teammate activity projection assembly and local
  activity preview formatting.
- `features/teammates/schemas.ts` owns AI teammate create/update parsing and validation
  plus replace-channel-membership, replace-memory-scope, replace-skill-binding, and
  replace-MCP-binding parsing, plus persona draft, direct-message request, private
  attachment, and hard-delete request parsing.
- `features/tasks/routes.ts` owns `/tasks` collection and `/tasks/:id` item CRUD HTTP
  handlers plus the `/tasks/:id/run` route shell. The run action delegates
  `executeRunRequest` through an explicit callback supplied by `server/router.ts`.
- `features/tasks/schemas.ts` owns task create/update parsing and task status query
  validation plus task run request parsing. `executeRunRequest` now lives in the `runs`
  orchestrator slice.
- `features/runs/schemas.ts` owns top-level `/runs` create request parsing, inline
  provider parsing, run thinking-level validation, and the public `RunRequest` type,
  which `index.ts` re-exports for compatibility.
- `features/runs/artifacts.ts` owns run tool-output artifact extraction, generated-file
  artifact metadata, artifact content redaction/truncation, run artifact materialization,
  artifact content path safety, and artifact content-type inference.
- `features/runs/approvals.ts` owns run approval policy evaluation, approval profile and
  tool-list merging, stale approval expiry, approval decision event appends, runner
  approval request creation, wait/replay behavior, approval payload/risk projection, and
  side-effect/run-tool detection.
- `features/runs/concurrency.ts` owns run resource lease preparation, task claim
  validation, runtime semaphore acquisition, duplicate idempotency detection, queueable
  conflict errors, and run concurrency cleanup helpers.
- `features/runs/cancellation.ts` owns durable run cancellation, terminal cancellation
  summary writes, task cancellation projection, run lease release, and work-unit
  cancellation projection. Run and runtime route shells receive it as an explicit
  callback supplied by `server/router.ts`.
- `features/runs/providers.ts` owns provider preset versus inline-provider resolution
  for coding runs, provider capability checks, provider preflight enforcement, and
  secret resolution into runner provider config.
- `features/runs/mcp.ts` owns teammate MCP access snapshot assembly, runner MCP tool
  definition conversion, MCP tool-call authorization, and per-call MCP result redaction.
  Run snapshots include secret refs/status only; raw MCP values are resolved only inside
  trusted daemon tool-call paths.
- `features/runs/queue.ts` owns durable queued-run creation for queueable resource and
  semaphore conflicts.
- `features/runs/terminal.ts` owns terminal run summary writes and run failure event
  append/stream helpers.
- `features/runs/work-units.ts` owns run-event to work-unit state projection and
  runtime progress event projection for runner output.
- `features/runs/orchestrator.ts` owns `executeRunRequest`: run idempotency, durable run
  and work-unit creation, skill selection, memory prompt assembly, provider and MCP
  runner request assembly, SSE ready/result/error streaming, approval bridging,
  heartbeat/timeout cancellation, terminal summaries, resource lease release, runtime
  semaphore cleanup, and artifact extraction. It imports only explicit daemon runtime,
  store, runner, secret, and MCP dependencies; feature modules still do not import
  `index.ts`.
- `features/runs/routes.ts` owns the `/runs` create/list/detail/events/artifacts/cancel
  route shells, top-level artifact metadata/content route shells, plus the approval
  policy, approval list, approval detail, and approval decision HTTP route shells and
  their request/query validation. `/runs` create delegates actual execution through an
  explicit callback while run cancellation delegates durable state transition through an
  explicit callback.
- `features/media/routes.ts` owns `/media-jobs`, `/media-jobs/:id`, and media job
  artifact route shells. The run action delegates media execution through
  `features/media/executor.ts`.
- `features/media/schemas.ts` owns media job create parsing and media job status query
  validation.
- `features/media/provider.ts` owns media job provider capability checks and media
  adapter resolution.
- `features/media/executor.ts` owns media job execution, live cost approval gating,
  provider secret redaction, media runtime semaphore acquisition/release, media adapter
  execution, media artifact creation, media runtime artifact events, and media run
  responses. Runtime work-unit start, terminal transitions, and stale approval expiry are
  supplied through explicit hooks wired by `server/router.ts`; terminal/cancel transition
  helpers now live in `runtime/work-units.ts`.
- `features/external-work/routes.ts` owns the read-only `/external-work` list and
  `/external-work/:id` detail route shells plus external work view assembly.
- `features/external-work/status.ts` owns the read-only `/external-work/status` route,
  workflow file status projection, secret status projection, external work count
  projection, and background scheduler status projection.
- `features/external-work/background.ts` owns `/external-work/background` list,
  `/external-work/background/start`, and `/external-work/background/:id/stop` route
  shells.
- `features/external-work/background-scheduler.ts` owns the external work background
  scheduler registry, timer lifecycle, startup reconcile, repeated poll/reconcile ticks,
  duplicate scheduler detection, and stop/stopAll lifecycle controls.
- `features/external-work/actions.ts` owns `/external-work/actions/propose`, read-only
  `/external-work/actions` list, `/external-work/actions/:id` detail, and
  `/external-work/actions/:id/cancel` route shells plus the
  `/external-work/actions/:id/execute` route shell. Execute validates the local
  workflow, source kind, repository target, request body, and response shape, then
  delegates runtime work-unit start, artifact runtime events, terminal transitions, and
  live external mutation through explicit callbacks supplied by `server/router.ts`;
  terminal transition helpers now live in `runtime/work-units.ts`, and the feature still
  does not import the daemon entrypoint.
- `features/external-work/imports.ts` owns GitHub and Linear external work import route
  shells and external work evidence artifact creation.
- `features/external-work/sync.ts` owns GitHub/Linear external work poll route shells and
  the explicit reconcile route shell.
- `features/external-work/ci-triage.ts` owns GitHub CI triage list, detail, triage, and
  run bridge route shells. The run bridge starts a daemon run through an explicit callback
  supplied by `server/router.ts`; it does not import the daemon entrypoint or own
  `executeRunRequest`.
- `features/external-work/schemas.ts` owns external work list query validation for
  source kind, work item kind, scheduler status, and action list filters, plus
  setup/secret/background/import/poll/reconcile/action and CI request body parsing for
  the mutating route shells, including CI triage run parsing.
- `features/external-work/workflow.ts` owns `/external-work/workflow/configure`,
  `/external-work/secrets/configure`, and `/external-work/secrets/delete` route shells,
  WORKFLOW.md setup helpers, writable path validation, minimal workflow template
  generation, keychain secretRef normalization, external-work secret purpose mapping, and
  workflow secretRef update helpers.

The daemon entrypoint owns daemon lifecycle, extension registry setup, dependency
construction, and public exports. `server/router.ts` owns route order and cross-feature
hook wiring. Run, channel, direct-message, external-work, and media orchestration are
feature-owned.

## Testing and Verification

Run after each meaningful extraction:

```bash
corepack pnpm --filter @ling-stack/daemon typecheck
corepack pnpm --filter @ling-stack/daemon test
git diff --check
```

When a slice touches shared contracts or cross-package behavior, broaden to:

```bash
corepack pnpm typecheck
corepack pnpm test
```

Regression coverage must preserve:

- `/health` response.
- Provider preset create/update/delete/check/model-list behavior.
- MCP server check and tool sync behavior.
- Run creation, SSE ready event, run event persistence, and terminal summaries.
- Run cancellation before and during active execution.
- Approval request creation, approve, deny, expiry, and stream replay behavior.
- Resource lease and runtime semaphore conflict behavior.
- Channel message AI reply provider selection.
- Channel workflow step start behavior.
- Attachment and link-preview path safety.
- External work GitHub URL normalization, import, poll, reconcile, actions, CI triage,
  and background scheduler behavior.
- Media job cost approval and artifact creation.
- Runtime startup reconciliation of claimed/running/cancelling work units.

## Risks

- `executeRunRequest` combines storage, runner invocation, SSE streaming, approvals,
  memory recall, skill selection, MCP tool access, leases, semaphores, artifacts,
  heartbeat, timeout, and cancellation. It now lives in `features/runs/orchestrator.ts`;
  future changes must keep its event, response, and persisted state shapes stable.
- Route precedence is currently encoded by `if` order. A router table must preserve that
  order exactly.
- Shared helper extraction can accidentally change error messages. UI and tests may rely
  on those strings.
- External work has live-provider and local-file behavior. Refactors must preserve
  `WORKFLOW.md` path safety, secret redaction, and duplicate handling.
- Artifact helpers touch filesystem paths and secret redaction. They should move with
  narrow tests.
- Runtime supervisor changes can leave stale locks, leaked leases, or stuck semaphore
  slots if behavior changes during extraction.

## Acceptance Criteria

- `packages/daemon/src/index.ts` is reduced to a composition root and public exports.
- Each feature module has a narrow route file and feature-local helpers.
- The daemon API surface remains compatible with the current Web client and tests.
- Existing daemon tests pass without rewriting assertions around behavior.
- New code paths use explicit context instead of long positional argument lists.
- Follow-up feature work can change one capability without touching unrelated route,
  parser, or runtime code.

## Assumptions

- The daemon remains the only local runtime owner.
- SQLite remains the local-first durable store for this refactor.
- `packages/core` continues to own durable domain types and store interfaces.
- The Web client remains the primary consumer used for regression checks.
- Future desktop work should consume the same daemon API rather than calling runner or
  storage internals directly.
