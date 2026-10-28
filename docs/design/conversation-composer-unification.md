# Conversation Composer Unification

Status: active design addendum for shared conversation UI
Date: 2026-06-28
Permission UI contract updated: 2026-10-28 (supersedes the old four-preset composer menu)
Scope: channel composer, normal conversation composer, teammate private chat composer,
and future Desktop/PC conversation composers

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Multi-Agent Slash Commands](multi-agent-slash-commands.md)
- [Conversation Plan And Goal Modes](conversation-plan-and-goal-modes.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)

## Purpose

The conversation composer must become one shared product surface across channel,
normal conversation, and teammate private chat.

The current implementation already moved message rows, action bars, source icons,
teammate stacks, and empty states toward shared primitives. The composer is still split:

- channel owns the richest composer behavior in `WorkspaceClientView`,
- normal conversation owns a separate floating home composer,
- private chat uses `MessageComposer`, but with a narrower textarea-based behavior set.

That split makes future work drift. A user should not have to learn three different
input boxes for the same underlying action: send a message with files, slash commands,
runtime guidance, and optional approval context.

## Product Decision

Use one shared `ConversationComposer` system.

Behavior should align to the current channel composer because it has the broadest
functional contract. Visual treatment should align to the normal conversation composer
because it has the cleaner floating shell, softer border, and better focused input feel.

The unified composer is not three skins. It is one visual system with surface policies.
The surface decides which controls exist, but spacing, radius, shadow, input behavior,
pending asset chips, popovers, toolbar layout, and send/stop states stay identical.

## Delivery Slices

The implementation is split into seven product slices plus one delayed packaging stage:

1. Code audit and current-state checklist for channel, normal conversation, and teammate
   private chat composer state.
2. Shared composer shell and visual tokens.
3. Shared toolbar with one compact authorization control; independent sandbox defaults in Settings.
4. Normal conversation adapter, including model selection and no teammate mentions.
5. Teammate private chat adapter, including direct guidance and no model picker.
6. Channel adapter, preserving the richest `/`, `@`, attachment, approval, active run,
   stop, and follow-up behavior.
7. Tokenized input, preview strip, pending assets, slash/mention popovers, and visual
   parity convergence across all three surfaces.
8. Delayed extraction stage: expand `conversation-ui-core` only for stable pure policy,
   then consider a future `conversation-ui-react` package after the Web adapters stop
   changing.

This order is intentional. Shell and visual parity come before deeper policy extraction,
and channel moves after normal/private because it carries the largest behavior surface.

## Complete Component Architecture

The full target is a Conversation UI Kit, not only a shared input box. The kit has three
layers:

```text
packages/conversation-ui-core/
  surface-policy.ts
  composer-policy.ts
  message-actions.ts
  permission-types.ts

apps/web/src/shared/conversation/
  surface/
    ConversationSurface.tsx
    ConversationFeed.tsx
    ConversationEmptyState.tsx

  message/
    MessageRow.tsx
    MessageAvatar.tsx
    MessageActionBar.tsx
    MessageMeta.tsx
    MessageBody.tsx

  evidence/
    EvidenceBundle.tsx
    SourceIconStack.tsx
    WorkCell.tsx
    FileReferenceBlock.tsx

  composer/
    ConversationComposer.tsx
    ConversationComposerShell.tsx
    TokenizedComposerInput.tsx
    ComposerToolbar.tsx
    ComposerPermissionMenu.tsx
    ComposerPreviewStrip.tsx
    ComposerStatusStrip.tsx
    ComposerPopoverLayer.tsx
    composer-types.ts
    composer-policy.ts
```

The first implementation can remain Web-local, but the component boundaries should match
this target so the later `packages/conversation-ui-react` extraction is mechanical rather
than a second redesign.

### Layer Responsibilities

| Layer | Owns | Must not own |
| --- | --- | --- |
| `conversation-ui-core` | pure types, policy helpers, action filtering, permission preset mapping | React, daemon calls, app routing, channel stores |
| Web shared conversation components | rendering primitives, shared CSS classes, keyboard/focus behavior, popover placement | provider fetching, teammate mutation, channel routing |
| Surface adapters | mapping app state into shared props, send callbacks, model/provider state, active run status | redefining shared visual tokens or capability semantics |

The architecture should make these dependencies one-way:

```text
surface owner state
  -> surface adapter
    -> shared conversation components
      -> core policy helpers
```

Shared components must never import upward from daemon APIs, `WorkspaceClientView`,
teammate settings domains, route modules, or app shell navigation.

### Surface Adapters

| Adapter | Surface | Required mapping |
| --- | --- | --- |
| `ChannelComposerAdapter` | channel root/branch | text, slash commands, teammate mentions, attachments, active run guidance, stop/follow-up, compact authorization control, no model picker |
| `NormalConversationComposerAdapter` | normal conversation after home send | text, slash commands, attachments, selected model, thinking when supported, compact authorization control, no teammate mentions |
| `TeammateDirectComposerAdapter` | teammate private chat | text, slash commands, private-scoped attachments, direct guidance, compact authorization control, optional read-only teammate model status, no model picker, no teammate mentions |

Adapters own business state. `ConversationComposer` receives already-resolved props and
only renders the result.

### Attachment Scope Contract

The shared composer visual system does not mean shared attachment storage. Attachment
records stay scoped to their surface owner:

| Surface | Attachment owner | Required invariant |
| --- | --- | --- |
| Channel | `channel_attachments` | attachment belongs to the current channel/message |
| Normal conversation | `conversation_attachments` | attachment belongs to the current conversation thread/turn after send |
| Teammate private chat | teammate private attachments | attachment belongs to the private teammate thread/message |

Normal conversation attachments use their own contract and storage path. They must not
be faked as channel attachments or teammate private attachments just because the chip UI
is shared. Preview/content/delete routes may share global attachment endpoints. Preview
lookups must validate source scope when the caller supplies scope context. The first Web
slice keeps the existing id-plus-cwd content/delete compatibility for channel and private
attachments; making content/delete require explicit scope is a separate compatibility
slice, not part of the composer unification.

### Full Composer Props Target

The first slice may pass `authorizationNode`, `modelNode`, and `thinkingNode` slots to
avoid moving business logic too early. The stable target should become typed state:

```ts
type ConversationComposerSurface =
  | "channel"
  | "normal_conversation"
  | "teammate_direct";

type ConversationComposerSendState =
  | "idle"
  | "sending"
  | "active_run_empty_guidance"
  | "active_run_has_guidance"
  | "queued_guidance"
  | "approval_required"
  | "failed"
  | "uploading";

type ConversationPermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";

interface ConversationComposerAuthorizationState {
  readonly mode: "ask" | "smart" | "always";
  readonly preset: ConversationPermissionPreset;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly requiresConfirmation?: boolean;
}

interface ConversationComposerModelState {
  readonly label: string;
  readonly providerLabel?: string;
  readonly readonly: boolean;
}

interface ConversationComposerProps {
  readonly surface: ConversationComposerSurface;
  readonly capabilities: ConversationComposerCapabilities;
  readonly value: string;
  readonly placeholder: string;
  readonly inputParts: readonly ComposerInputPart[];
  readonly sendState: ConversationComposerSendState;
  readonly authorization: ConversationComposerAuthorizationState;
  readonly model?: ConversationComposerModelState;
  readonly attachments?: ConversationComposerAttachmentState;
  readonly slashCommands?: readonly ComposerSlashCommandOption[];
  readonly mentionOptions?: readonly ComposerMentionOption[];
  readonly statusNode?: ReactNode;
  readonly approvalNode?: ReactNode;
  readonly guidanceNode?: ReactNode;
  readonly previewNode?: ReactNode;
  readonly feedbackNode?: ReactNode;
  readonly onChange: (value: string, caret: number) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
  readonly onAuthorizationChange: (mode: "ask" | "smart" | "always") => void;
  readonly onModelChange?: (modelId: string) => void;
  readonly onAttachFiles?: (files: readonly File[]) => void | Promise<void>;
}
```

Rules:

- `onModelChange` is only valid when `capabilities.modelPicker` is true.
- Private chat passes `model.readonly = true` when showing model status.
- Channel usually omits `model`; if model status is shown, it is read-only explanatory
  copy, not a control.
- `authorization.disabled` must be true while the active execution snapshot exists.
- `requiresConfirmation` only describes UI flow; enforcement still belongs to the daemon
  policy snapshot.

## Hard Rules

1. Channel, normal conversation, and teammate private chat must use the same composer
   shell, input, toolbar, pending asset strip, status strip, and send button visual
   tokens.
2. The channel composer is the functional baseline. Do not remove channel capabilities
   while extracting the shared component.
3. Normal conversation and teammate private chat must not expose teammate `@` routing.
   They may tokenize typed text for files, URLs, and slash commands, but `@someone`
   remains plain text unless a future explicit product decision changes it.
4. Normal conversation can select a model from the composer. Teammate private chat
   cannot change model from the composer; it may show the teammate's effective
   provider/model as read-only status, and edits belong in teammate settings. Channel
   cannot select a model from the composer because channel teammates already own
   configured model/provider settings.
5. Authorization belongs in the shared composer toolbar for channel, normal
   conversation, and teammate private chat. It uses one shared compact control with
   Request approval, Help me approve, and Full access shortcuts. There is no separate
   composer sandbox selector. Task inspectors show permission details read-only and
   link to Settings instead of maintaining another sandbox editor.
6. Authorization defaults come from settings/surface defaults. If settings resolve to a
   custom policy, the composer starts on `custom`; do not silently coerce it into a
   friendlier preset.
7. Once a message is sent and a model/run/direct reply is active, authorization is locked
   for that active execution. A changed preset can only apply to the next turn/run after
   the current execution finishes.
8. Placeholder copy must reflect the surface capability. Do not show `@` instructions
   in surfaces where `@` is disabled.
9. The normal conversation floating shadow and soft rounded shell are the base style.
   Channel and private chat may be docked differently, but they must not introduce a
   separate visual language.
10. Active work guidance, inline approval, upload state, failed send retry, and stop
   controls render above or inside the same composer shell, not as unrelated page-local
   panels.
11. The composer must stay keyboard accessible. Hover-only controls need focus-visible
   equivalents.
12. The shared composer must not fetch daemon/channel/teammate state. Surfaces adapt
    their state into composer props.

## Surface Capability Matrix

| Capability | Channel | Normal conversation | Teammate private chat |
| --- | --- | --- | --- |
| Shared shell/style | Required | Required | Required |
| Tokenized input | Required | Required | Required |
| Plain textarea fallback | No, except accessibility fallback | No, except accessibility fallback | No, except accessibility fallback |
| `/` command picker | Yes | Yes | Yes |
| Teammate `@` picker | Yes | No | No |
| File upload | Yes | Yes | Yes |
| Drag and drop files | Yes | Yes | Yes |
| Pending file preview strip | Yes | Yes | Yes |
| Link preview chips | Yes | Yes | Yes when private preview exists |
| Workspace file refs | Yes | Yes | Yes, private-scoped |
| Model picker | No | Yes | No |
| Read-only model status | Optional | Optional | Yes if model identity is useful |
| Thinking mode picker | No by default | Yes when selected model supports it | No from composer; inherited from teammate settings/runtime |
| Authorization picker | Yes, locked while active | Yes, locked while active | Yes, locked while active |
| Inline approval strip | Yes | Yes | Yes |
| Active run guidance mode | Yes | Yes | Yes |
| Stop active run button | Yes | Yes | Yes when direct reply is running |
| Send shortcut | Enter sends, Shift+Enter newline | Same | Same |
| Surface-specific placeholder | Required | Required | Required |

## Placeholder Copy

Placeholders are part of the capability contract. They must not promise controls that
are disabled.

| Surface | Placeholder |
| --- | --- |
| Channel | `Message this channel... (type / for commands, @ to mention teammates)` |
| Normal conversation | `Message Ling Stack... (type / for commands)` |
| Teammate private chat | `Message this AI teammate privately... (type / for commands)` |

Chinese copy should follow the same boundary:

| Surface | Chinese placeholder |
| --- | --- |
| Channel | `输入消息...（输入 / 唤起命令，@ 队友协作）` |
| Normal conversation | `输入消息...（输入 / 唤起命令）` |
| Teammate private chat | `私聊这位队友...（输入 / 唤起命令）` |

## Unified Visual Contract

### Shell

The composer shell should use one shared class family:

```text
conversation-composer
conversation-composer-surface-channel
conversation-composer-surface-normal
conversation-composer-surface-direct
conversation-composer-density-floating
conversation-composer-density-docked
```

Shared shell tokens:

| Token | Target |
| --- | --- |
| Background | `var(--surface-panel)` or a shared composer panel token |
| Border | `1px solid var(--border)` |
| Radius | 18-20px for the outer shell |
| Shadow | floating soft shadow from normal conversation composer |
| Padding | 8-10px outer, consistent across surfaces |
| Focus | accent border plus one subtle focus ring |
| Width | align to the conversation content column, never narrower than the feed |
| Overflow | popovers and preview strips may overflow; shell body must not clip menus |

Channel is allowed to be positioned in a docked bottom slot. It is not allowed to look
like a different component. Private chat is allowed to be narrower because the chat pane
is narrower; it still uses the same tokens and control sizes.

### Input Area

The input area uses `TokenizedComposerInput` as the default.

Requirements:

- minimum height is shared across surfaces,
- text wraps and never causes horizontal scroll except code/file preview internals,
- slash command, file reference, URL, and optional mention tokens use the same chip
  colors and shape,
- disabled mention support means no mention picker and no mention token parsing,
- drag-over state uses the same accent background and drop hint,
- the shared input owns clipboard parsing: files are always prevented from entering the
  contenteditable DOM and are delivered through `onPasteFiles`; file extraction checks
  `DataTransfer.files` and falls back to file-kind `DataTransfer.items`,
- text paste inserts `text/plain` only; clipboard HTML, raw `<img>` nodes, and other rich
  DOM fragments are never inserted,
- the editable root uses the browser `plaintext-only` contenteditable mode as a native
  backstop; attachment rendering is exclusively owned by `ComposerPendingAssetStrip`.

Paste, attach-button selection, and drag/drop must converge on the surface attachment
controller. A surface cannot add a second clipboard parser around the shared input, and
`TokenizedComposerInput` does not expose a page-level `onPaste` compatibility hook.

### Toolbar

The toolbar has two zones:

```text
left tools: attach, optional mention, authorization, optional extra tools
right tools: model/thinking controls when editable, read-only model status when useful, send/stop button
```

Toolbar rules:

- icon buttons are 30-32px with transparent default background,
- all three surfaces offer Request approval, Help me approve, and Full access
  shortcuts in their compact permission menu. Independent authorization and sandbox
  defaults remain in Settings. Request approval and Help me approve preserve the
  selected sandbox; Full access sets both always authorization and full access only
  after confirmation. Returning from that shortcut restores the prior sandbox, or
  the workspace default when restoring an existing conversation;
  channel and private chat use the same shared `ConversationPermissionControl`,
  with no independent sandbox picker in any composer. Settings owns the sandbox
  default for the selected workspace, not an implicit machine-wide grant. The
  shared presentation does not merge conversation authorization scopes. Pending
  confirmations are discarded on owner/policy changes, permission changes, active
  execution or unmount; returning to the same owner must not revive an old reply,
- model picker is right aligned and appears only for normal conversation,
- teammate private chat can show read-only effective model status, but not a model
  picker,
- channel does not show a disabled model picker,
- send button is the same shape and size across all surfaces,
- stop button uses the same send-button slot and swaps icon/state.

### Popovers

Mention picker, slash command picker, authorization menu, model menu, and thinking menu
must share:

- border radius,
- border token,
- panel shadow,
- row hover/focus treatment,
- max-height and overflow behavior,
- keyboard selection rules.

The popover anchor differs by control, not by surface-specific CSS.

## Behavior Contract

### Slash Commands

All three surfaces support slash commands, but execution context differs:

- channel slash commands may target channel teammates or multi-agent work,
- normal conversation slash commands target the selected assistant/model context,
- private chat slash commands target the selected teammate/private context.

The parser should receive `surface` and `allowedTargets` so it can disable invalid
targets before rendering executable tokens.

### Mentions

Only channel surfaces allow teammate mentions.

Normal conversation and private chat:

- do not show the `@` toolbar button,
- do not open mention picker on `@`,
- do not include teammate mention options in `parseComposerInputParts`,
- do not convert typed `@name` into teammate route metadata,
- can still display `@name` as plain typed text.

### Model Selection

Normal conversation:

- shows selected provider/model,
- shows thinking mode only when supported by the selected model,
- sends provider preset and thinking level with the conversation message.

Teammate private chat:

- shows the teammate's effective provider/model,
- does not allow model switching from the composer,
- uses the teammate's configured model/provider and any runtime router decision,
- edits to the teammate's persistent provider/model happen only in teammate settings,
- must not mutate channel teammate model settings accidentally.

Channel:

- hides model picker,
- uses channel membership, teammate settings, and router policy,
- may expose a read-only tooltip such as `Channel teammate models are configured in settings`.

### Authorization

All conversation composers expose the same compact authorization menu next to the
attach button. Settings keeps authorization and sandbox as independent defaults;
it saves them for the selected workspace, not as a machine-wide authorization grant.

| Shortcut | Authorization | Sandbox |
| --- | --- | --- |
| Request approval | `ask` | Preserve current sandbox; restore the previous sandbox when leaving Full access. |
| Help me approve | `smart` | Preserve current sandbox; restore the previous sandbox when leaving Full access. |
| Full access | `always` | Change to `full_access` only after explicit confirmation for this conversation. |

If the prior sandbox is unavailable after restoring a conversation, leaving Full
access uses the workspace default. An inherited `always` with a restricted sandbox
is not the Full access shortcut: preserve and distinguish that combination rather
than silently broadening access. Legacy preset fields remain transport projections,
not another editable composer control. UI reuse does not combine the authorization
scope of a channel, ordinary thread or teammate direct conversation.

Default resolution:

- surface-specific saved default, if present,
- conversation/thread/channel default, if present,
- workspace settings default,
- `custom` when the effective settings policy is custom or cannot be mapped cleanly to a
  preset.

Runtime lock:

- authorization is editable only while the composer has no active send/run/direct reply,
- while `sending`, `active_run_*`, `queued_guidance`, `approval_required`, or an active
  direct reply exists, the trigger stays visible but disabled with a tooltip such as
  `Authorization is locked for the running reply`,
- any user request to change authorization during active execution must be deferred to
  the next turn/run, not applied to the current model call,
- `full_access` still requires explicit confirmation before starting the run, even if the
  trigger is visible.

This borrows Codex's useful authority shape: configuration selects the default,
pre-execution UI can choose the next execution profile, and the active execution uses an
immutable permission snapshot. The authorization trigger is visual, not a permission
override. Existing `PermissionPreset`, `SessionPermissionMode`, `ApprovalPolicy`, and
effective policy snapshots remain the source of truth for execution.

### Active Work

The shared composer owns these active states:

- `idle`
- `sending`
- `failed`
- `active_run_empty_guidance`
- `active_run_has_guidance`
- `queued_guidance`
- `approval_required`
- `uploading`

Those presentation states are driven by one request lifecycle shared by channel, normal
conversation, and teammate private chat:

```text
idle -> submitting -> message_accepted -> reply_linked -> settled
                       \-> failed after accept: do not restore the original payload
       \-> failed_before_accept: restore the original draft and pending assets
```

`reply_linked` means the daemon has durably linked both the real `RunSession` and its
supervising WorkUnit. The first active status can be `queued`; the UI must not wait for
`running` or the first text delta before unlocking guidance. Every submit has an independent
request identity: two rapid guidance submits may remain in flight together, and completion of
one cannot invalidate, clear, or restore the other's draft snapshot. Stale events are scoped
by surface owner, while transient SSE targets reconcile with authoritative runtime data by
`runId` without constructing a fake full `RunSession`. Older fetched Run details cannot
overwrite a newer terminal list snapshot.

For a channel send that owns an idle reply lane, `reply_pending` follows `message_accepted`
before potentially slow materialization, intent selection, provider preparation, or Run
creation. It carries only the accepted source message id, canonical target teammate id, and
timestamp. A send that discovers an active lane emits no `reply_pending`; its terminal stream
result moves the optimistic row into the durable guidance queue. That row adopts the durable
intervention id and remains visible while the next intervention refresh is in flight; it is
retired only when the authoritative queue owns the same id or the source message enters the
transcript.

For channel only, the daemon may temporarily hold dispatch ownership before `reply_linked`
while the first message is materialized and routed. That process-local lane is keyed by
workspace, channel, and conversation line. A rapid submit may follow only the existing
predecessor, wait for linkage, and then enter the durable follow-up FIFO; a mode-only request
without a predecessor returns to normal intent routing. This process-local lane
does not create a UI state, a second queue, or another persistence contract.
The queue payload, pending reply, WorkUnit, and Run must use canonical teammate ids. No
mention is always `ling_agent`; the generic author type string `ai-teammate` is never a valid
executor fallback.

When active work exists:

- channel typed text remains a durable message; the daemon's mention resolver records who
  should handle it when its FIFO turn arrives,
- no AI mention targets Ling Agent, one AI mention targets that teammate, and multiple AI
  mentions return to Ling Agent for coordination,
- Root, Branch, Topic, and explicit Thread lines have independent active reply lanes; only an
  explicit same-line disposition queues, even when it targets another idle teammate; empty
  send may stop the active reply on that line,
- message wording never changes queue guidance into interruption,
- no previous target selection can leak into a later unmentioned message because the Web
  stores no independent target selection,
- normal conversation and teammate-private typed text continue to target their one active
  owner Run.

The default visual projection stays lightweight:

- normal conversation and a channel with active replies do not render a standalone run
  summary card or an empty guidance panel above the composer;
- channel targeting stays in the ordinary mention input; no "Guide whom" selector is
  rendered;
- approvals, provider blockers, and other actionable exceptions may still render a
  persistent status strip;
- accepted channel guidance is projected from its durable `RunIntervention`, not a second
  client-only queue;
- if an earlier send is still settling, the next send is projected as guidance immediately;
  it does not wait for asynchronous active-Run refresh and never flashes as a transcript row;
- while queued it appears once in the Composer guidance queue and its source message is hidden
  from the transcript; at `starting_continuation` the same source message enters the transcript;
- it has no success toast and cannot be promoted ahead of earlier FIFO items;
- run details remain available from the right-side evidence/detail surfaces and do not
  return to the composer.

Channel activity transitions use initial-load feedback only. Once a channel scope has
loaded, control-plane and run updates refresh retained data silently instead of flashing a
loading row in the message feed. A Run whose referenced WorkUnit is between refresh snapshots
is also hidden from default chat until ownership resolves, so completed operation status does
not appear and disappear between polling responses.

Draft recovery follows acceptance, not transport completion. A failure before
`message_accepted` restores text and pending assets. A failure after acceptance keeps them
consumed so an uncertain network tail cannot duplicate a durable user message. Network send
latency does not disable channel text entry or submission; only unresolved attachment or link
materialization blocks a payload that depends on those assets.

## Component Boundary

Target shared component:

```ts
type ConversationComposerSurface = "channel" | "normal_conversation" | "teammate_direct";

interface ConversationComposerProps {
  readonly surface: ConversationComposerSurface;
  readonly density?: "floating" | "docked";
  readonly value: string;
  readonly inputParts: readonly ComposerInputPart[];
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly sendState: ConversationComposerSendState;
  readonly capabilities: ConversationComposerCapabilities;
  readonly attachments?: ConversationComposerAttachmentState;
  readonly linkPreviews?: ConversationComposerLinkPreviewState;
  readonly fileRefs?: ConversationComposerFileRefState;
  readonly slashCommands?: readonly ComposerSlashCommandOption[];
  readonly mentionOptions?: readonly ComposerMentionOption[];
  readonly authorization?: ConversationComposerAuthorizationState;
  readonly model?: ConversationComposerModelState;
  readonly thinking?: ConversationComposerThinkingState;
  readonly guidance?: ConversationComposerGuidanceState;
  readonly approvals?: ConversationComposerApprovalState;
  readonly feedback?: ConversationComposerFeedbackState;
  readonly onChange: (value: string, caret: number) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
  readonly onAttachFiles?: (files: readonly File[]) => void | Promise<void>;
}

interface ConversationComposerCapabilities {
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
```

The component renders controls only from `capabilities`. It does not inspect route names
or infer behavior from `surface` alone.

## Implementation Notes

The first implementation should extract shared UI without moving all channel state
management at once.

Recommended adapters:

- `ChannelComposerAdapter` in `WorkspaceClientView` maps channel state to
  `ConversationComposerProps`,
- `NormalConversationComposerAdapter` in `ConversationHome` maps provider/model,
  authorization, and slash state,
- `TeammateDirectComposerAdapter` in `TeammatePrivateChatSurface` maps private
  attachments, direct guidance, authorization, and read-only teammate provider/model
  state.

The channel composer logic can remain in `WorkspaceClientView` initially. The first
slice should move rendering and shared control behavior, not daemon routing.

## Regression Contract

Every implementation slice must prove:

- the three surfaces use the same root class family,
- channel still supports `/`, `@`, attachments, pending previews, active guidance, and
  inline approvals,
- normal conversation supports `/`, attachments, model, thinking, authorization, and no
  `@` picker,
- private chat supports `/`, attachments, authorization, optional read-only model status,
  direct guidance, and no `@` picker,
- channel renders authorization and does not render a model picker,
- authorization is disabled while each surface has an active send/run/direct reply,
- placeholder copy differs by surface,
- visual shell tokens match across surfaces,
- keyboard send and picker navigation still work.

## Current Implementation Note - 2026-06-28

The first Web-local implementation now shares the composer shell and permission menu
across channel, normal conversation, and teammate private chat. Normal conversation and
teammate private chat use `TokenizedComposerInput`; channel already used it and now routes
that input through the shared shell.

The shared tokenized input also owns controlled paste, and all three surfaces now use one
owner-scoped send lifecycle. Message acceptance consumes the optimistic payload;
durable reply linkage, including `queued`, releases the Composer into guidance mode while
the original SSE stream continues.

Important boundary:

- Normal, channel and private adapters submit both the selected `authorizationMode`
  and `workspaceAccessMode` through their existing request paths, together with the
  derived legacy fields and scope-bound Full access confirmation where required.
- Channel updates both dimensions in one state transition. Private selection updates
  its paired local/owner state together; it cannot display Full access while sending
  a restricted sandbox or preserve a stale approval result after changing owner.
- Normal/private do not expose teammate `@` routing. Channel remains the only surface
  with teammate mention picker behavior.

## Resolved Decisions

No blocking product decision remains for the first design slice.

- Teammate private chat does not change model from the composer. The model is owned by
  teammate/provider settings and may be shown read-only.
- Channel authorization is not hidden. Channel, normal conversation, and teammate private
  chat all use one `ConversationPermissionControl`; sandbox defaults remain in Settings.
- The default authorization preset comes from settings. A configured custom policy
  resolves to `custom`.
- Authorization cannot change the permission snapshot of an active model call/run/direct
  reply. Changes apply only before send or to the next execution.
