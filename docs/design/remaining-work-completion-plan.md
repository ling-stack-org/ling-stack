# Ling Stack 未完成工作收口计划

Status: active execution plan; branch-local implementation and verification are recorded below
Owner: Ling maintainers; one integration owner for each delivery batch
Last verified: 2026-11-18
Branch-cut baseline: `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63`
Current main integrated locally: `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63`.
Target: 2027-03-15 release-candidate closure for the active delivery queue
Canonical status source: [Implementation Status](implementation-status.md)
Code and test anchors: each work package keeps its owning plan and contract
M0 audit packet: [Baseline And Decisions](remaining-work-m0-baseline-and-decisions.md)
14-item execution overlay: [Remaining Work 14-Item Delivery Plan](remaining-work-14-item-delivery-plan.md)

## 执行状态

执行分支为 `codex/remaining-work-implementation`，实现保存在独立 Git worktree 中。当前目标由本工作线程推进，
整合责任由本线程承担；外部平台验收的人员与环境仍待落实。

- M0 的 main 基线、隔离分支、计划索引、PR 快照、owner/平台资源审计表和六项决策包已记录在
  [M0 Baseline And Decisions](remaining-work-m0-baseline-and-decisions.md)。六项产品决策、每项 active
  work 的命名 owner/平台预约及 PR/CI 逐项闭环尚未完成，因此 M0 尚未整体完成。
- 本次复核从 `origin/main@81f216d7de8211257448451ddfecde94fcf0ec63` 新建目标分支和独立
  worktree；目标分支尚未推送、开 PR 或合并。提交 PR 前仍必须重新做 main 合并、迁移和受影响
  测试复核。
- 当前批次覆盖 External Work 8.0/8.1、Channel Context lineage/quote/redaction/startup reconstruction、F5
  rerun/approval/capacity/stop/recovery、Automation ingress、Goal supervision 和 Runner
  input rebind；这些是本地 branch implementation，不能写成远端合并或已发布。
- F5-04 已在本地实现事务内 source/policy 复核、持久化幂等意图和 POST/GET caller；F5-05
  已接入独立 node-rerun approval owner、checkpoint 和 post-commit 绑定；F5-06 已在同一
  writer 内创建冻结的目标 Run/WorkUnit/Attempt/fence 和 receipt。定向审批、迁移/恢复、
  SDK 输入重新绑定、目标提交及普通入口隔离回归通过，Contracts/Core/Daemon/API client/
  Runner 生产/测试类型检查和受影响包构建通过。F5-07 已接入只读代次依赖投影，分叉/
  汇合、原结果不变、冻结 pins、reopen 及 Origin/scope 回归通过。F5-08a 已接入从未派发
  目标的专属取消与同源保留位释放，具备幂等/回滚/重启和损坏审计回归。F5-08b 已接入
  当前执行前只读复核，重验审批/源/策略/产物/runtime/冻结输入，并补齐本地回调和历史
  启动证据的阻断；F5 与路由 145 项、合同与客户端 15 项及四包类型检查/构建通过。
  F5-08c1 已接入重跑专属容量 owner、workspace migration 229 和 Host 全局 schema v3；
  旧容量凭据/释放历史/外键保留及精确 v1/v2 升级回归通过，229 专项 32 项、全局 Store
  69 项、registry migration 44 项、运行时容量 137 项和 F5/路由 145 项通过；Core 构建及
  Core/Daemon 生产和测试类型检查通过。F5-08c2 专属容量 prepare/reserve/attach 已接入；
  交接与 F5/路由合计 205 项、Core 容量及 continuation 37 项通过，Core 构建及 Core/Daemon
  类型检查通过。F5-08c3 已接入从未派发容量的取消释放：取消事务撤销已 attach gate 并写入
  durable release outbox，迟到 reservation 可在恢复路径按原身份释放，Host/ACK 中断保留
  同一 outbox；释放后重新准备容量必须经过新的 intent、approval 和 owner identity。c3 的
  handoff 窗口、迟到 attach、损坏审计/部分 receipt、失败回滚、HTTP 释放和 fresh-intent
  回归已通过。F5-08c4 已在 workspace writer 内接入冻结重跑目标的完整本地资源组准入：按
  持久化 runner input、写锁策略、Provider、Runner 和 Channel 推导 lease/semaphore，原子
  写入并保持 Host dispatch gate 未消费；重复调用返回同一 capacity record。F5-08c5 已接入
  专属一次性 dispatch gate：通用 gate 仍拒绝 rerun owner，只有专属 wrapper 在资源组完整、
  source/owner/digest/prestart 均复核后消费一次；随后由专属 Host receiver 在同一 SQLite
  writer 内原子 claim 目标 Task/WorkUnit，并通过冻结的 Runner input 进入既有执行监督链。
  F5-08d 已接入已派发目标的 exact-fence stop boundary：停止请求只进入 cancelling、触发
  active run，并保留 Host capacity，直到 local writer drain 与 Host effect coverage 形成停止证明。
  本地 finalizer/retry、Host stopped release、capacity ACK 和无 live registry 的 HTTP recovery 已实现并
  通过回归。F5-08e 已接入原始 Pi receiver 的本地 streaming Provider smoke：目标通过真实适配器
  完成一次请求，完成后 capacity release 仍由只读 durable dispatch receipt 支撑首个响应和重复
  请求的幂等判断；该 receipt 不重新授予执行权限。启动恢复现在会重新读取已派发重跑的
  exact receipt：终态且 Host drain/effect coverage 完整时写入 stopped release，否则写入一次
  `diagnostic_stuck_detected` unknown-outcome 诊断并保留 Host capacity，绝不自动重派。两个独立
  daemon 进程共享临时 Host/SQLite 的本地重启回归已通过；真实 Runner/Provider 停止确认、外部
  Provider/Daemon 验收仍未完成。
- 本分支的源码、定向验证、远端合并和发布验收分别记录，不能相互替代。
- 2026-11-18 的 14 项状态复核已转成独立执行台账；当前第一项跨切片本地交付是权限预览
  `POST /runs/policy-preview`。它复用实际 Run dispatch 的 `resolveSessionRunPolicy`，校验
  channel/task 归属和 approval profile，标记 full access 的确认要求，并保证不创建 Run、Approval、
  Artifact 或状态迁移。该切片的 Contracts/Core/API Client/Daemon 类型检查、Daemon build 和两项
  HTTP 回归已通过；分支仍未推送、开 PR、合并或部署。

## 1. 目标与完成定义

本计划把当前未完成工作收敛成一个可验收的 Release Candidate 目标。目标是完成
当前已经批准、可以直接推进的主线，并把需要产品决策或新的产品设计的事项从交付
队列中明确隔离。它不承诺在一个周期内把所有长期设想全部实现。

到目标日期，以下条件必须同时满足：

1. 运行安全、审批、恢复、重跑和证据链在 Core、Daemon、Web 的受影响路径上闭环；
2. 关键主线通过定向测试、类型检查、构建、浏览器验收和至少一次真实 Provider smoke；
3. 需要发布的桌面能力通过签名、干净机器、macOS/Windows、无障碍和升级路径验收；
4. Chrome、Office/WPS、媒体任务和 External Work 的已纳入能力都有可复现的验收证据；
5. 未知副作用、审批越权、跨会话泄漏、重启重复执行和旧入口误调用均保持 fail closed；
6. `implementation-status.md`、各 owning contract 和发布证据与实际结果一致，未把本地
   源码通过写成已发布或已部署。

## 2. 范围决策

### 2.1 本轮必须完成：Active Delivery / Platform Closure

这部分进入 16 周主线，但“完成”包括源代码、验证、review、合并和平台收口，不只是
本地实现：

- **运行与可靠性**：Ling Multi-Agent Safe Concurrency、F5 Node Rerun Contract、Native
  Execution Engines、Channel Execution Completion、Channel Context Processing、Ling
  Agent Session、Memory Review Policy。
- **会话与审批体验**：P2 Conversation Experience、Conversation Surface、Right Dock
  Responsive Visibility、Workspace Command Rule Approval、Permission Presets、Sidebar/
  Approval/Proposal Dialogs、Thread-First Work History、Project Defect Remediation。
- **集成与执行工具**：Chrome Browser Built-in Plugin、Bundled CUA Driver、Desktop
  Computer Use PiP、Office Documents Native Plugin、Bundled GStack Client、Conversation
  Media Generation、External Work Phase 8.0/8.1。
- **桌面与视觉交付**：Desktop Theme Persistence、Shared Component Theme Presentation、
  Official Scene Themes/Custom Media Background、Ling Journey UI Visual Adaptation。
- **持续维护项**：Provider Model Catalog and Discovery 以正常目录审查和连接器维护为闭环；
  不再把它当作新的功能开发目标。

### 2.2 本轮只做决策，不默认开发：Pending Product Reopening / Architecture Decision

第 1 阶段完成决策包和安全审查；只有明确批准的条目才进入后续小周期：

- External Agent Skill Discovery and Adoption；
- Core Tools Runtime Boundary；
- Mobile Remote Access；
- Work Board；
- Startup and Diagnostics；
- Workspace Tools Embedded。

Mobile 继续保持在当前产品验收范围之外，除非安全评审和产品负责人明确重新开放。

### 2.3 本轮建立候选池，不承诺完成：Tracked Follow-ups

以下事项保留合同和入口，但不与 Release Candidate 争抢执行资源：

- Jimeng live generation、stored-artifact image-edit、image-to-video 的真实 Provider 验收；
- Provider profile 清理、Keychain 迁移、Workspace State Storage rollout；
- AI Councils、治理通知、会话记忆引用、活动摘要与 exploration batching、富输入物化；
- Multi-Agent Requirement Shaping、Native Skill Recording 后续入口；
- SQLite 继续模块化、Automations 的更丰富监控源/桌面通知/外部目的地。

这些事项在本轮末做一次重新排序；没有产品负责人、成功指标、依赖和验收方式的条目不进入开发。

## 3. 交付顺序与里程碑

计划按 16 周执行。每个阶段先在干净的 `origin/main` worktree 中建立基线，保留当前
`codex/ling-companion` 工作树和其他 WIP，不执行 reset、clean 或覆盖。

| 阶段 | 周期 | 交付内容 | 阶段出口 |
|---|---:|---|---|
| M0 基线与分流 | 第 1 周 | 已建立 worktree、PR/CI 快照、owner/平台矩阵和六项 decision packet；继续完成命名 owner、资源预约与明确的 approve/defer 结果 | 范围冻结；每项 active work 有命名 owner、输入、输出和验收；决策项有明确的 approve/defer 结果 |
| M1 运行安全闭环 | 第 2–5 周 | Safe Concurrency 的 review/CI/merge 收口；F5 从只读 plan 接到 Run/WorkUnit/Attempt/fence/approval、下游失效、取消、重启、重复点击和真实 Provider；Native Engine T7；Channel Execution Completion 合并与远端 main 核验 | 重跑至多一次副作用；未知效果保持阻塞；并发默认仍关闭，目标组合有真实 daemon/Provider 证据 |
| M2 上下文与会话闭环 | 第 4–8 周 | Context condensation、quote eligibility、持久化/重启恢复、redaction ownership；Permission/Command Approval；Conversation Surface、Right Dock、Sidebar/Proposal、Thread-first、P2 和 Ling Agent Session 的浏览器与恢复验收 | Channel、普通 Conversation、私聊三类入口共享同一权限和证据语义；无跨 scope 泄漏；失败、过期、空态和恢复均可观察 |
| M3 集成、媒体与桌面 | 第 7–11 周 | Chrome 自动 Host/双平台/真实 Chrome；CUA/PiP；Office/WPS；GStack 包；媒体任务统一注册、付费任务幂等、恢复投影；External Work 8.0/8.1；主题与背景包 | 真实浏览器、真实 Office/WPS、目标媒体 Provider 和包内资源均有证据；付费操作有审批和成本边界 |
| M4 发布收口 | 第 12–15 周 | macOS arm64、Windows x64 签名包；干净机器、升级/损坏资源、无障碍、Chrome Store、依赖/许可证/公开仓库检查；补齐 Memory/Skill Learning 等发布门 | 所有宣称能力都有平台和结果记录；无未解释的 failed/unknown；CI、review、merge 完成 |
| M5 目标审计 | 第 16 周 | 复核主线、关闭已完成计划、更新状态索引和 release evidence；整理 2.2/2.3 的下一周期候选 | `origin/main` 上形成可复现 Release Candidate；未完成项都有明确去向和下一动作 |

阶段允许小范围并行，但 M1 的安全、租约、fence、恢复和审批契约是 M2/M3 的前置条件。
任何阶段不得用 UI 通过或静态测试通过替代真实执行、平台或发布验收。

## 4. 关键工作包

### 4.1 F5 节点重跑

当前分支已完成 F5-01/02/03 的合同预检、Host 只读观察和 admission plan，并在本地完成
F5-04/05/06/07/08a/08b/08c1/08c2/08c3/08c4/08c5/08d；后续实现顺序为：

1. 根据不可变 source snapshot、policy 和 idempotency key 创建唯一 rerun intent；
2. 原子提交新的 Run/WorkUnit/Attempt/fence 和 approval lineage，不复制旧 Attempt；
3. 在提交前重新校验 stop、lease、effect、dependency、artifact 和 graph facts；
4. 对下游 WorkUnit 做精确失效，处理取消、重启、超时和重复点击；
5. 已完成从未派发目标的容量取消释放：在 cancellation writer 内撤销 gate、保留释放
   outbox，并在 Host/ACK 恢复中只处理同一容量身份；释放后必须新建 intent、approval
   和容量 owner，旧 intent 不得复用；
6. 已完成专属完整资源组准入：在 workspace writer 内按冻结输入原子取得 lease/semaphore，
   不消费 Host dispatch gate，重复调用只返回同一 capacity record；
7. 已接入专属一次性 dispatch gate：只允许完整本地资源组的同一 rerun owner 消费一次，通用
   dispatch 入口继续拒绝该 owner；
8. 已接入已派发目标的 exact-fence 停止请求、active-run AbortSignal、local writer drain 与
   Host completion/effect coverage gate；证据不足时保留 execution authority 和 capacity；
9. 已接入原始 Pi Runner receiver 及本地恢复观察；未知副作用不得自动重放。receiver 的 HTTP
   回执在 live capacity 释放后读取 durable dispatch receipt，不能把历史回执当作新的执行授权；
10. 已接入启动恢复对派发 receipt 的 unknown-outcome 保留：只有终态、精确 Attempt 和完整
   Host drain/effect coverage 才允许 stopped release；未知副作用写入可重入诊断并保持 blocked，
   不自动重放。两个独立 daemon 进程的本地重启回归已覆盖保留 capacity、终态不变和诊断幂等；
   仍需外部真实 Provider、停止确认、A17/A18 证据；
11. 完成 Web/CLI/daemon acceptance 后，才开放显式 rerun 入口。

### 4.2 上下文处理

保留 durable messages、memory、artifacts、workflow 和 approvals 为唯一权威；缓存视图只能
重建。summary 生成、替换和失效由一个 owner 负责；引用统一检查 stale/deleted/private/
policy-blocked；重启和 late materialization 使用版本/CAS 拒绝旧写入；prompt、API 和 artifact
redaction 统一且失败时 fail closed。

目标分支已先落地摘要协调器的 source-fence/CAS 边界、摘要输入与结果脱敏，以及会话回复/引用项
的 exact-effective、scope、visibility 检查和 id-only rejection diagnostics。source-level quote
eligibility 已接入 proposal source-reference 和 channel/workflow context-pack caller；context view
lineage 已以 SQLite migration 225 持久化，并覆盖 reopen、旧投影和匹配 CAS 的拒绝回归。daemon
重启时从 durable sources 重建 canonical projection，并对 private-chat、workflow-proposal、workflow-step、
channel reply 和 selector 视图做只读复水；workflow/private/proposal 视图做 view fingerprint 复核，
reply/selector 的 freshness 继续由 durable projection 判定，避免把 request-specific prompt envelope 当作持久事实。
specialist/inspect 现在由 durable source turn、角色投影和协议/active-work 元数据重建 prompt envelope；
specialist 必须带精确 consumer teammate，inspect 使用 operator projection，启动恢复不写回 lineage。
API/artifact redaction 已在公开 artifact/workflow-evidence 投影层完成本地收口；Web/security 和平台验收仍未完成，本地定向测试通过不等于
PR、合并、部署或发布验收。

### 4.3 多 Agent 与原生执行

先完成 Host enforcement、隔离 worktree、候选结果、审批 apply、清理 journal 和恢复证据的
发布门，再考虑扩大 Provider 或跨平台范围。Native Engine 保留协议 Adapter，把启动归属、
监督、取消、停止证据、资源释放和续跑统一到主线控制模块；OpenClaw approval/remote-stop、
Electron 交互、签名和其他平台在 T7 中逐项验收。

### 4.4 会话、审批和外部集成

共享 Composer、WorkCell、evidence、attachment、approval queue 和 proposal dialog 的状态
必须来自同一 daemon contract。Workspace command approval 要证明 once/persistent、revoke、
restart 和 unsafe-command rejection；Chrome/Office/CUA/媒体/External Work 只通过已有审批、
artifact、audit 和权限边界接入，不另建平行执行路径。

## 5. 验收矩阵

| 层级 | 必须覆盖 |
|---|---|
| Contract/Core | 状态机、CAS、fence、lease、approval、redaction、migration、unknown effect、idempotency |
| Daemon/Integration | SQLite reopen、daemon restart、SSE/reload、Git/worktree、late result、cancel/drain、真实 Provider smoke |
| Web/Browser | Channel、普通 Conversation、private chat、Sidebar、Work Board 相关入口；空/错/过期/恢复/窄屏；真实浏览器而非只看 DOM |
| Native/External | Chrome Native Messaging、Office/WPS、CUA/PiP、OpenClaw/Kimi/Codex 目标场景、真实媒体任务的付费与取消边界 |
| Distribution | macOS arm64、Windows x64、签名、干净机器、升级/损坏资源、无障碍、Store/发布流程 |
| Repository | `typecheck`、受影响 package tests、`build`、`check:docs`、`check:i18n`、`check:licenses`、`check:public`、dependency-security |

最小验证顺序：先跑受影响 package 的定向测试和 typecheck，再跑 Web/daemon/native 集成；
阶段出口通过后才跑完整构建和平台包。测试失败时先修复或重新划定范围，不通过删除断言或扩大 skip。

## 6. 风险控制

- **范围膨胀**：2.2/2.3 不得偷偷进入 M1–M4；任何新增工作先说明替代项和对目标日期的影响。
- **工作树污染**：所有实现从干净 `origin/main` worktree 开始；当前 `codex/ling-companion` 的 WIP
  只读、保留，不做 reset/clean/强制 rebase。
- **平台证据滞后**：第 1 周建立 macOS/Windows/Chrome/Office/Provider 预约和负责人；没有平台证据
  就不能标记完成。
- **未知副作用**：重跑、取消、恢复和媒体付费操作都以 unknown/blocked 为默认安全结果，不靠超时猜测。
- **发布与实现混淆**：源代码合并、CI 通过、PR 合并、签名包、现场验收分别记录，不用其中一项代替其他项。
- **付费与外部操作**：真实 Provider 和外部 action 只在已有预算、审批、停止条件和审计账本下执行。

## 7. 目标日期与调整规则

建议把 **2027-03-15** 设为本轮 Release Candidate 目标日。该日期假定有一名整合负责人、
每个工作包至少一名执行者，并允许平台验收资源按阶段提供；它不是对缺少资源时程的承诺。

若 M1 结束时 F5 或 Safe Concurrency 仍没有可复现的恢复/副作用证据，目标不得通过增加 UI
范围来掩盖，应将 M3 中的主题、GStack 或非核心媒体适配移到下一周期。若 M4 仍缺签名或干净
机器证据，发布目标只能降级为 source-complete，不能称为 Release Candidate。

本计划完成后，已闭环计划移交 owning contract 并从 unfinished index 删除；决策项和长期候选
仍保留，但必须带有新的 owner、范围和目标日期。
