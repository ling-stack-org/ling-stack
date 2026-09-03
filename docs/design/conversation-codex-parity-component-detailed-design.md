# Conversation Codex-Parity Component Detailed Design

Status: normative component implementation contract v3.9.1-final; D0–E5 source implementation
and automated gates are green, but the implementation is not yet accepted because E6 packaged
macOS normal/private/channel/topic/branch/child and recovery evidence remains open.
Date: 2026-09-01
Design revision: Codex parity handoff 2026-09-01（component tree、row contract、child span 和 EnvironmentPopover 已锁定）
Base: `origin/main` @ `ebfadd1b`
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

Channel/topic/branch 的 feed 只挂载一个 `renderVirtualRow -> ConversationTimeline` root。
旧的 `renderMessageFeedItem` 不属于 `ChannelMessageRenderers` 对外 contract；shared virtual
feed 也不再提供 `renderItem` fallback。virtualizer 只能调用 `renderVirtualRow`，normal、
private、channel、topic、branch 和 child 都必须把完整 snapshot 交给同一个 Timeline root。
fixture 若需要逐行断言，应直接调用纯 projector/registry，不得通过第二个 legacy JSX 入口
绕过 Timeline。

当一个 surface 的 Timeline root 不与 `items[index]` 一一对应（例如 channel 把
`older-loader` 和历史消息折叠进同一个 root）时，virtual feed 必须显式提供稳定的
`virtualRowIdentity={ id, kind }`。这个 identity 只用于焦点、滚动锚点和 semantic selector，
不能把 loader、batch 数量或任意首条消息冒充 Timeline root；内容变化时 root key 和
lineage 仍保持不变。

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
slot lets a surface inject a second approval, retry, completion or summary owner. It is forbidden
in production and in parity fixtures; typed shell actions remain owned by Composer/approval
controls and may only focus the owning Timeline item.

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
  /** Real LingThread.id; for a child this is the parent's thread. */
  readonly threadId: string;
  readonly scope: ConversationTimelineScope;
  readonly policy: ConversationSurfacePolicy;
  readonly chrome: ConversationSurfaceChrome;
  readonly snapshot: TimelineSnapshot;
  readonly callbacks: ConversationTimelineCallbacks;
};

type ConversationChildScope = {
  readonly kind: "child";
  readonly threadId: string; // parent LingThread.id; never a synthetic child thread
  readonly participantId: string;
  readonly parentItemId: string;
  readonly depth: 1;
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
  /** Real LingThread.id; child uses the parent's id and a participant span. */
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly depth: 0 | 1;
  readonly snapshot: TimelineSnapshot;
  readonly policy: ConversationInteractionPolicy;
  readonly chrome: ConversationSurfaceChrome;
  readonly callbacks: ConversationTimelineCallbacks;
};

/** Child Agent scope is a span in the parent Thread, not a new visible Thread. */
type ConversationChildSurface = {
  readonly kind: "child";
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly anchorItemId: string;
  readonly participantId: string;
  readonly depth: 1;
};

function mountConversationTimeline(
  surface: ResolvedConversationSurface,
): React.ReactElement;
```

`mountConversationTimeline` 内部只做 `snapshot → display projection → registry render`。
caller 不能传入第二个 message/action/report 数组，也不能传入自己的排序器、状态映射、
batch 函数、Markdown parser、scroll container 或 completion callback。Topic/Branch 的
adapter 必须提供真实的 topic/branch child `LingThread.id` 和 anchor；depth-1 Agent child
复用 parent `LingThread.id`，只携带 participant span。任一 scope 解析失败就返回
`diagnostic(scope_mismatch)`，禁止回退到 parent feed 或 synthetic id。

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
旧的 `renderFactActions` 注入 slot 已从当前实现删除；approval、stop、retry 只通过
typed row action 和唯一的 Composer/approval gate 出现一次，不能再由 surface 注入任意
`ReactNode`。

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
6. 当前实现已移除 `renderFactActions` 注入能力；component/semantic tests 只负责证明
   该入口和 `ConversationWorkCell` activity caller 不会重新出现，剩余 production caller
   仍按 E4 surface cutover 的完成条件收口。

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

## 27. v3.9.1-final 组件开工清单

这一节将组件合同转换成可逐项验收的实现任务。任务之间共享同一个 snapshot 和
fixture；不要从 normal、private 或 channel 任意一个 JSX 文件反向设计协议。

### 27.1 必须存在的模块边界

| 模块 | 输入 | 输出 | 失败时 |
| --- | --- | --- | --- |
| `canonical-transcript-snapshot` | API/SQLite/SSE、scope、cursor | `TimelineSourceSnapshot` + coverage | partial，不伪造 complete |
| `execution-actions` / `EvidenceFold` | `tool_start/update/end` | action map、revision、terminal fence | audit diagnostic，原 row 不回退 |
| `conversation-ui-core` projector | source snapshot + fold | atomic `TimelineSnapshot` | `diagnostic(blocked)` |
| `typed-transcript-batching` | atomic items | display rows + split reasons | 原子 item 不丢失 |
| `shared/conversation/timeline` | immutable `TimelineSnapshot` | Document/Fact/Result/Nested DOM | unknown kind 显式 blocked |
| surface adapter | route state + real `LingThread.id` | `ResolvedConversationSurface` | `scope_mismatch`，不使用 synthetic id |
| Host viewer adapter | trusted source ref + lineage | issue/redeem/open | scope/epoch/TTL/realpath 任一失败即 blocked |

### 27.2 唯一 render 入口和回调

```ts
function mountConversationTimeline(
  surface: ResolvedConversationSurface,
): React.ReactElement;

type ConversationTimelineCallbacks = {
  onFocusItem(itemId: string): void;
  onOpenSourceRef(
    ref: ConversationTrustedSourceRef,
    lineage: ConversationTimelineItemLineage,
  ): Promise<void>;
};
```

`renderFactActions?: ReactNode` 不是目标 API，当前实现也不保留这个运行时兼容入口。
审批、stop、retry 由 typed row action 和唯一的 Composer/approval gate 各自拥有；如果
某个 surface 缺少能力，返回缺失 callback 的 policy 状态或 `diagnostic(blocked)`，不能
恢复任意 ReactNode 注入。

### 27.3 子 Agent 的递归边界

```text
SubAgentActivity(depth=1)
  -> participant label + lifecycle
  -> child Timeline(depth=1)
       -> agentMessage/reasoning/plan
       -> command/exploration/file/tool/approval
       -> terminalReport（若 child execute turn 有结果）
```

child 可以写正常 `agentMessage`，但 child 的 `ready/done` 只作为叙述。父级 fan-in 只读
required participant 的 atomic evidence；缺 evidence 显示 `Waiting`，明确不可恢复时显示
structured `Blocked`。depth=2 只显示一个 `nested_depth_exceeded` diagnostic。

### 27.4 组件验收顺序

1. closed union + exhaustive registry + unknown-kind blocked；
2. 同一 `actionId` 的 start/update/end、SSE replay、restart replay 原地收敛；
3. `terminalReport`/reply outcome slot 单一且不被 Composer/Popover 重复；
4. batch 可逆、split reason 可读、展开恢复 exact child ids；
5. normal/private/channel/topic/branch/child fingerprint 一致且 `scrollOwnerCount=1`；
6. Host capability issue/redeem、approval、retry、fan-in 在真实 packaged macOS 中验收。

任何一项失败都停在当前阶段，不能通过隐藏 DOM、保留旧 WorkCell 或新增 surface-specific
renderer 越过闸门。

## 28. Surface-level single Timeline cutover

前面的“一次 mount”指一个会话 surface 只建立一次 transcript composition，不是每条
message、workflow、run 或 protocol activity 分别调用一次 `mountConversationTimeline()`。
后者只能统一局部 row 的外观，仍然留下多个排序 owner、多个 fingerprint 和跨 row
重复结果的可能性。

### 28.1 2026-09-01 live code audit

当前实现 worktree 已有 shared registry 和局部 Timeline，但 E4 仍未完成：

| 当前 caller | 当前行为 | 目标行为 |
| --- | --- | --- |
| `NormalConversationFeed.tsx` | 已切换为 feed-level snapshot/mount；message row 只提供 chrome | 继续保持整个 real `LingThread` 一个 surface snapshot 和一个 Timeline owner |
| `TeammatePrivateChatFeed.tsx` | 已切换为 feed-level snapshot/mount；不再回退 `private:<teammateId>` | 继续只接受真实 `LingThread.id`；缺 scope 显示一个 `scope_mismatch` diagnostic |
| `ChannelMessageRenderers.tsx` | 旧 per-item protocol/activity/workflow/run fact renderer 已切断/删除；message chrome adapter 仍只负责作者、附件和 typed callbacks | channel root/branch 先合并成一个 canonical snapshot，再由一个 Timeline owner 渲染 |
| `ThreadReplyPanel.tsx` | topic root/replies 通过真实 `resolvedThreadId` 构造一个 `topic_reply` snapshot；消息 chrome 只包作者、编辑、memory 和 retry | 不得恢复逐条 `MessageRow` 列表或用 parent item id 充当 transcript thread |
| `MessageRow`/attachments/evidence/action bar | surface 各自组合 message chrome、附件、引用和操作 | message renderer 读取 typed presentation；交互通过 typed callback，不注入任意 React node |

因此以下断言是 E4 的机械闸门：

```text
mount calls per surface viewport = 1
timeline DOM owners per real LingThread = 1
synthetic transcript thread ids = 0
route-local item ordering/merge functions = 0
arbitrary renderer ReactNode action slots = 0
```

depth-1 child 在该唯一 Timeline 内部递归使用同一个 registry，不计作第二个 surface
owner；它不得拥有独立 feed、virtualizer、history loader 或 scroll container。

### 28.1.1 E4a/E4b 实现切片记录

normal 和 private 的第一批切换已经按上述目标收口：surface 先构造完整 snapshot，再由
`renderMessageChrome` 包装作者、时间、编辑、附件、反馈和重试等 chrome；message row 本身
不再创建第二个 Timeline。private virtualizer 的计数也降为一个 root row，只负责测量和
滚动锚点，不能改变 message/fact 的排序。private scope 只接受 API 返回的真实
`LingThread.id`，缺失时由 `buildSurfaceTimelineSnapshot()` 产生一个
`scope_mismatch` diagnostic。

private 的 legacy adapter 若需要把一条消息及其 facts 合并为 surface snapshot，必须先在
消息内部使用从零开始的 local `threadSequence`，再由 owning surface 用稳定的
`baseSequence + localSequence` rebasing 一次。不能把 `baseSequence` 同时传进消息 helper；
否则 message 会被加两次偏移，facts 会落在所属 message 之前。该规则只约束 display adapter，
canonical durable sequence 仍由 `ConversationItemStore` 提供。

E4 的 source cutover 与自动化 contract 已完成：channel root/branch/topic 的消息、事实、
protocol、workflow 和 run projection 均进入同一 Timeline，生产代码没有
`ConversationWorkCell` 或独立 `TerminalReportBlock` renderer caller。它仍不是 E6 完成证明；
后续必须按 28.5 的 source audit 和 packaged macOS 证据闸门重放真实交互、重连与重启。

### 28.2 Target composition API

目标入口同时组合 feed viewport、Timeline、typed interaction 和 shell chrome。调用者不再
逐条 message/activity mount：

```ts
type ResolvedConversationSurface = {
  readonly id: string;
  readonly kind: "normal" | "private" | "channel_root" | "topic" | "branch";
  readonly workspaceId: string;
  readonly threadId: string; // verified LingThread.id
  readonly parentThreadId: string | null;
  readonly anchorItemId: string | null;
  readonly source: TimelineSourceSnapshot;
  readonly policy: ConversationInteractionPolicy;
  readonly chrome: ConversationSurfaceChrome;
  readonly interaction: ConversationTimelineInteraction;
};

type ConversationTimelineInteraction = {
  readonly message: {
    readonly editingItemId: string | null;
    readonly feedbackByItemId: ReadonlyMap<string, "up" | "down">;
    readonly onCopy: (itemId: string) => void;
    readonly onEdit?: (itemId: string) => void;
    readonly onFeedback?: (itemId: string, value: "up" | "down") => void;
    readonly onReplyTopic?: (itemId: string) => void;
    readonly onCreateTask?: (itemId: string) => void;
  };
  readonly source: {
    readonly onOpen: (
      ref: ConversationTrustedSourceRef,
      lineage: ConversationTimelineItemLineage,
    ) => Promise<void>;
    readonly onCopyPath: (ref: ConversationSourceRef) => void;
  };
  readonly protocol?: {
    readonly onInvoke: (
      itemId: string,
      action: ConversationProtocolAction,
    ) => Promise<void>;
  };
};

function mountConversationSurface(
  surface: ResolvedConversationSurface,
): React.ReactElement;
```

`mountConversationSurface()` 内部才允许调用一次 `mountConversationTimeline()`。typed
interaction 只携带状态和 callback，不携带 `ReactNode`、第二份 item 数组或 completion
结果。callback 缺失表示该 surface/policy 不允许对应操作；renderer 不猜默认权限。

### 28.3 Message presentation contract

为了删除外层 `MessageRow` caller，message item 必须带 renderer 所需的稳定 presentation
metadata。它们由 canonical item/actor/resource refs 派生，不是第二份历史：

```ts
type ConversationTimelineMessageItem = ConversationTimelineItemBase & {
  readonly kind: "userMessage" | "agentMessage";
  readonly markdown: string;
  readonly presentationRole: "prompt" | "commentary" | "reply_result";
  readonly actor: {
    readonly kind: "local_user" | "ling_agent" | "teammate" | "system";
    readonly id: string | null;
    readonly label: string;
  };
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly resources: readonly ConversationMessageResource[];
};

type ConversationMessageResource =
  | { readonly kind: "attachment"; readonly ref: ConversationSourceRef }
  | { readonly kind: "path"; readonly ref: ConversationSourceRef }
  | { readonly kind: "web"; readonly ref: ConversationSourceRef }
  | { readonly kind: "memory"; readonly ref: ConversationSourceRef };
```

规则：

- author label/avatar、时间、edited 状态由 shared message renderer 处理；normal/private/
  channel 不能再套自己的消息几何；
- attachment、web evidence 和 memory citation 是 message resource/disclosure，不在
  Timeline 外创建第二张证据卡；
- Host 生成的 image/media 仍投影为 `imageView`；accepted plan 仍投影为 `plan`；运行错误
  投影为 `diagnostic`，不塞进 message footer；
- `presentationRole="reply_result"` 才是 reply turn 的最终文本；execute turn 的
  `execution_summary` 不进入可见 result slot；
- copy/edit/feedback/reply/create-task 是 interaction affordance，不落 SQLite、不改变
  fingerprint 的 canonical item identity。

### 28.4 Typed actions instead of renderer injection

`renderFactActions` 删除后，approval/protocol 仍需要可执行入口，但不能退回 route-local
按钮 JSX。目标是 item 给出 Host 验证过的 action enum，renderer 通过 typed callback
执行：

```ts
type ConversationProtocolAction =
  | "open_source"
  | "open_task"
  | "open_run"
  | "open_approval"
  | "start_workflow"
  | "advance_workflow"
  | "cancel_workflow"
  | "retry_step"
  | "supersede_decision"
  | "reject_decision";

type ConversationTimelineProtocolEventItem = {
  // existing lineage and protocol payload
  readonly availableActions: readonly ConversationProtocolAction[];
};
```

按钮或 menu 仍显示在 owning row 的 disclosure/control slot 内，但 registry 只消费 enum 和
callback。它不能接受任意 React node，也不能让 surface 为同一 protocol fact 再渲染一张
外部 card。active approval 只在 approval row 中显示 `Waiting for approval`，点击打开唯一
decision dialog；Composer 不再复制 approval 内容或 summary。

### 28.5 Virtualization and scroll ownership

单一 Timeline 不要求一次创建全部 DOM。长历史由 `ConversationFeedViewport` 按
`TimelineDisplayItem.id` virtualize，但排序、batch 和 owner 在 virtualizer 之前已完成：

```text
atomic TimelineSnapshot
  -> projectDisplayBatches()
  -> TimelineDisplaySnapshot
  -> ConversationFeedViewport window/anchor
  -> registry renderer for visible display items
```

virtualizer 只能选择可见窗口和测量高度，不能：

- 改变 item 顺序、合并相邻 row 或选择 TerminalReport generation；
- 以 message/workflow/run 类型选择不同 renderer pipeline；
- 让 batch/detail/child 建立第二个纵向 overflow；
- 用数组 index 代替稳定 item/batch identity。

历史向上加载后必须以 durable sequence/cursor 合并 source snapshot，再重新产生同一个
display projection；visible anchor 按稳定 item id 恢复。

### 28.6 E4 deletion and verification order

E4 采用 strangler cutover，但开发阶段不保留 runtime compatibility path：

1. 先扩充 shared message presentation 和 typed interaction contract；
2. 建立 fixture-only `mountConversationSurface()`，证明 message/resource/protocol action
   不依赖 route JSX；
3. normal 改为 surface-level snapshot/mount，删除 per-message Timeline caller；
4. private 使用同一 adapter，并删除 `private:<id>` synthetic fallback；
5. channel root/topic/branch 把 turn/message/protocol/workflow/run 全部接入一个 snapshot，
   删除 route-local Timeline caller；
6. child span 复用同一 registry，保留 depth=1；
7. parity、single-owner、scroll、interaction 回归通过后，删除旧 MessageRow/WorkCell/
   activity production callers。

每一步都必须比较下面的同 fixture fingerprint：

```text
item ids + kind + order + status + rendererKey + disclosureCount
+ action owner count + result owner count + Timeline owner count + scroll owner count
```

截图相似但 `Timeline owner count > 1`、存在 synthetic thread 或 protocol action 仍由
route-local card 拥有，均判 E4 未完成。

## 29. Codex parity 开工级组件锁（2026-09-01）

本节把组件树、输入、状态和验收压缩成实现时不可分叉的一套接口。目标不是重新实现一套
Codex TUI，而是让 Ling 的 durable facts 经过一套 renderer 后呈现出相同的信息层级：正文
像正文，动作像动作，结果只出现一次，多 Agent 只是浅层嵌套。

### 29.1 唯一生产组件树

```text
ConversationSurfaceShell
├─ ConversationSurfaceHeader           surface chrome only
├─ ConversationFeedViewport             only vertical scroll owner
│  └─ ConversationTimeline              one immutable display snapshot
│     ├─ ConversationDocumentRenderer   message/reasoning/plan/compaction
│     ├─ ConversationFactRenderer       command/read/file/tool/approval/protocol
│     ├─ ConversationResultRenderer     terminalReport only
│     ├─ ConversationBatchRenderer      reversible display wrapper
│     └─ ConversationSubAgentRenderer   participant rail + same registry(depth=1)
├─ EnvironmentPopover                   active ambient state only
└─ ConversationComposer                 draft/stop/retry/approval controls
```

生产代码不得再导出 `MessageBubble`、`ConversationWorkCell`、route-local `CommandRow`、
`renderFactActions` 或 `ConversationVirtualFeed.renderItem` 作为 transcript 入口。Fixture
直接调用 pure projector、fingerprint 或 registry；不为测试保留第二套 JSX。

### 29.2 Display snapshot 与 row contract

```ts
type ConversationDisplaySnapshot = {
  readonly scope: ConversationScopeIdentity;
  readonly atomicItems: readonly ConversationTimelineItem[];
  readonly displayRows: readonly ConversationTimelineDisplayRow[];
  readonly activeRun: ActiveRunSnapshot | null;
  readonly canonicalRevision: number;
  readonly sseCursor: string | null;
};

type ConversationTimelineDisplayRow =
  | { readonly kind: "atomic"; readonly item: ConversationTimelineItem }
  | { readonly kind: "batch"; readonly item: ActivityBatchItem };
```

`atomicItems` 是 completion、fan-in、retry 和 TerminalReport 的输入；`displayRows` 只供
Timeline 绘制。React 不允许从 `displayRows.length`、batch child 数或文案推断完成。每个
atomic action 只能映射到一个稳定 row id；`tool_update` 只更新该 row 的 revision/status/
detail，不能插入 start/end 两行。

### 29.3 Scope contract：surface Thread 与 child span 分开

```ts
type ConversationScopeIdentity =
  | {
      readonly kind: "thread";
      readonly surfaceKind: "normal" | "private" | "channel_root" | "topic" | "branch";
      readonly threadId: string; // real LingThread.id
      readonly parentThreadId: string | null;
      readonly anchorItemId: string | null;
    }
  | {
      readonly kind: "child";
      readonly threadId: string; // parent's real LingThread.id
      readonly parentThreadId: string;
      readonly parentItemId: string;
      readonly participantId: string;
      readonly depth: 1;
    };
```

Topic/Branch 是真实 child Thread；Agent child 不是。两者都不能使用 `channel:<id>`、
`private:<id>`、`child:<id>` 或 message id 作为 transcript id。depth-1 child 只过滤父级
snapshot 中属于该 participant span 的 atomic items，再递归调用同一个 registry。

### 29.4 Document、fact、result 的稳定 renderer 接口

```ts
type ConversationTimelineRendererContext = {
  readonly depth: 0 | 1;
  readonly policy: ConversationInteractionPolicy;
  readonly disclosure: ConversationDisclosureStore;
  readonly callbacks: ConversationTimelineCallbacks;
};

type ConversationTimelineRenderer<K extends ConversationTimelineItemKind> = (
  item: Extract<ConversationTimelineItem, { readonly kind: K }>,
  context: ConversationTimelineRendererContext,
) => React.ReactNode;
```

renderer 只消费 typed item：

- document renderer 解析 allowlisted Markdown AST，保留 paragraph/list/quote/fence/path；
- fact renderer 固定输出 `icon + verb title + status text + one disclosure`；
- result renderer 只接 `terminalReport`，不能再输出命令列表或第二份 final summary；
- nested renderer 只增加 participant label、1px rail、8px inset；child item 仍回到同一
  registry；
- unknown kind、missing lineage、scope mismatch 一律转换为 typed diagnostic，再进入
  registry，不使用 generic message fallback。

### 29.5 EnvironmentPopover 的精确状态

```ts
type EnvironmentPopoverState =
  | { readonly phase: "hidden" }
  | {
      readonly phase: "active" | "reconnecting";
      readonly runId: string;
      readonly actionId: string;
      readonly revision: number;
      readonly primary: string;   // Working · Engineer editing parser.ts
      readonly secondary: string; // ling-stack · feature/transcript
    };
```

`EnvironmentPopover` 最多两行，绑定一个 active action。revision 到来时原地更新；terminal
fence 或 run settled 后立即进入 `hidden`；reconnect 只改变 `phase`，恢复后回到同一
action。点击只 focus owning row。它不接收 message、output、TerminalReport、memory 或
approval payload，也不创建历史项。

### 29.6 组件级停止条件

实现遇到下列任一情况必须停下并回到设计，不得以 CSS 或兼容层绕过：

- 一个 viewport 需要两个 Timeline/scroll owner 才能工作；
- child Agent 需要新建可见 Thread 或专用 renderer；
- surface 必须传任意 `ReactNode` 才能执行 approval/protocol action；
- model path 在没有 Host capability 时需要可点击；
- execute turn 需要 `terminalReport` 之外的第二个结果 owner；
- fixture 只能通过 legacy renderer fallback 才能编译或验收。

### 29.7 交互与状态转移（实现级）

交互状态也只有一个 owner：Timeline 保存 disclosure/focus，Composer 保存输入和控制，
Host 保存动作状态。点击事实行的 disclosure 只能改变本地展开状态，不能重新查询、重新
排序或创建新的 item：

```text
pointer/keyboard
      │
      ├─ disclosure -> DisclosureStore(itemId, expanded)
      ├─ source ref -> Host callback(ref, full lineage)
      ├─ retry/stop/approval -> Composer typed action
      └─ row focus -> ConversationTimeline focus(itemId)

Host event/revision
      -> source snapshot watermark
      -> EvidenceFold
      -> canonical projector
      -> same stable row id, new revision/status/detail
```

所有 callback 必须是闭集命令，而不是任意 `ReactNode` 或字符串事件：

```ts
type ConversationTimelineAction =
  | { readonly kind: "open_source_ref"; readonly ref: ConversationTrustedSourceRef }
  | { readonly kind: "copy_text"; readonly itemId: string }
  | { readonly kind: "focus_item"; readonly itemId: string };

type ConversationHostAction =
  | { readonly kind: "stop_run"; readonly runId: string }
  | { readonly kind: "retry_turn"; readonly turnId: string }
  | { readonly kind: "approval_decision"; readonly approvalId: string; readonly decision: "allow" | "deny" };
```

`open_source_ref` 在 daemon 侧再次校验 workspace、scope、realpath、capability TTL 和
daemon epoch；失败时返回 `diagnostic(source_ref_blocked)`，UI 不把路径渲染成可执行链接。
   `approval_decision`、`retry_turn` 和 `stop_run` 只由 Composer/approval gate 发起，结果
   仍通过 Timeline 的 owning fact/result row 回显，不能在输入框下方追加状态卡。

### 29.8 组件验收快照

每个 renderer 的 component test 必须输出同一份最小快照，供 normal/private/channel/child
做 fingerprint 比对：

```json
{
  "timelineOwnerCount": 1,
  "scrollOwnerCount": 1,
  "rows": [
    {"id": "item-msg-1", "kind": "agentMessage", "rendererKey": "message.document"},
    {"id": "action-1", "kind": "commandExecution", "status": "succeeded", "rendererKey": "fact.command", "disclosureCount": 1},
    {"id": "result-1", "kind": "terminalReport", "rendererKey": "result.terminal", "disclosureCount": 1}
  ]
}
```

验收必须同时断言：同一 action 的 start/update/end 只有一个 `id`；普通 reply 没有
`result.terminal`；execute turn 没有第二个 summary；child 只增加 participant rail；未知
kind、缺 lineage、depth=2 都生成 typed diagnostic。截图只作为几何辅助，不能替代该快照或
`lineage.json`。
