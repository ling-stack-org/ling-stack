# Design Tokens 与独立主题包

## Related Docs

- [主题系统入口](../themes/README.md)
- [主题包 Schema 与 Token 合同](../themes/02-主题包Schema与Token合同.md)
- [沉浸式主题与 Presentation Profile](../themes/01-独立主题包产品模型.md)
- [AI 生成主题产品流程（历史停用）](../themes/07-AI生成主题产品流程.md)
- [CSS 目标目录与加载顺序](../architecture/03-CSS所有权与迁移规则.md)
- [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
- [共享组件参数与新模块接入](../../component-theme-presentation.md)

## Ownership

Tokens 和内置 Theme Pack 由 `@ling-stack/ui-react` 定义。Web 现有 `base.css`
在迁移期只保留 reset、AppShell 必要布局和旧变量 alias，不再新增视觉 token。

Theme Pack 是完整、独立的外观单元。`ling-light`、`ling-dark` 是经典内置主题，
`ling-breeze`、`ling-ocean`、`ling-night`、`ling-journey` 是官方场景主题。它们不是同一主题内部的
Light/Dark 双模式。`System` 只是根据 OS 外观解析 Theme Pack 的选择策略。

## Token Layers

```text
Foundation tokens
  size / typography / spacing / radius / motion / z-index

Theme Pack tokens
  background / text / border / action / status / shadow / native

Shared component defaults + official appearance overrides
  control / composer / navigation / shortcut / card / row / overlay / message / code

Client surface tokens
  Web / Desktop window material and chrome

Presentation Profile recipes
  route artwork / approved surface composition / fixed decoration slots
```

- Foundation 的字号、间距、控件高度、命中区域、图标、motion 和 z-index 保持固定。
- 组件圆角、边框、局部阴影和材质是允许的外观参数；默认值在 `component-tokens.css`，官方主题在 `built-in-themes.css` 集中覆写，不改 foundation scale 本身。
- Theme Pack 必须提供完整 semantic token set，不从其他主题继承。
- 未声明的组件参数使用共享默认值；这与缺少必需 semantic manifest 字段是两回事。
- Client surface 只增强窗口材质，不改变业务组件视觉语义。
- Presentation Profile 只组合批准的 surface/artwork recipe，不覆盖 foundation geometry。

## Foundation Scale

| Category | Tokens |
|---|---|
| Space | `2, 4, 6, 8, 12, 16, 20, 24, 32px` |
| Radius | foundation scale 为 `4, 6, 8px`；组件参数可选择批准的主题圆角，不受统一 `8px` 上限约束 |
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

- 共享组件只读 `--ling-*` semantic/component variables。
- Feature CSS 不读 manifest，不识别 Theme Pack ID。
- Feature CSS 不识别 Presentation Profile ID；只有共享 presentation layer 可以消费。
- 遇到需要外观差异的领域 surface，先定义 semantic token，不写主题 selector。
- 主题不得改写 foundation space、font、radius scale、motion、z-index 和 icon 尺寸；组件级 radius 由批准的组件参数控制。
- Feature CSS 中主题颜色字面量目标为 `0`。

精确参数、所有权和扩展步骤见[共享组件合同](../../component-theme-presentation.md)。组件参数目前是应用控制的 CSS 变量，并非 manifest 可任意追加的字段；扩展序列化协议必须同时修改 types、validator、映射与 bootstrap 测试。

## Built-In Themes

### Built-In

- 以 typed manifest 编译进 package。
- 使用 `ling.tokens.theme` layer 产生 token-only selectors。
- 启动时同步可用，不等待异步存储。

### 历史导入/生成数据

- 当前产品不提供导入或生成主题入口。
- 历史 local-import/local-generated 数据不进入可用 registry。
- 历史选择按颜色模式回退到官方浅色或深色主题，不自动删除本地数据。

## Semantic Status

每个 success、warning、danger、info 都必须提供 foreground、soft background 和 border。
Feature 只指定语义 tone，不指定颜色。颜色不能是唯一状态信号。

## Client Surface

- Web 默认清晰、不透明、低阴影。
- Desktop 可根据 Theme Pack 的可选 Desktop tokens 使用有限材质。
- macOS/Windows 不支持对应 blur/transparency 时回退到不透明 semantic surface。
- Desktop surface 不得重写 Button、Dialog、Menu、Toast 或会话控件样式。

## Bootstrap

- 首帧同步解析 ThemeSelection 和内置主题；非 built-in 历史 snapshot 不再授权给首帧。
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
