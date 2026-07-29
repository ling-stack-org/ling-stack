# P11.2 Runs 与 Threads UI 2.0 Implementation Plan

Status：`P11.2-G verified on Web / packaged acceptance deferred to P13`。

## 1. Slice Contract

本计划实施 [Runs 与 Threads UI 2.0 零决策合同](15-Runs与Threads.md)，关闭：

- `RUN-HISTORY-001`
- `RUN-DETAIL-001`
- `RUN-INTERVENTION-001`
- `THREAD-LIST-001`

不修改 daemon API、contracts、database、run/thread 状态机、permission snapshot、retention、ViewId、Settings
IA 或审计历史。Settings Startup/Diagnostics 已 verified，只做回归。

## 2. Baseline Audit

| Owner | Current posture | Migration requirement |
|---|---|---|
| `RunHistory.tsx` | 182 行 composition | 已完成；不回流请求、detail 或 intervention 行为 |
| `ThreadPage.tsx` | 66 行 composition | 已复用 focused thread controller/list/detail |
| `RunInspector.tsx` | 60 行 focused owner | recording state 已合并 |
| `RunTimeline.tsx` | 89 行 focused owner | shared primitives 迁移已完成 |
| `SkillRecordingReviewSheet.tsx` | 1 行 compatibility re-export | shared Dialog owner 已完成 |
| `runs.css` | 8 行 import-only manifest | focused owners 与 U13 全局 selector 清理均已完成 |
| `runtime.spec.ts` | 1,533 行、19 个业务场景 | 不扩主文件；新 UI2 场景进入 focused spec |

现有 API 足以完成本切片：threads list/detail/evidence/turns/resume preview/resume/fork/fork-run/archive/unarchive/
pin/unpin，runs detail/events/artifacts/snapshots/cancel/interventions，以及 recording eligibility/submit。无需新增
接口或 schema。

## 3. Target Module Tree

```text
apps/web/src/features/runs/
  RunHistory.tsx                         composition only
  ThreadPage.tsx                         composition only
  useRunsThreadsPageController.ts
  useThreadHistoryController.ts
  useRunInterventionController.ts
  runs-thread-view-models.ts
  run-detail-view-models.ts
  RunHistoryHeader.tsx
  WorkHistoryList.tsx
  WorkHistoryRow.tsx
  ThreadList.tsx
  ThreadDetailPanel.tsx
  ThreadLineageSection.tsx
  ThreadResumeSection.tsx
  RunDetailPanel.tsx
  RunDetailHeader.tsx
  RunOverviewSection.tsx
  RunTimeline.tsx
  RunApprovalSection.tsx
  RunArtifactSection.tsx
  RunEvidenceSection.tsx
  RunGuidancePanel.tsx
  RunTechnicalDetails.tsx
  RunSkillRecordingDialog.tsx
  ShellSnapshotPanel.tsx

apps/web/src/styles/runs/
  page.css
  history-list.css
  thread-detail.css
  run-detail.css
  timeline.css
  evidence.css
  recording-dialog.css
```

目标名可按现有命名微调，但职责不可重新合并。所有新 production owner 低于 400 行；任何文件接近 400 行
时继续按 section/controller/view-model 拆分。

## 4. State And Request Model

Controller 状态最少分为：

```text
historyLoad: idle | loading-initial | refreshing | stale | failed
threadDetailLoad: per thread id
runDetailLoad: owned by existing runs domain
threadMutation: { threadId, action } | none
runMutation: existing cancel/rerun + focused intervention action
recording: closed | checking | editing | submitting | failed | completed
selection: { threadId?, groupId?, runId? }
```

- 每个 async response 验证 `cwd + object id + request revision`。
- refresh 不清空已加载 list/detail；失败转 stale。
- selected row 被 filter/refresh 移除时，按可见顺序选择相邻对象；无对象时显示 EmptyState。
- late turn/evidence/resume/intervention response 不得写入新 thread/run。
- mutation single-flight 只限制相同对象/行动；不同对象允许独立操作。

## 5. Work Breakdown

| Task | Scope | Dependency | Parallel | Status | Verification | Weight |
|---|---|---|---|---|---|---:|
| P11.2-A | baseline fixture、pure state/action/grouping tests | none | yes | implemented | projection characterization 2/2 | 10% |
| P11.2-B | extract history/thread controller and pure projections | A | no | implemented | request/race/fallback focused coverage | 18% |
| P11.2-C | migrate PageHeader, toolbar, history/thread lists | B | yes with D after interfaces freeze | implemented | focused rerun pending | 17% |
| P11.2-D | extract Run Detail sections and intervention controller | B | yes with C | implemented | focused rerun pending | 22% |
| P11.2-E | extract Thread Detail, lineage, resume/fork/archive/pin | B | yes with D on disjoint files | implemented | focused rerun pending | 16% |
| P11.2-F | recording Dialog + shared forms/feedback | D interface | yes | implemented | focused rerun pending | 7% |
| P11.2-G | CSS migration, screenshots, selected/full regression, docs | C-F | no | verified on Web | focused 7/7; runtime 19/19; selected 3/3; evidence 8/8 | 10% |

总计 `100%`。B 是唯一前置主干；C/D/E 可在 type/interface owner 固定后并行，禁止同时编辑聚合
`RunHistory.tsx`。主 Agent 负责最后 composition 和全局文档。

## 6. Slice P11.2-A/B: Freeze Projections And Extract State

1. 把 `WorkHistoryTurnLoadState`、group/attempt/context types 移入 focused types/view-model。
2. 抽 `buildWorkHistoryTurnGroups`、tree、legacy fallback、search match、status/action/disabled reason 为纯函数。
3. 新 controller 接管 thread list/search/filter/turn load/selection；保留 404-only fallback。
4. 抽 thread detail evidence/resume/fork/archive/pin 请求和 identity guard。
5. 抽 run guidance create/cancel/promote state；不复制 runs domain 的 list/detail/cancel owner。
6. 删除 `window.setTimeout` 驱动的 presentation 清理，改为受控 feedback lifecycle；业务 polling 不因迁移删除。

Exit gate：`RunHistory.tsx` 不再持有 thread API 调用或大段纯 helper；race/fallback/selection tests 先绿。

## 7. Slice P11.2-C: Page And Lists

1. PageHeader 使用 shared Button/IconButton；Refresh busy 只锁自身。
2. Search/archived filter 使用 Field/Input/Select；Escape clear、no-result clear。
3. History/Thread rows 使用 DataRow + one StatusIndicator；支持 Enter/Space。
4. 100 rows 内部滚动，row title/objective/metadata 使用 `min-width:0` 和可读截断。
5. initial loading 使用固定数量 Skeleton；empty、no-result、first error、retained stale 各有唯一 owner。
6. ThreadPage 复用相同 controller/list/detail，不再重复 API state 和 row visual。

Exit gate：`RUN-HISTORY-001` 和 `THREAD-LIST-001` 的 list states implemented，双 View 无重复请求 owner。

## 8. Slice P11.2-D: Run Detail And Intervention

1. Header 派生唯一 primary state/action；Stop、Rerun、Refresh hit area/disabled reason 稳定。
2. Timeline、Approvals、Artifacts/Changes、Evidence、Intervention、Technical details 分 focused sections。
3. pending approval 和 failed repair 优先展开；raw events/leases/transitions/snapshots 默认折叠。
4. Timeline 保留 user-scroll suspension；raw event/code 使用内部 overflow owner。
5. guidance draft 失败保留；create/cancel/promote busy 精确到 action/object。
6. provider/task/approval repair 继续调用现有 navigation callback。
7. Stop/Rerun 等待 domain authority，不乐观宣告 durable success。

Exit gate：`RUN-DETAIL-001`、`RUN-INTERVENTION-001` implemented；全部失败可在 Toast 消失后修复。

## 9. Slice P11.2-E: Thread Detail And Actions

1. Overview、lineage、attempts、evidence、resume/fork、technical sections 使用 InspectorSection。
2. active run 时 Resume/Fork-run 禁用，显示现有 disabled reason。
3. Preview、Resume、Fork、Fork and run、Pin、Archive 各有独立 busy/error。
4. mutation 成功后重新读 authority；refresh 失败保留对象并标 stale。
5. legacy fallback 只显示真实可用 Open run；不显示不可调用 thread actions。
6. Archive/Unarchive 不扩成永久删除；Settings Archived Items 保持唯一 permanent-delete owner。

Exit gate：`THREAD-LIST-001` detail/action states implemented，payload 与既有 API 完全一致。

## 10. Slice P11.2-F: Skill Recording

1. 合并 `RunInspector` 与 `RunEvidencePanel` 的 eligibility/draft/submit owner。
2. 用 shared Dialog 代替 non-modal role=dialog sheet。
3. 所有字段迁 Field/Input/Textarea/Select；validation error 与字段关联。
4. checking/submitting 时阻止重复提交和 premature dismiss；Cancel 初始焦点，close focus restore。
5. duplicate、blocked、recorded、candidate-created 结果产品化；raw route/reason 进入 details。
6. recording success 可 Toast，但 Dialog result/created identity 在关闭前仍可读。

Exit gate：单一 recording owner，validation/failure/success/duplicate/focus/reduced motion 全覆盖。

## 11. CSS Migration

`runs.css` 最终只保留 imports。按以下顺序迁移并在每步删除旧 selector：

| Owner | Budget | Includes |
|---|---:|---|
| `page.css` | <=120 | two-column shell、responsive Drawer switch、root overflow |
| `history-list.css` | <=180 | toolbar、rows、tree、scroll、Skeleton/Empty placement |
| `thread-detail.css` | <=220 | lineage、attempt、resume/fork geometry |
| `run-detail.css` | <=220 | header、summary、section layout |
| `timeline.css` | <=180 | activity list、auto-follow、raw events scroll |
| `event-log.css` | <=160 | raw event disclosure、event rows、payload containment |
| `evidence.css` | <=240 | artifacts、changes、memory、snapshot、technical code |
| `recording-dialog.css` | <=160 | form grid/body scroll only |

P11.2 当时不修改 `components.css`、`strict-console.css` 或 `styles.css`；U13 随后按主线 single-owner 规则
完成重复清理并新增 shared Artifact import。focused owners 不覆盖 `.ling-ui-*`，颜色字面量、`!important`、
`transition:all`、Theme/Profile ID selector、私有 keyframe 或 raw duration 命中保持 0。

## 12. Focused E2E Matrix

新建 `apps/web/e2e/ui2-runs-threads.spec.ts`，至少覆盖：

1. initial loading、empty、100 thread/turn groups、internal scroll、search/no-result/Escape；
2. retained refresh failure/recovery、404 legacy fallback、non-404 first error；
3. durable turn attempts、retry grouping、parent/child lineage、selection preservation/races；
4. run queued/running/waiting approval/failed/cancelled/succeeded/unknown primary state；
5. Stop scoped busy/failure/authority success，Rerun provider disabled reason；
6. guidance create/cancel/promote success/failure and independent busy；
7. Timeline auto-follow suspension、long raw events、artifacts unavailable、shell snapshots；
8. thread resume preview/resume/fork/fork-run/pin/archive/unarchive payload、busy、failure；
9. active run disables resume/fork-run，legacy fallback hides unsupported actions；
10. recording eligibility/validation/duplicate/failure/success、Esc/focus/busy/reduced motion；
11. Light/Dark、zh-CN/en-US、long copy、1280/1440、no document/detail/list overflow；
12. selection/cwd/request race：旧 response 不写入新对象。

`runtime.spec.ts` 保留 19 个现有行为场景，仅在 public role/name 改变时做最小 selector 更新，不继续加入
UI2 changed-state 大场景。

## 13. Screenshot Matrix

| Viewport | Theme | Required state |
|---|---|---|
| 1440x960 | Ling Light | thread-first history + attempts + selected detail |
| 1280x800 | Ling Dark | retained stale/no-result + compact columns |
| 1440x960 | Ling Light | running run + pending approval + Stop |
| 1280x800 | Ling Dark | failed run + provider/task repair |
| 1440x960 | Ling Light | lineage + resume preview + actions |
| 1280x800 | Ling Dark | active-run disabled reason + technical fold |
| 1440x960 | Ling Light | recording validation/duplicate |
| 1280x800 | Ling Dark | long raw event/snapshot internal scroll |

截图使用真实 Vite + daemon fixture，不使用静态 DOM。每张图前断言 console/page error、horizontal overflow、
主题、focus、overlay count 和内部 scroll。metadata 写 SHA-256，不裁剪/缩放后替换原图。

## 14. Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/conversation-ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-runs-threads.spec.ts runtime.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts settings.spec.ts approvals.spec.ts work-board.spec.ts dark-mode.spec.ts
```

Playwright suites 串行或使用唯一端口，不能让多个 webServer 争用 `4174` 后把 connection refused 当产品回归。

## 15. Integration And Rollback

- C/D/E Agent 必须使用不相交新文件；只有主 Agent 修改最终 `RunHistory.tsx` composition 和共享 locale。
- 每个 slice 先过 focused 再删旧 selector；发现回归按 page/list/detail/recording owner 独立回滚。
- API/domain 不变，因此回滚不需要数据迁移；不得用 API 变更掩盖 presentation 问题。
- 合并前检查重复 thread fetch、重复 recording owner、重复 Toast/overlay、状态映射和 mutation payload。

## 16. Completion Gate

四个 Function ID 只有同时满足以下条件才可 `verified`：

- 代码、focused/legacy/selected tests 全绿；
- RunHistory/ThreadPage 无重复 state/request owner，production source <800、新 owner <400；
- 8 张原尺寸 changed-state evidence、metadata、hash、console/overflow 审查完成；
- Light/Dark、双 viewport、zh/en、keyboard、reduced motion 覆盖；
- durable audit、permission、artifact、intervention、thread action 和 legacy fallback 语义未回退；
- Settings Diagnostics、Archived permanent delete、Automation/Task/Approval navigation 回归通过；
- packaged macOS/Windows 缺口诚实留在 P13，不用 Web 截图代替。

## 17. 2026-07-23 Completion Record

- `RUN-HISTORY-001`、`RUN-DETAIL-001`、`RUN-INTERVENTION-001`、`THREAD-LIST-001` 均完成 Web changed-state 验证。
- focused `7/7`，runtime 单次 `19/19`，最终 AppShell/Dark selected `3/3`；所有 Playwright 均使用独立端口与 `workers=1`。
- 8 张截图已核对原始尺寸、SHA-256、主题、locale、changed state、console 和溢出；聚合记录见 `evidence/features/runs-threads/metadata.json`。
- 原图审查暴露并修复了 history DataRow 空列挤压、summary MetaRow 重叠、Thread feedback grid 重叠、recording focus return 和 changed-state 取景问题。
- `runtime.spec.ts` 无需修改；`AppShell.tsx`、locales、全局 CSS 与 Work Board 均未修改。
- 全局 typecheck 命令当前退出 2，唯一报错为禁止范围 `apps/web/src/features/work-board/WorkBoardInspector.tsx:78`；P11.2 不越界修复。
- U13 全局 selector 清理已完成；packaged desktop/forced-colors 验收仍为显式后续项，不纳入 Web verified 结论。
