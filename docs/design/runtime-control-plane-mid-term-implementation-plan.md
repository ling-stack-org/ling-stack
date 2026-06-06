# Runtime Control Plane Mid-Term Implementation Plan

## Purpose

This plan turns the daemon into the explicit Ling Runtime Control Plane:

```text
Web / CLI / desktop / future workers
-> shared API client
-> daemon control plane
-> run, memory, skills, approvals, providers, tools, MCP, runners, artifacts
```

The daemon should become the only writer and subscription owner for runtime state. This
prevents Web, CLI, background jobs, and future desktop clients from building separate
state models.

## Scope

In scope:

- define control-plane-owned state domains;
- define the first common snapshot and event subscription shape;
- move clients toward daemon-owned reads and subscriptions;
- preserve existing HTTP/SSE endpoints while adding shared control-plane views;
- prepare transport-agnostic processor/service boundaries for a future JSON-RPC or
  WebSocket adapter;
- make approval, provider, skill, memory, and run state observable through one daemon
  boundary.

Out of scope:

- Codex app-server JSON-RPC migration;
- implementing a `/rpc` or WebSocket JSON-RPC endpoint;
- remote multi-user server mode;
- distributed locking;
- replacing existing run-specific SSE streams;
- enabling `codex-app-server` as a runner backend.

## Control-Plane State Domains

| Domain | Source of truth | Current modules | Subscription need |
| --- | --- | --- | --- |
| Runs | `run_sessions`, `run_events`, active run registry | `features/runs/*`, `runtime/active-runs.ts` | high |
| Work units | work-unit tables and runtime supervisor | `runtime/work-units.ts`, `runtime/supervisor.ts` | high |
| Memory | memory tables, review policy, consolidation jobs | `features/memory/*` | medium |
| Skills | built-ins plus skill registry entries | `features/skills/*`, core skill packs | medium |
| Teammates | teammate tables and skill/memory/MCP bindings | `features/teammates/*` | medium |
| Approvals | approval policy and pending approval records | `features/runs/approvals.ts`, media approvals | high |
| Providers | provider presets, preflight status, secret refs | `features/providers/*` | medium |
| MCP | MCP server config, runtime status, synced tools | `features/mcp/*` | medium |
| Runners | runner registry and runtime settings | `runtime/runners.ts`, `runtime/runner-settings.ts` | low |
| Artifacts | artifact metadata and local content refs | `features/runs/artifacts.ts`, preview routes | medium |

## Control-Plane Invariants

- Clients do not open SQLite, inspect runtime files, or infer live state directly.
- Every mutating operation enters through a daemon route.
- Every side effect is attributable to actor, policy, approval, run/work unit, and
  timestamp.
- Secret values never appear in control-plane snapshots, events, logs, doctor output, or
  artifacts.
- Active runs keep immutable request, provider, skill, memory, MCP, and approval
  snapshots.
- Subscriptions are read-only. They never repair, refresh, approve, or start work.
- Domain failures are isolated: a provider preflight error must not make skills render as
  empty, and a skills refresh error must not hide run history.

## Future JSON-RPC Readiness

This mid-term slice must not implement JSON-RPC. It should make the later JSON-RPC
adapter cheap by keeping control-plane business logic independent of HTTP route files.

Required separation:

```text
HTTP route
-> control-plane processor/service
-> domain readers/writers
-> store/runtime registries
```

Future transport:

```text
JSON-RPC or WebSocket adapter
-> same control-plane processor/service
-> same domain readers/writers
-> store/runtime registries
```

Rules:

- HTTP routes parse URLs, query params, request bodies, and response status codes only.
- Domain snapshot assembly, event listing, event emission, redaction, and policy checks
  live in control-plane processors or services.
- Contracts live in `packages/contracts` before Web, CLI, or desktop clients consume
  them.
- Future JSON-RPC must not introduce a second state model, second approval path, or
  alternate secret resolver.
- Future JSON-RPC method names are reserved now but not exposed in this slice.

Reserved future method namespace:

```text
initialize
workspace.attach
workspace.detach
controlPlane.snapshot
controlPlane.events.list
controlPlane.subscribe
controlPlane.unsubscribe
runs.create
runs.cancel
skills.refresh
memory.reviewPolicy.get
memory.review
approvals.resolve
providers.check
registry.get
registry.refresh
```

The first implementation should prove that `controlPlane.snapshot` and
`controlPlane.events.list` can be called through internal processors. HTTP remains the
only public transport until a later transport slice adds session initialization,
capability negotiation, bounded queues, and compatibility tests.

## Proposed Shared Event Model

Add a daemon-owned workspace event stream alongside existing run-specific event streams.

New durable table:

```sql
CREATE TABLE control_plane_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  ts TEXT NOT NULL,
  domain TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX control_plane_events_workspace_seq
  ON control_plane_events(workspace_id, seq);
```

Event envelope:

```ts
interface ControlPlaneEvent {
  seq: number;
  workspaceId: string;
  cwd: string;
  ts: string;
  domain:
    | "runs"
    | "work_units"
    | "memory"
    | "skills"
    | "teammates"
    | "approvals"
    | "providers"
    | "mcp"
    | "runners"
    | "artifacts";
  entityType: string;
  entityId: string;
  action: string;
  data: Record<string, unknown>;
}
```

Initial event actions:

- `run.created`, `run.updated`, `run.cancelled`, `run.completed`;
- `work_unit.created`, `work_unit.transitioned`;
- `approval.created`, `approval.resolved`, `approval.expired`;
- `memory.candidate_created`, `memory.reviewed`, `memory.policy_updated`;
- `skill.registry_changed`, `teammate.skills_changed`;
- `provider.updated`, `provider.preflight_checked`;
- `mcp.server_updated`, `mcp.status_checked`, `mcp.tools_synced`;
- `runner.settings_updated`.

Do not duplicate every `run_event` token or output chunk into this table. It is a
workspace-level invalidation and audit stream, not a transcript stream.

## Per-Domain Event Payload Rules

Event `data` must be smaller than the source record. Treat it as invalidation and audit
metadata, not a copy of the mutated object.

Common event data:

```ts
interface ControlPlaneEventDataBase {
  readonly status?: string;
  readonly previousStatus?: string;
  readonly actorKind?: string;
  readonly actorId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly summary?: string;
}
```

Allowed first-slice event payloads:

| Action | Required data | Forbidden data |
| --- | --- | --- |
| `run.created` | `status`, `taskId`, `channelId`, `teammateId`, `providerPresetId`, `requestedSkillId` | prompt text, messages, tool output |
| `run.cancelled` | `previousStatus`, `status`, `reasonCode` | partial transcript |
| `run.completed` | `previousStatus`, `status`, `terminalAt`, `errorCode?` | assistant final text, artifact bytes |
| `work_unit.transitioned` | `previousStatus`, `status`, `runId?`, `blockedReason?` | worker stdout/stderr |
| `approval.created` | `ownerType`, `ownerId`, `actionType`, `risk`, `expiresAt?` | command body, diff body, preview text |
| `approval.resolved` | `previousStatus`, `status`, `decision`, `resolvedBy` | approval rationale free text beyond summary |
| `memory.candidate_created` | `scopeType`, `ownerId?`, `confidence`, `reasonCode` | memory body, source transcript |
| `memory.reviewed` | `previousStatus`, `status`, `decision`, `reviewedBy` | memory body |
| `memory.policy_updated` | `mode`, changed boolean field names | raw policy history with actor secrets |
| `skill.registry_changed` | `registryGeneration`, `changeType`, `skillId?` | imported source content |
| `teammate.skills_changed` | `teammateId`, `added`, `removed`, `disabled`, `enabled` counts | private teammate notes |
| `provider.updated` | `providerId`, `enabled`, `kind`, `api` | `apiKeyRef`, key value, headers |
| `provider.preflight_checked` | `providerId`, `ok`, `code`, `checkedAt` | provider request/response bodies |
| `mcp.status_checked` | `serverId`, `status`, `toolCount`, `missingSecretCount` | raw env, headers, tool schemas |
| `runner.settings_updated` | `defaultRunnerId`, `allowedRunnerCount` | process args, secret env |

If an action needs richer detail, persist that detail in the domain table or artifact
store and put only a ref id in `data`.

## Proposed Snapshot API

Add a batched read endpoint so clients can render a consistent workspace surface without
large `Promise.all` fanout.

```text
GET /control-plane/snapshot?cwd=/path/to/project&domains=runs,memory,skills,approvals,providers
```

Response:

```ts
interface ControlPlaneSnapshotResponse {
  cwd: string;
  workspaceId: string;
  generatedAt: string;
  latestEventSeq: number;
  domains: Record<string, ControlPlaneDomainSnapshot>;
}

interface ControlPlaneDomainSnapshot {
  ok: boolean;
  revision: number;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

Rules:

- each requested domain is isolated;
- partial failures return `ok: false` for that domain only;
- data must already be redacted for Web/CLI use;
- no secret resolution is allowed in snapshot generation unless an existing trusted
  daemon path already requires it;
- large domains use summaries and links to existing detail endpoints.

## Per-Domain Snapshot Payload Schemas

Snapshot payloads are read models, not direct table dumps. They must be small, redacted,
and stable enough for Web, CLI, and future desktop to share.

Common helper shapes:

```ts
interface ControlPlaneLink {
  readonly href: string;
  readonly label: string;
}

interface CountSummary {
  readonly total: number;
  readonly active?: number;
  readonly pending?: number;
  readonly failed?: number;
  readonly blocked?: number;
}
```

### `runs`

```ts
interface RunsDomainSnapshot {
  readonly activeRuns: readonly RunSummary[];
  readonly recentRuns: readonly RunSummary[];
  readonly stuck: {
    readonly count: number;
    readonly workUnitIds: readonly string[];
  };
  readonly links: {
    readonly recentRuns: ControlPlaneLink;
    readonly stuckWork: ControlPlaneLink;
  };
}

interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly providerPresetId?: string;
  readonly workUnitId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly latestEventSeq?: number;
  readonly errorCode?: string;
}
```

Rules:

- do not include prompt text, assistant text, tool output, or artifact content;
- include links to existing run detail routes when clients need transcript data;
- cancelled and stale-completion states are visible as status/error metadata only.

### `work_units`

This domain is optional for M3 but should use this shape when enabled:

```ts
interface WorkUnitsDomainSnapshot {
  readonly counts: CountSummary;
  readonly active: readonly WorkUnitSummary[];
  readonly queued: readonly WorkUnitSummary[];
  readonly stale: readonly WorkUnitSummary[];
}

interface WorkUnitSummary {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly runId?: string;
  readonly channelId?: string;
  readonly leaseId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHeartbeatAt?: string;
  readonly blockedReason?: string;
}
```

Rules:

- no runner prompt or output payloads;
- no lease token values;
- active work visibility is diagnostic only and must not allow state mutation.

### `skills`

```ts
interface SkillsDomainSnapshot {
  readonly registryGeneration: number;
  readonly counts: {
    readonly total: number;
    readonly builtin: number;
    readonly published: number;
    readonly draft: number;
    readonly archived: number;
  };
  readonly skills: readonly SkillRegistrySummary[];
}

interface SkillRegistrySummary {
  readonly id: string;
  readonly packId: string;
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly reviewStatus: string;
  readonly workspaceVisible: boolean;
  readonly updatedAt: string;
}
```

Rules:

- no full imported source content in the snapshot;
- built-ins and custom entries stay distinguishable;
- use `GET /skills` for complete registry entry details if needed.

### `teammates`

This domain is optional for M3 but needed before Web teammate settings move to snapshot.

```ts
interface TeammatesDomainSnapshot {
  readonly counts: CountSummary;
  readonly teammates: readonly TeammateSummary[];
}

interface TeammateSummary {
  readonly id: string;
  readonly displayName: string;
  readonly source: "builtin" | "user";
  readonly status: string;
  readonly defaultProviderPresetId?: string;
  readonly effectiveSkillCount: number;
  readonly blockedSkillCount: number;
  readonly memoryScopeCount: number;
  readonly mcpServerCount: number;
  readonly updatedAt: string;
}
```

Rules:

- no persona body, private message text, private attachment names, or private memory
  body text;
- use existing teammate detail routes for setup/editing workflows.

### `approvals`

```ts
interface ApprovalsDomainSnapshot {
  readonly policy: {
    readonly mode: string;
    readonly toolDecisionCounts: Record<string, number>;
    readonly allowedWritePathCount: number;
  };
  readonly pending: readonly ApprovalSummary[];
  readonly counts: {
    readonly pending: number;
    readonly highRisk: number;
    readonly expired: number;
  };
}

interface ApprovalSummary {
  readonly id: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly actionType: string;
  readonly risk: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly previewArtifactId?: string;
}
```

Rules:

- do not include full command strings, file diffs, prompt text, or raw approval preview
  content in the snapshot;
- include artifact ids for explicit detail fetches;
- resolving approvals remains a separate mutation route.

### `providers`

```ts
interface ProvidersDomainSnapshot {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly runnable: number;
    readonly preflightReady: number;
    readonly missingSecrets: number;
  };
  readonly providers: readonly ProviderSummary[];
}

interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly api: string;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
  readonly input: readonly string[];
  readonly runnable: boolean;
  readonly blocker?: string;
  readonly secretStatus: "configured" | "missing" | "unavailable" | "not_required";
  readonly secretRefKind?: "env" | "keychain";
  readonly lastCheck?: {
    readonly ok: boolean;
    readonly code: string;
    readonly checkedAt: string;
  };
}
```

Rules:

- never include raw API keys, `apiKeyRef` values, authorization headers, or provider
  request bodies;
- `secretRefKind` is allowed, but the ref name is not part of the snapshot;
- model lists stay behind explicit provider detail/model routes.

### `memory`

```ts
interface MemoryDomainSnapshot {
  readonly reviewPolicy: {
    readonly workspaceId: string;
    readonly mode: string;
    readonly autoActiveSameScope: boolean;
    readonly autoActiveUserExplicit: boolean;
    readonly requireManualForWorkspace: boolean;
    readonly requireManualForPersona: boolean;
    readonly requireManualForCrossScope: boolean;
    readonly quarantineSecretAdjacent: boolean;
    readonly updatedAt: string;
  };
  readonly promotionInbox: {
    readonly pending: number;
    readonly quarantined: number;
  };
  readonly recentCandidates: readonly MemoryCandidateSummary[];
}

interface MemoryCandidateSummary {
  readonly id: string;
  readonly scopeType: string;
  readonly ownerId?: string;
  readonly title: string;
  readonly status: string;
  readonly confidence: string;
  readonly reasonCode?: string;
  readonly createdAt: string;
}
```

Rules:

- candidate summaries may include title but not memory body/snippet by default;
- no source transcript, prompt, private teammate message, or cross-channel raw context;
- use promotion inbox and memory detail routes for reviewer-only content.

### `mcp`

This domain is optional for M3 but should follow this shape when added:

```ts
interface McpDomainSnapshot {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly failed: number;
    readonly missingSecrets: number;
    readonly syncedTools: number;
  };
  readonly servers: readonly McpServerSummary[];
}

interface McpServerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly status?: string;
  readonly toolCount: number;
  readonly missingSecretCount: number;
  readonly legacySecretMigrationRequired: boolean;
  readonly updatedAt: string;
}
```

Rules:

- no raw command env values, headers, tokens, cookies, or MCP tool input payloads;
- synced tool schemas may be fetched through existing MCP detail routes.

### `runners`

This domain is optional for M3 but should follow this shape when added:

```ts
interface RunnersDomainSnapshot {
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly runners: readonly RunnerSummary[];
}

interface RunnerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly experimental: boolean;
  readonly capabilities: readonly string[];
  readonly blocker?: string;
}
```

Rules:

- no runner internal process args, secret env, or raw runtime logs;
- disabled future adapters are visible only as capability/status metadata.

### `artifacts`

This domain is optional for M3 but should follow this shape when added:

```ts
interface ArtifactsDomainSnapshot {
  readonly counts: {
    readonly recent: number;
    readonly byKind: Record<string, number>;
  };
  readonly recent: readonly ArtifactSummary[];
}

interface ArtifactSummary {
  readonly id: string;
  readonly runId?: string;
  readonly title: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly contentHref: string;
}
```

Rules:

- snapshot includes metadata only;
- artifact bytes continue through existing artifact content endpoints;
- local paths must be normalized artifact refs, not absolute private filesystem paths.

## Proposed Event APIs

Polling endpoint:

```text
GET /control-plane/events?cwd=/path/to/project&afterSeq=0&limit=200&domains=runs,skills
```

SSE endpoint:

```text
GET /control-plane/stream?cwd=/path/to/project&afterSeq=0&domains=runs,skills,approvals
Accept: text/event-stream
```

SSE events:

```text
event: control_plane_event
data: {"seq":123,"domain":"skills","entityType":"registry","entityId":"default","action":"skill.registry_changed",...}

event: heartbeat
data: {"ts":"2026-06-06T00:00:00.000Z","latestEventSeq":123}
```

Rules:

- `afterSeq` provides reconnect support;
- per-client queues are bounded;
- slow clients are disconnected with a clear event instead of blocking writers;
- if history is compacted in a future slice, clients receive a `snapshot_required`
  event and must reload `/control-plane/snapshot`.

### SSE Queue And Backpressure Policy

Use explicit numbers in the first implementation so behavior is testable.

Polling:

- default `limit`: 200 events;
- max `limit`: 1000 events;
- invalid `limit` or `afterSeq`: `400 bad_request`;
- unknown domains are rejected with `400 bad_domain`;
- events are returned in ascending `seq` order;
- if `afterSeq` is older than retained history in a future compaction slice, return
  `409 snapshot_required` with the lowest available seq.

SSE:

- heartbeat interval: 15000 ms;
- initial replay limit: 1000 events;
- per-client live queue hard limit: 500 events;
- queue warning threshold: 400 events;
- coalescing starts at 400 queued events;
- disconnect if queue remains above 500 for 2 consecutive flush attempts;
- flush cadence: at most once every 100 ms per client;
- maximum serialized SSE event size: 64 KiB; larger domain details must be replaced by
  ref ids and links;
- idle clients still receive heartbeat events.

Coalescing rule:

```text
If queue length >= 400:
  keep all approval.* and run terminal events
  coalesce repeated registry/provider/memory invalidations by domain/entity/action
  append one coalesced event with summary.count
If queue length > 500 after coalescing:
  send event: slow_client_disconnect
  close stream
```

Writers must never wait on SSE clients. Event append goes to SQLite first; live delivery
is best-effort fanout from the durable event stream.

## Implementation Slices

### Slice M1: Event Append Infrastructure

Primary files:

- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/core/src/run-types.ts`
- `packages/core/test/channel-runtime-store.test.mjs`

Add store APIs:

```ts
appendControlPlaneEvent(input, now): ControlPlaneEvent
listControlPlaneEvents(options): ControlPlaneEvent[]
getLatestControlPlaneEventSeq(workspaceId): number
```

Keep writes inside the same transaction as the state mutation when practical. If a
secondary event write fails, the primary mutation should fail for core domains such as
approvals and runs because audit loss is worse than request failure.

### Slice M2: Domain Event Emission

Primary files:

- `packages/daemon/src/features/runs/*`
- `packages/daemon/src/features/memory/*`
- `packages/daemon/src/features/skills/*`
- `packages/daemon/src/features/teammates/*`
- `packages/daemon/src/features/providers/*`
- `packages/daemon/src/features/mcp/*`
- `packages/daemon/src/runtime/*`

Emit events at domain boundaries:

- run creation, cancellation, terminal transition;
- approval create/resolve/expire;
- memory candidate/review/policy changes;
- skill import publish/archive/refresh;
- teammate skill binding changes;
- provider preset mutations and preflight results;
- MCP server mutation/status/tool sync;
- runner setting changes.

Do not emit control-plane events from low-level helpers that cannot identify actor,
workspace, or entity context.

### Slice M3: Snapshot Route

Primary files:

- `packages/daemon/src/features/control-plane/routes.ts`
- `packages/daemon/src/features/control-plane/processors.ts`
- `packages/daemon/src/features/control-plane/snapshots.ts`
- `packages/daemon/src/server/router.ts`
- `packages/daemon/src/server/routes.ts`
- `packages/api-client/src/client.ts`
- `packages/api-client/test/client.test.mjs`

Implement `/control-plane/snapshot` with isolated domain readers.

HTTP route responsibilities:

- parse `cwd` and `domains`;
- call `buildControlPlaneSnapshot(...)`;
- map domain-level failures into the response body without failing the whole request.

Processor/service responsibilities:

- resolve workspace metadata;
- read each requested domain through isolated readers;
- compute `latestEventSeq`;
- redact domain payloads;
- return the transport-neutral `ControlPlaneSnapshotResponse`.

First supported domains:

- `runs`: active runs, recent runs, stuck summary;
- `skills`: effective registry and registry generation;
- `approvals`: pending approvals and policy summary;
- `providers`: provider preset readiness summary;
- `memory`: review policy, promotion inbox count, recent candidates.

Add `mcp`, `runners`, and `artifacts` after the first route is stable.

### Slice M4: Events And Stream Routes

Primary files:

- `packages/daemon/src/features/control-plane/routes.ts`
- `packages/daemon/src/features/control-plane/processors.ts`
- `packages/daemon/src/shared/response.ts`
- `packages/api-client/src/client.ts`

Implement JSON polling first, then SSE.

Use existing SSE helpers where possible, but do not couple workspace events to active
run execution sinks. Run-specific streams continue to serve transcript/progress events.

### Slice M5: Web And CLI Consumption

Primary files:

- `apps/web/src/api.ts`
- `apps/web/src/domains/*`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `packages/cli/src/doctor/checks.ts`

Move broad workspace refreshes to `/control-plane/snapshot` where it reduces fanout.

Client behavior:

- render partial domain errors inline instead of collapsing the whole settings page;
- subscribe to control-plane events for invalidation;
- keep existing detail fetches for large data;
- doctor may read snapshot summaries but remains read-only.

### Web And CLI Migration Order

Migrate broad read surfaces only after M1-M4 are stable. Do not change mutation routes
just because snapshots exist.

Order:

1. Add API client methods:
   - `getControlPlaneSnapshot(cwd, domains)`;
   - `listControlPlaneEvents(cwd, options)`;
   - `streamControlPlaneEvents(cwd, options)` after SSE lands.
2. Move CLI `doctor` to read snapshot summaries for `skills`, `memory`, `providers`,
   `approvals`, and runtime readiness while preserving existing route probes until
   snapshot health is proven.
3. Move Web settings overview to snapshot for:
   - provider readiness summary;
   - skill registry summary;
   - memory review policy and inbox counts;
   - pending approvals count.
4. Move workspace/dashboard sidebars to snapshot for active runs, stale work, and recent
   run counts.
5. Add event invalidation in Web:
   - `skills` events invalidate skills settings;
   - `providers` events invalidate provider readiness;
   - `approvals` events invalidate approval trays;
   - `memory` events invalidate memory review counters;
   - `runs` and `work_units` events invalidate runtime panels.
6. Keep detail pages on existing endpoints until their domain snapshot proves sufficient.
7. Remove duplicated `Promise.all` fanout only after the equivalent snapshot route has
   daemon/API-client tests and one Web smoke test.

Do not migrate:

- run transcript streaming;
- artifact content downloads;
- approval resolution mutations;
- provider key or secret editing;
- memory review mutations.

Rollback rule: every migrated Web/CLI surface must keep a small fallback to existing
detail endpoints for one release slice. A failing domain snapshot should degrade that
panel only, not hide the entire page.

### Slice M6: Governance And Redaction Audit

Before treating the daemon as the control plane, audit domain snapshots and events for
secret and approval leakage.

Checks:

- no raw provider keys;
- no MCP raw secret values;
- no unredacted external tokens;
- no private raw memory excerpts outside allowed memory surfaces;
- no approval bypass through direct domain endpoints;
- no stale run completion can overwrite cancelled state.

### Executable Redaction Audit Checklist

Add a shared redaction test helper for snapshots and events:

```ts
assertControlPlanePayloadRedacted(payload, forbiddenValues)
```

The helper should stringify the payload and assert that these values are absent:

- raw provider API key values;
- `apiKeyRef` full strings such as `env:LOCAL_RELAY_API_KEY` or `keychain:...`;
- bearer tokens, GitHub tokens, Linear tokens, cookies, authorization headers;
- MCP server raw env values and header values;
- approval preview body text for shell/write/edit actions;
- run prompt text, user message text, assistant message text, tool stdout/stderr;
- memory body/snippet/source transcript;
- teammate private message text, private attachment file names, private memory body;
- absolute artifact filesystem paths outside `.ling-stack/artifacts`;
- external-work webhook payload bodies and raw GitHub/Linear API responses.

Required test fixtures:

- provider with configured env and keychain refs plus a fake secret value;
- MCP server with missing and configured secret refs;
- pending approval with shell command preview and diff preview artifact;
- memory candidate with secret-adjacent body text;
- teammate private message and private attachment;
- run with prompt, assistant output, tool output, and artifact metadata;
- external work item with token-like evidence.

Required assertions:

- `GET /control-plane/snapshot` never includes forbidden values for any requested domain;
- `GET /control-plane/events` never includes forbidden values after mutations;
- SSE stream sends the same redacted event shape as polling;
- doctor JSON does not expose any forbidden value when it reads snapshot summaries;
- redaction failures fail tests before Web/CLI snapshots can ship.

Manual audit command before landing a control-plane slice:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
git diff --check
```

## Tests

Core:

```bash
corepack pnpm --filter @ling-stack/core test
```

Required test cases:

- control-plane event seq is monotonic;
- event listing respects `afterSeq`, `limit`, and domain filters;
- mutations append expected domain events;
- event payloads follow the allowed per-action field table;
- redaction helpers prevent secret-shaped fields from entering events.

Daemon/API client:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
```

Required test cases:

- snapshot returns requested domains only;
- each first-slice domain returns the documented payload schema;
- one failing domain does not fail the whole snapshot;
- events endpoint replays from `afterSeq`;
- invalid `afterSeq`, invalid `limit`, and unknown domains fail readably;
- event polling enforces default and max limits;
- SSE stream sends heartbeat and disconnects slow clients safely;
- SSE queue behavior covers warning threshold, coalescing, and slow-client disconnect;
- snapshot/events/SSE payloads pass the executable redaction checklist;
- approval/provider/memory/skills mutations emit expected invalidation events.

Web:

```bash
corepack pnpm --filter @ling-stack/web typecheck
```

Targeted browser smoke after UI adoption:

- Settings skills tab does not show `0 executable` because an unrelated memory route
  failed;
- provider readiness errors render in provider domain only;
- pending approvals update without full page reload;
- a snapshot domain failure degrades only the affected panel;
- migrated surfaces still fall back to existing detail endpoints for one release slice.

## Migration Strategy

1. Add event table and store APIs without changing existing routes.
2. Emit events for the highest-value domains: approvals, runs, skills.
3. Add snapshot route for skills, approvals, providers, memory, and runs.
4. Add polling event route.
5. Add SSE route after polling behavior is stable.
6. Move Web and CLI surfaces one domain at a time.
7. Use doctor to report whether control-plane snapshot/events are healthy.

## Done Criteria

- Web, CLI, and future desktop can read the same daemon-owned workspace snapshot.
- Skills, approvals, provider readiness, memory policy, and run summaries have domain
  snapshots with partial failure isolation.
- Control-plane events provide invalidation for high-value state changes.
- Existing run-specific SSE streams still work and are not overloaded with registry or
  provider events.
- No client needs to infer current runtime state from local files or direct SQLite
  access.
- No secret or approval state leaks through snapshots, events, logs, or doctor JSON.
