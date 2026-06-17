# Conversation Memory Citations And Sources

Status: implementation design patch
Date: 2026-06-17
Scope: main conversation memory citation footer, active source popover, and source/detail boundaries

## Summary

Ling already has durable scoped memory and context source records. The missing UI layer is
not another memory system. The missing layer is a transcript read model that separates:

```text
Used memory evidence
  -> message-level memory citation footer

Context/source inventory
  -> active source popover and source detail

Execution evidence
  -> OperationCell rows and folded evidence detail
```

This follows the Codex lesson without copying Codex storage. Codex attaches memory
citations to assistant messages. Ling should derive the same user-facing shape from
`UsedMemoryEvent`, `MemoryObject`, and `ConversationTranscript` instead of making users
inspect raw memory audit rows.

## Current Ling Shape

Ling memory is durable and scoped:

```text
MemoryObject
  scopeType: workspace | channel | teammate | task | run
  ownerId
  sourceRefs
  reviewState
  sensitivity
  enabled

recallMemory()
  -> RecalledMemory[]

renderUsedMemoryPrompt()
  -> prompt section

recordUsedMemoryEvent()
  -> responseId/runId + memoryIds + recallQuery + policyVersion
```

Ling context sources are separate:

```text
ChannelContextSource
  kind: turn | recent_message | materialized_input | memory | artifact | workflow | ...
  sourceRefs
  title
  metadata
  sensitivity
  freshness

ChannelContextView / ContextPack
  sections
  sources
  sourceRefs
  dropped
  compactions
```

The current gap is presentation:

- memory use can be audited, but it is not a first-class transcript citation footer;
- source summaries exist, but the active floating popover is not yet a Codex-like source
  overview;
- memory citation, source inventory, operation evidence, result review, and raw/debug
  detail can easily duplicate each other if they are rendered from different UI paths.

## Non-Goals

- Do not replace Ling Memory with Codex file-based memory.
- Do not move memory scope/review policy into the Web UI.
- Do not show every context source in the main feed.
- Do not show a standalone Sources card in the main conversation.
- Do not duplicate OperationCell rows inside the source popover or source drawer.
- Do not treat memory as permission, tool access, file access, or external authority.

## Read Model Additions

### TranscriptMemoryCitation

`TranscriptMemoryCitation` is a message-level or turn-level read model derived from
`UsedMemoryEvent` plus the referenced `MemoryObject` records.

```ts
interface TranscriptMemoryCitation {
  readonly id: string;
  readonly ownerBlockId: string;
  readonly ownerKind: "coordinator_message" | "operation_cell" | "agent_activity_span";
  readonly eventIds: readonly string[];
  readonly entries: readonly TranscriptMemoryCitationEntry[];
  readonly policyVersion: string;
}

interface TranscriptMemoryCitationEntry {
  readonly memoryId: string;
  readonly title: string;
  readonly scopeType: "workspace" | "channel" | "teammate" | "task" | "run";
  readonly ownerId: string;
  readonly sensitivity: "normal" | "private" | "secret-adjacent";
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly recallQuery?: string;
  readonly matchedTerms?: readonly string[];
  readonly excerpt?: string;
}
```

Projection rules:

- If `UsedMemoryEvent.responseId` matches an assistant/coordinator message id, attach the
  citation to that message block.
- If `UsedMemoryEvent.runId` exists but no response message exists, attach it to the
  related `OperationCell` terminal area.
- If multiple used-memory events target the same block, merge by memory id and keep all
  event ids.
- If a memory object is missing, keep a placeholder entry with the memory id and mark the
  detail as unavailable.
- If `sensitivity` is `secret-adjacent`, do not show body/excerpt in the default UI.
  Normal recall should already avoid secret-adjacent memory unless explicitly allowed.

### TranscriptSourceSummary

`TranscriptSourceSummary` is not memory citation. It is a compact inventory of context
sources used or available for the current turn.

```ts
interface TranscriptSourceSummary {
  readonly id: string;
  readonly ownerTurnId: string;
  readonly status: "active" | "committed";
  readonly groups: readonly TranscriptSourceGroup[];
  readonly droppedCount: number;
  readonly compactionCount: number;
}

interface TranscriptSourceGroup {
  readonly kind: string;
  readonly label: string;
  readonly count: number;
  readonly examples: readonly string[];
  readonly sourceRefIds: readonly string[];
}
```

Projection rules:

- Build from `ChannelContextView.sources`, `ChannelContextView.sourceRefs`, operation
  source refs, and materialized input records.
- Group by user-facing type: messages, files, web pages, memory, artifacts, workflow,
  tools/apps, and teammates.
- Filter internal refs such as context-pack internals, raw prompt/logs, daemon glue,
  projector helpers, model/provider ids, token budget, setup/cleanup wrappers, and raw
  event ids.
- Deduplicate by stable semantic key: memory id, normalized URL, file path, artifact id,
  tool/app id, or message id.

## Main Conversation UI

### Memory citation footer

Placement:

```text
Ling Agent
  natural answer text

  Used 2 memories  v
```

Collapsed behavior:

- one quiet footer line below the assistant/coordinator message;
- text only, no card, no heavy chip stack;
- do not show memory body in collapsed mode;
- show nothing when no memory was used.

Expanded behavior:

```text
Used 2 memories  ^
  Workspace: Provider routing order
    source: decision / Model Workbench setup
  Engineer: targeted test preference
    source: private chat summary
```

Rules:

- Show title, scope, source summary, and recall reason/query when available.
- Private memory can show title/scope if policy allowed the current actor to use it, but
  should avoid public body quotes by default.
- Secret-adjacent memory should not show body/excerpt in the footer. If it appears, the
  footer must force detail-only review language.
- The footer is attached to the answer. It is not an operation row and not a source card.

### OperationCell boundary

Operation rows still own execution:

```text
Read files
Edited files
Ran checks
Opened browser
```

Memory citation footer does not list commands, files, checks, or output. If memory affected
the work, the OperationCell may show a small memory count in its detail metadata, but the
default reading path remains the message footer.

### AgentActivitySpan boundary

For multi-agent work, memory used by a specialist reply attaches to that specialist span
only when the response or run can be attributed to that agent.

Default:

```text
Engineer
  Updated login.html  v
```

Expanded:

```text
Engineer
  Updated login.html  ^
    Used 1 memory: Login page convention
    Edited login.html
    Ran checks
```

The coordinator terminal summary can also carry memory citations when the coordinator used
memory to summarize or decide.

## Active Source Popover

The right floating popover remains an active-work surface. It may show a compact source
strip while a turn is running.

Default active shape:

```text
Running
Engineer editing login.html

Sources  messages 2  files 3  memory 1  artifacts 1
```

Rules:

- It appears only while there is active work, waiting approval, blocked state, or another
  active status worth monitoring.
- It hides after terminal commit unless the user opens detail explicitly.
- It never repeats the coordinator answer.
- It never repeats OperationCell rows.
- It may show icons/counts/examples, not raw source content.
- Clicking a source group opens source metadata detail or the related inline transcript
  detail.

Memory in source popover:

- Memory may appear as a source group count because it is part of context inventory.
- The popover must not expand into the same title/scope list as the memory citation
  footer. If the user wants memory details, route to the message footer or source detail.

## Right Drawer Boundary

The drawer is result-review and metadata navigation, not a second transcript.

Allowed drawer pages:

- file/artifact preview: generated files, changed files, diffs, rendered previews;
- review detail: completed checks, approvals, artifact review, audit metadata;
- source metadata: grouped source refs, source metadata, related operation/message ids;
- memory detail: memory title, scope, review state, source refs, policy/event ids;
- raw/debug detail: raw refs, payload ids, JSON, full logs, full command output.

Forbidden drawer behavior:

- no duplicate progress list if the active popover already shows progress;
- no duplicate main transcript text;
- no operation process timeline that copies OperationCell or AgentActivitySpan rows;
- no duplicate memory footer list as a root drawer card;
- no raw event stream unless the user opens raw/debug explicitly.

## Lifecycle

```text
user submits turn
  -> ConversationTranscriptTurn created
  -> TranscriptSourceSummary is empty or pending

context pack built
  -> source summary mutates in place
  -> active source popover can show compact source groups

memory recalled
  -> memory sources enter context inventory
  -> no citation footer yet, because no answer has used it yet

assistant/coordinator response commits
  -> UsedMemoryEvent recorded with responseId/runId
  -> TranscriptMemoryCitation attaches to the owning block

operation terminal
  -> OperationCell commits folded rows
  -> source summary freezes as committed evidence
  -> floating popover hides unless state is blocked/waiting
```

The key rule: final summary never replaces operation cells, memory citations, or source
summaries. It is another block in the same transcript turn.

## Implementation Slices

### MCS1. Transcript memory citation projection

Files likely touched:

```text
packages/contracts/src/channels.ts
packages/contracts/src/memory.ts
apps/web/src/lib/conversation-turn-projector.ts
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/shared/components/UsedMemorySummary.tsx
```

Acceptance:

- A message with `UsedMemoryEvent.responseId` renders a memory footer.
- A run-only memory event attaches to the related OperationCell terminal detail.
- Missing memory records render as unavailable detail, not crashes.
- Private/secret-adjacent memory does not leak body text in collapsed UI.

### MCS2. Source summary read model

Files likely touched:

```text
packages/contracts/src/channels.ts
packages/daemon/src/features/channels/context-processing/types.ts
apps/web/src/lib/conversation-context-sources.ts
apps/web/src/lib/conversation-turn-projector.ts
```

Acceptance:

- Source groups are derived from structured context/source refs, not assistant prose.
- Internal refs are filtered.
- Memory source groups and memory citation details remain separate.
- Source ids are stable across active-to-terminal mutation.

### MCS3. Active source popover UI

Files likely touched:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/styles/components.css
apps/web/e2e/channel.spec.ts
```

Acceptance:

- Active popover shows compact source icons/counts when sources exist.
- Popover hides after terminal commit.
- Popover does not show progress rows already owned by OperationCell.
- Popover click opens detail without duplicating transcript text.

### MCS4. Drawer detail pages

Files likely touched:

```text
apps/web/src/shared/conversation/RightDrawer.tsx
apps/web/src/shared/conversation/ConversationEvidenceBundlePanel.tsx
apps/web/src/shared/components/UsedMemorySummary.tsx
```

Acceptance:

- Drawer source detail shows grouped sources and related refs.
- Drawer memory detail shows memory provenance and used-memory event ids.
- Drawer root does not repeat the active popover or main conversation.

## Test Matrix

- Single-agent reply with no memory: no footer, no memory source group.
- Single-agent reply with workspace memory: footer appears on the Ling Agent message.
- Channel reply with private teammate memory: footer appears only when policy allows the
  current teammate; body is not quoted by default.
- Task run memory with no response message: citation attaches to the owning inline
  OperationCell detail.
- Active turn with attachments/files/memory/artifact sources: popover shows grouped source
  counts, not a card stack.
- Terminal turn: operation rows remain folded, memory footer remains visible, popover hides,
  result review/raw-debug detail remains available.
- Internal context refs: no raw prompt, provider id, token budget, context-pack id, or daemon
  helper appears in source groups.

## Design Verdict

Add the Codex-like citation presentation layer, but keep Ling's memory runtime:

```text
Ling Memory stays authoritative for scope/review/recall.
TranscriptMemoryCitation makes used memory readable near the answer.
TranscriptSourceSummary makes active context inventory visible without polluting the feed.
OperationCell keeps execution evidence.
Right drawer owns result review and explicit raw/debug detail only.
```
