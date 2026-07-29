# DataRow、Table 与 InspectorSection

## DataRow

标准列：identity、summary、status、actions。支持 selected、disabled、loading 和 compact。
行点击只负责选择；离开当前壳层的动作必须是显式按钮。

hover/selected 使用 `120ms` color/background/border；列表不得逐行 stagger 入场。Disclosure
使用 `180ms` grid rows + opacity，长异步内容允许直接打开。

## Table

用于需要跨行比较的数据。1280px 下优先收敛列，不依赖横向滚动。raw id、path、时间线
和低频元数据进入 Inspector。Header 固定，body 可滚动。

## InspectorSection

summary-first。Header 显示标题、摘要和 disclosure；body 放 requirements、policy、raw、
history、artifacts。默认只展开用户完成任务所需区域。

## Text And Actions

长 identity 省略但提供 title/详情。Actions 固定宽度、右对齐，不被文本挤压。危险操作
不与主行动并排制造误触。

## Empty/Loading

列表空态不撑大；Inspector 无选择时使用 compact EmptyState；加载保持 panel 尺寸。

## P1C Implementation Status

- `DataRow`、semantic `Table` family 与 `InspectorSection` 已在 `@ling-stack/ui-react` 实现并通过
  package contract tests。
- 组件支持 selected/disabled/loading/compact、sticky header、固定 actions slot、原生 details
  disclosure 与 reduced motion。
- 本切片只建立共享合同；各业务列表的 JSX 和旧 selector 不在 P1C 批量迁移，按 P4-P12 页面切片推进。
