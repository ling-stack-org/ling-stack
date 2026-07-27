# Runs 与 Threads UI 2.0 零决策合同

## 1. Status And Authority

Status：`verified on Web / packaged acceptance deferred to P13`。本合同覆盖主应用 `Runs` 与 `Threads` 两个 View、它们的
列表、详情、时间线、证据、干预、恢复/分叉、归档和 Skill recording overlay。

Settings > Startup and diagnostics 已在 P7B.4 verified，只是精简诊断入口和主 Runs 导航 adapter；本切片
不得重建该 Settings 页面，也不得把主 Runs 的完整能力复制进 Settings。

发生冲突时优先级如下：

1. daemon API、contracts、持久化、审计历史、run/thread 状态机和权限证据不变；
2. 既有 `runtime.spec.ts` 的行为合同不变；
3. 本文决定 UI 2.0 组件、布局、状态表达、反馈、动效、CSS owner 和验证方式；
4. 无权威字段时显示未知或不可用，不从事件文本猜测成功、取消或 provenance。

实施计划见 [Runs 与 Threads implementation plan](15-Runs与Threads-implementation-plan.md)。

## 2. Product Goal

Runs/Threads 是本地工作空间的执行历史和审计面，不是默认展开的诊断控制台。用户默认层必须快速回答：

1. 这次工作是什么、属于哪个 thread/turn；
2. 当前或最终状态是什么；
3. 是否需要审批、修复或停止；
4. 产物和下一步在哪里。

事件 payload、租约、provider/raw response、runner resolution、shell snapshot、permission snapshot 和内部
transition 默认折叠。完整审计能力必须保留，不能为了页面简洁删除数据或隐藏唯一修复路径。

## 3. Function IDs

全局矩阵继续使用四个 closeout ID，避免把同一页面拆成无法独立验收的伪功能：

| Function ID | Includes | Completion owner |
|---|---|---|
| `RUN-HISTORY-001` | thread-first history、search/filter、turn attempt grouping、legacy fallback、selection、long list | Runs list + history controller |
| `RUN-DETAIL-001` | summary、Timeline、Approvals、Artifacts、Evidence、permission/runtime audit、recording、raw details | Run detail shell + focused sections |
| `RUN-INTERVENTION-001` | stop、rerun、guidance create/cancel/promote、provider/task repair、scoped busy | intervention controller + owned feedback |
| `THREAD-LIST-001` | Threads list、parent/child lineage、resume preview/resume、fork/fork-run、pin/archive/unarchive | Thread list/detail controller |

Settings 永久删除仍由 Archived Items 的已验证合同拥有。主 Threads 页面只做 archive/unarchive，不增加第二个
hard-delete 入口。Skill recording、Timeline、diagnostics 和 thread archive 是上述四项的子能力，不另增未登记
的全局 Function ID。

## 4. Entry And Shell Ownership

现有 View 与上下文入口保持：

```text
AppShell
  ViewId=runs    -> RunHistory
  ViewId=threads -> ThreadPage

Current visible IA
  Settings > Startup and diagnostics -> Runs
  Automation definition / execution context -> Threads

Settings > Startup and diagnostics
  -> SettingsRunDiagnosticsPanel
  -> explicit Open Run Diagnostics
  -> ViewId=runs + selected run
```

- 不新增 ViewId、路由或 Settings section。
- 当前 Sidebar primary navigation 没有全局 `Threads` 按钮；focused 验收必须沿现有对象上下文入口进入，不得为测试发明新 IA。
- 从 Automation、Task、Approval、Conversation、Teammate Activity 打开 Run 时，保持目标 `runId` 精确选择。
- 从 archived/settings 返回必须遵守 AppShell 既有 exact-return 合同。
- Runs 与 Threads 共享 presentation primitives 和纯投影，但不创建第二套 domain store。

## 5. Data And State Ownership

### 5.1 Existing domain owner

`use-runs-domain.ts` 继续拥有 run list、selected run、events、artifacts、leases、state transitions、work-unit
detail、approvals adapter 和 run mutation。Feature 不复制这些请求或把 domain data 写入 localStorage。

### 5.2 Thread feature controller

focused controller 负责：

- `listLingThreads`、thread search、archive filter、selected thread；
- turn/run link load、legacy 404 fallback、request identity 和 retained stale；
- thread evidence、resume preview、fork/fork-run、pin/archive mutation；
- per-operation busy、overlay state、focus return 和 product feedback；
- cwd、thread、run 切换后的 stale response guard。

### 5.3 Pure projections

纯 view-model 派生：

- thread-first Work History group tree、attempt count、latest attempt 和 lineage；
- run/thread `primaryState`、`primaryAction`、disabled reason；
- readable target、permission、provider、artifact、memory 和 failure summary；
- search/filter result、empty/no-result、stale 和 detail section visibility。

JSX 不重新判断状态优先级，不从 raw event message 推断业务状态。

## 6. Standard Page Geometry

```text
PageShell
  PageHeader
    Work history / Threads
    Refresh IconButton
  PageToolbar
    Search Input
    Status / archived filters
  PageContent
    HistoryList       minmax(320px, 38%)
    DetailWorkspace   minmax(0, 1fr)
      SummaryHeader
      DetailTabs / sections
  Overlay layer
    Resume/Fork confirm when required
    Skill recording Dialog
```

- `1440x960` 使用双列；列表与详情各自拥有内部滚动。
- `1280x800` 仍保持双列，但列表收敛到 320-360px，详情 `min-width:0`。
- Electron 最小窗口若不足以保持 320px + 可读详情，Detail 使用 Drawer；不得缩小固定字体或产生根横向滚动。
- 不使用卡片墙；列表行和 InspectorSection 是主要信息结构。

## 7. RUN-HISTORY-001

### 7.1 Default list

- 默认使用 thread/turn 分组，不把每次 retry 平铺成无上下文 run wall。
- Identity：thread/turn title；副行只显示必要 objective/attempt summary。
- Status：每组一个主状态；attempt count、pin 和 archive 不叠加为彩色 badge。
- Meta：更新时间和必要 target；raw thread/run IDs 默认不显示。
- 选择行支持 pointer、Enter 和 Space；内部 action 不触发行选择。

### 7.2 Search and filters

- Search 覆盖 thread title、objective、turn title、run title 和后端返回的权威 search match。
- `Escape` 清空并保持焦点；无结果显示紧凑 EmptyState + Clear。
- archived filter 保留 `exclude/include/only` 现有语义，不将 archived row 混入默认列表。
- refresh 失败保留上一批 rows 并显示 stale InlineFeedback + Retry；首次加载失败才使用 full empty/error owner。

### 7.3 Fallback

`GET /threads` 返回 404 时保留现有 run-derived legacy fallback，并明确为兼容视图；其他失败不得静默切换
fallback。fallback 不伪造 parent/turn/evidence 字段。

## 8. THREAD-LIST-001

### 8.1 Thread list and lineage

- Threads View 使用相同 List primitive，不保留第二套 raw button/status-dot 视觉。
- parent、child、fork 和 durable turn attempt 使用层级/lineage summary，不靠缩进制造无限宽度。
- archived/pinned 是对象属性；主状态仍来自 thread 权威状态。
- 100 rows 由内部 scroll owner 承担，长 title/objective 截断并可通过详情读取完整内容。

### 8.2 Thread actions

| State | Primary action | Secondary actions | Rules |
|---|---|---|---|
| active work exists | none / Open active run | Pin, view evidence | Resume/Fork-run disabled with product reason |
| resumable terminal thread | Resume | Preview, Fork, Fork and run, Pin, Archive | Preview failure keeps draft and action |
| archived | Unarchive | view evidence | no Resume until authoritative unarchive succeeds |
| pinned | context action unchanged | Unpin | pin does not alter run/thread state |
| legacy fallback | Open run when known | none unsupported | no fake resume/fork/archive if thread API is absent |

- Archive/Unarchive、Pin/Unpin、Resume、Fork、Fork and run 使用独立 busy key。
- mutation 成功后读取权威 thread/list；列表刷新失败时保留 mutation 结果的对象级状态并标 stale。
- active run、non-terminal source turn、missing cwd/source run 等 disabled reason 必须可读。

## 9. RUN-DETAIL-001

### 9.1 Summary header

默认只显示 title、单一状态、target/workspace、开始/更新时间、duration 和当前主行动。Stop、Rerun、Refresh
按真实状态派生；不存在 provider preset 时 Rerun disabled 并给 Model Workbench repair。

Run 状态产品优先级固定为：

```text
failed/cancelled > waiting approval/blocked > stopping > running > queued > succeeded > unknown
```

仅从权威 run/approval/work-unit 字段映射；颜色只辅助，不代替文字。

### 9.2 Detail sections

建议顺序：

1. `Overview`：task、provider/model、permission summary、thread/turn/attempt；
2. `Activity`：产品化 Timeline，running 时可跟随最新；
3. `Approvals`：pending 优先展开，决定和权限后果持续可见；
4. `Artifacts and changes`：artifact、workspace change、undo/reapply 状态；
5. `Evidence`：memory、files、browser、terminal、shell snapshot；
6. `Intervention`：guidance、cancel/promote 和失败；
7. `Technical details`：raw events、leases、state transitions、snapshots、runner audit，默认折叠。

空 section 不铺空卡；使用一行 empty state 或不渲染 launcher。打开深层 section 不改变外层列表选择。

### 9.3 Timeline and raw events

- Timeline 使用可读 activity projection，不直接把 event name/payload 当主文案。
- running 自动跟随只在用户仍位于底部时生效；用户向上阅读后不强制跳底。
- raw events 默认折叠，长 payload 在内部 code scroll owner；debug event 数量不能撑宽页面。
- state transition、tool start/result、artifact 和 approval 关联保持现有审计顺序。

### 9.4 Artifacts and recording

- Artifact 行显示 name/type/availability 和真实 action；不可用时保留原因。
- `Record as skill candidate` 先执行现有 eligibility，再打开 shared Dialog；不能把当前非模态伪 dialog
  继续当 UI 2.0 overlay。
- recording Field errors 靠近字段；duplicate、blocked、created 结果保持可读。成功 Toast 不替代结果 owner。
- raw runId/artifact refs 进入 Technical details，默认表单只显示任务所需字段。

## 10. RUN-INTERVENTION-001

- Stop 只对可停止状态可用；点击后只锁 Stop，状态显示 Stopping，等待 daemon 权威结果。
- Rerun 保留既有 permission/provider/task semantics，不因 UI2 自动改变 preset 或 full-access。
- Guidance create、cancel、promote 分别拥有 busy key；一条 intervention 失败不锁其他 intervention。
- 失败主文案产品化，raw daemon text 放 Details；输入失败后保留 draft。
- provider failure 指向 Model Workbench；可编辑 task 指向现有 task owner；审批阻塞指向 Approval owner。
- 不用 Toast 宣布 run 成功/取消；durable run state 是完成事实。

### 10.1 T13-O.26 Row Productization Closeout

- `RunInterventionRow` 是 intervention 的唯一产品化行结构；Run Guidance 使用 actionable 模式，Thread Evidence
  使用 read-only 模式，不在只读审计面复制 Cancel/Start handling。
- Header 固定为产品化 mode + 单一可见状态文字；queued/info、stopping/warning、starting/info、started/success、
  failed/danger、cancelled/neutral，不再复用通用 run tone。
- instruction 独占正文区。超过 260 字符默认三行，Show details 展开后最多 240px 内部滚动；requested actor、
  created/updated、continuation 和 failure reason 在 details 中渐进展示。
- cancel/promote 继续按 intervention ID 各自 busy/error；Thread loading 只投影 `aria-busy`/Spinner，不改变请求聚合。
- focused ordinary/capture `3/3`、selected `36/36`、broad `48/48` 和三张原尺寸 Light/Dark/Quiet Ocean 证据通过。
- 本切片不修改 API、contracts、数据库、状态机、全局 DataRow、Input/Textarea 或 packaged Desktop。

## 11. Feedback, Races And Refresh

| Event | Owner | Lifetime |
|---|---|---|
| list refresh failure with data | list toolbar InlineFeedback | persistent until retry/success/cwd change |
| initial list/detail failure | current list/detail owner | persistent |
| run/thread mutation failure | trigger row, Dialog or detail section | persistent with retry when safe |
| lightweight pin/archive success | global Toast | auto dismiss |
| run failed / approval blocked | detail primary state + repair | durable, never toast-only |
| recording validation/result | Field/Dialog result | until corrected/closed |

每个请求携带 cwd + threadId/runId identity；迟到 response 不得覆盖新 workspace/selection。刷新 selected detail 时保留
旧 summary 并局部 skeleton/stale，不先清空整页。重复 Stop/Rerun/Resume/Fork/Submit 在 busy 时被阻止。

## 12. Overlays, Focus And Motion

- Skill recording 使用 shared Dialog；Cancel 初始焦点，busy 时阻止 outside/Escape dismiss，关闭恢复 trigger。
- destructive 或会创建新执行的二次确认只在现有业务合同要求时使用 Dialog，不新增确认疲劳。
- Menu/Tooltip/Dialog 由 shared Radix owner；Feature 不添加 document Escape/outside listener。
- InspectorSection、Drawer、Dialog 使用 UI2 Motion tokens；快速开关可反向，drag/scroll 期间不做 layout transition。
- reduced motion 下保留状态变化但 duration 为 0。

## 13. Theme, Desktop, I18n And Accessibility

- 只使用 semantic tokens；状态色只用于真实状态。
- imported Theme Pack 不改变 run 状态、列表密度、artifact 像素或 code contrast minimum。
- Web 验收 `1440x960`、`1280x800`；packaged macOS Retina、Windows 125%/150%、forced colors 进入 P13。
- visible copy、Tooltip、disabled reason、状态和 Dialog 文案全部来自共享 i18n。
- icon-only action 至少 32px，具有 aria-label/Tooltip；DataRow、Tabs、Menu、Dialog、InspectorSection 键盘可达。
- error/status 不只依赖颜色；时间和 duration 使用统一 formatter。

## 14. Current Architecture And Required Extraction

当前生产实施基线（2026-07-23）：

| File | Current lines | Required action |
|---|---:|---|
| `RunHistory.tsx` | 182 | composition owner 已拆分，继续禁止回流 thread request/detail/intervention 大段行为 |
| `ThreadPage.tsx` | 66 | 共享 controller/list/detail composition 已实施 |
| `RunInspector.tsx` | 60 | focused inspector/recording trigger 已实施 |
| `RunTimeline.tsx` | 89 | focused Timeline 已实施 |
| `RunGuidancePanel.tsx` | 63 | composition-only；actionable row props 从既有 controller 派生 |
| `RunInterventionRow.tsx` | 113 | actionable/read-only 纯展示 owner；不得接 API 或请求状态机 |
| `run-intervention-view-models.ts` | 15 | 六种权威状态的纯 tone 映射 |
| `ThreadEvidenceSection.tsx` | 43 | read-only intervention consumer；不持有 mutation callback |
| `SkillRecordingReviewSheet.tsx` | 1 | compatibility re-export；recording Dialog 已迁 focused owner |
| `runs/intervention-row.css` | 126 | focused row/details/scroll/action geometry；禁止共享 control repaint |
| `runs.css` | 10 | import-only manifest 已实施 |
| `runtime.spec.ts` | 1,533 | 保留业务回归；UI2 changed states 进入新 focused spec |

当前 Runs/Threads production 文件均低于 400 行。API/client/domain/types 不迁入 presentation 文件。

## 15. Component And CSS Mapping

| Legacy | Target |
|---|---|
| `.panel/.panel-title` page chrome | PageHeader + focused page shell |
| raw run/thread row buttons | DataRow + StatusIndicator |
| raw input/textarea/SelectControl form | Field + Input/Textarea/Select |
| raw status-dot + StatusBadge stack | one StatusIndicator |
| native details disclosure | InspectorSection where interactive semantics require it |
| non-modal `role=dialog` recording sheet | shared Dialog |
| raw primary/secondary/icon buttons | Button/IconButton/Menu |
| inline-error/success variants | InlineFeedback + global Toast adapter |
| page-level loading text | Skeleton/EmptyState/Spinner |

focused CSS 只拥有 grid、column width、scroll boundary、timeline/evidence geometry 和 code wrapping；不得选择
package-private `.ling-ui-*` descendant，不得写颜色字面量、`!important`、`transition:all`、Theme Pack ID selector
或私有 motion duration。

P11.2 模块切片原先只登记 `components.css`、`strict-console.css`、`workspace.css` 与 `styles.css` 的重复 owner；
U13 主线现已完成集中收口。Timeline/raw events 分别由 `runs/timeline.css` 和 `runs/event-log.css` 拥有，
Runtime summary 回到 Channel focused owner，共享 Artifact 行由 `styles/shared/artifact-row.css` 拥有。

## 16. Verification And Evidence

新增 `apps/web/e2e/ui2-runs-threads.spec.ts`，覆盖四个 Function ID 的 changed states；保留
`runtime.spec.ts` 作为业务回归。最低截图：

```text
1440x960-ling-light-history-thread-groups.png
1280x800-ling-dark-history-stale.png
1440x960-ling-light-run-running-approval.png
1280x800-ling-dark-run-failure-repair.png
1440x960-ling-light-thread-lineage-resume.png
1280x800-ling-dark-thread-active-run-disabled.png
1440x960-ling-light-recording-validation.png
1280x800-ling-dark-technical-details-long.png
```

每张截图前检查 console/page error、document/list/detail horizontal overflow、内部 scroll owner、主题和 focus。
metadata 记录 branch/HEAD、Vite URL、fixture、locale、viewport、Theme Pack、SHA-256、测试结果和 Desktop 缺口。

2026-07-23 Web 验证结果：

- focused `ui2-runs-threads.spec.ts` 在独立端口 `42919`、`workers=1` 下 `7/7` passed；
- `runtime.spec.ts` 在独立端口 `42920`、`workers=1` 下单次 `19/19` passed；
- AppShell + Dark selected 在独立端口 `42921`、`workers=1` 下 `3/3` passed；补充全量 App + Dark 曾 `21/21` passed；
- lint 与 i18n audit passed；全局 typecheck 当前仅被禁止范围 `WorkBoardInspector.tsx:78` 的共享脏树错误阻断；
- 8 张 PNG 均为原始 `1440x960` / `1280x800`，SHA-256 与原图字节一致，原图检查 `8/8` passed；
- retained stale 和 guidance draft 两个场景各有一次故意注入的 HTTP 503，已在 metadata 中单列，其余 console/page errors 为 0。

证据总账见 [Runs/Threads metadata](../evidence/features/runs-threads/metadata.json)。

## 17. Hard Stops

- 不改 run/thread API、contracts、数据库、retention、state machine、permission snapshot 或 audit history。
- 不把 Settings Diagnostics 扩成第二个主 Runs 页面。
- 不在主 Threads 页面增加永久删除；永久删除继续归 Archived Items。
- 不把 run cancel/rerun、thread resume/fork 或 intervention 伪造成前端成功。
- 不根据 raw 文本猜 provider、approval、artifact 或 provenance。
- 不继续扩大 `RunHistory.tsx`、`runs.css` 或 `runtime.spec.ts`。
- 不直接 import Radix，不新增全局 overlay/Toast owner，不覆盖共享组件内部 class。
- 未完成真实双主题、双 viewport、changed-state 和 metadata 前，四个 Function ID 最多标记 `implemented`。

## 18. Deferred Global Selector Cleanup

U13 主线收口结果：

- `components.css`、`strict-console.css`、`workspace.css` 的 Runs/Threads/Timeline/raw-event/Artifact 目标 selector
  命中归零；测试兼容 class 仍可保留在 JSX，但不再被聚合层上色；
- `runs.css` 保持 8 行 import-only manifest，新增 123 行 `event-log.css`，`timeline.css` 保持 154 行；
- 共享 Artifact owner 通过 Runs、Approvals、External Work 三类消费者回归；
- focused `7/7`、Runtime + focused `26/26`、Artifact consumers `19/19` 通过，未改 API/domain 行为。
