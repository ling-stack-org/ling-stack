# Ling Harness Gap Closure Implementation Plan

## Status

- Review status: approved and adopted into the current implementation branch
- Review date: 2026-09-13
- Repository branch reviewed: `codex/reasoning-summary-autoreview-implementation`
- Original review baseline: `8b259da0`
- Current adoption baseline: `a233a46e`
- Codex OSS reference baseline: `70eb36203dbb8c75d006b39cdfae74bd04e18a65`
- Confidence: high for the boundary and sequencing decisions; medium for effort estimates until the first schema PR lands

## Executive Verdict

Ling already has an orchestration layer and several harness building blocks. The missing work is not a new top-level orchestrator. The missing work is a single durable execution boundary that makes runner continuation, local tool execution, run evaluation, and dynamic delegation obey the same attempt fencing, approval, budget, artifact, and recovery rules.

The implementation should land as four vertical phases:

1. **P0: continuation and runner consistency**
2. **P0/P1: daemon-owned tool execution and sandbox enforcement**
3. **P1: task-level evaluation loop**
4. **P2: controlled dynamic collaboration**

The strongest counterargument is that Ling could expose more runner-native capabilities directly and reach feature parity faster. That path would create multiple sources of truth for approvals, side effects, resume state, and evidence. The chosen design keeps Ling as the product control plane and treats runner-native sessions as optional acceleration data.

## Problem Statement

Ling's current control plane already owns runs, attempts, approvals, artifacts, workflow sequencing, runtime leases, and user-facing projections. Several execution paths still stop short of a complete harness contract:

- continuation behavior is spread across manual resume, queued follow-up, interrupt redirect, approval resume, retry, and optional runner-native resume;
- `bash` has a daemon execution path, while approved `edit` and `write` can still fall back to Pi's native implementations;
- evaluation exists in narrower domains, but there is no generic append-only result model tied to a run, suite, case, baseline, grader version, cost, and latency;
- workflow graphs support declared collaboration, but a running step cannot yet create and recover a bounded, durable delegation tree;
- large execution payloads and queue recovery need one consistent storage and scheduling rule.

The goal is to close these gaps without replacing the daemon, the existing `RunSession` model, the Continuity timeline, the workflow graph, or Pi as the default runner.

## What Already Exists

The implementation must extend these capabilities instead of describing them as absent:

| Existing capability | Evidence | Reuse decision |
| --- | --- | --- |
| Optional runner-native resume port | `packages/daemon/src/context.ts:51` exposes `resumeTask()` | Keep the port; call it only after capability and conformance checks |
| Pi declares no native resume | `packages/runner-pi/src/metadata.ts:44` sets `nativeResume: false` | Pi uses deterministic context replay |
| Pi sessions are in-memory and disposed after a run | `packages/runner-pi/src/adapter.ts:54` creates an in-memory session and disposes it in `finally` | Never treat a Pi process-local session as durable continuation authority |
| Manual resume, queued follow-up, interrupt redirect, and approval resume | `packages/core/src/run-types.ts`, `packages/daemon/src/features/runs/threads.ts`, `interventions.ts`, and `approval-resume-coordinator.ts` | Route new execution continuation attempts through `RunnerContinuation`; preserve existing product-level turn and run lineage |
| Attempt fencing and stale completion rejection | runtime attempt fence migration, runtime supervisor, and `packages/daemon/src/features/runs/stale-completion.ts` | Reuse for every continuation, tool claim, and delegated child completion |
| Daemon-owned command execution | `packages/daemon/src/features/runs/unified-exec.ts:34` | Extract behind the Tool Execution Broker rather than replace it |
| Approval checkpoints and atomic resume coordination | `packages/core/src/storage/sqlite/approval-resume-store.ts:30` | Reuse its narrow-port and transaction-coordinator pattern |
| Persistent runtime semaphores | `packages/core/src/storage/sqlite/runtime-semaphore-store.ts:17` | Extend with layered quotas rather than adding an unrelated limiter |
| Run artifacts, stdout chunking, redaction, timeout, and cancellation | `packages/daemon/src/features/runs/unified-exec.ts` | Keep large output artifact-backed and reuse normalized summaries |
| Trace and span contracts | `packages/contracts/src/traces.ts:48` | Add harness span attributes; do not build a second tracing system |
| Store facets | `packages/core/src/run-types.ts:2267` | Add narrow harness facets and keep services off the full `RunStore` |
| Workflow completion gate | `packages/daemon/src/features/channels/workflow-completion-gate.ts:35` | Add required delegation descendants as another deterministic gate |
| Canonical conversation timeline and context projection | Continuity v2 context-processing and thread/run linkage | Keep conversation history authority upstream of the harness |
| Channel-specific team evaluations and skill regression harness | core channel-team and skill regression modules | Reuse grader utilities where suitable; do not stretch either schema into generic run evaluation |

## Real Gaps

| Gap | User-visible failure if left open | Target owner |
| --- | --- | --- |
| No persisted runner continuation record shared by all resume paths | A restarted daemon cannot always explain whether a task resumed natively, replayed context, or started a duplicate attempt | Harness continuation domain |
| File mutation can execute inside Pi after approval | Tool behavior, evidence, sandbox policy, and crash recovery vary by runner | Tool Execution Broker |
| No generic run evaluation result and queue | Quality changes cannot be compared against a versioned task baseline | Evaluation domain |
| No durable dynamic delegation tree | Spawned collaboration cannot be recovered, budgeted, or used safely as a workflow completion dependency | Delegation domain |
| Large event payloads can pressure SQLite and projections | Long output and grader transcripts increase write amplification and replay cost | Artifact-backed event policy |
| Existing semaphores do not express all harness quotas | One root run or provider can monopolize work, and graders can delay normal runs | Layered quota policy |

## Goals

The finished harness boundary must provide these guarantees:

1. Every execution attempt has a current fence and a durable lineage record.
2. Ling can resume through a runner-native handle when verified, and can deterministically replay context when it cannot.
3. All local mutation tools use one daemon-owned prepare, approval, execution, and evidence path.
4. An arbitrary external side effect is never falsely reported as exactly-once.
5. Evaluation is append-only, versioned, asynchronous, and isolated from normal run capacity.
6. Dynamic child work cannot gain more permissions, tools, workspace scope, provider access, or budget than its parent.
7. A required delegated child is part of its owning workflow step's completion condition.
8. SQLite remains the authority for durable queues; in-memory events only reduce wake-up latency.
9. Conversation history remains owned by Continuity; harness transcripts remain execution evidence.

## NOT in Scope

- Replacing Ling's HTTP/SSE daemon with Codex app-server or JSON-RPC.
- Replacing `RunSession`, `WorkUnit`, or fenced `Attempt` with Codex Thread/Turn objects.
- Making a runner session transcript the canonical conversation history.
- Replacing Pi as the default and fallback runner.
- Exposing an external runner in user pickers before readiness, approval, abort, resume, tool, and event conformance pass.
- Silently injecting a new user message into a running model prompt. Follow-ups continue through explicit queue or interrupt paths.
- Rewriting an accepted `ChannelWorkflow` graph when a running step delegates work.
- Distributed coordination, Kafka, or a network database. SQLite remains the local authority.
- Claiming generic `RunEvaluation` or model-grader merge gates as Codex parity. Those are Ling-owned designs.
- Guaranteeing exactly-once execution for arbitrary shell commands or external APIs across a host crash.
- A new UI information architecture. Initial UI work is limited to exposing harness state through existing run, thread, approval, artifact, and workflow surfaces.

## Authority Boundaries

```text
Continuity canonical timeline
  -> ConversationContextProjector / ChannelContextView
  -> immutable context snapshot + source refs
  -> Ling RunSession
  -> WorkUnit
  -> fenced Attempt
  -> Harness coordinator
       -> RunnerContinuation
       -> ToolExecution
       -> RunEvaluation
       -> DelegationStep
  -> small durable events + artifact refs
  -> existing run/thread/workflow projections
```

Authority rules:

- **Continuity** owns user and assistant conversation order, turn semantics, source refs, and context projection.
- **RunSession** owns the logical unit of execution and user-visible run state.
- **Attempt** owns one fenced execution try. A recovered or resumed execution always receives a new attempt and fence.
- **RunnerContinuation** owns how an attempt is reconstructed. A runner handle is opaque acceleration data, not authority.
- **Tool Execution Broker** owns local tool preparation, policy, approval linkage, sandbox selection, execution claims, and evidence commit.
- **RunEvaluation** owns immutable evaluation requests and append-only grader results.
- **Delegation Tree** owns runtime-created child work below an accepted workflow step. It cannot edit the workflow graph.
- **Artifact store** owns large or sensitive payloads. Events store references, digests, status, and bounded summaries.

## Module Boundaries

The daemon receives one new feature boundary with four subdomains. Domain types and SQLite adapters stay separated from orchestration code.

```text
packages/contracts/src/
  harness.ts                         public DTOs, event payloads, API shapes

packages/core/src/harness/
  common.ts                          CAS, transition result, failure-code primitives
  continuations.ts                   continuation state and policies
  tool-executions.ts                 broker state and side-effect outcome rules
  evaluations.ts                     suite/case/baseline/result contracts
  delegations.ts                     tree, budget, capability-subset rules

packages/core/src/storage/sqlite/
  runner-continuation-migration.ts
  harness-tool-execution-migration.ts
  run-evaluation-migration.ts
  delegation-tree-migration.ts
  runner-continuation-store.ts
  harness-tool-execution-store.ts
  run-evaluation-store.ts
  delegation-tree-store.ts
  harness-commit-coordinator.ts       multi-entity SQLite transactions only

packages/daemon/src/features/harness/
  index.ts                           composition only
  continuations/
    coordinator.ts
    recovery.ts
    context-replay.ts
  tool-execution/
    broker.ts
    sandbox.ts
    executors/
      bash.ts
      apply-patch.ts
      write.ts
  evaluations/
    scheduler.ts
    graders/
      rule.ts
      model.ts
      human.ts
  delegations/
    coordinator.ts
    completion-gate.ts
    recovery.ts
```

Existing large orchestrators should only call these entrypoints and translate their results into existing run events. They should not absorb new state-machine logic.

### Narrow Ports

Each service depends on a small `Pick`/facet or a domain port. Examples:

```ts
type ContinuationStorePort = RunStoreFacet<
  | "getRun"
  | "getWorkUnit"
  | "getWorkUnitAttempt"
  | "createWorkUnitAttempt"
  | "updateWorkUnitAttemptStatus"
  | "appendRunEvent"
> & RunnerContinuationStore;

interface HarnessCommitCoordinator {
  prepareContinuationAndAttempt(input: PrepareContinuationInput): PreparedContinuation;
  commitToolOutcome(input: CommitToolOutcomeInput): ToolExecution;
  enqueueTerminalRunEvaluations(input: EnqueueEvaluationsInput): readonly RunEvaluation[];
  spawnDelegatedRun(input: SpawnDelegatedRunInput): DelegationSpawnResult;
}
```

The coordinator promises atomicity for SQLite state changes. It does not promise atomicity between SQLite and an OS process, filesystem mutation, remote API, or external runner.

## Shared Infrastructure Rules

### State Machines

Each subdomain has its own status union and failure codes. Shared infrastructure is limited to:

- `TransitionResult<TStatus>`;
- compare-and-swap on expected state and revision;
- current attempt fencing;
- idempotency keys;
- lease ownership and expiry;
- canonical timestamps;
- bounded event summaries and artifact references.

Do not create a generic `HarnessEntityStatus` with a union of every domain state. That would weaken transition validation and make recovery ambiguous.

### Failure Codes

Failure codes are stable machine-readable values. Human messages are projection concerns. Initial families:

```text
continuation.*
  handle_missing
  handle_rejected
  context_snapshot_missing
  source_attempt_stale
  target_attempt_lost
  runner_not_conformant

tool.*
  policy_denied
  approval_denied
  sandbox_unavailable
  execution_timeout
  execution_cancelled
  stale_attempt
  evidence_commit_failed
  unknown_side_effect_outcome

evaluation.*
  grader_unavailable
  invalid_suite_version
  baseline_missing
  lease_expired
  result_invalid

delegation.*
  capability_escalation
  budget_exhausted
  depth_exceeded
  cycle_detected
  child_lost
  required_child_failed
```

### Feature Flags

```text
harness.continuations.mode = off | shadow | enforce
harness.toolBroker.mode = off | shadow | enforce
harness.evaluations.mode = off | shadow | enforce
harness.evaluations.modelGate = shadow | enforce
harness.delegations.mode = off | shadow | enforce
harness.delegations.maxDepth = integer
```

Rules:

- `off` preserves current behavior.
- `shadow` persists decisions and checks without changing the execution owner where that is safe.
- `enforce` makes the harness domain authoritative.
- A flag is read into the run/attempt policy snapshot. Changing workspace configuration does not mutate an active attempt's policy.
- Rollback disables the new coordinator while retaining readable rows and events.

## Phase 0: Continuation and Runner Consistency

### Outcome

Every continuation request produces a durable `RunnerContinuation` decision and starts execution in a new fenced attempt. Ling remains able to represent manual resume, queued follow-up, interrupt redirect, approval resume, runner retry, and daemon recovery without assuming runner-native persistence.

### Product-Level Run Semantics

Existing user-intent semantics remain intact:

- manual follow-up, queued follow-up, and interrupt redirect may create a new `LingTurn` or child `RunSession` under current Continuity rules;
- approval resume may continue the current logical run where current policy already allows it;
- after the target `RunSession` is resolved, execution starts through a new fenced `Attempt` and a `RunnerContinuation` record;
- a new user message is never inserted into an already-running prompt as hidden context.

This distinction preserves product lineage while making execution reconstruction uniform.

### RunnerContinuation Model

Minimum persisted fields:

```text
id
run_id
work_unit_id
source_attempt_id
target_attempt_id
origin                         manual_resume | queued_followup | interrupt_redirect |
                               approval_resume | runner_retry | daemon_recovery
strategy                       native_resume | deterministic_replay
state                          requested | prepared | claimed | running | recovery_pending |
                               succeeded | failed | cancelled | superseded
runner_id
runner_capability_revision
context_view_id
context_snapshot_artifact_id
runner_handle_ref               nullable opaque ref
idempotency_key
claim_owner
claim_token                    unique lease generation; prevents same-owner ABA
claim_expires_at
next_attempt_at
generation
failure_code
failure_detail_artifact_id
created_at
updated_at
completed_at
```

`runner_handle_ref` stores an opaque secret or artifact reference. It must not contain an unredacted credential, provider token, or runner transcript.

### Continuation State Machine

```text
requested
  -> prepared
       -> claimed
            -> running
                 -> succeeded
                 -> failed
                 -> cancelled
                 -> recovery_pending
                      -> prepared          new target Attempt + new fence
       -> superseded
       -> cancelled
       -> failed

native_resume handle rejected
  -> recovery_pending
  -> prepared(strategy=deterministic_replay, generation+1)
```

Transition rules:

1. `prepareContinuationAndAttempt()` writes `prepared` and creates or binds the new target
   Attempt in one SQLite transaction. `prepared -> claimed` only grants a token-fenced lease;
   it never allocates another Attempt.
2. A continuation cannot reuse a terminal or lost attempt's fence.
3. `running -> succeeded` requires the current run, work unit, attempt, lease, and continuation generation to match.
4. A native handle failure may fall back to deterministic replay once per generation. Repeated rejection becomes `continuation.handle_rejected`.
5. Recovery marks an abandoned target attempt `lost` before creating another target attempt.
6. Duplicate requests with the same idempotency key return the existing continuation.

### Deterministic Context Replay

The replay package contains:

- immutable context view id and source refs;
- accepted system and task instructions;
- bounded assistant/tool evidence needed to continue;
- approval decision and side-effect fingerprint where applicable;
- artifact references instead of copied large output;
- continuation origin and user-visible reason;
- prior attempt outcome and stale-completion boundary.

It does not rebuild context from the latest mutable conversation window. That would create context drift after a retry or daemon restart.

### Native Resume Gate

Call `resumeTask()` only when all conditions pass:

1. the runner advertises native resume;
2. the adapter implements `resumeTask()`;
3. endpoint readiness passes;
4. the runner's resume conformance suite passes for the active adapter version;
5. the handle belongs to the same workspace, root run, runner, and policy snapshot;
6. the source attempt is still the expected lineage head;
7. abort propagation and approval bridging are supported.

Otherwise use deterministic replay and record the reason.

### Phase 0 Acceptance Gate

- All six continuation origins persist a `RunnerContinuation`.
- Every continuation execution uses a fresh target attempt and fencing token.
- Pi always uses deterministic replay and produces the same bounded replay package before and after daemon restart.
- A conformant fake native runner resumes from its opaque handle.
- A rejected or stale handle falls back once, then fails with a stable code.
- Duplicate claims do not create duplicate current attempts.
- Stale runner completion cannot change run, work unit, continuation, or terminal report state.
- Existing manual resume, queue follow-up, interrupt redirect, and approval UI behavior remains compatible.

## Phase 0/P1: Tool Execution Broker and Sandbox

### Outcome

`bash`, `edit`, `write`, and apply-patch execute through one daemon-owned broker. Runners propose calls and receive normalized results. They do not choose the approval engine, sandbox, mutation implementation, evidence format, or recovery rule.

### Main Flow

```text
runner tool proposal
  -> normalize input and target scope
  -> prepare immutable request digest and side-effect fingerprint
  -> evaluate policy snapshot
  -> create/link approval when required
  -> claim execution with current Attempt fence
  -> select sandbox and executor
  -> execute with timeout/cancel/redaction
  -> stage large output as artifacts
  -> commit outcome + evidence refs + bounded event summary
  -> return normalized result to runner
```

### ToolExecution Model

```text
id
run_id
work_unit_id
attempt_id
continuation_id                 nullable
delegation_step_id              nullable
tool_call_id
tool_name
executor_kind                   bash | apply_patch | write
state                           proposed | prepared | approval_pending | approved |
                                claimed | executing | committing_evidence |
                                succeeded | denied | failed | cancelled |
                                superseded | unknown_outcome
request_digest
side_effect_fingerprint
policy_snapshot_artifact_id
approval_id                     nullable
sandbox_profile_id
claim_owner
claim_expires_at
execution_started_at
execution_finished_at
result_digest
result_summary_json
failure_code
created_at
updated_at
```

Large request bodies, patches, stdout, stderr, and detailed errors remain artifacts.

### Tool Broker State Machine

```text
proposed
  -> prepared
       -> approval_pending
            -> approved
            -> denied
            -> cancelled
       -> approved                 policy permits without prompt
       -> failed                   invalid request or sandbox cannot be prepared

approved
  -> claimed
       -> executing
            -> committing_evidence
                 -> succeeded
                 -> failed         evidence known to be complete enough to report failure
                 -> unknown_outcome side effect may have happened but proof is incomplete
            -> failed
            -> cancelled
            -> unknown_outcome
       -> superseded               attempt or policy fence is stale
```

### Crash and Exactly-Once Boundary

SQLite can atomically commit the tool row, approval linkage, artifact references, run event, and execution-action projection. It cannot atomically commit an arbitrary shell or remote side effect with SQLite.

Rules:

- Before process start, expired claims can be safely reclaimed.
- Read-only tools can be retried when their inputs and sandbox are unchanged.
- File mutations use preimage hashes, patch digests, postimage hashes, and target refs. Recovery can classify `not_applied`, `applied`, or `diverged`.
- Arbitrary shell commands are not blindly retried after a crash in `executing`.
- If Ling cannot prove whether a side effect happened, the state becomes `unknown_outcome`; the run blocks and shows the command, target scope, captured output, and reconciliation action.
- An external runner cannot report success and bypass the daemon evidence commit in enforce mode.

### Sandbox Rules

- The broker receives canonical workspace roots from the attempt's immutable environment snapshot.
- Path normalization happens before approval. Traversal and symlink escape checks happen again immediately before execution.
- Sandbox preparation failure blocks execution. It never falls back to unsandboxed native runner execution.
- Environment variables are allowlisted and summarized; secret values are redacted from events and artifacts.
- Child processes inherit cancellation and timeout. Process group termination is verified before the attempt can finish.
- Runner-native tool execution remains disabled until a runner passes the same request, approval, sandbox, evidence, cancellation, and stale-fence conformance suite.

### Migration of Existing Tool Paths

1. Wrap `executeUnifiedBashTool()` as the first broker executor.
2. Move apply-patch and write behavior behind daemon executors.
3. Change Pi file-mutation extensions to return broker-handled results only.
4. In shadow mode, compare normalized request and intended evidence without changing ownership.
5. In enforce mode, delete the fallback call to Pi's `originalEdit.execute()` and `originalWrite.execute()`.

### Phase 0/P1 Acceptance Gate

- All four mutation tool kinds pass through the broker in enforce mode.
- Denial or missing approval produces no process or file mutation.
- Policy, approval, execution claim, attempt fence, and evidence linkage are queryable from one execution id.
- Timeout and cancellation terminate the process group and close the execution claim.
- File mutation recovery distinguishes not-applied, applied, and diverged states.
- Unknown shell outcomes block automatic retry.
- Large output is artifact-backed and event payload limits stay bounded.
- Secret redaction is tested across output chunk boundaries.
- A non-conformant runner cannot activate native tool execution.

## Phase 1: Task-Level Evaluation Loop

### Outcome

Terminal runs can enqueue one or more versioned evaluations without delaying normal run completion. Rule, model, and human graders append immutable results to a shared run-evaluation record.

### Model

```text
RunEvaluation
  id
  root_run_id
  run_id
  suite_id
  suite_version
  case_id
  case_version
  baseline_id
  baseline_version
  candidate_artifact_id
  state                         queued | claimed | grading | completed | failed | cancelled
  next_attempt_at
  claim_owner
  claim_expires_at
  created_at
  completed_at

RunEvaluationGrade             append-only
  id
  evaluation_id
  grader_type                  rule | model | human
  grader_id
  grader_version
  verdict                      pass | fail | abstain | error
  score
  severity
  rationale_artifact_id
  raw_output_artifact_id
  cost_input_tokens
  cost_output_tokens
  cost_amount_micros
  latency_ms
  adjudication_status
  created_at
```

Suite, case, and baseline definitions are immutable by version. A new definition creates a new version; it does not update historical rows.

### Scheduling

- The terminal run transaction enqueues evaluation ids and emits bounded references.
- A persistent SQLite claim queue is authoritative.
- `ControlPlaneEventHub` wakes workers quickly after commit.
- Startup and low-frequency scans reclaim expired leases and due `nextAttemptAt` rows.
- Evaluation workers have their own low-priority concurrency limit and do not consume normal run semaphores.
- Provider and model quotas still apply.

### Grader Policy

- Rule graders are deterministic and may block a merge or release when their contract says so.
- Model graders begin in shadow mode and only record results.
- Human grades are the adjudication source for promotion analysis.
- A model grader may become an enforced gate only after one version satisfies all of these on at least 100 human-adjudicated cases:
  - zero severe false negatives;
  - false-block rate at or below 1%;
  - repeated-run agreement at or above 95%;
  - versioned prompt, model, sampling, and rubric are frozen for the measured set.
- Any grader version change resets promotion evidence for the new version.

### Phase 1 Acceptance Gate

- A terminal run can enqueue evaluations without extending run semaphore occupancy.
- Suite, case, baseline, candidate, grader, cost, and latency lineage are queryable.
- Rule graders are deterministic across restart.
- Model grader failures do not alter the completed run and remain shadow-only.
- Expired evaluation claims recover without duplicate grade rows.
- Large rationale and raw output are artifacts; events remain bounded.
- Promotion reports calculate the four thresholds from human-adjudicated cases.

## Phase 2: Controlled Dynamic Collaboration

### Outcome

A running step may create durable child runs and communicate with them through controlled `spawn`, `message`, `wait`, `interrupt`, and `resume` operations. The accepted workflow graph remains unchanged.

### Delegation Model

```text
DelegationStep
  id
  root_run_id
  parent_run_id
  parent_attempt_id
  workflow_id                    nullable
  workflow_step_id               nullable
  parent_delegation_step_id      nullable
  child_run_id                   nullable until spawn commit
  spawn_call_id
  objective_artifact_id
  required                       boolean
  state                          planned | spawning | running | waiting |
                                 interrupting | interrupted | resuming |
                                 succeeded | failed | cancelled | lost
  depth
  permission_snapshot_artifact_id
  tool_allowlist_artifact_id
  workspace_scope_artifact_id
  provider_policy_artifact_id
  token_budget
  cost_budget_micros
  wall_time_budget_ms
  idempotency_key
  failure_code
  created_at
  updated_at
  completed_at

DelegationMessage
  id
  delegation_step_id
  direction                       parent_to_child | child_to_parent
  kind                            instruction | progress | result | control
  body_artifact_id
  digest
  idempotency_key
  created_at
```

### Delegation Tree

```text
accepted Workflow Step
  |
  +-- DelegationStep A (required)
  |     +-- child Run A
  |           +-- DelegationStep A.1 (required)
  |           +-- DelegationStep A.2 (optional)
  |
  +-- DelegationStep B (optional)

Workflow graph: unchanged
Completion gate: accepted step + required delegation descendants
```

### Capability and Budget Subset Rule

For every child:

```text
child.permissions       subset_of parent.permissions
child.tools             subset_of parent.tools
child.workspace_roots   subset_of parent.workspace_roots
child.providers         subset_of parent.providers
child.network_policy    no broader than parent.network_policy
child.secret_refs       subset_of explicitly delegated parent refs
child.budget            reserved from root-run remaining budget
```

The subset check runs before the child `RunSession` and attempt are created. The spawn transaction reserves budget and creates the delegation row and child run atomically.

### Root Budget

- Token, cost, and wall-time accounting roll up to the root run.
- Children reserve from root remaining capacity; unused reservation returns on terminal completion.
- Every runner/provider/tool-process limiter is checked in addition to the root budget.
- Exceeding the root budget prevents new child claims and interrupts active optional children first according to policy.
- A required child that cannot finish because the budget is exhausted fails its delegation and blocks the owning workflow step with a stable reason.

### Completion Gate

A workflow step can finish only when:

1. its existing operation bindings and approval gates pass;
2. all required direct and transitive delegation descendants are terminal;
3. all required descendants succeeded, unless the declared workflow failure policy accepts their failure;
4. no current delegated child attempt remains leased or running;
5. the parent attempt fence is still current.

Optional children may be cancelled when the parent step completes. Their terminal evidence remains visible.

### Phase 2 Acceptance Gate

- `spawn`, `message`, `wait`, `interrupt`, and `resume` are durable and idempotent.
- Restart reconstructs the same delegation tree and current child attempt.
- Capability expansion, workspace escape, provider escalation, and budget over-reservation fail before child creation.
- Required descendants block parent step completion.
- Optional descendants follow declared cancellation policy.
- Stale child completions cannot finish the parent step.
- Depth and cycle limits are deterministic.
- Root budget reports include every child run and grader-excluded accounting remains separate.

## Storage and Migration Plan

The current implementation branch migration head is version `134`. Versions `130-133` were already claimed by local feature work and must not be reused. This branch reserves the next free contiguous versions `135-138`; recheck the head immediately before each migration commit and renumber before merge if upstream claims them first.

| Proposed version | Migration | Tables / changes | Backfill |
| --- | --- | --- | --- |
| 135 | `create_runner_continuations` | `runner_continuations`, indexes by run/state/due time/idempotency | No synthetic historical continuation rows; existing runs remain readable through current lineage |
| 136 | `create_harness_tool_executions` | `harness_tool_executions`, indexes by attempt/tool call/state/due time | New tool calls only; existing execution actions remain unchanged |
| 137 | `create_run_evaluations` | `run_evaluations`, `run_evaluation_grades`, version indexes and unique grader-result key | No historical scores are invented |
| 138 | `create_delegation_tree` | `delegation_steps`, `delegation_messages`, lineage, child-run, state, and due-time indexes | Existing static workflows remain graph-only with no synthetic children |

Migration rules:

1. Each migration is idempotent and records its schema migration only after postconditions pass.
2. Foreign keys and `CHECK` constraints encode domain status unions where compatible with future additive states.
3. Partial unique indexes enforce idempotency for active claims and one logical object per idempotency key.
4. `PRAGMA foreign_key_check` and targeted postconditions run before commit.
5. Migration failure leaves the prior schema usable and prevents daemon startup from serving mutations.
6. Migration tests start from a v134 fixture and from an already-migrated database.
7. Large bodies are never migrated into SQLite event rows; only references and digests are stored.

### Required Indexes

```text
runner_continuations(run_id, created_at DESC)
runner_continuations(state, next_attempt_at, claim_expires_at)
runner_continuations(idempotency_key) UNIQUE

harness_tool_executions(attempt_id, tool_call_id) UNIQUE
harness_tool_executions(state, claim_expires_at)
harness_tool_executions(approval_id)
harness_tool_executions(side_effect_fingerprint)

run_evaluations(state, next_attempt_at, claim_expires_at)
run_evaluations(run_id, suite_id, suite_version, case_id, case_version)
run_evaluation_grades(evaluation_id, grader_type, grader_id, grader_version) UNIQUE

delegation_steps(root_run_id, parent_delegation_step_id, created_at)
delegation_steps(parent_run_id, state)
delegation_steps(child_run_id) UNIQUE WHERE child_run_id IS NOT NULL
delegation_steps(idempotency_key) UNIQUE
delegation_messages(delegation_step_id, created_at, id)
delegation_messages(idempotency_key) UNIQUE
```

## Artifact and Event Policy

### Store in SQLite Rows or Events

- ids, state, revisions, timestamps, lease metadata;
- runner/provider/tool/grader identifiers and versions;
- bounded summaries;
- byte counts, token counts, cost, and latency;
- SHA-256 digests;
- artifact ids and source refs;
- failure codes.

### Store as Artifacts

- full stdout and stderr;
- patches, write bodies, preimages, and postimages;
- deterministic replay packages;
- runner transcripts and opaque continuation payloads;
- delegation objectives and messages;
- grader prompts, raw responses, and rationales;
- large policy and capability snapshots.

### Projection Rules

- Projections are rebuildable from authoritative rows, events, and artifact metadata.
- Pagination is mandatory for event, evaluation, and delegation-message lists.
- Hot rows keep bounded summaries. Cold artifact bodies may be compressed.
- Pin policies preserve artifacts referenced by active continuations, unresolved tool outcomes, active evaluations, required delegation descendants, and audit holds.
- A projection failure does not change domain state. Recovery rebuilds the projection after the authoritative commit.

## Scheduling and Performance

### Layered Limits

```text
workspace limit
  -> root run limit
       -> provider limit
            -> runner limit
                 -> tool process limit

evaluation queue: separate low-priority worker limit
```

Rules:

- Child runs consume root-run budget and workspace/provider/runner capacity.
- Graders use separate execution slots but still obey provider quotas and cost ceilings.
- Tool processes have a dedicated cap so a run cannot exhaust host process capacity.
- Limits are persisted where ownership must survive restart; in-memory counters are caches only.
- Admission failures return a due time or stable blocked reason instead of spinning.

### Persistent Claim Queue

Every asynchronous domain follows this pattern:

```text
SQLite due row
  -> transactionally claim with owner + lease expiry
  -> emit in-memory wake-up after commit
  -> execute
  -> CAS terminal commit

startup / low-frequency scan
  -> find due unclaimed rows
  -> reclaim expired leases
  -> reconcile rows left in in-flight states
```

`ControlPlaneEventHub` reduces latency but is never the durable queue.

### Performance Budgets

Initial budgets should be measured in shadow mode before enforcement:

- harness bookkeeping adds no more than 25 ms p95 before runner dispatch for local SQLite;
- event rows stay below 16 KiB, excluding artifact bodies;
- queue claim transactions stay below 20 ms p95 on the supported local database size;
- startup reconciliation scans use due-state indexes and finish in bounded pages;
- evaluation scheduling does not increase normal run queue wait p95 by more than 5%;
- delegation listing and completion checks remain proportional to the active subtree, not all historical descendants.

## Production Failure Modes and User-Visible Results

| Failure | Durable response | User-visible result |
| --- | --- | --- |
| Native resume handle is missing or stale | Record handle failure and switch once to deterministic replay | "Runner session could not be resumed; Ling rebuilt the execution context" |
| Daemon stops after continuation preparation | Lease expires; recovery claims the same continuation and creates a fresh attempt | Run remains resumable and shows recovery history |
| Old runner finishes after a newer attempt starts | Fence check rejects every state and projection update | Old output appears only as ignored stale evidence, never as the final answer |
| Approval is resolved after its attempt is superseded | Approval decision remains audited; execution claim is rejected | Approval card shows stale/superseded and no tool runs |
| Sandbox cannot be created | Tool fails before process start | Tool card shows "sandbox unavailable" with remediation; no native fallback |
| Host crashes after a shell side effect but before evidence commit | Tool becomes `unknown_outcome`; automatic retry is blocked | User sees the exact command and a reconciliation action instead of a false success |
| File patch is partly applied | Compare preimage/postimage and classify applied, not applied, or diverged | User sees affected paths and must resolve divergence before resume |
| Artifact write fails after execution | Commit bounded metadata and `evidence_commit_failed` or `unknown_outcome` | Run is blocked as unverified; success is not fabricated |
| SQLite is busy | Back off with `nextAttemptAt`; retain claim authority | Work waits with an observable retry reason instead of spinning |
| Evaluation provider is down | Retry evaluation queue; do not reopen the completed run | Run remains complete; evaluation shows delayed or unavailable |
| Model grader changes version | Start a new promotion evidence window | Prior scores stay visible but cannot authorize the new grader version |
| Child requests broader permissions | Reject spawn transaction | Parent receives a capability-escalation result; no child run exists |
| Required child exceeds budget or is lost | Mark delegation failed and block workflow completion | Workflow step names the required child and failure reason |
| Projection update fails | Authoritative state remains committed; replay rebuilds projection | UI may lag, then recovers without changing execution outcome |

## Test Strategy

### Four-Layer Gate

```text
Layer 1: state machine and policy unit tests
  continuation transitions
  tool outcome classification
  capability subset and budget math
  grader promotion thresholds

Layer 2: SQLite and fault-injection tests
  migrations and postconditions
  CAS and fencing
  multi-entity transaction rollback
  claim lease expiry and recovery

Layer 3: daemon vertical integration
  fake runner
  fake grader
  real artifact store
  restart and stale-completion scenarios

Layer 4: conformance and evaluation
  runner resume/tool/abort/approval conformance
  LLM tool-definition behavior eval
  human-adjudicated model-grader promotion set
```

### Current 23 New Path Gaps

These are new-path gaps for the proposed harness. They do not mean the repository lacks all related lower-level tests.

| ID | Domain | Required test path | Merge gate |
| --- | --- | --- | --- |
| G01 | Continuation | Conformant native runner resumes into a fresh fenced attempt | Hard |
| G02 | Continuation | Runner without native resume uses the exact immutable replay package across restart | Hard |
| G03 | Continuation | Stale or rejected native handle falls back once and then returns a stable failure | Hard |
| G04 | Continuation | Crash after prepare and before claim recovers without duplicate current attempts | Hard |
| G05 | Continuation | Duplicate continuation idempotency key returns the existing lineage | Hard |
| G06 | Continuation | Stale source or target attempt completion cannot commit run or terminal projection state | Hard |
| G07 | Tool Broker | Denied or missing approval starts no process and writes no target file | Hard |
| G08 | Tool Broker | Approved execution atomically commits tool state, evidence refs, action projection, and event | Hard |
| G09 | Tool Broker | Crash after possible side effect produces `unknown_outcome` and blocks blind retry | Hard |
| G10 | Tool Broker | Timeout and cancellation kill the process group, close leases, and preserve partial output | Hard |
| G11 | Tool Broker | Traversal, symlink escape, and policy-snapshot drift fail before mutation | Hard |
| G12 | Tool Broker | Non-conformant runner cannot bypass the broker through native edit/write/bash | Hard |
| G13 | Tool Broker | Large stdout/stderr stays artifact-backed and secrets spanning chunks remain redacted | Hard |
| G14 | Evaluation | Rule grader is deterministic and rejects malformed results | Hard |
| G15 | Evaluation | Model grader in shadow mode cannot block a merge or alter terminal run state | Hard |
| G16 | Evaluation | Expired evaluation lease retries without duplicate append-only grade rows | Hard |
| G17 | Evaluation | Suite, case, baseline, and grader versions remain immutable in historical results | Hard |
| G18 | Evaluation | Promotion report enforces 100 adjudicated cases, zero severe misses, <=1% false blocks, and >=95% agreement | Hard before model-gate enforcement |
| G19 | Delegation | Child permission, tool, provider, secret, network, and workspace scopes are strict subsets | Hard |
| G20 | Delegation | Root token/cost/time budget includes descendants and prevents over-reservation | Hard |
| G21 | Delegation | Required transitive child blocks parent step; optional child follows cancellation policy | Hard |
| G22 | Delegation | Message, wait, interrupt, and resume operations are idempotent under retries | Hard |
| G23 | Delegation | Restart rebuilds the tree and stale child completion cannot finish the parent | Hard |

### Deterministic Versus Model Gates

Deterministic contract checks block merge from the first enforcing PR:

- state transition legality;
- current attempt fencing;
- lineage and idempotency;
- permission and workspace subset rules;
- no repeated side effect when outcome is unknown;
- budget reservation and release;
- migration integrity and rollback;
- bounded events and valid artifact refs.

Model graders remain shadow-only until the explicit promotion thresholds are met. Their initial purpose is to find tool-definition ambiguity and quality regressions, not to decide merge status.

### Validation Commands

Use the narrowest package command first, then the repository gate used by the implementation PR:

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/runner-pi test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm test
```

Fault-injection tests should use fake processes, fake runners, and temporary SQLite databases. Do not depend on paid providers for deterministic merge gates.

## Codex OSS Reference Audit

Reference: OpenAI Codex repository at commit `70eb36203dbb8c75d006b39cdfae74bd04e18a65`.

| Decision | Reference strength | Codex evidence | Ling adaptation |
| --- | --- | --- | --- |
| Persisted continuation with native resume or replay | Direct | `codex-rs/app-server-protocol/src/protocol/common.rs:559` exposes thread resume; `codex-rs/core/src/session/mod.rs:1384` restores persisted token usage for resume/fork | Ling keeps Run/Attempt and Continuity authority; runner handles remain opaque hints |
| Daemon-owned Tool Execution Broker | Direct | `codex-rs/core/src/tools/orchestrator.rs:130` centralizes approval, sandbox selection, execution, and telemetry | Ling extends existing unified exec and approval artifacts across bash/edit/write/apply-patch |
| Step-level delegation tree | Direct | `codex-rs/core/src/agent/control.rs:117` scopes shared agent control to a root session tree; multi-agent tests cover control operations | Ling persists the tree and links it to existing workflow-step completion gates |
| Root budget shared by child agents | Direct | `codex-rs/core/src/rollout_budget.rs:16` keeps shared root-session accounting and per-thread reminders | Ling adds token, cost, time, provider, runner, and tool-process limits |
| Four-layer tests and conformance | Direct pattern | Codex multi-agent and tool orchestrator tests exercise control and failure boundaries | Ling adds SQLite migration/fault injection because its daemon is the durable authority |
| Independent harness module boundary | Structural adaptation | Codex separates app-server protocol, core sessions, tool orchestration, and agent control | Ling uses `features/harness/` while preserving existing packages and APIs |
| Small events plus artifacts and rebuildable projections | Structural adaptation | Codex uses persisted rollout items and bounded protocol notifications | Ling retains its existing artifact/event/projection model and tightens payload policy |
| Persistent claim queue plus in-memory wake-up | Structural adaptation | Codex uses in-process control and serialization patterns, but Ling has a restartable SQLite daemon | SQLite remains authoritative; EventHub only wakes workers |
| Generic append-only `RunEvaluation` | Ling-owned | Codex exposes telemetry, token usage, tests, and feedback paths, but this audit found no public generic run-evaluation/grader schema | Design and name it as a Ling quality-control capability |
| Narrow ports plus atomic SQLite commit coordinator | Ling-owned | No equivalent public Ling-shaped `RunStore` problem exists in Codex | Follow existing Ling approval-resume and store-port patterns |
| Domain-specific state machines on shared CAS/fencing primitives | Ling-owned | Codex has domain-specific control types, but not this proposed shared persistence contract | Keeps recovery explicit and avoids a universal ambiguous status enum |
| Human-calibrated model-grader merge promotion | Ling-owned | No public Codex implementation found for this merge gate | Treat as a Ling release policy, initially shadow-only |

The Codex audit validates the control-plane direction. It does not justify copying Codex Thread/Turn storage, protocol, or single-session assumptions into Ling.

## PR Sequence

Each PR must be reviewable and releasable behind flags. Do not combine all four phases into one branch-wide implementation.

| PR | Priority | Scope | Depends on | Flag / rollout | Acceptance |
| --- | --- | --- | --- | --- | --- |
| H01 | P0 | Harness contracts, shared transition primitives, narrow store facets, composition seams | None | All flags `off` | Builds with no behavior change; existing tests pass |
| H02 | P0 | Migration 135 and continuation store/coordinator | H01 | continuation `shadow` | G04-G06 pass; shadow rows match existing continuation decisions |
| H03 | P0 | Deterministic replay and native-resume conformance adapter | H02 | continuation `shadow` then `enforce` for fake runner/Pi | G01-G03 pass; Pi replay survives restart |
| H04 | P0 | Route manual, queued, interrupt, approval, retry, and recovery attempts through continuation coordinator | H03 | continuation `enforce` | Existing continuation API/UI regressions pass; stale completion remains fenced |
| H05 | P0 | Migration 136 and Tool Broker around existing unified bash | H01, H02 | broker `shadow` | G07-G10 and existing bash tests pass |
| H06 | P0 | Daemon apply-patch/write executors and Pi fallback removal | H05 | broker `enforce` | G11-G13 pass; no runner-native mutation path remains |
| H07 | P1 | Sandbox profiles and external-runner tool conformance suite | H06 | native runner tools disabled by default | Non-conformant adapter fails closed |
| H08 | P1 | Migration 137, evaluation store, low-priority claim scheduler, rule grader | H01 | evaluation `shadow` | G14, G16, G17 pass; normal run slots unaffected |
| H09 | P1 | Model/human grades, cost/latency artifacts, promotion report | H08 | model gate `shadow` | G15, G18 pass; no merge block from model grader |
| H10 | P2 | Migration 138, delegation store, subset and budget policies | H01, H02 | delegation `shadow` | G19-G20 pass |
| H11 | P2 | Spawn/message/wait/interrupt/resume coordinator and recovery | H10 | delegation `shadow` | G22-G23 pass with fake runners |
| H12 | P2 | Workflow completion gate integration and controlled enablement | H11 | delegation `enforce` for selected workflows | G21 passes; accepted workflow graph is unchanged |
| H13 | P2 | Rebuildable projections, operator diagnostics, artifact retention, performance budgets | H04, H07, H09, H12 | staged per domain | Recovery dashboard and p95 budgets verified |

### Rollback Rule

Every enforcing PR must support rollback by disabling its feature flag and restarting the daemon. Rollback must not delete new rows, rewrite history, or require a down migration. New state remains readable for audit and future replay.

## Worktree Parallelization Strategy

### Dependency Table

| Workstream | Modules touched | Depends on |
| --- | --- | --- |
| Foundation | contracts, core harness primitives, daemon harness composition | None |
| Continuation | core harness continuation, SQLite continuation store, daemon run/runner integration | Foundation |
| Tool Broker | core harness tool execution, SQLite tool store, daemon harness executors, runner-pi | Foundation; continuation fencing seam |
| Evaluation | core harness evaluation, SQLite evaluation store, daemon evaluation workers | Foundation |
| Delegation | core harness delegation, SQLite delegation store, daemon harness delegation, channel completion gate | Foundation; continuation fencing seam |
| Final integration | central SQLite registration, exports, docs, diagnostics, full regression | All lanes |

### Parallel Lanes

- **Lane A:** H02 -> H03 -> H04 -> H05 -> H06 -> H07. Continuation and Tool Broker remain sequential because both own active attempts, approval resume, and runner handoff.
- **Lane B:** H08 -> H09. Evaluation is independent after foundation and uses a separate queue.
- **Lane C:** H10 -> H11 -> H12. Delegation is independent after foundation until the final workflow completion integration.
- **Lane D:** H13 after A, B, and C merge.

### Execution Order

1. Land H01 sequentially.
2. Launch Lane A, Lane B, and Lane C in clean worktrees.
3. Keep migration ownership fixed at the start of the wave and rebase before central registration changes.
4. Merge the three lanes, resolve only the known exports/migration-registration seams, then run Lane D.

### Conflict Flags

- Lanes A, B, and C all need core exports and SQLite migration registration. H01 should create stable per-domain registration seams; final shared-file edits remain a controlled merge point.
- Lane A and Lane C both touch attempt fencing and root-run lineage. Their public port contract must land in H01.
- Lane C touches the channel workflow completion gate. Keep that integration in H12 so earlier delegation work does not conflict with unrelated channel WIP.
- The user explicitly selected the existing clean implementation worktree and branch. Keep the dependency order, atomic commits, and fixed migration ownership here; do not touch the separate dirty UI2 checkout at `/Users/tianxiao/ling-stack`.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific reviewed gap.

- [x] **T1 (P0, human: ~1 day / CC: ~45 min)** — Harness foundation — Add contracts, state-machine primitives, narrow ports, feature flags, and composition seams.
  - Surfaced by: Code Quality CQ1-CQ3.
  - Files: `packages/contracts/src/`, `packages/core/src/harness/`, `packages/daemon/src/features/harness/`.
  - Verify: contracts, core, and daemon package tests with every flag off.
- [x] **T2 (P0, human: ~1.5 days / CC: ~60 min)** — Continuation storage — Add migration 135, continuation store, idempotency, leases, and atomic attempt creation.
  - Surfaced by: Architecture D2 and test gaps G04-G06.
  - Files: core SQLite migrations/stores and harness continuation domain.
  - Verify: v134 migration, rerun, rollback, duplicate claim, and stale-fence tests.
  - Implemented: migration 135, mapper/store, SQLite commit coordinator, explicit target
    Attempt precondition, immutable replay checks, claim-token ABA fencing, and fenced
    claim/start/finish transitions. Contracts 85/85 and Core 952/952 pass.
- [x] **T3 (P0, human: ~1.5 days / CC: ~60 min)** — Runner reconstruction — Implement native-resume gates and immutable deterministic replay.
  - Surfaced by: Architecture D2 and Codex resume reference audit.
  - Files: daemon harness continuation, runtime runners, runner conformance fixtures.
  - Verify: G01-G03 with Pi and a fake native runner.
  - Implemented: SQLite-sealed replay packages, secret and size bounds, stable replay
    fingerprints, native handle artifacts, workspace/policy/source lineage checks, explicit
    readiness/conformance/abort/approval gates, and one atomic native-to-replay generation.
  - Verified: Contracts 85/85, Core 952/952, H03 focused Core 13/13, reconstruction 9/9,
    runner registry 15/15, and the serial Daemon continuation/approval/workflow matrix
    241/241 pass. The default all-file Daemon command was not used as evidence because its
    parallel workers deadlocked on shared integration resources; the stable serial matrix
    completed with a real exit code.
- [x] **T4 (P0, human: ~1 day / CC: ~45 min)** — Continuation integration — Route all six origins into `RunnerContinuation` while preserving current turn/run semantics.
  - Surfaced by: Scope challenge and existing continuation fragmentation.
  - Files: daemon run threads, interventions, approval resume, recovery, and orchestrator wiring.
  - Verify: existing manual/queue/interrupt/approval regression suites plus restart recovery.
  - Implemented: manual resume, queued follow-up, interrupt redirect, approval resume,
    runner retry, and daemon recovery now prepare or adopt one durable continuation with
    immutable prepared input, a fresh fenced Attempt, scheduled conflict recovery, and
    terminal resource release. Approval restart replays durable tool evidence without
    executing the approved side effect twice; effect-unknown remains fail-closed.
  - Verified: daemon build; focused Core 137/137, approval recovery 13/13,
    continuation/prepared-input integration 30/30, and Runner Pi 181/181 pass. The two
    first failing files from the parallel all-file Daemon run pass independently
    (AI council 1/1 and approval/run integration 94/94); the aggregate runner remains a
    known shared-integration concurrency problem and is not used as H04 evidence.
- [x] **T5 (P0, human: ~2 days / CC: ~75 min)** — Tool Broker core — Add migration 136 and wrap daemon unified bash with prepare/approve/claim/evidence state.
  - Surfaced by: Architecture D3 and test gaps G07-G10.
  - Files: core tool-execution domain/store and daemon harness tool broker.
  - Verify: approval, cancellation, timeout, crash-window, and atomic SQLite commit tests.
  - Implemented: Attempt-fenced prepare and approval states, claim-token leases,
    daemon-owned unified bash execution, atomic terminal evidence references, startup
    reconciliation to `unknown_outcome`, and a rebuildable `ExecutionAction` projection.
    Approval restart creates a successor execution on the new Attempt and atomically marks
    the old pre-effect execution `superseded`; the lineage is retained through
    `supersedesExecutionId` and source refs.
  - Verified: daemon build; Harness/Core/broker focused suite 31/31 and the existing
    approval, restart recovery, command journal, cancellation, output, and execution-action
    regression set 152/152 pass.
- [x] **T6 (P0, human: ~2 days / CC: ~75 min)** — File mutation authority — Add daemon apply-patch/write executors and remove Pi native fallback in enforce mode.
  - Surfaced by: `packages/runner-pi/src/extensions/file-mutation.ts:16` and G11-G13.
  - Files: daemon harness executors, core patch helpers, runner-pi extension.
  - Verify: traversal, symlink, divergence, large output, and redaction tests.
  - Implemented: Pi `edit` and `write` now fail closed unless Host returns a handled
    result. Daemon native write, exact edit, and Codex-compatible apply-patch share one
    Attempt-fenced ToolExecution lifecycle with approval linkage, policy snapshot,
    stable execution identity, patch/result/provenance evidence, and hash-only recovery
    basis. Typed `file_create` remains existing-parent and no-clobber; patch-shaped typed
    create cannot downgrade into the ordinary replacement writer.
  - Safety: execution rechecks cancellation, workspace policy, lexical scope, symlink
    resolution, and `.ling-stack` exclusion immediately before effects. Updates use
    same-directory fsynced atomic replacement while preserving executable mode; creates
    use a hard-link no-clobber publish. Partial multi-file failure rolls back only this
    execution's verified postimages; concurrent external changes become `diverged`
    instead of being overwritten.
  - Recovery: expired file ToolExecutions classify durable pre/post hashes as
    `not_applied -> failed`, `applied -> succeeded`, or `diverged -> unknown_outcome`.
    The state transition and evidence refs commit in one SQLite transaction. Shell and
    unclassifiable effects retain the conservative `unknown_outcome` fallback.
  - Verified: Runner Pi 182/182, Core Harness/ToolExecution 24/24, Daemon
    broker/approval/workflow/patch/recovery 233/233, and the narrow H06 boundary matrix
    41/41 pass. Runner/Core/Daemon builds and `git diff --check` pass. Full repository and
    packaged macOS acceptance remain part of the final combined gate, not T6 evidence.
- [x] **T7 (P1, human: ~1 day / CC: ~45 min)** — Runner tool conformance — Gate native runner tools on approval, sandbox, evidence, cancellation, and fencing parity.
  - Surfaced by: Architecture D3 and Codex tool-orchestrator audit.
  - Implemented: `RegisteredRunner` now carries an adapter revision, side-effect map,
    and typed `RunnerToolExecutionConformanceV1` receipt. Registry resolution rejects
    missing receipts, adapter revision drift, uncurated tools, unclassified side effects,
    and missing evidence/abort/Attempt/workspace gates with a durable
    `runner_tool_conformance_failed` fallback reason.
  - External boundary: `codex-app-server` and `openclaw-acp` receipts curate only
    `read/grep/find/ls`; runner-native mutation, shell, network, provider-secret,
    delivery, and MCP effects stay disabled. The adapter repeats the receipt, requested
    tool, side-effect, and revision checks when a backend proposal actually arrives.
    `approvalBridgeVerified` is no longer hard-coded, and optional backend claims such as
    approval bridge or native resume do not enable unsupported Ling behavior.
  - Config/API: removed the external `conformancePassed` config escape hatch. Readiness
    reports typed per-capability evidence and blocker codes instead of deriving every
    safety claim from one boolean. The remaining `readinessPassed` flag only gates endpoint
    bootstrap and cannot authorize a tool.
  - Verified: Daemon build passes; external registry/readiness/adapter/bridge/conformance,
    hydration, reconstruction, and approval-recovery focused tests 63/63 pass; Contracts
    85/85, API client 52/52, Core fallback/migration 2/2, Web typecheck, and
    `git diff --check` pass. Full repository and packaged macOS acceptance remain part of
    the final combined gate.
- [ ] **T8 (P1, human: ~1.5 days / CC: ~60 min)** — Evaluation foundation — Add migration 137, append-only records, scheduler, and deterministic rule grader.
  - Surfaced by: Architecture D4 and performance P1/P3.
  - Files: core evaluation domain/store and daemon evaluation scheduler.
  - Verify: G14, G16, G17 and no normal-run semaphore use.
- [ ] **T9 (P1, human: ~1.5 days / CC: ~60 min)** — Evaluation calibration — Add model/human grades, artifacts, cost/latency, and promotion reports.
  - Surfaced by: Test T2 and gaps G15/G18.
  - Files: daemon graders, evaluation APIs/projections, fixtures.
  - Verify: model gate remains shadow and threshold math passes fixed datasets.
- [ ] **T10 (P2, human: ~1.5 days / CC: ~60 min)** — Delegation storage and policy — Add migration 138, tree lineage, subset checks, depth/cycle checks, and root budget reservation.
  - Surfaced by: Architecture D5 and gaps G19-G20.
  - Files: core delegation domain/store and runtime budget ports.
  - Verify: capability escalation and over-reservation roll back child creation.
- [ ] **T11 (P2, human: ~2 days / CC: ~75 min)** — Delegation operations — Implement durable spawn/message/wait/interrupt/resume and restart recovery.
  - Surfaced by: Architecture D5 and gaps G22-G23.
  - Files: daemon harness delegation coordinator/recovery and runner tool surface.
  - Verify: retry/idempotency, restart, lease expiry, and stale child completion tests.
- [ ] **T12 (P2, human: ~1 day / CC: ~45 min)** — Workflow integration — Add required-descendant completion checks without mutating the accepted graph.
  - Surfaced by: Architecture D5 and G21.
  - Files: channel workflow completion gate and harness delegation projection.
  - Verify: required, optional, transitive, failed, cancelled, and budget-exhausted child cases.
- [ ] **T13 (P2, human: ~1.5 days / CC: ~60 min)** — Operations and performance — Add rebuildable projections, diagnostics, artifact retention, paged recovery, and budget measurements.
  - Surfaced by: Performance P1-P3 and production failure review.
  - Files: daemon control-plane projections/diagnostics, artifact retention, harness workers.
  - Verify: restart reconciliation and the stated p95/event-size budgets on a representative local database.

## Delivery Checklist

Before enabling each phase:

- [ ] The domain migration passed from the current production schema head and on rerun.
- [ ] Feature flag `off` preserves current behavior.
- [ ] Shadow telemetry shows no unexplained decision mismatch.
- [ ] Deterministic hard gates pass.
- [ ] Restart and lease-expiry recovery pass.
- [ ] Stale completions are rejected.
- [ ] Event payload and artifact retention budgets pass.
- [ ] Existing run, thread, approval, artifact, and workflow projections remain compatible.
- [ ] Operator diagnostics name the current state, owner, fence, lease, next retry, and failure code.
- [ ] Rollback by disabling the flag has been exercised.

## Success Metrics

- Duplicate side effects caused by continuation or worker retry: **0** in deterministic tests and canary evidence.
- Stale attempt writes accepted: **0**.
- Continuation recovery after daemon restart: **100%** for prepared/claimed states in fixtures.
- Tool outcomes falsely reported as success when evidence is incomplete: **0**.
- Normal run queue p95 regression from evaluation workers: **<=5%**.
- Model grader severe false negatives before enforcement: **0 across >=100 adjudicated cases**.
- Delegated child capability expansions accepted: **0**.
- Required child omitted from parent completion gate: **0**.

## Retrospective Learning Applied

Recent branch history includes runtime fencing, Continuity v2 recovery, and terminal-evidence repair. Two prior project learnings directly affect this plan:

- `run_terminal_after_failure`: old provider loops can emit events after a run is terminal. Every new coordinator therefore uses the current attempt fence before domain or projection commits.
- `terminal-report-recovery-latest-per-source`: recovery must select the latest committed generation per source. Continuation and delegation projections therefore include generation and idempotency boundaries.

The plan avoids reopening existing UI2 files and limits current work to this document and gstack review artifacts.

## Current Branch Adoption Assessment

This plan is being implemented on the existing `codex/reasoning-summary-autoreview-implementation` branch at the user's direction. It remains split into atomic commits and feature-gated phases even though it shares one branch with the transcript and approval work.

| Domain | Current branch evidence | Adoption verdict |
| --- | --- | --- |
| Continuation | Manual resume, queued follow-up, interrupt redirect, approval resume, immutable prepared input, context-view lineage, fresh Attempts, and stale-completion fences already exist. `RunnerAdapter.resumeTask()` is declared but has no production caller. | Reuse current lineage and recovery. Add the durable strategy/claim record and native-resume gate; do not rebuild Continuity or approval resume. |
| Tool execution | Migration 136, the daemon bash/file broker, Attempt fencing, approval recovery supersession, crash-window reconciliation, atomic artifact refs, and the `ExecutionAction` evidence projection are implemented. Pi `edit` and `write` fail closed without a Host handled result; daemon executors own native write, exact edit, and apply-patch effects. | T5 and T6 are complete. Continue with T7 to reject external runners that cannot prove the same approval, sandbox, cancellation, fencing, and evidence behavior. |
| Evaluation | Skill regression and channel-team evaluation models exist, but no generic run/suite/case/baseline/grade lineage exists. | Reuse grader and artifact utilities only. Add a generic append-only evaluation domain without changing completed Run status. |
| Delegation | Accepted workflow graphs, participant manifests, required-evidence fan-in, step completion gates, and child presentation exist. Runtime `spawn/message/wait/interrupt/resume` and a restartable child tree do not. | Keep the workflow graph immutable. Add only the Step-scoped durable delegation overlay and root-budget/subset gates. |
| Queue and recovery | Runtime semaphores, approval-review WorkUnits, leases, attempts, EventHub wake-up, and startup recovery patterns exist. | Reuse the WorkUnit/Attempt and claim patterns. Do not add a second scheduler framework or in-memory authority. |
| UI | Typed canonical transcript, nested sub-agent presentation, approval cards, TerminalReport and artifacts are already implemented in the current branch. | No new transcript renderer. New harness states project into the existing typed timeline and diagnostics. |

### Combined Validation Rule

The original transcript/approval gates and the new Harness G01-G23 gates are one final acceptance set. Each Harness phase runs narrow deterministic tests first. After all enforcing phases land, run the repository checks, isolated-per-file Daemon suite, packaged macOS smoke, daemon restart, SSE reconnect, approval resume, continuation replay, tool crash-window reconciliation, evaluation recovery, and required-child fan-in in the same packaged application build.

## GSTACK REVIEW REPORT

### Review Runs

| Review | Runs | Status | Findings |
| --- | ---: | --- | --- |
| Scope Challenge | 1 | Closed | Four-stage vertical scope accepted; no runtime rewrite |
| Architecture | 4 decisions | Closed | Ling-owned continuation, Tool Broker, generic evaluation, and delegation tree |
| Code Quality | 3 decisions | Closed | Harness module boundary, narrow ports/commit coordinator, domain state machines |
| Tests | 2 decisions | Closed | Four-layer gate and deterministic-hard/model-shadow policy; 23 paths enumerated |
| Performance | 3 decisions | Closed | Layered quotas, artifact-backed payloads, persistent claim queues |
| Codex OSS Reference Audit | 1 | Complete | Direct references separated from structural adaptations and Ling-owned designs |
| Outside Voice | 0 | Skipped | The active reviewer is Codex; the OSS source audit is evidence, not an independent model review |

### Completion Summary

- Step 0: Scope Challenge — scope accepted as four vertical phases.
- Architecture Review: 4 issues found and resolved in the plan.
- Code Quality Review: 3 issues found and resolved in the plan.
- Test Review: coverage diagram produced, 23 new-path gaps identified.
- Performance Review: 3 issues found and resolved in the plan.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0 proposed; actionable work is recorded here and in the gstack task artifact.
- Failure modes: 14 production modes covered; 0 unresolved critical gaps.
- Outside voice: skipped because this review is already running in Codex.
- Parallelization: 4 lanes; 3 implementation lanes parallel after 1 sequential foundation, then 1 sequential integration lane.
- Lake Score: 12/12 reviewed recommendations chose the complete option.

### Findings Verdict

| Area | Initial risk | Final control | Unresolved |
| --- | --- | --- | ---: |
| Continuation authority | Runner-local or fragmented resume state | Persisted Ling `RunnerContinuation` plus fresh fenced attempts | 0 |
| Tool side effects | Runner-dependent mutation and evidence | Daemon broker with fail-closed sandbox and explicit unknown outcomes | 0 |
| Evaluation quality | No generic versioned run-quality loop | Append-only rule/model/human evaluation with shadow promotion | 0 |
| Dynamic collaboration | Ephemeral children can escape lineage and budget | Durable delegation tree with subset and completion gates | 0 |
| Store coupling | New services could depend on the full `RunStore` | Narrow domain ports and SQLite-only atomic coordinator | 0 |
| Recovery performance | Polling and large event rows | Indexed claim queues, EventHub wake-up, artifact-backed bodies | 0 |

### Suppressed Findings

None. Low-confidence implementation details were kept as implementation-time measurements or recheck requirements rather than reported as current defects.

### VERDICT

**APPROVED FOR PHASED IMPLEMENTATION.** Implement H01-H13 as ordered, atomic commits on the current clean implementation branch, per the user's explicit decision. Keep all flags off or shadow until each enforcing gate passes, and do not touch the separate dirty UI2 checkout.

NO UNRESOLVED DECISIONS
