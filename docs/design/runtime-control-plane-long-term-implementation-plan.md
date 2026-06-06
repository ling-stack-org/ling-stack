# Runtime Control Plane Long-Term Implementation Plan

## Purpose

This plan covers the long-term phase of the Runtime Control Plane roadmap: when Ling has
Web, CLI, desktop, external agent workers, background jobs, and multiple workspaces
competing for the same runtime state, introduce Codex app-server-like layering for
transport, request processing, registries, and event subscriptions.

This is not a default migration to Codex app-server JSON-RPC. It is a staged plan for
adding the same kind of operational separation only when Ling has the pressure that
justifies it.

## Relationship To Codex App-Server Adapter

There are two separate long-term tracks:

1. Codex app-server as an optional runner backend.
   This is covered by [Runner Adapters](runner-adapters.md). Ling sends one run to a
   local or bundled Codex app-server while preserving Ling approvals, audit, memory, and
   run store as the product source of truth.

2. Ling daemon as an app-server-like control plane.
   This document covers Ling's own transport, processors, registry broker, and
   subscription hub. It serves Web, CLI, desktop, and future workers.

The second track must not depend on the first. Ling can have an app-server-like control
plane without enabling Codex app-server as a runner.

## Entry Criteria

Do not start this phase just because the architecture is attractive. Start when at least
two of these pressures are real:

- Web, CLI, and desktop are all active clients for the same workspace.
- Background jobs need long-lived subscriptions independent of Web page lifetime.
- External agent workers need to claim, stream, and complete work units.
- HTTP/SSE fanout creates duplicate refresh logic or inconsistent partial failures.
- Slow clients or reconnecting clients can block or corrupt runtime state.
- Registry changes need versioned replay across skills, tools, MCP, providers, runners,
  plugins, jobs, and automations.
- Multiple workspaces are open concurrently and need isolated lifecycle, event, and
  subscription scopes.
- A future multi-user or remote mode requires actor identity, workspace membership, and
  service-account style workers.

Prerequisites:

- [Runtime Control Plane Mid-Term Implementation Plan](runtime-control-plane-mid-term-implementation-plan.md)
  is implemented for snapshots and workspace-level events.
- Run, memory, skills, approvals, providers, MCP, runners, and artifacts already expose
  daemon-owned domain snapshots.
- Doctor can report control-plane snapshot/event health.
- Approval and secret redaction tests are in place.

## Target Architecture

```text
clients
  web
  cli
  desktop
  external workers
  background jobs
    |
    v
transport layer
  HTTP/SSE compatibility
  optional WebSocket or JSON-RPC-style envelopes
  initialize gate
  client capability negotiation
    |
    v
connection/session manager
  actor identity
  workspace attach
  reconnect handles
  bounded client queues
    |
    v
request processor layer
  parse
  authorize
  idempotency
  serialization scope
  dispatch
    |
    v
domain processors
  runs
  work units
  memory
  skills
  teammates
  approvals
  providers
  MCP
  runners
  artifacts
  jobs
    |
    v
kernel/store/audit
  SQLite
  active runtime registries
  approval policy
  event log
  secret resolver boundary
```

## Protocol Envelope

The first version can be transport-neutral TypeScript contracts. Do not expose a second
wire protocol until the contracts are useful behind existing HTTP/SSE routes.

```ts
interface ControlPlaneEnvelope {
  readonly protocolVersion: "ling-control-plane.v1";
  readonly id?: string;
  readonly kind: "request" | "response" | "event" | "error" | "heartbeat";
  readonly method?: string;
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly actor?: ControlPlaneActor;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly payload?: unknown;
}

interface ControlPlaneActor {
  readonly kind: "local_user" | "web_client" | "cli" | "desktop" | "worker" | "background_job";
  readonly id: string;
  readonly displayName?: string;
}
```

Required method families:

- `initialize`
- `workspace.attach`
- `workspace.detach`
- `controlPlane.snapshot`
- `controlPlane.events`
- `controlPlane.subscribe`
- `controlPlane.unsubscribe`
- `runs.create`
- `runs.cancel`
- `runs.get`
- `approvals.resolve`
- `memory.review`
- `skills.refresh`
- `registry.get`
- `registry.subscribe`
- `jobs.claim`
- `jobs.heartbeat`
- `jobs.complete`

Compatibility rule: existing HTTP routes remain the public stable API until a new
transport has equivalent tests and client support.

## Future JSON-RPC Adapter Shape

If Ling later needs JSON-RPC, add it as an adapter over the same processor layer. Do not
move domain logic into the adapter.

Initial endpoint options:

```text
POST /rpc
GET /control-plane/rpc-stream
```

`POST /rpc` handles request/response calls. A future WebSocket or stream endpoint may
carry subscriptions and server notifications if HTTP/SSE becomes insufficient.

Request shape:

```json
{
  "jsonrpc": "2.0",
  "id": "req_123",
  "method": "controlPlane.snapshot",
  "params": {
    "cwd": "/path/to/project",
    "domains": ["runs", "skills", "approvals"]
  }
}
```

Response shape:

```json
{
  "jsonrpc": "2.0",
  "id": "req_123",
  "result": {
    "cwd": "/path/to/project",
    "workspaceId": "workspace_default",
    "generatedAt": "2026-06-06T00:00:00.000Z",
    "latestEventSeq": 42,
    "domains": {}
  }
}
```

Error shape:

```json
{
  "jsonrpc": "2.0",
  "id": "req_123",
  "error": {
    "code": -32001,
    "message": "workspace_not_attached",
    "data": {
      "traceId": "trace_..."
    }
  }
}
```

Adapter rules:

- Map `method` to a registered `ControlPlaneProcessor`.
- Map `params` to the processor request schema without accepting extra secret-bearing
  fields.
- Preserve processor idempotency, actor, workspace, serialization, and redaction rules.
- Use Ling domain error codes in `error.message` or `error.data.code`; reserve JSON-RPC
  numeric codes for protocol-level classes.
- Do not support batch requests in the first version.
- Do not send binary artifact bytes through JSON-RPC; return artifact refs and keep the
  existing artifact content endpoints.
- Subscriptions use either existing SSE or a dedicated stateful stream. JSON-RPC
  request/response alone is not enough for durable workspace event delivery.

Candidate method mapping:

| JSON-RPC method | Processor | Existing compatibility route |
| --- | --- | --- |
| `initialize` | `initialize` | none |
| `workspace.attach` | `workspace.attach` | implicit `cwd` query today |
| `controlPlane.snapshot` | `controlPlane.snapshot` | `GET /control-plane/snapshot` |
| `controlPlane.events.list` | `controlPlane.events.list` | `GET /control-plane/events` |
| `controlPlane.subscribe` | `controlPlane.subscribe` | `GET /control-plane/stream` |
| `runs.create` | `runs.create` | `POST /runs` |
| `runs.cancel` | `runs.cancel` | `POST /runs/:id/cancel` |
| `skills.refresh` | `skills.refresh` | `POST /skills/refresh` |
| `memory.reviewPolicy.get` | `memory.reviewPolicy.get` | `GET /memory/review-policy` |
| `approvals.resolve` | `approvals.resolve` | approval resolve routes |
| `providers.check` | `providers.check` | provider check routes |

JSON-RPC is therefore a transport compatibility layer, not a new product control plane.
The daemon store, approval policy, runner registry, memory policy, event log, and secret
resolver remain Ling's source of truth.

## Initialize Gate And Client Capabilities

Every stateful client session must initialize before mutating requests.

Initialize request:

```ts
interface InitializeRequest {
  readonly clientName: "web" | "cli" | "desktop" | "worker" | string;
  readonly clientVersion?: string;
  readonly supportedProtocolVersions: readonly string[];
  readonly capabilities: {
    readonly subscriptions?: boolean;
    readonly resumeAfterSeq?: boolean;
    readonly binaryArtifacts?: boolean;
    readonly approvalPrompts?: boolean;
    readonly backgroundWorker?: boolean;
  };
}
```

Initialize response:

```ts
interface InitializeResponse {
  readonly protocolVersion: "ling-control-plane.v1";
  readonly sessionId: string;
  readonly serverStartedAt: string;
  readonly serverCapabilities: Record<string, boolean>;
  readonly maxClientQueueEvents: number;
  readonly heartbeatIntervalMs: number;
}
```

Rules:

- mutating calls before initialize fail with `not_initialized`;
- workspace-scoped calls before `workspace.attach` fail with `workspace_not_attached`;
- unsupported protocol versions fail closed;
- read-only HTTP compatibility routes may stay ungated for existing clients.

## Request Processor Layer

The current `server/router.ts` can remain the HTTP route table, but long-term mutation
logic should move into request processors that are independent of transport.

Processor contract:

```ts
interface ControlPlaneProcessor<Request, Response> {
  readonly method: string;
  readonly domain: ControlPlaneDomain;
  readonly mode: "read" | "mutate" | "stream";
  readonly serializationScope: (request: Request) => string | undefined;
  readonly handle: (context: ProcessorContext, request: Request) => Promise<Response>;
}
```

Processor responsibilities:

- validate request schema;
- resolve actor and workspace;
- enforce policy and approval boundaries;
- enforce idempotency for mutating calls;
- acquire serialization scope when state must not race;
- call domain services;
- append control-plane events;
- return redacted response payloads.

Transport responsibilities:

- parse envelopes or HTTP requests;
- apply initialize/session checks;
- maintain connection queues;
- encode responses and events;
- handle disconnects and backpressure.

This separation is the main Codex app-server idea worth borrowing. It keeps HTTP,
WebSocket, CLI, and future worker transports from each implementing policy logic.

## Serialization Scopes

Serialization scopes define where concurrent mutation is unsafe.

Initial scopes:

| Scope | Example methods |
| --- | --- |
| `workspace:{workspaceId}` | workspace config migrations |
| `run:{runId}` | cancel, continuation, stale completion handling |
| `work-unit:{workUnitId}` | claim, heartbeat, complete, retry |
| `approval:{approvalId}` | resolve approval |
| `teammate:{teammateId}:skills` | replace/backfill skill bindings |
| `registry:skills:{workspaceId}` | publish/archive/refresh skills |
| `provider:{providerId}` | update preset, preflight status |
| `memory:{memoryId}` | review, promote, quarantine |

Rules:

- scopes are held for the shortest transaction boundary possible;
- long-running runner work does not hold a SQLite write transaction;
- active-run streaming uses event append and cancellation handles, not global locks;
- late completions after cancellation append stale audit only.

## Registry Broker

The registry broker is the long-term owner for dynamic capability registries.

Registries:

- skills;
- tools;
- MCP servers and synced MCP tools;
- provider presets and model capability snapshots;
- runners;
- plugins and managed contributions;
- background jobs and automation templates;
- UI feature modules.

Broker responsibilities:

- compute effective registry view;
- assign registry generation numbers;
- emit registry change events;
- enforce review status and visibility;
- keep built-ins, imported entries, plugin contributions, and user overrides separate;
- expose redacted snapshots to clients;
- reject unknown or disabled capabilities before run start.

Suggested APIs:

```text
GET /registry/:kind?cwd=/path/to/project
POST /registry/:kind/refresh?cwd=/path/to/project
GET /registry/:kind/events?cwd=/path/to/project&afterGeneration=0
```

The short-term `/skills/refresh` can later become a specialized route backed by this
broker.

## Subscription Hub

The subscription hub builds on the mid-term `control_plane_events` table.

Subscription request:

```ts
interface SubscribeRequest {
  readonly afterSeq?: number;
  readonly domains?: readonly ControlPlaneDomain[];
  readonly entityRefs?: readonly {
    readonly domain: ControlPlaneDomain;
    readonly entityType: string;
    readonly entityId: string;
  }[];
}
```

Hub responsibilities:

- replay durable events after `afterSeq`;
- fan out live events to connected clients;
- keep per-client queues bounded;
- send heartbeats;
- send `snapshot_required` when replay history is insufficient;
- disconnect slow clients before they block writers;
- isolate workspace scopes.

Backpressure policy:

```text
normal -> enqueue event
queue near limit -> coalesce invalidation events by domain/entity
queue full -> send slow_client_disconnect and close stream
client reconnects -> replay from afterSeq or request snapshot
```

Do not send token-level runner output through the workspace subscription hub. Run-specific
streams remain the transcript/progress channel.

## External Worker Gateway

When external agent workers arrive, they should claim work through the daemon rather
than touching SQLite or runner internals.

Worker APIs:

```text
POST /workers/register?cwd=/path/to/project
POST /work-units/:id/claim?cwd=/path/to/project
POST /work-units/:id/heartbeat?cwd=/path/to/project
POST /work-units/:id/events?cwd=/path/to/project
POST /work-units/:id/complete?cwd=/path/to/project
POST /work-units/:id/fail?cwd=/path/to/project
```

Rules:

- workers have explicit actor identity and capability grants;
- workers cannot approve their own side effects;
- workers receive scoped secrets only through trusted daemon paths;
- missed heartbeats return work units to a recoverable state;
- worker output is normalized into Ling events and artifacts.

## Multi-Workspace And Future Multi-User

Long-term control-plane envelopes should include both `workspaceId` and `cwd` while Ling
remains local-first. This avoids a later rewrite when workspace ids become stable beyond
one local path.

Future multi-user or remote mode adds:

- actor authentication;
- workspace membership;
- role-based grants;
- service accounts for workers;
- remote-safe artifact storage;
- database-backed leases beyond local process checks.

Do not implement remote multi-user semantics in the local-first phase, but keep contracts
from assuming a single anonymous actor.

## Implementation Slices

### Slice L1: Contracts Only

Primary files:

- `packages/contracts/src/index.ts`
- `packages/api-client/src/client.ts`
- `docs/daemon-api.md`

Add TypeScript contracts for:

- envelopes;
- actors;
- initialize request/response;
- control-plane methods;
- subscription requests;
- registry snapshots.

No runtime behavior changes in this slice.

### Slice L2: Processor Extraction

Primary files:

- `packages/daemon/src/server/router.ts`
- `packages/daemon/src/features/*`
- new `packages/daemon/src/control-plane/processors.ts`

Extract selected read and mutation paths behind processor objects:

- `controlPlane.snapshot`;
- `skills.refresh`;
- `approvals.resolve`;
- `runs.cancel`;
- `providers.check`.

HTTP routes call processors directly. No new transport yet.

### Slice L3: Initialize And Session Manager

Primary files:

- new `packages/daemon/src/control-plane/sessions.ts`
- `packages/daemon/src/context.ts`
- `packages/daemon/src/server/router.ts`

Add initialized sessions for long-lived transports, but keep existing HTTP routes
compatible.

Implement:

- session id creation;
- client capability storage;
- workspace attach state;
- heartbeat metadata;
- bounded queue config.

### Slice L4: Subscription Hub

Primary files:

- new `packages/daemon/src/control-plane/subscriptions.ts`
- `packages/daemon/src/shared/response.ts`
- `packages/api-client/src/client.ts`

Upgrade the mid-term stream route into a reusable subscription hub.

Add tests for:

- replay from `afterSeq`;
- domain filters;
- slow client disconnect;
- heartbeat;
- snapshot-required flow.

### Slice L5: Registry Broker

Primary files:

- new `packages/daemon/src/control-plane/registries.ts`
- `packages/daemon/src/features/skills/registry.ts`
- plugin, provider, MCP, runner registry modules

Move registry generation and refresh behavior into one broker. Keep specialized routes
as compatibility aliases.

### Slice L6: External Worker Gateway

Primary files:

- `packages/daemon/src/runtime/work-units.ts`
- `packages/daemon/src/runtime/routes.ts`
- new `packages/daemon/src/control-plane/workers.ts`

Add worker registration, claim, heartbeat, event append, complete, and fail flows.

Workers must pass the same approval and secret boundary tests as local runners.

### Slice L7: Optional New Transport

Only after processors, sessions, subscriptions, and registries are stable, add one new
transport if HTTP/SSE is a proven bottleneck.

Candidates:

- WebSocket with Ling envelopes;
- JSON-RPC-style request/response over WebSocket;
- stdio JSONL for local worker processes.

Selection rule:

- Web/desktop interactive multiplexing pressure -> WebSocket;
- local worker process pressure -> stdio JSONL;
- external protocol compatibility pressure -> JSON-RPC-style envelopes.

Do not remove HTTP/SSE until clients and tests prove parity.

### Slice L8: Codex App-Server Adapter Integration

If `codex-app-server` runner is implemented, bridge it through the same processor,
subscription, registry, and approval surfaces.

Requirements:

- adapter capability registered through the registry broker;
- health and conformance visible in control-plane snapshots;
- Codex approval requests normalized into Ling approvals;
- Codex stream events normalized into Ling run/work-unit events;
- abort and late-completion behavior tested through Ling stale-completion tests;
- no Codex-owned state becomes the Ling source of truth.

## Testing

Contracts:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/api-client test
```

Daemon:

```bash
corepack pnpm --filter @ling-stack/daemon test
```

Required daemon tests:

- processor methods are transport-independent;
- mutating processors reject uninitialized state when invoked through session transport;
- HTTP compatibility routes still work;
- idempotency prevents duplicate side effects;
- serialization scopes prevent racing approval/run/registry mutations;
- subscription hub disconnects slow clients without blocking event writers;
- registry broker emits generation changes and preserves review boundaries;
- worker heartbeat timeout is recoverable;
- no raw secrets appear in envelopes, events, snapshots, logs, or doctor JSON.

Web/CLI/Desktop:

- clients can use snapshots and subscriptions without `Promise.all` collapse;
- reconnect uses `afterSeq` and falls back to snapshot when needed;
- domain failures stay isolated in UI;
- CLI automation keeps stable stdout/stderr contracts.

## Rollout Strategy

1. Keep HTTP/SSE stable and add contracts first.
2. Move route logic into processors while preserving public endpoints.
3. Add session manager and initialize gate for new transports only.
4. Harden subscriptions and registry broker behind existing routes.
5. Add external worker gateway when workers exist.
6. Add WebSocket or JSON-RPC-style transport only after evidence shows HTTP/SSE is not
   enough.
7. Keep Codex app-server as an optional runner backend, never as Ling's source of truth.

## Done Criteria

- Web, CLI, desktop, workers, and background jobs can share one daemon control plane.
- The same processor logic serves HTTP compatibility routes and any new transport.
- Registries are generationed, refreshable, subscribable, and review-aware.
- Workspace subscriptions support replay, heartbeat, filtering, backpressure, and
  snapshot-required recovery.
- External workers can claim and complete work units without direct store access.
- Approval, memory, provider, MCP, runner, and skill boundaries stay centralized in the
  daemon.
- Codex app-server, if enabled, is only a runner adapter under Ling's approval and audit
  model.
