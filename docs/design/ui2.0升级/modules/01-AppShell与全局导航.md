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

- Sidebar 是对象导航，不是状态说明墙；支持的 Desktop shell 展开宽度固定为 `292px`，收起后切换为
  独立的 `48px` compact rail。compact rail 是真实导航面，不是透明留白或展开 Sidebar 的压缩态。
- 展开态显示当前发布的主工具、频道、AI 队友和最近对话；Inbox 与 Work Board 在产品重新开放前
  不进入可见导航、键盘顺序或辅助技术树。
- Sidebar 收起后仍由共享顶部栏中的唯一导航开关恢复；展开态对象列表、标题和分区菜单退出
  可访问树与指针命中区，compact rail 只保留新建对话、现有主工具、频道、队友、最近会话和设置的
  图标入口。它不得渲染展开态文字，也不得重复渲染 Sidebar 开关。
- 对象行点击只导航；三点菜单不触发行点击。运行、待审批、失败、未读只显示一个最高优先级状态，
  idle 不显示绿色健康标签。
- 展开态对象标题使用完整行宽。隐藏操作和状态控件采用右侧覆盖层，不得永久保留空白网格列；控件
  显示时用局部背景和渐隐保护可读性，不覆盖标题文字。
- 最近对话行只显示一行会话标题，不重复显示“对话”类型副标题或其他分区已表达的元信息。行高保持
  `32px`，图标与标题共用同一垂直中心线；去掉副标题不得改变标题水平起点。
- 溢出标题不使用硬省略号。默认在右边缘自然渐隐，鼠标悬浮或键盘聚焦时平滑移动到末尾并停住，
  离开或失焦后复位。`prefers-reduced-motion` 下不播放移动动画。
- 频道、队友私聊和普通对话共用同一个非交互式完整预览，统一显示完整名称和最近活动时间，不重复
  展示 Sidebar 分区已经说明的对象类型。对象自身的有效执行工作区可解析为 Git 仓库时，附加仓库
  目录名和当前分支；该目录必须区别于共享全局工作区。频道以当前 workspace binding 为权威，其次
  才使用独立的最新 Run 或显式 bound path；私聊和普通对话只使用独立的最新 Run。历史 Run 位于共享
  工作区时不得用该目录今天的分支冒充会话级 Git 上下文。Git 缺失时直接省略，不写死、不显示绝对
  路径、不渲染“未配置”占位；
  查询按工作目录去重，不为 Tooltip 发起单行请求。
  预览宽度使用窗口可用空间内的稳定上限，不得出现水平或垂直滚动条；单行文字超出时与对话标题使用同样的
  右侧渐隐和悬浮滚动到末尾行为，而不是扩大 Tooltip 或引入内部滚动。
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
- macOS、Windows 和 Web Desktop 共用一条真实的 `48px` 全宽 titlebar 布局行。展开和收起导航
  按钮始终由该行持有；切换 Sidebar 不得改变按钮尺寸、焦点或交互所有权。
- macOS 工具槽避开 `76px` traffic-light exclusion，按钮保持 `32x32`、`x=84px`、`y=8px` 和
  `no-drag`。原生交通灯起点为 `x=12px, y=17px`；交通灯、Sidebar 按钮、当前标题和右侧操作的
  视觉中心统一为 `y=24px`。Web 的开关位于顶部行左端；Windows 的开关与自绘窗口按钮同属该行。
- 当前页面 Header 通过共享 titlebar surface slot 进入同一行；Sidebar、workspace body 和 inspector
  从该行下方开始。任何平台不得保留页面内重复 Header、空白占位行或绝对定位浮动按钮。
- 展开态 titlebar 左段和 Sidebar 使用同一 `background.sidebar`；收起态 compact rail 继续使用
  `background.sidebar`，workspace 从 `x=48px` 开始。Ling 只显示已有可用行动，不复制无真实状态的 Codex Back、Forward、
  Search、Notification 或菜单控件。

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
- 所有 Desktop 平台展开/收起 Sidebar 时，titlebar 必须保持 `0,0` 起始、全宽和 `48px` 高；展开
  Sidebar 为 `292px`，收起为 `48px`，正文顶边必须等于 titlebar 底边。原生和 renderer 控件共享
  `y=24px` 中心线；按钮尺寸、键盘顺序、可拖拽区、compact rail 命中区及无横向滚动必须由几何回归验证。
