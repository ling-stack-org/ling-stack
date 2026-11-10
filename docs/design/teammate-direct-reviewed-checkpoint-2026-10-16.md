# A28 私聊逻辑暂停与持久恢复检查点

日期：2026-10-16。基线：A27 `d1f1c05caf26a5fbb5ad2b1190cee629253e7785`，
其父为已合并 #551 的 `da396aaf35c5ebe8302ff2fb33ef483676f02e00`。
本记录不是 E6 完成、Office approved、发布批准或真实 macOS App 验收。
主 CI 按用户要求不查询、不启用、不等待、不作为门槛。

## 实现边界

- Core 专用 observation/CAS 事务核对 native owner、canonical source、input snapshot、
  Turn/Run/WorkUnit/Attempt 与持久 proof；unchanged 不重复写入，stale 不向 successor 重放。
- 物理 Runner 返回不再直接结束逻辑回复。真实审批暂停保持原 message/Turn pending；
  恢复成功后在同一消息收尾，空结果明确失败，未知事实不伪造成功。
- live、GET、terminal、startup recovery、denial 和 preflight shutdown 共享生命周期规则；
  GET 保持只读，刷新通知使用已有 runs domain。
- ready producer 必须携带自身完整 source fence。旧回调、损坏投影与缺失 fence 不借最新
  observation 的权限更新 successor。
- 审批 continuation 按完整持久前驱链回溯 immutable basis，最多 64 跳；拒绝缺链、环、
  歧义和未知 effect。safe suspension writer 与 chain reader 都拒绝非文本或空白 Attempt 归属。
- prepared continuation 在异步 preflight 前绑定真实 claimed target/fence；未派发的 shutdown
  只能经 Core 原子核验后安全暂停。没有新增表、通用事务 callback 或宽松兼容旁路。

大型现有文件仅接线，验证与 proof 集中在专用小模块。默认私聊 HTTP 仍未 opt-in required
user-input yield，公开 answer 仍返回 409；内部 yield proof 测试不代表公共问答续跑已完成。

## Root 实际验证

全部使用隔离 HOME/workspace/SQLite 与 deterministic fixture，不调用真实模型、真实凭据、
Keychain 或日常数据库。fresh Core 与 Daemon TypeScript 构建均 actual exit 0。

| 完整文件组 | 结果 | output/e6-20260928/a28-20261016/ 原始日志 |
| --- | --- | --- |
| Core admission / proof / committed private yield 三文件 | 64/64，exit 0 | core-full-boundaries-postfix.log |
| Daemon 暂停、恢复、live settlement、projection、owner 五文件 | 40/40，exit 0 | final-postfix-focused.log |
| 审批与私聊九个邻近文件 | 187/187，exit 0 | final-approval-private-neighbors-postfix.log |
| Core private input/yield 邻近文件 | 73/73，exit 0 | core-private-yield-neighbors.log |
| 当前 Desktop authored source 输入 | 408/408，exit 0 | desktop-current-source-inputs.log |

各组均零 fail/cancelled/skipped/todo，不累加重叠组。未运行整个 Daemon glob。
Desktop 首个 stale-dist 用例使用真实 esbuild，但 native/compiler/signing/verify 为 synthetic；
fail-before-build 用例未调用这些步骤，artifactExecuted=false。不是新包或真实 GUI 验收。

真实 RED 保留：原 message 在暂停时被错误 failed；延迟 ready 借 successor fence；
完整 A→B 安全暂停→C 成功后原消息仍 pending；非文本/空 Attempt effect 错误允许安全暂停。
chain 首次七例因合法前提失败不计业务 RED，修正 SQL schema 后的 2 pass/5 fail 才计。
邻近首次 186/187 的唯一失败为旧 test fixture；仅修合法 waiting_for_approval、approvalId 和
严格 CAS stub，保留原 HTTP/approved/deferred/invalidation 断言，完整重跑 187/187。

## 冻结与证据

34 项最终输入清单 `final-runtime-inputs.sha256`：
`4cc409c1bc78d78652ddeb776147f7ed7ba349db0981b5fa7d5574156b24277c`。
Root 校验 34/34 一致；本检查点文档随后另行保存，不冒作此前编译输入。

| 原始日志 | SHA-256 |
| --- | --- |
| core-full-boundaries-postfix.log | 14d380d8cc77f0823e36eed959b9991ff39c360e290d958aceb8249fb77fcc30 |
| final-postfix-focused.log | 1c71c013e773168badbca720afa5293dbf2c4547c1f7d6c8c3a5670b26f8d412 |
| final-approval-private-neighbors-postfix.log | 37c54dfa96d4abe5e59de0b94e6e9be326a43d1de39776eb9ebba4998b707a49 |
| core-private-yield-neighbors.log | a4a4f16e68e97b9491916b29a826095b4e512539357ae64c1d9e38c9d05142cd |
| desktop-current-source-inputs.log | 72c89c7bdf347dbd4f310e41c90b767b50bcaee71aa15a06a20fd04dc87b3ef4 |

未实施产品的审阅者已给出 `PASS_SCOPED_WITH_LIMITS`、确认残留阻断 0、approved=false。
Root 已全文读回 `final-independent-review-20261016.md` 并核 SHA-256：
`404535dfe23ad25d350ce03f6f54a34702c654a5a8ed59994eeebd3b8f84605d`。
审阅者本人编写 recovery/yield 两测试，报告明确不将这两文件称为独立测试审阅；
独审仅覆盖冻结产品增量及必要接缝，不冒称整个 Daemon/Office 全文重审。

## 后续

A18 真实受控 OS race、其他具名项、具体冻结 Office
用户批准、新 QA 包和 12 类真实 macOS GUI 验收仍未完成，总 goal 保持 active。
不发布、不生成 approved，不 reset/clean/stash/force/admin，不绕 hooks。
另一 writer 文档保持 SHA `8acef2d140ed10724ab3a583533ec11b7cff4c3fabd45727c2159668e6e34044`，
不纳入本提交。根 checkout 不动。A28 范围没有新增待用户选择的产品决策。
