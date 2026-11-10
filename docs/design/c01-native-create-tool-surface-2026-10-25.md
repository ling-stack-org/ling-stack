# C01：类型化新增文件的工具声明与 Host 执行契约

## 真实问题与范围

R10 的 Engineer Run `run_15ea1c9e-e09d-4032-9aca-fb7b58278282` 成功读取三个输入后，
调用 `write({patchText: "*** Begin Patch…*** Add File…"})`。Host 在文件执行前返回
`operation_binding_content_form_unsupported`。后继 `checkpoint.effect_unknown` 是拒绝工具后的
保守检查点阻断，不是首次错误。QA 未启动，工作流 blocked；原八文件 SHA 未变，两交付不存在。

证据保留在本地 `output/e6-20260928/p3-bash-cwd-contract-live-20261025/`：
capture 073、`r10-write-failed-host-state.json` 与真实截图/AX。该目录不作为公开产物提交。

根因是协议声明错配：Runner 向所有 Run 宣传 `write.patchText`，但类型化 `file_create`
只允许 `path/content`，要求 Host 原子防覆盖。模型遵循了被广告的合法工具格式，却不能执行。
这不是权限不足，不应通过允许覆盖、重发任务、改提示词碰运气或代写产物解决。

## 设计

1. Host 从已接收的 `workflowOperationExecution` 选择 `initialToolSurface.nativeFileCreate`，
   必须在真实 SDK prepared input 生成之前设置。该字段不接收模型选择，不授予文件权限。
2. 选择后仅 `write` 的模型声明变成 `path/content` 两个必填字段，禁止额外字段；说明独占新增、
   不覆盖、不隐式创建目录。`edit`、普通/私聊/无类型计划的 `write.patchText` 保持原能力。
3. 初次准备、实际执行、恢复重建使用同一 Runner 工具注册路径。SDK fingerprint 必须覆盖真实
   工具声明；Host 将选择与 prepared 输入一起冻结。恢复时 native/non-native 变化双向拒绝，
   不能用旧宽 schema 恢复到新 typed 执行，也不能把 typed 冻结输入改成宽 schema。
4. 反序列化验证选择与实际 `write` 描述符一致，拒绝仅篡改选项的快照。没有 `write` 工具时，
   该选项不激活任何新工具。
5. Host 原执行准入、所有者/来源/Attempt 校验、文件路径和内容约束、原子 no-clobber、审批、
   工具 evidence/fan-in、未知效果检查点不变。模型仍可能给出坏参数；声明不是安全边界。

## 回归与验收

Value: protects=typed write schema and frozen recovery agree with exclusive-create Host;
fails_when=typed Runner advertises patches or restore changes schema mode;
why_new=existing tests exercise native success and patch denial but not the advertised schema;
seam=none; no_claim=loopback SDK tests do not prove external-model or packaged GUI success.

- 修前 capture 074：新增三项回归均失败。Runner 的 required 仍为空，Host 不认识选择字段；
  这验证了协议链路缺口，未重放失败真实任务。
- Runner 用真实 Pi SDK 检查准备与实际请求 schema 一致、普通 patch 保留、fingerprint 变化及
  schema 漂移在 Provider 请求前拒绝。
- Host 冻结/恢复表覆盖两种选择与反向变化、字段篡改。
- 原 real Pi + loopback SSE 双模式测试增加 wire/持久快照断言，继续验证真实读取、新增、
  审批一次、检查点及终态，不使用自造工具 evidence。
- 原防覆盖、并发、缺父目录、补丁拒绝与取消测试必须保持通过。
- 完成定向回归、差量审阅后才重新打隔离 QA 包；新真实项目通过前，不能称 R10 或 P3 成功。

## 独立遗留

失败 consequential tool 在缺独立无效果持久凭据时仍保守阻断，不凭 `isError=true` 推断可重试。
本次不放松该门禁，不自动续跑 R10。R5 确认承接、R6 审批 toast、其余 P3/P4/P5 仍按总计划推进。
