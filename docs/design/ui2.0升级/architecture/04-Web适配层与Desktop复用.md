# Web 适配层与 Desktop 复用

## Web Adapter

`apps/web/src/shared/ui` 负责：

- re-export `@ling-stack/ui-react`；
- 通过 `LingUiProvider` 提供翻译后的 dismiss、close 等默认 label；
- 提供 ThemeSelection 存储、首帧 mirror 和用户自定义背景媒体仓库；
- 提供 Model Workbench capability 和 Media/Artwork job adapter；
- 连接 ThemeProvider 已设置的 `data-ui-theme`、`data-color-scheme` 和 semantic variables；
- 为现有测试保留短期 compatibility exports。

它不得复制组件 JSX、添加业务状态或定义第二套 CSS。

## P3 Foundation Status

截至 2026-07-18，Web adapter foundation 已实现：

- `apps/web/src/shared/ui/index.ts` 是 App、Domain 和 Feature 使用通用 primitive 的唯一入口；
- `LingUiProvider` 在 Web root 统一挂载一个 Tooltip Provider 和一个 Toast viewport；
- package 内 Tooltip 保留 standalone compatibility fallback，只服务独立 renderer、fixture 和渐进迁移，
  Web/PiP 正常入口均显式挂 Provider；
- `check-ui2-imports.mjs` 阻止 `app/`、`domains/`、`features/` 直接导入
  `@ling-stack/ui-react` 或 Radix；当前直接导入数为 0；
- Web build、typecheck 和 E2E 在执行前先构建 `@ling-stack/ui-react`，避免读取过期 dist。

这只代表 adapter 和 guard 可用，不代表全产品调用面迁移完成。P3 foundation 曾以 compatibility
facade 承接渐进迁移；T13-P.3-R 的 canonical current status 是：`SelectControl`、`CreateDialogShell`
与 `OperationEmptyState` 的 component、export 和生产引用均已删除，三者 guard 均为 `0/0`。
Channel Create 已直接使用 shared `Dialog` 与 `Select`；`StatusBadge` 仍是受预算约束的 compatibility
facade，必须按业务状态语义继续迁移；
非 Sidebar 的 ActionMenu、业务 Drawer 和视觉 class E2E selector 按后续模块切片迁移；Sidebar
Menu/Tooltip 已在 P4.1 接入共享 primitive。

## Desktop Renderer

Desktop 直接使用 package 或复用 Web renderer。Desktop adapter 只处理窗口、系统菜单、
通知、文件选择和 keychain callback，不改变共享组件语义。

Theme 方面，Desktop adapter 负责官方 ThemeSelection 存储、用户自定义背景受管目录、首帧 bootstrap 注入和窗口材质 adapter。它不复制 ThemeRegistry、Presentation Profile、Compiler 或内置 Theme Pack，也不再把 `.ling-theme` 持久化、Theme Studio 草稿或生成资产 staging 作为当前产品能力。

Desktop renderer 分为两类：

- main BrowserWindow 加载同一份 Web build，通过 typed `LingDesktopCapabilities` 暴露 OS 能力；
- Computer Use PiP 等 utility renderer 使用独立 React root，只组合 shared compact primitives 和
  focused layout，不加载 AppShell、router 或 feature stores。

main Web feature 只能检查 capability 是否存在，并把已派生 summary/actions 映射到共享组件；
不能导入 Electron、IPC channel 或平台 capture adapter。PiP renderer 也只能接收净化后的状态、
主题、语言和 callback，不能直接持有 preload object。

Desktop 多 renderer 共享带 revision 的 client-safe Theme/Locale snapshot。snapshot 不能包含
原始文件路径、CSS text、artwork bytes 或未知变量；视觉切换不能触发窗口、媒体或业务状态重建。

## Provider Order

```text
I18nProvider
  ThemeProvider (selection + resolved Theme Pack adapter)
    LingUiProvider
      App
```

Toast 与 Tooltip viewport 由 `LingUiProvider` 挂载。业务模块只调用 hook，不自行创建
viewport。

PiP 不挂全局 Toast viewport。持续运行、权限、连接和 Stop failure 属于窗口内对象状态，使用
`CompactWindowStatusOverlay`；轻量成功通过 authoritative state 静默确认。

## No Fork Rule

Web 和 Desktop 不能各自实现 Button、Dialog、Menu、Toast 或状态 badge。出现平台差异时
先评估 token/slot；只有 OS 能力才能留在客户端 adapter。

Web 和 Desktop 也不能各自维护 Theme Pack Schema、built-in palette 或 token mapping。
平台只拥有 persistence、用户背景文件能力、模型/媒体任务连接和 window material adapter。

已停用的 Theme Studio 不直接读取 provider secret。Web/Desktop adapter 只暴露经过能力过滤的模型/媒体 job callback；API Key、Base URL 和 raw header 留在现有 provider domain。

Native recovery Dialog 是唯一允许不经过 React primitive 的视觉例外，因为 renderer 可能尚未
启动。它仍必须使用 typed bilingual catalog、明确 Retry/Quit 主次序和平台键盘默认行为，不能
在 Electron main 中散落临时文案。
