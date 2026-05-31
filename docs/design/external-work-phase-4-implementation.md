# External Work Phase 4 Implementation Plan

## Summary

Phase 4 adds GitHub CI triage and local fix task creation on top of the completed
GitHub PR/issue external-work path. The first implementation should stay manual and
read-first: inspect failing GitHub checks and Actions jobs, write local evidence
artifacts, create or reuse a scoped Ling task, and optionally let the existing task/run
path perform a local fix under normal channel policy.

Phase 4.0 implements the manual read-only path:

- `POST /external-work/github/ci/triage?cwd=...`
- `LingDaemonClient.triageGitHubExternalWorkCi()`
- `ling-stack external-work github ci triage --external-work <id>`

The shipped CLI/API path creates local triage records, evidence artifacts, and fix
tasks by default. `startRun: true` remains rejected in Phase 4.0, so no runner starts
from CI triage.

The roadmap after the completed Phase 4.2 Web surface is tracked in
[External Work Roadmap](external-work-roadmap.md). In short: Phase 5 should close the
GitHub-first operator loop, starting with the strict PR review action documented in
[External Work Phase 5 Implementation](external-work-phase-5-implementation.md); Phase
6 should add background polling/reconciliation; Phase 7 should prove a second channel
adapter.

Phase 4 must not become an auto-push bot. Reading CI metadata and logs is allowed with a
GitHub token. Creating Ling records and artifacts is local-only. Starting a local fix run
goes through existing channel runtime policy, provider preflight, resource leases, and
approval policy. Pushing commits, posting diagnosis comments, requesting review changes,
or merging remains an approval-gated external action and should not be part of the first
CI triage implementation.

## Goals

- Turn a failing PR check into a durable, inspectable Ling triage record.
- Capture enough evidence to reproduce the failure locally: check name, workflow/job,
  failure conclusion, URLs, head SHA, key log excerpt, first likely failing command, and
  suggested reproduction command.
- Create a scoped Ling task such as `Fix failing CI: web e2e on owner/repo#123`.
- Reuse existing channel, task, artifact, approval, lease, and run machinery instead of
  adding a second scheduler database.
- Keep idempotency stable across repeated manual triage calls for the same PR head SHA
  and CI failure.

## Non-Goals

- No webhook receiver.
- No background CI poll loop.
- No automatic runner start by default.
- No automatic push, force-push, branch creation, merge, PR review decision, issue close,
  or release action.
- No Linear CI concept.
- No full log indexing or long-term log warehouse.
- No attempt to parse every test framework perfectly in Phase 4.

## GitHub API Boundary

Use GitHub REST through an injected `fetch`, following the existing external-work adapter
style. The first adapter should only perform `GET` requests.

Read-only endpoints:

- `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` to list check runs for the PR
  head SHA.
- `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}` to list workflow runs for the
  PR head SHA.
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` to list jobs for a failing
  workflow run.
- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` to download one failing job log
  with byte limits and redaction.
- Optional later: check-run annotations for richer file/line mapping.

Token handling follows Phase 2 and Phase 3:

- `source.secretRef` resolves through the daemon `SecretResolver`.
- Token values are passed only to the current adapter call.
- Tokens and authorization headers are never stored in SQLite or artifacts.
- Logs are redacted before artifact write.

Reference docs:

- [REST API endpoints for checks](https://docs.github.com/en/rest/reference/checks)
- [REST API endpoints for workflow runs](https://docs.github.com/rest/actions/workflow-runs/)
- [REST API endpoints for workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28)

## Data Model

Keep durable state in the existing workspace SQLite store.

Add `external_work_ci_triage`:

- `id`, `workspace_id`, `channel_id`, `external_work_id`.
- `source_kind`: initially `github`.
- `repository`, `subject_kind`, `subject_number`, `head_sha`.
- `failure_key`: stable idempotency key for repository, PR number, head SHA, run/check id,
  job id when available, conclusion, and updated timestamp.
- `status`: `triaged`, `task_created`, `run_requested`, `blocked`, `stale`, `failed`.
- `check_name`, `workflow_name`, `job_name`, `conclusion`, `html_url`.
- `first_failing_command`, `reproduction_command`, `suspected_source_path`.
- `task_id`, `run_id`.
- `artifact_ids_json`: normalized CI item, log excerpt, triage summary, task prompt.
- `last_error_code`, `last_error_message`.
- `created_at`, `updated_at`.

Indexes:

- `(workspace_id, source_kind, failure_key)` unique.
- `(workspace_id, external_work_id, status)`.
- `(workspace_id, channel_id, updated_at)`.
- `(workspace_id, head_sha)`.

Do not add a separate CI scheduler database. This table is a local evidence and
idempotency index for the existing external-work record.

## Contracts

Add contract/core DTOs:

```ts
export type ExternalWorkCiTriageStatus =
  | "triaged"
  | "task_created"
  | "run_requested"
  | "blocked"
  | "stale"
  | "failed";

export interface GitHubCiFailure {
  readonly repository: string;
  readonly subjectKind: "github_pull_request";
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly checkName: string;
  readonly workflowName?: string;
  readonly jobName?: string;
  readonly conclusion: "failure" | "cancelled" | "timed_out" | "action_required" | string;
  readonly htmlUrl?: string;
  readonly failureKey: string;
  readonly firstFailingCommand?: string;
  readonly reproductionCommand?: string;
  readonly suspectedSourcePath?: string;
  readonly logExcerptArtifactId?: string;
}

export interface ExternalWorkCiTriageRequest {
  readonly externalWorkId: string;
  readonly workflowPath?: string;
  readonly limit?: number;
  readonly createTask?: boolean;
  readonly startRun?: boolean;
}

export interface ExternalWorkCiTriageResponse {
  readonly cwd: string;
  readonly triaged: number;
  readonly taskCreated: number;
  readonly duplicates: number;
  readonly blocked: number;
  readonly stale: number;
  readonly failed: number;
  readonly records: readonly ExternalWorkCiTriageView[];
}
```

Phase 4.0 should target PR-owned CI only through an existing `externalWorkId`. A later
webhook/polling phase may promote `github_check` into `ExternalWorkItemKind` for
standalone check events, but that is not required for manual PR CI triage.

## Service Flow

`triageGitHubCiForExternalWork()`:

1. Load the external work record and require `github_pull_request`.
2. Parse the channel-bound `WORKFLOW.md` and resolve `source.secretRef`.
3. Re-read the current PR through the existing read-only adapter.
4. If the stored PR head SHA is stale, mark triage `stale` and do not inspect old CI.
5. Acquire `external_subject` lease for `github_pr:<repo>#<number>`.
6. List check runs and workflow runs for the current head SHA.
7. Keep only failing or action-required conclusions.
8. For each selected failure, compute `failureKey` and reuse existing records.
9. Fetch bounded job logs for GitHub Actions failures when available.
10. Redact and store normalized CI item, log excerpt, and triage summary artifacts.
11. Heuristically extract first failing command and reproduction command.
12. If `createTask !== false`, create or reuse a scoped Ling task linked in the triage
    record.
13. Phase 4.0 rejects `startRun === true` on the JSON triage endpoint. Phase 4.1 starts
    a normal task run only through the separate explicit triage-run SSE endpoint and
    existing channel policy. This remains off by default.

Failure parsing should be deliberately conservative. If the parser cannot identify a
command, it should still create evidence and a task with a clear missing-command note
instead of guessing.

## Local Fix Task

The generated task prompt should include:

- Repository and PR identifier.
- Head SHA and expected PR state.
- Check/workflow/job names.
- Failing command or missing-command note.
- Log excerpt artifact ids.
- Reproduction command when available.
- Instruction to gather local evidence first.
- Explicit prohibition on pushing commits or commenting on GitHub unless a separate
  approval-gated external action is created and approved.

The task should be created in the same channel as the external work item. If the channel
has no default provider or teammate, use the same fallback behavior as existing task
creation and external-work workflow creation.

## Future Push Fix Action

Push commits should be a later strict-action slice, not Phase 4.0. The design target is
a durable external action kind such as `github_push_commit` with:

- Exact repository, branch, expected head SHA, and commit/diff summary.
- Local git evidence artifact: status, diffstat, commit id, test evidence.
- Strict approval requirement.
- Revalidation of PR head SHA immediately before push.
- No force-push in the initial version.
- Failed or rejected GitHub push recorded as external action evidence.

Until that exists, local fix tasks may produce patches or commits locally, but publishing
them must remain outside the automated external-work executor.

## Daemon, SDK, and CLI

Daemon:

```http
POST /external-work/github/ci/triage?cwd=/path/to/project
POST /external-work/github/ci/triage/:triageId/run?cwd=/path/to/project
```

Request:

```json
{
  "externalWorkId": "external_work_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 5,
  "createTask": true,
  "startRun": false
}
```

SDK:

```ts
await client.triageGitHubExternalWorkCi("/path/to/project", {
  externalWorkId: "external_work_...",
  workflowPath: "WORKFLOW.md",
  limit: 5,
  createTask: true,
});

await client.startGitHubExternalWorkCiTriageRun(
  "/path/to/project",
  "external_work_ci_triage_...",
  { providerPresetId: "provider_..." },
);
```

CLI:

```bash
ling-stack external-work github ci triage \
  --external-work external_work_... \
  --workflow-path WORKFLOW.md \
  --limit 5

ling-stack external-work github ci run \
  --triage external_work_ci_triage_... \
  --provider provider_...
```

Human output should show counts, failure names, task ids, artifact ids, stale state, and
whether a run was requested. `--json` should return the daemon response unchanged for
triage and newline-delimited SSE events for the explicit run command.

## Web Surface

Phase 4.2 keeps CI triage inside existing Web surfaces instead of adding a GitHub page.
The daemon exposes local-only list/detail endpoints:

- `GET /external-work/github/ci/triage?cwd=...`
- `GET /external-work/github/ci/triage/:triageId?cwd=...`

The Web Workspace shows channel-level CI triage rows with failed check/workflow/job
metadata, reproduction hints, linked artifacts, and linked local fix task/run ids. The
right-side task Inspector filters the same records down to the selected task or its
current run. These reads do not call GitHub and do not start a runner. Local fix runs
remain behind the separate explicit Phase 4.1 endpoint and CLI command.

Existing approval cards remain the surface for any diagnosis comment or later GitHub
mutation proposal.

## Post-4.0 Roadmap Boundary

Phase 4.1 is useful, but it must stay narrow:

- Run a live smoke on a disposable failing PR before expanding the product surface.
- Use the explicit local fix run bridge only through existing task/run APIs:
  `POST /external-work/github/ci/triage/:triageId/run`,
  `LingDaemonClient.startGitHubExternalWorkCiTriageRun()`, and
  `ling-stack external-work github ci run --triage <id> --provider <provider>`.
- Keep `startRun` rejected on the JSON triage endpoint and avoid hidden runner startup.
- Keep push, comments, labels, review decisions, merge, and release outside CI triage.

Phase 4.0 is complete without Phase 4.1. Phase 4.1 is needed only if the product goal is
to turn CI triage into an operator-controlled local repair loop. Phase 4.1 is complete
only after both the bridge implementation and the disposable failing-PR smoke are
recorded.

## Tests

Core:

- GitHub CI adapter lists check runs and workflow runs for a head SHA using injected
  fetch.
- Failing GitHub Actions job logs are bounded, redacted, and saved as artifacts.
- Failure keys are stable and duplicate triage returns the existing record/task.
- Stale PR head SHA blocks CI triage for old external work.
- Missing logs still produce a triage record with readable error evidence.
- Task prompt includes evidence ids and external mutation prohibition.

Daemon:

- `POST /external-work/github/ci/triage` creates triage records, artifacts, and local
  tasks from mock GitHub responses.
- Duplicate triage does not create a second task.
- Invalid channel, missing external work, non-PR work item, invalid workflow path,
  missing token, GitHub HTTP error, and stale target return readable errors.
- Default triage does not start a runner.

API client and CLI:

- SDK uses the expected route, query, and body without transforming the response.
- CLI validates flags, renders human output, supports `--json`, and exposes daemon 400
  errors clearly.

Live smoke:

- Use a disposable PR with a failing GitHub Actions workflow.
- Poll/import the PR external work.
- Run CI triage.
- Verify artifacts and local task are created.
- Verify no runner starts by default and no GitHub mutation is called.

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
corepack pnpm typecheck
git diff --check
```

## Implementation Slices

1. **Docs and contracts:** land this plan, contracts, and route/CLI shape without
   behavior.
2. **Core adapter and parser:** GitHub read-only CI adapter, log redaction, failure
   extraction, and unit tests.
3. **Durable triage records:** SQLite table, store methods, idempotency, artifacts, and
   task prompt creation.
4. **Daemon/API/CLI:** manual triage endpoint, SDK method, CLI command, and tests.
5. **Phase 4.1 live smoke:** failing-check fixture repo path and reproducible local
   evidence verification against a disposable PR.
6. **Phase 4.1 local fix run bridge:** explicit run creation through existing task run
   path, still off by default from CI triage.
7. **Strict push action design:** separate implementation plan before any GitHub push
   mutation exists.
