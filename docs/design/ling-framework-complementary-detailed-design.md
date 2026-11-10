# Ling 框架补强详细设计

Status: F1/F2 merged in PR #653 (`47afcc47`); F3-A fixture evidence adapter and F4-01 read-only diagnostics report implemented on an independent branch; F3-B live execution and F5 rerun remain design contracts
Owner: Ling framework maintainers; evaluation and SDK implementation owners
Last verified: 2026-11-09
Document type: reference / technical design
Canonical replacement: none; does not replace existing evaluation, runtime, or API contracts
Code and test anchors: section 12 and the implementation record; offline, fixture evidence, and read-only diagnostics acceptance only

上层边界见[总体设计](ling-framework-complementary-design.md)，执行顺序见[实现计划书](ling-framework-complementary-implementation-plan.md)。

## 1. 合同层级

本文区分四类内容：

- **现有合同**：已在核查基线中存在的函数、字段与行为。
- **已实现私有格式**：F1 task/suite、offline observation 与报告、F2 consumer 报告、F3-A fixture 执行证据与 F4-01 只读诊断报告，只用于本工具链；不是新增 daemon 公共 API。
- **拟新增接入合同**：F3-B 真实执行证据接线与 F5 节点重跑，尚无运行实现。
- **未来约束**：节点级重跑的设计要求，没有授权本轮修改执行链路。

所有新格式采用 `schemaVersion: 1`。F1、F3-A 和 F4-01 由显式解析器拒绝未知 schema、未知字段和不合法枚举；F3-B/F5 接入遵循相同原则。F3-A/F4-01 格式是本工具链私有报告，不是新增 daemon DTO。

首批不新增持久化表、不更改 Run/Attempt 状态机，不把任务元数据塞进已有规则 case。

## 2. 目录与命令

```text
scripts/framework-assurance/
  index.mjs                # CLI 参数与模式路由
  manifest.mjs             # 新任务格式、路径与摘要验证
  preflight.mjs            # 纯离线预检与校准编排
  grader.mjs               # 源码加载两个既有 Core 纯函数模块
  evidence.mjs             # 离线观察格式
  execution-evidence.mjs   # F3-A fixture 证据与可信绑定适配
  diagnostics.mjs          # F4-01 只读诊断分页报告
  report.mjs               # JSON/Markdown 报告与可比性检查
  output.mjs               # 外部目录校验与不覆盖式原子发布
  sdk-consumer.mjs         # producer 产物审计、仓外消费
  *.test.mjs               # 对应模块的边界与回归测试
fixtures/framework-assurance/
  suites/                  # 冻结任务索引
  cases/                   # task metadata 与独立规则 case
  controls/                # 已知正确、错误、缺证据的合成输入
  sdk-consumer/            # 仓外消费者模板；不是 workspace 包
  execution-evidence/      # F3-A 的 Run/WorkUnit/Attempt fixture
```

F1/F2 路径均已实现，F2 经统一 CLI 入口调用独立 consumer 模块。没有为了脚本便利新增 Core 公共出口或复制 grader。输出默认写入新临时根，显式 `--output` 必须在实施 checkout 外，并在创建目录前检查词法路径与最近已存在祖先的真实位置，拒绝 `.git`、`.ling-stack`、`node_modules` 及符号链接解析后落入上述位置的目录。不提交真实日志、用户数据库、tarball 或模型输出。

| 子命令 | 输入 / 输出 | 允许做什么 | 禁止做什么 |
| --- | --- | --- | --- |
| `preflight` | suite 路径 / 预检 JSON | 解析、摘要、路径、引用与工具链声明检查 | 派发 Run、执行任务命令、创建 Store |
| `calibrate` | 已预检 suite / 校准 JSON | 通过已有确定性 grader 检验合成正反控制 | 执行候选代码、调用 Provider |
| `report` | 已验证的观察文件 / JSON 与 Markdown | 校验来源、汇总、比较与脱敏 | 自动补跑失败任务、猜测缺失费用 |
| `sdk-consumer` | 当前 producer 输入 / 消费报告 | 在实施工作区串行构建，在隔离临时目录打包、安装本地包、运行固定测试 | 根目录安装、源码 fallback、启动真实 daemon |

CLI 入口为 `node scripts/framework-assurance/index.mjs <command>`。`preflight/calibrate` 接受 `--suite`（相对 fixture 根）；`report` 必须指定 `--input`，可加 `--compare` 和唯一变量 `--variable model|executionStrategy`；各命令可用 `--output`。根脚本有 `assurance:offline`、`assurance:sdk`、`test:assurance`。F3 不得在这里增加绕过 Host 的 `run-shell` 或隐式付费模式。

退出码：`0` 表示本命令成功，`1` 表示校准或消费验收失败，`2` 表示输入、环境或前置条件不满足。`report` 成功生成含失败或不可比样本的报告仍返回 `0`；报告生成成功与被测对象成功分开。离线进程测试封锁网络、任务子进程和 SQLite 加载，仅允许读取源码的 `git cat-file blob`。

SDK 未预置 TypeScript 时返回 `toolchain_missing` / `blocked` / exit `2`，不进入构建；仍记录锁文件核对及工具自有临时目录清理结果。这是环境阻断，不是 SDK 的验收失败。

## 3. 固定任务与 Artifact

### 3.1 引用与身份

已实现 `ArtifactRefV1`：

| 字段 | 类型 / 要求 |
| --- | --- |
| `path` | 相对可信 fixture 根的文件路径；拒绝绝对路径、越界、链接逃逸和网络 URL |
| `sha256` | 文件原始字节 SHA-256，64 位小写十六进制 |
| `mediaType` | 明确的 JSON、文本或补丁类型；不是自动执行指令 |

已实现 `TaskSuiteV1`：

| 字段 | 类型 / 要求 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `suiteId` / `suiteVersion` | 非空稳定标识 / 显式版本；改变任务或规则必须升版本 |
| `description` | 任务集目的，不作为判定规则 |
| `tasks` | 1 至 100 个 `{ taskId, taskVersion, task }`；`task` 为 metadata 的 artifact 引用；身份不重复 |

已实现 `TaskSpecV1`：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` / `taskId` / `taskVersion` | 固定 schema；与 suite 引用完全一致 |
| `category` | `analysis_readonly`、`single_module_fix`、`two_module_change` 三种首轮任务类别；不是执行权限分类 |
| `source` | `{ repository: "ling-stack", commit, lockSha256, files }`；完整本地 commit SHA、冻结来源锁摘要及 1 至 20 个文件引用，不任意克隆 URL |
| `provenance` | `{ kind, description, anchors, injection }`；`source_analysis / real_regression / fault_injection`。注入必须有补丁引用，其余为 null；不把只读源码分析假称历史回归 |
| `prompt` | 固定任务说明的 artifact 引用，不从当前会话临时拼接 |
| `validationProfile` | 经维护者审核的验证 profile 标识、版本与摘要；由可信运行配置解析，不采信候选代码中的同名配置 |
| `ruleCase` | 独立的现有 `DeterministicRunEvaluationCaseV1` JSON 引用 |
| `expected` | 可信预期 JSON artifact 引用；与候选输出严格分开 |
| `controls` | 正确、错误和缺证据三个控制样本；声明期望判定，不使用付费模型 |
| `environment` | `{ node, pnpm, typescript, platform }` 声明；校准另记录实际 Node/OS/架构，不把声明视为实际执行验证 |
| `capabilityRequirements` | 执行所需能力，由 Host 决定是否允许；不是授权本身 |
| `requiredEvidence` | 必须出现的测试/差异/执行身份等证据类型 |
| `limits` | 时间、并发、请求及金额边界；币种明确，未知费用处理明确 |

首版解析上限：单个文件为 1 MiB、JSON 深度 64、任务数最多 100；仅允许可移植 ASCII 相对路径。这是离线工具的保护值，不是既有运行时能力上限；超限直接报错，不静默截断。`limits` 当前是冻结元数据，不授权执行；首个 suite 请求/金额上限均为零，F3 才实现真实执行预算。

`source.commit`、观察中的 `sourceCommit` 与 `limits.currency` 必须是字符串；即使单元素数组可隐式转换为合法 SHA 或币种文本，也必须以 `invalid_manifest` 拒绝，不能带入身份比较或费用报告。

### 3.2 规则 case 与摘要不能混用

现有规则 case 的顶层是闭合格式：

```text
schemaVersion: 1
kind: deterministic_json_rule
graderId, graderVersion, failureSeverity
assertions
```

现有断言支持 `deep_equal`、`contains`、`exists`、`number_range`，数量 1 至 100。`contains` 对数组的行为不是无序集合包含，写规则时必须按当前实现校准。不能增加 `taskId`、`sourceRunId` 或自定义执行代码到规则 JSON；这些信息放在独立 metadata / evidence 中。

| 摘要 | 输入 | 用途 |
| --- | --- | --- |
| Artifact 字节摘要 | 实际封存文件字节 | 验证文件未替换，包括空格变化 |
| 现有 `digestRunEvaluationValue` | canonical JSON 值，递归键排序 | 值级幂等与评测身份；JSON 格式变化可不改变结果 |
| 源码快照摘要 | 实际参与构建的源码和必要未跟踪输入 | 证明使用了哪些输入，不仅是 HEAD |
| 构建 / tarball 摘要 | 实际 dist 或归档字节 | 证明验证了哪个产物 |

这些摘要分别命名、分别保存。不得把值摘要填进 artifact 字节摘要字段。规则 grader 的 JSON 约束沿用原实现，包括有限数字、普通 JSON 值、无循环及最大深度 64。

### 3.3 首轮固定任务

| 任务 | 已冻结来源与控制 | 仍未完成的真实执行验证 |
| --- | --- | --- |
| T01 只读定位 | `evaluation-rule-grader.ts` 的 contains 数组前缀语义；错误控制把它当无序集合 | 正常 Run 的只读定位答案与可信位置验证 |
| T02 单模块修复 | `evaluation-json.ts` 明确注入删除 `.sort()`；正确/错误/缺证据 JSON | 注入后的代码行为失败、真实修复通过、错误修复失败 |
| T03 两模块修改 | 明确注入 diagnostics schema 变为 2、api-client 丢 cwd；单侧修复的两个负例均不通过 grader | 隔离环境中的两侧真实类型/行为验证与完整修复 |

三任务最初冻结到 `d7227c83af77daf237e85845961cb54511d681f8`，历史 v3 校准套件冻结到已整合的主线 `9f0b72d028f1ca6a966f997125374ffc19ea6a54`；当前 v4 套件随最新主线 `8435a43e5ca610f2d0026c9e8b3947e5d25b3ab0` 重新冻结。锁、源码、prompt、profile、规则和控制均有字节摘要。两个 patch 仅执行 `git apply --check`，不应用。F1 交付的是可运行的**校准任务集**，不是已验收的真实修复 benchmark。profile 为 `offline_control_only`，checks 是受控说明而非任意可执行命令。真实基线失败/修复成功的代码验收保留给 F3。

审查期间，为通过完整提交范围的空白检查，T03 patch 删除了一个不必要的空白上下文行；schema 与 cwd 的注入改动不变，T03 和 suite 曾递增到 `2`。随后整合主线锁更新，旧锁摘要在真实预检中被正确拒绝；历史 v3 将三任务源码基线和锁摘要一起冻结，当前 v4 再次跟随最新主线锁更新，T01/T02 `taskVersion` 为 `3`、T03 为 `4`，`suiteVersion` 为 `4`，默认索引为 `suites/framework-v4.json`。v4 套件字节摘要为 `cd22fb7efda7585107a39b4bda195bcaf058be1a37e6e9416afd1da9bc8fab04`。源码文件、注入内容、schema、规则和 profile 未变；历史报告和 v3 套件不改写，也不作为 v4 验收证据。

最新主线再次只改变了依赖锁：`main@c156901c6c0bb97570ba56f39ec0f731872f56d9` 的 `pnpm-lock.yaml` 摘要为 `49c509936672cbe4ce9118a4bf3907c4b32eea1babfc6dd74dec295c526f4d10`，四个源码 pin 与 v4 保持一致。按版本规则保留 v4，并生成当前默认的 v5：T01/T02/T03 任务版本为 `4/4/5`，`suiteVersion` 为 `5`，默认索引为 `suites/framework-v5.json`，套件字节摘要为 `69129d529f41cdad17e9da1a706c4a1f7d3f00b7c4d8b59d11268faaf329a303`。该更新只重绑定冻结来源，不改变任务规则、控制输入或 F1 的零模型边界。

`source.lockSha256` 仍严格校验冻结 commit 中的锁文件，保证 fixture 的来源与工具链输入可复现。候选 checkout 可以提交新的 `pnpm-lock.yaml`；离线校准不执行候选依赖，候选锁由 dependency-policy 和 SDK consumer 各自核验，因此不把依赖更新误报为冻结 artifact 损坏。任务源码文件仍要求候选 checkout 与冻结摘要一致。

## 4. F1 离线流程

```text
读取 suite -> 校验 schema/上限 -> 验证 metadata 字节摘要
  -> 验证任务身份与引用 -> 验证规则及控制样本
  -> 已有 grader 执行合成正反校准 -> 输出观察文件 -> 生成报告
```

1. 可信 fixture 根由工具启动参数确定；逐项检查路径规范化、`lstat` / `realpath` 和根目录包含关系，防止 `..`、前缀相似目录、符号链接及平台分隔符绕过。
2. 文件只读取一次，将验证的同一份字节交给解析器和摘要计算；后续需要使用时先暂存不可变副本，不在摘要后重新读取可变原文件。
3. `preflight` 不执行 manifest 声明的任何命令，也不加载 suite 指定的 JS 模块。依赖检查读取声明，不触发安装。
4. `calibrate` 使用与本次源码匹配的已有 Core grader，不复写断言引擎。正确控制必须通过，错误控制必须失败，缺证据必须拒绝或不可评估。
5. 控制样本的“通过”表示规则校准符合预期，不表示 T01/T02/T03 的真实任务已经完成。
6. 输出先写入本次工具拥有的临时文件，校验后原子发布；不得覆盖已有不同 digest 的结果文件。重复同一输入可以复用结果，但不增加独立试验次数。

测试必须能证明零 Provider 调用、零普通 Run 派发、零用户 Store 初始化。优先通过模块依赖和可替换副作用边界验证，不依赖“没有配置凭据所以大概不会调用”。

当前用 Node 原生 TypeScript 支持及窄 `registerHooks` 加载 `evaluation-rule-grader.ts` 与 `evaluation-json.ts`；只将前者的 `./evaluation-json.js` 指向后者，不加载 Core barrel/数据库，也不依赖来源不明的旧 dist。先校验所有任务与源码 pin，再以有界、拒绝链接的读取获取 grader 字节，与 `git cat-file blob HEAD:<path>` 比较后才导入；导入后再次核对摘要并注销 hook。脏 grader 或链接被拒绝的测试会确认其代码没有执行。这是可信工具源码校验，不是运行不可信候选代码的沙箱。该实现替代最初“必须先构建完整 Core”的设想；实际验收工具链见实施记录，未证明其他 Node 版本均已通过。

## 5. F3 普通 Run 证据接入

### 5.1 正常执行与评测分离

```text
现有正常任务入口 -> Host 授权与正常 Run/Attempt -> 执行结束/确认停止
    -> 冻结源执行关联与输入/输出 -> 可信验证执行器
    -> 封存 baseline / candidate JSON 与来源说明
    -> 现有 enqueue + evaluation worker -> 既有判定与 rationale artifact
    -> 新报告适配器
```

现有 evaluation worker 负责判定封存输入，不负责替代正常 Provider 执行。现有 `RunEvaluationTaskV1` 以及 model grader 试点不是通用原始代码任务执行入口。

### 5.2 F3-A fixture `TaskExecutionEvidenceV1`

| 字段组 | 必须包含 |
| --- | --- |
| 任务身份 | suite / task 身份、各 artifact 字节摘要、规则与验证 profile 版本 |
| 源执行身份 | workspace 标识、WorkUnit、source Run、source Attempt、执行代次及必要 lineage 引用 |
| 输入快照 | 实际源码、依赖锁、任务说明与工具链摘要；必要图版本/隔离计划版本 |
| 输出快照 | 实际 candidate artifact、差异与构建产物摘要；不能只有模型消息 |
| 验证身份 | 可信验证器版本、实际执行 profile、隔离环境标识、允许执行的验证集摘要 |
| 验证结果 | 每项检查状态、退出原因、必要产物引用及证据缺失项 |
| 执行观察 | 正常完成/失败/取消/超时/未知；是否确认停止，是否存在未知副作用 |
| 资源观察 | 已知调用和用量、未知项、来源、币种，分别区分任务和 grader |
| 证据类型 | `synthetic_control`、`fixture_replay`、`live_execution`，不可互相冒充 |

本批将这些字段收敛为 `scripts/framework-assurance/execution-evidence.mjs` 的 fixture 格式，并以独立 `trusted-binding` 作为可信侧输入。它不修改既有数据库 DTO，也不从候选证据推导可信绑定；真实 Host 读取和封存接口仍留给 F3-B 前的独立任务。若无法通过现有公开内部接口取得必要关联，不直接访问其他模块私有 SQLite 表。

### 5.3 可信验证边界

- 测试 profile 由可信代码固定 argv、cwd、超时与环境白名单；不能从模型产出的脚本名直接执行。
- 候选修复可以改测试文件，但最终裁判测试来自冻结的可信快照；不接受候选自行删除断言后产生的“全绿”。
- 导入候选模块、运行候选测试本身就是执行不可信代码。只允许使用对应能力已验收的隔离执行器，禁止 `shell: true` 拼接候选输入或在原工作区直接运行。
- 验证器只接受可核验的退出与测试证据。模型输出 `testsPassed: true`、自报成本、伪造日志不构成授权或成功依据。
- 缺失执行能力、隔离或必要证据时记录 `blocked` / `not_assessed`；不能降低规则获得 pass。

### 5.4 关联、幂等与失败

| 情形 | 必须行为 |
| --- | --- |
| source Run 不属于同一 WorkUnit / 允许 lineage | 拒绝关联，不读取其 artifact 充数 |
| 兄弟 Run、旧 Attempt 或旧代次证据 | 不能作为当前执行的证据 |
| 读取过程中快照变化 | 丢弃当前适配输出，报告输入变化，不封存“混合快照” |
| evaluation 重复请求 | 复用既有冻结输入幂等语义；报告不再派发任务 |
| worker 失去 claim / shutdown | 沿用既有持久化恢复与 claim 处理，不私自完成记录 |
| artifact 缺失、字节不符或 JSON 损坏 | 标为证据失败，保留原因，不把空对象当合法候选 |
| 原执行取消但未确认停止 | 标记未知副作用并阻断后续有副作用的重试 |
| 报告生成失败 | 只允许重读已封存结果；禁止顺便重跑正常任务 |

映射源任务状态、evaluation 状态和客观结果时分别保留。现有 evaluation 的 `completed` 只说明判定过程结束，不自动代表 verdict 成功。

## 6. 结果格式与比较

### 6.1 已实现离线观察文件

F1 仅接受 `synthetic_control` 与声明为 `fixture_replay` 的离线数据，显式拒绝 `live_execution`。`fixture_replay` 是输入标签，不是可信 Host 认证；不能凭调用者填写的 pass 字段取得真实执行验收。F3 将另加来源权威与封存验证，不放宽当前限制。

| 字段 | 合同 |
| --- | --- |
| `schemaVersion` / `observationId` / `invocationId` / `caseId` | 固定版本、观察身份、独立调用身份与控制身份；同一调用重复导出不增样本 |
| `taskIdentity` / `inputDigests` | 完整冻结引用，不能只写任务展示名 |
| `sourceCommit` / `comparison` | 完整源码 commit；实际 model/reasoning/executionStrategy/node/platform/arch，离线模型与推理均为 `none` |
| `evidenceKind` | 当前只允许合成校准与 fixture 重放；真实执行不是本格式已支持能力 |
| `executionStatus` | 归一化观察状态：`not_started / running / completed / failed / cancelled / timed_out / unknown` |
| `assessment` | 新报告的 `pass / fail / not_assessed / invalid_evidence`；不是替换现有数据库枚举 |
| `stopReason` / `effectStatus` | 保留停止原因；副作用为 `none / confirmed / unknown`，不能从文本猜测 |
| `timings` | queue、执行、验证和判定分别记录；缺失值为 null 并说明原因 |
| `usage` | task / grader 两类列表，每项有请求身份、来源、known/unknown、数量或金额与币种 |
| `artifacts` | 当前 `{ role, sha256 }` 列表；不含绝对路径或原始内容，不含尚未接入的 evaluation 身份 |
| `limitations` | 缺失能力、平台限制、未验证项，不能为空白掩盖已知问题 |

观察文件记录成功、失败和缺证据三个维度；`assessment: pass` 必须有可信裁判所需的全部证据。未执行 / 不支持的任务不能映射成 pass。

当前 `inputDigests` 固定为 suite/task/rule/expected/profile/lock 的原始字节摘要。bundle 为 `{ schemaVersion: 1, kind: "offline_observations", requestedCount, observations }`，最多 10000 条观察。校准要求的顶层证据缺失时为 `invalid_evidence`，不是普通失败；校准成功要求九控制均匹配各自期望，而不是九控制全为 pass。

### 6.2 可比性键与分母

比较键包含任务/规则版本、源码与验证 profile、依赖/工具链/平台、能力与隔离 profile、模型/推理参数及执行策略。指定“并发策略”或“模型”为唯一试验变量时，只允许该维度不同，其他差异明确标记 `not_comparable`。

| 指标 | 定义与约束 |
| --- | --- |
| Requested | 冻结试验设计要求的次数，含失败和未启动；不能事后删样本 |
| Assessed | 有完整可信证据、得到 pass 或 fail 的次数 |
| Assessed pass rate | `pass / Assessed`，分母为零时为 null |
| End-to-end success rate | `pass / Requested`，同时列出 blocked、unsupported、缺证据与未启动数量 |
| Timing | 仅比较同类阶段；记录样本数，不能把跨主机时间戳差直接当持续时间 |
| Cost | 分币种列 known subtotal 和 unknown count；未知项存在时不得标成总成本 |

同一 invocation、任务身份和 case 的重复导出按结构值去重；同身份但内容冲突必须拒绝。用量按 invocation/request 身份去重，冲突结算拒绝。比较按任务/case 分组，要求两组独立调用数相等、各组环境同质且没有未观察调用；重复导出不能填平缺样本。timing median 在偶数样本时取中间两值的平均，p95 至少 20 个样本才有数值。三个任务或一次试点不足以证明整体提效，离线控制不得计入真实任务成功率，报告的 live task 请求/通过数始终为零。

JSON 是机器读取的主格式，Markdown 从同一已验证对象生成，不能各自计算指标。公共输出不包含绝对用户路径、原始 prompt、私有日志、凭据、claim token 或 resume handle；敏感原始证据留在原隔离存储。

### 6.3 付费与重试约束

默认离线模式不产生模型费用。真实试点必须在启动前明确总体金额、币种、请求/工具循环/子任务/时间上限、最大在途并发，以及最坏情况下未结算请求的预算预留。总账包含所有子代理、工具循环和后置 grader，不能只统计 root Run。

未知用量、金额超限、无法确认停机或权限变化时停止继续派发，并明确已有在途请求及其停止状态。不自动更换付费模型、不偷偷重试。现有人工 model-grader pilot 的 1 至 3 次请求限制只适用于它自身，不能套用为整项代码任务预算。

## 7. F2 SDK 独立消费者

### 7.1 Producer 与归档审计

核查基线三包版本均为 `0.0.0`，均为 ESM 根出口；contracts 另有公开 continuity JSON fixture。contracts 依赖 localization，api-client 依赖 contracts。因此至少准备四包的真实 tarball，按实施基线重新计算完整依赖闭包。

1. 在独立实现工作区每次重新串行构建四包依赖闭包，确保 dist 来自本次受检输入；没有跳过构建或复用外部 build 报告的入口。构建前后记录源码和锁摘要；HEAD 一致本身不能证明 dist 新鲜。
2. 在各 producer 包中运行真实 `pnpm pack`，不自行拼装“看起来一样”的归档。
3. 审计实际归档中的 manifest、exports、声明、JS、公共 JSON 与依赖。拒绝残留的 `workspace:`、`link:`、源码目录依赖、越界归档条目或不合法链接。
4. 缺文件时修 producer 配置后重新构建、打包；禁止在 consumer 补拷 dist、源码或改写 manifest 掩盖缺陷。

首次真实消费在四包构建后，于 localization 归档审计报 `export_file_missing`：缺少公开出口的 `dist/index.d.ts`。已为四包增加最小 `files` allowlist，均包含 `dist`，contracts 另包含公开 continuity JSON；未改 API 语义、依赖或锁。最终重新构建、真实 `pnpm pack`、归档审计和仓外离线安装通过，四个 tarball、dist 与安装后字节对应，失败及通过报告均保留在仓外。

### 7.2 仓外安装与工具链

- 用 `fs.mkdtemp(os.tmpdir())` 创建不在任何工作区根下的 consumer，只复制受控模板和真实 tarball。
- 四个本地 tarball 在同一次安装中提供，使用隔离缓存和 `npm install --offline --ignore-scripts --package-lock=false --no-audit --no-fund`。缺少其他依赖时明确报告环境阻断，不悄悄联网获取“最新”。
- 固定的 compiler 及必要类型依赖在独立工具目录预置，记录实际版本与摘要；不能依赖根工作区 tsconfig、根 `node_modules` 或自动联网下载。工具目录不是 Ling 包解析 fallback。
- 清除 `NODE_PATH` 等污染变量；禁止 TS `paths` 指向工作区、向上 `extends`、绝对源码导入及私有 `daemon/core/src` 导入。
- 通过 `lstat`、`realpath`、`import.meta.resolve` 和 TS resolution 记录证明 Ling 包来自 consumer 的 `node_modules`，没有 workspace symlink。
- TS 采用 `strict`、`noEmit`、`skipLibCheck: false`，显式声明 Fetch/DOM 和 Node 类型环境。
- 运行前后比较根锁文件摘要；清理只删除本工具创建并核实归属的临时目录，不扫描清理其他工作区或用户缓存。
- 仅可执行 CLI 入口安装 `SIGINT` / `SIGTERM` 监听，向本次 consumer 传播取消；模块导入不安装全局监听。取消后不启动后续命令，POSIX 下终止当前自有进程组并等待 `close`，再核对锁、清理自有目录及保存 `failed` / `command_cancelled` 报告。入口移除监听并分别以 `130` / `143` 退出。报告只保留允许的信号名，不复制任意取消原因；Windows 后代进程清理不在本轮验收声明内。

最终实际消费中，运行时检查解析到仓外安装的四包；两个类型 profile 各记录 317 个解析文件，均限于 consumer 或隔离 compiler 目录。临时 consumer 在核实归属后删除，脱敏日志、tarball 与报告保留在外部输出目录。`--offline`、`--ignore-scripts` 与固定 argv 是可信工具的行为约束，不冒充操作系统级网络隔离或不可信代码沙箱。

### 7.3 消费验收矩阵

| 测试组 | 正例 | 负例 / 边界 |
| --- | --- | --- |
| 公共导入 | 三包根 bare import；contracts 的公开 JSON 子路径 | 未导出的 `src/*`、`dist/*` 深导入必须失败 |
| 声明消费 | ESM NodeNext；Bundler 类型解析另成一格 | 缺少 `RunnerExtensionMetadata.resumeCapabilities` 等必填字段必须类型失败 |
| Manifest | 按 extension 与 plugin package 各自当前合同提供合法值 | 错误接口版本、非法包版本、重复 contribution、秘密值、越界路径按所属校验器拒绝 |
| Registry | 正确 kind 注册、get/list/listByKind | wrong kind、跨 kind 重复 ID；验证列表冻结，不声称记录深冻结 |
| JSON endpoint | URL/cwd/body、HTTP message/code、fetch cause | AbortError 不包装、无隐式重试；malformed JSON 与 HTTP 错误分离 |
| 流 endpoint | 原始 Response/chunk、所属入口的 header、afterSeq、适用的 signal | 分入口记录 HTTP 错误差异；不虚构统一 decoder/reconnect |
| 安全边界 | Computer Use token 只发往所属路由 | token 不进入 URL、不发到无关 endpoint；metadata 不授予执行权 |
| 产物完整性 | 各出口与所有声明依赖可解析 | 归档摘要变化、缺依赖、源码 fallback 使整格失败 |

extension manifest 与 plugin-package manifest 的版本校验不是同一套规则，不能把后者的严格检查套到前者。现有 `assertSemverCompatible` 也不是完整 SemVer 或 Host 版本协商协议。

`LingDaemonTransport` 的 JSON 错误语义不能推导到另一套 `ExecutionEngineManagementClient` 请求实现。`streamConversation` 返回原始 Response，当前不检查 `response.ok`；channel 流入口有 HTTP 检查但未统一结构化 code。测试保留差异；若要统一行为，另做 API 合同变更及调用方回归。

### 7.4 支持矩阵与版本轴

每格记录 OS/架构、Node、npm/pnpm、实际 TS、module/解析模式、四包版本与 tarball SHA、fixture 版本和结果。以下本地复验环境为 macOS arm64、Node `22.22.1`、npm `11.12.0`、pnpm `10.0.0`、TypeScript `7.0.2`；类型依赖为 `@types/node 26.6.5` 与 `undici-types 8.9.0`，原生 compiler 为 `@typescript/typescript-darwin-arm64 7.0.2`。此前 Node `24.22.1` / npm `11.12.1` 结果保留为历史本地记录；新增托管候选结果单独记录，不改写此前报告的来源。

| 已运行测试格 | 本轮结果 | 证据边界 |
| --- | --- | --- |
| ESM runtime | 19/19 组检查通过 | 真实四包、固定 mock transport；不是实际 daemon 或 Runner |
| ESM NodeNext types | strict 正例、缺 `resumeCapabilities` 负例及解析审计通过 | `noEmit: true`、`skipLibCheck: false`；317 个解析文件 |
| Bundler types | strict 正例、相同必填项负例及解析审计通过 | 317 个解析文件；不是浏览器运行验收 |

审查修复后，新工具 64/64 项测试通过，其中 F1/CLI 为 47 项、SDK 边界测试为 17 项；连同相关 CI/历史扫描契约 125 项，共 189/189，无跳过或取消。新增中断回归覆盖预先取消和真实 CLI 的 `SIGINT` / `SIGTERM`，在 macOS arm64 上验证后代进程停止、自有目录清理、锁不变、失败报告和非成功退出。真实 SDK consumer 也已在修复后重跑通过。既有三包 typecheck 与 contracts/plugin-sdk/api-client 的 123/8/130 项测试已有本地通过记录；产物、fixture 与报告摘要见实施记录，不把包声明直接当通过证据。

本分支的 `framework-assurance` CI lane 使用 Ubuntu、Node `22.22.1` 与完整 Git 历史，执行离线回归/校准及独立重建的真实 SDK consumer，不复用 `ci-dist`。它在完整非文档档位下是 `quality` 的必需输入；失败、取消、缺失或意外跳过均拒绝。

2026-11-03 已核实候选 `0a4f5327073058f45d14b5c21940a1811d9fb6b1` 的 [Linux job](https://github.com/ling-stack-org/ling-stack/actions/runs/41477220526/job/125386311185) 成功，工具回归 64/64、v3 校准 9/9 符合期望。其独立 SDK 报告记录 Linux x64、Node `22.22.1`、npm `10.9.4`、pnpm `10.0.0`、TypeScript `7.0.2` 及原生 `@typescript/typescript-linux-x64 7.0.2`：四包重新构建、真实打包和仓外离线安装通过，ESM 19/19，NodeNext/Bundler 各自的 strict 正例、必填字段负例及 317 文件解析审计通过。251 个 producer 输入前后摘要一致；报告与输入摘要见[实施记录](ling-framework-complementary-implementation-plan.md#9-交付记录与完成判定)。这是新增的真实 Linux 消费格，不是复制 macOS 结果。Common checks 的历史哈希误报已获批准补齐 106 条精确指纹，本地相同全历史范围扫描零命中、扫描契约 22/22 通过；旧远端失败不改记成功。完整 CI 已结束且失败，Daemon shard 0 取消、1/2 成功、3 失败，helper smoke 成功；不再列为排队或在途。

当前 PR #653 的提交 `3c7b905be010fa0da37780da6e5288dbff760cd1` 已在 [CI run 42401958832](https://github.com/ling-stack-org/ling-stack/actions/runs/42401958832) 完成并通过。四个 Core shard、四个 Daemon shard、framework assurance、真实 SDK consumer、构建、类型检查、依赖策略、Linux restricted-command、macOS helper/Seatbelt、质量汇总和 timing telemetry 均为 success；Core shard 2 首次的时间边界失败在同一 run 的 job 重跑中通过。该证据只收口 F1/F2 的当前 PR 门禁，不扩大为真实 Runner、GUI 或 F3/F4 验收。

后续本地限时诊断保留 0/10 轮完整完成、89/150 文件完成及 6 项实际失败，不推算通过率。独立合成探针确认的原生私有状态隔离缺陷已修复，并由真实 macOS native boundary 回归 22/22、相关 Kimi/relay 回归 65/65 验证；这不替代远端完整 CI 或原 history-budget 超时的独立处理，详见实施记录。

- Linux、macOS、Windows 独立记录；单机通过不能复制结果到其他平台。
- Bundler 类型通过不代表浏览器运行验收通过。
- CJS、旧工具链、历史 SDK/daemon 配对、真实 Runner 与 GUI 未覆盖时写“未验证/未承诺”。
- npm 包版本、`lingInterfaceVersion: "1"`、DTO `schemaVersion`、数据库 migration 分列，不相互替代。
- `capabilities`、`trustLevel`、`defaultApprovals` 是元数据或策略输入，不是授权凭据。

对外稳定承诺前还需确定公共出口、版本发布和兼容窗口。SDK/contracts 中同名 manifest 类型的归属与细微差异应独立决策，不在 consumer 首轮中顺手重构。

## 8. F4 只读诊断

现有入口：`LingDaemonClient.getWorkUnitHarnessDiagnostics(cwd, workUnitId, query)` 对应 `GET /work-units/:id/harness`。cwd 必填，limit 当前为 1 至 500，cursor 受 Run/WorkUnit 范围约束。F4-01 由 `readHarnessDiagnosticsReportFromClient` 将这个真实客户端入口接入 `readHarnessDiagnosticsReport`，逐页读取并输出 workspace 摘要哈希、页级时间标记、allowlist 诊断记录和同一 Run/WorkUnit 的 F3 observation 关联。底层回调仍保留为纯适配边界，便于验证报告逻辑而不创建客户端或执行状态。

| 条件 | 消费方行为 |
| --- | --- |
| 冷工作区返回 `harness_workspace_uninitialized` / 503 | 展示不可用，不触发 Store 初始化、reconcile 或 retry |
| `available` | 读取 allowlist 投影；关联同一身份的报告 |
| `run_unlinked / run_missing / lineage_mismatch` | 显式显示对应缺失，不找其他 Run 代替 |
| 分页过程源状态变化 | 保留页面身份和读取时间；不声称跨页事务快照 |
| checkpoint ready / isCurrent | 仅表示投影状态，不作为任务完成或授权证据 |
| fence / owner / recovery 信息 | 只观察，不触发 continuation 或重跑 |

不公开 claimToken、resume handle、私有输入、artifact body。新增报告只引用允许字段；详细失败日志仍由原权限边界控制。集成测试覆盖“读取不启动执行”的反例，不只验证返回 JSON。

## 9. F5 节点重跑未来合同

本节不授权实现。第一轮不新增 rerun API、按钮、状态、数据库列或审批动作。

### 9.1 将来必须满足的准入

1. 原执行已结束或已确认停止，没有未确认的 lease / fence / 在途副作用。
2. 指定原始 Run、Attempt、节点、图版本、输入与依赖产物摘要；不从可变当前工作区补全旧输入。
3. 明确受影响的下游依赖闭包；只有摘要、权限和依赖不变的上游证据才允许复用。
4. 新执行身份、代次及 fence 由既有运行时产生；新结果不得冒充旧 Attempt 的继续写入。
5. 外部写入、审批与 release 重新走当前策略；旧批准不自动成为新批准。
6. `effectStatus: unknown`、外部非幂等操作、不可还原输入、过期权限时拒绝自动重跑，先人工处理。

### 9.2 将来必须保留的结果与审计

- 原始 DAG、旧节点、旧 artifact 和旧判定保持不可变；新结果通过 lineage 关联。
- 修改后的图是新版本，不直接修改已接受的执行图来绕过依赖检查。
- 控制平面只提交意图，Host 再校验；不能把 UI 可点击或诊断 fence 当执行许可。
- 取消、重启、重复点击和审批失效的语义必须与并发拥有方联合验收。
- 实现方案、迁移需求及 UI 另立任务。相关批准前，F5 状态始终为设计合同，不计入已实现能力。

## 10. 验收矩阵

| 编号 | 阶段 | 必须留下的证据 |
| --- | --- | --- |
| A01 | F1 | 合法 suite 可读；未知 schema/字段、重复身份、超限均拒绝 |
| A02 | F1 | 越界、符号链接、平台路径绕过、引用字节变化均拒绝 |
| A03 | F1 | 三个任务槽位来源与输入冻结；正确、错误、缺证据控制符合预期 |
| A04 | F1 | 任务 metadata 与既有闭合 rule case 分离；字节与值摘要不混用 |
| A05 | F1 | 预检及校准零模型、零普通 Run、零用户 Store 初始化 |
| A06 | F1 | JSON/Markdown 指标一致；重复 invocation 去重，未知成本/零分母不造值 |
| A07 | F2 | 四包及实际依赖闭包真实打包、仓外离线安装、所有公开出口完整 |
| A08 | F2 | 无工作区/源码 fallback；深导入负例失败；根锁摘要不变 |
| A09 | F2 | NodeNext/Bundler 类型正反例，以及两个 manifest 校验器的各自边界 |
| A10 | F2 | registry、公共 HTTP、AbortError、token 路由和原始流的分入口测试 |
| A11 | F2 | 每个测试格有平台、实际工具链和 tarball SHA，未测范围明确 |
| A12 | F3-A | 兄弟 Run、旧 Attempt、输入变化、损坏 artifact、丢 claim 均不被接受 |
| A13 | F3-B | 正常 Run -> 可信验证 -> 既有 evaluation -> 报告的完整真实证据链 |
| A14 | F3-B | 所有子调用和 grader 纳入预算；未知用量、取消未停、权限变化停止派发 |
| A15 | F3-B | 串行先验收；并发对比只在对应能力/隔离/汇合及恢复验收后进行 |
| A16 | F4 | 冷工作区、错 lineage、分页变化正确呈现；诊断零执行副作用与敏感字段泄露 |
| A17 | F5 设计 | 停止确认、冻结输入、依赖闭包、新身份、新审批及未知副作用阻断齐全 |
| A18 | 全阶段 | 原 WIP、共享运行数据和锁文件未被越界修改；文档同步真实交付状态 |

## 11. 错误、兼容与未决项

新脚本错误采用私有 code，并附脱敏 message。F1 已实现既有校验错误；F3-A 增加 `evidence_lineage_mismatch`、`evidence_stale_attempt`、`evidence_snapshot_changed`、`evidence_artifact_missing`、`evidence_artifact_digest_mismatch`、`evidence_claim_lost`、`evidence_effect_unknown` 等拒绝码；F4-01 增加 `diagnostics_scope_mismatch`、`diagnostics_invalid_response`、`diagnostics_duplicate_record`、`diagnostics_pagination_stalled` 等只读适配错误。冷工作区和既有 endpoint 错误映射为脱敏报告状态，不伪造 daemon HTTP code。

既有 `harness_workspace_uninitialized` 等错误仍按原合同解释。现有 canonical write、历史 read、不可变证据字节、权限与 Runner 迁移继续归原兼容文档拥有，不因消费测试而放宽。

首批 F1/F2 无需等待全量未来路线图，但必须在实施中关闭以下具体事项：

| 项目 | 关闭节点 | 未关闭的影响 |
| --- | --- | --- |
| 三个具体校准任务与冻结规则 | F1-01 已关闭 | 源码分析/故障注入标签明确；候选修复行为验证仍待 F3 |
| 消费矩阵的实际工具链与依赖预置 | F2-01 已有 macOS arm64 本地及 Linux x64 托管消费格 | Windows SDK 及其他工具链仍未验证；安装器 job 不替代 SDK 消费 |
| 正常 Run 证据内部读取及封存接口 | F3-01 | 只做 fixture，不执行真实适配 |
| 对应执行 profile 的安全/恢复验收 | F3-B 启动前 | 阻断该能力的真实任务，不阻断离线和 SDK |
| 付费总额与 Provider 选择 | 每次真实试点前 | 不产生任何模型请求 |
| 公开包稳定窗口和版本发布策略 | 对外宣称稳定前 | 可以内部验证，不能扩大支持承诺 |

## 12. 代码与测试锚点

完整源码基线与锚点见[总体设计第 10 节](ling-framework-complementary-design.md#10-代码与测试锚点)。实施重点回归：

- Core：`packages/core/src/harness/evaluation-rule-grader.ts`、`evaluation-json.ts`、`evaluations.ts`。
- Daemon：`run-evaluation-scheduler.test.mjs`、`run-evaluation-storage-projection.test.mjs`、`run-evaluation-task-worker-composition.test.mjs`、`run-evaluation-qa-pilot-runner.test.mjs`、`harness-diagnostics-api.test.mjs`，均位于 `packages/daemon/test/`。
- SDK：`packages/plugin-sdk/test/package-manifest.test.mjs`、`registry.test.mjs`、`packages/contracts/test/conversation-continuity-v2.test.mjs`。
- Client：`packages/api-client/test/client.test.mjs`、`computer-use.test.mjs`、`transport-origin.regression-1.test.mjs`；Web SSE 解码代码位于 `apps/web/src/sse.ts`，不等于 api-client 公共 decoder。
- 现有构建/测试调度：`scripts/ci/run-packages.mjs`；实施时按同一基线先构建再测试，不重复使用来源不明的 dist。
- macOS native boundary：`packages/daemon/src/runtime/sandbox/native-process-launch.ts` 与 `packages/daemon/test/native-process-boundary.test.mjs`；私有状态规则、合法 workspace 写入、Kimi metadata、relay 和进程回收分别保留独立边界。
- 新工具：`scripts/framework-assurance/`；冻结输入：`fixtures/framework-assurance/`；实现测试：`offline.test.mjs`、`cli.test.mjs`、`sdk-consumer.test.mjs`、`execution-evidence.test.mjs` 与 `diagnostics.test.mjs`，均位于新工具目录。
