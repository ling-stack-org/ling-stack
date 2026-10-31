# C01 generated content 的事实依赖

## 问题与边界

R9 真实客户端返回 `contentSource.inputOperationIds` 校验失败，无新 workflow/Run 或文件效果。
被拒的模型候选未持久化，不能将下面的合成探针称作原候选重放。
最小原生测试确认：现有 binder 与持久 plan validator 均只允许 file_read，无法表达
“根据自己读取的文件和自己执行的测试结果生成报告”。只改 prompt 或取消依赖校验不能修复契约。

## 统一契约

`generated_objective.inputOperationIds` 表示同 owner 的事实输入，而非一组文件路径。
允许 `file_read` 和 `run_command`，且每个 ID 必须存在、归属同 participant、显式出现在
该写操作的 `dependsOn`。未知 ID、写操作输入、跨 owner 引用和依赖环继续拒绝。
跨 Agent 交付须由接收方声明独立 file_read，并依赖生产者；不借用生产者的读取或命令权限。

- file_read 按既有规则贡献 inputRefs/readPaths；file_edit 保留其已有目标读取权限。
- run_command 仅贡献 Host 命令结果依赖，不把其 inputs、projectInputRoot、cwd 或 exactCommands
  复制给报告写操作，不增加读取、命令、网络或环境权限。
- 工具准入继续走现有 validateDependencies：唯一 owning step/Run、冻结计划与 owner 一致，
  对应 operation 必须已有真实成功 evidence。审批或模型自述不能替代命令结果。
- fan-in 继续使用原子 ExecutionAction：精确 command/cwd、exit0、非取消/超时/signal，
  并验证前置操作完成顺序。另一 Run、失败、缺退出码、缺 evidence 都不能支持报告成功。
- 强类型命令还必须包含完整结构化命令结果解析才产生的显式 `timedOut=false` 与
  `cancelled=false`。普通历史的 UI legacy fallback 可以保留，但由 `isError=false`
  推断的 exit0 不可供强类型工具准入或 fan-in 消费；不是“工具没报错就等于命令成功”。

不新增表、不修改已冻结历史、不自动重放命令。保持 bindingVersion=1 和现有字段结构；
这是对同一字段依赖类型的明确定义，binder、持久化校验、模型契约同时更新。

## 验收

新增原生测试覆盖 read→command→report、仅命令输入、无权限扩张、同 owner/显式依赖、
持久计划、工具准入和 fan-in 的失败/取消/超时/缺证据/错误目录/错误命令/跨 Run/乱序。
测试仅使用临时 SQLite 和合成 RunEvent；不是外部模型或 packaged GUI 验收。
独审加强有效 cwd 后，056 复现了旧式叙述性 tool_end 被推断 exit0 的证据缺口；
现有真实 typed Host 执行路径仍返回 unifiedExec，没有模型绕过执行器的实证。
后续必须差量独审、构建新 QA 包并提交唯一新 nonce 真实任务；不得将旧 R9 改成成功。
