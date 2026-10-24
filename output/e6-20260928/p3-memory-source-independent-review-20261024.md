# P3 Memory source / native / Web / Office 定向独立审查

日期：2026-10-24。审查者：真实独立子代理 `/root/c01_dependency_boundary_review`。

实施目录：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。

## 结论与范围

**所选稳定差量已完成定向独审，剩余已确认 finding 为 0。** 本结论限于下述 Memory 首次水合、Pi/native 接线、Web snapshot 重跑与 Office 清单/故障测试差量，不是整个 E6、全部公共隐私出口、Office 批准或新包 GUI 验收通过。

本代理只读实现，独立执行了 11 项 Memory 纯测试与 3 项 Web 纯测试；没有修改实现、普通 `dist`、候选构建、真实数据库、QA 进程、审批记录或 Git index/history，没有调用真实模型、打包或发布。本次接续只落盘已有审查结论，未重复运行这些 GREEN 检查。

公共历史 transport 的最终实现与独审由指定的 `p3_offline_delta_review` 链负责。本报告不复核、不代替其 Run/WorkUnit/Turn/item、resume/fork、私聊 runtime、supervisor 等最终公共出口结论。

## 实际核对的安全语义

1. **精确来源绑定，而非重新召回。** `createMemorySourceRevisions()` 对完整 `MemoryObject` 做 key-order canonical SHA-256，唯一排除观察性 `lastUsedAt`；正文、来源引用、scope/owner、health、review/enabled、sensitivity、verification 与 `updatedAt` 均参与绑定。`assertPreselectedMemoryCurrent()` 对 ID/revision 数量、唯一性、对应关系、字段与 hash 格式做拒绝式校验，在同一只读 snapshot 中先验当前 eligibility，再读正文并比对语义 hash。不通过则 `409 prepared_memory_unavailable`，不重新 recall。

2. **Workflow 私有正文不进入用户 Task。** `prepareWorkflowStepStart()` 保留原 context-pack 预算与 stamp，单独取实际保留的 `workflow_role_evidence` 来源，正文从 task prompt 移除，通过一次性 `preselectedMemoryUse.renderedPrompt/sourceRevisions` 交给首次执行。未被保留的 Memory 不会因这次水合被登记为实际输入。

3. **Pi 的真实 await 链已接通共享 guard。** 首次非 frozen 输入在 Memory 水合前校验；`assertPreparationCurrent()` 同样校验来源，并由 normal preparation 的 await 前后、直接 Pi SDK preparation 返回后、sandbox preparation await 后及执行输入刷新边界调用。frozen recovery 仍沿用原 frozen-input/eligibility 契约，不追加新的 recall 或把 source revisions 当旧记录的新恢复要求。捕获的 `usedMemory` 只拣 IDs/query/policy，不 spread 私有正文和 revisions。

4. **Native 私有输入与接受事实分离。** dispatcher 克隆输入，在 read snapshot 中选择一次并冻结来源，私有文本只注入独立 `appendSystemPrompt`；availability await 后及后续 Host authority callback 均校验当前来源。已追到 `run-target-dispatcher.ts` → `native-admission.ts` 返回的同步 acceptance closure，submit/spawn 前仍会调用外层 authority guard。Codex target 使用独立 developer instructions；现有不支持 system hydration 的 Kimi/OpenClaw 路径明确拒绝，不降级到 user task 文本。

5. **Native usage 只认 journaled acceptance。** `recordAcceptedMemoryUse()` 读取精确 Run/Attempt fence 下的 native submission，只有存在真实 `nativeTurnId` 才记使用；availability、配置、reserved submission 不算事实。正常返回、事件与异常路径均有补记机会；已接受后再失败仍记 use，同次 dispatcher 生命周期只记一次。此审查没有证明新的 native restart/resume 协议；现有 native shutdown policy 仍为 `stop_without_resume`。

6. **last-used 不构成语义编辑。** Core `recordUsedMemoryEvent()` 仅更新 `last_used_at`，不再同时改 `updated_at`；因此另一个消费者的使用记录不会让已冻结的相同语义来源失效。未放宽正文、scope、资格或其他语义字段变更的校验。

7. **Web 普通重跑不重放缓存私有系统输入。** workflow snapshot 重跑由 builder 明确拒绝；三个 UI controls 共享 capability，并在 click handler 再 guard。普通重跑仍使用用户 Task/objective，不复制缓存的 `systemPrompt/appendSystemPrompt` 或内部 execution input。历史继承 workflow thread 的 transport lineage 处理不属于本报告的最终出口证明。

8. **Office 清单与故障注入没有削弱安全门。** 固定源码清单新增 `node-command-inputs.ts` 与 `public-execution-snapshots.ts`，测试显式要求两者存在。`protected-host-staging.test.mjs` 的测试 helper 原同步 `finally` 会在异步 preparation 完成前恢复故障；现改为 Promise settle 后恢复，并新增 `corruptedReads` 断言确保故障确实覆盖异步窗口。没有改生产 guard，也没有删安全断言。

## 独立执行与原始证据

以下两条是在本代理独审时真实执行的最小独立检查，均 actual exit 0；本次报告落盘没有重跑。

```sh
node --loader ./output/e6-20260928/public-projection-test-loader.mjs \
  --test packages/daemon/test/memory-verification-prompt.test.mjs

node --test apps/web/test/run-snapshot-rerun.test.mjs
```

| 本代理实际执行 | 结果 | 原始证据定位 |
| --- | --- | --- |
| Memory verification、source revision、首次水合资格/格式 guard | 11/11；0 fail/cancel/skip/todo；exit 0 | 测试源 `packages/daemon/test/memory-verification-prompt.test.mjs`；loader `output/e6-20260928/public-projection-test-loader.mjs`；当前会话原工具回执 chunk `db8cd5` |
| Web workflow snapshot 拒绝、capability、普通用户 task/缓存私有输入隔离 | 3/3；0 fail/cancel/skip/todo；exit 0 | 测试源 `apps/web/test/run-snapshot-rerun.test.mjs`；当前会话原工具回执 chunk `47b673` |
| 所选差量 `git diff --check` | exit 0，无输出 | 当前会话原工具回执 chunk `f21a75` |

独立 11/11、3/3 的 stdout 当时没有另建文件日志；以上结果从真实工具回执落盘于本报告，不把主代理日志伪称为本代理重跑日志。其 pass summary 为：

```text
Memory: tests 11, pass 11, fail 0, cancelled 0, skipped 0, todo 0
Web:    tests 3,  pass 3,  fail 0, cancelled 0, skipped 0, todo 0
```

下列是已读取/交叉核对的原有实现或集成证据，**不是本代理重新执行的大套**：

- `output/e6-20260928/native-memory-private-hydration-20261024.md`：native 原 RED→GREEN、114/114 扩展回归及最后 last-used-only 1/1，明确是 synthetic Host/native journal integration，不是真模型或 packaged GUI。
- `output/e6-20260928/p3-pi-memory-source-binding-final-20261024.log`：Pi/SDK 17/17，0 fail/cancel/skip/todo；已读取末尾结果。
- `output/e6-20260928/p3-pi-memory-source-negative-final-20261024.log`：移除两个精确 guard 后 before-entry、during-prepare、missing-revision 三项均真实失败；断言实际得到 Run 而预期为 undefined，说明回归不是只检查文案或源代码存在性。
- `output/e6-20260928/p3-web-rerun-final-20261024.log`：主代理纯 request/controller 14/14，0 fail/cancel/skip/todo；已读取末尾结果。
- `output/e6-20260928/p3-web-rerun-typecheck-20261024.log`：主代理 Web 类型检查证据；本代理未另开 build lane。
- `output/e6-20260928/p3-protected-stage-async-probe-20261024.log`、`p3-protected-stage-async-red-20261024.log`、`p3-protected-stage-async-green-20261024.log`：主代理故障窗口 RED→GREEN；末份原 24/24（包含原 native command 矩阵）通过，0 fail/cancel/skip/todo。未重新执行这些 native 命令。
- `output/e6-20260928/p3-office-source-closure-green-20261024.log`：主代理原 closure regression 1347/1347，0 fail/cancel/skip/todo；已读取末尾结果。这是 synthetic inventory/guard 检查，不是 Office 编译或批准。

## 最终所选字节 SHA-256

本轮审查后的只读 hash 回读如下。哈希冻结具体字节，不扩大正文审查范围；若文件之后变化，需按受影响差量重新确认，不能沿用为新字节证明。

### 实现与实际追踪的支撑边界

```text
014f27a3b2e82908ad7c500beccb56820210132692e8f90f9d61daf2bb2b976d  packages/daemon/src/features/memory/prompt.ts
644cd6bcc3cc7b1fb18dee1ba3b196fd99f3ac818e9dd4c1617ae8ac48ca03b5  packages/daemon/src/features/runs/native-run-dispatcher.ts
3f2e093ad1242961244799051486537f7dcd961d29fef6e5e996cf03cadcbb6e  packages/daemon/src/features/runs/orchestrator.ts
57dfbec8e072c739da0f7421056340a91a72a09f553a88ca1434b8a2d1902f7f  packages/daemon/src/features/channels/workflows.ts
2f7fe96a1e84c8cad26d4e7ac68d3ce171180f5024a8e98cdea07e389174a089  packages/daemon/src/features/runs/schemas.ts
f0011531ec37b3b496cd067fcfa99a96800d7669fd787509c3db15831d0d3efd  packages/core/src/storage/sqlite/memory-retrieval-store.ts
7e982a422e3d06ad0a1e079504bb273db7591532ae2fc46524511ffb0b55bfc2  packages/daemon/src/features/execution-engines/run-target-dispatcher.ts
7d932863d7c6b8ecd4b21236d7da08d7260aea9910dbaed833cc3f8c5d44780e  packages/daemon/src/features/execution-engines/native-admission.ts
e1b4f74d4045f8e9209f8c936261c291fbabcb73f197dbcff8477d358a4439c9  packages/daemon/src/features/conversations/normal-conversation-prepared-execution.ts
80a4b3ba8bfdf2e8919be4138477a278c2294d3891aeba8c06a52f62fab3eab3  packages/daemon/src/features/runs/prepared-runner-input.ts
09db687e004cb43f6a4cfdd0bbed063dfd050034d8c8778f91fbf935175af527  apps/web/src/api/run-request-builders.ts
5c70b07917656d5b295623d118d44e54d59a5d84185abfc41ecc9c8eab614f4e  apps/web/src/features/runs/RunDetailHeader.tsx
634c9e370d587c595c9a7914847cf52de84c866f31b168af009d3e0a7c3ac915  apps/web/src/features/runs/RuntimeRunRepairPanel.tsx
45a6c4d5724314cf20b9c37d32ddb9efd1d1b8dc545fb0acea405926a838e7a3  apps/web/src/features/providers/ProviderWorkbenchFeedback.tsx
f6d771f4ca9877380a5fcbac27b9a2c2aaeda7eaa18902c5ffe742b52074cbce  apps/desktop/scripts/packaged-office-native-review-inputs.mjs
```

`workflows.ts` 在上一轮独审回执时为 `c7dc2b6d7e14a5055355ede3552a80094f8437b873a1d356fc8116a9d90d6c70`。报告落盘时只读核对到当前 `57df…`：Memory 准备差量不变，两个公共 evidence 调用新增 `store` 参数。该 transport 差量归指定历史投影审查，本报告的当前整文件 hash 不应被解释为替代其公共出口 clean verdict。

### 实际阅读的相关测试

```text
718387b00b559a49352f156a7683643797cb8b37fb072ace3a17a1956f6f96ef  packages/daemon/test/memory-verification-prompt.test.mjs
2a3cbea390fc32680a1bd69273084bf6a4ab86f8f8bda37f356df41ac975fe6f  packages/daemon/test/run-execution-binding.test.mjs
83865efacb7c48f39a2809be28636bd7b37b525c6a1c46a851c998924cdc154b  packages/daemon/test/run-prepared-input.test.mjs
98ad8852d6d56ceca6eea55a40ae743f8829d8e257c3df57625742d54443908e  packages/daemon/test/agent-context-consistency.test.mjs
dbacbaf5f9b760674940ab04f3304a637712d56964e9e4d293e18cb968aacddd  packages/daemon/test/channel-operation-pi-e2e.test.mjs
fafd82f151028dbe22b92b077c934b6541114c62f59ca0efdd4093c801fe8904  packages/daemon/test/channel-workspace.test.mjs
01e91a58e4168ef3a7bac8be721fb57d3d907cb342f0e0ce9d18829af1a89358  packages/core/test/memory-use-revision.test.mjs
58b5358b472e065e1e78cffee3fcebf8f9c3ddd0f7df085c5369971475877d4b  apps/web/test/run-snapshot-rerun.test.mjs
222e4faa27a51f0bf24d14fb460b5465a83700e3d6074278f47419fc72cfb86b  apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs
5e2b5b086b4f029de68c5e447c6df148fe6aefdcbc2fe780243e43bc74b6b18c  packages/daemon/test/protected-host-staging.test.mjs
```

## 明确限制与交接

- 这是一份定向独立内容/边界审查，不是完整 pre-landing review、全量依赖内容审阅、Office approved manifest 或用户系统认证回执。
- 没有重跑整套 Daemon、native/Pi/Office 大矩阵、真实断线/重启、多参与者、动态委派/H09 或 20 项 packaged GUI；已有通过证据不扩展为这些验收。
- 已核内部分离与首次输入来源校验，但公共历史 transport 全出口最终关闭由指定审查负责，本报告不宣称 privacy closure。
- 保留 frozen recovery 的现有语义，不重新召回、不伪造 native resume 能力、不改历史数据。native conflict queue 的保存不被本报告当作已证明可自动续跑的执行协议。
- 未提交、未 push、未建 PR、未合并、未部署、未发布。主代理仍需完成最终组合/差量审查和后续真实客户端验收，再对 E6 总目标给出结论。
