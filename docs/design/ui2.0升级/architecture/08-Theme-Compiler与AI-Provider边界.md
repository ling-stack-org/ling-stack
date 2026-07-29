# Theme Compiler 与 AI Provider 边界

## Goal

建立一个确定性、可测试、跨 Web/Desktop 共用的主题编译管线。AI 只能提供计划候选和
图片资产，最终 Theme Pack 必须由 Ling Theme Compiler 生成、校验和发布。

## Implementation Status

P2B.1 pure Compiler foundation is `implemented` as of 2026-07-18:

- app-owned Profile registry and route-policy resolution;
- deterministic local RGBA image analysis;
- Light/Dark semantic token derivation with bounded contrast repair;
- verified artwork identity/slot compilation without source paths;
- blockers for unsafe palette、unknown Profile、unsupported decoration、pseudo UI、text、Logo/watermark
  and invalid asset metadata;
- versioned generated manifest、preview model and normal Registry validation/install compatibility.

Provider adapters、draft controller、real image decode/worker、asset publish transaction and Theme Studio
remain later slices. Evidence:
[P2B.1 Presentation/Compiler metadata](../evidence/features/ui2-presentation-compiler/metadata.md).

Related docs:

- [主题包 Schema 与 Token 合同](../themes/02-主题包Schema与Token合同.md)
- [沉浸式主题与 Presentation Profile](../themes/06-沉浸式主题与Presentation-Profile.md)
- [AI 生成主题产品流程](../themes/07-AI生成主题产品流程.md)
- [Theme Studio 与生成预览](../components/13-Theme-Studio与生成预览.md)

## Module Boundary

```text
packages/ui-react/src/theme/
  presentation/
    profile-types.ts
    profile-registry.ts
    built-in-profiles.ts
  compiler/
    compiler-types.ts
    analyze-image.ts
    derive-palette.ts
    derive-tokens.ts
    validate-contrast.ts
    compile-artwork.ts
    compile-theme.ts
  generation/
    generation-types.ts
    validate-plan.ts

apps/web/src/shared/ui/theme-studio/
  use-theme-generation-controller.ts
  web-theme-draft-storage.ts
  theme-model-capability-adapter.ts
  theme-artwork-job-adapter.ts

apps/desktop/src/renderer/theme-studio/
  desktop-theme-draft-storage.ts
  desktop-theme-file-adapter.ts
```

- `ui-react` 拥有纯类型、图片分析、Profile registry、编译、验证和 fixture 数据。
- Web/Desktop adapter 拥有文件选择、持久化、i18n 和模型/媒体任务连接。
- Theme Studio 组件只接收 view model 和 callbacks，不直接调用 API Client。
- Compiler 不导入 Model Workbench、Media Jobs、Core、daemon、路由或 Settings feature。
- 模型 adapter 不进入 `ui-react`，避免共享组件包依赖 provider domain。

## Function IDs

```text
UI-THEME-COMPILER-001        Deterministic theme compilation
UI-THEME-IMAGE-ANALYSIS-001  Local palette, saliency and safe-area analysis
UI-THEME-PROVIDER-001        Planner and artwork capability adapters
UI-THEME-DRAFT-001           Draft persistence and invalidation graph
UI-THEME-PUBLISH-001         Atomic publish, registry install and rollback
```

## Compiler Inputs

```ts
export interface CompileLingThemeInput {
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
  };
  readonly colorScheme: "light" | "dark";
  readonly presentation: LingThemePresentationSelection;
  readonly artwork?: readonly ValidatedThemeArtworkInput[];
  readonly paletteCandidate?: ThemePaletteCandidate;
  readonly generation?: LingThemeGenerationMetadata;
  readonly attribution?: LingThemeAttribution;
}
```

`ValidatedThemeArtworkInput` 必须来自已经通过 MIME、尺寸、像素和文件身份校验的资源。
Compiler 不接受路径字符串、远程 URL、data URL 或任意 Blob URL 作为持久化身份。

## Compiler Outputs

```ts
export interface CompiledLingThemeCandidate {
  readonly manifest: LingThemePackManifest;
  readonly assets: readonly CompiledThemeAsset[];
  readonly tokenMap: Readonly<Record<LingSemanticVariable, string>>;
  readonly analysis: ThemeImageAnalysis;
  readonly verification: ThemeVerificationReport;
  readonly previewModel: ThemePreviewModel;
}
```

只有 `verification.blockers.length === 0` 的 candidate 可以发布。Warnings 可以由用户确认，
但不能绕过 Logo、执行内容、对比度、伪 UI 和路径安全 blocker。

## Deterministic Pipeline

```text
normalize identity and selection
  -> validate Profile allowlist
  -> decode and normalize artwork
  -> local image analysis
  -> derive semantic palette candidates
  -> compile full required token set
  -> compile route-aware artwork metadata
  -> validate contrast and semantic separation
  -> render isolated preview model
  -> produce verification report
```

相同输入、Compiler 版本和平台无关参数必须得到相同 manifest 和 token map。Desktop
material fallback 不写回 Theme Pack，只由运行时 client adapter 解释。

## Local Image Analysis

第一阶段使用低分辨率采样，不上传像素：

```ts
export interface ThemeImageAnalysis {
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly averageLuminance: number;
  readonly dominantColors: readonly string[];
  readonly accentCandidate: string;
  readonly leftInformationScore: number;
  readonly rightInformationScore: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly safeArea: "left" | "right" | "center" | "none";
  readonly recommendedProfileId: LingPresentationProfileId;
}
```

- 采样最长边不超过 `128px`，避免在主线程处理原始大图。
- Web 优先 worker/offscreen canvas；不可用时分帧处理并显示 Analyze progress。
- saliency 只用于焦点建议，不做人脸识别或身份推断。
- 图片亮度只建议 Theme Pack `colorScheme`，不能改变用户已确认的值。
- Planner 建议与本地分析冲突时，以最终图片本地分析和对比度结果为准。

## Token Derivation

Compiler 必须生成完整 Required Semantic Tokens：

1. 从图片中提取背景、panel、accent 候选。
2. 根据 `colorScheme` 建立可读 foreground 层级。
3. 生成 default/strong/focus border。
4. 生成 action hover/pressed/selection。
5. 从 Ling 固定语义基线派生 success/warning/danger/info，主题只能协调色相，不能交换语义。
6. 生成 shadow、native selection 和 scrollbar。
7. 验证正文、muted、disabled、focus、danger 和 accent foreground。

自动修复只允许在受控色彩空间内调整 lightness/chroma，最多执行固定次数。无法通过时
返回 blocker，不通过叠加任意黑白蒙层掩盖问题。

## Presentation Compilation

- Manifest 保存 `profileId` 和 allowlisted intensity，不保存 Profile CSS。
- Compiler 检查 Profile 支持的 artwork slot 和 decoration set。
- route policy 来自 Profile registry，不来自模型或 manifest。
- `shell-background` 必须有 safe area、focus 和 scrim。
- decoration 资源必须透明、无 UI、无文字，并绑定固定 slot。
- Profile 预览失败时 candidate 仍可切换到 `ling-standard` 重新编译，但需要用户确认。

## AI Provider Adapters

应用层提供两个窄 adapter：

```ts
export interface ThemePlannerAdapter {
  readonly listCapabilities: () => readonly ThemePlannerModelOption[];
  readonly plan: (request: ThemePlannerRequest, signal: AbortSignal) => Promise<ThemePlanCandidate>;
}

export interface ThemeArtworkAdapter {
  readonly listCapabilities: () => readonly ThemeArtworkModelOption[];
  readonly generate: (request: ThemeArtworkRequest, signal: AbortSignal) => Promise<ThemeArtworkResult>;
}
```

- Adapter 从 Model Workbench 的真实 capability/view model 派生选项。
- 不按 `gpt-image`、`vision` 等名称字符串判断能力。
- API Key、Base URL、secret header 和 provider raw response 不进入 Theme Studio props。
- Artwork 请求尽量复用既有 Media Jobs/Artifact 流程；如果当前 API 无法支持引用图、取消或
  结构化 Planner，必须补独立业务设计，不能在 UI 2.0 中伪造。
- Provider 原始错误映射为产品化错误；raw response 放 diagnostics Details。

## Draft State Graph

```ts
export interface ThemeGenerationDraft {
  readonly id: string;
  readonly mode: "quick" | "generate" | "advanced";
  readonly sourceRevision: number;
  readonly input: ThemeGenerationInputState;
  readonly analysis?: ThemeImageAnalysis;
  readonly plan?: ThemePlanCandidate;
  readonly artworkCandidates: readonly ThemeArtworkCandidate[];
  readonly selectedArtworkId?: string;
  readonly compiled?: CompiledLingThemeCandidate;
  readonly stage: ThemeGenerationStage;
  readonly issue?: ThemeGenerationIssue;
}
```

Invalidation rules：

| Changed input | Invalidate |
|---|---|
| source image | analysis, plan, artwork, compiled, verification |
| visual description | plan, artwork, compiled, verification |
| Planner model | plan, artwork, compiled, verification |
| artwork model | artwork, compiled, verification |
| selected artwork | compiled, verification |
| colorScheme/Profile/intensity | compiled, verification only |
| theme name/description | manifest identity only |

Controller 只重跑失效节点。用户从高级模式切到快速模式时保留源图，但清除未使用的
Planner/Artwork 结果，避免错误复用。

## Job And Cancellation

- 每次 plan/generate 有唯一 job ID、AbortSignal 和 input revision。
- 晚到的旧请求结果如果 revision 不匹配必须丢弃。
- Cancel 不删除草稿；Retry 从失败步骤创建新 job ID。
- 页面退出时询问是否保留有修改的草稿；已安装结果不再标记 dirty。
- 模型调用不由 Toast timer 控制，真实 job state 是唯一权威状态。

## Storage

### Web

- 草稿 metadata 和小型 preview 保存 IndexedDB。
- 原始/生成图片保存受管 Blob store，不进入 localStorage。
- localStorage 只保存最近草稿 ID 和 ThemeSelection bootstrap。

### Desktop

- 草稿位于 app data 的 `theme-drafts/<draftId>/`。
- 生成中使用随机 staging；完成后 atomic rename。
- Renderer 通过 preload 窄 API 读写，不获得任意文件系统路径。
- macOS/Windows 共享 draft/manifest contract，路径只由 adapter 决定。

## Publish Transaction

```text
verify compiled candidate
  -> write assets to staging
  -> write preview and attribution
  -> write manifest last
  -> verify checksums and real paths
  -> atomically publish theme directory/blob namespace
  -> register source=local-generated
  -> optionally apply through normal ThemeRegistry transaction
```

安装和应用是两个事务。安装成功但应用失败时主题保留为 ready，当前主题回滚，不删除用户
已经生成的资产。

## Package And File Size Guardrails

- `compile-theme.ts`、`derive-tokens.ts`、`analyze-image.ts` 分开维护。
- `use-theme-generation-controller.ts` 只协调状态，不包含 token 算法或 JSX。
- 单个生产源文件目标低于 `500` 行，禁止把 Compiler、Provider 和 UI 合并为大文件。
- 共享类型不重复定义在 Web/Desktop adapter。

## Test Strategy

- Compiler golden tests：固定图片分析 fixture -> stable token/manifest snapshot。
- Property tests：非法颜色、极端亮暗图、单色图、透明图、超宽图和损坏资源。
- Contrast tests：所有 required semantic pair。
- Provider adapter contract tests：capability mapping、cancel、timeout、late result。
- Draft reducer tests：invalidation、mode switch、retry、recovery。
- Publish tests：staging failure、checksum mismatch、registry failure、apply rollback。
- Web/Desktop tests：相同 candidate 生成相同 manifest 和 Profile ID。

## Hard Stops

- 使用模型输出作为 CSS、HTML、JS、selector 或直接 runtime style。
- UI component 直接请求 provider 或读取 API Key。
- 用正则从自由文本提取 manifest。
- Planner 返回的 token 未经 Compiler 验证直接安装。
- 模型失败后生成一个看似成功的空主题。
- Web 和 Desktop 分别实现 token derivation 或 Profile registry。
- 将用户原始绝对路径、secret 或完整 provider response 写入主题包。
