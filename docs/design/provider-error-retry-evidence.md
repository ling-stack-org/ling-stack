# Provider 安全诊断与 SDK 重试事实

## 已确认的缺口与边界

H2 原生长任务保存了六个有效压缩 checkpoint，随后 assistant stopReason=error。
Pi 原先丢弃 SDK retry lifecycle，并把错误原文替换成单一通用文案；因此旧 Run
不能区分请求错误、超时、限流或其他失败。补诊断不能追溯生成旧历史中不存在的事实。

本实现于历史核验时核对 Pi SDK **0.84.4** 的 AgentSessionEvent、agent-session.js；当前 runner-pi 已统一到 1.1.0。
pi-ai error-body.js 和 retry.js，不重复研究已冻结的 Codex/UI 设计。

## 模块与事实来源

- Runner：`provider-error-diagnostic.ts` 只提取允许列表分类、依据、HTTP 状态和精确错误码。
  状态字符串前缀的依据是 `sdk_error_marker`，不能冒充捕获了原始 HTTP response。
  不明错误保留 `unknown/unclassified`；不读取或输出正文、stack、模型输入。
- Contracts：`provider-diagnostics.ts` 是 Host/public 的类型和校验边界。
  Runner 保持既有独立 structural port；Daemon 集成回归检验实际 SDK 投影与 Host contract 相容。
  拒绝额外、隐藏、symbol、继承字段和 accessor；没有任意字符串 passthrough。
- Translator：只投影真实 SDK 的 scheduled / attempt_start / settled，不创建或启动重试。
- Adapter：最终失败只取最新 assistant 终态，之前已恢复的错误不能使 Run 失败；
  safe diagnostic 随实际 terminal provider error 到 run_error。
  用户取消、Host boundary failure 或 cleanup failure 不借用早先的 provider diagnosis。
- Host：同一 Attempt 的 appendExecutionEvent/fencing/terminal guard 继续有效；
  provider_retry 由 Host 填充 attemptId，不接受 SDK 的 retryAttempt 冒充 Host Attempt。

## 新事件

`provider_retry` / `policyVersion=pi_sdk_retry_v1`：

- scheduled：assistant 或 summarization scope，retryAttempt、maxRetryAttempts、delayMs、safe diagnostic。
- assistant settled：真实 SDK success/failed/cancelled；不是任务完成、tool evidence 或 TerminalReport。
- summarization attempt_start：compaction 或 branch_summary；compaction 保留 reason。
- summarization settled：**没有 outcome**，SDK 未提供它；实际成功必须由 compaction_end 和 Host seal 证明。

允许列表分类含 authentication、permission_denied、invalid_request、context_limit、rate_limited、
quota_exhausted、provider_unavailable、timeout、network、cancelled、unknown。
分类仅作诊断，不作为 retry eligibility、权限、恢复准入或运行成功的依据。

## 不变项

不增加 retry budget，不新增 session 服务或 SQLite 表，不改 provider 绑定、权限和 API key。
不重放工具，不改旧 failed Run、既有 TerminalReport、历史事件或数据。
时长格式与 R03 局部验收不重新实现或重测。

## 验证与当前完成门槛

新增九项测试在实现前全部失败，覆盖缺失诊断、丢失 retry 和缺少 contract 校验。
真实 SDK 与真实 Adapter 的本机隔离 transport 验证：成功、耗尽、backoff 取消、completed tool
只执行一次、终态不被旧错误覆盖、取消不带错诊断、隐私正文不进入公开事件。
Host 隔离 SQLite 验证：实际读工具、唯一 Attempt 归属、取消/迟到 fence、终态 safe diagnosis。
这些是本机集成测试，不是 packaged GUI 或真实 relay 长任务通过。

最新实现/门禁记录见 `output/e6-20260928/H2/provider-diagnostics-20261002/README.md`。
H2 新包/new unique case 尚需独立验收；原失败 Run 的原因仍未知，总 E6 目标保持 active。
本切片没有新增产品决策；未决的是 full gates、新包和真实模型/UI 证据，而非权限选择。
