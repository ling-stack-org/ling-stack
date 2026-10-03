# 共享会话回复规范

状态：2026-10-01 已接入新 Run 的 Host prompt 组装，85 项相关回归与 3 项
真实模型用例通过；最终原生客户端截图已读回核验。验证范围与限制见
`../../output/e6-20260928/response-style-20261001/README.md`。

## 目标与边界

普通会话、队友私聊、频道主 Agent 与委派子 Agent 使用同一套自适应叙述
规范，不强制每条回复都成为列表或验收报告。短结论默认自然段；独立并列
要点才用列表；顺序步骤或供用户选择的选项用编号。用户明确要求的格式、
详细程度、代码块和 JSON 优先保留，不新增按条数自动改写 Markdown 的规则。

执行过程、最终回答、原子工具事实和文件变更卡保持分层。最终回答说明结果
和真实验证，不机械复述每次读取、编辑、成功命令、exit 0 或每文件 +/−。
需要说明改动原因、复现问题、交接任务或用户要求详细命令时，仍保留必要
细节和文件引用。失败、partial、blocked、审批/问答、未验证和实质风险不能
因简洁规范被隐藏或改写为成功。模型叙述不能替代工具/Host evidence。

不改 renderer、CSS、历史文本、工具参数、文件内容或 machine-only JSON
生成入口。正常 Markdown 列表照常解析和复制。

## 开源 Codex 依据

本次按用户要求直接核对了固定源码版本
`6996cde697b228fbf5695ce855b2498c5c668795` 的
[gpt-5.2-codex_prompt.md](https://github.com/openai/codex/blob/6996cde697b228fbf5695ce855b2498c5c668795/codex-rs/core/gpt-5.2-codex_prompt.md)。
引用仅作为外部设计依据，不是 Ling 的执行指令：

> Formatting should make results easy to scan, but not feel mechanical.
>
> Use structure only when it helps scanability.
>
> Adaptation: ... casual one-offs → plain sentences, no headers/bullets.
>
> Bullets: ... merge related points ...

同版本的 `protocol/src/prompts/base_instructions/default.md` 也规定简单确认
可跳过重排版，不为琐碎细节逐项列 bullet。没有把桌面 renderer 或“条数达到
固定阈值就变列表”当作已公开能力；也不照搬 CLI 的全部 header/bullet 限制。
官方文档 MCP 连接本轮不可达；上述结论来自实际读到的开源 prompt。

## 接入与恢复

- 单一纯模块：`packages/daemon/src/shared/conversation-response-style.ts`。
- `features/runs/orchestrator.ts` 在新执行输入准备前，将这段 guidance 与
  profile、skill、memory 的 appendSystemPrompt 合并一次；不替换这些来源。
- 所有会话及委派执行已经共用这个 Host 入口，不分别复制四份 prompt。
  外部 runner 也接收相同 options，但具体模型是否遵循仍需实测。
- guidance 进入实际 SDK prepared input、fingerprint 与 Run requestSnapshot，
  可以追溯真实投喂内容，而不是只改未使用的 UI 文案。
- 已接受/冻结的运行输入继续原样恢复，不在重启、审批或问答恢复时重建成
  新版本。保留已接受证据不是“兼容旧 UI”或重新解释历史。
- 合并不修改 caller-owned 数组，精确去重，不靠文本关键词猜测用户意图。

## 验证标准

纯规范回归覆盖简短叙述/合法列表/明确格式请求/异常证据/结构化数据边界；
实际 Pi SDK 与 Host dispatch 回归覆盖三种会话的统一注入、落盘、去重及
原有快照恢复。频道真实委派入口另验角色 profile 保留和共享规范投喂。
prompt 文本测试不是模型输出验收；真实回复是否自然需要新的模型执行，
不能通过重开旧历史证明。模型规范不能保证所有回复都不出现列表。

本次无未决产品选择；不扩大到总 E6/Harness 的恢复验收或其他独立 backlog。
