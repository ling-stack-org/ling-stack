# Design Tokens 与独立主题包

## Related Docs

- [主题系统入口](../themes/README.md)
- [主题包 Schema 与 Token 合同](../themes/02-主题包Schema与Token合同.md)
- [沉浸式主题与 Presentation Profile](../themes/01-独立主题包产品模型.md)
- [AI 生成主题产品流程](../themes/07-AI生成主题产品流程.md)
- [CSS 目标目录与加载顺序](../architecture/03-CSS所有权与迁移规则.md)
- [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)

## Ownership

Tokens 和内置 Theme Pack 由 `@ling-stack/ui-react` 定义。Web 现有 `base.css`
在迁移期只保留 reset、AppShell 必要布局和旧变量 alias，不再新增视觉 token。

Theme Pack 是完整、独立的外观单元。`ling-light` 和 `ling-dark` 是两个平级内置主题，
不是同一主题内部的 Light/Dark 双模式。`System` 只是根据 OS 外观解析 Theme Pack
的选择策略。

## Token Layers

```text
Foundation tokens
  size / typography / spacing / radius / motion / z-index

Theme Pack tokens
  background / text / border / action / status / shadow / native

Client surface tokens
  Web / Desktop window material and chrome

Presentation Profile recipes
  route artwork / approved surface composition / fixed decoration slots
```

- Foundation tokens 对所有主题固定，主题不能改变 geometry。
- Theme Pack 必须提供完整 semantic token set，不从其他主题继承。
- Client surface 只增强窗口材质，不改变业务组件视觉语义。
- Presentation Profile 只组合批准的 surface/artwork recipe，不覆盖 foundation geometry。

## Foundation Scale

| Category | Tokens |
|---|---|
| Space | `2, 4, 6, 8, 12, 16, 20, 24, 32px` |
| Radius | `4, 6, 8px` |
| Font | `12, 13, 14, 16, 20px` |
| Line height | `18, 20, 22, 24, 28px` |
| Control height | `32, 36, 40px` |
| Icon | `14, 16, 18, 20px` |
| Motion | `120, 180, 240ms` |
| Z-index | sticky 20, menu 40, popover 50, dialog 60, toast 80, tooltip 90 |

完整 duration、easing、属性和 reduced-motion 合同见
[Motion 与状态转场](./04-交互动效与无障碍.md)。Feature 不得自行新增 raw duration/easing。

## Theme Pack Tokens

Theme Pack 覆盖的语义组：

| Group | Examples |
|---|---|
| Background | app, panel, elevated, subtle, pressed, overlay, code, sidebar, composer |
| Text | strong, default, muted, soft, inverse, link |
| Border | default, strong, focus |
| Action | accent, hover, pressed, foreground, selection |
| Status | success, warning, danger, info foreground/background/border |
| Shadow | low, medium, overlay |
| Native | selection, scrollbar, scrollbar hover |

Built-in token values 由
[主题包 Schema 与 Token 合同](../themes/02-主题包Schema与Token合同.md)统一管理。

## Root Contract

```html
<html
  data-ui-theme="ling-light"
  data-color-scheme="light"
  data-theme-selection="system"
  data-ui-presentation="ling-standard"
  data-client="web"
>
```

- `data-ui-theme` 是当前实际 Theme Pack ID。
- `data-color-scheme` 来自 Theme Pack manifest，不代表 Theme Pack family。
- `data-theme-selection` 是 `fixed` 或 `system`。
- `data-ui-presentation` 是 Theme Pack 选择并经 Registry 验证的 app-owned Profile。
- `data-client` 是 `web` 或 `desktop`。
- Legacy `data-theme="light|dark"` 在 U13 之前只作兼容 alias，不能被新代码使用。

## CSS Variables

- 共享组件只读 `--ling-*` semantic variables。
- Feature CSS 不读 manifest，不识别 Theme Pack ID。
- Feature CSS 不识别 Presentation Profile ID；只有共享 presentation layer 可以消费。
- 遇到需要外观差异的领域 surface，先定义 semantic token，不写主题 selector。
- 主题包不得覆盖 space、font、radius、motion、z-index 和 icon 尺寸 token。
- Feature CSS 中主题颜色字面量目标为 `0`。

## Built-In And Imported Themes

### Built-In

- 以 typed manifest 编译进 package。
- 使用 `ling.tokens.theme` layer 产生 token-only selectors。
- 启动时同步可用，不等待异步存储。

### Imported

- 使用同一 Schema 和 token allowlist。
- 通过经验证 variable map 由单一 runtime style owner 应用。
- 不能包含 CSS、JavaScript、字体、远程 URL 或 Logo 替换。
- 不完整或对比度不合格的主题不能进入 ready registry。
- `local-generated` 与 `local-import` 使用同一 token/Profile/resource validator。
- Quick/Generate/Advanced 都由 Theme Compiler 产生完整 token，不接受模型生成的 runtime CSS。

## Semantic Status

每个 success、warning、danger、info 都必须提供 foreground、soft background 和 border。
Feature 只指定语义 tone，不指定颜色。颜色不能是唯一状态信号。

## Client Surface

- Web 默认清晰、不透明、低阴影。
- Desktop 可根据 Theme Pack 的可选 Desktop tokens 使用有限材质。
- macOS/Windows 不支持对应 blur/transparency 时回退到不透明 semantic surface。
- Desktop surface 不得重写 Button、Dialog、Menu、Toast 或会话控件样式。

## Bootstrap

- 首帧同步解析 ThemeSelection 和内置/经验证导入主题 snapshot。
- 首帧与 React 最终解析的 Theme Pack ID、colorScheme 和 sentinel token 必须一致。
- shared UI 不直接读 localStorage、IndexedDB 或 Desktop store，由客户端 adapter 注入。
- 无效 selection 回退内置主题，不等待 daemon 或渲染空白页。

## Hard Stops

- 要求每个 Theme Pack 提供 Light/Dark 两套 token。
- Feature 使用 `data-ui-theme="<id>"` 或 `data-color-scheme` 修补组件。
- 主题改变布局、字号、间距、控件尺寸、图标或 Logo。
- Feature 根据 Presentation Profile ID 编写页面样式分支。
- 导入 CSS/JS、远程主题资源或未经验证的 CSS value。
- 模型输出绕过 Theme Compiler 直接成为 manifest、token 或 artwork layer。
- 主题切换刷新页面、丢失焦点、重置滚动或关闭 overlay。
