# E6：A29–A32、B006、B008 已验证本地检查点

日期：2026-10-16。基线 HEAD：a44c4377832b74416cbd332e626a322f9f35ab8d（PR #552）。
唯一实施树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`；
分支 `codex/e6-safe-continuation`。只保存本文列出的 46 个 owned 输入和本文，不包含另一 writer WIP。

## 已实施和实测

| 范围 | 最终证据（均由 Root 收到真实 exit 0） |
| --- | --- |
| A29/A30：snapshot pipeline、完整活跃 writer、原子 restore claim | `a29-a30-final-snapshot-neighbors-20261016.log`，104/104 |
| A31：独占 SQLite runtime owner、恢复前准入、失败保 lease | `a31-current-complete-neighbors-20261016.log`，42/42 |
| A32：独立 poll deadline、原请求 abort/settle、有界 drain、原 job/child 恢复 | `a32-producer-receipt-neighbors-final-20261016.log`，219/219 |
| A32：合作 abort / 不合作 late ACK、真实 EOF 分离 | `a32-scene-cooperative-late-tail-first-20261016.log`，36/36 |
| A32：原 SQLite 重开、一次 POST、receipt COMMIT 后真实尾部 | `a32-business-recovery-final-20261016.log`，7/7 |
| B006：Task CAS 与 ledger 专用 SAVEPOINT、外层审批组合 | `b006-task-approval-green-first-20261016.log`，194/194 |
| B008：waiting 状态闭集、graph/shared parser、非法持久化限定显式拒绝 | `b008-status-gate-neighbors-first-20261016.log`，144/144 |
| 当前 authored 输入、fresh source 打包保护 | `a29-a32-b006-b008-desktop-inputs-final-20261016.log`，412/412 |

以上零 fail/cancel/skip/todo；不同组有重叠，不累加成总测试数。
A11 独立隔离 native 邻域另为 20 pass / 1 fixture-child skip、actual exit 0，不能称 21/21 零跳过。
Core/Providers/Daemon fresh 构建已 actual exit 0；B008 最后再 fresh Core/Daemon build 0。
Desktop 使用真实 esbuild，但 native/compiler/signing 是 synthetic；
`fixtureOnly=true`、`artifactExecuted=false`，不是安装或真实 App 验收。

## RED 和修正不是丢弃测试

- 原 snapshot 流、活跃 writer、owner、Task 半写与 B008 均保留有效 RED→GREEN。
- A32 guard 修复前，真实本地 abort 被 adapter 解释为远端 failed，导致 child 绑定丢失；
  现在保 running/handle/child 供恢复，本地已停不能推导远端已取消/无计费。
- 首邻域 218 项 205 pass / 13 fail 保留：12 项是 after hook 先 rm owned temp 再释放 owner；
  仅将删除注册移到 owner/Store 关闭之后，保所有 receipt 断言。另 1 项旧 fixture 未区分合作 sender。
- 后者现为两例：不合作 sender 保原 EOF 前不释放保护，验证真实 SQLite BUSY 和最终 PNG bytes；
  合作 sender 不给 fixture EOF，必须原 body 真 abort/settle 才可 stop，且无假 artifact/terminal。
- 不使用 Promise.race 把产品原回调伪退役；5 秒 drain 超时拒绝、保原 owner/Store，
  原尾部结束后可同实例 retry stop。只保证 Media drain 阶段有界，不保证整个 stop 总时间 5 秒。
- 非法 gate 的 absent=any、[]=none 保原合同；只修有效 gate 内的限定，不冒所有 metadata 严格校验。

## 未实施者限定审阅（Root 已全文读回及核 SHA）

| 报告 | SHA-256 |
| --- | --- |
| A30 final | 1adabaef9dbb54398657255ead37a8e41a0b063b8fc908dea4afc382f0bea503 |
| A31 final | 85e760f58e07e10441b8cdf9ff73f67f7e6f6b1d49023e9cbc1af57272cb1179 |
| A32 Root 增量及后继证据 | d9676c3d33a533cbe1b5c314a2537cc1a64a8bb71b6e55d54caa7a4bec7418b0 |
| Seedance deadline 独立范围 | bbcdc22bcb87df39e78642cec9a225e05f9fa57acb242542cd1db1e3b4b52d85 |
| B006 final | cb3b68f6e661442a13240ac521fa5140c9c3e493ccbb16ff4301aeec7f11a400 |
| B008 final | a2d6d09ee1b9c1764add51dae47f86095cca174ba6eaf49a1dbecc1c5850d8de |

均为 `PASS_SCOPED_WITH_LIMITS` / `approved=false`，非全仓、Office 或发布批准。
A32 审阅者实施过 Seedance deadline，故另由未实施者审该部分；测试作者关系均已披露。
设计文档随后仅同步进度，不继承旧文档整文件 hash；产品冻结以以下实际输入为准。

## 仍未完成，不关闭总目标

- B009 / B010 设计与 test-only 在继续，不包含在本次已验证保存范围；B009 首 RED 1 pass / 8 fail。
- 其余 B/C、公共 required 问答→delivery→continuation/recovery、H10/H11 继续。
- H10 Root budget 的原 D1/R1 未答，不借其它授权补选、不启动态 child。
- A18 受控 OS race 的工具安全拒绝保持记录，不换说法绕过，也不归为 Full Access 关闭 finding。
- B008 部分 detached starter 消费 terminal callback reject；坏 gate 不会被当无 gate 继续，
  但全路径后台错误通知尚未完成，后续可靠性/诊断需跟踪。
- 受影响输入增量独审→具体 Office 用户批准→新 QA 包→12 类真实 macOS 验收仍需执行。
- B006 的既有大 Store 和 B008 大 types/mapper/graph 模块风险保留，本次不扩 unrelated 重构。
- 主 CI 不查、不启、不等、不作门槛；不发布、不 mint approved，不动日常数据库或根 checkout。
- 另一 writer 文档 `harness-delegation-storage-checkpoint-2026-10-09.md`
  SHA-256 `8acef2d140ed10724ab3a583533ec11b7cff4c3fabd45727c2159668e6e34044` 不改、不 stage。
- 本地 commit 不等于已 push/新 PR/合并 main，更不等于 App 验收。总 goal 仍 active。

## 46 个已验证 owned 输入 SHA-256

```text
4116e7dda43863910823dd113f23bc5204f7406391289076ceb8a80f0bad7b56  docs/design/runtime-singleton-owner-2026-10-16.md
fff6483a522e9290bc741c8e9ccd9c5498f8347f4c38340b610a903f45106ca2  docs/design/seedance-poll-operation-deadline-2026-10-16.md
dbdf1f4df3004103935871bd5168b5acab52b92f602c80d986b665c64c79b7f4  docs/design/snapshot-active-writer-barrier-2026-10-16.md
6d9e18ac523de9db6bb888b4d3d28d7a9b6361e12eed22928413d75fc5c78aef  docs/design/snapshot-stream-lifecycle-2026-10-16.md
f0c49f09bae689ef59f727e78afa7933b207b4321df6b639ad67b17a2e93bc16  docs/design/task-status-ledger-atomicity-2026-10-16.md
3e4abc417444f2d9870f5f485158afd4c4ba2afcb6a4b5d2bd4f4ff6a852a3c4  docs/design/workflow-status-gate-contract-2026-10-16.md
9dcf2fb9e10e3fd5d786be4642445569a388cfa133ee21ce4cfd8cdf614737d9  packages/core/test/task-status-ledger-atomicity.test.mjs
66259810ef22ee607f38121391285ecf5cebb83c27dc9406244a74ae1a4d7f39  packages/core/test/workspace-snapshot-atomic-claim.test.mjs
ae1acbe51cc941fe319a39c5d33267499e90783b25de56e16ab845e1c9be11ba  packages/daemon/src/runtime/workspace-runtime-owner.ts
c14700fe55957c15b8cb93a8a31e146e512ea04abc067d0faafa38399aacd7af  packages/daemon/test/media-daemon-stop-drain.test.mjs
d1978175c67afe37cde1bc2ce5a37f2fe0532f8e8b430c6631b971974cec9d34  packages/daemon/test/media-local-abort-lifecycle.test.mjs
3798a770c76376572e0790c4ae0d2de3a0596664599ddc0c698364838fd6dd6c  packages/daemon/test/media-shutdown-recovery-integration.test.mjs
4a6b2f12e22a046f28278630adf1c349057fc01a208122c597ec68d1a71d2846  packages/daemon/test/runtime-owner-release-failure.test.mjs
3730914904df6c98068f17ed445b6db8d0a2f3e42cf932db4e106f295231d84b  packages/daemon/test/runtime-registry-ownership.test.mjs
a1e8ea0dc6147b1d6e548faddda2f8d3b407fbadc49182e5add79aeda45077bd  packages/daemon/test/runtime-supervisor-ownership.test.mjs
703e6839ff9e86a64d4b0093d3b3d9bfab90f7726a2ed5f473352022f6a9e4e9  packages/daemon/test/seedance-poll-operation-deadline.test.mjs
2a6117d6c9353bf1a45e8cc4e7cbffbb728177a12ba6e1ecb889c9f782cdd27b  packages/daemon/test/support/media-owned-native-observer.mjs
96a076efcb1cec9c02956a5fe7576ef89f863773145585cb181013ea0da1ba4d  packages/daemon/test/workflow-status-gate-contract.test.mjs
646ed3a5a2e04b3228a5809a6821a289224e6129045151a41b074ff3cf78985a  packages/daemon/test/workspace-snapshot-active-writers.test.mjs
df2c7949b23212596686929e328ebd99eeddc9330d8a7d35488a43663ef94345  packages/daemon/test/workspace-snapshot-fence-failure-edges.test.mjs
6a965e4a3c3f97e55867ac517f6dfeaac11f03a8a0718da9b1b72d5a386fb34e  packages/daemon/test/workspace-snapshot-postcheck-lifecycle.test.mjs
ef872f56cfa415ee0bcb870b8b493684f1b07491c5207c4beadf032226b1d8ea  packages/daemon/test/workspace-snapshot-stream-lifecycle.test.mjs
f88e7ee5d16624c15ca1a00d12507ae4aeec4b7a60a2f34148bc781859e0bfc5  apps/desktop/scripts/packaged-office-native-review-inputs.mjs
683058927a1c5ab396e93ab93e62d42465e8044badf462b983318e5f839f8563  apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs
3208fc8ecd6a4dfd5bca033a2d1e5a65da610b2cb3ebb3608f5ae5da464018b1  packages/core/src/run-types.ts
23bc6c581dcbf4d0549cc62110a2be119b8397ecf3aedd1dffb3a96cae19707a  packages/core/src/storage/sqlite-run-store.ts
9a4b2c813753c31f6dbf956ac1db54494e3bf55d5df71176d796f9aad533edee  packages/core/src/storage/sqlite/channel-workflow-mappers.ts
0b49a1099c0d24594bfd0a728932bd8d35880fffbc2a49c1a07b3c8a9d4e78bc  packages/core/src/storage/sqlite/run-session-store.ts
037224db53bfbeb554154925ad15b30fc49bfa1c9948b8a32dc272bcd6d46d4b  packages/core/src/storage/sqlite/workspace-snapshot-store.ts
6d0dcb7243f916437c16882b7b6453922847a3dd5f90900818e0088a1fb34d7e  packages/core/src/workspace-types.ts
dcaf1a6406670c9b6153777d4fb74e312a43a2e89b336c3dfa66212704e1e5df  packages/core/test/approval-policy.test.mjs
bcc50b8aa0e3b8482223568a463c147a5815796104eb0b08390664a37017502f  packages/daemon/src/features/channels/workflow-graph.ts
032f7c22cf163636fa032282813cc644d370801abcd38973bf8ba7b311fb069d  packages/daemon/src/features/media/guarded-native-transport.ts
ec0b59fbd66795537c04a612b3fc58bdf20cd9b5260db475a314d5e168cd1e04  packages/daemon/src/features/media/native-http-transport.ts
f0db9b03d806c620f55c816a6bd96414d0199f878fd5f1c942dfc38e2b2e7499  packages/daemon/src/features/runs/workspace-snapshot-restore.ts
1fbff33a55394cfee295ac7ade19ec4468349e8c766efdefd416dc40bcb8b46e  packages/daemon/src/index.ts
0509db95f91aec1b3445cf0b0a1cecfb9586ef91972de370af98d3db48413b59  packages/daemon/src/runtime/media-local-executions.ts
239f4c49801a0cc64b3860ecae4ee385ca032fefba52c8eae01543b0a1eb9409  packages/daemon/src/runtime/store-registry.ts
4f6fef3577081c0d00a4a12fe3a98dcdf8e4393b55d591be9f7ff11b133e2a35  packages/daemon/src/runtime/supervisor.ts
364ded1c478c951d6c542ff94affd7eaf3c9be8633a9ea8de599604ddb89fe26  packages/daemon/test/daemon-startup-cleanup.test.mjs
acde82145edc7ba8cbfe91bf2f4f7377b268f3b4d728335e8b4a7426f8b0af3a  packages/daemon/test/media-host-operation.test.mjs
9e4cbf2f1ffa72408f2b4da559b911bf9ef78019a112c689dbec43d81a92336c  packages/daemon/test/media-local-producer-integration.test.mjs
dd0c74de62e5e58b3cc1360485e415bef1fc099a4e316718e8492dda37c3ee5f  packages/daemon/test/media-local-production.test.mjs
8409fcb639e1d75904ac640a32b03c6b57ee6212bcb2e1be630b2fbf61f84f7c  packages/daemon/test/media-scene-cancel-lifecycle.test.mjs
619ddb7c08c41eecf6aaf4a9b53c86e5d89c025823367cb24682eac182454095  packages/daemon/test/store-registry-initialization.test.mjs
a83e75289ad5cb49d66d0f4344556f3b768659935f179069f195747efe2d4cd3  packages/providers/src/vendors/seedance.ts
```
