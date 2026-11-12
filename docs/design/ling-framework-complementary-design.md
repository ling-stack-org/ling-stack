# Ling 框架补强总体设计

Status: F1/F2 merged in PR #653 (`47afcc47`); F3-A/F4-01, F3-B admission evidence, F3-02 preflight, and the Host readiness review gate are on main through PR #690 (`edb820f0`); current main includes the PR #691 documentation refresh (`878e422a`); exact Run/evaluation association merged in PR #684 (`9af7ad54`); F3-B real trial and F5 rerun remain blocked/unimplemented
Owner: Ling framework maintainers; evaluation and SDK implementation owners
Last verified: 2026-11-12
Document type: explanation / scope contract
Canonical replacement: none; complements existing runtime, evaluation, and SDK contracts
Code and test anchors: see section 10 and the implementation record; live evidence is read-only and not assessed, with no real task, Provider, or GUI acceptance

配套文档：[详细设计](ling-framework-complementary-detailed-design.md)、[实现计划书](ling-framework-complementary-implementation-plan.md)。

## 1. 结论与目标

本轮补强的核心不是再造多代理调度器，而是让 Ling 能回答三个问题：

1. 同一项任务，框架修改前后是否真的做得更好，判断依据能否复核？
2. 对外提供的包离开 monorepo 后，是否仍能安装、导入、通过类型检查并保持约定行为？
3. 任务失败时，能否从已有只读诊断定位原因，并为未来安全重跑保留明确边界？

首批实现固定任务集、离线校准、结果报告，以及真实打包产物的独立 SDK 消费测试。后续接入普通 Run 的真实执行证据和已有诊断接口。节点级重跑只定义合同，不在首批实现。

这里的“补强”是基于 Ling 当前代码与在途计划作出的工程分工，不是对所有开源框架的功能排名。没有新的外部对标或性能数据，不承诺提效比例。

### 本轮实施边界

- F1/F2 已合并到主线，合并提交为 `47afcc47b9063cd7a402a81cf1088caa695f3638`；此前 Linux 托管证据覆盖离线工具与冻结校准数据、四包真实 tarball 的仓外消费。F3-A/F4-01 的 fixture 证据适配和只读诊断报告已在主线可用，仍不代表真实 Run 或节点重跑验收。
- 审查修复后，新工具 64 项测试与相关 CI/历史扫描契约 125 项共 189/189 通过；既有三包 261 项测试及类型检查已有本地通过记录。候选 `0a4f5327` 的 Linux 托管 job 另行验证了工具 64/64、九控制校准、仓外 SDK 19/19 及 NodeNext/Bundler 类型正反例；Windows 安装器契约也已通过，但不代表 Windows SDK 消费通过。已获批准补齐 106 条精确历史误报指纹，本地同范围全历史扫描零命中、扫描契约 22/22 通过，未放宽规则或范围。旧候选的完整 CI 已以 failure 结束：Common checks 与 Daemon shard 3 失败，Daemon shard 0 取消，1/2 与 helper smoke 成功。本地修复不改写远端结果，不能声称门禁全绿。
- PR #653 的 hosted CI 已在合并前通过，合并结果以 `47afcc47` 为准；该门禁证据只覆盖 F1/F2，不扩大为真实 Runner、GUI、F3-B 或 F5 验收。
- F3-B 准入证据前置已通过 PR #676 合并到 `5990095f06d9a03c95ceb307e57f529afd462dcb`：Daemon 只读投影 Run/WorkUnit/Attempt、fence、停止、artifact、delegation 预算、isolated binding、branch result、candidate、approval 和 apply；API client 将投影与冻结任务输入关联。最终候选 35 项托管检查全部成功，实际合并提交的 84 项相关回归及零模型 preflight 通过；详见[准入审计增量](../testing/f3b-admission-audit-2026-11-10.md)。
- Run/evaluation 精确只读关联和 collector→F4 适配已在 PR #684 实现并合并到 `main@9af7ad54`；合并后 framework-assurance 98/98、Daemon assurance 相关回归 182/182、API client 7/7，以及构建和类型检查通过，托管门禁最终 30 项成功。普通 artifact 缺少独立 Attempt/fence 归属，保留 `attemptBinding: unavailable`，不授予真实执行权限。当前八项准入复核见[2026-11-12 合并基线审计](../testing/f3b-admission-audit-2026-11-12.md)。
- F3-02 review-only preflight 与 Host readiness review gate 已在 PR #690 合并到 `main@edb820f0`；当前主线为 `main@878e422a`。Host readiness 回归 20/20，framework-assurance 全套 127/127，`typecheck:ci-tests` 和格式检查通过。它只审查已捕获的五域 evidence projection，始终保持 `executionAuthorized:false`，不替代真实 Provider、生产 daemon、跨平台 packaged 或付费试点验收。当前八项准入复核见[Host readiness 收口审计](../testing/f3b-admission-audit-2026-11-12.md)。
- 失败分片的限时追加诊断未完整完成任何一轮，并发现一个原生私有状态隔离缺陷；该缺陷已在本分支修复，并由真实 macOS native boundary 回归 22/22、相关 Kimi/relay 回归 65/65 验证。原超时和远端完整 CI 失败仍分别记录，均不以单独 lane 成功或文档补齐替代收口。
- 不修改多代理并发、worktree 合并、审批、Run/Attempt 生命周期和 SQLite schema。
- 不运行真实模型，不启动、停止或重启其他会话的服务。
- 新实现采用独立工作区和独立运行数据目录；不同工作区仍可能争用 CPU、内存、磁盘与 Provider 配额。

## 2. 核查基线

| 对象 | 本次确认 | 如何使用 |
| --- | --- | --- |
| 主线源码 | 当前 `origin/main@878e422a` | PR #690 功能合并提交为 `edb820f0`，PR #691 同步设计与准入文档；历史批次仍保留各自快照 |
| 复核时主线引用 | `d7227c83af77daf237e85845961cb54511d681f8`，新增架构文档同步 | 本文涉及的 evaluation、SDK、diagnostics 源码在两快照间无变化 |
| 原文档工作区 | `codex/retry-report-supersession`，HEAD `8b259da0ff4302b97c69f9ef65e221fd108e0ee0` | 只保留原 WIP，不在此实现 |
| 当前实施工作区 | `codex/f3b-readiness-evidence`，基于 `origin/main@878e422a` | 独立 worktree；复核 Host readiness 与 evaluation association 后同步当前准入记录 |
| 提前验证提交 | `0a4f5327073058f45d14b5c21940a1811d9fb6b1`，已整合主线 `9f0b72d028f1` | 2026-11-03 核实同提交的托管 job 与产物；未创建 PR，完整 CI 尚未通过 |
| 并发实现会话 | 开工核查时，`评估 Super-agent 设计是否适合 Ling` 正在推进 P1/P2 | 这是观察快照，不是实时进度；正式接入前重新核验 |
| F1 验证层级 | 纯函数与 CLI 进程回归，实际离线校准 | 三任务九控制；不执行候选代码，不构成真实任务或 GUI 验收 |
| F2 验证层级 | macOS arm64 本地记录及 Linux x64 托管候选，Node `22.22.1`、TypeScript `7.0.2` 的真实 tarball 消费；保留此前 Node `24.22.1` 本地记录 | 各报告独立保存，运行时使用 mock transport；未验收 Windows SDK、真实 daemon/Runner 或浏览器 |

工作区已有六份架构文档修改由原任务拥有。本次不覆盖这些修改，只在设计索引增加入口。

## 3. 已有能力与待补能力

| 领域 | 已有基础 | 本计划新增 | 不应误报 |
| --- | --- | --- | --- |
| 确定性评测 | Core 规则 grader、冻结 artifact、持久化 evaluation 队列及恢复 | 固定任务元数据、正反校准、任务证据适配、可比报告 | 不是“从零建立评测系统” |
| 可靠性基准 | 本地 SQLite / scheduler 合成基准 | 任务结果正确性的验证与对比 | 不替代既有压力基准，不修改其阈值 |
| 多代理执行 | 另一会话实现安全并发、隔离执行、结果汇合及恢复 | 为其输出补任务级质量证据 | 不另建调度、worktree 或合并引擎 |
| SDK | contracts、plugin-sdk、api-client 的公共出口和仓内测试 | 真实 tarball、仓外消费、依赖闭包与支持矩阵 | 包可导入不等于真实 Runner 或权限执行已验收 |
| 业务兼容 | 已有 canonical write、历史 read、迁移及退出合同 | 在 consumer 中验证相关公共行为 | 不重做迁移、公共 API 治理或版本切换 |
| 诊断 | `GET /work-units/:id/harness` 及客户端方法 | 复用接口生成只读诊断摘要、关联报告 | 诊断读取不能触发恢复、重试或授权 |
| 重跑 | 已有受约束的 continuation / daemon recovery | 未来节点重跑的前置条件与禁止事项 | 不把 continuation 当作任意节点 replay |

SDK 基线中 `streamConversation` 等流入口返回原始 `Response`；不同入口的 HTTP 错误行为并不完全一致。本计划先验证并标明边界，不把它描述成已有统一解码、重连、取消协议。

## 4. 总体结构

```text
              [版本化任务集 / suite / task / 可信验证规则]
                      |                      |
                      v                      v
              [离线预检与正反校准]      [普通 Run 正常执行]
                      |                      |
                      |              [Host 收集执行证据]
                      |                      |
                      |              [可信验证 + 封存 artifact]
                      |                      |
                      |              [现有 evaluation 队列]
                      |                      |
                      +----------+-----------+
                                 |
                                 v
                        [可复核结果与对比报告]
                                 ^
                                 |
 [四包真实 tarball] -> [仓外 SDK consumer]     [现有只读 Harness 诊断]
                                 |                      |
                                 +--------报告引用-------+

 多代理调度 / worktree / 合并 / 审批 / Run 与 Attempt / 数据库
                   继续由既有模块及另一会话拥有
```

“证据”指 Host 或可信验证过程记录的来源、输入、结果和摘要，不是模型自行声称“已通过测试”。报告引用不可变 artifact，不把用户私有输入或原始日志复制进公共报告。

## 5. 模块职责

### 5.1 任务集与离线验证

任务集冻结源码、任务说明、验证规则、工具链和资源边界。预检只解析与核验文件；校准使用已知正确、已知错误和缺证据样本检验规则是否能区分结果。

首轮三个任务已固定到上述实施基线：T01 定位现有数组 contains 的前缀语义（`source_analysis`）；T02 明确注入取消 canonical JSON 对象键排序；T03 明确注入 diagnostics schema 变化与客户端丢失 cwd。后两者不是主线历史缺陷。

F1 只验证这些任务的元数据、注入补丁可应用性和 synthetic 控制判定。它不应用补丁、不运行修复任务，也不根据控制 JSON 的字段自称真实测试已经通过；候选代码的可信验证仍属于 F3。

### 5.2 执行证据适配

从正常任务执行链获取 Run/Attempt 关联和输入、输出快照，由可信验证执行器产生机器可判定的 JSON 结果，再交给现有确定性 evaluation。该适配器不派发普通任务、不选 Provider、不自行实现重试。

候选代码及其测试可能包含不可信代码。真实验证必须使用已有且经过验收的隔离执行能力；没有适合的执行 profile 时记录阻断，不退回到直接在主机执行任意命令。

### 5.3 结果与对比报告

报告分别记录任务执行状态、客观结果、停止原因、证据完整性、耗时、已知用量和未知用量。流程结束不自动等于正确；花费缺失不写成零。

对比必须固定同一任务、同一输入和可信规则。模型或并发策略是被比较变量时显式列出，其余差异导致报告标记不可比。合成数据、离线重放、真实执行证据分别呈现。

### 5.4 SDK 独立消费验证

构建并打包 `plugin-sdk`、`api-client`、`contracts` 及依赖闭包中的 `localization`。在仓库外临时项目中安装这些真实 tarball，通过公共出口执行运行时与类型测试，禁止工作区链接、源码导入或临时伪造包内容。

第一轮只形成实际测试格的证据，不自动承诺 CJS、所有 TypeScript / Node 版本、浏览器运行或跨历史 daemon 版本兼容。npm 包版本、插件接口版本、DTO schema 和数据库版本是不同维度。

本轮实际发现默认打包忽略规则漏掉声明文件，已为四包补充最小 `files` allowlist：包含 `dist`，contracts 另保留公开 continuity JSON。重新串行构建、真实打包与仓外离线安装通过；没有修改公共 API 语义或锁文件。

### 5.5 只读诊断消费

直接使用现有客户端 `getWorkUnitHarnessDiagnostics(cwd, workUnitId, query)`，仅消费允许公开的投影字段。未初始化的工作区保持拒绝读取，不为了报告创建 Store 或触发运行恢复。

### 5.6 节点级重跑合同

本阶段只保留未来约束：确认旧执行停止、冻结输入和图版本、校验受影响依赖、创建新执行身份、重新审批有副作用的操作、保留旧证据。不能根据一个诊断页面中的 fence 状态直接重放命令。

## 6. 需求与验收方向

| 编号 | 必须满足 | 主要验收阶段 |
| --- | --- | --- |
| R01 | 不覆盖原工作区 WIP，不访问其他会话数据库、端口和日志 | 全阶段 |
| R02 | 任务、规则、源码、产物和工具链有不可歧义的版本与摘要 | F1 / F3 |
| R03 | 用独立可信规则判断结果，正确与错误校准均可复现 | F1 |
| R04 | 不接受错误 Run、兄弟 Run、旧 Attempt 或已变化快照作为当前证据 | F3 |
| R05 | 任务状态、客观结果、证据完整性和未知用量分开记录 | F1 / F3 |
| R06 | 离线模式零 Provider 调用、不执行任务代码、不初始化用户 Store | F1 |
| R07 | SDK 从真实包在仓外消费，公开与非公开导入均有正反测试 | F2 |
| R08 | 只对测试矩阵中的环境形成证据，未测试范围不冒充支持承诺 | F2 |
| R09 | 诊断无恢复、派发、审批或敏感数据泄露副作用 | F4 |
| R10 | 重跑不复用旧审批或执行身份，不自动重放未知副作用 | F5 合同，未来另验收 |

详细验收用例及字段合同见[详细设计](ling-framework-complementary-detailed-design.md)。

## 7. 与并发实施的分工

| 责任方 | 拥有范围 | 本计划的关系 |
| --- | --- | --- |
| 并发实现会话 | admission、能力分类、隔离 worktree、结果汇合、合并应用、取消和恢复 | 消费经合并及验收的接口，不修改其在途文件 |
| 本计划 F1 | 新任务 fixture、离线校准及报告脚本 | 可以先做，不依赖真实多代理写代码 |
| 本计划 F2 | 仓外 consumer、包出口与声明验证 | 可以与 F1 并行；公共包修复单独界定范围 |
| 本计划 F3/F4 | 执行证据适配与诊断消费 | 在对应基础能力通过验收后，窄范围接入 |
| 共同维护者 | contracts、根脚本、CI 路由、设计索引 | 每次只由一个集成负责人修改 |

另一会话的计划文件名为 `docs/design/ling-multi-agent-safe-concurrency-implementation-plan.md` 与 `docs/design/ling-multi-agent-safe-concurrency-detailed-design.md`。它们在另一工作区的存在不等于已进入本分支；正式接入时按合并后的版本对照，避免在本分支制造失效链接。

不同 worktree 仍共享 Git 引用和系统资源。隔离不能解释成“完全零影响”。代码阶段还应隔离 `LING_STACK_HOME`、工作区 cwd、本地状态、端口及临时 artifact，并限制重型构建的并行度。

## 8. 分期与取舍

| 阶段 | 交付 | 默认是否开启真实执行 |
| --- | --- | --- |
| F0 | 本三份文档及入口 | 否 |
| F1 | 固定任务、零模型预检、正反校准、离线报告 | 否 |
| F2 | 真实 tarball 的独立 SDK consumer 与测试矩阵 | 否；可运行可信测试工具，不启动 daemon |
| F3-A | Run 证据适配的 fixture 与接口回归 | 否 |
| F3-B | 准入证据前置与普通 Run 真实试点，随后按能力增加并发对比 | 证据投影已实现；真实执行仍须通过安全、隔离、预算和资源前置检查 |
| F4 | 已有诊断的只读摘要和报告关联 | 只读取已存在的运行数据 |
| F5 | 节点重跑的设计合同 | 否；实现另立任务 |

选择复用现有 grader 与队列，牺牲“一套全新通用评测平台”的自由度，换取证据、恢复和存储合同一致。选择先做 CLI / JSON / Markdown 报告，暂不新建仪表盘、长期结果服务或数据库。

不接受用“已有 synthetic benchmark”“模型回答完成”“mock Runner 测试通过”代替真实任务质量或真实执行验收。真实任务慢、费用不明或缺可信验证时，允许明确记录不可评估，不降低判定标准。

## 9. 风险与降级

- 基础接口变动：冻结报告输入；重做适配器验证，不跟随在途分支反复改公共协议。
- 私有数据混入：公共报告只保留允许公开的摘要和 artifact 标识；执行原始证据保留在隔离环境。
- 付费失控：真实试点单独授权；包含子代理、工具循环及 grader 的总预算，未知用量即停止继续派发。
- 任务集失真：保留任务来源、注入补丁及正反控制；调整任务即升版本，不覆盖旧结果。
- 包产物缺失：修 producer 的打包配置并重新构建；禁止在 consumer 中补拷源码伪造通过。
- 隔离能力不足：F3-B 暂停，F1/F2 继续；不绕过 Host 权限或在原工作区验证候选代码。
- 新功能回退：停用新脚本和适配入口，保留已封存 artifact；首批没有数据库迁移。

## 10. 代码与测试锚点

以下路径已在独立实施工作区核对；既有源码以第 2 节基线为准，新增工具、打包配置与 CI 接线属于本分支变更。提交和 PR 状态以实际 Git/托管记录为准，后续接入或换基线时重新确认。

| 事实 | 代码 / 测试锚点 |
| --- | --- |
| 规则与 canonical JSON 摘要 | `packages/core/src/harness/evaluation-rule-grader.ts`、`evaluation-json.ts`、`evaluations.ts` |
| Artifact 校验与持久化评测 | `packages/daemon/src/features/harness/evaluations/rule-grader.ts`、`scheduler.ts` |
| 评测恢复与来源约束 | `packages/daemon/test/run-evaluation-scheduler.test.mjs`、`run-evaluation-storage-projection.test.mjs`、`run-evaluation-task-worker-composition.test.mjs` |
| 人工付费 grader 试点 | `packages/daemon/src/features/harness/evaluations/qa-model-pilot-runner.ts`、`packages/daemon/test/run-evaluation-qa-pilot-runner.test.mjs` |
| 合成可靠性基准 | `scripts/harness-reliability-benchmark.mjs`、`scripts/harness-reliability-corpus.mjs` |
| 实际源码与 dist 指纹模式 | `scripts/native-execution-engines/snapshot.mjs` |
| 诊断合同与只读处理 | `packages/contracts/src/harness-diagnostics.ts`、`packages/daemon/src/runtime/harness-diagnostics.ts`、`packages/daemon/test/harness-diagnostics-api.test.mjs` |
| 客户端诊断入口 | `packages/api-client/src/endpoints/runtime.ts` |
| 受约束恢复 | `packages/daemon/src/features/harness/continuations/daemon-recovery-coordinator.ts` |
| SDK 运行时与打包边界 | `packages/plugin-sdk/src/manifest.ts`、`registry.ts`、四包 `package.json` 的出口、依赖与本次 `files` allowlist |
| API 客户端现有错误与流行为 | `packages/api-client/src/transport.ts`、`endpoints/conversations.ts`、`endpoints/channels.ts`、`execution-engines.ts` |
| SDK 回归 | `packages/plugin-sdk/test/package-manifest.test.mjs`、`registry.test.mjs`、`packages/api-client/test/client.test.mjs`、`transport-origin.regression-1.test.mjs` |
| 运行目录隔离 | `packages/core/src/runtime-paths.ts` |
| macOS native boundary | `packages/daemon/src/runtime/sandbox/native-process-launch.ts`、`packages/daemon/test/native-process-boundary.test.mjs`；本地验证覆盖 workspace/private-state、Kimi metadata、relay 与进程回收 |
| 本轮离线实现与回归 | `scripts/framework-assurance/manifest.mjs`、`preflight.mjs`、`grader.mjs`、`evidence.mjs`、`report.mjs`、`output.mjs`、`index.mjs`、`offline.test.mjs`、`cli.test.mjs` |
| F3-A fixture 证据适配 | `scripts/framework-assurance/execution-evidence.mjs`、`execution-evidence.test.mjs`、`fixtures/framework-assurance/execution-evidence/` |
| F3-B 准入证据投影 | `packages/contracts/src/framework-assurance.ts`、`packages/daemon/src/features/runs/assurance-evidence.ts`、`packages/api-client/src/endpoints/runs.ts`、`scripts/framework-assurance/execution-evidence.mjs` |
| F3-B 受控回归 | `packages/daemon/test/assurance-evidence-api.test.mjs`、`assurance-evidence-isolation.test.mjs`、`assurance-evidence-budget.test.ts`、`packages/api-client/test/harness-diagnostics.test.mjs` |
| F4-01 只读诊断报告 | `scripts/framework-assurance/diagnostics.mjs`、`diagnostics.test.mjs`；通过 `readHarnessDiagnosticsReportFromClient` 组合既有 `LingDaemonClient.getWorkUnitHarnessDiagnostics` |
| 本轮真实包消费与回归 | `scripts/framework-assurance/sdk-consumer.mjs`、`sdk-consumer.test.mjs`、`fixtures/framework-assurance/sdk-consumer/` |
| 冻结校准输入 | `fixtures/framework-assurance/suites/framework-v5.json` 及 cases/controls 引用；历史 v3/v4 结果不改写 |

既有业务兼容设计归 `docs/design/business-data-api-compatibility.md`、`business-data-api-compatibility-cutover.md`、`business-compatibility-boundary-hardening.md` 等主线文档所有。本计划不取代其迁移和退出门禁。

## 11. 阅读顺序

1. 本文确定范围、已有基础和跨会话分工。
2. [详细设计](ling-framework-complementary-detailed-design.md)定义数据、证据、错误处理与验收矩阵。
3. [实现计划书](ling-framework-complementary-implementation-plan.md)确定工作包、依赖、提交顺序和停止条件。

相关既有设计：[Ling Framework](ling-framework.md)、[Multi-Agent App Detailed Design](multi-agent-app-detailed-design.md)、[State Machines And Recovery](state-machine-recovery.md)、[Internal Registry And Plugin SDK](internal-registry-plugin-sdk.md)。
