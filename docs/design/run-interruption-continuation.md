# Run Interruption And Continuation

Status: implemented product and runtime contract
Owner: Runtime supervisor, daemon API, Web run surface
Last verified: 2026-08-03

## Summary

Ling Stack supports human course correction while an AI teammate run is active.
The product goal is not true token-stream prompt injection. The goal is an auditable
runtime interaction model:

```text
active run
  -> user adds a follow-up or redirect
  -> daemon records the intervention
  -> either queue the instruction or cancel-and-continue
  -> next run starts with explicit lineage and continuation context
```

This borrows the Codex-style interaction pattern of "keep working, but let the user
steer" while preserving Ling's daemon-owned runtime supervisor, approvals, memory audit,
and state-machine guarantees.

The complete approval, evidence, thread, and resume product contract is defined in
[Codex-Like Execution Experience](codex-like-execution.md).

## Current State

The current daemon and Web surfaces implement:

- durable `RunIntervention` records with `queue_followup` and `interrupt_redirect`;
- FIFO continuation, explicit source-run lineage, cancellation and late-result guards;
- preserved partial events, attachments, links, workspace refs, artifacts, approvals,
  and memory evidence;
- channel Composer controls that distinguish queued guidance from stop-and-redirect;
- refresh-safe intervention lists and explicit cancel/edit/promote actions.

Ordinary channel replies are eligible sources because each reply now owns a standard
`RunSession`. The `channel_ai_reply` WorkUnit only projects supervision state. A single
active reply is targeted automatically; concurrent teammate replies require explicit
target selection before queue, redirect, or stop. This reuses the same intervention FIFO
and does not introduce another queue or persistence table.

Runner-native token-stream prompt injection remains intentionally unsupported. Guidance
is applied only at an auditable continuation boundary.

## Non-Goals

- Do not inject prompt text into an active Pi `session.prompt(...)` call.
- Do not silently merge user interjections into the current run.
- Do not claim real-time chat with the underlying model unless the runner exposes a
  stable protocol for it.
- Do not let a stale runner completion move a cancelled run or work unit to `succeeded`.
- Do not give interjection text extra tools, approvals, secrets, or external-send rights.
- Do not discard partial events, artifacts, approvals, or used-memory audit.

## User Modes

### Queue Follow-Up

Use when the user wants to add guidance without stopping the active run.

```text
user submits follow-up
  -> daemon creates queued continuation request
  -> active run continues
  -> active run reaches terminal state
  -> daemon starts next run in FIFO order
  -> next run prompt includes previous result + queued instruction + source links
```

Expected UI:

- Composer remains available while a run is active.
- Primary action: `Queue follow-up`.
- The active run detail shows pending follow-ups.
- When the next run starts, it shows `Continues from run_...`.

### Interrupt And Redirect

Use when the active run is going in the wrong direction and should stop.

```text
user submits redirect
  -> daemon records interruption request
  -> daemon cancels active run/work unit
  -> partial messages/events/artifacts remain durable
  -> daemon builds continuation context
  -> daemon starts a linked continuation run
```

Expected UI:

- Destructive action label: `Stop and redirect`.
- User must provide a redirect instruction.
- The interrupted run stays visible as `cancelled` or `interrupted`.
- The continuation run shows the source run, interrupt reason, partial output summary,
  and any used memory.

## Data Model

Add a durable intervention record rather than overloading run messages:

```ts
type RunInterventionMode = "queue_followup" | "interrupt_redirect";
type RunInterventionStatus =
  | "queued"
  | "cancelling_source"
  | "starting_continuation"
  | "started"
  | "failed"
  | "cancelled";

interface RunIntervention {
  id: string;
  workspaceId: string;
  sourceRunId: string;
  sourceWorkUnitId?: string;
  sourceAttemptId?: string;
  continuationRunId?: string;
  continuationWorkUnitId?: string;
  mode: RunInterventionMode;
  status: RunInterventionStatus;
  instruction: string;
  requestedBy: "local-user" | "system";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}
```

Run records should gain optional lineage fields:

```ts
interface RunLineage {
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: string;
}
```

State transition and runtime event types should include:

- `run_intervention_created`
- `run_followup_queued`
- `run_interrupt_requested`
- `run_continuation_starting`
- `run_continuation_started`
- `run_intervention_failed`

Queue presentation is narrower than durable intervention history:

- `queued` and `cancelling_source` remain visible in the guidance queue because the
  follow-up has not started yet.
- `starting_continuation` exits the guidance queue immediately. The accepted guidance
  is represented by the ordinary user message and the active reply surface instead of
  being duplicated in both places until the reply completes.
- `started`, `failed`, and `cancelled` remain durable audit states but are not active
  queue rows. Failures use their owning run or conversation feedback surface.
- An accepted teammate follow-up is persisted as an ordinary `local-user` message with
  the user's original body. It must not add `排队引导` or another control prefix to the
  model prompt. The continuation system prompt tells the Agent to respond directly and
  not acknowledge receipt, queueing, or continuation mechanics.

## API Shape

```text
POST /runs/:id/interventions
GET /runs/:id/interventions
GET /run-interventions/:id
POST /run-interventions/:id/cancel
```

Create input:

```json
{
  "mode": "queue_followup",
  "instruction": "When this finishes, also check the memory audit UI.",
  "idempotencyKey": "client-generated-key"
}
```

Interrupt input:

```json
{
  "mode": "interrupt_redirect",
  "instruction": "Stop. Use the daemon API path instead of editing the UI first.",
  "idempotencyKey": "client-generated-key"
}
```

The daemon should return the intervention immediately. For interrupt mode, it can also
return the cancellation state and eventually the continuation run id.

## Continuation Context

Continuation prompt construction should be explicit and bounded:

```text
Original task:
<task title and prompt>

Interrupted run:
<run id, status, selected skill, provider, timestamps>

Partial result:
<short summary of durable assistant messages/events/artifacts>

User redirect:
<verbatim instruction>

Constraints:
- Continue from the preserved context.
- Do not assume unseen state.
- Do not repeat side effects that may already have happened.
- Re-check files or external state before acting if prior output was partial.
```

For queued follow-up after a successful run, the continuation can use the final result
instead of partial output.

## Policy

- The continuation run must re-resolve provider readiness, effective skill, tools, MCP
  access, approvals, memory recall, leases, and channel status.
- The intervention text does not grant permissions.
- External sends, deploys, broad file changes, credentials, and high-cost media actions
  still require approval.
- Memory recall should run again for the continuation, and used-memory events should
  attach to the continuation run.
- If the source run used a selected skill, the continuation may inherit it only after
  effective-skill validation passes again.

## Runtime Semantics

Queue follow-up:

- Record the intervention with `status=queued`.
- Do not cancel the source work unit.
- When the source run reaches terminal state, claim the next queued intervention for the
  same source run or task.
- Start a new run with `parentRunId=sourceRunId` and `interventionId`.
- Preserve FIFO order per source run.

Interrupt and redirect:

- Record the intervention.
- Transition the source work unit to `cancelling` and the source run to `cancelled` or a
  future `interrupted` state if introduced.
- Abort the active runner attempt.
- Ignore late success events from the source attempt.
- Release runtime resources.
- Start the continuation run only after the cancellation transition is durable.

## UI Requirements

Task/run surfaces should show:

- active run status,
- `Queue follow-up` composer,
- `Stop and redirect` action,
- queued interventions,
- continuation lineage,
- interrupted run partial output,
- used-memory summary for both source and continuation runs.

The UI must not make browser connection state the source of truth. If the page refreshes,
it should reload interventions and lineage from the daemon.

## Relationship To Streaming Private Replies

Streaming private replies improves chat responsiveness. Run Interruption And Continuation
improves active task steering. They can share UI conventions, but the runtime design is
separate:

- private reply streaming emits assistant text deltas,
- run interruption records durable intervention requests and may start new supervised
  runs.

## Open Questions

1. Should interrupted runs use the existing `cancelled` status or a new `interrupted`
   status?
   Recommendation: start with `cancelled` plus an intervention record; add `interrupted`
   only if UI/reporting needs a first-class status.
2. Should queue follow-up attach to source run, task, or work unit?
   Recommendation: attach to source run and copy `taskId`/`workUnitId` for indexing.
3. Should the continuation run reuse the same `requestedSkillId`?
   Recommendation: inherit the requested skill but revalidate effective skill before run
   start.
4. Should an interrupt auto-start continuation if cancellation times out?
   Recommendation: no. Mark intervention `failed` if source cancellation becomes stale;
   let the user retry after reconcile.

## Implementation Slices

### Slice 1: Durable Intervention Records

- Add core types and SQLite table.
- Add list/create/cancel daemon APIs.
- Add idempotency.
- Add tests for create/list/cancel and invalid source run states.

### Slice 2: Queue Follow-Up

- Start queued continuation after source run terminal state.
- Link continuation run to source run.
- Add Web pending follow-up UI.
- Test FIFO ordering and duplicate idempotency.

### Slice 3: Interrupt And Redirect

- Wire cancellation plus continuation start.
- Preserve partial outputs and artifacts.
- Add lineage UI.
- Test late success after cancel, source cancellation timeout, and continuation failure.

### Slice 4: Runtime Polish

- Add compact partial-output summaries.
- Add Used Memory display for source and continuation.
- Add e2e coverage for queue, interrupt, page refresh, and retry.
