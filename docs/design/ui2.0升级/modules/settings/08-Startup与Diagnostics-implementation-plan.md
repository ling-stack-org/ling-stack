# P7B.4 Startup 与 Run Diagnostics Implementation Plan

> Status: `verified` on 2026-07-20. Implementation, regression, six real-browser evidence images and all closeout gates completed.

## 1. Slice Contract

本切片迁移七个可达 Function ID：

- `SETTINGS-STARTUP-STATUS-001`
- `SETTINGS-STARTUP-BLOCKER-001`
- `SETTINGS-STARTUP-REFRESH-001`
- `SETTINGS-DIAG-OPEN-001`
- `SETTINGS-DIAG-LIST-001`
- `SETTINGS-DIAG-DETAIL-001`
- `SETTINGS-DIAG-EXTERNAL-001`

旧 `SETTINGS-DIAG-001` 与四个细粒度 Diagnostics ID 重复，从覆盖矩阵删除。当前 API、Runs domain、
Settings Shell 和 full diagnostics navigation 已足够；本切片只迁展示、状态投影、AppShell adapter、CSS、测试和证据。

## 2. Authoritative Baseline

| Owner | Baseline |
|---|---:|
| `MaintenanceSettingsPanel.tsx` | 240 lines |
| `SettingsRunDiagnosticsPanel.tsx` | 156 lines |
| `SettingsPage.tsx` | 331 lines |
| `settings.css` | 823 lines |
| `settings-interactions.css` | 190 lines |
| Startup selector family | about 155 lines in `settings.css` |
| Diagnostics selector family | about 125 lines in `settings-interactions.css` |
| Existing E2E | basic Settings open/close、full navigation、Dark shell boundary |

Reachability facts：

- Startup state：`GET /startup/status`、`POST /startup/refresh`；refresh failure 保留当前 snapshot。
- Runs state：`runsDomain.runs/selectedRun/events/artifacts/error`；list 与 detail 请求已经存在。
- `nextAction` 无 action id/API，只能作为建议文本。
- `openFullRunDiagnosticsFromSettings` 已存在；不需要新增 route。

## 3. Module Boundaries

1. `startup-readiness-view-models.ts`：status、tone、issue、phase 和 count projection；pure、locale-neutral。
2. `StartupReadinessSummary.tsx`：single status、timestamp、Refresh、Open Diagnostics、initial unavailable/loading。
3. `StartupIssueList.tsx`：scoped stale/initial error 与最多 4 个 product issues；不执行 repair。
4. `StartupTechnicalDetails.tsx`：shared InspectorSection、metadata、10 phases、raw diagnostics。
5. `MaintenanceSettingsPanel.tsx`：composition only，target `<140` lines。
6. `run-diagnostics-view-models.ts`：run title/status/next-step/count/event projection；pure、locale-neutral。
7. `SettingsRunDiagnosticsToolbar.tsx`：compact count summary、Refresh、Close。
8. `SettingsRunDiagnosticsList.tsx`：shared Skeleton/EmptyState/DataRow/StatusIndicator、keyboard selection。
9. `SettingsRunDiagnosticsDetail.tsx`：summary、recent activity、raw details、Open full action。
10. `SettingsRunDiagnosticsPanel.tsx`：composition only，target `<130` lines。
11. `settings-startup-diagnostics.css`：唯一 domain geometry owner，target `<400` lines。

翻译字符串留 JSX/i18n；view-model 只输出 key/status/value。AppShell 不持有展示状态，DOM ref 不进入 domain。

## 4. Implementation Steps

### Step A: Documentation And Coverage

- 完成 module design 与本 implementation plan。
- 从覆盖矩阵删除 `SETTINGS-DIAG-001`，七个细粒度 ID 进入 `designed`。
- 校准总计为 205：`89 verified / 30 implemented / 32 designed / 54 inventory`。
- 在 E2E、CSS、selector、motion、feedback 矩阵登记本切片 owner 和证据路径。

### Step B: Pure Startup Projection

- 建立 primary status label/tone，明确 initial、ready、starting、degraded、failed、unavailable、stale。
- 分离 warning/error issues 与 info diagnostics；保留 count/path/code 进入 technical details。
- 建立 required/warmup phase definitions 和 human-readable label keys。
- 增加纯函数测试或 focused E2E 断言，避免状态优先级散落 JSX。

### Step C: Startup Component Split

- 先抽 Summary/Issue/Technical components，再收敛 `MaintenanceSettingsPanel.tsx`。
- raw button、`Loader2.spin`、legacy `StatusBadge/MetaRow/EmptyState` 迁为 shared primitives。
- ready 默认层不显示绿色 card 或“无诊断”空态；failure/stale 使用 scoped InlineFeedback。
- Refresh 为 IconButton，Open Diagnostics 为文字 Button；不新增修复按钮。

### Step D: Runs Adapter Boundary

- `SettingsPage` props 增加 selectedRun/events/artifacts/runsError，删除全局 `errorMessage`。
- AppShell 新增 `selectSettingsRunDiagnostics`：只更新 selected id、加载 detail 和 approvals。
- AppShell 新增 `refreshSettingsRunDiagnostics`：刷新 list，并按当前 id 刷新 detail；不重记 return target。
- `openSettingsRunDiagnostics` 仍负责首次打开和 return target；`openFull...` 保持现有导航语义。
- `loadRun` rejection 由 runsDomain error 接住，adapter 防止 unhandled rejection，不吞掉 UI error。

### Step E: Diagnostics Component Split

- 建立 run/event projections；recent runs <= 12，events <= 6。
- Toolbar 收敛为中性 count line + Refresh/Close IconButton。
- List 使用 DataRow/Skeleton/EmptyState；selected id 与 loaded run 不一致时 detail 显示 loading。
- Detail 使用 StatusIndicator、InlineFeedback、DataRow/definition rows、InspectorSection 和 Open full Button。
- Open full action 移出 Raw details；Settings 不加入 retry/cancel/intervention。

### Step F: Focused CSS

- 新增 `styles/settings-startup-diagnostics.css`，按 Settings focused owner 顺序导入。
- 同步删除 `settings.css` Startup family 和 `settings-interactions.css` Diagnostics family。
- shared control/DataRow/Feedback/Inspector visuals 保持 package owner。
- 记录迁移前后行数；新增颜色字面量、`!important`、`transition: all`、private keyframe、Theme/Profile selector 为 0。

### Step G: Focused E2E And Existing Regression

- 新增 `ui2-settings-startup-diagnostics.spec.ts` 覆盖 design 第 15 节状态。
- mock daemon 增加 bounded failure controls/request counts；不改变其他 spec 默认行为。
- 更新 `settings.spec.ts`、`runtime.spec.ts`、`dark-mode.spec.ts` 的旧 class/按钮位置断言，保留业务断言。
- 联合运行 Settings Shell、Feedback/Data、App、Dark 和 shared package tests。

### Step H: Browser Evidence And Closeout

- 使用真实 Vite server 采集 6 张 `1440x960 ling-light` / `1280x800 ling-dark` changed-state 证据。
- 原尺寸检查列表/Inspector、长文本、内部 scroll、focus、Dark tokens、console 和 document overflow。
- 写 `evidence/settings/startup-diagnostics/metadata.md` 和 SHA-256。
- 回写 README、临时总控、覆盖/E2E/CSS/selector/motion/feedback 矩阵和状态看板。
- 自动化和代码完成但 evidence 不全时只标 `implemented`；全部证据通过后才标 `verified`。

## 5. Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-startup-diagnostics.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts runtime.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-shell.spec.ts ui2-feedback-data-display.spec.ts app.spec.ts dark-mode.spec.ts
```

顺序运行，不与 build/typecheck 并发。最终浏览器截图来自真实 Vite dev server，不使用代码截图或旧 dist。

## 6. Stop Conditions

遇到以下情况立即询问用户：

- 需要新增 repair action API、持久化 stale 标记、route、ViewId、Settings IA、权限或 Runs/Startup 状态机；
- 正确 UI 只能通过伪造 blocker 修复、吞掉 Runs error、删除审计数据或复制完整 Runs surface 实现；
- 远端与当前 UI 2.0 对同一 Startup/Run 行为无法同时保留；
- 需要 destructive Git、提交、推送、PR、合并或影响运行服务。

其余组件拆分、view-model、focused CSS、i18n、测试和证据问题由本切片连续完成，不上抛普通实现选择。

## 7. Closeout Result

- Owners：`MaintenanceSettingsPanel.tsx` 51 行，`SettingsRunDiagnosticsPanel.tsx` 82 行；focused
  Startup/Diagnostics components 与两个 pure view-model 完成。
- Adapter：Settings 使用 `runsDomain.error/events/artifacts/selectedRun`；run selection 不重复请求 `/runs`
  或重记 Settings return target。
- CSS：`settings.css` 662 行，`settings-interactions.css` 60 行，focused owner 398 行；源 selector 净迁出。
- Verification：`@ling-stack/ui-react 41/41`、focused `5/5`、Settings `17/17`、Runtime `19/19`、selected
  `25/25`，以及 typecheck/i18n/lint/diff check 全部通过。
- Evidence：六张目标图、原尺寸目检、console/overflow/keyboard/reduced-motion 结论和 SHA-256 见
  [`../../evidence/settings/startup-diagnostics/metadata.md`](../../evidence/settings/startup-diagnostics/metadata.md)。
- Seven Function IDs：全部 `verified`。下一切片为 P7B.5 Settings Workspace Tools 嵌入态。
