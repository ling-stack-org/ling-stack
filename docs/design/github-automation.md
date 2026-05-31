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

GitHub automation is the first concrete implementation of the broader
[External Work Orchestration](external-work-orchestration.md) design. It should adopt
the external scheduler, claim/reconciliation, retry/backoff, workspace isolation, and
approval-gated action semantics defined there while keeping GitHub-specific event and
permission details in this document.

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
-> external scheduler claim and reconciliation
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

The GitHub source adapter only normalizes GitHub payloads and reads GitHub state. The
scheduler decides whether the subject should run, the channel coordinator acquires
leases and starts Ling workflows, and the external action executor performs approved
GitHub mutations.

## Goals

- Let Ling Stack review PRs with the same rigor as local code review.
- Let Ling Stack triage bug reports with duplicates, reproduction notes, likely owner,
  severity, and next action.
- Let Ling Stack investigate failing checks and propose or implement a fix.
- Let users approve or reject external side effects from the Ling UI.
- Respect GitHub permissions, CODEOWNERS, branch protection, required checks, and repo
  rules.
- Preserve durable evidence so a later session can understand why an action was taken.
- Reconcile webhook and polling races without duplicate runs.
- Isolate per-PR or per-issue workspaces for installs, tests, git operations, and local
  fixes.

## Non-Goals

- No unreviewed PR approval, merge, deployment, or issue closing.
- No bypassing GitHub branch protection or required checks.
- No direct plugin database access.
- No distributed multi-node GitHub worker in v0.1.
- No broad external plugin marketplace before internal registries are stable.
- No GitHub-specific workflow state path separate from Ling workflows and workflow
  steps.

## Repository Workflow Contract

GitHub repositories should be able to opt into automation through a Ling `WORKFLOW.md`
file. The shared schema is defined in
[External Work Orchestration](external-work-orchestration.md). GitHub-specific source
config should include the repository, event set, optional label filters, and token
secret ref.

Minimal GitHub example:

```md
---
source:
  kind: github
  repository: openclaw/openclaw
  events:
    - pull_request.opened
    - pull_request.synchronize
    - issue.opened
scheduler:
  pollIntervalMs: 30000
  maxConcurrentWorkItems: 4
workspace:
  root: ~/.ling-stack/workspaces/openclaw
  mode: per_subject
hooks:
  afterCreate: |
    git clone git@github.com:openclaw/openclaw.git .
  beforeRun: |
    git fetch origin "$GITHUB_HEAD_REF"
agent:
  teammateId: engineer
  requestedSkillId: review
actions:
  defaultExternalMutationApproval: strict
---

Review {{ item.identifier }} and produce evidence first. Do not post comments,
request changes, push commits, or merge unless Ling creates and approves a proposed
GitHub action.
```

Invalid GitHub workflow config blocks new dispatch for that repository but must not
crash the daemon. Reload failures keep the last known good effective config and surface
a visible diagnostics error.

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

Webhook and poll normalization must produce the same subject identity. If both observe
the same PR update, the scheduler should return the existing workflow or claim rather
than starting a second run.

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
unclaimed
-> claimed
-> workspace_preparing
-> queued
-> running
-> waiting_for_approval
-> acting
-> posted | applied | skipped | failed | cancelled | superseded
```

Rules:

- Duplicate delivery with the same idempotency key returns the existing workflow run.
- Claims are durable workflow or workflow-step facts, not in-memory-only scheduler
  state.
- New PR commits should cancel, supersede, or queue behind older review runs for the same
  PR, depending on policy.
- A review generated for an old head SHA cannot approve or request changes on a newer
  head SHA.
- A failed external action writes an audit event and preserves the proposed action body.
- A GitHub automation cannot mark itself successful until the kernel records the terminal
  transition.
- A GitHub subject that becomes terminal or irrelevant during reconciliation cancels or
  supersedes non-terminal Ling workflows through normal state transitions.

## Scheduler and Reconciliation

GitHub automation may start from webhook delivery, polling, or manual import. All three
paths must converge on the same scheduler contract:

1. Normalize the GitHub subject.
2. Validate `WORKFLOW.md` and source credentials.
3. Acquire the subject claim lease.
4. Prepare or reuse the isolated workspace.
5. Create or reuse a Ling workflow and workflow step with the source idempotency key.
6. Start a runner only through channel coordinator policy.
7. Reconcile source state before retry, approval execution, and terminal transition.

Reconciliation runs at daemon startup, on scheduler ticks, after webhook delivery, and
before approved GitHub mutations.

It must detect:

- PR head SHA changes after review generation.
- Issues or PRs closed while a workflow is queued or running.
- Check reruns replacing older failing check data.
- Running workflows with no active runner after daemon restart.
- Active leases past expiry.
- Proposed actions whose target SHA or target state is stale.

Required behavior:

- Stale PR head SHA invalidates comments tied to old diffs, review decisions, pushes,
  merges, and approvals.
- Terminal source state cancels or supersedes queued/running workflows.
- Lost runners become failed or blocked according to Ling recovery policy.
- Reconciliation never posts to GitHub directly; it only updates Ling state or creates
  proposed actions.

## Retry and Backoff

GitHub failures should be classified before retry.

Retryable by default:

- GitHub rate limits with retry-after metadata.
- Network timeouts.
- Check log fetch timeouts.
- Provider or runner timeouts before external mutation.
- Workspace hook dependency installation failures that are not deterministic.

Not retryable without a new source event or user action:

- Missing or invalid GitHub credentials.
- Permission denied for the requested GitHub scope.
- Stale PR head SHA.
- Denied or expired approval.
- Branch protection blocks merge or review action.
- A GitHub mutation may have partially succeeded without an idempotent proposed action
  record.

Backoff should be exponential with jitter and bounded by the repository workflow config.
Each retry attempt writes timeline evidence with the failure class, attempt number, next
due time, and whether the retry is automatic or requires human action.

## Workspace Isolation and Hooks

GitHub automation should use one isolated workspace per PR or issue by default:

```text
.ling-stack/
  external-work/
    github/
      owner_repo/
        pr_123/
          repo/
          logs/
          artifacts/
```

Rules:

- Runner cwd is the isolated `repo/` directory.
- `afterCreate` can clone the repository and install durable toolchain state.
- `beforeRun` can fetch refs, check out the target SHA, install dependencies, or run
  preflight checks.
- `afterRun` can collect logs, summaries, coverage, or screenshots.
- `beforeRemove` can preserve final evidence before workspace cleanup.
- Hooks are shell commands, so they require the same local write and shell approval
  posture as normal runs.
- Hook output is redacted and stored as evidence.
- Workspace cleanup never deletes Ling state-transition history, approval records, or
  copied artifacts.

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
| `workflow_step:<id>` | Step start, retry, or handoff |
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

External mutation execution must re-read the current GitHub subject immediately before
the API call. If the head SHA, issue state, required checks, branch protection, or
approval target no longer matches the proposed action, the executor records a stale
target failure and does not call the mutation endpoint.

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
- Poll and webhook race claim the same subject.
- Webhook arrives before local repo is synced.
- PR head SHA changes after review generation.
- GitHub token expired or lacks scope.
- Rate limit or secondary abuse prevention.
- CI log unavailable or truncated.
- User approves after approval expires.
- External action fails after approval.
- Workspace hook fails before a run starts.
- Daemon restarts while a GitHub workflow is blocked on approval.

Required behavior:

- Duplicate events are idempotent.
- Subject claims use resource leases and source idempotency keys.
- Stale head SHA blocks external review decisions.
- Permission failure creates a visible failed external action artifact.
- Expired approval cannot execute.
- Retried external action uses the same proposed action id unless the content changes.
- Recovery reconciles queued/running GitHub workflows at daemon startup.
- Hook failures are recorded as attempt evidence and classified for retry.
- Blocked approvals survive daemon restart because they are persisted by Ling, not held
  only in scheduler memory.

## Implementation Phases

### Phase 1: Read-Only Review Artifacts

- Add GitHub channel source type and `WORKFLOW.md` parsing for GitHub repositories.
- Normalize PR and issue events from fixtures or manual imports.
- Create durable workflow/workflow-step records with source idempotency keys.
- Generate local PR review and issue triage artifacts.
- No external posting.

### Phase 2: Scheduler Claims, Reconciliation, and Workspaces

Implementation plan: [External Work Phase 2 Implementation](external-work-phase-2-implementation.md).

- Add GitHub polling for candidate PRs and issues.
- Add source, subject, workspace, and bound path claim leases.
- Add manual reconciliation for local scheduler state and optional remote terminal checks.
- Add per-subject isolated workspaces and manually enabled workspace hooks.
- Capture hook logs and retry/backoff evidence.

### Phase 3: Approval-Gated Comments and Labels

- Implementation plan: [External Work Phase 3 Implementation](external-work-phase-3-implementation.md).

- Add proposed action records for comments and labels.
- Link proposed actions to durable approval requests.
- Land propose/list/show/cancel before mutation execution so operators can inspect local
  action, approval, and artifact state without any GitHub side effect.
- Land explicit execute for approved comment/label actions only; execution revalidates
  the target and refuses stale PR heads or terminal subjects before any mutation call.
- Land Web Inbox approval cards and action audit for pending and terminal GitHub
  external actions; approval and execution remain separate UI actions.
- Keep the Phase 3 live validation path in
  [External Work Live Smoke](../external-work-live-smoke.md): the default helper polls a
  real repository, creates local evidence and a proposed action, cancels it, and verifies
  no runner starts; actual comments or labels require the documented separate approval
  and execute step on a disposable test target.
- Post comments and labels only after approval and immediate stale-target revalidation.
- Store external API results, stale-target failures, and redacted request/response
  evidence.

### Phase 4: CI Triage and Local Fix Tasks

- Implementation plan: [External Work Phase 4 Implementation](external-work-phase-4-implementation.md).

- Import failing check metadata, workflow run/job metadata, and bounded redacted logs.
- Create Ling tasks from CI failures by default, linked to the originating PR external
  work item and evidence artifacts.
- Allow local fix runs only through the normal channel coordinator, task run endpoint,
  provider preflight, approval policy, and resource leases.
- Keep push commits out of Phase 4.0; add them only as a later strict external action
  with head-SHA revalidation and evidence.

### Phase 5: Review Decisions

- Request changes or approve PRs after strict approval.
- Verify target head SHA immediately before execution.
- Respect CODEOWNERS and branch protection.

### Phase 6: Merge and Release

- Merge or release only after strict approval, required checks, and release policy.
- Store release readiness report and final GitHub result.

## Test Plan

Core and daemon:

- Duplicate webhook delivery returns the same workflow run.
- Poll and webhook race produces one subject claim.
- PR head SHA change invalidates old approval.
- Strict actions cannot execute with standard approval.
- Failed GitHub action persists audit evidence.
- Daemon startup recovers queued/running GitHub workflows.
- Workspace hook failure records retry evidence.
- Terminal GitHub subject state cancels or supersedes active Ling workflow state.

GitHub adapter:

- Fixture normalization for PR, issue, check, workflow, and release events.
- Permission failures are normalized.
- Rate-limit failures are retryable when safe.

UI:

- Pending proposed actions display exact target, body, and required approval.
- Approve/reject flows update the Inbox card and linked action status without executing
  the external mutation.
- Approved actions require a separate `Execute action` click before Web calls the
  explicit execute endpoint.
- Stale head SHA disables approval execution.
- Evidence artifacts are reachable from workflow detail.

End-to-end simulation:

- PR opened -> review artifact generated -> proposed comment created -> user approves ->
  comment action recorded.
- Issue opened -> duplicate candidates found -> labels proposed -> user rejects -> no
  GitHub mutation.
- CI failed -> diagnosis artifact generated -> local task created -> push blocked until
  strict approval.
