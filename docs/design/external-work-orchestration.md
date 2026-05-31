# External Work Orchestration

## Purpose

This document defines how Ling Stack should ingest work from external trackers and
turn it into auditable AI teammate workflows.

External work orchestration covers:

- GitHub issues, pull requests, checks, and releases.
- Future Linear issues.
- Future Slack, Feishu, email, or custom ticket sources.
- Repository-owned workflow contracts.
- Scheduler claim, reconciliation, retry, and workspace preparation.
- Approval-gated external actions such as comments, labels, review decisions, pushes,
  merges, releases, and ticket state changes.

This design is inspired by issue-to-agent orchestration systems such as Symphony, but
the Ling Stack implementation must remain native to Ling's product model: channels,
tasks, workflow steps, resource leases, approvals, state transitions, evidence
artifacts, and provider policy.

## Position in the Platform

External work is not a separate scheduler core. It enters the platform through channel
source adapters and is coordinated by the same daemon/kernel path as local Web and CLI
work.

```text
external tracker event or poll
-> channel source adapter
-> normalized external work item
-> scheduler claim and reconciliation
-> channel coordinator
-> kernel state machines
-> workflow and workflow step
-> runner/provider/tool execution
-> evidence artifacts
-> approval request
-> external action executor
```

The kernel remains the source of truth. Adapters, schedulers, and external action
executors must not mutate durable task, run, workflow, approval, or lease state
directly.

## Goals

- Turn external issues and PRs into repeatable daemon workflows instead of one-off
  scripts.
- Keep workflow prompts and runtime policy versioned with the repository.
- Support bounded concurrency across repositories, subjects, providers, and local
  checkouts.
- Preserve enough evidence to explain why an external action was proposed or executed.
- Recover safely after daemon restart, webhook duplicate delivery, poll races, stale
  head SHAs, runner crashes, provider timeouts, and approval delays.
- Add GitHub issue and PR support first. Linear should be a later adapter using the
  same source and scheduler contracts.

## Non-Goals

- No second durable orchestration database separate from Ling's workspace store.
- No unmanaged background bot that bypasses approvals.
- No direct merge, release, issue close, label mutation, or PR review decision without
  Ling policy and approval checks.
- No hard-coded Linear-first domain model.
- No distributed multi-node worker in v0.1.
- No long-running agent loop that can self-create hidden work outside workflow state.

## Ling `WORKFLOW.md`

`WORKFLOW.md` is the repository-owned contract for external work orchestration. It
describes which external source is active, how work is selected, where isolated
workspaces live, which hooks prepare those workspaces, and how prompts are rendered.

### Discovery

Workflow file path precedence:

1. Explicit channel or repository binding setting.
2. `WORKFLOW.md` at the bound repository root.
3. Future workspace-level default template.

The file should be version-controlled with the repository. Missing or invalid workflow
configuration blocks new dispatch for that repository but must not crash the daemon.

### Format

`WORKFLOW.md` is Markdown with optional YAML front matter. The body is the prompt
template for the selected work item.

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
  maxRetryBackoffMs: 300000
workspace:
  root: ~/.ling-stack/workspaces/openclaw
  mode: per_subject
hooks:
  afterCreate: |
    git clone git@github.com:openclaw/openclaw.git .
  beforeRun: |
    corepack pnpm install --frozen-lockfile
agent:
  teammateId: engineer
  requestedSkillId: review
  maxTurns: 20
actions:
  defaultExternalMutationApproval: strict
---

You are working on {{ item.kind }} {{ item.identifier }}.

Title: {{ item.title }}
URL: {{ item.url }}

Produce evidence first. Do not post to GitHub unless Ling creates and approves a
proposed external action.
```

### Front Matter Schema

Top-level keys:

- `source`: external system and work-item selection.
- `scheduler`: claim, polling, concurrency, retry, and reconciliation settings.
- `workspace`: per-item workspace root and isolation policy.
- `hooks`: shell hooks for workspace lifecycle.
- `agent`: teammate, skill, provider, tool, and turn defaults.
- `actions`: external mutation policy.

Unknown keys should be ignored for forward compatibility and exposed as warnings in
diagnostics.

### Source Config

```ts
export type ExternalSourceKind = "github" | "linear";

export interface ExternalWorkflowSourceConfig {
  readonly kind: ExternalSourceKind;
  readonly repository?: string;
  readonly projectSlug?: string;
  readonly events?: readonly string[];
  readonly activeStates?: readonly string[];
  readonly terminalStates?: readonly string[];
  readonly secretRef?: string;
}
```

Rules:

- `github` is the first supported source kind.
- `linear` is a later adapter and must reuse the same normalized work-item contract.
- Secrets are referenced by `secretRef` or provider-specific defaults. Raw tokens must
  not be stored in `WORKFLOW.md`, logs, artifacts, or renderer state.
- Event and state names are source-specific at the adapter boundary, then normalized
  before entering the scheduler.

### Scheduler Config

```ts
export interface ExternalWorkflowSchedulerConfig {
  readonly pollIntervalMs: number;
  readonly maxConcurrentWorkItems: number;
  readonly maxConcurrentByKind?: Readonly<Record<string, number>>;
  readonly maxRetryBackoffMs: number;
  readonly staleRunTimeoutMs?: number;
  readonly reconcileOnStartup: boolean;
}
```

Defaults:

```ts
{
  pollIntervalMs: 30000,
  maxConcurrentWorkItems: 4,
  maxRetryBackoffMs: 300000,
  reconcileOnStartup: true
}
```

Scheduler config applies to future dispatch and retry decisions. Invalid reloads keep
the last known good effective config and emit a visible configuration error.

### Workspace Config and Hooks

```ts
export type ExternalWorkspaceMode = "per_subject" | "per_attempt";

export interface ExternalWorkspaceConfig {
  readonly root: string;
  readonly mode: ExternalWorkspaceMode;
  readonly cleanupTerminalWorkItems: boolean;
}

export interface ExternalWorkspaceHooks {
  readonly afterCreate?: string;
  readonly beforeRun?: string;
  readonly afterRun?: string;
  readonly beforeRemove?: string;
  readonly timeoutMs: number;
}
```

Rules:

- `workspace.root` resolves to an absolute path.
- Relative paths resolve relative to the selected `WORKFLOW.md`.
- `per_subject` maps one external subject to one reusable workspace.
- `per_attempt` creates a new workspace for every retry or rerun and is safer for
  destructive experiments.
- Hooks run inside the isolated workspace with a scoped environment.
- Hook output is stored as evidence. Secrets are redacted.
- Hook failures abort the affected attempt except `afterRun` and `beforeRemove`, which
  are logged and do not hide the original run result.

## Normalized Work Item

External adapters normalize source-specific payloads before scheduler decisions.

```ts
export type ExternalWorkItemKind =
  | "github_pull_request"
  | "github_issue"
  | "github_check"
  | "github_release"
  | "linear_issue";

export interface ExternalWorkItem {
  readonly id: string;
  readonly sourceKind: ExternalSourceKind;
  readonly kind: ExternalWorkItemKind;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly state: string;
  readonly priority?: number;
  readonly labels: readonly string[];
  readonly repository?: {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch: string;
  };
  readonly branchName?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly blockedBy?: readonly ExternalWorkItemBlocker[];
  readonly updatedAt?: string;
  readonly payloadRef: string;
  readonly idempotencyKey: string;
}
```

`idempotencyKey` must identify the source delivery or poll snapshot. Duplicate webhook
deliveries and poll retries must return the existing workflow or scheduler claim.

## Tracker Adapter Contract

Channel source adapters own external API normalization only. They do not decide whether
work should run, mutate Ling state, or execute external side effects.

```ts
export interface ExternalTrackerAdapter {
  readonly kind: ExternalSourceKind;
  loadCandidates(config: ExternalWorkflowSourceConfig): Promise<readonly ExternalWorkItem[]>;
  getWorkItem(id: string, config: ExternalWorkflowSourceConfig): Promise<ExternalWorkItem | undefined>;
  getTerminalWorkItems(config: ExternalWorkflowSourceConfig): Promise<readonly ExternalWorkItem[]>;
  normalizeWebhook(payload: unknown): Promise<ExternalWorkItem | undefined>;
}
```

Adapters must:

- Normalize labels and states.
- Preserve source identifiers and payload references.
- Surface permission and rate-limit failures as typed adapter errors.
- Avoid sending cookies, raw token values, or private payload bodies to model providers.
- Leave comments, labels, review decisions, issue closing, and merges to the external
  action executor.

## Scheduler State Machine

The scheduler turns normalized work items into Ling workflow records.

```text
unclaimed
-> claimed
-> workspace_preparing
-> ready_to_run
-> running
-> waiting_for_approval
-> retry_queued
-> succeeded | failed | cancelled | superseded
```

This is scheduler state. It must compile into durable Ling workflow and workflow-step
state transitions rather than existing only in memory.

Rules:

- The scheduler claims an item before workspace preparation.
- Claims acquire source-specific resource leases such as `github_pr:<repo>#<number>`.
- The workflow step owns the run request and receives the idempotency key.
- A newer source update can supersede an older queued or running item according to
  repository policy.
- Terminal external states cancel active or retry-queued workflows.
- Daemon startup reconciles durable workflows, external source state, active leases,
  and workspace directories.

## Claiming and Resource Leases

Recommended lease keys:

| Resource | When acquired |
| --- | --- |
| `external_source:<kind>:<scope>` | Source-level poll or webhook reconciliation |
| `github_repo:<owner>/<repo>` | Repo-level scheduling or mutation coordination |
| `github_pr:<owner>/<repo>#<number>` | PR review, CI triage, push, review decision, or merge |
| `github_issue:<owner>/<repo>#<number>` | Issue triage, labels, comments, or close |
| `bound_path:<realpath>` | Local checkout write, install, test, or git operation |
| `workflow_step:<id>` | Step start or retry attempt |
| `provider:<providerPresetId>` | Provider concurrency and rate policy |

Read-only analysis may run in parallel when channel policy allows it. Any local write,
shell hook, git mutation, or external mutation must acquire the relevant lease before
execution.

## Retry and Backoff

Retry decisions must distinguish transient failure from unsafe replay.

Retryable by default:

- Tracker rate limits with retry-after metadata.
- Network timeouts.
- Provider timeouts.
- Workspace hook transient dependency failures.
- Runner crash before an external action is approved or executed.

Not retryable without new source state or user action:

- Invalid `WORKFLOW.md`.
- Missing credentials.
- Permission denied for required external scopes.
- Stale PR head SHA.
- Denied or expired approval.
- Hook failure caused by deterministic repository errors.
- External mutation that may have partially succeeded without an idempotent action id.

Backoff should be exponential with jitter up to `maxRetryBackoffMs`. Retry attempts must
be visible in the workflow timeline and evidence artifacts.

## Reconciliation

Reconciliation runs at startup, on a fixed cadence, and after source events.

It must detect:

- Active Ling workflows whose external work item moved to a terminal state.
- PR review or approval workflows whose head SHA changed.
- Retry entries whose due time has passed.
- Running workflows with no active runner after daemon restart.
- Active leases past expiry.
- Workspaces for terminal items eligible for cleanup.
- Proposed external actions whose target is no longer current.

Required behavior:

- Terminal external state cancels or supersedes non-terminal Ling workflows.
- Stale head SHA invalidates proposed review decisions, comments tied to old diffs,
  pushes, merges, and approvals.
- Lost runners become failed or blocked according to recovery policy.
- Cleanup is explicit and evidence-preserving. Deleting a workspace must never delete
  Ling artifacts or state-transition history.

## Approval-Gated External Actions

All external mutations compile into proposed actions first.

```ts
export type ExternalActionKind =
  | "post_comment"
  | "add_labels"
  | "remove_labels"
  | "request_changes"
  | "approve_pull_request"
  | "push_commit"
  | "merge_pull_request"
  | "close_issue"
  | "transition_ticket_state"
  | "publish_release";

export interface ExternalProposedAction {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowStepId?: string;
  readonly sourceKind: ExternalSourceKind;
  readonly subjectId: string;
  readonly kind: ExternalActionKind;
  readonly targetSha?: string;
  readonly targetState?: string;
  readonly bodyRef?: string;
  readonly labels?: readonly string[];
  readonly requiredApproval: "standard" | "strict";
  readonly idempotencyKey: string;
}
```

Execution rules:

- Read-only evidence writing does not require external action approval.
- External comments and labels require at least standard approval unless repository
  policy is stricter.
- Review decisions, pushes, merges, releases, ticket closes, and state transitions
  require strict approval.
- Approval is invalid if the target SHA, target state, or proposed body changes.
- External execution uses the proposed action id as the idempotency key whenever the
  external API supports it.
- The executor persists request metadata, response metadata, and failure details without
  logging raw secrets.

## Workspace Isolation

Each external item should run in a workspace that is separate from the Ling Stack
monorepo and separate from other external items.

Recommended path shape:

```text
.ling-stack/
  external-work/
    github/
      openclaw_openclaw/
        pr_1234/
          repo/
          logs/
          artifacts/
```

Rules:

- Runner cwd is the isolated `repo/` path, not the Ling Stack project directory.
- `afterCreate` may clone or initialize the repo.
- `beforeRun` may install dependencies, fetch refs, or check out the target SHA.
- `afterRun` may collect logs and summaries.
- `beforeRemove` may upload or preserve final evidence before workspace cleanup.
- Workspace cleanup never removes durable Ling state, audit records, approval records,
  or artifact copies.

## Evidence Artifacts

Every external workflow should preserve:

- Workflow config version or hash.
- Normalized work item.
- Source payload reference or redacted payload summary.
- Claim, retry, and reconciliation decisions.
- Workspace hook logs.
- Runner events.
- Tool calls and outputs.
- Diff, check, or issue summaries.
- Proposed actions and approval decisions.
- External API execution results.
- Final state-transition timeline.

Evidence must be visible from run detail, workflow detail, and external automation
feature modules.

## Failure Modes

Critical failure modes:

- Duplicate webhook delivery creates two runs.
- Poll and webhook race claim the same item.
- A PR head SHA changes after review but before approval.
- A local workspace hook writes outside its isolated root.
- A denied approval is retried as if it were transient.
- A GitHub or Linear token loses permission mid-run.
- Daemon restart loses in-memory blocked state.
- External action succeeds but local persistence fails.

Required mitigations:

- Idempotency keys on source events, workflow starts, state transitions, and proposed
  actions.
- Resource leases for source subjects and local checkout paths.
- Head-SHA and state revalidation immediately before external mutation.
- Approval state persisted in SQLite.
- Last-known-good workflow config for reload failures.
- External action execution records persisted before and after the API call.

## Implementation Phases

### Phase 1: GitHub Read-Only Scheduler

- Parse Ling `WORKFLOW.md` for GitHub repository bindings.
- Normalize GitHub PR and issue fixtures/manual imports into `ExternalWorkItem`.
- Create durable workflow and workflow-step records.
- Expose manual imports through the API client and `ling-stack external-work github import`.
- Generate evidence artifacts only. No external mutation.
- Keep copy-pasteable read-only smoke fixtures under `examples/external-work/github/`.

### Phase 2: GitHub Polling, Claims, and Workspaces

Implementation plan: [External Work Phase 2 Implementation](external-work-phase-2-implementation.md).

- Add GitHub poll adapter for PR and issue candidates.
- Add claim leases for repo, PR, issue, workflow step, and bound path.
- Create per-subject isolated workspaces.
- Run `afterCreate` and `beforeRun` hooks with evidence capture when manually enabled.
- Add manual reconciliation for leases, terminal workflow steps, retry backoff, and optional remote terminal checks.
- Keep startup reconciliation local-only until a background scheduler loop exists.
- Keep the example smoke path authenticated with `env:GITHUB_TOKEN` and isolated on a
  non-default daemon port so poll/reconcile docs remain copy-pasteable on developer
  machines with existing daemons.
- Expose local-only list/show observability for external work records, workflow/step
  links, scheduler state, workspace paths, errors, and artifact refs before adding any
  approval-gated GitHub mutation path.

### Phase 3: Approval-Gated Comments and Labels

- Add `ExternalProposedAction` records for comments and labels.
- Add UI approval cards.
- Execute approved GitHub comments and labels through the daemon action executor.
- Store external API results and stale-target failures.

### Phase 4: CI Triage and Local Fix Tasks

- Normalize failing checks and workflow runs.
- Create scoped Ling tasks from CI failures.
- Allow local fix runs through normal channel coordinator and leases.
- Require strict approval for push commits.

### Phase 5: Review Decisions, Merge, and Release

- Add strict-approval PR review decisions.
- Add merge and release proposed actions.
- Revalidate branch protection, required checks, target SHA, and CODEOWNERS before
  execution.

### Phase 6: Linear Adapter

- Add `linear` source adapter using the same normalized work item, scheduler, workspace,
  approval, and evidence contracts.
- Support ticket comments and state transitions only through proposed actions.

## Test Plan

Core and daemon:

- Duplicate source idempotency key returns the existing workflow.
- Poll and webhook races produce one claim.
- Startup reconciliation cancels workflows for terminal external items.
- Retry backoff is visible and bounded.
- Invalid workflow reload keeps the last known good config.
- Stale head SHA invalidates approval and external action execution.

Workspace:

- Relative workspace paths resolve from `WORKFLOW.md`.
- Hooks run inside isolated roots.
- Hook failure aborts the correct attempt.
- Workspace cleanup preserves Ling evidence artifacts.

GitHub adapter:

- PR, issue, check, workflow, and release fixtures normalize correctly.
- Permission and rate-limit errors become typed adapter failures.
- Missing credentials block dispatch without crashing the daemon.

Approvals and external actions:

- Standard actions cannot execute when strict approval is required.
- Denied and expired approvals never execute.
- External API failure persists request metadata and failure evidence.
- Target SHA/state is revalidated immediately before mutation.
