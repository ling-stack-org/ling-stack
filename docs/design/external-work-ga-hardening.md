# External Work GA Hardening Plan

## Summary

External Work orchestration v1 is feature-complete after Phase 7: GitHub can move from
discovery to local evidence and approval-gated external actions, and Linear proves the
same read-only orchestration model works for a second source. GA hardening is the work
that turns that feature-complete system into an operator-safe production capability.

GA hardening should not broaden the external automation surface by default. It should
make the shipped surface reliable, recoverable, auditable, and safe under real
repository and team conditions.

The target GA posture is:

```text
real repository or Linear project
-> documented token and permission setup
-> repeatable live smoke suite
-> durable scheduler/action/approval records
-> searchable/exportable audit evidence
-> explicit policy controls for sources and mutations
-> recovery playbooks for stuck work, stale leases, and failed actions
```

The operator-facing setup/status gap is tracked separately in
[External Work Status Surface](external-work-status-surface.md). That surface should
land before or alongside GA hardening so live smoke, token-scope audit, and recovery
work have a visible place to report workflow health, source target, token readiness,
record counts, and scheduler state.

## Current Baseline

Already available before GA hardening:

- GitHub PR/issue manual import, poll, reconcile, and background scheduler registration.
- GitHub CI triage, local fix task creation, and explicit local fix run bridge.
- Approval-gated GitHub comment, label, and PR review actions.
- Web Inbox approval cards and external action audit panels.
- Web Workspace and task Inspector CI triage visibility.
- Linear read-only issue import and poll as the second source adapter.
- Durable SQLite state for external work, scheduler state, actions, approvals, leases,
  artifacts, CI triage, tasks, and runs.

Still enforced:

- No automatic runner start from import, poll, reconcile, background ticks, CI triage,
  or Linear operations.
- No GitHub mutation without durable proposed action, approval, explicit execute, and
  stale-target revalidation.
- No Linear mutation in v1.
- No webhook ingestion in v1.
- No automatic push, force-push, merge, release, issue close, or repository write.
- No token persistence in SQLite or artifacts.

## Goals

- Prove the system against real repositories and real Linear projects, not only unit
  fixtures and mock adapters.
- Document the minimum viable GitHub and Linear token scopes.
- Make token, permission, and branch-protection failures readable and recoverable.
- Make scheduler, lease, action, approval, artifact, and CI triage state inspectable by
  operators.
- Add audit search/export paths for approvals and external actions.
- Add admin policy controls that define allowed sources, actions, approval levels, and
  background operation.
- Verify workspace isolation and redaction against adversarial inputs.
- Provide backup, restore, and incident playbooks for local SQLite workspaces.
- Define a release checklist that distinguishes feature completion from production
  readiness.

## Non-Goals

- No new external source adapter.
- No Linear mutation action.
- No webhook receiver.
- No automatic runner start.
- No GitHub push, merge, release, or issue close action.
- No edit-and-approve action flow.
- No multi-node distributed scheduler.
- No change to the existing approval requirement that external mutations execute only
  after explicit operator action.

## GA Workstreams

### 1. Live Smoke Suites

Purpose: prove the existing system works against real provider behavior and remains
inside the safety boundary.

Required smoke paths:

- GitHub fixture import smoke with local artifacts.
- GitHub live read-only poll and reconcile smoke.
- GitHub live CI triage smoke against a disposable failing PR.
- GitHub proposed comment/label/review smoke that creates and cancels local actions
  without mutation.
- Optional gated GitHub mutation smoke that executes a harmless approved comment or PR
  review only when explicitly enabled.
- GitHub background scheduler smoke that registers, ticks, deduplicates, lists, and
  stops.
- Linear fixture import smoke.
- Linear live read-only poll smoke against a disposable project.

Smoke invariants:

- Import, poll, reconcile, background ticks, CI triage, and Linear operations do not
  start local runners.
- Read-only smokes do not call GitHub or Linear mutation APIs.
- Action approval never executes as a side effect.
- Stale target revalidation blocks mutation before external API writes.
- Evidence artifacts are readable and redacted.
- Re-running the same smoke is idempotent.

Deliverables:

- `docs/external-work-ga-smoke.md`
- reusable smoke command examples
- CI-friendly mock smoke and manually gated live smoke instructions

### 2. Permission And Token-Scope Audit

Purpose: minimize credential blast radius and make permission failures obvious.

GitHub token modes to document:

- Read-only PAT or GitHub App installation token for import, poll, reconcile, CI triage,
  and background ticks.
- Narrow write-capable token for explicit action execution only.
- Separate local environment setup for optional mutation smoke.

Linear token modes to document:

- Read-only issue/project access for import and poll.
- No write-capable Linear token required in v1.

Checks:

- Missing token produces a readable blocked state or daemon error.
- Expired token produces a typed permission/auth failure.
- Insufficient GitHub write scope fails before or during explicit action execution with
  redacted evidence.
- Tokens never appear in SQLite, artifacts, logs, Web payloads, CLI output, or test
  snapshots.

Deliverables:

- `docs/external-work-permissions.md`
- token-scope checklist in the GA release checklist
- tests for representative auth, permission, and redaction failures

### 3. Recovery And Reconciliation

Purpose: make stuck external work recoverable without manual SQLite surgery.

Recovery cases:

- daemon restart while background scheduler is registered
- expired source/subject/workspace lease
- missing workflow or workflow step
- terminal local workflow or workflow step
- retry wait whose `nextAttemptAt` has elapsed
- pending approval for a stale target
- action stuck in `executing`
- CI triage with missing linked task or run
- workspace path missing or moved
- artifact file missing from disk

Expected operator actions:

- list affected records
- run local reconcile
- inspect blockers and last errors
- retry safe read-only work
- cancel stale proposed actions
- stop background scheduler
- preserve evidence before cleanup

Deliverables:

- `docs/external-work-recovery.md`
- expanded CLI/API examples for list/show/reconcile/cancel
- tests for stuck state transitions that can be repaired safely

### 4. Audit Search And Export

Purpose: let operators answer "what happened, who approved it, and what external state
was observed" without reading raw SQLite rows.

Audit entities:

- external work record
- workflow and workflow step
- scheduler state
- resource leases
- approval request and decision
- external action
- CI triage record
- linked task and run
- artifacts

Minimum query filters:

- source kind
- work item kind
- repository or project
- channel
- status
- approval status
- action kind
- actor or decision author
- created/updated time range
- external work id
- artifact id

Export formats:

- JSON for automation and support bundles
- markdown summary for PR reviews and incident notes

Safety:

- exported artifacts must pass the same redaction rules as stored evidence
- exports must not include secret values
- export should include enough ids to reconstruct links between records

Deliverables:

- daemon audit list/export endpoints or CLI-only export if API scope is deferred
- `ling-stack external-work audit export`
- Web follow-up only after CLI/API audit export is stable

### 5. Admin Policy Controls

Purpose: make source and action boundaries explicit instead of relying only on code
defaults.

Policy dimensions:

- allowed source kinds: `github`, `linear`
- allowed GitHub repositories
- allowed Linear project slugs
- allowed action kinds: comment, label, PR review
- required approval level per action kind
- background scheduler allowed or disabled
- execute hooks allowed or disabled
- maximum poll limit
- maximum background schedulers per workspace
- token purpose allowed per source

Default policy:

- GitHub and Linear reads allowed when configured by channel-bound `WORKFLOW.md`.
- GitHub comment/label/PR review actions require explicit approval.
- PR review actions require strict approval.
- Linear mutations disabled.
- background scheduler registration allowed only through explicit API/CLI call.
- hooks disabled unless explicitly requested.

Deliverables:

- policy schema extension
- daemon enforcement before poll/action/background execution
- CLI and Web policy visibility
- docs for safe defaults and override examples

### 6. Workspace Isolation And Redaction Review

Purpose: validate that external work cannot escape its workspace or leak secrets through
evidence.

Review areas:

- `WORKFLOW.md` path resolution under channel `boundPath`
- relative workspace root resolution
- per-subject and per-attempt workspace allocation
- hook working directory
- workspace lease acquisition and release
- artifact path containment
- stdout/stderr redaction
- GitHub and Linear token redaction
- common secret pattern redaction
- malicious label/title/body values in prompts and artifacts

Deliverables:

- adversarial tests for path escape and artifact escape
- redaction tests with realistic token and secret patterns
- documented residual risks for local hooks

### 7. Rate Limit And Backoff Tuning

Purpose: keep live operation predictable under API limits and transient failures.

Behaviors to verify:

- GitHub rate limit and retry-after handling
- Linear GraphQL error handling
- exponential backoff capped by `maxRetryBackoffMs`
- no overlapping background ticks
- duplicate subject claims block concurrent work
- scheduler state records last error and next attempt
- poll limit defaults are conservative

Deliverables:

- typed adapter failures for rate limit, auth, permission, network, validation, and
  unavailable
- operator-facing messages in CLI/Web
- tests for capped retry and no-overlap background ticks

### 8. Backup, Restore, And Incident Docs

Purpose: make local durable state operable.

Docs must cover:

- what lives in SQLite
- what lives in the artifact directory
- how to back up a workspace before repair
- how to restore a workspace copy
- how to inspect a stuck external work item
- how to cancel stale actions safely
- how to stop background schedulers
- how to rotate tokens
- what evidence to attach to an incident

Deliverables:

- `docs/external-work-operations.md`
- incident checklist
- support bundle export command if audit export lands first

## Proposed GA Slices

### GA.1: Live Smoke And Permissions

Scope:

- real GitHub read-only smoke
- real Linear read-only smoke
- optional gated GitHub mutation smoke
- token-scope and permission docs
- smoke docs with expected outputs

Completion criteria:

- A developer can follow docs against disposable GitHub and Linear targets.
- Read-only smokes prove no mutation and no runner start.
- Optional mutation smoke is clearly gated and records evidence.

### GA.2: Recovery And Audit Export

Scope:

- local recovery docs and reconcile examples
- action/approval/triage audit export
- CLI support bundle command
- stuck-state tests

Completion criteria:

- A stuck external work item can be diagnosed from CLI output and exported evidence.
- Operators can cancel stale actions and run local reconcile without raw SQLite edits.

### GA.3: Admin Policy Controls

Scope:

- allowed source/action/background/hook policy
- daemon enforcement
- CLI/Web policy visibility
- docs for defaults and overrides

Completion criteria:

- A workspace admin can disable risky actions or background operation without code
  changes.
- Disallowed actions fail before external API calls.

### GA.4: Security And Release Review

Scope:

- workspace isolation tests
- redaction adversarial tests
- permission matrix review
- final GA checklist

Completion criteria:

- No known path escape or token leakage issue remains untracked.
- GA checklist is explicit about residual risks and operational requirements.

## GA Release Checklist

- Live GitHub read-only smoke passes.
- Live Linear read-only smoke passes.
- Optional GitHub mutation smoke is either passed with explicit approval or intentionally
  skipped with rationale.
- All read-only flows prove no runner start.
- All mutation flows prove approval and stale-target revalidation.
- Token scopes are documented and verified.
- Redaction tests cover GitHub token, Linear token, authorization headers, and common
  secret patterns.
- Workspace path containment tests pass.
- Background scheduler no-overlap and stop behavior pass.
- Reconcile repairs expired leases and retry waits.
- Audit export includes action, approval, target snapshot, artifacts, and execution
  evidence.
- Backup and recovery docs are current.
- `corepack pnpm test`, `corepack pnpm typecheck`, Web e2e, and `git diff --check`
  pass for the final GA hardening PR.

## Open Decisions

- Whether audit export should be daemon API first, CLI first, or both in the same slice.
- Whether admin policy controls should extend the existing approval policy schema or use
  a separate external-work policy object.
- Whether background scheduler registry should remain process-local for v1 GA or gain a
  durable registration table.
- Whether optional GitHub mutation smoke should be automated behind an environment gate
  or kept as a manual-only operator procedure.
- Whether Web needs a dedicated audit search surface before GA, or CLI export plus
  existing Web panels are enough.

## Handoff

The first GA hardening implementation should be GA.1. It has the highest signal-to-risk
ratio: it proves the merged feature line against real providers, documents token
boundaries, and preserves the current no-new-mutation default.
