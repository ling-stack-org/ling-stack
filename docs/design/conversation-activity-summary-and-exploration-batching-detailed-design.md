# Conversation Activity Summary And Exploration Batching Detailed Design

Status: subordinate projection rule; canonical contract in
[Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Date: 2026-09-01
Last verified: 2026-09-01
Scope: batch-header navigation copy, read-operation batching, shared conversation
projections, Continuity v2 integration boundaries, and validation

Related docs:

- [Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)

v3.8 note: this document defines only the pure, display-only batch projection. The
canonical owner is `ConversationTimeline`; `ConversationWorkCell` is a pre-v3.7
migration input and must not remain as a production renderer or summary owner.

实现映射固定为：durable action → canonical atomic item →
`commandBatch`/`explorationBatch` display wrapper。任何 batch header、membership 或
disclosure 都不能写回 `conversation_items`，也不能被 TerminalReport、fan-in 或
`contextSegmentId` 读取。

batching 只接收 `TimelineSnapshot` 的 atomic items；`TimelineSourceSnapshot` 仍由
evidence fold/projector 负责，不能被 UI 直接读取或按可见行数重新分组。

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
  -> reversible activity-item projection
       ├── exploration batch
       ├── command batch
       └── standalone consequential or exceptional action
```

Batch headers are display projections only. They never replace, coalesce, rewrite, or
delete the underlying `ExecutionAction`, run event, artifact, or source reference. A
cross-kind completed activity summary is not rendered as a second row in v3.8.

## 2. Continuity v2 Boundary

This feature is downstream of the v3 typed transcript design. It must not create a second conversation
timeline or become another context authority.

| Layer | Authority | This feature's relationship |
| --- | --- | --- |
| `LingThread` / `LingTurn` / `ConversationItem` | canonical conversation timeline and lineage | read-only source context |
| `ConversationContextProjector` | permission-filtered context views and source refs | not changed by activity grouping |
| Run / approval / artifact stores | execution and business facts | remain authoritative |
| `ExecutionAction` and run events | tool action identity, status, and evidence | input to the row projection |
| `ConversationTimeline` | user-visible operation rendering | consumes the derived projection |
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

### 3.1 No standalone completed activity summary

v3.8 does not render a cross-kind row such as:

```text
已编辑 2 个文件 · 已读取 8 项 · 已运行 3 个命令
```

That row duplicates the owning file, exploration, and command facts and caused the
completed red-frame/Composer-summary regressions. The compact copy now exists only inside
the owning batch header:

```text
Read 8 items
Ran 3 commands
```

Rules:

- Derive a header only from the exact atomic children inside that batch.
- Use action kind and status, never translated titles, as classification authority.
- Say `items` when target refs do not prove that every child is a file.
- Active, failed, blocked, approval-gated, and consequential actions remain standalone.
- Do not emit `Processed`, `Completed`, or an aggregate activity-summary row after the
  final `agentMessage`, `fileChange`, or `terminalReport` result row.
- Batch counts are navigation copy, not completion evidence. Terminal reporting,
  workflow completion, and multi-agent fan-in inspect atomic actions and source lineage.

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

`commandBatch` remains responsible only for successful, low-risk Bash commands. It is
not renamed to or broadened into `explorationBatch`. The command contract remains in
[Conversation Command Execution Batching Detailed Design](conversation-command-execution-batching-detailed-design.md).

## 4. Shared View Model

This subordinate design uses the canonical union directly. It does not define a second
legacy `ConversationWorkCellItem` union:

```ts
type ActivityBatchLineageEnvelope = {
  /** Stable display identity; never a durable ExecutionAction id. */
  readonly actionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
};

type ActivityBatchItem = ConversationTimelineItemBase & ActivityBatchLineageEnvelope & {
  readonly kind: "commandBatch" | "explorationBatch";
  readonly actionIds: readonly string[];
  readonly childActionIds: readonly string[];
  readonly childItemIds: readonly string[];
  readonly batch: CommandBatchPayload | ExplorationBatchPayload;
};

type ExplorationBatchPayload = {
  readonly operationCount: number;
  readonly targetCount?: number;
  readonly defaultExpanded: boolean;
  readonly children: readonly ExplorationItem[];
};
```

Every child remains an atomic canonical item with its original `actionId`, `runId`,
`attemptId`, `participantId`, `workflowStepId`, status, revision, and source refs. The batch
copies the exact lineage scope and ordered child ids needed for reversible rendering; it is
not a runtime record and cannot make approval, execution, retry, or completion decisions.
Missing attempt or source lineage keeps the atomic row visible and makes it ineligible for
batching; the projector never fills a guessed default.

## 5. Deterministic Projection

The shared projection receives canonical atomic items in stable transcript order and emits
display items. It is called once before `ConversationTimeline` and is reused by every
surface and depth-1 participant span.

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
5. Emit `explorationBatch` only when the segment contains at least three rows.
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
explorationBatch[A,B,C]
operation[edit D]
explorationBatch[E,F,G]
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

The batch display identity is derived from participant scope, run scope, attempt scope, and the
first child action. It is a projection key, not a new Host action:

```text
explorationBatch:{participantId}:{runId}:{attemptId}:{firstActionId}
```

`actionIds`/`childActionIds` remain the durable identities used for audit and completion. A
batch cannot be formed unless all children share participant, run, attempt and workflow-step
lineage; otherwise the projector flushes the batch and keeps atomic rows visible.

The revision key includes ordered child ids, statuses, and `updatedAt` values. A later
read appended to the same segment updates the batch without discarding user disclosure
state.

These boundaries also constrain `commandBatch`. No command or exploration batch may
cross an agent, run, attempt, retry role, workflow step, approval, failed action, or
consequential action. The batch retains the union of visible child `sourceRefs`, while
each child retains its original refs for exact UI-to-SQL traceability.

## 6. Rendering And Accessibility

Render both batch kinds through the shared Timeline registry. The batch component may
delegate child detail to the same `TimelineFactRow`, but it must not import or wrap the
legacy `ConversationWorkCell`.

- Use a native button with `aria-expanded` and a localized accessible label.
- Keep the batch borderless and visually subordinate to normal conversation text.
- Render child rows with the same fact-row renderer; do not create nested chat bubbles.
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

- The `terminalReport` Timeline item is projected from `TerminalReport` after it reads
  atomic `ExecutionAction`, RunEvent, approval, artifact, and verification evidence with
  source refs.
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
2. **R6 - pure projection:** add the canonical `explorationBatch` variant and deterministic
   batching function. Keep it outside React and outside persistence; do not add a standalone
   activity-summary item.
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
stream:  Read 8 items + Ran 3 commands + standalone Edited 2 files rows
expanded: all original child rows and source refs remain recoverable
absent:  no second aggregate activity-summary row after the stream
```

## 11. Non-Goals

- Do not change Continuity v2 storage, item kinds, context segmentation, or projector
  ownership.
- Do not persist presentation batches as conversation items.
- Do not let activity batching assign or infer `contextSegmentId`.
- Do not summarize activity with an LLM.
- Do not merge edits, approvals, deploys, credential changes, external sends, or failures
  into generic counts that hide their consequences.
- Do not add a second aggregate summary after the final message, artifact, or diagnostic.

## 12. Decision Verdict

The activity summary and exploration batch are downstream, deterministic projections. They
consume the merged Continuity v2 channel/item contract and never become timeline or
completion authority. There are no unresolved product or architecture decisions for this
design slice; implementation and packaged recovery evidence remain pending.
