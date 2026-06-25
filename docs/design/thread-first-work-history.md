# Thread-First Work History

Status: design baseline for Web information architecture and follow-up data-model
planning
Date: 2026-06-08
Scope: Runs surface, thread detail, run attempts, evidence, Review Queue links, future
turn records, and thread metadata hardening

Implementation detail plan:

- [Thread-First Work History Implementation Plan](thread-first-work-history-implementation-plan.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)

## Summary

Ling Stack should treat work history as durable project-work continuity, not as a log
page.

The target information architecture borrows Codex's session model:

```text
Thread
  -> Turn
    -> Item
```

Ling Stack translates that into:

```text
Work thread
  -> User intent turn
    -> Run attempt
      -> Evidence item
```

This keeps the user-facing model stable:

- a thread is the long-lived unit the user returns to, resumes, forks, searches, and
  audits;
- a turn is one user intent or follow-up inside that thread;
- a run is one execution attempt for a turn, not the primary object;
- events, logs, shell snapshots, approvals, diffs, and artifacts are evidence items.

The first implementation should be UI and composition only. It should not require a new
durable turns table. The second implementation should introduce durable turns and richer
thread metadata once the UI proves the query patterns.

## Why This Exists

The current product has multiple nearby concepts:

- Runs
- Thread detail
- Channel activity
- Work Board
- Review Queue
- Approvals
- Artifacts
- Raw run events and JSONL logs

If "Run history" remains the top-level mental model, users will read the page as an
engineering log browser. That is the wrong product meaning. Users need to know:

- what work happened,
- what the user asked for,
- what AI attempted,
- what changed,
- what requires review,
- how to continue safely.

The page should answer those questions before exposing raw runtime evidence.

## Codex Reference Boundary

References checked on 2026-06-08:

- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI Codex MCP interface notes](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)
- [OpenAI Codex rollout recorder](https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs)
- [OpenAI Codex install/logging docs](https://github.com/openai/codex/blob/main/docs/install.md)

Useful Codex ideas:

- `Thread` is the durable session/work container.
- `Turn` is the unit of user input and agent response.
- `Item` stores messages, tool work, file updates, and other transcript/evidence cells.
- `thread/list`, `thread/read`, `thread/resume`, and `thread/fork` make history a
  recovery surface, not a raw log browser.
- Approvals are presented inline with active work when the user needs to decide.
- JSONL rollouts and plaintext logs are persistence and diagnostics, not the default
  user-facing hierarchy.

Ling-specific differences:

- Ling has channels, tasks, work items, external work, workflows, media jobs, AI
  teammates, provider presets, explicit approvals, artifacts, and scoped memory.
- Ling should not wholesale replace daemon `/runs` with Codex app-server JSON-RPC.
- Ling should keep Pi runner integration as the default execution backend unless a
  separate runner decision changes it.
- Ling should keep Review Queue as a cross-surface action queue, not as the thread
  history itself.

## Product Model

### Terms

| Term | User-facing meaning | Current / future storage |
| --- | --- | --- |
| Channel | Collaboration space that owns messages, topic replies, and work threads | Existing channel records |
| Topic reply / side thread | A lightweight Slack-style branch from a channel message | Existing `ChannelMessage.threadId` |
| Channel branch | A named work lane under one channel | Existing `ChannelBranch.rootThreadId` plus `LingThread` |
| Work thread | A durable unit of project work, conversation, or workflow step | Existing `LingThread` |
| Turn | One user intent, follow-up, or continuation inside a thread | V1 derived; V2 durable |
| Run attempt | One execution attempt by the runner | Existing `RunSession` |
| Evidence item | Proof or detail for a turn or run | Existing events, artifacts, approvals, actions, shell snapshots |
| Review item | Something requiring human action | Existing Review Queue sources |
| Raw log | Diagnostic stream for operators | Existing event JSONL and runtime logs |

Channel is not a single conversation. It is the collaboration container:

```text
Channel
  -> channel messages
  -> topic replies / side threads
  -> work threads / LingThreads
```

Topic replies are message-level side conversations inside the current channel. Work
threads are executable or auditable work conversations inside the current channel. A
future `fork` creates a new work thread branch under the same channel by default; it does
not create or copy a channel. The selected channel should expose a work-thread tree under
the channel row so users can switch between source and forked child threads. A source
transcript branch notice may confirm creation, while Work History shows parent/child
lineage. The boundary between channel root, channel branch, topic reply, teammate private
chat, and future session surfaces is defined in
[Conversation Surface Taxonomy](conversation-surface-taxonomy.md).

### Ownership

```text
LingThread owns continuity.
Turn owns user intent.
RunSession owns execution attempt.
RunEvent / RuntimeEvent owns low-level runtime facts.
RunArtifact owns durable evidence payloads.
ApprovalRequest owns user authority decisions.
Review Queue owns pending human actions across threads.
```

The UI should not ask users to reason from `runId` first. `runId` remains useful for
operators and deep evidence links.

## V1: Thread-First UI Without New Durable Turns

V1 is a product and composition slice. It should reuse current contracts:

- `LingThread`
- `RunSession.threadId`
- `RunSession.parentRunId`
- `RunSession.interventionId`
- `RunSession.continuationReason`
- `RunEventEnvelope`
- `RunArtifact`
- `ApprovalRequest`
- `ExecutionAction`
- `StateTransitionEvent`
- `RunIntervention`

### V1 Goals

- Rename and reposition "Run history" as work history / thread history.
- Make thread the primary list object.
- Treat runs as attempts inside a selected thread.
- Fold event logs, shell snapshots, approvals, diffs, and artifacts under evidence.
- Keep existing `/runs` and `/threads` APIs.
- Avoid a new durable turns table.
- Avoid a standalone route unless AppShell navigation needs it.

### V1 Non-Goals

- No new `turns` table.
- No migration that rewrites old runs.
- No Codex app-server adapter.
- No React Router dependency just for thread detail.
- No change to approval enforcement.
- No hidden mid-run prompt injection.
- No Review Queue rewrite.

### V1 Navigation

Preferred labels:

| Current | V1 label | Reason |
| --- | --- | --- |
| Runs | Work History | User returns to work, not raw execution |
| Run history | Work history | Avoid log-page framing |
| Recent runs | Recent work | Thread-first list |
| Thread detail | Work detail | Product language |
| Run detail | Attempt detail | Run is one attempt |
| Run events | Evidence timeline | Events are proof, not the main story |

Chinese localization can use:

| English | Chinese |
| --- | --- |
| Work History | 工作记录 |
| Work detail | 工作详情 |
| Attempt detail | 执行尝试 |
| Evidence | 证据 |
| Diagnostics | 诊断 |

### V1 Layout

```text
Work History
  Left rail: work threads
    - title
    - objective preview
    - status
    - channel/task/workflow/external-work link
    - attention markers

  Center: selected work detail
    - thread header
    - objective
    - current status
    - primary actions
    - summary
    - turns or derived activity groups
    - attempts
    - artifacts
    - approvals
    - state transitions

  Right drawer: evidence inspector
    - selected run attempt
    - selected approval
    - selected artifact
    - selected command/shell snapshot
    - raw event JSON when needed
```

### V1 Derived Turn Groups

Before durable turns exist, Web can derive turn-like groups from current records:

```text
thread
  -> source request snapshot / task snapshot
  -> runs ordered by createdAt
  -> parent/continuation/intervention links
  -> user guidance/intervention records
  -> assistant output and summary artifacts
```

Suggested derived group kinds:

| Derived group | Source |
| --- | --- |
| Original request | first run `taskSnapshot` / `requestSnapshot.task` |
| Manual resume | run with `continuationReason = "manual_resume"` |
| Queued follow-up | `RunIntervention.mode = "queue_followup"` |
| Redirect | `RunIntervention.mode = "interrupt_redirect"` |
| Workflow step attempt | run with `workflowStepId` |
| External work attempt | thread with `externalWorkId` |

The UI should mark these groups as derived. Backend remains authoritative for execution
state.

### V1 Detail Hierarchy

| Level | Name | Default visibility | Examples |
| --- | --- | --- | --- |
| 0 | Work summary | visible | title, objective, status, last activity |
| 1 | User intent and result | visible | request, final answer, failure summary |
| 2 | Attempts | visible but compact | run attempts, status, provider, runner |
| 3 | Evidence | collapsed or drawer | approvals, artifacts, action previews, shell snapshots |
| 4 | Raw diagnostics | hidden behind explicit action | raw events, JSON payloads, JSONL path |

The user should understand what happened without expanding Level 3. The user should be
able to verify exact evidence by expanding Level 3 and Level 4.

## V2: Durable Turns And Thread Metadata

V2 should start after V1 shows real usage pressure. It adds durable records for the
concepts V1 only derives.

### V2 Goals

- Represent user intent as a stable durable object.
- Associate multiple run attempts with one turn.
- Support thread search, archive, pin, summary, and unread/attention counters without
  scanning all runs and events.
- Let Review Queue refer to thread/turn anchors, not only run or approval ids.
- Support resume and fork from a clear user-intent boundary.

### Durable Turn Model

Proposed contract:

```ts
type LingTurnKind =
  | "initial_request"
  | "manual_followup"
  | "queued_followup"
  | "interrupt_redirect"
  | "workflow_step"
  | "external_work_update"
  | "automation_tick";

type LingTurnStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

interface LingTurn {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly kind: LingTurnKind;
  readonly status: LingTurnStatus;
  readonly title: string;
  readonly userInstruction: string;
  readonly normalizedObjective?: string;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly runIds: readonly string[];
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}
```

V2 should not store raw model text or secrets in turns. Large summaries and evidence
stay in artifacts or events.

### Thread Metadata Hardening

The existing `LingThread` already has the core identity fields. V2 can add or derive a
metadata object for fast, stable list rendering:

```ts
interface LingThreadMetadata {
  readonly summary?: string;
  readonly pinnedAt?: string;
  readonly archivedReason?: string;
  readonly lastTurnId?: string;
  readonly lastActivityAt: string;
  readonly pendingApprovalCount: number;
  readonly blockedCount: number;
  readonly failedAttemptCount: number;
  readonly artifactCount: number;
  readonly unreadAttentionCount?: number;
  readonly latestEvidenceArtifactId?: string;
  readonly latestFailureRunId?: string;
}
```

This metadata can live as:

1. columns on `ling_threads` when fields are query-critical;
2. a `metadata_json` column while shape is still changing;
3. a materialized cache that can be rebuilt from runs/events/artifacts.

Do not make metadata the source of truth for safety decisions. Approvals, runs, and
state transitions remain authoritative.

### V2 API Shape

Additive API proposal:

```text
GET /threads?cwd=...&includeMetadata=true
GET /threads/:threadId?cwd=...
GET /threads/:threadId/turns?cwd=...
POST /threads/:threadId/turns?cwd=...
GET /threads/:threadId/evidence?cwd=...&turnId=...
POST /threads/:threadId/resume-preview?cwd=...&turnId=...
POST /threads/:threadId/resume?cwd=...&turnId=...
POST /threads/:threadId/fork?cwd=...
POST /threads/:threadId/archive?cwd=...
POST /threads/:threadId/pin?cwd=...
```

V2 does not need to remove:

```text
GET /runs
GET /runs/:id
GET /runs/:id/events
GET /runs/:id/artifacts
```

Those remain operator and evidence APIs.

## Review Queue Relationship

Review Queue is not history. It is a human-action queue.

```text
Work History answers:
  What happened? What was attempted? How do I continue?

Review Queue answers:
  What needs my decision now?
```

Review Queue items should link to:

- `threadId` when the action belongs to a work thread,
- `turnId` in V2 when the action belongs to a specific user intent,
- `runId` when the action is attempt-specific,
- `approvalId` when the action is a permission decision,
- artifact/action ids when the decision is about a proposed side effect.

Do not duplicate the full thread detail in Review Queue. It should show enough context to
decide and link back to Work History for the full evidence bundle.

## Work Board Relationship

Work Board is a current-state operational surface. Work History is a durable audit and
recovery surface.

```text
Work Board:
  what is in flight or ready to be acted on inside a channel

Work History:
  what happened across attempts and how to resume/fork/audit it
```

Work Board cards should link to a thread detail rather than a raw run detail when a
thread exists.

## Data Flow

### V1 Data Flow

```text
GET /threads
  -> left rail work threads

select thread
  -> GET /threads/:threadId/evidence
  -> group runs into derived turns
  -> render attempts and evidence

select attempt or evidence item
  -> right drawer detail

resume
  -> POST /threads/:threadId/resume-preview
  -> user reviews context
  -> POST /threads/:threadId/resume
```

### V2 Data Flow

```text
user submits intent
  -> create LingTurn
  -> create RunSession attempt linked to turn
  -> stream attempt evidence
  -> update turn and thread metadata

user follows up
  -> create child LingTurn
  -> attempt can reuse previous thread context
  -> Review Queue links to thread/turn/action as needed
```

## Migration Plan

### Phase 1: Rename And Reframe

- Rename nav and visible headings from run-centric labels to work/thread-centric labels.
- Keep old API and component names where changing them would create noise.
- Preserve deep links to run detail.

### Phase 2: Thread-First Composition

- Make thread rows the default list.
- Move run rows under "Attempts".
- Put event timelines under "Evidence".
- Keep selected-run detail for old records and direct run links.

### Phase 3: Derived Turn Groups

- Add client-side grouping helpers.
- Display original request, follow-ups, redirects, and manual resumes as grouped user
  intent sections.
- Add tests proving multiple runs can render under one derived turn.

### Phase 4: Durable Turns

- Add contracts and store methods.
- Backfill best-effort turns for new runs only; do not rewrite all old history in the
  first durable slice.
- Link new run attempts to `turnId`.
- Add `/threads/:id/turns`.

### Phase 5: Thread Metadata

- Add query-critical metadata.
- Keep metadata rebuildable from source records.
- Use metadata for list performance and attention badges only.

## Acceptance Criteria

V1 is successful when:

- the primary UI reads as work history, not a log page;
- a user can open a thread, understand objective/status/result without reading raw
  events;
- attempts are visible but secondary;
- evidence remains accessible for audit;
- approvals still route through active surfaces and Review Queue;
- no new durable table is required.

V2 is successful when:

- one user intent can own multiple run attempts;
- resume/fork/search/archive can anchor to thread or turn;
- Review Queue can link to a stable thread/turn target;
- thread lists do not need expensive event scans for common counters;
- metadata remains rebuildable and non-authoritative for safety.

## Risks

| Risk | Mitigation |
| --- | --- |
| V1 becomes a cosmetic rename only | Add derived turn groups and attempt/evidence hierarchy |
| Turns duplicate channel messages | Store intent anchors, not every chat message |
| Metadata becomes stale authority | Treat metadata as read model/cache; source of truth stays runs/events/approvals |
| Review Queue and Work History overlap | Keep Review Queue action-focused and link to thread detail |
| Old run-only records disappear | Preserve direct run detail fallback |
| UI hides safety-critical facts | Approval/blocker state must stay visible at Level 1 |

## Open Questions

- Should V2 turns be created for normal channel chat messages, or only for work-triggering
  intents?
- Should direct teammate chats share the same `LingTurn` table or keep private-message
  records separate?
- Should thread metadata be a JSON column first or explicit columns from the start?
- Should fork create a new thread with copied turns, or a parent-linked thread with
  evidence references?
- Should Work History replace the current Runs nav label in one slice or behind a feature
  flag?
