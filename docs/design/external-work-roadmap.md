# External Work Roadmap

## Purpose

This document records the external-work roadmap after the completed Phase 7 second
source adapter slice. It is the compact planning index for what is already shipped, what
remains open, when the GitHub-first loop is considered done, when external-work
orchestration v1 is considered done, and what should happen after v1.

The source-of-truth design boundaries remain:

- [External Work Orchestration](external-work-orchestration.md)
- [GitHub Automation](github-automation.md)
- [External Work Phase 4 Implementation](external-work-phase-4-implementation.md)
- [External Work Phase 5 Implementation](external-work-phase-5-implementation.md)
- [External Work Phase 6 Implementation](external-work-phase-6-implementation.md)
- [External Work Phase 7 Implementation](external-work-phase-7-implementation.md)
- [External Work Status Surface](external-work-status-surface.md)
- [External Work GA Hardening](external-work-ga-hardening.md)

## Current Baseline

Completed capabilities:

- GitHub PR/issue manual import from fixtures or `WORKFLOW.md`.
- GitHub read-only poll and local reconcile.
- Durable scheduler state, resource leases, isolated workspaces, optional hook evidence.
- Approval-gated GitHub comment and label proposals.
- Explicit action execution after approval and stale-target revalidation.
- Web Inbox approval cards and external action audit panels.
- GitHub PR CI triage for existing external-work items, including redacted evidence
  artifacts and local fix task creation.
- Explicit local CI fix run bridge from an existing triage record through the normal
  task/run SSE path.
- Local-only CI triage list/detail APIs and Web Workspace/Inspector audit panels.
- Strict GitHub PR review actions.
- Runtime-registered GitHub background polling and reconciliation.
- Linear read-only issue import and poll as a second source adapter.

Still enforced:

- No webhook receiver.
- No unmanaged or unregistered background polling loop.
- No automatic runner start from external work.
- No GitHub mutation without a durable action, approval, explicit execute call, and
  stale-target revalidation.
- No automatic push, review decision, merge, release, or issue close.

Product entry point:

- Setup and connection status are visible from the Web Settings External Work panel and
  `ling-stack external-work status`. Both surfaces read local `WORKFLOW.md`, channel,
  secret status, local record counts, and background scheduler state without implicit
  GitHub or Linear calls. Web Settings also provides the browser-friendly setup path:
  create or repair a minimal local `WORKFLOW.md`, paste a GitHub or Linear token, save
  it to macOS Keychain, and persist only the `keychain:` `secretRef` in `WORKFLOW.md`.
  The shipped behavior is tracked in
  [External Work Status Surface](external-work-status-surface.md).

## Completion Model

There are three different "done" lines:

- GitHub-first closure: GitHub external work can move from discovery to local evidence,
  approval, and an explicit approved GitHub action. This is Phase 5 plus either accepted
  manual operation or Phase 6 background operation.
- External-work orchestration v1: the same model works for GitHub and one non-GitHub
  source adapter. This is Phase 7.
- Product GA: v1 is hardened for live operations with smoke suites, security review,
  recovery docs, policy controls, and audit tooling. GA is not another broad feature
  phase.

## Status Ledger

| Phase | Status | Boundary |
| --- | --- | --- |
| 1 | Shipped | Manual GitHub PR/issue import and evidence artifacts. |
| 1.1 | Shipped | SDK and CLI manual import surfaces. |
| 1.2 | Shipped | Copy-pasteable GitHub fixture smoke examples. |
| 2 | Shipped | Manual GitHub poll/reconcile, scheduler state, leases, workspaces, hooks. |
| 3 | Shipped | Approval-gated GitHub comments and labels. |
| 3.2 | Shipped | Web Inbox approval cards and external action audit. |
| 4.0 | Shipped | Manual read-only CI triage and local fix task creation. |
| 4.1 | Shipped | Explicit local fix run bridge from CI triage to the normal task/run path. |
| 4.2 | Shipped | Web Workspace and task Inspector CI triage audit surface. |
| 5 | Shipped | Strict PR review action slice; push, merge, and release remain deferred. |
| 6 | Shipped | Runtime-registered GitHub background polling and reconciliation; webhook ingestion is deferred. |
| 7 | Shipped | Linear read-only manual import and poll as the second channel adapter. |
| UX.1 | Shipped | Web Settings status surface for workflow health, source target, token status, counts, and background controls. |
| UX.2 | Shipped | Web Settings Keychain token setup/removal for GitHub and Linear external work. |
| UX.3 | Shipped | Web Settings local WORKFLOW.md create/repair path before token setup. |
| GA.1 | Planned | Live smoke suites and permission/token-scope audit. |
| GA.2 | Planned | Recovery docs and audit export. |
| GA.3 | Planned | Admin policy controls for sources, actions, hooks, and background operation. |
| GA.4 | Planned | Security review, redaction review, and GA release checklist. |

## Phase 5 First Slice

The first Phase 5 implementation is a strict GitHub PR review action, not push,
merge, release, or a broad action framework expansion.

Why this is the right next slice:

- It reuses the durable external action, approval, explicit execute, and stale-target
  revalidation path that is already shipped for comments and labels.
- It proves a higher-risk GitHub side effect with strict approval without introducing
  repository write operations such as push or merge.
- It completes the operator-facing loop from local evidence to an auditable external
  action while preserving the existing Web Inbox surface.

The first action is `github_pr_review` for `github_pull_request` external work only.
The payload is:

```ts
{
  type: "github_pr_review";
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
}
```

Rules:

- Every PR review action requires `strict` approval; `standard` is rejected.
- Approval and execution remain separate.
- Execution performs an immediate PR state and head SHA revalidation.
- Phase 5 does not add inline review comments, push commits, merge, release, webhook,
  background polling, or edit-and-approve.

The full implementation plan is in
[External Work Phase 5 Implementation](external-work-phase-5-implementation.md).

## Phase 6 First Slice

The first Phase 6 implementation is a runtime-registered GitHub background scheduler,
not a daemon-wide hidden crawler and not a webhook receiver.

Why this is the right next slice:

- The daemon currently knows only about workspaces that a user or client explicitly
  opens, so background operation should start from an explicit `cwd + channelId +
  WORKFLOW.md` registration.
- It reuses the Phase 2 manual poll/reconcile path and existing durable SQLite state
  instead of creating a second scheduler system.
- It lets operators list and stop background discovery while preserving the existing
  approval and external action boundaries.

The planned first-cut surfaces are:

- `POST /external-work/github/background/start?cwd=...`
- `GET /external-work/background?cwd=...`
- `POST /external-work/background/:schedulerId/stop?cwd=...`
- `LingDaemonClient.startGitHubExternalWorkBackground()`
- `LingDaemonClient.listExternalWorkBackgroundSchedulers()`
- `LingDaemonClient.stopExternalWorkBackgroundScheduler()`
- `ling-stack external-work github background start|list|stop`

Rules:

- Registration is explicit per `cwd`, `channelId`, and resolved `workflowPath`.
- Duplicate registration returns the existing scheduler instead of creating another
  timer.
- Startup reconcile runs only when a scheduler is explicitly registered and the workflow
  config requests it; daemon process startup should not silently call GitHub.
- Scheduler ticks may read GitHub PRs/issues and create or reuse local records.
- Scheduler ticks must not start local runners or execute GitHub mutations.
- Webhook ingestion remains a later option if deployment needs it.

The full implementation plan is in
[External Work Phase 6 Implementation](external-work-phase-6-implementation.md).

## Completed Phase 4 Closures

### Phase 4.1: Live Smoke and Local Fix Run Bridge

Goal: prove Phase 4.0 against a disposable real failing PR, then connect CI triage to an
explicit local fix run without changing the external mutation boundary.

Shipped surface:

- `POST /external-work/github/ci/triage/:triageId/run?cwd=...`
- `LingDaemonClient.startGitHubExternalWorkCiTriageRun()`
- `ling-stack external-work github ci run --triage <id> --provider <providerPresetId>`

Scope:

- Run a reproducible live smoke against a disposable failing PR.
- Verify real GitHub check runs, workflow jobs, and bounded job logs normalize correctly.
- Verify triage records, artifacts, and local fix tasks are readable through CLI/API.
- Keep the explicit run bridge only through the existing task/run path, provider
  preflight, approval policy, resource leases, and channel runtime policy.
- Keep `startRun` off by default and reject hidden runner startup.

Completion criteria:

- A developer can follow docs from import or poll through CI triage and local fix task
  creation on a real failing PR.
- A local fix run can be started only by an explicit user action.
- No GitHub push, comment, review, label, merge, or release occurs as part of CI triage.
- `corepack pnpm test`, `corepack pnpm typecheck`, and `git diff --check` pass for the
  bridge slice before it is merged.

### Phase 4.2: Web CI Triage Surface

Goal: make CI triage inspectable in the Web app without creating a separate GitHub page.

Scope:

- Show CI triage records from existing Workspace and task Inspector surfaces.
- Show failed check/workflow/job metadata, redacted log excerpts, linked artifacts, and
  linked local fix task/run ids.
- Preserve the existing approval card model for any proposed external action.
- Keep Web local-only for this surface: list/show triage data, but do not start a local
  fix run unless a separate explicit command invokes the Phase 4.1 run bridge.

Completion criteria:

- A user can inspect why a fix task exists, open its evidence artifacts, and navigate to
  the linked local task/run from Web.
- Failed, stale, duplicate, and task-created triage states are visible without reading
  raw SQLite state.

## Remaining Phases

### Phase 5: GitHub-First Closure Loop

Goal: make GitHub external work usable end to end while still requiring explicit
approval for every external side effect.

Scope:

- Connect external work, isolated workspace allocation, teammate task/run execution,
  generated evidence, proposed GitHub actions, approval cards, and explicit action
  execution into one operator flow.
- First add `github_pr_review` as a strict PR-only proposed action with durable evidence
  and stale-target revalidation.
- Defer push commit, merge, release readiness, and release actions until the PR review
  path proves the strict approval model.
- Keep edit-and-approve out of the first loop. Cancel and re-propose instead.
- Keep no-force-push as the default push boundary.

Completion criteria:

- A GitHub PR/issue can be discovered or imported, assigned to a local teammate run,
  produce evidence, propose an allowed action, receive approval, and execute that action
  only after revalidating the target state.
- The operator can audit every external side effect from durable records and artifacts.
- GitHub-first orchestration is functionally complete after this phase plus either
  manual polling or the Phase 6 background loop, depending on deployment needs.

### Phase 6: Background Polling and Reconciliation

Goal: move from manual operations to durable background operation.

Scope:

- Add runtime-registered scheduled polling first. Webhook ingestion is deferred until a
  deployment needs a public receiver.
- Add startup reconciliation for scheduler state, leases, stale workspaces, pending
  approvals, and external actions when a scheduler is explicitly registered.
- Preserve rate limits, backoff, source leases, subject leases, workspace leases, and
  approval boundaries.
- Keep all external mutation paths behind existing proposed action execution.

Completion criteria:

- The daemon can continuously discover and reconcile GitHub external work without
  duplicating workflows, losing scheduler state, or bypassing approvals.
- Operators can pause, inspect, and recover background external-work state.

### Phase 7: Second Channel Adapter

Goal: prove external-work orchestration is a platform abstraction, not GitHub-specific
code hidden behind generic names.

Scope:

- Add Linear as the second source adapter, with GitLab or Jira as later alternatives
  only if real usage demands them.
- Reuse normalized work items, scheduler state, leases, workspace isolation, approvals,
  evidence artifacts, and action audit contracts.
- Start with read-only Linear issue import and poll. Do not add Linear mutations,
  background polling, webhook ingestion, or runner startup in the first Phase 7 slice.
- Keep GitHub as the only source with approval-gated external mutation execution until a
  later Linear action design justifies the write surface.

Completion criteria:

- The same import/poll/reconcile/evidence/approval model supports GitHub and one
  non-GitHub source.
- Channel-specific behavior lives in adapters and proposed action executors, not in the
  scheduler core.
- External-work orchestration v1 is complete.

The first Phase 7 implementation plan is in
[External Work Phase 7 Implementation](external-work-phase-7-implementation.md).

## After Phase 7: GA Hardening

Phase 7 is the feature-complete line for external-work orchestration v1. After Phase 7,
avoid adding more broad feature surface unless live usage proves a need. The expected
work should be GA hardening:

- Real-repository smoke suites.
- Permission and token-scope audits.
- Audit search and export.
- Admin policy controls for allowed sources, actions, and approvals.
- Rate-limit and retry tuning.
- Security review for workspace isolation, redaction, and external action execution.
- Operational docs for backup, recovery, and incident triage.

The GA hardening plan is in
[External Work GA Hardening](external-work-ga-hardening.md). The recommended first
implementation slice is GA.1: real GitHub and Linear smoke suites plus permission and
token-scope documentation.

## Done Definitions

- GitHub-first closure is done when Phase 5 is complete and either manual operation is
  accepted by the product or Phase 6 background operation is complete.
- External-work orchestration v1 is done when Phase 7 proves the model works for GitHub
  and one second channel adapter.
- Phase 7 is the feature-complete line for external-work orchestration v1, not the end
  of all work. Product GA is a hardening milestone after v1.
