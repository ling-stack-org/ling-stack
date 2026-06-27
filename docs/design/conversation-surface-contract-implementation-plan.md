# Conversation Surface Contract Implementation Plan

Status: active detailed plan for shared conversation surface slices
Date: 2026-06-28
Scope: shared conversation UI component boundary, surface policy, action bars, avatar
stacks, source stacks, compact evidence/work parity, regression tests, and package
extraction readiness

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Conversation Composer Unification Implementation Plan](conversation-composer-unification-implementation-plan.md)

## Goal

The conversation surface contract should land in ordered slices.

Slice 2A turns the shared conversation UI contract into concrete Web component
boundaries. Slice 2B makes compact evidence/work capability parity real for normal
conversation and private chat. Slice 2C locks the shared behavior with focused
regression tests. Slice 3 extracts packages only after Web consumers prove the contracts
are stable.

The previous baseline already made normal conversation, channel assistant turns, and
teammate private chat share more visual primitives. This plan should not restart visual
redesign. It should make the shared pieces explicit so later work can add capability
parity without reintroducing page-local message rows, source badges, action bars, and
policy checks.

## Non-Goals

Do not include these in Slice 2A:

- package extraction into `packages/conversation-ui-core` or
  `packages/conversation-ui-react`,
- right floating activity panel redesign,
- Desktop/PC renderer work,
- daemon storage changes,
- new transcript persistence model,
- large `WorkspaceClientView.tsx` modularization,
- new visual theme pass beyond what is needed to make shared primitives stable,
- normal conversation work-cell/evidence capability parity beyond wiring placeholders and
  policy contracts.

Those belong to Slice 2B or later.

## Current Anchors

| Concern | Current file | Current status |
| --- | --- | --- |
| Message row | `apps/web/src/shared/conversation/blocks/MessageRow.tsx` | Shared slot component exists |
| Footer actions | `apps/web/src/shared/conversation/blocks/MessageFooterActions.tsx` | Shared but named as footer and assembled page-locally |
| Copy button | `apps/web/src/shared/conversation/feedback/CopyActionButton.tsx` | Shared primitive exists |
| Evidence bundle | `apps/web/src/shared/conversation/blocks/ConversationEvidenceBundlePanel.tsx` | Shared structured panel exists |
| Message evidence | `apps/web/src/shared/conversation/blocks/MessageEvidencePanel.tsx` | Has private `WebSourceIconStack` and web evidence summary logic |
| Feed | `apps/web/src/shared/conversation/blocks/ConversationFeed.tsx` | Shared simple feed exists |
| Virtual feed | `apps/web/src/shared/conversation/blocks/ConversationVirtualFeed.tsx` | Shared virtual feed exists |
| Normal conversation | `apps/web/src/features/workspace/ConversationHome.tsx` | Uses shared shell/feed/message row after first send |
| Channel | `apps/web/src/features/workspace/WorkspaceClientView.tsx` | Uses shared message row in key paths, still assembles actions and team summary locally |
| Private chat | `apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx` | Uses shared virtual feed/message row, still assembles actions locally |

## Implementation Checkpoint

Current branch checkpoint, 2026-06-28:

Slice 2A shared primitives are implemented on this branch:

- `conversation-surface-policy.ts` exists and defines surface defaults.
- `MessageActionBar` exists and filters actions by policy.
- channel AI actions use `MessageActionBar`.
- teammate private chat actions use `MessageActionBar`.
- `SourceIconStack` exists and is used by `MessageEvidencePanel`.
- `TeammateAvatarStack` exists as a shared primitive.
- focused E2E assertions cover channel action ordering, source stack absence/presence,
  private chat action filtering, and normal conversation page behavior.

Slice 2B compact work parity is implemented in the conservative first-pass shape:

- `ConversationHomeMessage` preserves `threadId`, `turnId`, and `runId`.
- `AppShell.homeMessageFromTranscript` and selected conversation mapping preserve those
  ids.
- `ConversationHome` accepts `detailContext` with the selected `threadId`, `turns`, and
  `runs`.
- normal conversation assistant rows render `ConversationWorkCell` only when
  `message.runId` matches a real `RunSession`.
- private chat receives `runs` and `onOpenRun`, and renders `ConversationWorkCell` only
  when an AI row has `linkedRunId` that matches a real run in the selected teammate
  scope.

Slice 2C focused regression checks are implemented for the touched surfaces:

- normal conversation asserts compact work, shared action bar, no topic reply, no
  teammate stack, and no source stack when no source exists.
- private chat asserts a linked-run message shows compact work and still has no topic
  reply.
- channel coverage asserts the shared action/source behavior from Slice 2A.

Slice 3 has started with a core-only package extraction:

- `packages/conversation-ui-core` owns pure surface policy and action filtering types.
- Web re-exports those helpers from
  `apps/web/src/shared/conversation/tokens/conversation-surface-policy.ts`.
- React components are still Web-local. Do not extract `conversation-ui-react` until the
  view-model adapter props stabilize.

Composer unification is now a separate follow-up design track:

- [Conversation Composer Unification](conversation-composer-unification.md) defines the
  shared product and visual contract.
- [Conversation Composer Unification Implementation Plan](conversation-composer-unification-implementation-plan.md)
  defines the implementation slices.
- It should not be treated as a generic visual polish task. The channel composer remains
  the functional baseline, the normal conversation composer remains the visual baseline,
  and the surface policy decides model, authorization, and `@` capabilities.

This checkpoint is still a branch state until merged. Any follow-up implementation should
start by re-running the focused checks listed below against the final branch state.

## Slice Shape

Slice 2A is a Web-only refactor and regression slice:

```text
surface policy defaults
  -> shared action bar
  -> shared teammate avatar stack
  -> shared source icon stack
  -> channel/private/normal consumers
  -> focused E2E invariants
```

It should be possible to review this PR without understanding daemon internals.

## New Or Formalized Files

Create or update these files:

```text
apps/web/src/shared/conversation/tokens/conversation-surface-policy.ts
apps/web/src/shared/conversation/feedback/MessageActionBar.tsx
apps/web/src/shared/conversation/identity/TeammateAvatarStack.tsx
apps/web/src/shared/conversation/identity/SourceIconStack.tsx
apps/web/src/shared/conversation/index.ts
apps/web/src/shared/conversation/blocks/MessageFooterActions.tsx
apps/web/src/shared/conversation/blocks/MessageEvidencePanel.tsx
apps/web/src/features/workspace/WorkspaceClientView.tsx
apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx
apps/web/src/features/workspace/ConversationHome.tsx
apps/web/e2e/channel.spec.ts
apps/web/e2e/teammates.spec.ts
apps/web/e2e/app.spec.ts
```

Do not move the existing shared files only for directory purity. If a move is necessary,
keep compatibility exports through `apps/web/src/shared/conversation/index.ts`.

## Surface Policy

Add a small policy module. The policy should be explicit data, not inferred from route
names or CSS classes.

Suggested file:

```text
apps/web/src/shared/conversation/tokens/conversation-surface-policy.ts
```

Suggested types:

```ts
export type ConversationSurfaceKind =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct"
  | "run_thread";

export type ConversationEvidenceMode = "none" | "compact" | "rich";
export type ConversationWorkCellMode = "none" | "compact" | "rich";
export type ConversationRawDetailMode = "hidden" | "developer" | "rich";

export interface ConversationSurfacePolicy {
  readonly surface: ConversationSurfaceKind;
  readonly allowCopy: boolean;
  readonly allowFeedback: boolean;
  readonly allowTopicReply: boolean;
  readonly allowCreateTask: boolean;
  readonly allowRetry: boolean;
  readonly allowTeammateMentions: boolean;
  readonly allowMultiTeammateActivity: boolean;
  readonly showChannelRoster: boolean;
  readonly evidenceMode: ConversationEvidenceMode;
  readonly workCellMode: ConversationWorkCellMode;
  readonly rawDetailMode: ConversationRawDetailMode;
}
```

Default policies:

| Surface | Copy | Feedback | Topic reply | Create task | Retry | Teammate mentions | Multi-teammate activity | Evidence | Work cell | Raw detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `normal_conversation` | Yes | Yes | No | Later | Later | No | No | Compact | Compact | Developer |
| `channel_root` | Yes | Yes | Yes | Yes | Later | Yes | Yes | Compact | Compact | Developer |
| `channel_branch` | Yes | Yes | Yes | Yes | Later | Yes | Yes | Compact | Compact | Developer |
| `topic_reply` | Yes | No by default | Nested only | No | No | No | No | Compact | None unless promoted | Hidden |
| `teammate_direct` | Yes | No by default | No | Yes | Later | No | No | Compact/private | Compact/private | Developer |
| `run_thread` | Yes | No by default | No | No | Yes | No | Contextual | Rich | Rich | Rich |

Implementation rule:

```ts
getConversationSurfacePolicy(surface).allowTopicReply
```

is the only acceptable way for a shared component to decide whether a topic reply action
can render. Page code may still pass callbacks, but the shared action bar filters by
policy before rendering.

## MessageActionBar

Add a shared action bar that formalizes the current `MessageFooterActions` behavior.

Suggested file:

```text
apps/web/src/shared/conversation/feedback/MessageActionBar.tsx
```

Suggested types:

```ts
export type MessageActionKind =
  | "copy"
  | "like"
  | "dislike"
  | "reply_topic"
  | "create_task"
  | "retry"
  | "open"
  | "download"
  | "custom";

export interface MessageActionBarAction {
  readonly id: string;
  readonly kind: MessageActionKind;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly className?: string;
  readonly href?: string;
  readonly target?: string;
  readonly rel?: string;
  readonly copyText?: string;
  readonly onClick?: () => void;
}

export interface MessageActionBarProps {
  readonly surface: ConversationSurfaceKind;
  readonly policy?: ConversationSurfacePolicy;
  readonly className?: string;
  readonly actions: readonly MessageActionBarAction[];
  readonly visibility?: "hover-focus" | "always" | "critical";
}
```

Filtering rules:

| Action kind | Required policy |
| --- | --- |
| `copy` | `allowCopy` |
| `like` / `dislike` | `allowFeedback` |
| `reply_topic` | `allowTopicReply` |
| `create_task` | `allowCreateTask` |
| `retry` | `allowRetry` |
| `open` / `download` | Always allowed when href/action exists |
| `custom` | Caller owns policy, but must provide label and action |

Rendering rules:

- return `null` when no action survives filtering,
- render as the last child of `MessageRow` or the last child inside a turn transcript,
- keep copy success feedback inline through `CopyActionButton`,
- keep icon plus visually hidden or compact label according to existing CSS,
- preserve `aria-label`, `title`, and `data-tooltip`,
- selected feedback actions use `selected`,
- disabled actions remain visible only when they explain a state-critical limit.

Compatibility plan:

1. Implement `MessageActionBar` using the same DOM classes as `MessageFooterActions`
   where possible.
2. Keep `MessageFooterActions` exported in the first PR.
3. Either make `MessageFooterActions` a wrapper around `MessageActionBar`, or migrate only
   the channel/private/normal call sites that are touched in Slice 2A.
4. Do not rename every CSS selector in the same PR.

Consumer mapping:

| Current site | New surface | Required action set |
| --- | --- | --- |
| `renderChannelAiMessageActions` | `channel_root` or `channel_branch` | copy, like, dislike, reply_topic |
| private chat row actions | `teammate_direct` | copy, create_task |
| normal conversation assistant rows | `normal_conversation` | copy, feedback if backed by state; otherwise no fake action |
| topic reply panel | `topic_reply` | copy only in first slice |

## TeammateAvatarStack

Add a shared teammate avatar stack. It should not know about channel storage, teammate
settings, or daemon models.

Suggested file:

```text
apps/web/src/shared/conversation/identity/TeammateAvatarStack.tsx
```

Suggested types:

```ts
export interface TeammateAvatarStackItem {
  readonly id: string;
  readonly label: string;
  readonly avatarNode?: ReactNode;
  readonly status?: "active" | "done" | "delayed" | "unavailable";
  readonly title?: string;
}

export interface TeammateAvatarStackProps {
  readonly items: readonly TeammateAvatarStackItem[];
  readonly maxVisible?: number;
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
  readonly overflowLabel?: (count: number) => string;
  readonly onOpen?: () => void;
}
```

Rendering rules:

- use `avatarNode` when present,
- fallback to stable initials from `label`,
- normal circular avatars have no outer decorative frame,
- overlap by tokenized spacing, not ad hoc negative margins in page CSS,
- render overflow as a separate chip with spacing, for example `+4`,
- the overflow chip must not visually touch the final avatar,
- expose a single accessible label for the stack, such as `4 teammates`,
- do not render the word "Teammates" beside the stack unless the caller explicitly needs
  a section heading.

First consumer:

- `ChannelTeamExpertsSummary` should keep its existing product behavior, but any compact
  participant preview inside it should use `TeammateAvatarStack`.

Do not migrate the entire left teammate list. This stack is for conversation turns only.

## SourceIconStack

Move the current private `WebSourceIconStack` shape out of `MessageEvidencePanel` into a
shared source stack.

Suggested file:

```text
apps/web/src/shared/conversation/identity/SourceIconStack.tsx
```

Suggested types:

```ts
export type SourceIconKind =
  | "web"
  | "open_url"
  | "memory"
  | "file"
  | "tool"
  | "artifact"
  | "app"
  | "policy";

export interface SourceIconStackItem {
  readonly id: string;
  readonly kind: SourceIconKind;
  readonly label: string;
  readonly href?: string;
  readonly title?: string;
  readonly status?: "available" | "degraded" | "blocked";
}

export interface SourceIconStackProps {
  readonly sources: readonly SourceIconStackItem[];
  readonly maxVisible?: number;
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
  readonly overflowLabel?: (count: number) => string;
  readonly onOpenSource?: (source: SourceIconStackItem) => void;
}
```

Rendering rules:

- return `null` for an empty source list,
- stack icons like teammate avatars,
- no decorative border around ordinary icons,
- use visible degraded/blocked styling only when the source status requires attention,
- web sources use globe/search-style icons, but do not show `web_search` text in the
  collapsed row,
- overflow gets spacing like teammate overflow,
- each source has a tooltip and accessible label,
- clicking a source opens the evidence/detail path only when the caller provides
  `onOpenSource` or `href`.

`MessageEvidencePanel` migration:

- keep `hasRenderableWebEvidence` so rows with no real evidence still return `null`,
- convert web sources/read URLs into `SourceIconStackItem[]`,
- keep blocked/degraded reason text in the expanded evidence section,
- use `SourceIconStack` for the collapsed summary when sources exist,
- keep `WebEvidenceStatusIcon` only if it represents blocked/degraded state with no
  source URLs.

## MessageRow Contract Adjustments

`MessageRow` should remain slot-based in Slice 2A. Do not force it to own every action or
evidence type yet.

Allowed small additions:

```ts
readonly surface?: ConversationSurfaceKind;
readonly actionBarNode?: ReactNode;
```

But only add these if they reduce ambiguity. It is also acceptable to keep `actionsNode`
and make call sites pass `MessageActionBar`.

Rules:

- `actionsNode` or `actionBarNode` must render after body, attachments, evidence, and
  error nodes,
- no page should manually put feedback buttons above evidence or teammate activity,
- user rows can omit action bars in Slice 2A,
- assistant/teammate rows get action bars only when policy allows at least one action.

## Consumer Migration

### Channel

File:

```text
apps/web/src/features/workspace/WorkspaceClientView.tsx
```

Work:

1. Replace `renderChannelAiMessageActions` internals with `MessageActionBar`.
2. Pass `surface` as `channel_branch` when a branch is selected, otherwise
   `channel_root`.
3. Keep action order: copy, like, dislike, reply_topic.
4. Keep `ChannelTeamExpertsSummary` above the action bar.
5. Use `SourceIconStack` through `MessageEvidencePanel`, not page-local source text.

Do not split `WorkspaceClientView.tsx` in this slice. This PR should be reviewable as a
component boundary change, not a large workspace refactor.

### Teammate Private Chat

File:

```text
apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx
```

Work:

1. Replace private `MessageFooterActions` usage with `MessageActionBar`.
2. Pass `surface="teammate_direct"`.
3. Keep action order: copy, create_task.
4. Do not add topic reply or teammate mention actions.
5. Keep private evidence and attachments scoped to the selected teammate.

### Normal Conversation

File:

```text
apps/web/src/features/workspace/ConversationHome.tsx
```

Work:

1. Pass `surface="normal_conversation"` where useful.
2. Do not add channel teammate activity.
3. Do not add topic reply.
4. Add action bar only when there is actual action state to back it. If no copy handler
   exists yet, do not add fake copy UI.
5. Keep the post-send conversation page behavior.

### Message Evidence

File:

```text
apps/web/src/shared/conversation/blocks/MessageEvidencePanel.tsx
```

Work:

1. Replace private `WebSourceIconStack` with shared `SourceIconStack`.
2. Preserve `hasRenderableWebEvidence`.
3. Preserve blocked/degraded default-open behavior.
4. Keep expanded source titles and links.

## CSS And Tokens

Use existing CSS class compatibility first:

```text
message-footer-actions
message-footer-action
message-evidence-source-stack
message-evidence-source-icon
message-evidence-source-overflow
```

Add semantic classes only where necessary:

```text
message-action-bar
teammate-avatar-stack
teammate-avatar-stack-overflow
source-icon-stack
source-icon-stack-overflow
```

CSS rules:

- action bars are hover/focus discoverable,
- keyboard focus reveals the bar,
- source and teammate overflow chips have a minimum gap from the previous icon,
- icon stacks do not change row height when overflow appears,
- no visible border around normal avatar/source icons,
- selected feedback states remain visible,
- disabled critical actions have reduced opacity but readable tooltip.

Avoid adding a new color palette in this slice. Use existing conversation tokens and
semantic state classes.

## E2E Regression Plan

### Channel

File:

```text
apps/web/e2e/channel.spec.ts
```

Required assertions:

- assistant action row is the last child of the assistant turn transcript,
- `ChannelTeamExpertsSummary` renders before the action row,
- channel assistant rows include copy, like, dislike, and reply_topic actions,
- reply_topic action is absent when the surface is not channel root/branch,
- source icons render for a message with actual web sources,
- source icons do not render when no web evidence exists,
- blocked/degraded web evidence shows the reason in expanded evidence,
- source overflow such as `+4` has visible spacing and does not collide.

Suggested targeted command:

```bash
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "channel team experts fold|web evidence|source"
```

### Private Chat

File:

```text
apps/web/e2e/teammates.spec.ts
```

Required assertions:

- private chat uses shared message row classes,
- private chat empty state is centered through shared empty state classes,
- private action bar includes copy and create_task only,
- private action bar does not include reply_topic,
- private chat does not expose `@` teammate routing,
- private web evidence uses the same source icon stack when sources exist.

Suggested targeted command:

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts -g "private chat|empty message states share"
```

### Normal Conversation

File:

```text
apps/web/e2e/app.spec.ts
```

Required assertions:

- sending from home switches to the conversation page,
- normal conversation uses shared message rows,
- normal conversation has no topic reply action,
- normal conversation has no teammate avatar stack by default,
- normal conversation row width stays aligned with the composer.

Suggested targeted command:

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts -g "conversation home follows|recent conversations"
```

### Static Checks

Run:

```bash
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

## Implementation Checklist

1. Add `conversation-surface-policy.ts`.
2. Export policy types and helper from `apps/web/src/shared/conversation/index.ts`.
3. Add `MessageActionBar.tsx`.
4. Either wrap or migrate `MessageFooterActions`.
5. Add `TeammateAvatarStack.tsx`.
6. Add `SourceIconStack.tsx`.
7. Migrate `MessageEvidencePanel` to use `SourceIconStack`.
8. Migrate channel AI message actions to `MessageActionBar`.
9. Migrate teammate private chat actions to `MessageActionBar`.
10. Touch normal conversation only if needed for policy wiring or tests.
11. Add focused E2E assertions.
12. Run targeted E2E and typecheck.

## Acceptance Criteria

Slice 2A is done only when all of these are true:

- shared policy helper exists and is used by shared action rendering,
- channel AI action row is rendered through `MessageActionBar`,
- private chat action row is rendered through `MessageActionBar`,
- private chat cannot render `reply_topic` even if a caller accidentally includes it,
- source collapsed UI uses shared `SourceIconStack`,
- rows with no real web/source evidence render no source stack,
- teammate/source overflow spacing is stable,
- action row remains the last visual layer of the assistant message/turn,
- teammate activity remains above the action row,
- normal conversation still switches from home to conversation page after first send,
- focused tests and typecheck pass.

## Review Notes For The Implementing Agent

The most likely failure modes are:

- accidentally adding topic reply to private chat because actions are passed from a shared
  config without policy filtering,
- showing source icons when `webEvidence` only contains empty/default metadata,
- moving channel teammate activity below the action row while refactoring action placement,
- renaming CSS classes broadly and breaking existing tests,
- turning this slice into package extraction.

Avoid those by keeping the PR small and policy-driven.

## Deferred To Slice 2B

Slice 2B should handle capability parity:

- normal conversation compact evidence/work cells,
- private chat compact work cells,
- shared file/reference blocks across normal/channel/private,
- run/thread rich mode based on the same capability data.

Do not start those until Slice 2A has stabilized the action/avatar/source/policy boundary.

## Slice 2B Detailed Plan: Capability Parity

Goal: normal conversation and teammate private chat should use the same compact
capability blocks as channel when actual capability data exists. They should not show
decorative "sources", "files", "context", or "work" rows when there is no structured
data.

### 2B.1 Preserve Conversation Ids

Current issue:

```text
ConversationTranscriptMessage.threadId / turnId / runId
  -> AppShell.homeMessageFromTranscript
  -> ConversationHomeMessage
```

`ConversationHomeMessage` currently keeps text and status but drops `threadId`, `turnId`,
and `runId`. That prevents safe matching to `ConversationDetailResponse.runs` and
`ConversationDetailResponse.turns`.

Required work:

1. Add optional `threadId`, `turnId`, and `runId` to `ConversationHomeMessage`.
2. Preserve those ids in `homeMessageFromTranscript`.
3. Preserve those ids in the `selectedConversationMessages` mapper in `AppShell`.
4. Keep merge keys stable. Do not switch normal conversation merging to raw `id` if the
   existing `role:turnId` merge rule prevents duplicate streaming rows.

Acceptance:

- a normal conversation assistant row can be matched to its `runId` after refresh,
- streaming updates still mutate the same assistant row,
- a plain text conversation without a run still renders normally.

### 2B.2 Pass Detail Context To The Surface

`ConversationHome` should receive enough already-loaded detail data to build compact
capability rows without fetching daemon state itself.

Preferred first shape:

```ts
interface ConversationHomeDetailContext {
  readonly threadId?: string;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
}
```

Implementation rules:

- pass this from `selectedConversationDetail`,
- do not import daemon API functions into `ConversationHome`,
- do not make `ConversationHome` responsible for route selection,
- keep mapping logic small and local until the view model stabilizes.

If this grows beyond simple maps, extract a Web-local projector:

```text
apps/web/src/shared/conversation/projectors/normal-conversation-capabilities.ts
```

Do not extract a package in Slice 2B.

### 2B.3 Build Compact Work From Real Runs

Minimum first version:

- build `runById` from `ConversationDetailResponse.runs`,
- for each assistant row, find the linked run by `message.runId`,
- preserve `message.turnId` and `message.threadId` for future projector work, but do not
  use them as broad fallback matching keys in the first pass,
- render compact work only when a run exists.

Compact work content:

| Run status | Compact UI |
| --- | --- |
| queued/running | one active work cell row, mutating in place |
| waiting/blocked | visible attention state and next action when available |
| failed | failed state with reason and safe retry only if policy allows |
| succeeded | quiet terminal summary, checks/artifacts if structured data exists |
| cancelled | neutral stopped state |

Rules:

- do not parse assistant prose for file changes, commands, checks, or evidence,
- do not render raw run ids in the main feed,
- do not duplicate the final answer as a separate "result card",
- do not attach every run in a `threadId` to every assistant row in that thread,
- do not attach by `turnId` until the source contract exposes an explicit turn-run
  relation and a regression test proves the row cannot duplicate stale work,
- open rich run detail through the existing run/thread detail path when available.

Acceptance:

- a normal conversation linked to a real run shows one compact work block,
- a normal conversation with no run shows no work block,
- no new channel-only teammate activity appears in normal conversation.

Implemented first-pass behavior:

```text
ConversationHomeMessage.runId
  -> RunSession.id exact match
  -> buildConversationWorkCellViewModel({ runs: [matchedRun] })
  -> MessageRow.workCellNode
  -> ConversationWorkCell
```

The matched run's `threadId` or the selected conversation `threadId` anchors the work cell.
It is not a fallback that searches all runs for the thread.

### 2B.4 Build Compact Evidence From Real Sources

Evidence input can come from current detail contracts only if it is structured. If current
contracts cannot expose memory/web/file/tool evidence for normal conversations, 2B should
record the daemon contract gap instead of rendering fake evidence.

Minimum rendering gates:

| Source | Required structured data |
| --- | --- |
| web/open URL | URL, search/open event, citation, or blocked/degraded reason |
| file | file reference, artifact id, upload id, or workspace file reference |
| memory | used-memory event or memory source id |
| tool | tool call/evidence event tied to run or turn |
| approval | approval/checkpoint tied to run or turn |

Rules:

- use `SourceIconStack` for collapsed source icons,
- use `MessageEvidencePanel` or `ConversationEvidenceBundlePanel` for expandable detail,
- keep raw provider metadata in developer detail,
- rows with configured tools but no actual usage render no source/evidence UI.

Acceptance:

- source icons appear only when a real source exists,
- `web_search` text does not appear when no search happened,
- blocked/degraded source state is visible before or during expansion.

### 2B.5 Private Chat Capability Boundary

Private chat can reuse the same compact capability blocks, but the scope is stricter than
normal conversation.

Required work:

1. Identify the private message/thread data that can safely map to runs/evidence.
2. Attach compact work/evidence only when the record belongs to the selected teammate
   private thread.
3. Keep `surface="teammate_direct"` for the action bar.
4. Keep `allowTeammateMentions=false` and `allowMultiTeammateActivity=false`.

Forbidden:

- showing other teammate avatar stacks,
- exposing channel topic reply,
- importing channel-visible evidence into private chat without explicit link/promotion,
- publishing private evidence into channel context automatically.

Acceptance:

- private chat can show compact work/evidence for the selected teammate,
- private chat still has no `@` routing and no topic reply,
- private empty state remains centered through the shared empty-state component.

Implemented first-pass behavior:

```text
TeammateDirectMessage.linkedRunId
  -> RunSession.id exact match
  -> require RunSession.threadId
  -> if RunSession.teammateId exists, require selected teammate id
  -> buildConversationWorkCellViewModel({ runs: [matchedRun] })
  -> MessageRow.workCellNode
  -> ConversationWorkCell
```

This is intentionally stricter than normal conversation. A private chat row must never
discover channel runs by shared workspace or broad thread search.

### 2B.6 Files, Attachments, And References

The same visual primitives should render references across normal, channel, and private
surfaces.

Required work:

- convert composer file references and transcript file references into a shared
  capability view,
- render compact file/reference chips only when the message contains real references,
- preserve existing upload/open behavior,
- use the same source/icon stack grammar for file/reference summaries.

Acceptance:

- a message with a real file reference shows the compact reference,
- a message without references does not show a placeholder,
- private chat file references stay private unless explicitly shared.

## Slice 2C Detailed Plan: Regression Guard

Goal: prevent future screenshot-driven tweaks from breaking the shared contract.

### Test Groups

| Test group | Required assertions |
| --- | --- |
| Normal conversation | post-send page, shared rows, no topic reply, no teammate stack by default, row/composer alignment |
| Channel | teammate activity above action bar, action bar last, topic reply only on channel surfaces, source absence gates |
| Private chat | centered empty state, shared rows, copy/create-task only, no topic reply, no `@` teammate routing |
| Source/evidence | source icons only for actual sources, no nested link inside button, blocked/degraded state visible |
| Overflow | teammate/source `+N` chip spacing does not collide with previous icon |
| Composer unification | shared composer root/style on channel, normal, and private; channel keeps `/`, `@`, attachments, active guidance, visible authorization, and no model picker; normal keeps `/`, model, authorization, attachments, and no `@`; private keeps `/`, authorization, optional read-only model status, attachments, and no `@` or model picker; authorization is locked while active |

Selectors should target shared primitives:

```text
.message-action-bar
.source-icon-stack
.teammate-avatar-stack
.conversation-empty-state
.normal-conversation-message-row
```

Do not rely on exact long copy unless the copy itself is under test.

### Commands

Run the narrow suite first:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "channel team experts fold|web evidence|source"
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts -g "private chat|empty message states share"
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts -g "conversation home follows|recent conversations"
git diff --check
```

Broader E2E can run before PR merge if this slice touches shared feed, composer, or
virtualization behavior outside the targeted surfaces.

### Browser QA

Browser QA should verify one normal conversation, one channel row, and one private chat
empty state when the app is already running.

Minimum manual checks:

- no console errors on the local Web dev URL,
- existing recent conversation opens to the conversation page,
- normal conversation does not show topic reply,
- channel action row remains below teammate activity,
- private chat empty state is centered.

## Slice 3 Detailed Plan: Package Extraction

Package extraction is split into core-first and React-later.

The core-first part has started because surface policy and action filtering are pure
data. React extraction is still deferred. It should start only after Slice 2B and 2C
prove that Web surfaces can share stable view-model props without leaking app shell,
channel store, teammate store, or daemon fetching concerns into a package API.

### First Extractable Package

Package:

```text
packages/conversation-ui-core
```

Allowed contents:

- surface kind types,
- surface policy defaults,
- action kind types,
- source/avatar/evidence/work view model types,
- pure filtering helpers,
- fixture transcript data used by tests.

Forbidden imports:

- daemon API clients,
- app shell navigation,
- channel domain stores,
- teammate settings stores,
- React components,
- browser-only utilities.

Acceptance:

- package builds without React,
- Web imports policy/types from the package,
- package tests prove private chat cannot render channel-only controls.

Implemented in the current branch:

```text
packages/conversation-ui-core/
  package.json
  tsconfig.json
  src/index.ts
  src/surface-policy.ts
  test/surface-policy.test.mjs
```

Current package scope:

- `ConversationSurfaceKind`,
- evidence/work/raw detail mode types,
- `MessageActionKind`,
- `ConversationSurfacePolicy`,
- `getConversationSurfacePolicy`,
- `mergeConversationSurfacePolicy`,
- `conversationActionAllowedByPolicy`.

Do not add React, Web i18n, lucide icons, app navigation callbacks, or daemon-derived
view models to this package in the same slice.

### Second Extractable Package

Package:

```text
packages/conversation-ui-react
```

Allowed contents after stabilization:

- `MessageActionBar`,
- `SourceIconStack`,
- `TeammateAvatarStack`,
- purely presentational evidence/work primitives that do not import app state.

Rules:

- React package depends on `conversation-ui-core`,
- React package accepts view models and callbacks only,
- Web owns data fetching and route state,
- Desktop/PC can adopt the same props without copying Web page code.

Acceptance:

- fixture transcript renders without channel app state,
- package components do not import `apps/web/src/domains/*`,
- Web call sites need only thin adapters from app state to shared view models.

## Implementation Sequencing

Recommended order from the current branch state:

1. Re-run the focused Slice 2A/2B/2C checks against the final branch state.
2. Merge the current shared primitives, conservative compact work, and
   `conversation-ui-core` package together if the diff remains scoped.
3. Add evidence/source gates only where current contracts expose real structured data.
4. Add explicit turn-run projector tests before enabling `turnId` fallback.
5. Add explicit thread-level summary tests before enabling any `threadId` fallback.
6. Extract `conversation-ui-react` only after core extraction proves useful and Web
   adapters stop changing.

Combining the current 2B first-pass and core-only Slice 3 is acceptable because the core
package contains only pure policy/action filtering. Do not combine React component
extraction with 2B capability expansion. The risk is not TypeScript complexity. The risk
is locking unstable Web adapter shapes into a package API too early.

## Unresolved Decisions

No unresolved decision blocks Slice 2A.

No unresolved decision blocks the current 2B first pass:

- normal conversation compact work attaches by exact `message.runId` only,
- private chat compact work attaches by exact `linkedRunId` plus selected teammate scope,
- rows with no structured capability data render no work/source/evidence block.

Open for Slice 2B:

- whether current daemon contracts expose enough normal-conversation evidence to render
  memory/web/file/tool evidence without a backend extension,
- whether a stable turn-run link can support safe `turnId` fallback,
- whether thread-level summaries belong under one selected row, a separate thread
  summary strip, or only the run/thread detail page,
- whether file/reference capability blocks should share the same projector as source
  icons or stay as attachment-strip inputs.

Open for Slice 3:

- `packages/conversation-ui-react` name and public component list,
- whether screenshot regression becomes mandatory in CI before extraction,
- whether Desktop needs the React package or only the core view model contracts first.
