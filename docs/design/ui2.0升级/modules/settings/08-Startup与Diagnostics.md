# Startup 与 Diagnostics

## Status

**产品状态：待开发，Settings 导航入口已于 2026-07-28 隐藏。**

P7B.4 的既有组件、数据边界、状态矩阵、CSS owner、自动化和六张浏览器证据曾于
2026-07-20 完成技术验证；这些记录作为保留实现的历史证据，不代表该入口当前对用户发布。
底层 Startup/Run Diagnostics 能力暂不删除，供内部回归和后续产品化继续使用。

## 1. 页面目标

Settings > 启动与诊断用于回答两个问题：

- 当前 workspace 是否已经可以正常工作；如不能，用户下一步应检查什么；
- 最近运行发生了什么，以及何时需要进入主应用查看完整诊断。

它不是 daemon 日志墙、配置浏览器或自动修复中心。默认层只显示单一启动状态、更新时间、真实 blocker、
Refresh 和 Open Run Diagnostics。phase、attempt、code、path、provider、event log 和 raw failure 默认折叠。

## 2. 待开发入口、Shell 与目标 IA

- 当前版本不展示 Settings > Maintenance > Startup and diagnostics 导航项。
- 待开发完成后，目标入口仍为 Settings > Maintenance > Startup and diagnostics。
- Shell owner：`SettingsShell`；Settings 左侧导航始终可见，主应用 Sidebar 必须 absent。
- 默认页显示 Startup surface；Open Run Diagnostics 在同一 Settings Shell 内切换为 Diagnostics surface。
- Close Run Diagnostics 返回 Startup surface；点击其他 Settings section 关闭 Diagnostics 并打开目标 section。
- Open full diagnostics in app 显式离开 Settings，进入既有 Runs view；不新增 route、ViewId 或二级 Settings section。
- Web 与 Electron Desktop 主窗口复用同一 surface；移动端不在本轮范围。
- 回话语气和技能治理的来源、存储路径只允许出现在本页 Technical details；Personalization 不再显示这些技术字段。

## 3. 已确认的数据与业务边界

### Startup

- `GET /startup/status` 提供 `starting / ready / degraded / failed`、10 个 phase、diagnostics 和 timestamps。
- `POST /startup/refresh` 重新读取状态；失败时现有最后成功快照保留。
- `StartupDiagnostic.nextAction` 是建议文本，没有 action id、repair API 或可验证执行结果。
- 因此 blocker 可以显示原因和下一步建议，但不得渲染假的 Fix、Repair 或 Retry repair 按钮。
- stale 只定义为“已有权威 Startup 快照，但显式 Refresh 失败”；不按时间阈值猜测过期。

### Run Diagnostics

- 复用 `runsDomain` 的 runs、selectedRun、events、artifacts、loading 和 DomainError；不建立第二套请求层。
- Open 时可以刷新 list 并加载目标 run；在列表内选择 run 只加载该 run 的 detail，不重记 return target、
  不重复刷新整个 list。
- Settings Diagnostics 只投影最近 12 条 runs、最多 6 条 recent events 和 artifact/event counts。
- 完整 Timeline、Intervention、Approval、raw payload 和 artifact inspector 继续属于主应用 Runs view。
- Settings 不改变 run、event、artifact、approval、thread 或 work-unit 数据；不伪造成功、取消或修复状态。

## 4. 当前问题与实施基线

| Owner | Current | Problem |
|---|---:|---|
| `MaintenanceSettingsPanel.tsx` | 240 lines | composition、phase map、status projection、raw controls 和技术详情混在一处 |
| `SettingsRunDiagnosticsPanel.tsx` | 156 lines | summary/list/detail/helper 混合；raw buttons；只读取 runs，不消费 events/artifacts |
| `SettingsPage.tsx` | 331 lines | Diagnostics 误用 AppShell 全局 `errorMessage` |
| `AppShell.tsx` | over 3,000 lines | select run 复用 open handler，重复 refresh list 和 return-target side effects |
| Startup selector in `settings.css` | about 155 lines | 绿色/黄色 phase 卡片和页面 geometry 混入 aggregate |
| Diagnostics selector in `settings-interactions.css` | about 125 lines | Settings-specific list/detail owner 混入 interaction aggregate |

现有 Settings Shell、API、domain 和导航能力足够。本切片不需要后端、contracts、数据库、权限、状态机、
ViewId、Settings IA 或 First Run 改动。

## 5. Function Points

| Function ID | Surface | Required states | Target primitive | Status |
|---|---|---|---|---|
| `SETTINGS-STARTUP-STATUS-001` | Startup 单一主状态 | initial-loading, starting, ready, degraded, failed, unavailable, stale | `StatusIndicator`, `Skeleton`, `EmptyState` | verified |
| `SETTINGS-STARTUP-BLOCKER-001` | blocker 和下一步建议 | none, warning, error, multiple, long, no-action, raw-folded | `InlineFeedback`, `InspectorSection` | verified |
| `SETTINGS-STARTUP-REFRESH-001` | Startup 局部刷新 | idle, refreshing, success-snapshot, initial-failure, stale-failure | `IconButton`, `Spinner`, `InlineFeedback` | verified |
| `SETTINGS-DIAG-OPEN-001` | Settings 内打开/关闭 Diagnostics | open, close, section-switch, no-runs, target-run, focus | `Button`, `IconButton`, `SettingsShell` | verified |
| `SETTINGS-DIAG-LIST-001` | 最近运行列表和选择 | loading, loaded, empty, selected, refreshing-with-data, failed, stale, long | `DataRow`, `Skeleton`, `EmptyState`, `StatusIndicator` | verified |
| `SETTINGS-DIAG-DETAIL-001` | 运行摘要、activity 和技术详情 | loading, selected, running, failed, complete, events, no-events, artifacts, raw-folded | `DataRow`, `InspectorSection`, `InlineFeedback`, `StatusIndicator` | verified |
| `SETTINGS-DIAG-EXTERNAL-001` | 打开主应用完整诊断 | available, no-selection, navigation, navigation-failed | `Button`, navigation adapter | verified |

旧粗粒度 `SETTINGS-DIAG-001` 与以上四个 Diagnostics ID 重复，必须从覆盖矩阵删除，不保留双重完成计数。

## 6. 页面结构

```text
SettingsShell
  StartupDiagnosticsSettingsPanel
    StartupReadinessSummary
      single status + updated time
      Refresh IconButton
      Open Run Diagnostics Button
    optional StartupIssueList
    StartupTechnicalDetails (collapsed)

  OR

  SettingsRunDiagnosticsPanel
    SettingsRunDiagnosticsToolbar
      compact counts
      Refresh IconButton
      Close IconButton
    persistent scoped error when needed
    list + inspector layout
      SettingsRunDiagnosticsList
      SettingsRunDiagnosticsDetail
        run summary
        recent activity <= 6
        raw details (collapsed)
        Open full diagnostics Button
```

Startup 与 Run Diagnostics 互斥渲染；不得将两个页面作为嵌套 cards 同时铺开。

## 7. Startup 默认层

- root 使用 unframed Settings section，不再套 `.panel.settings-panel.developer-settings-panel`。
- Header identity 为 Startup status；不重复解释 Settings 页面用途。
- Refresh 使用 icon-only `IconButton`，32px hit area、Tooltip、title 和 ARIA；只有该按钮 loading。
- Open Run Diagnostics 是可见文字 secondary Button，因为它是该页唯一导航任务。
- 主状态只渲染一个 `StatusIndicator`：
  - ready -> success；
  - starting -> info；
  - degraded -> warning；
  - failed -> danger；
  - 未加载 -> neutral。
- ready 不显示绿色卡片、成功说明或“无诊断”空态；状态点和更新时间已经足够。
- initial loading 使用稳定 Skeleton，不先闪出 `not loaded`。
- 无状态且请求失败使用 compact EmptyState/InlineFeedback，提供真实 Refresh。

## 8. Startup blocker 与 stale

- diagnostics 中 warning/error 投影为 issue；info 只进入技术详情。
- 默认 issue 行显示产品 message；`nextAction` 有值时作为普通建议文本显示。
- phase/code/path/count 不进入 issue 主标题；放在每条 issue 的折叠技术详情或总 Technical details。
- 多 issue 最多在默认层显示 4 条；其余数量在 Technical details summary 中可发现。
- refresh failure 且已有 status：保留状态和 issues，显示 warning InlineFeedback“状态可能已过期”及错误详情。
- initial load/refresh failure 且无 status：显示 danger InlineFeedback；不伪造 stale snapshot。
- 成功 refresh 静默更新 timestamp；不新增 Toast 或常驻 success banner。

## 9. Startup 技术详情

- 使用 shared `InspectorSection`，默认 closed；标题为 Technical details，summary 显示 phase/issue count。
- 第一组 DataRow/definition rows：Workspace、Attempt、Started、Updated、Effective config。
- 第二组为 10 个 phase；显示产品化 label、Required/Warmup 和单一状态，不使用整行成功/警告底色。
- 第三组为全部 diagnostics；message 在前，phase/code/path/count/nextAction 在次级字段。
- 长 path、code 和 message 可换行，容器内部不产生横向滚动。
- Details open/close 使用 shared disclosure motion；reduced motion 下 transition 为 0。

## 10. Run Diagnostics Toolbar 与列表

- Toolbar 显示一行中性摘要，例如 `12 recent · 1 running · 2 need attention`；不做四个统计卡。
- Refresh 与 Close 均为 icon-only `IconButton`；顺序固定 Refresh / Close。
- list 只显示最近 12 条，使用 bounded scroll 和 `role=listbox`；DataRow 支持 pointer、Enter、Space。
- 行 identity：task title；无标题使用 Untitled run。summary：更新时间。status：一个 `StatusIndicator`。
- selected 只使用 shared selected state，不用黑色边框或彩色卡片。
- 首次加载且无数据显示 4 个 Skeleton rows；refreshing 时保留列表。
- true empty 显示一句 compact EmptyState；有数据的 refresh failure 保留列表并标 stale。
- 列表错误只来自 `runsDomain.error`，不得显示 AppShell、MCP、Channel 或其他 domain 的全局错误。

## 11. Run Diagnostics Detail

- selectedRun.id 与 selectedRunId 不一致时显示 detail loading，不展示上一个 run 的内容。
- 默认 detail 显示 title、单一 status、next step、Created/Updated、event count 和 artifact count。
- failed/cancelled 显示 persistent warning/danger InlineFeedback；不复制 raw error 到默认层。
- Recent activity 最多显示 6 条，按时间排序；每行只显示产品化 event label 和时间，不显示 raw payload。
- 无 events 使用一句 compact EmptyState，不把空 Inspector 撑高。
- Raw run details 使用 `InspectorSection` 默认 closed，保留 run id、provider、model、task/channel/work-unit、
  event log 和 failure detail。
- Open full diagnostics in app 位于 detail 主行动区，不藏在 Raw details 内；无选中 run 时仍可打开主 Runs view。
- Settings detail 不提供 retry/cancel/intervention；这些行为继续属于主 Runs view。

## 12. Feedback Ownership

- Startup load/refresh error：Startup surface 内；已有快照用 warning，无快照用 danger。
- Runs list/detail error：Diagnostics surface 内一个 persistent InlineFeedback；保留最后权威 list/detail。
- Open full navigation failure：Settings Diagnostics 内 persistent feedback；不能被 Startup Refresh 清除。
- Refresh success：状态/timestamp/list 直接更新，静默完成。
- 不使用 AppShell 全局 `errorMessage`、browser alert、局部 Toast provider 或 Feature timer。

## 13. Theme、尺寸、键盘与文案

- 验收 viewport：`1440x960`、`1280x800`；额外回归 Settings Shell `980x680`。
- 主题：`ling-light`、`ling-dark`；imported fixture 在全局主题回归中验证。
- list/detail 在 1280 下保持双列；宽度不足时 detail 可下移，但 document 不产生横向滚动。
- Settings navigation 与 content 保持唯一滚动 owner；Diagnostics list 可以拥有明确内部纵向滚动。
- IconButton hover/focus/disabled/loading、DataRow keyboard selection、Inspector Enter/Space/Esc 按 shared contract。
- 中文、英文、长 task title、长 path、长 provider error 均不得挤压 actions 或竖排。
- 默认层不显示 raw phase key、code、path、run id、event payload 或 event log path。

## 14. Module And CSS Ownership

```text
MaintenanceSettingsPanel.tsx                 composition, target <140
  StartupReadinessSummary.tsx                status/header/actions, target <170
  StartupIssueList.tsx                       scoped feedback/issues, target <180
  StartupTechnicalDetails.tsx                phases/raw details, target <220
  startup-readiness-view-models.ts           pure projections, target <260

SettingsRunDiagnosticsPanel.tsx              composition, target <130
  SettingsRunDiagnosticsToolbar.tsx          counts/actions, target <130
  SettingsRunDiagnosticsList.tsx             skeleton/empty/DataRows, target <220
  SettingsRunDiagnosticsDetail.tsx           summary/activity/raw, target <260
  run-diagnostics-view-models.ts              pure projections, target <280

styles/settings-startup-diagnostics.css      domain geometry only, target <400
```

- Feature 只从 `apps/web/src/shared/ui` 导入 primitive，不直接 import Radix。
- AppShell 只增加 select/refresh adapter 和现有 domain props；不增加展示或复制 Runs state。
- `SettingsPage.tsx` 只接线 scoped Startup/Runs props；移除全局 `errorMessage` 依赖。
- Startup selector 从 `settings.css`、Diagnostics selector 从 `settings-interactions.css` 同步删除。
- 新 CSS 不允许颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 或
  package-private `.ling-ui-*` selector。

## 15. E2E And Evidence

新增 `ui2-settings-startup-diagnostics.spec.ts`；既有 `settings.spec.ts`、`runtime.spec.ts` 和
`dark-mode.spec.ts` 只更新因共享结构变化失效的 locator，不塞入全部视觉场景。

最低覆盖：

1. Startup initial loading、ready、starting、degraded、failed、initial error、stale refresh failure；
2. blocker warning/error/no-action/multiple/long，Technical details 默认 closed、打开后 raw 可见；
3. Refresh scoped busy、last snapshot retained、success timestamp update；
4. Diagnostics open/close/section switch、Settings Shell boundary、no runs、list loading/error/stale；
5. run select 只发 detail requests，不重复 list refresh；selected loading、running/failed/complete；
6. events preview、no events、artifact counts、Raw details folded、Open full navigation；
7. keyboard/focus、zh-CN/en-US、Light/Dark、reduced motion、console 和 overflow。

目标证据：

- `1440x960-ling-light-startup-ready.png`
- `1440x960-ling-light-startup-blocker-details.png`
- `1280x800-ling-dark-startup-stale-zh-CN.png`
- `1440x960-ling-light-run-diagnostics-selected.png`
- `1280x800-ling-dark-run-diagnostics-empty.png`
- `1280x800-ling-dark-run-diagnostics-error-details.png`

## 16. Non-Goals And Stops

- 不改 daemon/API/contracts/database、Startup 状态、Runs 状态机、Settings IA、ViewId、权限或 First Run。
- 不新增自动修复、批量 retry/cancel、日志下载、运行搜索、时间阈值 stale 或新的 full diagnostics route。
- 不把 Timeline、Intervention、Approval 或完整 artifact inspector 复制进 Settings。
- 如果正确实现需要 repair action API、持久化 stale 标记、新 route、权限或状态机，立即停止并向用户提交独立方案。
- 不修改 Logo。

## 17. Verified Closeout

- Production owners：Startup/Diagnostics composition 分别为 51/82 行；pure view-model、focused components
  和 AppShell scoped adapter 已落地，Settings 不再消费全局 error。
- CSS：`settings.css` `823 -> 662`、`settings-interactions.css` `190 -> 60`；398 行
  `settings-startup-diagnostics.css` 是唯一 domain geometry owner，颜色字面量、`!important`、
  `transition: all`、private keyframe 和 Theme/Profile selector 均为 0。
- Tests：package `41/41`、focused `5/5`、Settings `17/17`、Runtime `19/19`、selected `25/25`；
  Web typecheck、i18n、lint 和 diff check 通过。
- Evidence：六张 `1440x960 ling-light` / `1280x800 ling-dark` changed-state PNG 已原尺寸检查，console、
  overflow、中文、reduced motion、raw disclosure 和 Recent activity label 均通过。详情见
  [`../../evidence/settings/startup-diagnostics/metadata.md`](../../evidence/settings/startup-diagnostics/metadata.md)。
- Business boundary：未新增 API、route、repair action、状态机、持久化、权限或 Settings IA；完整 Timeline、
  retry/cancel/intervention 继续归主 Runs view。
