# H09 task/claim/recovery：内部实现检查点

唯一实施树：`ling-e6-continuation/ling-stack`；分支 `codex/e6-safe-continuation`。
起始 HEAD：`fcc47e2696c1f0926fc52903c063f8fcf33d87de`。
本记录只覆盖独立评估任务的内部基础，不代表 H09 生产启用或总目标完成。

## 实际实现

- Contracts/Core：独立 model Task、Attempt、Result DTO 和窄 Store 端口；新增158 sidecar。
- 语义 identity 锁住 evaluation、冻结七字段 config digest、repeatOrdinal；完整 artifact byte pins
  另保留。复制 artifactId 或改 JSON key 顺序不能制造同 ordinal 的第二任务。
- 每次领取生成独立 Attempt/token；首次 admission 和 active settlement 都要 exact 双revision、
  owner/token 和 live lease。历史 replay 只允许 no-op，admission replay 必须 `mayDispatch=false`。
- 准入前过期可以同 task/ordinal 重排；准入后未知只能 unknown，不能自动重发或把未知成本算0。
- result、Attempt、task terminal 三方原子提交；DDL/marker/commit 故障全 rollback，BEGIN 失败
  不 rollback 调用者事务。结果 `authority=unverified`，不写旧 grade，不增加 promotion 样本。
- Worker：先登记 lifetime/controller 再执行 callback；configured wake 先 bounded recovery，
  absent executor 零读取/claim/派发。shutdown 关准入、abort owned adapter、等真实 drain，
  挂起不冒 idle。只读输入有全树预算，不执行 getter/toJSON。
- 排序表达式匹配的新 index 消除临时全队列 ORDER BY；不冒充严格 O(limit) examined work。
- Office fixed authored inventory 补7个可达新 leaf；缺 digest、源变动、源缺失不能 fallback dist。
  实际清单文件为 `apps/desktop/scripts/packaged-office-native-review-inputs.mjs`。

既有 rule scheduler、137 grade unique/append-only、source terminal Run/Attempt、普通 quota
以及报告数学保留。新 worker 只有 export，未 production 注册或注入 executor。
主 Store 只添加 delegation wiring；新 SQL、validation、mapping、migration 和 worker 分模块。

## 已保存的 RED 与边界

收据目录：`output/e6-20260928/`。

- `h09-task-public-contract-red-20261010.tap`：旧 dist 缺12个 API，12失败；属于接口缺失 RED。
- `h09-task-exact-recovery-red-20261010.tap`：旧 dist 缺 exact recovery API；不冒恢复语义 RED。
- `h09-task-worker-old-dist-red-20261010.tap`：旧 dist 缺 Worker export；不冒 shutdown 逻辑 RED。
- `h09-task-renew-fence-red-20261010.tap` → `h09-task-renew-fence-green-20261010.tap`：
  真正旧续租 fence 缺陷，0/2 → 2/2，绿色 exit0。
- `h09-task-claimable-index-red-20261010.tap`：旧执行计划有临时 ORDER BY，0/1 exit1。
- `h09-task-migration-focused-20261010.tap`：索引/DDL/marker/metadata 防漂移18/18 exit0。
- `h09-task-worker-dto-copy-reentry-red-20261010.tap` →
  `h09-task-worker-dto-copy-reentry-green-20261010.tap`：真实 admission 后构造输入时停止，
  原 worker 仍调用 executor；补输入构造后的立即停止检查，1失败 → 1通过，actual exit1 → 0。
- `h09-office-required-inputs-domain-red-20261010.tap` →
  `h09-office-required-inputs-seven-static-green-20261010.tap`：固定清单缺失 → static1/1 exit0。
  这个 static 结果本身不是完整 esbuild、native 或 packaged GUI 验收。

## 最终验证

Contracts/Core rebuild 已 exit0。Daemon 第一次 tsc exit2 是新增 copier 的 string/symbol 类型
收窄错误，单点修正后 build-final exit0；没有修改预算或数据约束。

| 当前冻结源码验证 | 实际结果 | 收据（均在上述 output 目录） |
| --- | --- | --- |
| Core focused Node22/24，含旧 evaluation/fixture | 各111/111，exit0 | h09-task-final-node22/node24-20261010.tap |
| Worker focused Node22/24 | 各36/36，exit0 | h09-task-worker-node22/node24-final-20261010.tap |
| Core+Worker joint Node22/24 | 各87/87，exit0 | h09-task-joint-node22/node24-20261010.tap |
| Core full | 2692/2692，exit0 | h09-task-core-full-20261010.tap |
| Daemon isolated full | 3943/3943，exit0 | h09-task-daemon-isolated-full-20261010.tap |
| Desktop final full，包含Office source-only matrix | 1998pass/3Windows-onlyskip，exit0 | h09-task-desktop-final-full-20261010.tap |
| Workspace CI typecheck scripts | WORKSPACE_TYPECHECK_EXIT=0 | h09-task-workspace-types-20261010.log |

Core/Worker focused、joint、Core full 均0fail/cancel/skip/todo。同 harness 独审最终无剩余P1/P2；
这不是外部 Claude 或生产模型验收。21份源码/测试固定到 `h09-task-final-source-20261010.sha256`。

首 Office source-only matrix359/359、Desktop1998pass/3Windows-onlyskip都exit0，但其中fixture捕获的
worker SHA 是输入复制停止检查前的旧版本。因此保留为历史收据，不冒最终源码证据；最终Desktop
重跑也包含完整 source-only matrix，三次真实 esbuild捕获的新7leafSHA已逐项核验与冻结manifest一致。
3998 runtime inputs、1162 authored workspace inputs、0 workspace dist inputs；native compiler/codesign
仍是synthetic，未执行bundle，不产生正式approval或真实GUI证据。

首次 Daemon full 命令漏掉已有逐进程隔离，默认工作区触发旧 delegation marker conflict。
已核验并只终止本轮 PID19009/20635，session17080实际exit1且没有完整suite footer；
`h09-task-daemon-full-20261010.tap`只作失败运行记录，不称完整full结果或H09回归缺陷。
随后使用已存在的 `t13b-test-process-isolation.mjs` 和新 mktemp 目录重新跑；
未为解决失败去修改旧数据库，未删除数据、未放宽迁移校验。最终 isolated Daemon/full 已收真正
终态：3943pass，0fail/cancel/skip/todo，`DAEMON_FULL_EXIT=0`；隔离目录
`/private/tmp/ling-h09-daemon-full.iGWrcH`。session2268 已结束，不再轮询或重复执行。

后续 full 命令必须保留隔离（此片段仅复现命令，不承诺已执行结果）：

```sh
isolation_root=$(mktemp -d /private/tmp/ling-h09-daemon-full.XXXXXX)
LING_T13B_TEST_PROCESS_ROOT="$isolation_root" \
  node \
  --import ./output/e6-20260928/t13b-test-process-isolation.mjs \
  --test --test-concurrency=1 --test-reporter=tap packages/daemon/test/*.test.mjs
```

这同时隔离 `LING_STACK_HOME` 和 default workspace；只设置共享临时 home 不足以保证
每个 test process 使用独立 workspace。测试目录保留到收据确认，不广泛删除用户目录。

## 尚未启用与未决选择

内部 foundation 没有新增未决选择。用户随后已确定 QA 案例/脱敏产物 only、Host 验证的本地用户
显式提交和纠正撤回，并将 Provider/model/预算委托实施者决定；不再重复问这些已答政策。
初始选择 batch3/滚动24h12 个真实 request attempt、单个固定隔离QAworkspace稳定额度，初版retry0；
完整输入估算8k另加bytes硬界，output1k要wire验证。价未知不宣称金额硬界。
这些是下一切片政策，不是当前 worker 已启用配额或真实producer。现有Pi诊断是logical stream
而非HTTP次数；现有Desktop token不证明人工身份；OS确认helper当前也未production composition。
因此 next chain仍需补齐真实model transport/provenance/独立quota、payload-bound OS人工确认/
append-only correction-revoke、explicitQA enrollment/terminal原子enqueue；human不进入自动queue。
Provider D1 A 已完成，只回答凭据观察隔离，不回答这些政策，也不回答 H10 根预算。

正式 Office review row/隔离 Keychain、Mobile 实际 native compile/sign/install、新 macOS packaged
12类案例仍未完成。controlled executor/SQLite reopen 和 synthetic native matrix 都不是这些证据。
外部 Claude 审查只尝试一次，authentication unavailable；同 harness 独审不冒跨模型审查。

根 checkout 未改；独立 writer WIP 不改、不 stage。其 diff SHA256 保持
`312530d527ff7d209c8c281de4bc17e27261bfb7d15358a9006a281dc59e43db`。
本检查点尚无新的 commit/push/PR/merge，后续以真实 Git readback 更新。
