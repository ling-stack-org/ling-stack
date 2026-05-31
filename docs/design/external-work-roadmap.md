# External Work Roadmap

## Purpose

This document records the external-work roadmap after the completed GitHub Phase 4.0 CI
triage slice and the current Phase 4.1 local-fix-run bridge slice. It is the compact
planning index for what is already shipped, what remains open, when the GitHub-first loop
is considered done, when external-work orchestration v1 is considered done, and what
should happen after v1.

The source-of-truth design boundaries remain:

- [External Work Orchestration](external-work-orchestration.md)
- [GitHub Automation](github-automation.md)
- [External Work Phase 4 Implementation](external-work-phase-4-implementation.md)

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

Still enforced:

- No webhook receiver.
- No background polling loop.
- No automatic runner start from external work.
- No GitHub mutation without a durable action, approval, explicit execute call, and
  stale-target revalidation.
- No automatic push, review decision, merge, release, or issue close.

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
| 4.1 | In progress | Local fix run bridge exists; disposable real failing-PR smoke remains open. |
| 4.2 | In progress | Web CI triage surface exists; full verification and merge remain open. |
| 5 | Planned | GitHub-first closure loop with strict proposed actions. |
| 6 | Planned | Background polling or webhook ingestion plus reconciliation. |
| 7 | Planned | Second channel adapter proving the platform abstraction. |

## Remaining Phases

### Phase 4.1: Live Smoke and Local Fix Run Bridge

Goal: prove Phase 4.0 against a disposable real failing PR, then connect CI triage to
an explicit local fix run without changing the external mutation boundary.

Implemented surface in the current slice:

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

### Phase 5: GitHub-First Closure Loop

Goal: make GitHub external work usable end to end while still requiring explicit
approval for every external side effect.

Scope:

- Connect external work, isolated workspace allocation, teammate task/run execution,
  generated evidence, proposed GitHub actions, approval cards, and explicit action
  execution into one operator flow.
- Add strict proposed action kinds beyond comments and labels only when they have
  durable evidence and stale-target revalidation. Candidate actions include PR review
  decision, push commit, merge, and release readiness or release action.
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

- Add webhook ingestion or scheduled polling, not both in the first cut unless required
  by deployment constraints.
- Add startup reconciliation for scheduler state, leases, stale workspaces, pending
  approvals, and external actions.
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

- Add one second source adapter, likely Linear first, with GitLab or Jira as later
  alternatives if real usage demands them.
- Reuse normalized work items, scheduler state, leases, workspace isolation, approvals,
  evidence artifacts, and action audit contracts.
- Add only the minimal proposed actions needed for the selected channel.

Completion criteria:

- The same import/poll/reconcile/evidence/approval model supports GitHub and one
  non-GitHub source.
- Channel-specific behavior lives in adapters and proposed action executors, not in the
  scheduler core.
- External-work orchestration v1 is complete.

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

## Done Definitions

- GitHub-first closure is done when Phase 5 is complete and either manual operation is
  accepted by the product or Phase 6 background operation is complete.
- External-work orchestration v1 is done when Phase 7 proves the model works for GitHub
  and one second channel adapter.
- Product GA is not a new feature phase. It is a hardening milestone after v1.
