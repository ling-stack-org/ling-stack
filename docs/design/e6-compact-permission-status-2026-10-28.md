# E6 紧凑权限统一检查点 — 2026-10-28

Status: DONE_WITH_CONCERNS — implementation verified; not packaged/macOS acceptance, not merged.
Base: `22204d64f5fab1ca0cdd81b5cedad6477ae8d050`, `codex/e6-safe-continuation`.

本记录保留实现和验证结束时的快照。用户随后已要求提交并创建检查点草稿 PR；下文“未提交/未推送”是该验证阶段的历史状态，后续传输状态以 Git 和 GitHub 读回为准。创建草稿不代表允许合并、完成客户端验收或发布。

## 需求和根因

用户确认：普通会话、频道、队友私聊共用一个紧凑权限入口；独立沙盒配置放设置。
#584 只简化普通会话，设计明确保留另外两个 surface 的独立菜单；四个相关源码在
此前 E6 HEAD 与 main 一致。这不是旧包或本次 main 合并丢失代码。

## 实现

- 三种 Composer 都使用 `shared/conversation/ConversationPermissionControl.tsx`，
  不再各自组合授权菜单和沙盒菜单；保留各自的运行锁定提示。
- 请求审批/帮我审批只改变审批模式；完全访问经本会话确认才切换为
  `always + full_access`，离开时恢复先前沙盒，无先前值则用工作区默认值。
- 频道/私聊共用 selection controller，拒绝迟到的确认、ABA owner/policy
  切换、运行锁定和卸载后的回执；失败进入现有 surface 错误展示。
- 普通会话保留既有经过验证的 thread/draft 绑定与权限选择控制逻辑，仅改共享 UI import。
- 任务 Inspector 删除旧沙盒编辑器，只读显示权限摘要并跳转设置的默认授权页。
- 确认框返回焦点时解析菜单的 `aria-labelledby`，记录持久 trigger 而非即将卸载的菜单项。
- Settings 保存的是当前工作区默认值。没有增加机器级授权，没有合并三种会话的
  授权 scope，没有更改 Daemon、SQLite、真实权限数据或已运行任务的快照。

## 证据

所有下面的浏览器检查均使用 mock HTTP/SSE，不是实际模型调用或 packaged App。

| 检查 | 结果 |
| --- | --- |
| 新用例的初始有效 RED | 普通通过，频道/私聊因没有共享紧凑 trigger 失败（1 pass / 2 fail） |
| Selection controller 单测 | 16/16，包括取消、恢复、ABA、锁定、卸载和异常 |
| 最终 Web 单测 | 1085/1085，`web-unit-final.log` |
| 最终权限/设置/Inspector/Composer ownership 浏览器组合 | 27/27 |
| 频道任务实际 adapter 请求与确认焦点 | workspace request 用例通过；焦点修复后 full-access 用例通过 |
| Web TypeScript、lint、git diff --check | 通过 |

目录：`output/e6-20260928/compact-permission-unification-20261028/`。
`final-combined-results` 为最终 27 项；`final-parity-results` 为三种菜单、退出完全访问后的
实际请求参数及“从 Inspector 进入 Settings 修改，三种 Composer 继承”的 4 项检查。

## 没有被算成通过的检查

- 早期新增测试忘传 `createBaseState` 参数，3 项在 fixture 构造阶段报错；不算产品 RED。
- 原 `teammates.spec.ts:1200` 期待一个 blocked lineage diagnostic，实际为 0。
- 原 `ui2-normal-conversation-feed-composer.spec.ts:142` 期待没有独立 reasoning-summary
  控件，实际找到 1 个。未改这些失败断言、超时或重试策略。
- 后两项在未修改 HEAD 的独立源码快照上，同样在上述位置失败，见
  `baseline-final-results/`。是本次改动之前已有的回归/契约差异，根因修复仍待安排。
  最初两次 baseline 快照缺少 Desktop shared 输入/依赖而无法加载，不是有效对照；
  补齐冻结输入并重新启动后，只有最后一次对照用于上述归因。

## 待办与交付边界

### 同日后继：完全访问语义与文案

用户确认：本会话经明确确认后，同时启用自动审批与 Full Access；系统权限和 Host 拒绝规则仍有效。

- 共享菜单改用“完全访问权限”，按钮继续显示短名称“完全访问”。菜单说明和确认框明确上述语义，并保留工作区外访问风险、会话范围和禁用工具说明。
- 沿用已有 `always + full_access` 成对切换与确认凭据；没有更改 Daemon enforcement、系统权限或任何全局默认值。
- 33 项权限/确认 scope/翻译否定语义单测通过；TypeScript、Web i18n audit、lint、diff check 通过。
- 浏览器组合 17/17：三种会话的 `smart + read_only` 与 `always + full_access` 请求参数；后者还校验 `permissionConfirmation`，同时覆盖取消、恢复与继承确认。另补中文桌面和 390px 窄屏菜单/确认框检查。全部使用 mock HTTP/SSE，不是 packaged App 或真实 Daemon 执行验收。
- 中英文三条新增消息已完整翻译。原有翻译服务两次 TLS ECONNRESET，其他 53 个 locale 仅对新增三条采用显式英文兜底；全部既有消息逐项核对未变。55/55 catalog audit 和编译通过，不把英文兜底称为已翻译。
- 证据目录：`output/e6-20260928/full-access-semantics-20261028/`，组合报告为 `browser-results.json`；初版窄屏截图捕获到过渡帧，保留但不作为静态外观结论，后继截图使用 Playwright 的有限动画终态截取。
- 本后继仍未提交、推送或更新当前 macOS QA 包；前述两项已有 E2E 失败仍保留，不冒充总目标或全套 E2E 通过。

1. 本次修改尚未提交、推送、创建 PR 或合并；无关 `.catalog-consumer-4gQEBm/` 未动。
2. 当前运行的 macOS QA 包仍是 `22204d64` 的旧输入，不包含此 WIP；未操作它或真实数据库。
3. 新包仍需纳入当前输入差量审阅/冻结，再做三种会话的真实 macOS 客户端验证。
4. 两项旧 E2E 失败保留在总验收清单，不宣称全分支或总目标通过。
5. 不重做已通过的 pending-authority、时长/复制和旧包清理；继续其余 E6 联合验收。

边界风险：AppShell、WorkspaceClientView 与 TeammateWorkspace 仍是较大的既有 adapter；
本次只调整权限回调和共享组件接线，没有借机重构它们。
