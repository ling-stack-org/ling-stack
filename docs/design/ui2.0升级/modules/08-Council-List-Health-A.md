# Council List / Health A

> Slice: `P8.2a`
> Function ID: `COUNCIL-LIST-001`
> Product decision: Council A

## 1. Goal

Council List / Health A 把 Council Workspace 左侧列表和选中 Council 的健康摘要迁到 UI 2.0。
页面只陈述当前 API 可以证明的三类事实：Council 配置、成员 readiness、频道关系。它不展示
“正在运行”、最近执行来源、并发执行或其他缺少 Council provenance 的运行事实。

`COUNCIL-RUNTIME-001` 继续保持 blocker。本切片不新增 API、contract、数据库字段、migration，
也不从一般 Runs、消息或时间戳猜测 Council runtime。

## 2. Protected Baseline

- 保留 `CouncilCreateDialog`、`CouncilCloneDialog`、`useCouncilCreateCloneController` 和
  `council-create-clone-view-model` 的现有实现。
- Create / Clone 成功继续使用 Council detail GET 权威确认；超过前 100 条列表时继续保留投影；
  Clone source drift 继续要求二次确认。
- Members、Channels、Settings、Archive 的现有 API 和可达行为不在本切片重构。
- Settings 嵌入态继续隐藏重复页面标题，反馈仍由真实 Council owner 管理。

## 3. Page Structure

```text
CouncilWorkspacePage
  CouncilWorkspacePanels
    CouncilListHealthPanel
      Header: count + scoped Refresh
      Toolbar: Search + Health filter + Create
      Persistent refresh feedback
      Bounded list
        CouncilListRow (DataRow)
    CouncilDetailHeader
    CouncilHealthSummary
      Primary StatusIndicator
      Configuration / readiness / channel relationship summary
      InspectorSection: health findings, default collapsed
    Existing Tabs
      Members / Channels / Settings
```

左侧列表是独立滚动 owner。Toolbar 和错误反馈不随列表滚动。列表项不使用卡片墙，不逐行入场，
选中、hover、focus 不改变行高。右侧详情继续是 `minmax(0, 1fr)`。

## 4. Shared Primitive Contract

| Surface | Primitive | Rule |
|---|---|---|
| Search | `Input` | `Search` icon 前缀，固定 `sm` 高度，支持清空 |
| Health filter | `Select` | 只显示产品状态，不显示 severity raw enum |
| Refresh | `IconButton` | scoped `loading`，只锁定 Refresh，不让 Search/Select 跳动 |
| Rows | `DataRow` | `identity / summary / status`；点击只选择 |
| Primary state | `StatusIndicator` | 每个 Council 只能显示一个主状态 |
| Load | `Skeleton` | 初始无权威列表时显示稳定的 5 行骨架 |
| Empty / no result | `EmptyState` | 两种状态分开；no result 提供 Clear filters |
| Refresh error / stale | `InlineFeedback` | 保留已有行并持续到成功刷新或显式重试 |
| Health detail | `InspectorSection` | 默认折叠；只放产品化 finding，不把 raw message 常驻默认层 |

Feature 不直接 import Radix，不使用原生 `button` 或旧 `SelectControl` 构建 List / Health。

## 5. Health Evidence Model

### 5.1 Allowed facts

- Council：`status`、`source`、`routingPolicy`、`governanceProfile`、`pinned`、`updatedAt`。
- Readiness：现有 `AiCouncilHealthReport` 的 member/council findings。
- Channel relationship：现有 `ChannelCouncilPolicy` 及当前页面已有 attach/preferred 关系。

### 5.2 Report completeness

Health report 只有同时满足以下条件，才允许将无 finding 的 Council 显示为 `healthy`：

1. report 存在，`generatedAt` 是有效时间；
2. `generatedAt >= council.updatedAt`；
3. `report.findings.length` 不小于 `summary.findings` 三种 severity 的总和；
4. 当前 Council 未处于 `paused` 或 `archived`。

服务端允许按 `limit` 截断 findings。只要 summary 总数大于实际返回数组，未命中 finding 不能证明
当前 Council 没问题，必须显示 `partial`，绝不能显示 `healthy/clear`。

### 5.3 Single primary state

优先级固定为：

```text
paused > partial > attention > pending > healthy
```

| State | Evidence | Tone | User copy |
|---|---|---|---|
| `paused` | `council.status === paused` | neutral | Paused / 已暂停 |
| `partial` | report 过期、时间无效或 findings 被截断 | warning | Partial health / 健康信息不完整 |
| `attention` | 完整且新鲜的 report 对当前 Council 有 finding | warning/danger | Needs attention / 需要关注 |
| `pending` | report 不存在 | neutral | Health pending / 健康状态待加载 |
| `healthy` | report 完整、新鲜且当前 Council 无 finding | success | Healthy / 状态正常 |

`attention` 的 tone 由最高 severity 决定：critical=`danger`，warning=`warning`，info=`info`。
paused 不再同时显示 warning finding 胶囊；finding 仍可在折叠详情中查看。

## 6. List Interaction

### Search

- 搜索 `displayName`、`description`、source label 和 routing mode 的产品化文本。
- 大小写不敏感，trim 后匹配；空 query 不过滤。
- Search 改变不清除 Health filter，反之亦然。

### Filter

主状态固定值：`all / healthy / attention / partial / pending / paused`。保留 `critical / warning / info`
作为 finding severity 的兼容细筛选，供既有审查流程直接定位；它们不改变行的单一主状态。
旧 `clear` 统一由 `healthy` 取代。

### Selection stability

- 用户显式选择的 Council ID 单独保存，Search/Filter 不改写它。
- 若显式选中项暂时被过滤，详情可暂时显示第一条可见 Council；清除筛选后恢复原显式选择。
- 删除、归档或权威列表确认该 ID 不存在时，才选择第一条可见 Council。
- Create / Clone 投影会清空 Search/Filter 并显式选择新 Council，保持现有 authority repair。

### Refresh

- Refresh 按钮拥有独立 busy 状态，重复点击 single-flight。
- 初始无行且 `aiCouncilsLoading=true`：Skeleton。
- 已有行刷新：保留列表和选择，不显示全页 Skeleton。
- refresh 失败：保留最后列表和 report，显示 persistent `InlineFeedback`，将 surface 标为 stale。
- 下一次成功刷新清除错误和 stale；不弹成功 Toast。

## 7. Reachable State Matrix

| State | List | Health summary | Action |
|---|---|---|---|
| initial loading | 5-row Skeleton | pending placeholder | Refresh disabled/busy |
| loaded empty | compact EmptyState | no selection | Create |
| no result | compact EmptyState | no selection | Clear filters |
| healthy | one success StatusIndicator | no finding copy | Details folded |
| attention | one warning/danger/info indicator | productized finding count | Open health details |
| paused | neutral indicator | paused configuration fact | Existing Settings action |
| pending | neutral indicator | report unavailable | Refresh |
| partial health | warning indicator | why evidence is incomplete | Refresh |
| refresh error, no rows | danger InlineFeedback + empty | pending | Retry |
| refresh error, rows retained | danger InlineFeedback + stale marker | last known summary | Retry |
| long list / long zh-CN | internal scroll; identity ellipsis/title | no overflow | keyboard selection |
| Dark / reduced motion | tokens only; no color literals | disclosure uses shared motion | no private keyframe |

## 8. Health Detail

- 默认层只显示主状态、简短 readiness 摘要和 report timestamp（若有效）。
- findings 放入默认关闭的 `InspectorSection`。
- 每条 finding 显示产品化 subject + kind；不直接显示后端 `title/message/id`。
- partial 原因必须可读：报告过期、报告截断或报告时间无效。
- channel relationship 只显示 attached/preferred 的真实关系；无 policy 时显示 unknown，不推断未接入。

## 9. Motion And Accessibility

- DataRow hover/selected 只使用共享 `120ms` color/background transition。
- Search/Filter 切换直接更新列表，不使用高度动画或 stagger。
- Inspector disclosure 使用共享 `180ms` motion；reduced motion 由 package 归零。
- Refresh busy 保持按钮尺寸；Spinner 有 loading label。
- 列表使用 `role=listbox`，DataRow 使用 `role=option`、`aria-selected`，Enter/Space 可选择。
- Search、Filter、Refresh、Clear filters、状态文字、Tooltip 和 ARIA 全部中英文对齐。

## 10. CSS Ownership

- 新 owner：`apps/web/src/styles/council-list-health.css`。
- 目标 selector 只使用 `.council-list-health-*` 及公开 Feature root；不命中 package-private
  `.ling-ui-*` 子结构。
- `councils.css` 中现有 List / Health selector 必须同步删除，文件只能减少。
- 禁止硬编码颜色、`!important`、`transition: all`、私有 keyframe、raw duration/easing。
- 新 production owner 少于 400 行。

## 11. Error Ownership

- List/Health refresh error 属于 `CouncilListHealthPanel`，使用 persistent `InlineFeedback`。
- Create/Clone 反馈继续属于既有 Dialog/projection owner。
- Members、Channels、Settings 的错误继续留在对应 section。
- 本切片不创建 Toast viewport，不增加 Feature timer，不把 health 状态变成 Toast。

## 12. Verification

- Static：`git diff --check`、Web typecheck、i18n、lint。
- Focused：`ui2-council-list-health.spec.ts` 覆盖本文件全部状态。
- Regression：`councils.spec.ts`、`ui2-council-create-clone.spec.ts`、
  `ui2-settings-workspace-tools.spec.ts`、`dark-mode.spec.ts`。
- Browser：真实 Vite source server，`1440x960` 和 `1280x800`，Light/Dark 至少 5 张原尺寸截图。
- 每张 evidence 记录 locale、fixture、console、document/root overflow、主要 scroll owner、尺寸和 SHA-256。

## 13. Non-goals

- 不关闭 `COUNCIL-MEMBERS-001`、`COUNCIL-CHANNELS-001`、完整 `COUNCIL-SETTINGS-001`。
- 不实现 Archive restore、runtime history、run source、aggregation 或新的 health API。
- 不修改 Create/Clone、AppShell、domain、API client、contracts、Core、daemon 或数据库。
