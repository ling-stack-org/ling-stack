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
- 展开态对象标题使用完整行宽。隐藏操作和状态控件采用右侧覆盖层，不得永久保留空白网格列；控件
  显示时用局部背景和渐隐保护可读性，不覆盖标题文字。
- 溢出标题不使用硬省略号。默认在右边缘自然渐隐，鼠标悬浮或键盘聚焦时平滑移动到末尾并停住，
  离开或失焦后复位。`prefers-reduced-motion` 下不播放移动动画。
- 频道、队友私聊和普通对话共用同一个非交互式完整预览，统一显示完整名称和最近活动时间，不重复
  展示 Sidebar 分区已经说明的对象类型。对象自身的有效执行工作区可解析为 Git 仓库时，附加仓库
  目录名和当前分支；该目录必须区别于共享全局工作区。频道以当前 workspace binding 为权威，其次
  才使用独立的最新 Run 或显式 bound path；私聊和普通对话只使用独立的最新 Run。历史 Run 位于共享
  工作区时不得用该目录今天的分支冒充会话级 Git 上下文。Git 缺失时直接省略，不写死、不显示绝对
  路径、不渲染“未配置”占位；
  查询按工作目录去重，不为 Tooltip 发起单行请求。
  三点菜单和状态控件保持既有尺寸、键盘顺序和导航隔离。
- Sidebar 是跨主 View 持久存在的稳定投影。新会话、已有会话、频道、队友私聊、媒体生产、Plugin
  Manager 与自动化之间切换时，只允许改变选中态；不得 remount Sidebar、替换分区、重置滚动或焦点，
  也不得把目标页面的详情请求、模块加载或操作 busy 投影成 Sidebar Loading。
- 分区标题中的数量和状态槽位保持稳定。导航、详情读取和后台刷新不得把数量临时替换成 Spinner，
  compact rail 也不得因这些请求出现加载标记。
- 对象列表占剩余高度并内部滚动。Skeleton 只允许用于当前 workspace 首次、无任何缓存对象的权威列表
  加载；已有数据后的刷新保留原列表和数量，响应完成后原子更新。断线保留已有数据并标记 stale。
- 归档是低频菜单动作，永久删除只在拥有该能力的管理页面出现。
- Settings 继续使用全屏 Settings shell 并隐藏主 Sidebar；进入和返回必须直接完成壳层切换，不得经过
  空白、默认壳或 Loading 中间帧。
- macOS Desktop 使用一条真实的 `48px` 全宽 titlebar 布局行。展开和收起导航按钮始终由
  Desktop Chrome 持有，固定在红黄绿窗口按钮右侧；展开/收缩 Sidebar 不得改变按钮位置、尺寸、
  焦点或交互所有权。
- 工具槽避开 `76px` traffic-light exclusion，按钮保持 `32x32` 和 `no-drag`，按钮前后各保留
  `8px` 间距，拖拽 sibling 不得覆盖该区域。macOS 原生交通灯起点为 `x=12px, y=17px`；交通灯、
  Sidebar 按钮、当前标题和右侧操作的视觉中心统一为 `y=24px`。Web 和 Windows 继续使用页面内
  Sidebar 按钮。
- macOS Desktop 收缩后保留 `48px` compact rail，但 rail 不重复渲染展开按钮；“新建对话”成为
  rail 的第一个行动并保持 `36x36`。本轮不增加返回、前进或其他无状态支撑的 titlebar 控件。
- 当前页面 Header 通过共享 titlebar surface slot 进入同一行；Sidebar、rail、workspace body 和
  inspector 从该行下方开始。macOS 不得保留页面内重复 Header、空白占位行或绝对定位浮动按钮；
  Web 和 Windows 继续使用原页面内 Header。

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
- 侧栏对象行不得因隐藏工具保留空白列；长标题悬浮滚动不得创建 Sidebar 横向滚动。
- grid/flex 子项使用 `min-width: 0`；Canvas、表格、列表和 Dock 各自拥有明确滚动边界。
- resize 不重置 View、选中对象、Drawer、焦点或 ThemeSelection。
- 页面不可用状态必须保留一个明确恢复行动；正常状态不在 Header 堆积标签。
- macOS Desktop 展开/收起 Sidebar 时，titlebar 必须保持 `0,0` 起始、全宽和 `48px` 高；按钮保持
  同一几何位置，不得与 traffic lights、“新建对话”或拖拽区重叠。正文顶边必须等于 titlebar
  底边，原生交通灯和所有 Web titlebar 控件必须共享 `y=24px` 中心线；按钮尺寸、键盘顺序和
  可拖拽区必须由几何回归验证。
