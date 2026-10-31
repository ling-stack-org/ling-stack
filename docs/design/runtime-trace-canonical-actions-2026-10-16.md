# B-012：Trace 工具子 span 使用完整 canonical action

状态：已实施并通过限定回归、未实施产品者窄审。有效首 RED 20/20 失败、actual exit 1；最终四完整 Trace 文件 25/25、actual exit 0（含真实 denied 审批），零 fail/cancel/skip/todo。contracts/Core/Daemon fresh build 各 actual exit 0。主 CI 停用，不查询或启用。此设计不改变会话、Run 完成裁决、TerminalReport 或 multi-agent fan-in；不是 GUI、Office 或 E6 总验收。

## 1. 已确认的可达链

- `packages/daemon/src/server/router.ts:1161` 调用 `/traces` collection handler；`:1176` 调用 `/traces/:traceId` 和 `/traces/:traceId/spans` handler。
- `packages/daemon/src/features/runs/traces-routes.ts:113` 的 `buildRunTrace` 经真实 Registry 找 Store，读取真实 Run，再调用 Core `projectLingTrace`；thread 入口为 `:85`。
- `packages/api-client/src/endpoints/runs.ts:191`、`:207`、`:211` 分别公开 list/get/listSpans。此次搜索未定位当前 Web 的实际 renderer caller，不能把修复宣称为已复现的 GUI 修复。
- `traces-routes.ts:158` 只读取首 1000 个 RunEvent；Run trace 的 actions 只取 500，thread actions 又受 thread/workspace 500 窗口限制。
- `packages/core/src/runtime-trace-projection.ts:26` 使用跨 Run 的全局 toolCallId Set；`:74` 只要 raw 窗口出现同 callId，就跳过完整 ExecutionAction。`:120` 又用 raw start/end 重新判定成功，未遵守 canonical 的 accepted lifecycle/fence。
- `packages/daemon/src/features/runs/execution-actions.ts:121` 已有 `listAllExecutionActionsForRun`；`:615` 已用 afterSeq 每页 1000 读完同 Run。旧修已覆盖 action 本身，无需重新实现 action 状态机。
- `packages/core/src/storage/sqlite/run-event-store.ts:97` 的真实分页查询为同 Run、seq 升序、`seq > afterSeq`；1000 是单页上限，不是历史总上限。

因此，首窗含 start、terminal 在第 1000 项后时，Trace 会把完整 terminal action 遮住并错误保留 running 子 span。跨 Run 复用 callId 也会错误遮住另一个 owner 的 action。真实路由明确传 Run/thread status，所以本缺陷不等于整体任务成功或失败裁决错误。

## 2. 最小实现边界

1. Daemon 对已经选中的每个 Run 调用现有 `listAllExecutionActionsForRun`。Run trace 不再依赖 500 窗口；thread trace 对所选 runs 逐 Run 取完整 canonical actions，不能先查 workspace 500 再声称选中 Run 完整。thread 的 Run 选择窗口仍是既有 API 边界，不扩大为整个线程全部历史。
2. Core 优先从 canonical action 投射工具/外部动作 span。相关性至少使用 `[runId, toolCallId]`，独立动作使用稳定 action.id；不得用全局 callId，也不改变已经接受的 approval/tool logical lifecycle 合并结果。
3. raw events 不能覆盖 canonical status、receipt 或时间。真实 HTTP 的工具事实可直接来自已分页的 canonical action，不必再用首窗 raw 结果重判。保留 raw-only 纯 projector 调用时，必须输出显式结构化 `partial`/`raw_event_fallback` 来源标记，不能把 raw isError 当 Host 确认成功；标记通过 Core 类型和 trace contract 一起公开。完整 canonical 匹配存在时，不再额外生成同逻辑工具 fallback span。
4. 非工具诊断 span 继续保持现有语义。本项不顺便重写 runtime-event、transition、intervention 的全量分页，不把它们的窗口描述为整个 Trace 全量覆盖。`complete` 只用于所选 Run 的 action 投影覆盖。
5. span 保留 `executionActionId`、run/workUnit/attempt/workflowStep 等已有真实 lineage；不得把 raw payload/command/result 原文塞回 redactedAttributes。需要来源记录时只保留 accepted 的结构化 source reference，不混入 diagnostic source 去冒终结回执。
6. 工具 span 的结束时间取 canonical completedAt，不借 approved/resolvedAt、Run endedAt 或 generatedAt 填补。审批 span 自己仍用 resolvedAt。取消/失败但没有真实工具终结 receipt 时允许没有 endedAt；terminal 运行裁决不承诺工具物理停止。

不新增 SQLite 表，不清洗历史，不增加任意总上限，不让 Trace 成为工具完成或 fan-in 权威。保留 stable action/span identity，避免因切换来源让同一 logical action 重复展示。

## 3. 回归验收合同

- 隔离真实 SQLite/Registry、合法生产 Run 与真实 router HTTP：超过 1000 个事件，start 在第一页、terminal 在后页；getTrace 和 listSpans 均读取准确 canonical status/时间，或明确 partial，而非未声明的 running。
- 单 Run 超过 500 actions，验证完整 action 不被末尾窗口截断；多页读取不能跨 Run 混合。
- canonical accepted success 后再出现 late/duplicate raw failure，不得把工具改为失败；terminal fence 后 raw end 不得伪造 completedAt。
- 两个 Run 复用同 callId，分别有独立 parent、status、executionActionId；一个 Run 的 raw fallback 不抑制另一个 Run。
- 失败、取消且无物理终结 receipt、approved 后续跑、pending/denied 审批、正常短流与重复 HTTP 读取均遵循 canonical 状态和时间语义。
- 纯 projector 的 events-only 输入明确 partial；空输入、yielded thread、隐私 redaction 和 deterministic ordering 原正例保留。
- 不伪造 Store/listEvents，不用提高 limit 的 stub 证明修复，不写用户数据库，不宣称 packaged App 或 GUI 验收。

已依此完成测试冻结、有效 RED、产品修复和限定 GREEN。原首跑命令拼接 exit 127 是运行配置错误，不算业务 RED；历史日志保留。最终日志为 `output/e6-20260928/b012-canonical-trace-neighbors-final-20261016.log`；首轮 24/24 与新增 denied 后 25/25 不重复相加。

## 4. 调查快照 SHA-256

| 文件 | SHA-256 |
| --- | --- |
| Core runtime-trace-projection.ts | `080073d57ee2f86c3e2297f6f2b6cbbe1c7396bba9daecdb6599d65ca40f9d09` |
| Core runtime-trace-types.ts | `ef6b4ca9274dc3d02e0c0ab7950cdda157c594ad04185563509c829a0808ffce` |
| Daemon traces-routes.ts | `a884feaba263d0d8ea1caf3bd1d9c19bf0dd5e758b8ce02f6e4fd0c23c5b5863` |
| Daemon execution-actions.ts | `5939e0ab49b103f025cd51dcfdc6d8e87e73695fa63677ef88af9baabbfe7349` |
| Core run-event-store.ts | `32f8d580385aa680bd6711296f6b2ab5c5a6508b11b37071cc0a38c10f046242` |
| Core runtime-trace-projection.test.mjs | `5c56af802db97aa414ace9b73014e16855346037595e5e9e2e4d89f1c5f8d2bb` |
| Daemon runtime-traces-api.test.mjs | `f2650d2867d2ecbaf860d16c82ceb75c64b5bbe877b1ae57f1476686ecdcf5f2` |

未决设计选择：无。Core/contract 已统一使用 `evidenceCoverage.source/completeness`，保持 raw-only 非权威合同。独审报告 `output/e6-20260928/b012-canonical-trace-independent-review-20261016.md` SHA `3b5d5d64622c59d4e6028f137fd8e89506f1733d753872b8bd355ba17eac5ba1`，结论 `PASS_SCOPED_WITH_LIMITS`、无确认 blocker、`approved=false`，Root 已全文读/hash。第 4 节保留的是实施前调查快照，不是当前产品输入哈希。真实安装包/GUI 和最终审核仍独立待验，不因本窄审自动批准。
