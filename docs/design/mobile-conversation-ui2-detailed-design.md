# Mobile Conversation UI 2.0 Detailed Design

Status: design-ready for native implementation; live protocol expansion still required
Date: 2026-07-31
Parent: [Ling Mobile Remote Access](mobile-remote-access.md)

## Outcome

Ling Mobile V1 is a narrow remote conversation surface for the conversations that already
exist on the paired PC. It synchronizes three conversation kinds:

- **Channel**: a shared Ling channel with multiple participants.
- **Conversation**: a normal one-to-one user and Ling conversation.
- **Teammate direct**: a private conversation with one AI teammate.

The mobile product does not create three separate feature areas. It has one conversation
index and one shared conversation detail surface. Conversation kind changes identity,
participants, subtitle, and message attribution, but not the navigation or composer model.

V1 supports reading synchronized history, receiving live updates, unread state, retaining
an unsent local draft, and sending plain text while connected. The PC daemon remains the
authority for message identity, ordering, execution, teammate identity, and retention.

## Product Principles

1. **Conversation first.** Opening the app should reveal recent PC conversations, not a
   remote-control dashboard.
2. **One model, three identities.** Channel, normal, and teammate-direct conversations
   share components and state transitions instead of diverging into separate products.
3. **PC authority stays visible.** The app says whether content is synchronized, stale,
   reconnecting, or unavailable. Cached content is never presented as live.
4. **UI 2.0 semantics, native interaction.** Reuse the Ling theme, message hierarchy,
   identity language, and headless policies; implement native React Native components.
5. **Subtract by default.** V1 has no remote task controls, approval actions, attachments,
   file browser, terminal, settings workspace, or Computer Use surface.

## Information Architecture

```text
App launch
  |
  +-- authenticated and paired ------------------------------+
  |                                                          |
  |                                                          v
  |                                                Conversation index
  |                                                - All
  |                                                - Channels
  |                                                - Conversations
  |                                                - Direct
  |                                                          |
  |                                                          v
  |                                                Conversation detail
  |                                                - Header identity
  |                                                - Synced transcript
  |                                                - Plain-text composer
  |
  +-- reconnecting/offline -> index with honest sync state and cached rows
  |
  +-- revoked/unpaired ----> existing secure pairing flow, outside this UI slice
```

There is no bottom tab bar in V1. The app is a two-level navigation stack. A persistent
tab bar would spend scarce screen space on features that do not exist yet.

## Screen 1: Conversation Index

### Hierarchy

The user sees, in order:

1. **Title and synchronization truth**: `会话` plus `已同步`, `正在连接`, or `离线`.
2. **Conversation-kind filter**: `全部`, `频道`, `会话`, `私聊`.
3. **A single activity-sorted list** spanning all three conversation kinds.

Search, creation, editing, sorting controls, workspace selection, and administration are
not present in V1.

### Phone Wireframe

```text
+--------------------------------------+
|  会话                         已同步  |
|  我的 Mac · 刚刚                      |
|                                      |
| [全部]   频道    会话    私聊          |
|--------------------------------------|
|  #   Ling Mobile UI              10:42|
|      频道 · 4 位成员                   |
|      已同步最新页面设计……            2 |
|--------------------------------------|
|  L   新对话                       09:18|
|      会话                             |
|      我们先确认消息同步边界……          |
|--------------------------------------|
| [N]  Noah                         昨天 |
|      私聊 · 系统架构师                 |
|      Remote Gateway 的边界是……        |
|--------------------------------------|
|          正在重新连接到 PC…            |
+--------------------------------------+
```

### Conversation Row

Each row is a single 72-84 pt touch target with no decorative card container.

| Element | Requirement |
| --- | --- |
| Leading identity | 40 pt; channel glyph, Ling mark, or teammate avatar. |
| Primary title | One line, semibold, ellipsized after available width. |
| Kind label | Text plus icon semantics; color is never the only distinction. |
| Preview | Latest display-safe plain text, one line, paths and tool detail redacted. |
| Time | Relative on recent items, localized date for older items. |
| Unread | Compact count badge; hidden when zero; `99+` maximum label. |
| Activity order | Latest authoritative message timestamp, descending. |

Type-specific presentation:

| Kind | Leading identity | Subtitle | Detail header |
| --- | --- | --- | --- |
| `channel` | `#` in a neutral Ling surface or channel avatar | `频道 · N 位成员` | Channel name and member count |
| `conversation` | Ling mark | `会话` | Conversation title and `与 Ling 对话` |
| `teammate_direct` | Teammate avatar/initials | `私聊 · <role>` | Teammate name, role, and presence summary |

### Index States

| State | What the user sees | Available action |
| --- | --- | --- |
| Initial loading | Six quiet skeleton rows; title remains visible. | None. |
| Empty | `PC 上还没有会话` and `在 PC 端开始对话后会出现在这里`. | Refresh connection only. |
| Filter empty | `没有频道/会话/私聊` and a return-to-all action. | `查看全部`. |
| Reconnecting | Cached rows remain visible with a top status strip. | Retry automatically; manual retry after timeout. |
| Offline | Cached rows are labeled with last sync time; never shown as current. | `重新连接`. |
| PC unavailable | Clear PC name and last-seen time. | `重试`. |
| Revoked | Conversation data is cleared and the pairing state takes over. | Pair locally again. |
| Partial sync | Rows received so far plus `正在补齐较早的会话`. | Continue browsing received rows. |

## Screen 2: Conversation Detail

### Hierarchy

The user sees, in order:

1. Back navigation and conversation identity.
2. Synchronization state only when it needs attention.
3. Transcript, anchored at the newest unread or latest message.
4. Plain-text composer fixed above the keyboard and bottom safe area.

The header has no overflow menu in V1 because there are no secondary conversation
actions. It shows a back button, 32 pt identity, title, kind-specific subtitle, and a
non-interactive sync indicator.

### Phone Wireframe

```text
+--------------------------------------+
| <   #  Ling Mobile UI                |
|        频道 · 4 位成员        已同步  |
|--------------------------------------|
|                                      |
| [N] Noah · 10:18                     |
|     三类会话应该共享同一个详情页。     |
|                                      |
|                    先按这个方向设计。 |
|                               10:21  |
|                                      |
| [L] Ling · 正在回复                  |
|     我会保留 UI 2.0 的消息层级……      |
|                                      |
|------------ 2 条新消息 --------------|
|                                      |
|--------------------------------------|
|  发消息…                       [发送] |
+--------------------------------------+
```

### Transcript Rules

- Peer and teammate messages are left-aligned with a 30 pt avatar and author metadata.
- Local-user messages are right-aligned on the UI 2.0 subtle surface, not a saturated
  chat-app color bubble.
- Message width is capped at 84% of the phone content width.
- Body text is at least 16 pt with a 1.5 line-height; desktop's denser 13 px body is not
  copied to Mobile.
- Adjacent messages from the same author within five minutes form one visual group while
  preserving every authoritative message id.
- Channel messages always retain author identity. Normal-conversation assistant messages
  use `Ling`. Teammate-direct messages use the teammate identity.
- System and synchronization events are centered, quiet, and never impersonate chat
  messages.
- Plain text, headings, lists, links, inline code, fenced code, and quotes may reuse the
  DOM-free message parser. Mermaid, KaTeX dialogs, local-file open actions, attachments,
  work cells, terminal reports, and evidence views are not rendered in V1.
- A streaming message shows the UI 2.0 inline progress treatment and remains one message;
  it does not append a new list row per delta.

### Composer

- Multiline plain-text input, one to five visible lines.
- 16 pt text prevents iOS zoom-like readability problems and respects Dynamic Type.
- Send control is at least 44 x 44 pt and has a text accessibility label.
- Return inserts a newline; the explicit send control sends.
- The draft is retained locally per conversation across navigation and short reconnects.
- There is no offline mutation queue. While disconnected, the draft stays editable but
  send is disabled with `连接 PC 后发送`.
- Sending uses an optimistic local row only after a durable `commandId` exists. The row
  exposes `发送中`, `已发送`, or `发送失败`; retry reuses the same command id.
- No attachment, slash-command, model, provider, permission, voice, or tool controls.

### Detail States

| State | Transcript | Composer |
| --- | --- | --- |
| Loading snapshot | Header plus anchored skeleton lines. | Disabled. |
| Empty transcript | `还没有消息` and kind-specific guidance. | Enabled when connected. |
| Live | Ordered snapshot plus deltas. | Enabled. |
| Reconnecting | Cached transcript with a status strip. | Draft editable, send disabled. |
| Missing event range | `正在重新同步…`; fetch a fresh snapshot. | Disabled until authoritative baseline returns. |
| Send pending | One optimistic local message with progress. | Enabled for a later message only if client ordering permits it. |
| Send failed | Failed row remains with concise reason and retry. | Draft is not duplicated. |
| Revoked | Transcript leaves memory immediately. | Removed; pairing state takes over. |

## Synchronization Language

The UI uses one shared state vocabulary:

| Internal state | User-facing label | Tone |
| --- | --- | --- |
| `online` | `已同步` | Neutral, usually hidden in detail after stability. |
| `connecting` | `正在连接…` | Neutral progress. |
| `reconnecting` | `正在重新连接…` | Warning only after a short grace period. |
| `offline` | `离线 · 上次同步 <time>` | Warning. |
| `pc_unavailable` | `<PC name> 不可用` | Warning with retry. |
| `syncing_snapshot` | `正在同步会话…` | Neutral progress. |
| `revoked` | `此设备已取消配对` | Danger; clear cached content. |
| `protocol_error` | `需要更新 Ling` | Danger; no fallback to the broad daemon API. |

Connection state is a status strip, not a third primary page. Pairing remains a separate
security flow already defined by Mobile Remote Access and is outside this visual slice.

## UI 2.0 Native Token Mapping

Mobile copies semantic values into an app-local typed theme. It does not parse CSS or
import `@ling-stack/conversation-ui-react`.

| Mobile token | UI 2.0 light | UI 2.0 dark | Usage |
| --- | --- | --- | --- |
| `background.app` | `#f6f7f8` | `#111315` | Root surface |
| `background.panel` | `#ffffff` | `#171a1d` | Header, list, transcript |
| `background.subtle` | `#f1f3f5` | `#22262b` | Own message, filters |
| `background.pressed` | `#e8ebee` | `#2c3137` | Pressed rows |
| `text.strong` | `#121417` | `#f4f5f6` | Titles and authors |
| `text.default` | `#2b3036` | `#d7dbe0` | Message body |
| `text.muted` | `#68707a` | `#9ba3ad` | Preview and metadata |
| `border.default` | `#d9dde2` | `#353b42` | Hairline separators |
| `action.accent` | `#17191c` | `#f0f2f4` | Send and selected filter |
| `status.info` | `#466b91` | `#8cb5df` | Synchronizing state |
| `status.warning` | `#8a5d12` | `#ddb45f` | Offline/reconnecting |
| `status.danger` | `#a13e3b` | `#e48782` | Revoked/protocol failure |

Native layout scale:

- spacing: `2, 4, 8, 12, 16, 20, 24, 32` pt;
- radii: `6, 10, 14, 999` pt, assigned by hierarchy rather than uniformly;
- body: `16/24`, metadata: `12/16`, row title: `16/20`, screen title: `28/34`;
- separators use platform hairline width; shadows are reserved for the floating composer
  boundary, not every row.

## What Already Exists

| Existing asset | Mobile reuse |
| --- | --- |
| `packages/conversation-ui-core` | Reuse DOM-free message parsing, composer policies, surface policy, and compatible view models. |
| `packages/conversation-ui-react` | Reference semantics and hierarchy only; never import ReactDOM components or CSS. |
| `packages/ui-react` built-in Ling themes | Copy reviewed semantic values into typed app-local native themes. |
| `packages/contracts` | Reuse existing identities and transcript semantics where they are platform-neutral. |
| `packages/remote-protocol` | Reuse validation, signing, sequence, replay, and command-idempotency behavior. |
| Existing secure-device-key module | Keep pairing/auth identity separate from screen and conversation state. |
| UI 2.0 normal/channel/teammate surfaces | Preserve the distinct author and conversation-kind semantics through one native shell. |

## Native Module Boundaries

```text
apps/mobile/src/
  navigation/
    MobileConversationNavigator.tsx
  features/conversations/
    domain/
      conversation-types.ts
      conversation-list-projection.ts
    data/
      MobileConversationAdapter.ts
    screens/
      ConversationIndexScreen.tsx
      ConversationDetailScreen.tsx
    components/
      ConversationKindFilter.tsx
      ConversationListRow.tsx
      ConversationHeader.tsx
      NativeMessageRow.tsx
      PlainTextComposer.tsx
      SyncStatusStrip.tsx
      ConversationEmptyState.tsx
    state/
      useConversationIndex.ts
      useConversationDetail.ts
      useConversationDrafts.ts
  theme/
    mobile-theme.ts
    mobile-theme-provider.tsx
```

Responsibilities stay separated:

- screens compose layout and navigation only;
- hooks expose index/detail state and commands without parsing wire frames;
- `MobileConversationAdapter` maps validated remote projections to view models;
- `conversation-ui-core` supplies compatible DOM-free parsing and policies;
- protocol validation, reconnection, ordering, and command receipts remain outside UI;
- native theme values are app-local until a second native consumer exists.

## Required Remote Projection Evolution

The implemented Slice 1 wire protocol is currently channel-specific. The UI must not
rename channel DTOs and pretend they cover all conversation kinds. Before live V1
integration, add a versioned remote conversation projection such as:

```ts
type RemoteConversationKindV1 = "channel" | "conversation" | "teammate_direct";

interface RemoteConversationSummaryV1 {
  readonly conversationId: string;
  readonly kind: RemoteConversationKindV1;
  readonly title: string;
  readonly subtitle?: string;
  readonly latestPreview?: string;
  readonly latestMessageAt?: string;
  readonly unreadCount: number;
  readonly identity?: RemoteConversationIdentityV1;
}

interface RemoteConversationSnapshotV1 {
  readonly conversation: RemoteConversationSummaryV1;
  readonly messages: readonly RemoteConversationMessageV1[];
  readonly baselineSequence: number;
}
```

The exact contract belongs in the protocol design slice. It must preserve:

- opaque ids instead of `cwd` or local paths;
- an explicit PC-side allowlist for all three conversation kinds;
- participant/author identity without exposing teammate-private memory or workspace data;
- the same durable idempotency and ordered resume behavior as channel commands;
- a server-owned authority ceiling that prevents Mobile text from starting tools or
  workflows regardless of conversation kind.

## Accessibility and Platform Behavior

- All interactive targets are at least 44 x 44 pt.
- Support iOS Dynamic Type and Android font scaling without clipping row titles or
  composer controls at 200% text size.
- VoiceOver/TalkBack row labels announce kind, title, latest author, preview, time, and
  unread count in that order.
- Unread and connection state use labels/icons as well as color.
- Body text contrast is at least 4.5:1 in both built-in themes.
- Safe-area insets protect headers and composer; keyboard avoidance never covers the
  latest local message or send control.
- Back gestures first dismiss the keyboard, then return to the index without losing the
  draft.
- Reduced Motion removes streaming shimmer and animated row insertion while retaining
  progress labels.
- Long titles, CJK, emoji, mixed RTL content, code blocks, and `99+` unread counts are
  included in fixture coverage.

## User Journey

| Step | User action | Expected feeling | Design support |
| --- | --- | --- | --- |
| 1 | Opens Ling Mobile away from the PC | Oriented | Recent conversations appear immediately with honest sync status. |
| 2 | Scans channel, normal, and direct conversations | In control | One list, clear type identity, activity order, unread counts. |
| 3 | Opens a conversation | Continuous with PC | Same transcript identity and ordering, phone-native hierarchy. |
| 4 | Sends plain text | Confident | Durable send state and no hidden workflow/tool escalation. |
| 5 | Loses connectivity | Not misled | Cached content remains readable but visibly stale; draft is preserved. |
| 6 | Reconnects | Reassured | Snapshot recovery removes ambiguity and avoids duplicate messages. |

## NOT in Scope

- Conversation creation, rename, archive, delete, pinning, search, or administration.
- Attachments, voice, camera, rich composer commands, model/provider/permission controls.
- Remote approvals, run control, tasks, work cells, files, terminal, artifacts, or
  Computer Use.
- Teammate profile editing, memory, activity inspector, channels tab, or private files.
- Workspace selection or exposure of local filesystem paths.
- Push-notification design beyond content-free connection plumbing.
- Tablet, split-view, landscape multi-column, watch, or desktop-native layouts.

## Acceptance Criteria

- A user can distinguish channel, normal, and teammate-direct conversations without
  relying on color.
- All three kinds use the same index row, detail shell, transcript primitives, composer,
  drafts, and connection states.
- Index and detail remain usable at 320 pt width and 200% font scale.
- Cached data is never presented as current during reconnect/offline states.
- Plain-text send has pending, success, failure, and same-command retry states.
- No out-of-scope control is visible in the two primary screens.
- Native source contains no `apps/web`, ReactDOM, DOM API, or Web CSS imports.
- Light and dark themes map from UI 2.0 semantic values through typed native tokens.
- Fixtures cover three conversation kinds plus loading, empty, partial, offline,
  reconnecting, send-failed, and revoked states.
- The live implementation does not ship until the channel-only protocol has a reviewed
  generic conversation projection and authorization policy.

## Implementation Tasks

- [ ] **T1 (P1)** — Remote contracts — define generic conversation summary, snapshot,
  delta, authorization, and send-command contracts for all three kinds without weakening
  the existing Gateway boundary.
  - Files: `packages/contracts/src/remote-access.ts`, `packages/remote-protocol/src/`.
  - Verify: shared fixtures validate all three kinds, field mutation, allowlist rejection,
    ordered resume, and same-command retry.
- [ ] **T2 (P1)** — Mobile theme — add the typed light/dark UI 2.0 native token map and
  font/spacing/radius scale.
  - Files: `apps/mobile/src/theme/`.
  - Verify: token unit tests plus light/dark screenshots at 320 and 390 pt widths.
- [ ] **T3 (P1)** — Conversation index — build the unified list, type filters, row
  identities, unread state, and loading/empty/offline/partial states with fixtures.
  - Files: `apps/mobile/src/features/conversations/`.
  - Verify: component tests cover the three kinds and every index state in this design.
- [ ] **T4 (P1)** — Conversation detail — build the shared header, virtualized transcript,
  native message rows, per-conversation drafts, and plain-text composer.
  - Files: `apps/mobile/src/features/conversations/`.
  - Verify: fixture tests cover grouping, streaming, reconnect, resync, pending/failure,
    same-command retry, and draft retention.
- [ ] **T5 (P1)** — Accessibility and platform QA — verify safe areas, keyboard avoidance,
  Dynamic Type/font scaling, VoiceOver/TalkBack labels, reduced motion, and contrast.
  - Files: Mobile component tests and platform acceptance evidence.
  - Verify: iOS simulator and physical iPhone first; Android emulator for layout and a
    physical Android device before release security acceptance.
- [ ] **T6 (P2)** — Live Remote Gateway integration — connect the reviewed conversation
  projection to the two screens without moving protocol logic into UI hooks.
  - Files: `packages/remote-client/`, daemon remote-access modules, Mobile adapter/hooks.
  - Verify: PC-originated/mobile-originated sync, sleep/wake, reconnect, resync, revoke,
    and duplicate-command E2E scenarios.

## Design Review Result

The previous plan was 4/10 for Mobile UI completeness: it listed broad screens, retained
channel-only information architecture, and deferred visual decisions. This document raises
the plan to 9/10 by fixing information hierarchy, state coverage, the end-to-end user
journey, UI 2.0 token alignment, native component boundaries, responsive behavior, and
accessibility. The remaining point is live visual QA on iOS and Android implementations;
it cannot be proven by a design document.

NO UNRESOLVED DESIGN DECISIONS
