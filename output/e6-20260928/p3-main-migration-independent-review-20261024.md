# P3 main 整合：176 冲突迁移独立审阅

日期：2026-10-24。审阅者：`/root/p3_merge_migration_review`，未参与本次实现。

## 状态

**最终范围结论：DONE，第三遍候选无剩余已确认问题。** M1/M2/M3 均已修复并经独立隔离验证，最终字节和验证见本文末尾第三遍 addendum。下方前两遍记录仅保留发现、修复与哈希历史，不代表当前仍有这些问题。本报告不生成 `approved`，不批准正式发布。

只读生产源码；只在 fresh `LING_STACK_HOME` 下运行临时 SQLite 测试；没有打开 QA 数据库、启动模型、编辑源码/测试、创建或修改 `approved` 记录。

## 候选与覆盖

唯一实施树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。

- 分支：`codex/e6-safe-continuation`。
- 当前父 HEAD：`17af63ac1b3218731db506e03e13f469cc8a1874`。
- 正在整合的 `MERGE_HEAD`：`7bd33739852cec139822b33e12b4f8189b3964de`。
- 176 两种已知历史：main `create_work_summary_pull_requests`；E6 `durable_delegation_budget_authority_v1`。
- 新的 canonical marker：work summary 188、budget 189。保留真实旧 176，不改写旧 applied_at。

完整阅读两份迁移、三个指定测试文件。阅读 `sqlite-run-store.ts` 的迁移调用、事务/关闭及 marker 写入相关链路；核对旧 main work-summary 176 的真实建表 SQL、E6 原预算迁移差量、`helpers.ts` 回滚逻辑和 delegation 154 的既有数据校验作为对照。没有声称完整阅读 6,436 行 RunStore 或整个 Daemon。

第一遍原始字节 SHA256：

| 文件（相对实施树） | SHA256 |
| --- | --- |
| `packages/core/src/storage/sqlite/work-summary-migration.ts` | `8a527f9ecec5dbcdb3e88b558ae9b1846df003b9b0ba0e60c1bae90ebd4ee935` |
| `packages/core/src/storage/sqlite/delegation-budget-migration.ts` | `f378bcf0fc04d3c08b20e9325854bd7a67593429287bb74f87b0e38606c2cc22` |
| `packages/core/src/storage/sqlite-run-store.ts` | `fc2acad505fb7ef5275bb3b19176e0fa960bb1ce9aac823c220b80391b65524d` |
| `packages/core/test/delegation-budget-migration.test.mjs` | `3d1cf9f1e1213c9ccaf6a562782ce632f864bc2e6f53b02387c7853364d58cbd` |
| `packages/core/test/delegation-migration.test.mjs` | `9545531bb21133030ec29dfd8e58596ffffd0b8e30f4a59684e97801cc4a8b0d` |
| `packages/core/test/work-summary-store.test.mjs` | `2766220d218359e9d9270d40c48221be7f8896bbd5bc9ec286db7af5ce3c8c50` |

## 确认问题 M1：旧预算坏数据仍被追加 canonical 189

位置：第一遍 `delegation-budget-migration.ts:161-175,208-212`。`assertData` 仅调用各表 `foreign_key_check`，不验证已有 CHECK 违规，也不检查跨 Run/Attempt/Reservation 的持久归属关系。迁移能在 schema 精确且 FK 全部有效、但预算事实非法时追加 canonical 189；补回缺失的 lineage trigger 也不会检查已有行。

这是对历史数据的错误准入，不是说本修复主动修改了余额或审批，也不是通过本测试证明正常工具能够绕过 SQLite guard。复现只在临时库主动注入损坏数据，目的是验证启动迁移承诺的 fail-closed 边界。

独立复现 1（Node v24.15.0，真实 SQLite，命令 exit 0 表示探针成功观察到缺陷）：

1. 建与 `delegation-budget-migration.test.mjs` 相同的 FK fixture，先安装 delegation 154、budget 189。
2. 仅在临时库将此预算 marker 的 version 改为 176，模拟已有 E6 历史。
3. 建立存在的 root Run 和 authority artifact；临时 `PRAGMA ignore_check_constraints=ON`，插入 `token_budget=-1` 的 root 行，然后立即恢复为 OFF。其余字段合法。
4. SQLite `PRAGMA integrity_check(delegation_root_budgets)` 确认 `CHECK constraint failed in delegation_root_budgets`。
5. 调用 `applyDelegationBudgetMigration`。

实际输出：

```json
{"probe":"legacy176-invalid-CHECK-data","integrity":[{"integrity_check":"CHECK constraint failed in delegation_root_budgets"}],"result":true,"canonical":{"version":189,"name":"durable_delegation_budget_authority_v1","applied_at":"2026-10-19T00:00:00.000Z"},"preserved":true}
```

独立复现 2：同样先装精确 schema 并将 marker 转为历史 176。建立 root Run（work_unit_id=`root-work`）和真实 Attempt（work_unit_id=`wrong-work`）。临时移除 `trg_delegation_budget_charges_lineage`，插入引用该错误 Attempt 的 charge，保持所有 FK 均存在和所有列 CHECK 合法；调用迁移。

实际输出：

```json
{"probe":"legacy176-invalid-charge-lineage","result":true,"canonical":true,"lineageRestored":true,"badCharge":{"attempt_id":"wrong-attempt"}}
```

期望：两种损坏都拒绝，原 176 和原数据不变，不追加 189；如在事务中修复派生 trigger/index，失败时回滚此次修复，保留原损坏现场。后续修复需覆盖 canonical 重开和 legacy176 adoption 两条路径。

### 持久字段不变量建议

不要直接重用 INSERT trigger 的临时条件：合法历史在执行后不再是 `step.state='spawning'`、`child_run_id IS NULL`、parent reservation `state='reserved'`。应检查运行推进后仍成立的关系：

- charge 的 Run 与 Attempt 属于同一个 WorkUnit；无 reservation 的 charge 是 root 自身；带 reservation 的 charge 与其 root、child Run 一致。
- reservation 与 delegation step 的 root、parent/child Run 和 parent delegation/reservation 链一致，不形成自指或环；期限不超过 root/父 reservation；已绑定 child 不得串到其他分支。
- root/charge 的 authority、price artifact/digest 成对约束及数值、时间、state 的 SQLite CHECK 均有效。
- 不因合法的 `settled`/`released` 状态拒绝历史；不靠重新运行工具、重算余额、改写历史来修复。
- 任何检查失败均不更改旧 marker、预算行或审批事实。

## 非数据损坏观察 M2：未知 176 的拒绝发生较晚

第一遍按公开调用顺序先 summary、后 budget，临时库已有 `176/unknown_owner` 时，summary 仍先建立表并提交 188，之后 budget 才拒绝。实际输出：

```json
{"probe":"startup-order-unknown176","budgetError":"delegation.budget_migration_marker_conflict","markers":[{"version":154,"name":"create_delegation_tree_v1"},{"version":176,"name":"unknown_owner"},{"version":188,"name":"create_work_summary_pull_requests"}],"summaryTable":true}
```

未知 176 原记录没有被删除或覆盖，且整个启动拒绝；因此不将其夸大为预算/审批损毁。为了满足未知 176 应先拒绝的明确要求，建议 summary marker 前置只读核验 176 的已知 owner。保留各迁移独立原子事务，无需把全套旧迁移套进一个大事务。

## 第一遍已验证正常与异常行为

- main176 已有 PR binding 保留，追加 188/189，并可重开幂等。
- E6 budget176 已有 root 行和表定义保留，不重写 176/applied_at，追加 189 幂等。
- 新建库和 schema153 通过实际 `createSqliteRunStore` 走到 189；native169–175、历史 Run/Artifact、原 marker 保留。
- canonical owner 冲突、name 出现在未知 version、已记录但缺表、schema 缺 NOT NULL 均拒绝。
- fresh DDL/record callback 失败回滚；canonical record 失败保留原176；嵌套 BEGIN 失败不会回滚调用者持有的事务。
- 没有发现本次修复主动更新预算余额、价格、权限/审批事实的 SQL；旧 schema 154 的持久 guards 未被改写。

独立执行的命令（所有环境变量在 Node 启动前设置，三个测试文件实际共 55 个 case，含子测试）：

```sh
p3_review_root=$(mktemp -d /private/tmp/ling-e6-migration-review.XXXXXX)
mkdir -p "$p3_review_root/state" "$p3_review_root/workspace"
LING_STACK_HOME="$p3_review_root/state" \
LING_STACK_DEFAULT_WORKSPACE_CWD="$p3_review_root/workspace" \
LING_WORKSPACE_CWD="$p3_review_root/workspace" \
node --test packages/core/test/delegation-budget-migration.test.mjs \
  packages/core/test/delegation-migration.test.mjs \
  packages/core/test/work-summary-store.test.mjs
```

实际：**exit 0；55 tests / 55 pass / 0 fail / 0 skip**。本次读取确认相应 dist 为本候选逻辑；未自行重构建共享 dist。探针不是新回归测试，报告不能用这 55 个通过来掩盖上面 M1 的独立失败观察。

## 未覆盖与下一步

此报告只覆盖 176 冲突迁移及相邻持久化边界，不是整个 main 合并冲突审查、Office 内容审查、GUI/模型测试或发布批准。等待主代理修复 M1、M2 后，重新绑定实际哈希并复核受影响测试和两条探针；此前不得把本报告记为无问题通过。

## 第二遍复核：M1/M2 已关闭，另有 M3 预留上限漏检

本段取代第一遍的当前缺陷状态，但保留原始观察和哈希供追溯。**尚非最终通过：M3 待修。**

修复后完整重读两份迁移及预算测试；复查运行时三个 mapper、真实预算 Store 的 freeze/prepare/reserve/容量校验和 fixture，核验新纯类型 binding 文件。`sqlite-run-store.ts` 的 binding 依赖为 `import type`，输出 JS 没有相应 runtime import；本报告不替代该 binding 提取的完整独审。

第二遍候选 SHA256：

| 文件（相对实施树） | SHA256 |
| --- | --- |
| `packages/core/src/storage/sqlite/work-summary-migration.ts` | `1b48d6b16f1c6f243b8ffa385b661081f0fda46d8d94fe1b7e1fb897c22a10d5` |
| `packages/core/src/storage/sqlite/delegation-budget-migration.ts` | `3f5d1f62f7dad11d7ff2c62d65f822ee84d3193481a687a3f0ed6f91678d3b58` |
| `packages/core/src/storage/sqlite-run-store.ts` | `1e36bb717a8df454bab8352fd587cb7c606fa35f2e9459a5f2b91339e133f913` |
| `packages/core/test/delegation-budget-migration.test.mjs` | `b8ebf1b458968bed69cb334ff03e1a78941f88e27d2791ff202f981ee226de58` |
| `packages/core/test/delegation-migration.test.mjs` | `9545531bb21133030ec29dfd8e58596ffffd0b8e30f4a59684e97801cc4a8b0d` |
| `packages/core/test/work-summary-store.test.mjs` | `2766220d218359e9d9270d40c48221be7f8896bbd5bc9ec286db7af5ce3c8c50` |
| `packages/core/src/storage/sqlite/delegation-budget-rows.ts` | `d8dff558da289323eb1a7d998cee0e901e110fa298fa0b0c31d7b647f9dc49d2` |
| `packages/core/test/support/delegation-budget-fixture.mjs` | `e854b7b3384d79db4846b31d6b1f5f58f591416cdaf821e5cae58cc8282e738e` |
| `packages/core/src/delegation-host-store-binding-types.ts` | `df82edd51005b8f7edb263cca16eb86af42a45f8084b5ee0b6459272f7345dbb` |

独立执行与第一遍相同的三文件命令，fresh 根目录改为 `/private/tmp/ling-e6-migration-review-final.XXXXXX`：**exit 0；63 tests / 63 pass / 0 fail / 0 skip**。实际覆盖：legacy176/canonical189 各三种坏历史、missing derived object 修复回滚、合法 nested grandchild released + child settled + measured charge。没有把实现者五文件 111/111 计作本审阅者独立执行。

### 已关闭

- M1：三个 runtime mapper、每表 integrity_check/FK 和持久跨表 lineage 已进入 migration 的 adoption 与 canonical 重开两条分支；新增六项损坏测试实际通过，保留坏现场并回滚派生对象修复。
- M2：work-summary 的第一次 marker 读取已包含 `version=176`；只放行两个已知 owner。未知 176 在建表/事务前即拒绝。
- 合法历史不再套 INSERT 时的 spawning/reserved 条件，真实嵌套终态测试通过；root/child/authority owner、Attempt WorkUnit 归属、新旧 marker 幂等和现有 schema153 公共入口仍通过。

### M3：预留值可超过其不可变 root/parent allocation

位置：第二遍 `delegation-budget-migration.ts` 的 reservation/charge lineage SQL。reservation 只验证 `b.token_reserved IS s.token_budget` / `cost_reserved_micros IS s.cost_budget_micros`，未校验这些值相对 root 或 parent reservation 的冻结上限；charge 对其 root/reservation allocation 也未校验 reserved 数值上限。runtime Store admission 明确禁止这种预留，不是合法 Provider 实际用量超额。

独立真实 SQLite + Store 探针：

1. 用 `createBudgetHarness` 在 fresh 临时 cwd 创建真实 root（tokenBudget=100）、freeze 并 start。
2. reservation 情形先真实 `spawn()`，仅在临时库保存并暂移该表原 triggers，一致把 step.token_budget 和 reservation.token_reserved 改成 200，再逐条恢复全部原 trigger SQL。charge 情形真实 `charge()` 后同样暂移/恢复原 triggers，仅改 reserved_tokens=200。
3. 保持所有 CHECK、FK、状态、归属、原 trigger 字节均合法；将预算 marker189 转为历史176，调用迁移。

可靠探针命令 exit 0，实际两条输出：

```json
{"fault":"reservation-cap","result":true,"rootCap":100,"canonical":true}
{"fault":"charge-cap","result":true,"rootCap":100,"canonical":true}
```

第一次注入探针因只暂移 immutable trigger、未处理原 step revision guard 而在造坏数据阶段被拒绝（exit 1）；它没有运行到迁移，不作为缺陷证据。之后改为临时保存/暂移/恢复目标表全部原 triggers，完成上面的有效复现。没有改生产源码、测试文件或真实库。

建议补：每条不可变 reservation 的 token/cost 预留不超过 root 和对应 parent allocation；已定义上限时不能用 NULL 逃逸。charge 的原始 reserved token/cost 同样受对应 allocation 上限约束。两种 marker 均验证、拒绝时保留原现场。**不要因 measured input/output/actual cost 高于预留而拒绝历史**，这可由真实 Provider overrun 产生；也不要简单累计所有历史 reservation 而把合法顺序复用的预算重复计算。

## 第三遍最终 addendum：M1/M2/M3 关闭，范围内无剩余确认问题

**结论：DONE，0 项剩余已确认问题。** 此结论绑定以下最终字节和指定范围，不替代整个合并、Office 包、模型或 GUI 验收，不修改批准文件。

HEAD 和 MERGE_HEAD 仍为首段记录的 `17af63ac1b3218731db506e03e13f469cc8a1874` / `7bd33739852cec139822b33e12b4f8189b3964de`。审阅前后重新读回相同 SHA256，没有以第一遍或第二遍字节替代第三遍候选。

| 最终审阅文件（相对实施树） | SHA256 |
| --- | --- |
| `packages/core/src/storage/sqlite/work-summary-migration.ts` | `1b48d6b16f1c6f243b8ffa385b661081f0fda46d8d94fe1b7e1fb897c22a10d5` |
| `packages/core/src/storage/sqlite/delegation-budget-migration.ts` | `c8a1a2bd0f4f5487fa0bee1a145110f367da1ef97bf3212434e77dbe834878d3` |
| `packages/core/src/storage/sqlite-run-store.ts` | `1e36bb717a8df454bab8352fd587cb7c606fa35f2e9459a5f2b91339e133f913` |
| `packages/core/test/delegation-budget-migration.test.mjs` | `24a572b434d3eb4ffe4f25cd38a69ea4f85e0210565bbf8a0827e054cbbd3d07` |
| `packages/core/test/delegation-migration.test.mjs` | `9545531bb21133030ec29dfd8e58596ffffd0b8e30f4a59684e97801cc4a8b0d` |
| `packages/core/test/work-summary-store.test.mjs` | `2766220d218359e9d9270d40c48221be7f8896bbd5bc9ec286db7af5ce3c8c50` |
| `packages/core/src/delegation-host-store-bridge.ts` | `eb4cee8804af907ffe72caa658c4ebf29fd25aa4bd311aeeea6a07e18de93570` |
| `packages/core/src/delegation-host-store-binding-types.ts` | `df82edd51005b8f7edb263cca16eb86af42a45f8084b5ee0b6459272f7345dbb` |
| `packages/core/test/delegation-host-store-bridge.test.mjs` | `2c5bb54cda95968d2c9bcfdeaa618bc8337c770a994d99d47f19124f5ba81261` |

复用且已读的纯 mapper/fixture 字节仍为第二遍表中的 `d8dff558...` / `e854b7b3...`。两份迁移已完整阅读；预算测试的新增内容已完整阅读，其他两份迁移测试原始字节未漂移。三个 binding 文件的本次 type-only 提取已完整读差量和新目的文件，完整阅读 159 行 bridge 与 4 行 types 文件；RunStore 依旧是相关调用链与差量审阅，不声称全文覆盖整个大型文件。

### M3 修复核对

- `within(value,limit)` 对受限 allocation 同时要求非 NULL 且不大于上限；root/parent 的 token 与金额预留均用同一表达式。无限上限仍允许真正未限制的维度。
- reservation 与 step 的预算值继续一致，且同时受 root 和 parent 的冻结 allocation 限制；charge 受 root 或对应 reservation 的原始预留限制。子 allocation 的 root 限制通过已验证 reservation 链传递。
- reservation 的创建不早于 root 冻结，期限不超过 root/parent；charge 的创建不早于冻结且早于 root/child deadline。金额预留依赖 root price，价格引用与 root 的固定 artifact/digest 匹配。
- 不读取瞬时 spawning/reserved 状态判定历史是否合法，不对所有历史 allocation 简单求和，也不将真实 measured usage 超额改成坏历史；没有增加余额“修正”、重新执行、审批绕过或历史重算。
- M1/M2 的异常拒绝、原 marker/坏数据保留、修复派生对象的回滚与 caller-owned 事务边界继续通过。

### 独立实跑与额外探针

所有 Node SQLite 测试均在进程启动前设置 fresh `LING_STACK_HOME`、`LING_STACK_DEFAULT_WORKSPACE_CWD`、`LING_WORKSPACE_CWD`，不使用 QA profile。

1. 三文件完整命令与第一遍相同，临时根目录为 `/private/tmp/ling-e6-migration-review-closed.XXXXXX`：**实际 exit 0，69 tests / 69 pass / 0 fail / 0 skip**。含新六项 root/parent reservation over/NULL、root charge over/NULL；同时保留坏历史六项、合法多层 terminal ledger、公共启动/旧历史/幂等/回滚测试。
2. 额外独立执行 `node --test packages/core/test/delegation-host-store-bridge.test.mjs`，临时根目录 `/private/tmp/ling-e6-binding-review.XXXXXX`：**实际 exit 0，9 tests / 9 pass / 0 fail / 0 skip**。核验假 JSON token、过早 writer 读取、重用 constructor owner、close 后缓存 accessor/method、authority function 替换、真实 claim replay 以及 suspension mutation custody。
3. 用实际 Store fixture 创建 child allocation=40，再在临时库保存/暂移/恢复 charge 原 triggers 后注入 `reserved_tokens=41`：迁移拒绝，markers 完全保留。该分支验证的是 child allocation，而不是仅 root 上限。
4. 用实际 Store writer 记录 root cap=100、reserved=20、真实 measured=130 的超额用量，转为 legacy176 后成功 adoption，第二次 canonical 重开返回 false。证明本次修复没有把合法 Provider overrun 当作迁移损坏。

第 3、4 两个最终额外探针在同一 fresh 命令中 **实际 exit 0**，输出：

```json
{"fault":"child-charge-over","result":"rejected","markersPreserved":true}
{"fault":"measured-overrun-allowed","result":"accepted legitimate measured=130 reserved=20 cap=100"}
```

补充探针的首次 child setup 因尚未把真实 step 绑定为 running 而被 Store 的 `delegation.lineage_invalid` 拒绝，未运行到迁移；纠正 fixture 为与已通过 nested 测试相同的绑定后，上面第 3、4 项才完整通过。首次命令里最后的 shasum exit 0 不被冒充为前面失败 Node 的成功。这是探针准备问题，不是产品缺陷或通过证据。

实现者的组合日志 `p3-main-ledger-cap-green-20261024.log` 被读回显示 118/118，但本审阅者没有消费其进程句柄，不把该日志替代上述独立实际退出。

### 纯 binding 类型提取的独立内容审阅

本次 delta：将 bridge 内的私有 `unique symbol` brand + `DelegationHostStoreBinding` interface 移到只含类型的新文件；bridge 通过 `import type` / `export type` 维持原类型入口；RunStore 对类型使用新入口，运行时仍从原 bridge 导入 `captureDelegationHostStoreBinding`。

已核对 WeakMap、owner、retired、captured readers、install 和 writer accessor 的运行时主体不变。采用 Node v24.15.0 内置 `stripTypeScriptTypes`（transform 模式）独立比较：bridge 的 HEAD 与当前候选剥离类型后完全相同；RunStore 的当前候选与只还原旧组合 import 的版本剥离类型后完全相同；新 types 模块无运行时输出。

实际命令 exit 0，输出：

```json
{"method":"Node v24.15.0 stripTypeScriptTypes transform","bridgeRuntimeEqual":true,"bridgeTransformedSha256":"d1d8509039b5c522cca089d6f08d293957f72deb53f19cab17c02c602222a500","runStoreTypeExtractionRuntimeEqual":true,"typeModuleOutput":""}
```

最初尝试 TypeScript compiler API 时，项目 `typescript@7.0.2` 主导出只有版本接口，不提供 `getParsedCommandLineOfConfigFile`，该尝试实际 exit 1；没有下载依赖或改锁文件，改用上面的 Node 内置实现完成比较。该比较与 custody 9/9 互相补充，不以纯类型文件名替代运行时归属证据。

### 最终边界

此次范围内原 M1/M2/M3 全部关闭，无剩余确认缺陷。没有对真实历史做任何更新，没有生成/更改 `approved`，没有宣称整个 E6、Office 最新包装、真实 GUI、模型预算或 PR/合并目标已完成。此 addendum 可作为本次指定 migration 与 pure-binding delta 的独立内容审阅输入，是否应用 QA 审核记录由原工作流处理。
