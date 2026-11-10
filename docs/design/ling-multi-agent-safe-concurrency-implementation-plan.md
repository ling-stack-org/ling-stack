# Ling 多 Agent 安全并发实施计划

状态：P1/P2 执行路径、P3 本地联合可靠性、P4 模板创作、P5 graph、B4 受控档位验收和 B5 Host 策略回读均已有本地实现；
构建、冻结输入下的完整相关 package 回归与受控 Provider 的真实 daemon 浏览器链路通过。
Web 冲突修复、共享 UI、语言目录和夹具另有增量回归与真实浏览器验收；完整冻结回归
不覆盖其后新增的源码。Daemon 独立 dependency-security lane 已通过；真实 Provider、
packaged、跨平台与 review/CI/merge 尚未完成，不满足发布门禁。B3.3 的 native/automation
接缝代码已接入统一 Host/queue 路径并有受控 daemon 回归；这不等于所有执行链的联合发布验收。
Owner：Ling maintainers。
最后核对：2026-11-10。
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
| P2 | 本地代码接入与组合验收通过，尚未声明可发布；普通 workflow 写并发仍关闭 | 隔离写入、封存结果、确定性集成、审批应用和故障恢复协议可运行 |
| P3 | 本地 Git/SQLite、Pi SDK/Host、生产 Web 构建的取消/重启、SSE/reload、审批/apply、公共 candidate-only 链路通过；Web 冲突修复与后继执行有独立增量验收，真实 Provider、packaged、跨平台等发布门禁未完成 | 目标组合的联合与真实客户端验收通过，才允许选定 workflow 开启写并发 |
| P4 | registry、编译冻结、HTTP/API-client 与 authoring UI 已接入；保存/发布/预览、CAS 冲突与 exact pin 显式创建已通过本地浏览器验收 | registry 版本冻结、校验、authoring 与真实保存/编译流程通过 |
| P5 | 共享 read model、同 turn graph/list、选择与断连状态已接入；桌面键盘、390px 列表回退、reduced motion 和 reload/SSE 检查通过 | 同一工作对象内 graph/list 一致、可访问、真实状态可靠 |

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
  回归通过。单次 permit、独占 lease、实际 clean-target fast-forward、审批 route、completion
  与 startup reconciliation 已接入并通过本地构建及真实 Git/SQLite 回归。普通审批同意
  不代表已合入工作区；unknown 保留 intent/lease，重启只观察，不重放 Git。
- P2-D 已接入独立 owned-worktree cleanup journal、证据/ref 留存与 clean-only no-force
  回收；duplicate/startup 只观察已有 intent，不延迟重放删除。新建 worktree 的数量与磁盘
  预算已有 Host 约束；整轮预算现已覆盖全部 writing steps 加 integration、freeze 前再检查
  与实际 create 的外部竞争，P3 完整真实客户端/平台联合验收仍需完成。
- 内部 isolation planner 默认 `candidate_only`；显式 Host 可在启动前冻结 `apply_to_target`，
  不开放公共自动 merge 请求。普通 workflow 写并发仍关闭。静态校验
  明确记录 `projectTestsRun: false`，不等于项目测试、审批或 apply 已完成。

P3 当前实现与开启范围：

- `POST /workflows/:id/orchestrate` 可显式选择
  `{"executionProfile":"pi_host_isolated_files_v1"}`。Host 开关默认关闭；只接受 macOS、
  enforced Tool Broker、实际注册且 workspace-enabled 的 Pi adapter、2-128 个全部声明为
  `workspace_write` 的参与步骤，冻结并发上限 2、`candidate_only` 与 `require_success`。
  API 不接受调用方指定 command、target apply、任意路径或并发数；不提供自动合并权限。
  Web 同 turn workflow 行已有显式 candidate-only 启动入口；普通推进不隐式选择该 profile。
  2-128 是完整 graph 的解析边界，不是资源承诺；单 target 的 16 registration 预算只允许
  最多 14 个 writing steps，加上原 target 和一个 integration worktree。
- 受控验收可在启动 Host 时设置 `LING_STACK_CHANNEL_WORKFLOW_ISOLATED_FILES=true` 与
  `LING_STACK_HARNESS_TOOL_BROKER_MODE=enforce`；等价配置是
  `channels.workflowIsolatedFiles: true` 和 `harness.toolBroker.mode: "enforce"`。
  工作区设置与模板不能修改 Host 开关；打开开关本身不代表平台或真实 Provider 验收完成。
- Core 在一个事务中冻结完整 workflow/channel/step 快照、safety/scope plans、round 和父锁；
  `planning` 未完成时，普通 orchestrate、manual start、retry 与 Run admission 均不得降级启动。
- 每个 sibling 保留独立原始 Attempt、Host drain、worktree lease 和持久 slots；一个分支结束
  不释放全组父锁。普通 Run、其他 workflow 或另一个 round 不能共享该父锁写目标目录。
- Git common-directory 下的 repository fence 同时约束其他 checkout、Store 与 daemon 进程。
  首版只支持一个 canonical target 和一个 canonical Host 数据库；额外 registration 仅允许
  通过历史 owner、terminal/drain/effect、资源释放及物理身份核验的 retained worktree，
  不恢复其执行权限。未知或外来 checkout 仍拒绝，全部 registration 均计入 16 预算。
  这不是多 checkout 共享写协议。
  初次空数据库可在 writer transaction 内重试初始化；损坏或旧 owner 未确认时 fail closed。
  规划失败的补偿只释放本次 reservation，不能撤销并发请求已经取得的所有权。
- retained isolation evidence 经现有 evidence API 投影到同一 conversation work-cell，分别显示
  candidate-only、待审批、已批准未应用、applied、冲突、取消与结果待确认；客户端有界轮询
  不签发执行权限。功能关闭禁止新准入，但保留已接受 round 的观察与收尾。

当前验收入口：`workflow-isolated-parallel-integration.test.mjs` 验真实 Pi SDK/Host 的 2/3/4
档位分支文件写入、审批、fan-in、apply 与 drain；`workflow-multibranch-integration.test.mjs` 验真实 Git/SQLite 的
merge/conflict/reopen；`workflow-repository-fence.test.mjs` 验跨 Store/process 竞争。
这些 Provider transport 可控的集成测试不等于真实 Provider 或 packaged 客户端验收。

2026-11-03 本地组合验证：上述 parallel、delivery、multibranch 与 repository-fence 四个
测试文件共 35 项通过。覆盖使用真实 Pi SDK/Host 的受控传输双分支，以及真实 Git/SQLite
和跨进程竞争；未运行真实 Provider。另已补齐同进程 create/capture 排队、等待期间撤权、
健康后继继续执行与物理锁释放回归。跨进程及遗留 owner 仍 fail closed，不自动接管。
该结果不是全量 Core/Daemon、CI、桌面包或跨平台通过声明。

最新完整 Pi SDK/Host parallel 集成文件回归也已通过，补验显式 candidate-only round 完成后
关闭功能并重启 Host：留存 evidence 可读，原 sibling 不再派发，普通写能力 Run 可在原
canonical cwd 取得自己的 fenced `bound_path` lease 与 Provider/Runner slots，terminal/drain
后释放其资源。该后继使用 tool-free 模型回复，验证的是普通准入与收尾，不是普通文件写入；
全过程目标 checkout 未变，留存 candidate 未应用。

Web 本地构建产物已用 Playwright 和受控 HTTP fixture 检查：1440x960 下分别呈现
candidate-only、待审批、已批准未应用、已应用、冲突、结果待确认和取消，均保留两个参与
分支；重新打开同一会话后不会将未应用结果标为 applied。390x844 下检查取消与未知结果、
参与者展开及候选 hash 换行，document/feed/证据行均无横向溢出。本地截图位于
`output/playwright/concurrency-*.png`；这些受控 HTTP 快照本身不是真实 daemon/Provider
端到端证据。后续真实 daemon 浏览器链路见下文；packaged 门禁仍未完成。

P3 已补齐 policy/source-turn 撤权贯穿原 Host drain、新 round 启动后旧 generation 重入、
terminal generation 的原始停止/coverage/audit 核验，以及历史 retained checkout 的只读
身份核验。取消不会把物理停止证据变成结果封存或重试权限；未确认 intent 不会被重放。
Pi SDK 的 schema/gate 拒绝只有在冻结 Host-only profile 且真实 producer 从未进入时，才可
被证明为未派发；实际 effect 仍必须有 Core receipt。活跃 workflow 控件不会被已有证据隐藏。

2026-11-03 本地完整回归证据：冻结输入下的 Core、Daemon、Web、Contracts、API-client、
conversation-ui-core、conversation-ui-react、localization 和 runner-pi 完整相关回归通过；
Daemon 沿用仓库的独立 dependency-security lane 排除规则，该独立文件另行执行通过，
不代表根目录 `check:dependency-security` 的其他 package 与脚本也已执行。
Core 与未受变更影响的 Daemon 分片按输入 digest/preimage 核验后复用，其余分片重新运行；
未新增排除项或放宽 deadline。Daemon build:ci、Web build 与 Web lint 通过。
逐文件报告与日志汇总保留既有条件跳过：LanceDB native 未配置、Electron fixture 未显式
提供、Windows 专用场景、macOS 下原本跳过的文件故障注入和仅子进程启用的 fixture。
这些跳过不计为已验证的平台或 native 能力，也不构成整仓库或 CI 通过声明。

`apps/web/e2e/workflow-isolation-live.spec.ts` 在生产 Web 构建上走真实 daemon HTTP/SSE，
两条场景通过：双分支运行期间断网/重连/reload，取消立即撤权但原 Host/slots 保留到实际
drain，同一数据库重启后不重复 Run；另一条由界面逐次批准写入、等待候选验证、打开
merge approval、批准后实际 fast-forward，验证 target 内容、source turn、TerminalReport
并 reload。fixture 使用真实 Pi SDK/Host/Git/SQLite，仅 Provider 回答由本地受控传输生成，
且内部预先冻结 `apply_to_target`；不代表公共 selected profile 开放自动合并或真实模型验收。

同一冻结输入上的 `workflow-isolation-public.spec.ts` 验证 Web 显式选择 candidate-only：
依赖先执行，再由两个 sibling 并发写各自 worktree，完整 drain 后唯一发布报告并终结
source turn，target 保持不变。同数据库重启不增加 Run，桌面与 390px 下不残留 draining
投影、不出现横向溢出。`workflow-template-live.spec.ts` 验证保存、发布、预览与 exact pin
创建均不派发，只有显式推进才进入原 Pi Run，成功状态在 reload 后保留。上述四个真实
daemon 浏览器场景均通过，没有失败、重试通过或跳过；不是外部真实模型或 packaged 验收。

Host 隔离 operation 真正结束并移出 pending 后，daemon 持久追加并发布
`channel_workflow.isolation_settled`，
复用现有 runs invalidation 刷新协议与审批。duplicate single-flight 不重复通知；嵌套任务、
异常结果与通知失败不伪造 drain 或 effect-confirmed。前端只在整批协议刷新成功后恢复
observation-ready；失败保留重连。

P5 graph 在截断前过滤和排序，节点键盘名称包含真实状态，刷新顺序不会改变有界节点集
或选择。共享 UI/Web 回归与生产构建浏览器已核验节点键盘焦点、可访问名称及详情选择
一致，以及窄屏列表回退和 reduced motion。此检查不替代 packaged 或跨平台可访问性验收。

Web 冲突修复的增量验收使用生产构建和 `--conflict-recovery --hold-return` 真实 daemon
夹具：两条原始 sibling 对同一文件的写入产生 Git 文本冲突；窗口首次打开只查询，创建
修复计划不产生 Run。相同数据库在计划 ready 和后继完成后分别重启，均保留同一 lineage、
旧冲突和各自唯一的报告，不增加 Run。只有单独点击启动才执行后继，其依赖及 siblings
使用全新的写入审批、Run/Attempt 和隔离目录；候选验证完成后 target 仍未改变。
关闭重开和“查询恢复结果”不重复 POST。桌面焦点返回当前修复按钮，390px 下按钮文案
完整换行且没有横向溢出。该夹具使用受控 Provider，不等于外部真实模型验收。
增量 Web、共享 UI/localization 与受影响 Daemon 夹具回归、完整 Web 构建及语言目录检查
分别绑定当前增量；不将旧完整冻结回归改称为新增源码的全量验收。

真实 Provider、packaged 和跨平台门禁尚未完成；普通 workflow 写并发继续关闭。

持久协议与客户端行为：

- 模板创建原子写入 workflow/steps 和 canonical 用户 source turn/item，失败全部回滚，
  preview/create 不启动模型。P4 浏览器创建后的显式推进由原 Pi Run 消费该 source。
- 公共 text-conflict recovery 通过精确 round/revision 和幂等请求创建 generation 1 的新
  workflow/round；旧 workflow 永久退役，旧 journal/冲突/refs 保留。仅实际 drain 且无活动
  effect/资源/审批时转移父锁；规划失败可按原请求续完，GET/restart 不执行或应用结果。
  新审批、Run/Attempt、canonical repair source 与旧执行完全分离，不改写旧 round generation。
  HTTP/API-client 与 Web 修复窗口已接入。窗口只为已确认 drain、无未知 effect 的单轮
  candidate-only 文本冲突提供入口；已退役前驱只能发现既有后继，不能重新创建。
  请求按 workspace/channel/thread 与 daemon epoch fencing，命令 single-flight，超时进入
  结果待确认；重试前先 GET，且只复用原 key、要求和 revision。计划创建与执行分开。
- repository reservation 在持久 marker 之后用 sidecar SQLite writer 覆盖 inventory/freeze；
  新协议 no-round marker 可在原 writer 退出后按精确 owner 恢复。COMMIT/re-BEGIN 竞争者
  必须重新核验 token；Core 已提交而 sidecar 未提交的崩溃仍保留准入阻断。旧协议/未知
  owner 不自动接管，不删除路径，不按 PID/TTL 释放锁。
- candidate 完成后的各 orchestrator completed 出口均调度报告。真实公共 HTTP、
  Pi SDK/Host/Git/SQLite 回归验证报告唯一发布、source turn 终结、target 未改及同 DB 重启
  不重派。fixture 的 Git 异步读取与 SQLite 状态分开取样，canonical publication 和 turn
  状态使用同一 SQLite 快照。

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

当前两项候选的处理边界：

- `runtime/store-registry.ts` 的 canonical workspace key 去重已在当前分支实现并回归；
  等价路径不能制造同仓库的第二个 live Store。跨数据库/进程仍由 repository fence 处理，
  不把进程内去重当成全局锁。
- `canonical-transcript-snapshot.ts` 的 child-action anchor 唯一性；先验证同一 child 的
  spawn + message 是否造成真实投影歧义，必要时作为 P3 的投影修复，不强行搬旧代码。

旧 WIP 的 migration 编号与主线已有用途冲突；不能照搬 SQL 或覆盖发布过的 migration。
deterministic evaluation 和 evaluation worker 也已有主线实现，不能因为旧 grades/job API
尚未迁移，就把通用 grading 误列为本轮缺失的执行底座。

## 4. 分支与小 PR 策略

当前本地实现位于 `codex/ling-multi-agent-safe-concurrency`，按下述责任边界分批提交；
尚未 push、创建 PR 或合并。以下是后续审查/交付拆分，不代表已有这些 PR。

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
| 同一 source turn 多轮审批与 blocked 后重新 start | 固定同一 `now` 各执行四轮；每轮有效转换保留独立事件，同状态重复 sync 不增加事件 |
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

当前实现：`workflow-template-registry.ts` 提供有界纯 JSON/DAG/safety 校验；Core 专用
registry store 与 migration 保存不可变版本、CAS revision、review status 和历史 pin。
daemon `/workflow-templates`、版本读取、review 与 preview 路由复用本机 workspace trust
gate；版本来源与可见性由服务端拥有。编译冻结 objective、prompt、policy/gates、依赖、
参与者、skill 实际源、Provider 和 effective Runner；准入与实际 effect 再检查撤权，Runner
不可静默 fallback。preview 不创建 workflow/Task/Run/approval；创建请求原子保存
workflow/steps 和 canonical 用户 source turn/item，不创建执行队列或自动 orchestrate。
Web 在现有 Skill Library 内编辑、导入导出、处理 dirty/CAS 冲突、发布
并预览，只有当前 clean published exact pin 的预览才允许显式创建。

## 9. P5：Workflow Graph

从现有 workflow evidence/progress 建立共享 read model，再把 graph 放入同一 turn 的
展开区域。list 与 graph 共用节点身份、状态、权限、审批和选择，不各自拉一套执行事实。
沿用仓库已有的 `@xyflow/react`，不为同一只读视图再引入图库；跨客户端共享的状态模型
仍由 `packages/conversation-ui-core` 拥有，Web 不复制第二套语义。

验收：真实 branch/join、依赖缺失、运行/阻塞/取消/结果未知、动态 overlay、reload/SSE
收敛、长标题、大图有界布局、键盘/屏幕阅读器、窄屏与 reduced motion。
graph 不能创建节点或执行 effect；列表回退始终可用。视觉验收用实际浏览器和截图，
不能仅凭组件快照或构建通过。

当前实现：`packages/conversation-ui-core/src/workflow-graph-*` 投影 accepted step 及真实
依赖、branch/join、审批与有界 dynamic overlay；缺依赖、cycle、duplicate 或观察断连显示
unknown，而不是伪造成功。Web 同 turn 展开区复用现有协议操作，graph/list 共享 step id
和选择；Graph 行默认折叠，节点仅显示名称和状态，选择只高亮、不展示详情。成功完成时保留
至多一条简洁的最终集成状态，不重复展示 observation 和正常完成报告；失败由原会话结果承接，
审批复用原窗口，会话 workflow 行继续保留必要的推进、取消、重试、审批和冲突修复动作。
`@xyflow/react` 按需加载，窄屏的 Graph
与列表均可访问，断线后需 control-plane baseline 完成才
恢复 current 状态。graph 只读，不新增执行 API。

## 10. 验证命令与证据分级

文档检查：

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
node --test --test-concurrency=1 packages/daemon/test/workflow-conflict-recovery.test.mjs packages/daemon/test/workflow-conflict-recovery-live-fixture.test.mjs packages/daemon/test/workflow-isolation-terminal-report.test.mjs
node packages/localization/scripts/check-catalogs.mjs
LING_PLAYWRIGHT_PORT=4190 LING_PLAYWRIGHT_PREVIEW=1 corepack pnpm --filter @ling-stack/web exec playwright test e2e/workflow-isolation-live.spec.ts e2e/workflow-isolation-public.spec.ts e2e/workflow-template-live.spec.ts --workers=1
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

本地提交按 P3 可靠性、P4 registry/API、P4 UI、P5 projection/UI、冲突修复与验收的责任
边界拆分，不 push、不创建 PR 或合并。固定输入下的完整相关回归与后续增量验收分别
记录，Daemon 独立 dependency-security lane 已通过；后续交付门禁仍包括目标真实
Provider/Runner、packaged/平台验收及 review/CI/merge。不能把本地可运行实现或受控
Provider 验收报成整体可发布，各门禁通过前保持普通写并发关闭。

## 12. 并发预算与扩容

目标：将首版固定档位推进为可配置、受控、可恢复的并发准入，不增加另一套 Agent
runtime。契约见[详细设计第 5.6-5.10 节](ling-multi-agent-safe-concurrency-detailed-design.md#56-并发预算的作用域与配置)。
P3 的真实 Provider、packaged 和平台门禁继续保留；补齐配置不代表这些门禁通过。

### 交付顺序与状态

| 单元 | 状态 | 交付物 | 依赖 |
| --- | --- | --- | --- |
| B0 | 已完成文档检查 | 作用域、配置、计数、冻结/变更、排队、扩容与会话边界 | 当前 P1-P5 本地实现 |
| B1 | 已实现并通过定向回归 | 可信 `DaemonConfig.concurrency`、严格解析、不可变策略与默认关闭的显式启用状态 | B0 |
| B2 | B2.1-B2.4 已接线并通过 Core/Daemon 定向回归 | 单 workspace 普通 Run/workflow/delegation 的总量、分类和 Provider/Runner 统一持久准入；首次 Pi 队列消费 | B1 |
| B3 | B3.1-B3.4 已接线并通过 Core/Daemon 定向回归；完整真实执行链联合验收未完成 | 跨 workspace 的 Host 持久总容量、可恢复交接与跨进程竞争 | B2 |
| B4 | 受控 Pi SDK/Host 的 2/3/4 档位联合验收通过；真实 Provider、packaged、跨平台与发布门禁待完成 | 按目标组合验证 2-4 隔离写档位，冻结实际额度，保持独立 merge approval | B2、B3 和 P3 目标组合门禁 |
| B5 | 已实现并通过类型/构建回归 | 现有执行引擎设置只读回读可信 Host 并发策略；文本流、Composer 和折叠 Graph 不扩张 | B2；跨 workspace 声明依赖 B3 |

B1 是配置契约，不接入前不得宣称限制已生效。默认总容量 4、只读 4、写入 2、
Provider/Runner 各 4、隔离 sibling 2 是候选运行政策；其解析范围不是通过验收的规模。
`concurrency.enabled` 默认 false，仅填写数字不启用新预算。可信 Host 显式设为 true 后，
普通 Run、workflow 与 delegation 使用同一持久策略；首次队列消费、公平性和恢复已通过
Core/Daemon 定向回归，但仍不默认推广。disabled 状态仍持久保留 revision，不借关闭策略释放
原执行资源。
公开隔离入口默认固定为 2；可信 Host 显式启用统一并发策略后，新的隔离轮次可使用配置的
2-4 档位。未启用时不因填写数字而放开，已冻结轮次也不会随配置变化自动升级或降级。

### B2 实施单元

| 单元 | 状态 | 实现内容 | 完成条件 |
| --- | --- | --- | --- |
| B2.1 | 已实现并通过定向回归 | Core `acquireRuntimeSemaphoreSlots` 与普通 Run 共用入口 | 同一事务整组取得 Provider/Runner/Channel；满额无半组历史、无虚假 acquired 事件，重复准入不破坏原 owner |
| B2.2 | 已实现并通过定向回归 | workspace 持久策略和统一计数 | 普通 Run、workflow preparing/transfer、approval resume、continuation 读取同一容量权威；当前额度独立于 frozen plan |
| B2.3 | 已实现并通过定向回归 | dynamic delegation 预留与 spawn 门禁 | 在创建可等待 child 前原子核对父/祖先占位与剩余容量；不能把确定未派发的容量不足误标成 unknown dispatch |
| B2.4 | 已接线并通过 Core/Daemon 定向回归 | 恢复、配置变更与首次 Pi 排队 | legacy owner、unknown、取消、跨 Store/process、降额及公平性矩阵已有定向证据；真实 Provider/packaged/跨平台门禁仍需完成 |

`wait_agent` 目前只观察 child；不释放父 Run 的 Provider/Runner slots。child 的预算预留、
Attempt claim、执行槽准入与 SDK ACK 是不同阶段。B2.3 必须保留这个区分：容量不足时
不能先 claim 再留下不可重发的未知派发，也不能为腾出槽位释放仍有 effect 责任的父资源。

### B2.4 实现与验收

1. 首次队列的冻结输入：保存原 Run、WorkUnit、created Attempt、Provider/Runner 输入和
   effective policy；核对 task/channel/participant 当前 authority，不使用 successor continuation
   的创建入口。原 teammate 的 active/visible 检查独立于 skill/memory，在 Core 最终准入
   事务和 SDK 前均执行；不因冻结输入保留而豁免撤权。migration 217 保存精确队列身份；
   旧 queued Run 不回填权限。
2. 持久 claim 与 dispatch gate：精确 fence、CAS revision、稳定入队顺序、等待原因和一次性
   派发边界；claim 接管后旧 owner 不得释放接管者资源，unknown dispatch 不因 TTL 重派。
3. workspace 仲裁与生命周期：跨 channel/workflow 轮转、组内 FIFO、冲突跳过且防止新请求
   持续插队；Store 初始化、入队、资源实际释放和审批就绪唤醒，周期 tick 兜底。
4. 冷启动与联合验收：Core 与 Supervisor recovery 保留精确首次队列 custody；duplicate tick、
   取消/实际 drain、降额、旧 owner、跨 Store/process 与 fairness 通过后，才考虑默认启用。

受控进程验收已覆盖 dispatch gate 提交而 SDK ACK 未知的边界：独立 SQLite 连接核对后
强制终止执行子进程，重新建立 Registry、Supervisor、首次队列和 continuation recovery
coordinator。正常时间与 claim/resource TTL 过期后均保留原 fence、队列事实和资源；
不重派、不建 successor，独立组的两轮实际准入仍因原占位而排队。这不是完整 daemon
server 启动或真实 Provider 验收，也不覆盖尚未接线的跨 workspace Host 总池。

首次队列的基础准入仅覆盖普通首次 Pi、明确 tools 数组、preset 或无 secret 匿名 inline；
workflow/delegation/continuation/native/automation 由各自 owning contract 接入同一 coordinator
与 Host authority，不把公开 queue 请求当作这些路径的恢复凭证。生产 daemon 注册与启动 coordinator，
入队/资源实际释放唤醒、周期 tick 兜底，shutdown 先停准备再等待完整执行。每 Store 至少
保留 4 个 preparing 位，可信总容量更大时随配置提高；它们在 `onRunReady` 后归还，不是
执行并发上限。
占位按每次独立 preparation 计数，同一 Run 的多代 claim 分别占位；旧 ready/finally
仅能归还自己的位。归还准备位不提前结束对应执行的 shutdown/drain 跟踪。

### B3 实施单元

| 单元 | 状态 | 交付物与门禁 |
| --- | --- | --- |
| B3.1 | 已实现并通过 Core/Daemon 定向回归 | 用户 global SQLite 独立 schema、policy CAS、精确持久 reservation、无 TTL 回收与跨进程末位竞争；daemon composition 持有唯一 Host authority |
| B3.2 | 已接线并通过 Core/Daemon 定向回归 | workspace intent/receipt/dispatch gate/release outbox；跨库交接不同时持有两个写事务 |
| B3.3 | 已接线并通过 Core/Daemon 定向回归 | workflow preparing/transfer、delegation spawn/claim/successor、approval/continuation、native/automation 与 legacy owner 的容量接缝 |
| B3.4 | 已接线并通过 Core/Daemon 定向回归；完整真实执行链联合验收未完成 | Host policy 冲突与变更、真实多 workspace 竞争、冷启动、取消、unknown、释放恢复和公平性 |

B3 必须在同用户存储根的全局数据库中建立 Host 总池，不把 workspace 数据库或内存池
冒充整机限制。交接顺序为 workspace durable intent、Host reserve、workspace receipt、
一次性 dispatch gate；不同时持有两个数据库写事务。unknown 保留额度，释放依赖原 fence
停止/effect 证据及持久 outbox。不同 `LING_STACK_HOME` 不自动属于同一共享预算域。

首次 Pi 的 `dispatchRuntimeQueuedRun` 已消费 Host dispatch gate，不再只由独立 fixture
手动消费。启用可信 `DaemonConfig.concurrency` 时，daemon composition 会在 canonical
用户存储的 `global.sqlite` 安装 Host policy，queue claim 会执行 Host reserve/receipt，
再由原子 dispatch gate 消费；已有 Host intent 时省略引用也拒绝。整组资源、Task/WorkUnit
认领和两道 dispatch gate 原子提交。workspace 的 workflow、delegation、approval/continuation
等容量接缝已有 Core/Daemon 定向回归；native dispatcher 现在按 native profile 或 workflow
start owner 选择对应 Host reservation，手动 resume 与 intervention continuation 复用绑定的
engine/profile，automation 首次 Run 可在 Host 满额时 durable queue，scheduler actor、
heartbeat execution binding 和 terminal 状态由 owning contract 保留。legacy owner、真实
Provider、packaged 和跨平台联合验收未完成，不能宣称整体已达到发布门禁。

Core 构造私有 binding 将可信 composition 的 workspace journal accessor 与公开 Store
分离。构造失败或关闭即撤销 accessor、facade 与提取的方法；每个真实 workspace 与
queue 共用 journal，不向 composition 暴露事务内 dispatch consumer。此边界只提供生产
接线所需的窄接口，不自行安装 Host policy 或启动 reserve/SDK/drain 生命周期。

### 当前验证记录

2026-11-03，activation 增量之前：Core 与 Daemon `build:ci` 通过；配置、原子准入、
容量与生命周期分别完成 113 项 Core、247 项 Core 和 278 项 Daemon 定向回归。
追加 policy、delegation capacity 与相关迁移矩阵 417 项通过。以上为独立测试集合，
有重叠，不相加作为唯一测试数量；不是全仓 checker、真实 Provider 或 packaged 验收。

2026-11-04：Core 245 项与 Daemon 210 项联合定向回归通过，覆盖 activation、delegation、
普通/continuation/approval、workflow admission 与 recovery。首次队列行为 53 项、
coordinator 生命周期 13 项、真实 Pi SDK 与本地受控传输的集成 3 项通过；后者验证原
Attempt 1 执行、冻结请求、资源释放唤醒、Store 重开和取消不进入 SDK。authority 撤销与
接管边界仍在增量验收。以上集合有重叠，不相加成唯一测试数量；不代表外部真实 Provider、
全仓 checker、packaged 或发布验收。B3.3/B3.4 已有 Core/Daemon 定向回归证据；B4 的完整
目标组合联合验收与发布门禁仍未完成。B5 已接入执行引擎设置页的只读 Host 策略回读；它不提供
workspace HTTP 写入口，也不改变默认关闭状态。

2026-11-04，B3.2 Core dispatch gate 接线：首次 Pi 的 Host/queue 联合准入 33 项通过，
包含在 Host store、身份、journal/bridge、迁移和 queue 的 417 项联合定向回归中。
Daemon coordinator、Supervisor 和受控 Pi SDK 队列集成联合回归 41 项通过。
Core 与 Daemon 的 `build:ci`、`typecheck:ci` 均通过；新增 TypeScript 测试纳入严格检查。
验证覆盖两道 gate 与整组本地资源的原子提交、缺失或伪造凭证拒绝、跨进程竞争、
失败回滚、Store 重开、unknown 保留和原执行 drain 后释放。生产 daemon 的 Host
reserve/SDK 前复核/drain 已接入首次普通 Pi queue；其他执行链的完整真实联合验收仍未完成，
不代表真实外部 Provider、全仓 checker、packaged、平台或发布验收。

2026-11-04，首次队列 authority 与 preparation 边界：Core queue/Host queue 89 项通过；
Daemon coordinator、Supervisor 与受控 Pi SDK 队列集成 48 项通过。无 skill/memory 的
teammate 在排队后 paused、disabled 或 hidden 时，Core 不消费 gate、不取得资源，
daemon 不进入 SDK，且独立组可继续执行。协调器覆盖同一 Run 的多代 claim、每代占位、
旧 ready/finally 回调与完整执行 drain。Core 与 Daemon 的 `build:ci`、`typecheck:ci`
均通过，最终 Daemon 构建和严格检查包含上述两项修复；测试集合有重叠，不相加计数。
preflight 内部 await 接管、dispatched ACK 未知的完整冷启动，以及 channel/Runner/
凭据撤权在此轮尚未覆盖，后续增量见下；不据此关闭 B2.4 或开放 Host 总池。

2026-11-04，构造私有绑定与首次队列增量验收：绑定生命周期 13 项通过；Host store、
身份、journal/bridge、迁移和 queue 联合定向回归 420 项通过；构造器清理的既有
delegation/Office bridge 与 SQLite fixture 兼容回归 69 项通过。Daemon coordinator、
Supervisor 与受控 Pi SDK 集成 56 项通过，包含 sandbox preflight await 期间 claim 接管，
以及排队后的 channel、Runner、凭据、policy、仓库和 teammate authority 变更。
Core 与 Daemon 的 `build:ci`、`typecheck:ci` 通过。脚本化凭据状态不等于真实系统
Keychain 认证验收；测试集合有重叠，不相加计数，Host 总池当前仅保护首次普通 Pi queue。

首次队列的真实子进程终止与冷恢复 2 项通过，覆盖正常时间与超 TTL。独立组的每轮
claim/revision、持久 defer 与精确 409 busy 响应分别核对；该响应不是 Run 执行失败。
原未知执行的 gate、fence、冻结输入、事件和资源不变，queue 与 continuation discovery
均不重放原执行。最终 Daemon 严格检查包含该 TypeScript 用例与 helper。

Graph 动效验收：共享 read model、会话渲染与 presentation 定向测试 48 项通过；
Web 严格类型检查和 lint 通过，i18n 检查退出成功但报告 skill-source 文案缺少中文键。
真实浏览器验证桌面双分支信号移动、完成/等待/失败/断连静止、reduced motion、390px
纵向布局、节点完整可见与长标题不造成页面横向溢出。该页面使用受控状态 fixture，
不代表真实外部 Provider、多 workspace 或 packaged 验收。

2026-11-07，并发预算与 Host 恢复增量：Core workflow migration 310/310 通过；Core 并发、
Host、queue、continuation 与 workflow admission 定向回归 907/907 通过；Daemon composition、
Supervisor、queue、delegation、approval 与 continuation 定向回归 193/193 通过。覆盖配置激活、
跨 Store/process 争用、恢复、unknown dispatch、取消、降额、公平性、Host intent/receipt/
dispatch gate/release outbox 以及旧 schema 兼容。以上是定向回归集合，不等于全仓 checker、
真实 Provider、packaged、跨平台或所有执行链的完整联合验收。

同日并发档位接线后，Core `workflow-isolation-selection` 61/61、Daemon
`workflow-isolation-planning` 26/26 通过；覆盖默认二档以及可信 Host 配置的 3/4 档规划、
冻结和边界拒绝。

2026-11-08，受控 Host 档位联合验收：`workflow-isolated-parallel-integration.test.mjs`
在 macOS 真实 Pi SDK/Host 链路上按 2、3、4 个 sibling 分别通过。每档均核对独立
Run/Attempt、worktree/bound-path、Provider/Runner 与 workflow slots、文件写入审批、
父 fence、固定 merge 顺序、candidate-only 目标不变、单次 merge approval、实际 apply、
terminal/drain 及资源释放；普通 writer 拒绝和 Host 策略关闭边界也保留。该证据只覆盖
本地受控 Provider transport，不等于外部真实 Provider、packaged、跨平台或 review/CI/merge
发布门禁已通过。

2026-11-10，本地收口回归：Core `test:ci` 全量 6607 项通过、0 项失败；受影响的 Core
并发/Host/queue/隔离/模板定向集合 270 项通过，Daemon 并发策略、Host composition、queue、
审批恢复、Graph 和 isolated workflow 定向集合 275 项通过。Web 全部单元回归 1323 项、
Conversation UI Core 207 项、Contracts 151 项、API client 137 项、Localization 24 项通过。
Core、Daemon、Web 类型检查通过，Core/Daemon 构建、Web 生产构建、Web lint、i18n 和 Markdown
link check 通过，且 `git diff --check` 无输出。Daemon 全量 `test:ci` 曾启动但因包含大量与本
目标无关的全仓边界测试而中止，不能计为通过。以上本地证据不替代真实外部 Provider、packaged、
跨平台或 review/CI/merge 验收。

同日 B3.3 执行链增量：Daemon `build` 与测试类型检查通过；`runtime-run-queue` coordinator、
queue integration/recovery、native workflow Host capacity 和 automation heartbeat 相关回归通过。
新增 TypeScript daemon fixture 以真实 daemon composition、唯一 installation-global Host SQLite、
Host 最大并发 1 和受控 Pi SDK transport 验证两条不同 automation：第一条持有 Host reservation
时第二条保持 durable `queued`，不进入 runner；第一条 terminal/drain 后第二条被唤醒并以原
Run/Attempt 完成，WorkUnit actor 为 `scheduler`，AutomationRun 的 started/completed 状态与实际
执行一致。该证据不覆盖外部 Provider、packaged、跨平台或完整 native/automation 故障矩阵。

同日 Host continuation 接缝增量：Core 受影响的 Host、审批、workflow admission、native
continuation、migration 和 queue 集合 267 项通过；Daemon 容量、队列、审批恢复、native
workflow、automation、continuation 和 user-input 集合 170 项通过。native profile 的审批恢复、
user-input Store reopen 和 workflow-start 现在复用匹配的 native Provider/Runner capacity，
workflow step 不会同时创建普通 `attempt` 与 `workflow_start` 两种 Host intent；嵌套 authority
读取在已有 SQLite writer transaction 中保持同一快照。Daemon typecheck/build、Markdown link
check 和 `git diff --check` 通过。该增量结果更新了受影响代码的当前验证状态；此前完整回归数字
不因本次增量自动扩展，真实 Provider、packaged、跨平台和 review/CI/merge 发布门禁仍未完成。

### 代码责任与实现约束

- B1：daemon `config.ts` 与专用 `runtime/concurrency-policy.ts` 捕获可信启动值；
  不新增模型/模板字段、环境变量、HTTP 热更新入口或权限扩张。
- B2：沿用 Core admission/reservation、runtime slots 与精确 Attempt fence。普通 Run、
  workflow preparing、dynamic child、approval resume、continuation 都须有接入证据。
  新总池/分类池不能与旧 Provider/Runner 池互不计数，也不能绕过审批与仓库父锁。
- B2：先实现整组资源的短事务准入与恢复，再替换调用点；不能用顺序 acquire 后只释放
  部分资源，或在现有事务内调用另起 `BEGIN` 的公共方法。
- B2：当前执行容量与 frozen resource/authority plan 分离。降额只阻止新准入，旧计划
  不变；旧 owner 和 unknown execution 不得因缺新 pool 行、TTL 或重启而漏算。
- B3：Host 容量记录不复用某个 workspace 的 DB 冒充全局 Store；跨数据库交接保留
  durable intent/receipt，明确崩溃窗口、原 owner 发现和无副作用的 reconciliation。
- B4：实际 sibling 数取所有限制的交集并冻结；放宽档位不放宽工具、路径、网络、
  optional failure 或 target apply 规则。保留旧固定二并发轮次的读取与恢复。
- B5：配置只在既有设置中呈现，不新增并发首页、会话预算卡或第二组恢复/审批按钮。

### 必须通过的验收

- 配置默认值、边界、unknown key、null、NaN/Infinity、原对象后续修改与启动快照。
- 普通 Run、静态分支、动态子代理混合运行；总量与分类、Provider、Runner 同时生效。
- 不同 channel/workflow/Store/process 争最后一个槽位，无超额、半组预留或重复 dispatch。
- preparing 到 Attempt 的原子交接、重复回调、启动失败、取消、unknown、重启与 fence 接管。
- 降额时保留已有执行；升额不升级旧 round；已批准计划、审批和 scope digest 不被重写。
- legacy 活动 owner 纳入新容量，旧 workflow/round 不被无提示升级或遗漏计数。
- 父任务占满容量时 child spawn 返回可处理的不足结果，不形成等待父任务结束的死锁；
  真正 yield/drain 后交还与 resume 重新准入另验，不释放仍有权限责任的写锁。
- 大 workflow 不饿死其他会话；Provider 限流不被当作额度丢失或成功派发。
- Host 与 workspace 交接各崩溃窗口、跨 Store 重开及其他 Host 策略冲突均可恢复且不超额。
- 2/3/4 分支的真实 Git/Host 与受控 Provider、审批、fan-in、目标不变、apply、drain 和资源释放
  证据逐档记录；按每档的真实 Provider、完整取消/重启/竞争矩阵、浏览器、packaged 和平台验收
  分别报告。

### 阶段完成判定

每个单元单独记录实现、测试、未验证范围与是否接入生产路径。B1 通过只能说明配置
解析可用；B2 通过才能声明单 workspace 统一限制；B3 通过才能声明 Host 跨 workspace
总限制。B4 的受控 Pi SDK/Host 2/3/4 档位已通过，但完整目标组合和发布门禁未通过前，
默认仍维持二档；3/4 只作为可信 Host 的显式配置能力，不能据此宣称真实 Provider、
packaged 或跨平台联合验收已完成。目标保持进行中，不能因为文档或受控测试完成就标记
整体完成。

## 13. 完整目标收口清单

这是本计划的整体完成标准，不把“代码已接线”提前写成“已发布”：

1. **执行安全**：workflow/template、普通 Run、dynamic delegation、approval resume 和
   continuation 都经过同一套 Host 权限、分类、资源、Provider/Runner 与 Attempt fence；
   不能由提示词、工具名称、客户端字段或关闭开关伪造只读或停止证据。
2. **并发与恢复**：workspace 预算、Host 总池、持久队列、公平性、跨 Store/process 争用、
   cancel/restart/unknown/降额和容量释放都可重开收敛；容量不足不产生半组资源或重复派发。
3. **隔离交付**：写入分支使用独立 worktree，结果按固定基线和顺序集成；candidate、
   approval、冲突、clean-target apply、TerminalReport 和 cleanup 均保留证据，用户 WIP 不被覆盖。
4. **会话体验**：普通文本流保持主展示；单 Agent 不显示 Graph；并行/多 Agent 才显示
   会话内折叠 Graph；失败、审批、重试、继续、取消和冲突修复留在原会话处理入口。
5. **模板和复盘**：模板 registry/authoring 只生成冻结版本；Experience review 只生成
   候选并要求原有审核流程，不自动授予运行权限或发布变更。
6. **发布门禁**：选定 workflow/executor/platform 的真实 Provider、桌面包、平台行为、
   review、CI 和 merge 证据全部通过后，才可开启对应写并发。当前分支已完成代码和受控
   本地验证，仍保持普通 workspace-write 并发关闭。
