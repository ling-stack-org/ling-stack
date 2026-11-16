# Agent Execution Capabilities Implementation Plan

Status: C1–C3, A1/A2 and R1–R3 locally implemented; full regression/review/CI open
Owner: Runner and daemon maintainers
Last verified: 2026-11-16
Document type: implementation plan
Contract: [Agent Execution Capabilities](agent-execution-capabilities.md)

## Objective And Ordering

Deliver code intelligence, Code Mode and general lifecycle Hooks through Ling's actual
Pi/daemon execution path, with signed event automation, selective rerun and bounded
evidence-based Goal supervision through the existing runtime owners.

| Stage | Deliverable | Dependency | Acceptance |
|---|---|---|---|
| C1 | TS/JS definition, references, hover, symbols, diagnostics and bounded repo map | Host workspace snapshot | Cross-file query, next-query edit freshness, partial-index disclosure and path/fence rejection |
| C2 | Bounded QuickJS Code Mode and nested tool audit | Existing SDK nested executor | Parallel reads, serialized effects, filtering, approvals, cancellation and limits via real tool pipeline |
| C3 | Trusted configuration and lifecycle Hooks | C2 sandbox, Host approvals | Policy denial, post-result observation, approved command, project trust/digest, timeout and no recursion |
| A1 | Signed Webhook and durable event inbox | Existing automation store/queue | Signature/replay/dedupe, matching, burst/restart and one execution per event |
| A2 | External sources and result delivery outbox | A1 | One GitHub adapter and one generic business-event adapter; scoped delivery, retries and reconciliation |
| R1 | F5 rerun submission and dependency invalidation | Existing F5 admission | Fresh successor identity, unaffected result reuse, duplicate/stale-plan rejection |
| R2 | Restart/cancellation/effect reconciliation | R1 | No repeated known effect or replay of unknown effect; reliable dependent scheduling |
| R3 | Goal acceptance and bounded long-term supervision | R2, existing Goal | Evidence-based acceptance, budgets/no-progress, pause/blocker and visible continuation |

C1–C3 and A1–R3 are locally implemented. The local controlled-transport acceptance
uses a scripted Provider; full regression, review and remote CI remain release gates.

The local implementation is on `codex/agent-capabilities`, based on `main@878dfa13`.
This record does not establish that the changes are merged or deployed.

## Implementation Batches

### C1: Code Intelligence

- Add bounded Host snapshot I/O and the TS/JS language adapter as focused daemon modules.
- Register one versioned `code_intelligence` Runner schema selected before preparation.
- Bind live execution to the frozen cwd, current Run admission and cancellation signal.
- Keep compiler I/O inside the immutable source snapshot; exclude dependency loading,
  plugins, process launch and emit.
- Add temporary-workspace cross-file behavior and forbidden-path tests.

### C2: Code Mode

- Reuse the installed Pi Code Mode sandbox as an explicit dependency; disable direct
  model APIs and avoid tool implementations or unreviewed SDK extension loading.
- Add Ling-owned limits, selected-tool filtering, read/effect scheduling and result bounds.
- Use `ctx.executeTool`, with child identities and existing validation/approval handlers.
- Preserve parent tool ids in Runner/contract Run events and frozen schema selection.
- Exercise blocked writes, actual Host-handled commands, output filtering, infinite
  loops, unawaited calls, cancellation and resource release.

### C3: Hooks

- Strictly parse user configuration and digest-pinned project proposals in the daemon.
- Freeze selected non-secret definitions; recheck trust/configuration on restoration.
- Add a Runner dispatcher for `run_start`, `before_tool`, `after_tool`, `run_end`.
- Execute policy scripts without I/O and commands only through Host bash approval.
- Bound matching/count/time/output, suppress recursive command events, preserve audit
  receipts and propagate blocking failures through the task boundary.
- Provide configuration examples in the contract, with tested trust/denial semantics.

### A1/A2: Event Automation

Owner modules: `core` automation storage/contracts, daemon automation feature, API/CLI
and existing automation settings. Add inbox/source/outbox migrations with rollback/reopen
coverage. Keep secrets in the existing secret resolver.

The implementation provides source CRUD/revision CAS, two secret refs for rotation,
raw-body HMAC verification, strict envelope limits, exact type/predicate matching and
transactional claims. GitHub issue/comment and generic business sources share the
inbox. Destination-bound result delivery has a durable outbox, CAS receipts, bounded
retry for known non-delivery and explicit reconciliation for unknown remote outcomes.
Migration 221 owns these tables. See the contract for headers, limits and endpoints.

Acceptance scenarios: valid issue opens one task; redelivered event opens none; changed
payload under the same id is rejected; wrong signature and stale timestamps start no
work; daemon restart recovers an accepted event; burst rate limiting preserves queue
state; failed Run and failed delivery have distinct statuses; unknown delivery is
reconciled before retry. No external messages are sent during local fixture tests.

### R1/R2/R3: Rerun And Completion

Owner modules: existing F5 Host admission, workflow graph/storage/scheduler, Run
orchestration and Goal interventions. Extend those owners rather than introduce a
parallel task engine. The [F5 plan](ling-framework-complementary-implementation-plan.md)
remains authoritative for its existing phases.

The submission API consumes intent and a reviewed plan fingerprint inside a Host
transaction. It records one successor and exact invalidated closure, retires the
source, and pins unaffected results. Existing orchestration creates fresh execution
identities and approvals. The durable supervisor checks pins and resumes successors
through the normal workflow owner. Ordinary materialized graphs are supported;
compiled templates, participant/intent authority and safety/isolation/delegated profiles
fail closed. Unknown, pending and affected known external effects block replay.

Migration 222 owns submission records and Goal criterion/evidence/policy columns.
Goal completion verifies current explicit persisted proof while retaining historical
references. Supervision atomically queues idempotent interventions and enforces token,
time, no-progress, pause, pending-work and authority limits. The default three-step
bound remains; configured limits are covered by behavior tests. Exact-evidence
`autoComplete` is opt-in. Existing Goal and workflow owners retain execution authority.

Acceptance scenarios: `A -> B -> C` with independent successful `D`; rerun failed B,
keep A/D artifacts and only reconsider C; two submissions create one successor; edited
A invalidates B/C pins; stale plan creates nothing; cancellation/restart never repeats
an uncertain external action; user pause stops scheduling; exhausted budget and
repeated no-evidence continuation stop visibly; acceptance passes only with declared
evidence. Run completion alone cannot complete a Goal.

## Verification And Status

Use the owning package build, focused TS behavior tests and production/test typecheck.
Run related prepared-input, tool-before, approval, workflow profile and event-contract
regressions. Run docs links/license/public checks and `git diff --check`. Broaden only
for changed dependencies, failures or unresolved risks. Native packaging and real
Provider acceptance are separate release gates.

Local checks cover Runner and Contracts suites, daemon capability/approval/prepared
input/workflow regressions, the owning production and test typechecks, and the daemon
dependency build graph. The integration fixture starts a real daemon and Pi SDK with
a local scripted SSE Provider: Code Mode resolves a cross-file symbol, then a command
Hook waits for manual approval through the daemon API and executes through the
journaled Host shell. SQLite readback verifies lineage, Hook receipts and frozen
capabilities. No external Provider or messaging service is exercised.

Implementation owners:

- `packages/daemon/src/runtime/code-intelligence/` captures and queries source snapshots;
  `features/runs/code-intelligence.ts` owns Worker lifetime and live admission checks.
- `packages/runner-pi/src/extensions/code-mode.ts` owns tool selection/scheduling;
  `script-runtime.ts` owns the shared bounded QuickJS worker lifetime.
- `packages/daemon/src/features/runs/hooks-configuration.ts` owns configuration trust;
  Runner `hook-runtime.ts` and `extensions/hooks.ts` own lifecycle dispatch and receipts.
- `packages/core/src/storage/sqlite/automation-event-store.ts` owns inbox/outbox and
  receipts; daemon `features/automations/event-{ingress,routes,worker}.ts` own source
  authentication, local management and dispatch through existing automation/IM ports.
- `packages/core/src/storage/sqlite/node-rerun-store.ts` owns atomic successor records;
  daemon `features/runs/node-rerun-submission.ts` revalidates Host observation.
- Core `goal-acceptance.ts`/`goal-supervision-store.ts` own proof and intervention
  transactions; daemon `task-supervisor.ts` recovers both workflow and Goal work.
- Prepared Runner input freezes schema/configuration; existing Host approvals own every
  command and nested effect. Child cancellation uses the captured approval fence.

The code-intelligence compiler profile is deliberately independent of project tsconfig
and package types. It is a bounded TS/JS adapter, not a persistent repository-wide or
multi-language index. Workflow/delegated/native capability support, packaged Worker/WASM
resource lookup and live Provider quality remain separate follow-up acceptance.

| Work | Current status | Remaining |
|---|---|---|
| Plan/design | Contract and staged acceptance synchronized with local code | Maintain alongside subsequent delivery |
| C1 | Local Pi/daemon implementation and validation complete | Review/CI and packaged/live Provider acceptance |
| C2 | Local nested SDK execution, audit, approval and cancellation validation complete | Review/CI and packaged/live Provider acceptance |
| C3 | Local trust, lifecycle policy, approved command and failure-boundary validation complete | Review/CI and packaged/live Provider acceptance |
| A1/A2 | Local signed ingress, GitHub/business adapter, durable claims/outbox and mock-IM integration pass | Full regression, review/CI; live service acceptance |
| R1/R2/R3 | Local successor/reuse/effect/restart and Goal acceptance/supervision regressions pass | Full regression, review/CI; advanced workflow profiles remain closed |
| Release | Unverified | Review/CI, merge, packaged acceptance and deployment |
