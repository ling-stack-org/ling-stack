# Mobile Conversation UI 2.0 Detailed Design

Status: design-ready for native implementation; shared message semantics plus approval and
creation extensions pending
Date: 2026-08-01
Parent: [Ling Mobile Remote Access](mobile-remote-access.md)

## Outcome

Ling Mobile V1 is a narrow remote conversation surface for the paired PC. It synchronizes
and can safely start three conversation kinds:

- **Channel**: a shared Ling channel with multiple participants.
- **Conversation**: a normal one-to-one user and Ling conversation.
- **Teammate direct**: a private conversation with one AI teammate.

The mobile product does not create three separate feature areas. It has one conversation
index and one shared conversation detail surface. Conversation kind changes identity,
participants, subtitle, and message attribution, but not the navigation or composer model.

V1 supports secure first-time pairing, reading synchronized history, receiving live
updates, unread state, retaining an unsent local draft, sending plain text while connected,
starting a normal/teammate-direct conversation with its first message, creating a basic
channel, adding an existing teammate, resolving eligible durable approvals, and a minimal
personal surface for the synced user identity and Mobile appearance. The PC daemon remains
the authority for message identity, ordering, execution, approvals, teammate identity,
user profile, runtime defaults, and retention.

## Product Principles

1. **Conversation first.** Opening the app should reveal recent PC conversations, not a
   remote-control dashboard.
2. **One model, three identities.** Channel, normal, and teammate-direct conversations
   share components and state transitions instead of diverging into separate products.
3. **PC authority stays visible.** The app says whether content is synchronized, stale,
   reconnecting, or unavailable. Cached content is never presented as live.
4. **UI 2.0 semantics, native interaction.** Reuse the Ling theme, message hierarchy,
   identity language, and headless policies; implement native React Native components.
5. **Narrow action, not remote administration.** Approval is `allow_once`/`deny` over the
   existing durable request; creation uses server defaults and existing teammates. V1 has
   no run control, persistent policy, file browser, terminal, settings workspace, or
   Computer Use surface.
6. **Pairing is the application gate.** An unpaired app presents a dedicated secure
   pairing flow; a paired app launches directly into conversations.

## Information Architecture

```text
App launch
  |
  +-- no pairing
  |      |
  |      v
  |   Pairing welcome -> QR scanner -> Waiting for PC confirmation
  |                                      |
  |                                      v
  |                                Initial conversation sync
  |                                      |
  +-- authenticated and paired ----------+-------------------+
  |                                                          |
  |                                                          v
  |                                                Conversation index
  |                                                - All
  |                                                - Channels
  |                                                - Conversations
  |                                                - Direct
  |                                                - Approval badge
  |                                                - + action menu
  |                                                          |
  |                               +--------------------------+------------------+
  |                               |                          |                  |
  |                               v                          v                  v
  |                      Pending approvals             Creation sheets   Conversation detail
  |                      - List/detail                 - New conversation - Header identity
  |                      - Allow once/deny             - New channel      - Synced transcript
  |                                                   - Existing teammate - Plain-text composer
  |                                                                          - Approval cards
  |                                                                          - Add teammate
  |
  |                                                          |
  |                                                          +-- avatar -> My
  |                                                                       - Profile
  |                                                                       - Appearance
  |                                                                       - Paired PC
  |
  +-- reconnecting/offline -> index with honest sync state and cached rows
  |
  +-- revoked/unpaired ----> Screen 0 secure pairing
```

There is no bottom tab bar in V1. Conversations remain the primary two-level navigation
stack. Approval list/detail, creation forms, teammate pickers, and `My` are secondary
stack/sheet surfaces opened from the index/detail headers. A persistent tab bar would
spend scarce screen space on infrequent actions.

## Screen 0: Secure Pairing

Pairing is shown only when the app has no valid pairing record. It is not a button mixed
into the conversation index, because there is no meaningful conversation state before a
PC is trusted.

### Pairing Welcome

The user sees, in order:

1. Ling identity and `连接你的 Ling`.
2. One sentence explaining that the phone continues PC conversations securely.
3. Primary action `扫描 PC 配对码`.
4. A short security note: one phone, local PC confirmation, private key never leaves the
   device.

```text
+--------------------------------------+
|                                      |
|                 L                    |
|                                      |
|           连接你的 Ling               |
|   扫描 PC 上的配对码，同步已有会话。    |
|                                      |
|        [  扫描 PC 配对码  ]            |
|                                      |
|  在 PC：设置 → 移动端访问 → 开始配对    |
|                                      |
|  一台 PC 仅绑定一部手机。私钥不会离开   |
|  当前设备，绑定还需要在 PC 上确认。      |
+--------------------------------------+
```

### Pairing State Flow

| State | What the user sees | Action |
| --- | --- | --- |
| Camera permission unknown | Native permission explanation before the system prompt. | `继续`. |
| Camera denied | Why scanning needs camera access. | `打开系统设置`. |
| Scanning | Edge-to-edge camera, quiet frame guide, cancel button. | Point at the PC QR. |
| Invalid/expired QR | `配对码无效或已过期`; no endpoint detail is exposed. | Scan the refreshed PC code. |
| Candidate recognized | PC display name plus short verification phrase. | Continue automatically to PC confirmation. |
| Awaiting PC confirmation | `请在 <PC name> 上确认这部手机`; expiry countdown and cancel. | Confirm locally on PC. |
| Rejected | `PC 拒绝了绑定`; local candidate state is cleared. | Scan the rotated code. |
| Accepted | Gateway identity verified, device key persisted, initial sync begins. | Enter conversations automatically. |
| Initial sync | Conversation-index skeleton with `正在同步 PC 会话…`. | None. |

After a successful pairing, future launches skip this flow and enter the conversation
index. Revocation, local unpair, invalid device epoch, or deleted secure key returns to the
pairing welcome after clearing cached conversation content.

### Required PC Companion Surface

The QR does not appear in a conversation. PC owns pairing under:

```text
Settings -> Device -> Mobile Access
```

This adds one `Mobile Access` row beside the existing device settings. Its page has five
states:

| PC state | PC UI |
| --- | --- |
| Disabled | Explain the local Gateway and show `启用移动端访问`. |
| Enabled, unpaired | Show status/reachability and primary action `生成配对码`. |
| Pairing window open | Show QR, PC name, five-minute countdown, and `取消配对`. |
| Candidate waiting | Replace passive QR emphasis with phone name/platform and the short verification phrase; require explicit `确认绑定` or `拒绝`. |
| Paired | Show phone name, platform, paired/last-connected time, status, and destructive `撤销绑定`. No QR remains visible. |

The phone owns `扫描 PC 配对码`; the PC owns `生成配对码` and final confirmation. Pairing
always begins from a fresh local PC action, and a rejected/expired attempt rotates the QR.
This PC surface is required for the Mobile flow even though it is not part of the Mobile
screen set.

## Screen 1: Conversation Index

### Hierarchy

The user sees, in order:

1. **Title and synchronization truth**: `会话` plus PC name and `已同步`, `正在连接`,
   or `离线`.
2. **Conversation-kind filter**: `全部`, `频道`, `会话`, `私聊`.
3. **A single activity-sorted list** spanning all three conversation kinds.
4. **Pending approvals**: a 44 pt shield button, hidden when the capability is absent,
   with a count badge when pending items exist.
5. **Create**: a 44 pt `+` button opening the creation action sheet while online.
6. **User avatar**: a 44 pt button that opens `My`.

Search, rename/archive/delete, sorting controls, workspace selection, teammate creation,
and broad administration are not present in V1.

### Phone Wireframe

```text
+--------------------------------------+
|  会话                 [盾2] [+] [我]  |
|  我的 Mac · 刚刚              已同步  |
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
| Empty | `还没有会话` and `开始与 Ling 或队友对话`. | `新建会话` while online. |
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

The header shows a back button, 32 pt identity, title, kind-specific subtitle, and a
non-interactive sync indicator. An active channel also exposes one overflow action,
`添加已有队友`; other conversation kinds do not show administrative actions.

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
| [!] Ling 需要你的批准                 |
|     写入 2 个工作区文件 · 中风险       |
|                           [查看详情]   |
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
- A pending approval is an inline control-plane card anchored to the authoritative
  conversation, not an Agent chat bubble. It never impersonates a teammate message or
  exposes a raw command/path/payload.

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
- No attachment, slash-command, model, provider, permission-preset, voice, or tool
  controls in the composer. Approval lives only in its reviewed cards/detail surface.
- In a new normal/direct draft, the first send uses the atomic start command and then
  replaces the local draft identity with the returned authoritative conversation id.

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

## Approval Attention and Decision

Approval UI follows the complete security/product contract in
[Mobile Approval and Creation Detailed Design](mobile-approval-and-creation-detailed-design.md).

### Attention hierarchy

1. The index shield badge gives a stable home for all pending requests.
2. The open conversation shows its pending approval inline at the relevant transcript
   position.
3. The first new request in the foreground may open one non-blocking sheet. Dismissing it
   leaves the badge/card and it does not reopen on every delta.
4. A backgrounded/suspended app refreshes the approval snapshot on foreground; the local-
   only architecture does not promise remote push wake.

### Approval list

Each row shows conversation identity, Agent/operation title, risk, relative expiry, and
pending/terminal status. It never shows an absolute path, command line, raw MCP payload,
terminal output, secret, or artifact content. Rows are ordered by nearest expiry, then
creation time. A capability-disabled app hides the entry rather than showing a broken
screen.

### Approval detail

```text
+--------------------------------------+
| <  权限申请                           |
|--------------------------------------|
| Ling · 当前会话                       |
| 中风险 · 4 分钟后过期                  |
|                                      |
| 需要写入工作区内的 2 个文件。           |
| • src/...                            |
| • tests/...                          |
|                                      |
| 仅本次生效，不会修改工作区权限策略。     |
|                                      |
| [拒绝]                  [仅本次允许]   |
+--------------------------------------+
```

- Low/medium eligible items expose both actions.
- High eligible items require a decision reason and local Face ID/Touch ID/passcode before
  the app sends `仅本次允许`.
- Critical/sensitive items replace the approve button with `请在 PC 处理`; explicit deny
  remains available only when the server policy permits it.
- Submitting disables both buttons and shows `正在记录决定…`.
- If PC wins the race, the sheet becomes `已在 PC 处理 · <result>` rather than showing a
  generic failure.
- Approved runtime permission remains run-/continuation-scoped. Mobile never offers
  `始终允许`, permission preset, workspace policy, or allowed-path editing.

## Creation Flows

The index `+` action sheet contains:

```text
新建会话
新建频道
与已有队友私聊
```

### New conversation

- Opens a blank local draft detail immediately.
- No daemon object exists until the first non-empty message is sent.
- Back preserves the device-local draft according to the normal draft policy; deleting the
  draft leaves no PC object.
- First-send pending/retry uses one command id and binds to the returned conversation.

### New channel

- One sheet contains a required name and optional multi-select of existing active
  teammates.
- The form explains `工具、模型和权限沿用 PC 工作区默认设置`.
- It does not expose path, provider, model, tools, permissions, runtime policy, auto-reply,
  response language, or default-teammate controls.
- Success closes the sheet and opens the new channel. Failure preserves values and offers
  same-command retry when safe.

### Existing teammate

- `与已有队友私聊` selects one active teammate and opens a local direct draft; the first
  message creates or returns the authoritative direct thread.
- `添加已有队友` inside a channel excludes current members, Ling Agent, hidden teammates,
  and disabled teammates.
- Mobile cannot create/edit/delete a teammate, remove a channel member, select a default,
  or change teammate provider/runner/tools/skills/MCP/memory/permission settings.

All creation mutations are disabled while offline/reconnecting. Draft text/form state may
remain local, but there is no offline mutation queue.

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
security flow and is fully specified above.

## Screen 3: My

`My` opens from the conversation-index avatar and deliberately reuses only two PC settings
concepts: user profile and interface preferences. It is one scrollable phone page, not a
copy of the PC settings sidebar.

### Personal Profile

- Show the synced avatar, display name, and read-only `@handle`.
- Allow display-name editing with the same 80-character limit as PC.
- Allow choosing/cropping a photo for the user avatar with a strict image MIME/byte limit.
- Save through a dedicated allowlisted profile command; never send a local file path.
- A successful update becomes authoritative on PC and returns through the normal profile
  projection so all three conversation kinds use the same identity.
- Do not show PC Token statistics, activity heatmaps, run history, skill counts, or other
  analytics on Mobile.

### Interface Preferences

Mobile reuses the PC appearance vocabulary but owns a device-local selection:

| Option | Behavior |
| --- | --- |
| `跟随系统` | Default. Ling Light for light system appearance and Ling Dark for dark. |
| `Ling Light` | Fix the Mobile app to the built-in light native token map. |
| `Ling Dark` | Fix the Mobile app to the built-in dark native token map. |

Changing Mobile appearance does not remotely change the PC theme. PC theme creation,
imports, arbitrary theme packages, Quick Theme Studio, product language, and AI response
language stay on PC in V1. A later release may accept sanitized mobile-compatible semantic
token snapshots; Mobile must never execute CSS, font files, scripts, or arbitrary theme
package assets received from the PC.

### Paired PC

- Show PC display name, last synchronized time, and current connection state.
- `取消绑定` is a destructive text action at the bottom, behind a confirmation sheet.
- Confirming revokes the active Mobile session when reachable, deletes the local device
  key and cached conversations, and returns to Screen 0.
- If the PC is unreachable, local credentials/data are still cleared; the PC-side device
  remains blocked by its normal epoch/revocation policy before another pairing is accepted.

```text
+--------------------------------------+
| <              我的                  |
|                                      |
|       [头像]  Tianxiao               |
|               @local-user            |
|          [编辑个人资料]               |
|--------------------------------------|
| 界面偏好                              |
| 跟随系统                         [开] |
| 主题                  Ling Light  >  |
|--------------------------------------|
| 已绑定的 PC                           |
| 我的 Mac                    已连接    |
| 上次同步：刚刚                         |
|                                      |
|              取消绑定                 |
+--------------------------------------+
```

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
  features/pairing/
    screens/
      PairingWelcomeScreen.tsx
      PairingScannerScreen.tsx
      PairingConfirmationScreen.tsx
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
      ConversationCreateMenu.tsx
      NewChannelSheet.tsx
      TeammatePickerSheet.tsx
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
  features/approvals/
    data/
      MobileApprovalAdapter.ts
    screens/
      PendingApprovalsScreen.tsx
    components/
      InlineApprovalCard.tsx
      ApprovalDetailSheet.tsx
    state/
      usePendingApprovals.ts
      useApprovalDecision.ts
  features/profile/
    MyScreen.tsx
    ProfileIdentitySection.tsx
    AppearancePreferenceSection.tsx
    PairedPcSection.tsx
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
- pairing screens consume a pairing state machine and never parse QR wire data directly;
- profile edits use a dedicated allowlisted adapter, separate from conversation commands;
- approval screens consume server eligibility and sanitized summaries; they never parse
  or classify raw approval payloads;
- creation screens emit narrow typed intents and never choose path/runtime defaults;
- native theme values are app-local until a second native consumer exists.

## Required Remote Projection Evolution

The isolated branch now routes the generic conversation projection through
`MobileConversationAdapter` and a Native renderer backed by `conversation-ui-core`.
Approval and creation add separate capability-gated projections; they do not widen the
conversation message DTO:

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

The minimal personal surface also requires explicit `profile.read` and `profile.update`
capabilities. `profile.update` accepts only display name and a bounded validated avatar
payload; it cannot read files, paths, analytics, runs, skills, settings, or arbitrary
profile storage. Mobile appearance remains local and requires no Remote Gateway setting
mutation.

Approval/catalog/creation DTOs, redaction, atomic decision rules, and command shapes are
owned by
[Mobile Approval and Creation Detailed Design](mobile-approval-and-creation-detailed-design.md).

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
| 1 | Opens an unpaired app | Secure | One obvious scan action and a clear PC-local confirmation promise. |
| 2 | Completes PC confirmation | Reassured | Gateway identity verification and initial sync precede conversation access. |
| 3 | Opens a paired app away from the PC | Oriented | Recent conversations appear immediately with honest sync status. |
| 4 | Scans channel, normal, and direct conversations | In control | One list, clear type identity, activity order, unread counts. |
| 5 | Opens a conversation | Continuous with PC | Same transcript identity and ordering, phone-native hierarchy. |
| 6 | Sends plain text | Confident | Durable send state and no hidden workflow/tool escalation. |
| 7 | Receives an approval request away from the desk | Unblocked but cautious | Badge, inline card, redacted detail, risk-aware `Allow once`/`Deny`, and PC-only critical state. |
| 8 | Starts a conversation/channel or chooses a teammate | Productive | One `+` menu, local drafts, server defaults, and narrow existing-teammate pickers. |
| 9 | Loses and regains connectivity | Not misled | Cached content is visibly stale; snapshot recovery avoids duplicates or double decisions. |
| 10 | Opens the avatar | Familiar | Identity and Mobile appearance are together without exposing the PC settings center. |

## NOT in Scope

- Conversation/channel rename, archive, delete, pinning, search, or broad administration.
- Conversation attachments, voice/camera capture, rich composer commands, and
  model/provider/permission controls.
- Manual low-entropy pairing codes until a separate protocol and threat model are approved.
- `Always allow`, approval-policy/preset edits, persistent grants, critical/sensitive
  Mobile approval, run control, tasks, work cells, files, terminal, artifacts, or Computer
  Use.
- Creating/editing/deleting an AI teammate, teammate memory/skills/MCP/permissions,
  activity inspector, channels tab, or private files.
- Channel member removal/default selection or replace-all membership management.
- PC Token/activity analytics, theme creation/import, arbitrary theme packages, language,
  personalization, or broad settings management.
- Changing the PC theme from Mobile; Mobile appearance is device-local in V1.
- Workspace selection or exposure of local filesystem paths.
- Guaranteed background approval push/wake without an APNs-capable service. Foreground
  content-free attention and fresh foreground sync are included.
- Tablet, split-view, landscape multi-column, watch, or desktop-native layouts.

## Acceptance Criteria

- A user can distinguish channel, normal, and teammate-direct conversations without
  relying on color.
- All three kinds use the same index row, detail shell, transcript primitives, composer,
  drafts, and connection states.
- Index and detail remain usable at 320 pt width and 200% font scale.
- Cached data is never presented as current during reconnect/offline states.
- Plain-text send has pending, success, failure, and same-command retry states.
- No out-of-scope control is visible in the primary or secondary screens.
- The index exposes a 44 pt approval entry, `+` creation entry, and avatar without
  clipping at 320 pt/200% text; accessibility labels distinguish all three.
- Pending approvals show conversation, action, risk, expiry, decision eligibility, and
  terminal race state without raw payload/path/secret content.
- High-risk approval invokes local OS authentication before `Allow once`; cancellation
  sends no command. Critical/sensitive approval cannot be approved on Mobile.
- Tapping new conversation/direct and backing out before send creates no daemon object;
  first-send retry produces one authoritative thread/message/work unit.
- New channel accepts only name and existing teammates, visibly states that PC defaults
  apply, and cannot surface path/provider/model/tool/permission inputs.
- Adding an existing teammate is additive/idempotent and cannot remove/default/configure.
- Native source contains no `apps/web`, ReactDOM, DOM API, or Web CSS imports.
- Light and dark themes map from UI 2.0 semantic values through typed native tokens.
- Fixtures cover three conversation kinds plus loading, empty, partial, offline,
  reconnecting, send-failed, and revoked states.
- Unpaired, scanning, awaiting-confirmation, rejected, expired, accepted, and initial-sync
  states have explicit screens and recovery paths.
- A paired app launches directly to conversations; an unpaired/revoked app launches to
  secure pairing.
- The conversation-index avatar opens `My`; the page contains only profile identity,
  Mobile appearance, paired-PC status, and local unpair.
- Mobile profile edits are narrow allowlisted commands; Mobile appearance never mutates
  the PC theme.
- The live implementation does not ship until the generic conversation projection is
  consumed through the shared Mobile semantic adapter/renderer and its authorization
  policy remains green.
- Approval/creation does not ship until the shared approval resolver uses atomic first-
  decision-wins CAS and PC/Mobile race tests pass.

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
- [ ] **T7 (P1)** — Pairing UI — implement welcome, QR scanner, local-confirmation
  wait, rejection/expiry, accepted, initial-sync, and return-to-pairing recovery states,
  plus the required PC Mobile Access settings surface.
  - Files: `apps/mobile/src/features/pairing/`,
    `apps/web/src/features/settings/mobile-access/`, settings shell registration.
  - Verify: permissions, invalid/expired QR, rotated QR, PC reject/accept, revoke, missing
    secure key, and accessibility fixtures.
- [ ] **T8 (P2)** — Minimal personal surface — implement synced profile identity, local
  appearance preference, paired-PC status, and confirmed unpair.
  - Files: `apps/mobile/src/features/profile/`, Remote profile projection/commands.
  - Verify: profile limits, avatar payload validation, PC round-trip, theme persistence,
    local-only theme behavior, and credential/cache clearing after unpair.
- [ ] **T9 (P1)** — Approval attention — implement pending badge, inline card, list,
  redacted detail, eligibility states, local-auth gate, submission/race/expiry recovery.
  - Files: `apps/mobile/src/features/approvals/`, remote-client approval state.
  - Verify: low/medium/high/critical fixtures, PC-wins race, expired, offline, OS-auth
    cancel, 320/390 pt, 200% text, VoiceOver, Light/Dark.
- [ ] **T10 (P1)** — Conversation/channel creation — implement `+` action sheet, normal/
  direct local drafts, first-send binding, new-channel form, and durable retry states.
  - Files: Mobile conversation components/state and remote-client creation commands.
  - Verify: back-before-send creates nothing, duplicate retry creates one object/work unit,
    validation preserves form state, and offline disables mutation.
- [ ] **T11 (P1)** — Existing teammate selection — implement sanitized teammate pickers,
  direct-draft start, and additive channel membership.
  - Files: Mobile conversation components/state and remote-client teammate catalog.
  - Verify: existing/hidden/disabled/current-member states, idempotent add, stale catalog,
    and negative assertions for create/edit/remove/default/configure controls.

## Design Review Result

The previous plan was 4/10 for Mobile UI completeness: it listed broad screens, retained
channel-only information architecture, and deferred visual decisions. The 2026-07-31 pass
raised the conversation shell to 9/10. The 2026-08-01 amendment closes the remaining
product-flow design gaps with explicit approval attention/detail, risk and stale-decision
states, creation drafts/forms/pickers, server-default language, background limits,
accessibility, failure recovery, and testable acceptance criteria. Live visual and real-
device security QA remain implementation evidence, not unresolved design choices.

NO UNRESOLVED DESIGN DECISIONS
