# 翻译目录自动化方案

日期：2026-10-28。状态：**已实施（#608），zh-CN 草稿自动补齐为 2026-10-28 修订。**

来源：用户评审对话（翻译流水线是否可做成仓库 CI/workflow，参照模型目录同步任务）。本文落定后，翻译目录自动化的实施与验收以本文为准。

## 1. 背景与现状问题

仓库的翻译流水线是四段式：

1. 源文案：`apps/web/src/i18n/locales/en-US.ts`、`zh-CN.ts` 与 `packages/localization/catalogs/additional-source.json`、`additional-zh-CN.json`。
2. `catalog:import-legacy`：把 TS 源与 additional JSON 导入为 `catalogs/en-US.json`、`catalogs/zh-CN.json`（带防止丢文案的断言）。
3. `catalog:translate`：以 en-US 为源，经 Google 免费翻译端点增量补齐 53 个目标语言（按 sourceHash 复用未变更条目，受保护 token 与占位符校验，原子写入）。
4. `catalog:check`（CI 必跑）：校验所有语言的 key 完整性、sourceRevision/sourceHash 新鲜度、占位符一致性。

现状痛点：第 2、3 步靠作者本地手动执行。漏跑就出现 #599 的情况——PR 的翻译完整性检查红，需要人工补跑 55 个语言的翻译再推 commit，来回一轮就是几十分钟。

## 2. 目标与原则

目标：源文案变更进入 PR 后，机器人自动完成导入与增量翻译并把结果提交回 PR 分支，CI 自动转绿；main 上的漂移由每日兜底任务自动开 PR 合并。全程不需要作者本地跑翻译脚本。

原则：

1. 翻译质量门禁不放松：所有校验（占位符、受保护 token、非空、sourceHash 一致）沿用现有脚本，机翻结果必须通过 `catalog:check` 才会被提交。
2. 写权限最小化且 fail-closed：复用已安装的模型目录 GitHub App（contents + pull-requests 写权限），App 配置缺失时直接失败，不 fallback 到 GITHUB_TOKEN 推送。
3. 不信任 fork 代码：只对同仓库分支的 PR 自动写回；fork PR 跳过并给出人工指引。
4. 无回路：机器人提交的 commit 只触碰 `packages/localization/catalogs/*.json`，不在触发路径内，不会自我唤醒。

## 3. 方案

### 3.1 PR 内自动补译（主链路）

新工作流 `translate-pr-catalogs.yml`：

- 触发：`pull_request` 的 `opened / synchronize / reopened / ready_for_review`，路径过滤仅四个真源文件（两个 TS locale、两个 additional JSON）。
- 守卫：`github.event.pull_request.head.repo.full_name == github.repository`，仅同仓库分支执行；fork PR 整job 跳过。
- 步骤：checkout PR head（不持久化凭据）→ 校验 App 配置 → 铸造仓库级 App token → 运行 `import-legacy-web-catalogs.mjs` 与 `translate-catalogs.mjs` → 仅当 `catalogs/*.json` 有 diff 时，以 App bot 身份提交并推送到 PR head 分支。
- 并发：按 PR 编号分组，`cancel-in-progress: true`，新 push 取消旧翻译。
- 时限：20 分钟（典型增量为数十个 key × 53 语言，实测分钟级）。

### 3.2 每日兜底（辅链路）

新工作流 `sync-translation-catalogs.yml`，结构与 `sync-provider-model-catalog.yml` 对齐：

- 触发：每日定时 + `workflow_dispatch`；仅在 main 上运行。
- 步骤：checkout main → App token → 导入 + 翻译 → 有 diff 则推送到固定分支 `automation/translation-catalogs` → 用 PR 选择器脚本找到该分支唯一的 App 自建开放 PR（不存在则创建）→ `gh pr merge --auto --squash --match-head-commit`。
- 该 PR 走正常 CI 与 ruleset 门禁（必需检查 + 评审线程），由 App 身份触发 CI，无需人工批准 workflow。

### 3.3 PR 选择器复用

新增通用脚本 `scripts/ci/automation-pr.mjs`（`provider-model-catalog-pr.mjs` 的通用化副本，参数化分支名与 App slug，报错信息去业务化），配套 `*.test.mjs`。原模型目录脚本不动，避免扩大影响面。

## 4. 安全分析

| 风险 | 缓解 |
|---|---|
| fork PR 注入恶意翻译脚本骗取写权限 | 同仓库守卫直接跳过；同仓库作者本身已有写权限，风险不扩大 |
| App 私钥泄露面扩大 | 沿用现有 secret，不新增凭证；steps 全部 `persist-credentials: false`，只在推送 step 注入 |
| 机器人自触发循环 | 触发路径与提交路径不相交；并发组兜底 |
| 机翻错误进 main | `catalog:check` 是 CI 必需检查的一部分；每日兜底 PR 同样过完整门禁 |
| Google 端点限流 | 脚本自带指数退避（10 次重试）；失败只影响该次运行，可手动重跑 |

## 5. 验收标准

1. 工作流与脚本的契约测试在 `node --test scripts/ci/*.test.mjs` 下通过（含以模拟 gh/git 可执行文件真实跑 shell 步骤）。
2. 本仓 PR CI 全绿后合并。
3. 合并后用一个测试 PR 改动 `en-US.ts` 验证：机器人自动提交翻译 commit → 翻译完整性检查转绿；随后关闭测试 PR 并删除其分支。
4. 每日兜底工作流在 Actions 列表中可见且启用，手动 `workflow_dispatch` 空跑成功（无 diff 时安全退出）。

## 6. 非目标

- 不引入人工审校流程，不评估/更换翻译供应商。
- 不改变 `catalog:check` 的任何判定标准。
- 不为 fork PR 提供自动写回；fork 作者仍按 CONTRIBUTING 指引本地运行 `catalog:translate`。
- 不重构 `provider-model-catalog-pr.mjs` 等既有自动化脚本。

---

## 7. 修订（2026-10-28）：zh-CN 缺失草稿自动补齐

### 背景修订

原方案假设 en-US/zh-CN 均由人认真撰写，因此 `check:i18n` 对"en 有 zh 无"硬失败。实际工作流中两种源文案都由 agent 生成，缺 zh 属疏忽而非态度，与其余 53 个语言的机翻兜底行为不一致。

### 修订内容

1. 新增 `packages/localization/scripts/draft-missing-chinese.mjs`：找出"英文源有、中文源无"的 key（TS 字典与 additional JSON 两个容器都覆盖），经同一 Google 端点机翻 zh-CN 草稿，做与主翻译相同的占位符/受保护 token/非空校验，然后写回**真实源文件**（TS 字典 key 追加到 `zh-CN.ts` 根部；additional-only key 写入 `additional-zh-CN.json`）。草稿进入源文件后，import、parity 检查、PR 评审都按正常内容对待。
2. 两个工作流在 import 之前先跑草稿脚本；提交范围扩大到 `zh-CN.ts` 与 catalogs。机器人推 zh-CN.ts 会再触发一次 synchronize，该次运行经无 diff 出口收敛，不构成循环。
3. PR 工作流在推送后尝试用 `gh pr comment` 列出本次机翻草稿的 key 清单，供人工润色；评论权限不可用时降级为警告，不影响主流程。
4. `check:i18n` 的 en/zh 缺口（`englishOnlyKeys`、`missingChinese`）从硬失败降为信息输出；重复 key 仍为硬失败。
5. 共享模块抽取：`google-translate.mjs`（端点调用）、`web-locale-sources.mjs`（TS 字典与 additional 解析），`translate-catalogs.mjs` / `import-legacy-web-catalogs.mjs` 改为复用，行为不变。

### 明确不做的

- 不处理"只有中文没有英文"的方向（en 缺失时 import 回退为 key 原文，历史上即如此）。
- 不给机翻草稿加永久标记；可见性靠 bot commit 与 PR 评论。
