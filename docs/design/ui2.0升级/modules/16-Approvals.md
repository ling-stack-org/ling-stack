# Approvals UI 2.0 零决策合同

## 1. Status And Authority

Status：`verified (Web) / packaged Desktop pending`。本合同覆盖主应用 Inbox/Approvals、run-scoped repair view、
Approval Card、权限变化、external action audit 和会话内 Inline Approval Strip。

2026-07-23 Web closeout 已完成：focused `9/9`、legacy Approvals `2/2`、精确 external-work selected
`5/5`，并以 `workers=1` 和三个独立 Vite 端口串行验证。8 张原始 viewport PNG 已逐张核对尺寸、
SHA-256、主题、overlay、滚动边界和视觉叠层，账本见
[Approvals evidence metadata](../evidence/features/approvals/metadata.md)。

本状态不代表 imported Theme Pack 或 packaged Electron macOS/Windows 已验收。U13 已完成
`components.css` / `strict-console.css` / `workspace.css` 的旧 Approvals selector 清理；Inbox owner 留在
`styles/approvals/*`，Channel approval detail owner 留在 `channel-overlays.css`。

Review Queue 与 Approval 是不同语义：Review Queue 可以包含 route、repair、execute approved action 和
offline/local review；只有真实 `ApprovalRequest` 的 pending decision 才显示 Approve/Deny。UI2 不得把所有
Review 项伪装成审批。

业务权威顺序：daemon/contracts/API 和现有 `useApprovalsDomain` > 已有 E2E 行为 > 本文的布局、组件、
反馈和验证合同。实施计划见 [Approvals implementation plan](16-Approvals-implementation-plan.md)。

## 2. Product Goal

用户必须在默认层理解：请求做什么、谁/哪个运行拥有它、风险和权限变化、何时过期、批准或拒绝的后果，
以及解决后接下来能做什么。raw payload、tool ID、policy snapshot、artifact refs、external action payload 和
内部路由信息默认折叠。

决定完成后以对象 durable status 为事实；Toast 只能补充轻量成功，不能代替 approved/denied/expired 状态。

## 3. Function IDs

全局矩阵保持两个 closeout ID：

| Function ID | Includes |
|---|---|
| `APPROVAL-LIST-001` | Inbox Review Queue、run-scoped list、筛选/选择、Card summary、permission delta、expired/cancelled、Inline Strip、empty/stale |
| `APPROVAL-DECIDE-001` | Approve/Deny、high-risk reason/confirmation、external action execute/cancel、route/repair actions、busy/failure/authority refresh |

模块原先的 Card/Delta/Expire/Inline 均为这两个 closeout ID 的子能力，不另增未登记全局 ID。

## 4. Existing Entry And Data Ownership

```text
AppShell ViewId=approvals
  -> ApprovalsPage
     -> ReviewQueueLayout or run-scoped Approval list
     -> ApprovalCard

Conversation/Run
  -> InlineApprovalStrip / ApprovalCard compact
  -> Open approval -> ViewId=approvals + selected id/run repair id

useApprovalsDomain
  -> listApprovals
  -> approveApproval / denyApproval
  -> get/execute/cancel ExternalWorkAction
```

- `useApprovalsDomain` 继续拥有 approvals、selected id、per-approval resolution busy、external action details/busy
  和 mutation event emission；Feature 不复制 domain store。
- focused presentation controller 只拥有 search/filter/selection fallback、detail disclosure、decision draft、
  second-confirm Dialog 和 focus return。
- cwd/request revision 必须阻止迟到 list/action detail/mutation response 写入新 workspace 或新 selection。

## 5. Page Structure

```text
PageShell
  PageHeader
    Inbox / Approval requests
    Refresh IconButton
  PageToolbar
    Search Input
    Queue/status/risk filters
  PageContent
    ReviewQueueList     minmax(320px, 1fr)
    ReviewDetail       340-380px
  Overlay layer
    High-risk approval Dialog
    External action cancel Dialog when reason/confirmation is required
```

- 默认是密集 list + detail，不用整页 Approval Card 墙。
- list/detail 分别内部滚动；`1440x960` 和 `1280x800` 无根横向滚动。
- `1280` 保持 detail 至少 320px；最小 Electron 窗口不足时 detail 进入 Drawer。
- run-scoped repair view 保留明确返回/清除 repair scope，不与主 Inbox filter 混合。

## 6. APPROVAL-LIST-001

### 6.1 Review Queue

队列行统一显示：对象 identity、category、一个主状态、risk（仅真实审批风险）、owner/target、更新时间和一个
推荐下一步。Category 使用产品语义：

- `Approve request`：真实 pending Approval；
- `Route work`：选择目标 Channel/owner，不显示 Approve/Deny；
- `Repair run`：打开 Run/Model/Work Board repair；
- `Execute approved action`：审批已完成但外部动作尚未执行；
- `Offline/local review`：只显示当前真实可用 action。

同一对象只在一个队列 owner 中显示；`inlineApprovalIds` 已在会话内拥有时，Inbox summary 不重复制造第二个
紧急提示。主 Inbox 仍可通过显式打开查看完整审计。

### 6.2 Search and filters

- Search 覆盖 title、description、action type、owner、run/task/channel 和 external work identity。
- Filter：Actionable、History；Actionable 可再按 category/risk 收窄，默认不把 approved/denied 历史混入。
- pending count 只统计真实有效 pending，不统计 expired/cancelled/replaced。
- Escape clear、no-result + Clear；Refresh 失败保留 rows 并显示 stale InlineFeedback。

### 6.3 Approval summary

默认 detail 顺序：

1. 请求动作和影响对象；
2. risk、owner、created/expires timing 和单一 status；
3. permission scope delta / file change / media cost / external action summary；
4. reason 与决定后果；
5. action buttons；
6. Artifacts/technical audit，默认折叠。

raw payload 不在默认 Card 中直接 `<pre>` 展开。长 path/scope 使用可换行 code/details，不扩宽列。

### 6.4 Status

只从 `ApprovalRequest.status` + 权威 expiration mapping 派生：

```text
pending > approved | denied | expired | cancelled
```

expired/cancelled/replaced 不显示可点击决定 action；approved/denied 保留 decision reason、resolved time 和结果。

## 7. Permission Delta And Risk

- Runtime permission delta 必须明确区分新增、移除和保持的 scope；空 delta 不显示装饰性区块。
- 路径、工具和模式使用 readable label；raw policy 进入 Technical details。
- risk 只用于真实 `low/medium/high/critical`，颜色不能替代文字。
- high/critical Approve 必须经过 shared Dialog 二次确认；需要 reason 的现有规则保持：高风险且非
  `media_cost` 时 reason required。Deny 不伪装成永久删除 danger action。
- permission/result consequence 持续 inline 显示，不能只发 Toast。

## 8. APPROVAL-DECIDE-001

### 8.1 Approve and Deny

- Approve 是 pending approval 的主行动；Deny 是明确次级 destructive decision，不使用 Delete icon/copy。
- 每个 approval 独立 busy；决定一个对象不锁全页或其他 Card。
- duplicate activation 被 domain single-flight 和 disabled control 双重阻止。
- failure 保留 reason/draft/selection，并在 Card/Dialog 内显示 Retry；不清空 payload/context。
- success 使用 API 返回的 authority 更新对象并 emit 既有 `approval.resolved` event；随后 refresh failure 时保留
  已返回的 resolved object 并标 stale。

### 8.2 External action and route

- Approval approved 不等于 External Work action 已执行；Execute/Cancel 是独立状态和 busy key。
- external action failure 归属对应 detail/Card，不能显示成审批决定失败。
- route action 只在真实 channels/callback 可用时显示；missing target 显示修复，不静默选择默认 Channel。
- Run repair、Work Board navigation 和 Open Run 使用现有 callbacks；navigation failure 由当前 owner 持续反馈。

## 9. Inline Approval Strip

- Inline Strip 是阻塞当前 run/composer 的紧凑 owner，最高风险 + pending count 只显示一次。
- primary approval 展示必要 scope delta 和 Open full approval；其他 pending 折叠到共享 Collapsible。
- Inline 和 Inbox 消费同一 approval/resolving state；决定后两处同步，不做本地乐观假状态。
- high-risk 二次确认不能在 strip 内铺长表单；打开共享 Approval Dialog 或主 detail。
- 不覆盖 Composer 尺寸，不遮挡 Send/Stop；长文本有内部边界，键盘可进入/离开。

## 10. Loading, Empty, Error And Races

| State | UI owner |
|---|---|
| initial loading | fixed Skeleton list + detail placeholder |
| empty actionable | one concise EmptyState + History/Work Board action when real |
| no-result | EmptyState + Clear filters |
| refresh failure with data | retained list + stale InlineFeedback + Retry |
| external detail unavailable | affected item summary + retry/details unavailable |
| mutation failure | exact Card/Dialog/action owner |
| request missing/expired during decision | authority status replaces form; draft no longer submittable |

cwd、approvalId、actionId 和 request revision 均参与 response guard。selection 消失时选择下一可见行；列表为空时
detail 卸载为 EmptyState，不保留上一对象 action。

## 11. Feedback And Accessibility

- lightweight refresh/route/execute success 可用全局 Toast；approval decision 的 durable status 必须留在对象。
- Field validation 使用 Field error；对象 failure 使用 InlineFeedback；全局断线由 AppShell owner。
- DataRow、Tabs/filters、Menu、Dialog、InspectorSection 使用 shared semantics。
- 32px+ icon hit area；每个 icon-only action 有 aria-label/Tooltip。
- Cancel 是 high-risk Dialog 初始焦点；busy 时阻止 outside/Escape dismiss，关闭后恢复 trigger/fallback。
- error/status 不只依赖颜色；ARIA live 不重复播报 Inline Strip + Inbox 同一消息。

## 12. Theme, Motion And Responsive

- semantic tokens only；approval/risk/category 不用彩色卡片墙。
- Dialog/Drawer/Collapsible 使用 UI2 Motion token，rapid toggle 可反向，reduced motion duration 0。
- imported Theme Pack 不改变 risk/status 语义、权限 scope 或列表密度。
- Web `1440x960`、`1280x800`；packaged macOS Retina、Windows DPI/forced-colors 进入 P13。
- zh-CN/en-US 长 label、path、payload、reason 不产生 root overflow。

## 13. Architecture Closeout

| File | Current lines | Result |
|---|---:|---|
| `ApprovalsPage.tsx` | 115 | composition only；header/toolbar/list/detail/repair/controller 已拆分 |
| `ApprovalCard.tsx` | 76 | summary/delta/external action/technical/decision owner 已拆分 |
| `InlineApprovalStrip.tsx` | 91 | focused compact adapter，复用同一 domain resolution state |
| `RuntimePermissionScopeDelta.tsx` | 6 | compatibility adapter to `ApprovalPermissionDelta` |
| `approvals.css` | 6 | imports-only，加载 6 个 dedicated CSS owner |
| `approvals.spec.ts` / `ui2-approvals.spec.ts` | 53 / 426 | legacy `2/2` + focused `9/9` |

Approvals production owner 最大 189 行，dedicated CSS owner 最大 178 行，没有大文件/module boundary 风险。
Domain/API/contracts 未迁入 presentation；`ExternalActionBusyState` 与 `ApprovalResolution` 由 domain-neutral
`domains/approvals/approval-domain-types.ts` 拥有，不再由 presentation component 反向提供。

## 14. Components And CSS

迁移：raw buttons -> Button/IconButton；raw textarea -> Field/Textarea；raw select -> Select；row/Card wall ->
DataRow + Detail；status/risk spans -> StatusIndicator/Badge；native details -> InspectorSection；inline confirm panel ->
shared Dialog；empty/loading/error -> EmptyState/Skeleton/InlineFeedback。

focused CSS 只拥有 grid、list/detail scroll、delta layout、payload wrapping 和 Inline Strip geometry。禁止
颜色字面量、`!important`、`transition:all`、Theme/Profile ID selector、私有 duration/keyframe 或 package-private
`.ling-ui-*` descendant selector。

## 15. Evidence Gate

新增 `ui2-approvals.spec.ts`，最低原图：

```text
1440x960-ling-light-actionable-list-detail.png
1280x800-ling-dark-empty-history.png
1440x960-ling-light-high-risk-confirm.png
1280x800-ling-dark-decision-failure.png
1440x960-ling-light-permission-delta.png
1280x800-ling-dark-external-action-failure.png
1440x960-ling-light-inline-approval-strip.png
1280x800-ling-dark-expired-long-payload.png
```

每张检查 console/page error、root/list/detail/Dialog overflow、focus、主题和唯一 overlay。metadata 记录 SHA-256、
fixture、locale、viewport、served artifact、tests 和 Desktop 缺口。

当前 Web evidence 已按本节完成；自动化 overflow assertion 覆盖密集列表、empty、Inline Strip 和 long-payload
边界，其余截图在原始分辨率完成视觉复核。预期 synthetic `409/503` 仅出现在故障注入场景。

## 16. Hard Stops

- 不改 approval/API/contracts/database/policy/state machine 或 risk/reason 业务规则。
- 不把 Review Queue item 全部改成 Approval，不混用 Review/Evidence/Approve 语义。
- 不让 approved 等于 external action executed，不伪造 run resume。
- 不用 Toast 代替 durable decision status/permission consequence。
- 不继续扩大 ApprovalsPage/ApprovalCard/approvals.css，不新增第二个 Toast/overlay owner。
- 不直接 import Radix，不覆盖共享组件内部 class。
- 未完成真实 changed-state 双主题、双 viewport 和 metadata 前，两个 Function ID 最多为 `implemented`。
