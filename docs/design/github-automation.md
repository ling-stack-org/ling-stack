# GitHub Automation Design

## Purpose

This document defines how Ling Stack should support future GitHub automation:

- Pull request review.
- Bug and issue triage.
- CI failure investigation.
- Security review.
- Release readiness checks.
- Approval-gated comments, labels, review decisions, fixes, merges, and releases.

GitHub automation must be useful without becoming an unsafe bot. The default mode should
produce evidence artifacts and suggested actions. Any external side effect must pass
through Ling Stack policy, approvals, resource leases, and audit logs.

## Position in the Platform

GitHub is not a separate core. It is a combination of:

- Channel source adapter.
- Automation workflows.
- Tool actions.
- Evidence artifact writer.
- Optional UI feature module.

```text
GitHub webhook or poll
-> GitHub channel source adapter
-> normalized channel event
-> channel coordinator
-> kernel state machines
-> workflow run
-> runner/provider/tool execution
-> evidence artifacts
-> approval request
-> GitHub external action
```

The kernel remains the source of truth. GitHub cannot mutate tasks, runs, approvals, or
workflow states directly.

## Goals

- Let Ling Stack review PRs with the same rigor as local code review.
- Let Ling Stack triage bug reports with duplicates, reproduction notes, likely owner,
  severity, and next action.
- Let Ling Stack investigate failing checks and propose or implement a fix.
- Let users approve or reject external side effects from the Ling UI.
- Respect GitHub permissions, CODEOWNERS, branch protection, required checks, and repo
  rules.
- Preserve durable evidence so a later session can understand why an action was taken.

## Non-Goals

- No unreviewed PR approval, merge, deployment, or issue closing.
- No bypassing GitHub branch protection or required checks.
- No direct plugin database access.
- No distributed multi-node GitHub worker in v0.1.
- No broad external plugin marketplace before internal registries are stable.

## Event Model

GitHub events should be normalized before entering Ling Stack.

```ts
export type GitHubAutomationEventType =
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.review_requested"
  | "pull_request.ready_for_review"
  | "issue.opened"
  | "issue.reopened"
  | "issue_comment.created"
  | "check_suite.completed"
  | "check_run.completed"
  | "workflow_run.completed"
  | "release.published";

export interface NormalizedGitHubEvent {
  id: string;
  deliveryId: string;
  installationId?: string;
  repository: {
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
  };
  type: GitHubAutomationEventType;
  actor: string;
  receivedAt: string;
  subject: GitHubAutomationSubject;
  idempotencyKey: string;
  payloadRef: string;
}
```

The `idempotencyKey` should include the GitHub delivery id when available. For polled
events, it should include repository, subject id, event type, and source update time.

## Subject Types

```ts
export type GitHubAutomationSubject =
  | {
      kind: "pull_request";
      number: number;
      baseRef: string;
      baseSha: string;
      headRef: string;
      headSha: string;
      draft: boolean;
    }
  | {
      kind: "issue";
      number: number;
      title: string;
      labels: readonly string[];
    }
  | {
      kind: "check";
      checkName: string;
      conclusion: "success" | "failure" | "cancelled" | "timed_out" | "neutral" | "skipped";
      headSha: string;
      htmlUrl?: string;
    }
  | {
      kind: "release";
      tagName: string;
      targetCommitish: string;
    };
```

## Workflow State

GitHub automations should compile into normal Ling workflow runs.

```text
queued
-> running
-> waiting_for_approval
-> acting
-> posted | applied | skipped | failed | cancelled
```

Rules:

- Duplicate delivery with the same idempotency key returns the existing workflow run.
- New PR commits should cancel, supersede, or queue behind older review runs for the same
  PR, depending on policy.
- A review generated for an old head SHA cannot approve or request changes on a newer
  head SHA.
- A failed external action writes an audit event and preserves the proposed action body.
- A GitHub automation cannot mark itself successful until the kernel records the terminal
  transition.

## Built-In Workflows

### `github-pr-review`

Purpose:

- Review a pull request diff.
- Identify correctness, security, data migration, performance, UX, test, and docs risks.
- Produce a structured review artifact.
- Optionally draft a GitHub review comment.

Inputs:

- Repository id.
- PR number.
- Base SHA and head SHA.
- Changed files and patch metadata.
- CI status.
- CODEOWNERS and branch protection snapshot when available.
- Optional user-provided review focus.

Outputs:

- Findings with severity.
- File references.
- Test evidence.
- Suggested comment.
- Approval request if the action posts to GitHub.

Default action policy:

| Action | Policy |
| --- | --- |
| Read PR metadata and diff | Allowed |
| Write local review artifact | Allowed |
| Draft comment | Allowed |
| Post comment | Standard approval |
| Request changes | Strict approval |
| Approve PR | Strict approval and clean head SHA check |
| Merge PR | Strict approval plus branch protection |

### `github-bug-triage`

Purpose:

- Classify new issues.
- Search for duplicates.
- Identify likely component and owner.
- Reproduce when possible.
- Suggest labels and next action.

Outputs:

- Triage summary.
- Duplicate candidates.
- Reproduction steps or missing information checklist.
- Severity and confidence.
- Suggested labels.
- Suggested reply.

Default action policy:

| Action | Policy |
| --- | --- |
| Read issue and repository metadata | Allowed |
| Write local triage artifact | Allowed |
| Draft reply | Allowed |
| Add labels | Standard approval or repo policy |
| Post reply | Standard approval |
| Close issue | Strict approval |

### `github-ci-triage`

Purpose:

- Inspect failing checks.
- Identify the failing command or test.
- Connect logs back to source files.
- Produce a fix plan or create a scoped task for an Engineer teammate.

Outputs:

- Failing check summary.
- First failing command.
- Suspected root cause.
- Reproduction command.
- Fix plan.
- Optional task/run request.

Default action policy:

| Action | Policy |
| --- | --- |
| Read check logs | Allowed |
| Create local task | Allowed |
| Start local fix run | Channel policy |
| Push fix commit | Strict approval |
| Comment with diagnosis | Standard approval |

### `github-security-review`

Purpose:

- Review sensitive diffs and dependency changes.
- Flag secrets, auth boundary changes, injection risk, permission broadening, and unsafe
  external calls.

Outputs:

- Security findings.
- Evidence references.
- Required reviewer recommendation.
- Suggested blocking comment.

Default action policy:

| Action | Policy |
| --- | --- |
| Read metadata and diff | Allowed |
| Write local security artifact | Allowed |
| Post blocking comment | Strict approval |
| Request changes | Strict approval |

### `github-release-readiness`

Purpose:

- Check whether a release or deployment should proceed.
- Verify tests, changelog, migration notes, approvals, and known risk.

Outputs:

- Release readiness report.
- Missing gate list.
- Risk summary.
- Suggested release note.

Default action policy:

| Action | Policy |
| --- | --- |
| Read repo, checks, and release metadata | Allowed |
| Write readiness artifact | Allowed |
| Publish release note | Strict approval |
| Merge/deploy/release | Strict approval plus release policy |

## Resource Leases

GitHub automation should use the same lease model as local channels.

Recommended resource keys:

| Resource | When acquired |
| --- | --- |
| `github_repo:<owner>/<repo>` | Repo-level action coordination |
| `github_pr:<owner>/<repo>#<number>` | PR review, comment, approve, merge, or push |
| `github_issue:<owner>/<repo>#<number>` | Issue triage, labels, comments, or close |
| `bound_path:<realpath>` | Local checkout write or test run |
| `provider:<providerPresetId>` | Provider concurrency or rate policy |

Read-only review can run in parallel if provider and repo policies allow it. Any action
that writes to a local checkout or changes GitHub state should acquire the relevant
write lease.

## Approval Model

GitHub automations should produce proposed actions first.

```ts
export interface GitHubProposedAction {
  id: string;
  workflowRunId: string;
  repositoryFullName: string;
  subject: GitHubAutomationSubject;
  kind:
    | "post_comment"
    | "add_labels"
    | "request_changes"
    | "approve_pull_request"
    | "push_commit"
    | "merge_pull_request"
    | "close_issue"
    | "publish_release";
  targetSha?: string;
  bodyRef?: string;
  labels?: readonly string[];
  requiredApproval: "standard" | "strict";
}
```

The UI should show:

- The proposed action.
- The exact body or label set.
- The target PR/issue/release.
- The head SHA or release target.
- Evidence artifacts.
- Risk level.
- Approve, reject, or edit-and-approve.

Approval must be invalidated if the target head SHA changes before execution.

## Evidence Artifacts

Every automation run should store:

- Raw payload reference or redacted payload summary.
- Normalized event.
- Repo and subject metadata.
- Diff or check summary.
- Model/provider used.
- Teammate and skill pack used.
- Tool calls and logs.
- Findings.
- Proposed external action.
- Approval decision.
- External API result.

Evidence artifacts should be visible in run detail and usable later for audit, debugging,
and follow-up tasks.

## UI Surfaces

Recommended GitHub UI feature module:

```text
apps/web/src/features/github/
  routes.tsx
  GitHubAutomationPage.tsx
  GitHubEventTimeline.tsx
  GitHubWorkflowRunDetail.tsx
  GitHubProposedActionCard.tsx
  GitHubPolicyPanel.tsx
```

Surfaces:

- GitHub connections and token status.
- Repo bindings to Ling workspaces/channels.
- Automation policy per repo.
- Event timeline.
- PR review artifacts.
- Bug triage artifacts.
- Pending GitHub approvals.
- External action results.

Mobile/PWA should initially expose read-only summaries and approval decisions, not full
configuration.

## Secrets and Permissions

GitHub credentials must be referenced through secret refs. They must not be stored in
logs, artifacts, or plugin manifests.

Recommended scopes should be minimal for each phase:

- Read-only PR/issue/check review first.
- Comment and label scopes after approval UX is stable.
- Write, approve, merge, and release scopes only after strict approval and audit paths
  are implemented.

The GitHub adapter should degrade clearly if a token lacks permission. It should not ask
the model to infer permission failure.

## Failure and Recovery

Failure cases:

- Duplicate webhook delivery.
- Webhook arrives before local repo is synced.
- PR head SHA changes after review generation.
- GitHub token expired or lacks scope.
- Rate limit or secondary abuse prevention.
- CI log unavailable or truncated.
- User approves after approval expires.
- External action fails after approval.

Required behavior:

- Duplicate events are idempotent.
- Stale head SHA blocks external review decisions.
- Permission failure creates a visible failed external action artifact.
- Expired approval cannot execute.
- Retried external action uses the same proposed action id unless the content changes.
- Recovery reconciles queued/running GitHub workflows at daemon startup.

## Implementation Phases

### Phase 1: Read-Only Review Artifacts

- Add GitHub channel source type.
- Normalize PR and issue events from fixtures or manual imports.
- Generate local PR review and issue triage artifacts.
- No external posting.

### Phase 2: Approval-Gated Comments and Labels

- Add proposed action records.
- Add UI approval cards.
- Post comments and labels only after approval.
- Store external API result.

### Phase 3: CI Triage and Local Fix Tasks

- Import failing check metadata and logs.
- Create Ling tasks from CI failures.
- Allow local fix runs through normal channel coordinator and leases.
- Push commits only after strict approval.

### Phase 4: Review Decisions

- Request changes or approve PRs after strict approval.
- Verify target head SHA immediately before execution.
- Respect CODEOWNERS and branch protection.

### Phase 5: Merge and Release

- Merge or release only after strict approval, required checks, and release policy.
- Store release readiness report and final GitHub result.

## Test Plan

Core and daemon:

- Duplicate webhook delivery returns the same workflow run.
- PR head SHA change invalidates old approval.
- Strict actions cannot execute with standard approval.
- Failed GitHub action persists audit evidence.
- Daemon startup recovers queued/running GitHub workflows.

GitHub adapter:

- Fixture normalization for PR, issue, check, workflow, and release events.
- Permission failures are normalized.
- Rate-limit failures are retryable when safe.

UI:

- Pending proposed actions display exact target, body, and required approval.
- Approve/reject flows update timeline.
- Stale head SHA disables approval execution.
- Evidence artifacts are reachable from workflow detail.

End-to-end simulation:

- PR opened -> review artifact generated -> proposed comment created -> user approves ->
  comment action recorded.
- Issue opened -> duplicate candidates found -> labels proposed -> user rejects -> no
  GitHub mutation.
- CI failed -> diagnosis artifact generated -> local task created -> push blocked until
  strict approval.
