# 官方主题 Schema 与 Token 合同

## Goal

用一份可验证、可版本化、不能执行任意代码的 manifest 表达官方主题。所有可用主题都编译进 `@ling-stack/ui-react`，不来自用户导入包或远程资源。

## Implementation Status

经典主题的 schema、complete token map 和 runtime validator 已实现。`scene` metadata、三套官方场景主题、连续背景可见度和自定义媒体背景按[实施方案](../../full-window-theme-background-implementation-plan.md)进入当前交付。

## Package Shape

官方主题以 TypeScript manifest 编译进产品：

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
  readonly source: "built-in";
  readonly tokens: LingThemeTokens;
  readonly desktop?: LingDesktopThemeTokens;
  readonly presentation?: LingThemePresentationSelection;
  readonly scene?: LingThemeScene;
}
```

`ling-*` 命名空间保留给官方主题。validator 不接受非 built-in source 的 scene、Presentation Profile 自定义定义或任何可执行资源。

## Identity Rules

- `schemaVersion` 必须精确支持，不对未知版本做猜测兼容。
- `id` 使用小写 ASCII kebab-case，最长 64 字符。
- `name` 最长 80 个 Unicode 字符，不允许控制字符或多行文本。
- `familyId` 只用于 ThemePicker 分组，不用于 token 继承。
- `homepage` 只能是 `https` URL，显式用户操作才能打开。

## Color Scheme

`colorScheme` 是主题包固有元数据：用于 `document.documentElement.style.colorScheme`、原生控件和固定主题失效后的官方浅色/深色回退。不会为当前主题自动生成另一套 token。

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
```

主题包必须提供完整 token set。注册器不从另一主题填补缺失字段。正文、muted text、focus、status 和 accentForeground 必须通过对比度检查。

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

Desktop tokens 是可选表面增强，不能复制 Button/Dialog/Menu 样式。不支持 blur 或用户关闭透明效果时，使用已验证的不透明 fallback。macOS 和 Windows 读取相同 token，平台 adapter 只解释窗口材质。

## Scene Metadata

```ts
export type LingBuiltInSceneId =
  | "forest-breeze"
  | "ocean-drift"
  | "midnight-aurora"
  | "sakura-bloom"
  | "ember-dusk";

export interface LingThemeScene {
  readonly id: LingBuiltInSceneId;
  readonly mascot: boolean;
  readonly corners: boolean;
}
```

- `scene` 只能出现在官方 built-in manifest。
- scene ID 必须在应用注册的 renderer 中存在。
- manifest 不能保存 SVG、CSS、图片路径、脚本、坐标、opacity、selector 或远程 URL。
- scene renderer 负责全窗插画、主题缩略图、Ling Core IP 和角落装饰。
- 经典 `ling-light` / `ling-dark` 不声明 scene。

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

Theme Pack 只能选择注册表中存在的 Profile，不能提供 Profile definition。Feature 不得根据 Profile ID 编写样式分支，只有 AppShell presentation layer 可以消费。

## Theme Bootstrap

内置主题直接由编译后的 manifest 和 CSS layer 提供首帧，不需要 localStorage 保存大型变量快照。历史 local-import/local-generated bootstrap snapshot 不再授权给首帧，避免旧导入主题闪回。

## Variable Map

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

变量映射由单一 runtime style owner 应用。Feature 不直接读取 manifest 或拼装变量名。

## Validation Boundary

- 颜色必须是 safe hex、rgb(a)、hsl(a) 或受限制的 color-mix 值。
- shadow 不能包含可执行 CSS。
- scene、profile、identity 和 token 完整性由 validator 统一检查。
- 用户自定义背景不进入 Theme Pack schema，也不改变主题 tokens。
