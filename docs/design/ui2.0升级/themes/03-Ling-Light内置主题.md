# Ling Light 内置主题

## Identity

```text
id: ling-light
familyId: ling
name: Ling Light
colorScheme: light
source: built-in
artwork: none
```

`ling-light` 是一个完整独立 Theme Pack。它不从 `ling-dark` 继承或反向计算颜色。

## Product Character

- 光学白为主，但通过边框和细微 surface 层级避免平板感。
- 黑色主行动、中性次级操作、小范围语义色。
- 不使用大面积米色、蓝色、紫色或装饰渐变。
- Settings、表格、会话、Inspector 和诊断都以可扫描性为优先。

## Core Tokens

| Semantic token | Value |
|---|---|
| `--ling-bg-app` | `#ffffff` |
| `--ling-bg-panel` | `#ffffff` |
| `--ling-bg-elevated` | `#ffffff` |
| `--ling-bg-subtle` | `#f5f5f5` |
| `--ling-bg-pressed` | `#eeeeee` |
| `--ling-bg-overlay` | `rgba(17, 17, 17, 0.36)` |
| `--ling-bg-code` | `#f6f7f8` |
| `--ling-bg-sidebar` | `#fafafa` |
| `--ling-bg-composer` | `#ffffff` |
| `--ling-text-strong` | `#111111` |
| `--ling-text` | `#111111` |
| `--ling-text-muted` | `#6b6b6b` |
| `--ling-text-soft` | `#8a8a8a` |
| `--ling-text-inverse` | `#ffffff` |
| `--ling-text-link` | `#1d4ed8` |
| `--ling-border` | `#e5e5e5` |
| `--ling-border-strong` | `#d8d8d8` |
| `--ling-border-focus` | `#737373` |
| `--ling-accent` | `#111111` |
| `--ling-accent-hover` | `#262626` |
| `--ling-accent-pressed` | `#000000` |
| `--ling-accent-foreground` | `#ffffff` |
| `--ling-selection` | `rgba(17, 17, 17, 0.12)` |

## Semantic Tones

| Tone | Foreground | Soft background | Border |
|---|---|---|---|
| Success | `#087443` | `#edf8f2` | `#b7e2cc` |
| Warning | `#9a5b00` | `#fff7e8` | `#efd3a1` |
| Danger | `#b42318` | `#fff1f0` | `#f2bbb6` |
| Info | `#1d4ed8` | `#eff5ff` | `#bfd3ff` |

语义色只用于真实状态、小图标、细色条和轻背景，不用于大面积装饰。

## Surface Rules

- AppShell 与 PageContent 使用同一白色基底，依靠 divider 而非浮卡分区。
- Sidebar 使用轻微 `#fafafa`，active row 使用 pressed/selection token。
- Dialog/Drawer/Popover 使用 elevated surface 和轻阴影，不使用高饱和边框。
- Composer 与会话 feed 保持清晰边界，不增加渐变、光斑或毛玻璃。
- Code、terminal 和 raw details 使用专用 code surface，不直接使用纯黑。

## Desktop Surface

- macOS 和 Windows Desktop 可以使用有限窗口材质，但内容区保持不透明。
- Windows 不支持对应 blur 时使用 `--ling-bg-panel` 不透明 fallback。
- 窗口阴影、titlebar 和 traffic-light/window-control 对比由 Desktop adapter 验证。
- 主题不改变窗口控制位置、drag region 或平台菜单行为。

## Required Evidence

- `ui-primitives` 全组件截图。
- AppShell、Sidebar、Settings、Channel、Normal conversation、Teammate chat。
- Dialog、Drawer、Popover、Menu、Toast、InlineFeedback、Terminal、Inspector。
- `1440x960`、`1280x800`，Web 与 Desktop representative viewport。
- macOS/Windows 原生 input、select、scrollbar 和窗口控制对比。

## Acceptance

- 首帧不先显示 `ling-dark` 或无主题默认页。
- 没有 Feature 通过 `data-ui-theme="ling-light"` 修补样式。
- 没有硬编码白色面板与主题 token 产生色差。
- muted text、disabled、focus、danger 和 code surface 都满足对比要求。
- 切换到其他主题时页面 geometry 和控件 bounding box 不变。
