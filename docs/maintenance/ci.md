# CI 运行方式

本文按当前工作区源码说明 CI 行为，再记录尚未实施的平台分工和定时优化方案。分类收窄、Draft 分档、严格汇总门、Core 分片和文件级计时已实现；这不表示当前修改已合并或通过 hosted CI 验收。

分片执行、文件 watchdog、报告与耗时缓存见 [CI 测试执行说明](../../scripts/ci/README.md)；依赖安全补丁、兼容边界与验证入口见[补丁维护说明](../../patches/README.md)。

## 当前行为

以下描述以工作区中的[分类器](../../scripts/ci/classify-scope.mjs)、[执行策略](../../scripts/ci/execution-policy.mjs)和[工作流](../../.github/workflows/ci.yml)为准，不以历史提交作为当前基线。PR 工作流在推送修改后应用；定时任务使用默认分支上的工作流。本次文档同步未核验 GitHub 仓库可见性、账户额度或账单，不能据此承诺排队时间或费用。

CI 会先根据整个 Pull Request 的变更路径选择最小安全范围：

- 只有文档、各级 `README.md`、已登记的 PR／Issue 模板、`CODEOWNERS`、`FUNDING.yml` 或维护脚本变更时，不选择产品任务，但仍运行公共检查和汇总门。完整执行档位即使是纯文档范围也扫描 Git 历史；只有 Draft preview 延后历史扫描。维护脚本白名单仅包含 `check-markdown-links.mjs`、`check-public-repo-safety.mjs` 和后者的测试，新增脚本仍保守处理。
- 工作区源码或包内 TypeScript／构建配置变更时，[分类器](../../scripts/ci/classify-scope.mjs)选择所属包及直接、间接消费者；仅改测试时选择所属包，并补充已识别的跨包测试辅助文件使用方。Web 的目录导入器额外选择 localization 验证，实际依赖图也包含 CLI 对 Web 的依赖；为构建补齐依赖不等于选择这些依赖的测试分片。
- 包级 `package.json` 只有在 base 与当前包目录、名称、测试／类型检查入口存在性及全部 scripts 内容可核验且不变时才允许收窄；使用新旧依赖边的并集扩大消费者，并选择依赖策略任务。新增、删除、重命名、无法核验或任意 script 增删改均回退全量。根 `package.json`、锁文件、workspace 配置、非白名单 `.github/`／`scripts/`、补丁、根 TypeScript／构建配置及未知路径仍全量；维护脚本与源码混合不豁免源码检查。
- [工作流](../../.github/workflows/ci.yml)由 Pull Request、手动运行和每日定时触发，没有 `main` push 触发。定时为每天 UTC 03:17，即北京时间 11:17；手动和定时运行始终走现有完整 Linux/macOS 矩阵，即使当天没有提交也执行。GitHub 定时任务可能排队或延迟，不保证准点启动。没有启用成功证据去重或每日 Linux 单独分档。
- 新增 `full-ci` 标签立即触发全量；已有标签让后续推送继续全量。无关标签事件不替换必需检查结果，也不取消当前验证；移除标签只影响下一次正常 PR 运行，不立即重跑。
- [执行策略](../../scripts/ci/execution-policy.mjs)独立选择 `preview`／`complete`：无 `full-ci` 的 Draft 推送只跑公共检查，延后依赖安装、构建、类型检查、产品测试、历史密钥扫描及所有 macOS 任务；转正式评审、正式 PR 更新、手动或定时运行使用完整执行档位。
- Draft 的轻量成功不是完整验证成功。汇总门明确报 `deferred_by_draft_policy`，提醒需要转正式或请求完整运行；正式档位下所有必需任务均须实际成功。同一个 PR 的新运行会取消旧运行，但已执行的任务用量不会因此退回。

| 事件 | 执行方式 |
| --- | --- |
| 无 `full-ci` 标签的 Draft 新建、推送、重开或转回 Draft | `preview`：分类、文档链接、公开仓库安全、CI 规则测试及空白检查；不安装依赖、不构建、不运行产品测试或历史密钥扫描 |
| 正式 PR 新建、推送、重开或转为正式评审 | `complete`：按整个 PR 的改动范围补齐必要检查 |
| 新增或保留 `full-ci` 标签 | 完整执行档位及全仓范围；大小写匹配与 GitHub 表达式一致 |
| 手动运行 | 目标分支上的完整验证 |
| 定时运行 | 默认分支每天 UTC 03:17（北京时间 11:17）的完整验证 |

Daemon 测试拆为四个 `macos-26` shard，每个 shard 使用四个文件 worker；每个文件单独以 `--test-concurrency=1` 启动，拥有独立的 runtime home、workspace 和 POSIX 进程组。Kimi Host read／terminal 和 delegation production tool surface 文件在所属 shard 的独占阶段先串行完成，其余文件再进入按估计耗时降序的共享队列。Channel 测试已拆为 discussion、intents、workflows 和 workspace 四个普通并行文件，共享 fixture 不作为测试入口。完整执行档位下选择 Daemon 时，仍运行独立的 Linux restricted-command 拒绝契约和真实 macOS helper／Seatbelt smoke。

Daemon 分片任务上限为 40 分钟，执行队列上限为 30 分钟；默认文件 watchdog 为五分钟，仅 recovery-discovery-fair-scan 文件保留十分钟例外，拆分后的 Channel 文件使用默认上限。超时或取消会终止文件所属进程并使任务失败，不重试或强制通过。任务预算和本地计时不能证明 hosted CI 性能改善。

Core 已接入四个 Linux shard，每个使用两个文件 worker、20 分钟队列上限，属于既有 `unit-tests` 必需矩阵。普通 packages 入口排除 Core 与 Daemon，避免重复执行；只有存在其他被选测试包时才生成该入口。仅改 Core 测试时生成四个 Core 入口，且不生成空 packages 入口；仅改 Daemon 测试时没有 Linux unit 入口。

[分片计划](../../scripts/ci/test-shard-plan.mjs)在 scope 阶段统一生成并上传 `ci-test-plan`，各 shard 与新发现的 `test/*.test.mjs`、`test/*.test.ts` 核对完整且恰好一次的分配。计时提示仅影响外层分片和内部队列顺序；缺失或不可用时回退源码大小／类别估算，不减少覆盖。每文件日志及 JSON 计时报告上传为 `ci-test-report-core-*`／`ci-test-report-daemon-*`；汇总验证全部计划文件恰好通过一次后，仅默认分支运行可发布计时缓存。无关策略失败不阻止完整测试报告的计时保存，但仍使质量门失败；PR 不能发布计时基线。这些计时不是跳过测试的成功证据。

历史运行 `39274142315` 的分片 1 在当时 25 分钟上限前已连续通过 1,584 个顶层测试，尚有文件未执行；扩大任务上限只补足运行预算，不代表性能优化。当前任务上限包含依赖安装及原生准备。

完整 Daemon 分片使用 macOS，是为了让 Darwin 专属正向用例实际执行。[平台契约测试](../../scripts/ci/platform-lanes.test.mjs)当前明确保护这一要求，不能只改 `runs-on`，让 Linux 上的跳过被当成原生验证成功。

Daemon 专用的依赖安全测试由 `dependency-policy` 任务单独运行，因此不会在 shard 中重复执行。`quality` 汇总任务保留检查名 `Typecheck, unit tests, and Web build`，统一判断适用任务的结果。

整合 `main@328bb10a`（#515）后，类型检查、单元测试、Daemon 及 Linux 契约／macOS helper 任务条件使用 `!cancelled()`，使手动取消或新推送的自动取消能终止长任务。只使用 `always()` 时 GitHub 重新计算条件仍为真，任务可能继续运行；汇总门保留 `always()`，明确拒绝取消或未完成的验证。

主 CI 的 Node 工具链固定为 `22.22.1`。构建只执行一次 `build:ci` 拓扑构建，短期 `dist` artifact 供类型检查、单元测试和 Daemon 分片复用；`test:ci` 不隐式重建依赖。本地通过不替代 GitHub 对当前待检提交的干净 runner 验证，完整 CI 成功也不替代 packaged 产品验收。

公共检查同时发现 `scripts/ci/*.test.mjs` 和 `scripts/ci/*.test.ts`，由固定 Node 直接运行。根 `typecheck` 和被选中的 CI typecheck 任务执行 `typecheck:ci-tests`，使用 `scripts/ci/tsconfig.test.json` 严格检查 TS 测试；运行时类型擦除不能代替类型检查。Daemon 的包级测试命令及两处分片发现也包含 `.test.ts`，其 `typecheck:ci` 同时检查生产代码与 `test/**/*.ts`，包括测试辅助文件。

框架 assurance 是独立重建例外，不能用产品测试图的 `dist` artifact 代替实际 producer/tarball 消费证据。本分支的 `framework-assurance` 在完整非文档档位运行离线测试、三任务九控制校准及真实 SDK consumer；零模型、无 secrets、不启动 daemon。Consumer 串行重建 localization/contracts/plugin-sdk/api-client，实际 pack 并仓外离线安装。`quality` 要求该 lane 成功，失败、取消、缺失或意外跳过均拒绝；Draft/full-ci 规则不变。报告和直属日志上传为 `ci-framework-assurance` 并保留七天，不上传 consumer/toolchain 树或 tarball。详见[补强实现记录](../design/ling-framework-complementary-implementation-plan.md#9-交付记录与完成判定)。

Linux 构建任务在选中 CLI 时运行真实 daemon 生命周期和新工作区 doctor 检查；未配置 provider 的新工作区预期返回诊断退出码 4。在选中 Web 时，使用生产构建的 Vite preview 运行六项 Playwright 回归，覆盖权限、内置技能元数据和中文角色。浏览器测试使用模拟 daemon 数据，不包含真实模型调用。当前运行的截图与测试结果上传为 `ci-linux-source-web-smoke` artifact，保留七天。

会话操作记录、复制、文件审查、归属与颜色层级场景可通过 `corepack pnpm --filter @ling-stack/web test:e2e:work-cell` 本地按需运行。会话样例由 E2E mock daemon 提供，不依赖开发模式；Web 的 `typecheck` 和 `typecheck:ci` 通过 `tsconfig.e2e.json` 检查所列用例及其辅助文件。

本地化包的 `typecheck:ci` 和 `test:ci` 已补齐；前者在干净 runner 重新生成未跟踪的 TypeScript 目录文件后检查类型，后者执行翻译目录完整性、占位符检查及本地化单元测试，复用构建阶段的 `dist`。新增[入口覆盖契约](../../scripts/ci/package-script-coverage.test.mjs)，要求分类器选中的每个类型检查／测试包都有对应 CI 脚本，防止 `--if-present` 静默跳过漏配包。

## CodeQL 安全扫描

[CodeQL 工作流](../../.github/workflows/codeql.yml)采用与 OpenClaw 相同的触发策略，按 Ling 的源码目录适配，扫描语言仍为 JavaScript/TypeScript，使用 CodeQL 默认查询集：

- 正式 PR 新建、推送、重开或转为正式评审时，仅在源码、依赖、构建配置、扫描脚本或工作流相关路径变化后扫描；Draft 暂缓，转正式后补跑。仅修改 `docs/` 中的普通文档或根目录 Markdown 时跳过分析，带源码后缀的文件仍扫描；源码目录内的文档按目录保守纳入。所有正式 PR 先进入轻量范围判断，差异达到 API 的 300 文件上限或无法完整确认时直接扫描，避免顶层路径过滤漏掉大 PR。
- PR 的范围选择器固定读取事件中的 base SHA，不能执行 PR 自己修改的跳过逻辑；首次引入工作流时，若基线没有选择器则保守扫描。SARIF 确认逻辑直接放在工作流中，不导入待扫描代码。
- 默认分支每小时 UTC 第 23 分钟检查一次（北京时间每小时第 23 分钟），没有 main push 触发。GitHub 调度可能延迟。
- 手动运行始终执行扫描，不复用历史成功；默认分支上的手动成功可以作为定时扫描的基线。
- [定时选择器](../../scripts/ci/codeql-scope.mjs)只复用同仓库 main 上、本工作流最近 30 次运行中的实际成功扫描，最长有效 24 小时。分析任务须确认该次 SARIF 上传已完成处理，pending、失败、缺少上传 ID 或状态查询错误均使任务失败，不能作为后续跳过的基线。仅完成范围判断或跳过分析的运行不会刷新基线；PR、其他分支和 fork 的结果也不能充当基线。
- 只有与扫描基线相比的完整差异不涉及扫描输入时才跳过。改名检查新旧路径；最新主干尝试失败、取消、未完成，比较达到 API 的 300 文件上限、发生分叉、查询失败或没有可靠成功记录时，重新扫描。即使源码不变，至少每天重新扫描一次，以更新查询和 runner 环境。
- 同一 PR 的新提交取消旧扫描；定时扫描完成当前运行，后续小时只替换等待中的运行。手动运行独立排队，不互相取消。

切换此工作流时，需先关闭仓库的 CodeQL default setup，避免它继续在每次 main 更新时扫描，以及拒绝高级工作流上传 SARIF。上线验收同时核对 default setup 为 not-configured、PR 分析成功上传，以及合并后 main 手动扫描成功。若替代扫描无法正常上传，恢复原默认设置；不能仅删工作流后留下没有扫描的仓库。

本节仅调整 CodeQL，不改变主 CI 的每日完整矩阵、Draft 档位、必需质量门或 Copilot 安全审查。CodeQL 的成功基线仅用于其自身定时扫描，不为产品测试提供跳过依据。Copilot Autofix 是扫描后的修复建议，需要审查和测试。

## 2026-10-19 补充规则评估

| 项目 | 当前覆盖与建议 |
| --- | --- |
| 本地化类型／测试入口 | 本次修复此前被选中却未执行的漏检，并增加入口覆盖契约 |
| CodeQL / Copilot Autofix | 工作区已包含上节的 PR 范围过滤、每小时检查和手动工作流；GitHub default setup 当前状态及扫描上传验收仍须单独核验。Autofix 建议仍须审查与测试，不自动合并 |
| 仓库级密钥扫描／推送保护 | 2026-10-19 的历史评估记为开关关闭；本次未核验当前设置。现有完整执行档位包括纯文档 PR 都运行 Gitleaks 历史扫描，Draft preview 延后；上传后的扫描不能代替推送时拦截 |
| 新披露的依赖漏洞 | 历史评估记录 Dependabot 告警及安全更新已配置，本次未核验服务端状态；仓库 `.github/dependabot.yml` 仍声明每周版本更新。CI 另测安全补丁与许可策略；新增严重性阻断前须核对现存告警、补丁及无上游修复的基线，不能将旧告警直接当作本次改动引入 |
| 浏览器与桌面交互 | 选中 Web 时执行六项生产预览 Playwright smoke，使用模拟 daemon 数据并保留截图；Desktop 主要只有类型检查。后续可逐步扩大交互覆盖；不把每日现有矩阵成功视为桌面打包或设备验收 |

本次文档整合未变更或核验 GitHub 安全设置、分支保护及服务端状态，也未修改 Dependabot 配置或发布流程。2026-10-19 的调度调整及其回退说明属于历史记录；当前主 CI 仍按上文每日完整矩阵运行，不能据此恢复每周运行。CodeQL 的切换、验收和回退按上节单独执行。

## 分层方案与范围

以下是此前节流方案及尚未实施的候选设计；其中“每日 Linux 去重／每周 macOS”已被本次每日完整矩阵要求取代，不能作为当前行为说明。后续目标是缩短开发等待，同时保留正式 PR 和发布所需的真实验证。沿用 GitHub Actions、现有分类器和一次构建复用，不为此引入新的 monorepo 框架。

必须分别计算三个维度：

- **改动范围**：文档、受影响包或全量，由整个 PR 的 base 与待检提交差异决定。
- **执行档位**：Draft 反馈、正式 PR 检查或完整回归，由事件、PR 状态和显式请求决定。
- **平台要求**：通用 Linux 测试和真实 macOS 测试，由测试清单及能力影响关系决定。

Draft 减少执行不改变改动范围。不能把大 PR 的范围伪装成 `docs`，也不能只看最后一次提交，从而漏掉此前失败或尚未验证的修改。共享契约改动仍应扩大到使用方；未知关系保守回退。

### 目标运行矩阵

| 场景 | 必要检查 | macOS 范围 | 完整验证规则 |
| --- | --- | --- | --- |
| 纯文档、Issue 模板 | 对应文档／模板、公开仓库安全、CI 规则和空白检查 | 无 | 明确范围外任务后可通过汇总检查 |
| 正式 PR：Web 或其他局部包 | 受影响包及使用方的构建、类型检查、测试；适用的公共与依赖检查 | 未触及原生能力时不运行 | 所有选中的任务必须真实成功 |
| 正式 PR：Core／Daemon 通用修改 | 受影响包的 Linux 测试；按能力影响关系扩展平台任务 | 无法证明无影响时保留相关 macOS 验证 | 不以目录名或测试名猜测原生影响 |
| 正式 PR：原生沙箱、Host、Office、桌面能力修改 | Linux 拒绝契约、相关通用测试和原生正向／负向测试 | 运行相应真实 macOS 测试组及 helper smoke | 原生验证失败、取消或意外跳过均阻止通过 |
| Draft／备份 PR 推送 | 公共检查、分类与清单契约、适用的快速静态检查 | 默认延后昂贵任务；显式完整运行可覆盖 | 仅表示开发反馈，不能产生完整质量门成功 |
| Draft 转正式评审 | 根据整个 PR 差异补齐正式 PR 所需检查 | 按完整影响范围执行 | 绑定当前待检提交重新验证 |
| main 定时回归（当前） | 每日强制 Linux 与 macOS 完整回归 | 每日完整执行，发布前另行验证 | 不复用历史成功来跳过当天检查 |
| `full-ci` 或手动完整运行 | 完整受支持测试矩阵 | 完整平台验证 | 不受 Draft 延后和定时去重影响 |

候选的每周 macOS 回归尚未接入；若未来实施，用于发现平台环境漂移，不替代涉及原生能力的 PR 检查或发布前验证。当前 Daemon 已分为四个 macOS shard，平台拆分后的任务数量仍须依据清单和测量决定。

### 路径分类收窄

第一阶段只拆已知的误伤路径，保留可解释的回退规则：

| 改动 | 目标选择 | 保守边界 |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/**` | 模板与公共检查 | 修改 CI 工作流本身仍全量 |
| 已登记的文档／检查脚本 | 对应脚本、其测试和公共检查 | 未登记脚本、分类器、任务执行器仍全量 |
| 普通包源码 | 所属包、直接和间接使用方 | 构建继续补齐依赖闭包 |
| 测试与共享夹具 | 所属包和夹具使用方 | 无法识别共享关系时扩大范围 |
| `native/` 和已登记原生接线 | native、相关 Daemon／Host 测试与平台契约 | 涉及共享启动、权限、运行时契约时扩大；未知 native 路径仍全量 |
| 包内 TypeScript／构建配置、可核验且全部 scripts 不变的包 manifest（已实现） | 所属包及消费者；manifest 另选依赖策略 | manifest 身份或 scripts 变化、无法核验时全量；新旧依赖边并集不能丢失消费者 |
| 根配置、workspace、锁文件、补丁、CI 工作流／脚本 | 保留全量 | 文档及明确登记的维护路径例外；未知路径仍全量 |

分类结果应输出命中文件、理由、受影响包、选中任务和平台要求，供 PR 摘要核对。`macos-required` 不能仅由当前的 `daemon=true` 或单个路径正则替代，需要包含共享契约和调用链的影响传播。

### 平台测试清单

先建立受版本控制的通用与真实 Darwin 文件清单，再调整 runner：

1. 每个现有 Daemon discovery 文件必须且只能属于一个默认执行组；两个组的并集等于当前 discovery，交集为空。依赖安全专项和额外 `.contract.mjs`、native smoke 入口另列，分别检查覆盖完整性。
2. 新增、删除、重命名文件必须同步清单。未分类文件使清单契约失败，不能自动忽略或默认为 Linux。
3. 混有 Darwin 正向用例的文件先整文件留 macOS；需要拆文件时另做小切片，并保留原有断言和夹具语义。
4. 原生范围包含 Seatbelt、helper、protected-host staging／bootstrap、真实进程与文件来源 hooks、Office 原生一致性和桌面 computer-use／Cua 能力。最终分组以源码与真实执行证据为准。
5. 迁移时同步更新 `platform-lanes.test.mjs`：保护“原有正向用例仍在真实支持平台执行”和清单守恒，不再只保护固定四个 macOS 分片。

文件级清单只证明测试入口未丢失。验收还必须核对原生正向／负向用例确实执行，避免文件执行了、关键用例却全部跳过。禁止用 mock、放宽生产平台门禁、测试名称过滤或 `continue-on-error` 代替真实原生成功。

### 触发事件与质量门

PR 工作流保留稳定入口，在 job 层选择任务；不要用顶层 `paths` 跳过受保护的整个工作流。以下事件和质量门规则已在 P1 接入，其余平台分组仍待 P2 验证。

- 覆盖 `opened`、`synchronize`、`reopened`、`ready_for_review`、`converted_to_draft`。标签事件不进入 CI 工作流：必需门按名称在该 head 最新一次 CI 运行中解析，任何缺门 job 的运行都会被规则判为缺失并拦截合并。`full-ci` 标签由独立工作流 `full-ci-label.yml` 接管：以 `pull_request_target` 触发（fork PR 才能拿到可 dispatch 的 token），用 head 分支名（而非 SHA）分发一次完整 `workflow_dispatch` 运行；fork 的 head 分支在本仓库没有可寻址 ref，该任务显式失败并提示推送新提交；无关标签不产生任何 CI 运行。`full-ci-label.yml` 只调用 API 分发，绝不 checkout 或执行 PR 代码。`unlabeled` 不触发工作流，移除标签只影响下一次正常运行。
- Draft 使用明确的轻量反馈结果。稳定的完整质量门不能通过 `if` 跳过来表示完成，也不能把延后的任务视为范围外。`quality` 明确失败并说明 `deferred_by_draft_policy`，轻量任务单独显示结果；转正式评审或显式完整运行后补齐。
- 汇总门使用 `always()` 和显式的必需任务集合。选中的任务只有 `success` 可通过；`failure`、`cancelled`、`skipped`、空结果均拒绝。只有分类确认范围外的任务才允许跳过。
- 分类、公共检查、清单校验失败时，汇总门必须失败。文档范围也不能因上游失败而得到成功。
- 完整证据绑定验证提交、PR base 和检查方案。手动运行选择目标分支并默认完整；其他分支或 main 的成功不能代替当前 PR。main 更新后遵守分支保护重新验证的要求。
- 保留同一 PR 新推送取消旧运行。反馈与完整回归若拆工作流，使用不同并发组，避免轻量反馈误取消所需完整验证。

若未来启用 GitHub merge queue，再增加 `merge_group` 事件；当前方案不要求调整分支保护或引入合并队列。

### 定时去重与费用观察

当前主 CI 为每日完整 Linux/macOS 矩阵。下面保留此前的每日 Linux 去重候选设计，尚未接入，也不是本次计划；它需要 P2 的平台分工和可信成功基线，不能直接跳过现有完整检查来模拟。

Linux 每日回归仅在同一提交、同一检查方案已有有效的完整成功证据时跳过。成功基线必须记录提交、工作流／清单版本、运行时与平台配置、任务集合和完成时间；失败、取消、不完整或证据读取失败均不能作为跳过依据。查询以最新可比较的完整尝试为准：同一验证范围后来失败、取消或未完成时，旧成功基线失效，不能从历史挑选一次成功来掩盖新问题。历史运行查询仅在相应 job 增加 `actions: read`，其余权限仍保持最小范围。

成功证据最多有效七天；每周至少一次强制完整 Linux 与 macOS 回归，即使提交不变也执行，检查两种 runner 镜像与外部环境漂移。检查方案或运行时配置变化、显式 `full-ci`、手动完整运行和发布前验证均不复用定时跳过结论。定时回归不增加失败后的自动密集重试。

每次运行分别记录排队时间、页面总时长、各任务运行时间、Linux／macOS 累计任务分钟、测试数量与原生跳过数量。累计任务分钟是性能观察，不能在没有账单证据时称为实际扣额；失败任务已运行的部分也会消耗资源。

独立的 `timing-telemetry` 任务在 `quality` 汇总结束后，尽力保存
`ci-telemetry` artifact（保留 14 天）并写入 GitHub Step Summary。质量门
不依赖该任务；采集、下载、解析、上传或观测任务失败都不改变原有门禁。
质量门失败时仍下载可用分片报告，记录本次运行尝试的 run/job/step 观测、
逐文件结果、Core/Daemon 最大分片文件累计耗时、分片不均衡比和可用报告中的
timeout/leaked-process 计数。job 启动延迟包含依赖等待，不能当作纯 runner
排队时间；并发文件累计耗时不等于分片实际时长；截至已完成任务的经过时间
不等于依赖图关键路径，且不包含仍在执行的任务。run 总时长标为采集时
已观测值，报告缺失也不能据此断言全量测试没有超时或泄漏。先观察至少
5～10 次完整 hosted run，再决定是否调整分片、worker 并发或增加 E2E；当前
不据此承诺固定提速比例。

缓存继续用于锁定依赖和同一次构建输出复用。不得复用与提交、平台或方案不匹配的测试成功。分片缩短等待不一定减少累计费用；不在测量前承诺节省比例，也不把公开仓库、自托管 runner 或增加支出上限当作本轮方案的前提。

## 实施顺序与验收

| 阶段 | 修改边界 | 完成门槛 |
| --- | --- | --- |
| P1：规则与开发阶段分档（已接入） | 分类器、执行策略、CI 工作流、现有 CI 契约测试、本文 | 模板／已登记脚本不误触全量；未知配置仍全量；Draft 不冒充完整通过；转正式和 `full-ci` 标签正确补齐；所有必需任务意外跳过均被拒绝；定时完整矩阵每日运行 |
| P2：平台分工 | 测试清单、Daemon 分片执行器、平台契约、工作流 | discovery 与清单守恒；Linux 通用组通过；原有 Darwin 正向／负向用例实际执行；额外 Linux 拒绝与 native smoke 保留；共享变更正确扩大平台范围 |
| P3：耗时与定时优化（部分实现） | Core／Daemon 分片执行、文件级计时、必要的 CI 任务、定时选择 | Core 四分片与两 worker、普通入口排除、共享计划及计时报表已实现；hosted 性能收益待验证。每日去重／每周 macOS 尚未实现，仍须满足可信成功证据与平台覆盖规则 |

实施前以分类和汇总契约测试覆盖文档、局部源码、共享契约、未知路径、标签、Draft 转正式、平台新增文件、上游失败和意外跳过。P2 在真实 Linux 与 macOS 上验证同一候选提交的原有覆盖后，才允许减少 macOS 任务。P3 对相同任务集合比较改动前后的累计运行时间和等待时间。

首次切换应保留完整矩阵的手动兜底。发现漏分类、原生跳过或质量门误绿时，回退到原有保守全量规则和真实 macOS 范围；修复分类与契约后再启用收窄。

## 开源设计参考

- [Vitest CI（固定提交）](https://github.com/vitest-dev/vitest/blob/f5dd99ed083ba9035f378438e7a9dc9c5ce1c674/.github/workflows/ci.yml#L148-L179)：Linux 承担主测试矩阵，macOS 保留专项任务。借鉴平台分工；Ling 的原生覆盖清单与路径传播仍需自行验证，不能照抄后只留一个 smoke。
- [dorny/paths-filter（固定版本说明）](https://github.com/dorny/paths-filter/blob/f3360c560367c9daf72b88c0e6164162034c5721/README.md)：按路径输出布尔值、文件列表和矩阵，供 job／step 选择；PR 默认仍看相对 base 的整体差异。它不提供依赖图，也不消除大 PR 的累计影响；当前可继续使用自有分类器。
- [Nx affected](https://nx.dev/ci/features/affected)：Git 改动结合项目依赖图，包含受影响项目的使用方。借鉴依赖传播和成功基线，不把项目级选择误称为精确单测选择。
- [GitHub：被跳过的 required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)：解释顶层路径过滤导致 Pending、job 条件跳过与上游失败的区别，是汇总门设计依据。

## 本地检查

只检查 CI 规则和分类，不执行产品全套测试：

```bash
corepack pnpm typecheck:ci-tests
node --test --test-concurrency=1 scripts/ci/*.test.mjs scripts/ci/*.test.ts
node scripts/ci/classify-scope.mjs --files='["packages/core/src/index.ts"]'
node scripts/check-markdown-links.mjs
node scripts/check-public-repo-safety.mjs
```

下面的命令会真实执行一个 Daemon 分片，不是只打印分配；需要构建产物和对应支持平台：

```bash
node scripts/ci/daemon-test-shard.mjs --shard=0 --shard-count=4 --concurrency=4
```

## 未决事项

- **平台清单与能力影响映射尚未验证**：这是 P2 的前置条件；未完成时保留现有完整 macOS 范围，不能只切换 runner。
- **hosted 性能收益尚未验证**：Core 分片、两 worker 和文件级计时已实现；仍须比较同等覆盖下的排队、准备、测试及总时长与累计任务分钟，不能从本地文件计时推导 hosted 加速或费用下降。
- **主 CI 定时去重尚未实现**：当前按本次要求每天运行完整矩阵；上节 CodeQL 的定时基线不适用于该矩阵。若未来重新提出分层或去重，必须满足平台覆盖与成功基线规则。

以上缺口不阻塞 P1。P1 的本地契约验证不能代替 GitHub runner 实际验收，也不能证明原生平台测试已通过；运行额度仍由账户账单决定。
