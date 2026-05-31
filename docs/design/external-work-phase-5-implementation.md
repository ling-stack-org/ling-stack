# External Work Phase 5 Implementation Plan

## Summary

Phase 5 closes the first GitHub-first operator loop by adding one strict external
mutation beyond comments and labels: a GitHub pull request review action.

The first implementation should be intentionally narrow. It should reuse the existing
external work records, local teammate runs, artifacts, durable proposed actions,
approvals, Web Inbox cards, and explicit execute endpoint. It should not add push,
merge, release, webhook, background polling, inline review comments, or edit-and-approve
behavior.

The target end-to-end path is:

```text
GitHub PR import or poll
-> local workflow and isolated workspace
-> optional local teammate run and evidence
-> proposed github_pr_review action
-> strict approval card
-> explicit execute
-> stale target revalidation
-> GitHub PR review API call
-> execution evidence artifact
```

Phase 5 is the point where Ling Stack proves that external work can move from discovery
and local evidence into a controlled external side effect without becoming an unmanaged
bot.

## Current Baseline

Already shipped before this phase:

- Manual GitHub PR/issue import.
- Manual GitHub poll and local reconcile.
- Durable scheduler state, leases, isolated workspaces, and hook evidence.
- Approval-gated GitHub comment and label actions.
- Web Inbox external action approval cards and audit panels.
- Manual GitHub CI triage, local fix task creation, explicit local fix run bridge, and
  Web CI triage audit surfaces.

Still enforced:

- No webhook receiver.
- No background polling loop.
- No automatic runner start from external work.
- No GitHub mutation without a durable external action, approval, explicit execute call,
  and stale-target revalidation.
- No automatic push, force-push, merge, release, issue close, or PR review decision.

## Goals

- Add a durable `github_pr_review` external action kind.
- Support PR review events `COMMENT`, `APPROVE`, and `REQUEST_CHANGES`.
- Require strict approval for every PR review action, including comment-only PR reviews.
- Restrict PR review actions to `github_pull_request` external work items.
- Revalidate the PR target immediately before execution, including expected head SHA and
  PR open state.
- Write proposed payload, target snapshot, approval preview, execution result, and
  failure/stale evidence as local artifacts.
- Surface PR review proposals in the existing CLI, SDK, daemon API, Web Inbox, and
  approval inspector flows.

## Non-Goals

- No inline review comments, file paths, positions, or suggested changes.
- No edit-and-approve. Users cancel and re-propose if the body or event is wrong.
- No push commits.
- No merge.
- No release.
- No issue close or state transition.
- No new GitHub page in Web.
- No webhook receiver or background scheduler loop.
- No Linear or second source adapter in this phase.

## Action Contract

Add one action kind:

```ts
type ExternalWorkActionKind =
  | "github_comment"
  | "github_label"
  | "github_pr_review";
```

Add one payload shape:

```ts
type GitHubPrReviewActionPayload = {
  type: "github_pr_review";
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
};
```

Validation rules:

- `actionKind` must be `github_pr_review`.
- `payload.type` must be `github_pr_review`.
- `payload.event` must be one of `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`.
- `payload.body` must be a non-empty string after trimming.
- The linked external work item must have `kind: "github_pull_request"`.
- `approvalRequirement` must be `strict`. Missing approval requirement should default to
  `strict`; `standard` must be rejected.

The action title, description, and preview should include the review event and a compact
body preview. For `APPROVE`, the body is still required so the audit trail records the
reason for approval.

## GitHub API Boundary

Execution may call only this mutation endpoint for the new action:

```http
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

Request body:

```json
{
  "event": "COMMENT",
  "body": "Review body"
}
```

The executor must continue to perform a read-only target check before mutation:

- `GET /repos/{owner}/{repo}/pulls/{pull_number}` for pull requests.
- The current PR state must still be open.
- The current head SHA must match the durable target snapshot.

If the target is stale, execution records `stale_target`, writes a stale evidence
artifact, and skips the mutation call.

Token handling stays unchanged:

- `source.secretRef` resolves through the daemon secret resolver.
- Token values are passed only to the adapter for the current request.
- Tokens and authorization headers are never stored in SQLite or artifacts.
- Request and response evidence must be redacted before artifact write.

## UX and CLI Surface

The existing external action proposal, list, show, cancel, approve, and execute flow
remains the source of truth.

Add one CLI helper:

```bash
ling-stack external-work actions propose-review \
  --external-work external_work_... \
  --event COMMENT \
  --body-file review.md
```

The CLI should default review proposals to strict approval. Passing
`--approval standard` should fail with a readable error before the daemon request when
possible; the daemon must also reject it.

Web should stay inside the existing Inbox and Inspector surfaces:

- Show action kind `github_pr_review`.
- Show review event.
- Show body preview.
- Show repository, PR number, URL, expected state, expected head SHA, attempt count, last
  error, and linked artifacts.
- Show Approve/Deny while approval is pending.
- Show Execute action only after strict approval.
- Never execute as a side effect of approving.

## Tests

Core:

- Proposing `github_pr_review` creates a durable action and strict approval.
- `standard` approval is rejected for `github_pr_review`.
- Issue external work is rejected for `github_pr_review`.
- Empty body and unsupported event are rejected.
- Duplicate propose returns the existing action.
- Execute calls only `POST /repos/{owner}/{repo}/pulls/{number}/reviews`.
- Stale head SHA blocks execution before mutation.
- Execution writes redacted evidence artifacts.

Daemon:

- `POST /external-work/actions/propose` accepts a valid PR review proposal.
- Invalid event, empty body, issue target, and non-strict approval return readable 400s.
- Approved PR review execute succeeds with mock fetch.
- Stale target execute records `stale_target` and does not call the review endpoint.

CLI and SDK:

- SDK forwards the review proposal request unchanged.
- `external-work actions propose-review` sends the strict review payload.
- Invalid event, missing body file, and `--approval standard` fail clearly.

Web:

- Approval card displays PR review event, body preview, target metadata, action status,
  and artifacts.
- Approval does not execute the action.
- Execute action appears only after approval.
- Failed and stale actions are read-only and expose error/evidence.

Verification:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/cli test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
corepack pnpm typecheck
corepack pnpm test
git diff --check
```

## Completion Criteria

- A PR external work item can propose a strict PR review action from local evidence.
- The proposal appears in CLI/API/Web with enough target and payload detail to audit.
- Approval and execution remain separate.
- Execution revalidates target state immediately before calling GitHub.
- Every success, failure, and stale target writes evidence artifacts.
- No push, merge, release, inline review comment, webhook, or background loop is added.
