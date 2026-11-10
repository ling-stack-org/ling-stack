# Run 压缩后的冻结任务约束

本页补充 [Harness 上下文可靠性设计](harness-context-reliability-integration.md) 的 H2。
摘要是可损的进度说明，不能替代已接受的用户任务。保留原任务也不能保证模型必然遵守输出格式；
真实产物仍须按原始要求严格验收。

## 证据与边界

真实 PqqdUw 案例产生了九个 committed seals。冻结输入含原始 JSON 的 `"name"`；SDK 压缩视图
没有逐字保留原任务。摘要仍提及 `name / rows / firstValue / lastValue`，因此不能断言 schema 错误
完全由失忆导致。旧 Run、结果文件和失败 verdict 保留，不修历史来制造通过。

## 模块与数据流

1. Runner 已有 prepared input 的 `userPrompt` 是不可变来源；未提供 prepared input 的本地 Runner
   调用只冻结本次 `formatTaskPrompt(task)`。不从摘要抽取约束，不推测字段，不加载其他会话。
2. 一个纯 projection 在 SDK 消息含 `compactionSummary` 时，把逐字原任务作为普通 `user` 消息
   放在首个摘要之后。已有完全相同的 user 内容不重复插入。初次输入不变，不改变末条角色、
   工具 call/result 配对、工具顺序或 SDK 内存/SessionManager 历史。
3. SDK context hook 使用该 projection 后再执行工具结果预算。Runner provider 边界再次验证
   原任务仍存在；丢失时 latch failure 并拒绝分派。压缩摘要请求不是任务请求，不按新任务处理。
4. Host 的 pre-compaction、installed view 和工具轮次 progress 都使用同一 projection。
   sealed model view 保存实际使用的用户约束，而不声称纯 SDK view 自带约束。现有 Run/Attempt、
   prepared fingerprint、context view、SHA-256、predecessor 和 admission fence 继续控制归属。
5. daemon restart 仅安装 Host 验证的 sealed view。projection 幂等；恢复后仍以本次冻结任务
   校验，不重发原始 prompt、不重放已完成工具，也不把 assistant-complete 视图改成 continue。
   seal 本身缺少当前冻结任务或含其他任务时，在安装/模型/工具执行前拒绝；不能恢复时临时
   合成未封存的前缀，再执行工具等待后续进度校验失败。开发期不为无约束旧seal保留兼容续跑。

## 异常与安全要求

- 原任务不提升成 system/developer 权限，不赋予新的文件/命令权限。
- 原任务超出模型剩余预算或 sealed view 大小上限时 fail closed；不裁剪任务、放宽预算或隐藏失败。
- SDK hook 抛错被吞后，provider 边界不能继续发送丢约束的任务请求。
- 原任务和 sealed view 内容保持内部受限证据，公共 RunEvents/UI 不增加私有全文。
- 不增加表，不更改 canonical conversation history、contextSegmentId、batch 或完成证据。

## 验收

先保留无修复时的红测，再验证纯 projection、SDK 实际中途压缩、重复压缩、恢复、Host progress、
丢约束拒绝、取消和容量拒绝。最后使用新唯一标记运行真实 packaged H2；旧失败案例不重发。
字段、anchors、十二批数据、唯一读取/写入、原子 action、sealed lineage 和终态 GUI 必须同时通过。
