# Conversation Composer Unification Implementation Plan

Status: active detailed implementation plan
Date: 2026-06-28
Scope: shared composer component extraction, visual token unification, channel feature
parity, normal model control, private read-only model status, shared four-preset
authorization controls, and focused regression tests

Related docs:

- [Conversation Composer Unification](conversation-composer-unification.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Conversation UI Package Extraction Implementation Plan](conversation-ui-package-extraction-implementation-plan.md)
- [Multi-Agent Slash Commands](multi-agent-slash-commands.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)

## Goal

Implement one shared composer UI for channel, normal conversation, and teammate private
chat without breaking channel composer behavior.

The implementation should preserve the channel composer as the functional baseline and
the normal conversation composer as the visual baseline:

- functional baseline: channel composer in `WorkspaceClientView`,
- visual baseline: floating rounded normal conversation composer,
- policy baseline: surface capability flags decide which controls render.

## Target Architecture Vs First Slice

The complete target is a Conversation UI Kit:

```text
conversation-ui-core
  -> pure policy, permission, action, and view-model contracts

conversation-ui-react
  -> surface, feed, message, evidence, and composer rendering

surface adapters
  -> channel, normal conversation, and teammate private state mapping
```

The first implementation slice should not try to move all channel, model, permission, and
send/routing logic into the shared component. It should instead make the component shape
match the final architecture while keeping business ownership in adapters.

| Area | Final target | First slice |
| --- | --- | --- |
| Core policy | `packages/conversation-ui-core` owns pure composer/surface policy | Add only the small helpers needed for capability filtering |
| React package | `packages/conversation-ui-react` renders app-agnostic conversation props | Extract first-wave composer/message/feed primitives now; keep adapters in Web |
| Business state | adapters map resolved state into typed props | keep most state inline in current surface owners if extraction is too large |
| Authorization | typed four-preset state with immutable active snapshot semantics | render shared control/slot and lock while active |
| Model | normal conversation picker; channel/private read-only or absent | preserve current model paths; private remains no picker |
| Token parsing | one tokenized input path | migrate only after shell and toolbar are stable |
| Styling | one visual token system across all surfaces | move shared CSS first; leave placement wrappers only |

This is the line between "full design" and "safe implementation": design the complete
component boundary now, but land behavior in small slices that keep existing route and
runtime ownership intact.

## Canonical Delivery Slices

Use this order for implementation and PR review. It is the source of truth for the
current slice plan:

| Slice | Name | Primary outcome |
| --- | --- | --- |
| 1 | Code audit / state confirmation | Composer state sources and surface boundaries are mapped before edits. |
| 2 | Shared Composer Shell | All three surfaces render one shared shell and visual class family. |
| 3 | Shared Toolbar + four authorization presets | Authorization is visible everywhere and locked during active execution. |
| 4 | Normal conversation adapter | Normal conversation uses the shared composer, keeps model/thinking, and blocks `@`. |
| 5 | Teammate private adapter | Private chat uses the shared composer, keeps direct guidance, blocks `@`, and has no model picker. |
| 6 | Channel adapter | Channel uses the shared composer without losing `/`, `@`, files, approvals, active run stop/follow-up, or inline guidance. |
| 7 | Tokenized input / preview / popover convergence | Input, pending assets, slash/mention popovers, and preview strips behave and look consistent. |
| 8 | Core/React package extraction | Create `conversation-ui-react`, move first-wave shared composer/message/feed primitives, and keep app adapters Web-owned. |

Slice 8 starts after Slices 2-7 prove that channel, normal conversation, and private chat
share the same composer shape. The extraction must not freeze active-run, private direct
reply, or channel routing state into package APIs; those remain Web adapter concerns.

## Non-Goals

Do not include these in the first implementation slice:

- unrelated daemon route changes outside composer parity,
- a new transcript persistence model,
- moving all `WorkspaceClientView` send/routing logic into a new state machine,
- Desktop/PC implementation,
- changing channel teammate model configuration semantics,
- making normal conversation or private chat support teammate `@` routing,
- changing permission/approval policy semantics.

## Current Anchors

| Concern | Current file | Notes |
| --- | --- | --- |
| Channel composer rendering | `apps/web/src/features/workspace/WorkspaceClientView.tsx` | Richest behavior, page-local rendering |
| Normal composer rendering | `apps/web/src/features/workspace/ConversationHome.tsx` | Best floating visual shell, separate textarea |
| Private chat composer | `apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx` | Uses `MessageComposer`, lacks tokenized parity |
| Generic textarea composer | `apps/web/src/shared/components/MessageComposer.tsx` | Shared but not rich enough |
| Tokenized input | `apps/web/src/shared/conversation/composer/TokenizedComposerInput.tsx` | Should become default input |
| Composer parts parser | `apps/web/src/shared/conversation/composer/composer-input-parts.ts` | Already supports attachments, mentions, skills, slash, URLs |
| Authorization menu | `apps/web/src/features/workspace/ConversationAuthorizationMenu.tsx` | Needs shared composer placement and four-preset permission model alignment |
| Styles | `apps/web/src/styles/components.css`, `apps/web/src/styles/conversation-home.css`, `apps/web/src/styles/teammates.css` | Currently split by surface |

## Target File Layout

Full target layout:

```text
packages/conversation-ui-core/src/
  surface-policy.ts
  composer-policy.ts
  message-actions.ts
  permission-types.ts

apps/web/src/shared/conversation/
  surface/
  message/
  evidence/
  composer/
```

First slice should stay Web-local and start with the composer directory:

```text
apps/web/src/shared/conversation/composer/
  ConversationComposer.tsx
  ConversationComposerShell.tsx
  ConversationComposerToolbar.tsx
  ConversationComposerPopovers.tsx
  conversation-composer-types.ts
  conversation-composer-policy.ts
```

Surface adapters stay near the owning surface:

```text
apps/web/src/features/workspace/
  ChannelConversationComposerAdapter.tsx      optional first slice
  NormalConversationComposerAdapter.tsx       optional first slice

apps/web/src/features/teammates/
  TeammateDirectComposerAdapter.tsx           optional first slice
```

If adapter extraction would make the first slice too large, keep adapter logic inline
and only extract `ConversationComposer` plus shared types. Do not block the shared visual
contract on perfect modularization.

The original first composer slice should not create `packages/conversation-ui-react`
until all three Web surfaces consume stable props. That condition is now met for the
first-wave composer shell and tokenized input. Package extraction may proceed, but active
run handling, private direct replies, and model/provider ownership must stay in Web
adapters.

## Slice 1: Shared Visual Shell

Goal: create the visual shell and tokens before moving behavior.

### Work

- Add `ConversationComposerShell` with slots:
  - `statusNode`
  - `approvalNode`
  - `guidanceNode`
  - `previewNode`
  - `inputNode`
  - `leftToolsNode`
  - `rightToolsNode`
  - `feedbackNode`
- Add shared root classes:
  - `.conversation-composer`
  - `.conversation-composer-shell`
  - `.conversation-composer-input-zone`
  - `.conversation-composer-toolbar`
  - `.conversation-composer-left-tools`
  - `.conversation-composer-right-tools`
  - `.conversation-composer-send`
- Move the normal conversation composer shadow/radius into shared composer styles.
- Keep old surface classes as compatibility wrappers only:
  - `.channel-composer`
  - `.conversation-home-composer`
  - `.teammate-direct-composer`

### Visual Acceptance

- all three surfaces use one outer shell visual token set,
- outer radius, border, background, focus ring, toolbar button size, and send button
  shape match,
- channel no longer looks like a separate compact box,
- private chat no longer has its own narrower visual style beyond its parent width,
- popovers are not clipped by shell overflow.

### Tests

- CSS/DOM assertions in focused E2E:
  - root composer has `.conversation-composer`,
  - channel/normal/private still have their surface class,
  - send button class is shared,
  - no duplicate composer toolbars render.

## Slice 2: Tokenized Input Everywhere

Goal: use `TokenizedComposerInput` in channel, normal conversation, and teammate private
chat.

### Work

- Extract shared input props:
  - `value`
  - `parts`
  - `placeholder`
  - `ariaLabel`
  - `onChange(value, caret)`
  - `onKeyDown`
  - `onPaste`
  - `onSelect(value, caret)`
- For normal conversation:
  - replace textarea with `TokenizedComposerInput`,
  - parse slash command tokens,
  - keep model/authorization state unchanged,
  - do not pass teammate mention options.
- For teammate private chat:
  - replace textarea path in `MessageComposer` usage with tokenized input,
  - parse slash/file/url tokens,
  - keep model identity read-only from teammate/provider settings,
  - do not pass teammate mention options.
- For channel:
  - keep existing mention/slash behavior,
  - route through the same input slot.

### Capability Gates

| Surface | `teammateMentions` | Parser mention options |
| --- | ---:| --- |
| Channel | true | channel/workspace teammate options |
| Normal conversation | false | empty |
| Teammate private chat | false | empty |

### Acceptance

- typing `/` opens command picker in all three surfaces,
- typing `@` opens teammate picker only in channel,
- normal/private typed `@name` stays plain text,
- file/url chips render with the same style,
- Enter send behavior remains unchanged.

### Tests

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "composer|mention|slash|file ref"
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts -g "conversation home"
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts -g "private chat"
```

Use narrower patterns if the full groups are too broad, but include one assertion for
each surface.

## Slice 3: Shared Toolbar Controls

Goal: align toolbar controls and policy filtering.

### Work

- Add `ConversationComposerToolbar`.
- Define controls:
  - `attach`
  - `mention`
  - `authorization`
  - `model`
  - `thinking`
  - `send`
  - `stop`
  - `custom`
- Use shared icon-only button styling.
- Move authorization into the shared toolbar slot for channel, normal conversation, and
  teammate private chat.
- Replace the old three-mode conversation authorization menu with the four permission
  presets used by settings: `read_only`, `workspace_collaboration`, `full_access`, and
  `custom`.
- Default authorization from surface/thread/channel/workspace settings. If the effective
  settings policy is custom, render `custom` as the selected preset.
- Disable the authorization trigger while the surface has an active send/run/direct reply.
  The selected preset for an active execution must come from the immutable run/direct
  reply request snapshot.
- Keep channel mention button in the shared toolbar but render only when
  `teammateMentions` is true.
- Keep channel model picker absent.
- Keep teammate private chat model picker absent. Optionally render a compact read-only
  model label/status if the teammate model identity is helpful.

### Control Matrix

| Control | Channel | Normal conversation | Teammate private chat |
| --- | ---:| ---:| ---:|
| Attach | yes | yes | yes |
| Mention | yes | no | no |
| Authorization | yes, locked while active | yes, locked while active | yes, locked while active |
| Model | no | yes | no; optional read-only status |
| Thinking | no by default | model-supported | no from composer |
| Send | yes | yes | yes |
| Stop | active run only | active run only | active direct reply only |

### Acceptance

- toolbar layout is identical across surfaces,
- channel does not show a disabled model control,
- normal conversation shows model control on the right,
- teammate private chat does not show model control,
- authorization appears beside attach on all three surfaces,
- authorization becomes disabled during active send/run/direct reply and cannot mutate
  the active execution,
- `@` button exists only in channel,
- send button location and size are stable.

## Slice 4: Pending Assets, Approval, And Guidance Parity

Goal: keep capability blocks in the same composer positions.

### Work

- Route pending attachments, link previews, file refs, upload states, and remove actions
  through one `previewNode`.
- Route inline approvals through one `approvalNode`.
- Route active/queued run guidance through one `guidanceNode`.
- Route failed send and retry through one `feedbackNode`.

### Slot Ordering

Inside the shared composer shell:

```text
status / active strip
inline approval
guidance queue
pending assets
input
toolbar
feedback / failed send retry
```

Do not put these blocks outside the composer in page-local wrappers unless layout
requires a sticky/docked container.

### Acceptance

- channel inline approval still appears above input,
- private direct guidance still appears above input,
- normal conversation can show the same approval/guidance slots when data exists,
- pending assets look identical across all surfaces,
- failed send retry is visually identical across surfaces.

## Slice 5: Surface Adapters And State Cleanup

Goal: reduce page-local duplication after behavior is stable.

### Work

- Extract adapters only after Slice 1-4 pass:
  - `buildChannelComposerView(...)`
  - `buildNormalConversationComposerView(...)`
  - `buildTeammateDirectComposerView(...)`
- Move common picker state helpers into shared hooks where safe:
  - slash picker navigation,
  - mention picker navigation,
  - token insertion,
  - focus/caret restoration.
- Keep daemon calls and route state in owning pages.

### Acceptance

- `ConversationComposer` imports no daemon route modules,
- adapters pass explicit props,
- channel send logic still lives in channel owner,
- private chat direct guidance logic still lives in private owner,
- normal conversation model/authorization persistence still lives in normal owner.

## Slice 6: Channel Adapter Parity

Goal: move channel onto the shared shell without shrinking the channel composer contract.

### Work

- Render the channel composer through `ConversationComposerShell`.
- Keep the channel as the functional baseline:
  - `/` slash commands,
  - teammate `@` mentions,
  - file uploads and drag/drop,
  - pending assets,
  - inline approvals,
  - active run status,
  - active run stop,
  - follow-up guidance while a run is active,
  - failed-send retry and feedback.
- Keep channel model picker absent.
- Keep channel authorization visible and locked while a message/run/guidance action is
  active.

### Acceptance

- Channel still supports all pre-existing composer capabilities.
- Channel does not show a model picker or private/direct-only model control.
- Local user bubbles do not expose stale hover-only topic reply actions; AI replies use
  the shared `MessageActionBar` reply action.
- E2E covers mention, slash command, file/link assets, topic reply, and active-run
  guidance behavior.

## Slice 7: Tokenized Input / Preview / Popover Convergence

Goal: make the three surfaces feel like the same input system while keeping their
capability policies different.

### Work

- Use `TokenizedComposerInput` for channel, normal conversation, and teammate private
  chat.
- Keep parser capability gates:
  - channel receives teammate mention options,
  - normal conversation receives no teammate mention options,
  - teammate private receives no teammate mention options.
- Route pending attachments, link previews, file refs, upload states, and remove actions
  through the shared preview strip location.
- Route slash and mention popovers through shared popover classes and placement rules.
- Keep surface-owned business state until the behavior is stable enough for adapter
  extraction.

### Acceptance

- Typing `/` behaves consistently across all three surfaces.
- Typing `@` opens teammate routing only in channel.
- Normal/private typed `@name` stays plain text.
- File and URL chips use the same visual treatment.
- Popovers share radius, border, shadow, row hover/focus, max height, and keyboard
  selection behavior.

## Stage 8: Core Policy / React Package Extraction

Goal: make future Desktop/PC reuse possible without freezing unstable Web assumptions.

Decision update, 2026-06-28: this implementation stage is now in progress. Channel,
normal conversation, and teammate private chat have converged on the same Web-local
composer shape, and the first React package extraction proceeds with strict dependency
boundaries.

The component-by-component extraction details are defined in
[Conversation UI Package Extraction Implementation Plan](conversation-ui-package-extraction-implementation-plan.md).
This Stage 8 section remains the composer-specific summary and must not diverge from the
package plan.

### Work

- Expand `packages/conversation-ui-core` only with stable, app-agnostic policy helpers:
  - surface capabilities,
  - permission preset mapping,
  - action filtering,
  - explicit active-execution lock derivation.
- Add pure package tests that assert:
  - private chat cannot enable teammate mentions,
  - private chat cannot enable model picker,
  - channel cannot enable model picker,
  - all three surfaces enable authorization,
  - authorization lock state is derived from explicit active execution state, not from
    route names.
- Create `packages/conversation-ui-react` and move first-wave React components:
  - `ConversationComposerShell`,
  - `TokenizedComposerInput`,
  - `ComposerPermissionMenu`,
  - `ConversationShell`,
  - `ConversationFeed`,
  - `ConversationEmptyState`,
  - `MessageRow`,
  - `MessageBubble`,
  - `MessageBodyRenderer`,
  - `MessageActionBar`,
  - `ConversationStatusStrip`,
  - `ConversationGuidanceStrip`,
  - `SourceIconStack`,
  - `TeammateAvatarStack`.
- Keep Web-owned slots for surface-specific controls:
  - channel: attach, `@`, authorization, active run stop/follow-up, send,
  - normal conversation: attach, authorization, thinking/model pickers, send,
  - private chat: attach, authorization, direct guidance send/stop.
- Keep `ConversationWorkCell`, attachment/evidence previews, code/diff rendering, and
  file chips in a second-wave audit unless their props are already app-agnostic.
- Do not move app-specific file pickers, model/provider fetching, channel routing,
  teammate settings, run cancellation, or daemon calls into the package.

### Acceptance

- `packages/conversation-ui-core` imports no React.
- `packages/conversation-ui-react` imports do not reach into `apps/web/src/app`,
  daemon clients,
  route modules, or workspace domain hooks.
- `packages/conversation-ui-react` imports neither `@ling-stack/api-client` nor
  `@ling-stack/core`.
- Web adapters keep the existing behavior differences:
  - private chat cannot `@` teammates and cannot change teammate model,
  - normal conversation can select model/thinking and cannot `@`,
  - channel can `@` teammates and cannot select a model.
- All three docked/post-send composers share the same shell visual contract.
- Desktop/PC can consume package APIs with their own adapters.

## Detailed Type Contract

```ts
export type ConversationComposerSurface =
  | "channel"
  | "normal_conversation"
  | "teammate_direct";

export type ConversationComposerDensity = "floating" | "docked";

export type ConversationComposerSendState =
  | "idle"
  | "sending"
  | "failed"
  | "active_run_empty_guidance"
  | "active_run_has_guidance"
  | "queued_guidance"
  | "approval_required"
  | "uploading";

export interface ConversationComposerCapabilities {
  readonly slashCommands: boolean;
  readonly teammateMentions: boolean;
  readonly attachments: boolean;
  readonly dragDropAttachments: boolean;
  readonly workspaceFileRefs: boolean;
  readonly linkPreviews: boolean;
  readonly modelPicker: boolean;
  readonly modelStatus: boolean;
  readonly thinkingPicker: boolean;
  readonly authorizationPicker: boolean;
  readonly activeRunGuidance: boolean;
  readonly inlineApprovals: boolean;
}

export interface ConversationComposerProps {
  readonly surface: ConversationComposerSurface;
  readonly density?: ConversationComposerDensity;
  readonly value: string;
  readonly parts: readonly ComposerInputPart[];
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly title?: string;
  readonly capabilities: ConversationComposerCapabilities;
  readonly sendState: ConversationComposerSendState;
  readonly sendLabel: string;
  readonly sendTitle?: string;
  readonly sendDisabled?: boolean;
  readonly attachLabel?: string;
  readonly accept?: string;
  readonly multipleAttachments?: boolean;
  readonly statusNode?: ReactNode;
  readonly approvalNode?: ReactNode;
  readonly guidanceNode?: ReactNode;
  readonly previewNode?: ReactNode;
  readonly feedbackNode?: ReactNode;
  readonly authorizationNode?: ReactNode;
  readonly modelNode?: ReactNode;
  readonly thinkingNode?: ReactNode;
  readonly mentionPickerNode?: ReactNode;
  readonly slashPickerNode?: ReactNode;
  readonly dropHintNode?: ReactNode;
  readonly onChange: (value: string, caret: number) => void;
  readonly onSelect?: (value: string, caret: number) => void;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onPaste?: ClipboardEventHandler<HTMLDivElement>;
  readonly onSubmit: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
  readonly onAttachFiles?: (files: readonly File[]) => void | Promise<void>;
  readonly onDragOver?: DragEventHandler<HTMLDivElement>;
  readonly onDragLeave?: DragEventHandler<HTMLDivElement>;
  readonly onDrop?: DragEventHandler<HTMLDivElement>;
}
```

`authorizationNode`, `modelNode`, and `thinkingNode` are slots in the first slice to
avoid moving business logic too early. Later slices may replace them with typed state.

## CSS Contract

Shared composer CSS should live in `apps/web/src/styles/components.css` with these
selectors:

```css
.conversation-composer {}
.conversation-composer-density-floating {}
.conversation-composer-density-docked {}
.conversation-composer-shell {}
.conversation-composer-input-zone {}
.conversation-composer-toolbar {}
.conversation-composer-left-tools {}
.conversation-composer-right-tools {}
.conversation-composer-tool-button {}
.conversation-composer-send {}
.conversation-composer-popover {}
```

Surface CSS can only control placement and max-width:

```css
.normal-conversation-page .conversation-composer {}
.activity-shell .conversation-composer {}
.teammate-private-chat .conversation-composer {}
```

Surface CSS must not redefine:

- radius,
- send button size,
- toolbar gap,
- token chip color,
- popover row treatment,
- pending asset card style.

## Migration Checklist

### Channel

- [x] Wrap existing channel composer in `ConversationComposerShell`.
- [x] Preserve `channelActiveStatusStrip`.
- [x] Preserve inline approval strip.
- [x] Preserve run guidance strip.
- [x] Preserve file upload, drag/drop, and pending assets.
- [x] Add four-preset authorization in the shared toolbar.
- [x] Lock authorization while a channel run is active.
- [x] Preserve mention picker and slash picker.
- [x] Preserve active run stop/follow-up behavior.
- [x] Reduce channel-only composer visual styles to placement and channel-specific
  behavior compatibility.

### Normal Conversation

- [x] Replace textarea with tokenized input.
- [x] Reuse shared preview strip for file attachments.
- [x] Move four-preset authorization into shared toolbar.
- [x] Lock authorization while message send/run is active.
- [x] Move model/thinking picker into shared right toolbar.
- [x] Keep floating shadow visual through shared density.
- [x] Ensure no mention button or mention picker.
- [x] Ensure model selection still affects send payload.
- [x] Add conversation-scoped attachment upload, stream payload, preview/content/delete,
  and transcript replay.

### Teammate Private Chat

- [x] Replace `MessageComposer` usage with `ConversationComposerShell`.
- [x] Reuse shared preview strip for private attachments/link previews/file refs.
- [x] Add four-preset authorization control.
- [x] Lock authorization while direct reply is active.
- [x] Keep model picker absent.
- [x] Preserve direct guidance strip and stop state.
- [x] Ensure no mention button or mention picker.
- [x] Ensure private-scoped attachments and file refs stay private.

Deferred:

- Read-only effective teammate provider/model status remains optional and is not required
  for first parity because private model edits are intentionally blocked in the composer.

## Regression Tests

### Required E2E Assertions

Normal conversation:

- post-send conversation page uses `.conversation-composer`,
- placeholder contains `/` but not `@`,
- model control is visible,
- authorization control is visible,
- slash command picker opens,
- mention picker does not open when typing `@`.

Channel:

- channel uses `.conversation-composer`,
- placeholder contains both `/` and `@`,
- attach and mention buttons are visible,
- model control is absent,
- authorization control is visible,
- authorization control is disabled while an active run is running or waiting for
  approval,
- slash and mention pickers still work,
- active run send button switches between stop and follow-up.

Teammate private chat:

- private chat uses `.conversation-composer`,
- placeholder contains `/` but not `@`,
- mention button is absent,
- model picker is absent,
- optional model status is read-only if rendered,
- authorization control is visible,
- authorization control is disabled while a direct reply is active,
- direct guidance still queues and stops correctly,
- private attachments still upload and render in history.

Visual:

- shared shell class exists in all three surfaces,
- send button has the same dimensions in all three surfaces,
- toolbar gap and icon button dimensions match,
- popovers use the shared popover class,
- pending asset chip class matches.

### Suggested Commands

Run in this order while implementing:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --dir apps/web exec playwright test e2e/app.spec.ts
corepack pnpm --dir apps/web exec playwright test e2e/channel.spec.ts -g "channel activity supports mentions, messages, files, links, and topic replies"
corepack pnpm --dir apps/web exec playwright test e2e/teammates.spec.ts -g "AI teammate private chat exposes direct reply guidance and stop controls"
git diff --check
```

Run Browser smoke after code changes:

```text
app loads -> normal conversation composer renders -> channel composer renders -> private
composer renders -> no console error/warn -> no framework overlay
```

## Risk Register

| Risk | Failure mode | Guard |
| --- | --- | --- |
| Channel behavior regression | mention/slash/active run flow breaks | migrate channel last or keep adapter thin |
| Private chat privacy leak | private composer exposes `@` teammate routing | capability gate and E2E absence assertions |
| Model semantics drift | channel or private chat appears to edit provider/model | no model control in channel/private capability; private status is read-only |
| Authorization confusion | composer picker looks like approval bypass or changes an active run | copy and payload must still map to existing permission policy; disabled while active; full access requires confirmation |
| Visual drift | surfaces share component but override CSS differently | CSS contract forbids surface token overrides |
| State ownership bloat | shared component starts fetching daemon state | slots/adapters only; no daemon imports |
| Keyboard regression | tokenized input breaks Enter or picker navigation | focused E2E plus unit tests for helpers |

## Implementation Order Recommendation

1. Audit state sources and produce the implementation checklist.
2. Extract shared visual shell without changing send behavior.
3. Move toolbar authorization into the shared shell and lock it during active execution.
4. Move normal conversation onto the shared shell.
5. Move teammate private chat onto the shared shell.
6. Move channel onto the shared shell while preserving current rich behavior.
7. Converge tokenized input, preview strip, slash/mention popovers, and shared visual
   classes.
8. Extract `conversation-ui-core`/`conversation-ui-react` after Web props stabilize.

The order is intentionally conservative. Channel composer carries the most product
behavior, so it is not the first behavior-heavy rewrite. Package extraction now follows
the Web convergence slices and should not absorb adapter state.

## Done Criteria

This slice is complete when:

- all three surfaces render the shared composer root,
- visual shell tokens match,
- channel keeps current composer capabilities,
- normal conversation has model and authorization controls,
- channel and private chat have authorization controls,
- private chat does not have a model picker,
- active send/run/direct reply locks authorization until the next turn/run,
- normal/private do not expose `@`,
- focused E2E covers the capability differences,
- old `conversation-home-composer` and `teammate-direct-composer` CSS are reduced to
  placement compatibility or removed.

## Implementation Status - 2026-06-28

Completed in the first shared composer slice:

- Added Web-local shared composer primitives:
  - `ConversationComposerShell`
  - `ComposerPermissionMenu`
- Channel, normal conversation, and teammate private chat now render the shared
  `.conversation-composer` root.
- The composer toolbar uses the same four permission presets across all three surfaces:
  `read_only`, `workspace_collaboration`, `full_access`, and `custom`.
- Full access selection requires an explicit client-side confirmation before the preset
  changes.
- Channel authorization reuses the existing run permission state and is locked while a
  channel message/run/guidance action is active.
- Normal conversation authorization uses `PermissionPreset` directly and sends
  `permissionMode` plus `permissionPreset` in the existing conversation payload.
- Private chat authorization is visible and locked while a direct reply/guidance action
  is active. It is UI-only in this slice because the teammate direct message API does not
  yet expose a permission snapshot field.
- Normal conversation and teammate private chat now use `TokenizedComposerInput`.
- Channel remains the functional baseline: slash commands, teammate mentions, pending
  assets, drag/drop, inline approvals, active run guidance, stop, and follow-up behavior
  stay owned by `WorkspaceClientView`.
- Private chat keeps its private attachment/link/file-ref preview path and direct
  guidance controls while moving off the old generic textarea composer.
- Slash picker detection, filtering, and token insertion now use a shared helper across
  channel, normal conversation, and teammate private chat. Each surface still owns its
  local picker state so channel routing and private direct guidance do not leak into a
  premature global state machine.
- Normal conversation now has a committed backend attachment scope:
  `conversation_attachments`, `/conversations/attachments`, `attachmentIds` on
  `/conversations/stream`, conversation preview scope, and transcript replay of uploaded
  files.
- Focused regression tests cover:
  - shared composer rendering and capability differences in normal/channel/private
    surfaces,
  - normal conversation attachment upload, send, and replay,
  - normal conversation send and recent conversation behavior,
  - private chat attachment and direct guidance behavior,
  - channel slash, mention, failed-send retry, pending-routing send, and active-run
    guidance behavior.

Coverage against the canonical delivery slices:

- Slice 1 is represented by this implementation plan and the current-state anchors.
- Slices 2 and 3 are implemented with `ConversationComposerShell` and
  `ComposerPermissionMenu`.
- Slices 4, 5, and 6 are implemented Web-locally for normal conversation, teammate
  private chat, and channel.
- Slice 7 is implemented for Web-local parity: all three surfaces use tokenized input
  and shared preview/popover class families, and slash command picker behavior is shared
  through helper functions while picker state remains surface-owned.
- Stage 8 first-wave extraction is implemented. The existing `conversation-ui-core`
  package remains pure policy/types/helpers; the new `conversation-ui-react` package
  owns React rendering and composer interactions only.

Deferred after this slice:

- Normal conversation link-preview persistence remains deferred. File attachments are
  implemented; URL previews should get a separate conversation-scoped contract before
  becoming durable transcript assets.
- Private chat permission changes are not sent to the daemon yet. Add this only with a
  teammate direct message permission snapshot contract.
- Global slash picker state extraction remains deferred. Channel, normal conversation,
  and private chat share command matching/filtering/insertion helpers, but keep separate
  picker state because their execution contexts differ.
- Strict scope requirements for attachment content/delete endpoints remain deferred for
  compatibility with existing channel and private attachment links. Conversation preview
  lookups already support `scope=conversation` plus `threadId`.
- Second-wave `conversation-ui-react` migration remains deferred for WorkCell,
  evidence/attachment previews, file chips, and code/diff renderers until their props
  are dependency-audited.
- Channel message action tests are synchronized with the newer shared `MessageActionBar`
  boundary: local user bubbles no longer expose the old hover-only meta reply button,
  while AI replies expose `Reply in topic` through the shared action bar.

## Resolved Decisions

No unresolved product decision blocks Slice 1.

- Private model selection is not a composer feature. Private chat uses teammate/provider
  settings and may show read-only model status only.
- Channel authorization is visible in the first shared toolbar slice.
- Authorization uses the four permission presets from settings.
- If settings default to a custom policy, composer defaults to `custom`.
- Authorization is immutable for an active execution snapshot and can only change before
  send or for the next turn/run.
