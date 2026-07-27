# 沉浸式主题与 Presentation Profile

## Goal

让 Theme Pack 在不执行任意 CSS、JavaScript 或修改业务布局的前提下，选择 Ling
预先实现并验证过的全局表现配方。Presentation Profile 负责“图片和 token 如何进入
产品表面”，Theme Pack 负责“提供什么图片和 token”。

## Implementation Status

P2B.1 Profile foundation is `implemented` as of 2026-07-18. The shared registry owns all four Profile
definitions、surface route policy、slot/decoration support、compact reduction and accessibility fallback.
AppShell emits generic policy attributes without Feature Profile branches; Computer Use PiP is forced to
`overlay/solid/off/off`.

Actual artwork byte storage、decode/preload/crossfade and the full visual surface layer remain U4/U7 work.
Evidence: [P2B.1 Presentation/Compiler metadata](../evidence/features/ui2-presentation-compiler/metadata.md).

Related docs:

- [独立主题包产品模型](01-独立主题包产品模型.md)
- [主题包 Schema 与 Token 合同](02-主题包Schema与Token合同.md)
- [主题资源导入与安全](05-主题资源导入与安全.md)
- [Motion 与状态转场](../foundations/08-Motion与状态转场.md)
- [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
- [Theme Compiler 与 AI Provider 边界](../architecture/08-Theme-Compiler与AI-Provider边界.md)

## Core Decision

Presentation Profile 是由 Ling 代码拥有、版本化和测试的表现模板，不是主题提供的
CSS class，也不是可以修改页面结构的插件。

```text
Theme Pack
  tokens + artwork + approved parameters
                     |
                     v
Presentation Profile Registry
  app-owned route and surface recipes
                     |
                     v
Ling UI primitives and feature layout
```

Theme Pack 可以选择 Profile，并调整允许的强度、焦点和装饰资源。Profile 的 CSS、
DOM、断点、z-index、动效和回退全部由 `@ling-stack/ui-react` 与 AppShell 拥有。

## Function IDs

```text
UI-THEME-PRESENTATION-001  Presentation Profile registry and contract
UI-THEME-PRESENTATION-002  Route-aware artwork and surface policy
UI-THEME-PRESENTATION-003  Decorative slot safety and responsive behavior
UI-THEME-PRESENTATION-004  Reduced transparency and platform fallback
```

## Theme Manifest Contract

Theme Pack 只声明 Profile ID 和受限参数：

```ts
export type LingPresentationProfileId =
  | "ling-standard"
  | "ling-glass"
  | "ling-immersive"
  | "ling-illustrated";

export interface LingThemePresentationSelection {
  readonly profileId: LingPresentationProfileId;
  readonly surfaceIntensity?: "subtle" | "balanced" | "strong";
  readonly artworkIntensity?: "subtle" | "balanced" | "strong";
  readonly decorationSet?: "none" | "home-corners";
}
```

- 未声明 `presentation` 时使用 `ling-standard`。
- 未知 Profile ID 导入失败，不猜测相近字符串。
- 强度值映射到 Profile 内部固定 token，不允许传入原始 opacity、blur 或 selector。
- `decorationSet` 只有 Profile 声明支持且资源通过验证时才生效。
- Profile ID 不影响 Theme Pack 的 `colorScheme`、System selection 或 fallback 归属。

## App-Owned Profile Contract

内部注册表拥有完整行为：

```ts
export interface LingPresentationProfileDefinition {
  readonly id: LingPresentationProfileId;
  readonly supportedArtworkSlots: readonly LingThemeArtworkSlot[];
  readonly supportedDecorationSets: readonly LingThemeDecorationSet[];
  readonly routePolicy: LingPresentationRoutePolicy;
  readonly surfaceRecipe: LingPresentationSurfaceRecipe;
  readonly desktopRecipe: LingPresentationDesktopRecipe;
  readonly fallbackProfileId: "ling-standard";
}
```

Profile definition 不进入导入包，不允许用户覆盖。新增 Profile 需要共享包代码、视觉
fixtures、全产品 smoke 和 schema allowlist 同时更新。

## Built-In Profiles

### ling-standard

安静、清晰、以工作内容为主的默认配方。

- App、Sidebar、Composer 和面板使用实色或接近实色 surface。
- 背景图默认只在 Home 使用，其他页面使用 token-only surface。
- 不显示独立装饰槽位。
- Settings、表格、Inspector、Dialog 和诊断始终使用清晰不透明层。
- 资源缺失或平台不支持时无需改变布局即可完整回退。

### ling-glass

允许全窗口背景贯穿壳层，但保持稳定阅读层。

- Home、Sidebar 和 App background 可以看到连续背景。
- Sidebar、Header、Composer 使用受控 frosted surface。
- 会话 Feed 使用低透明环境层，消息内容本身保持可读。
- Settings、Model Workbench、Plugin、Skill、Diagnostics 和所有 overlay 使用高不透明度。
- Windows 不支持目标材质时使用带噪声抑制的不透明 surface，不模拟 macOS 材质。

### ling-immersive

用于截图所示的全局氛围变化，Home 表现强，工作页面自动降噪。

- Home 使用 full-window 或 home-hero artwork，允许主视觉占据大部分内容区。
- Sidebar 与 Home 工具区使用协调的半透明 surface。
- Conversation、Channel、Teammate Chat 只保留低强度 ambient artwork。
- Settings、管理表格、运行诊断和审批关闭 artwork，只保留主题 token。
- Dialog、Drawer、Popover、Menu 和 Toast 不继承背景图，只使用 verified overlay tokens。
- Profile 不新增营销式内容、虚构功能卡或主题专属业务行动。

### ling-illustrated

在 `ling-immersive` 基础上开放 Ling 固定的装饰槽位。

- 允许 Home Hero、右下角装饰和左右角环境装饰。
- 装饰必须是独立透明 PNG/WebP，不把 UI、按钮、文字或 Logo 画进背景。
- 装饰层 `pointer-events: none`、`aria-hidden="true"`，不能成为交互入口。
- 装饰在窄窗口、reduced transparency、forced colors 和高密度工作页自动关闭。
- 不允许主题改变 Logo、导航图标、产品名称、菜单文字或真实状态数据。

## Route Policy Matrix

| Surface | standard | glass | immersive | illustrated |
|---|---|---|---|---|
| Home | optional home artwork | continuous artwork | strong hero/full-window | strong + approved decorations |
| Sidebar | solid | frosted | frosted | frosted |
| Conversation | token-only | low ambient | low ambient | low ambient, no decoration |
| Channel | token-only | low ambient | low ambient | low ambient, no decoration |
| Settings | token-only | token-only | token-only | token-only |
| Management tables | token-only | token-only | token-only | token-only |
| Media canvas | domain surface | domain surface | domain surface | domain surface |
| Dialog/Drawer/Menu | opaque overlay | opaque overlay | opaque overlay | opaque overlay |
| Diagnostics/Approvals | opaque | opaque | opaque | opaque |

“token-only”表示主题颜色仍生效，只关闭背景图片和装饰，不切换 Theme Pack ID。

## Artwork Slots

允许的第一阶段 slot：

```ts
export type LingThemeArtworkSlot =
  | "shell-background"
  | "home-hero"
  | "home-corner-start"
  | "home-corner-end";
```

| Slot | Purpose | Required behavior |
|---|---|---|
| shell-background | 全窗口连续背景 | cover、focus/safe area、route-aware intensity |
| home-hero | 首页主视觉 | 不承载按钮或可读文字，不改变 Home 真实任务结构 |
| home-corner-start | 首页左下/左上环境装饰 | 不覆盖 Sidebar、标题、Composer |
| home-corner-end | 首页右下/右上环境装饰 | 不覆盖主行动、状态、Toast viewport |

主题资源不能自定义 slot 坐标。Profile 根据 viewport、Sidebar 宽度、title bar 和
Composer 高度计算 approved placement。任何关键装饰距可交互区域至少 `16px`。

## Surface Recipes

Profile 只选择下列内部 surface recipe，不接受原始 CSS 数值：

```text
solid       opaque semantic surface
frosted     platform material or verified translucent fallback
translucent controlled alpha + scrim, no unbounded backdrop filter
```

- `surfaceIntensity` 只影响 AppShell、Sidebar、Home tools 和 Composer 的批准 surface。
- 表格、Settings、Inspector、code、terminal、approval 和 overlay 不接受 strong translucency。
- backdrop blur 由 Desktop/Web client token 决定，并受性能与 reduced transparency 限制。
- 不使用 `filter` 模糊真实内容，不让背景穿透到敏感输入或诊断文本下方。

## Responsive And Large Displays

- Profile 不改变 Foundation 字号、控件高度、导航宽度或页面断点。
- 背景使用 `cover`，焦点和 safe area 保证关键主体不被 Sidebar/Composer 裁切。
- `1280x800` 下关闭非必要 corner decoration，并降低 Home artwork intensity。
- `1440x960` 使用标准 Profile 构图。
- `1920x1080`、`2560x1440` 不放大 UI 字体，只增加内容留白和背景可视区域。
- `3440x1440` 优先使用 ultrawide variant；没有 variant 时保持焦点并允许两侧裁切/留色。
- 窗口低于 Desktop 支持下限时使用 `ling-standard` 的表面规则，Theme Pack token 仍保留。

## Motion

- Profile 切换与 Theme Pack 一起在单一 apply transaction 中完成。
- 背景资源预解码完成后再提交，不显示破图或先黑后白。
- 同一 Profile 的 token 切换可使用 `180ms` color transition。
- artwork 只允许 `180ms` opacity crossfade，不缩放、不平移、不视差。
- Profile 改变不重放页面入场动画，不关闭 Dialog、Drawer、Summary 或 Terminal。
- reduced motion 下 artwork 与 surface 直接切换。

## Accessibility And Fallback

- `prefers-reduced-transparency`、系统关闭透明效果或 GPU fallback 时使用 solid recipe。
- forced-colors 下关闭 artwork 和 decoration，保留系统颜色与真实 focus ring。
- 背景分析失败、资源损坏或对比度不足时关闭 artwork，不修补 Feature CSS。
- 装饰资源失败不影响主背景；主背景失败不影响 Theme Pack token。
- Profile fallback 不改变用户当前业务状态，也不自动切换到另一个 Theme Pack。

## Security Rules

- Profile 不包含 selector、DOM path、component name、ViewId 或业务 handler。
- Theme Pack 不能提供 Profile CSS、JS、HTML、字体、SVG filter 或远程资源。
- `LingStackLogo`、favicon、Lucide action map 和产品文案保持受保护。
- 背景和装饰中不得包含伪按钮、伪输入框、可读指令、Logo 或水印。
- 装饰不能覆盖权限、审批、诊断、危险操作和 disabled reason。

## Acceptance

- 四个 Profile 都有 Home、Conversation、Settings、Dialog fixtures。
- `ling-immersive` 可产生全局明显变化，但真实功能、布局和 hit area 不变。
- Profile 切换无首帧黑闪/白闪，无页面 remount、滚动或焦点丢失。
- 背景和装饰在 `1280x800`、`1440x960`、`1920x1080`、`2560x1440`、
  `3440x1440` 下不遮挡真实控件。
- macOS 和 Windows 使用相同 Profile ID；平台差异只来自 surface adapter。
- 任意导入 Theme Pack 无法创建第五种未注册 Profile 或执行任意样式。
