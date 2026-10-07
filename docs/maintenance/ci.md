# CI 运行方式

CI 分别选择执行档位与改动范围：Draft 减少执行，不缩小整个 Pull Request 的差异。公共检查提供开发反馈，完整质量门只认可实际完成的必要验证。

## 执行档位

| 事件 | 执行方式 |
| --- | --- |
| 无 `full-ci` 标签的 Draft 新建、推送、重开或转回 Draft | `preview`：分类、文档链接、公开仓库安全、CI 规则测试及空白检查；不安装依赖、不构建、不运行产品测试或历史密钥扫描 |
| 正式 PR 新建、推送、重开或转为正式评审 | `complete`：按整个 PR 的改动范围补齐必要检查 |
| 新增或保留 `full-ci` 标签 | 完整执行档位及全仓范围；大小写匹配与 GitHub 表达式一致 |
| 手动运行 | 目标分支上的完整验证 |
| 定时运行 | 默认分支每周一 UTC 03:17（北京时间 11:17）的完整验证 |

工作流监听 `opened`、`synchronize`、`reopened`、`ready_for_review`、`converted_to_draft`、`labeled`。无关标签事件不取消当前验证，使用独立并发组及 `CI label event (no validation)` 检查名称；移除标签不立即触发，影响下一次正常 PR 运行。

同一个 PR 的正常新运行会取消旧运行。工作流没有 `main` push 触发，避免合并后重复完整验证；需要合并后验证时可手动运行。周定时配置合入默认分支后生效。

类型检查、单元测试及 Daemon 的任务条件使用 `!cancelled()`，使手动取消或新推送的自动取消真正终止长任务。只使用 `always()` 时 GitHub 重新计算条件仍为真，任务可能继续运行；汇总门保留 `always()`，明确拒绝取消或未完成的验证。

Draft 公共检查成功不代表完整验证通过。汇总门保留 `Typecheck, unit tests, and Web build` 名称，明确报 `deferred_by_draft_policy`；准备合并前转正式评审或加 `full-ci` 补齐。选中的任务必须为 `success`，失败、取消、缺失或意外跳过均不能通过；只有已确定范围外的任务允许跳过。

## 改动范围

在完整执行档位下，[分类器](../../scripts/ci/classify-scope.mjs)选择最小安全范围：

- 只有 `README.md`、`docs/`、文档资源、`.github/ISSUE_TEMPLATE/**` 或已登记维护脚本变更时，运行公共检查；历史密钥扫描和产品任务跳过。维护白名单仅为 `scripts/check-markdown-links.mjs` 与 `scripts/check-public-repo-safety.mjs`，新增脚本仍保守处理。
- 工作区源码变更沿 workspace 依赖图扩大到直接和间接消费者。文档、模板或白名单脚本与源码混合时继续保留使用方；仅改测试时按既有测试及共享辅助文件规则选择。
- `package.json`、锁文件、工作流、未知脚本、补丁、TypeScript／构建配置和未知路径保守进入全仓范围。`full-ci`、手动与定时运行也使用全仓范围。

分类以整个 PR 相对 base 的差异为依据。大 PR 即使只推送一个小修复，仍可能包含共享 Core、Daemon 或全仓配置的修改；本地通过一个包的测试不等于整个 PR 已完成验证。

## 构建与测试

构建只执行一次 `build:ci` 拓扑构建，`dist` 以短期 artifact 供类型检查、单元测试和 Daemon 分片复用。各包 `test:ci` 只运行测试，不隐式重建依赖。

main 当前使用 Node 22.15.0 和 Linux runner。Daemon 保留四个独立分片及各自的 `LING_STACK_HOME`，每个以 `--test-concurrency=1` 执行；依赖安全专项在 `dependency-policy` 单独运行。这次节流不引入开发分支中的 macOS 原生执行器、额外平台任务或业务代码。

本地测试用于开发反馈；GitHub CI 在干净 runner 上验证远端待检提交、锁定依赖及适用任务。GitHub 不会自动导入本地通过的结果。开发时保持 Draft 可避免每次推送重复完整检查，准备合并时完成一次对应范围的验证。

## 用量与后续优化

Actions 用量按所有任务累计，页面总等待时长不是累计任务时间。并行分片可以缩短等待，但不保证减少用量；不同 runner 的费率也不同。账单中的 consumed usage 与免费折扣相抵时，实际 billable usage 可能仍为零。

当前只降低开发阶段和定时全量的触发次数。Core 耗时、测试并发与平台迁移仍需测量及独立验收，不承诺完整测试从此很快，也不以跳过失败的测试节省额度。账单余额及刷新时间以仓库所属组织的 Billing 页面为准。

## 本地验证

只验证 CI 规则，不执行产品全套：

```bash
node --test scripts/ci/*.test.mjs
node scripts/ci/classify-scope.mjs --files='["packages/core/src/index.ts"]'
node scripts/check-markdown-links.mjs
node scripts/check-public-repo-safety.mjs
```

`node scripts/ci/daemon-test-shard.mjs --shard=0 --shard-count=4` 会真实运行一个 Daemon 分片，需要对应构建产物。
