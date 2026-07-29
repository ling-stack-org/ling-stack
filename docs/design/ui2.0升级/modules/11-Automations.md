# Automations UI 2.0

Status: `Web verified / packaged Desktop partial`。本文件冻结 P9.3 的产品与交互合同；对应代码实施、迁移和证据要求见
`11-Automations-implementation-plan.md`。

## 1. 页面目标

Automations 是本地工作区的自动执行管理面。用户必须能在默认层快速回答四个问题：

1. 哪些自动化正在生效；
2. 下一次何时运行、作用到哪里；
3. 最近一次运行是否成功；
4. 失败后下一步应该做什么。

它不是 scheduler 诊断控制台。RRULE、context selector、rendered prompt、idempotency key、raw event 和
provider payload 默认折叠到 Inspector 详情。

## 2. Function IDs

- `AUTO-LIST-001`：搜索、筛选、列表、选择、空态和长列表滚动。
- `AUTO-STATUS-001`：定义状态、调度状态、最近运行和单一 primary state。
- `AUTO-CREATE-001`：模板、手动、从对话描述创建，以及 draft confirmation。
- `AUTO-SCHEDULE-001`：manual、interval、daily、weekly、scheduler start/stop。
- `AUTO-TARGET-001`：workspace、channel、conversation 和真实目标缺失状态。
- `AUTO-RUN-001`：立即运行、最近运行、打开 Run/Thread 和 scoped busy。
- `AUTO-INSPECT-001`：摘要、失败原因、修复路径、context preview 和 raw details。

## 3. Shell 与入口

入口保持 AppShell `Automations` ViewId，不新增路由或 Settings section。页面使用：

```text
PageShell
  PageHeader
    Automations
    Refresh IconButton
    Add automation Button
  SchedulerSummary
  PageToolbar
    Search Input
    Status Tabs
  PageContent
    AutomationList
    AutomationInspector
  Overlay layer
    Create Dialog
    Archive Dialog
    Schedule Dialog/Popover
```

Header 只保留一个主行动 `Add automation`。模板、手动和“从对话描述”进入同一 Create Dialog 的模式选择，
不在 Header 平铺三个同权按钮。

## 4. 页面布局

- Header 高度与其他工程页面一致，不使用营销式标题或说明墙。
- SchedulerSummary 是一条中性摘要，只显示 `Running / Stopped`、已启用 schedule 数量和下一次运行；没有
  scheduled automation 时只显示一句紧凑状态。
- 主区使用 `minmax(0, 1fr) minmax(320px, 360px)`。Inspector 是唯一右侧详情 owner。
- `1280x800` 下 Inspector 可收敛到 `Drawer`，列表保持最小可读宽度，不产生根横向滚动。
- 列表和 Inspector 分别拥有内部滚动；页面根不承担长列表滚动。

## 5. Toolbar 与筛选

- Search 检索 title、description、channel、conversation title 和 schedule 摘要。
- Tabs 固定为 `Enabled / Paused / Needs attention / Recent runs`；成功历史不单独占长期主 Tab。
- Tab count 只显示真实数量；0 可以省略，不使用彩色 count chip。
- Refresh 是 icon-only，busy 只作用于 Refresh；保留旧数据时显示 stale InlineFeedback。
- Clear search 使用 Input suffix IconButton，`Escape` 清空并保持焦点。

## 6. Automation Row

每行固定四个信息区：

```text
Identity | Target + schedule | Primary state | Actions
```

- Identity：title 为主；manual/heartbeat 等模式只在确有区分价值时作为一行紧凑副信息。
- Target：显示 workspace、`#channel` 或 conversation title；不存在的目标显示 `Target unavailable`。
- Schedule：manual、interval、daily、weekly 使用产品化摘要，不在默认层显示 RRULE。
- Primary state 每行只能有一个，优先级：
  `target missing > recent failure > definition error > paused > running > scheduled > ready`。
- 状态使用 `StatusIndicator`，不叠加 definition badge、run badge 和 scheduler badge。
- 行可用 Enter/Space 选择；内部 action 不触发行选择。

### 6.1 行内行动

- failure：`Inspect failure`；
- paused：`Resume`；
- enabled/manual：`Run now`；
- enabled/scheduled：`Run now` 仍可用，schedule 编辑进入 secondary action；
- running：主行动禁用并显示 scoped Spinner；
- target missing：`Fix target` 打开 Inspector 的 Target section。

常用 `Run / Pause-Resume / Edit schedule / Open thread` 行内可达。`Archive` 进入 More Menu，并使用共享
confirmation Dialog。后端只有 archive 时，界面不得写“Delete”。

## 7. Scheduler Summary

- scheduler stopped 且存在 enabled scheduled definitions：warning，主行动 `Start scheduler`；
- scheduler running：neutral/success dot，次级 `Stop scheduler`；
- 没有 scheduled definitions：显示 `No scheduled automations`，不显示无意义的 Start；
- start/stop busy 只锁 SchedulerSummary，不锁列表、Refresh 或 Create；
- start/stop 失败保留 InlineFeedback 和 Retry；成功使用短暂 Toast。

## 8. Create Dialog

Create Dialog 使用共享 `Dialog`、`Tabs/SegmentedControl`、`Field`、`Input/Textarea/Select`、`Button` 和
`InlineFeedback`。不保留手写 backdrop、document Escape listener 或 body overflow owner。

### 8.1 模板模式

- 显示服务端真实 templates；本地额外 template 只有已登记产品来源时才保留。
- 每行显示 title、用途、默认 target/schedule 摘要和 `Use template`。
- 选择模板后进入同一表单复核，不直接静默创建。

### 8.2 手动模式

默认字段：

- Name；
- Prompt；
- Target；
- Schedule；
- Model。

Advanced 默认折叠：runtime、reasoning、artifact output、custom RRULE 和 context preview。用户不能绕过现有
保存校验；模型只列出真实 chat-capable provider。

### 8.3 从对话描述

- 输入自然语言 request 后创建 draft，不冒充自动化已经启用；
- draft 行必须显示 `Draft / Ready for confirmation / Invalid` 单一状态；
- confirmation 前展示解析后的 name、target、schedule、prompt 和 model；
- invalid draft 保留原输入和字段错误；Confirm scoped busy，失败不关闭 Dialog/Inspector。

## 9. Schedule 与 Target

- manual 不显示时间字段；
- interval 使用正数 stepper/input，单位明确为 minutes；
- daily 显示 time + timezone；
- weekly 显示 weekday + time + timezone；
- custom RRULE 只在 Advanced 中提供，必须有格式错误和产品摘要；
- workspace、channel、conversation 只显示真实可用项；archived/missing target 不作为可选项；
- 已有 automation 的 target 后续失效时保留定义并进入 `Target unavailable`，不静默改到 workspace。

## 10. Inspector

Inspector 使用以下 section：

1. `Overview`：title、primary state、target、schedule、model；
2. `Latest run`：time、status、duration、Open run；
3. `Failure and repair`：产品原因、下一行动、Retry/Open provider/Open target；
4. `Context preview`：来源数量和可读摘要；
5. `Output`：打开 automation thread/artifact；
6. `Technical details`：RRULE、raw IDs、rendered prompt、event/output payload，默认折叠。

没有选择对象时显示紧凑 EmptyState。切换行不得清空整个 Inspector 后再闪入；loading skeleton 只覆盖变化 section。

## 11. Feedback 与错误

- create/confirm/archive/start/stop/run success：全局 Toast，自动消失；
- 字段校验：Field error；
- 对象 mutation failure：对应 row 或 Dialog/Inspector InlineFeedback；
- refresh failure：保留列表，页面级 stale InlineFeedback；
- run failure：持久显示到下一次成功或用户检查，不使用自动消失 Toast；
- 不显示 raw daemon/provider message 作为主文案，raw response 进入 Technical details。

## 12. Busy、竞态与中断

- refresh、row mutation、draft mutation、scheduler action、create 分开建模；
- 一行 mutation 不得让所有行或 Header spinning；
- cwd 或 selected object 改变后，旧请求不得写入新对象；
- duplicate Run/Confirm/Archive 在 busy 时被阻止；
- Dialog busy 时禁止 outside/Escape dismiss，失败后恢复关闭能力；
- 15 秒 runtime refresh 不覆盖用户正在编辑的 draft/form。

## 13. 可达状态

验收必须逐项覆盖：

- page loading、empty、loaded、stale、refresh error；
- search no-result、四个 Tabs、100 definitions internal scroll；
- enabled manual、enabled scheduled、paused、running、recent success、recent failure、definition error；
- scheduler absent/running/stopped/loading/failure；
- target workspace/channel/conversation/missing/archived；
- template success/empty/error；
- manual invalid/saving/failure/success；
- chat draft parsing/ready/invalid/confirming/failure/success/discard confirmation；
- Inspector empty/loading/summary/failure/context/raw details；
- archive cancel/confirm/failure；
- Light/Dark、zh-CN/en-US、keyboard、reduced motion。

## 14. Component Mapping

| Current | UI 2.0 owner |
|---|---|
| raw PageActionHeader buttons | Button / IconButton |
| raw automation tab buttons | Tabs |
| StatusBadge/status-dot stack | one StatusIndicator |
| StatusActionRow compatibility facade | DataRow |
| hand-written AutomationModal | Dialog |
| hand-written popover button/list | Popover/Menu/Select |
| raw labels/inputs/textarea | Field/Input/Textarea/Select |
| automation-history-lite | InspectorSection / Drawer |
| OperationEmptyState | EmptyState |
| page/global error message | Toast or scoped InlineFeedback |

Feature CSS 只拥有页面 grid、列表列宽、scroll boundary 和领域内容 geometry，不覆盖 `.ling-ui-*` 内部结构。

## 15. Light、Dark 与 Desktop

- 只使用 semantic tokens；状态色只用于真实 warning/danger/success dot。
- imported Theme Pack 不改变列表密度、媒体或状态语义。
- Desktop renderer 复用 Web 页面和共享组件，不复制 automation CSS。
- Windows 125%/150% DPI、forced colors 和 macOS Retina 属于 P13 发布证据；Web 截图不能冒充完成。

## 16. i18n 与 Accessibility

- 所有 visible copy、Tooltip、Dialog title、status、disabled reason 使用共享 i18n owner；
- icon-only action 必须有 `aria-label`、title/Tooltip 和至少 32px hit area；
- Tabs、Menu、Dialog、Popover 使用 Radix 语义和 focus return；
- 行选择支持 Enter/Space；Escape 分层关闭当前 overlay；
- error/status 不只依赖颜色；时间、weekday、timezone 中英文可读。

## 17. 禁止改变

- 不改 daemon API、contracts、数据库、trigger/target/output schema、scheduler 或 run state machine；
- 不新增 ViewId、SettingsSectionId 或自动化路由；
- 不把 archive 改造成未存在的永久删除；
- 不自动启用 chat draft，不自动启动 scheduler；
- 不删除 audit run/thread/context history；
- 不因 UI 迁移修改执行权限、provider selection 或 artifact output 语义。

## 18. 验收

- focused E2E 覆盖七个 Function ID 和全部可达状态；
- `automations.spec.ts`、相关 `app.spec.ts`、`dark-mode.spec.ts` 全绿；
- typecheck、i18n、UI2 lint、diff check 通过；
- `1440x960` Light、`1280x800` Dark 原尺寸截图、console/overflow/keyboard/reduced-motion 通过；
- evidence metadata 包含 URL、fixture、locale、theme、viewport、SHA-256 和未验证 Desktop 边界；
- 七个 Function ID 在代码、测试和截图全部闭环前最多标记 `implemented`。

## 19. P9.3 Closeout - 2026-07-22

- 页面已拆为 controller、纯 view-model、Header、Scheduler、List/Row、Create/Schedule/Archive Dialog 和
  Inspector owners；`AutomationsPage.tsx` 为 279 行，所有 production owner 低于 800 行。
- 旧 718 行 `AutomationCreateDialogs.tsx` 和 `AutomationSchedulerStrip.tsx` 已删除；`automations.css`
  收敛为 5 行 import manifest，五个 focused CSS owner 均低于 220 行。
- shared Input/Tabs/Dialog/Field/Select/Button/Menu/Inspector/Feedback 已接入；API、schema、scheduler、run、
  draft、target 和 archive 语义未改变。
- focused + legacy Automations `7/7`、selected App/Runtime/Settings/Dark `57/57` 通过；六张 Light/Dark、
  `1440x960`/`1280x800` 原尺寸 evidence 已检查并登记 SHA-256。
- 七个 `AUTO-*` Web Function ID 已达到 `verified`；imported Theme Pack 和 packaged macOS/Windows 证据仍在
  全局 Theme/Desktop release gate，不由本 Web closeout 代替。

证据见 [Automations metadata](../evidence/features/automations/metadata.md)。
