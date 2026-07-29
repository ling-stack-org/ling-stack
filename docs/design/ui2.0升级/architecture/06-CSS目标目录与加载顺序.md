# CSS 目标目录与加载顺序

## Current Baseline

Web 当前通过 `apps/web/src/styles.css` 顺序加载 42 个全局 CSS 文件，共约 49,205 行。
后加载的 `components.css`、`strict-console.css`、`sidebar.css` 等大量依赖 source order 和
高 specificity 覆盖前面的 feature CSS，导致主题、按钮和 overlay 难以追踪。

UI 2.0 使用明确的 package、conversation、shell、feature 和 temporary legacy 边界。

## Target File Tree

```text
packages/ui-react/src/styles/
  index.css
  foundation-tokens.css
  themes/
    built-in-themes.css
    runtime-theme.css
    presentation-profiles.css
  controls/
    button.css
    fields.css
  overlays/
    dialog-drawer.css
    menu-popover-tooltip.css
  navigation/
    tabs-segmented.css
  theme/
    theme-picker.css
    theme-studio-preview.css
  feedback/
    status-feedback.css
    toast-loading.css
  data-display/
    rows-tables.css
    empty-inspector.css
  desktop/
    capability-control.css
    compact-window.css

packages/conversation-ui-react/src/styles/
  index.css
  shell-feed.css
  composer.css
  messages-operations.css
  artifacts-previews.css
  dock-terminal.css

apps/web/src/styles/
  preflight.css
  index.css
  app/
    shell.css
    sidebar-layout.css
    settings-shell.css
    desktop-surface.css
  features/
    workspace/
    teammates/
    councils/
    model-workbench/
    plugins/
    automations/
    media-jobs/
    media-production/
    work-board/
    runs/
    approvals/
    profile/
    settings/
  legacy/
    # 迁移期临时文件，U13 必须为空并删除

apps/desktop/renderer/computer-use-preview/styles/
  index.css
  tokens.css
  shell.css
  status.css
  controls.css
```

单个生产 CSS 文件建议不超过 500 行，硬上限 800 行。超过上限必须按领域或组件责任继续拆分。

`theme/theme-studio-preview.css` 只拥有共享 synthetic viewport、四类 surface 和等比缩放几何；
Settings Theme Studio 页面排版归 Web focused CSS。它不能读取 Theme ID/Profile ID，也不能拥有
图片解码、object URL、tab/controller 或业务状态。

## Cascade Layers

`preflight.css` 首先声明唯一 layer 顺序：

```css
@layer ling.reset, ling.tokens.base, ling.tokens.theme, ling.tokens.client,
  ling.legacy, ling.primitives, ling.conversation, ling.shell,
  ling.features, ling.utilities;
```

责任如下：

| Layer | Ownership |
|---|---|
| `ling.reset` | box sizing、body、selection、基础 focus fallback |
| `ling.tokens.base` | spacing、typography、radius、motion、z-index 等不随主题变化的 foundation |
| `ling.tokens.theme` | built-in Theme Pack 和经验证 runtime semantic variables |
| `ling.tokens.client` | Web/Desktop window and material surface overrides |
| `ling.legacy` | 迁移期旧 CSS，优先级低于新 primitives |
| `ling.primitives` | `@ling-stack/ui-react` 基础组件 |
| `ling.conversation` | conversation-ui-react 领域组件 |
| `ling.shell` | AppShell、Sidebar、Settings shell、窗口 chrome |
| `ling.features` | 业务布局，不得覆盖 `.ling-ui-*` 内部 |
| `ling.utilities` | sr-only、稳定的少量布局 utility |

旧 CSS 必须通过 `@import url(...) layer(ling.legacy)` 加载。未进入 layer 的第一方 CSS 视为
迁移错误，因为 unlayered CSS 会绕过既定 cascade。

## Runtime Import Order

Web 最终入口顺序：

```ts
import "./styles/preflight.css";
import "@ling-stack/ui-react/styles.css";
import "@ling-stack/conversation-ui-react/styles.css";
import "./styles/index.css";
```

迁移期 `styles/index.css` 最后导入 `legacy/index.css`，但 legacy 内容属于较低 cascade layer，
不能覆盖新组件。当前 `styles.css` 在 U13 删除或变成对 `styles/index.css` 的兼容入口。

## Theme Coverage

- `:root` 只定义 foundation 和安全 fallback tokens。
- `:root[data-ui-theme="ling-light"]` 和 `:root[data-ui-theme="ling-dark"]` 是两个独立内置 Theme Pack。
- 本地导入主题通过单一 runtime style owner 写入经验证 semantic variables。
- 生成主题通过同一 runtime style owner；模型不能写入 CSS 文件或 style text。
- `presentation-profiles.css` 只包含 Ling 内置 Profile recipe，并由共享 presentation layer 使用。
- `:root[data-client="desktop"]` 只覆盖 Desktop surface、shadow 和 material tokens。
- `data-color-scheme` 只协调 native controls，不用于 Feature 组件分支。
- Feature CSS 不出现 `[data-theme]`、`[data-ui-theme]`、`[data-ui-presentation]`、具体
  Theme Pack ID 或 Presentation Profile ID。
  确需领域色差时必须先提升为 semantic token。

Desktop renderer 加载同一 package CSS，再加载 `desktop-surface.css`。该文件只能定义窗口
chrome、drag region 和 `[data-client="desktop"]` token，不能复制 Theme Pack、Button/Dialog/Menu 样式。

Shared main BrowserWindow 的现有 `apps/web/src/styles/app/macos-titlebar.css` 是 focused chrome owner。
它只在 `.desktop-macos` 下消费 `data-desktop-window-drag-region` /
`data-desktop-window-no-drag` contract，以及 Settings Back 的
`data-desktop-window-traffic-light-clearance` native safe-area exception；不能维护 Feature class 白名单，
也不能把使用 Dialog 层级的透明 sibling overlay 铺过控件。
Feature/shared Header 只声明 marker；平台 hit testing、traffic-light safe area 和 no-drag carve-out 仍由
该 focused shell CSS 独占。

Computer Use PiP 最终加载顺序：

```ts
import "@ling-stack/ui-react/styles.css";
import "./styles/index.css";
```

PiP `styles/index.css` 只进入 `ling.shell`/`ling.features` 中批准的 Desktop utility layer；
`tokens.css` 只能把 shared semantic token 映射成 compact-window alias，不能定义 Light/Dark
颜色字面量。`shell.css`、`status.css` 和 `controls.css` 只拥有媒体框、drag/no-drag、布局和
compact positioning。Button、Menu、Tooltip、Spinner、focus、状态色和 motion 来自 package。

Desktop main BrowserWindow 继续加载 shared Web CSS，不新增第二套 `desktop-main.css` 页面树。
native Dialog 不加载 CSS，其产品文案和行动顺序由 Desktop typed catalog 管理。

## Portal And Z-Index

| Surface | Token / value |
|---|---:|
| sticky header | 20 |
| menu | 40 |
| popover | 50 |
| dialog/drawer | 60 |
| toast | 80 |
| tooltip | 90 |

所有 Radix Portal 复用这些 tokens。Feature 不得创建 `9999` 等局部层级逃逸。

## Hard Stops

- Feature selector 命中 `.ling-ui-*` 后代。
- 在 tokens 之外新增主题颜色字面量。
- Feature 使用具体 Theme Pack ID 或 `data-color-scheme` 修补组件。
- Feature 使用具体 Presentation Profile ID 修补页面。
- 主题导入任意 CSS/JS，或通过 runtime style owner 写入非 allowlist 变量。
- 新增未分层的全局 CSS。
- 用 import 顺序覆盖组件状态，而不修复所有权。
- Desktop 通过独立 CSS 复制 Web primitives。
- PiP 使用 `prefers-color-scheme`、Theme Pack ID selector 或硬编码状态色拥有主题。
- Desktop utility CSS 重写 `.ling-ui-*` 组件内部或用 source order 覆盖 package state。
