# Session Persistence Design

## Status

Draft for Milestone 1: Durable Runs.

This design narrows the broader v0.1 plan into the first implementation slice. It should be implemented before provider presets, task CRUD, approval UI, or the full web application, because those features all need durable run history.

The broader thread, evidence bundle, and resume experience is defined in
[Codex-Like Execution Experience](codex-like-execution.md).

## Goal

Every `POST /runs` call should leave a local, inspectable record.

Minimum outcome:

```text
POST /runs
-> create run id
-> create run session metadata
-> stream SSE events
-> persist each event
-> write append-only JSONL log
-> update terminal status
-> expose run and event read APIs
```

After this slice, a user should be able to start a run, close the HTTP client, restart the UI, and still inspect what happened.

## Current Baseline

Implemented today:

- `POST /runs` parses a request body.
- The daemon calls `PiRunnerAdapter.runTask()`.
- Runner events are translated to Ling Stack events.
- Events are streamed over SSE.
- No run id is created by Ling Stack.
- No event envelope is added.
- No events are persisted.
- No read API exists for historical runs.
- HTTP client disconnect does not cancel the underlying Pi run.

## Scope

This slice includes:

- Runtime directory creation under `.ling-stack/`.
- SQLite metadata for run sessions and events.
- Append-only JSONL event logs.
- Redacted event envelopes.
- `GET /runs/:id`.
- `GET /runs/:id/events`.
- Minimal crash recovery for stale running sessions.
- Test seams for a mock runner.

This slice does not include:

- Provider preset CRUD.
- Channel/task CRUD.
- Approval interception.
- Web UI.
- Desktop packaging.
- Full cancellation semantics.
- Artifact extraction beyond reserving paths for later.

## Important Constraint

Session persistence must work before the task, channel, teammate, and provider preset systems exist.

That means Milestone 1 cannot require foreign keys to real `tasks`, `channels`, `ai_teammates`, or `provider_presets` tables. It must persist request snapshots now and allow later migrations to link runs to first-class domain records.

Recommended approach:

- Store `task_id` from the incoming request if supplied.
- Store `channel_id` if supplied.
- Store `task_snapshot_json`.
- Store `provider_snapshot_json` after secret redaction.
- Store `request_snapshot_json` after secret redaction.
- Add nullable future link columns such as `provider_preset_id` and `teammate_id`.

## Runtime Layout

For a run started with `cwd=/path/to/project`, v0.1 writes:

```text
/path/to/project/.ling-stack/
  ling-stack.sqlite
  sessions/
    run_<id>.jsonl
    run_<id>.summary.json
  artifacts/
    run_<id>/
      files/
      diffs/
      media/
      logs/
  pi/
```

The current Pi adapter already defaults `agentDir` to:

```text
<cwd>/.ling-stack/pi
```

The persistence layer should use the same `.ling-stack` root unless a future daemon config explicitly overrides it.

## IDs

Use prefixed IDs:

```text
run_<uuid>
evt_<uuid>
```

The event sequence number is the source of ordering, so v0.1 does not need a sortable ID dependency. `crypto.randomUUID()` is enough.

Rules:

- `run_id` is created by the daemon before the runner starts.
- `seq` starts at `1` per run.
- Every persisted event has a unique `(run_id, seq)`.
- Terminal events are still assigned a sequence.

## Data Model

### RunSession

```ts
type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

interface RunSession {
  id: string;
  status: RunStatus;
  cwd: string;
  taskId: string;
  channelId?: string;
  teammateId?: string;
  providerPresetId?: string;
  providerName: string;
  providerModel: string;
  taskSnapshot: unknown;
  providerSnapshot: unknown;
  requestSnapshot: unknown;
  eventLogPath: string;
  summaryPath?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
}
```

Milestone 1 deliberately omits `waiting_for_approval`; approval status enters after the approval policy slice.

### RunEventEnvelope

```ts
interface RunEventEnvelope {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: RunEventType;
  data: unknown;
}
```

The event type should match the SSE event name.

Milestone 1 event types:

```text
run_created
run_start
turn_start
turn_end
assistant_text_delta
assistant_thinking_delta
message_end
tool_start
tool_update
tool_end
run_end
run_error
run_cancelled
result
```

`result` is kept because the current daemon already emits it as a stream summary. It should become an envelope and should be persisted.

## SQLite Schema

Create a migration table first:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

Initial run tables:

```sql
CREATE TABLE run_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  cwd TEXT NOT NULL,
  task_id TEXT NOT NULL,
  channel_id TEXT,
  teammate_id TEXT,
  provider_preset_id TEXT,
  provider_name TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  task_snapshot_json TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL,
  request_snapshot_json TEXT NOT NULL,
  event_log_path TEXT NOT NULL,
  summary_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
  UNIQUE(run_id, seq)
);

CREATE INDEX idx_run_sessions_status ON run_sessions(status);
CREATE INDEX idx_run_sessions_task ON run_sessions(task_id);
CREATE INDEX idx_run_sessions_created_at ON run_sessions(created_at);
CREATE INDEX idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX idx_run_events_type ON run_events(type);
```

Recommended SQLite settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

WAL mode is appropriate for a local daemon because the UI may read events while a run writes events.

## JSONL Event Log

For every event envelope inserted into `run_events`, append the same envelope as one line to:

```text
.ling-stack/sessions/<run_id>.jsonl
```

Line format:

```json
{"id":"evt_...","runId":"run_...","seq":1,"ts":"...","type":"run_created","data":{}}
```

Rules:

- One JSON object per line.
- No trailing commas.
- Append in sequence order.
- Append only after the SQLite insert succeeds.
- If JSONL append fails, the run should fail loudly with `run_error`; silent evidence loss is worse than a failed run.

SQLite is the query index. JSONL is the audit-friendly append log.

## Redaction

Persisted and streamed envelopes should be redacted before they leave the daemon boundary.

Redact by key name:

```text
apiKey
api_key
apiKeyRef
authorization
Authorization
cookie
Cookie
password
token
secret
```

Redact common value patterns:

```text
sk-...
Bearer ...
Basic ...
```

Replacement:

```text
[REDACTED]
```

For Milestone 1, redaction can be conservative and lossy. It is acceptable to redact more than necessary; it is not acceptable to persist raw API keys.

## Write Order

The daemon should use this order:

1. Parse and validate request.
2. Resolve runtime paths.
3. Open or initialize SQLite.
4. Create `run_id`.
5. Insert `run_sessions` row with `queued`.
6. Append and persist `run_created`.
7. Send SSE `ready` with `runId`.
8. Mark session `running`.
9. Invoke runner.
10. For each runner event:
    - redact payload,
    - create envelope,
    - insert into SQLite,
    - append JSONL,
    - write SSE if client is still connected.
11. On success:
    - append `result`,
    - mark session `succeeded`,
    - write summary JSON.
12. On error:
    - append `run_error`,
    - mark session `failed`,
    - write summary JSON.

The event should be durable before it is streamed. This prevents the UI from showing events that cannot be recovered later.

## SSE Contract

Current stream:

```text
event: run_start
data: {"type":"run_start",...}
```

Milestone 1 stream:

```text
event: run_start
data: {"id":"evt_...","runId":"run_...","seq":2,"ts":"...","type":"run_start","data":{...}}
```

`ready` should include `runId`:

```text
event: ready
data: {"ok":true,"runId":"run_..."}
```

`ready` does not need to be persisted if `run_created` is persisted before it.

## Read APIs

### Get Run

```http
GET /runs/:id
```

Response:

```json
{
  "id": "run_...",
  "status": "succeeded",
  "cwd": "/path/to/project",
  "taskId": "task-1",
  "channelId": "engineering",
  "providerName": "local-relay",
  "providerModel": "dpv4",
  "eventLogPath": ".ling-stack/sessions/run_....jsonl",
  "createdAt": "...",
  "startedAt": "...",
  "endedAt": "..."
}
```

### Get Run Events

```http
GET /runs/:id/events
GET /runs/:id/events?afterSeq=12&limit=100
```

Response:

```json
{
  "runId": "run_...",
  "events": [
    {
      "id": "evt_...",
      "runId": "run_...",
      "seq": 13,
      "ts": "...",
      "type": "tool_end",
      "data": {}
    }
  ],
  "nextSeq": 14
}
```

Default limit: `200`.

Maximum limit: `1000`.

## Summary File

At terminal status, write:

```text
.ling-stack/sessions/<run_id>.summary.json
```

Shape:

```json
{
  "runId": "run_...",
  "status": "succeeded",
  "taskId": "task-1",
  "eventCount": 42,
  "messageCount": 3,
  "startedAt": "...",
  "endedAt": "...",
  "errorMessage": null
}
```

This file is a convenience artifact. SQLite remains the source for list/query operations.

## Crash Recovery

On daemon startup, find sessions with:

```sql
status IN ('queued', 'running')
```

For Milestone 1, mark them as `failed` with:

```text
error_message = "Daemon stopped before the run reached a terminal state."
```

Also append a `run_error` event if no terminal event exists.

This is conservative. The later
[Run Interruption And Continuation](run-interruption-continuation.md) design can
introduce `interrupted` or linked continuation sessions.

## Client Disconnect Behavior

Current behavior: the daemon stops writing SSE when the response closes, but the Pi run may continue.

Milestone 1 behavior:

- Continue persisting events even if the client disconnects.
- Stop writing SSE after disconnect.
- Do not mark the run cancelled just because the client disconnected.
- Add explicit cancellation later through `POST /runs/:id/cancel`.

Reason: closing the browser tab should not destroy the audit record or leave the run invisible.

## Module Plan

### `packages/core`

Add durable run types and storage primitives:

```text
packages/core/src/runtime-paths.ts
packages/core/src/run-types.ts
packages/core/src/redaction.ts
packages/core/src/storage/sqlite-store.ts
packages/core/src/storage/migrations.ts
packages/core/src/storage/run-store.ts
packages/core/src/storage/event-log.ts
```

Responsibilities:

- Resolve `.ling-stack` paths.
- Create directories.
- Open SQLite.
- Apply migrations.
- Insert/update run sessions.
- Insert/query run events.
- Append JSONL.
- Redact event payloads.

### `packages/daemon`

Update daemon dependencies:

```ts
interface DaemonDependencies {
  runner?: RunnerAdapter;
  storeFactory?: RunStoreFactory;
}
```

This allows tests to inject a mock runner and a temporary store.

Update `createDaemonServer` to accept:

```ts
createDaemonServer(config?: DaemonConfig, dependencies?: DaemonDependencies)
```

Routes to add:

```text
GET /runs/:id
GET /runs/:id/events
```

Route to evolve:

```text
POST /runs
```

### `packages/runner-pi`

No required changes for Milestone 1.

Optional later improvement:

- Accept `runId` for richer logs.
- Expose cancellation when available.

## Store Interface Draft

```ts
interface RunStore {
  createRun(input: CreateRunInput): Promise<RunSession>;
  markRunStarted(runId: string, startedAt: string): Promise<void>;
  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): Promise<void>;
  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): Promise<void>;
  appendEvent(runId: string, type: RunEventType, data: unknown): Promise<RunEventEnvelope>;
  getRun(runId: string): Promise<RunSession | undefined>;
  listEvents(runId: string, options?: { afterSeq?: number; limit?: number }): Promise<RunEventEnvelope[]>;
  recoverStaleRuns(now: string): Promise<number>;
}
```

`appendEvent` should own sequence allocation so callers cannot create duplicate sequence numbers.

## Error Handling

Failure cases:

| Failure | Behavior |
| --- | --- |
| Cannot create `.ling-stack` | Return HTTP 500 before starting runner |
| SQLite migration fails | Return HTTP 500 before starting runner |
| Request parse fails | Return HTTP 400; no run created |
| Event insert fails | Append/stream `run_error` if possible, mark run failed |
| JSONL append fails | Mark run failed; do not continue silently |
| Runner throws | Persist `run_error`, mark failed, stream error |
| Client disconnects | Continue run and persistence, stop SSE writes |

Do not start the runner unless session storage is ready.

## Test Plan

### Unit Tests

- Runtime path resolution returns `<cwd>/.ling-stack`.
- Redaction removes API keys and authorization headers.
- Migration runner is idempotent.
- `appendEvent` increments sequence numbers.
- JSONL contains valid one-line JSON objects.
- Stale run recovery marks queued/running sessions as failed.

### Daemon Tests

Use a mock runner that emits deterministic events.

Test cases:

- `POST /runs` returns SSE with `ready` containing `runId`.
- `POST /runs` persists `run_created`, `run_start`, mock events, `result`.
- `GET /runs/:id` returns session metadata.
- `GET /runs/:id/events` returns ordered envelopes.
- `GET /runs/:id/events?afterSeq=...` paginates correctly.
- Bad request returns 400 and creates no run.
- Runner error persists `run_error` and marks session `failed`.
- Client disconnect does not stop persistence.

### Manual Smoke Test

```bash
corepack pnpm build
node packages/daemon/dist/cli.js
curl -N http://127.0.0.1:17891/runs \
  -H 'content-type: application/json' \
  -d '{
    "cwd": "'$PWD'",
    "task": {
      "id": "task-smoke",
      "title": "Smoke test",
      "prompt": "List files."
    },
    "provider": {
      "provider": "local-relay",
      "displayName": "Local Relay",
      "model": "dpv4",
      "baseUrl": "http://127.0.0.1:3000/v1",
      "api": "openai-completions",
      "apiKey": "sk-local"
    },
    "tools": ["read", "grep", "find", "ls"],
    "thinkingLevel": "off"
  }'
```

Then inspect:

```bash
find .ling-stack -maxdepth 3 -type f | sort
sqlite3 .ling-stack/ling-stack.sqlite 'select id,status,event_log_path from run_sessions;'
sqlite3 .ling-stack/ling-stack.sqlite 'select seq,type from run_events order by seq;'
```

## Implementation Checklist

1. Add SQLite driver dependency behind `packages/core` storage abstraction.
2. Add runtime path helper.
3. Add migration runner and initial schema.
4. Add run and event TypeScript types.
5. Add redaction helper.
6. Add JSONL event log writer.
7. Add `RunStore` implementation.
8. Add daemon dependency injection for mock runner/store.
9. Update `POST /runs` to create run sessions and envelopes.
10. Add `GET /runs/:id`.
11. Add `GET /runs/:id/events`.
12. Add tests for storage and daemon routes.
13. Run `corepack pnpm typecheck`.
14. Run `corepack pnpm build`.
15. Do one manual daemon smoke test.

## Open Decisions

### SQLite Driver

Decision needed before implementation:

- Use a mature package such as `better-sqlite3`.
- Or use a runtime-provided SQLite API if the required Node version supports it well enough.

Recommendation: hide the choice behind `SqliteStore` so this decision does not leak into daemon or UI code.

### Canonical Event Source

Recommendation:

- SQLite is canonical for API queries.
- JSONL is canonical for audit/recovery inspection.
- Both contain the same redacted event envelopes.

### Full Message Persistence

The Pi runner returns `messages` at the end of a run. Milestone 1 should not persist full raw messages until redaction is reliable.

Recommendation:

- Persist event envelopes now.
- Persist `messageCount` in summary.
- Add full message snapshot later only after explicit redaction and size limits.
