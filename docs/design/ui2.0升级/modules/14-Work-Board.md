# P11.1 Work Board UI 2.0 零决策设计合同

## 0. 文档状态

- 文档类型：生产切片前实施审计与 UI 合同。
- 当前状态：`Web verified / packaged Desktop pending`；WB-00..WB-08 的模块内实现、AppShell/locale/outcome/open-intent 接线、raw diagnostics 折叠与 9 张 Web evidence 已闭环。
- 验收表面：Desktop Web，`1440x960` 与 `1280x800`；移动端不纳入本切片。
- 对应总控：`P11 / R5.1 / U12`。
- 配套实施计划：[14-Work-Board-implementation-plan.md](14-Work-Board-implementation-plan.md)。
- 业务不变量：不修改 daemon API、API client contract、数据库、路由、`ViewId`、Task/Run/
  Approval/Thread/WorkItem 状态机。

本文取代本文件原有的 30 行摘要。旧 Work Board、Review Queue、Runtime 文档继续作为业务历史，
但 UI 组件、状态反馈、CSS、主题和动效以 UI 2.0 文档为准。

### 0.1 2026-07-22..23 production slice 记录

- 已实现：workspace source projection、retained stale/capped disclosure、request identity guard、per-item durable busy/failure/blocker、纯 view-model/controller、shared UI2 primitives、Fail Dialog、focused CSS、Channel bounded projection 与 focused E2E。
- 行数：`GlobalWorkBoardPage.tsx` 低于 180；本 slice 所有新增 production owner 低于 400；focused CSS 单文件低于 400。
- 已接线：AppShell 直传稳定 `workspaceCwd`、单调 `WorkBoardOpenIntent.requestId`、durable busy/failure/blocker/routing maps、reason 和 Promise outcomes；source refresh 后 focus restore focused case `1/1`。
- 已验证：focused UI2 + legacy Work Board 串行 `11/11`；dark-mode 串行 `2/2`；`check:i18n` 通过，审计计数 `en-US=3902 / zh-CN=5561 / literalKeys=3318 / dynamicCalls=397`。
- WB-08 evidence：合同第 13 节 9 张 changed-state 全部由 `LING_PLAYWRIGHT_PORT=4194` 真实 Vite 页面产生，sidecar 均为 `verification=verified`、console pass、document overflow `0/0`、哈希匹配，并完成原尺寸目检。
- Fail Dialog 与 Inspector 的 raw `technicalMessage` 均进入默认关闭的 Technical details；缺失 raw message 时显示产品化 fallback，不再暴露空值或默认压屏。
- 全局覆盖矩阵、README、总控和状态看板由本轮全局 closeout 同步登记。

## 1. 产品定位

Work Board 是 workspace 级执行台账和任务协调入口。它负责回答：

1. 当前有哪些工作需要处理、正在进行、可领取或已经结束；
2. 选中工作由哪个 Task、Run、Approval、Channel、Workflow Step 或 external work 对象承载；
3. 用户下一步应该领取、处理审批、查看失败、打开运行、打开任务还是路由到频道；
4. 数据是否完整、新鲜，某个动作是否成功，失败发生在哪个对象。

Work Board 不是：

- 第二套 Task、Run、Approval 或 Thread 持久化系统；
- 自动启动 Run 的调度器；
- 在列表内复制完整审批、运行诊断、任务编辑或 Thread lineage；
- 看板拖拽、自由列配置或项目管理卡片墙；
- Settings 页面。它是一级 `work_board` 产品入口。

## 2. 权威所有权边界

| 领域 | 权威 owner | Work Board 允许 | Work Board 禁止 |
|---|---|---|---|
| Work Board projection | `buildWorkItemViews`、durable `work_items` 与 P11 controller | 合并、去重、筛选、排序、选择、显示下一步 | 创建第二份持久化 ledger |
| Task | workspace Task API/store/state machine | 显示任务、打开精确任务、显示关联 Run/Approval | 复制 Task CRUD、直接改 Task 状态、自动运行 |
| Teammate Tasks | `TeammateTasksTab` 的最近 100 条单队友投影 | 创建后路由到 Work Board；无 `currentRunId` 时打开精确 `task:<id>` | 宣称完整任务库、持有第二份 Task store、自动运行 |
| Channel Work Board | 全局 Work Board 的 `channelId` 过滤投影 | 在频道工具面板显示活跃工作并复用相同 WorkItem mutation | 建立 per-channel ledger 或不同状态规则 |
| Runs | Runs domain、Run History/Diagnostics | 显示 run-derived 状态并显式打开 Run | Retry、Cancel、Timeline、events、artifacts 诊断复制到 Board |
| Threads | Threads domain、Thread Page | 通过 Run 页面间接进入 Thread | 伪造 direct Thread target；当前 WorkItem contract 没有 `threadId` |
| Approvals | Approvals domain、Inbox/Review Queue | 显示 waiting/approval，显式进入 Inbox 精确审批 | 在 Board 内批准、拒绝、改授权策略或弱化后果说明 |
| Durable WorkItem | Core WorkItem store | claim、heartbeat、release、complete、fail；显示依赖 blocker | 绕过 claim token、重写 retry/dependency 语义 |
| External work | External Work domain | 对现有 external work 显式 route 到频道 | 执行外部 mutation、自动创建 Run、路由不支持的 manual item |

“Work Board 是权威任务 owner”指完整 workspace 协调表面由 Work Board 承担；底层 Task 记录仍由
Task domain 权威持久化。Teammate Tasks 和 Channel Work Board 都是有边界的投影，不拥有新的 Task store。

## 3. 当前真实入口与调用链

### 3.1 一级导航

```text
SidebarPrimaryNavigation
  -> onOpenView("work_board")
  -> SidebarNavigation
  -> AppShell.onOpenView
  -> openWorkBoard("actionable", "")
  -> setWorkBoardRequestedScope / setWorkBoardRequestedItemId
  -> openPlainView("work_board")
  -> lazy-pages.LazyGlobalWorkBoardPage
  -> GlobalWorkBoardPage
```

当前 `ViewId` 已包含 `work_board`，Sidebar 的 `Kanban` 入口已经存在。P11 不新增路由、不把 Work Board
放回 Settings，也不增加第二个导航入口。

### 3.2 Teammate Tasks 路由

```text
TeammateTasksTab row
  -> currentRunId ? controller.onOpenTask(run) : controller.onOpenTask(task)
  -> AppShell.onOpenRun / onOpenTaskInWorkBoard
  -> 有 currentRunId：openRunFromWorkspace -> Runs
  -> 无 currentRunId：openTaskInWorkBoard
     -> scope = terminal ? history : global
     -> itemId = "task:<task.id>"
     -> GlobalWorkBoardPage 精确选择
```

私聊消息和 Tasks 表单仍可调用现有 `createTask`，但创建成功只更新 projection 并打开 Work Board；
不得调用 Run create/start API。

### 3.3 Inbox / Approval 路由

```text
ApprovalsPage / Review Queue empty or contextual action
  -> onOpenWorkBoard(scope)
  -> AppShell.openWorkBoard(scope)
  -> Work Board

Work Board approval action
  -> setSelectedApprovalId(approvalId)
  -> openPlainView("approvals")
  -> ApprovalsPage owns decision
```

### 3.4 Channel projection

```text
WorkspaceClientView
  -> ChannelActivityToolsPanel
  -> ChannelWorkBoard
  -> buildWorkItemViews(...)
  -> filterWorkItemsByChannel(selectedChannelId)
  -> non-terminal WorkItemRow[]
```

### 3.5 WorkItem mutation

```text
Work Board action
  -> useDurableWorkItemsDomain action
  -> apps/web/src/api/work-items.ts
  -> @ling-stack/api-client operationEndpoints
  -> daemon /work-items/:id/{claim|heartbeat|release|complete|fail}
  -> Core SqliteWorkItemStore
  -> typed mutation response
  -> replace exact projection row
```

External route 使用现有 external work route，并在成功后刷新 action、CI、status、channel protocol、approval
和 durable work item。P11 不改成通用 `routeWorkItem`，因为当前产品只接线了 external work route。

## 4. 当前实现审计

| 文件 | 当前行数 | 当前职责 | P11 问题 |
|---|---:|---|---|
| `GlobalWorkBoardPage.tsx` | 910 | 页面、筛选、选择、分组、Inspector、动作、文案 | 超过 800，业务判断与 JSX 混合 |
| `WorkItemRow.tsx` | 230 | row、所有 mutation、route、open target | 行内动作过多；交互 row 内嵌按钮语义复杂 |
| `ChannelWorkBoard.tsx` | 125 | channel projection | 使用旧 row/empty/status 视觉 |
| `lib/work-items.ts` | 550 | source projection、状态映射、去重、分组 helper | 低于 800，但不能继续吸收 UI 决策 |
| `use-durable-work-items-domain.ts` | 198 | durable list 与 mutation | 只有单一 `busyWorkItemId`，错误泄漏到 AppShell 全局 |
| `work-board.css` | 698 | page、toolbar、row、Inspector、旧 Settings mode | 单文件混合，含硬编码 `#fff` 与旧 control chrome |
| `work-board.spec.ts` | 70 | durable merge、claim、heartbeat、三 scope | 不覆盖 UI2 全状态、失败、竞态、长列表或截图 |
| `AppShell.tsx` | 3000+ | 各 domain 接线与导航 | 只能保留薄 props/callback，不增加 projection 逻辑 |

### 4.1 当前全局完整性缺口

当前顶层页面接收的 `tasks`、`channelWorkflowSteps` 与 `externalWorkCiTriage` 仍来自 selected-channel
domain state。`refreshTasks()` 在没有 selected channel 时会清空 Task，导致 “All active” 可能不是 workspace
全量视图。现有 API 已支持：

- `listTasks(cwd)`：不传 `channelId` 获取 workspace Task；
- `listGitHubExternalWorkCiTriage(cwd, options)`：不传 `channelId` 获取 workspace CI triage；
- `listChannelWorkflows(cwd, channelId)` 与 `listChannelWorkflowSteps(cwd, workflowId)`：按现有频道聚合；
- `listRuns(cwd)`、`listApprovals(cwd)`、`listWorkItems(cwd)`：workspace 列表。

此外已有 `listExternalWorkActions(cwd)` 可提供 workspace external action view，`listRunArtifacts(runId, cwd)`
可在用户展开 Evidence 时按需读取 Run artifacts。因此这是 Web projection 缺口，不是 API blocker。
P11 必须用现有接口建立 workspace 只读聚合快照，不能继续把 selected-channel 数组称为全局，也不能新增
数据库或第二份 durable Task store。该快照只是可丢弃的 read model，不接受 Task 写入或状态变更。

现有 list API 有服务端上限：Task/Approval/WorkItem/External Action/CI 每类最多 500，Run 最多 200；当前 Web
调用的默认值更低。P11 必须请求现有最大 limit。任一 source 返回恰好上限时，将 freshness 标为 `capped`，
显示 `Showing the latest available records`，并禁止把 summary/count 描述为无界全量。增加 cursor/pagination 属于
未来 API 工作，不在本 UI2 切片伪造。

## 5. Function ID 合同

保留当前模块已经定义的六个稳定 ID；本 production slice 受写入边界限制，不修改全局覆盖矩阵。

| Function ID | 产品范围 | 当前锚点 | P11 完成证据 |
|---|---|---|---|
| `BOARD-LIST-001` | scopes、搜索、筛选、排序、summary、长列表 | `GlobalWorkBoardPage` | focused list/filter/100-row E2E + 双尺寸截图 |
| `BOARD-ROW-001` | identity、single status、selection、next action、scoped busy | `WorkItemRow` | row matrix、keyboard、busy/failure E2E |
| `BOARD-DETAIL-001` | summary-first Inspector、关联对象、claim、route、evidence、raw details | page 内 `WorkItemDetailDrawer` | Inspector/action/disclosure E2E + screenshot |
| `BOARD-EMPTY-001` | first loading、true empty、scope empty、no result、selected missing | `WorkBoardEmptyState` | 每种空态独立断言 |
| `BOARD-OPEN-001` | Task/Run/Approval/Channel/External target 导航 | `AppShell` callbacks | 目标精确、失败保留、无隐式跳转 E2E |
| `BOARD-GUIDE-001` | 默认折叠的处理指南 | empty Inspector details | collapsed/default、keyboard、reduced-motion E2E |

全局矩阵当前只登记 `BOARD-LIST-001`、`BOARD-DETAIL-001`、`BOARD-OPEN-001`。后续 production closeout
必须把另外三个 module-local ID 登记进去；本任务受写入边界限制，不改矩阵。

## 6. 数据投影与去重规则

### 6.1 Canonical sources

Work Board 只读取现有 canonical records：

```text
Task[]
RunSession[]
ApprovalRequest[]
ChannelWorkflowStep[]
ExternalWorkActionView[]
ExternalWorkCiTriageView[]
RunArtifact[]
Durable WorkItemView[]
```

### 6.2 Durable precedence

`sourceType + sourceId` 相同的 durable WorkItem 覆盖 derived row。该规则保持现状，避免一个 Task 同时出现
derived 和 durable 两行。不同 source 的关联对象仍是同一 WorkItem 的 linked targets，不进行标题猜测式去重。

### 6.3 Derived source mapping

| Source | Work item id | 状态 owner | Target owner |
|---|---|---|---|
| Task | `task:<taskId>` | pending approval 优先，否则 Task/Run mapping | Channel Task workspace |
| standalone Run | `run:<runId>` | Run status；pending approval 优先 | Runs |
| Workflow Step | `workflow-step:<stepId>` | Step status；pending approval 优先 | Task/Run/Channel 中现有 target |
| External action | `external-action:<actionId>` | external action status | Inbox/Channel |
| CI triage | `external-ci:<triageId>` | CI triage status | Task/Run/Channel |
| standalone pending Approval | `approval:<approvalId>` | `waiting/approval` | Inbox |
| Durable item | durable id | Core WorkItem status/claim/dependency | WorkItem mutation + linked target |

### 6.4 Status mapping

Work Board 只显示一个主状态：

| Work status | Tone | 含义 |
|---|---|---|
| `intake` | neutral | 新进入、未完成 triage |
| `triage` | info | 正在分类/路由 |
| `backlog` | neutral | 待处理 Task |
| `ready` | neutral | 已准备或已领取，尚未运行 |
| `running` | info | Run 或 Workflow Step 正在执行 |
| `waiting` | warning | 等待审批、外部、用户、资源、handoff、scheduler 或 provider |
| `review` | warning | 等待人工复核 |
| `blocked` | danger | 失败、阻塞、stale target 或需修复 |
| `done` | success | 已完成 |
| `archived` | neutral | 取消、跳过或归档 |

StatusIndicator 之外不得再用整行绿色/黄色/红色底色。waiting/blocked 可保留 2px 语义边线，但不能与多个
彩色 Badge 叠加。

## 7. 页面结构与固定尺寸

```text
WorkBoardPage
  WorkBoardHeader
    identity: Work Board
    neutral summary / stale summary
    Refresh IconButton
  WorkBoardToolbar
    Tabs: Needs action / All active / Channel / Mine / Blocked / History
    Search Input
    Filter Popover trigger
    Sort Select
  WorkBoardContent
    WorkBoardListPane
      grouped DataRow list / state surface
    WorkBoardInspector
      summary / primary action / sections / feedback
  WorkBoardFailDialog
```

尺寸规则：

- Page 根节点 `height: 100%`、`min-width/min-height: 0`、`overflow: hidden`；不拥有 document scroll。
- Header 高度由内容决定，目标 `52px`，最小 `48px`；不显示长说明段落。
- Toolbar 使用两行上限：第一行 Tabs，第二行 Search/Filter/Sort；`1280x800` 不换成卡片。
- Content 使用 `minmax(0, 1fr) minmax(320px, 360px)`；Inspector 不超过 `360px`。
- List pane 和 Inspector 各自是唯一垂直 scroll owner；Toolbar/Header 固定。
- Tabs 保持单行，容器可内部横向滚动；不得产生 page/body 横向滚动。
- Row 目标最小高度 `56px`，identity 与 next action 各最多一行，长文本 ellipsis + title/Inspector 完整值。
- Popover 宽 `360px`、最大高 `min(560px, available-height)`，内部滚动，collision padding `12px`。
- Inspector section 使用共享 `InspectorSection`；raw diagnostics 默认关闭。

## 8. Scope、搜索、筛选与排序

### 8.1 Scope

| Scope | 精确 predicate | 默认分组 |
|---|---|---|
| `actionable` | 非 terminal 且 waiting/blocked/review/approval/claimed/unclaimed durable/unassigned | action group |
| `global` | 非 `done/archived` | action group |
| `channel` | 有 `channelId` 且非 terminal | action group |
| `mine` | 有 assignee 或 active claim 且非 terminal | action group |
| `blocked` | `blocked` 或 `waiting` | action group |
| `history` | `done` 或 `archived` | `YYYY-MM-DD`，updated desc |

默认 scope 为 `actionable`。Scope 切换清空用户 filter 以外的 selection intent，不清空 Search/Filter；
如果当前筛选仍有结果，选择第一行；没有结果进入 scope/no-result state。

### 8.2 Search

共享 Input，实时本地匹配：title、subtitle、channel display name、teammate display name、source label、status label、
waiting reason、labels、Task/Run/Approval/WorkItem id。ID 可搜索但不在默认 row 显示。

### 8.3 Filter Popover

固定顺序：Channel、Status、Source、Owner、Waiting reason、Priority。全部使用 shared Field + Select，
即时生效；Popover footer 只有 `Clear filters`。Filter trigger 显示 active count Badge，不显示长摘要。

Owner 选项固定为：All、Unassigned、Claimed、当前 teammate 列表。没有权威 teammate display name 时显示现有 id，
不得猜名称。

### 8.4 Sort

固定三个选项：

1. `Recently updated`：默认，`updatedAt desc`；
2. `Priority`：urgent/high/normal/low，再 `updatedAt desc`；
3. `Oldest updated`：`updatedAt asc`。

History 仍先按日期分组，再在组内应用 sort；其他 scope 先按 action group，再在组内应用 sort。不得跨组拖拽。

## 9. Selection 与请求竞态

### 9.1 Selection states

| State | 行为 |
|---|---|
| first data, no explicit intent | 选择第一个 visible row，Desktop Inspector 不空白 |
| user selects row | 保持 id，更新 Inspector；不离开页面 |
| selected row filtered out | 不静默选择别行；Inspector 显示 `Selected work is hidden by filters` + Clear filters |
| selected row removed after refresh | 保留 missing id；Inspector 显示对象已变化/不存在 + Refresh + Clear selection |
| scope manually changed | 取消旧 explicit selection；选择新 scope 第一行 |
| empty scope | selection 清空；显示 scope empty |
| same item requested twice | 每次 open intent 都重新定位/聚焦，不能被旧 ref 去重 |

### 9.2 Open intent

`AppShell.openWorkBoard` 传入前端-only：

```ts
interface WorkBoardOpenIntent {
  readonly requestId: number;
  readonly scope: WorkBoardScope;
  readonly itemId?: string;
}
```

`requestId` 每次调用递增。它不进入 route、URL、API 或 contract。Controller 只应用最新 requestId。

### 9.3 Load identity

workspace source projection 使用 `cwd + requestSequence`：

- cwd 变化立即使旧请求失效并重置 selection/filter/overlay；
- refresh N+1 先完成时，refresh N 不能覆盖；
- open intent 在 load 中保持 pending；最新 load 完成后再解析 item；
- 用户在等待期间手动切 scope/filter 后，旧 intent 不重新覆盖 interaction revision；
- mutation response 只更新 exact work item id，不能重排/选中另一个对象。

## 10. Reachable state matrix

### 10.1 Page/list freshness

| State | UI | 数据规则 | Action |
|---|---|---|---|
| first loading, no rows | 结构匹配的 6 行 Skeleton + Inspector Skeleton | 不显示 empty | Refresh disabled/loading |
| fresh | normal list | 最新成功 snapshot | Refresh enabled |
| refreshing with rows | 保留 rows，Refresh spinner，summary `Refreshing` | 不退回 Skeleton | row actions 可用，除同对象 mutation |
| partial initial | 成功 source rows + warning InlineFeedback | 不把 counts 宣称为完整 | Retry failed sources |
| retained stale | 保留上次 rows + persistent warning | 显示 failed source；不清空 | Retry |
| capped source | 保留最大边界 rows + neutral/info InlineFeedback | summary 标记 latest available，不声称无界全量 | 无假 Load more；Technical details 说明 limit |
| total initial error | page InlineFeedback + compact EmptyState | 无伪数据 | Retry |
| daemon offline | AppConnectionStatus + Board stale warning | 保留 rows | Retry connection/Refresh |
| no cwd | compact blocker | 不请求 API | Open workspace settings if existing callback，否则 disabled reason |

### 10.2 Selected evidence freshness

| State | UI | Rule |
|---|---|---|
| Evidence closed | 只显示已知 artifact/proof count 或 `Available in Run` | 不发请求 |
| first open with run | section 内 Skeleton | 调现有 `listRunArtifacts` |
| loaded empty | `No run artifacts` | 不伪造 0 之外的证据 |
| loaded | compact artifact rows/count + Open run evidence | 不复制 artifact preview |
| refresh failure with cache | 保留 artifact rows + stale InlineFeedback | Retry exact run |
| first failure | section InlineFeedback | Retry exact run |
| selection/run switch race | 旧 response 丢弃 | key = cwd + itemId + runId + requestId |

### 10.3 Empty and no-result

| State | Title | Action |
|---|---|---|
| workspace true empty | `No work yet` | Open a channel；不显示 View history |
| actionable empty | `No work needs your attention` | View all active / History |
| history empty | `No completed work yet` | View needs action |
| scope empty | `No work in this view` | 切换 Needs action / All active |
| search/filter no result | `No work matches these filters` | Clear filters |
| selected hidden | Inspector 内说明 | Clear filters / Clear selection |
| selected missing | Inspector persistent warning | Refresh / Clear selection |

### 10.4 Work item states

必须 E2E 到达：intake、triage、backlog、ready、running、waiting approval、waiting non-approval、review、blocked、
done、archived、unassigned、assignee、unclaimed durable、claimed durable、expired claim projection、dependency blocker、
retry budget exhausted、standalone approval、standalone run、workflow step、external action、CI triage、long title/labels。

### 10.5 Approval states

- pending：Board 显示 waiting/approval，主行动 `Handle approval`；
- approved/denied/expired/cancelled standalone approval：不生成 standalone row；
- external action denied/expired/stale target：映射 blocked，打开 Inbox/linked object 查看原因；
- approval resolution busy/failure：由 Approvals surface 拥有，返回 Board 后通过 refresh 投影；
- Board 不渲染 Approve/Deny。

### 10.6 Run and Thread states

- queued -> ready；running -> running；waiting_for_approval -> waiting；succeeded -> done；failed -> blocked；
  cancelled -> archived；
- `View failure/View run` 进入 Runs，并选中精确 run id；
- Run 不在当前 cached list 时仍允许 `loadRun(runId)`，加载失败回到 Board 时保留 navigation failure；
- Thread 只能从 Runs/Thread Page 进入。无 `threadId` 时 Board 不显示 Thread action。

## 11. Row 与 Inspector 内容

### 11.1 Row

DataRow 固定四槽：

- identity：source icon、title；
- summary：next action、channel/owner、updated time，最多一行；
- status：一个 StatusIndicator；
- actions：至多一个 visible text action或一个 claim action。

Row click/Enter/Space 只选择。Inner Button 必须 stop propagation；DataRow 使用 `role=option`，外层 list 使用
`role=listbox` + `aria-label=Work items`。不得继续用 `article role=button` 包裹多个按钮。

Labels 默认不铺在 row；最多显示 `+N labels` 中性 Badge，完整 labels 进 Inspector。

### 11.2 Inspector default layer

固定顺序：

1. title + single StatusIndicator；
2. 一句 Next action；
3. item-scoped InlineFeedback；
4. 一个 primary action + 必要 secondary actions；
5. Owner、Channel、Source、Updated 四项紧凑 summary；
6. `Linked objects` InspectorSection，默认关闭；
7. `Evidence` InspectorSection，默认关闭；
8. `Work controls` InspectorSection，仅 durable/route item 显示，默认按是否需行动决定；
9. `Technical details` InspectorSection，始终默认关闭。

Evidence 默认关闭；打开后，有 run 的 item 通过现有 `listRunArtifacts` 按需读取并缓存，durable item 使用
contract 已携带的 artifact/proof ids。有 run 时提供 `Open run evidence`。当前没有独立 artifact product view，
因此 P11 不新增 artifact preview/download 行为。

### 11.3 Technical disclosure

可显示：work item id、source type/id、task/run/workflow/step/external/approval id、created/updated、attempt/retry、
claim owner/claimedAt/heartbeatAt/expiresAt、artifact/proof ids、failure reason、dependency ids、raw provider message。

禁止显示：claim token、secret、authorization header、完整环境变量、attachment 本地绝对路径。claim token 即使 contract
中存在也不能进入 DOM、title、tooltip、ARIA 或 screenshot。

### 11.4 Guide

无选择时 Inspector 先显示 compact EmptyState；其下只有一个默认关闭的 `How Work Board is organized`
InspectorSection，内容三行：Approvals in Inbox、Failures in Needs action、Completed work in History。
不显示常驻大说明卡，不自动展开。

## 12. Action precedence and matrix

### 12.1 Primary action precedence

按以下顺序短路，最多一个 primary：

1. pending `approvalId` -> `Handle approval`；
2. durable、非 terminal、无 claim -> `Claim`；
3. `blocked + runId` -> `View failure`；
4. `runId` -> `View run`；
5. `taskId` -> `Open task`；
6. routeable external work 且无 channel -> `Route to channel`；
7. `channelId` -> `Open channel`；
8. none -> 无主行动。

### 12.2 Secondary and danger

| Condition | Secondary | Danger |
|---|---|---|
| linked Task/Run/Approval/Channel | linked object rows | none |
| claimed durable | Refresh claim、Release claim、Mark done | Mark failed |
| unclaimed durable | Open linked target if present | none |
| routeable external work | Channel Select + Route | none |
| terminal durable | Open linked target | none |
| unsupported manual/durable routing | disabled reason only | none |

`Mark failed` 必须打开 shared Dialog。Dialog 显示对象名与不可逆状态后果；reason 默认为空，trim 后
不能为空。确认调用现有 `fail(..., retry:false)`。busy 时禁止 Esc/outside/Cancel，失败保留 Dialog 和输入。

### 12.3 Busy scope

```ts
type WorkBoardMutation = "claim" | "heartbeat" | "release" | "complete" | "fail" | "route";
type WorkBoardBusyKey = `${workItemId}:${WorkBoardMutation}`;
```

- 只让 initiating control loading；
- 同一 work item 的冲突 mutation disabled；
- 不同 work item 可并行；
- page Refresh 不让所有 row spinner；
- navigation 不复用 mutation busy；
- mutation settle 后恢复原宽度和 focus。

## 13. Feedback lifecycle

| Event | Owner | Lifetime / clear rule |
|---|---|---|
| initial/partial/refresh load failure | Board list InlineFeedback | Retry、cwd change 或成功 refresh |
| claim dependency/already claimed/retry exhausted/terminal blocker | exact row + Inspector InlineFeedback | exact mutation success、authoritative row revision 或 dismiss |
| heartbeat/release/complete/fail failure | exact item InlineFeedback | Retry、row revision 或 dismiss |
| navigation target missing/failure | Inspector InlineFeedback | selection change、Refresh 或 retry |
| field/Fail reason validation | Dialog Field error | input change |
| route/complete/fail success | global Toast, scoped | 3000ms |
| claim/heartbeat/release success | silent authoritative status update | immediate |
| Refresh success | silent | immediate |

Toast scope 固定：`work-item:<id>:<action>`。同一个真实动作不能同时显示 page success、row success 与 Toast。
错误原始 response 进入 Technical details，不在默认层直接显示 HTTP/raw JSON。

## 14. Navigation contract

| Target | Enabled rule | Exact destination | Failure |
|---|---|---|---|
| Task | `taskId` 存在且 Task 可解析 | selected channel + selectedTaskId + workspace | Inspector persistent feedback；不打开空 workspace |
| Run | `runId` 存在 | `loadRun(runId)` + Runs | 保留 Board intent，显示可重试 failure |
| Approval | pending/linked `approvalId` 存在 | Inbox + selectedApprovalId | Inbox own missing/expired state；返回不丢 Board filters |
| Channel | channel 在 active channel list | selected channel workspace | disabled + `Channel is no longer available` |
| External route | externalWorkId + 可选 destination | existing route API | item-scoped failure，保留选择 |
| Thread | never direct in P11 | Runs -> Thread | 不渲染伪 action |

离开 Work Board 的动作必须有文本；不能让 row click 隐式跳转。浏览器 Back/返回应用不新增路由语义；现有
AppShell view state继续负责。

## 15. Keyboard、ARIA 与 Motion

- Tab 顺序：Refresh -> scope Tabs -> Search -> Filter -> Sort -> rows -> row action -> Inspector actions/sections。
- Tabs 支持 ArrowLeft/ArrowRight、Home/End；Search 不劫持全局快捷键。
- DataRow Enter/Space 选择；选择后 focus 不强制跳到 Inspector。
- Filter Popover：Enter/Space 打开、Esc 关闭并回 trigger、outside click 关闭；打开 Dialog 时先关闭 Popover。
- Fail Dialog：初始 focus reason；Cancel/Esc 恢复触发按钮；busy 不关闭。
- InspectorSection：原生 summary 键盘语义；展开状态不跨 work item 继承 Technical details。
- focus-visible 不改变控件外部几何；Input focus 不溢出 32/36px shell。
- hover/selected 只做 `120ms` color/background/border；Popover `120ms` fade/4px；Dialog `180/160ms`；
  disclosure `180ms`。Row 不 stagger，不缩放，不使用 `transition: all`。
- `prefers-reduced-motion: reduce`：移除位移、spinner 改共享 reduced-motion 表现、disclosure 直接切换或仅淡入。

## 16. Light、Dark、Theme 与 i18n

- 所有颜色只用 Ling semantic tokens；success/warning/danger 只表达真实状态。
- 删除 Work Board 内硬编码 `#ffffff` 和 `strict-console.css` 的 Work Board Dark blanket owner。
- `ling-light`、`ling-dark` 和至少一个自定义 Theme Pack fixture 不得改变布局、状态优先级或可读性。
- Desktop renderer 复用 Web 组件；本 P11 只验 Web，packaged macOS/Windows 证据由 P13 单独关闭。
- 中英文必须同时覆盖 scope、filter、sort、状态、disabled reason、blocker、Dialog、Toast、empty/no-result。
- 状态判断、action precedence、filter predicate 不进入 locale 文件。
- title/subtitle/id 使用 `dir=auto`；长中文、英文、路径式 id 不撑宽 row/Inspector。
- icon-only 仅用于 Refresh、Filter trigger、close 等熟悉工具；所有 icon action 必须有 tooltip、title、ARIA。

## 17. Component 与 CSS 目标

### 17.1 Shared primitives

| Current | Target |
|---|---|
| raw/legacy `.secondary-button` | `Button` |
| Refresh text button | `IconButton` + `RefreshCw` |
| raw `.work-board-tabs button` | shared `Tabs` |
| `SelectControl` | shared `Select` + `Field` |
| no search | shared `Input` + `Search` prefix |
| filter card/details | shared `Popover` |
| `StatusBadge` | `StatusIndicator` |
| `OperationEmptyState` | `EmptyState` |
| hand-built row | `DataRow` |
| raw details | `InspectorSection` |
| direct fail mutation | shared `Dialog` + Field + Button |
| global `errorMessage` | scoped `InlineFeedback` |
| local action success text | global `Toast` adapter |

Feature 页面只从 `apps/web/src/shared/ui` 导入共享组件，不直接导入 Radix，不命中 package-private
`.ling-ui-*` selector。

### 17.2 Focused CSS ownership

```text
apps/web/src/styles/work-board.css                 import manifest only
apps/web/src/styles/work-board/page.css            page grid/header/content <=180
apps/web/src/styles/work-board/toolbar.css         tabs/search/filter/sort <=220
apps/web/src/styles/work-board/list.css            groups/row/long-list <=260
apps/web/src/styles/work-board/inspector.css       inspector/actions/details <=300
apps/web/src/styles/work-board/channel.css         Channel projection <=160
```

每个新增 CSS 文件硬上限 `400` 行，目标总量低于当前 698 行。Feature CSS 只拥有布局与领域尺寸；Button、
Input、Select、Status、Popover、Dialog、DataRow chrome 由 package CSS 拥有。

## 18. Genuine blockers and explicit non-blockers

当前没有阻塞 P11 Web UI2 的 API 或业务决策：现有 API 足以读取有明确上限的 workspace
Task/Run/Approval/WorkItem/External Action/CI，并按频道读取 Workflow/Step；现有 mutation 足以
claim/heartbeat/release/complete/fail 和 route external work。无界历史不是本切片可证明的能力；达到现有
500/200 上限时必须诚实标记 capped。

以下边界不是本切片缺口，不得自行扩 scope：

1. WorkItem contract 没有 `threadId`，因此不支持 Board -> Thread 直达；需要时属于未来 contract/API 决策。
2. Web 未接通 generic `routeWorkItem`，因此 manual/durable item 不新增通用 route；当前只 route external work。
3. WorkItem artifact 只有 id 时没有独立 artifact product view；P11 只显示计数/raw id 和 Run evidence 入口。
4. packaged macOS/Windows 不是 Web verified 的替代或前置；由 P13 单独验收。
5. list API 没有 cursor/total，无法证明超过单状态/单 source 服务端上限后的无界完整性；P11 通过 capped
   状态避免误报，不增加假分页。

## 19. Completion gate

只有以下全部满足，六个 ID 才能标记 `verified`：

- workspace 全量 source projection 不再依赖 selected channel；
- 六个 scope、Search、六类 Filter、三种 Sort、所有 empty/no-result/stale/error 可达；
- 十种 WorkItem 状态与 durable claim/blocker/action matrix 只显示一个主状态和一个主行动；
- Approval、Run、Task、Channel 导航精确，Thread 边界不伪造；
- Teammate Tasks/Channel Board 仍是 bounded projection，创建不自动运行；
- request/selection/cwd/mutation races 有 focused E2E；
- `GlobalWorkBoardPage.tsx < 800`，所有新增 production owner `<400`；
- CSS focused split、无硬编码颜色、无 `!important`、无 private keyframe、无 package-private selector；
- `1440x960`、`1280x800`，Light/Dark、keyboard、reduced motion、i18n、console、overflow 通过；
- focused + legacy + selected regression 全绿，原尺寸截图和 SHA-256 metadata 完成；
- 没有 API、contract、DB、route、state machine 或 Logo 变化。

2026-07-23 closeout：9 张 screenshot matrix、focused + legacy `11/11`、Dark `2/2`、i18n、console、
overflow 和 raw technical failure 折叠均通过。完整账本见
[Work Board evidence metadata](../evidence/features/work-board/metadata.md)。Web 六个 ID 为 verified；packaged
macOS/Windows 继续 P13 pending。
