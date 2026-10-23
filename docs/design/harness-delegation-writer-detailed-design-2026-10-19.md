# H10 Delegation Writer 详细设计

状态：设计冻结，已有分阶段实现候选，等待当前组合验证和真实客户端验收。
范围：H10 root budget authority、delegation writer、reservation/settlement；以及必须预留的 H11/H12 接缝。  
不代表：dynamic child 已启用、G19/G20 已通过、H11/H12 已完成，或 packaged macOS 已验收。

## 1. 结论

Ling 不新增第二套 orchestrator。动态委派继续复用现有 Run、WorkUnit、Attempt、
RunnerContinuation、审批、沙盒和 workflow completion 边界。

H10 的权威写入必须满足以下不变量：

1. RootRun 在第一次进入 `running` 之前，由 Host 持久化不可变 root budget snapshot；
   第一次 spawn 不能临时补建预算，也不能从后来可编辑的 Goal 推导预算。
2. child 创建和 root/parent capacity reservation 在一个 `BEGIN IMMEDIATE` 事务内完成。
3. H10 只创建 queued child。`delegation_steps` 保持 `spawning`，
   `child_run_id` 仍为空；新增 reservation 行唯一绑定 queued child Run。
4. H11 只有在 child 的真实 Runner start 被 Host 接受时，才在同一事务内执行
   `spawning -> running` 并把 `delegation_steps.child_run_id` 绑定到该 child Run。
5. 不修改已经发布并由启动断言保护的 migration 154，也不替换它的 trigger。
6. 权限、工具、workspace、Provider、网络和 secret scope 必须来自 Host-owned producer；
   普通 JSON、模型参数、artifact ID 或 digest 本身都不是权限权威。
7. dynamic child producer 在 H10/H11/H12 门禁全部满足前保持关闭。

## 2. 已批准决策

### R1：root budget

- RootRun 执行准入时冻结一次。
- 全树共享同一个 root ledger。
- child reservation 与 child durable identity 同事务提交。
- Goal token tally、终态 usage 汇总和 runtime semaphore 都不能替代该 ledger。

### R2：绝对 deadline

- root 保存绝对 `deadlineAt`。
- child deadline 为 `min(root deadline, parent deadline, requested deadline)`。
- daemon restart、retry、resume 和 wait 不能延长 deadline。
- `wait(timeout)` 只是一次观察超时，不是取消、终态或资源释放证明。

### R3：金额预算

- 使用 Host 管理的、版本化、币种固定、Provider/Base URL/API/Model scope 绑定价格快照。
- 价格未知时，只拒绝带 `costBudgetMicros` 的 spawn。
- token/time-only spawn 不因价格未知而被禁用。
- usage 或外部费用未知时保留 unresolved reservation，不虚构零费用或退款。

### R4：child authority

- child 创建事务冻结当时的 effective authority 和 effective budget。
- 后续父级增权不能扩大旧 child。
- resume/recovery 仍叠加当前撤权；历史 frozen snapshot 不被回写。

## 3. 非目标

H10 不实现：

- Runner 启动；
- message、wait、interrupt、resume；
- workflow required/optional fan-in；
- 新 transcript renderer；
- accepted workflow graph 改写；
- 根据模型文本判断“child 已完成”；
- 从当前 Goal、当前设置或当前价格覆盖历史 root/child snapshot。

这些分别属于 H11、H12 或既有 UI/projection。

## 4. 模块边界

### 4.1 Contracts

文件：`packages/contracts/src/harness.ts`

只增加跨包必须共享的持久化 DTO 和稳定枚举：

- root budget snapshot identity；
- reservation/charge state；
- artifact pin；
- writer/recovery failure code；
- H11 所需的 child binding identity。

Contracts 不包含 SQLite、Runner、Daemon producer 或 coordinator 操作。

### 4.2 Pure authority math

文件：`packages/core/src/harness/delegation-authority.ts`

职责：

- root/parent/requested budget 继承与子集检查；
- absolute deadline 计算；
- price scope 检查；
- BigInt 费用计算与保守向上取整。

该模块明确不证明 Host provenance、不读取 SQLite、不做 reservation。

### 4.3 Shared ancestry

建议文件：`packages/core/src/storage/sqlite/run-ancestry.ts`

evaluation、delegation writer 和后续 recovery 共用完整 ancestry resolver。

它必须：

- 返回 `root -> ... -> parent` 完整链；
- missing parent、cycle、重复 Run、超过固定上限时 fail closed；
- 不把 direct parent lookup 冒充完整 ancestry；
- 不从 `delegation_steps.depth` 反推 Run ancestry。

### 4.4 Host authority producer

建议目录：`packages/daemon/src/features/harness/delegations/`

职责：

- 从实际 Run execution、effective approval/sandbox policy、canonical workspace scope、
  tool inventory、Provider runtime scope、network/secret policy 和 participant manifest
  生成 frozen authority bundle；
- 生成 root budget authority 和 child launch plan；
- 使用 module-private brand/WeakSet 或等价 custody，防止 route/model/普通 JSON 构造
  “看起来相同”的 authority object；
- 不把 plaintext secret 写入 artifact，只写稳定 secret ref 和 scope digest。

Core writer 不接受一组由调用者任选的 artifact IDs。artifact 必须由 writer 消费
Host-issued authority capture 后在自己的事务内创建，或通过同等强度的 custody bridge
验证后创建。

### 4.5 SQLite writer

建议文件：`packages/core/src/storage/sqlite/delegation-write-store.ts`

不要把 mutation、artifact authentication 和 child creation 塞入已验证的
metadata-only `delegation-store.ts`。

writer 只暴露窄接口：

```ts
prepareDelegatedChild(input): PreparedDelegatedChild
freezeRootDelegationBudget(input): DelegationRootBudgetSnapshot
reserveModelInvocation(input): DelegationBudgetCharge
settleModelInvocation(input): DelegationBudgetCharge
settleDelegatedChild(input): DelegationBudgetReservation
```

H10 不在 public `RunStore` 暴露可由普通 route 直接传 raw JSON 的宽 mutation API。

## 5. Migration 176 候选结构

最初设计在 head 168 上预留 169；整合原生执行引擎后已顺延为 176（T13B 为 177）。
禁止修改既有 migration 154；提交前仍应重新检查 migration head 与 startup assertions。

### 5.1 `delegation_root_budgets`

一条 RootRun 一行。snapshot identity 永久不可变。

建议字段：

```text
root_run_id                 PK, FK run_sessions
schema_version              = 1
authority_artifact_id       UNIQUE, FK artifacts
authority_digest            sha256
price_artifact_id           nullable, FK artifacts
price_digest                nullable sha256
token_budget                nullable safe integer
cost_budget_micros          nullable safe integer
deadline_at                 canonical ISO timestamp
frozen_at                   canonical ISO timestamp
created_at                  canonical ISO timestamp
```

约束：

- row 禁止 UPDATE/DELETE/REPLACE；
- `cost_budget_micros` 存在时必须有 price pin；
- `deadline_at > frozen_at`；
- authority artifact owner 必须是 `root_run_id`；
- artifact bytes、stored SHA 和 row digest 三者一致；
- root run 不得有另一个 root budget row。

### 5.2 `delegation_budget_reservations`

每个 committed delegation step 一行。它既是 capacity allocation，也是 H10 queued
child 的唯一 pre-start binding。

建议字段：

```text
id                          PK
schema_version              = 1
root_run_id                 FK delegation_root_budgets
delegation_step_id          UNIQUE, FK delegation_steps
parent_reservation_id       nullable, FK self
child_run_id                UNIQUE, NOT NULL, FK run_sessions
request_digest              sha256
token_reserved              nullable safe integer
cost_reserved_micros        nullable safe integer
deadline_at                 canonical ISO timestamp
state                       reserved | settled | released | unresolved
settled_token_usage         nullable safe integer
settled_cost_micros         nullable safe integer
failure_code                nullable stable enum
idempotency_key             UNIQUE
revision                    monotonic safe integer
created_at
updated_at
settled_at                  nullable
```

贡献规则：

- `reserved`：向直接 parent/root 贡献完整 reservation；
- `settled`：只贡献 verified actual usage；
- `released`：贡献 0，必须有 no-dispatch/no-usage 证明；
- `unresolved`：继续贡献完整 reservation，直到有可信裁决。

`child_run_id` 在 reservation 上从 H10 commit 起不可变。它不是 child 已开始的证明。

### 5.3 `delegation_budget_charges`

仅有 child reservation 不足以关闭 G20：root/parent 自身的并发模型调用也会消费
同一容量。因此每次受预算约束的 Provider 调用都必须先 reserve，再按可信 usage receipt
settle，不能只在 Run 终态做 post-hoc tally。

建议字段：

```text
id                          PK
schema_version              = 1
root_run_id                 FK delegation_root_budgets
reservation_id              nullable FK delegation_budget_reservations
run_id                      FK run_sessions
attempt_id                  FK work_unit_attempts
invocation_id               stable provider invocation identity
request_digest              sha256
price_artifact_id           nullable FK artifacts
price_digest                nullable sha256
reserved_tokens             nullable safe integer
reserved_cost_micros        nullable safe integer
input_tokens                nullable safe integer
cached_input_tokens         nullable safe integer
output_tokens               nullable safe integer
actual_cost_micros          nullable safe integer
state                       reserved | measured | cancelled_before_dispatch | unresolved
idempotency_key             UNIQUE
revision
created_at
updated_at
settled_at                  nullable
```

同一 `invocation_id` 只结算一次。未知 usage/费用进入 `unresolved` 并保留原 reservation。
迟到或重复 receipt 不得二次扣费或退款。

### 5.4 不修改 migration 154

尤其保留：

- `spawning -> running` 时才能写 `delegation_steps.child_run_id`；
- child binding 一次性；
- tree-edge trigger；
- immutable identity 和 append-only message 约束。

新表只补充 queued child 的 pre-start binding，不改变 `running` 的事实语义。

## 6. RootRun 准入冻结

### 6.1 精确时点

root budget freeze 发生在：

1. Run、WorkUnit、current Attempt 已有 durable identity；
2. WorkUnit 已被 Host claim；
3. Runner 尚未开始；
4. Run 尚未进入 `running`。

建议把 freeze 接在现有 Run start admission、`startObservedRuntime` 之前，而不是
第一次 spawn、第一次 usage callback 或 Run terminal。

对 queued Run：排队期间不临时创建动态 child；真正取得执行准入时才冻结。

### 6.2 准入事务

事务内要求：

- Run `queued`；
- WorkUnit `claimed`；
- Attempt `created` 且是 active Attempt；
- runtime instance/fencing token 精确匹配；
- Run、WorkUnit、Attempt 尚未 terminal/cancelling；
- Host authority capture 与该 Run/Attempt/scope 一致。

事务创建 root authority artifact、可选 price artifact 和 root budget row。

只有该事务成功后，现有 start path 才能把 Run/WorkUnit/Attempt 推进到 running/started。

### 6.3 replay 和 crash

- 相同 authority digest 的重复 freeze 返回原 row；
- 同一 RootRun 的不同 snapshot 返回 conflict；
- crash 在 commit 前：没有 root budget，Run 不得开始；
- crash 在 commit 后、start 前：recovery 读取原 snapshot，不重新计算 deadline；
- 已经 running 但缺 root budget 的 Run 不允许 backfill 后再 spawn，必须明确拒绝。

### 6.4 数值来源

- token/cost 只来自明确的 Host policy；未配置时保持 `undefined`，不虚构额度；
- deadline 必须来自一个已经权威化的 Host timeout policy。建议使用执行准入时冻结的
  effective WorkUnit `hardTimeoutMs` 计算绝对时间，而不是从模型参数或可编辑 Goal 读取；
- cost budget 存在但没有匹配 price snapshot 时，root admission 或 cost-mode activation
  必须失败；不能用 weighted token unit 冒充货币。

## 7. `prepareDelegatedChild` 单事务

### 7.1 输入

建议输入只包含：

- parent Run id + exact RuntimeAttemptFence；
- caller-stable `spawnCallId`；
- objective payload；
- requested budget；
- required/optional 标记；
- Host-issued child launch/authority capture；
- Host timestamp。

child Run/WorkUnit/step/reservation IDs 由 writer 生成并在 replay 时从 SQLite 返回，
不让模型指定 durable identity。

### 7.2 replay 顺序

事务开始后先按 `(parent_attempt_id, spawn_call_id)` 查现有 step/reservation：

- `request_digest` 相同：返回原完整结果，即使 parent 后来已 terminal；
- digest 或 authority identity 不同：`delegation.idempotency_conflict`；
- 不得因 response lost 再扣预算或创建第二个 child。

只有“没有已提交结果”的新请求才继续 current-fence 检查。

### 7.3 parent execution gate

复用 `runExecutionOwnerSql` 的 identity/fence 部分，但必须在同一 mutation SQL 中额外要求：

```text
parent Run       = running
parent WorkUnit  = running
parent Attempt   = started
abort_requested  = null
allowCleanup     = false
```

`queued`、`claimed`、`waiting_for_approval`、`waiting_for_input`、`cancelling` 或 cleanup
authority 都不能 spawn。

### 7.4 ancestry 和 delegation lineage

1. 解析完整 Run ancestry；
2. root 必须存在且有已冻结 root budget；
3. root id 必须与 authority capture、parent effective budget 和 parent delegation lineage 一致；
4. root child depth 为 1；nested child 必须引用当前 parent delegation step；
5. nested parent step 必须已 `running` 且 `child_run_id == parentRunId`；
6. missing ancestor、cycle、depth overflow 全部 rollback。

H11 对 delegated child 的 interrupt/resume 必须保持同一个 child Run、创建新 Attempt；
不能用任意 successor Run 替代 parent step 的 `child_run_id`，否则会破坏 migration 154
的 tree-edge 合同。

### 7.5 workflow lineage

- 有 workflow step 时，workflow id/step id 必须与 parent Run 和 accepted graph 一致；
- 没有 workflow 时两者都为空；
- dynamic child 是 overlay，不新增、重排或改写 accepted workflow graph；
- participant 必须来自冻结的 participant manifest/scope；
- child 可以复用 workflow step 作为 projection lineage，但不能自行推进该静态 step。

### 7.6 authority validation

writer 读取并重新验证 Host capture，生成并 pin：

- permission snapshot；
- tool allowlist；
- workspace scope；
- provider policy；
- network scope；
- secret refs/scope；
- common authority-set id、source revision 和 scope digest。

对 nested child，所有维度都必须是 parent frozen authority 的严格子集或相等值：

- tool/network/secret：唯一集合子集；
- workspace：canonical root containment + access mode 不扩张；
- Provider/Base URL/API/Model：必须命中 parent 允许 scope；
- approval/sandbox：使用显式偏序，不以字符串相等代替安全强度；
- plaintext secret、额外 header、未知 capability fail closed。

SHA-256 只证明 bytes 未变，不证明这些 bytes 是 Host 决策。因此 writer 不接受“已有
artifact id + digest”作为新 authority。

### 7.7 budget reservation

在同一事务中：

1. 使用 pure authority helper 计算 effective child budget/deadline；
2. 校验 price scope；
3. 从直接 parent 沿 `parentReservationId` 逐级校验每个祖先 allocation 的已用、
   active reservation 和 unresolved contribution，不能漏掉中间层；
4. 同时校验 root ledger；
5. 任一 token/cost/time 维度超限即 rollback；
6. 创建 reservation row。

SQLite `BEGIN IMMEDIATE` 串行化 competing sibling writers；不能先读余额、事务外创建 child、
再回来扣账。

### 7.8 durable child create 顺序

同一事务内推荐顺序：

1. 创建 parent-owned objective/authority artifacts；
2. 创建 queued child WorkUnit，暂不绑定 Run；
3. `createRunWithinTransaction` 创建 queued child Run，写 `work_unit_id`；
4. 把 child Run id 回绑 WorkUnit；
5. 插入 `delegation_steps(state='spawning', child_run_id=NULL)`；
6. 插入 `delegation_budget_reservations(child_run_id=<queued child>)`；
7. 重读全部行与 pins；
8. COMMIT。

H10 不创建 child Attempt、不调用 Runner、不把 step 标为 running。

任一步失败时，artifact、WorkUnit、Run、step、reservation 必须全部消失。

## 8. H11 精确接缝

### 8.1 start

H11 coordinator 从 reservation 取得 queued child identity，创建/claim child Attempt 并准备
Runner。Runner 的真实 start 被 Host 接受时，一个 start commit 完成：

- child Run `queued -> running`；
- child WorkUnit `claimed -> running`；
- child Attempt `created -> started`；
- delegation step `spawning -> running`；
- `delegation_steps.child_run_id` 从 NULL 绑定为 reservation 的 `child_run_id`。

上述 identity 必须完全相同，且 step/reservation revision 仍 current。不能在仅 queued、
仅创建 Attempt、仅发起 Promise 或仅收到“我会开始”的模型文本时绑定 running。

### 8.2 spawn crash windows

- H10 commit 后、H11 claim 前：recovery 看见 `spawning + reserved + queued child`，可重试 claim；
- Runner 未开始且可证明 no-dispatch：可把 step failed/cancelled、reservation released；
- dispatch outcome unknown：step 不冒充 failed，reservation 进入 unresolved/lost 路径；
- Runner 已开始但 start commit 丢失：必须依赖 Host start/Attempt evidence reconcile，
  不能仅凭 child 输出补写 running。

### 8.3 message / wait / interrupt / resume

- message：append-only `delegation_messages`，idempotency key 去重；
- wait：有界观察，不改变 step 状态，不释放 reservation；
- interrupt：`running|waiting -> interrupting`，真实 stop receipt 后才 `interrupted`；
- resume：同 child Run 上新建 fenced Attempt，`interrupted -> resuming -> running`；
- daemon restart：SQLite state/lease 为权威，EventHub 只负责唤醒；
- stale child Attempt completion 不能终结 step 或 parent workflow。

### 8.4 interruption overlay 与 Attempt 读取范围

中断不等于取消逻辑任务。Host 把 child WorkUnit/Attempt 置为 cancelling，并保存绑定
parent fence、child source fence 和 call id 的 sealed control message；child Run 保持 running。
只有原始 Host lifetime 已 drained、工具与 native effect journals 已逐项重验、durable
quiescence 已成立，才允许物理 Attempt/WorkUnit cancelled、step interrupted，并释放该
Attempt 的资源。该例外仅允许资源清理，不赋予执行、resume 或成功权限。

resume 在同事务中再次验证当前 parent fence、冻结权限与当前撤权、绝对 deadline，
新建单调 fence 的 Attempt。child Run 和 reservation/deadline 不变；新 Attempt 仍需要
真实 adapter acceptance 才能从 resuming 进入 running。

resume 的 sealed control fact 同时绑定 `callId`、parent fence、预期 step revision、
被中断的 source fence、以及新建的 target fence。首次调用必须完成上述实时校验；
同一调用的响应丢失重试只读取并校验该事实，不重新 dispatch，也不因随后 ACK、终态、
绝对 deadline 到期、Store 重开或后继 Attempt 而改写原结果。相同 `callId` 配合不同
parent fence/revision，或 fact 与 source/target Attempt lineage 不一致，必须明确冲突。

现有 reader 默认保留 whole-run fail-closed 行为。仅真实 committed delegation ownership
可采用 exact-attempt scope；排除旧 Attempt 的 facts 前，必须验证原始 owner/fence、
terminal Attempt、原始 drained lifetime，并继续验证旧 receipts/journal。不能通过 SQL
只筛当前 attempt 而遗忘 orphan、pending、unknown 或 stale 历史。

### 8.5 late acceptance 与拒收停止

claim replay 是观察，不重新 dispatch。adapter Promise 完成不等于已启动；只有实际
acceptance callback 能提交 start。callback 失败、被 adapter 吞掉异常或 Promise 结束后
晚到的 acceptance，都由 coordinator exact-once 持有物理 stop Promise；shutdown/recovery
必须等待 drainRejectedStarts，失败不能吞掉，也不能伪造 no-dispatch 退款。

### 8.6 原始准备工件与真实 Pi ACK

执行准备沿用现有 Run orchestrator 的 policy、工具、secret rebinding 和 SDK preflight；
不建立第二个 Runner loop。Host 在第一次模型调用前提交唯一 child-owned
`delegation.execution.v1` sealed artifact，内容包括原始第一个 Attempt fence、
non-secret request、实际 SDK prepared input、effective policy 和准备时间。

- private factory 的 preparation token 经 constructor reader 验真；普通 JSON、复制 token、
  同形 reader 和另一 factory 的 token 均不能作为准备权威。
- Core `commitDelegatedChildStart` 强制验证原始准备工件，不能仅凭 start observation
  绕过准备。工件缺失或冲突时保持 claimed/unknown，不自动补造新输入或重新 dispatch。
- 真实接收点为 `PiRunnerRunOptions.onPreparedInputAccepted` 的 `pi-session-ready` ACK：
  精确核对 Run、当前 Attempt、Task、SDK fingerprint、完整 non-secret Provider descriptor、
  deadline，以及接收时仍 current 的 fence 与 sealed artifact。
- 一次 callback 已尝试后，不允许因 COMMIT 失败、回调中取消或重复 ACK 再次执行模型；
  由现有 orchestrator 持有 physical stop/drain，未证实停止则保留不确定状态和预留。
- resume 仍读取第一个 Attempt 的原始准备工件，ACK 绑定新的单调 Attempt；
  nested child 的继承输入来自父 child 原始准备工件，不来自后来聊天或 minimal request。
- inline Provider 凭据及 headers 不入工件；每个 child 的真实 Provider 原件必须由
  同一 Host composition 单独绑定，不能拿 root 的 Provider 引用冒充 child 准入。
- SDK prepared input 的 fingerprint 绑定其原始 JSON 属性顺序。仅
  `delegation.execution.v1` 使用保序的 data-only 序列化和字节 SHA-256：先拒绝
  getter、Proxy、函数及 `toJSON` 等非纯数据，再保留原始 `JSON.stringify`
  顺序入库与读回核验；不得排序其嵌套键，也不得为迁就排序结果重算 SDK fingerprint。
  预算、控制、结果等其他工件仍保留既有 canonical JSON，不扩大例外。

当前 prepared-input receiver 和低层事务测试只是实现候选。读取初始 prompt 不等于
恢复已执行工具之后的 transcript；在完整 continuation/停止/恢复/汇合及 packaged
验收通过前，动态 producer 仍关闭，不得把重新 prompt 说成无重复执行的恢复。

## 9. H12 精确接缝

H12 读取原子 delegation facts，不读取 UI batch 数量或模型总结：

- required child 及其所有 required descendants 都 terminal-success 才允许 parent step success；
- required child failed/cancelled/lost/unresolved 会阻塞或失败；
- optional child 采用用户于 2026-10-22 批准的 `stop_with_parent`：不允许在父 Run/step
  收尾后继续后台执行。父模型返回不是整树完成，Host 必须先关闭父执行的子任务准入，
  按精确 Run/Attempt fence 请求停止仍活动的 optional 子树，并等待原执行的真实
  stop/drain、effect quiescence、预算结算及 sealed result。abort/requestStop 返回值、
  进程消失或 lease 到期均不是停止回执；未知结果保留 owner/预留，阻塞父终态；
- optional 的已验证业务失败/取消不转成 required 失败；但 optional 的 `lost`、未结算、
  缺原始 completion/结果、遗留问题或审批仍属于整树未确认，不得称 succeeded。
  required 后代维持原 fan-in 规则，不因祖先标记 optional 而静默改写 required；
- stop_with_parent 覆盖成功、失败和取消收尾。冻结输入/私有 Host registry 执行停止，
  不新增模型可调用的 finish/权限接口。重复收尾只重读同一证据，不重跑工具/模型，
  也不制造 no-dispatch 退款。已中断、等待问答/审批、启动结果未知或跨进程 child
  必须走其现有私有恢复/停止链；没有足够停止证据时明确 blocked，不借通用入口旁路；
- `spawning` 即使 `delegation_steps.child_run_id` 仍为空，只要 reservation 已绑定 queued child，
  仍是 outstanding child，不能被 fan-in 漏掉；
- accepted workflow graph 保持不变，delegation tree 作为 completion overlay；
- TerminalReport lineage 指向 step、reservation、child Run、Attempt 和 evidence refs。

terminal producer 必须与 step 终态同事务创建 child-owned sealed `delegation.result.v1`
artifact 和唯一的 `child_to_parent/result` message。payload 包括 step/reservation/root/
parent/child identity、完整当前 source fence、真实 outcome、settlementDigest，以及固定三类
原子引用：Host attempt completion、settled budget reservation、该 child Run 所有
measured/cancelled-before-dispatch Provider charge。引用用原始记录的稳定 digest，不能从
模型文本、UI batch 或任意 caller refs 生成。

fan-in reader 必须独立重读这些原子事实、重新计算 completion coverage/quiescence 与 refs。
终态 step 缺结果、重复结果、unknown charge、stale fence 或 digest 不符均 fail closed；
不能在 restart 后仅根据终态 UI 回填成功结果。

## 10. 稳定错误码

新请求失败且事务全回滚时，使用非持久 step state 的 writer error：

```text
delegation.invalid_input
delegation.source_attempt_stale
delegation.parent_not_running
delegation.root_budget_missing
delegation.root_budget_conflict
delegation.lineage_invalid
delegation.workflow_lineage_invalid
delegation.authority_invalid
delegation.capability_escalation
delegation.price_unknown
delegation.price_scope_conflict
delegation.deadline_exceeded
delegation.budget_exhausted
delegation.depth_exceeded
delegation.cycle_detected
delegation.idempotency_conflict
```

migration 154 现有 `DelegationFailureCode` 只用于已经存在的 step 终态，不为丰富
request error 而重建旧表。

## 11. 分阶段 RED / 验收

### H10-A：pure authority

- deadline、继承、root/parent 子集；
- price scope；
- BigInt ceil 和 overflow；
- getter/extra field/unsafe integer/canonical timestamp 拒绝。

### H10-B：migration

- 当前真实 schema head -> 新 migration；
- reopen/rerun；
- marker/object/trigger 损坏拒绝；
- DDL/fault injection 全回滚；
- migration 154 SQL/trigger/hash 不变。

### H10-C：root admission

- budget 在 Run start 前冻结；
- freeze commit 后重启 deadline 不变；
- running-but-unfrozen Run 不允许补建再 spawn；
- Goal/设置/价格后来变化不改历史 snapshot；
- cost cap + unknown price fail closed；token/time-only 保持可用。

### H10-D：writer / G19-G20

至少包含：

1. stale parent Attempt/fence：零 artifact、零 reservation、零 child Run/WorkUnit/step；
2. parent queued/waiting/cancelling 即使 fence 匹配也拒绝；
3. missing ancestor、false root、cycle、depth overflow 全回滚；
4. permission/tool/workspace/provider/network/secret 任一扩权拒绝；
5. sibling 并发看到同一余额时只有合法数量成功；
6. duplicate spawn 返回同一 queued child，不重复扣账；
7. 同 key 不同 request digest 明确 conflict；
8. token/cost/deadline 任一超限全回滚；
9. unknown price：cost 模式拒绝，token/time-only 允许；
10. price revision/scope 任一漂移拒绝；
11. child deadline clamp，reopen 不延长；
12. 父级后续增权不扩大旧 child；
13. 当前撤权后的 start/resume 不恢复旧扩权；
14. settlement exactly once；
15. unknown usage 保留 unresolved reservation；
16. 在 artifact、WorkUnit、Run、step、reservation 各插入点 fault injection，零孤儿行；
17. root/parent 自身 Provider charge 与 child reservation 并发时不超总额。

### H11

- spawn/message/wait/interrupt/resume retry 幂等；
- pre-start、unknown dispatch、start-commit-lost、daemon restart；
- same child Run + fresh Attempt resume；
- stale completion 不写 step terminal；
- fake Runner 先通过，dynamic producer 仍不对普通模型开放。

### H12

- required、optional、transitive、failed、cancelled、lost、unresolved；
- spawning reservation 不能被 fan-in 漏掉；
- TerminalReport lineage；
- selected workflow enforce；
- packaged macOS、daemon restart、SSE reconnect 联合验收。

## 12. Feature gate

- `off`：不创建 root budget，不暴露 dynamic delegation tools，现有静态频道行为不变；
- `shadow`：允许 root snapshot/decision observation 和直接测试入口，但不向普通 Runner 暴露
  可真正创建 child 的工具；
- `enforce`：只有 H10/H11/H12 hard gates、recovery 和 packaged acceptance 全通过后，
  才对选定 workflow 开放。

回滚只关闭 flag 并重启；不删除或改写已持久化历史。

## 13. 仍需在实现前固定的语义

以下不是 R1-R4 回退，而是具体 producer/adapter 参数仍需落到代码：

1. **Root deadline 来源**：建议冻结 effective WorkUnit `hardTimeoutMs`；如果另选 Host policy，
   必须是准入前已确定的不可变值，不能来自模型或后续 Goal。
2. **Price registry 内容**：需定义受支持 Provider/Base URL/API/Model 的版本化费率和币种；
   未列出的 scope 只能运行 token/time-only。
3. **Provider usage receipt**：每个实际 Provider adapter 必须明确 measured/unknown 语义和
   invocation id；没有 receipt 的路径不能虚构 settlement。
4. **Root/parent direct usage admission**：必须接入同一 ledger；只实现 child rows 不能宣称
   G20 完成。
5. **Optional child cancellation policy**：在 H12 开启 selected workflow 前固定；不影响
   H10 writer 的 required flag 和 durable identity。

在 1-4 完成前，dynamic child producer 保持关闭。

## 14. 实现顺序

1. pure authority tests；
2. shared ancestry resolver；
3. migration 及 adversarial migration tests；
4. root admission freeze；
5. Host authority custody/producer；
6. provider charge reservation/settlement port；
7. `prepareDelegatedChild` writer + fault injection；
8. H10 G19/G20 full gate；
9. H11 coordinator/recovery；
10. H12 fan-in/selected workflow enablement；
11. combined macOS packaged acceptance。

任何较早阶段通过都不能提前打开 dynamic child producer。
