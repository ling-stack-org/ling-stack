# P11.1 Work Board UI 2.0 零决策实施计划

## 0. Execution contract

本计划实施 [P11.1 Work Board UI 2.0 零决策设计合同](14-Work-Board.md)。独立 production slice 和 WB-08
模块内 closeout 已按本文执行；全局覆盖矩阵、README、总控和状态看板仍由全局 owner 登记。

> 2026-07-23 closeout：AppShell/locale/outcome/open-intent 已接线，9 张 changed-state evidence 与
> focused/legacy `11/11`、Dark `2/2`、i18n gate 已通过。Fail Dialog 和 Inspector raw detail 默认折叠，
> 模块 Web 状态为 `verified`；packaged Desktop pending。

允许后续 production slice 修改：

- Work Board 的 Web presentation controller、view-model、展示组件、focused CSS、locale、E2E 与 evidence；
- 现有 Web domain 的 loading/error/busy/request guard 展示接口；
- `AppShell` 的薄 props/callback/open-intent 适配；
- 对现有 `lib/work-items.ts` 做有 characterization test 保护的机械拆分。

禁止修改：

- daemon route、API-client request/response、contracts、Core store、SQLite schema；
- Task、Run、Approval、Thread、WorkItem、external action 状态机；
- `ViewId`、Sidebar IA、Settings IA、主导航顺序；
- 自动启动 Run、增加第二个 Task/WorkItem store、通用 durable route、直接 Thread target；
- Logo、移动端、与 Work Board 无关的混合工作树文件。

## 1. Preconditions and worktree safety

每个 implementation slice 开始前：

```bash
git status --short --branch
wc -l \
  apps/web/src/features/work-board/GlobalWorkBoardPage.tsx \
  apps/web/src/features/work-board/WorkItemRow.tsx \
  apps/web/src/features/work-board/ChannelWorkBoard.tsx \
  apps/web/src/lib/work-items.ts \
  apps/web/src/domains/work-items/use-durable-work-items-domain.ts \
  apps/web/src/styles/work-board.css \
  apps/web/e2e/work-board.spec.ts
```

规则：

1. 保留当前 Desktop/CUA/UI2 混合脏工作树；禁止 reset、clean、stash、switch、rebase、merge、commit、push。
2. 先建立现有 WorkItem mapping 的纯测试和 `work-board.spec.ts` baseline，再拆文件。
3. 浏览器验收必须确认服务的是 Vite source，而不是 stale `dist` 或 packaged renderer。
4. AppShell 只允许增删 import、props、callback 和 `WorkBoardOpenIntent` 适配；禁止加入 filter/selection/feedback JSX。
5. 每个 slice 完成后局部验证，不等最后一次性跑测试。

## 2. Target module boundary and line budgets

### 2.1 Production owners

```text
apps/web/src/features/work-board/
  GlobalWorkBoardPage.tsx                  composition only, <=180
  WorkBoardHeader.tsx                      title/summary/refresh, <=140
  WorkBoardToolbar.tsx                     Tabs/Search/Filter/Sort, <=240
  WorkBoardList.tsx                        groups/list/state routing, <=220
  WorkItemRow.tsx                          DataRow projection, <=220
  WorkBoardInspector.tsx                   summary/sections/actions, <=360
  WorkBoardEmptyState.tsx                  empty/no-result/missing, <=180
  WorkBoardGuide.tsx                       collapsed guide, <=100
  WorkBoardFailDialog.tsx                  fail confirm/field error, <=160
  WorkBoardLinkedObjects.tsx               target rows, <=180
  useWorkBoardController.ts                presentation/race/selection, <=400
  work-board-view-models.ts                filter/group/status/action, <=400
  work-board-types.ts                      display-only contracts, <=220
  ChannelWorkBoard.tsx                     bounded projection, <=180
  index.ts

apps/web/src/domains/work-items/
  use-work-board-source-projection.ts       global read projection, <=360
  use-durable-work-items-domain.ts          durable mutation owner, <=300

apps/web/src/lib/work-items/
  source-projections.ts                    source -> WorkItem, <=400
  status-projections.ts                    mapping/action groups, <=240
  merge-work-items.ts                      durable precedence/dedupe, <=180
  index.ts                                 public facade, <=100

apps/web/src/styles/work-board.css          imports only, <=20
apps/web/src/styles/work-board/page.css     <=180
apps/web/src/styles/work-board/toolbar.css  <=220
apps/web/src/styles/work-board/list.css     <=260
apps/web/src/styles/work-board/inspector.css <=300
apps/web/src/styles/work-board/channel.css  <=160
```

若机械拆分 `lib/work-items.ts` 会扩大当前 slice 风险，可保留 550 行文件，但必须做到：不再加入 UI state、
文案、CSS、React 或 controller 判断；所有新增 production owner 仍 `<400`。`GlobalWorkBoardPage.tsx` 在增加任何
新行为前必须先降到 `<400`，最终目标 `<=180`。

### 2.2 Responsibility table

| Layer | Owner | 允许职责 | 禁止职责 |
|---|---|---|---|
| Source domain | `use-work-board-source-projection` | existing API read、retained read model、selected evidence、source freshness、cwd/request guard | Task 写入、UI copy、filter、selection、mutation |
| Durable domain | `use-durable-work-items-domain` | WorkItem mutation、per-item busy、blocker/error outcome | global Toast timer、JSX、Task mutation |
| Pure projection | `work-board-view-models` | scopes/search/filter/sort/group/status/action/disabled reason | hooks、API、i18n state |
| Presentation | `useWorkBoardController` | open intent、selection、filter、Popover/Dialog、feedback owner、focus intent | API contract、server truth |
| UI | focused TSX | shared primitives、events、ARIA | status precedence、raw API 判断 |
| App adapter | `AppShell` | source props、navigation callbacks、intent sequence | list derivation、error copy、overlay state |

## 3. Display-only contracts

在 `work-board-types.ts` 固定：

```ts
export type WorkBoardScope = "actionable" | "global" | "channel" | "mine" | "blocked" | "history";
export type WorkBoardSort = "updated-desc" | "priority" | "updated-asc";
export type WorkBoardFreshness = "initial" | "fresh" | "refreshing" | "partial" | "stale" | "capped" | "error";
export type WorkBoardMutation = "claim" | "heartbeat" | "release" | "complete" | "fail" | "route";

export interface WorkBoardOpenIntent {
  readonly requestId: number;
  readonly scope: WorkBoardScope;
  readonly itemId?: string;
}

export interface WorkBoardFilters {
  readonly channelId: string;
  readonly owner: "" | "unassigned" | "claimed" | `teammate:${string}`;
  readonly priority: "" | "low" | "normal" | "high" | "urgent";
  readonly source: "" | WorkItemSourceType;
  readonly status: "" | WorkItemStatus;
  readonly waitingReason: "" | WorkItemWaitingReason;
}

export interface WorkBoardSourceIssue {
  readonly kind: "load" | "capped";
  readonly source: "tasks" | "runs" | "approvals" | "work-items" | "workflows" | "external-ci" | "external-actions";
  readonly message: string;
  readonly technicalMessage?: string;
}

export interface WorkBoardEvidenceState {
  readonly itemId: string;
  readonly runId: string;
  readonly status: "idle" | "loading" | "ready" | "empty" | "stale" | "error";
  readonly artifacts: readonly RunArtifact[];
  readonly issue?: WorkBoardSourceIssue;
}

export interface WorkBoardMutationState {
  readonly action: WorkBoardMutation;
  readonly itemId: string;
}

export type WorkBoardNavigationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly technicalMessage?: string };
```

这些类型只存在 Web，不导出到 contracts。`WorkItemView`、Task、Run、Approval 等继续引用现有类型。

## 4. Delivery slices

| Slice | Function IDs | 结果 | 依赖 |
|---|---|---|---|
| P11.1a | all | baseline、fixtures、mapping characterization | none |
| P11.1b | LIST/ROW/DETAIL | source projection、view-model、controller、race guards | a |
| P11.1c | LIST/ROW/EMPTY/GUIDE | Header/Toolbar/List/shared primitives | b |
| P11.1d | DETAIL/OPEN | Inspector、actions、fail Dialog、navigation/feedback | b |
| P11.1e | ROW/LIST | Channel projection 与私聊消息转任务 regression | c/d |
| P11.1f | all | focused CSS/i18n/a11y/motion | c/d/e |
| P11.1g | all | E2E、browser、screenshots、metadata、global docs closeout | all |

## 5. Implementation task list

百分比按 P11.1 生产切片工作量计算，总计 100%。下表记录本次 production slice 的完成或 partial 状态。

| Task | 内容 | 主要文件/模块 | 依赖 | 可并行 | 状态 | 验证 | 占比 |
|---|---|---|---|---|---|---|---:|
| `WB-00` | baseline、现有 mapping characterization、fixture catalog | lib/work-items, work-board spec | none | 否 | 完成 | legacy baseline `1/1` + focused fixtures | 7% |
| `WB-01` | workspace 全量 source projection、retained stale、request guard | domains/work-items | WB-00 | 是，独立于 UI shell | 完成 | source/stale/capped/StrictMode identity E2E + AppShell cwd | 16% |
| `WB-02` | pure view-model、action/status/filter/sort matrix | work-board-view-models | WB-00 | 是 | 完成 | focused filter/sort/action E2E + typecheck | 12% |
| `WB-03` | presentation controller、open intent、selection/race/focus | useWorkBoardController | WB-01/02 | 否 | 完成 | selection/keyboard/focus + requestId + refresh focus restore E2E | 13% |
| `WB-04` | Header、Toolbar、List、Empty/Guide、shared migration | focused components | WB-02/03 | 是，与 WB-05 文件不交叉 | 完成 | list/filter/empty/keyboard E2E | 14% |
| `WB-05` | Inspector、linked objects、mutation、Dialog、feedback/navigation | focused components + durable domain | WB-01/02/03 | 是，与 WB-04 文件不交叉 | partial | action/outcome/focus 已验；Dialog 仍直接显示 technicalMessage | 17% |
| `WB-06` | Channel Board、私聊消息转任务/Inbox/Runs regression adapters | channel/teammate/AppShell thin wiring | WB-04/05 | 否 | 完成 | Channel bounded projection + legacy regression + AppShell thin wiring | 7% |
| `WB-07` | focused CSS、i18n、theme、a11y、motion、overflow | styles/work-board + locale | WB-04/05/06 | 部分 | 完成 | `check:i18n` + Light/Dark/reduced-motion/overflow | 7% |
| `WB-08` | full gates、双尺寸截图、metadata、覆盖矩阵/status closeout | E2E/evidence/docs | all | 否 | 模块内完成 | 8/8 verified evidence；全局矩阵由全局 owner 登记 | 7% |

### 5.1 Locale closeout

主 Agent 已补齐以下 Work Board `en-US` / `zh-CN` key。2026-07-23 `check:i18n` 通过：
`en-US=3902 / zh-CN=5561 / literalKeys=3318 / dynamicCalls=397`。保留清单作为 locale 审计记录：

```text
A failure reason is required.
Approvals are handled in Inbox.
Channel work items
Clear filters to see work in this view.
Completed work appears in History.
Could not load run evidence
Evidence could not be loaded
Failures appear in Needs action.
Filter work
How Work Board is organized
Labels
Mark work as failed
No completed work yet
No evidence recorded
No run artifacts
No work in this view
No work matches these filters
No work yet
Oldest updated
Open a channel
Open run evidence
Partial data
Recently updated
Search work
Select work to inspect
Selected work is hidden by filters
Selected work is no longer available
Showing retained data
Showing retained evidence
Showing the latest available records
Sort work
This records a terminal failure for {name}.
View all active
View needs action
Work Board could not be loaded
Work cannot be claimed yet
Work details
Work from tasks, runs, approvals, and channels will appear here.
Work item ID
Work marked failed
Work routed
labels
this work item
{count} active filters
```

### 5.2 Verified Web evidence

真实 Vite source 使用 `LING_PLAYWRIGHT_PORT=4194` 采集，原尺寸目检通过；每张 sidecar metadata 记录 URL、
viewport、theme、locale、console、document/list/Inspector metrics、reduced-motion、sourceActive、RGB 与 SHA-256。

| File | State | SHA-256 |
|---|---|---|
| `evidence/features/work-board/1440x960-ling-light-actionable-mixed.png` | actionable mixed groups + keyboard-selected Inspector | `71445ebd96762a323a292182539c2091f12555e604312fb7bd600e2e26e27694` |
| `evidence/features/work-board/1280x800-ling-dark-filter-no-result.png` | active status filter + no-result | `7361c2b30c51ee540f8d71719a2cadd52fe9817a846660a99cc8ab57d83abcdc` |
| `evidence/features/work-board/1440x960-ling-light-approval-inspector.png` | pending approval + exact Inbox action + raw folded | `cb9302efbaba7de803ac852d6e4a479d92980f0cc97e54fa388e6324027ba70c` |
| `evidence/features/work-board/1280x800-ling-dark-retained-stale.png` | retained capped rows + stale source + Retry | `d6775f2b8fedfa261c9b3700e11385313d4b1ca7c78361efd2f0278df8afc3cf` |
| `evidence/features/work-board/1440x960-ling-light-durable-fail-dialog.png` | claimed durable + failed mutation + retained reason | `6a856a7578f8f931860c23b7d2cab983e118c683209dc06c95d77826374ded29` |
| `evidence/features/work-board/1280x800-ling-dark-long-list-reduced-motion.png` | 120 rows + long text + independent scroll + reduced motion | `ff3578d95fbeffab4921e8e20359e3b725a6a646cb99c0d1316666520001e608` |
| `evidence/features/work-board/1440x960-ling-light-selected-missing.png` | authoritative removal + explicit recovery | `1fdded3fbc5b8d6455f684c2cc60b864940af0c5d9489c94455bc6af7feb5aeb` |
| `evidence/features/work-board/1280x800-ling-dark-channel-projection.png` | Engineering-only non-terminal bounded projection | `de2fad1c5c377bf580fd1ccf74bfdbc6449cfc32e64f8ae60079096fde686cb9` |

八张均为 `verification=verified`，sidecar 记录 Vite URL、theme id、locale、viewport/RGB dimensions、
source state、visible rows、document/list/Inspector/Channel scroll metrics、reduced motion、console、overflow 和 SHA-256。
原尺寸目检通过；Fail Dialog 图同时如实记录了默认层显示 technicalMessage 的剩余缺口。

## 6. P11.1a Baseline and characterization

### 6.1 Fixture catalog

在新 `ui2-work-board.spec.ts` 或 support helper 建立稳定 id：

| Fixture | Required state |
|---|---|
| `board_empty` | 所有 sources 为空 |
| `board_task_matrix` | todo/claimed/running/blocked/review/done/failed/cancelled |
| `board_work_status_matrix` | intake/triage/backlog/ready/running/waiting/review/blocked/done/archived |
| `board_pending_approval` | task/run/standalone pending approval |
| `board_run_matrix` | six Run states、standalone Run、run with thread |
| `board_durable_unclaimed` | dependency-free claimable item |
| `board_durable_claimed` | owner/lease/attempt/retry/proof ids |
| `board_claim_blockers` | dependency、already claimed、retry exhausted、terminal |
| `board_external` | action waiting/approved/failed/stale/cancelled + CI triage |
| `board_partial_stale` | 一项 source refresh failure，其他 source 成功 |
| `board_long_100` | 100+ rows、long title/channel/labels/id |
| `board_target_missing` | requested id 不存在、selected item refresh 后消失 |

所有 fixture 使用假 id、无真实 secret。Claim token 使用明显 fake 值，并断言它不出现在 DOM、ARIA、title、
tooltip 和截图文本。

### 6.2 Characterization tests

冻结当前业务规则：

- durable 按 `sourceType:sourceId` 覆盖 derived；
- Task/Run/Workflow/External/CI/Approval 全映射；
- ten WorkItem status label/group/terminal/actionable；
- pending approval precedence；
- six scope predicate；
- Task/Run/Step/external status mapping；
- no auto-run from task creation/open/routing；
- claim/heartbeat/release/complete/fail request payload 不变。

在 characterization 通过前不得拆 `work-items.ts`。

## 7. P11.1b Source and controller implementation

### 7.1 Workspace source projection

`use-work-board-source-projection.ts` 只在 Work Board mounted/active 且 cwd 有效时加载完整 workspace read model：

1. `listTasks(cwd, undefined, 500)` 或兼容 overload，不传 channel、传现有最大 limit；
2. `listRuns(cwd, { limit: 200 })`；
3. `listApprovals(cwd, { limit: 500 })`；
4. `listWorkItems(cwd, { limit: 500 })`；
5. `listExternalWorkActions(cwd, { limit: 500 })`；
6. `listGitHubExternalWorkCiTriage(cwd, { limit: 500 })`，不传 channel；
7. 对 active channel 并发 `listChannelWorkflows(cwd, channel.id)`；
8. 对返回 workflow 并发 `listChannelWorkflowSteps(cwd, workflow.id)`；
9. `buildWorkItemViews` 在 feature view-model 前只执行一次。

该 hook 的 Task/Run/Approval/WorkItem arrays 是不可变、可丢弃的 read model，不提供 Task setter、CRUD 或状态
transition，也不替代各业务 domain。AppShell 不再把 selected-channel arrays 作为 global Board truth。

`apps/web/src/api/channels.ts` 的 `listTasks` 与 `api/approvals.ts` 的 wrapper 可增加向后兼容的 `limit`
参数透传；不得修改 API-client/contracts/daemon。每个 capped source 恰好返回 500（Run 为 200）时记录
`capped=true`；由于 response 没有 cursor/total，UI 只显示 latest available，不能渲染假的 Load more 或完整总数。

Evidence 不在首屏批量加载。用户首次展开 selected item 的 Evidence 时：

- 有 `runId`：调用现有 `listRunArtifacts(runId, cwd)`；
- 无 run：只使用 durable WorkItem 已携带的 artifact/proof ids；
- cache key 为 `cwd + itemId + runId`；
- retry 保留旧 artifacts 并显示 stale；
- selection/cwd/requestId 变化使旧 response 失效；
- 不增加 artifact preview/download API 或行为。

并发必须使用 request identity：

```text
identity = normalized cwd
requestId = monotonically increasing integer
channelRevision = sorted active channel ids + updatedAt/status
```

只有三者仍匹配时发布。Channel list 变化触发新 request；旧请求结果丢弃。

### 7.2 Retained source result

- 每个 source 保存 last successful value 和 issue；失败不清空旧值；
- initial 全失败 -> `error`；部分成功 -> `partial`；有旧值 refresh 失败 -> `stale`；触及服务端上限 -> `capped`；
- source 成功后只清自己的 issue；
- UI count 在 partial/stale 时加 `Partial data`，不显示虚假的完整性语言；
- cwd change 清空所有 retained values，不能跨 workspace 展示。

### 7.3 Durable domain

将：

```text
busyWorkItemId: string
routingExternalWorkId: string
global setErrorMessage
```

收敛为：

```text
busyByWorkItemId: ReadonlyMap<string, WorkBoardMutation>
failureByWorkItemId: ReadonlyMap<string, WorkBoardActionFailure>
blockerByWorkItemId: ReadonlyMap<string, WorkItemClaimBlocker>
routingByExternalWorkId: ReadonlySet<string>
```

保持现有 API payload。不同 item 可并发，同 item mutation single-flight。Claim blocker 不是 global page error。
Mutation response 必须确认 response item id 与请求 id 相同；cwd 已变时丢弃。

### 7.4 Presentation controller

`useWorkBoardController` 拥有：

```text
scope, query, filters, sort
selectedItemId, selectionOrigin
latestAppliedOpenIntentId, interactionRevision
filterPopoverOpen
failDialogTargetId, failReason, failValidation
navigationFailureByItemId
expandedInspectorSectionByItemId (only non-technical optional state)
evidenceOpenIntent (delegates load to source projection)
focusReturnIntent
```

不拥有 canonical arrays、API calls、Toast timers 或 status mapping。

Controller exact rules：

1. scope/filter/search/sort view 由 pure function 派生；
2. open intent 只按 requestId 应用一次，同 item 新 request 仍应用；
3. requested item load 中保持 pending，不先选择第一行；
4. load settled missing -> selected-missing；
5. filter hidden -> selected-hidden；
6. mutation 导致 scope 移除 -> missing/changed feedback，不自动跳到下一行；
7. manual scope change -> clear explicit selection and choose first new visible row；
8. cwd change -> reset local state、close Popover/Dialog、invalidate focus return；
9. Popover 与 Dialog 互斥；打开 fail Dialog 先关闭 filter Popover；
10. success Toast 通过 shared adapter，不设置 feature timeout。

## 8. P11.1c Header, toolbar, list and empty states

### 8.1 Header

`WorkBoardHeader`：

- H1 `Work Board`；
- summary 顺序：`{actionable} need action · {running} running · {blocked} blocked`；零值保留中性 count，
  但不使用彩色统计卡；
- partial/stale 时 summary 前显示一个 warning StatusIndicator；
- Refresh 使用 icon-only shared IconButton，`loading` 只绑定 refresh；
- 无大段 description、无 Settings mode、无第二个 Refresh。

### 8.2 Toolbar

- 第一行 shared Tabs，六个 scope 固定顺序；
- 第二行 Input Search 占剩余宽，Filter IconButton + active count Badge，Sort shared Select `160px`；
- Filter Popover 六个 Field/Select，`360px`；
- Search 立即更新，无 debounce；
- clear filter 不清 scope/sort，Clear search 由 native search 或 suffix action；
- focus ring owner 是 shared Input shell，native input border/shadow 必须为零。

### 8.3 List

- 外层 `role=listbox`，每组有 heading/count；
- DataRow root `role=option`；
- action group 顺序保持 needs action/in progress/ready/recent done/archived；
- History 使用 date groups；
- row actions 使用 view-model，不在 JSX 判断 `item.status`；
- first loading Skeleton 高度与 row 相同；refresh 不卸载 list；
- 100+ rows 由 list pane 内部滚动，不限制完整数据，不在 P11 引入 virtualization。

### 8.4 Empty/guide

分别实现 true empty、scope empty、actionable clear、history empty、filter no-result、selected hidden、selected missing。
Guide 只在无选择 Inspector 内以默认 closed InspectorSection 出现，不占第一屏。

## 9. P11.1d Inspector, actions and navigation

### 9.1 Pure action view

`deriveWorkBoardActions(item, context)` 返回：

```ts
interface WorkBoardActionView {
  readonly id: string;
  readonly labelKey: string;
  readonly kind: "primary" | "secondary" | "danger";
  readonly disabled: boolean;
  readonly disabledReasonKey?: string;
  readonly loading: boolean;
  readonly target?: "task" | "run" | "approval" | "channel" | "route" | "claim" | "heartbeat" | "release" | "complete" | "fail";
}
```

严格使用合同的 primary precedence；JSX 不二次判断 status。

### 9.2 Inspector

拆成：

- `WorkBoardInspector`：header、next action、summary、action composition；
- `WorkBoardLinkedObjects`：Task/Run/Approval/Channel rows；
- shared `InspectorSection`：Linked objects/Evidence/Work controls/Technical details；
- `InlineFeedback`：source/mutation/navigation/blocker；
- `WorkBoardFailDialog`：reason + confirm。

Technical details 初始 closed，每次 selected id 改变重置为 closed。Linked/Evidence 不保存到 localStorage。

### 9.3 Navigation adapter

在 `use-app-navigation-controller.ts` 让 Work Board target callback 返回 `WorkBoardNavigationOutcome`，
但不改变 route：

- Task：先确认 Task 可解析，再 set channel/task/view；不可解析返回 failure，不打开 workspace；
- Run：await `loadRun`，成功后 open Runs；失败返回 failure；
- Approval：set selected id + open Inbox；目标过期由 Inbox 显示；
- Channel：确认 active channel 后 select；不存在返回 failure；
- Thread：不增加 callback。

AppShell 只把 outcome callback 传入 controller。

### 9.4 Fail Dialog

- Trigger：Inspector `Mark failed` danger Button；
- reason 默认为空，必须由用户输入非空原因；
- trim 不能为空；
- confirm 调现有 fail action，`retry:false`；
- busy 禁止 dismiss；
- failure `InlineFeedback` 留 Dialog，technical message 折叠；
- success 关闭、恢复 focus、Toast 3000ms，并由 authoritative row response 更新 scope。

## 10. P11.1e Projection integration

### 10.1 Channel Work Board

- 保留 `ChannelActivityToolsPanel -> ChannelWorkBoard` 入口；
- 复用 `buildWorkItemViews`、single status、DataRow/WorkItemRow 和 scoped mutation；
- 仅 `channelId === selectedChannelId && !terminal`；
- compact Header、loading/empty、内部滚动；不显示 global scopes/filter/Inspector；
- 不建立新 store，不改变 channel tools panel/nav。

### 10.2 Private-message task creation

Regression-only assertions：

- 私聊设置不显示 Tasks/Activity；
- message create 只使用 active membership channels，且不生成 Run；
- 创建成功通过 Toast 打开精确 Work Board task；
- Work Board refresh 后能看到新任务；
- message-scoped busy/error 和 teammate identity guard 不回退。

### 10.3 Approvals/Runs/Threads

- Approvals resolve 后 Work Board refresh 投影正确；
- Run status change 只改变 Work Board derived row，不复制 Run controls；
- Runs -> Thread 路由继续工作；Board 无 Thread button；
- Inbox/Run 返回后 Work Board filter/selection 保留到当前 component 未卸载范围；重新从 Sidebar 打开使用新 intent。

## 11. P11.1f CSS, i18n and accessibility

### 11.1 CSS migration

1. 先创建 focused files 并按 page -> toolbar -> list -> inspector -> channel import；
2. 迁布局 selector；共享组件 chrome 不复制；
3. 删除 `.settings-return-mode`、`.settings-tool-mode`、`.work-board-settings-*` 死 owner；
4. 删除 `.secondary-button/.compact-button/.select-control/.status-badge` 的 Work Board visual dependence；
5. 删除三个 `#ffffff`；
6. 从 `strict-console.css` 移除 Work Board dark blanket selector；
7. `work-board.css` 最终只保留 imports；
8. 不新增 direct color、`!important`、private keyframe、`transition: all`、Theme/Profile id selector。

### 11.2 i18n

新增/替换的 visible string 同时进入 `en-US` 与 `zh-CN`。至少覆盖：

- six scopes、search/filter/sort labels；
- 10 status labels、waiting reasons、source labels；
- all empty/partial/stale/missing/navigation states；
- action labels、disabled reasons、claim blocker summaries；
- Fail Dialog、Field error、Toast；
- Guide、Inspector section titles、raw detail labels。

不得把 predicate 或 action precedence 写进 locale。

### 11.3 Accessibility and motion

- role/listbox/option/aria-selected/aria-busy/aria-live 精确；
- all icon-only actions >=32x32、tooltip/title/label；
- nested row actions stop propagation；
- Tabs/Popover/Dialog/DataRow/Inspector keyboard contract；
- focus ring 不改变尺寸，Input focus 几何 E2E；
- reduced motion：无 feature keyframe、无 row stagger/scale；
- long zh/en/id/label 和 200% browser zoom 不遮挡 action。

## 12. Focused E2E scenarios

新增 `apps/web/e2e/ui2-work-board.spec.ts`，不要把 UI2 全状态塞进当前 70 行 legacy spec。

| Case | Required assertions |
|---|---|
| initial/true empty | Skeleton -> true EmptyState；无 empty flash |
| scope matrix | six scopes predicate、group/order、history date |
| search/filter/sort | all fields、clear、priority/order、no result |
| selection | row click/Enter/Space、first select、hidden/missing、no implicit navigation |
| open intent race | same item twice、delayed load、newer user interaction wins |
| cwd/source race | old cwd/older refresh cannot publish |
| partial/stale/capped | retained rows、source issue、Retry、counts not authoritative、no fake pagination |
| evidence | closed no request、loading、empty、ready、retained stale、failure、selection race |
| status/action matrix | ten statuses、one status、one primary action |
| approval | pending opens exact Inbox；no Approve/Deny in Board |
| run/thread | exact Run opens；Board no Thread；Run retains Thread route |
| task navigation | exact channel/task；missing task stays Board with feedback |
| durable claim | claim/heartbeat/release、scoped busy、different row still active |
| claim blocker | four blocker codes、persistent inline、raw folded |
| complete/fail | mark done; fail Dialog cancel/validation/busy/failure/success |
| external route | destination select、same disabled、failure retain、success refresh |
| long list | 100+ rows、independent list/Inspector scroll、long text、no page overflow |
| guide | default closed、keyboard/open/close、reduced motion |
| secrets | fake claim token absent from visible/accessibility DOM |
| theme | Light/Dark/custom fixture、no hardcoded white/black |
| console | each case no pageerror/console error/unhandled rejection |

Legacy `work-board.spec.ts` 保留 durable merge、claim、heartbeat 与入口回归，必要时只迁 selector，不删除业务断言。

## 13. Screenshot evidence matrix

目标目录：`docs/design/ui2.0升级/evidence/features/work-board/`。2026-07-23 WB-08 已用真实 Vite source
完成以下 8/8 changed-state matrix；哈希见第 5.2 节，每张 sidecar 均为 `verification=verified`。

| File | Viewport / Theme | Required changed state |
|---|---|---|
| `1440x960-ling-light-actionable-mixed.png` | 1440x960 / ling-light | mixed groups、selected Inspector、single states/actions |
| `1280x800-ling-dark-filter-no-result.png` | 1280x800 / ling-dark | Filter Popover 或 active filter + no-result，no overflow |
| `1440x960-ling-light-approval-inspector.png` | 1440x960 / ling-light | pending approval、Handle approval、raw folded |
| `1280x800-ling-dark-retained-stale.png` | 1280x800 / ling-dark | retained rows、partial/stale InlineFeedback、Retry |
| `1440x960-ling-light-durable-fail-dialog.png` | 1440x960 / ling-light | claimed durable、Fail Dialog、scoped busy/failure |
| `1280x800-ling-dark-long-list-reduced-motion.png` | 1280x800 / ling-dark | 100+ rows、long text、independent scroll、reduced motion |
| `1440x960-ling-light-selected-missing.png` | 1440x960 / ling-light | requested/selected missing recovery |
| `1280x800-ling-dark-channel-projection.png` | 1280x800 / ling-dark | Channel Work Board bounded projection |

Metadata 必须记录：locale、theme id、viewport、fixture、URL、served artifact、console result、document overflow、
list/Inspector scroll metrics、reduced-motion、RGB dimensions、SHA-256。每张图按 original size 人工审查。

## 14. Exact verification commands

### 14.1 Static and package gates

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
```

### 14.2 Core/API/daemon regression

本切片不改这些层，但必须证明 WorkItem behavior 未漂移：

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/daemon test
```

若完整 daemon suite 受无关环境失败影响，至少先执行可复现的 focused command，并在 metadata 记录完整失败：

```bash
corepack pnpm --filter @ling-stack/core build && node --test packages/core/test/work-items.test.mjs
corepack pnpm --filter @ling-stack/daemon build && node --test packages/daemon/test/work-items-api.test.mjs
```

### 14.3 Focused Web

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-work-board.spec.ts \
  work-board.spec.ts
```

### 14.4 Selected integration regression

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  app.spec.ts \
  approvals.spec.ts \
  runtime.spec.ts \
  teammates.spec.ts \
  channel.spec.ts \
  dark-mode.spec.ts
```

没有独立 Thread E2E 文件；Thread 回归使用 `runtime.spec.ts` 中现有 Thread/Run 路径和新增 focused case。
若并行运行，为每个 Agent 指定不同端口：

```bash
LING_PLAYWRIGHT_PORT=4191 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-work-board.spec.ts work-board.spec.ts
LING_PLAYWRIGHT_PORT=4192 corepack pnpm --filter @ling-stack/web test:e2e -- approvals.spec.ts runtime.spec.ts
```

## 15. Browser acceptance

在真实 Vite 页面逐项验证：

1. `1440x960` Light：一级 Work Board -> scopes -> search/filter/sort -> select -> linked targets；
2. `1280x800` Dark：long list、Inspector 独立滚动、Popover collision、Fail Dialog；
3. reduced motion：Tabs/Popover/Dialog/disclosure 无位移或私有动画；
4. keyboard-only：完整 Tab/Arrow/Enter/Space/Esc/focus return；
5. 中文和英文：最长 scope/action/empty/disabled copy 无截断误义；
6. refresh failure：已有 rows 不消失；初始失败不伪装 empty；
7. Task/Run/Approval/Channel 精确导航和失败返回；
8. fake claim token 不出现在 accessibility snapshot；
9. `document.documentElement.scrollWidth === clientWidth`；list/Inspector 各自可滚动；
10. console/pageerror/unhandled rejection 为零。

## 16. Parallel execution and file collision plan

最多四个独立 lane，但只有依赖满足时启动：

| Lane | Work | Exclusive files | Start condition |
|---|---|---|---|
| A | source projection + durable outcome | domains/work-items/* | WB-00 complete |
| B | pure view-model + tests | work-board-view-models/types/lib split | WB-00 complete |
| C | Header/Toolbar/List/Empty/Guide | listed TSX + page/toolbar/list CSS | A/B contracts stable |
| D | Inspector/actions/Dialog/navigation | listed TSX + inspector CSS + thin navigation adapter | A/B contracts stable |

规则：

- `GlobalWorkBoardPage.tsx`、`AppShell.tsx`、`work-board.css` import manifest 只由主 Agent 最终集成；
- C/D 不同时编辑 `WorkItemRow.tsx`；Row 归 C，D 只通过 action props/view-model 接线；
- locale 由一个 owner 统一合并，避免四路重复 key；
- E2E fixture/support 由一个 owner 维护，其他 lane 只提交 scenario list；
- 任一 lane 完成后先局部测试，主 Agent 再运行组合测试和 selector/duplicate audit。

## 17. Rollback boundaries

- 无 API/DB migration，回滚以 feature/controller/focused CSS slice 为单位；
- 旧 component/CSS selector 只有在新 owner、focused E2E、截图都存在后删除；
- source projection 可单独回滚到当前 props 输入，但不得把 incomplete selected-channel 数据标为 verified；
- open-intent adapter 可恢复旧 state props，不影响 route；
- fail Dialog 回滚时不得恢复无确认的 destructive action；应保持功能 disabled 并报告 blocker；
- 不使用 git destructive operation 处理回滚。

## 18. Hard stops

遇到以下情况停止对应子切片并报告，不自行改业务：

1. 需要新增/修改 daemon API、contract、DB 或状态机才能达到已约定行为；
2. 产品要求 Board 内直接 Approve/Deny、Run Retry/Cancel 或 Thread resume；
3. 产品要求 generic manual/durable route，但现有 Web 只接 external work route；
4. 产品要求 artifact preview/download，但没有批准目标 surface/安全策略；
5. claim owner 身份必须从 `web-user` 改为真实用户 id；这属于认证/审计决策；
6. 旧测试要求保留 global error、selected-channel 假全量或无确认 Mark failed；
7. source partial failure 无法从当前 Web domain outcome 区分，且必须改变 API response 才能修复；
8. packaged macOS/Windows 不可用只阻塞 P13 Desktop evidence，不阻塞 P11 Web verified。

当前审计没有发现 1-7 的即时 blocker：workspace aggregate read、mutation、navigation均可用现有 Web/API能力实现。
现有 list API 无 cursor/total 是已记录的能力边界，不阻塞 capped UI2 closeout，但阻塞任何“无界历史完整”声明。

## 19. Closeout procedure

全部代码与 browser gate 通过后，production slice 才能更新非本任务允许范围内的：

- `01-全产品覆盖矩阵.md`：登记六个 BOARD ID 并机械更新状态；
- `04-E2E与截图矩阵.md`；
- `05-完成状态看板.md`；
- `migration/03`、`06`、`07`、`09`、`10`；
- `README.md`、总控和 evidence metadata。

本轮全局 owner 已登记 6 个 BOARD Function ID、9 张 verified evidence 与 raw technical disclosure
折叠结果。账本见 [Work Board evidence metadata](../evidence/features/work-board/metadata.md)。

## 20. Definition of done

- 合同六个 Function ID 全部有真实 trigger、all reachable states、focused E2E 和原尺寸 evidence；
- global source 是 workspace projection，不依赖 selected channel；
- Work Board 是完整协调 owner；私聊消息创建入口和 Channel Board 不建立第二份任务管理页面，且无 auto-run；
- DataRow/Status/Inspector/Button/Input/Select/Popover/Dialog/Feedback 全部消费 UI2 shared primitives；
- 一个主状态、一个主行动、scoped busy、retained stale、竞态和 feedback 生命周期全部通过；
- raw diagnostics 默认折叠且绝不暴露 claim token/secret；
- two viewports、Light/Dark/custom fixture、zh/en、keyboard、reduced motion、overflow/scroll/console 全通过；
- production file `<800`，新增 owner `<400`，focused CSS 每个 `<400`；
- exact static/core/API/daemon/focused/selected commands 通过，或任何外部失败被准确记录且不冒充通过；
- API、contracts、DB、routes、state machine、Logo 均无变化。
