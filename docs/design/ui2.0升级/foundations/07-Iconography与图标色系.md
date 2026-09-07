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
| Ling Logo 和 favicon | 本地精细矢量母版及按尺寸导出的品牌资源 |

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

## Brand Asset Contract

Status: current implementation contract
Owner: Web and Desktop maintainers
Last verified: 2026-09-07

本轮为用户明确授权的品牌精细化替换。保留三层堆叠、白色顶面、五个连接节点和紫蓝青配色；
去除模糊阴影、光晕和边缘杂点。品牌不能被 Theme Pack、UI 图标迁移或普通功能修改自行替换。
角色头像属于独立的身份资源，不属于应用品牌 Logo。

- 唯一母版位于 `apps/web/public/icons/`：`ling-mark-micro.svg` 用于 16–24px，
  `ling-mark-compact.svg` 用于大于 24px 且不超过 64px，`ling-mark.svg` 用于大于 64px。
  任意 UI 尺寸使用不小于需求的对应层级；小图增粗连接线、扩大节点色块、精简中心环。
- 母版只包含本地几何和简单渐变，不嵌入位图、字体、滤镜或外部引用。
- `LingStackLogo` 统一选择母版，使用可信的 public base URL，保持既有装饰性无障碍语义。
  首页品牌容器不得通过圆形裁切截掉三层图标的角点。
- PNG 逐尺寸从母版渲染，不通过多轮位图缩放得到小图。macOS 的标准/Retina 表示按逻辑尺寸
  选择相同母版；Windows 和 Chrome 扩展按目标像素尺寸选择母版。
- macOS 包含 10 个表示，16–1024px；Windows 包含 9 档 32-bit RGBA 图标，
  16、20、24、32、40、48、64、128、256px。
- Web favicon 保留稳定 `favicon.png` 地址作为兼容入口，并优先使用 SVG；README 使用完整
  矢量母版，不能放大 64px favicon 充当大图。扩展商店图和仓库宣传图同步使用新品牌。
- 旧生成 PNG 和旧手绘堆叠 Logo 路径在引用迁移后删除。稳定原生文件名原位替换，不留旧版
  副本；历史版本由 Git 保留。

## Brand Delivery And Verification

1. 收口三档矢量母版及集中导出命令 `corepack pnpm --filter @ling-stack/desktop generate:icons`。
2. 替换 Web、共享 Logo、原生包、扩展和宣传图，清除旧路径引用。
3. 验证全部帧的尺寸、透明像素、非空内容和边缘留白；以图像内容校验替代文件体积下限。
4. 使用 macOS `iconutil` 解码回读，验证 ARGB 透明边缘和 PNG 表示；验证 Windows ICO
   每一帧与对应母版渲染的内容一致。
5. 检查真实浏览器中的明暗首页、favicon 和扩展宣传图，运行资源路径、扩展、类型、lint、
   i18n、文档链接及构建检查。截图放在忽略的本地产物目录，不重新加入设计文档目录。

SVG 放大不产生位图放大失真；有限像素和非整数系统缩放仍限制极小尺寸的细节。资源校验
不代表已重新签名安装客户端，也不替代真实 Windows 主机上的打包验收。

## Accessibility

装饰图标 `aria-hidden=true`。IconButton 必须提供 label；独立语义图标需要可访问名称。Tooltip
不能成为完成任务的唯一信息来源。
