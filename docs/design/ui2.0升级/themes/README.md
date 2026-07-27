# Ling UI 2.0 主题系统入口

## Status

Design source of truth. P2A ThemeRegistry and P2B.1 Presentation Profile/Theme Compiler foundations are
`implemented`. P7C.1 Web ThemePicker/import/preview/reimport/delete is `verified` as of 2026-07-20
under D1=A token plus isolated preview and D2=A Web IndexedDB first. Real artwork publish/render,
Desktop native Theme Pack persistence and Quick/Generate/Advanced Theme Studio remain open.

Implemented evidence:

- package tests `28/28`;
- focused Theme Registry Web E2E `5/5`;
- Web P2A/Dark/Desktop bridge target set `27/27`;
- Desktop theme store/IPC `6/6` and Computer Use PiP renderer `23/23`;
- [P2A Theme Registry screenshots and metadata](../evidence/features/ui2-theme-registry/metadata.md).
- P2B.1 package suite `36/36`、target Web regression `63/63` and
  [Presentation/Compiler evidence](../evidence/features/ui2-presentation-compiler/metadata.md).
- P7C.1 package `45/45`、focused `5/5`、selected `83/83` and
  [Web Theme Pack evidence](../evidence/settings/theme-packages/metadata.md).

Desktop `appData/themes/<id>`、staging/atomic rename、typed IPC、packaged restart and macOS/Windows
evidence are tracked as `DESKTOP-THEME-PACK-PERSISTENCE-001` and must not be inferred from Web evidence.

## Core Decision

Ling 的最小外观单元是独立 Theme Pack。`ling-light`、`ling-dark`、
`graphite`、`forest-mist` 或本地导入主题都是平级主题包。

不存在“每个主题内部必须提供 Light/Dark 两套颜色”的规则。

- `Ling Light` 是一个完整主题包。
- `Ling Dark` 是另一个完整主题包。
- `System` 不是主题，而是根据操作系统外观选择主题包的策略。
- 主题包的 `colorScheme` 只用于浏览器原生控件、滚动条和系统颜色协调。

## Reading Order

1. [独立主题包产品模型](01-独立主题包产品模型.md)
2. [主题包 Schema 与 Token 合同](02-主题包Schema与Token合同.md)
3. [Ling Light 内置主题](03-Ling-Light内置主题.md)
4. [Ling Dark 内置主题](04-Ling-Dark内置主题.md)
5. [主题资源导入与安全](05-主题资源导入与安全.md)
6. [沉浸式主题与 Presentation Profile](06-沉浸式主题与Presentation-Profile.md)
7. [AI 生成主题产品流程](07-AI生成主题产品流程.md)
8. [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
9. [Theme Compiler 与 AI Provider 边界](../architecture/08-Theme-Compiler与AI-Provider边界.md)
10. [ThemePicker 与主题预览](../components/12-ThemePicker与主题预览.md)
11. [Theme Studio 与生成预览](../components/13-Theme-Studio与生成预览.md)
12. [主题系统迁移与兼容验收矩阵](../migration/11-主题系统迁移与兼容验收矩阵.md)
13. [AI 主题与跨平台验收矩阵](../migration/12-AI主题与跨平台验收矩阵.md)

## Ownership

| Concern | Owner |
|---|---|
| Theme Pack types, built-in registry, token validation | `@ling-stack/ui-react` |
| Web i18n, selection adapter, bootstrap mirror | `apps/web/src/shared/ui` |
| Electron persistence, local theme files, window surface | Desktop adapter |
| Business state, API, permissions, workspace data | Existing domains; theme system must not own |
| Logo and favicon | Protected brand assets; theme system cannot replace |

## Theme Layers

```text
Foundation geometry and typography
  -> selected Theme Pack semantic tokens
     -> Web/Desktop client surface tokens
        -> shared primitives
           -> feature layout
```

Theme Pack 可以改变颜色、surface、边框、阴影、accent 和经过限制的本地背景资源。
它不得改变控件高度、字号、间距、栅格、图标语义、Logo、业务文案或交互状态机。

Theme Pack 可以选择 Ling 内置并验证的 Presentation Profile，以决定背景、磨砂 surface、
route-aware artwork 和固定装饰槽位如何呈现。Profile 的 CSS、DOM、断点和动效由 Ling
代码拥有，主题包不能上传或修改。

## Function IDs

```text
UI-THEME-MODEL-001       Independent Theme Pack product model
UI-THEME-SCHEMA-001      Theme manifest and semantic token contract
UI-THEME-REGISTRY-001    Registry, validation and resolution
UI-THEME-BOOTSTRAP-001   First-paint bootstrap and persistence adapters
UI-THEME-PICKER-001      Theme selection and preview UI
UI-THEME-IMPORT-001      Local theme bundle import and safety
UI-THEME-MIGRATION-001   Legacy system/light/dark and selector migration
UI-THEME-VERIFY-001      Cross-product and cross-client verification
UI-THEME-PRESENTATION-001 Presentation Profile registry and route policies
UI-THEME-COMPILER-001     Deterministic image-to-theme compiler
UI-THEME-GENERATE-QUICK-001 Quick local generation without model calls
UI-THEME-GENERATE-STANDARD-001 Image-model generation flow
UI-THEME-GENERATE-ADVANCED-001 Planner plus artwork generation flow
UI-THEME-STUDIO-001       Settings Theme Studio workflow
```

## Completion Gate

- Light/Dark 不再被定义为 Theme Pack 内部模式。
- `System` 只表示选择策略，不出现为可导入主题。
- 所有主题包提供完整语义 token，不依赖另一主题继承补齐。
- Feature CSS 不识别具体主题 ID。
- 主题切换不卸载页面、不修改业务状态、不丢失焦点。
- 本地导入主题不能执行 CSS、JavaScript 或远程资源。
- Presentation Profile 能产生全局明显变化，但不能改变业务布局、Logo 或真实功能。
- 快速、生成、高级模式都通过同一个 Compiler、验证和发布事务。
- Quick 断网可用；Generate 只要求生图能力；Advanced 支持同一模型或两个模型承担角色。
