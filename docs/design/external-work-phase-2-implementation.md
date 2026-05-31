# External Work Phase 2 Implementation Plan

## Summary

Phase 2 turns the Phase 1 manual GitHub import foundation into a read-only scheduler
path. It discovers GitHub PR and issue candidates, claims each subject through Ling's
existing lease/state-machine boundaries, prepares isolated local workspaces, captures
hook evidence, and reconciles durable state through an explicit local operator command.

This phase still must not mutate GitHub. It must not post comments, add labels, request
reviews, push commits, merge, close issues, or execute any external action outside Ling
policy and approval gates.

## Deliverables

- GitHub read-only polling adapter for pull requests and issues.
- Durable scheduler state in the existing workspace SQLite store.
- Subject/resource claims using Ling resource leases.
- Manual reconciliation for queued, claimed, running, blocked, retry, terminal, and
  stale external work state.
- Per-subject workspace path allocation and hook execution with local evidence
  artifacts.
- Manual operator API and CLI smoke path for one poll/reconcile cycle.
- Tests proving duplicate polls, retry/backoff, lease conflicts, and workspace hook
  evidence.

## Scope Boundaries

In scope:

- GitHub PR and standalone issue candidate discovery.
- Repository `WORKFLOW.md` parsing through the existing parser.
- Existing `ExternalWorkItem` normalization and `createOrReuseExternalWorkWorkflow()`.
- Existing `ResourceLease`, `ChannelWorkflow`, `ChannelWorkflowStep`, artifacts, and
  state-transition tables.
- GitHub token lookup through existing secret refs.
- Shell hook execution for workspace preparation only, with evidence artifacts.

Out of scope:

- Webhooks.
- Linear.
- Runner startup from external work.
- GitHub comments, labels, review decisions, pushes, merges, issue close, or release
  mutation.
- UI beyond existing API/CLI visibility.
- Multi-node distributed scheduling.

## Data Model Changes

Keep all durable state in the existing Ling SQLite workspace store.

Extend `ResourceType` with:

- `external_source`: one poll/reconcile lease per source scope, for example
  `github:openclaw/openclaw`.
- `external_subject`: one subject claim per GitHub PR or issue, for example
  `github:pull_request:openclaw/openclaw#86279`.
- `external_workspace`: workspace preparation and cleanup lock for one subject.

Add an `external_work_scheduler_state` table keyed by `external_work_id`:

- `external_work_id`, `workspace_id`, `channel_id`.
- `subject_key`, `source_key`, `workflow_id`, `workflow_step_id`.
- `scheduler_status`: `discovered`, `claimed`, `workspace_preparing`, `ready`,
  `blocked`, `retry_wait`, `terminal`.
- `attempt_count`, `last_attempt_at`, `next_attempt_at`, `max_retry_backoff_ms`.
- `last_error_code`, `last_error_message`.
- `workspace_path`, `workspace_mode`.
- `hook_artifact_ids_json`.
- `last_reconciled_at`, `created_at`, `updated_at`.

Do not create a second scheduler database. Do not store GitHub tokens, raw hook secrets,
or full HTTP authorization headers in this table.

## Contracts And Interfaces

Add an external-work-specific adapter interface in `@ling-stack/core` instead of
changing the existing generic `ChannelSourceAdapter` event interface:

```ts
export interface ExternalWorkSourceAdapter {
  readonly id: string;
  readonly kind: ExternalSourceKind;
  loadCandidates(input: ExternalWorkLoadCandidatesInput): Promise<readonly ExternalWorkItem[]>;
  getWorkItem(input: ExternalWorkGetItemInput): Promise<ExternalWorkItem | undefined>;
}
```

The GitHub adapter accepts:

- `repository`: `owner/name`.
- `events`: only `pull_request.*` and `issue.*` selectors in Phase 2.
- `activeStates`: defaults from `WORKFLOW.md` parser.
- `secretRef`: optional GitHub token secret reference.
- `limit`: default 50, bounded at 100.

GitHub polling uses read-only REST calls:

- `GET /repos/{owner}/{repo}/pulls?state=open&per_page=...`
- `GET /repos/{owner}/{repo}/issues?state=open&per_page=...`

The issue path must ignore items with an `issue.pull_request` field so PRs are not
double-imported as issues.

Add a scheduler service boundary:

```ts
export interface ExternalWorkScheduler {
  pollGitHub(input: ExternalWorkPollInput): Promise<ExternalWorkPollResponse>;
  reconcile(input: ExternalWorkReconcileInput): Promise<ExternalWorkReconcileResponse>;
}
```

`ExternalWorkPollResponse` returns counts for candidates, claimed, duplicates, blocked,
retryScheduled, terminalIgnored, and artifact ids created during workspace hooks.

## Scheduler Flow

For each poll cycle:

1. Load channel and selected `WORKFLOW.md`.
2. Validate `source.kind === "github"` and `source.repository`.
3. Acquire `external_source` lease for `github:<repo>`.
4. Load GitHub PR and issue candidates through the adapter.
5. Filter by configured events and active states.
6. For each candidate, compute:
   - `subject_key = item.id`.
   - `idempotency_key = item.idempotencyKey`.
7. Acquire `external_subject` lease for `subject_key`.
8. Check for existing active scheduler state for the same subject. If active, record a
   duplicate/blocked result and do not create a new workflow.
9. Call `createOrReuseExternalWorkWorkflow()` for new or replayed idempotency keys.
10. Allocate or reuse an isolated workspace path.
11. Run `afterCreate` once for new workspaces and `beforeRun` before marking the
    scheduler state `ready`.
12. Attach hook stdout/stderr/status artifacts to the external work scheduler state.
13. Release source and subject leases when the poll cycle finishes, unless a state
    transition intentionally leaves the work blocked for retry.

Poll failures must not crash the daemon. They update scheduler state with
`retry_wait`, increment `attempt_count`, and compute `next_attempt_at` using exponential
backoff capped by `maxRetryBackoffMs`.

## Workspace Isolation And Hooks

Default workspace root:

```text
.ling-stack/external-workspaces/<sourceKind>/<hash-of-subject-key>/
```

If `workspace.root` is configured, resolve it from the `WORKFLOW.md` file location and
require the final workspace path to remain inside that configured root.

Workspace modes:

- `per_subject`: stable path per PR or issue.
- `per_attempt`: add attempt id suffix under the subject directory.

Hook execution:

- `afterCreate`: run once when the workspace directory is first created.
- `beforeRun`: run after candidate import and before scheduler state becomes `ready`.
- `afterRun`: register the hook for terminal workflow-step reconciliation, but do not
  run it until a later phase actually starts and completes runs.
- `beforeRemove`: no-op in Phase 2 except for validation and future cleanup state.

Hook execution must:

- Acquire `external_workspace` and `bound_path` leases.
- Run with cwd set to the isolated workspace path.
- Enforce `hooks.timeoutMs`.
- Capture stdout, stderr, command, exit code, and duration as artifacts.
- Redact known secret values using existing secret redaction helpers.
- Mark scheduler state `blocked` or `retry_wait` on failure according to retry policy.

## API And CLI

Add local read-only operator endpoints:

```http
POST /external-work/github/poll?cwd=/path/to/project
POST /external-work/reconcile?cwd=/path/to/project
```

`POST /external-work/github/poll` body:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": true
}
```

`executeHooks` defaults to `false` for tests and safe dry-runs. When `true`, hooks run
only inside isolated workspaces with lease protection and artifact capture. The endpoint
never starts the runner and never calls GitHub mutation APIs.

Add CLI commands:

```bash
ling-stack external-work github poll --channel <id> [--workflow-path WORKFLOW.md] [--limit 50] [--execute-hooks]
ling-stack external-work reconcile [--channel <id>] [--workflow-path WORKFLOW.md]
```

Human output should show candidate, claimed, duplicate, blocked, retry, and artifact
counts. `--json` should print the full response.

## Reconciliation

Run reconciliation in two places:

- Local recovery when a workspace store is opened, limited to stale run and lease expiry.
- Explicit `POST /external-work/reconcile` for external scheduler state.

Reconciliation must:

- Expire stale leases.
- Detect scheduler rows whose workflow or workflow step was deleted and mark them
  `blocked`.
- Detect active scheduler rows whose source item is terminal and mark them `terminal`
  without deleting evidence when `workflowPath` is supplied.
- Detect `retry_wait` rows whose `next_attempt_at <= now` and make them eligible for
  the next poll.
- Release workflow-step leases for terminal steps through existing state-machine paths.

Phase 2 does not add a background polling timer. `scheduler.pollIntervalMs` remains part
of the workflow contract for the later scheduler loop.

## Implementation Order

1. Add scheduler DTOs, resource type extensions, and scheduler-state store methods.
2. Implement GitHub read-only adapter with injected fetch for deterministic tests.
3. Add scheduler service that imports candidates through existing Phase 1 import
   primitives.
4. Add workspace path allocator and hook runner with artifact capture.
5. Add daemon endpoints and CLI commands.
6. Add startup reconciliation wiring behind the parsed `reconcileOnStartup` config.
7. Update examples and docs with poll/reconcile smoke commands.

## Tests

Core:

- GitHub adapter normalizes PR and issue candidate fixtures.
- Issue polling ignores PR-shaped issues.
- Scheduler state persists status, attempt count, backoff, workspace path, and hook
  artifact ids.
- Existing active subject blocks duplicate workflow creation across repeated polls.
- Same idempotency key reuses existing workflow and step.
- Lease conflicts produce blocked poll results instead of duplicate work.
- Workspace path allocator stays inside configured root.
- Hook runner records stdout/stderr/exit code artifacts and redacts secrets.
- Retry backoff is capped by `maxRetryBackoffMs`.

Daemon:

- `POST /external-work/github/poll` imports PR/issue candidates into workflow/step
  records without starting the runner.
- `executeHooks: false` does not run hooks.
- `executeHooks: true` writes hook artifacts under the external work evidence path.
- Missing channel, invalid workflow path, missing GitHub token, invalid repository, and
  GitHub API failures return readable errors.
- Reconcile endpoint expires stale leases and marks missing workflow state blocked.

CLI:

- `external-work github poll` sends the expected request body and renders counts.
- `--json` prints the daemon response.
- Invalid `--limit`, missing `--channel`, and daemon 400 errors are readable.

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
corepack pnpm test
corepack pnpm typecheck
git diff --check
```

## Acceptance Criteria

- A local operator can run one read-only GitHub poll cycle from a Ling channel and
  produce durable workflows, steps, scheduler state, workspace paths, and evidence
  artifacts.
- Repeated polls of the same unchanged PR or issue produce no duplicate workflow.
- Concurrent poll attempts for the same source or subject are blocked by resource
  leases.
- Failed polling or hooks schedule visible, bounded retry state.
- Daemon restart reconciliation does not lose, duplicate, or silently abandon external
  work.
- No code path in Phase 2 calls a GitHub mutation endpoint or starts a runner from
  external work import/polling.
