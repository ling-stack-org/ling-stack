# AppShell、Sidebar 与全局导航

## Ownership

AppShell 只拥有全局布局、View 切换、跨页面 Provider、连接状态、Desktop chrome 和 overlay
挂载。Feature 自己拥有请求、业务状态、Dialog 内容和错误。不得向 AppShell 继续追加主要页面 JSX。

```text
LingUiProvider
  AppShell
    Sidebar
    ActiveView
    Optional Inspector/Right Dock
    Global overlay root
```

Settings 激活时隐藏主 Sidebar。View 切换不得 remount AppShell，也不得清空当前选择、滚动位置、
Composer 草稿、运行状态或主题。

## Sidebar

- Sidebar 是对象导航，不是状态说明墙；展开宽度约 `236px`，compact rail 为 `48px`。
- 展开态显示当前发布的主工具、频道、AI 队友和最近对话；Inbox 与 Work Board 在产品重新开放前
  不进入可见导航、键盘顺序或辅助技术树。
- compact rail 只显示分区入口，不渲染去文字化的对象列表或随数据增长的头像墙。点击分区后先展开
  Sidebar，再打开目标 section。
- 对象行点击只导航；三点菜单不触发行点击。运行、待审批、失败、未读只显示一个最高优先级状态，
  idle 不显示绿色健康标签。
- 对象列表占剩余高度并内部滚动；loading 使用稳定 Skeleton，断线保留已有数据并标记 stale。
- 归档是低频菜单动作，永久删除只在拥有该能力的管理页面出现。

## Global State And Overlay

- daemon 断线保留当前页面和数据，显示持久反馈、重连行动和折叠技术详情。
- 全局只有一个 Tooltip Provider、Toast viewport 和 application overlay root。
- Dialog/Drawer、Menu/Popover、Toast、Tooltip 使用共享层级；Feature 不创建全局 `activeOverlay` 或
  私有高位 z-index。
- full access 等安全确认生成真实权限证据；UI 不改变安全策略、审批或运行状态机。
- Desktop drag/no-drag、safe area、DPI 和 titlebar 由 focused Desktop boundary 负责，不由 Feature
  selector 清单控制。

## Layout And Acceptance

- `1440x960`、`1280x800` 和支持的 Desktop 最小窗口无 document 横向滚动。
- grid/flex 子项使用 `min-width: 0`；Canvas、表格、列表和 Dock 各自拥有明确滚动边界。
- resize 不重置 View、选中对象、Drawer、焦点或 ThemeSelection。
- 页面不可用状态必须保留一个明确恢复行动；正常状态不在 Header 堆积标签。
