# A28 Core runtime CAS implementation boundary

状态：source-only 实施记录；不代表构建、测试或 A28 验收通过。

`getTeammateDirectMessageRuntimeObservation(scope)` 是可嵌套 `readSnapshot` 的只读入口。
`commitTeammateDirectMessageRuntime({expected, operation}, now)` 自行开启短
`BEGIN IMMEDIATE`，在 `readSqliteWithinTransaction` 中序列化输入并重读 owner、source、
Turn/Run link、WorkUnit、Attempt fence、checkpoint proof 与 RunEvent 水位。
调用方不能传 SQL、predicate、状态白名单或任意事务 callback。

`operation.kind` 为三种固定权限：

- `pre_dispatch`：只允许真正未派发消息的 pending 进度或 blocked 配置阻断。
  null linkedRunId 不是充分条件；Core 也定点检查该消息已创建的 WorkUnit。
- `execution`：只允许 current active owner 的 pending 写入和首次绑定；必须携带捕获的
  完整四元 fence。lost、yielded、terminal 或被接管后，旧回调没有写权限。
- `reconcile`：active/logical_wait 只能 pending；indeterminate 不可写。
  terminal failed/cancelled 只能对应原结果；succeeded 根据同 Run 持久叙述与媒体事实，
  只允许 ready 或真正 empty-result failed。本地化错误正文不算成功叙述。

取消的窄边界：

- Run-less standalone WorkUnit 取消可传 `scope.workUnitId`，但必须是真实 cancelled、
  有 endedAt、native source/thread/request/input snapshot/canonical Turn 归属闭合。
  没有 Attempt 时 attemptCount 必须为零；存在 Attempt 时必须是匹配完整 fence 的
  durable cancelled Attempt，lost 本身不是取消证明。
- committed user-input wait 取消保留原 Run/Attempt 的 yielded 状态；必须同时验证
  immutable checkpoint、wait cancelled、WorkUnit cancelled 和其专用 cancellation audit。
  不新增宽松 cancelling、abort 或错误字符串分支。

稳定 observation fingerprint 包含消息原值、link、生命周期、source fingerprint、
Attempt 身份、proof revision/审计及最终 RunEvent identity/seq，排除 heartbeat 时间。
事务内条件 UPDATE 再核 scope 与原消息字段。同值返回 unchanged，不改 updatedAt，
不重复 invalidation；stale 不自动将旧 patch 重放到新 Attempt。

Core 不发送 SSE 或 control-plane invalidation；Daemon 仅对 applied 发布已有私聊通知。
GET 只读。审批/yield proof 缺失或损坏不补造等待，也不释放资源。

旧 updater 仅保留兼容 API；A28 全部产品 caller 必须迁移到新边界。原设计验收矩阵和
主代理独占构建/测试约束保持不变。

## Approval continuation 完整持久链补充

已复现边界：原 approval basis 固定指向 A；首次 claim 建立 A→B，B 在
`resume_pre_dispatch` 原子暂停后再次 claim 建立 B→C。当前 handle 已指向 C，
Run/WU/C 均 succeeded，但只接受 `sourceAttemptId === basis.priorAttemptId`
会错误拒绝 B→C，导致原消息保持 pending。不得改写 basis 或删除严格条件。

新增独立只读 chain proof helper，仅供 terminal approval continuation 校验：

- 从当前 C 沿唯一 `target_attempt_id` 前驱回溯到 immutable basis 的 A；最多 64 跳。
  全局重复前驱、缺链、环、异 Run/WU/runner/context、非连续 attemptNumber、
  非递增十进制 fencingToken 均 fail-closed。generation 不是跳数，不能要求逐跳递增。
- 每跳必须为同一 approval 的 deterministic replay continuation；精确核对
  `runner-continuation:<run>:<source>:approval_resume:<generation>:<approval>`
  idempotency。最新 continuation 仍必须与当前 terminal Run 同结果；中间只允许
  prepared/claimed/running/recovery_pending，不预放将来的 superseded 或其他 terminal。
- 每跳读取 SQLite sealed replay artifact，不访问 artifact 文件；核 content digest、
  replay fingerprint、同 Run/WU/context/runner、完整 source fence，及唯一 approved
  approval evidence 的 approvalId/sideEffectFingerprint。此处只验证 Core 消息归属所需
  的持久子协议，不把 Daemon 的完整 runner input parser 迁入 Core。
- 每个非根 source（如 B）必须真实 lost/runtime_suspend/endedAt，sealed priorAttempt
  也必须一致；同 full fence 的唯一 work_unit_stale audit、同 checkpoint 的唯一
  resume_pre_dispatch control-plane commit 必须同刻。commit 中旧 revision 必须是
  安全整数、低于当前 checkpoint revision，并沿链单调；不能用当前 revision-1
  猜历史暂停。拒绝 source 的 durable tool_start 或无法归属的 tool_start。
  writer 的 suspension gate 和 reader 的历史链 proof 使用相同效果边界：归属必须是
  非空文本；缺失、null、number、array、object、空串或仅空白均属于未知效果，
  不能因不等于某个 Attempt ID 而被放过。明确归属其他 Attempt 的 start 不阻断本跳。
- 原 checkpoint/basis/approval/side effect/current handle C 的现有校验全部保留。
  frozen feature snapshot 为 continuation enforce、或本 Run 已有 approval continuation
  时，缺当前 target continuation 不能借空数组走 legacy 分支；真正非 enforce 且无
  continuation 行的旧路径保持原行为。
  整条链的 continuation、source identity、sealed digest、audit、commit 纳入 observation
  witness，writer 在同一事务重读，链变化会使旧 observation stale。

验证分工：新增 Core proof 正/负例覆盖链完整与破坏，原两组六例不修改；真实 SDK
恢复和原消息 ready 仍由 Daemon 集成测试证明。实施者 source-only，不执行 build/test/Git/CI。

实施纠错及已取得证据：新 helper 首版误选 `control_plane_events.id`，但该表只有
`seq` 主键。对 Root 保留的真实 SQLite 只读查询明确报 `no such column: id`，因此
合法链在读取审计提交时抛错，被观察入口保守判为 indeterminate。Root 仅移除此
不存在的列后，新增 7 项归属负例均先通过真实 Core terminal 链前提，随后实际
2 pass / 5 fail，证明 number/array/object/empty/whitespace 会被旧 NULL-only
reader 漏过。Root 随后只把 reader 的效果归属谓词与 writer 对齐，并独占重新构建
和完整验证；此记录不预先宣称完整回归已通过。

未决策项：无。超过 64 跳是显式 indeterminate，不自动压缩或改写历史证明。
