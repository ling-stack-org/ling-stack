# Ling 多 Agent 完整目标设计

状态：active implementation target；代码主链已在当前分支实现，发布与平台门禁仍按本文收口。
Owner：Ling maintainers。
最后核对：2026-11-10，基于 `origin/main@841dab4d`。
文档类型：总设计 / 目标规格。

本文是 Ling 多 Agent 工作流增强的单一目标入口。它把安全并发、隔离 worktree、恢复、
模板、会话 Graph、Host 总容量和 Experience review 放在一条产品链上；具体字段、事务和
代码责任仍由[安全并发详细设计](ling-multi-agent-safe-concurrency-detailed-design.md)、
[实施计划](ling-multi-agent-safe-concurrency-implementation-plan.md)和
[Orchestrator Advanced](orchestrator-advanced.md)拥有。

## 1. 目标

Ling 要能把一个用户任务拆成少量有依赖关系的工作步骤，在满足安全条件时并行执行，
把每个步骤的结果汇总回原会话，并让用户可以理解、暂停、批准、取消、重试和恢复整个
过程。用户看到的主体验仍然是连续的文本会话；并发结构只作为会话中的折叠辅助视图。

完整目标不是增加一个名为 `Super-agent` 的产品，也不是创建第二个 Agent runtime。目标是
让现有的 Ling 执行路径具备以下闭环：

```text
用户消息
  -> 冻结 workflow/template、参与者、权限与副作用计划
  -> Host/workspace 统一容量准入与公平排队
  -> Run / WorkUnit / fenced Attempt
  -> 串行执行，或显式隔离的 sibling worktree 并行执行
  -> branch evidence、检查与确定性 fan-in
  -> candidate-only 或独立审批后的目标 apply
  -> TerminalReport 回到原会话
  -> 可选的 Experience review candidate
  -> 用户审核后进入既有 skill、memory、channel review 流程
```

代码达到目标，要求所有纳入范围的执行入口使用同一套 owner、capacity、approval、
cancel、recovery 和 evidence 约束。发布达到目标，还要求选定 Provider、Runner、桌面包
和目标平台的真实验收，以及 review、CI 和 merge 完成。

## 2. 用户可见行为

### 2.1 普通会话

- 单个 Agent、单个步骤或串行 workflow 继续使用原来的文本消息流。
- 正常完成只显示回答和必要的 TerminalReport；不附加调度详情、资源卡或重复的成功卡片。
- Composer 的开始、继续、停止入口继续承接开始、恢复、重试和取消。
- 失败保留会话中的失败事实；审批使用既有弹窗；冲突使用既有冲突修复窗口。

### 2.2 多 Agent 或真实并行

- 只有存在多个真实参与者，或 accepted workflow 中存在可验证的并行依赖时，才显示 Graph。
- Graph 内嵌在同一条会话工作单元中，默认折叠，展开后仍然是只读投影。
- Graph 只显示步骤名称、依赖关系和简洁状态；不显示独立详情控制面，也不创建新的执行权限。
- Graph 与列表共享 step id、状态、审批和选择；断连或缺失事实显示 unknown/stale，不能推断成功。
- 单个步骤、普通文本回复和没有并行关系的 workflow 不显示 Graph。

### 2.3 Experience review

Experience review 是已结算 Run 的经验候选提炼入口，类似“从一次执行中提炼可复用经验”，
但它不是自动修改系统的开关：

- 消息操作区保留一个小入口，与 Copy message 相邻；打开后使用非模态面板。
- 自动提炼只生成有界、可追溯、待审核的 memory、channel method 或 skill revision candidate。
- 候选包含来源 Run、证据引用、作用域、原始 skill revision 和校验结果。
- 没有成功工具证据时，不能伪造已验证 procedure；失败/取消 Run 只有显式选中才可复盘。
- 用户审核、应用、撤销仍由现有 Memory、Skill、Channel review 流程负责。
- 自动策略默认关闭；开启后仍受 workspace policy、Provider、预算和 source authority 限制。

## 3. 运行时模型

### 3.1 四个层次

| 层次 | 权威 | 主要职责 |
| --- | --- | --- |
| Core | SQLite、类型、不变量 | workflow 快照、Run/WorkUnit/Attempt、owner、capacity intent、approval、evidence 和迁移 |
| Daemon | Host、物理执行、恢复 | 解析策略、准入、Runner/Provider/工具、Git worktree、drain、reconcile 和事件发布 |
| Web/Desktop | 真实状态投影 | 会话流、Composer、审批弹窗、Graph/list、冲突修复和只读设置回读 |
| Learning review | 独立观察作业 | 从已结算证据生成候选，不拥有执行、权限或自动发布权 |

workflow DAG 是接受后冻结的业务依赖图。动态 delegation 是某个 Run 的子执行树，不能改写
DAG 或另建调度系统。Graph 是上述事实的 read model，不能反向签发 Task、Run、审批或 Git effect。

### 3.2 副作用分类

| 类别 | 默认行为 | 允许的并行条件 |
| --- | --- | --- |
| `analysis_readonly` | 串行或等待 | Host 能证明只读 executor/profile，且通过统一容量准入 |
| `test_artifact_only` | 串行或等待 | Host 只允许本 Attempt 的 artifact/scratch 写入，不能写 workspace |
| `workspace_write` | 默认串行 | 显式 isolated worktree、父锁、Git coordinator、结果封存和审批协议 |
| `external_mutation` | 严格串行 | 本目标不自动放开，必须沿 owning contract 单独审批 |
| `release` | 严格串行 | 本目标不自动放开，发布仍是独立门禁 |

skill 名称、模型提示词、工具列表或模型自报不能把写入执行宣称为只读。Host 能力不足时
保持串行或阻塞，不能为了增加并发数降低安全等级。

### 3.3 统一容量

并发额度表示同时获得执行资格的 Run/Attempt，不表示打开的聊天、DAG 节点数、累计子代理数、
token 额度或费用额度。有效上限取 Host、workspace、channel、workflow/group、Provider、Runner
和资源锁的交集；所有入口共享同一持久准入：

- 普通 Run、workflow step、delegation child、approval resume、user-input continuation、native
  profile 和 automation 都必须绑定精确 owner/fence。
- `preparing`、dispatch-ready 和实际 Attempt 都占用对应预留；整组资源要么全部取得，要么全部回滚。
- Host 总池使用 canonical 用户存储根下的 `global.sqlite`；workspace 与 Host 通过 intent/receipt/
  dispatch gate/release outbox 交接，不用内存 semaphore 冒充跨进程限制。
- dispatch ACK 未知、effect 未确认或物理 drain 未完成时保留容量；TTL、客户端关闭和界面终态不能释放它。
- 配置只由可信 Host 安装；新 round 冻结实际并发值，配置变化不升级旧 round、不重签旧审批。

默认候选策略是 disabled、总量 4、只读 4、workspace write 2、Provider 4、Runner 4、隔离 sibling 2。
公开隔离入口继续 candidate-only；可信 Host 明确启用后，新隔离 round 才能选择 2–4 档位。

## 4. 隔离写入和结果交付

### 4.1 计划与执行

执行前冻结 workflow/template 版本、step/participant、skill source、Provider/Runner、safety plan、
scope plan、execution root、resource keys 和 approval fingerprint。审批消费前不创建真实执行身份；
审批消费后只能补齐真实 Run/WorkUnit/Attempt，不得改变已批准的 semantic basis。

每个 writing sibling 拥有独立 worktree、branch ref、Attempt、Host operation journal 和 evidence。
共享 Git common directory 由 Host Git coordinator 串行操作；Runner 不得写 `.git`、用户 checkout、
其他 sibling、共享缓存或未授权外部路径。

### 4.2 Fan-in、候选与应用

分支完成必须同时具备 terminal、子树 quiescence、工具/effect receipt、tree capture、检查结果和
artifact digest。确定性 fan-in 按冻结顺序读取 branch packet；缺 packet、owner 不匹配、冲突、未知
effect 或检查失败都生成结构化 blocker。

公共入口只生成 verified candidate，target checkout 保持不变。目标 apply 必须满足：

1. 单次、当前 revision 的 merge approval；
2. clean target、expected HEAD、repository fence 和 candidate digest 全部匹配；
3. Host Git actor 持有一次性 permit 和目标 lease；
4. no-force fast-forward 成功，并在 SQLite 中记录 intent、receipt 和 applied 状态；
5. 崩溃或结果未知时只 reconcile exact evidence，不重放 Git effect。

### 4.3 清理

active、unknown、dirty、conflicted、待审批和被 artifact 引用的 worktree 必须保留。只有原 Attempt
真实停止、effect journal 收敛、branch result 已封存且 retention 条件满足时，才可执行 clean-only 回收。
cleanup intent/receipt/tombstone 独立于业务 round；duplicate、startup 和 reopen 只观察既有 intent，
不重复物理删除。

## 5. 恢复、重试和会话连续性

| 情况 | 处理 |
| --- | --- |
| 准入前失败 | 只释放本次未派发 reservation，保留 Run/Attempt 的失败事实 |
| dispatch ACK 未知 | 保留原 owner、fence、capacity 和 effect journal；核对原执行，不重派 |
| daemon 重启 | 恢复持久 queue、intent、receipt、approval、round 和 evidence；不因启动自动重跑副作用 |
| 用户取消 | 禁止新准入，等待每个实际 executor drain；未知停止不能写成成功或可重试 |
| 分支失败 | 按 workflow failure policy 处理 sibling；required coverage 未满足时不发布成功 TerminalReport |
| retry | 由会话继续入口触发；先核对旧 Attempt 已停止和现场状态，再复用安全 checkpoint 或创建新 generation |
| 冲突修复 | 先只读发现和生成修复计划；单独开始按钮才创建新 Run/Attempt/审批/worktree |
| 审批恢复 | 复用原 scope、当前 authority 和精确 Host receipt；旧 approval 不授权新 generation |

重启、reload、SSE 重连和重复点击只能重新读取同一事实。客户端不能通过轮询、事件回调或按钮状态
伪造终结，也不能在普通文本流旁边创建第二套重试控制面。

## 6. 交付阶段与依赖

```text
G0 目标与契约收口
 └─> G1 安全副作用与 workspace 准入
      └─> G2 isolated worktree、fan-in、审批 apply
           └─> G3 重启/取消/冲突/未知结果联合验收
                ├─> G4 模板 registry 与 authoring UI
                └─> G5 会话 Graph/read model
                     └─> G6 Experience review candidate 闭环
                          └─> G7 Provider、packaged、平台与远端交付
```

| 阶段 | 目标 | 当前状态 | 关闭条件 |
| --- | --- | --- | --- |
| G0 | 总设计、详细协议、实施计划、状态索引一致 | 本轮补齐 | 文档链接、状态和非目标一致 |
| G1 | 副作用分类、Host enforcement、workspace/Host capacity、原子准入 | 本地实现 | 目标执行入口回归、真实链路和 review/CI |
| G2 | sibling worktree、branch result、fan-in、candidate/apply、cleanup | 本地实现 | Git/SQLite/Host/客户端组合验收 |
| G3 | restart、cancel、retry、unknown、approval、conflict recovery | 本地实现与受控验收 | 真实 Provider/packaged/平台组合验收 |
| G4 | versioned registry、compile pin、authoring UI | 本地实现与受控浏览器验收 | 真实保存/权限/回退验收 |
| G5 | 同会话折叠 Graph、列表回退、键盘/窄屏/reduced motion | 本地实现与受控浏览器验收 | packaged/cross-platform accessibility |
| G6 | 自动提炼候选、人工审核、应用/撤销、来源与作用域 | 源码已实现，质量与发布门禁分离 | source Run、证据和 review API 联合验收 |
| G7 | 真实 Provider、Desktop package、Windows/Linux、review、CI、merge | 未完成 | 选定发布矩阵全部留存脱敏证据 |

阶段状态只代表代码和已执行证据。受控 Provider、fixture、development build 或本地浏览器不能代替
真实 Provider、packaged、目标平台和远端交付门禁。

## 7. 当前实现责任与下一步

当前代码应沿以下路径继续推进：

1. 以当前 `origin/main` 和本分支 HEAD 重新运行 Core、Daemon、Web、Graph、模板、恢复和 Host capacity
   定向检查，确认文档中的证据仍对应当前源码。
2. 审计普通 Run、workflow start、delegation、approval resume、user-input continuation、native 和
   automation 的真实 reserve → dispatch gate → SDK/engine → drain → release 链路；发现未接入入口时补最小
   production wiring 与 TypeScript 回归。
3. 对每个配置档位验证 `enabled=false`、2、3、4、降额、重启、未知 dispatch 和跨 workspace 竞争，保持
   普通 workspace write 并发关闭。
4. 对会话展示只验证用户目标：普通文本不被打断，Graph 仅在真实并行/多 Agent 时出现且默认折叠，失败、
   审批、继续、重试、取消和冲突修复由原会话控件承接。
5. 仅在代码与本地验收稳定后，按独立交付动作进入真实 Provider、packaged、平台、review、CI 和 merge。

本轮不通过文档状态直接宣称发布完成，也不把普通写并发默认打开。

## 8. Definition of Done

### 代码闭环

1. 每个纳入范围的 Run/Attempt 都能追溯到 frozen plan、owner、fence、capacity receipt 和 terminal evidence。
2. 任意重复 start、重启、reload、SSE 重连、超时和未知 ACK 都不会重复模型、工具或 Git effect。
3. 资源不足、权限不足、scope 漂移、冲突、缺失 evidence 和未确认 effect 都 fail closed，并保留可恢复事实。
4. 普通文本会话在串行任务中保持原行为；Graph 无独立执行 API；公开隔离入口保持 candidate-only。
5. Experience review 只能生成待审核候选，不能自动修改 skill、memory、channel、权限或 workflow。

### 验收闭环

1. Core/Daemon/Contracts/API-client/Web/shared UI/runner-pi 的相关单元、类型检查和构建通过。
2. 真实 Git/SQLite/Host/Runner 的 2/3/4 档位、审批、fan-in、apply、drain 和跨进程竞争通过。
3. 生产 Web 构建的会话、Graph、冲突修复、重启、断连、窄屏和 reduced-motion 场景通过。
4. 至少一个脱敏真实 Provider Run 通过 provider check、持久事件、token usage 和 daemon restart 回读。
5. 选定发布矩阵的 packaged Desktop、目标平台、review、CI、PR 和 merge 证据齐全后，才可变更公开开关。

## 9. 回退和明确不做

回退只禁止新准入或回到 Graph/list 的既有只读投影；不删除 migration、evidence、candidate、approval、
unknown effect 或用户 worktree。已接受 round 继续按原 authority 安全收尾。

本文不包含：第二套 Agent runtime、无限并发、自动远端 merge/push/deploy、自动批准、自动发布、通用
模型评分或路由优化、未验证的 artifact-only QA 并行、跨 worktree 自动 undo，以及把 Experience review
变成无人工审核的自动进化系统。

## 10. 关联契约

- [Ling 多 Agent 安全并发详细设计](ling-multi-agent-safe-concurrency-detailed-design.md)
- [Ling 多 Agent 安全并发实施计划](ling-multi-agent-safe-concurrency-implementation-plan.md)
- [Orchestrator Advanced](orchestrator-advanced.md)
- [Bounded learning review runtime](learning-review-runtime.md)
- [Ling Implementation Status Index](implementation-status.md)
