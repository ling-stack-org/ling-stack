# Ling 框架补强实现计划书

Status: F1/F2 merged in PR #653 (`47afcc47`); F3-A/F4-01, F3-B admission evidence, F3-02 review-only preflight, and Host readiness are on main at `edb820f0` (PR #690); the F3-B real trial and F5 rerun remain blocked/unimplemented
Owner: Ling framework maintainers; one integration owner per implementation batch
Last verified: 2026-11-12
Document type: implementation plan / acceptance checklist
Canonical replacement: none; retain while material work remains unfinished
Code and test anchors: sections 7 and 9; live evidence is read-only, Host readiness is review-only, and no real task or GUI acceptance is claimed

设计依据：[总体设计](ling-framework-complementary-design.md)、[详细设计](ling-framework-complementary-detailed-design.md)。

## 1. 交付结论

按“离线评测与报告 + SDK 独立消费”先实施，再接真实执行和诊断。不要等待另一会话完成所有未来功能，也不要抢先改它正在拥有的安全并发、隔离执行、合并和恢复文件。

用户确认开始后，F1/F2 已在独立工作区实现并合并到主线，合并提交为 `47afcc47b9063cd7a402a81cf1088caa695f3638`。F3-A/F4-01、F3-B 准入证据前置、F3-02 和 Host readiness 已进入 `main@edb820f0`，包含 #676、#685、#684、#688、#689 和 #690 的已合并增量。默认不产生付费模型请求，不启动生产 daemon、不修改共享数据库，不开放真实 F3-B 试点。实际证据见第 9 节。

| 里程碑 | 内容 | 当前状态 | 进入条件 |
| --- | --- | --- | --- |
| F0 | 三份设计与实施文档 | 已编写；文档检查通过 | 无代码执行依赖 |
| F1 | 固定校准任务、预检、正反校准、离线报告 | 已实现；47 项离线/CLI 测试与实际校准通过 | 不构成真实代码任务验收 |
| F2 | 真实包审计、仓外 consumer、支持矩阵 | 已实现；17 项边界测试及修复后的真实四包消费通过 | macOS arm64 本地及 Linux x64 托管分别有 19 组 runtime 与两个类型格；Windows SDK 未验证 |
| F3-A | Run 证据适配与 fixture 回归 | fixture 适配及只读 Host 来源适配已实现；仍不代表真实评测通过 | F1 格式稳定、来源接口可核实 |
| F3-B | 准入证据前置、普通 Run 真实试点及后续并发对比 | 准入证据前置已实现；真实试点仍 BLOCKED | 对应安全/隔离/恢复验收、可信验证、试点预算 |
| F4 | 已有 Harness 诊断的只读消费 | F4-01 已实现分页报告；未改生产者 | F1 报告稳定、已有诊断合同可用 |
| F5 | 节点重跑合同 | 仅文档设计 | 实现另立任务，本计划不增加 rerun 功能 |

## 2. 开工前的隔离与分工

### 2.1 实施基线

本批已核实并 fetch `origin/main`，从 `d7227c83af77daf237e85845961cb54511d681f8` 创建专用 managed worktree，未沿用原目录旧 HEAD。仅选择性带入三份文档和索引；原六份 WIP 继续留在原目录。以下步骤仍适用于后续批次，不把开工快照当永久主线。

1. 重新检查合并状态与主线代码。总体设计中的两个 commit 是本次核查快照，不是未来自动有效的开工基线。
2. 先检查已有附属 worktree，复用适合且没有冲突的干净实施工作区；没有合适工作区时再创建专用 worktree / `codex/ling-framework-assurance` 分支。
3. 基于核实后的已合并 `main`，不基于本次较旧的 `codex/retry-report-supersession`，也不基于另一会话的在途分支直接开工。
4. 将本次三份文档及索引入口选择性带入实施基线。不整体复制当前目录，不带入与本任务无关的 WIP。
5. 保存开工时文件状态、关键锁文件摘要与工具链信息。检测到他人修改时保留，无法分离的改动先隔离，不 reset、clean 或覆盖。

本次文档工作区已有 `docs/architecture.md`、`contracts-api-client.md`、`desktop-shell.md`、`internal-registry-plugin-sdk.md`、`platform-architecture.md`、`web-modularization.md` 六份原有修改，后五份位于 `docs/design/`。它们不属于本计划首批写入范围。

### 2.2 运行资源清单

| 资源 | 实施约束 | 验证方式 |
| --- | --- | --- |
| 源码与 dist | 仅使用实施工作区，记录构建输入与实际产物 | 构建前后摘要及产物审计 |
| 用户状态根 | 为需要运行的测试设置独立 `LING_STACK_HOME` | 核查实际 runtime path，不能只设置变量就假定隔离 |
| workspace cwd | 指向工具拥有的临时/专用工作区 | 确认 `.ling-stack`、SQLite、artifact、日志均未落到原工作区 |
| 服务与端口 | F1/F2 不启动 daemon；后续使用独立端口 | 启动前核验占用，不停止/重启其他会话进程 |
| Git | 不 prune worktree、不删除共享引用、不操作他人分支 | 精确文件 diff 与分支身份 |
| 系统资源 | 初始重型构建并行度为 1；轻量纯函数测试可并行 | 运行前确认另一会话是否在重型构建，不抢满资源 |
| Provider | 首批零调用；后续仅显式预算试点 | 请求账本与未知用量停止规则 |
| 临时目录 | 工具创建、标识归属、限于本次输出 | 清理前核实 realpath；不清理公共缓存和其他工作区 |

不同 worktree 仍共享 CPU、内存、磁盘和 Git 引用，不能承诺绝对零影响。上述清单是在代码与运行数据层降低干扰；本次没有探测所有现存监听端口或证明全机完全隔离。

### 2.3 文件责任

| 实施角色 | 可写范围 | 不能顺手改动 |
| --- | --- | --- |
| 评测实现者 | `scripts/framework-assurance/` 的 manifest、preflight、evidence、report 及对应测试；`fixtures/framework-assurance/` 的 suites/cases/controls | 普通调度、审批、存储迁移、Provider 选择 |
| SDK 实现者 | `sdk-consumer.mjs` 及对应测试、`fixtures/framework-assurance/sdk-consumer/` | 向根安装依赖、修改 API 语义、统一 manifest 类型 |
| 集成负责人 | 新 CLI `index.mjs`、根脚本/CI 路由、共享 fixture 索引、三份设计和设计索引 | 未经界定的大范围公共合同变动 |
| 并发实现会话 | 安全并发、worktree 执行/汇合/应用、取消与恢复 | 本计划不接管其在途文件 |

允许评测与 SDK 两个独立写集并行。若需要修改公共包配置或接口，先缩小写集并交由一位负责人处理，不让两个实现者同时编辑共享入口或锁文件。

本批由集成负责人额外修改四包 `package.json` 的 `files` allowlist，修复真实打包发现的声明缺失；没有修改出口/API 语义、依赖或锁文件。根命令、独立 assurance CI lane 与严格汇总门已接入，原有 Draft/full-ci 选择规则不变。

## 3. F1 工作包

### F1-01 固定任务与格式

- **输入**：已核查 Core grader、任务来源及详细设计第 3 节。
- **改动**：`manifest.mjs`、对应测试、suites/cases/controls fixture。
- **实施**：落实 T01/T02/T03 的具体 commit、任务说明、可信规则、正反与缺证据样本。只读源码分析为 `source_analysis`，真实回归引用实际来源；注入缺陷同时保存补丁和说明。
- **约束**：不改现有闭合 rule case，不执行 fixture 内代码，不使用占位摘要冒充冻结任务。任一槽位未落实，必须标记未交付，不能把只有 schema 的提交称为任务集完成。
- **验收**：A01 至 A04；错误 schema、重复 ID、超限、错误摘要、越界与链接逃逸均有负例。
- **依赖**：实施基线与目录责任已确认，不依赖真实并发执行。

### F1-02 离线预检与正反校准

- **输入**：F1-01、同一基线的现有 Core 纯函数 grader；当前通过原生 TS 窄加载，无需完整 Core 构建。
- **改动**：`preflight.mjs`、对应测试；由集成负责人接入 `index.mjs`。
- **实施**：只读预检、固定正反控制、缺证据处理和稳定退出码。对通过摘要检查的同一字节做解析，防止重新读取混入变化。
- **约束**：无 Provider、普通 Run、用户 Store、真实任务命令。复用 grader，不复制断言实现。
- **验收**：A03 至 A05；正确控制通过、错误控制失败、缺证据不能通过；通过副作用边界测试证实零派发。
- **依赖**：F1-01 格式稳定。三槽位可以逐个校准，但里程碑要求全部覆盖。

### F1-03 观察文件与对比报告

- **输入**：详细设计第 6 节、F1-02 校准结果及固定报告样本。
- **改动**：`evidence.mjs` 的私有格式、`report.mjs`、对应测试；JSON / Markdown 输出在临时目录生成。
- **实施**：分离执行状态与客观判定，区分证据类型，计算显式分母、可比性、已知费用小计及未知项。
- **约束**：不增加数据库，不建立后台服务，不把校准次数算入真实任务成功率。不可比的两组结果只能并列，不输出提效结论。
- **验收**：A06；零分母、失败/未启动、不支持、未知币种/用量、重复 invocation、不同规则/平台等边界；JSON 与 Markdown 结果一致并脱敏。
- **依赖**：F1-01；可与 F1-02 后半段开发并行，集成验收在 F1-02 之后。

**F1 完成定义**：三个具体任务全部冻结，离线正反校准通过，报告可复核，零模型与零用户运行状态副作用有测试证据。只有文档或数据结构不算完成。

这里“任务”特指校准任务：T01 源码分析、T02/T03 明确故障注入。F1 不执行注入后的候选代码；真实修复前失败/修复后通过等代码行为验收仍列入 F3，不能用正确控制 JSON 代替。

## 4. F2 工作包

### F2-01 Producer 审计与仓外安装

- **输入**：四包实际 manifest 与出口，实际依赖闭包，独立构建目录和固定工具链。
- **改动**：`sdk-consumer.mjs` 的构建/归档/隔离部分、对应测试、consumer 基础模板。
- **实施**：同一基线构建，真实 `pnpm pack`，审计 tarball 中的 exports、声明、JS、JSON 与依赖；仓外一次性安装本地 tarball，禁止生命周期脚本和网络 fallback。
- **约束**：localization 是当前闭包的一部分，不只打三个入口包。禁止在 consumer 修补归档内容或链接源码。发现 producer 问题时提交最小包配置修复，不附带 API 重构。
- **验收**：A07/A08；所有解析落在 consumer 临时目录；锁文件前后摘要相同；归档缺文件/缺依赖有失败证据。
- **依赖**：不依赖 F1，也不依赖另一会话的并发实现；需要独立构建资源。

### F2-02 公共消费测试与矩阵

- **输入**：F2-01 的真实产物；现有 manifest、registry、transport 和各流入口合同。
- **改动**：consumer 的运行时与类型测试、NodeNext / Bundler 配置、`sdk-consumer.mjs` 的结果矩阵部分。
- **实施**：公共导入与深导入反例、类型必填项正反例、manifest 两套校验边界、registry、HTTP/cause/abort/no-retry、token 路由与原始流分入口测试。
- **约束**：不能把 Web 解码器当作 api-client 公共功能，不承诺自动重连或统一 HTTP 错误。fake Runner 只证明受测接口，不能代替真实 Runner 执行/恢复。
- **验收**：A09 至 A11；每格记录实际工具链、平台与 tarball SHA，未测平台明确未测。Consumer 与仓内测试分别报告。
- **依赖**：F2-01；复用 F1 报告格式时由集成负责人串联，不阻塞其独立 JSON 结果输出。

**F2 完成定义**：至少一个真实运行的 ESM NodeNext 格通过，Bundler 类型格单独记录，各包依赖闭包与正反行为可复核。跨平台支持只对实际通过的格声明，不虚构 Windows/Linux 验收。

## 5. F3 / F4 后续工作包

### F3-01 执行证据适配，fixture 范围已完成

- **输入**：F1 已冻结格式、主线已合并的 Run/Attempt/WorkUnit 和封存接口。
- **改动**：新增本计划 `execution-evidence.mjs` 与 fixture 测试；必要内部读取接口另列单一拥有者及窄范围差异。
- **实施**：建立从正常源 Run 到可信验证结果，再到现有 evaluation 的关联。不负责普通任务派发或 Provider。
- **验收**：A12；兄弟 Run、旧 Attempt、快照变化、缺 artifact、错误字节摘要、claim 丢失、报告重试不重跑任务。
- **停止条件**：接口只存在于另一会话 WIP，或需要直接改私有表/迁移才能接入时，停止真实接线，保留 fixture 并提出具体接口差异。
- **本批结果**：`execution-evidence.mjs` 提供独立 trusted binding、lineage/snapshot/artifact/claim 校验和 `fixture_replay` observation 适配；`execution-evidence.test.mjs` 与两个 JSON fixture 覆盖 A12。真实 Run/Host 封存接口仍未接入。

### F3-02 单任务串行真实验收

- **输入**：F3-01、正常执行入口、可信验证器，以及准入清单。
- **实施**：先做 T01 只读任务，随后仅对已具备隔离验收的写任务做 T02/T03；真实任务、验证与 grader 分别记录调用与费用。当前已先交付 `trial-preflight`：它只接受可信绑定的提交内 T01 manifest，核对 suite/task/source/input 摘要，冻结 Provider/model、金额/币种、Provider 请求、token、工具循环、子代理、grader、在途 reservation 和未知状态停止规则，并检查 checkout 外的 `LING_STACK_HOME`、workspace、输出目录、loopback 端口及 CPU/内存/磁盘余量。
- **验收**：A13/A14；完整链条不是用合成日志替代。包含一次失败/缺证据和一次取消未确认停止的处理证据，不人为强制所有任务通过。
- **限制**：默认不进入日常付费 CI。预算、Provider 与请求上限没有明确前，不运行模型。`trial-preflight` 只返回 `blocked` / `ready-for-review`，始终 `executionAuthorized=false`，不启动 Provider、模型、daemon、Store 或真实任务；资源与端口在真正启动前仍须重查。

**F3-02 前置交付状态（2026-11-12）**：`scripts/framework-assurance/trial-preflight.mjs`、`fixtures/framework-assurance/trials/t01-review.json` 和 `trial-preflight.test.ts` 已实现。测试覆盖冻结摘要漂移、可信 manifest 路径和字节绑定、符号链接、非空目录、目录根 symlink 逃逸、错误 `LING_STACK_HOME`、端口冲突、资源不足、checkout 内资源根、隐式 Provider 和执行授权字段；新测试 `9/9`，assurance 全套（含新 TypeScript 测试）`107/107`，`tsc -p scripts/ci/tsconfig.test.json --noEmit` 通过。该状态只关闭 F3-02 的离线前置缺口，不关闭 A13/A14 或 F3-B 真实试点准入。

### F3-B-01 Host readiness review gate

- **输入**：已捕获的 `FrameworkAssuranceEvidenceResponse`，不接受 task input、claim token、resume handle、artifact body 或 evaluation grade。
- **实施**：新增 `host-readiness.mjs` 与 `host-readiness` CLI。解析器强制 lifecycle、completion、budget、isolation、admission 五域；评估器逐个核对 lifecycle Attempt（旧恢复 Attempt 允许 `lost`）、当前 Attempt/runtime/fence/generation、请求 Run 与 projection Run 的一致性、全部 completion/budget root 的根 Run 归属、drain/settle/reusable、terminal claim、effect confirmation、完整且已确认 `applied` 的隔离 round、隔离 profile/binding、独立 admission safety plan 的存在与有效性、Tool Broker `enforce` 和预算 blocker。aggregate 与 token/cost 两个预算维度不一致、未知用量、未确认取消或非当前 fence 均 fail-closed。
- **输出**：只生成 `ready-for-trial-review` 或 `blocked` 的 JSON/Markdown review report；`executionAuthorized` 永远为 `false`。`collectHostReadiness()` 只做一次客户端读取，不触发 recovery、取消、重试、Store 初始化或派发。
- **验收**：合成 Host shape 覆盖旧 Attempt 丢失后当前 Attempt 成功、缺五域、lineage 漂移、预算维度不一致、请求 Run 不一致、缺失或未应用隔离 round、非终态 Attempt、混合根 Run、无效 admission safety plan、取消未确认和 CLI 输出；合并前后收口回归 `20/20`，framework-assurance 全套 `127/127`，`corepack pnpm typecheck:ci-tests` 和格式检查通过。
- **证据边界**：PR #690 已合并到 `main@edb820f0`；fixture 仍是 parser 和 review gate 的合成输入，不是真实 Provider、模型、生产 daemon、跨平台 packaged 或付费试点验收；F3-B 继续保持 `BLOCKED`。

### F3-03 并发对比及写入结果验收

- **输入**：F3-02、另一会话对应能力的已合并及验收证据。
- **实施**：先只读/产物型任务，再按许可增加隔离写任务。固定对比输入，分别记录任务正确性、耗时、成本及冲突/取消情况。
- **验收**：A15；写任务必须验证真实 isolated worktree、结果捕获、确定性汇合、审批应用，以及重启、取消、冲突和授权失效。
- **限制**：不能仅凭 P1 组件测试通过就运行并发写代码；不要求等待不相关模板/UI/完整图路线全部完成。

### F4-01 已有诊断的只读报告消费

- **输入**：F1 报告、既有诊断 endpoint 与客户端，不依赖 F5。
- **改动**：本计划只读适配脚本和对应测试。首轮不改诊断生产者，不新建 UI 或 endpoint。
- **实施**：正确处理冷工作区、缺 Run/lineage、分页与时间标记，关联同一身份的报告。
- **验收**：A16；读取不能创建 Store、触发 supervisor / reconcile / retry / dispatch；无敏感字段泄露。
- **本批结果**：`diagnostics.mjs` 由 `readHarnessDiagnosticsReportFromClient` 组合真实 `LingDaemonClient.getWorkUnitHarnessDiagnostics`，再逐页消费并保留页级 `observedAt`、cursor 和 checkpoint，输出 workspace 哈希并关联同一 Run/WorkUnit 的 F3 observation；冷工作区和断链状态转为脱敏报告状态。底层回调保留为纯测试边界；未改 daemon、Store、API endpoint 或 UI。

### F3-B 准入清单

Host readiness review gate 只把已捕获投影的五域完整性和跨域一致性变成可重复检查；它不把合成 fixture 或本地报告升级为真实 Host/Provider 验收。以下真实试点项目仍需逐项取得证据。

- [x] 对应源代码已经进入核实的实施基线，不只存在于 WIP 或未合并 PR。
- [ ] Host 权限与能力分类、admission 及执行代次约束有验收证据。
- [ ] 候选代码/测试所需的真实隔离执行 profile 已验收；不能在主机任意 shell 执行。
- [ ] 普通 Run 与 evaluation 的证据身份、artifact 封存及恢复已通过 fixture 回归。
- [ ] 确认停止、取消、重启和授权失效适用于本次执行类型。
- [ ] 并发写任务额外通过隔离 worktree、结果汇合、冲突和审批应用验收。
- [ ] Provider、总金额/币种、全部子调用和工具循环、grader、在途预留及超限停止均明确。
- [ ] 本次数据目录、端口、输出位置与另一会话隔离，关键资源有余量。

任一项不满足，只阻断受影响的真实执行阶段，F1/F2 可继续。F5 仅对详细设计 A17 做合同检查，不进入代码实施。

2026-11-09 的只读准入审计基于旧主线快照，结论为 `F3-B BLOCKED`；2026-11-10 的增量审计确认准入证据前置已实现；2026-11-12 的合并基线复核确认 #690 已进入 `main@edb820f0`，Host readiness review gate 已具备但真实试点仍为 `F3-B BLOCKED`。完整证据、八项核查和解阻顺序见[2026-11-12 合并基线审计](../testing/f3b-admission-audit-2026-11-12.md)，历史记录见[2026-11-10 准入审计增量](../testing/f3b-admission-audit-2026-11-10.md)和[2026-11-09 准入审计](../testing/f3b-admission-audit-2026-11-09.md)。

## 6. PR 与集成顺序

下面是建议的最小可审查批次，不代表已经创建 PR。创建、合并和发布仍分别记录状态。

| 批次 | 内容 | 必须附带 | 不混入 |
| --- | --- | --- | --- |
| D0 | 三份文档与索引 | 文档检查、边界说明 | 原六份 WIP 的再次修改 |
| E1 | F1-01 固定任务/解析 | 真实来源或明确注入、路径与摘要负例 | 真实模型执行 |
| E2 | F1-02 离线校准 | 正反与缺证据结果、零副作用证明 | 新 grader 或调度引擎 |
| E3 | F1-03 报告 | 可比性、分母、未知项与脱敏测试 | 数据库或仪表盘 |
| S1 | F2-01 真实打包与隔离 | 归档/依赖审计、仓外解析、锁摘要 | 公共接口统一 |
| S2 | F2-02 消费矩阵 | 类型/运行时正反例、每格产物摘要 | 真实 Runner 已验收声明 |
| B1 | F3-A 证据适配（fixture 范围已完成） | 来源/快照/恢复/幂等反例 | 并发实现会话在途修复 |
| B2 | F3-B 真实试点 | 准入、调用账本、真实证据链 | 默认付费 CI |
| O1 | F4 只读诊断（F4-01 已完成） | 冷工作区、权限、零执行副作用 | 节点 rerun |

```text
F0 -> 实施基线 -> E1 -> E2 -> E3 -----> B1 -> B2
                     \-> E3 草拟       ^
       实施基线 -> S1 -> S2             |
       并发会话对应能力合并/验收 --------+
                        E3 -> O1

F5: 仅合同，不进入本轮实现依赖图
```

两个并行实现者提交明确文件清单与测试结果，集成负责人核对最终实际消费的 commit / fixture / tarball，而不是仅凭各自一次通过就汇总“全部通过”。共享 CLI、CI 和文档由单人集成。

## 7. 验证命令与证据层级

### 7.1 文档检查

以下命令在仓库根目录运行，不调用模型、不构建应用：

```bash
node scripts/check-markdown-links.mjs
node scripts/check-public-repo-safety.mjs
git diff --check
```

还需检查新增未跟踪文件的空白、代码围栏与本地链接；`git diff --check` 不能独自证明新文件内容合格。原六份 WIP 用前后摘要核对，本计划只检查、不改写。

### 7.2 新工具检查与使用

以下入口已存在，在独立实施 checkout 根目录运行：

```bash
node --test scripts/framework-assurance/*.test.mjs scripts/framework-assurance/*.test.ts
corepack pnpm typecheck:ci-tests
node scripts/framework-assurance/index.mjs preflight
node scripts/framework-assurance/index.mjs host-readiness --input fixtures/framework-assurance/execution-evidence/host-ready-shape.json
corepack pnpm assurance:offline
corepack pnpm assurance:sdk
```

`preflight` 和 `host-readiness` 只读；`host-readiness` 只产生 review report，不能授予执行权限；`assurance:offline` 即 `calibrate`，输出 `calibrate.json`、`observations.json`、`report.json`、`report.md` 至新外部临时目录。`assurance:sdk` 构建/打包可信 producer，运行固定仓外消费测试，不启动 daemon。所有命令默认零模型调用。

命令 stdout 为 JSON，含本机 outputDir 与文件位置，便于本地打开；这些私有绝对路径不写入公开报告内容。重读或比较时使用 CLI 返回的观察文件路径：

```bash
node scripts/framework-assurance/index.mjs report --input /outside/observations.json
node scripts/framework-assurance/index.mjs report --input /outside/a.json --compare /outside/b.json --variable model
```

示例 `/outside/` 是输出位置占位，不是实际生成位置。各命令可指定 checkout 外的 `--output`；目录禁止落入运行数据或依赖根。已有不同内容文件不会覆盖。退出码 `0/1/2` 分别为命令成功、校准/消费验收失败、输入/环境错误；report 中的 fail 或不可比不等同于命令失败。

### 7.3 已有 SDK 回归入口

以下是主线已有脚本接口；运行记录见第 9 节，不能仅凭命令存在推断已通过：

```bash
node scripts/ci/run-packages.mjs --task=build:ci --packages='["@ling-stack/plugin-sdk","@ling-stack/contracts","@ling-stack/api-client"]' --closure=true
node scripts/ci/run-packages.mjs --task=typecheck:ci --packages='["@ling-stack/plugin-sdk","@ling-stack/contracts","@ling-stack/api-client"]'
node scripts/ci/run-packages.mjs --task=test:ci --packages='["@ling-stack/plugin-sdk","@ling-stack/contracts","@ling-stack/api-client"]'
```

`test:ci` 本身不构建；必须消费第一步同一基线的 dist。前三包的 build closure 包含 localization。它们是仓内回归，不是仓外 tarball consumer 的替代证据。

### 7.4 接入后的已有回归

证据适配涉及 Core / Daemon 时，按其实际脚本先准备同一基线构建，再最小化运行相关测试。已核查的入口包括：

```bash
corepack pnpm --filter @ling-stack/core build
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/daemon exec node --test --test-concurrency=1 test/run-evaluation-scheduler.test.mjs test/run-evaluation-storage-projection.test.mjs test/run-evaluation-task-worker-composition.test.mjs test/harness-diagnostics-api.test.mjs
```

先检查目标基线的脚本与测试隔离条件，必要时按受影响模块缩小集合。不要在仅编辑文档或仅改报告格式时机械执行全部应用测试。

### 7.5 CI 逐步接入

本分支已在 `.github/workflows/ci.yml` 接入 `framework-assurance`；当前 PR #653 的 `framework-assurance`、SDK consumer、完整 Core/Daemon、平台契约与 quality 汇总均已在 CI run 42401958832 通过。运行及产物定位见第 9 节。

- 完整非文档档位在 Ubuntu / Node `22.22.1` / pnpm `10.0.0` 运行；Draft preview 与纯文档范围继续按现有规则延后或排除，不伪装完整验证。
- 完整历史 checkout 后安装锁定依赖，运行新工具回归、离线 `calibrate` 与真实 `sdk-consumer`，不使用 secrets 或 Provider。
- Consumer 自行串行重建四包、真实 pack 并仓外离线安装，不下载/复用 `ci-dist`；缺少预置工具链直接报阻断，不临时升级或联网 fallback。
- 输出限于 `RUNNER_TEMP` 下本任务拥有的目录；上传 JSON/Markdown 报告及直属命令日志，artifact `ci-framework-assurance` 保留 7 天，不上传 consumer/toolchain/归档树。
- `quality` 明确要求 `ASSURANCE=success`；失败、取消、空结果和意外跳过均拒绝，相关契约已在本地验证。首个托管 Linux assurance/SDK 格已通过；独立 Windows 安装器结果不扩大成 Windows SDK 消费声明。
- 不改变既有可靠性基准阈值、付费回归或业务执行入口；F3-B 仍是另行授权的人工试点。

## 8. 风险与停止条件

| 发现 | 立即动作 | 可继续范围 |
| --- | --- | --- |
| 需要覆盖另一会话文件或共享 DB | 停止该改动，列出最小接口需求，重新界定拥有者 | 离线 fixture / consumer |
| 原 WIP 或根锁被意外改变 | 定位本任务改动，只恢复本任务可分离的误改，不覆盖他人新改动 | 未受影响文档与调查 |
| 产物来源不匹配 | 作废该次消费结果，从固定源码重建 | 纯格式测试 |
| 真实运行缺隔离/可信规则 | 记录 blocked，不在主机 fallback | F1/F2 与 F3 fixture |
| 费用未知、预算超限或无法确认停止 | 停止继续派发，记录在途请求，不自动重试 | 已封存结果的报告 |
| 诊断读取触发执行或泄露字段 | 停用新消费入口，按原合同修复 | 无诊断的报告 |
| 只有 mock / 单平台证据 | 保留相应标签，不扩大能力声明 | 对应范围继续补验收 |

回退首批脚本时停用新增入口即可，不需要迁移回滚；保留已封存 artifact 供复核。未来若出现必须迁移的方案，另做数据保护、恢复和拥有者评审，不能借本计划自动批准。

## 9. 交付记录与完成判定

每批实施在同一任务更新三份文档中受影响的部分，至少记录以下状态，不用一句“完成”合并它们：

| 状态 | 需要的证据 |
| --- | --- |
| 代码已实现 | 精确 commit / 文件范围，剩余项 |
| 测试已通过 | 实际命令、基线、输入/产物摘要、结果 |
| 运行已验收 | fixture / live 的层级、平台、权限与预算边界 |
| 已创建 PR | 实际 PR 与审查状态 |
| 已合并 | 合并 commit，不以批准或 CI 通过代替 |
| 已启用/发布 | 实际环境与版本；未发布时明确未发布 |

F1/F2、F3-A fixture 适配、F4-01 只读报告和 F3-B 准入证据前置是分层交付；它们不等于 F3-B 真实执行或 F5 已完成。F5 即使文档通过评审，也不能列成“支持节点重跑”。

### 本批实施记录（2026-11-02）

下表为审查前的本地实施基线；审查修复后的验证及待决项见文末“审查收口进度”，不作为提交前最终验收。

| 项目 | 已确认结果 |
| --- | --- |
| 范围 | 新 assurance 脚本、冻结 fixture、根命令、四包打包 allowlist、零模型 CI/汇总契约及相关文档；无公共 API 语义、并发调度/合并/审批/DB 变更 |
| 基线 | `d7227c83af77daf237e85845961cb54511d681f8`，独立分支 `codex/ling-framework-assurance`；提交/PR 状态单独记录 |
| 实际 F1 工具链 | macOS / arm64；当前复验 Node `22.22.1`、pnpm `10.0.0`；此前 Node `24.22.1` 为历史本地记录 |
| 实际 F2 工具链 | 当前同平台/Node/pnpm；npm `11.12.0`、TypeScript `7.0.2`、`@types/node 26.6.5`、`undici-types 8.9.0`；原生 compiler `@typescript/typescript-darwin-arm64 7.0.2`；历史 npm 为 `11.12.1` |
| 依赖预置 | `pnpm install --offline --ignore-scripts --frozen-lockfile` 仅针对 SDK 闭包和根工具，11 包复用本机离线缓存 |
| 审查前工具回归 | `node --test scripts/framework-assurance/*.test.mjs`，60/60 通过、无跳过；F1/CLI 47 项，SDK 边界 13 项；与相关 CI/历史扫描契约共 185/185 通过；下述审查修复后的结果另记 |
| F1 实际校准 | `calibrate` 成功；3 task / 9 controls，pass/fail/invalid_evidence 各 3；9 个判定均符合期望 |
| F1 报告 | requested=9、assessed=6、passed=3；这是控制判定分布，不是真实任务成功率；live requested/passed=0 |
| 隔离证据 | CLI 回归封锁网络、任务进程和 SQLite；用户 Store/普通 Run/Provider 均为零，未创建测试 runtime home |
| SDK 真实消费 | `node scripts/framework-assurance/index.mjs sdk-consumer` 返回 `passed: true` / exit 0；四包重新串行构建、四次真实 pack、一次仓外离线安装通过 |
| SDK runtime | ESM 19/19 组通过；公共导入/JSON、深导入反例、两类 manifest、registry、HTTP/cause/abort/no-retry、token 与各流入口及独立 management client |
| SDK types | NodeNext 与 Bundler 各自 strict/noEmit/不跳过声明检查，正例、缺 `resumeCapabilities` 负例及解析审计通过；各解析 317 个文件，无源码/工作区 fallback |
| SDK 既有回归 | 第 7.3 节三包 typecheck 全通过；contracts 123/123、plugin-sdk 8/8、api-client 130/130，共 261 项；使用 smoke 新构建的 dist |
| SDK 隔离 | 自建 consumer 核实归属后删除；脱敏日志、归档与报告保留在仓外；根锁摘要不变。可信工具约束不等于 OS 沙箱 |
| 文档与范围检查 | 历史本地检查覆盖 544 份 Markdown 链接及 6663 个仓库文件的公共安全扫描；当时工作区增量空白检查通过，但后续完整提交范围检查发现 T03 patch 空白上下文与 SDK consumer 文件末尾空行，不能据此声称最终空白门禁通过；修复与复验见审查收口进度 |
| 原工作区保护 | 原六份 WIP 的前后 SHA-256 一致；实施工作区根锁为下表所列摘要，未与原分支的不同锁版本互相覆盖 |
| CI 路由 | 已接入 `framework-assurance` 及 `ASSURANCE` 严格汇总；托管 Ubuntu/Node 22 结果待 PR 运行确认，本地通过不替代托管 CI |
| 额外模型复核 | 本轮未启动外部模型文档评审；文档按源码、产物与实际本地测试证据同步，不声称有外部评审结论 |
| PR / 合并 / 发布 | PR 以托管实际记录为准；未合并、未发布，未启动或重启任何业务服务 |

首次真实 smoke 的四包构建通过，但 localization 打包审计失败：`export_file_missing`，缺少 `dist/index.d.ts`。修复仅在四包 manifest 声明 `files: ["dist"]`，contracts 另包含公开 continuity JSON；没有向 consumer 补拷源码或篡改归档。首次失败报告与最终通过报告均保留。

此前 Node 24 的 F1/F2 输出目录标识分别为 `ling-framework-assurance-ysMTLG` 与 `ling-framework-assurance-sXd4hC/sdk-consumer-3GdzpW`。当前 Node 22 复验保留于 `ling-f1f2-qa.JUc2ot`，含 `offline` 的四份校准/报告文件及 `sdk/sdk-consumer-LoUiwi` 的详细报告、命令日志和归档。首次失败目录标识为 `ling-framework-sdk-artifacts-iyPmnt/sdk-consumer-WHMU7n`。这些是本地临时证据定位符，不是仓库路径或长期托管承诺；不把私有绝对路径写入公共报告。

| 本轮输入 / 产物 | SHA-256 |
| --- | --- |
| 根 `pnpm-lock.yaml`，前后不变 | `47a8c14c88f8bd07be1f210d5b8e1e56794ddeba7eb5f2a137935a06e1d6191c` |
| F2 实际 producer 输入快照 | `e73fc817699f46c3a0b7f810383caa3a8ca11effab788847438e3a39e8f860b6` |
| F2 consumer fixture | `056561c7269b980707c1395dfdaac3423307d7e2510f55357dc1d1d72f70ec2a` |
| localization `0.0.0` tarball | `3a8d6ff658c0813e68edfda1ab93c284ef59ddb4bdf0964d7a87a2dc0a47137d` |
| contracts `0.0.0` tarball | `124d6808d105943ce7936b608e972226323ca61b748c15a0de96ee02699e0dab` |
| plugin-sdk `0.0.0` tarball | `32482ba02a7d3c51e9961a9009ca0e17c89cdeb0b182e9fc18de02ab6d28f7fc` |
| api-client `0.0.0` tarball | `51eee9dec881b57329954e4abc48351435441e7b6ad7551f69723a67aa9da47c` |
| F1 `report.json` | `c835a0128768468630a5899b4f002efe09aa122d7e8316f5868cb617a1542c9d` |
| F2 CLI 保存的 `sdk-consumer.json` | `0049fe586ec0c2d24b8119dd26c4ab262b81bf510d756b8c86e5d5b786b52222` |

HEAD 只是实现基线；上述 producer 输入快照包含本次实际参与构建的未提交输入。摘要表中的报告项保留原 Node 24 记录，Node 22 复验报告独立保存，不用不同时间的报告互相覆盖。macOS 一格不扩展成 Windows/Linux、CJS、其他 Node 版本、浏览器或真实 daemon/Runner 验收；F1 控制通过也不证明 T02/T03 的真实修复任务已执行。

### 本批结束前检查

- [x] 三份文档已编写，已有设计索引加入入口。
- [x] 区分现有能力、新增计划与未来重跑合同。
- [x] 明确并发会话拥有范围，不修改其在途代码或计划。
- [x] F1 任务/引用/规则校准/报告/CLI 的正反例验证通过。
- [x] F2 真实 pack、仓外 runtime/type 检查及声明矩阵通过。
- [x] F3-A fixture 证据适配覆盖 lineage、snapshot、artifact、claim、effect 和幂等反例。
- [x] F4-01 只读诊断报告覆盖分页、冷工作区、断链、时间标记、敏感字段和零执行副作用。
- [ ] 提交前最终本地链接、公共仓库安全及完整提交范围空白检查重新通过；历史检查不替代最终验收。
- [x] 本批原六份 WIP 与实施工作区锁文件前后核对一致。
- [x] 本批没有真实任务、模型调用、发布、服务或共享数据库操作。

后续进入 F3-B 前仍须完成真实 Host 证据来源、可信隔离、预算和恢复准入；不能因为 F1/F2、F3-A 或 F4-01 通过就自动开启真实任务与付费试点。

### 审查收口进度（2026-11-02）

- 已修复并复验：缺少 TypeScript 的首次解析归入 `toolchain_missing` / `blocked` / exit `2`；任务与观察 commit、任务币种拒绝数组隐式转换。新增/扩展回归先得到三项预期失败，修复后原命令三项全部通过。Node `22.22.1` 下 assurance 工具共 61/61（F1/CLI 47、SDK 边界 14），连同相关 CI/历史扫描契约共 186/186，无跳过或取消；根锁摘要保持不变。
- 已获维护者批准并修复中断清理：此前真实 CLI 配合受控 `git` 连续两次复现 `SIGINT` / `SIGTERM` 后自有子进程和目录残留、缺少最终报告。修复限定于验收 CLI、SDK consumer、相关回归与文档；入口传播本次取消，停止自有 POSIX 进程组并等待关闭，不再启动后续命令，完成锁核对、归属清理和失败报告，再以 `130` / `143` 退出。模块导入不增加全局信号监听，不改 Core/Daemon 或其他工作区。
- 中断红绿验证：规范化 macOS 临时 fixture 的真实路径后，同一 native 命令先得到预先取消、`SIGINT`、`SIGTERM` 三项预期失败，修复后 3/3 通过。完整工具与相关 CI/历史扫描契约为 189/189（F1/CLI 47、SDK 边界 17、CI/历史 125），无跳过或取消；真实 executable 回归验证后代心跳停止、自有目录删除、根锁不变、失败报告及退出码。该 POSIX 夹具在 Windows 明确跳过，不扩写为 Windows 验收。
- 修复后的真实 SDK 消费已重跑：Node `22.22.1` 下四次串行 fresh build、四次真实 pack、仓外离线安装、ESM runtime 19/19，以及 NodeNext/Bundler 正负例与解析审计通过；两个类型格各解析 317 个文件，负例均为预期必填字段错误。producer 输入快照、consumer fixture 与根锁保持前述摘要，自有 consumer 已清理。详细报告位于本地证据标识 `ling-f1f2-qa.JUc2ot/sdk-revalidated/sdk-consumer-BlfDLS`，报告 SHA-256 为 `46e2aeb105bca56fdc04a350f557aedca5422658e3283d9c1eac09dce7bc77da`；这是 macOS 本地消费验收，不是托管 Linux 或真实 daemon/Runner 验收。
- 完整提交范围检查另发现两处必需 CI 空白失败。修复删除 SDK consumer 的多余 EOF 空行，以及 T03 patch 不必要的空白上下文，不改两处注入的增删内容。T03/task 与 suite 的版本均递增为 `2`，默认索引改为 `framework-v2.json`，依赖 SHA-256 同步更新；产品版本保持 `0.2.1`。历史 v1 结果保留，v2 校准、相关回归及整合候选验收尚未执行，不以格式修复代替行为验证。
- 修复后的静态核对通过：26 个 artifact 引用摘要一致；T03 patch 与原内容的差异严格限于移除空白上下文和调整 hunk 范围，SDK consumer 严格只少一个 EOF 换行；完整提交范围 `git diff --check 3cab8088d5bde474e990148f9c93d6c8ee422e9c` 通过，新索引另经字节级空白检查。v2 suite SHA-256 为 `7cc9b5d5ca907ded99bf9896cf09388ca1c77844eeb605c2fb55913c0f583899`；这些是静态检查，不是 v2 运行验收。
- 共享 pre-gate 的两项依赖映射与 assurance 文件选择映射已获维护者授权并应用；runner、allowlist、串行模式及测试标准未改。首次重跑已消除映射缺失，但本地 lane 因构建产物/工具前置条件缺失失败，不能记为门禁通过；随后 frozen 安装、声明的 17 包 CI 图构建、Desktop main 编译及三份插件元数据 staging 均成功，未执行完整 Desktop 打包。
- 前置条件补齐后的诊断保持原文件顺序与原时间上限：64 个 Node 文件的 10 次计划中完成 3 次，均为 2429 passed、0 failed、78 skipped；其余 7 次被总时限截断，12 个整文件跳过不计为资源/打包验收。浏览器原计划 10 次中，首次因诊断隔离目录名不符合既有断言而无效；修正目录名后，原窗口内完整完成 1 次，123/123 通过、无跳过，其余 8 次被截断。诊断进程已结束并检查清理；这些结果不替代正式 pre-gate 判定。
- 正式 pre-gate 已按原命令重跑完成：64 个 Node 文件的 native 汇总为 2429 passed、0 failed、78 skipped、0 cancelled，浏览器完整 123/123 通过；跳过的 12 个整文件仍不算资源/打包验收。整体判定为 `requires-remote (3 uncleared)`，不是门禁全绿；新增 fixture 目录与一处时间依赖断言的非阻断警告仍保留，未调整标准或新增重试。
- Linux 的 dependency-policy / framework-assurance 与 Windows installer-contracts 仍缺真实平台证据。维护者已明确授权将独立验证分支普通推送到公开仓库，并运行现有完整 Linux/macOS CI 与独立 Windows installer-contracts，取得同一候选提交的真实证据；这不授权合并、发布、部署、付费资源或真实模型调用。远端结果须以实际 job、日志和产物核实，不用本地 macOS、虚构运行地址或任意标签清除远端义务。v2 校准、完整相关回归与整合候选 SDK 消费验收仍待门禁后的既定步骤执行。
- 本次门禁选择基于当时的 `origin/main@9f0b72d028f1`，受测候选仅整合到 `3cab8088d5bd`。随后已正常合并主线 `9f0b72d028f1`，合并提交为 `2ce605a89aab`；合并前后完整快照仅 `pnpm-lock.yaml` 不同，原有待提交修改完整保留。新锁摘要为 `56fd59b33ab2fc4ab8615ad7e050c839ed14fc621096ee9c754572b7212d3d78`，按新锁 frozen 安装及完整提交范围空白检查通过；尚未运行新候选的行为复验。本段文档及锁文件变化均晚于门禁，原 receipt 不作为新候选的新鲜证据。
- 提前推送前的相关回归真实发现旧任务锁摘要与已整合锁不一致：154 passed / 2 failed，无跳过或取消；同一八文件命令的隔离诊断完成 10/10，均复现这两项失败。逐文件核对确认四个源码 pin 与新主线完全一致，只有锁摘要变化。修复不放宽校验：将三任务重新冻结到 `9f0b72d028f1` 及新锁，T01/T02 任务版本递增到 `2`、T03 到 `3`、套件到 `3`；测试使用既有 `DEFAULT_SUITE` 避免重复硬编码。规则、profile、注入内容及产品版本未变；修复后回归和校准结果单独核实。
- 本轮仍处于审查与验证候选准备阶段，未创建 PR、未合并、未发布；提前推送仅用于取得平台证据，不等于最终交付。此前本地验收保留为历史证据，不能冒充审查修复后的最终验收。

### 提前推送与平台证据（2026-11-03）

以下结果更新前述历史待验收状态，不改写旧报告。已按维护者授权普通推送 `codex/ling-framework-assurance`，首次推送的受测提交为 `0a4f5327073058f45d14b5c21940a1811d9fb6b1`；产品版本仍为 `0.2.1`，未创建 PR、未合并、未发布。两个现有 workflow 均运行此提交，未新增付费资源或真实模型任务。

| 检查 | 实际证据 | 结果与边界 |
| --- | --- | --- |
| Linux assurance | [CI job 125386311185](https://github.com/ling-stack-org/ling-stack/actions/runs/41477220526/job/125386311185) | success；工具 64/64，无失败、跳过或取消；v3 九控制全部符合期望，pass/fail/invalid_evidence 各三项 |
| Linux SDK 消费 | 同 job 的 artifact `ci-framework-assurance`，ID `13158061597`，报告 `sdk/sdk-consumer-gL9aTc/sdk-consumer-report.json` | 四包 fresh serial build、真实 pack、仓外离线安装通过；ESM 19/19，NodeNext/Bundler 正负例及各 317 文件解析审计通过 |
| Linux 依赖策略 | [CI job 125386311294](https://github.com/ling-stack-org/ling-stack/actions/runs/41477220526/job/125386311294) | success；四批测试 3+21+2+24，共 50/50；许可证检查覆盖 1252 个依赖版本 |
| Windows 安装器 | [run 41477222513](https://github.com/ling-stack-org/ling-stack/actions/runs/41477222513) / job `125385880795` | completed/success；native NSIS 6/6，无失败、跳过或取消；不构成 Windows SDK 或 GUI 验收 |
| 提前推送候选本地 pre-gate | 2026-11-02T16:15:00.087Z 生成，受测 tree `22ae9bb45cee06a40f385cd23f21292a1c891f8f` | 64 个 Node 文件全部 exit 0：2507 tests、2429 passed、78 skipped、0 failed/cancelled；浏览器 123 passed。跳过项不算资源/打包验收；保留 `requires-remote (3 uncleared)`，未登记远端 clearance |
| 完整 CI | [run 41477220526](https://github.com/ling-stack-org/ling-stack/actions/runs/41477220526) | 已 completed/failure；Common checks 与 [Daemon shard 3](https://github.com/ling-stack-org/ling-stack/actions/runs/41477220526/job/125387958512) 失败，Daemon shard 0 取消、1/2 成功，macOS helper smoke 成功。不是全绿或最终验收 |

Linux SDK 实际工具链为 Linux x64、Node `22.22.1`、npm `10.9.4`、pnpm `10.0.0`、TypeScript `7.0.2`、`@types/node 26.6.5`、`undici-types 8.9.0` 及原生 `@typescript/typescript-linux-x64 7.0.2`。251 个 producer 输入的前后 SHA-256 均为 `2b7f362bebfe7a860e54e976b260fedabf77d41892dcd6b6895abeb9002a839a`，consumer fixture 为 `056561c7269b980707c1395dfdaac3423307d7e2510f55357dc1d1d72f70ec2a`，根锁前后均为 `56fd59b33ab2fc4ab8615ad7e050c839ed14fc621096ee9c754572b7212d3d78`。报告核实无源码/工作区 fallback，自有 consumer 已清理；运行时仍是 mock transport，不等于真实 daemon/Runner、网络、权限或 GUI 验收。

托管离线校准使用 suite `3`，套件字节摘要为 `e27693c5e5e89e07845fc759dffcd5c85483fd672dda6c5066bcd5d28064013b`；Provider 调用、普通 Run 派发、用户 Store 初始化均为零，`taskCodeExecuted=false`。提前推送前的相关回归已在修复锁 pin 后通过 189/189，不能将此前的 154/2 失败删除或改记为成功。

Common checks 的失败已定位到全历史 Gitleaks：1438 个提交、383387440 字节中产生 131 条 `generic-api-key` 命中，去重为 106 个精确 fingerprint，全部来自已在整合主线中的 `1047b00500ec478c5bf4594f25a97e73b8dd34a3`。逐条复核为源码/Node 头文件的 SHA-256 记录；五份命中文件与原已审核提交的 Git blob 完全相同，旧 `.gitleaksignore` 的文件/规则/行号也全部对应。根因是 squash 后提交号变化，原 commit-scoped 指纹未覆盖新提交，不是本次引入凭据。本地 Gitleaks `8.30.1` 只读扫描复现同样命中，但不宣称与远端容器版本等同。

维护者于 2026-11-03 批准并已补齐这 106 条精确历史指纹；原名单 257 条记录及原文件字节前缀完整保留，不删除旧条目、不增加宽路径或规则排除。扫描配置、CI、扫描器及其测试均未改。以相同 `--full-history --diff-merges=first-parent 0a4f5327073058f45d14b5c21940a1811d9fb6b1` 范围复验，本地 Gitleaks `8.30.1` 退出 0，仍覆盖 1438 个提交和 383387440 字节，报告零命中；扫描契约测试 22/22 通过，无失败、跳过或取消。原失败报告保留；这是精确名单修复的本地证据，不是旧远端 Common job 改判通过，也不替代修复后的远端验证。

精确名单补齐已单独提交为 `7ff94e88`，四份文档同步已提交为 `48022dc3` 并推送。native boundary 修复及其回归在此之后加入；前述 receipt 仍保留其真实输入，不自动重绑定为新鲜通过。后续仍须完成修复候选的远端门禁、既定审查、文档审计、最终冻结验证及 PR；F3/F4/F5、合并、发布和部署均未启动。

### 失败诊断与新增阻断（2026-11-03）

- 原 Daemon shard 3 的 150 个文件全部完成，149 个通过、1 个失败。失败在 `protected-host-staging.test.mjs` 的 history-budget 场景：内部子进程超过既有 90 秒上限，未确认具体停在哪次迭代。相关静态输入与整合基线相同，不足以证明动态故障早已存在。查阅的主线历史找到两个同名通过样本，未找到同样超时；这不是完整失败分布或根因证据。
- 原文件集合、每 worker 顺序与并发不变的追加诊断，计划 10 轮、共用 600000ms 总上限，retry 关闭，独立 HOME/TMP/状态且无模型凭据。最终 0/10 轮完整完成：仅首轮启动，完成 89/150 文件，文件状态为 87 passed、2 failed、61 cancelled；完整文件的 native 汇总为 1367 tests、1359 passed、6 failed、2 skipped。目标 history-budget 文件尚未执行，其余九轮未启动；不把截断计为完整失败率或通过率，不重置预算重跑。
- 6 项新失败集中在私有状态隔离。独立最小合成探针确认的 macOS 原生权限边界缺陷已在本分支修复；修复采用 canonical workspace literal 与固定私有状态组件匹配，未改变其他 allow/deny、CI 门槛或上游调用契约。真实 macOS native boundary 回归 22/22、相关 Kimi/relay 回归 65/65 通过；未读取真实用户数据，Linux/Windows 与远端完整 CI 仍待重跑。
- 另一会话的 [PR #643](https://github.com/ling-stack-org/ling-stack/pull/643) 正在处理原 history-budget 场景。已查快照中尚未合并、其新候选 Daemon 验证未结束；本分支未复制、cherry-pick 或合并该修改，也不把其他候选的通过记录用作本分支验收。

完整 CI 的历史最终状态已于 `2026-11-02T17:31:25Z` 附近查询确认，run 的 `updatedAt` 为 `2026-11-02T17:24:28Z`；Daemon shard 0 的取消原因尚未确认。native boundary 修复后的新候选尚未取得远端完整 CI 结果，未穿过门禁继续发布步骤。

### Native boundary 修复（2026-11-08）

- 修改 `packages/daemon/src/runtime/sandbox/native-process-launch.ts`：私有 workspace 状态 deny 规则使用 canonical workspace 的 SBPL literal bound，并将私有目录组件匹配保持为固定规则，避免动态路径参与二次正则序列化。其他 workspace、operation、home、external grant、network、metadata 和进程生命周期规则保持原契约。
- 新增 `packages/daemon/test/native-process-boundary.test.mjs` 回归，覆盖特殊字符 workspace 路径、合法 public read/write、嵌套私有目录和 symlink alias。旧实现先出现该回归预期失败，修复后真实 macOS 22/22 通过。
- 相关 Kimi 安装/执行与 model relay 回归合计 65/65 通过；Daemon `build:ci` 通过，保留现有 Rust compiler warning。该证据只覆盖当前 macOS，不能替代 Linux/Windows 或远端完整 CI。
- 合入最新 `main@8435a43e` 后，主线锁摘要由历史 v3 的 `56fd59b33ab2fc4ab8615ad7e050c839ed14fc621096ee9c754572b7212d3d78` 更新为 `167eb55b8ed43c0b58a363005b867069d1ddcd659b36408d95ddbb227338b543`；为保持 source pin 与工作树一致，新增默认 v4 校准套件 `framework-v4.json`，T01/T02/T03 版本为 `3/3/4`。历史 v3 套件字节摘要 `e27693c5e5e89e07845fc759dffcd5c85483fd672dda6c5066bcd5d28064013b` 保留为历史输入，v4 摘要为 `cd22fb7efda7585107a39b4bda195bcaf058be1a37e6e9416afd1da9bc8fab04`。合并后的 CI policy、workflow 和 assurance 回归为 162/162 通过；这是本地新鲜验证，不替代当前 PR 的 hosted CI。

### PR #653 合并前收口记录（2026-11-08）

| 项目 | 已确认结果 |
| --- | --- |
| 代码提交 | F1/F2 实现提交 `3c7b905be010fa0da37780da6e5288dbff760cd1`，分支 `codex/ling-framework-assurance`；本次文档同步继续附加在同一 PR |
| PR | [#653](https://github.com/ling-stack-org/ling-stack/pull/653)，已创建并承载实现及文档同步；未合并、未发布、未部署 |
| Hosted CI | [run 42401958832](https://github.com/ling-stack-org/ling-stack/actions/runs/42401958832) completed/success；assurance、SDK consumer、依赖策略、构建、类型检查、四个 Core shard、四个 Daemon shard、Linux restricted-command、macOS helper/Seatbelt、quality 与 timing telemetry 全部通过 |
| 时间相关重跑 | Core shard 2 首次因主线 `run-compaction-suspension.test.mjs` 的 `artifact_retention_deadline_in_past` 失败；同一 run 的 [重跑 job](https://github.com/ling-stack-org/ling-stack/actions/runs/42401958832/job/128498297153) 33/33 通过。该测试文件和 retention store 未被本分支修改，未将无关修复混入 PR |
| 本地相关验证 | 合并最新主线后 assurance、CI policy、workflow 与相关回归 162/162 通过；F1/F2 工具及真实 SDK consumer 的 macOS 复验、Linux hosted consumer 与完整当前 PR 门禁均有独立证据 |
| 运行边界 | 未运行真实模型、Provider、普通 Run 或付费任务；未启动/重启服务，未修改共享数据库或另一会话 worktree |

合并前 F1/F2 交付条件已满足：代码、离线校准、仓外真实 SDK consumer、零模型 CI 门禁、文档和 PR 均有证据。随后 PR #653 以 `47afcc47` 合并；本节保留合并前证据，不覆盖下方 F3-A/F4-01 当前批次。

### 最新主线锁更新与 v5 冻结（2026-11-09）

- 合并 `origin/main@c156901c6c0bb97570ba56f39ec0f731872f56d9` 后，原 v4 预检的两项失败均定位为 `pnpm-lock.yaml` 字节摘要失配；T01/T02/T03 的源码文件摘要仍与冻结来源一致。未放宽校验，也未修改规则、profile、注入补丁或控制输入。
- 依赖锁当前摘要为 `49c509936672cbe4ce9118a4bf3907c4b32eea1babfc6dd74dec295c526f4d10`。三任务来源更新到该完整提交，任务版本递增为 `4/4/5`，套件递增为 `5`；v4 文件保留为历史输入，默认套件改为 `framework-v5.json`。v5 套件字节摘要为 `69129d529f41cdad17e9da1a706c4a1f7d3f00b7c4d8b59d11268faaf329a303`。
- v5 修复后，framework-assurance、CI policy、workflow、平台 lane 与 SDK 边界相关回归共 `179/179` 通过；直接执行 `preflight` 与 `calibrate` 均成功。输出目录仍在 checkout 外，未初始化用户 Store、派发普通 Run、调用 Provider 或运行真实模型/付费任务。

### F3-A / F4-01 当前批次（2026-11-09）

| 项目 | 已确认结果 |
| --- | --- |
| 实施工作区 | `codex/ling-f3-f4-readonly`，基于合并后的 `origin/main@47afcc47b9063cd7a402a81cf1088caa695f3638`；另一会话 worktree 未修改 |
| F3-A 代码 | `scripts/framework-assurance/execution-evidence.mjs`；独立 trusted binding、Run/WorkUnit/Attempt/fence lineage、snapshot、artifact digest、terminal claim 和 effect 校验；输出保留 `fixture_replay` / `not_assessed` |
| F3-A fixture | `fixtures/framework-assurance/execution-evidence/valid.json`、`trusted-binding.json` |
| F3-A 回归 | `execution-evidence.test.mjs` 覆盖兄弟 Run、旧 Attempt、快照变化、artifact 缺失/错误/多余、claim 丢失、未知副作用、重复适配；对应测试全通过 |
| F4-01 代码 | `scripts/framework-assurance/diagnostics.mjs`；通过既有 `getWorkUnitHarnessDiagnostics` 回调逐页读取，保留 cursor/页级时间/checkpoint，按同一 Run/WorkUnit 关联 observation |
| F4-01 回归 | `diagnostics.test.mjs` 覆盖分页、冷工作区、run_unlinked/run_missing/lineage_mismatch、重复页、停滞 cursor、错误 lineage、敏感字段和零 Store/重试/派发路径 |
| 本批测试 | `node --test scripts/framework-assurance/execution-evidence.test.mjs scripts/framework-assurance/diagnostics.test.mjs`：30/30 通过 |
| assurance 全套 | `node --test scripts/framework-assurance/*.test.mjs`：94/94 通过；`preflight` 与 `calibrate` 成功；本地缺失 `tar` 时临时复用既有只读 node_modules 后重跑，链接已清理 |
| 运行边界 | 未启动真实 Run、Provider、模型、付费任务、daemon 或 Store；未修改 F3-B/F5、daemon、SQLite、API endpoint、UI 或另一会话 worktree |
| 当前未完成 | F3-B 真实串行/并发执行证据、F5 节点重跑实现仍未启动；本批不创建 rerun API 或生产执行接线 |

### F4-01 客户端组合收口（2026-11-10）

| 项目 | 已确认结果 |
| --- | --- |
| 组合入口 | `readHarnessDiagnosticsReportFromClient` 将 `LingDaemonClient.getWorkUnitHarnessDiagnostics` 接入既有只读分页报告适配器 |
| 真实客户端回归 | `packages/api-client/test/harness-diagnostics.test.mjs` 使用真实 `LingDaemonClient`，验证 GET、cwd/WorkUnit scope、分页参数、无 body 和不携带 Computer Use token |
| 生产范围 | 未改 daemon、Store、诊断 endpoint、数据库、UI 或执行入口；未启动真实 Run、Provider、模型或付费任务 |

### F3-B 准入证据前置增量（2026-11-10）

| 项目 | 已确认结果 |
| --- | --- |
| 实施基线 | PR #676 已合并到 `5990095f`，候选 `90bca175` 的托管门禁、审查和合并后受控回归均已通过；PR #685 已合并到 `origin/main@df5c03df`，补齐零 delegation step 时根预算和 Provider charge 的只读投影 |
| Daemon 只读入口 | `GET /runs/:id/assurance-evidence`；只读取已初始化 Store，不创建 Store、不触发 recovery、不派发 Run |
| 证据内容 | Run/WorkUnit/Attempt/fence、snapshot/artifact digest、生命周期停止、delegation completion、预算 reservation/charge、isolated binding、integration round、effect/receipt、branch result、candidate、approval、apply 和 fail-closed admission |
| 准入归属门禁 | Run、WorkUnit、当前 Attempt 仅接受 succeeded/failed/cancelled 且当前 claim 为 terminal_retained；lost claim 固定 expired，聚合停止完成不能替代当前执行归属 |
| 根 Run 预算适用性 | 无子代理时仍投影既有根预算和 Provider charge，保留 pending/unknown/over/missing 与原始 issue；子任务、根预算、根 charge 和读取问题均不存在时才返回 not_applicable。Node 22 预算回归 17/17、六文件证据回归 96/96；修复前确定复现 11 项失败，含真实 SQLite/Host writer→HTTP 的 root reservation。限定修改只读投影，不更改计费、调度或数据库 |
| 客户端接入 | `collectLiveExecutionEvidence()` 通过 `LingDaemonClient` 读取投影，与冻结任务输入关联；结果为 `live_execution` / `not_assessed`，不自动判 pass |
| 候选结果归属 | candidate 分支摘要与全部参与者结果按数量精确匹配，保留重复次数、不依赖顺序、不修改输入；缺失、多余、未封存或空集合均阻断 |
| 相关回归 | PR #676 合并基线 framework-assurance 全套 98/98、Daemon 证据/API/隔离/预算/准入/解析回归 84/84；跟进分支 Node 22 根预算矩阵 17/17、六文件证据回归 96/96，含真实 SQLite Host writer→HTTP root reservation、pending/unknown/over/missing 与普通空 Run `not_applicable`；修复前确定复现 11 项失败；API client 全套 139/139；Contracts/API client/Daemon 构建与类型检查通过 |
| 冲突恢复夹具 | 手工 Host 回调在审批消费期间持有既有 post-commit owner claim，原回调成功且 owner 证据验证后才结算；强制后台扫描的 TypeScript 回归先复现 `tool.stale_attempt`，修正后与原七项冲突恢复回归共 8/8 通过，平台登记/CI 合同 29/29 通过 |
| 隔离交付同步 | SDK/Host 交付夹具先等待既有 isolation lifecycle drain，再等待后台生成 merge approval；保留原超时与全部审批、产物、单次 apply 和重开只读断言。交付端到端及生命周期回归 13/13 通过 |
| 锁屏时间边界 | 部分 heartbeat 间隔内解锁的 HTTP 回归使用受控 monotonic 时钟和原生 MockTimers，等待真实 gate/runner 边界；保持 80ms hard budget、60ms 锁屏和 50ms runner。Node 22 的锁屏与 supervision 回归 10/10，错误计入锁屏时间的临时反例确定失败，CI 平台/工作流合同 22/22 |
| 运行边界 | 只运行临时 SQLite/Git/HTTP fixture；未启动真实 Provider、模型、生产 daemon 或付费任务，不开放普通 workflow 写并发 |
| 当前未完成 | 真实 Provider/评测验收、生产 daemon 重启与权限撤销、packaged/跨平台和独立资源预算；Run/evaluation 只读关联另见后续增量，F3-B 真实试点保持 BLOCKED |

### F4 Host 观察关联（2026-11-11）

| 项目 | 已确认结果 |
| --- | --- |
| 实施分支 | PR #684，`codex/ling-evaluation-association`；已整合 #676 的实际主线合并提交 `5990095f` |
| 显式适配 | `adaptLiveExecutionEvidenceForDiagnostics()` 校验 collector 的 Host source 与 observation 一致性，输出 F4 严格三字段输入，保留 `not_assessed` |
| 行为回归 | 新 TypeScript 回归覆盖真实 collector 到 F4 报告的组合、四项执行身份、时间、状态、环境、artifact、限制、字段 allowlist 和对象隔离；与既有 execution/diagnostics 回归共 56/56 通过 |
| 类型与 CI | Daemon `typecheck:ci` 通过；新回归登记 Linux lane，平台与 workflow 合同 38/38 通过 |
| 证据边界 | 只使用内存客户端响应；未读取共享 Store，未发起真实 Run、Provider、模型或付费任务；完整 evaluation 关联及 F3-B 真实验收仍未完成 |

### Run/evaluation 只读关联（2026-11-11）

| 项目 | 已确认结果 |
| --- | --- |
| 实施分支 | PR #684，`codex/ling-evaluation-association`；已合并到实际主线 `9af7ad54`，保留完整独立增量 |
| 核心投影 | 指定 evaluation ID、16 字段冻结 identity/key、候选与可选 grade pins；独立验证六份原始输入、三组 Host snapshot、Run/root、封存 artifact owner/字节和 grade 摘要，首尾重读拒绝漂移 |
| Host 组合 | 只查已初始化 Store，所有读取在同步只读 snapshot 内；冷工作区不初始化，已提交观察不能代替独立 Host 读取 |
| Daemon/API 接线 | `POST /runs/:id/assurance-evaluation-association?cwd=...` 接收完整 request 和六份 Base64 冻结输入；`LingDaemonClient.projectRunAssuranceEvaluationAssociation()` 复用同一只读投影，URL Run ID 与 request lineage 一致性由 Daemon 校验 |
| 行为证据 | 新增 association、SQLite composition 和 F4 接线 TypeScript 回归共 85/85；涵盖无写入、快照中拒绝写入、冷 Store、读取漂移、grade 四种 verdict、摘要分域、Run 状态合同、敏感字段和失败不发布部分结果 |
| 集成验证 | 合并后 Node 22 Daemon assurance 相关回归 182/182、API client 7/7、离线 assurance 98/98；Contracts/API client/Daemon 构建和 Daemon 源码/测试类型检查通过；托管门禁最终 30 项成功 |
| 权限边界 | 固定 `not_assessed` / `enforcementAuthorized:false`；Attempt/artifact 归属始终 unavailable，不将 caller mapping 或 grade pass 当真实执行验收 |
| 尚待完成 | 真实 Producer/计费、Attempt 产物归属、packaged/跨平台和受控试点验收继续独立保留；F3-B 仍 BLOCKED |

### F3-02 试点前置预检（2026-11-12）

| 项目 | 已确认结果 |
| --- | --- |
| 代码 | `scripts/framework-assurance/trial-preflight.mjs` 增加严格 trial manifest 解析、冻结 T01 输入核对、外置资源与端口预检、容量检查和脱敏 JSON/Markdown 报告；`index.mjs` 增加 `trial-preflight` 子命令 |
| 冻结输入 | `fixtures/framework-assurance/trials/t01-review.json` 固定 suite/task/source、七组输入摘要、review-only Provider/model 标识、金额/币种、Provider 请求/token/工具循环/子代理/grader/在途 reservation 上限和 fail-closed 停止规则 |
| 资源边界 | 只接受 checkout 外的绝对 resource root；逐级拒绝符号链接和文件冲突，已有目录必须为空，三类目录不可重叠；`LING_STACK_HOME` 必须与计划路径一致；daemon/UI 只能是不同 loopback 端口 |
| 余量检查 | 读取 `availableParallelism`、free memory、free disk 和 load-1；资源根缺失、测量失败、端口占用或低于最低值均为 `blocked` |
| 授权边界 | `ready-for-review` 仍固定 `executionAuthorized=false`，Provider/模型/Run/Store/daemon/任务调用计数为零；端口探针绑定后立即释放，执行前必须再次检查 |
| 回归 | `node --test scripts/framework-assurance/*.test.mjs scripts/framework-assurance/*.test.ts`：107/107；新边界测试 9/9；`corepack pnpm exec tsc -p scripts/ci/tsconfig.test.json --noEmit` 通过；CI assurance lane 已纳入 TypeScript 测试发现 |
| 尚待完成 | 真实 Host lifecycle、Provider/evaluation/费用账本、重启/取消/授权撤销、跨平台 packaged 和 A13/A14 试点验收仍未完成；F3-B 继续 BLOCKED |

### F3-B Host readiness review gate（2026-11-12，PR #690 已合并）

| 项目 | 已确认结果 |
| --- | --- |
| 合并结果 | PR #690，候选 head `23af3c4a`，实际 merge commit `edb820f0`；已进入 `main` |
| 代码 | `scripts/framework-assurance/host-readiness.mjs` 提供五域解析、跨域 lineage 校验、fail-closed review assessment、一次性只读 client collection 和脱敏 JSON/Markdown；`index.mjs` 增加 `host-readiness` 子命令 |
| fixture | `fixtures/framework-assurance/execution-evidence/host-ready-shape.json` 展示旧 Attempt 丢失、当前 Attempt 成功、隔离 apply、预算 charge 和 admission projection；只用于合成 parser/review gate 验收 |
| 回归 | `host-readiness.test.ts`：20/20；全套 `node --test scripts/framework-assurance/*.test.mjs scripts/framework-assurance/*.test.ts`：127/127；`corepack pnpm typecheck:ci-tests` 与 `git diff --check` 通过 |
| 授权边界 | `ready-for-trial-review` 和 `blocked` 都固定 `executionAuthorized=false`；未启动 Provider、模型、付费任务、生产 daemon、Store 或共享数据库 |
| 未完成 | 真实 Host/Provider/evaluation/费用账本、重启/取消/权限撤销、跨平台 packaged 和 A13/A14 仍缺真实验收，F3-B 保持 BLOCKED |
