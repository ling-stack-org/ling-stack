# 主题包 Schema 与 Token 合同

## Goal

用一份可验证、可版本化、不能执行任意代码的 manifest 表达主题。
内置主题和本地导入主题使用同一语义合同。

## Implementation Status

The schema、complete token map and runtime validator are `implemented` for P2A as of 2026-07-18.
Current validation covers identity/reserved namespace、metadata、complete colors and shadows、contrast、
Desktop tokens、registered Profile IDs、local PNG/WebP artwork paths、generation metadata and exact
bootstrap variable allowlists. Registry source overrides manifest source for local install.

`.ling-theme` archive parsing、ZIP limits、asset decode/hash verification and published schema migration
tools remain assigned to Theme import and Compiler slices. Evidence:
[P2A Theme Registry metadata](../evidence/features/ui2-theme-registry/metadata.md).

## Package Shape

内置主题以 TypeScript manifest 编译进 `@ling-stack/ui-react`。本地导入使用
`.ling-theme` 归档，归档根目录必须包含 `theme.json`。

```text
theme.json
assets/
  background.webp       # optional
  hero.webp             # optional, approved Profile only
  corner-start.webp     # optional transparent decoration
  corner-end.webp       # optional transparent decoration
  preview.webp          # optional
LICENSE.txt              # optional but recommended
```

归档不得包含 CSS、JavaScript、HTML、字体、可执行文件、symlink 或远程 URL。

## Manifest

```ts
export interface LingThemePackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly familyId?: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  readonly colorScheme: "light" | "dark";
  readonly source: "built-in" | "local-import" | "local-generated";
  readonly tokens: LingThemeTokens;
  readonly desktop?: LingDesktopThemeTokens;
  readonly presentation?: LingThemePresentationSelection;
  readonly artwork?: LingThemeArtwork;
  readonly generation?: LingThemeGenerationMetadata;
  readonly preview?: string;
}
```

`source` 由注册器确定，导入文件中的同名字段被忽略，避免冒充内置或 AI 生成主题。
UI 2.0 主题实现开始前可以在 `schemaVersion: 1` 中加入这些可选字段；一旦已有正式用户主题，
新增必填字段或改变现有语义必须提升 schema version。

## Identity Rules

- `schemaVersion` 必须精确支持，不对未知版本做猜测兼容。
- `id` 使用小写 ASCII kebab-case，最长 64 字符。
- `ling-*` 命名空间为内置主题保留，本地导入时拒绝覆盖。
- `name` 最长 80 个 Unicode 字符，不允许控制字符或多行文本。
- `familyId` 只用于 ThemePicker 分组，不用于 token 继承。
- `homepage` 只能是 `https` URL，显式用户操作才能打开。

## Color Scheme

`colorScheme` 是主题包的固有元数据：

- 用于 `document.documentElement.style.colorScheme`。
- 用于原生 input、select、scrollbar、form autofill 和系统菜单协调。
- 用于固定主题失效时选择 `ling-light` 或 `ling-dark` 回退。
- 不会为当前主题自动生成另一套 token。

## Required Semantic Tokens

```ts
export interface LingThemeTokens {
  readonly background: {
    readonly app: string;
    readonly panel: string;
    readonly elevated: string;
    readonly subtle: string;
    readonly pressed: string;
    readonly overlay: string;
    readonly code: string;
    readonly sidebar: string;
    readonly composer: string;
  };
  readonly text: {
    readonly strong: string;
    readonly default: string;
    readonly muted: string;
    readonly soft: string;
    readonly inverse: string;
    readonly link: string;
  };
  readonly border: {
    readonly default: string;
    readonly strong: string;
    readonly focus: string;
  };
  readonly action: {
    readonly accent: string;
    readonly accentHover: string;
    readonly accentPressed: string;
    readonly accentForeground: string;
    readonly selection: string;
  };
  readonly status: {
    readonly success: LingSemanticTone;
    readonly warning: LingSemanticTone;
    readonly danger: LingSemanticTone;
    readonly info: LingSemanticTone;
  };
  readonly shadow: {
    readonly low: string;
    readonly medium: string;
    readonly overlay: string;
  };
  readonly native: {
    readonly selection: string;
    readonly scrollbar: string;
    readonly scrollbarHover: string;
  };
}

export interface LingSemanticTone {
  readonly foreground: string;
  readonly background: string;
  readonly border: string;
}
```

主题包必须提供完整 token set。注册器不从另一主题填补缺失字段。
可以使用 package 内置的安全 fallback 显示错误预览，但不能将不完整主题标记为已安装。

## Desktop Tokens

```ts
export interface LingDesktopThemeTokens {
  readonly windowBackground?: string;
  readonly sidebarMaterial?: string;
  readonly overlayMaterial?: string;
  readonly titlebarForeground?: string;
  readonly shadowStrength?: number;
  readonly blurStrength?: number;
}
```

- Desktop tokens 是可选表面增强，不能复制 Button/Dialog/Menu 样式。
- 不支持 blur 或用户关闭透明效果时，使用已验证的不透明 fallback。
- macOS 和 Windows 读取相同 token，平台 adapter 只解释窗口材质。

## Artwork

```ts
export type LingThemeArtworkSlot =
  | "shell-background"
  | "home-hero"
  | "home-corner-start"
  | "home-corner-end";

export interface LingThemeArtwork {
  readonly assets: readonly LingThemeArtworkAsset[];
}

export interface LingThemeArtworkAsset {
  readonly slot: LingThemeArtworkSlot;
  readonly image: string;
  readonly variants?: Readonly<Partial<Record<"16:9" | "16:10" | "21:9", string>>>;
  readonly safeArea?: "left" | "right" | "center" | "none";
  readonly focusX?: number;
  readonly focusY?: number;
  readonly taskMode?: "off" | "ambient" | "banner";
  readonly scrim?: "auto" | "light" | "dark";
}
```

- `focusX/focusY` 范围为 `0..1`。
- 第一阶段要求 `shell-background` 或 `home-hero` 至少有一个主资源；变体和装饰可选。
- `home-corner-*` 只允许透明 PNG/WebP，并且只在 `ling-illustrated` Profile 生效。
- slot 坐标、最大尺寸、断点和 z-index 由 Profile registry 决定，manifest 不能提供。
- 默认内置 `Ling Light` / `Ling Dark` 不使用背景图。
- Profile 的 shell ambient policy 不得减弱表格、Settings、Inspector、Dialog 和诊断内容可读性。
- 高密度页面可根据产品规则自动收敛为 token-only surface，但不改变主题 ID。

## Presentation Selection

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

- 未声明时使用 `ling-standard`。
- Theme Pack 只能选择注册表中存在的 Profile，不能提供 Profile definition。
- intensity 由 Profile 映射到内部 token，不能传入 opacity、blur、CSS variable 或函数。
- Feature 不得根据 Profile ID 编写样式分支，只有 AppShell presentation layer 可以消费。

## Generation Metadata

```ts
export interface LingThemeGenerationMetadata {
  readonly mode: "quick" | "generate" | "advanced";
  readonly createdAt: string;
  readonly compilerVersion: string;
  readonly plannerModelRef?: string;
  readonly artworkModelRef?: string;
  readonly promptTemplateVersion?: string;
  readonly sourceAssetCount: number;
}
```

- 只保存非秘密、非路径的来源信息，不保存 API Key、Base URL、provider response 或图片字节。
- 模型引用使用稳定 display reference，不把 Theme Pack 与具体 provider runtime 强绑定。
- 用户导出时可移除可选生成元数据，但 license/attribution warning 不能被静默删除。
- generation metadata 不参与 token resolution，不允许改变主题行为。

## Token Validation

- 颜色只允许标准 hex、rgb/rgba、hsl/hsla 和经过限制的 `color-mix()` 结果。
- 不允许 `url()`、`var()`、`env()`、`attr()`、CSS function injection 或分号。
- 阴影通过专用 parser 验证，不将原始字符串写入任意 CSS。
- status foreground/background/border 必须保留语义，不允许 danger 与 success 无法区分。
- 普通正文、muted text、focus ring、disabled 和主行动必须通过对比度阈值。
- 用户导入主题不得改变 geometry、motion、z-index 或图标 token。
- Profile、slot、intensity 和 generation metadata 必须通过 allowlist/schema 验证。

## CSS Variable Mapping

Registry 将 manifest 映射到固定变量，例如：

```text
tokens.background.app              -> --ling-bg-app
tokens.background.elevated         -> --ling-bg-elevated
tokens.text.default                -> --ling-text
tokens.border.focus                -> --ling-border-focus
tokens.action.accent               -> --ling-accent
tokens.status.danger.foreground    -> --ling-danger
tokens.status.danger.background    -> --ling-danger-soft
tokens.status.danger.border        -> --ling-danger-border
```

Feature 不得直接读取 manifest 字段，只能消费 CSS semantic variables 或共享视图模型。

## Versioning

- `schemaVersion: 1` 的 required token set 不可在 minor 发布中静默改变。
- 新增可选 token 需有 package fallback。
- 新增必填 token 必须提升 schema version 并提供显式迁移器。
- 无法迁移的主题保留本地文件，但标记为 incompatible，不直接删除用户资产。

## Non-Executable Contract

- Theme Pack 不包含 selector、class name、component name 或 DOM path。
- Theme Pack 不包含 CSS、JS、React component、Radix config 或业务 handler。
- Theme Pack 不能请求网络、读取 workspace、访问 daemon 或执行 shell。
- 主题显示名和描述不经过 `dangerouslySetInnerHTML`。
- Theme Pack 不包含 Profile definition、slot 坐标、prompt executor 或模型调用配置。
- AI plan/artwork 输出必须经过 Theme Compiler，不能直接作为 manifest 或 token map 安装。
