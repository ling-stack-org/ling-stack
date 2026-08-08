# Run Interruption And Continuation

Status: implemented product and runtime contract
Owner: Runtime supervisor, daemon API, Web run surface
Last verified: 2026-08-08

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
- ordinary Composer submissions for queued guidance plus explicit stop controls;
- refresh-safe intervention lists with cancel and edit actions. Channel guidance cannot be
  promoted ahead of the FIFO because promotion would interrupt the active reply.

Ordinary channel replies are eligible sources because each reply now owns a standard
`RunSession`. The `channel_ai_reply` WorkUnit only projects supervision state. Whenever any
reply is active, the Composer remains the ordinary channel input with no target selector.
The daemon resolves no AI mention to Ling Agent, one AI mention to that teammate, and
multiple AI mentions back to Ling Agent for coordination. Each Channel conversation line owns
its own reply lane: Root, Branch, message-keyed Topic, or explicit Thread. A later non-empty
message becomes a `queue_followup` only when the Web sends an explicit typed disposition and
the daemon verifies the exact active Run against that same line. A related message may target
a different idle teammate; the queued payload retains its resolved target so the correct
teammate and model are selected only when that FIFO item starts. An absent, stale, terminal,
cross-channel, or cross-line disposition goes through normal intent routing.
This reuses the same intervention FIFO and does not introduce another queue or persistence
table. Rapid consecutive submits use independent Web request identities and may reach the
same daemon FIFO concurrently; transport latency cannot discard the later durable user
message.

Before the first reply Run is linked, the daemon serializes only dispatch ownership through
a process-local lane scoped to workspace, channel, and conversation line. A mode-only
`queue_followup` may follow that specific in-flight predecessor and wait for its real Run id.
If no predecessor lane exists, the daemon does not attach the message to another active Run;
normal intent routing continues. Dispatch failure releases the lane so the next message can
become the owner. This transient lane contains no
user payload and is neither an intervention queue nor a restart-recovery authority.
The queued intervention separately stores the canonical target teammate id. No mention uses
`ling_agent`; the author-type label `ai-teammate` must never be persisted as an executor id.
This guarantees that rapid later messages join the channel FIFO instead of creating another
root Run for an idle teammate.

The channel stream emits `reply_pending` only when the accepted message owns its conversation-line lane
and is actually preparing a new reply. A message that finds an active lane returns
`followup_queued` directly and must never flash a temporary thinking projection. The event
carries no Run id and grants no execution or queue authority.

Ordinary channel message text never selects `interrupt_redirect`, including instructions
such as "stop" or "use another approach". Interruption remains an explicit control: empty
Composer submit against the one active channel reply, or a Run detail action. It never
converts a non-empty message into interruption.

When a queued intervention carries a channel `sourceMessageId`, its message is hidden from the
transcript and shown once in the Composer guidance queue. When the intervention enters
`starting_continuation`, the queue item disappears and that same durable message enters the
transcript. A cancelled item never enters the transcript.

Channel, normal conversation, and teammate private chat receive the same compact
`activeReply` projection after the real RunSession and supervising WorkUnit are durably
linked. Its first status is normally `queued`; that is already an active, cancellable
guidance target. The Composer therefore unlocks at durable linkage rather than waiting for
`running`, the first model delta, or reply completion.

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

For conversation surfaces, "remains available" means the initial send is locked only
until its user message is accepted and its reply target is linked. A subsequent non-empty
submit creates the existing `RunIntervention`; an empty submit invokes stop. The still-open
response stream does not own the Composer lock.

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
  messagePayload?: {
    sourceMessageId?: string;
    body: string;
    attachmentIds: string[];
    linkPreviewIds: string[];
  };
  requestedBy: "local-user" | "system";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}
```

For channel replies, `messagePayload.sourceMessageId` is the authoritative relationship to
the already-persisted ordinary user message. Idempotency keys remain deduplication material
and must not be parsed as a foreign key. Before a continuation starts, the daemon creates a
deterministic pending Agent message; the continuation WorkUnit uses the source user message
as its owner and that Agent message as `linkedMessageId`.

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
- `completedAt` is written when the continuation Run reaches any terminal state. A
  successful continuation keeps `status=started` and gains `completedAt`; failed and
  cancelled continuations also record their terminal status and failure reason. A started
  row without `completedAt` is still in progress and must remain recoverable after restart.
- An accepted teammate follow-up is persisted as an ordinary `local-user` message with
  the user's original body. It must not add `排队引导` or another control prefix to the
  model prompt. The continuation system prompt tells the Agent to respond directly and
  not acknowledge receipt, queueing, or continuation mechanics.
- A channel continuation rebuilds the normal channel Context Pack around that persisted
  follow-up. The follow-up occupies the current `User message` section; the source Run's
  prior `task.prompt` must never be copied into the new turn as another current instruction.
  Earlier channel messages and completed replies from older interventions in the same FIFO
  chain remain bounded history evidence only. This preserves short-reference continuity
  without allowing an earlier long request to restart or override the latest guidance.

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

The public Run-intervention API accepts content payload fields such as body, attachments,
links, and workspace refs. Channel lineage fields `sourceMessageId` and `targetTeammateId`
are daemon-managed and are rejected on this public endpoint; only the Channel reply-dispatch
path may persist them after same-line validation.

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

- Persist the originating channel input as an ordinary user message before dispatch.
- Record the intervention with `status=queued`.
- Do not cancel the source work unit.
- When the source run reaches terminal state, claim the next queued intervention for the
  same source run or task.
- Start a new run with `parentRunId=sourceRunId` and `interventionId`.
- Preserve FIFO order per source run.
- Rebuild channel context for every continuation. The claimed intervention is the current
  user turn; any earlier completed continuation reply may be included only as prior context.

Interrupt and redirect:

- Never infer this mode from ordinary channel message text.
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

Before that refresh completes, the client may bridge the gap with the compact SSE target.
It must reconcile by `runId`, reject stale owner/request events, and never synthesize a
complete RunSession. A stale fetched Run detail cannot replace a newer terminal list item.
Transport failure before user-message acceptance restores the draft; failure after
acceptance does not, because retrying the original payload could duplicate a durable
message. When no reply remains active, channel target selection returns to Ling Agent.
These rules reuse RunIntervention persistence and add no queue or table.

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
