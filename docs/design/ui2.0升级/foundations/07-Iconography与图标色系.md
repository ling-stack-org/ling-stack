# Iconography 与图标色系

## Default Source

Ling UI 操作、导航、菜单、状态和工具条默认使用 `lucide-react` SVG React components。当前
已有 176 个源码文件使用 Lucide，继续统一可避免第二套图标语言。

React 本身不提供图标。Feature 不得新增远程 Iconfont、字符图标、emoji 操作图标或 PNG
按钮图标。

## Asset Boundaries

| Content | Format / source |
|---|---|
| UI action/navigation/status | Lucide SVG component |
| Ling 自定义但非 Logo 的产品符号 | 审核后的本地 SVG React component |
| 官方品牌、语言和文件类型 | 本地 SVG 或批准的 `react-icons` 例外 |
| 头像、缩略图、生成结果 | PNG/WebP/JPEG |
| 复杂插图 | 优先 WebP/PNG，确需矢量时本地 SVG |
| Ling Logo 和 favicon | 当前资源原样保留 |

禁止加载阿里 Iconfont 或其他远程字体图标。若从 Iconfont 获取自定义图标，只允许导出 SVG、
确认授权、清理不必要 metadata 后作为本地资产提交。

## Size And Stroke

| Context | Size | Stroke width |
|---|---:|---:|
| compact inline action | 14px | 2 |
| standard button/menu/field | 16px | 2 |
| Sidebar/primary navigation | 18px | 1.75 |
| prominent status/tool | 20px | 1.75 |
| compact EmptyState maximum | 24px | 1.75 |

禁止通过 viewport 缩放图标。图标容器控制尺寸，Feature 不直接传任意像素值。大于 24px 的
图标属于插图，需要独立设计理由。

## Color

- 默认 `currentColor`，继承 Button/Menu/Text token。
- default：`--ling-text-muted`；hover/focus：`--ling-text-strong`。
- active/selected：使用当前文字和背景层级，不单独染品牌色。
- disabled：使用 disabled text token，不通过 opacity 让对比度不可读。
- danger：只有真实删除/永久操作使用 danger token。
- success/warning/error：状态图标必须同时有文字，颜色不单独承担语义。
- 品牌图标可保留官方颜色，但只用于身份识别，不进入普通操作按钮。

Theme Pack 和 Desktop 不分别替换 SVG 文件，只通过 semantic tokens/currentColor 变化。

## Style

- 默认 outline，不在同一工具条混用 filled 和 outline。
- 同一行动全产品使用同一个图标。
- 图标不重复旁边已经清楚表达的装饰意义。
- loading 使用统一 Loader2/Spinner 动效，不用不同旋转图标。
- 图标与文字基线由 Button/Menu 组件控制，Feature 不用手动 translate 修正。

## Logo Protection

以下对象明确排除在 UI 2.0 图标迁移之外：

```text
apps/web/src/shared/components/LingStackLogo.tsx
apps/web/public/favicon.svg
apps/web/public/favicon.png
```

规则：不替换、不重绘、不改路径、不改主体颜色、不改变比例、不用 Lucide 近似图标代替。
组件可通过既有 `size` prop 缩放，但必须保持 `viewBox` 和路径。Logo 保护优先于统一 stroke
或 icon wrapper 规则。

## Accessibility

装饰图标 `aria-hidden=true`。IconButton 必须提供 label；独立语义图标需要可访问名称。Tooltip
不能成为完成任务的唯一信息来源。
