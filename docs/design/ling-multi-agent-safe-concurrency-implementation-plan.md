# Ling 多 Agent 安全并发实施计划

状态：P1 源码与本地回归已落地；P2 隔离执行实现中，P3-P5 未完成。
Owner：Ling maintainers。
最后核对：2026-11-02。
文档类型：implementation plan；完成后将长期规则归入 owning contracts，不保留完成日志。
权威设计：[总体设计](multi-agent-app-detailed-design.md)、
[安全并发详细设计](ling-multi-agent-safe-concurrency-detailed-design.md)。
基线：PR #614 已于 2026-11-02 合并；从更新后的 `origin/main` 开发，不从旧 Harness 分支接续。
Code/test anchors：各阶段表格列出的模块与测试；尚未接入实际执行链的组件不算阶段交付。

## 1. 交付目标与边界

先让 Ling 能可靠地并发分析和检查，再让代码实现分支在隔离 worktree 中并发，
通过可恢复的集成、验证和审批交付结果。随后开放模板创作，最后提供 graph 视图。
保持一份 workflow、Run/WorkUnit/Attempt、审批和 TerminalReport 权威。

```text
P0 docs/baseline
  -> P1 explicit safety + Host enforcement + atomic admission
  -> P2 isolated execution + deterministic merge + approval
  -> P3 combined restart/cancel/conflict/approval acceptance
  -> P4 template registry + authoring UI
  -> P5 workflow graph
```

不纳入本计划：第二套 Agent runtime、全量 Harness 搬迁、通用模型评分/路由、
requirement shaping 产品扩展、自动远端 merge/push/deploy、跨 worktree 自动 undo。
`external_mutation` 与 `release` 不因 P2 完成而获得自动并行资格。

## 2. 文档与实现状态

| 阶段 | 当前状态 | 完成含义 |
| --- | --- | --- |
| P0 | DONE：总体设计、详细协议、实施计划与索引已对齐，文档检查通过 | 统一产品边界、协议、代码责任与验收入口，不代表功能完成 |
| P1 | 本地实现与回归完成，review/CI/merge 和平台验收未完成 | 安全类别贯穿全路径，Host 实际约束生效，原子准入与回归通过 |
| P2 | 实现中，尚未交付；普通 workflow 写并发仍关闭 | 隔离写入、封存结果、确定性集成、审批应用和故障恢复协议可运行 |
| P3 | 待实现 | 多分支联合与真实客户端验收通过，才允许选定 workflow 开启写并发 |
| P4 | 待实现 | registry 版本冻结、校验、authoring 与真实保存/编译流程通过 |
| P5 | 待实现 | 同一工作对象内 graph/list 一致、可访问、真实状态可靠 |

P2 当前边界：

- P2-A 的 immutable scope plan、fenced binding、round/journal 与迁移已实现并通过本地回归。
- P2-B 的 isolated Run cwd、Host file executor、沙盒与 evidence 绑定已实现并通过本地回归。
- P2-C 的 terminal branch result 封存和结果门禁已接入真实执行链；candidate 生成与固定
  Host 静态校验、持久 coordinator/completion barrier 与 startup/cancel/drain 已接入并通过
  本地回归。Core journal/migration 72 项、daemon Git/lifecycle/result 64 项、publication/recovery
  30 项通过；report 最终事务重新核验 retained evidence，移除 step pin 不绕过持久 round。
- P2-D 的 Host merge approval 基础已实现：冻结完整目标快照、候选与验证证据，审批只支持
  本地用户单次批准或拒绝，request/checkpoint/round 关联原子落库；不允许自动 reviewer、
  可复用规则或 permission-scope 授权。Core 审批/迁移及关联回归、daemon 真实 Git 审批
  回归通过。clean-target fast-forward 机制已有实现，但 permit、实际 apply 与恢复接线
  仍未完成；普通审批同意不代表已合入工作区。
- 内部 isolation planner 保持 `candidate_only`；普通 workflow 写并发仍关闭。静态校验
  明确记录 `projectTestsRun: false`，不等于项目测试、审批或 apply 已完成。

P1/P2 中各模块的故障测试随实现提交，不能把基本正确性留到 P3 才补。
P3 是端到端组合验收与缺口收口，不是第一次考虑取消、重启和审批。

## 3. Harness 取舍

以 #614 后主线实际文件为准。旧 reasoning-summary/Harness worktree 保持只读，
不整体 cherry-pick，不 reset，不把其未提交内容直接混入新分支。

| 类别 | 处理 |
| --- | --- |
| 主线已有 continuation、Attempt fencing、Tool Broker、delegation、预算/恢复、Completion Gate、TerminalReport | 复用并添加并发回归，不列为从零重做的 P0 大工程 |
| 旧基础与主线冲突、被主线替代的 patch 或恢复文件 | 不迁移；按当前实现重新定位真正缺口 |
| 旧 WIP 独有且与 P1-P3 有关的实现/测试候选 | 逐文件确认需求、diff、owner 和测试，必要时在当前主线重写最小实现 |
| 通用 evaluation/grading、summary 展示、独立 runtime 优化 | 不作为本轮并发前置；需要时进入其 owning plan |
| dynamic delegation 的开关、预算、真实 stop/ACK 与 packaged gates | 保持原合同；本轮不因静态并发完成而全局开启 |

每个被采用候选都应在对应 PR 说明原来源、当前必要性和重跑的验证。
“旧 WIP 有代码”不是验收；未采用不等于允许删除旧工作现场。

当前只记录两项小候选，不认定为已复现缺陷：

- `runtime/store-registry.ts` 的 canonical workspace key 去重；先验证现行调用能否传入
  等价路径并造成重复 store，再决定是否纳入 P1 的资源身份修复。
- `canonical-transcript-snapshot.ts` 的 child-action anchor 唯一性；先验证同一 child 的
  spawn + message 是否造成真实投影歧义，必要时作为 P3 的投影修复，不强行搬旧代码。

旧 WIP 的 migration 编号与主线已有用途冲突；不能照搬 SQL 或覆盖发布过的 migration。
deterministic evaluation 和 evaluation worker 也已有主线实现，不能因为旧 grades/job API
尚未迁移，就把通用 grading 误列为本轮缺失的执行底座。

## 4. 分支与小 PR 策略

P0 使用独立 `codex/ling-multi-agent-concurrency-plan` 分支。
P1 开工时更新远端，确认 P0 文档可作为基线，再从最新 `origin/main` 开实现分支。
如 P0 尚未合并，使用明确的短 stacked PR，不把未提交文件作为隐式依赖。
每个小 PR 列清行为、依赖、开关、回退与验收证据；review、CI、merge 分开记录。

建议按以下边界交付；只有相邻且能独立验证的单元才可合并成一个 PR。

| PR 单元 | 主要产物 | 依赖 |
| --- | --- | --- |
| P0 | 本设计、计划、canonical/index 对齐 | #614 合并 |
| P1-A | safety types、编译/存储/DTO 往返、保守默认 | P0 |
| P1-B | Host safety snapshot 与 tool/executor 强制约束 | P1-A |
| P1-C | candidate gate、原子资源/容量准入、持久 slots 交接、默认安全分析组 | P1-B |
| P2-A | immutable scope plan、fenced execution binding、integration store/journal 与迁移 | P1-C |
| P2-B | step worktree、Runner/operation/file/evidence 绑定 | P2-A |
| P2-C | branch result、确定性 integration、冲突与集成验证 | P2-B |
| P2-D | merge approval、clean-target apply、崩溃 reconciliation | P2-C |
| P3 | 联合故障矩阵、真实客户端/平台门禁、必要修复 | P2-D |
| P4-A | registry/version pin、compile lookup、导入与校验 | P3 |
| P4-B | existing skill library 内 authoring/preview/start 入口 | P4-A |
| P5 | graph read model、同 turn graph/list 与可访问性 | P4-B |

不提前预留 migration 编号，不把版本号、锁文件升级、release 文案或全局工具升级混入。

## 5. P1：副作用与安全并行

### 代码责任

| 责任 | 现有位置 / 新增方向 |
| --- | --- |
| template、graph、compiled metadata 与 contracts | `packages/core/src/skill-types.ts`、`workflow-graph-types.ts`、`workspace-types.ts`；`packages/contracts/src/workflows.ts` |
| 默认映射、inline custom validation、graph 编译 | daemon `features/channels/workflow-templates.ts`、`workflow-graph.ts`；内置 skill pack metadata |
| Host safety producer 与 effect 强制 | Core `session-permissions.ts`；daemon `features/harness/tool-execution/`、`features/runs/workflow-operation-effect-gate.ts`、`workflow-command-cwd.ts`、`runtime/sandbox/` |
| start authority、整组资源与容量事务 | Core `workflow-step-start-owner.ts`、SQLite `channel-workflow-start-store.ts`、`resource-lease-store.ts`、`runtime-semaphore-store.ts`；复用 daemon `features/runs/concurrency.ts` 的持久 slots/fence，不新建内存 limiter 或准入旁路 |
| candidate gate、活动分支与等待原因 | daemon `features/channels/smart-scheduler.ts`、`orchestrator.ts` |
| API 投影与客户端 | `packages/api-client/src/endpoints/channels.ts`；contracts 与客户端往返测试 |
| 只读状态与诊断展示 | `apps/web/src/lib/conversation-work-cell.ts`、现有 workflow evidence / progress projection；公共 view model 沿用 `packages/conversation-ui-core` |

### 验收

- 内置、inline custom、graph、SQLite reopen、API 与 Run snapshot 的 safety metadata 一致。
- 未知旧 metadata 串行；显式非法新声明拒绝；模型/模板不能把实际写能力伪装成只读。
- scheduler、skill 合并、MCP inventory、Run admission、write-lock 与实际 executor 读取
  同一 effective capability authority，不能只相信较窄的原始 `requiredTools`。
- 两个真实受限分析分支可同时运行；QA 只有 artifact-only executor 通过准入才可加入。
- 写文件、任意 shell、外部插件/CUA、网络写、跨目录与 `.git` 绕过均被 Host 拒绝。
- 同时 tick、重复请求、跨 workflow 争同一资源/容量时，无重复 start、半组锁或超额。
- P1-C 验证 preparing 预留到真实 Attempt 持久 slots 的原子/幂等交接；正常准备、
  失败、dispatch unknown、交接中崩溃和 reopen 均不双重计数、不出现容量空窗，
  不嵌套 SQLite 事务，不释放新 owner 的 slots/leases。
- pre-approval 先绑定 immutable scope/policy plan，再创建 Task/start owner/Run/Attempt；
  正常 preparing -> linked 不改变批准的 semantic basis，旧 generation 不能借原审批取得新权限。
- 一支待审批不阻塞独立安全支；全局决定、依赖 post-gate 与撤权正确阻塞。
- `workspace_write`、`external_mutation`、`release` 默认串行，正常审批不能被关闭开关绕过。
- serial `autoplan-lite`、typed operation authority 和现有 start owner 测试不回退。

优先复用现有 `channel-workflow-metadata-store.test.mjs`、
`workflow-step-start-ownership.test.mjs`、`workflow-pre-gate-admission.test.mjs`、
`workflow-start-lifecycle.test.mjs`、`workflow-operation-effect-gate.test.mjs` 和
`channel-workspace.test.mjs` 的相关 fixture；较大新矩阵独立成文件，不继续无界扩充大测试。

开启门禁：P1-A 到 P1-C 全部通过后，仅在支持的 executor 上启用 safe-read 并行。
没有真实 artifact-only 实现的平台保持 QA 串行/blocked，不将 schema 完成报成 QA 并发完成。

## 6. P2：Isolated Worktree Merge

### 代码责任

| 责任 | 位置 |
| --- | --- |
| scope plan、execution binding、round/merge packet types 与 API DTO | Core/Contracts 新增专用模块，审批语义计划与后置 runtime lineage 分离；现有 workflow 类型 barrel 只转出 |
| binding/round/journal 事务与 CAS | Core SQLite 新增专用 store/migration；不把 Git I/O 塞进 SQLite store |
| no-clobber worktree 与受保护 Git actor | daemon `features/workspaces/managed-worktrees.ts` 的窄复用/专用 step-worktree 模块 |
| isolated Run admission 与执行路径 | 现有 start、workflow command/effect gate、file mutation、context 与 evidence 路径 |
| branch capture/integration/recovery | daemon `features/channels/` 新增专用 coordinator、packet、reconciler 模块 |
| approval/action 与 completion | 现有 approval store、execution actions、workflow completion gate、TerminalReport |
| 分支、冲突、candidate/applied 列表 | 原 conversation work-cell、workflow progress/evidence；不做 graph |
| owned worktree 清理与资源预算 | worktree coordinator/journal；复用 clean-only cleanup，补 retained reason 与可恢复 ref |

### 分批验收

P2-A 验证 fresh migration、真实旧 schema upgrade、reopen、损坏约束拒绝和事务回滚；
同一 round/generation 和 scope plan 不可变，旧 owner 不能推进新 generation。
计划审批、审批消费后创建/关联 runtime identity、dispatch fence 分别核验；正常 linking
不自我失效，目录/工具/scope 漂移也不能通过填入新 binding 借用旧批准。

P2-B 用真实临时 Git 仓库创建两个 step worktree，证明各自 Run cwd、file/command
operation、沙盒和 evidence owner 一致；用户 checkout、共享 Git metadata 与 sibling
worktree 不可被 Runner 写。分支重名不覆盖，dirty/非 Git/权限缺失不共享目录 fallback。

P2-C 验证不同路径、同文件可干净合并、文本冲突、语义检查失败、optional 排除、新文件、
删除/mode、非法路径/特殊文件与超限 patch。Host 捕获完整授权结果；集成后重新验证，
冲突不自动解决，失败保留输入与结果 artifacts。

P2-D 验证审批 fingerprint、拒绝/超时/撤权、HEAD 漂移、dirty/index/untracked、目标切换、
外部 Git 操作、重复 apply、cancel/apply 竞态与每个 intent/receipt 崩溃窗口。
真实目标只 no-force fast-forward，不 push，不吞用户 WIP，不自动 reset 回滚。
同时验证资源预算、清理重试和留存：active/unknown/dirty/conflicted 不删除，clean terminal
目录只在 artifact/ref 可恢复且 owner 已停止后回收；不遗留无 owner 的临时 worktree。

开启门禁：P2 可在隔离 fixture/显式测试 workflow 验证，但 P3 完成前不向普通 workflow
默认开放写并发。P2 的任何一部分完成都不能解锁 external/release 并发。

## 7. P3：联合可靠性与真实验收

矩阵同时覆盖 SQLite、真实 Git/文件、Host 执行与客户端展示。可控 fake Provider 用于
确定性时序；真实 Provider/Runner 的验证另列证据，不把 fixture 冒充真实模型运行。

| 场景 | 必须证明的结果 |
| --- | --- |
| 重复/同时 orchestrate，response lost | 相同 start owner 只产生一次真实 dispatch；资源与容量不重复占用 |
| preparing/linked/start ACK 中断或 daemon 重启 | reconcile 原 lineage；没有停止/continuation 证据不重跑模型或工具 |
| preparing capacity -> Attempt slots 交接、失败及重开 | 同一持久容量计数原子转移；无重复 slots、空窗、嵌套事务或越权释放 |
| 旧 Attempt、旧 callback、旧 integration generation 晚到 | 不推进当前状态、不消费审批、不释放后继锁 |
| 资源不足、父子目录别名、同仓库不同 checkout | 正确 queued/blocked，粗粒度冲突不被路径字符串绕过 |
| workflow cancel、单分支失败、sibling cancel | 禁止新准入；所有实际分支与 required/optional 子树停止或明确 unknown |
| Provider/Runner 崩溃、断连、deadline、usage 未知 | 不伪造 no-dispatch、success、退款或 quiescence |
| pre/post/merge 审批等待、拒绝、过期、撤权 | 独立分支可继续；依赖与 merge 不偷跑；旧 approval 不授权新 candidate |
| worktree create / branch capture / Git merge / apply 各 crash window | intent/receipt 可重开核对；重复恢复不重复物理 effect |
| merge 文本/语义冲突、目标 HEAD/dirty 漂移 | 保留 candidate 与现场，用户 checkout 未被强制覆盖 |
| required/optional、all_terminal/any_succeeded、缺/坏 packet | 调度条件不替代 completion coverage，TerminalReport 准确 |
| SSE 重连、客户端 reload、后台恢复 | 同一 work-cell 状态收敛；cancelled 与结果待确认明确区分 |
| 功能关闭、迁移重开、旧数据/reader | 停止新准入但保留观察/收尾，不丢历史，不破坏旧串行流程 |
| worktree 数量/磁盘预算耗尽、清理中重启 | 新建受限，保留未知/dirty 现场，可恢复 ref 与 cleanup receipt 不丢失 |

### 平台与用户流程

- 先在隔离 workspace 运行真实受限只读分析、artifact-only QA、两个代码分支、集成检查、
  merge approval 与 apply；记录实际 source revision、能力组合与未验证项。
- 桌面 Web/本机客户端分别走一次：运行列表、审批、冲突、取消、daemon restart、
  SSE 重连和最终报告。构建通过不是客户端验收。
- macOS/Windows 的沙盒、Git/路径行为与 packaged 客户端分别验证；不支持或未验收的
  executor/platform 组合保持关闭，不借一个平台通过声明全平台可用。
- 最小可发布范围可限制为已通过的 selected workflow + executor/platform；每个限制
  必须体现在 Host gate 和用户状态，不能只是文档注释。

完成条件：完整矩阵与目标组合通过、必要修复已 review/CI/merge，才开启选定写并发。
动态 delegation 是否开启仍由其独立预算/ACK/stop/fan-in 门禁决定。

## 8. P4：模板 Registry 与 Authoring UI

先新增 registry 的显式 workflow-template 契约和版本/pin，再开放界面。
复用 `skill-registry-store.ts`、`effective-skill-registry.ts`、daemon skill registry 与
workflow compiler；Web 使用现有 skill library 责任边界，不另起 workflow 首页。

验收：唯一 id/version/digest、来源/owner/review、保存/导入/归档、编译预览、
missing/cycle/invalid capability 错误、权限撤销、template 更新不改变已编译 workflow、
retry 保留 pins、旧 inline custom 兼容。保存模板不会启动执行，auto-start 默认 false。
新模板不能通过自称 readonly、改变 resourceKeys 或选择不受限 Runner 绕过 P1/P2。

UI 覆盖草稿、校验错误、未保存、冲突版本、权限不足和归档状态，真实浏览器跑完整
保存 -> 预览 -> 用户确认启动 -> 观察结果。未通过 P3 的执行能力不因模板 UI 出现而开启。

## 9. P5：Workflow Graph

从现有 workflow evidence/progress 建立共享 read model，再把 graph 放入同一 turn 的
展开区域。list 与 graph 共用节点身份、状态、权限、审批和选择，不各自拉一套执行事实。
沿用仓库已有的 `@xyflow/react`，不为同一只读视图再引入图库；跨客户端共享的状态模型
仍由 `packages/conversation-ui-core` 拥有，Web 不复制第二套语义。

验收：真实 branch/join、依赖缺失、运行/阻塞/取消/结果未知、动态 overlay、reload/SSE
收敛、长标题、大图有界布局、键盘/屏幕阅读器、窄屏与 reduced motion。
graph 不能创建节点或执行 effect；列表回退始终可用。视觉验收用实际浏览器和截图，
不能仅凭组件快照或构建通过。

## 10. 验证命令与证据分级

本轮文档检查不安装运行依赖，不跑无关全仓测试：

```bash
node scripts/check-markdown-links.mjs
git diff --check
```

实现阶段按真实影响面执行。仓库要求 Node `>=22.22.1` 与其声明的 pnpm；
下面为当前可用命令，不表示本次已经运行：

```bash
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/daemon exec node --test --test-concurrency=1 test/workflow-start-lifecycle.test.mjs test/workflow-operation-effect-gate.test.mjs
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web build
corepack pnpm check:docs
```

先运行新增单元与相关定向测试，再根据 blast radius 扩到 package suites/typecheck；
Core/Daemon 跨模块准入、权限和迁移变更需完整相关 package suites，UI 再加真实浏览器。
新测试文件纳入脚本后再更新定向命令，不引用不存在的测试当验收证据。
记录静态核对、单元/fixture、真实 Git/Host、真实 Provider、客户端和 packaged 证据类别，
不固定容易过期的测试数量，不把 CI green 当真实外部执行完成。

## 11. 开启、回退与交付纪律

| 能力 | 开启条件 | 回退 |
| --- | --- | --- |
| safe-read parallel | P1 全路径强制与原子准入通过 | 禁止新并发，保持串行正常权限与现有收尾 |
| isolated-write parallel | P2 + P3 的目标组合通过 | 禁止新 writing round，保留活跃任务/证据并确认停止 |
| custom registry/authoring | P4 编译、权限、版本与浏览器验收通过 | 停新 compile，旧 workflow 仍读 frozen pins |
| graph | P5 同 read model 与可访问性通过 | 回退既有列表，不改变执行 |

shadow 只生成调度决定与诊断，不启动额外 Run/模型/工具/Git effect。
新 safety fail-closed 不能通过关闭 feature flag 被撤销；关的是能力扩展，不是安全门。
回退不删除表、工件、旧 worktree 或未确认 effect，不自动降级到不兼容旧二进制。

每次阶段交付交代：代码完成、测试范围、未验证组合、PR/CI、是否合并、是否开启。
不再把功能 WIP 与已合并 PR 混为一谈。提交只含当前责任文件；未完成现场保留明确
branch/owner，不跨数个大阶段堆积一个不可审查的 dirty worktree。

下一步接入 P2-D 的单次 permit、target apply journal 与只观察的 crash reconciliation。
P2-C 的持久 coordinator/completion barrier 与 P2-D 审批基础已通过本地定向回归。P1 与已完成的 P2
单元不重复从零实现；P3-P5、CI/merge 和真实客户端/平台验收仍未完成。
