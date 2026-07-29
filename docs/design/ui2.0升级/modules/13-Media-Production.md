# P10.2 Media Production UI 2.0 零决策设计合同

## 0. 文档状态

- 状态：Web `verified`；packaged macOS/Windows lane pending。
- 审计基线：2026-07-23 当前共享工作树；其中包含未提交的 Media Production 独立修改。
- 本文件冻结 P10.2 的产品、交互、状态、可访问性和验收合同；文件边界、S0-S5、任务依赖、测试命令与证据账本见
  [Media Production implementation plan](./13-Media-Production-implementation-plan.md)。
- P10.2 S0-S5 Web 生产实现、focused evidence 和 closeout 已于 2026-07-23 完成；9 个 Function ID 均为
  `verified`。权威证据见 [Media Production evidence](../evidence/features/media-production/metadata.md)。
- 本合同继续作为行为与回归基准；Web 结论不得继承给 packaged Desktop，macOS/Windows 主机集成与发行证据
  仍由 Desktop lane 独立关闭。

## 1. 产品定位

Media Production 是桌面 Web 的 canvas-first 分镜生产工作区。用户在同一页面中管理项目和有序场景，
在 Storyboard Canvas 上定位场景，在 Inspector 中配置直接视频模型或已验证工作流，运行单场景或项目，
并预览真实 Artifact。`Generation tasks` 仍由 P10.1 Media Jobs 所有，P10.2 只提供既有嵌入入口和场景上下文。

P10.2 的默认层必须让用户回答：

1. 当前项目和场景是否已经权威加载；
2. 当前选择、场景顺序和 Canvas 排布分别是什么；
3. 哪个场景可以运行、正在运行、需要修复或已有可用结果；
4. 下一步是填写输入、配置模型、修复工作流、运行、重试、预览还是删除；
5. 异步操作只锁定哪个对象，失败后在哪里重试或清除错误。

## 2. 非目标与硬边界

- 不新增、修改或删除 daemon API、Web API client、Core、contracts、storage、数据库、迁移或运行状态机。
- 不修改 `apps/desktop/**`，不新增 Desktop-only Media Production renderer；packaged Desktop 证据继续由 P13 所有。
- 不修改 `apps/web/src/features/media/**`、Media Jobs domain、P10.1 CSS、P10.1 tests 或其产品语义。
- 不改变项目、场景、Scene Run、Media Job、Workflow、Artifact 的持久化和删除语义。
- 不新增视频剪辑、时间线、合成导出、协作、移动端、分页历史或虚构的百分比进度。
- 不把 Canvas 改成普通三栏表格页；左右 Dock 覆盖 Canvas，开关 Dock 不改变 Canvas DOM 尺寸、场景坐标或顺序。
- 不向 `AppShell.tsx` 增加请求、状态派生、错误映射、Dialog、Toast timer 或领域 JSX；AppShell 只能挂载页面和传现有
  domain/callback。
- 不回滚或覆盖当前未提交的 Media Production 业务改动，不恢复已被 P10.1 删除的 Media Jobs 兼容 UI。
- 通用 Button、IconButton、Field、Input、Textarea、Select、Tabs、SegmentedControl、StatusIndicator、InlineFeedback、
  EmptyState、Skeleton、InspectorSection、Collapsible、Tooltip、Popover、Menu、Dialog 和 Toast 必须从
  `apps/web/src/shared/ui` 消费。
- 所有 modal surface 必须使用 shared `Dialog` family；禁止 `CreateDialogShell`、手写 `role="dialog"` overlay、
  feature focus trap 和 feature Escape listener。
- Web desktop `1440x960` 与 `1280x800` 是本切片双 viewport；移动端不在验收范围。

## 3. 唯一入口与权威链路

唯一可达入口保持不变：

```text
Sidebar / Media Production
  -> AppShell activeView === "media"
  -> LazyMediaProductionWorkspace
  -> Production studio | Generation tasks
  -> Project/Scene controller + Workflow controller
  -> apps/web/src/api/media-production.ts
  -> existing api-client / daemon routes
  -> existing Core media store
```

权威边界：

- 项目列表以 `listMediaProjects(cwd)` 成功响应为准；“无项目”只能在该响应成功且数组为空后出现。
- 项目详情、场景、Scene Run 以 `getMediaProject(cwd, projectId)` 成功响应为准。
- 项目删除必须复用现有 `deleteMediaProject(cwd, projectId)`；当前 API、client、daemon 和 Core 已存在该能力。
- 场景 mutation 复用现有 create/update/reorder/duplicate/delete/run/select-run/cancel-run API。
- Workflow 复用现有 connection/list/analyze/import/test/activate/archive/delete API。
- Media Job 与 Artifact 数据继续由 AppShell 现有 domain 提供；P10.2 不建立第二份 polling/store。
- 项目删除会移除项目及其场景；既有生成任务和 Artifact 不由该 DELETE 删除。确认文案必须准确表达该边界。

## 4. 2026-07-23 实施前代码审计快照

> 本节保留 S0 开始前的共享工作树事实，用于解释迁移原因，不代表 closeout 后的当前规模。最终结果见 4.4。

### 4.1 当前可达能力

- Project：列表、创建默认未命名项目、选择、改名、默认 direct/workflow 来源配置。
- Scene：创建、选择、编辑、Canvas 拖动、复制、上下排序、带确认的场景删除。
- Toolbar/Canvas：Production studio/Generation tasks 切换、左右 Dock、React Flow pan/zoom/fit、条件 MiniMap、
  多场景顺序边和节点结果入口。
- Inspector：设置/结果/历史，direct provider 与 workflow 配置，图片参考，Scene Run、取消、历史结果选择。
- Workflow：ComfyUI connection 创建/编辑/检查/删除，JSON analyze/mapping/import，test、activate、archive。
- Run/Preview：项目 ready/skipped review、单场景和项目运行、旧结果保留、真实 Artifact preview fallback。
- Media Jobs：既有嵌入视图与 project/scene/workflow display context bridge 可达。

这些能力来自实施前源码和既有测试审计；当时没有重跑浏览器，因此不作为最终运行态验收结论。

### 4.2 实施前缺口

| 缺口 | 当前事实 | P10.2 固定修复 |
|---|---|---|
| 加载假空态 | controller 首屏 `project=undefined`，`isLoading` 未渲染，Workspace 直接显示“新建项目” | initial Skeleton；只有权威空数组显示 EmptyState |
| 错误恢复 | raw `errorMessage` 只有一条 inline error，没有稳定 Retry、dismiss/clear 和 owner | typed failure owner；初始错误 Retry，retained/mutation 错误 Retry + clear，raw detail 折叠 |
| scoped busy | state 虽是字符串，多处以 `Boolean(busyAction)` 锁整页、所有 scene、Canvas 和 toolbar | 按 project/scene/run/workflow/preview owner single-flight；无关选择、预览和导航保持可用 |
| identity/request race | 两个 controller 都没有 cwd epoch 或 request sequence；旧响应和旧 `finally` 可覆盖新 workspace/选择 | cwd epoch + per-owner request id；不匹配响应、错误、Toast 和 busy clear 全部丢弃 |
| i18n | 18 个 production 文件仍含用户可见硬编码中文/英文；只有 toolbar 局部调用 `t()` | 18 文件全部 `useI18n`/Translate 注入；en-US/zh-CN parity gate |
| Workflow overlay | `MediaWorkflowLibraryOverlay.tsx` 手写 overlay/dialog、Escape 和 outside click | shared controlled Dialog，body 单一滚动 owner，busy 阻止 dismiss，focus return 由 shared owner |
| Feature Toast timer | production controller 自建 2 秒 timer，再把 notice 转发到 shared Toast | 删除 `noticeMessage`/timer；mutation 成功直接调用 shared Toast scope，生命周期由 provider 管理 |
| 项目删除 | `deleteMediaProject` API 已存在，但 controller actions、UI 和 Dialog 没有接线 | 首切片接现有 API；shared danger Dialog；成功后权威刷新并选择下一项目 |

### 4.3 实施前规模摘要

- Media Production feature production：22 文件 / 3,666 行；加既有 API wrapper 为 23 文件 / 3,810 行。
- 18 个含用户可见硬编码文案的 production 文件全部列入 i18n 写集合。
- 5 个旧 Media Production CSS：S0 脏树快照 2,432 行；相对 HEAD 的 tracked baseline 为 2,438 行，
  其中多个 owner 超过 400 行目标，最终在 S5 删除。
- `apps/web/e2e/media-production.spec.ts`：842 行 / 8 个测试。
- `AppShell.tsx`：3,164 行，只允许 mount wiring；`MediaProductionWorkspace.tsx`：390 行，已接近 400 行边界。

### 4.4 Web closeout 结果

- 五个旧 CSS owner 已删除（S0 脏树快照 `2,432` 行；相对 HEAD 的删除统计 `2,438` 行），最终替换为 8 个
  focused owner，共 `1,597` 行：
  `canvas 355 / dialogs 165 / dock 103 / index 7 / inspector 288 / project-scene 268 / shell 95 / workflow 316`。
- focused CSS 的颜色字面量、`!important`、`transition: all`、Theme selector 和 package-private
  `.ling-ui-*` 扫描均为 `0`。
- focused E2E `27/27`、legacy Media Production `8/8`、Media Jobs `16/16`、Dark `2/2`、evidence
  `36/36` 通过；Web typecheck、lint、i18n 和 `git diff --check` 通过。
- 36 张原尺寸 PNG 与 36 份 sidecar 覆盖 9 个 Function ID，每项 4 个 changed states；18 张 Light/en-US、
  18 张 Dark/zh-CN，viewport、SHA-256、console/page error、owner/document overflow 和 Canvas/media pixel
  合同全部通过。
- 该结论只关闭 desktop Web。packaged macOS/Windows 与 Desktop host integration 仍 pending。
- closeout 后的纯 CSS owner refinement 将 Dock 从 Canvas 拆出并收窄 Inspector；独立端口 focused + legacy
  `35/35` 通过，没有重新打开任何 Web ID。

## 5. Canonical Function IDs

P10.2 只使用以下 9 个 canonical Function ID；旧覆盖矩阵的聚合行不得减少本文件的独立计数。

| Function ID | 用户触发 | 权威 owner | 必须覆盖 |
|---|---|---|---|
| `PROD-PROJECT-001` | 进入页面、新建、选择、改名、配置默认来源、刷新 | project controller + outline | initial/refresh/empty/detail/load error/create/update/selection race/long name |
| `PROD-SCENE-001` | 新建、选择、编辑、复制、排序、移动 | scene controller + outline/inspector/canvas | empty/list/dirty/save/create/duplicate/reorder/move/failure/project switch |
| `PROD-TOOLBAR-001` | studio/jobs、Project Dock、检查/生成、修复来源 | toolbar controller/view model | no project/no source/no ready/ready/run busy/view switch/1280 overflow |
| `PROD-CANVAS-001` | 选择、拖动、pan、zoom、fit、Dock 开关 | StoryboardCanvas + layout helpers | zero/one/many/long/far node/selection/focus/minimap/reduced motion/nonblank pixel |
| `PROD-INSPECTOR-001` | 打开场景、Settings/Result/History、编辑来源和参数 | inspector UI + pure projections | no selection/direct/workflow/dirty/saving/blocker/result/history/error/close-return |
| `PROD-WORKFLOW-001` | 打开流程库、连接、导入、映射、测试、启用、归档 | workflow controller + shared Dialog | loading/empty/connection/import/validation/test/status/archive/error/race/busy dismiss |
| `PROD-RUN-001` | 单场景运行、项目 review/run、取消、重试、选择历史结果 | run actions + readiness projection | ready/skipped/queued/running/approval/success/fail/cancel/regenerate/old-result retained |
| `PROD-PREVIEW-001` | 节点/Inspector 打开结果、retry、下载、打开任务复用设置、关闭 | preview Dialog + existing Artifact/Media Jobs bridge | closed/loading/image/video/error/retry/download/open-task/focus/pixel invariant |
| `PROD-DELETE-001` | 删除项目或场景 | delete intents + shared Dialog | closed/review/busy/failure/retry/success/focus return/cwd race |

## 6. 页面结构与稳定布局

```text
MediaProductionWorkspace
  MediaProductionCanvasToolbar
  Studio
    MediaProductionLoadState | EmptyProjectState | CanvasStage
      StoryboardCanvas
      MediaProductionDockRail
      ProjectSceneOutline (left overlay dock)
      SceneInspector (right overlay dock)
  GenerationTasksHost (existing P10.1 surface)
  Shared Dialog slot (one discriminated overlay at a time)
    ProjectDeleteDialog | SceneDeleteDialog | ProjectRunReviewDialog
    SceneResultPreviewDialog | MediaWorkflowLibraryDialog | WorkflowDangerDialog
```

- CanvasStage 是稳定尺寸 owner；Dock 开关只能改变 overlay visibility/safe-area，不改变 stage width/height。
- `1440x960` 可同时显示左右 Dock；`1280x800` 使用互斥 Dock，打开一个先关闭另一个。
- 左 Dock 宽 `300px`，右 Dock 宽 `360px`；viewport 每侧至少保留 `16px`，Dialog 每侧至少保留 `16px`。
- toolbar、dock rail、Canvas controls 和节点必须有稳定尺寸，busy/icon/text 不得改变几何。
- 长项目名、长场景名、长 workflow 名使用 `minmax(0,1fr)` + ellipsis；完整值通过 Tooltip/title 或 Inspector 可达。
- 页面根、CanvasStage、Dock、Inspector、Workflow Dialog body 分别拥有明确滚动边界；禁止 document 横向溢出。

## 7. 统一状态、竞态、错误与反馈合同

### 7.1 Load identity

- `workspaceEpoch` 由 trim 后 `cwd` 变化递增；unmount 同样失效当前 epoch。
- project list、project detail、project refresh、workflow load 各有单调 request id。
- commit 条件固定为：epoch 相同、request id 仍是该 owner 最新值、响应对象仍匹配请求 project/workflow identity。
- stale response 不得写 list/detail/selection/failure/busy/Toast；旧 `finally` 不得清除新请求 busy。
- 选择项目期间使用 `pendingProjectId`；详情成功才提交 `selectedProjectId`。失败恢复原选择并显示可重试错误。
- cwd 改变立即清空 selection、draft、overlay、failure、pending focus、feature localStorage-derived transient state；
  左 Dock 的纯布局 preference 可以保留。

### 7.2 Scoped busy

| Owner | 只锁定 | 保持可用 |
|---|---|---|
| project list/detail | Refresh 或 pending project option | 当前 retained content、view switch；initial 无内容时只显示 Skeleton |
| create/update project | 对应 create trigger 或 project field | scene selection、Canvas、preview、jobs view |
| delete project | 当前 danger Dialog 全部 dismiss/confirm controls | modal 外不可交互，由 Dialog trap 负责 |
| create/reorder scene | add trigger 或排序 controls | Inspector tab、preview、unrelated scene selection |
| update/duplicate/move scene | 目标 scene/field/node | 其他 scene 和 toolbar |
| run project | Project Run Dialog confirm | review body；Dialog 外不可交互 |
| run/cancel/select run | 目标 scene/run action | 当前 Artifact preview、其他 scene |
| workflow mutation | 目标 connection/workflow/import action | Dialog tabs/list selection，除非会破坏当前 draft |
| preview content | preview frame Retry | Dialog close/download only when valid；页面 selection 不变 |

同一 owner/对象必须 single-flight；双击不得产生第二次 mutation。不同 owner 是否可并行只按上表，不使用全局布尔值。

### 7.3 Failure ownership

- failure 是 `{ owner, subjectId?, productMessageKey, technicalMessage?, retryIntent }`，不把 raw server text 直接放默认层。
- initial load failure：占据页面状态，显示 Retry，不显示假 EmptyState，不允许 dismiss 成无解释空白。
- retained refresh/detail failure：保留最后成功内容，显示 warning InlineFeedback，提供 Retry 和 clear。
- field validation：贴近 Field，输入变化清除；server mutation failure 保留到 retry、成功、clear 或 identity 改变。
- Dialog mutation failure 留在 Dialog；失败不得关闭 Dialog、丢失 draft 或提前改变 selection。
- preview content failure 留在 preview frame；Retry 只重载内容，不重跑 scene、不改变当前结果。

### 7.4 Overlay ownership

Workspace 使用单一 discriminated overlay：`none | delete-project | delete-scene | run-project | preview | workflow | workflow-danger`。
打开新 overlay 必须先关闭非 busy 旧 overlay；busy overlay 不接受替换。所有 overlay 使用 shared Dialog 的 focus trap、
Escape、outside click、portal、scroll lock 和 focus return；feature 不注册 document Escape listener。

### 7.5 Feedback

- 成功使用 `useLingToast().showToast`，scope 固定为 `media-production:<owner>:<subject>`；相同 scope 去重。
- 不设置 feature `setTimeout`、不维护 notice state、不复制 Toast DOM/CSS。
- update project/scene 的轻量成功使用 provider 默认 success duration；delete/run/import 等结果只在用户需要确认完成时 Toast。
- warning/error 不用自动消失 Toast 代替 owner InlineFeedback；raw diagnostics 进入默认关闭的 Collapsible。

## 8. `PROD-PROJECT-001` state matrix

| State | 进入条件 | 默认呈现 | 可执行动作 | 恢复/退出 |
|---|---|---|---|---|
| initial-loading | cwd 有效、尚无成功 list | page Skeleton + toolbar shell；无 Create CTA | 无项目 mutation | list success -> empty/loaded；failure -> initial-error |
| authoritative-empty | list success 且 `[]` | shared EmptyState“创建第一个媒体项目” | Create project | create success -> loaded |
| loaded | list/detail success | committed project、scene count、default source | select/create/rename/configure/delete/refresh | mutation owner 独立 |
| refreshing-retained | loaded 后 Refresh | 内容保留，Refresh icon busy，stale label 不出现 | selection/preview/jobs view | success replace；failure -> retained-error |
| selecting-project | 选择不同 project | option pending + content Skeleton；旧 project 不冒充新 project | 可取消为旧选择；无 scene mutation | detail success commit；failure revert |
| initial-error | list 首次失败 | danger InlineFeedback + Retry + folded details | Retry | success 清除；cwd change 清除 |
| retained-error | refresh/detail 失败且有旧内容 | warning InlineFeedback，旧内容明确 stale | Retry/Clear | retry success 或 clear |
| create-busy/failure | one-click create | 仅 create trigger busy；failure 在 project owner | Retry/Clear | success select returned project + Toast |
| update-dirty/busy/failure | name/default source 修改 | local draft；目标 Field busy；失败保留 draft | Retry/Clear/revert | success commit + scoped Toast |
| long-list/name | >=100 projects 或超长名称 | selector/rows scroll，文本 ellipsis | keyboard select | 无 document overflow |

## 9. `PROD-SCENE-001` state matrix

| State | 进入条件 | 默认呈现 | 可执行动作 | 恢复/退出 |
|---|---|---|---|---|
| no-scenes | project detail success 且 scenes `[]` | Canvas 与 outline 各一个一致 EmptyState | Add first scene | success select/open Inspector |
| loaded-unselected | scenes 非空但无有效 selection | 第一 scene 由 detail commit 规则选中 | select scene | 进入 selected |
| selected | scene id 存在 | outline、node、Inspector 单一选中 | edit/duplicate/reorder/move/delete/run | selection 不受 Dock 开关影响 |
| local-dirty | title/prompt/field 改动未提交 | Field 显示 draft，不改其他 scene | blur/explicit select 提交；Esc 恢复字段值 | save success/failure |
| save-busy/failure | update scene in flight/fail | 只锁目标 Field/scene；failure 贴 owner | Retry/Clear/revert | success authoritative patch + Toast |
| create/duplicate-busy | action in flight | 只锁触发按钮与目标 duplicate | 其他 scene 可选 | success load detail + select new scene |
| reorder-busy/failure | order request | 只锁排序 controls；Canvas position 不变 | preview/Inspector 可用 | success authoritative order；failure 恢复旧 order |
| move-busy/failure | node drag stop | node 固定在 optimistic position；该 node 不可再拖 | 其他 node 可操作 | failure 回退 committed position + InlineFeedback |
| project-switch-race | scene mutation/detail 后切 project/cwd | 新 project 不接收旧 response/selection/Toast | 新 project actions | stale response 丢弃 |
| long-tree | 100 scenes/长标题 | rail 独立滚动，order 与 action cell 固定 | keyboard row selection | no overlap/overflow |

## 10. `PROD-TOOLBAR-001` state matrix

| State | 呈现 | Primary action | Busy/keyboard | Gate |
|---|---|---|---|---|
| no project/loading | project trigger + stable segmented control | 无 run action | view switch 可用；loading 不抖动 | 不显示假 scene count |
| project/no source | project name + scene count | Configure video model | 只在 callback busy 时锁 action | 路由到现有 Model Workbench |
| source/no ready | project summary | Check scenes | 打开 shared review Dialog | 不显示“生成 0 个” |
| ready scenes | ready count | Generate `{count}` scenes | run owner busy；双击 single-flight | count 等于 review.ready |
| studio selected | SegmentedControl studio selected | Canvas actions | Arrow keys/Home/End 由 shared owner | selection ARIA 正确 |
| jobs selected | SegmentedControl jobs selected | P10.1 toolbar 接管 | 不重复 H1/说明 | 不修改 Media Jobs |
| 1280/long name | 文本 ellipsis，actions 不换成两行遮挡 | 同上 | Tab 顺序稳定 | toolbar 无横向溢出 |

## 11. `PROD-CANVAS-001` state matrix

| State | 呈现 | Interaction | Motion/pixel | Gate |
|---|---|---|---|---|
| no scene | shared EmptyState，CanvasStage 尺寸稳定 | Add first scene | 无假 node | 与 Scene empty 同源 |
| one scene | 一个固定尺寸 node，无 MiniMap | select/drag/pan/zoom/fit | selected outline/focus visible | nonblank pixel |
| many scenes | ordered edges、条件 MiniMap、legend | select/drag/pan/zoom/fit | controls 不遮 Dock/MiniMap | 100 nodes 可达 |
| selected/focus request | node selected，安全区内 focus | click/keyboard select | normal motion <=250ms | 不修改 order/position |
| far/long content | fit 后目标进入 safe area，文案 ellipsis | Fit View | frame 非空 | no clipping |
| dock transition | overlay dock open/close | rail buttons/Escape | stage geometry前后相同 | 1280 docks 互斥 |
| node move busy/fail | 目标 node scoped state | drag single-flight | no layout shift；fail rollback | 其他 node 不锁 |
| reduced-motion | media query reduce | 全部 action 可用 | fit/focus/dock duration `0ms` | 无位移/闪烁动画 |
| theme switch | UI token 改变 | Canvas 保持功能 | Artifact 像素不变；Canvas 非全空/纯色 | 无 filter/opacity/blur 污染 |

## 12. `PROD-INSPECTOR-001` state matrix

| State | 默认呈现 | Actions | Failure/exit | Gate |
|---|---|---|---|---|
| no selection | 右 rail disabled，不挂空 Inspector | select scene | selection 后打开 | 无伪空面板 |
| settings/direct ready | title、prompt、source、ratio、duration、refs | edit/run/duplicate/delete | per-field owner | shared Field/Select/Button |
| settings/direct blocked | 产品化模型原因 | Configure model | return 后重算 readiness | raw provider 默认折叠 |
| settings/workflow ready | workflow + mapped fields | edit/run/open library | field validation local | 不显示 direct fields |
| settings/workflow blocked | missing/archived/connection issue | Open workflow/connection | refresh 后重算 | 路由精确 |
| dirty/saving/failure | draft、目标 Field busy、InlineFeedback | Retry/Clear/revert | scene switch 只丢弃未提交 local draft并恢复权威值 | 不锁整个 Inspector |
| result-empty | 无 current Artifact | Run/repair | state update 后刷新 | 不显示坏 preview |
| result-current | current Artifact + source/status | Preview/open task/regenerate | latest issue 单独显示 | 旧结果在 regenerate/fail 时保留 |
| history-empty/mixed | EmptyState 或 ordered runs | select result/cancel active | per-run busy/failure | status 单一、raw details folded |
| close/reopen | Inspector overlay hidden | rail reopen | 恢复 scene selection 和 tab | Canvas geometry不变 |

## 13. `PROD-WORKFLOW-001` state matrix

| State | 默认呈现 | Actions | Failure/exit | Gate |
|---|---|---|---|---|
| dialog-loading | shared lg Dialog + Skeleton | Close only when not busy | load failure -> retained/initial error | focus trap/return |
| no connections | connection onboarding | Create connection | validation near Field | 不显示 workflow detail |
| connection-ready | list + selected detail + health | edit/check/new/delete | target busy；delete shared Dialog | secret 不回显 |
| connection-error | product status + folded raw health | Check/Retry/Clear | success clear | 不把全库标失败 |
| no workflows | workflow onboarding | Import/Open connections | action scoped | 单一导入 CTA |
| analyze/import | file selected/analyzing/mapping | edit mappings/cancel/import | invalid type/>5MB/local JSON error | draft 保留，busy 不 dismiss |
| mapping-invalid | field/output error | correct mapping | input change clear | import disabled |
| test queued/running | status + linked Media Job | wait/open tasks/cancel if existing semantics allow | refresh uses existing jobs | 不虚构 percent |
| test failed | 产品原因 + folded technical | Retry test/repair connection | owner failure persists | draft/input retained |
| tested/ready | version status | Activate/use in scene | scoped Toast | only tested version可启用 |
| archived/missing selection | archived weak row 或新 selection | select active workflow | refresh repairs selection | scene readiness重算 |
| refresh race | cwd/overlay identity changed | 新 identity only | stale response丢弃 | 无旧 Toast/error |

## 14. `PROD-RUN-001` state matrix

| State | 默认呈现 | Action | Busy/failure | Gate |
|---|---|---|---|---|
| project review none ready | shared Dialog，skipped reasons | Close/repair scene | 无 submit | 不出现 0-run action |
| project review mixed | ready ordered list + skipped list | Generate ready count | confirm single-flight；busy blocks dismiss | request sceneIds精确等于 ready |
| scene ready | readiness `ready` | Run scene | target scene only | creates existing run/job |
| queued/running | single generating state | view history/cancel | target run owner | no fake percent |
| waiting approval | waiting status + exact repair/open approval | Open approvals/cancel existing run | other scene available | 不自动批准 |
| succeeded | current result status | preview/select/open task/regenerate | result retained | current artifact authoritative |
| regenerate active | current result + “updating” | preview old/cancel new | run busy only | old result remains selected |
| failed | product reason + folded raw | Retry/repair | owner failure clear on success | old result retained if any |
| cancelled | cancelled status | Retry/select older result | per-run action | no success styling |
| select historical | history row action | Set current | target row busy/failure | preview changes only after success |
| cwd/request race | run resolves after identity change | no old UI commit | suppress old Toast/error/finally | server truth left to old cwd |

## 15. `PROD-PREVIEW-001` state matrix

| State | 默认呈现 | Actions | Close/focus | Pixel gate |
|---|---|---|---|---|
| closed | no Dialog | open from node/result/history | trigger retained | no selection change |
| loading | shared Dialog frame + Spinner/Skeleton | Close | Escape/outside allowed | stable frame geometry |
| image ready | contain image、metadata-neutral UI | Download、Open task、Reuse settings via existing task view | close returns trigger | decoded media pixel hash theme-equal |
| video ready | `<video controls preload="metadata">`，不 autoplay | Play、Download、Open task | close stops playback/returns focus | no CSS filter/opacity/blend |
| content error | InlineFeedback “Preview unavailable” | Retry、Download fallback、Open task | error retained until retry/close | broken bytes不伪装 ready |
| retry busy | frame-only busy | Close remains available | does not run scene | one content request |
| open task/reuse | switch to Generation tasks and select current job | existing P10.1 Reuse settings | preview closes after navigation | 不复制 Media Jobs form |
| long title/1280 | title ellipsis，body owns overflow | all actions reachable | Dialog edges >=16px | no viewport overflow |

## 16. `PROD-DELETE-001` state matrix

| State | 项目删除 | 场景删除 | Busy/failure/focus |
|---|---|---|---|
| closed | danger action in project settings | danger icon in scene row/Inspector | trigger owns focus return |
| review | shared Dialog：name、scene count、项目/场景后果、jobs/artifacts retained | shared Dialog：scene name、项目移除、jobs/artifacts retained | Cancel/Escape/outside close |
| confirming | `deleteMediaProject` once | `deleteMediaScene` once | confirm busy；Cancel/Escape/outside/close blocked |
| failure | Dialog stays open，draft target unchanged，InlineFeedback + Retry/Clear | 同左 | selection/content unchanged，technical folded |
| project success | close，移除 deleted id，权威 refresh，选择下一项目或 authoritative empty | n/a | scoped success Toast，focus到 project trigger/empty CTA |
| scene success | n/a | close，权威 detail refresh，选择后继、前驱或空 scene | scoped success Toast，focus到 selected row/Add CTA |
| cwd race | 不向新 cwd 提交 selection/error/Toast | 同左 | stale response/finally ignored |
| repeated click | no second request | no second request | single-flight asserted |

## 17. i18n、键盘、ARIA 与 reduced motion

### 17.1 i18n

当前以下 18 个 production 文件含用户可见硬编码文案，P10.2 必须全部迁移：

`MediaProductionCanvasToolbar.tsx`、`MediaProductionDockRail.tsx`、`MediaProductionWorkspace.tsx`、
`ProjectRunReviewDialog.tsx`、`ProjectSceneOutline.tsx`、`SceneDeleteDialog.tsx`、
`SceneExecutionSettings.tsx`、`SceneInspector.tsx`、`SceneResultPreviewDialog.tsx`、`StoryboardCanvas.tsx`、
`media-production-view-models.ts`、`use-media-production-controller.ts`、
`workflows/MediaWorkflowLibraryOverlay.tsx`、`workflows/WorkflowConnectionWorkspace.tsx`、
`workflows/WorkflowFieldRenderer.tsx`、`workflows/WorkflowImportMappingEditor.tsx`、
`workflows/WorkflowLibraryWorkspace.tsx`、`workflows/use-media-workflow-controller.ts`。

- 英文用户文案作为现有字典 key，`en-US` 是完整英文，`zh-CN` 是完整中文；动态值使用 `{count}`、`{name}`、
  `{duration}` 插值，不在 JSX 拼接语序。
- status/reason projection 接收 `Translate` 或返回 key+values，纯 view model 不直接硬编码 locale text。
- 日期使用当前 locale，不固定 `zh-CN`；技术 ID、provider/workflow 原名不翻译。
- static gate：上述 18 文件不得残留用户可见汉字；locale parity 和 missing-key gate 必须为零。

### 17.2 Keyboard/ARIA

- SegmentedControl/Tabs 使用 shared roving keyboard；Project/Scene rows Enter/Space 选择，箭头只在控件自身语义内移动。
- Canvas controls 保留 React Flow 键盘能力；scene node 有可读 label，preview 是独立可聚焦 IconButton。
- Dock rail IconButton 提供 label/Tooltip；Escape 先关闭顶层 shared Dialog，再右 Dock，再左 Dock。
- Dialog 初始 focus：delete confirm 前的 Cancel 或首个安全控件；workflow 首个 tab/Field；preview close；run review close。
- busy Dialog 不可 dismiss；结束后 focus 返回精确 trigger。删除成功 trigger 消失时按第 16 节 fallback。
- error 使用 `role=alert`，loading/status 使用 `role=status`；不得用颜色作为唯一状态信号。

### 17.3 Motion

- hover/selected 只使用 shared `120ms` color/background/border token；Dock 可使用 shared panel transition。
- `prefers-reduced-motion: reduce` 下 Dock、Dialog、Tabs、Canvas focus/fit 的动画 duration 为 `0ms`，不改变功能。
- 禁止 feature keyframes、scale bounce、模糊转场；媒体元素不受 transition/filter/opacity 动画影响。

## 18. Theme、viewport、console、overflow 与 Canvas pixel

- 每个 Function ID 必须在 `ling-light`、`ling-dark` 和 `1440x960`、`1280x800` 的 2x2 组合中至少有一张
  changed-state 原尺寸证据；证据文件名和状态由 implementation plan 第 11 节冻结。
- 每个 focused scenario 收集 `console.error`、page error、failed request；预期 mock failure 只能由 fixture ledger allowlist，
  UI 不得产生未解释 console/page error。
- 每个 Function ID 都断言 `documentElement.scrollWidth <= clientWidth`，并断言其 page/Dock/Dialog/Canvas owner
  没有不可达横向 overflow。
- Canvas element screenshot 必须尺寸大于零、不是透明/单色空图，scene node 与 controls 有非背景像素；selected node
  在 safe area 内，controls/MiniMap/Dock 不重叠。
- Artifact image 的 decoded pixel hash 在 Light/Dark 相同；video 断言 `filter:none`、`opacity:1`、
  `mix-blend-mode:normal`，且 poster/content frame 不被 artwork overlay 覆盖。
- imported Theme 可以作为额外回归，不替代 Light/Dark 2x2 证据。

## 19. Function 回归门槛

| Function ID | Focused gate | 必须联合回归 | 完成证据 |
|---|---|---|---|
| `PROD-PROJECT-001` | loading/empty/error/retry/select/create/update/race | AppShell navigation + legacy media-production | 2x2 screenshots + console/overflow |
| `PROD-SCENE-001` | empty/create/edit/duplicate/reorder/move/long/race | legacy media-production | 2x2 screenshots + scoped busy |
| `PROD-TOOLBAR-001` | no source/check/run/view switch/long | ui2-media-jobs + app shell selectors | 2x2 screenshots + keyboard |
| `PROD-CANVAS-001` | zero/one/100/far/dock/minimap/fit/reduce | legacy media-production + dark mode | 2x2 screenshots + nonblank pixel |
| `PROD-INSPECTOR-001` | direct/workflow/dirty/blocker/result/history | model workbench + media jobs | 2x2 screenshots + keyboard/overflow |
| `PROD-WORKFLOW-001` | loading/connection/import/test/activate/archive/error/race | media jobs workflow repair | 2x2 screenshots + Dialog focus |
| `PROD-RUN-001` | review/scene/project/approval/success/fail/cancel/regenerate | media jobs + approvals | 2x2 screenshots + request count |
| `PROD-PREVIEW-001` | image/video/error/retry/download/open task | ui2-media-jobs preview | 2x2 screenshots + media pixel hash |
| `PROD-DELETE-001` | project/scene cancel/busy/fail/retry/success/race | legacy media-production | 2x2 screenshots + focus return |

任一 ID 的 state matrix、2x2 evidence、focused test、console/overflow 或关联回归未来发生回退，该 ID 必须重新
打开；不得用别的 ID、P10.1 evidence、typecheck 或单张静态截图代替。2026-07-23 closeout 已满足全部 Web gate。

## 20. 完成定义

以下 Web closeout gate 已于 2026-07-23 全部满足：

1. 9 个 canonical Function ID 均按本合同实现，未扩大 API/Core/Media Jobs/Desktop 边界；
2. S0-S5 按 implementation plan 的互斥写集合完成，AppShell 仍只有 mount wiring；
3. 初始加载不再显示假空态，错误具备 owner、Retry/clear，busy 与 request identity 正确；
4. 项目删除复用现有 API，项目/场景/工作流危险动作全部使用 shared Dialog；
5. 18 文件 i18n、Light/Dark、双 viewport、keyboard、reduced motion、console、overflow 和 Canvas/media pixel gate 全绿；
6. focused、legacy、Media Jobs、Model Workbench、Approvals、AppShell/theme 联合回归全部通过；
7. 原尺寸证据、sidecar、SHA-256 和人工逐图审查真实存在并链接到 9 个 Function ID；
8. production/CSS owner 满足 implementation plan 行数上限，没有新增 >800 行 production 文件；
9. Web 生产和 evidence 已按 [证据账本](../evidence/features/media-production/metadata.md) 完成；Desktop 状态继续
   独立保持 pending，不得由 Web verified 推导。
