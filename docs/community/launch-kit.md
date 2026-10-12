# Ling Stack 首发与首批用户验证材料

这份材料供维护者审核、复制和发布。它不代表帖子已发布、用户已邀请或演示已验收。
新文档合入默认分支后再发布包含其链接的帖子；录像、截图和用户反馈只在实际取得后补充。

## 一句话介绍

**Ling Stack 是一个本地 AI 协作工作台：在同一个项目中组织使用不同模型的 AI 队友，集中查看对话、工具活动、审批和结果。**

首发面向已有模型 API 使用经验、愿意从源码运行的开发者。先展示一个小任务，不把媒体生成、Office 或 Computer Use 作为首轮体验的必需项。

## 发布口径

- 当前是 MIT 许可的 **source-first Alpha**，默认试用路径是从源码启动 Web UI、daemon 和 CLI。
- 模型由用户自行配置，API key 和模型费用来自自己的 provider 账号；模型检查也会联系 provider，可能产生费用。
- 工作区状态、对话历史和运行证据保存在本地；请求及其上下文会发送给用户选择的模型或工具 provider。不要称为“完全离线”或“所有数据不出本机”。
- 队友的角色或 skill 不会自动授予工具和文件权限。工具可用性取决于配置、工作区权限和平台就绪情况。
- 桌面安装包属于开发预览。稳定签名安装包、正式生产发行版和部分原生集成仍有独立验收门槛。
- 宣传材料不能把某个 provider、平台或工具的局部成功推广为全部支持；不承诺无人值守完成任意任务。

口径来源：[README](../../README.md)、[入门指南](../getting-started.md)、[支持范围](../../SUPPORT.md)、[实现状态](../design/implementation-status.md)和[桌面开发包说明](../release/development-packages.md)。

## V2EX 首发稿

**标题：** 我开源了 Ling Stack：在一个本地项目里组织不同模型的 AI 队友

我做了一个本地 AI 协作工作台 Ling Stack，最近开放了源码，MIT 许可，目前是 Alpha。

想解决的问题比较具体：用几个模型处理同一个项目时，任务说明、各自的回复、工具操作和结果容易散在不同窗口里。Ling 把它们放进项目频道，也可以先从普通模型对话开始。

目前可以给队友分别配置模型和允许使用的工具，在频道里提出任务，再集中查看参与者回复、工具活动、审批请求、产物和最终报告。界面支持中文和英文。

第一次试用建议做一个小任务：让两个队友分别检查一份项目说明的需求边界和验收条件，再检查 Ling Agent 汇总是否有用。这里有[项目文档评审步骤](https://github.com/ling-stack-org/ling-stack/blob/main/docs/community/first-project-review.md)，欢迎照着跑，也欢迎指出哪一步没有跑通。

先说明使用边界：当前默认从源码启动 Web UI + 本地 daemon + CLI，需要 Git、Node.js 22.22.1+、pnpm 10 和自己的模型 API key，费用由自己的 provider 账号承担。工作区状态和历史保存在本机，但请求及其上下文会发给你选择的模型或工具 provider。桌面包仍是开发预览。

我希望先找一些正在使用多个模型或 Agent 的开发者试用，最想知道两件事：第一次任务在哪一步卡住，以及这个频道是否比你现在的工作方式更方便。遇到问题可以通过仓库的 Issue 表单反馈；请勿上传密钥和私人项目数据。

仓库：[ling-stack-org/ling-stack](https://github.com/ling-stack-org/ling-stack)。如果这个方向对你有用，欢迎 Star，方便后续关注。

## 掘金首发稿

**标题：** 开源 Ling Stack：把不同模型的 AI 队友放进同一个项目

### 为什么做这个项目

用多个模型处理一个项目时，除了获得回答，还需要保留任务背景、比较不同意见、检查工具操作和收集最终结果。聊天窗口多了，这些信息也会分散。

Ling Stack 尝试把这段工作过程放进一个本地工作台。你可以从一次普通对话开始，也可以创建项目频道，给 AI 队友配置模型和工具，再围绕同一个任务协作。

### 第一轮先体验一个小任务

我把首轮体验收窄到项目文档评审：用一份不含私人数据的项目说明，让两个队友分别检查需求边界和验收条件。最后查看频道中的意见、运行详情和 Ling Agent 汇总，判断它们是否回答了原来的问题。

完整步骤在[项目文档评审指南](https://github.com/ling-stack-org/ling-stack/blob/main/docs/community/first-project-review.md)。这是供你复现和反馈的试用流程；模型输出会因 provider、模型和提示词而变化。

### 现在可以做什么

- 在 Model Workbench 中配置和检查模型，用自己的 provider API key 发起对话。
- 为队友配置模型和允许使用的工具，在项目频道中组织协作。
- 在同一个频道查看参与者回复、工具活动、审批请求、产物和最终报告。
- 在本地保存工作区状态、对话历史和运行证据，使用中文或英文界面。

工具和文件访问由工作区权限控制。给队友写了角色说明或绑定 skill，并不等于授予它工具权限；平台原生能力还有各自的就绪和验收要求。

### 怎么试用

项目使用 MIT 许可，目前是 source-first Alpha。建议按[入门指南](https://github.com/ling-stack-org/ling-stack/blob/main/docs/getting-started.md)从源码启动 Web UI、本地 daemon 和 CLI，再配置一个聊天模型。需要 Git、Node.js 22.22.1+ 和 pnpm 10。

模型配置、API key 和费用来自你自己的 provider 账号；检查模型也会发出请求，可能产生费用。工作区状态和历史保存在本地，但请求和上下文会发送给你选择的模型或工具 provider。“本地工作台”不等于离线推理。桌面包属于开发预览，稳定安装包和部分原生功能仍有独立验收门槛。

### 想请你帮忙验证什么

第一轮更关心真实体验：是否能按照指南完成启动和第一条模型回复；能否完成这次文档评审；哪一步需要猜；Ling Agent 汇总是否减少了你整理意见的工作。

问题可以通过[Issue 表单](https://github.com/ling-stack-org/ling-stack/issues/new/choose)反馈，中文和英文都可以。附上版本或 commit、系统、最小复现和脱敏报错即可，不要上传密钥、数据库或私人模型内容。

仓库：[ling-stack-org/ling-stack](https://github.com/ling-stack-org/ling-stack)。如果你也需要这种协作方式，欢迎 Star，关注后续改进。

## Show HN draft

**Title:** Show HN: Ling Stack – A local workspace for AI teammates

**Submission URL:** https://github.com/ling-stack-org/ling-stack

**Author comment:**

I built Ling Stack to keep work with several AI models in one project workspace: the task, teammate responses, tool activity, approval requests, artifacts, and final report.

You can start with a regular model conversation, or create a project channel and give teammates their own model and permitted tool bindings. The interface supports English and Chinese. The project is MIT-licensed and currently a source-first alpha.

For an initial trial, I suggest a small document review: ask two teammates to inspect a sample project brief from different perspectives, then ask the Ling Agent to summarize their reviews and check whether the summary is useful. The [walkthrough](https://github.com/ling-stack-org/ling-stack/blob/main/docs/community/first-project-review.md) is intended as a reproducible trial, rather than a promise of identical model output.

The recommended starting path is the Web UI, local daemon, and CLI from source. It requires Git, Node.js 22.22.1+, pnpm 10, and your own provider configuration and API key. Your provider account handles model charges; readiness checks may also incur charges. Workspace state, conversation history, and run evidence stay local, but requests and their context go to the model or tool providers you choose. This is not an offline inference claim.

Desktop packages are development previews. Stable signed installers, production support, and some native integrations still have separate release and acceptance gates. A teammate role or skill does not automatically grant tool or filesystem access.

I'd especially value feedback from developers already using several models or agents: where does the first task get stuck, and does the project channel make it easier to compare and collect the results? Bug reports and questions are welcome through the repository's issue forms; please redact credentials and private data.

Repository: [ling-stack-org/ling-stack](https://github.com/ling-stack-org/ling-stack). If it is useful to you, a star helps you follow its progress.

## 首批用户邀请文案

这是可复制的邀请草稿，尚未发送。只联系对这个方向有兴趣的人，按对方回应继续，不批量群发。

> 我刚开源了 Ling Stack，一个把不同模型的 AI 队友放进同一个本地项目的工作台，目前是源码 Alpha。想找正在使用多个模型或 Agent 的开发者，试一遍小型项目文档评审，并告诉我哪里卡住、结果有没有用。需要从源码启动，并使用自己的模型 API key，费用由自己的 provider 账号承担；本地保存历史，但任务上下文会发送给所选 provider。桌面包仍是开发预览。第一次试用不需要接入私人项目，可以用公开示例。你有兴趣的话，可以先看[试用步骤](https://github.com/ling-stack-org/ling-stack/blob/main/docs/community/first-project-review.md)，反馈通过仓库 Issue 表单提交即可。
>
> 仓库：[ling-stack-org/ling-stack](https://github.com/ling-stack-org/ling-stack)。如果方向适合你，欢迎 Star，方便关注后续更新。

## 反馈收集清单

只记录定位问题所需的信息。用户不愿公开时，先将问题缩成不含私人内容的复现，不要求提供工作区数据库或完整日志。

| 信息 | 记录方式 |
| --- | --- |
| 试用环境 | 系统、运行方式、版本或 commit；源码试用再记录 Node/pnpm 版本 |
| 原有工作方式 | 当前用什么完成类似任务，为什么想试 Ling |
| 启动结果 | 安装、构建、打开 Web UI 是否完成；卡住的具体步骤和脱敏报错 |
| 模型结果 | 首条真实回复是否成功；只记录 provider/模型类别，不收集 key、私有 endpoint |
| 首个任务 | 是否完成文档评审，两个队友是否参与，Ling Agent 汇总是否回答问题 |
| 所需帮助 | 哪一步需要维护者解释或介入；没有帮助能否继续 |
| 结果价值 | 哪条意见有用或无用，是否减少比较、整理或遗漏检查的工作 |
| 后续意愿 | 是否愿意用于另一个实际任务；不愿意时记录首要原因 |
| 可公开材料 | 截图和引语仅在脱敏且本人明确同意后使用 |

建议用以下格式提交到相应 [Issue 表单](https://github.com/ling-stack-org/ling-stack/issues/new/choose)：

```text
版本或 commit：
系统与运行方式：
尝试的任务：
预期结果：
实际结果：
首次卡住的步骤：
最小复现与脱敏报错：
结果对我有用 / 无用的原因：
```

## 7 天行动表

“第 1 天”从开始本轮验证时算起。目标是邀请 5–10 位适合的用户，并争取至少 3 位尝试；这是行动目标，不是已有用户数或成功承诺。每天按实际反馈调整，Star 仅作为辅助观察。

| 时间 | 行动 | 当天产物与完成标准 |
| --- | --- | --- |
| 第 1 天 | 维护者在干净样例中走完入门和两队友文档评审；记录每一步 | 明确实际通过、失败和未执行范围；有卡点就先修复或在指南中写清 |
| 第 2 天 | 准备真实截图或短录屏，审核 README 和首发稿 | 画面显示任务与结果；遮盖 key、私有路径和数据；仅使用实际验收的效果 |
| 第 3 天 | 维护者选定 5–10 位目标用户，用上面的草稿发起邀请 | 记录是否愿意试用及约定反馈方式；不将未回应算作试用，不代用户填反馈 |
| 第 4 天 | 跟进愿意试用的人，收集第一次任务的完整反馈 | 区分独立完成、需要帮助、未完成；列出出现频率最高的三个卡点 |
| 第 5 天 | 优先解决一个影响首次任务的主要卡点，更新指南 | 复现问题后修复或给出明确绕行；请遇到问题的人再试，记录结果 |
| 第 6 天 | 指南和演示通过后，由维护者在一个匹配的中文社区首发 | 根据社区规则选版块；发真实案例与限制；回复问题并链接可复现步骤 |
| 第 7 天 | 整理首轮结果；决定是否扩到其他社区或 Show HN | 记录实际尝试人数、任务完成情况、主要问题、下一项改进；首轮仍卡住时先继续修复 |

首轮判断依赖任务结果：至少有真实用户完成任务且说明用途，再扩大传播。无人尝试时核对目标用户和邀请方式；有人启动却无法完成任务时优先修复体验；完成后仍不用时重新确认场景价值。不要把增长停滞默认归因于宣传不足。

## 发布前最后检查

- 确认本文件和[项目文档评审指南](./first-project-review.md)已合入默认分支，帖子中的链接可访问。
- 逐段核对当前 README、支持范围和实际演示；删去已过期或尚未验证的承诺。
- 只有真实完成验收后，才添加演示视频、结果截图或“已经跑通”的表述。
- 社区帖子和个人邀请由维护者审核后发送；录屏和引用他人反馈要有相应授权。

**未决事项：** 首轮模型与平台的实际验收结果、演示素材、邀请对象和发布社区时机尚需实际执行后确定。这些不影响准备材料；在结果与素材确认前发布效果宣传，会使读者无法核对承诺。
