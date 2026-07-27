# Composer 与会话控件

## Shared Surfaces

频道、普通对话、AI 队友私聊共享 Composer 外壳、输入 token、附件、权限菜单、发送、停止
和排队反馈。Surface-specific 能力通过 slots 接入，不复制 Composer。

## Layout

- 输入区宽度与 conversation column 对齐。
- 附件和 mention token 在输入区上方稳定换行。
- 左侧添加/权限，右侧发送/停止；控件高度统一。
- focus 不改变外部高度，不遮挡消息或底部 panel。

## States

draft、focused、uploading、queued、sending、streaming、stopping、disabled、error。发送后
不得永久停留在 responding；失败后恢复输入并保留可重试内容。

## Toolbar

三类会话主工具顺序统一为 Search、Refresh、Summary、Terminal、Details，默认 icon-only。
Review、Evidence、Files、Context 进入右侧栏。

## Panels

Summary 是独立 Popover；Right Dock 和 Bottom Terminal 独立开关。打开/收缩右侧栏时
Summary 平滑移动，不先消失再重新出现。Right Dock 和 Terminal 支持稳定拖动边界。

Dock/Terminal 使用 `240ms` enter、`180ms` exit。拖动时设置 resizing state 并禁用 transition；
释放后超出边界最多 `120ms` snap。Summary 使用同一 dock width token 做 transform，不卸载。

## Accessibility

Composer 有明确 label，token 可键盘删除，发送/停止有状态名称，权限菜单可键盘操作。

## P5.1 Current Status

- `@ling-stack/conversation-ui-react` 已允许单向依赖 `@ling-stack/ui-react`；
- 已建立 `ConversationToolbar`、icon/action button、count badge 和 package `styles.css` 出口；
- Web `WorkspaceTopRightToolbar` 只保留 class/callback compatibility adapter，频道、普通对话、
  AI 队友私聊和 dock 不再自建 Toolbar Button/Tooltip/Badge；
- Toolbar action 使用 `data-conversation-action`，count 使用 `data-conversation-count`；
- 证据：package `8/8`、focused `2/2`、代表面/Dark `8/8`、6 张 Light/Dark 双 viewport 实页图。

P5.1 只关闭 Toolbar foundation。频道 Search/Refresh、共享 Summary/Dock/Terminal motion、
Composer 与消息列宽度、完整 Header Function ID 仍属 P5.2-P6。

## P6A.2 Channel Adoption

- package Composer root 暴露稳定 `data-conversation-composer`、`data-surface` 和 `data-density`，
  测试不再依赖视觉 class 推断 surface。
- 权限预设使用共享 `MenuRadioGroup/MenuRadioItem`，保留当前确认 callback 和权限业务类型；Radix
  负责键盘导航、Esc、outside dismiss、Portal 和 trigger focus restore。
- package 拥有 Composer shell、tokenized input 和 permission menu 的基础视觉；Channel 只拥有
  attachment、goal、plan、approval 和 send feedback 的 feature slots。
- persistent send failure 使用 InlineFeedback 和明确 Retry/Dismiss；ephemeral success/info 继续由
  controller 定时清除。任何反馈都不得改变 conversation column 宽度或进入消息历史。
- Channel Feed 与 Composer 已在同一 conversation column 内完成 `1440x960` Light 和 `1280x800`
  Dark 几何验证；Feed 是唯一滚动 owner，Composer focus 不改变外部尺寸。
- P6A.2 验证为 package `40/40 + 10/10`、focused `3/3`、完整 Channel `105/105`、Teammates
  `21/21`。证据见
  [Channel Feed And Composer](../evidence/conversations/channel-feed-composer/metadata.md)。

该结果只关闭 Channel adoption。普通对话与 AI 队友私聊仍需在 P6B/P6C 分别迁移 Feed/Composer，
不得仅因共享 package 已存在而提前标记完成。

## T13-O.31 Three-Surface Ownership Closeout

- P6B/P6C adoption 已完成；O.31 进一步关闭三面的 CSS ownership 漂移，不改变其业务行为。
- package 只输出 canonical `.conversation-composer*` 与 stable data attributes；四个旧 compatibility class
  已删除，生产与 E2E 不得恢复依赖。
- 301 行 Web shared slot owner 持有附件预览、mention/slash picker、drop hint、attachment trigger 和
  file-reference；Channel/Normal/Teammate focused CSS 只持有 surface adapter。
- native input 不持有 border/outline/shadow；外壳通过 `focus-within` 显示 inset ring。聚焦前后 native、
  input zone 和 Composer shell 的几何必须稳定，任何后续截图发现的外扩都作为回归处理。
- package `20/20`、focused ordinary/capture `4/4`、既有 Composer/Token/Form `18/18`、broad `165/165` 和
  三张原尺寸证据通过。证据见
  [Shared Conversation Composer Ownership](../evidence/conversations/conversation-composer-ownership/metadata.md)。
- 该结果在 O.31 时不关闭页面级 raw text controls；这些控件现已由 T12.1c 独立迁移并加 lint guard。
  Composer 证据仍不替代 packaged macOS/Windows 验收。
