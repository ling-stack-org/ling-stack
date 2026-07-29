# Sidebar 与对象列表

## Goal

Sidebar 是对象导航，不是状态说明墙。它需要快速扫描频道、队友和最近对话，并保持紧凑、
稳定的点击区域和一致菜单。

## Function Points

- `SIDEBAR-PRIMARY-001`：当前发布 Media、Plugins、Automations；Inbox 与 Work Board 待开发并隐藏。
- `SIDEBAR-CHANNEL-001`：频道列表、头像、未读和运行状态。
- `SIDEBAR-TEAMMATE-001`：AI 队友列表、隐藏和选择。
- `SIDEBAR-RECENT-001`：最近对话、长标题和空态。
- `SIDEBAR-SECTION-001`：分组折叠、展开和 count。
- `SIDEBAR-MENU-001`：新建、归档、设置和低频操作。
- `SIDEBAR-TOOLTIP-001`：icon-only/截断内容说明。

## Layout

宽度默认 `236px`。Nav item 高度至少 `36px`，小图标按钮 hit area `32px`。Section header
保持一行；count、spinner 和 menu 不改变标题位置。对象列表占剩余高度并内部滚动。

## Interaction

行点击只导航，三点按钮不触发行点击。Menu 使用统一 Menu；归档为普通低频行动，永久删除
只在 Settings。Tooltip hover/focus 可达。折叠状态不隐藏当前选中对象的可识别反馈。

## States

loading 使用稳定行 Skeleton；empty 是单行 compact 状态；断线保留已有对象并标 stale。
运行中、待审批、失败只显示一个主 StatusIndicator。

## Current And Target

当前 `SidebarNavigation.tsx`、`SidebarPrimaryNavigation.tsx` 和 sidebar/layout CSS。对象导航行
迁移为 feature-owned `SidebarObjectRow`，内部使用共享 Button、IconButton、Tooltip、Menu 和
StatusIndicator；领域头像保留 feature helper，普通业务数据列表继续使用 DataRow。

## P4.1-P4.5 Current Status

已实现：

- `SidebarSectionMenu` 使用共享 Portal-backed Menu，保留受控单菜单、Esc、禁用项和 danger tone；
- `SidebarTooltip` 使用全局 Tooltip Provider，替代手写 rect、hover/focus state 和
  `.sidebar-hover-tooltip`；
- Tooltip 作为非交互说明，离开 trigger 后可快速切换，不保留 hoverable content 宽限区；
- 折叠开关、创建分支、提交分支和归档 icon action 已接共享 `IconButton`，保留 32px hit area；
- Media、Plugin、Automation 使用共享 `Button + Tooltip`，展开态保留文字；Inbox 与 Work Board
  保留隐藏的待开发节点，不参与可见导航、键盘焦点或辅助技术树；
  既有历史验证覆盖 Inbox、Media、Work Board、Plugin、Automation，
  48px rail 只显示 leading icon，并用 `aria-current=page` 表达当前项；
- Recent 分组错误使用 persistent `InlineFeedback`，不再维护硬编码 danger 颜色；
- Portal 后 E2E 使用 role/name，不再假设 `menuitem` 是 navigation DOM 子节点；
- 频道、AI 队友和最近对话已接 `SidebarObjectRow`，业务 callback 留在 navigation adapter；
- 共享 Button 公开 `data-ling-button-slot` 和 slot layout variables，Feature CSS 不命中 primitive
  内部 class；
- 展开态头像、长标题、行内 action 与折叠态 48px rail、26px identity、Tooltip 已在真实 Vite
  页面通过；
- section header/disclosure 已抽为 `SidebarSection`，使用共享 Button 和 Radix Collapsible；
- loading 使用 Spinner/Skeleton，stale 和未读使用 compact StatusIndicator，count 使用 Badge；
- normal motion 在用户触发后为 `180ms`，reduced motion 为 `0ms`，rapid reversal 以最后输入为准；
- Radix 初始 mount 为测量高度而临时设置 `animationName=none`，测试不把该行为误判为动画缺失；
- channel、teammate 和 recent 状态投影已集中到 `sidebar-status-projections.ts`，优先级固定为
  `paused > waiting > failed > running > unread`，idle 不伪造绿色正常态；
- 最近对话 loading 使用稳定 Skeleton，持久化 `thread.status` 和活动 run/stream 均可投影为 running；
- semantic StatusIndicator 已移到 native button 外的固定列，并提供显式 accessible name；hover action
  出现时 label 和状态点不位移；
- primary navigation 展开态统一为 `36px`，compact rail 保持 `36px`；active 只允许一个
  `aria-current=page`；
- section menu trigger 使用共享 IconButton，Menu 继续由受控 Radix Portal、Esc 和 focus restore 管理；
- compact rail 隐藏 section menu，避免 32px disclosure 与 32px action/rail preview 互相覆盖；
- Tooltip 支持 hover/focus、rapid switch、Portal 和 reduced motion；
- 已删除无运行时 owner 的 `.sidebar-section-menu-popover/.open/.copy/.rich-*` selector family；
- `SidebarNavigation.tsx` 为 633 行，`SidebarObjectRow.tsx` 为 59 行，
  `sidebar-status-projections.ts` 为 152 行，均低于 800 行生产文件警戒线。

P4.2 evidence：共享包 `37/37`、Sidebar target `7/7`、focused browser `2/2`，并保存
`1440x960` Light expanded 与 `1280x800` Dark collapsed Tooltip 截图，见
[Sidebar object rows evidence](../evidence/shell/sidebar-object-rows/metadata.md)。

P4.3 evidence：共享包 `38/38`、focused section `2/2`、selected browser regression `14/14`，并保存
`1440x960` Light loading 与 `1280x800` Dark stale/collapsed 截图，见
[Sidebar section disclosure evidence](../evidence/shell/sidebar-section-disclosure/metadata.md)。

P4.4 evidence：纯状态投影 `3/3`、focused list state `2/2`、list + object row `4/4`、壳层回归
`44/44`，并保存 `1440x960` Light dense states 与 `1280x800` Dark recent loading/running 截图，见
[Sidebar list state evidence](../evidence/shell/sidebar-list-states/metadata.md)。

P4.5 evidence：focused controls `2/2`、Sidebar 四专项 `8/8`、App target `3/3`、
Channel/Teammate menu target `4/4`，并保存 `1440x960` Light disabled danger Menu 与
`1280x800` Dark compact Tooltip 截图，见
[Sidebar controls evidence](../evidence/shell/sidebar-controls/metadata.md)。

2026-07-29 产品决策：Inbox 独立产品入口改为待开发。以下 `SIDEBAR-PRIMARY-001`
验证结论只适用于当前三个可见入口和隐藏边界，不表示 Inbox 已发布。

`SIDEBAR-PRIMARY-001`、`SIDEBAR-CHANNEL-001`、`SIDEBAR-TEAMMATE-001`、
`SIDEBAR-RECENT-001`、`SIDEBAR-SECTION-001`、`SIDEBAR-MENU-001` 和
`SIDEBAR-TOOLTIP-001` 已全部 `verified`。后续 U13 仍需拆分聚合 CSS 和删除跨模块兼容 selector，
但不得因此回退 Sidebar 已验证的视觉、交互或业务行为。

## Tests

`app.spec.ts`、`channel.spec.ts`、`channel-archive.spec.ts`、`teammates.spec.ts`、
`dark-mode.spec.ts`、`ui2-sidebar-object-rows.spec.ts`、`ui2-sidebar-sections.spec.ts`、
`sidebar-status-projections.spec.ts`、`ui2-sidebar-list-states.spec.ts`、`ui2-sidebar-controls.spec.ts`。验证 hit area、菜单键盘、截断、
滚动、选中、归档后刷新、唯一主状态、持久化 running、section rapid reversal、reduced motion、双主题和 compact rail。
