# B-013：Workflow 前置 Gate 与自动启动确认的原子准入

日期：2026-10-16
状态：基于当前实现的只读 trace 后补充的窄设计；尚未编写本项测试、修改产品、运行或构建。
审核/发布批准：`approved=false`。本项不是 Office 全量独审、packaged GUI 或正式发布批准。

## 1. 目标与边界

解决两个同族编排合同缺口：

1. graph/custom template 的 `gates` 非空，不等于无副作用，也不能代替明确的自动启动确认。
2. 声明式、适用的 `stage=pre` gate 必须在创建 Task 和启动 Run 前生效，覆盖 Advance、
   手工 Start、Retry 和恢复；不能只在外层 orchestrator 加一段 UI 或条件判断。

工具权限、Plan Mode、Provider preflight、channel tools、Host operation authority、Run/Attempt
fence 和 B011 startOwner 继续独立校验。此次只确认编排合同缺口，**没有证据表明真实命令、文件
或远端副作用已越权发生**。前置 gate 批准不授权工具越权，也不能替代具体工具审批。

不新增服务或 SQLite 表，不改真实历史、不迁移既有报告，不启动真实模型、App 或主 CI。
H10/模型评估预算不在本项内，不替用户选择预算。

## 2. 当前真实可达链

以下行号是 2026-10-16 当前树的定位，后续修改以符号名为准，不冒称整文件安全审核。

### 2.1 编译与持久化

```text
POST /channels/:channelId/workflows
  server/router.ts:2266
  → workflows.ts:185–188
  → workflow-templates.ts:88–113 parseWorkflowTemplateCompileRequest
  → compileWorkflowTemplate:116–132
      ├─ workflow-graph.ts validateWorkflowGraph:222–231
      │    → compileWorkflowGraph metadata.gates / autoStart
      └─ workflow-templates.ts validateCustomWorkflowTemplate:389–398
           → compileCustomWorkflowTemplate metadata.gates / autoStart
  → Core channel-workflow-store.ts:1265–1365
       channel_workflow_steps.metadata_json
  → channel-workflow-mappers.ts:245–251 / 640–674
       approvalGate、gates、preStepApprovalId 均能读回
```

`graphNodeHasSideEffects:567` 和 `customTemplateStepHasSideEffects:543` 仍在任何非空
`gates` 下直接返回 false；因此 mode=none、post-only、status 不适用的 pre 也可免去
`confirmUnsafeAutoStart`。这不是有效的前置屏障判定。

B008 已修合法状态闭集和 mapper 限制列表：absent=any、[]=none、非法值拒绝；
它没有把声明式 pre 接入执行前消费。

### 2.2 Advance、手工 Start、Retry

```text
POST /workflows/:id/orchestrate
  router.ts:1958–1982 → orchestrateChannelWorkflow
  → orchestrator.ts:195–220 maybeRequestPreStepApproval
  → workflows.ts:675 prepareWorkflowStepStart
  → Core channel-workflow-start-store.ts:23–53 beginChannelWorkflowStepStart
       状态迁移 + createTask + startOwner
  → startRun

POST /workflow-steps/:id/start
  router.ts:2079 → workflows.ts:628 → prepareWorkflowStepStart → 同一 Core begin → startRun

POST /workflow-steps/:id/retry
  router retry 分支 → retryChannelWorkflowStep / orchestrator.ts:581
  → prepareWorkflowStepStart → 同一 Core begin → startRun
```

`maybeRequestPreStepApproval:1174` 和 `smart-scheduler.ts:152` 只读
`metadata.approvalGate`。`selectWorkflowStepGate` 的真实调用只有 post:1024；
声明式 `metadata.gates` 虽保存完整，但 pre 尚未消费。

手工 Start / Retry 不经过该 pre helper。Core begin 目前只核 expected、lease、依赖、owner
与状态，不核适用 pre approval。B011 的原子 Task/owner 准入与 post 审批保护是真实反证，
但并未覆盖这项前置合同；只修 orchestrator 会留下另两个入口。

### 2.3 正常反例与恢复入口

- builtin compile 在 `workflow-templates.ts:183` 保存 `approvalGate`，现有 pre helper
  真实生效；必须保留，不能用较弱声明 gate 覆盖它。
- proposal 经 `confirm-workflow` 动作到 `proposal-workflows.ts:199–208`，内部编译显式
  `confirmUnsafeAutoStart:true`，保留该正常合同。准确说这是 Host 内部 compile 参数，
  **不是 HTTP body 必填的 `confirm:true` 字段**；现 router:2327–2345 不读取该 body。
- 审批提交后 `router.ts:2728`，以及 startup `index.ts:821` 的 postcommit recovery，
  都调用 `syncWorkflowApprovalDecision`。该接缝也必须核对当前 pre 审批归属。

## 3. 两个互不替代的决策

### 3.1 是否允许开启 autoStart

graph/custom 的现有 `autoStart=false` 默认、技能可执行性、Runner/并行预算等验证保留。
对已识别的风险工具沿用 `isRiskyRunTool` 分类，不因有 gate 改成无副作用。

- 风险技能的 autoStart，在 none / post-only / 有效 pre / 不适用 pre 四种情况下，都仍须
  `confirmUnsafeAutoStart:true`；确认缺失时在创建 workflow/step 前拒绝。
- graph 显式 `requiredTools` 也属于实际声明输入，应与技能 requiredTools 一并纳入同一
  风险判定，不能只看 skillId；不借此扩展实际工具授权或新建风险分类体系。
- builtin 模板的既有可信模板策略与 proposal 显式确认正常路径不顺手重写。
- 确认 autoStart 只允许调度；运行前若还有适用 pre gate，仍须取得该次 gate 批准。

### 3.2 这次启动是否已满足前置 gate

将现有 selector 提取为共享纯函数，适用规则保持：stage 精确匹配、mode!=none、
absent requiredForStatuses=any、[]=none、显式列表精确匹配，不把未知值转换为 any。
多个声明 gate 沿现有 first-applicable 语义，不改成全部 gate 串联或随意挑最弱一项。

前置有效配置由声明式 pre 和既有 `approvalGate` 共同形成：

- 仅 builtin：原 profile、风险、requiredForTools/actions、默认标题/说明保持。
- 仅声明式：使用选中 gate 的 profile、title、reason。
- 两者并存：声明 gate 不能屏蔽 builtin；复用现有保守 merge（严格 mode 优先，要求取并集），
  风险取不低于任一输入，说明同时保留两者来源；不产生两个相互竞争的许可。
- mode=none 或 status 不适用的声明 gate，不制造请求，也不关闭 builtin gate。
- post selector 仍在成功结果的既有时点使用 `succeeded`；不改后置门槛成启动许可。

Core 负责同事务最终判定，Daemon scheduler、prepare、orchestrator 使用相同纯选择逻辑。
不要让 UI、scheduler 或 model 文本各自实现不同的 gate 规则。

## 4. 审批依据跨状态持续有效，但不能跨启动无限复用

不能仅在旧 helper 加 `select(pre, step.status)`：申请审批前可能是 queued，批准后是
running；若 gate 限定 queued，按新状态重选会“消失”。反过来，也不能仅凭一个 approved id
永久放行之后的定义或新 Task。

新增 Host-only、持久化的 pre gate basis/marker，复用现有 `metadata_json` 和 approval payload：

```ts
interface WorkflowPreGateBasisV1 {
  readonly schemaVersion: 1;
  readonly startNonce: string; // Host 创建的本次启动周期，不由客户端指定
  readonly authorityBasis: string; // 复用 workflowStepStartAuthorityBasis 的语义依据
  readonly requestedStatus: ChannelWorkflowStepStatus;
  readonly gateFingerprint: string; // 来源、有效 profile、title/reason、适用规则
  readonly fingerprint: string;
}
interface WorkflowPreGateMarkerV1 {
  readonly basis: WorkflowPreGateBasisV1;
  readonly consumedByTaskId?: string;
}
```

marker 与现有 `preStepApprovalId` 配对，不复制 Approval.status 成第二份真相。
approval payload 持有对应 basis，request 的 channelId/workflowStepId 与 payload 的
workflowId/workflowStepId/gateStage=pre 必须全部一致。

`workflowStepStartAuthorityBasis` 已含 gate/approvalGate、prompt/title、participant、tools、
Provider/source 等语义。复用该依据，不把 mutable status/updatedAt、审批投影字段或 marker
本身塞入语义哈希，不形成环形 fingerprint；requestedStatus 单独冻结。

- queued→claimed→running→waiting_for_approval→running：保存的 requestedStatus 不变，
  同一有效 basis 的批准能继续完成唯一 Task 准入。
- pending 不占用执行 lease、Task、Run、startOwner；不把“Step 的 gate 状态 running”当执行已开始。
- begin 成功时同事务写 consumedByTaskId 和 Task/startOwner；并发 Advance/Start 不能各创建 Task。
- 同一已存在 Task/Run 的审批续跑沿 B011 owner 和 Attempt fence，不重新消费“开始一个 Task”。
- 失败后显式 Retry 是新的 Task 启动周期，重选当前 status 的有效 gate；不得把已消费的批准
  当新周期许可。不适用的 gate 不伪造审批，仍核其他适用 gate 和 builtin。
- 定义、归属、source 或权限语义变化使 authority basis 失效。旧批准、旧 callback、伪造 id、
  已撤销/过期/拒绝请求不能授权 successor；不为兼容而猜造缺失 basis。

这不是增加对旧数据库的迁移工作。无 marker 的历史 pre 请求不可自动升级为新许可；应安全
返回 stale/blocked，由明确的 Advance/Retry 创建当前请求，保留旧审批审计，不回写其内容。

## 5. 最小接口与事务归属

建议新增小型 Core 纯模块 `workflow-pre-gate.ts`（选择、保守合并、basis 验证），
窄类型沿既有 workflow-step-start-owner/types；复用现有 SQLite start-store 作为唯一写入者。
不要继续向大型 orchestrator/workflows 文件塞完整状态机。

### 5.1 请求与决议

在 RunStore 的现有 workflow facet 增加两个窄操作，命名可随现有风格微调，语义固定：

```ts
requestChannelWorkflowStepPreApproval({ workflowStepId, expected, now })
// not_required | requested/duplicate { approval } | approved | blocked | stale/invalid

resolveChannelWorkflowStepPreApproval({ workflowStepId, approvalId, now })
// approved | waiting | blocked | stale/invalid
```

Core 自己从当前 Store 读取 definition、selector 和有效 basis，不信任调用方传入的 approved
boolean、gate profile、status 或 arbitrary approvalId。两操作使用 start-store 的同步短事务：

1. 重新读取 workflow/step/source 与 expected，拒绝 terminal、stale 或错误归属。
2. 计算/验证当前周期与 gate；同 basis pending 请求返回 duplicate。
3. 创建 approval、保存 preStepApprovalId/basis、合法状态迁移与 transition audit 原子提交。
4. 决议只采用 Store 当前 request；pending 不前进，approved 仅转到待准入，deny/expiry/cancel
   复用既有 onApprovalDenied 策略。旧事件不会恢复 successor 的状态。
5. 任一步异常全 rollback，不残留“有 approval 无 marker”或“waiting 无 request”；不得在
   事务内 await Provider、Runner、网络或文件写入。不吞 rollback/commit 异常。

现有 post-approval 原子事务与决议保持独立，不把 pre 塞成 post 或复用 Run 工具 checkpoint。

### 5.2 统一 prepare 与最终 begin

`prepareWorkflowStepStart` 在资源 lease、memory/context 构造和 Task 创建前调用前置准入。
扩展内部 PreparedWorkflowStepStart：waiting_for_approval 携真实 workflow/step/approval；
manual route 与 orchestrator/retry 统一返回等待事实，不误报 ready、执行成功或 HTTP 错误。

`beginChannelWorkflowStepStart` 在既有 **同一个 SQLite 事务、createTask 之前**：

- 重读当前 effective pre gate；核未消费、精确归属、当前 approved request 与 basis。
- 无适用 gate 也基于当前语义验证 not-required，不能用外层旧快照绕过刚新增的 gate。
- 核 gate 后才执行状态迁移、Task 创建、startOwner 写入和许可消费；任何失败全 rollback。
- 保留 B011 expected/lease/dependency/authority 校验，不挪走 ready 的唯一 owner commit。

两层校验各有职责：prepare 产生可交互的等待事实，Core begin 防并发/TOCTOU 和直接调用旁路。
startRun 只接受 ready；pending/denied/expired/stale 的 Task 准备/创建及 startRun/Runner
计数必须均为 0。纯前置准入调用本身不算 Task 准备或执行，避免测试计数含义混淆。

`smart-scheduler` 复用有效 pre 选择与审批事实来排预算，不再只看 approvalGate；调度预算是
投影，不成为授权事实。orchestrator 不先独立创建一份审批；manual Start 和 Retry 也不能绕过。

#### 启动请求不能改变已批准的执行语义

适用 pre gate 的手工 Start 在申请/消费前拒绝非同值的 `taskPrompt`、`taskTitle`、
`providerPresetId`、`runnerId` override，返回 HTTP 409；不分配 lease，不准备 Task/Run。
相同值和省略字段保留正常路径；无适用 pre gate 的既有 override 接口不改变。

- prompt/title 与持久化 Step 的 prompt/title 精确比较，不将后来合法生成的 contextPack
  渲染 prompt 强制等于裸 Step prompt；Core begin 继续核持久 basis/permit/owner。
- Provider 默认依据按 frozen `providerBinding.providerPresetId`、Step `providerPresetId`、
  Channel `defaultProviderPresetId` 顺序确定；显式不同值须先修改持久定义、重新申请审批。
- Runner 的批准依据是 Step `requestedRunnerId`。已保存该字段时省略值也沿此请求来源运行；
  未保存时保留既有 workspace/user/built-in implicit routing，不在前置准入另读或猜测默认。
  此时显式 runner 并不等价于“省略后恰好解析到同一 runner”，因为 explicit/implicit 的
  fallback 规则不同，所以仍视为不同 override 并拒绝。无 pre gate 路径维持原有输入优先语义。

改变定义后旧 marker 会因 authority basis 不同失效，不通过布尔标记或 UI 文案绕过最终校验。

### 5.3 错误与 API 行为

复用已有 unsafe-autoStart 错误码和 HTTP 400 编译拒绝；不把有效等待视为失败：

| 情况 | 合同 |
| --- | --- |
| 正常 pending / 同 basis 重复请求 | HTTP 200，status=waiting_for_approval，返回同一 approval |
| 批准后唯一 begin | 正常既有 ready/start 路径，唯一 Task/Run |
| expected / definition / approval basis 变化 | HTTP 409 或内部 stale；无 Task/Run，重读后明确 Advance |
| gate 必需但缺合法批准的直接 Core begin | invalid，`workflow_pre_approval_required` |
| marker/payload 归属或 basis 非法 | invalid/stale，`workflow_pre_approval_basis_stale`，不自动认作已批准 |
| denied / expired / cancelled | 结构化 blocked/failed，沿现有策略，不自动开始或静默换新请求 |
| transaction I/O 异常 | 错误返回、整笔 rollback；不能把半成功显示为 waiting/started |

码名是本项最小语义建议，实现时复用现有错误目录规范；不进行无关字符串统一迁移。

## 6. 恢复与并发

- 审批提交仍复用现有 durable postcommit recovery；router 与启动恢复调用相同 Core
  resolve，不能让 stale pre callback 仅靠 workflowStepId 改 Step/Workflow 状态。
- daemon restart 只重建 pending/approved 的真实投影，不自动创建新副作用启动周期。批准
  待准入由现有调度/明确 Advance 消费，不引入另一个后台执行器或“恢复即执行”分支。
- 请求前、request transaction 中、批准提交后、begin 前、Task 创建中和 begin 提交后分别
  故障注入；重启只读取已提交事实。已 commit 的 Task 不再重复创建；未 commit 的不留 owner。
- 两个 SQLite 连接竞争相同 Step 请求/批准/Advance：至多一个有效请求、一个周期、一个 Task；
  loser 为 duplicate/stale，不覆盖 winner 的 metadata、批准、lease 或 Run 链接。
- cancellation、definition 修改与 begin 竞争时，以同事务最新状态裁决；审批不复活已终止 source。
- 不添加旧格式无 basis 放行分支，不伪造 lease，不改变 post-only 的后置意义。

## 7. RED→GREEN 回归矩阵

必须由 Root 先审 test-only/hash，再实际首跑确认是目标 RED，不接受 setup 失败或静态 grep
当行为复现。只用隔离 SQLite、真实 HTTP handler、离线 Provider/计数 Runner；不读日常 DB、
Keychain、真实模型/外网、正式 App。assert 同时检查事实数量、状态、输出与持久化，不仅检查 UI。

| 维度 | 必须验证 |
| --- | --- |
| 编译确认 | graph/custom 风险技能 × 无 gate/none/post-only/有效 pre/不适用 pre：缺确认均拒绝且无 workflow/step；确认后合法编译 |
| 正常编译反证 | readonly 默认、autoStart=false、builtin、proposal 内部 confirmUnsafeAutoStart:true 正常保留 |
| 真实入口 | Advance、manual Start、Retry：适用 pre 的 pending 均 0 Task/0 Run/0 runner start；相同请求复用审批 |
| status | absent/[]/queued/blocked/不适用；queued 限定经 waiting→running 后批准仍有效；post 在 succeeded 才请求 |
| gate 并存 | builtin 不被 none/较弱声明 profile/较低风险削弱；有效声明的 title/reason 与合并要求准确 |
| 决议 | approve/deny/expiry/cancel；合法批准唯一运行；拒绝按策略 blocked/failed，过期不开始 |
| Core 直接调用 | 不经 prepare 的 begin 仍拒绝缺许可；外层检查后新增/改 gate，最终事务仍拒绝 |
| 归属/新鲜度 | 错 channel/workflow/step、旧 id、缺/伪造 basis、已消费许可、改 prompt/participant/tools/source 不可复用 |
| 并发/回滚 | 两连接请求/批准/Advance 与修改/取消竞争；Task 创建/状态 audit/marker 写入注入失败全部原子 |
| resume/restart | pending/approved 未消费/已消费/旧 callback/中断 commit；保持 1 request/1 Task/1 Run，重启不隐式开新周期 |
| 工具独立保护 | pre 批准后 bash/edit/write 仍按真实工具 policy 审批/拒绝，Plan Mode/Provider/owner 保护不退化 |
| 邻近回归 | B008 status-gate、B011 start-owner/post approval、workflow operation evidence、proposal confirm、approval postcommit recovery |

顺序：冻结设计/test-only → 有效 RED → 最小 Core/Daemon 产品候选 → fresh Core/Daemon build →
专用 GREEN + 邻近完整文件 → 未实施产品者独审 → 主执行链收口。GUI/打包验收另列，不能被以上
隔离行为测试冒充。

## 8. 完成门槛与未决判定

只有上述真实链均接通、异常与恢复矩阵通过、独审无剩余已确认问题，才能有限关闭 B-013。
不能只删除 `gates.length` 特判、只把声明 pre 映射为 approvalGate，或只修外层一个入口即称完成。

本窄设计无新增待用户选择的产品/预算决策；first-applicable、自动启动确认独立、一次 Task
准入消费、builtin 不可削弱和旧无 basis 不放行均在此明确。具体接口命名不改变这些合同。
既有 orchestrator/workflows/store 大文件仍为模块风险；新增复杂选择/basis 逻辑应放小模块，
大文件只保留委托和既有状态机接线，不借本项做广泛重构。
