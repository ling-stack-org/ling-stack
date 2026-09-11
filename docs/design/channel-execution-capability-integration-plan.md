# 本机查询能力：执行入口与 Typed Transcript v3 整合

日期：2026-09-06。状态：调查已复核，增量设计已纳入；实现与真实能力 QA 均未完成。

本文件是[主实施计划 §6.4](conversation-codex-style-transcript-implementation-plan.md#64-本机查询能力增量2026-09-06未实现未验收)
的补充，不是新的 timeline/session/事实权威。
数据语义服从[typed 详细设计](conversation-typed-transcript-detailed-design.md)，组件服从
[组件设计](conversation-codex-parity-component-detailed-design.md)，展示服从
[视觉规范](conversation-codex-parity-visual-spec.md)，权限及 scope 服从
[surface contract](conversation-surface-contract.md)。

## 1. 当前事实与根因

关联任务：「定位并确认问题修复状态」（2026-09-01）。该任务是调查和方案讨论，没有
完成实现；不能把其中的建议当作已修复。2026-09-06 在独立 recovered worktree 复核：

- contracts/daemon 中没有 `host.local_network_info` 的定义、注册或执行实现。
- `channel-intent-selector.ts` 的 deterministic 分支仍调用 `materializeCommandIntent`。
  该方法依赖执行动词和 executable 白名单，不能把“查询本机 IP”绑定为具名 Host 能力。
- model-assisted 分支已经使用 `bindChannelOperationPlan`，不再从整段话重新猜命令；
  这是已有进展，必须复用。当前候选只支持 file/read/create/edit、run_command、open。
  `run_command` 要求 source-bound exact command；缺能力不能靠 Pi 的 bash 自动补救。
- binding 失败仍可能提示用户补负责队友、输入/输出文件，即使请求不是文件操作。
- 原 matcher 还承载 `commandMatchesPolicy`，被 binding、approval、workflow evidence
  调用。直接删除整文件会破坏安全边界；正确目标是迁出安全逻辑后删自然语言发现逻辑。

置信度：**高**（缺少能力及生产调用点由当前源码确认）。旧 matcher 的独立 probe 不等于
完整 selector/model/packaged GUI 复现；端到端查询仍须 K-01/K-07 证明。

## 2. 保留与替换

保留 SQLite canonical history、Run/Attempt、权限快照、ExecutionAction、TerminalReport、
已存在的 typed source binding 和统一 renderer。替换旧关键词发现责任，不再加“查询/网卡”
正则或增加 ifconfig 白名单来充当长期修复，不保留 matcher 二线 fallback。

三层职责：

```text
用户输入 + 可见历史 -> 模型选择 catalog 中的 capabilityId + typed input
                     -> Host 校验来源/owner/权限，编译确定的执行绑定（无副作用）
                     -> 真正工具调用/持久调度执行 -> 原子 action evidence
                     -> canonical projection -> 共享 Timeline -> 唯一 TerminalReport
```

selector 选择能力不等于能力已执行。询问 IP 概念、讨论命令或明确“先别执行”的输入仍为
reply；模型可先给 narration，但只有真实执行结果能证明查询成功。来源文本用于绑定用户
请求，不再要求自然语言含有某个 executable token。

## 3. 最小能力契约

用静态闭集 catalog 起步，不新增插件市场、远程 registry 或通用 session 系统。
每个条目定义 capability ID、contract version、input validator、effect scope、权限要求、
executor 与输出限制。模型不能提交 executor、任意脚本、权限或可信 sourceRefs。

首个能力：`host.local_network_info`。输入闭集：

```ts
type LocalNetworkInfoInput = {
  readonly family: "all" | "IPv4" | "IPv6"; // 默认 all
  readonly includeLoopback: boolean;        // 默认 false
};
```

缺省值由 Host 应用并记录；未知字段、错误类型、超长 envelope 拒绝。候选 request 只携带
operation ID、capability ID/version、typed input、owner 候选与用户 source quote；Host 从
当前 accepted input/scope 校验并生成可信 sourceRefs、participant 和执行绑定。候选不能
通过自报 workspace/run/attempt ID 取得授权。catalog 与编译输入版本进入不可变运行快照。

`host_capability` 为 operation/action/target 的显式闭集分支，D0 同步 contracts、core
types、validators、approval classifier、evidence projector 和 exhaustive fixtures。
不能用 `as`、未知字符串 fallback、`mcp_tool_call` 或假 `bash` 跳过契约迁移。

## 4. Host executor 与权限

- daemon 使用 Node `os.networkInterfaces()`；模型及 renderer 不直接读取 OS。
- 只返回接口名、地址族、IP、internal 标记与采集时间。稳定排序；最多 64 个接口、
  256 条地址、32 KiB 规范化结果，超限明确 `truncated`；展示尾部仍受现有更小的 evidence
  上限限制。接口名按数据转义，不拼成 shell/HTML。
- 不启动 shell、不访问公网、不返回 MAC/环境变量/凭据。不宣称得到公网出口 IP。
  用户要求公网 IP 时明确当前能力不覆盖，不能偷偷请求外部服务。
- 空接口列表是带说明的成功空结果，不伪造 `127.0.0.1`；OS 异常为结构化失败。
  IPv4/IPv6、loopback、虚拟网卡均按显式输入筛选，不猜“唯一主网卡”。
- 能力需独立的 `host.local_network_info` 授权；拥有 workspace read、bash 或文件查看器
  token 不自动获得此权限。缺授权时走既有 durable approval/blocked 流程，禁止后台
  改频道或私聊权限。该调用不发生网络请求，但查询结果仍可能暴露内网信息。
- normal/private/channel 复用同一 Host 实现与桥接。runner 无对应 bridge 时显式
  `runner_unsupported`，不能通过换队友或 shell 隐式降级；私聊不引入其他 Agent。
- Host 支持、runner bridge、workspace、surface、participant 策略取交集；执行前再验证
  有效 attempt、lease、scope、审批决定。不得仅信任 selector 的已编译结果。

## 5. 结构化失败与用户提示

| 原因码 | 用户应看到什么 | 禁止行为 |
| --- | --- | --- |
| `unsupported_capability` | 当前不支持该类查询 | 猜文件名/伪造 shell |
| `invalid_capability_input` | 哪个输入字段无效及可选值 | 变成 missing_target |
| `missing_command` | 明确执行命令时缺完整命令 | 模型擅自拼接命令 |
| `runner_unsupported` | 当前 runner 未接此能力 | 换 Agent、换 runner 偷跑 |
| `blocked_by_policy` | 当前 scope/队友权限不允许 | 放宽策略重试 |
| `approval_required` | 等待一次有范围的授权 | 当作已执行或永久失败 |
| `host_capability_failed` | 本机采集失败及可行下一步 | 用 narrative 当结果 |

reason code 贯穿 binding/dispatch/evidence/terminal reason，但不强行添加同名 action
status。沿用既有 waiting/denied/failed/cancelled 状态映射，并保留区别。缺 target 只用于
确实需要文件/路径的操作。

## 6. Shell 安全迁移与删除门槛

1. 将 quote-aware parser、`commandMatchesPolicy`、exact-command/executable policy 的
   安全比较机械迁至独立 `shell-command-policy.ts`；先不放宽任何接受条件。
2. binding、approval、workflow evidence 切到同一安全模块。保护已存在的危险结构、
   引号/转义、平台大小写和失败封闭行为；声明“执行 ifconfig”也仍需 policy 允许。
3. selector 使用具名能力/typed command 候选，删除自然语言发现分支和重复解析 helper。
   模型输出缺来源绑定仍应拒绝，不因去掉关键词 matcher 就放宽 shell 授权。
4. 生产代码对 `command-operation-match`/`materializeCommandIntent` import 为零，
   selector、approval、binding、evidence、runner 回归通过后删除原文件；不留 re-export。

## 7. Evidence、UI 与恢复

真实 `host_capability` action 投影为现有 `dynamicToolCall`。保留稳定 actionId 与
run/attempt/participant/workflowStep/sourceRefs，start/update/end 沿用 revision/fence。
只有真实采集才能形成 result；不得把计划卡或 Agent ready 文本当完成证据。

Host 负责把有界结构化结果转成可读工具详情。UI 沿用通用 icon、动词、状态、disclosure，
不新增网络结果卡，不伪造命令或 `exit 0`。IP 只作为文本展示/复制，不自动链接。MVP 不把
Host 查询混入 command/exploration batch；既有原子边界仍严格适用。

TerminalReport 只读取当前有效 attempt 的 required 原子 evidence。SSE 重连/daemon
恢复读取已提交事实，不能重新查询 OS 来替代原时刻结果；未提交结果的中断 action 不算成功，
显式重试使用新 attempt 和采集时间。重放/重复 end 不生成第二个 action/result。
跨 surface/child/私聊使用相同渲染但严格不同 scope；可见性过滤在 projection/copy 之前完成。

## 8. 纳入现有实施顺序

| 原阶段 | 本增量的工作 | 退出条件 |
| --- | --- | --- |
| D0 | 五份权威接缝、具名能力/闭集契约、输入/权限/错误/lineage fixture | contract 红测锁定；不把未实现 fixture 当通过 |
| E1 | 独立 shell 安全模块、Host catalog/compiler/executor 与 runner bridge | 保持原策略，真实 tool evidence，删除旧发现职责 |
| E2 | source/owner/attempt 严格 join，Host action 到 dynamicToolCall | 不串 Agent、不新增事实/结果 owner |
| E3/E4 | 三种会话与 child 复用 renderer/权限诊断 | 同 UI fingerprint，不新增私聊 Agent |
| E5 | 审批、重连/重启、retry、fan-in | 结果可恢复、待授权/缺 evidence 不成功 |
| E6 | K-01–K-07 真实 macOS QA | 新包与源码一致；截图、语义、lineage、脱敏日志齐全 |

先完成当前已安装包的复制/颜色验证，再实施能力切片；不以本增量抢掉已排定的
channel narration footer、child 分段/ownership、prepared-request 和原始 G/E6 全矩阵。
当前分支仅本地开发，不提交、推送或合并。若闭集 contract 或权限承载需变更，必须先
同步 D0 fixtures，再接业务代码；不能凭新 renderer 已存在就宣布 Host 能力已接通。

未决产品方向：无。已确定纳入同一计划，独立能力授权，无旧 matcher fallback。
待完成的实现核验：D0 需要证明各闭集承载类型与实际审批/runner bridge 可贯通；在对应
测试与真实包证据到齐前，本能力维持 `not_run`，不得宣布修复。

## 9. Host 能力缺失的失败投影（2026-09-09，已验证错误路径）

本增量只修复 `open_local_target` 能力未接通却被当成 ready/clarify 的错误路径，
不表示打开能力或七项正向频道验收完成，也不替代第 3–7 节的完整 Host 能力设计。

- binder 先完整核验 owner/source/path/依赖图。合法的打开请求返回具名
  `operation_binding_host_capability_unavailable` 阻塞；不生成 bash 权限申请、
  可执行计划、Proposal、Task、Run 或工具事实。来源/路径/图错误仍属于绑定失败。
- selector 返回内部 `action: blocked`；SQLite 保留 committed assistant item 的
  `deliveryStatus: blocked`，并保存 `action: reply, status: failed` 的 intent decision。
  `reply` 在这里是失败说明，不是 accepted 普通回复或允许执行的替代计划。
  现有 execute 契约要求完整计划与 participant manifest，不能伪造这些字段来保存失败。
- committed blocker 以 source/thread 绑定的幂等 key 成为恢复锚点。decision 写入失败
  不能进入模型失败的普通回复 fallback；重启读回 blocker 后补齐 failed decision，
  不再次调用模型或启动操作。索引点查，不扫描长会话的全部消息。
- 校验 blocker 的 channel/thread/turn/actor/domainRef/有效 item 身份；不完整 lineage
  显式失败。相同 source 的重放复用一个结果；新 turn 不继承旧 blocker。
- 现有 HTTP canonical `assistantItems`、SSE blocked 事件和源 LingTurn 共用该结果。
  不增加新 UI 卡片、批次表、摘要或兼容响应字段。

验证：10/10 新增用例通过，包含真实默认 Pi + 本机静态 SSE provider、HTTP/SSE、
SQLite 关闭重开、decision 写入故障、并发重复、后续 turn 隔离及不合法输入。
Daemon 全量 1738/1745，7 fail、0 skip。原打开成功测试没有修改或豁免，仍失败。
不是真实模型、daemon 进程重启或 packaged GUI 验收。详见
[本轮证据与剩余门槛](../../output/channel-host-open-blocker-handoff-20260909.md)。

## 10. Host 工具桥接与独立审批基础（2026-09-09，正向执行仍未接通）

本节实现第 3–7 节的 contract/Runner/approval/projection 接缝，不替代第 9 节的能力
缺失处理。catalog 中存在 schema 不等于运行环境支持执行，不能据此解除 binder/readiness。

- Contracts 固定 `host.open_local_target` / `host.local_network_info` 两个 ID，分别注册名
  `host_open_local_target` / `host_local_network_info`，版本为 1。打开输入只有规范相对
  `path`；网络输入只有 `family` / `includeLoopback`，Host 应用并记录默认值。
  未知字段、命令、绝对路径/URL、模型提供的 owner/approval/executor 均拒绝。
- `hostCapabilityTools` 是独立 Runner schema surface，不扩充内置 RunTool、不借 MCP。
  准备阶段使用真实 SDK 注册 schema，不要求伪造 Run 或执行回调；执行时必须具备
  Run/Attempt、通用 tool-before、独立审批和实际 Host callback。
- 固定调用顺序：执行前准入 → durable approval → 再次准入 → Host callback → SDK
  tool result。没有审批 ID、拒绝、审批已处理的替代结果、取消或过期 attempt 均不能
  继续派发。Host callback 还必须独立验证当前能力/审批/lease/owner；bridge 不签发这些权限。
- `host_` 为保留名称，MCP/内置工具不可冒用；在 SDK resource loader 前校验，不能依赖
  SDK 把 extension-load 错误当普通诊断后继续。未知 Host 名称不会降级为 MCP。
- Core/Contracts 新增显式 `host_capability` action 和 target；审批载荷保存 typed input、
  capability/version/cwd。read/bash 的 allow 或工具调用方的 allow hint 均不能绕过独立
  durable approval，deny 仍为 deny。复用原审批/恢复表，不增加新表。
- `runnerExecutionInput` 保存非秘密 Host schema。读回验证完整闭集，恢复时与当前 schema
  比较；撤销/替换拒绝，新加入的能力不能进入已经准备好的输入。回调及 grant 不持久化。
- Host action 使用已有 `dynamicToolCall` 投影和工具结果详情，保留现有原子 lineage、
  失败状态和 batching 边界；不产生 command/MCP 目标、不附加 `exit 0`。
  非法工具参数可作为失败尝试展示，但不能令整个 action projector 崩溃或得到文件引用。

当前未完成项：Host executor/支持能力发现、三 surface 当前权限交集、实际 dispatcher
和续接接线、operation binding/effect/evidence 的 open 分支、真实文件查看器回执与
HTTP/进程重启/packaged GUI 验收。当前 catalog 没有自动注入生产 Run，仍准确 blocked。
本节落地时网络能力只有 schema；后续采集实现及集成测试见第 12 节，生产派发仍未接通。
不得把 schema、审批通过或
模型“已打开”文本当成执行成功。打开 HTML 成果也不能直接用任意系统关联程序、命令或
URL 绕过现有内容预览安全边界。

验证证据与下一步见
[Host 能力桥接交接](../../output/host-capability-bridge-handoff-20260909.md)。

## 11. Host 原始调用校验与审批写入边界（2026-09-09）

本节落实既定的 source/owner/attempt 和独立审批要求，不表示支持能力发现、实际执行器
或七项频道正向验收已完成。

- `host-capability-authority.ts` 在创建 handler 时捕获原 Run 输入与 dispatch fence，不从
  最新 active Attempt 推导身份。以同一个 SQLite 只读快照核对当前 owner、task/cwd、
  channel/thread/teammate/workflow 归属，以及实际 SDK 准备输入中的 Host schema。
- 审批前、审批等待结束后、审批状态回调结束后均重验。审批与 checkpoint 的 run/task、
  channel、toolCallId、typed payload 必须一致；resume basis 的原 Attempt、workflow
  step、动作指纹也必须一致。缺准备输入、被替换的 Attempt、不同文件路径或借用审批拒绝。
- 审批维持单一 owner：Run 审批使用 runId/taskId；workflowStepId 保存在其不可修改的
  resume basis 中，不同时把 Run 审批转换为 workflow-owned 审批。
- Core `createExecutionApprovalRequest` 在实际 INSERT 内使用 execution-owner SQL 条件，
  并核对 task/channel；审批与 checkpoint 在一个 savepoint 中成功或回滚。只读预检查
  不能替代写入边界。Host 审批状态变化使用已有 `transitionRunExecutionStatus`。
- 审批结果仍不是执行证据。Host 不走 file/Bash 的 handled effect；实际 executor 仍须
  重验当前能力/权限交集、文件对象身份与取消，再产生真实回执。这里仅匹配已批路径和
  typed input，尚未实现文件 inode/内容的执行前验证，也没有打开窗口或读取网卡。
- 本 checker 只认可原始调用的 Attempt。恢复到新 Attempt 必须走独立、已验证的 durable
  handoff/resume 链路；不能拿新 Attempt 替换旧 fence 来通过本检查。

同时，全量回归发现默认队友 Memory scope 初始化的并发读写问题。该方法改为在读取
成员关系和已有 scope 前取得 `BEGIN IMMEDIATE`，防止 WAL 读快照升级写事务失败，以及
用已失效成员快照生成范围；不扩大 Memory 可见范围、不更换存储，也不靠重试掩盖错误。

精确回归与最终全量记录见
[Host 审批身份及初始化竞争交接](../../output/host-capability-authority-handoff-20260909.md)。

## 12. 本机采集、SDK 证据集成及 Host 回调生命周期（2026-09-09）

状态：下列内部链路已验证，生产能力发现/权限交集/dispatcher 与原七项频道验收未完成。
测试工具接线不是生产支持声明，不因此解除 command/open 的 runtime interlock。

- `host-capability-results.ts` 定义网络结果类型及 64 接口、256 地址、32 KiB 上限。
  `host-local-network-info.ts` 使用 `os.networkInterfaces()`，在采集前校验输入，按
  family/loopback 筛选并稳定排序，只保留接口名、地址族、IP、internal 和采集时间。
  OS 异常返回结构化失败；取消保留 AbortError。空结果和超限均显式，不伪造公网地址。
- `host-local-network-result.ts` 将结果转为可读工具文本和有界结构化 details。文本
  限制为 8 KiB/40 行，名称作为数据转义，不含 MAC、环境变量或原始 OS 异常。
  沿用现有工具详情展示，不新增卡片、不伪造 bash/MCP/exit code。
- 新集成用例实际运行 Pi SDK，经已有 Host authority、durable approval、采集器与
  `appendExecutionEvent` 到 SQLite action/evidence。使用 loopback 静态 SSE 服务和
  虚构地址，不是真实模型、不发送本机真实地址。审批与工具结果合为一个 action；
  SQLite 关闭重开后保留同一采集时间和结果，不重新采集来替代历史。
- 拒绝、OS 错误、借用审批、批准前后替换 Attempt、审批中取消均不产生成功证据。
  已终止 Run/旧 Attempt 的写入仍由 SQLite 拒绝，不使用无 fence 的 appendEvent 兜底。
  测试接线捕获 stale_run_execution 的方式遵循生产事件入口，不把此拒绝冒充 provider
  故障，也不把叙述文本当作成功事实。
- 发现并修复 `createPiTaskBoundary` 遗漏新增 `onHostCapabilityCall` 的生命周期检查。
  复用 MCP/媒体等回调的同一 guard，暂停、取消或失败后，先前捕获的 Host 回调也不得
  到达 executor。保留 Host 扩展内部重验和 executor 独立 authority，互不替代。

验证：采集/结果 11 项、SDK/SQLite 集成 7 项、Host 回调边界 5 项。回调边界反例在
修复前 1 pass/4 fail，修复后 5/5。原七项频道用例独立保留，不计入这些新测试。
全量另暴露排他创建测试将失败固定为 Promise reject 的时序假设；已补真实 OS open
屏障，严格验证唯一成功、明确失败码和赢家字节不被覆盖，生产创建逻辑未修改。
本阶段没有真实 daemon 进程重启、完整 surface projection、真实模型或 packaged GUI
验证；没有更新 QA App 或生成新截图。完整回归结果见
[本轮交接](../../output/host-capability-sdk-evidence-handoff-20260909.md)。

## 13. 原七项之二：Host 打开回执与完成校验（2026-09-09）

后续产品决策已确认：HTML 默认隔离可交互预览，源码查看与经授权的系统浏览器打开分开。
本节保留证据切片的历史范围，实施以[七项闭环计划](channel-seven-execution-closure-plan.md)为准，
不再等待用户重复选择取消或 HTML 策略。

实施范围是原第 2 项必须经过的证据层，不表示打开器、策略选择或七项正向用例完成。
现有完成检查将 open_local_target 归为 Bash 并依赖 exitCode，必须迁到独立 Host action。

- 新的闭集 HostOpenLocalTargetReceiptV1 只表达打开器已接受实际 launch：
  capability/version、path、runId、attemptId、toolCallId、approvalId、receiptId、launchedAt。
  固定 visibility=unverified，不能把 launch 成功说成窗口已展示；队列接收、模型叙述、
  Bash exit 0、无回执的 tool_end 均不能满足 required open。
- 回执由未来的 Host executor 在真实调用后生成，不进入模型输入 schema。read model
  只读原 tool_start/tool_end 与 SQLite，严格匹配同一调用的 path、Run/Attempt 和
  独立审批及其不可变 checkpoint。审批与 checkpoint 使用同一 readSnapshot 校验。
  不解析 outputText、显示标签或错误中的 JSON 来制造回执。
- 保留首次 accepted end；重复/晚到 end 不覆盖结果。ExecutionAction 增加派生字段
  hostOpenReceipt，不新增 SQLite 表或 conversation_items 摘要。沿用原 actionId、
  revision、sourceRefs 和共享 dynamicToolCall 渲染，不制造命令证据或 exit 0。
- workflow/fan-in 只接受当前有效 Attempt 的 Host launch evidence。旧 Attempt 的原
  回执在历史仍可检查，但不能借给新的执行。无证据为 blocked，不自动当完成。
- 本节只覆盖原始调用的 approved checkpoint；跨 Attempt 审批恢复须另经已有恢复
  协议核验，不能重绑 receipt 的身份来通行。读取回执不重新打开文件。

不在本切片选择 HTML 隔离预览或系统浏览器，不开放 Host 工具发现/dispatcher，
不解除 binder/readiness，也不改变 macOS 沙盒及后代停止承诺。验证采用临时 SQLite
与明确标注的回执夹具；真实打开器、真实模型和 packaged GUI 验收仍是独立必需项。

本节验证：25 项回执/归属、4 项实际 SDK/静态 provider 集成全部通过。
新增回执校验与外层完成校验的组合同时暴露并修复了只读快照嵌套 BEGIN：
内层复用同一模块持有的快照，不提交外层事务，仍拒绝接管外部写事务。
Core 903/903、Runner 169/169、Contracts 83/83、Web 类型检查与 build:ci 通过；
Daemon 最终 1832/1839，原七项仍失败、0 skip，失败集合无新增/移除。
详见[本轮证据与剩余实现](../../output/host-open-evidence-handoff-20260909.md)。
