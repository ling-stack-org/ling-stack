# 官方场景主题与自定义媒体背景实施方案

Status: active implementation plan\
Owner: theme and presentation delivery track\
Last verified: 2026-10-26\
Document type: implementation plan and task split\
Supersedes: 旧“整窗静态背景 P2”实施计划；长期行为由[统一合同](theme-background-motion-contract.md)、[Ling Core IP 设计合同](ling-core-ip-design.md)和 [UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)共同拥有\
Code and test anchors: `packages/ui-react/src/theme/built-ins/`、`packages/ui-react/src/theme-scene/`、`packages/ui-react/src/theme-picker/`、`apps/web/src/shared/ui/background/`、`apps/desktop/main/backgrounds/`、`apps/web/e2e/full-window-background.spec.ts`

## 1. 本期目标

把主题从“颜色主题 + 用户另配背景”升级为“官方场景主题 + 可选个人媒体覆盖”：

1. Ling 只提供官方内置主题，不提供主题包导入或 Theme Studio 生成入口。
2. 先建立 Ling Core IP，再新增 `ling-breeze`、`ling-ocean`、`ling-night`、`ling-sakura`、`ling-ember` 五套完整场景主题。
3. 主题列表直接展示场景缩略图，用户选择的是完整氛围；五个场景共享同一个 Core IP，只改变材质、道具、姿态和场景。
4. 自定义上传背景支持静态图片和本地 MP4/WebM 动态壁纸。
5. 背景可见度从三档改为连续滑杆，并兼容旧偏好迁移。
6. 在背景层稳定后，按[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)完成侧栏、顶栏、Composer、通用控件、弹层和设置页的完整主题表达。

本期不做主题商店、远程主题、第三方主题包 artwork、自动取色、程序生成背景、视频转码、云端同步或移动端验收。

## 2. 产品基线

| 项目 | 决定 |
|---|---|
| 主题来源 | 只使用编译进 `@ling-stack/ui-react` 的官方 built-in manifests |
| 导入/生成主题 | 产品入口移除；历史数据保留但不展示为可用主题，历史选择回退到官方浅色/深色 |
| 场景主题 | manifest 提供 tokens、scene metadata 和 Presentation Profile；场景渲染器由应用代码拥有 |
| Core IP | 轮廓、脸部、比例、材质变体和场景使用规则由 [Ling Core IP 设计合同](ling-core-ip-design.md)拥有 |
| 默认背景 | 经典主题为纯色；场景主题为应用内矢量插画 |
| 自定义背景 | 用户显式上传本地图片或视频后覆盖主题默认画面 |
| 清除背景 | 只移除用户媒体，回到当前主题默认画面；不重置主题 |
| 可见度 | 连续 `opacity`，20%–100%，默认 60%；旧三档映射为 45% / 60% / 75% |
| 保护页面 | settings、management、diagnostics、approvals、media-canvas、overlay 保持实底 |
| 设置入口 | 保持“设置 → 界面偏好”内的主题区和背景区，一个目的地 |
| UI 视觉适配 | 由独立 UI 方案拥有组件层级、材质、状态和截图门槛；本计划只拥有背景层与 route surface policy |

## 3. 首批场景主题

| ID | 名称 | 色彩方向 | 场景内容 |
|---|---|---|---|
| `ling-breeze` | Ling Breeze | 绿色、浅米白、自然清亮 | 天空、树枝、远近树层、小径、Ling 角色、角落枝叶 |
| `ling-ocean` | Ling Ocean | 蓝色、天空白、海面 | 云、海平线、波浪、小船、Ling 角色 |
| `ling-night` | Ling Night | 深蓝、紫色、青色极光 | 星空、极光、山层、月亮、Ling 角色 |
| `ling-sakura` | Ling Sakura | 粉白、暖米、柔和叶绿 | 花枝、石台、花瓣、Sakura Ling |
| `ling-ember` | Ling Ember | 暖橙、琥珀、可可棕 | 暮色丘陵、光路、草叶、Ember Ling |

每套主题必须通过现有 token 完整性和对比度验证。场景插画只能由应用代码注册，不能来自用户路径或远程资源；不包含可读文字、第三方 IP、伪控件或品牌替换。所有场景中的角色必须符合 Ling Core IP 合同，不能各自变成不同角色。

## 4. 模块职责

| 模块 | 落点 | 职责 |
|---|---|---|
| 主题类型与验证 | `packages/ui-react/src/theme/types.ts`、`validate-theme.ts` | 增加可选 `scene` metadata；只允许已知内置 scene；保持 token 完整和对比度验证 |
| Core IP | `docs/design/ling-core-ip-design.md`、后续受管视觉资产 | 先完成角色设定和五主题变体审核，再进入场景生产 |
| 内置主题 | `packages/ui-react/src/theme/built-ins/` | 新增三套官方场景 manifests；经典 light/dark 保持无 scene |
| 场景渲染 | `packages/ui-react/src/theme-scene/` | `SceneArtwork` 服务静态场景缩略图和全窗画面；`farbound-journey` 默认加载受管静态 WebP 母图 |
| 主题选择器 | `packages/ui-react/src/theme-picker/` | scene 主题渲染大幅缩略图；经典主题保留色板 |
| 主题设置 | `apps/web/src/features/settings/InterfaceThemeSettings.tsx` | 只展示 built-in 主题；移除导入、创建、修复、删除和预览入口 |
| 背景模型 | `packages/ui-react/src/theme/background/` | preference v2：selection + opacity；兼容 v1 strength 迁移；支持 image/video asset metadata |
| Web 背景仓库 | `apps/web/src/shared/ui/background/` | 图片继续规范化；视频验证格式/尺寸/时长并原样保存；IndexedDB 事务、revision 和回执不变 |
| Desktop 背景仓库 | `apps/desktop/main/backgrounds/` | 图片继续 codec；视频只接受有界 MP4/WebM 字节并原样受管保存；主进程重新验证摘要和大小 |
| 共享背景层 | `apps/web/src/shared/ui/background/WorkspaceBackgroundLayer.tsx` | 优先显示自定义媒体；无自定义时所有 scene（包括 `farbound-journey`）显示静态 `SceneArtwork`；只有用户自定义视频才负责播放、暂停和 reduced-motion |
| 设置操作 | `apps/web/src/features/settings/InterfaceBackgroundSettings.tsx` | 文件选择、拖放、预览、连续滑杆、应用、取消、恢复默认背景 |
| UI 视觉适配 | 见 [`ling-journey-ui-adaptation-implementation-plan.md`](ling-journey-ui-adaptation-implementation-plan.md) | 侧栏、顶栏、Composer、控件、弹层、设置页的主题材质和交互态；不改变业务状态机 |

## 5. 数据模型

### 5.1 主题 scene

```ts
type LingBuiltInSceneId = "forest-breeze" | "ocean-drift" | "midnight-aurora" | "sakura-bloom" | "ember-dusk";

interface LingThemeScene {
  readonly id: LingBuiltInSceneId;
  readonly mascot: boolean;
  readonly corners: boolean;
}
```

`scene` 是可选字段，只允许 built-in manifest 使用。底层 validator 遇到非 built-in scene 时拒绝。

### 5.2 背景 preference v2

```ts
type BackgroundSelection =
  | { readonly kind: "none" }
  | { readonly kind: "local-image"; readonly assetId: string }
  | { readonly kind: "local-video"; readonly assetId: string };

interface BackgroundPreference {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly selection: BackgroundSelection;
  readonly opacity: number; // 0.2–1
}
```

`none` 表示跟随主题默认画面，不是关闭主题自带场景。v1 `{ strength: "subtle" | "balanced" | "strong" }` 读取时映射为 `opacity: 0.45 / 0.60 / 0.75`；下一次提交写 v2。payload digest 覆盖 expectedRevision、selection 和 opacity。Web IndexedDB 版本不立即升级；仓库读取时做记录级迁移。

### 5.3 背景 asset

```ts
type BackgroundAsset =
  | { readonly kind: "image"; readonly assetId: string; readonly mimeType: "image/png"; readonly byteLength: number; readonly width: number; readonly height: number }
  | { readonly kind: "video"; readonly assetId: string; readonly mimeType: "video/mp4" | "video/webm"; readonly byteLength: number; readonly width: number; readonly height: number; readonly duration: number };
```

旧 PNG asset 读取时补 `kind: "image"`。视频保存原始 MP4/WebM 字节，不转码；尺寸和时长用于验证与展示。安全根仍然是字节大小、容器签名、摘要、受管路径和浏览器解码结果。

## 6. 关键实现

### 6.1 Core IP 与场景主题

先完成 Ling Core IP turnaround 与五主题变体表，再重做正式场景。五张背景图必须共享同一角色轮廓和脸部规则，只改变材质、颜色、道具、姿态和光影。

`SceneArtwork` 使用 inline SVG，按 16:9 设计并通过 `preserveAspectRatio="xMidYMid slice"` 覆盖全窗。Breeze、Ocean、Night 继续由 SVG 绘制；Journey 的 SVG 只加载受管静态母图，不渲染 rider、剑光或其它额外人物节点；scene definition 由应用注册，不让主题包传入 SVG。

`ThemePickerOption` 增加可选 scene。scene 主题卡显示约 84px 的大幅缩略图，经典主题保持 44px 色板。`WorkspaceBackgroundLayer` 优先显示自定义媒体；无自定义且 manifest 有 scene 时显示主题场景；否则保持纯色。

`data-user-background="ready"` 表示共享背景层可见，`data-background-source` 区分 `theme-scene`、`local-image`、`local-video` 和 `theme-solid`。保护路由仍由 presentation policy 回退实底。

### 6.2 连续可见度

`InterfaceBackgroundSettings` 用 range slider 替换三档 Select。滑杆值是 20–100 的整数百分比；内部存 0.2–1。预览和全窗使用同一个 opacity。`backgroundRecipe(opacity)` 输出 `scrim = 1 - opacity`；面板和侧栏 alpha 继续由对比度 resolver 收紧。1180–1280px 将高于 60% 的可见度收敛到 60%。

### 6.2A UI 视觉适配边界

背景层只拥有 L0–L2 的场景、环境和 route-aware surface policy。Composer、按钮、列表、卡片、Tabs、状态、Dialog、Popover、Menu、Toast、Tooltip 和设置页的组件级视觉，必须按[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)执行。实现时不得在业务组件里添加 `ling-journey` 主题 ID 分支；组件只消费共享 semantic variables 和 presentation profile。

### 6.3 动态壁纸

文件入口接受 MP4/WebM。视频最大 64 MiB、4096 单边、120 秒。先检查 MP4 `ftyp` 或 WebM EBML 签名，再在 renderer 使用临时 object URL 验证可解码、宽高和时长。

Desktop prepare 不转码。主进程只接受 renderer 已验证的候选，重新检查字节、签名、大小和摘要，并把 metadata 作为展示信息存储。renderer 无法解码时不得提交。

共享 video 使用 `muted`、`loop`、`playsInline`、`preload="auto"`；页面隐藏暂停，可见后恢复；reduced-motion 不自动播放；解码错误回退主题默认画面。替换、取消、清除、unmount 均释放 object URL 和候选 lease。

### 6.4 移除导入/生成主题入口

`InterfaceThemeSettings` 只渲染 built-in 主题卡，不渲染 Theme Studio、Import、Reimport、Delete、Repair 或 Preview 操作。`PersonalInterfaceSettingsPanel` 移除 quick-studio surface。`ThemeProvider` 不再把本地导入/生成 manifests 安装到运行时 registry；历史 fixed selection 在 registry ready 后按颜色模式回退到官方主题。历史 bootstrap snapshot 不再授权给非 built-in 首帧。

底层 package repository、IPC 和历史数据暂不删除；后续清理由单独迁移和回退计划处理。

## 7. 任务拆分

| 任务 | 依赖 | 完成条件 |
|---|---|---|
| S0-T1 Core IP 设计 | 本文档与 IP 合同 | V1.2 水墨灵台心印组件、三星错峰动效和 Web 首页截图已落地；待产品确认最终视觉，再补五主题变体并通过人工审核 |
| S1-T1 文档与产品边界 | 无 | 统一合同、实施计划、验收矩阵和主题 docs 与新边界一致 |
| S1-T2 scene 类型和内置主题 | S0-T1、S1-T1 | 五个 manifests 通过 validator；built-in 列表和 fallback 正确 |
| S1-T3 SceneArtwork | S1-T2 | 五个场景可用于缩略图和全窗；无外部资源；reduced-motion 无动画 |
| S1-T4 主题选择器与设置入口 | S1-T3 | scene 缩略图、键盘/选中状态正常；导入/生成入口不可见 |
| S1-T5 全窗场景接线 | S1-T3 | 无自定义背景时 scene 连续透出；切主题/保护路由/窄窗行为正确 |
| S1-T6 UI 视觉合同与 token | S1-T1 | L0–L4 材质、组件矩阵、状态合同和 1440×960 基线截图通过评审 |
| S1-T7 Shell 与 Composer 适配 | S1-T6 | 侧栏、顶栏、首页、Composer、快捷入口和拖放状态具有明确 Journey 视觉 |
| S1-T8 通用控件与 Overlay 适配 | S1-T6 | Button、IconButton、Tabs、List、Card、Dialog、Popover、Menu、Toast、Tooltip 状态一致 |
| S1-T9 设置与主题选择器适配 | S1-T6 | 主题卡、背景设置、slider、保护设置页的层级和状态一致 |
| S2-T1 preference v2 与滑杆 | S1-T1 | v1 迁移、opacity digest、Web/Desktop commit/read 通过 |
| S3-T1 视频模型与 Web 验证 | S2-T1 | MP4/WebM 大小、签名、metadata、候选释放和错误路径通过 |
| S3-T2 视频渲染与 Desktop 存储 | S3-T1 | 共享 video 播放/暂停/reduced-motion；Desktop 原样保存和恢复通过 |
| S4-T1 回归与视觉验收 | S1–S3 | typecheck、lint、model tests、focused E2E、真实浏览器截图和 console 无错误 |
| S4-T2 平台放行 | S4-T1 | 签名 macOS/Windows、原生拖放、性能、内存和可读性矩阵关闭 |

执行顺序：S0-T1 → S1-T1 → S1-T2/S1-T3 → S1-T4/S1-T5 → S1-T6 → S1-T7/S1-T8/S1-T9 → S2-T1 → S3-T1 → S3-T2 → S4-T1 → S4-T2。

## 8. 回退与验证边界

代码回退时关闭 scene renderer、动态壁纸和新设置入口，保留用户已提交背景数据和主题选择。v2 preference 的旧代码无法读取时，兼容回退版本应忽略背景能力并回到官方纯色/场景，不删除用户数据。历史导入主题只回退到官方主题，不自动删除包数据。

本计划定义当前源码实施路径。任何“已完成”结论必须以本轮构建、模型测试、focused Playwright、真实浏览器截图和平台验收为准；旧静态背景报告只证明旧 P2，不证明场景主题、视频壁纸或连续可见度已经验收。
