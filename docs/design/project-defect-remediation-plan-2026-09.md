# Ling 项目缺陷修复计划 2026-09

Status: implementation complete; platform acceptance pending
Owner: Web、Desktop、Chrome integration、daemon and release maintainers
Last verified: 2026-09-03
Document type: cross-module implementation plan
Source contract: [Ling Project Defect Remediation Contract](project-defect-remediation-contract-2026-09.md)
Review baseline: `codex/chrome-native-reconnect-0.1.2@7b131012`

## Scope

修复最近整体项目审查发现的五项问题：工作区右栏评审模式死控件、Run Inspector
查询链路断裂、Profile 国际化缺失、Native Broker 启动半失败，以及 Native 迁移可能
提前撤销旧凭据。保留现有业务能力、协议、权限、数据库和 Chrome 扩展产品边界。

本计划同时作为本轮实现与验证记录。实现已通过本地检查并提交到
`codex/chrome-native-reconnect-0.1.2`，PR 已创建；真实 macOS/Windows 客户端与
Chrome 扩展环境验收仍需在对应平台完成。

## Implementation Update 2026-09-03

- 右栏评审详情已移除没有状态/API 支撑的 Unified、Split、Hide whitespace 和 note
  filter 假控件；文件预览、统计和 minimap 保持不变。
- Runs Inspector 已恢复 Run ID 查询、回车/按钮加载、独立 loading、错误和空状态，
  并重新接入 AppShell 的右侧 Inspector；新增成功/失败浏览器回归。
- Profile standalone 页面硬编码的标题、字段、统计、热力图、空状态、头像提示和
  ARIA 文案已接入 en-US/zh-CN；成功提示不再依赖中文字符判断。
- Native Broker 启动发布失败会清理 listener、socket、timer 和本代 descriptor，并允许
  重试；descriptor refresh 失败会进入清理路径而不是静默继续。
- Native 迁移现在在 ready 成功发送后才撤销 legacy credential，并补充提交点回归测试。

当前仍未完成：真实 macOS/Windows 打包客户端与 Chrome 扩展环境验收；这些结果不能由
本机 Web 或 Node 测试推断。

## Slice 1: Baseline And Contract

- 以当前分支和源文件锚点建立回归基线。
- 保留本计划和合同作为唯一缺陷修复入口，避免为同一问题建立多个局部计划。
- 在测试中明确产品缺陷、测试基础设施缺陷和平台缺失证据三类结果。

Exit gate: 文档索引和实施状态已引用本计划，代码范围没有扩大到后端业务或数据库。

## Slice 2: Workspace Review Detail

Files:

- `apps/web/src/features/workspace/right-dock/DockReviewItemDetail.tsx`
- `apps/web/src/styles/channel-right-dock/review-details.css`
- 相关 right-dock view-model and tests

Actions:

- 查明 Unified、Split、Hide whitespace 和 note filter 是否有真实状态/API来源。
- 有真实能力时，使用 button/tab semantics，接入状态、键盘导航、焦点和加载/失败反馈。
- 没有真实能力时，移除选择外观并改为明确的静态说明，不伪造可用交互。
- 保持现有评审文件、差异统计和 minimap 展示不变。

Exit gate: 每个可点击元素都有状态变化；静态信息不再表现为按钮；真实浏览器点击无死操作。

## Slice 3: Runs / Run Inspector

Files:

- `apps/web/src/features/runs/RunInspector.tsx`
- `apps/web/src/features/inspector/PageInspector.tsx`
- `apps/web/src/app/AppShell.tsx`
- `apps/web/src/domains/runs/` and run tests as needed

Actions:

- 恢复 Run ID 输入、查询/加载操作，或删除已被产品明确废弃的参数和回调；默认采用恢复
  现有 `loadRun` 能力的方案。
- 明确 active run 与 lookup run 的区别，避免查询结果覆盖当前选中状态。
- 为 loading、not found、error、loaded events/artifacts 和取消/重复查询增加状态测试。
- 所有用户文案走 i18n，长 Run ID 使用稳定的溢出处理。

Exit gate: 用户可从 Runs 页面查询指定 Run ID，查询结果、事件和产物可见；刷新和失败后状态可恢复。

## Slice 4: Profile Internationalization

Files:

- `apps/web/src/features/profile/ProfilePage.tsx`
- `apps/web/src/i18n/locales/en-US.ts`
- `apps/web/src/i18n/locales/zh-CN.ts`
- 其他 locale 生成/校验入口和 Profile tests

Actions:

- 将标题、按钮、字段、统计、热力图说明、空状态、tooltip 和 ARIA label 替换为共享翻译调用。
- 为带变量的统计、日期和 Token 数量使用参数化翻译，不翻译数据值。
- 用英文和至少一个长文本 locale 验证按钮换行、头像控件和统计布局。
- 扩展 i18n 检查，使产品 JSX 直接文本不会被静默漏检。

Exit gate: 非中文 locale 不出现产品级中文文案；Profile 的保存、头像和活动切换功能保持可用。

## Slice 5: Native Broker Startup Cleanup

Files:

- `packages/daemon/src/features/browser-extension/native-broker.ts`
- `packages/daemon/src/index.ts`
- `packages/browser-host/src/runtime-descriptor.ts`
- Native Broker tests

Actions:

- 将 listener、descriptor 和 refresh timer 纳入可回滚启动事务。
- descriptor 发布失败时关闭 listener，清空本地句柄，并按 generation 删除本次拥有的 descriptor。
- 允许下一次 `start()` 重试；刷新失败必须进入可诊断、可修复状态，不得静默吞掉失败。
- 保持 loopback、token、origin、权限和 descriptor generation fence 不变。

Exit gate: 模拟目录不可写、发布失败、重复 start、close race 和 stale generation；失败后无残留监听器或错误 descriptor。

## Slice 6: Native Migration Atomicity

Files:

- `packages/daemon/src/features/browser-extension/session-controller.ts`
- `packages/daemon/src/features/browser-extension/native-broker.ts`
- `apps/chrome-extension/src/background.js`
- Native and legacy session tests

Actions:

- 定义 Native ready 的提交点，确保旧凭据撤销不会先于成功确认。
- 发送 ready 失败、socket 提前关闭、旧客户端和重复连接均保留可重试语义。
- 继续保证 Native 不接收 `cwd`，并维持 daemon workspace authority。
- 扩展端仅补充失败状态和 legacy fallback 回归测试；不改变 Web Store UI 或协议字段。

Exit gate: 迁移成功只发生一次；迁移失败后旧 WebSocket 仍可用；并发、重启、撤销和插件禁用测试通过。

## Verification Plan

### Automated

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/chrome-extension test
corepack pnpm --filter @ling-stack/browser-host test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/desktop typecheck
git diff --check
```

### Browser and Desktop

- Real browser: right-dock review detail and Runs lookup in success, loading, empty and failure states.
- Profile: zh-CN, en-US and one long-label locale; save, avatar, activity tabs, empty data.
- Native Broker: publish failure and retry, descriptor cleanup, legacy migration success/failure,
  extension pause, daemon restart and plugin disable.
- Record console errors, page errors, horizontal overflow and screenshots of every affected state.
- Windows/macOS packaging evidence is reported separately and is never inferred from macOS-only tests.

## Risks And Rollback

- If an unimplemented review mode has no real state source, keep it non-interactive rather than
  inventing frontend-only state.
- If migration commit semantics cannot be made atomic with the existing store API, preserve the
  old credential until a durable migration marker or equivalent transaction boundary exists.
- Rollback is limited to the changed module and its tests; do not revert unrelated user changes
  or alter stored workspace data during verification.

## Non-Goals

- No new UI features beyond reconnecting already-exposed Run lookup and truthful review controls.
- No redesign of Ling's shell, themes, sidebars, approvals, models, channels, or profile layout.
- No database migration, public API version bump, Chrome extension republish, PR, or remote push in
  the implementation turn unless separately requested.
