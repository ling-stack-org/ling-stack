---
status: in-progress
branch: codex/reasoning-summary-autoreview-implementation
timestamp: 2026-09-14T08:19:13+08:00
files_modified:
  - docs/design/reasoning-summary-autoreview-execution-checkpoint.md
  - docs/design/ling-harness-gap-closure-implementation-plan.md
---

# 推理摘要与自动审核执行检查点

> 本文是防止上下文压缩后重复研究的执行检查点，不是新的产品设计提案。
> 恢复工作时先读本文，直接从“下一步执行顺序”继续。除非实现或测试出现与本文矛盾的真实证据，否则禁止重新进行整轮 Codex 源码核对。

## 1. 当前目标与约束

- 更新基线：实际实现树已包含 `origin/main` 的 `76790031`。分支为 `codex/reasoning-summary-autoreview-implementation`；H07 已提交到 `47338dc1`，H08 evaluation foundation 由包含本文更新的下一笔原子提交记录。
- 实际开发树：`/private/tmp/ling-v3-implementation.tEPHvb`。
- 同事的 `<main-checkout>` 只读，禁止修改、清理、reset 或覆盖其中 WIP。
- 原 `<historical-recovery-worktree>` 暂不直接修改；验证完成后再受控同步差异。
- 只测试和打包 macOS，不处理 Windows。
- 当前不推送、不创建 PR。用户已在 2026-09-12 明确允许：未提交内容过多并妨碍继续开发时，可先创建本地恢复检查点提交。此类提交只用于保存和恢复，不代表 PR-ready，也不能替代后续按功能审查、测试和整理提交历史。
- 真实模型验收使用 `https://llm.gz.nobody.host/v1`；密钥只从环境中后缀 `_2` 的变量读取，禁止写入文档、日志、命令输出或截图。
- 历史 combined WIP 已通过本地检查点提交保存；后续继续按独立、已验证的功能边界创建本地提交，不把恢复检查点本身直接当成可合并 PR。

## 2. 已完成且不得重复的源码核对

### 2.1 Codex 推理摘要产品语义

Codex 设置提供四档：

- 自动
- 简洁
- 详细
- 无

结论已经确认：推理摘要是可公开的模型摘要，不等于原始推理过程。UI 可以显示安全摘要，但不得把原始 chain-of-thought、流式 thinking 文本或 provider 私有 reasoning content 当作摘要展示。

### 2.2 Pi SDK 0.84.4 与 OpenAI Responses 行为

已确认：

- OpenAI Responses 请求在存在 reasoning effort 时默认发送 `reasoning.summary = "auto"`。
- `SimpleStreamOptions` 没有公开 `reasoningSummary` 字段，但现有 `onPayload` 边界可以安全调整为 `auto`、`concise`、`detailed`，或删除 summary 实现 `none`。
- Pi 会把 `response.reasoning_summary_text.delta` 和 `response.reasoning_text.delta` 都转换为 `thinking_delta`，因此不能依据流式 `thinking_delta` 判断哪些文字可以公开。
- 最终 thinking block 的 `thinkingSignature` JSON 保存 `item.summary` 和 `item.content`。

安全规则锁定为：

1. 只从通过校验的 `thinkingSignature.item.summary` 读取公开摘要。
2. 禁止读取 `block.thinking` 或 `item.content` 作为公开摘要。
3. provider 没有安全摘要时，运行中只显示“正在思考”，完成后不伪造摘要。
4. 原始 `assistant_thinking_delta` 只驱动运行状态，不进入持久化公开 transcript。
5. 非 OpenAI Responses provider 不修改 payload，也不把普通 thinking 当安全摘要。

### 2.3 推理摘要事件与投影决策

采用独立的 typed reasoning-summary read model，不把推理摘要伪装成 `ExecutionAction`。原因是 `ExecutionAction` 是命令、工具和文件等事实的执行证据；混入摘要会污染 TerminalReport、multi-agent fan-in 和完成判定。

事件建议保持：

```ts
assistant_reasoning_summary {
  text: string;
  parts: string[];
  semantic: "safe_summary";
  source: "openai_responses";
  truncated: boolean;
}
```

投影规则：

- 由 Runner 在任务边界从合法 signature 提取。
- Contracts 负责类型与运行事件校验。
- Daemon 持久化并通过 reconnect/restart 可重建的 canonical 数据源公开。
- `conversation-ui-core` 投影为独立 reasoning item。
- 普通会话、Agent 私聊、频道外层和频道 child Agent 复用同一个 renderer。
- `ConversationTimelineReasoningRenderer` 不再使用事实行 `TimelineFactRow`，改为弱化的 document lane。

### 2.4 自动审核实现前基线

现有设置已经有：

- `ask`
- `smart / Help me approve`
- `always`

当时 `createRunApprovalHandler()` 仍然只创建 pending approval 并等待人工，`smart` 不是完整自动审核。该差距现已按第 2.5 节原则实现；本段只保留为设计决策来源，不代表当前源码状态。

已存在 `resolvedBy: "system-reviewer"` 的公开/读取合同，但 Store resolve 输入仍只允许 `"local-user"`。`WorkUnitKind` 也尚无 `approval_review`。`approvals.ts` 已约 1335 行，禁止继续把完整 reviewer 堆进这个大文件。

### 2.5 自动审核实现原则

锁定为：

- 使用当前获准 provider/model 创建独立 Pi reviewer session。
- reviewer `tools: []`，禁用 MCP、Memory、Skills、媒体、委派和递归审批。
- 严格输出 `approve | deny | manual`。
- 非法 JSON、异常、超时、证据不足全部回退人工，不自动放行。
- 使用共享总 deadline 和有限技术重试；明确拒绝不重试。
- 使用 approval revision、attempt、policy 和 action fingerprint 做 CAS，避免审核旧动作后批准新动作。
- 自动批准成功写入 `resolvedBy = "system-reviewer"`。
- 复用现有 WorkUnit、RuntimeEvent 和 approval checkpoint，不新增服务或 SQLite 表。
- 自动审核不等于 Full Access；执行前必须重新核验 action、cwd、参数、策略和 attempt fence。
- reviewer 拆为 parser、evidence builder、executor、deadline scheduler、CAS resolver、handler integration 等小模块。

## 3. 当前实现状态

### 3.1 安全推理摘要

已完成并有源码证据：

- Runner 新增 `packages/runner-pi/src/reasoning-summary.ts`，只读取通过校验的 `thinkingSignature.item.summary`。
- Runner 在 `message_end` 前输出 `assistant_reasoning_summary`，包含 `text`、`parts`、`semantic`、`source` 和 `truncated`。
- 提取最多 32 个 part、24,000 字符；非法签名 fail-closed，禁止回退到 raw `thinking` 或 `item.content`。
- Responses payload 已支持 `auto/concise/detailed/none`，并保留已有 `onPayload` 返回结果；非 Responses provider 不修改。
- Contracts 已加入事件类型和严格 payload 校验。
- `reasoningSummary` 已贯通 RunRequest、schema、workspace 默认设置、request snapshot、prepared input、continuation、automation 和四档 UI。
- Daemon 从已有 RunEvent 派生 `CanonicalReasoningSummaryRecord`，支持超过 1000 条事件分页扫描及 daemon restart 重建，不新增 SQLite 表。
- conversation detail / reconnect 对缺失 reasoning 集合 fail-closed；topic/thread reply 和 child Agent 已按 thread/run 贯通 reasoning timeline。
- raw `assistant_thinking_delta` 不进入公开摘要；Host 排序已改为预建 sequence Map，避免重复 `items.find()` 的 O(n^2) 路径。
- `conversation-ui-core` 已覆盖 stale/equal revision、reconnect merge、participant/run/attempt 隔离，以及 reasoning 不进入 TerminalReport/fan-in evidence。
- 普通会话、私聊、频道外层及 child Agent 已接入共享 `ConversationTimelineReasoningRenderer`；最终视觉结果仍须由 packaged macOS E6 验收。

本轮准确测试结果：

- Runner Pi：180/180 pass。
- Contracts：338/338 pass。
- Daemon reasoning/config/prepared-input focused：52/52 pass。
- conversation-ui-core：181/181 pass。
- Web unit：338/338 pass。
- Core/Daemon typecheck、Daemon build 和 Runner build 已通过；完整 combined gate 仍须按总计划重新运行。

### 3.2 自动审核

已完成并有专项测试证据：

- reviewer 使用独立模块、严格 parser、bounded evidence 和敏感信息裁剪；原始 prompt/output、raw reasoning 和 API Key 不持久化。
- `smart` 已接入自动审核；`ask` 与 `always` 保持各自既有语义。
- 非法输出、证据不足、异常、共享 deadline 超时和技术重试耗尽均 fail-closed 到人工处理。
- CAS resolve 支持 `system-reviewer`，并绑定 approval revision、policy、action fingerprint、Run 和 Attempt ownership。
- approve 后先重新核验 action/policy/attempt fence，再创建 fenced replacement Attempt 执行原动作。
- deny 后原子关闭 Run、WorkUnit 和 Task；取消、stale reviewer 和晚到结果不得重新放行动作。
- daemon restart 只恢复精确 pending approval、lost `runtime_suspend` Attempt 和匹配 checkpoint/policy/action/evidence fingerprint 的 reviewer；reviewer 最多一次恢复，总 Attempt 上限 2。
- 外部媒体恢复会绑定新的 Attempt，但不会重复提交已接受的付费任务。

专项结果：Core approval-policy 67/67、approval-policy-run 94/94、automatic reviewer focused 17/17、conversation media 25/25、Daemon build pass、`git diff --check` pass。

### 3.3 一并验证的既有链路

- Allow similar commands：规则真正持久化、匹配成功后命令实际继续执行，失败时不展示成已允许。
- 会话内审批卡与设置中的 sandbox/approval policy 职责分离。
- 最终总结只在存在真实执行/修改证据时生成对应事实区；纯问答不伪造操作总结。
- 三种会话共享 transcript、复制按钮、颜色层级和最终回复聚合。
- 子 Agent 叙述、工具、问题/回答和收尾按真实事件顺序展示。
- daemon restart、SSE reconnect、取消、超时、retry supersession、multi-agent fan-in、TerminalReport lineage。
- 压缩失败处理、单次长任务压缩、Memory 召回与新鲜度、工具结果预算。
- restricted command、HTML opener 和既定七项执行能力矩阵。

### 3.4 Harness H06 文件变更权威

已完成并有专项测试证据：

- Pi 原生 `edit/write` fallback 已删除；Host 遗漏 `handledResult` 时 fail-closed，不再绕过 Ling。
- Daemon 已统一接管 native write、exact edit 和 Codex-compatible apply-patch，并接入同一个 ToolExecution prepare/approval/claim/execute/evidence 生命周期。
- typed `file_create` 使用 existing-parent、hard-link no-clobber；patch-shaped typed create 直接拒绝，不会退回普通覆盖写入。
- 写入前重新核验取消、Attempt、policy、路径、symlink 和 `.ling-stack`；更新使用同目录 fsync + atomic rename，并保留文件执行权限。
- 多文件部分失败只回滚本次已写入且仍匹配 postimage 的路径；外部并发修改触发 `diverged/unknown_outcome`，不会被覆盖。
- 启动恢复使用 policy artifact 中的 hash-only pre/post basis，把过期文件执行区分为 `not_applied`、`applied`、`diverged`；状态和 evidence refs 在同一 SQLite 事务提交。
- H06 证据：Runner Pi 182/182、Core Harness/ToolExecution 24/24、Daemon broker/approval/workflow/patch/recovery 233/233、窄边界 41/41；Runner/Core/Daemon build 与 `git diff --check` 通过。

这部分尚未做完整仓库测试和 packaged macOS 验收，因此这里只声明 H06 实现完成，不声明整个 Harness 或总计划完成。

### 3.5 Harness H07 External Runner 工具一致性

已完成并有专项测试证据：

- External runner 不再读取可由配置自报的 `conformancePassed` 布尔值；工具授权来自与 adapter revision 绑定的 typed receipt。
- Registry 在选择 runner 时校验 curated tools、side-effect class、evidence commit、abort propagation、Attempt fencing 与 workspace boundary；失败写入稳定的 `runner_tool_conformance_failed` 原因。
- Adapter 收到实际 `tool_proposal` 后再次校验 receipt、revision 和本次 Run 的 requested tools，缺 receipt、旧 revision、未请求工具和副作用工具全部 fail-closed。
- 当前 Codex App Server 与 OpenClaw ACP 只开放 `read/grep/find/ls` 和 `none/workspace_read`；原生命令、写入、网络、凭据、外部投递与 MCP 继续禁用。
- `approvalBridgeVerified` 硬编码已删除；外部 backend 宣称 approval/native-resume 能力不会自动成为 Ling 的执行事实。
- Readiness API 改为逐项输出 tool execution conformance evidence，不再由一个 boolean 推导工具面、审批、workspace 和 artifact 全部已验证。

专项结果：Daemon build pass；runner registry/readiness/external adapter/bridge/conformance、hydration、reconstruction 与 approval recovery 63/63；Contracts 85/85；API client 52/52；Core fallback/migration 2/2；Web typecheck 与 `git diff --check` pass。全仓与 packaged macOS 仍属于最终 combined gate。

### 3.6 Harness H08 Evaluation Foundation

已完成并有专项和全量测试证据：

- migration 137 新增 `run_evaluations` 与 append-only `run_evaluation_grades`；不为历史 Run 伪造评分。
- suite、case、baseline、candidate 都绑定精确 artifact ID、sealed payload SHA-256 和稳定 hashed idempotency key；定义或 artifact identity 变化会追加新 evaluation，不会覆写旧事实。
- evaluation claim 使用 SQLite lease、claim token、revision CAS 和 canonical UTC 时间；数据库约束禁止无 lease 的 `claimed/grading` 状态，过期 worker 不能 complete、fail 或 requeue 新 owner 的任务。
- grade identity 由 evaluation、grader type/id/version 唯一约束；grade update/delete 被 trigger 禁止；grade 与 evaluation terminal transition 在同一事务提交。
- deterministic rule grader 只接受封闭 JSON schema，支持 `deep_equal`、`contains`、`exists` 和 `number_range`；未知字段、未知 assertion、循环对象、非有限数字和 sealed artifact digest 不一致全部 fail-closed。
- Daemon evaluation scheduler 使用独立低优先级并发池，默认并发 1；SQLite claim 是 authority，timer 只是唤醒；不调用普通 Run semaphore。worker 内部异常会被 registry 收口，未完成 lease 保留给过期恢复。
- shutdown 先停止 evaluation 唤醒，再等待 in-flight worker，最后才关闭 store；不会让后台 grader 在 SQLite close 后继续写入。

本轮准确验证结果：

- H08 Core/迁移兼容集中门禁：30/30 pass。
- H08 Daemon scheduler：7/7 pass。
- Contracts：85/85 pass。
- Core 全量：990/990 pass。
- Daemon harness config、scheduler 与真实 shutdown 集成：25/25 pass。
- Core/Daemon build 与 `git diff --check` pass。

这只代表 H08 完成。model/human grader、cost/latency artifact、promotion report 与 G15/G18 仍属于 H09；完整仓库 combined gate 和 packaged macOS 验收仍未执行。

## 4. 下一步执行顺序

1. 从 Harness T9/H09 继续：实现 model/human grades、cost/latency artifact 和 promotion report，并保持 model grader shadow-only。
2. 完成 Harness dynamic delegation T10–T12，并按依赖顺序接入现有 Run/Attempt/Workflow 边界，不重建顶层 orchestrator。
3. 按 `conversation-codex-style-transcript-implementation-plan.md` §6.2 重新执行当前 HEAD 的 G-00–G-12 combined gates，记录基线、源码、行为、安全与合并质量证据。
4. 对 Host capability/open viewer、既定七项执行能力、structured user-input lifecycle、native sandbox 后代停止与恢复、TerminalReport/fan-in/reconnect/restart 做真实正向和故障路径验证；修复当前 HEAD 可复现的问题。
5. 运行完整 test、typecheck、build，以及 docs/i18n/public/security/license 检查；不得用本节专项测试替代全量 gate。
6. 打包最新 macOS 客户端，使用真实 relay 完成普通会话、私聊、频道、多 Agent、审批、Allow similar commands、推理摘要四档、恢复、复制、最终总结和完整小项目案例。
7. 每个 E6 案例保存 screenshot、`semantic-state.json`、`lineage.json`、脱敏日志和 `case.json`；必须记录 build hash、thread/run/attempt、model 与 `simulation=false`。
8. 全部验证通过后，再评估如何受控同步或整理提交；仍不碰同事工作区、不推送、不创建 PR。

## 5. 防止再次死循环的恢复协议

上下文压缩或新会话恢复后：

1. 先读本文。
2. 用 `git rev-parse HEAD`、`git status --short` 和最近测试结果确认增量状态。
3. 从第 4 节第一个未完成步骤继续；当前唯一实现起点是 Harness T9/H09 evaluation calibration。
4. 不重新浏览整套 Codex 推理摘要源码，不重新输出同一份设计总结。
5. 只有以下情况才允许局部复查外部源码：
   - 本地依赖版本变化导致 API 与本文不一致；
   - 编译错误证明记录的字段或事件名不成立；
   - 测试捕获到安全语义冲突；
   - 用户明确要求重新核验最新上游实现。
6. 后续进度汇报只包含新增代码、测试结果、真实 GUI 证据和具体阻塞。

## 6. 完成定义

必须同时满足：

- 安全摘要不泄露 raw reasoning。
- 四档设置真实影响请求和展示。
- 自动审核具备 fail-closed、CAS、deadline、恢复和执行前 fence。
- 三种会话与 child Agent 使用共享 transcript 语义并保持归属隔离。
- 专项、全量、typecheck、build 通过。
- 最新 macOS packaged app 真实 GUI 验收通过并留有截图。

在这些条件达成前，不得声称“已完成”。

## 7. 未决决策

无。现阶段剩余内容是实现与验证，不需要再次讨论推理摘要的基本语义或重新选择投影方向。
