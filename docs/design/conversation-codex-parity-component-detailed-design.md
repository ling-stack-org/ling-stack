# Conversation Codex-Parity Component Detailed Design

Status: normative component implementation contract v3.9.1-final; implementation is in progress,
not yet accepted. E2 split-reason/expansion contract is now explicit; E3/E4 cutover remains open.
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Scope: normal conversation, teammate private chat, channel root/topic/branch, depth-1
sub-Agent activity, packaged macOS
Owner: Conversation UI, conversation-ui-core, daemon runtime, Desktop maintainers

Related authority:

- [Conversation Typed Transcript - Detailed Design](conversation-typed-transcript-detailed-design.md)
  owns durable facts, item semantics, lineage, completion and recovery;
- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
  owns geometry, density, disclosure and accessibility;
- [Conversation Surface Contract](conversation-surface-contract.md)
  owns scope, shell chrome, policy and Host callbacks;
- [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
  owns phase order, tests and packaged macOS evidence.

This document is the component-level bridge between those contracts and code. It does not
create a fifth fact authority. If it conflicts with typed transcript semantics, the typed
transcript design wins. If it conflicts with visual geometry, the visual specification wins.

## 1. Outcome

Ling adopts the useful part of Codex's conversation design:

```text
typed item -> one purpose-built renderer -> one owning row -> optional inline detail
```

Ling does not copy Codex storage, provider sessions, TUI controls or colors. Ling keeps its
own SQLite durable facts, `LingThread`/`LingTurn`, approvals, multi-Agent orchestration and
recovery rules.

The user-visible result is deliberately simple:

```text
User / Agent narration     document flow, no bubble card
Run / file / tool          icon + verb + text status + one disclosure
Turn outcome               one result row for execute, one final message for reply
Child Agent                the same renderers inside one shallow participant rail
Environment                two ambient lines for the active action only
```

The design is successful only when a user can answer, without opening a second panel:

1. what Ling said;
2. what the Host actually did;
3. whether anything is running, waiting, failed or blocked;
4. where the fact came from and how to inspect it.

## 2. Non-goals

- Do not add `session`, `batch`, `activity_summary` or UI-state SQLite tables.
- Do not turn model narration into command, file, tool or completion evidence.
- Do not preserve the unpublished legacy WorkCell/activity renderer behind a feature flag.
- Do not introduce a surface-specific Markdown parser, action row, status vocabulary or
  scroll container.
- Do not infer file-opening authority from a path string.
- Do not use batch counts, plan progress or a child Agent's `ready/done` text for fan-in.
- Do not rewrite the provider runtime or map provider sessions one-to-one to `LingThread`.

## 3. One-way data flow

```text
SQLite records / Host events / SSE deltas
                  |
                  v
        TimelineSourceSnapshot
      raw facts + coverage + cursor
                  |
                  v
             EvidenceFold
       actionId + monotonic revision
                  |
                  v
      CanonicalTranscriptProjector
 scope -> order -> owner -> attempt -> result
                  |
                  v
           atomic TimelineSnapshot
                  |
                  v
      display-only batching projection
                  |
                  v
           ConversationTimeline
      one registry, no I/O or inference
                  |
       +----------+-----------+
       |          |           |
    normal     private     channel/topic/branch
                              |
                         depth-1 child
```

The arrows are one-way. React never reads raw RunEvent/SQLite rows. Surface adapters never
sort or join items. The daemon never writes UI disclosure or batch membership.

## 4. Authority and state ownership

| State | Owner | Rebuildable | May prove completion |
| --- | --- | --- | --- |
| conversation item, run event, approval, artifact, TerminalReport | SQLite/Host | no | yes, through the completion gate |
| accepted action revision and terminal fence | EvidenceFold | yes from durable events | yes |
| atomic typed items and lineage | canonical projector | yes | consumers may read atomic facts |
| command/exploration batch | display projection | yes | no |
| disclosure, focus, local expanded state | Timeline view state | yes/resettable | no |
| active ambient hint | shell/EnvironmentPopover | yes | no |
| composer draft and controls | Composer | user state | no |

No state may have two owners. In particular, Composer, EnvironmentPopover, Right Dock and
TerminalReport must not repeat the Timeline's action rows or output.

## 5. Canonical component input

`ConversationTimeline` receives one immutable, already-scoped snapshot. It does not accept
separate message, operation, approval or report arrays.

```ts
type ConversationTimelineProps = {
  readonly snapshot: TimelineSnapshot;
  readonly depth: 0 | 1;
  readonly callbacks: ConversationTimelineCallbacks;
  readonly presentation: {
    readonly density: "default" | "dense";
    readonly renderParticipantAvatar?: (
      participantId: string,
    ) => React.ReactNode;
  };
};

type ConversationTimelineCallbacks = {
  readonly onFocusItem: (itemId: string) => void;
  readonly onOpenSourceRef: (
    ref: ConversationTrustedSourceRef,
    lineage: ConversationTimelineItemLineage,
  ) => Promise<void>;
};
```

The target contract does not expose an arbitrary `renderFactActions` React slot. Such a
slot lets a surface inject a second approval, retry, completion or summary owner. During
migration it may exist behind an adapter, but the E4 cutover removes it. Typed shell actions
remain owned by Composer/approval controls and may only focus the owning Timeline item.

### 5.1 Snapshot boundary and implementation types

The implementation has exactly two snapshot layers. Keeping them separate prevents a React
component from treating a partially loaded stream as canonical history.

```ts
type TimelineSourceSnapshot = {
  readonly threadId: string;
  readonly scope: ConversationTimelineScope;
  readonly cursor: string | null;
  readonly sourceRevision: number;
  readonly coverage: {
    readonly items: "complete" | "partial";
    readonly actions: "complete" | "partial";
    readonly reports: "complete" | "partial";
    readonly participants: "complete" | "partial";
  };
  readonly items: readonly CanonicalConversationItem[];
  readonly runEvents: readonly RunEventEnvelope[];
  readonly terminalReports: readonly CanonicalTerminalReportProjection[];
  readonly activeRun: ActiveRunSnapshot | null;
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
};

type TimelineSnapshot = {
  readonly scope: ConversationTimelineScope;
  readonly items: readonly ConversationTimelineItem[];
  readonly activeRun: ActiveRunSnapshot | null;
  readonly canonicalRevision: number;
  readonly sseCursor: string | null;
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
};
```

The only legal conversion is:

```text
TimelineSourceSnapshot
  -> EvidenceFold
  -> CanonicalTranscriptProjector
  -> TimelineSnapshot.atomic items
  -> display-only batch projection
  -> TimelineSnapshot.displayRows
```

`ConversationTimeline` accepts the immutable `TimelineSnapshot` only. It never receives raw source arrays,
per-surface message lists, provider JSON or a pre-grouped batch. A snapshot is rejected when
`threadId`, scope, cursor coverage or lineage does not agree; the adapter emits a blocked
diagnostic instead of guessing a default scope.

### 5.2 Renderer registry contract

The registry is a closed, exhaustive map. Adding a projection kind requires adding its item
type, renderer key, semantic fixture and renderer before the code can typecheck.

```ts
type ConversationTimelineRendererContext = {
  readonly depth: 0 | 1;
  readonly density: "default" | "dense";
  readonly callbacks: ConversationTimelineCallbacks;
  readonly focusItem: (itemId: string) => void;
};

type ConversationTimelineRenderer<K extends ConversationTimelineItemKind> = (
  item: Extract<ConversationTimelineItem, { readonly kind: K }>,
  context: ConversationTimelineRendererContext,
) => React.ReactNode;

const rendererRegistry: {
  readonly [K in ConversationTimelineItemKind]:
    ConversationTimelineRenderer<K>;
};
```

The renderer may derive labels, bounded details and accessibility attributes from its typed
payload. It may not sort items, fetch data, call a Host mutation, infer a missing action or
decide whether a turn/fan-in is complete. A Host mutation is initiated only by a callback that
contains the owning item's lineage.

## 6. Closed item and renderer contract

The projection kind is a closed union:

```text
document
  userMessage
  agentMessage
  reasoning
  plan
  contextCompaction

fact
  commandExecution
  exploration
  fileChange
  mcpToolCall
  dynamicToolCall
  collabAgentToolCall
  approval
  imageView
  protocolEvent
  diagnostic

result
  terminalReport

container/display
  subAgentActivity
  commandBatch
  explorationBatch
```

Each kind maps to exactly one stable renderer key:

| Projection kind | Renderer key | Visible owner |
| --- | --- | --- |
| `userMessage`, `agentMessage` | `message.document` | document item |
| `reasoning` | `document.reasoning` | structured document item |
| `plan` | `document.plan` | structured document item |
| `commandExecution` | `fact.command` | command action |
| `exploration` | `fact.exploration` | read/search action |
| `fileChange` | `fact.file` | file action |
| `mcpToolCall` | `fact.mcp` | MCP action |
| `dynamicToolCall` | `fact.tool` | dynamic Host action |
| `collabAgentToolCall` | `fact.collab` | delegation action |
| `approval` | `fact.approval` | approval status |
| `imageView` | `fact.image` | image/artifact action |
| `contextCompaction` | `document.compaction` | context lifecycle item |
| `protocolEvent` | `fact.protocol` | protocol fact |
| `diagnostic` | `fact.diagnostic` | blocked/unsupported fact |
| `terminalReport` | `result.terminal` | execute turn outcome |
| `commandBatch` | `batch.command` | display batch header |
| `explorationBatch` | `batch.exploration` | display batch header |
| `subAgentActivity` | `agent.nested` | participant span |

The registry is exhaustive at compile time. An unknown wire/projection kind becomes a
blocked diagnostic in the adapter. It never falls back to `agentMessage` or a generic
WorkCell card.

## 7. Component tree

```text
ConversationSurfaceShell
|- Header
|- ConversationFeedViewport              only vertical scroll owner
|  `- ConversationTimeline
|     |- ConversationDocumentItem
|     |  `- ConversationMarkdownBody
|     |- TimelineFactRow
|     |  `- TimelineInlineDetail
|     |- TerminalReportRow
|     |- TimelineBatchRow
|     |  `- exact atomic child renderers
|     `- SubAgentActivity
|        `- ConversationTimeline(depth=1, same registry)
|- EnvironmentPopover                    active ambient state only
|- Composer                              input and shell controls only
`- RightDock / HostViewer                selected source preview only
```

`ConversationFeedViewport` owns history paging, scroll anchoring and sticky-to-bottom
behavior. `ConversationTimeline`, nested child Timelines, batches and inline details use
normal document flow and never create `overflow-y`.

## 8. Document renderer

The durable message item may continue to carry Markdown text. The renderer parses it into
ephemeral content parts; those parts are not new conversation items and are not persisted.

```ts
type ConversationRenderPart =
  | { readonly kind: "paragraph"; readonly node: MarkdownAstNode }
  | { readonly kind: "list"; readonly node: MarkdownAstNode }
  | { readonly kind: "quote"; readonly node: MarkdownAstNode }
  | { readonly kind: "inlineCode"; readonly text: string }
  | { readonly kind: "codeBlock"; readonly language?: string; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | { readonly kind: "pathCandidate"; readonly path: string; readonly basename: string }
  | { readonly kind: "trustedFileRef"; readonly ref: ConversationTrustedSourceRef }
  | { readonly kind: "image"; readonly ref: ConversationTrustedSourceRef }
  | { readonly kind: "fallbackText"; readonly text: string };
```

Rules:

- CommonMark/GFM structure decides paragraph, list, quote, link and fenced code. Do not
  flatten message text into one line.
- Fenced code preserves newlines, indentation and optional language. It is not a command
  fact unless a separate Host action exists.
- An unfinished streaming fence uses safe monospace text in the same message item; after
  completion the item revises in place.
- A path candidate displays file icon + basename, with full path on hover/focus and copy.
  It remains non-clickable.
- Only a trusted Host ref exposes open-file/open-diff/open-artifact behavior.
- Parse failure keeps safe plain text and emits `diagnostic(markdown_parse_failed)` without
  losing the message.

## 9. Fact row anatomy

Every action renderer composes the same `TimelineFactRow`:

```text
[kind icon]  Verb target - Text status                         [Disclosure]
             optional one-line meta / bounded preview
```

The row contract is:

```ts
type TimelineFactRowModel = {
  readonly itemId: string;
  readonly rendererKey: string;
  readonly icon: TimelineIcon;
  readonly title: string;          // Host-derived verb + safe target
  readonly status: TimelineStatus;
  readonly statusLabel: string;
  readonly meta?: string;
  readonly detail?: TimelineDetailModel;
  readonly defaultExpanded: boolean;
  readonly lineage: ConversationTimelineItemLineage;
};
```

Title templates are deterministic:

| Kind | Template | Example |
| --- | --- | --- |
| command | `Run {commandSummary}` | `Run pnpm test` |
| read | `Read {target}` | `Read parser.ts` |
| search | `Search {query}` | `Search "terminal fence"` |
| create/edit/delete | `{Created|Edited|Deleted} {basename}` | `Edited parser.ts` |
| MCP/tool | `{toolVerb} {target}` | `Search GitHub issues` |
| delegation | `Delegated to {participant}` | `Delegated to QA` |

Missing safe payload produces `Activity unavailable - Blocked`. The renderer never shows
only `Running`, `Done`, raw provider JSON or the model's description of the action.

## 10. Status and action lifecycle

The item status vocabulary is closed:

```text
pending -> Queued
running -> Working
waiting -> Waiting
waiting + approval kind -> Waiting for approval
succeeded -> Succeeded
failed -> Failed
cancelled -> Cancelled
blocked -> Blocked
```

One `actionId` owns one row for its whole lifetime:

```text
tool_start    action:r3  Working
tool_update   action:r4  Working + updated bounded tail
tool_end      action:r5  Succeeded / Failed / Cancelled
late update   audit diagnostic only; terminal row does not reopen
```

The DOM id, action id and disclosure state remain stable across revision updates, SSE
reconnect and daemon restart. A terminal fence accepts one terminal result and rejects
stale/equal-conflict/late events from the visible projection.

### 10.1 Evidence fold algorithm

`EvidenceFold` is the only place that turns lifecycle events into a live action revision. It is
deterministic for a given event sequence and can be rebuilt after reconnect or daemon restart.

```text
for event in events ordered by durable sequence:
  if event.actionId is absent or lineage is incomplete:
    append audit diagnostic; do not create a successful row
  else if event.revision <= current.revision:
    append duplicate/stale audit; keep current row
  else if current.terminalFence exists:
    append late-event audit; keep terminal row closed
  else:
    accept event into action state
    current.revision = event.revision
    if event.kind == tool_end:
      current.terminalFence = event.sequence
```

The fold preserves the first accepted terminal result. An equal-revision event with a different
payload is a conflict diagnostic, not a last-write-wins update. An accepted `tool_update`
invalidates by `{threadId, runId, actionId, revision}` so a UI refresh cannot fall back to a
coarse run key and show stale output.

## 11. Command output and file diff

- Active command detail is open by default and updates in the same row.
- Completed success is collapsed by default. Failure/blocked remains open one level.
- The bounded command tail is at most 40 lines, 8 KiB and 64 chunks before the renderer's
  smaller first-screen clamp. Full logs open through an artifact ref.
- A detail preview is at most 240 px in normal document flow. `Show more` expands the same
  row or opens the trusted artifact; it does not create a nested vertical terminal.
- File rows show basename, icon, change kind, additions/deletions and one disclosure.
- Structured diff opens in the Host review viewer. Parse failure shows safe text plus a
  diagnostic; it does not silently become a successful file row.

## 12. Reversible batching

Batching runs after atomic projection and before rendering. It is a pure O(n) display
projection.

An eligible batch contains at least three adjacent, succeeded, low-risk commands or at
least three adjacent succeeded read-family actions. Every child must share:

```text
participantId + runId + attemptId + turnRunRole
+ workUnitId + workflowStepId + source lineage scope
```

The batch is flushed at narration, kind change, participant/run/attempt/step change,
approval, retry/resume/repair, active/failure/cancelled/blocked state, missing lineage or a
consequential action. Commit, push, deploy, credential change and external send always
remain standalone.

Batch identity is stable and display-only:

```text
{kind}:{participantId}:{runId}:{attemptId}:{firstActionId}
```

Expanding restores the exact child order and child source refs. Batch count, status and
visibility never participate in TerminalReport, retry or fan-in.

The implementation returns a split reason for every boundary. This is test/debug data only;
it is never persisted or shown as a second activity row.

```ts
type BatchSplitReason =
  | "narration"
  | "kind"
  | "participant"
  | "run"
  | "attempt"
  | "workflow_step"
  | "context_scope"
  | "approval"
  | "retry"
  | "non_adjacent"
  | "non_terminal"
  | "consequential"
  | "missing_lineage";
```

The implementation exposes the diagnostic result without making it part of the rendered
timeline contract:

```ts
type BatchSplitBoundary = {
  readonly beforeItemId: string;
  readonly afterItemId: string | null;
  readonly reason: BatchSplitReason;
};

type DisplayBatchProjection = {
  readonly items: readonly ConversationTimelineItem[];
  readonly boundaries: readonly BatchSplitBoundary[];
};

function projectDisplayBatches(
  atomic: readonly ConversationTimelineItem[],
  context: DisplayProjectionContext | undefined,
): DisplayBatchProjection;

function expandDisplayBatch(
  item: ConversationTimelineItem,
): readonly ConversationTimelineItem[];
```

`batchCanonicalTranscriptItems()` remains the compatibility-free convenience wrapper and
returns only `projectDisplayBatches(...).items`. If `context` is absent, the projector emits
no batch and records a `context_scope` boundary between adjacent eligible candidates. The
expansion function returns the original child item objects in canonical order; it never reads
batch counts or rehydrates a second fact model. Tests must assert both the visible wrapper list
and exact child ids/source refs after expansion.

The pure projection walks atomic items once. It starts a candidate at the first eligible item,
flushes on the first split reason, and emits a batch header only when the candidate has at least
three children. Expanding a header maps directly to the stored atomic item ids, so the operation
is reversible even if a later source update changes the visible status of a neighboring action.

## 13. Reply and execute outcome

Each turn has exactly one outcome slot:

```text
reply turn
  `- agentMessage(presentationRole=reply_result)

execute turn
  |- narration and atomic fact rows
  `- Finalizing result
       -> terminalReport(highest committed generation)
       -> diagnostic(blocked) when publication cannot settle
```

The provider's `execution_summary` is audit/synthesis input, not a second visible result.
TerminalReport is anchored by a dedicated `conversation_item(kind="terminal_report")` and
contains `reportId + generation + resultItemId`. It is rendered once inside the Timeline,
never again below Composer or in EnvironmentPopover/Right Dock.

## 14. Nested multi-Agent composition

`subAgentActivity` is a participant span, not a special chat product:

```text
Engineer -- I will inspect parser.ts.              agentMessage
            Read parser.ts - Succeeded             fact.exploration
            Run parser tests - Failed - exit 1     fact.command
```

Implementation rules:

- The parent renderer adds only participant label, lifecycle, 1 px rail and 8 px inset.
- Child narration is `agentMessage`. Child plan, command, file and tool use the exact same
  registry and row components as depth 0.
- The child Timeline receives a scoped child snapshot, not copied parent arrays.
- Depth 1 is the maximum visible nesting. Depth 2 projects
  `diagnostic(nested_depth_exceeded)` instead of another indent or scroll area.
- `started/running/waiting/blocked/errored` groups remain open. Completed safe history may
  collapse after reload, while a user's touched disclosure state remains stable.
- Parent fan-in waits for atomic evidence from every required participant or a structured
  blocked result. Child narration, plan completion and `ready/done` text do not settle it.

## 15. Surface adapters

Normal, private, channel root, topic, branch and child adapters have one job:

```text
route/domain selection
  -> resolve real LingThread id and scope
  -> load one canonical snapshot
  -> resolve shell policy and Host callbacks
  -> mount ConversationTimeline once
```

Allowed differences:

- title and participant roster;
- topic/branch navigation;
- participant rail;
- permission and model hints;
- availability of typed Host callbacks.

Forbidden differences:

- message geometry or left/right alignment;
- Markdown parsing;
- action renderer or status labels;
- batching thresholds;
- outcome selection;
- history scroll ownership.

The adapter boundary is intentionally small:

```ts
type ResolvedConversationSurface = {
  readonly threadId: string;
  readonly scope: ConversationTimelineScope;
  readonly policy: ConversationSurfacePolicy;
  readonly chrome: ConversationSurfaceChrome;
  readonly snapshot: TimelineSnapshot;
  readonly callbacks: ConversationTimelineCallbacks;
};

function mountConversationTimeline(
  surface: ResolvedConversationSurface,
): React.ReactElement;
```

Normal, private and channel/topic/branch callers must all invoke this function once. The caller
may choose a title, roster, permission policy and Host callback availability; it may not provide
another item array, row renderer, batch function, status mapper or scroll container. This is the
mechanical check that turns “统一组件” from a visual intention into a code-level boundary.

The parity fixture compares `kind/order/status/rendererKey/disclosureCount/geometry`. A
surface that passes only a screenshot but produces a different fingerprint fails cutover.

## 16. Shell ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| `ConversationFeedViewport` | history paging, anchor, sticky-bottom, vertical scroll | item semantics or completion |
| `ConversationTimeline` | row composition, disclosure, focus, semantic selectors | I/O, sorting, batching, completion |
| `Composer` | draft, send, stop, retry, allow/deny controls | summary, output, result row |
| `EnvironmentPopover` | current active action + workspace/branch, at most two lines | history, TerminalReport, approval |
| Right Dock/Host viewer | selected file/diff/artifact preview | second action/result list |

EnvironmentPopover closes at the active run's terminal fence. During reconnect it may show
`Reconnecting` as shell state, then returns to the same owning action. It never appends a
"recovered" message.

## 17. Trusted local resources

Path presentation and permission are separate:

```text
model path string
  -> display basename + tooltip + copy
  -> no navigation

Host source ref + lineage
  -> issue short-lived capability
  -> user click
  -> redeem with workspace/thread/run/action/epoch/TTL/realpath checks
  -> open file/diff/artifact viewer
```

Daemon restart invalidates old capabilities but not durable Timeline facts. The next click
may issue a new capability after the same checks. A denied/expired ref remains copyable and
shows a blocked diagnostic.

## 18. Accessibility and responsive behavior

- Document and fact content stay left aligned on all surfaces and widths.
- Fact row minimum hit target is 28 px; pointer and keyboard focus use the same affordance.
- Each disclosure is a native button with an accessible name and `aria-expanded`.
- Status is always icon + text + `aria-label`; color is secondary.
- A single polite live region announces semantic status transitions. Raw stdout chunks are
  not announced individually.
- `prefers-reduced-motion` disables insertion/spinner/disclosure transitions without
  changing status or order.
- Narrow layouts keep one column. Code/diff may scroll horizontally inside their own block;
  no child component creates vertical overflow.

## 19. Semantic selectors

Every owning row exposes stable, testable semantics:

```text
data-conversation-timeline-id
data-conversation-timeline-kind
data-conversation-timeline-renderer-key
data-conversation-timeline-status
data-conversation-timeline-revision
data-conversation-thread-id
data-conversation-run-id
data-conversation-attempt-id
data-conversation-participant-id
data-conversation-workflow-step-id
data-conversation-source-refs
```

The outer Timeline also exposes canonical revision, SSE cursor, depth, renderer fingerprint,
disclosure count and scroll-owner count. Tests use these fields instead of CSS class names or
translated copy.

## 20. Failure behavior

| Failure | Visible result | Forbidden fallback |
| --- | --- | --- |
| missing operation lineage | `Activity unavailable - Blocked` | guessed success/action owner |
| unknown item kind | `Unsupported activity - Blocked` | generic agent message |
| Markdown parse failure | safe plain text + diagnostic | flatten/drop content |
| capability denied/expired | copy-only ref + blocked detail | `file://` navigation |
| late event after terminal | unchanged terminal row + audit | reopen/duplicate row |
| SSE reconnect | same row/revision replay + shell hint | append reconnect message |
| daemon restart | rebuild same fingerprint from SQLite | use in-memory transcript as history |
| depth greater than one | blocked diagnostic | deeper nested UI |
| required participant lacks evidence | `Waiting` or structured `Blocked` | fan-in success from ready text |
| TerminalReport join fails | turn outcome diagnostic | duplicate assistant summary |

## 21. Migration map

Keep and harden:

- `packages/conversation-ui-core/src/transcript-item.ts` closed union;
- `canonical-transcript-projector.ts` and deterministic batching;
- `apps/web/src/shared/conversation/timeline/ConversationTimeline.tsx`;
- the exhaustive `renderer-registry.tsx` and dedicated renderers;
- Host source-ref/capability validation;
- durable RunEvent/ExecutionAction/TerminalReport stores.

Migrate:

- normal, teammate-private and channel/topic/branch adapters to one snapshot/mount;
- old WorkCell rows through a strict adapter until every durable source produces typed items;
- route-local Markdown/path handling to the shared document renderer;
- workflow plan skeletons to `plan`/`protocolEvent`, with execution state only from facts.

Remove from production after the E4 parity gate:

- `ConversationWorkCell` as an activity renderer;
- route-local operation transcript blocks;
- right-side user/assistant square bubble geometry;
- standalone completed activity-summary rows;
- TerminalReport-as-assistant-message publication/rendering;
- Composer/EnvironmentPopover/Right Dock duplicate summary or output;
- arbitrary `renderFactActions` injection and legacy surface status copies.

The project is in development, so no runtime compatibility renderer or dual write remains.
Old SQLite rows use the strict adapter; insufficient lineage produces a diagnostic.

## 22. Implementation order

```text
D0 contract/fixture lock
  -> E1 evidence fold and live invalidation
  -> E2 atomic projector and reversible batching
  -> E3 shared renderer and Host viewers
  -> E4 all-surface cutover and legacy caller removal
  -> E5 approval/retry/reconnect/restart/fan-in recovery
  -> E6 packaged macOS real UI acceptance
```

Each phase exits only with code, semantic tests and traceable evidence. A later phase cannot
hide an earlier failure with CSS or screenshots.

## 23. Test and evidence matrix

| Layer | Required proof |
| --- | --- |
| contract | closed union, wire/projection/renderer mapping, stable ids |
| evidence | start/update/end, revision, terminal fence, dedupe, bounded/redacted tail |
| projector | scope, order, owner, attempt, result generation, blocked fallback |
| renderer | Markdown/code/path, fact row, batch, result, nested Agent, a11y |
| parity | same fixture on normal/private/channel/topic/branch/child |
| recovery | approval allow/deny/expired, retry, SSE reconnect, daemon restart, fan-in |
| packaged macOS | real app screenshots + semantic state + lineage + redacted logs |

Required real-client cases remain `N-01`, `N-02`, `P-01`, `C-01`, `C-02`, `A-01`,
`R-01`, `R-02`, `R-03`, `F-01` and `E-01`. Every case stores:

```text
case.json             simulation=false, build hash, thread/turn/run/attempt
screen-01.png         active or initial state
screen-02.png         expanded, terminal or recovered state
semantic-state.json   kind/status/revision/renderer/scroll owners
lineage.json          item/action/run/attempt/participant/step/source refs
logs.redacted.txt     event and error evidence without secrets
```

## 24. Definition of done

- One `ConversationTimeline` is the only production transcript renderer.
- Normal, private, channel/topic/branch and depth-1 child share one registry and fingerprint.
- Narrative is Markdown document flow; code and line breaks remain intact.
- Every factual row has Host evidence and complete lineage or a blocked diagnostic.
- Action revisions update one row; reconnect/restart do not duplicate it.
- Command/exploration batches are reversible and never affect completion.
- Reply and execute turns each have exactly one outcome owner.
- Child Agents reuse the parent renderer and cannot settle fan-in from narration.
- Local paths are simple to read and only trusted refs are navigable.
- Composer, EnvironmentPopover and Right Dock do not duplicate history or results.
- The feed has exactly one vertical scroll owner.
- E1-E5 tests pass and E6 packaged macOS evidence is complete.

Unresolved product or architecture decisions: none. Implementation findings that require a
different kind, owner, completion rule, Thread mapping or Host permission boundary must update
the typed transcript design and this document before code diverges.

## 25. v3.9.1 implementation lock

This addendum is the handoff from design to implementation. It does not change the v3.9 data
model or introduce compatibility behavior.

### 25.1 First implementation slice

Implement in this order and stop after each gate:

1. `ConversationTimelineItemKind` and renderer registry compile exhaustively;
2. `EvidenceFold` accepts/rejects lifecycle events with stable action identity;
3. canonical projector produces atomic items and terminal-result join;
4. display batching consumes atomic items and returns split reasons;
5. one shared Timeline mounts in a fixture-only surface;
6. only after fixture parity passes, cut over normal/private/channel/child surfaces.

No CSS change is an acceptable substitute for a failed earlier gate. A phase is complete only
when its semantic tests and the relevant `data-conversation-timeline-*` selectors pass.

### 25.2 Required fixture shape

The fixture must include one reply turn, one execute turn, a live command update, a file diff,
an approval, a nested child narration/action, a failed attempt followed by retry, a partial
fan-in and a depth-2 blocked child. The same fixture is projected for normal, private, channel,
topic, branch and depth-1 child scopes. The expected fingerprint differs only in the explicitly
allowed shell/participant fields.

### 25.3 Explicit stop conditions

Stop and update the design before coding when any implementation proposal would:

- add a second SQLite session/batch/summary table;
- let model text create a fact or completion result;
- render the same `actionId` outside its owning Timeline row;
- let batch count, plan progress or `ready/done` text settle fan-in;
- add a surface-specific renderer, Markdown parser or vertical scroll owner;
- navigate a path without a Host capability and lineage check.

## 26. v3.9.1-final 开工细设计

本节把上面的组件合同压缩成实现者可以逐个勾选的接口和停止条件。它不增加新的事实
来源，也不允许在 route 内复制 Timeline。

### 26.1 唯一 mount 入口

所有 surface 先把自己的路由状态解析成 `ResolvedConversationSurface`，再调用一次：

```ts
type ResolvedConversationSurface = {
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch" | "child";
  readonly threadId: string;              // real LingThread.id
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly depth: 0 | 1;
  readonly snapshot: TimelineSnapshot;
  readonly policy: ConversationInteractionPolicy;
  readonly chrome: ConversationSurfaceChrome;
  readonly callbacks: ConversationTimelineCallbacks;
};

function mountConversationTimeline(
  surface: ResolvedConversationSurface,
): React.ReactElement;
```

`mountConversationTimeline` 内部只做 `snapshot → display projection → registry render`。
caller 不能传入第二个 message/action/report 数组，也不能传入自己的排序器、状态映射、
batch 函数、Markdown parser、scroll container 或 completion callback。Topic/Branch 的
adapter 必须提供真实 child `LingThread.id` 和 anchor；解析失败就返回
`diagnostic(scope_mismatch)`，禁止回退到 parent feed。

### 26.2 Registry 和 row renderer

registry 必须 exhaustive；React 层只接受 projection kind，不接受 wire kind：

```ts
type RendererContext = {
  readonly depth: 0 | 1;
  readonly density: "default" | "dense";
  readonly focusItem: (itemId: string) => void;
  readonly onOpenSourceRef: (
    ref: ConversationTrustedSourceRef,
    lineage: ConversationTimelineItemLineage,
  ) => Promise<void>;
};

const rendererRegistry: {
  readonly [K in ConversationTimelineItemKind]: (
    item: Extract<ConversationTimelineItem, { readonly kind: K }>,
    context: RendererContext,
  ) => React.ReactNode;
};
```

每个 renderer 只构造自己的 `DocumentBlock`、`FactRow` 或 `ResultRow`；不能调用 daemon、
读 SQLite、判断 fan-in 或创建 side effect。`FactRow` 的标题和状态只能由 typed Host
payload 生成；缺少 action/lineage/source ref 时返回 `Activity unavailable · Blocked`。
当前迁移期保留的 `renderFactActions` 必须限定为 focus/open callback；E4 后删除该 slot，
审批、stop、retry 只在 Composer/approval gate 出现一次。

### 26.3 一次 render cycle 的确定性算法

```text
source snapshot (immutable)
  -> fold event map by actionId
  -> project canonical items in threadSequence/partIndex order
  -> attach highest committed terminalReport by turnId
  -> project reversible batches (optional)
  -> map each visible item to exactly one renderer key
  -> emit semantic DOM selectors
```

不允许在 renderer 内做 N+1 读取或按文案相似度去重。`fingerprint` 只包含
`kind/order/status/rendererKey/disclosureCount/lineage ids/scrollOwnerCount`；不包含
颜色、翻译、标题或 shell。这样 normal/private/channel/topic/branch/child 可以在同一
fixture 上直接比较语义，而不被表面文案干扰。

### 26.4 交互状态机

```text
Queued ──start──> Working ──update──> Working
   │                         │
   ├─approval──> Waiting for approval ──allow──> Working
   │                                      ├─deny/expired──> Blocked
   ├─end(0)──> Succeeded
   ├─end(non-zero)──> Failed ──retry──> new attempt / old audit
   └─cancel──> Cancelled
```

一个 row 的 DOM id 与 `actionId` 不随 revision 改变。terminal fence 后只接受同一终态的
幂等重放；迟到 event 只产生 audit diagnostic。SSE reconnect/daemon restart 重新 fold
durable events，恢复同一 id/revision/fence，不追加“已恢复”消息。

### 26.5 子 Agent 组合

```text
SubAgentActivity(depth=1)
  ├─ participant label + lifecycle + 1px rail
  └─ ConversationTimeline(depth=1, child snapshot)
       ├─ agentMessage / reasoning / plan
       ├─ command/file/tool fact rows
       └─ terminalReport（若 child execute turn 有自己的结果）
```

父级只负责 participant span 和 fan-in；child 可以有正常 `agentMessage` 叙述，但不能用
`ready/done` 文本代替事实。没有 required evidence 时父级显示 `Waiting`；depth=2 显示
结构化 `diagnostic(nested_depth_exceeded)`，不得继续嵌套或建立第二个 scroll owner。

### 26.6 Host viewer callback

```text
display-only path -> basename/icon + tooltip/copy
trusted source ref -> issue capability -> click -> redeem
  -> workspace/thread/run/action/participant/step/epoch/TTL/realpath 校验
  -> file/diff/artifact viewer
```

callback 必须携带 renderer 当前 item 的完整 lineage，不能只传字符串路径。daemon 重启
会使旧 capability 失效，但不会删除 Timeline 事实；下一次点击重新签发。失败仍保留
copy affordance，并在 owning row 内显示 blocked detail。

### 26.7 E3/E4 的机械退出条件

只有同时满足下面条件，才能删除旧 caller：

1. registry 对 closed union exhaustive，未知 kind 和缺 lineage 都是 blocked diagnostic；
2. 三种 surface 与 child fixture 的 fingerprint 相同，且 Feed `scrollOwnerCount=1`；
3. `tool_update` 原地更新，batch 可展开恢复 exact child ids/source refs；
4. Composer、Popover、Right Dock 没有 action/result/summary duplicate owner；
5. Host viewer 的 capability issue/redeem 在真实 callback 上通过 scope/epoch/TTL/realpath；
6. component/semantic tests 通过后，才移除 `ConversationWorkCell` activity caller 和
   `renderFactActions` 的注入能力。

任何一个条件未满足都停在 E3/E4 修复，不通过 CSS 隐藏或保留第二套兼容 renderer。

### 26.8 v3.9.1-final 文件级开工契约

这一节把上面的组件树压成实现时可逐项勾选的边界。它不允许 surface 自己拼接
消息、action、approval 或 report，也不允许 child Agent 重新发明一套聊天组件。

```text
surface adapter
  -> ResolvedConversationSurface { threadId, scope, snapshot, policy, callbacks }
  -> mountConversationTimeline(surface)
       -> ConversationFeedViewport      (唯一 overflow-y)
            -> ConversationTimeline     (只接 TimelineSnapshot)
                 -> registry[item.kind](item, context)
```

| 文件/模块 | 允许做的事 | 明确禁止 |
| --- | --- | --- |
| `canonical-transcript-snapshot.ts` | 从 API/SQLite/SSE 组装有 coverage 的 source snapshot | 把 partial source 当完整历史返回 |
| `conversation-ui-core` projector/batch | 校验 scope、owner、attempt、revision，生成原子 item 和可逆 display rows | I/O、权限副作用、completion/fan-in 判断 |
| `shared/conversation/timeline/*` | exhaustive registry、row/detail、disclosure、semantic selectors | 读取 raw source、按文案去重、创建第二个 scroll owner |
| normal/private/channel/topic/branch adapter | 解析真实 `LingThread.id`、shell/policy、Host callback | 自建 `MessageBubble`、`WorkCell`、activity renderer 或 summary |
| `SubAgentActivity` | participant label、lifecycle、depth=1 child snapshot、fan-in focus | child-specific renderer、depth=2 Timeline、ready 文案冒充完成 |
| Composer/approval/EnvironmentPopover/Right Dock | 输入/控制、当前 active ambient、选中 source preview | 复制 action/output/TerminalReport 历史 |

一次 render cycle 只能有一个 owning row：

```text
same actionId + new revision -> update existing DOM row
same actionId + SSE replay   -> idempotent no-op
terminal fence + late event  -> audit diagnostic, never reopen
missing lineage              -> diagnostic(blocked), never guessed success
```

组件测试必须从同一 fixture 渲染 normal、private、channel 和 child，并比较
`kind/order/status/rendererKey/disclosureCount/scrollOwnerCount`。差异只允许来自 shell
标题、roster、participant rail、policy hint 和 callback 可用性；若某个 surface 需要额外
renderer、额外状态映射或额外滚动容器，说明 adapter 越界，应退回 E4 修复。
