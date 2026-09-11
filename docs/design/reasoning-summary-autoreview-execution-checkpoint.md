---
status: in-progress
branch: codex/reasoning-summary-autoreview-implementation
timestamp: 2026-09-12T04:07:13+08:00
files_modified:
  - docs/design/reasoning-summary-autoreview-execution-checkpoint.md
---

# 推理摘要与自动审核执行检查点

> 本文是防止上下文压缩后重复研究的执行检查点，不是新的产品设计提案。
> 恢复工作时先读本文，直接从“下一步执行顺序”继续。除非实现或测试出现与本文矛盾的真实证据，否则禁止重新进行整轮 Codex 源码核对。

## 1. 当前目标与约束

- 更新基线：实际实现树已包含 `origin/main` 的 `76790031`。分支为 `codex/reasoning-summary-autoreview-implementation`，已存在两个验证提交：`debb8199`（typed runtime evidence contracts）和 `b590a13a`（execution lifecycle / safe summaries）。
- 实际开发树：`/private/tmp/ling-v3-implementation.tEPHvb`。
- 同事工作区 `/Users/tianxiao/ling-stack` 只读，禁止修改、清理、reset 或覆盖其中 WIP。
- 原恢复树 `/Users/tianxiao/ling-typed-transcript-v3-recovered-20260906` 暂不直接修改；验证完成后再受控同步差异。
- 只测试和打包 macOS，不处理 Windows。
- 当前不推送、不创建 PR。用户已在 2026-09-12 明确允许：未提交内容过多并妨碍继续开发时，可先创建本地恢复检查点提交。此类提交只用于保存和恢复，不代表 PR-ready，也不能替代后续按功能审查、测试和整理提交历史。
- 真实模型验收使用 `https://llm.gz.nobody.host/v1`；密钥只从环境中后缀 `_2` 的变量读取，禁止写入文档、日志、命令输出或截图。
- 本次检查发现 434 个 tracked modified（含 2 个删除）、291 个 untracked，共 725 个工作树状态项。已经先通过两个独立验证提交保存 Contracts 和 Runner；其余跨功能内容已进入一个明确标记的本地恢复检查点。当前工作树应保持干净，后续不得把该检查点直接当成可合并 PR。

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

### 2.4 自动审核已确认现状

现有设置已经有：

- `ask`
- `smart / Help me approve`
- `always`

但当前 `createRunApprovalHandler()` 仍然只创建 pending approval 并等待人工，`smart` 不是完整自动审核。

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
- Runner 专项测试结果：9 tests，9 pass，0 fail。
- Contracts 测试结果：85 tests，85 pass，0 fail。
- Runner 构建已通过。此前临时树缺少包级 `node_modules` 链接导致的失败属于环境问题，补齐 16 个 workspace 包依赖链接后消失，不得再误判为代码故障。

本轮新增完成并已验证：

- Core typecheck、Daemon typecheck 和 Daemon build 通过。
- `conversation-ui-core` 179/179、Web unit 338/338 通过，Web typecheck 通过。
- Daemon 从已有 RunEvent 派生 `CanonicalReasoningSummaryRecord`，支持超过 1000 条事件分页扫描及 daemon restart 重建，不新增 SQLite 表。
- conversation detail / reconnect 对缺失 reasoning 集合 fail-closed；topic/thread reply 和 child Agent 已按 thread/run 贯通 reasoning timeline。
- raw `assistant_thinking_delta` 不进入公开摘要；Host 排序已改为预建 sequence Map，避免重复 `items.find()` 的 O(n^2) 路径。

尚未完成：

- 补齐 stale/equal revision、reconnect merge、participant/run/attempt 隔离，以及 reasoning 不进入 TerminalReport/fan-in evidence 的专项覆盖。
- 普通会话、私聊、频道外层及 child Agent 的共享 renderer 与归属隔离最终验收。
- `ConversationTimelineReasoningRenderer` 的弱化 document lane 最终视觉验收。
- `reasoningSummary` 在 RunRequest、schema、request snapshot、workspace/conversation 设置及四档 UI 中的完整贯通。

### 3.2 自动审核

- reviewer 独立模块和严格 parser。
- evidence 构造、敏感信息裁剪和 token budget。
- deadline、重试、取消和 daemon restart 恢复。
- CAS resolve 与 `system-reviewer` Store 支持。
- `smart` 模式接线；`ask` 和 `always` 行为不回退。
- 审核通过后执行前的二次 action/policy/attempt fence。

### 3.3 一并验证的既有链路

- Allow similar commands：规则真正持久化、匹配成功后命令实际继续执行，失败时不展示成已允许。
- 会话内审批卡与设置中的 sandbox/approval policy 职责分离。
- 最终总结只在存在真实执行/修改证据时生成对应事实区；纯问答不伪造操作总结。
- 三种会话共享 transcript、复制按钮、颜色层级和最终回复聚合。
- 子 Agent 叙述、工具、问题/回答和收尾按真实事件顺序展示。
- daemon restart、SSE reconnect、取消、超时、retry supersession、multi-agent fan-in、TerminalReport lineage。
- 压缩失败处理、单次长任务压缩、Memory 召回与新鲜度、工具结果预算。
- restricted command、HTML opener 和既定七项执行能力矩阵。

## 4. 下一步执行顺序

1. 重新运行 O(n^2) 优化后的 Daemon reasoning 专项和 typecheck，保存准确结果。
2. 补 stale/equal revision、reconnect merge、participant/run/attempt 隔离，以及 reasoning 不进入 TerminalReport/fan-in evidence 的测试。
3. 完成 `reasoningSummary` 四档在 RunRequest、schema、request snapshot、continuation/retry、workspace/conversation 设置中的贯通。
4. 写自动审核红测：严格 parser、manual fallback、deadline、取消、CAS stale、restart、执行前 fence。
5. 新建 reviewer 小模块并接入 `smart`；补 Store `system-reviewer` resolve。
6. 验证 Allow similar commands、审批恢复、最终总结、复制和三会话统一，不通过则按根因补齐。
7. 更新仍标记 `NOT_IMPLEMENTED` 的设计状态，但不改写已实现历史。
8. 先跑窄测试，再跑全量 test、typecheck、build。
9. 打包最新 macOS 客户端，用真实 relay 完成普通会话、私聊、频道、多 Agent、审批、推理摘要、恢复、复制和最终总结案例。
10. 保存真实客户端截图和日志证据供用户检查。
11. 验证全部通过后，才考虑把本轮新增差异受控同步回恢复分支；仍不碰同事工作区。

## 5. 防止再次死循环的恢复协议

上下文压缩或新会话恢复后：

1. 先读本文。
2. 用 `git rev-parse HEAD`、`git status --short` 和最近测试结果确认增量状态。
3. 从第 4 节第一个未完成步骤继续；当前起点是 Daemon/Core 类型检查与持久化读取链路。
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
