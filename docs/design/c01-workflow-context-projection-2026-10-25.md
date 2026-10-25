# C01：Workflow 步骤上下文的无损投影

状态：R11 真实问题的修复设计；不是完整项目或新包验收通过记录。

## 已确认的问题

R11 Engineer 已真实创建测试文件并通过七项测试。独立 QA 在创建 Task/Run 前被
`8382/6656 estimated input tokens` 拒绝。原预算门禁正确，不能提高预算或丢约束来放行。

3375 字的相同目标在发送上下文中出现三次：Graph 编译生成的 Workflow objective、
Proposal 节点的 Overall scope，以及 Context View 单独的 must-keep objective section。
QA 的全部 operation bindings 另占 15227 字符；它们包含实际命令、cwd、权限范围、
内容来源和 sourceRefs，本次完整保留，不用摘要代替。

## 职责与不变项

1. 持久化 workflow objective、graph node prompt、step prompt 仍保存完整原文。
   它们用于审计、来源、启动权威和恢复比较，不回写、迁移或清理历史。
2. 运行时 Context View 负责投影。共享纯 renderer 识别 Host 自己生成的精确 graph wrapper；
   一份完整目标保留在原 must-keep section，不通过字符串模糊匹配猜测任务。
3. 只有 graph/schema/id/node/title/结构指纹一致，且输入等于持久 step.prompt、
   又逐字等于共享 renderer 重建结果时，才移除 graph wrapper 的重复 objective。
   结构指纹不覆盖 node.prompt/name/skillId，不可把它单独当内容完整性证明。
4. Proposal 的重复 Overall scope 仅在 sourceProposalId 与 graph.id 绑定一致、
   标题和完整 objective 构成的已知前缀逐字一致时移除。其余节点指令逐字保留。
5. 显式 taskPrompt override、不匹配/未知包装、修改后的 node 内容或手工步骤保持原文。
   不删任意自定义正文中重复出现的目标，不截断 operations 或私自缩短权限边界。
6. 原预算计算、compaction、权限、工具、审批、fan-in 与 TerminalReport 门禁不变。
   独立必保留内容本身过大时，仍显式 blocked，不允许降级或靠叙述宣称成功。
7. 已开始 Run 的恢复继续使用冻结 Runner input；新投影只影响未启动步骤的新准备，
   不重建或修改已开始执行的请求。

## R11 恢复边界

只允许通过已有单步 retry 入口处理尚无 Run 的 blocked QA。它会重新核验依赖、
上下文新鲜度、provider、权限、启动 owner 和预算，再且仅再创建该 QA 的 Task/Run。
Engineer 成功记录及产物不变，不重编整个 workflow，不重发包含 exclusive-create 的原请求。
重复 retry 不能在该步骤已不再 blocked 后再次派发。

## 验证与打包

- 原生回归先 RED：目标出现三次、重复导致超预算；修复后只出现一次且预算仍为 6656。
- 覆盖显式 override、未知图、graph/node 不匹配，以及结构指纹未变但节点正文变化。
- 临时 SQLite 覆盖上游成功 → 下游准备被预算拒绝 → 仅重试下游 → Run 正确关联；
  上游事件与记录不变、持久 prompt 不变、依赖证据保留、重复 retry 不派发。
- 补齐上下文、agent consistency、terminal summary 和 retry ownership 的邻接回归。
- 新共享模块显式加入固定 packaging closure，补受影响差量独审；不改审批 reader 或门禁。
- 原生/隔离回归不替代新 macOS 包真实 QA-only retry。新包冻结、差量审阅、
  包身份读回通过后再操作客户端，保留原 R11 失败和现有成功产物。

R5 简短确认承接、R6 审批 toast、其余 P3/P4/P5 和 H09 门槛仍独立跟踪，
不能因为本次去重回归通过就标为全部完成。
