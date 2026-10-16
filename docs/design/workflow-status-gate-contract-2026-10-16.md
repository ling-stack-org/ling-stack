# B-008：Workflow 等待状态与 gate 限定不丢失

日期：2026-10-16
状态：三处产品最小修复已实施。首 RED 31 项 16 pass / 15 fail、actual exit 1；
fresh Core/Daemon build actual exit 0，五完整文件最终 144/144 actual exit 0、零失败/取消/跳过。
未实施者窄审 `b008-status-gate-independent-review-20261016.md` 无确认阻断，approved=false；不是 App 验收。

## 根因和边界

- `workspace-types.ts` 的 Workflow / Step union 已包含 `waiting_for_input`，但对应 runtime
  arrays 缺少该值。状态机和真实 `commitUserInputYield` 支持此状态，GET query 及 custom
  template parser 却依赖漏值数组而拒绝合法值。
- graph gate parser 使用没有 allowed whitelist 的 string-array reader；编译后将 gate 直接
  写入 step metadata。Core mapper 遇到未知列表，或漏值数组拒绝的合法 waiting 列表时，
  把 `requiredForStatuses` 变为 `undefined`，但仍保留 gate。
- orchestrator selector 把 absent 当 any；实际 post-gate 调用传入 `succeeded`。因此
  waiting-only / unknown 列表可能变为 succeeded 后额外审批、阻塞，而不是准确的原限定。
  目前只确认这条静态链，不声称日常数据库已发生误审批或权限绕过。

## 最小完整合同

| 列表输入 | HTTP graph / custom template | 持久化读取 | selector 原语义 |
| --- | --- | --- | --- |
| 未提供 / undefined | 接受，保持未提供 | 保持未提供 | any-status（保留原行为） |
| `[]` | 接受并保留 | 保留 `[]` | matches-none（保留原行为） |
| 全部为合法 Step 状态的数组 | 接受，包含 `waiting_for_input` | 原样保留 | 仅匹配所列状态 |
| unknown / 空字符串 / mixed / null / scalar | 拒绝，无编译写入 | 显式 invalid-record 错误，中止读取/编排 | 不允许退化为 any，不丢 gate |

1. runtime arrays 与 union / state machine 的合法闭集一致；非法 GET status 仍拒绝。
2. graph 与 custom template 使用同一 Core Step 闭集，不建立第二份产品枚举。
3. mapper 区分 absent 和 present-but-invalid。最小实现可在非法 present list 时抛出可辨识的
   `workflow_step_gate_statuses_invalid` 错误；不通过丢整 gate、过滤未知元素或用空数组
   掩盖损坏。调用者不得捕获后继续当作无 gate 编排；合法数据读取不改变。
4. 本项不改变 post-gate 触发时机：目前只在成功收尾时按 `succeeded` 选择；保留 waiting-only
   列表不等于实现“等待输入时触发 post 审批”。不放宽 PATCH 任意状态，也不替代 Host
   yield / answer 的原子协调。
5. 不改 pre gate、autoStart 或其确认策略（B-013）；不扩 lease（B-011），不增加表，不修改
   历史数据。坏记录保持显式故障，不自动猜测修复。

## Test-only 冻结

`packages/daemon/test/workflow-status-gate-contract.test.mjs`：

- 独立、显式 repo-local SQLite 路径；不读取真实 HOME、凭据或模型。只使用本地 fixture
  runner，没有真实网络请求或真实 App/Daemon 服务。
- 完整 runtime 闭集及 GET query 正/反例；真实 Core request + Host yield 后 Step 为 waiting，
  再通过合法 workflow 状态迁移建立 parent waiting，走真实 GET collection handler。
  此例不声称 Host yield 自动聚合 parent workflow 状态。
- graph / custom template 合法 waiting、完整合法数组、absent、empty；非法 unknown / mixed /
  null / scalar 一律在 parser 拒绝，不能进入 compile。
- 实际 parse → compile → SQLite reopen 保留限定；运行真实 `executeRunRequest` 生命周期，
  fixture runner 实际读取隔离文件并发出 read 事件，Host 产生 succeeded Run，再由真实
  `finalizeOrchestratedWorkflowStepRun` 检验 waiting-only / empty 不产生 post approval，
  absent / succeeded-only 仍产生原 post approval。
- 测试拥有的 raw SQLite 故障注入仅用于 malformed persisted 列表。真实终态后注入，get 与
  finalizer 必须显式错误，审批 / 状态 / artifacts / ledger 零新增，重开仍拒绝；不修改日常 DB。

Root 已确认首 RED 为目标行为而非 setup，再实施产品、执行 fresh build / GREEN / 邻近回归，
并完成未实施者限定审阅。原始 RED 保留，测试与设计不是 Office approved。

## 实施范围与未决项

预期产品边界只涉及 Core runtime arrays、Core gate mapper 和 Daemon graph parser。Query / custom
template 已依赖共享枚举；selector 的 absent / [] 语义不需要改写。不向大型 orchestrator 文件
添加新流程。既有大 types / mapper 的模块规模是存量风险，不借本项扩重构。

无新用户决策。坏记录恢复 UI / 自动迁移不属于本项；必须保持可观察错误，不能为了“可用”静默
扩大状态范围。B-008 完成不等于 B-011 / B-013、全量内容审阅或 packaged GUI 验收完成。

独审边界：Store get/list 和 finalizer 遇坏限定会显式抛错、停止后续编排；部分既有 detached
starter 会消费终态回调的 reject，尚不能保证所有后台路径都把该错误通知 UI。
这不是按无 gate 继续执行，但后台诊断/通知仍须在总计划中跟踪，不能以本项 GREEN 宣称已覆盖。
