# 翻译目录自动化实施计划

日期：2026-10-28。状态：实施计划。
契约：[翻译目录自动化方案](translation-catalog-automation.md)

## 切片

1. **通用 PR 选择器**：新增 `scripts/ci/automation-pr.mjs` 与 `scripts/ci/automation-pr.test.mjs`，覆盖正常选择、无匹配、多匹配、跨仓库、非 App 作者、非法 JSON 等失败关闭路径。
2. **PR 内补译工作流**：新增 `.github/workflows/translate-pr-catalogs.yml`（触发路径、同仓库守卫、App 校验与铸令牌、导入 + 翻译、条件提交推送、按 PR 并发组）。
3. **每日兜底工作流**：新增 `.github/workflows/sync-translation-catalogs.yml`（定时 + 手动、仅 main、固定分支 `automation/translation-catalogs`、选择器定位唯一 PR、`--auto --squash --match-head-commit` 自动合并）。
4. **工作流契约测试**：新增 `scripts/ci/translation-workflows.test.mjs`，用模拟 `gh`/`git` 可执行文件真实执行关键 shell 步骤：无 diff 时安全退出、有 diff 时按 App 身份提交、选择器拒绝异常 PR 列表、fork PR 守卫不执行、触发路径与提交路径不相交。

## 验证

- `node --test scripts/ci/automation-pr.test.mjs scripts/ci/translation-workflows.test.mjs` 全绿。
- `git diff --check` 干净；PR CI 全绿。
- 合并后实测：测试 PR 触发自动补译并转绿；`workflow_dispatch` 空跑兜底工作流成功。

## 硬性边界

- 不动其他分支与其他会话的未提交文件；只 `git add` 本文档列出的新增文件。
- 不修改 `provider-model-catalog-pr.mjs`、`sync-provider-model-catalog.yml`、`ci.yml`。
- 不新增 GitHub App 或 secret；复用 `MODEL_CATALOG_APP_CLIENT_ID` / `MODEL_CATALOG_APP_PRIVATE_KEY`。
- 提交作者身份使用仓库约定（gansx）。

## 修订切片（2026-10-28，zh-CN 草稿自动补齐）

1. 抽取 `google-translate.mjs`、`web-locale-sources.mjs` 共享模块，两个既有脚本复用。
2. 新增 `draft-missing-chinese.mjs` + `test/draft-missing-chinese.test.mjs`（无网络桩、幂等、占位符/空值 fail-closed）。
3. 两个工作流加草稿步骤并扩大提交范围；PR 工作流加草稿清单评论（失败降级警告）。
4. `check-i18n.mjs` 缺口降级为信息输出。
5. `translation-workflows.test.mjs` 增加草稿顺序、提交范围、评论降级断言。
