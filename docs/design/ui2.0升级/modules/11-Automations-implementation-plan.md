# Automations UI 2.0 Implementation Plan

Status: `Web verified / packaged Desktop partial`。

## 1. 范围

本计划实现 `AUTO-LIST-001`、`AUTO-STATUS-001`、`AUTO-CREATE-001`、`AUTO-SCHEDULE-001`、
`AUTO-TARGET-001`、`AUTO-RUN-001`、`AUTO-INSPECT-001`。保持现有 API、schema、scheduler、run、draft 和
archive 语义。

## 2. 当前代码基线

| Owner | 当前行数 | 问题 | 目标 |
|---|---:|---|---|
| `AutomationsPage.tsx` | 370 | 页面、thread load、dialog mode、selection timing 混合 | composition + page controller，低于 300 |
| `AutomationListPane.tsx` | 526 | tabs/list/run/draft/row/helper 混合 | list composition，row/run/draft 分离，每个低于 300 |
| `AutomationCreateDialogs.tsx` | 718 | 三种 modal、fields、popover、helpers 混合 | Dialog shell + 3 focused flows，每个低于 400 |
| `AutomationExecutionInspector.tsx` | 268 | raw grids/details 与 summary 混合 | shared Inspector sections，低于 300 |
| `use-automations-domain.ts` | 541 | domain fetch/mutation owner | 保留 domain，不迁入 UI；只做必要竞态/错误 contract |
| `automations.css` | 1457 | page、control chrome、modal、popover、dark 混合 | import manifest + focused files，每个低于 400 |

## 3. 目标模块

```text
apps/web/src/features/automations/
  AutomationsPage.tsx
  useAutomationsPageController.ts
  automation-page-view-models.ts
  AutomationWorkbenchHeader.tsx
  AutomationSchedulerSummary.tsx
  AutomationListPane.tsx
  AutomationDefinitionRow.tsx
  AutomationRunList.tsx
  AutomationDraftList.tsx
  AutomationCreateDialog.tsx
  AutomationTemplateStep.tsx
  AutomationManualForm.tsx
  AutomationChatDraftForm.tsx
  AutomationScheduleFields.tsx
  AutomationExecutionInspector.tsx
  AutomationArchiveDialog.tsx
  automation-view-models.ts

apps/web/src/styles/automations/
  page.css
  toolbar-list.css
  scheduler.css
  create-dialog.css
  inspector.css
```

`apps/web/src/styles/automations.css` 只保留 import。不得新增第二个 global overlay root 或 Toast viewport。

## 4. 状态边界

### 4.1 Domain

`useAutomationsDomain` 继续拥有：definitions、runs、drafts、templates、scheduler、API mutation 和定时 refresh。
不把可见文案、颜色、Dialog open 或 filter 放入 domain。

### 4.2 Feature controller

`useAutomationsPageController` 拥有：

- search、active tab、selected row、create/archive/schedule overlay；
- per-operation UI state 和 focus return；
- thread title load 与 cwd identity guard；
- derived callbacks，禁止 `window.setTimeout(action, 0)` selection hack；
- mutation result 到 Toast/InlineFeedback 的展示映射。

### 4.3 View-model

纯函数派生：

- `primaryState`、`primaryAction`、`secondaryActions`；
- target、schedule、latest run product summary；
- status/filter/search projection；
- disabled reason、repair action 和 Inspector sections。

JSX 不自行重复状态优先级。

## 5. Slice P9.3a：页面、列表和状态

### 实施

1. 抽 page controller/view-model；移除 Page 中未使用的 `void` actions。
2. Header 迁到 shared Button/IconButton；三个 create buttons 收敛成一个主行动。
3. raw tablist 迁到 shared Tabs；新增 shared Input search。
4. row 迁到 DataRow + one StatusIndicator；拆 Definition/Run/Draft list。
5. More Menu 承载 Archive；新增 shared archive Dialog。
6. 列表保留旧数据时显示 stale，不把 refresh failure 变成空页。

### 局部测试

- loading/empty/search/no-result/four tabs；
- seven primary state precedence；
- row Enter/Space、inner action propagation；
- scoped refresh/row busy；
- archive cancel/confirm/failure；
- 100 rows internal scroll and root overflow。

### Exit gate

`AUTO-LIST-001`、`AUTO-STATUS-001` 达到 `implemented`；没有截图前不得 verified。

## 6. Slice P9.3b：Create 与 Draft

### 实施

1. 用 shared Dialog 替换 `AutomationModal` 和 document Escape/body overflow code。
2. Template/Manual/From conversation 进入一个受控 Dialog；模式切换保留未提交 draft。
3. 手动表单迁 Field/Input/Textarea/Select；schedule fields 只按模式显示。
4. Popover/Menu 由 shared Radix owner；删除 feature outside click/Escape owner。
5. chat request 创建 draft；Confirm 前展示结构化复核；失败保留输入。
6. create/confirm scoped busy；busy Dialog 阻止重复提交和 dismiss。

### 局部测试

- templates loading/empty/select/review；
- manual invalid/known model/custom schedule/create failure；
- chat draft invalid/ready/confirm/discard；
- Dialog Esc/outside/focus return/busy/reduced motion；
- zh/en long copy and 1280 containment。

### Exit gate

`AUTO-CREATE-001`、`AUTO-TARGET-001` 达到 `implemented`。

## 7. Slice P9.3c：Schedule、Run 与 Inspector

### 实施

1. SchedulerStrip 迁到 SchedulerSummary，真实接入已有 start/stop action。
2. schedule edit 接入已有 `onSetSchedule`，不新增 API。
3. Run now、Pause/Resume、Open run/thread 使用 scoped action state。
4. Inspector 改为 InspectorSection；failure/repair 在默认展开层，raw details 默认折叠。
5. context preview 只有用户触发或已缓存时展示；不在每次行选择制造额外网络请求。
6. 15 秒 runtime refresh 使用 cwd/request identity，不能覆盖当前 overlay/form。

### 局部测试

- scheduler absent/running/stopped/start-stop failure；
- manual/interval/daily/weekly/custom schedule；
- row run/pause/resume/failure/duplicate activation；
- target missing repair；
- Inspector empty/loading/failure/context/raw details/open run/thread。

### Exit gate

`AUTO-SCHEDULE-001`、`AUTO-RUN-001`、`AUTO-INSPECT-001` 达到 `implemented`。

## 8. Slice P9.3d：CSS、回归和证据

1. 将 1457 行 legacy CSS 拆入 focused owners；删除已迁 control/modal/popover/status selector。
2. 新 CSS 不得包含颜色字面量、`!important`、`transition: all`、private keyframe、Theme/Profile ID selector
   或 package-private `.ling-ui-*` selector。
3. 更新 migration 06/07/09、feedback matrix、E2E matrix、module docs 和 evidence metadata。
4. 运行所有静态、focused、legacy、Dark 和跨模块回归。
5. 采集原尺寸实页证据并逐张 original-size 审查。
6. 机械更新覆盖矩阵；只有全部 gate 通过才将七项设为 verified。

## 9. 测试文件

- 新增 `apps/web/e2e/ui2-automations.spec.ts`，不要继续扩大已有 670 行 legacy spec；
- 保留并迁移 `apps/web/e2e/automations.spec.ts` 的产品行为断言，不依赖 private class/DOM order；
- selected regression：`app.spec.ts`、`runtime.spec.ts`、`settings.spec.ts`、`dark-mode.spec.ts`；
- package primitives 测试只在共享合同真实缺口时修改。

## 10. 必跑命令

```text
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-automations.spec.ts automations.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts runtime.spec.ts settings.spec.ts dark-mode.spec.ts
```

若完整 selected suite 太大，可按相关 grep 分批运行，但 metadata 必须列出精确过滤条件，不能写成完整 suite 通过。

## 11. 截图矩阵

| Viewport | Theme | State |
|---|---|---|
| 1440x960 | Ling Light | enabled/scheduled list + Inspector |
| 1280x800 | Ling Dark | needs attention + failure repair |
| 1440x960 | Ling Light | Create template/manual review |
| 1280x800 | Ling Dark | chat draft ready/invalid |
| 1440x960 | Ling Light | scheduler stopped + Start action |
| 1280x800 | Ling Dark | archive confirmation or mutation failure |

每张截图记录 locale、theme id、viewport、fixture、URL、served artifact、console、overflow 和 SHA-256。

## 12. i18n 与反馈验收

- 新增 visible strings 同时进入 `en-US` / `zh-CN`；
- `t()` 只处理文案，不处理状态判断；
- success/info 进入全局 Toast；validation/object failure/stale/blocker 进入 InlineFeedback；
- 不新增 feature timer、browser alert/confirm 或第二个 Toast owner。

## 13. Hard Stops

出现以下情况停止对应 mutation，但继续其他独立工作：

- 需要新增或改变 Automation API/schema/database；
- 现有 archive 被要求解释为永久删除；
- 目标列表缺少权威状态，必须猜测 archived/available；
- scheduler/run provenance 无法从现有 response 得到；
- 旧测试要求回退到手写 Modal/StatusBadge/private class；
- packaged macOS/Windows 证据不可用。

前五项需要更新业务设计或用户决策；最后一项只阻塞 Desktop verified，不阻塞 Web closeout。

## 14. 回滚边界

- 所有变更限于 Web presentation/controller/view-model/CSS/tests/docs；
- API、contracts、domain store 和 DB 无迁移，因此回滚以 Feature 文件和 CSS import 为单位；
- 不删除旧 CSS 前必须确认新 owner、E2E 和截图均存在；
- legacy component 只在调用点归零后删除。

## 15. 完成定义

- 七个 Function ID 都有真实 trigger、全部可达状态、E2E 和截图；
- Create/Schedule/Archive 使用共享 overlay，Esc/focus/busy 正确；
- row/batch/create/scheduler busy 互不污染；
- raw diagnostics 默认折叠，失败有产品化修复路径；
- 两主题、两 viewport、两语言、keyboard、reduced motion、console、overflow 全通过；
- Web verified 与 Desktop partial 在文档中明确分开；
- 大文件没有新增架构债务，Automations production owners 全部低于 800 行，新增 owner 低于 400 行。

## 16. Implementation Closeout - 2026-07-22

### Completed

1. 建立 `useAutomationsPageController`、focused form models 和纯 `automation-view-models`，页面 composition
   收敛到 279 行。
2. 列表、四状态 Tabs、search、100-row scroll、单一主状态、行选择和 scoped actions 已迁移。
3. Template/Manual/Conversation draft 共用一个 Dialog；失败保留输入，busy 阻止重复提交和提前关闭。
4. Scheduler、Schedule edit、target repair、run retry、Archive confirm 和 summary-first Inspector 已接线。
5. 旧 CreateDialogs/SchedulerStrip 删除；`automations.css` 只保留五个 focused owner import。

### Verification

```text
ui2-automations.spec.ts + automations.spec.ts                            7/7 PASS
app.spec.ts + runtime.spec.ts + settings.spec.ts + dark-mode.spec.ts   57/57 PASS
```

六张原尺寸 Light/Dark、双 viewport changed-state PNG 已完成 original-size 审查并记录 SHA-256，见
[evidence metadata](../evidence/features/automations/metadata.md)。七个 Web Function ID 可机械晋级为
`verified`。packaged Electron macOS/Windows、imported Theme Pack 和 forced-colors 继续由全局发布 gate 验收。
