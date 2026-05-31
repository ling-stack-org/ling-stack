# External Work Phase 3 Implementation Plan

## Summary

Phase 3 adds the first approval-gated external mutation path for GitHub comments and
labels. It must keep the existing Phase 1 and Phase 2 read-only scheduler behavior
unchanged: importing, polling, reconciling, listing, and showing external work still do
not mutate GitHub or start runners.

The core of this phase is not the GitHub API call. The core is a durable proposed action
model that records the exact target, body, idempotency key, approval requirement, stale
target checks, execution result, and evidence artifacts before any external mutation is
allowed.

## Deliverables

- Durable `external_work_actions` records in the existing workspace SQLite store.
- Contracts for proposed external actions, action status, target snapshots, execution
  evidence, and list/detail responses.
- Approval request ownership for external actions.
- Local daemon, API client, and CLI surfaces to propose, list, show, cancel, and execute
  eligible approved actions.
- GitHub mutation adapter limited to comments and labels.
- Revalidation immediately before mutation using read-only GitHub GET calls.
- Evidence artifacts for proposed payloads, execution requests, execution responses, and
  stale-target failures.
- Tests proving denied, expired, stale, duplicate, and successful approval-gated paths.

## Scope Boundaries

In scope:

- GitHub PR and issue comments.
- GitHub PR and issue label adds.
- Proposed action creation from an existing external work item.
- Human approval before external mutation.
- Standard approval by default, with strict approval support from `WORKFLOW.md` actions
  config and repository policy hooks.
- Revalidation of PR head SHA, issue or PR state, repository, subject number, and
  update timestamp before mutation.
- Local-only action observability through daemon, SDK, and CLI.

Out of scope:

- Webhooks.
- Background polling timers.
- Runner startup from external work.
- Push commits, merge, release, issue close, PR review decisions, or deployment.
- Linear mutation support.
- Cross-repository fan-out actions.
- Automatic action generation from model output. Phase 3 creates proposed actions through
  explicit local APIs first.

## Data Model Changes

Keep all durable state in the existing Ling workspace SQLite store.

Add `external_work_actions`:

- `id`, `workspace_id`, `channel_id`, `external_work_id`.
- `source_kind`: initially `github`.
- `action_kind`: `github_comment` or `github_label`.
- `status`: `proposed`, `waiting_for_approval`, `approved`, `executing`, `succeeded`,
  `failed`, `cancelled`, `denied`, `expired`, `stale_target`.
- `approval_id`: optional link to the approval request.
- `idempotency_key`: unique per workspace and source action.
- `target_json`: repository, subject kind, subject number, URL, expected state,
  expected head SHA, expected updated-at value, and optional expected labels.
- `payload_json`: comment body or label names.
- `approval_requirement`: `standard` or `strict`.
- `artifact_ids_json`: proposed payload, execution, and failure artifacts.
- `execution_attempt_count`, `last_attempt_at`, `next_attempt_at`.
- `last_error_code`, `last_error_message`.
- `created_at`, `updated_at`, `executed_at`.

Add indexes:

- `(workspace_id, external_work_id, status)`.
- `(workspace_id, source_kind, idempotency_key)` unique.
- `(workspace_id, approval_id)`.
- `(workspace_id, updated_at)`.

Do not store GitHub tokens, authorization headers, or raw secret values in action rows or
artifacts.

## Contracts

Add action types in `@ling-stack/contracts` and `@ling-stack/core`:

```ts
export type ExternalWorkActionKind = "github_comment" | "github_label";

export type ExternalWorkActionStatus =
  | "proposed"
  | "waiting_for_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied"
  | "expired"
  | "stale_target";

export type ExternalWorkActionApprovalRequirement = "standard" | "strict";
```

`ExternalWorkActionTarget` records:

- `sourceKind`.
- `repository`.
- `subjectKind`: `github_pull_request` or `github_issue`.
- `number`.
- `url`.
- `expectedState`.
- `expectedHeadSha` for PRs.
- `expectedUpdatedAt`.
- `expectedLabels`.

`ExternalWorkActionPayload` is a discriminated union:

- `github_comment`: `body`.
- `github_label`: `labels`.

Add request and response contracts:

- `ExternalWorkActionProposeRequest`.
- `ExternalWorkActionExecuteRequest`.
- `ExternalWorkActionCancelRequest`.
- `ExternalWorkActionListRequest`.
- `ExternalWorkActionListResponse`.
- `ExternalWorkActionDetailResponse`.

## Approval Integration

Extend approval records instead of overloading run or media-job ownership:

- Add optional `externalWorkActionId` to `ApprovalRequest` and
  `CreateApprovalRequestInput`.
- Add optional `externalWorkActionId` filter to `ListApprovalRequestsOptions`.
- Add an `ApprovalPayload` variant:

```ts
{
  readonly type: "external_action";
  readonly sourceKind: "github" | "linear";
  readonly actionKind: string;
  readonly target: unknown;
  readonly preview: string;
}
```

Use `ApprovalActionType.external_send` for Phase 3 comments and labels. Later strict
actions can add more specific action types only when the approval UX needs it.

Approval decision behavior:

- Proposed actions start as `waiting_for_approval` when approval is required.
- Approval `approved` moves the action to `approved`; it does not execute implicitly
  unless the caller invokes the explicit execution endpoint.
- Approval `denied` moves the action to `denied`.
- Approval `expired` moves the action to `expired`.
- Cancelled proposed actions cancel their pending approval if one exists.
- Denied, expired, cancelled, succeeded, failed, and stale-target actions are terminal
  for the original idempotency key.

## GitHub Adapter

Add a mutation adapter separate from the Phase 2 read-only candidate adapter:

```ts
export interface GitHubExternalActionAdapter {
  getPullRequest(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined>;
  getIssue(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined>;
  createIssueComment(input: GitHubCreateIssueCommentInput): Promise<GitHubActionResult>;
  addIssueLabels(input: GitHubAddIssueLabelsInput): Promise<GitHubActionResult>;
}
```

Allowed mutation endpoints:

- `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`.
- `POST /repos/{owner}/{repo}/issues/{issue_number}/labels`.

GitHub PR comments use the issue comments API because pull requests are issues for
conversation comments. Review comments, request changes, approve review, merge, and push
are not part of Phase 3.

Adapter requirements:

- Accept injected `fetch` for deterministic tests.
- Accept the resolved GitHub token as an argument; never persist it.
- Set GitHub API version and JSON accept headers.
- Normalize rate-limit, permission, validation, missing target, and network failures.
- Return redacted request and response metadata for evidence artifacts.

## Proposed Action Flow

Propose:

1. Load external work record and scheduler state.
2. Verify the action kind is supported for the work item kind.
3. Build target snapshot from the normalized `ExternalWorkItem`.
4. Validate payload:
   - Comment body must be non-empty.
   - Labels must be non-empty, unique, and bounded.
5. Compute idempotency key from source, action kind, external work id, target snapshot,
   and payload hash.
6. Reuse an existing action for the same idempotency key.
7. Write proposed payload evidence artifact.
8. Create approval request when required.
9. Persist action as `waiting_for_approval` or `proposed`.

Execute:

1. Load action and linked external work.
2. Reject terminal statuses.
3. Require approved approval unless the action was explicitly created as no-approval in
   a local test-only path.
4. Acquire `external_subject` lease for the subject.
5. Re-read the current GitHub PR or issue using a read-only GET call.
6. Compare repository, number, state, expected head SHA, expected updated-at, and labels.
7. If stale, mark `stale_target`, write failure evidence, and do not call mutation.
8. Mark `executing` before the mutation call.
9. Execute the GitHub comment or label mutation.
10. Persist response evidence and mark `succeeded`.
11. On failure, mark `failed` with normalized error code and evidence.
12. Release the lease.

Cancel:

1. Allow only `proposed`, `waiting_for_approval`, and `approved` actions to be cancelled.
2. Cancel the pending approval when possible.
3. Mark the action `cancelled` and write a local audit artifact.
4. Never call GitHub during cancel.

## API And CLI

Add daemon endpoints:

```http
POST /external-work/actions/propose?cwd=/path/to/project
GET /external-work/actions?cwd=/path/to/project&externalWorkId=external_work_...
GET /external-work/actions/:id?cwd=/path/to/project
POST /external-work/actions/:id/cancel?cwd=/path/to/project
POST /external-work/actions/:id/execute?cwd=/path/to/project
```

`execute` is explicit so approval decisions remain separate from side effects.

Add SDK methods:

- `proposeExternalWorkAction(cwd, input)`.
- `listExternalWorkActions(cwd, options)`.
- `getExternalWorkAction(cwd, actionId)`.
- `cancelExternalWorkAction(cwd, actionId, input)`.
- `executeExternalWorkAction(cwd, actionId, input)`.

Add CLI commands:

```bash
ling-stack external-work actions propose-comment --external-work <id> --body-file comment.md
ling-stack external-work actions propose-labels --external-work <id> --label needs-review --label agent-ready
ling-stack external-work actions list [--external-work <id>] [--status waiting_for_approval]
ling-stack external-work actions show <actionId>
ling-stack external-work actions cancel <actionId> [--reason "..."]
ling-stack external-work actions execute <actionId>
```

Human output should show action id, kind, target, status, approval id, artifact ids,
stale target reason, and GitHub result URL when present. `--json` prints the daemon
response without transformation.

## Evidence Artifacts

Every action should preserve enough local evidence to audit the decision without calling
GitHub again:

- Proposed payload markdown or JSON.
- Target snapshot JSON.
- Approval preview markdown.
- Execution request metadata with redacted headers.
- Execution response metadata with GitHub result URL and response ids.
- Stale-target failure JSON.
- Normalized error JSON.

Artifacts are linked from `external_work_actions.artifact_ids_json`. Existing artifact
read APIs remain the retrieval path.

## Revalidation Rules

Before mutation, re-read the current subject and fail stale when:

- Repository no longer matches.
- PR or issue number no longer matches.
- PR head SHA changed.
- PR or issue state is no longer active.
- `updatedAt` changed and the action policy requires update-time stability.
- Label add request is already satisfied and policy says duplicate label execution is
  unnecessary.
- Approval expired or no longer matches the action id.

Stale actions never execute automatically. A user must create a new proposed action from
the fresh external work state.

## Implementation Order

1. Add contracts and store types for external work actions.
2. Add SQLite migration and store methods.
3. Extend approval records with `externalWorkActionId` and `external_action` payload.
4. Implement proposed action service with idempotency and artifact creation.
5. Add daemon list/show/propose/cancel endpoints.
6. Add API client and CLI propose/list/show/cancel surfaces.
7. Implement GitHub action adapter and execute endpoint.
8. Add CLI execute command.
9. Update docs and examples with a local approval-gated smoke path.

If the implementation needs to be split, land steps 1-6 as Phase 3.0 with no GitHub
mutation execution, then land steps 7-9 as Phase 3.1.

Phase 3.0 landed the local-only action proposal surfaces. Phase 3.1 lands the explicit
execution slice: approved comment and label actions can execute only through
`POST /external-work/actions/:id/execute`, after subject lease acquisition and GitHub
target revalidation. The adapter remains limited to issue comments and issue labels.

## Tests

Core:

- Proposed comment and label actions persist target snapshot, payload, approval
  requirement, idempotency key, and artifacts.
- Duplicate propose returns the existing action.
- Approval request links to `externalWorkActionId`.
- Denied, expired, and cancelled approvals move actions to terminal statuses.
- Execute refuses unapproved, denied, expired, cancelled, succeeded, and stale actions.
- Revalidation detects PR head SHA changes and terminal issue or PR state.
- GitHub adapter calls only the two allowed mutation endpoints.
- Token values and authorization headers are redacted from artifacts.

Daemon:

- Propose comment creates action, approval, and artifacts.
- Propose labels validates duplicate and empty labels.
- List/show return local action views without GitHub calls.
- Cancel does not call GitHub and cancels pending approval.
- Execute performs revalidation before mutation.
- Stale revalidation writes evidence and skips the mutation call.
- GitHub permission, validation, rate-limit, and network errors return readable errors.

API client and CLI:

- SDK methods use the expected routes, query params, and request bodies.
- CLI propose-comment reads UTF-8 markdown.
- CLI propose-labels supports repeated `--label`.
- CLI list/show/cancel/execute render human output and support `--json`.
- Missing ids, missing payload files, invalid labels, and daemon 400 errors are readable.

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

- A local operator can propose a GitHub comment or label action from an existing external
  work item.
- The proposed action is durable, idempotent, visible through API/CLI, and linked to
  artifacts.
- Required approval is durable and linked to the proposed action.
- No GitHub mutation can happen before approval.
- Approved actions revalidate the current GitHub target immediately before mutation.
- Stale, denied, expired, cancelled, or duplicate actions do not mutate GitHub.
- Successful mutations persist redacted request/response evidence and final action
  status.
