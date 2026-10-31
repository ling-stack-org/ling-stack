# B011 实施合同：显式续租期限与安全 expiry SQL

日期：2026-10-16。唯一实施树：本机专用 worktree `ling-e6-continuation/ling-stack`（绝对路径仅保存在本地 QA 记录）。

本合同采用 Root 已固定的单一接口，覆盖先前 `b011-resource-lifecycle-trace-20261016.md` 中尚未确定的接口选项。
本合同不新增通用 reconciliation 事务、任意回调或自动撤权机制；先前 trace 的更宽建议不作为本次实现范围。

状态：已按本合同实施并通过限定回归、未实施产品者窄审。最终七完整文件 200/200，actual exit 0；contracts/Core/Daemon fresh build 各 actual exit 0。本文保存实施合同，历史 RED 分类保留；不是 packaged App、Office 批准或 E6 总验收，`approved=false`。

## 1. 目标与非目标

目标是让 current Attempt 的 heartbeat 真正延长资源 lease 和 semaphore slot 的截止时间，同时避免一个仍具执行权的 owner 被固定 TTL 扫描提前释放。
过期的日期不是 lost/terminal 事实，缺失 owner 也不是安全停止证据。

本项只声称资源/容量生命周期修复，不声称已证明双 effect，不删除 Host command blocker、Host operation journal 或 per-tool claim。
不提高当前6h窗口、不从历史期限反推 duration、不修改真实数据库、不引入独立服务/表，不把 Core 测试当 packaged App 验收。

## 2. 单一类型接口，无旧接口 fallback

```ts
interface RuntimeResourceRenewal {
  readonly renewedAt: string;
  readonly expiresAt: string;
}

interface RecordRuntimeHeartbeatInput extends RuntimeAttemptFenceV1 {
  readonly ts: string;
  readonly resourceExpiresAt: string; // 必填，由可信 Host 构造。
  readonly source: RuntimeHeartbeat["source"];
  readonly detail?: unknown;
}

renewResourceLeasesForAttempt(fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal): number;
renewRuntimeSemaphoreSlotsForAttempt(fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal): number;
```

第二参数不再接受 string。缺少 `resourceExpiresAt`、旧 string 调用、损坏对象必须拒绝，不通过 optional/default 保留只写 lastRenewedAt 的旧行为。
TypeScript 类型、RunStore 端口/facade、joined heartbeat ports 和所有真实调用者一并迁移。

Root 新增小模块 `runtime-resource-renewal.ts` 集中可信6h策略与 ISO/窗口校验；测试不预先导入不存在的新 export，避免 missing-import 冒充产品行为 RED。

### 2.1 时间验证

- renewedAt/ts 和 expiresAt/resourceExpiresAt 均必须是合法、规范 ISO 字符串，能往返 `new Date(ms).toISOString()` 且与输入一致。
- `0 < expiresAt - renewedAt <= 6h`；等于、早于、超窗以及非法/非规范日期均拒绝。
- deadline 来自可信 Host 的同一 ts+6h，不从模型参数或 heartbeat.detail 读取。
- 三个真实 Host 入口分别为 Run orchestrator、Media provider executor、Media workflow executor；每次捕获一个 ts，用同一 ts 构 deadline，避免两次 Date.now 令窗口意外大于6h。
- 不用 `expires_at - acquired_at` 或 `expires_at - last_renewed_at` 推算续租窗口，不为历史只写 lastRenewedAt 的行猜测原 policy。

## 3. 心跳与两类续租的原子边界

保留 `recordRuntimeHeartbeat` 现有 BEGIN IMMEDIATE 骨架：

1. 验证可信 deadline，并 fresh 验精确 current Attempt fence/lifecycle。
2. 写 heartbeat、更新 WorkUnit/Attempt 心跳。
3. 传同一 `{ renewedAt: input.ts, expiresAt: input.resourceExpiresAt }` 给两类 renew。
4. 所有成功才 COMMIT；任一失败整份回滚。

两类 renew 自身的 UPDATE 也要校验精确 fence、current pointer、workspace/owner 归属与非终态 Attempt，不能只依赖外层 heartbeat 已校验。
current created/started/waiting_for_approval/cancelling 按原持有/cleanup 生命周期允许维持资源；succeeded/failed/cancelled/lost/yielded 不续。

资源行只更新 status=active：

- `last_renewed_at = MAX(原值, renewedAt)`；
- `expires_at = MAX(原值, expiresAt)`；
- 原 acquiredAt/identity 不变；
- released/expired 不复活；旧 fence 不碰 successor。

这里的单调约束明确针对资源行的续租时间与期限。不要凭一次旧 callback 的时间缩短资源保留期。
合法 current heartbeat 即使没有 active 资源也可以记录，但绝不能因此重新创建已释放资源。

## 4. expiry：单条 UPDATE 内的正面已撤权证据

本次 expiry **不自行标 lost、不造 recovery callback、不对外执行取消**。
旧生命周期 already lost/terminal/replacement 的事实来自既有 authority 流程。

两类安全 expiry UPDATE 都保留 status=active、expires_at<=now，并在同一 SQL mutation 内决定能否回收：

### 4.1 Attempt-backed 资源

必须能精确 join WorkUnit/Attempt，匹配 workUnitId、attemptId、runtimeInstanceId、fencingToken、workspace；Attempt 已为 terminal 且 ended_at 非 NULL，才视作已撤权的正面事实。

下列情况一律保 active：

- current 非终态，哪怕 heartbeat 很旧或 fixed expiry 已过；
- terminal 但 endedAt 缺失；
- owner/WorkUnit/Attempt 缺失，token/runtime/workspace 不匹配，或归属不可确定；
- 读取/SQL 失败，不能当 count=0 或 owner 不存在即安全。

不能把终态文本以外的可疑缺失条件（如 NOT EXISTS owner）加入 safe-release OR 分支。
不依赖先 read、后无条件 UPDATE 的可竞态判断。

### 4.2 Owner-level lease

只有 resource lease 的 ownerType 为 workflow_step/system，且 work_unit_id、attempt_id、runtime_instance_id、fencing_token **四列全 NULL**，才按其原 TTL 到期。
部分归属或带可疑 fence 的行不能借 owner-level 名字绕过检查。

runtime semaphore slot 没有 ownerless 旁路；即使 ownerType 写为 system，仍需精确 Attempt 的 terminal+endedAt 事实。

### 4.3 与原 lifecycle 的关系

replacement、required-input yield、approval suspension/terminal/deny 和 Run finally 的 exact release 保持原语义。
expiry 不清 journal blocker，不把未知物理结果变成 known_no_start。
普通 terminal helper 当前不含 lease/slot release；本次也不把多个 Store 调用夸成一个新的原子聚合接口。

本项的原子保证是：**heartbeat+两类 renew 同一写事务**，以及 **safe-expire 的精确 SQL 准入与 mutation 同一语句**。

## 5. acquire 与 startup/recovery

- semaphore 保留 BEGIN IMMEDIATE 下 safe sweep→active count→INSERT；申请方自身仍须 fresh current fence；失败 rollback/fail closed。
- resource 保留 fresh-fence INSERT 与 active unique index；current owner 不被 sweep 移出 active，因此新 owner 不可越过独占约束。
- Supervisor startup 与 Core stale-run recovery 将 sweep 移至现有 reconciliation 之后；先获得 workspace ownership 的 A31 保护不回退。
- 这一顺序调整不把现有多 Store reconciliation 调用声称为单一原子事务，也不以“先改调用顺序”替代 safe-expire SQL 本身。
- stale HB 仍 current 时，本项宁可继续阻塞；只有现有 authority 路径真正写出可验证 terminal+endedAt 或做 exact release 后，才合法复用。

## 6. 新专用 Core 测试与证据分类

新测试：`packages/core/test/runtime-resource-lifecycle.test.mjs`。

隔离方式：显式 `resolveStoragePaths(...homeDir: ownedDirectory, env: {}, workspaceStateLocation: repo-local)`，两个真实 Store connection 指向同一 owned SQLite 文件；不连接真实 App HOME，不用 Provider/Runner/网络，不睡6h。
peer 在业务行创建前打开，避免把构造器使用真实 wall clock 的恢复误当受控 test clock。

| 覆盖 | 具体断言 | 首跑分类 |
| --- | --- | --- |
| 长 wall time 滑动续租 | Core 受控审批等待状态序列跨9h，真实 expiresAt/lastRenewedAt，rival仍拿不到资源/slot | 原 heartbeat 接受 extra deadline，故可形成真实“expiry未延长”的行为 RED；不冒真实 UI 审批 |
| stale HB/current 到期 | created/started/waiting/cancelling 全部保 active，无自动 lost | 原 expiry 的真实行为 RED |
| direct renew 类型/期限 | 显式短窗口、单调性、终态拒绝、旧 string/非法对象拒绝 | 旧 dist 可能先 binding TypeError；只算新接口不支持，不能冒称终态逻辑已复现 |
| known revoked | terminal+endedAt 精确匹配后 expiry 数量正确，另一个 owner 才能获取 | 保留合法回收正例 |
| unknown attribution | missing Attempt/WorkUnit、错 token/runtime/workspace、缺 endedAt 保 active | 正面已撤权证据规则 |
| released/expired | direct renew=0；合法 HB 不重建旧资源 | 状态不复活 |
| replacement/late callback | old HB/renew/release 不碰 successor；当前 generation 的 overdue 行仍阻塞 | fence 不回退 |
| 两 connection 顺序 | heartbeat-first 与 acquire-first 两种实际提交顺序 | 是真实 SQLite 顺序覆盖，不声称同时 writer stress |
| trigger rollback | lease/slot AFTER UPDATE 真触发 RAISE，heartbeat/WU/Attempt/两类续租全回滚，去 trigger 后可重试 | 实际 trigger/事务故障，不 mock DTO counter |
| 时间验证 | 缺 deadline、非法/非规范日期、<=0或>6h窗口拒绝且无半写 | 新合同 RED |
| owner-level | workflow/system 四 NULL保TTL；部分归属/无精确Attempt slot不走旁路 | 旧设计边界回归 |

unknown/missing-parent 测试专门构造**损坏历史 fixture**：仅在该测试自己的临时 SQLite connection 上短暂关闭 foreign_keys 建坏行后立即恢复，以免先因 FK setup 报错而没有触达 expiry。
这不是产品更改、正常业务写入方式或关闭实际数据库的外键；合法行与正常 acquire/heartbeat/trigger 路径一直使用真实 Store/SQL。

现有 `channel-runtime-store.test.mjs` 的“abandoned slot”测试实际仍为 current+started、没有撤权，却要求按 TTL 复用，和新合同冲突。
Root 将其改为真实不同 owner 且旧 Attempt 合法 terminal+endedAt 后再回收，保 expired 数量/新容量正例，不删除正例，也不加旧接口 fallback。
所有旧 heartbeat fixture 与 direct renew string 调用的迁移由 Root 处理，本文作者不编辑旧 tests。

## 7. 验收与未决裁决

实施顺序：Root 全文读取/hash 新测试→原 dist 首跑并分类业务 RED/接口未支持/fixture错误→最小产品修复→fresh Core/Daemon build→专用 GREEN→原 runtime/yield/approval/media/startup 邻近回归→未实施产品者审阅→限定保存。
不能把首跑的接口绑定错误、setup错误或未运行的 authored 测试说成业务 RED；不能把 Core GREEN 冒作 E6/Office/packaged GUI 全量完成。

本设计接口及安全政策已由 Root 固定，**无剩余接口选择或新增用户决策**。
实施和限定验证已收口：Core 专用39/39、三 Host 入口3/3，最终七完整文件联合200/200，均 actual exit 0，零 fail/cancel/skip/todo；重叠组不累加。早期接口 binding 失败与 Host fixture 缺 objective 的 setup 失败保留且不算业务 RED。

未实施产品者窄审见 `output/e6-20260928/b011-resource-lifecycle-independent-review-20261016.md`，SHA `2d35121e4de3e77fb20b9667d347645bd773313bc37c543e508952779e3d0ae0`，`PASS_SCOPED_WITH_LIMITS`、无确认残留；Root 已全文读/hash。App 总验收仍待完成，主 CI 维持不查、不启、不等、不作为门槛。
`approved=false`。
