# B-006：Task 状态与审计事实的原子迁移

日期：2026-10-16
状态：Root 首跑新 6 项实际 1 pass / 5 fail、exit 1、零 skip/cancel/todo，已复现半写。
专用 wrapper + private WithinTransaction 已实施；Root fresh Core/Daemon build actual exit 0，
Task / approval / 状态机五完整文件最终 194/194 actual exit 0，零失败/取消/跳过。
未实施者独审 `b006-final-independent-review-20261016.md` 无确认残留，approved=false；不是 App 验收。
原始 RED：`output/e6-20260928/b006-task-ledger-red-20261016.log`。

## 当前根因与真实入口

`SqliteRunStore.transitionTaskStatus`（`sqlite-run-store.ts:2981–3051`）先读取 Task / 幂等事件，
然后独立执行 Task status-CAS UPDATE，最后 INSERT `state_transition_events`。
`state-transition-store.ts:38–81` 不另开事务。普通
`features/runs/orchestrator.ts:2003,2475,2779` 的 start / success / failure 调用
没有包含该两次写入的外层事务；第二写失败会留下已迁移 Task 与缺失 ledger / 幂等事实。
这是现 checkout 的静态确认，不是声称日常数据库已损坏。

审批恢复终态入口不同：`approval-resume-store.ts:445–625,631–743` 已拥有
`BEGIN IMMEDIATE`，分别通过 `579`、`696` 行调用该 Task 方法。
不能用新的无条件 BEGIN 修普通入口却破坏这些合法的嵌套调用。

## 最小完整合同

1. 专用 `task_status_transition` SAVEPOINT 包含读取、原幂等检查、原状态机判定、
   原 Task CAS 与原 ledger INSERT。独立调用时最外层 RELEASE 提交；已有调用者事务时
   RELEASE 只完成本地 savepoint，不提交/回滚调用者。
2. 保留现有合法状态、actor、expectedStatus、幂等键以及 currentRunId / assignee 更新规则。
   stale / invalid / missing / duplicate 返回也必须释放本次 savepoint。
3. 原 Task 全字段及其 ledger / 幂等事实一起成功或一起失败。第二连接在 INSERT 边界
   不能看到半写；异常后同连接、第二连接和重开连接均看到原事实。
4. 失败仅 `ROLLBACK TO` 本次 savepoint，再 RELEASE；不得无条件 ROLLBACK 外层事务。
   调用者失败前已做的其他合法写入仍由调用者决定 COMMIT 或 ROLLBACK。
   不依赖支持中的 Node 22 上不可靠的 `DatabaseSync.isTransaction`。
5. 发生 rollback / release 错误时不得覆盖原始错误或返回成功；原错误与 cleanup 错误
   保留在 AggregateError / cause 中。`ROLLBACK TO` 若失败，禁止继续 RELEASE，避免
   最外层 RELEASE 提交未知半写；只有 rollback 成功才清理该 savepoint。
   不能用忽略所有 cleanup 错误伪装连接可继续使用。
6. 此操作仍完全同步，无 await / 外部回调；不新增通用事务 callback API、不新表、不迁移历史、
   不把所有 Task/Run/Workflow 放到同一个大型事务，也不扩到其他 B/C 项。

实现可以沿用现 `transitionChannelWorkflowStepStatus` 的专用 wrapper + private
WithinTransaction 方法形状；额外修正 Task 自身的异常保留，不顺便改其他 wrapper。
SAVEPOINT 覆盖权威读取即可；保留现 CAS，不引入无证据的全局锁或任意 SQL callback。

## Test-only 反例与回归范围

新 `packages/core/test/task-status-ledger-atomicity.test.mjs` 使用显式临时 root、
HOME/env-free storage paths、真实 Task/Run、两个真实 Store 连接及重开连接：

- 正常 INSERT 边界原状态对第二连接不可见；提交后两事实一起出现；同 key 重复不改任何字段、
  不多写 ledger。
- 真实 SQLite BEFORE INSERT trigger RAISE(ABORT)；已经执行的 Task UPDATE 回滚，所有字段与
  ledger / 幂等键保持原值。移除一次性故障后同 key 可以正常重试。
- 真实 ledger INSERT 成功后再抛可辨识故障；必须回滚 Task 与实际新增 ledger，保留原错误身份。
- 外层 BEGIN 内成功 Task 迁移不提前提交；调用者 ROLLBACK 同时撤销 Task / ledger / 额外 Task。
- 外层 BEGIN 内 INSERT 前/后失败仅回滚本次迁移，不丢调用者此前创建的额外 Task；
  故障移除后在同一外层事务重试并由调用者 COMMIT，第二连接才可观察。
- 后继另加 rollback / release 故障各一项（不修改原 6 项断言）：先实际写入 Task 与 ledger，
  再注入原错误和 cleanup 错误；确认两个错误和 cause 均保留，peer 没有半写。
  rollback 失败时实际未提交写入仍留在 writer，且没有 RELEASE；release 失败时必须已实际
  rollback 到原状态。测试拥有的显式 rollback 后同连接可重试，不把测试清理当产品回执。

真实 approval-resume 组合补在 `approval-policy.test.mjs`，复用原合法 fixture，新增显式隔离
storage 选项仅用于新例，不更改原例默认路径：观察真实 `commitApprovalResumeTerminal`
内部 Task 迁移后的第二连接事实；正常终态一并提交，Task 之后的真实 control-plane INSERT
故障一并回滚 checkpoint / Run / WorkUnit / Attempt / Task / runtime 与 control-plane ledger / capacity。
原文件已有正常与故障矩阵仍须联测，不用手工 BEGIN 冒充真实审批入口。

首 RED 与后续 fresh GREEN / build 均由 Root 执行并记录实际 exit；本设计/实施者不运行。
无新用户决策；不以这些 SQLite 回归替代 packaged App 验收或全量内容批准。

## 实施范围与模块风险

产品只改 `sqlite-run-store.ts` 的 Task 迁移方法：原公开签名与返回合同保留，原方法体进入
专用 private WithinTransaction；wrapper 管理本地 SAVEPOINT 与双错。不新增通用 callback，
不修改 Workflow wrapper 或重构整个 Store。该 Store 仍为大文件，是既有模块边界风险；
本轮将新增责任限制在 25 行专用 wrapper，未来可单独迁移 Task Store，但不能冒作本项已完成。
Root 的 fresh 联测与未实施者最终窄审已完成。原始 RED 和 cleanup 故障证据保留，
本项定向 GREEN 不替代全 Store、Office、packaged GUI 或发布批准。
