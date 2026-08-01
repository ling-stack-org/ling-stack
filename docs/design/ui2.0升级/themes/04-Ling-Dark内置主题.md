# Ling Dark 内置主题

Status: active Theme Pack reference; the former pure-black surface direction was
superseded on 2026-07-31 by
[Dark Mode Surface Convergence](../../dark-mode-surface-convergence.md).

The canonical values live in
`packages/ui-react/src/theme/built-ins/ling-dark.ts`. Historical screenshots may still
show the earlier pure-black implementation; they are implementation evidence, not the
current visual target.

## Identity

```text
id: ling-dark
familyId: ling
name: Ling Dark
colorScheme: dark
source: built-in
artwork: none
```

`ling-dark` 是完整独立 Theme Pack。它不是 `ling-light` 的 CSS override 集，
也不通过反转、降亮或算法自动生成。

## Product Character

- 中性黑和深灰层级，不使用整页暗蓝或紫蓝色调。
- 不依赖大面积光晕、发光边框和半透明灰字建立科技感。
- 正文、muted text、边框和操作状态必须有稳定对比层级。
- 成功、警告和失败只占用小范围语义色。

## Core Tokens

| Semantic token | Value |
|---|---|
| `--ling-bg-app` | `#111315` |
| `--ling-bg-panel` | `#171a1d` |
| `--ling-bg-elevated` | `#1d2024` |
| `--ling-bg-subtle` | `#22262b` |
| `--ling-bg-pressed` | `#2c3137` |
| `--ling-bg-overlay` | `rgb(0 0 0 / 58%)` |
| `--ling-bg-code` | `#15181b` |
| `--ling-bg-sidebar` | `#141618` |
| `--ling-bg-composer` | `#191c20` |
| `--ling-text-strong` | `#f4f5f6` |
| `--ling-text-default` | `#d7dbe0` |
| `--ling-text-muted` | `#9ba3ad` |
| `--ling-text-soft` | `#89929d` |
| `--ling-text-inverse` | `#111315` |
| `--ling-text-link` | `#9fc2e6` |
| `--ling-border-default` | `#353b42` |
| `--ling-border-strong` | `#4b535d` |
| `--ling-border-focus` | `#8aa8c7` |
| `--ling-action-accent` | `#f0f2f4` |
| `--ling-action-accent-hover` | `#ffffff` |
| `--ling-action-accent-pressed` | `#d8dde2` |
| `--ling-action-accent-fg` | `#151719` |
| `--ling-action-selection` | `#2b3a49` |

## Semantic Tones

| Tone | Foreground | Soft background | Border |
|---|---|---|---|
| Success | `#79bd94` | `#1c2c23` | `#365a45` |
| Warning | `#ddb45f` | `#2c271b` | `#5f512f` |
| Danger | `#e48782` | `#2d2020` | `#633c3a` |
| Info | `#8cb5df` | `#1d2935` | `#3a5773` |

## Surface Rules

- App 使用中性深灰 `#111315`；opaque 纯黑不再是产品 surface。
- Panel、Sidebar、Composer 与 Elevated 使用相邻但可识别的深灰层级，不使用高亮边框包围每个 section。
- 纯黑仅可作为遮罩、阴影或媒体 letterbox 的带透明度材料。
- Composer、terminal、code block 和 Inspector 分别使用专用语义 surface。
- disabled 不得仅通过降低 opacity 到难以读取的程度。
- Toast、Popover 和 Menu 不出现硬编码白色内层或纯黑透明断层。

## Desktop Surface

- macOS 材质使用 dark surface token 叠加有限 blur，不把正文面板变成透明玻璃。
- Windows Mica/Acrylic 只在窗口 shell 可用，不支持时回退到不透明 dark surface。
- titlebar、window controls、context menu 和原生 scrollbar 必须与 `colorScheme: dark` 一致。
- Desktop 不使用 macOS-only selector 重写共享 Button、Dialog 或会话控件。

## First-Paint Contract

- HTML/renderer 在 React 启动前解析到 `ling-dark`。
- `data-ui-theme="ling-dark"`、`data-color-scheme="dark"` 和 native `color-scheme: dark`
  必须在首个可见帧一致。
- 不先渲染一帧 `ling-light`，再由 effect 切换到 dark。
- 主题资源失效时回退到 token-only `ling-dark`，不渲染空白背景。

## Required Evidence

- 与 Ling Light 相同的全组件、Shell、Settings、会话和 overlay 证据。
- 首页作为新 surface hierarchy 的首个视觉验收切片；该方向已于 2026-07-31
  确认，并授权迁移 Settings 与其余产品表面。
- 刷新、硬重载、系统主题变化、窗口重开和 Desktop 冷启动录屏/帧证据。
- code syntax、canvas、图表、热力图、terminal、native controls 和 scrollbar 检查。
- `1440x960`、`1280x800`、macOS 和 Windows representative desktop viewport。

## Acceptance

- 无刷新黑闪后变白、白闪后变黑或背景与浮层不同步。
- 没有 Feature 通过 `data-ui-theme="ling-dark"` 修补样式。
- 灰色说明、disabled text、边框和 input placeholder 仍可读。
- status colors 在 dark surface 上不渗色、不大面积发光、不只依赖色彩区分。
- 切换到其他 Theme Pack 后 geometry、focus、scroll 和 overlay 状态不变。
