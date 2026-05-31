# External Work Phase 6 Implementation Plan

## Summary

Phase 6 moves GitHub external work from manual polling to controlled background
operation. The first implementation should be a runtime-registered GitHub scheduler,
not a daemon-wide hidden crawler and not a webhook receiver.

The target flow is:

```text
operator registers cwd + channel + WORKFLOW.md
-> daemon runs startup reconcile when configured
-> daemon schedules read-only GitHub poll ticks
-> each tick reuses the existing poll/reconcile services
-> workflows, scheduler state, leases, workspaces, and artifacts stay durable
-> operators can list and stop the registered scheduler
```

This phase is about discovery and recovery. It must not start local runners or execute
GitHub mutations. External mutation still requires the existing durable action,
approval, explicit execute call, and stale-target revalidation path.

## Required Baseline

Phase 6 should ship only after these capabilities are available:

- Manual GitHub PR/issue import.
- Manual GitHub poll and local reconcile.
- Durable scheduler state, subject/source/workspace leases, isolated workspaces, and
  optional hook evidence.
- Approval-gated GitHub comments, labels, and the Phase 5 strict PR review action slice.
- GitHub CI triage, local fix task creation, explicit local fix run bridge, and Web
  observability.

Still enforced:

- No webhook receiver in the first Phase 6 cut.
- No daemon-wide scan of every repository or channel.
- No automatic runner start from external work.
- No automatic GitHub comment, label, review, push, merge, release, or issue close.
- No token persistence in SQLite or artifacts.

## Goals

- Add a daemon-owned background scheduler registry scoped to the current daemon process.
- Register background operation explicitly by `cwd`, `channelId`, and `workflowPath`.
- Run a startup reconcile during registration when `WORKFLOW.md` requests it.
- Schedule repeated GitHub read-only polling using `scheduler.pollIntervalMs`.
- Reuse the existing Phase 2 poll/reconcile services instead of creating a second
  scheduler database.
- Preserve existing idempotency, leases, retry/backoff, workspace isolation, and artifact
  behavior.
- Expose SDK and CLI surfaces to start, list, and stop registered background schedulers.

## Non-Goals

- No webhook ingestion.
- No global daemon auto-discovery of workspaces.
- No cross-process scheduler persistence beyond the durable external work and scheduler
  state already stored in SQLite.
- No runner startup from background poll or reconcile ticks.
- No GitHub mutation execution from background ticks.
- No Linear or second source adapter in this phase.
- No Web scheduler management UI in the first cut.

## Scheduler Registration Model

The daemon only knows about workspaces that a user or client explicitly opens. Phase 6
should therefore register background work from an explicit API call instead of silently
scanning the filesystem.

Registration key:

```text
cwd + channelId + resolved workflowPath
```

Duplicate registration with the same key should return the existing scheduler and mark
the response as duplicate. It should not create another timer or run overlapping ticks.

The scheduler record should expose:

- `id`
- `kind: "github"`
- `cwd`
- `channelId`
- `workflowPath`
- `status`
- `pollIntervalMs`
- `limit`
- `executeHooks`
- `lastStartedAt`
- `lastTickStartedAt`
- `lastTickFinishedAt`
- `nextTickAt`
- `tickCount`
- `lastErrorCode`
- `lastErrorMessage`

This is runtime process state. Durable work ownership remains in the existing SQLite
external work tables.

## API Surface

Planned daemon endpoints:

```http
POST /external-work/github/background/start?cwd=...
GET /external-work/background?cwd=...
POST /external-work/background/:schedulerId/stop?cwd=...
```

Start request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false,
  "runImmediately": true
}
```

Rules:

- `channelId` is required.
- `workflowPath` defaults to `WORKFLOW.md` and is resolved by the existing channel-bound
  path rules.
- `limit` is bounded by the same rules as manual poll.
- `executeHooks` defaults to `false`.
- `runImmediately` defaults to `true`; when false, the first tick waits for the next
  interval.

SDK methods:

```ts
startGitHubExternalWorkBackground(cwd, input)
listExternalWorkBackgroundSchedulers(cwd)
stopExternalWorkBackgroundScheduler(cwd, schedulerId)
```

CLI commands:

```bash
ling-stack external-work github background start \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack external-work github background list

ling-stack external-work github background stop external_work_scheduler_...
```

`--json` should print daemon responses unchanged. Human output should show scheduler id,
status, channel, workflow path, poll interval, tick count, next tick, and last error.

## Tick Behavior

Each tick should:

1. Load and parse the current `WORKFLOW.md`.
2. Resolve the GitHub token through the existing secret resolver for the current request.
3. Run local reconcile before poll when configured or when recovering from an error.
4. Run the existing GitHub read-only poll service with the registered `channelId`,
   workflow path, limit, and hook flag.
5. Persist all work through the existing external work import, mapping, scheduler state,
   resource lease, workspace, and artifact paths.
6. Record tick timing, counts, and last error on the runtime scheduler record.
7. Schedule the next tick with `setTimeout`, not `setInterval`, so slow ticks cannot
   overlap.

Errors should be contained to the scheduler record. A failed tick should store the
readable error code/message and schedule the next tick according to the workflow retry
and backoff configuration. It should not crash the daemon.

## Reconciliation

Startup reconcile in Phase 6 means "reconcile when the scheduler is explicitly
registered", not "make network calls when the daemon process starts".

The reconcile path should continue to:

- Release expired local leases.
- Mark missing workflow/step records as blocked.
- Mark terminal workflow/step records as terminal.
- Move retry-wait states whose `nextAttemptAt` has arrived back to pollable.
- Optionally perform the existing single-item GitHub terminal check only when a workflow
  path is provided and the user explicitly registered that scheduler.

## Safety Boundary

Phase 6 must preserve the same boundary as the manual path:

- Background ticks may read GitHub PRs and issues.
- Background ticks may create or reuse local workflows, steps, scheduler state,
  workspaces, leases, and artifacts.
- Background ticks may run configured create-time hooks only when `executeHooks` is
  explicitly true and the existing hook isolation rules pass.
- Background ticks must not start teammate runs.
- Background ticks must not propose hidden external mutations unless a later phase
  explicitly adds such a policy with durable evidence.
- Background ticks must not execute external actions.

## Tests

Core and daemon:

- Registering a scheduler with a temp `WORKFLOW.md` and mock GitHub fetch creates one
  runtime scheduler.
- Immediate tick imports PR/issue candidates through the existing poll path.
- Duplicate registration returns the existing scheduler and does not create another
  timer.
- Stop cancels the timer and marks the scheduler stopped.
- GitHub errors are stored as scheduler `lastErrorCode` and `lastErrorMessage`.
- Invalid channel, path escape, invalid workflow, and unsupported event types return
  readable errors.
- Background ticks do not start runners and do not call mutation endpoints.

SDK and CLI:

- Start/list/stop methods call the expected URLs and preserve daemon responses.
- CLI human output shows scheduler status, tick count, next tick, and last error.
- `--json` prints daemon responses unchanged.
- Missing channel and invalid limits fail before or at the daemon with readable errors.

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
corepack pnpm typecheck
corepack pnpm test
git diff --check
```

## Completion Criteria

- A developer can register one GitHub background scheduler for a channel and workflow.
- The scheduler repeatedly discovers external work without duplicate workflows.
- Operators can list and stop the scheduler.
- Local reconcile runs at registration and during ticks without hidden network calls at
  daemon startup.
- No runner starts and no GitHub mutation happens from background operation.
- Existing manual import, poll, reconcile, CI triage, action approval, and action execute
  flows remain unchanged.

## Handoff To Phase 7

Phase 6 completes GitHub-first operations. Phase 7 should not broaden GitHub mutation
surface by default. It should prove the architecture by adding one second channel
adapter, likely Linear, while reusing normalized work items, scheduler state, leases,
workspace isolation, evidence artifacts, approvals, and action audit records.
