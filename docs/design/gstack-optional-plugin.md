# gstack 可选插件设计

- 状态为实现分支交付，主包解耦、Daemon 接口、插件页入口、版本保留和恢复逻辑已落地。双平台安装版与真实用户验收仍待完成。
- 基线为 2026-11-26 的 Ling `52346c7f8` 和桌面预发布 `v0.6.2-alpha.1`。
- 范围包括 macOS arm64 和 Windows x64 的插件安装、技能加载、任务执行和升级迁移。

## 产品决策

Ling 的主安装包只保留 gstack 的插件入口和接入代码。用户安装或连接上游 gstack，再在需要的工作区启用。新用户离线首次启动时可以打开会话和工作区，并使用可离线的原生功能。插件目录、缓存和依赖的状态只影响相应的 gstack 功能。gstack 通过通用的插件和技能注册入口接入，独有的运行时和宿主映射由其适配模块负责。

gstack 的默认来源是 [garrytan/gstack](https://github.com/garrytan/gstack)。优先复用上游的源码、安装说明和可验证的构建产物，沿用 Ling 已有的宿主适配。若某平台需要由 Ling 提供开箱即用的安装资产，可用同一锁定版本的现有构建产出独立签名资产，复用 [Ling 的官方插件发布机制](plugin-independent-packaging.md)。上游版本与 Ling 适配版本分别记录。

对照版本 `v0.6.2-alpha.1` 的 macOS DMG 为 794,517,399 字节，Windows 安装程序为 743,682,530 字节。该版 macOS 安装后的 gstack 资源约 1.37 GB。主包和独立运行时分别记录归档与解压大小。Chrome 和 TestSavant 模型由独立运行时按需获取。[预发布和验证清单](https://github.com/ling-stack-org/ling-stack/releases/tag/v0.6.2-alpha.1)

## 安装与连接

展开侧栏的“工程”，进入“插件管理 → 技能包”，选择 gstack 或 Superpowers。每项显示安装状态、版本、当前工作区是否启用，以及可用的安装、连接或回滚操作。

| 入口 | 用户操作和结果 |
| --- | --- |
| 从官方来源安装 | Superpowers 的“安装”从固定的官方归档下载并校验。gstack 的“安装指南”提供从固定上游源码准备 Ling 运行时的步骤。 |
| 连接本机安装 | gstack 选择适配当前平台的 Ling 运行目录，并填写来自独立构建记录或可信分发渠道的清单 SHA-256。Superpowers 选择上游仓库根目录或 `skills`。连接成功后，启用开关只作用于当前工作区。 |
| 使用已有 Ling 资源 | 升级时发现已验证的旧内置版本，可在插件页确认启用，复用相同版本资源。 |
| 从技能入口进入 | 显式调用当前工作区不可用的技能包条目时，执行入口提示安装并启用相应技能包。 |

上游 `setup` 按宿主注册技能，当前固定版本支持 Codex、Claude Code 等宿主，Ling 的渲染适配位于本仓。核查时，上游最近三条 GitHub Release 均没有附加的平台二进制资产。因此当前 gstack 入口是官方安装说明加本机连接，已验证的旧 Ling 资源可以直接复用，自动构建入口保留在独立候选准备流程中，尚未在插件页标为“一键安装”。Superpowers 固定提交支持 Ling 内部下载、校验和快照发布。[上游宿主安装契约](https://github.com/garrytan/gstack/blob/47d639abffa882b8cbb641d7d1dedf08ecada9ec/docs/ADDING_A_HOST.md) · [上游发布](https://github.com/garrytan/gstack/releases) · [Ling 宿主适配](../../scripts/gstack/render-upstream.ts)

### 从源码准备 gstack 运行时

在原生 macOS arm64 或 Windows x64 环境运行。准备 Git、Node.js 22.22.1 或更新版本、Bun 1.4.2 或更新版本、Bash、Go 及平台构建工具。脚本从官方仓库获取锁定提交，在独立目录生成运行时。工作目录预算为 12 GiB，构建过程中保留至少 20 GiB 磁盘余量。macOS 可在 Ling 源码根目录执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter '@ling-stack/core...' build
gstack_build_root="$(realpath "$(mktemp -d)")/gstack-runtime"
node scripts/gstack/prepare-desktop-candidate.mjs \
  --workspace "$gstack_build_root" \
  --bun "$(command -v bun)" --shell "$(command -v bash)" \
  --go "$(command -v go)" --local-bounded
```

Windows 使用同一个脚本，在参数中传入 Windows 原生 Bun、Go 和 Git for Windows 的 Bash 绝对路径。生成完成后，在 gstack 条目中点击“连接文件夹”，选择 `$gstack_build_root/artifacts/native/desktop-executable`，填写构建输出 `selection.identity.manifestChecksum` 的值。该目录包含同级的 `gstack` 和 `gstack-browser`。Ling 构建脚本会为技能生成 Ling 宿主指令和绑定清单。Codex 和 Claude Code 的 `setup` 生成各自的宿主文件。当前工作区若曾使用已知的旧 Ling 运行时，插件页会提供“使用上次安装”。

[固定上游提交](../../scripts/gstack/upstream-lock.json) · [独立构建入口](../../scripts/gstack/prepare-desktop-candidate.mjs)

连接本机安装时，先核对来源和版本，再检查技能、引用、工具以及依赖。官方 Git 来源可以用作接入的输入，运行文件需要自己的校验依据。连接成功后，Ling 从只读的已验证版本读取资源。可直接匹配已审核清单的文件复用，缺少验证依据的部分根据固定上游版本和 Ling 适配步骤准备。任一能力的运行文件未就绪时，插件页给出对应状态。用户通过原宿主管理外部安装，Ling 中的“重新检查”预览变化，采纳后作为另一代资源启用。普通的官方技能同步与共享技能导入仍按各自契约管理，它们的技能快照不会成为运行时安装证明。[官方技能来源](managed-official-skill-source-p16.md) · [共享技能发现](external-agent-skill-discovery.md)

## 通用宿主接入

上游负责准备和更新它的文件，Ling 负责识别贡献、登记来源和版本、管理启用，并在任务执行时应用自己的权限。扩展作者可以使用已有的技能目录和插件清单格式。用户也可以用 Ling 的界面完成连接。

| 扩展形态 | Ling 接入方式 | 运行条件 |
| --- | --- | --- |
| 普通技能目录 | 按 [Agent Skills 格式](https://agentskills.io/specification)提供 `SKILL.md` 和引用文件。现有共享入口可在工作区或用户的 `.agents/skills` 中发现，供用户预览、采纳和分配。 | 技能可以使用该任务已开放的 Ling 工具。共享导入可把脚本留作来源档案，执行脚本需要相应的运行时接入。 |
| 带工具的技能包 | 使用现有 `.ling-plugin/plugin.json`，声明 `skill-pack` 贡献及其资源路径。可复用的工具优先接入现有 MCP 贡献或已支持的运行时。 | Ling 验证来源、插件和接口版本、平台、工具及依赖。各工作区按现有策略启用和授权。 |
| 依赖特定宿主的扩展 | 适配器把上游的工具调用映射到 Ling 已有能力。例如 gstack 的提问映射和受管 `browse` 启动。 | 依赖宿主专用 hook、工具或 API 的工作流需验证对应适配。缺失项在预览中标明，其他符合条件的技能仍可接入。 |

共享技能和插件沿用各自现有的来源与信任规则，共用技能发布、分配和执行入口。插件注册输入沿用插件 ID、版本、贡献类型和路径。Ling 读取并验证这些声明，记录已验证摘要，检查命名冲突后再登记。权限由任务和工作区的现有设置决定。同名但归属不同的技能在预览中显示为冲突。同一来源更新时，现有定义和任务绑定按既有快照规则处理。[共享技能发布规则](external-agent-skill-discovery.md#publish-semantics) · [插件 SDK](internal-registry-plugin-sdk.md#modular-contribution-contract)

设置页调用 daemon 完成状态读取、连接、登记、启用、停用、卸载和回滚。gstack 连接要求用户选定已经准备好的 Ling 运行目录，Superpowers 可以从固定官方归档下载。后续可以在 `setup --host ling` 中调用同一登记流程的 CLI 入口，两种入口都应复用同一份 daemon 记录。[现有 CLI](../../packages/cli/src/main.ts) · [技能包路由](../../packages/daemon/src/features/skills/optional-pack-routes.ts)

## 状态与工作区行为

| 状态 | 行为 |
| --- | --- |
| 未安装 | 新工作区的自动技能选择跳过 gstack，显式选择可跳转到插件页。 |
| 正在准备 | 操作按钮显示处理中。并行的 Superpowers 官方安装共用一次下载。 |
| 已安装，当前工作区未启用 | 文件可供本机其他工作区复用，用户可以在当前工作区启用。 |
| 已启用 | 注册和分配当前版本可用的技能。需要 Chrome、模型或其他组件的动作按各自状态提示。 |
| 缺少依赖或版本不兼容 | 显示受影响的能力和补救操作，其余已验收的能力按已知状态使用。 |
| 安装失败或资源损坏 | 主窗口和普通任务可用。首次安装可重试，更新失败时保留原先可用版本。发生损坏的资源暂停执行并可修复。 |

Node、Bun 和 `browse` 随独立的 gstack 运行时准备。Chrome 和模型在相关功能首次使用时按需获取，已验证的缓存可离线复用。技能需要的外部服务由相应工作流处理。

## 运行边界

```mermaid
flowchart LR
  A[插件页] --> B[Daemon 插件管理]
  C[官方来源或用户选定的安装] --> B
  B --> D[验证并保留本机版本]
  D --> E[工作区启用与技能注册]
  E --> F[任务绑定准确版本]
  F --> G[Ling Runner 与现有审批]
  D --> F
```

- **桌面构建与启动**负责正常启动并提供插件入口。把 gstack 资源准备、原生构建、打包、归档校验和浏览器冒烟搬到插件的发布或接入验收。主包验证改为断网且不存在 gstack 时仍可启动，并检查归档里已没有 gstack 运行文件。启动路径上的缓存缺失、损坏和保留超限转成插件状态。[桌面构建流程](../../.github/workflows/desktop-prerelease.yml) · [延迟资源解析](../../packages/daemon/src/features/skills/packaged-resolution.ts) · [归档验证](../../scripts/release/verify-desktop-package.mjs)
- **插件管理**复用现有安装记录、启停、更新、回滚和审计。已验证资源按摘要保存在用户缓存，工作区记录自己的选定版本和启用状态。完整 gstack 资源超过当前远程安装器的 1 GiB 解包上限。若提供独立签名资产，下载与解包路径需验证容量、文件数、签名和完整文件清单。[下载安装器](../../packages/daemon/src/features/plugins/remote-package.ts) · [原生运行时验证](../../packages/core/src/official-plugin-runtime.ts)
- **技能管理**为 gstack 注册 `skill-pack` 贡献。现有远程贡献接入只处理 MCP，技能装载沿用 gstack 的原子发布、稳定技能 ID、完整正文和依赖校验。只有启用且可运行的条目进入自动选择。既有模板和工作流中对 gstack 的绑定保留，缺少插件时有明确状态。`implement`、`checkpoint` 等 Ling 原生能力由 Ling 注册，独立可用。[插件贡献接入](../../packages/daemon/src/features/plugins/install.ts) · [有效技能列表](../../packages/daemon/src/features/skills/registry.ts) · [技能来源发布](../../packages/daemon/src/features/skills/bundled-startup.ts)
- **任务执行**从已验证版本解析入口和兼容运行时，以绝对路径运行 gstack 工具，状态与工作区或任务隔离。已装、工作区已启用、能力可用是独立判断。工具调用沿用 Runner 的工作区权限、审批和审计。技能文本、项目目录或继承的 `PATH` 无权替换受管入口。宿主未提供的能力按实际状态显示。浏览器的内容安全处理沿用现有契约，组件失败按对应的不可用语义处理。[运行绑定](../../packages/daemon/src/features/skills/packaged-runtime.ts) · [宿主工具映射](../../packages/daemon/src/features/runs/gstack-host-context.ts) · [浏览器启动](../../scripts/gstack/packaged-browse-launch.mjs)

## 升级、恢复和卸载

1. **从内置版升级。** 保留已有技能快照、用户改动、审批、队友绑定和工作区状态。按需复验旧的 `sources/bundled-gstack` 缓存，同一摘要复用同一份本机文件。首次升级前已经绑定版本的任务可以按原绑定恢复，工作区明确停用插件后暂停相关恢复。新的 gstack 任务在用户启用插件后进入。已有技能记录本身不会触发下载或启用。
2. **任务固定版本。** 现有绑定继续记录资源清单摘要、上游提交、Ling 适配版本和技能来源摘要。运行中和待恢复任务按快照查找相同代。缺少或损坏时给出“准备此任务使用的版本”入口，保留历史和产物。只有通过原摘要验证的同一版本可继续该任务。
3. **更新与回滚。** 新版本先进入暂存，校验通过后原子切换本机选择。工作区在启用和加载技能时按该版本发布完整技能批次，失败可重试。保留跟随、固定、回滚、已有草稿和归档语义。已开始的执行继续使用自己的绑定。网络异常、并发安装、校验失败和磁盘容量不足都仅影响这次更新。
4. **停用与卸载。** 停用立即阻止当前工作区获取新的 gstack 执行权限，进行中的执行通过既有取消流程收尾。卸载撤销新执行的可用资格并保留任务快照、用户文件和审计。插件页显示供其他工作区和待恢复任务使用的保留版本。只有确认无引用的受管文件可以回收。仍缺少跨工作区引用证明时，延后回收或更新，Ling 照常启动。连接的外部安装由其原宿主管理。[既有保留规则与迁移证据](plugin-independent-packaging.md#原生运行时)

## 实施顺序与验收

| 顺序 | 交付 | 验收 |
| --- | --- | --- |
| 1. 解耦启动与技能列表 | 启动按普通应用就绪，gstack 状态延迟解析，保留现有任务身份 | 无 gstack、无用户缓存、断网启动可打开主窗口并运行非 gstack 任务。坏缓存或第三代延后时也可使用主程序。 |
| 2. 接通可选安装 | 复用插件页，接通通用 `skill-pack` 贡献登记和 gstack 适配。确认两平台采用的安装路径。 | macOS arm64、Windows x64 从干净环境走通相应安装路径和已有安装连接。用另一份不含 gstack 运行时的技能包验证同一登记和工作区启用流程。只读检测时宿主文件无变化。失败、取消、缺依赖、代理和平台限制有对应状态。 |
| 3. 接通运行与迁移 | 工作区启停、技能加载、准确版本解析、旧配置迁移和回滚 | 代表性的评审、浏览器和 PDF 工作流实际执行。验证工作区隔离、现有审批、两个版本并存、更新失败、断网复用、重启后恢复原版本及卸载后保护用户数据。覆盖上游能力列表中的真实前置条件。 |
| 4. 切换桌面发行 | 默认主包去掉 gstack 及其构建前置条件，插件另行验收并记录发布证据 | 双平台安装、升级、冷启动和归档清单校验。记录主包和 gstack 分开下载、安装后的占用以及下载并发，签名版补齐对应平台验收。 |

第 2 步需要回答两个发布问题。固定的上游版本能否在两平台满足 Ling 的兼容性和执行验证，以及干净机器能否通过选定入口准备运行时。连接方式和官方安装路径通过验证即可支撑外置发布。若要求两平台都在无开发工具的机器上直接完成一键安装，并且上游尚无可用安装资产，则用现有构建产出独立签名插件资产。同一版本的技能和工具接入规则适用于两种来源。
