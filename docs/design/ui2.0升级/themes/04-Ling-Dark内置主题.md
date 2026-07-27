# Ling Dark 内置主题

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
| `--ling-bg-app` | `#000000` |
| `--ling-bg-panel` | `#050505` |
| `--ling-bg-elevated` | `#111111` |
| `--ling-bg-subtle` | `#171717` |
| `--ling-bg-pressed` | `#262626` |
| `--ling-bg-overlay` | `rgba(0, 0, 0, 0.68)` |
| `--ling-bg-code` | `#0d0d0d` |
| `--ling-bg-sidebar` | `#050505` |
| `--ling-bg-composer` | `#111111` |
| `--ling-text-strong` | `#f8fafc` |
| `--ling-text` | `#e5e7eb` |
| `--ling-text-muted` | `#a1a1aa` |
| `--ling-text-soft` | `#71717a` |
| `--ling-text-inverse` | `#111111` |
| `--ling-text-link` | `#93c5fd` |
| `--ling-border` | `#27272a` |
| `--ling-border-strong` | `#3f3f46` |
| `--ling-border-focus` | `#a1a1aa` |
| `--ling-accent` | `#ffffff` |
| `--ling-accent-hover` | `#e5e7eb` |
| `--ling-accent-pressed` | `#d4d4d8` |
| `--ling-accent-foreground` | `#111111` |
| `--ling-selection` | `rgba(255, 255, 255, 0.14)` |

## Semantic Tones

| Tone | Foreground | Soft background | Border |
|---|---|---|---|
| Success | `#4ade80` | `rgba(34, 197, 94, 0.12)` | `rgba(74, 222, 128, 0.34)` |
| Warning | `#fbbf24` | `rgba(245, 158, 11, 0.12)` | `rgba(251, 191, 36, 0.34)` |
| Danger | `#f87171` | `rgba(239, 68, 68, 0.12)` | `rgba(248, 113, 113, 0.34)` |
| Info | `#93c5fd` | `rgba(59, 130, 246, 0.12)` | `rgba(147, 197, 253, 0.34)` |

## Surface Rules

- App 纯黑与 panel `#050505` 只用于建立层级，不使用高亮边框包围每个 section。
- Elevated overlay 使用 `#111111` 与中等阴影，不使用硬编码黑色块覆盖内容。
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
- 刷新、硬重载、系统主题变化、窗口重开和 Desktop 冷启动录屏/帧证据。
- code syntax、canvas、图表、热力图、terminal、native controls 和 scrollbar 检查。
- `1440x960`、`1280x800`、macOS 和 Windows representative desktop viewport。

## Acceptance

- 无刷新黑闪后变白、白闪后变黑或背景与浮层不同步。
- 没有 Feature 通过 `data-ui-theme="ling-dark"` 修补样式。
- 灰色说明、disabled text、边框和 input placeholder 仍可读。
- status colors 在 dark surface 上不渗色、不大面积发光、不只依赖色彩区分。
- 切换到其他 Theme Pack 后 geometry、focus、scroll 和 overlay 状态不变。
