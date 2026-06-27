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

shared conversation React primitives
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
| React package | future `packages/conversation-ui-react` can render from app-agnostic props | Keep React components Web-local under `apps/web/src/shared/conversation` |
| Business state | adapters map resolved state into typed props | keep most state inline in current surface owners if extraction is too large |
| Authorization | typed four-preset state with immutable active snapshot semantics | render shared control/slot and lock while active |
| Model | normal conversation picker; channel/private read-only or absent | preserve current model paths; private remains no picker |
| Token parsing | one tokenized input path | migrate only after shell and toolbar are stable |
| Styling | one visual token system across all surfaces | move shared CSS first; leave placement wrappers only |

This is the line between "full design" and "safe implementation": design the complete
component boundary now, but land behavior in small slices that keep existing route and
runtime ownership intact.

## Non-Goals

Do not include these in the first implementation slice:

- daemon route changes,
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

Do not create `packages/conversation-ui-react` in the first composer slice unless all
three Web surfaces already consume the same stable props. A premature package API would
freeze guesses about channel active runs, private direct replies, and model/provider
ownership.

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

## Slice 6: Core Policy Extraction

Goal: move only stable, app-agnostic composer policy into `conversation-ui-core`.

### Work

- Add a pure composer policy helper that returns capability flags for:
  - channel,
  - normal conversation,
  - teammate private chat.
- Add pure permission preset types or re-export existing `PermissionPreset` contracts
  without pulling React or Web state into the package.
- Add tests that assert:
  - private chat cannot enable teammate mentions,
  - private chat cannot enable model picker,
  - channel cannot enable model picker,
  - all three surfaces enable authorization,
  - authorization lock state is derived from explicit active execution state, not from
    route names.

### Acceptance

- `packages/conversation-ui-core` imports no React,
- Web can use the policy helper without importing app routes,
- package tests cover the surface capability matrix.

## Slice 7: Optional React Package Extraction

Goal: make future Desktop/PC reuse possible without copying Web conversation UI.

Only start this after channel, normal conversation, and teammate private chat all use the
same Web-local component props.

### Work

- Move app-agnostic React primitives into a future `packages/conversation-ui-react`:
  - `ConversationComposer`,
  - `ConversationComposerShell`,
  - `ConversationComposerToolbar`,
  - `ComposerPermissionMenu`,
  - message/action/source primitives only after their props are stable.
- Keep Web adapters, daemon calls, i18n wiring, route navigation, and provider fetching in
  Web.

### Acceptance

- fixture transcript/composer props can render in isolation,
- package imports do not reach into `apps/web/src/app`, daemon clients, route modules, or
  workspace domain hooks,
- Desktop/PC can consume the package with its own adapters.

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

- [ ] Wrap existing channel composer in `ConversationComposer`.
- [ ] Preserve `channelActiveStatusStrip`.
- [ ] Preserve inline approval strip.
- [ ] Preserve run guidance strip.
- [ ] Preserve file upload, drag/drop, and pending assets.
- [ ] Add four-preset authorization in the shared toolbar.
- [ ] Lock authorization while a channel run is active.
- [ ] Preserve mention picker and slash picker.
- [ ] Preserve active run stop/follow-up behavior.
- [ ] Remove channel-only composer visual styles after parity.

### Normal Conversation

- [ ] Replace textarea with tokenized input.
- [ ] Reuse shared preview strip for file refs/attachments.
- [ ] Move four-preset authorization into shared toolbar.
- [ ] Lock authorization while message send/run is active.
- [ ] Move model/thinking picker into shared right toolbar.
- [ ] Keep floating shadow visual through shared density.
- [ ] Ensure no mention button or mention picker.
- [ ] Ensure model selection still affects send payload.

### Teammate Private Chat

- [ ] Replace `MessageComposer` usage with `ConversationComposer`.
- [ ] Reuse shared preview strip for private attachments/link previews/file refs.
- [ ] Add four-preset authorization control.
- [ ] Lock authorization while direct reply is active.
- [ ] Keep model picker absent.
- [ ] Optionally show read-only effective teammate provider/model status.
- [ ] Preserve direct guidance strip and stop state.
- [ ] Ensure no mention button or mention picker.
- [ ] Ensure private-scoped attachments and file refs stay private.

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
corepack pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g "composer|mention|slash|active run"
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts -g "conversation home|recent conversations"
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts -g "private chat|direct guidance|attachments"
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

1. Land docs and CSS contract.
2. Extract shared visual shell without changing behavior.
3. Move normal conversation onto the shared shell.
4. Move private chat onto the shared shell.
5. Move channel onto the shared shell while preserving current rich behavior.
6. Replace normal/private textarea paths with tokenized input.
7. Consolidate toolbar controls and popovers.
8. Remove old surface-specific composer styles once E2E proves parity.
9. Extract pure composer policy to `conversation-ui-core`.
10. Consider `conversation-ui-react` only after Web props stabilize across all three
    surfaces.

The order is intentionally conservative. Channel composer carries the most product
behavior, so it should not be the first surface rewritten unless the change is only a
rendering wrapper.

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
- Focused regression tests cover:
  - shared composer rendering and capability differences in normal/channel/private
    surfaces,
  - normal conversation send and recent conversation behavior,
  - private chat attachment and direct guidance behavior,
  - channel slash, mention, failed-send retry, pending-routing send, and active-run
    guidance behavior.

Deferred after this slice:

- Normal conversation still has no committed backend attachment/link-preview contract.
  The shared shell is ready for `previewNode`, but the payload should not grow until the
  daemon route supports those fields.
- Private chat permission changes are not sent to the daemon yet. Add this only with a
  teammate direct message permission snapshot contract.
- Shared slash picker state is still surface-owned. Channel keeps the richest picker;
  normal/private currently tokenize commands without sharing the channel picker state
  machine.
- `conversation-ui-react` extraction remains deferred until the Web-local props have
  stabilized across all three surfaces.
- Large channel message action tests still need separate synchronization with the newer
  shared `MessageActionBar` UI. That is outside the composer slice unless the PR also
  chooses to finish message action migration cleanup.

## Resolved Decisions

No unresolved product decision blocks Slice 1.

- Private model selection is not a composer feature. Private chat uses teammate/provider
  settings and may show read-only model status only.
- Channel authorization is visible in the first shared toolbar slice.
- Authorization uses the four permission presets from settings.
- If settings default to a custom policy, composer defaults to `custom`.
- Authorization is immutable for an active execution snapshot and can only change before
  send or for the next turn/run.
