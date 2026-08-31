# Conversation Activity Summary And Exploration Batching Detailed Design

Status: subordinate projection rule; canonical contract in
[Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Date: 2026-09-01
Last verified: 2026-09-01
Scope: completed work-cell activity summaries, read-operation batching, shared
conversation projections, Continuity v2 integration boundaries, and validation

Related docs:

- [Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)

## 1. Purpose

Ling currently preserves each execution action as a visible operation row. That is
correct for auditability, but a long sequence of safe read operations creates repetitive
visual noise:

```text
read_only
  已读取
read_only
  已读取
read_only
  已读取
```

The target presentation has two layers:

```text
authoritative execution evidence
  -> typed operation rows
  -> compact activity summary
  -> reversible activity-item projection
       ├── exploration batch
       ├── command batch
       └── standalone consequential or exceptional action
```

The summary and batches are display projections only. They never replace, coalesce,
rewrite, or delete the underlying `ExecutionAction`, run event, artifact, or source
reference.

## 2. Continuity v2 Boundary

This feature is downstream of the v3 typed transcript design. It must not create a second conversation
timeline or become another context authority.

| Layer | Authority | This feature's relationship |
| --- | --- | --- |
| `LingThread` / `LingTurn` / `ConversationItem` | canonical conversation timeline and lineage | read-only source context |
| `ConversationContextProjector` | permission-filtered context views and source refs | not changed by activity grouping |
| Run / approval / artifact stores | execution and business facts | remain authoritative |
| `ExecutionAction` and run events | tool action identity, status, and evidence | input to the row projection |
| `ConversationWorkCell` | user-visible operation rendering | consumes the derived projection |
| Activity summary and batches | presentation state | reversible, derived, and non-canonical |

Invariants:

- Do not add an activity-summary item to `conversation_items` merely for rendering.
- Do not write batch membership back to `LingTurn`, Run, approval, or artifact records.
- Do not rebuild activity history from fixed `channel_messages` or ad-hoc message windows.
- Preserve source refs and stable action ids on every child row and batch.
- `contextSegmentId` belongs to the context projection and captured run input. Activity
  grouping must neither create nor change context segments.
- Do not add a SQLite activity-summary or batch table. Rebuild the presentation from
  canonical `ExecutionAction`, RunEvent, approval, artifact, and Continuity lineage.
- Disclosure state belongs to the view store. It is not conversation state.

Continuity v2 is already present on `main`. The implementation therefore consumes the
canonical channel/item projection directly and must not restore the legacy
`/channels/:id/messages` path or its fixed message window.

## 3. Product Contract

### 3.1 Completed activity summary

The completed work-cell shell may show a compact activity summary instead of a generic
`Processed` label when structured actions exist:

```text
已编辑 2 个文件 · 已读取 8 项 · 已运行 3 个命令
```

Rules:

- Count only structured execution actions in the current work cell.
- Exclude notes, terminal-report prose, artifact-only rows, approvals, and memory
  citations from activity counts.
- Use action type and status, never translated titles or labels such as `已读取` or
  `read_only`, as the classification authority.
- Say `项` when target refs do not prove that every child is a file. Do not fabricate a
  file count from a filename embedded in prose.
- Preserve the existing `Processed`, `Failed`, `Blocked`, and `Stopped` fallback when
  no structured activity exists.
- Active work shows the latest active action. It does not continuously rewrite a full
  historical summary for every output chunk.
- The summary count is navigation copy, not completion evidence. Terminal reporting,
  workflow completion, and multi-agent fan-in must inspect the atomic actions and their
  source lineage rather than a summary or batch count.

### 3.2 Exploration batch

The first slice groups adjacent successful read-family operations:

```text
已读取 8 项
```

Expanding the batch reveals the original rows in transcript order. Each child remains
independently expandable and keeps its source references.

The first read family is the operation kind already normalized by the Web projection:

- `read`
- `grep`
- `find`
- `ls`

Search/MCP rows remain standalone in the first slice because their query and external
target semantics differ from file reads. A later extension may add a typed exploration
family without changing the batch identity or Continuity boundary.

### 3.3 Existing command batch

`command_batch` remains responsible only for successful, low-risk Bash commands. It is
not renamed to or broadened into `exploration_batch`. The command contract remains in
[Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md).

## 4. Shared View Model

The row needs common execution identity in addition to command-specific evidence:

```ts
interface ConversationOperationSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly visibility?: "conversation" | "private";
}

interface ConversationOperationExecutionView {
  readonly actionId: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly turnRunRole?: "primary" | "retry" | "resume" | "repair" | "validation";
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly actionType: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}
```

`ConversationWorkCellRow` gains an optional `operationExecution` field. The existing
`commandExecution` field remains the specialized source for command text, output, exit
code, and artifacts.

The shared item union becomes:

```ts
type ConversationWorkCellItem =
  | { readonly kind: "operation"; readonly row: ConversationWorkCellRow }
  | { readonly kind: "command_batch"; readonly batch: ConversationCommandBatch }
  | { readonly kind: "exploration_batch"; readonly batch: ConversationExplorationBatch };

interface ConversationExplorationBatch {
  readonly id: string;
  readonly revisionKey: string;
  readonly actionIds: readonly string[];
  readonly runId: string;
  readonly attemptId?: string;
  readonly turnRunRole?: "primary" | "retry" | "resume" | "repair" | "validation";
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
  readonly operationCount: number;
  readonly targetCount?: number;
  readonly defaultExpanded: boolean;
  readonly rows: readonly ConversationWorkCellRow[];
}
```

The operation metadata is a projection of the authoritative action and its canonical run
lineage. It is not a new runtime record and must not be used to make approval or execution
decisions. When `attemptId` is not stored on an action, the adapter resolves it from the
owning Run/WorkUnit Attempt or Ling turn-run link; unresolved attempt lineage makes the
row ineligible for batching.

`command_batch` must expose the same lineage fields and ordered `actionIds`. Existing
command-specific evidence remains on its child items. This is a contract extension, not
a reason to duplicate or replace the implemented command batching algorithm.

## 5. Deterministic Projection

The shared projection receives rows in stable transcript order and emits activity items.
It must be used by the primary work-cell stream and every agent span.

An exploration row is eligible only when:

```text
normalized kind = read
actionType ∈ {read, grep, find, ls}
status = succeeded
row is not a note
actionId is stable
run and attempt/retry lineage is known
```

The grouping algorithm is:

1. Iterate rows in transcript order.
2. Start a pending read segment at the first eligible row.
3. Append only when run, attempt, turn-run role, participant, work unit, and workflow
   step match.
4. Flush before every non-eligible row or scope change.
5. Emit `exploration_batch` only when the segment contains at least three rows.
6. Emit one or two rows as ordinary operation items.
7. Keep executing, failed, cancelled, approval-gated, and consequential rows standalone.
8. Preserve the original row order exactly.

Example:

```text
read A
read B
read C
edit D
read E
read F
read G
```

becomes:

```text
exploration_batch[A,B,C]
operation[edit D]
exploration_batch[E,F,G]
```

Hard boundaries are the same as command batching where applicable:

- different agent/participant, run, attempt, or turn-run role;
- different work unit or workflow step;
- note, handoff, edit, command, approval, artifact, or browser row;
- failure, cancellation, timeout, or active execution;
- retry, resume, repair, validation, or second-wave run;
- an approval boundary, even when the actions on both sides later succeed;
- consequential actions such as write/edit, Git history mutation, deployment, credential
  access, provider configuration, network send, or external-system mutation;
- missing stable action identity, source refs, or required lineage.

The batch id is derived from participant scope, run scope, and the first child action:

```text
exploration-batch:{participantScope}:{runId}:{firstActionId}
```

The revision key includes ordered child ids, statuses, and `updatedAt` values. A later
read appended to the same segment updates the batch without discarding user disclosure
state.

These boundaries also constrain `command_batch`. No command or exploration batch may
cross an agent, run, attempt, retry role, workflow step, approval, failed action, or
consequential action. The batch retains the union of visible child `sourceRefs`, while
each child retains its original refs for exact UI-to-SQL traceability.

## 6. Rendering And Accessibility

Add a shared `ConversationExplorationBatch` component beside
`ConversationCommandBatch`.

- Use a native button with `aria-expanded` and a localized accessible label.
- Keep the batch borderless and visually subordinate to normal conversation text.
- Render child rows with the existing `WorkCellRow`; do not create nested chat bubbles.
- The batch disclosure controls only the child list.
- A child row controls only its own detail.
- Preserve keyboard focus behavior and reduced-motion behavior from command batches.
- Do not announce every read event individually through a live region.
- The collapsed summary must remain understandable without color or icon recognition.

Suggested copy:

```text
已读取 8 项
已展开读取记录
折叠读取记录
```

## 7. Refresh And Recovery

The projection is recomputed from the latest authoritative rows. It does not add a
browser-side action store.

- A changing action revision updates the summary and batch revision key.
- `tool_start`, `tool_update`, and `tool_end` fold into the same stable action identity.
  Each newer event sequence invalidates the shared projection so live output and status
  cannot remain stale.
- Stable batch ids preserve disclosure state when a segment grows.
- An active read is rendered separately and never retroactively inserted into a completed
  batch while it is still executing.
- Missing or malformed optional metadata leaves the atomic row visible and skips grouping.
- Refresh must not switch the work-cell or page into a loading state.
- Continuity context refresh and activity evidence refresh remain separate invalidation
  concerns.

## 8. Authority Consumers

Presentation grouping is never a completion oracle:

- `TerminalReport` reads atomic `ExecutionAction`, RunEvent, approval, artifact, and
  verification evidence with source refs.
- Multi-agent fan-in succeeds only after every required participant has terminal atomic
  evidence for the expected run/attempt/workflow-step lineage.
- A visible batch, summary count, or model-authored ready/done sentence cannot satisfy a
  required participant.
- A structured blocked result remains atomic evidence and must identify its participant,
  run, attempt, workflow step, blocker, and supporting source refs.

## 9. Implementation Slices

These are implementation follow-ups, not part of the Continuity v2 canonical model:

1. **R5 - evidence contract:** add common operation lineage and source refs, expose the
   same fields on command batches, and verify `tool_start/tool_update/tool_end` folding,
   stable action identity, revision, and invalidation.
2. **R6 - pure projection:** add the `exploration_batch` union variant plus shared,
   deterministic activity-summary and batching functions. Keep them outside React and
   outside persistence.
3. **R7 - shared UI:** add the exploration renderer, copy, styles, and disclosure state;
   ordinary conversation, channel, teammate-private, and every agent span consume the
   same projection.
4. **R8 - recovery and regression:** cover failures, cancellation, approvals, retry and
   attempt isolation, cross-agent isolation, TerminalReport/fan-in lineage, SSE reconnect,
   daemon restart, and packaged macOS GUI smoke.

## 10. Validation Contract

Core tests must cover:

- three successful reads form one batch;
- one or two reads remain standalone;
- an edit, command, note, approval, or failure splits the batch;
- active reads remain outside completed batches;
- different runs, participants, work units, and workflow steps never merge;
- different attempts and retry/resume/repair/validation roles never merge;
- a growing batch keeps its id and touched disclosure state;
- malformed metadata falls back to atomic rows;
- batch and child source refs preserve round-trip lineage to the authoritative SQLite
  action/run/attempt evidence;
- activity summaries exclude notes, reports, artifacts, approvals, and memory citations;
- file counts are shown only when structured file refs justify them.

Web E2E must cover channel, ordinary conversation, and teammate-private surfaces,
including keyboard disclosure, reduced motion, refresh without flicker, and no horizontal
overflow. Packaged macOS validation must additionally exercise daemon restart and SSE
reconnect recovery; browser-only fixtures do not close those two acceptance items.

Acceptance example:

```text
summary: 已编辑 2 个文件 · 已读取 8 项 · 已运行 3 个命令
stream:  exploration batch + command batch + standalone edit row
expanded: all original child rows and source refs remain recoverable
```

## 11. Non-Goals

- Do not change Continuity v2 storage, item kinds, context segmentation, or projector
  ownership.
- Do not persist presentation batches as conversation items.
- Do not let activity batching assign or infer `contextSegmentId`.
- Do not summarize activity with an LLM.
- Do not merge edits, approvals, deploys, credential changes, external sends, or failures
  into generic counts that hide their consequences.
- Do not replace the final Ling summary, artifact strip, or diagnostics view.

## 12. Decision Verdict

The activity summary and exploration batch are downstream, deterministic projections. They
consume the merged Continuity v2 channel/item contract and never become timeline or
completion authority. There are no unresolved product or architecture decisions for this
design slice; implementation and packaged recovery evidence remain pending.
