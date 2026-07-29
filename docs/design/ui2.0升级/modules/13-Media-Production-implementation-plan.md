# P10.2 Media Production UI 2.0 零决策实施计划

## 0. Execution contract

Status: Web `verified`；packaged macOS/Windows lane pending。

设计合同：[P10.2 Media Production UI 2.0](./13-Media-Production.md)。

本计划记录已完成的 S0-S5 实施顺序并继续约束后续回归。执行者必须：

- 保留共享脏工作树全部既有改动；禁止 reset、clean、stash、switch、rebase、merge、commit 和 push。
- 以切片开始时的当前文件为基线，不用 `origin/main`、HEAD 或旧文档覆盖未提交 Media Production 改动。
- 严格按 S0 -> S1 -> S2 -> S3 -> S4 -> S5 的集成顺序；每个文件只属于一个切片写集合。
- 只改 Web Media Production、薄 AppShell mount、focused CSS/i18n/tests 和最终 P10.2 evidence/docs。
- 不改 API/Core/contracts/storage/Desktop/Media Jobs production、Media Jobs CSS 或 Media Jobs E2E。
- AppShell 只保留 import、mount 和现有 callback/props 传递；任何请求、状态、派生、Dialog、错误和 Toast 进入
  focused owner。
- 所有 Dialog 使用 `apps/web/src/shared/ui` 导出的 shared primitive；不保留 feature overlay/focus/Escape owner。
- S0 是首个生产切片，固定为 `Project / Scene / Delete / Loading owner`，并一次性登记完整 P10.2 en-US/zh-CN
  locale catalog；不得先做 Canvas、Workflow 或视觉清理。
- S5 已于 2026-07-23 生成真实 evidence 并跑完回归；Web 状态已推进到 `verified`，Desktop 不继承该状态。

## 1. Authoritative baseline

### 1.1 2026-07-23 production snapshot

> 下表来自当前共享工作树 `wc -l`。它是实施前快照，不是目标行数，也不是完成证据。

| 当前 production owner | 行数 | 当前责任/审计 |
|---|---:|---|
| `MediaProductionCanvasToolbar.tsx` | 72 | view switch、project action；局部 i18n，raw buttons |
| `MediaProductionDockRail.tsx` | 30 | left/right dock triggers；硬编码文案 |
| `MediaProductionWorkspace.tsx` | 390 | composition、overlay booleans、layout effects、Toast bridge、jobs/workflow bridge；接近 400 |
| `ProjectRunReviewDialog.tsx` | 61 | project ready/skipped review；`CreateDialogShell` |
| `ProjectSceneOutline.tsx` | 196 | project/scene/source settings；blanket busy；无 project delete |
| `SceneDeleteDialog.tsx` | 35 | scene danger confirm；`CreateDialogShell`，调用方提前关闭 |
| `SceneExecutionSettings.tsx` | 262 | direct/workflow fields、reference assets；raw controls |
| `SceneInspector.tsx` | 284 | settings/result/history/run；blanket busy、固定 zh-CN 日期 |
| `SceneResultPreviewDialog.tsx` | 34 | current Artifact preview；`CreateDialogShell` |
| `StoryboardCanvas.tsx` | 382 | React Flow、node、fit/focus/MiniMap；固定 motion 和硬编码文案 |
| `media-job-host-bridge.ts` | 103 | P10.1 context/repair bridge；纯 helper |
| `media-production-layout.ts` | 84 | Dock/Canvas safe-area pure helpers |
| `media-production-types.ts` | 74 | broad state/actions/page props；无 typed owner/race contract |
| `media-production-view-models.ts` | 252 | readiness/run projections；返回 locale 文案 |
| `use-media-production-controller.ts` | 342 | list/detail/all mutations；单 busy/error、feature timer、无 identity guard |
| `workflows/MediaWorkflowLibraryOverlay.tsx` | 77 | 手写 modal/Escape/outside click |
| `workflows/WorkflowConnectionWorkspace.tsx` | 201 | connection list/form/check/delete；blanket busy |
| `workflows/WorkflowFieldRenderer.tsx` | 77 | workflow dynamic fields；硬编码文案 |
| `workflows/WorkflowImportMappingEditor.tsx` | 121 | analysis mapping；raw controls |
| `workflows/WorkflowLibraryWorkspace.tsx` | 273 | list/import/test/activate/archive；blanket busy |
| `workflows/media-workflow-types.ts` | 50 | workflow state/actions |
| `workflows/use-media-workflow-controller.ts` | 266 | workflow load/mutations；单 busy/error、无 identity guard |
| **Feature subtotal** | **3,666 / 22 files** | 当前 feature production 总量 |
| `apps/web/src/api/media-production.ts` | 144 | 既有 API wrappers，包含 `deleteMediaProject`；禁止修改 |
| **Feature + API** | **3,810 / 23 files** | API 不属于 P10.2 写集合 |

Integration snapshot：

| 文件 | 行数 | P10.2 边界 |
|---|---:|---|
| `apps/web/src/app/AppShell.tsx` | 3,164 | 只允许 S0 mount wiring，不加业务逻辑 |
| `apps/web/src/styles.css` | 88 | 只允许 S5 将 5 个旧 import 换成一个 focused index import |
| `apps/web/src/i18n/locales/en-US.ts` | 3,901 | S0 一次性登记完整 P10.2 keys；S1-S5 只读 |
| `apps/web/src/i18n/locales/zh-CN.ts` | 5,573 | S0 同步登记同构中文 catalog；S1-S5 只读 |

### 1.2 2026-07-23 CSS/test snapshot

| 当前 owner | 行数 | 审计结论 |
|---|---:|---|
| `media-production.css` | 701 | shell/project/scene/canvas 混合，>400 |
| `media-production-inspector.css` | 550 | inspector/dialog 混合，>400 |
| `media-production-canvas-first.css` | 361 | Canvas/Dock/toolbar 混合 |
| `media-production-priority-refinement.css` | 173 | 后置优先级修补 |
| `media-workflows.css` | 647 | overlay/connection/import/workflow 混合，>400 |
| **CSS subtotal** | **2,432 / 5 files** | S5 精确删除并迁入 focused owners |
| `apps/web/e2e/media-production.spec.ts` | 842 / 8 tests | 业务回归存在；缺完整 UI2 state/evidence/race/i18n/pixel gate |

### 1.3 Confirmed behavior gaps

1. 首次 list 请求前和请求中会渲染 `EmptyStudio`，形成“无项目”假状态；`isLoading` 没有 UI owner。
2. project/workflow error 只有 raw string；没有 initial/retained distinction、Retry intent、clear lifecycle。
3. 一个 `busyAction` 被多处转成 `Boolean`，无关场景、Canvas、toolbar 和 workflow 控件被一起锁定。
4. project/workflow list/detail/mutation 都没有 cwd epoch/request sequence；stale response 与旧 `finally` 可覆盖新 identity。
5. 设计合同列出的 18 个 production 文件仍有用户可见硬编码文案。
6. Workflow Library 仍是手写 overlay；其 focus trap、scroll lock 和 busy dismiss 不能由 shared owner保证。
7. production controller 用 `setTimeout(2000)` 维护 notice，再转发 shared Toast，生命周期重复。
8. `deleteMediaProject` 已存在于 Web API wrapper/client/daemon/Core，但 controller/UI/Dialog 未调用。
9. 场景和项目 run/delete Dialog 的调用方在 Promise 成功前关闭，失败无法留在原 Dialog owner。

## 2. Target module boundary and line guards

### 2.1 Responsibility boundary

| Layer | Owner | 可以做 | 禁止做 |
|---|---|---|---|
| App mount | `AppShell.tsx` | 传 cwd/providers/jobs/artifacts/callback；选择 existing media job | fetch、derive、Dialog、failure、Toast、timer |
| Composition | `MediaProductionWorkspace.tsx` | 组合 child、单一 overlay、dock/view/focus intent | 直接 API、readiness 规则、raw error mapping |
| Request state | two focused controllers | existing API、epoch/request guard、scoped busy/failure、structured outcome | JSX、CSS、Dialog lifecycle、locale sentence |
| Domain logic | focused view-model/helper files | readiness、project review、status/action projection、layout、job context | React state、API call、Toast |
| UI | focused TSX | shared primitives、translated copy、events、ARIA | API import、server truth解析、feature overlay implementation |
| API/client | existing files | 只消费 | 任何 P10.2 修改 |
| Types | `media-production-types.ts` / workflow types | discriminated state、owner ids、props、outcomes | duplicated contracts/Core types |
| Tests | focused specs/fixture | route fixture、race、a11y、visual/pixel/evidence | production-only test hooks、真实 provider side effects |

### 2.2 Target tree

```text
apps/web/src/features/media-production/
  MediaProductionWorkspace.tsx                 composition <=240
  MediaProductionLoadState.tsx                 initial/retained load UI <=140
  MediaProductionCanvasToolbar.tsx             toolbar <=140
  MediaProductionDockRail.tsx                  dock triggers <=100
  ProjectSceneOutline.tsx                      project/scene rail <=300
  ProjectDeleteDialog.tsx                      shared danger Dialog <=140
  SceneDeleteDialog.tsx                        shared danger Dialog <=140
  StoryboardCanvas.tsx                         React Flow owner <=400
  SceneInspector.tsx                           inspector composition <=220
  SceneExecutionSettings.tsx                   settings fields <=300
  SceneResultPanel.tsx                         current result/issue <=180
  SceneRunHistory.tsx                          history/actions <=240
  ProjectRunReviewDialog.tsx                   shared Dialog <=180
  SceneResultPreviewDialog.tsx                 shared Dialog <=180
  use-media-production-controller.ts           request state <=400
  media-production-types.ts                    state/type contracts <=240
  media-production-project-view-models.ts      project/scene pure projection <=240
  media-production-view-models.ts              readiness/run pure projection <=360
  media-production-canvas-view-models.ts       node/pixel-safe presentation <=200
  media-production-layout.ts                   pure geometry <=140
  media-job-host-bridge.ts                     P10.1 thin bridge <=160
  workflows/
    MediaWorkflowLibraryDialog.tsx             shared Dialog composition <=180
    WorkflowConnectionWorkspace.tsx            connection UI <=280
    WorkflowLibraryWorkspace.tsx               library UI <=320
    WorkflowImportMappingEditor.tsx             mapping UI <=220
    WorkflowFieldRenderer.tsx                  dynamic fields <=140
    media-workflow-types.ts                    exact state/actions <=220
    media-workflow-view-models.ts              pure projections <=260
    use-media-workflow-controller.ts           request state <=400
```

Generated/target CSS：

```text
apps/web/src/styles/features/media-production/
  index.css                 <=40
  shell.css                 <=260
  project-scene.css         <=320
  canvas.css                <=360
  inspector.css             <=360
  workflow.css              <=400
  dialogs.css               <=260
```

Guards：

- production source 单文件不得超过 800 行；本切片新增/拆分 owner 使用上表更严格预算。
- focused CSS 单文件不得超过 400 行，总量不得超过 2,000 行。
- `MediaProductionWorkspace.tsx` 从 390 降到 <=240；AppShell 不增加业务 helper 或局部 state。
- generated files、lockfile 不在本切片；不得修改 `pnpm-lock.yaml`。

## 3. Exact frontend contracts

### 3.1 Resource and failure state

`media-production-types.ts` 固定加入以下语义；可以调整 TypeScript 语法，不得改变字段含义：

```ts
type ResourcePhase = "initial" | "loading" | "ready" | "refreshing" | "error";

type MediaProductionFailureOwner =
  | "project-list" | "project-detail" | "project-create" | "project-update" | "project-delete"
  | "scene-create" | "scene-update" | "scene-duplicate" | "scene-reorder" | "scene-move" | "scene-delete"
  | "scene-run" | "project-run" | "run-cancel" | "run-select"
  | "workflow-list" | "workflow-connection" | "workflow-import" | "workflow-test"
  | "workflow-activate" | "workflow-archive" | "preview-content";

interface MediaProductionFailure {
  readonly owner: MediaProductionFailureOwner;
  readonly subjectId?: string;
  readonly productMessageKey: string;
  readonly technicalMessage?: string;
  readonly retryIntent: MediaProductionRetryIntent;
}

type MutationOutcome<T = undefined> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MediaProductionFailure };
```

`retryIntent` 是 discriminated union，只允许列举的 project/scene/run/workflow/preview retry；不存 closure，不持久化。

### 3.2 Project state

```ts
interface MediaProductionProjectState {
  readonly workspaceEpoch: number;
  readonly listPhase: ResourcePhase;
  readonly detailPhase: ResourcePhase;
  readonly projects: readonly MediaProject[];
  readonly project?: MediaProductionProjectDetail;
  readonly selectedProjectId: string;  // committed detail only
  readonly pendingProjectId: string;   // detail request only
  readonly selectedSceneId: string;
  readonly failures: readonly MediaProductionFailure[];
  readonly busy: MediaProductionBusyState;
}
```

- authoritative empty = `listPhase === "ready" && projects.length === 0`；其他 phase 不得显示 create EmptyState。
- `selectedProjectId` 与 `project.mediaProject.id` 必须同时提交；禁止 selector 指向 A、Canvas 显示 B。
- detail success 后 selection 规则：保留当前有效 scene；否则第一个 scene；无 scenes 为 `""`。
- project/scene mutation 返回 `MutationOutcome`；Dialog 仅在 `ok:true` 后关闭。

### 3.3 Scoped busy

```ts
interface MediaProductionBusyState {
  readonly projectList: boolean;
  readonly projectCreate: boolean;
  readonly projectUpdateId: string;
  readonly projectDeleteId: string;
  readonly sceneCreateProjectId: string;
  readonly sceneUpdateIds: ReadonlySet<string>;
  readonly sceneDuplicateIds: ReadonlySet<string>;
  readonly sceneMoveIds: ReadonlySet<string>;
  readonly sceneReorderProjectId: string;
  readonly sceneDeleteIds: ReadonlySet<string>;
  readonly sceneRunIds: ReadonlySet<string>;
  readonly projectRunId: string;
  readonly cancelRunIds: ReadonlySet<string>;
  readonly selectRunIds: ReadonlySet<string>;
}
```

实现可用 immutable arrays/records 代替 Set 以利 React equality；UI 语义必须等价。每个 mutation 在同 owner/subject
已有 busy 时立即返回，不发第二个 request。

### 3.4 Single overlay

```ts
type MediaProductionOverlay =
  | { readonly kind: "none" }
  | { readonly kind: "delete-project"; readonly projectId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "delete-scene"; readonly sceneId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "run-project"; readonly projectId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "preview"; readonly sceneId: string; readonly artifactId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "workflow"; readonly tab: "workflows" | "connections"; readonly trigger: HTMLElement | null }
  | { readonly kind: "workflow-danger"; readonly target: WorkflowDangerTarget; readonly trigger: HTMLElement | null };
```

- Workspace 是 overlay intent owner；Dialog child 是 render/confirm owner。
- shared Dialog controlled `open/onOpenChange`；busy 时 root `busy=true,dismissible=false`。
- overlay close 清除 owner failure；busy overlay 不接受 close/replace。
- project/scene 删除成功后 trigger 消失，使用合同第 16 节 fallback focus；其他 close 返回原 trigger。

### 3.5 Toast adapter

- Workspace 从 `useLingToast()` 取得 `showToast`，以稳定 callback 传 controller；controller 不 import UI package。
- 删除 `noticeMessage`、`noticeTimer`、`showNotice` 和 feature `setTimeout`。
- scope 固定：

| Outcome | Scope | Tone |
|---|---|---|
| project saved/created/deleted | `media-production:project:<id>:<verb>` | success |
| scene saved/created/duplicated/deleted | `media-production:scene:<id>:<verb>` | success |
| project/scene run submitted | `media-production:run:<id>:submitted` | success |
| workflow imported/activated/archived | `media-production:workflow:<id>:<verb>` | success |

Error/warning 不发自动消失 Toast；由 InlineFeedback owner 保留。

## 4. Request and mutation algorithms

### 4.1 Request guard

每个 controller 维护：

```ts
const epochRef = useRef(0);
const requestRef = useRef<Record<RequestOwner, number>>(...);
```

固定算法：

1. trim cwd；cwd 变化时 `epoch += 1`，递增所有 request owner，reset state/overlay/failure/draft。
2. request 开始捕获 `{epoch, requestId: ++requestRef[owner], cwd, subjectId}`。
3. response/catch/finally 前调用同一个 `isCurrent(token)`。
4. 只有 current token 可 commit data/failure/busy/Toast/focus intent。
5. stale success/failure/finally 静默丢弃；不得显示“旧 workspace 操作成功”。
6. 不依赖 AbortController；client 将来支持 signal 时可以额外 abort，但 token gate 仍保留。

### 4.2 Initial and retained refresh

- initial list：`initial -> loading -> ready/error`；不清空为假 empty。
- retained refresh：`ready -> refreshing`，保留 projects/project/selection；success 原子替换。
- refresh success 不含 committed project：选择第一个并加载 detail；数组为空进入 authoritative empty。
- retained refresh fail：phase 返回 ready，写 `project-list` warning failure；Retry 重新 refresh，Clear 只清 failure。
- project detail selection fail：清 `pendingProjectId`，保留 committed selection/project，写 `project-detail` failure。

### 4.3 Project deletion

1. Dialog target 必须等于当前 committed project；不存在则关闭 intent，不发请求。
2. confirm single-flight -> `deleteMediaProject(cwd, projectId)`；不改 API wrapper。
3. success 后立即从 retained list/detail/selection 中移除 target，避免已删除对象继续显示。
4. 以删除前列表顺序选第一个 remaining project 作为 preferred id，调用 authoritative list refresh + detail load。
5. refresh success empty -> authoritative empty；remaining detail success -> commit next project。
6. DELETE 已成功但 refresh 失败：Dialog 关闭，deleted target 仍不得恢复；显示 retained list warning + Retry。
7. DELETE 失败：Dialog 保持 open、target 不变、InlineFeedback + Retry/Clear；不提前 Toast。
8. cwd/epoch 改变：不向新 workspace commit/Toast/focus；旧 workspace server side effect不回滚。

### 4.4 Scene deletion and selection

- success 后加载当前 project detail；next selection 顺序为同 index 后继、前驱、`""`。
- detail refresh failure时本地先移除 deleted scene，绝不恢复已删除 row；显示 retained warning。
- deleting selected scene 时 preview/run overlay 不并存；打开 delete intent 前关闭非 busy preview。
- duplicate/create success 后 authoritative detail load，再 select returned scene id。

### 4.5 Workflow request state

- connection/workflow list 使用同 epoch、各自 request id；并发 `Promise.all` 只有两者都 current 才原子 commit。
- retained refresh failure保留两张列表和 selection；initial failure显示 Dialog owner error，不伪造 empty library。
- connection/workflow mutation busy 以 subject id 隔离；import draft只被 import/cancel/identity change清除。
- analyze/import/test/activate/archive 的 stale outcome不写 draft/list/status/Toast。
- destructive connection delete必须先 shared Dialog；被 workflow 引用时保持 disabled reason，不发 DELETE。

## 5. S0-S5 tasks, dependencies and exclusive write sets

### 5.1 Ordered task table

| Slice | Weight | Function IDs | 任务 | Depends on | 可并行准备 | 状态 | Exit gate |
|---|---:|---|---|---|---|---|---|
| `S0 / T10.2-S1` | 24% | PROJECT, SCENE, DELETE | Project/Scene/Delete/Loading owner；types、identity、failure、scoped busy、shared danger Dialog、完整双语 catalog、AppShell thin mount | 本文档 pair | 否，单一 foundation owner | completed | focused `6/6`、Media Jobs `11/11 + 5/5`、typecheck/i18n；legacy locator 已由 S5 收口 |
| `S1` | 14% | TOOLBAR, CANVAS | toolbar、dock rail、Canvas、layout/selection/focus/reduced motion | S0 contracts | S2/S3 可并行编码 | completed | focused `7/7`；Canvas state/pixel/geometry/keyboard/reduced-motion/overflow green |
| `S2` | 18% | SCENE, INSPECTOR, RUN | Inspector settings/result/history、readiness、scene run/cancel/select | S0 | S1/S3 可并行编码 | completed | focused `4/4`；S0 + S2 `10/10`；direct/workflow/dirty/failure/result/history/single-flight green |
| `S3` | 18% | WORKFLOW | connection/library/import/mapping/test/activate/archive、shared Dialog | S0 | S1/S2 可并行编码 | completed | focused `6/6`；no hand overlay；race/busy/focus/draft/delete green |
| `S4` | 12% | RUN, PREVIEW, TOOLBAR | project review/run、preview/download/open task reuse bridge、P10.1 host integration | S2 + S3 | S1 visual review可并行 | completed | focused `4/4`、Media Jobs legacy `5/5`、UI2 Media Jobs `10/10`；run/preview/open-task green，locator 在 S5 收口 |
| `S5` | 14% | all 9 IDs | CSS split、i18n parity/unused/hardcoded cleanup gate、legacy adaptation、2x2 evidence、selected regressions、docs closeout | S0-S4 | evidence review可按图片并行，写 owner 单一 | completed | focused `27/27`、legacy `8/8`、Media Jobs `16/16`、Dark `2/2`、evidence `36/36`、static green |

表中短名固定展开为：

- PROJECT = `PROD-PROJECT-001`
- SCENE = `PROD-SCENE-001`
- TOOLBAR = `PROD-TOOLBAR-001`
- CANVAS = `PROD-CANVAS-001`
- INSPECTOR = `PROD-INSPECTOR-001`
- WORKFLOW = `PROD-WORKFLOW-001`
- RUN = `PROD-RUN-001`
- PREVIEW = `PROD-PREVIEW-001`
- DELETE = `PROD-DELETE-001`

### 5.2 Exclusive write sets

下列并发集合互斥；路径不得在两个同时执行的 slice 间共享。S0 完成后允许唯一一次顺序交接：S3 可在
`MediaProductionWorkspace.tsx` 只改 Workflow Dialog 的 import/组件名，以删除旧 hand overlay；不得改 S0
状态、overlay、loading 或项目/场景逻辑。其余跨集合需求必须停止 slice、先修订本计划，不得临时越界。

**S0 write set**

```text
apps/web/src/app/AppShell.tsx                                  mount-only
apps/web/src/features/media-production/MediaProductionWorkspace.tsx
apps/web/src/features/media-production/MediaProductionLoadState.tsx       new
apps/web/src/features/media-production/ProjectSceneOutline.tsx
apps/web/src/features/media-production/ProjectDeleteDialog.tsx            new
apps/web/src/features/media-production/SceneDeleteDialog.tsx
apps/web/src/features/media-production/use-media-production-controller.ts
apps/web/src/features/media-production/media-production-types.ts
apps/web/src/features/media-production/media-production-project-view-models.ts  new
apps/web/src/i18n/locales/en-US.ts
apps/web/src/i18n/locales/zh-CN.ts
apps/web/e2e/support/media-production-fixtures.ts                          new
apps/web/e2e/ui2-media-production-project-scene.spec.ts                    new
```

**S1 write set**

```text
apps/web/src/features/media-production/MediaProductionCanvasToolbar.tsx
apps/web/src/features/media-production/MediaProductionDockRail.tsx
apps/web/src/features/media-production/StoryboardCanvas.tsx
apps/web/src/features/media-production/media-production-layout.ts
apps/web/src/features/media-production/media-production-canvas-view-models.ts  new
apps/web/e2e/ui2-media-production-canvas.spec.ts                            new
```

**S2 write set**

```text
apps/web/src/features/media-production/SceneExecutionSettings.tsx
apps/web/src/features/media-production/SceneInspector.tsx
apps/web/src/features/media-production/SceneResultPanel.tsx                new
apps/web/src/features/media-production/SceneRunHistory.tsx                 new
apps/web/src/features/media-production/media-production-view-models.ts
apps/web/e2e/ui2-media-production-inspector.spec.ts                         new
```

**S3 write set**

```text
apps/web/src/features/media-production/MediaProductionWorkspace.tsx              integration-only import/component rename
apps/web/src/features/media-production/workflows/MediaWorkflowLibraryOverlay.tsx  delete
apps/web/src/features/media-production/workflows/MediaWorkflowLibraryDialog.tsx   new
apps/web/src/features/media-production/workflows/WorkflowConnectionWorkspace.tsx
apps/web/src/features/media-production/workflows/WorkflowFieldRenderer.tsx
apps/web/src/features/media-production/workflows/WorkflowImportMappingEditor.tsx
apps/web/src/features/media-production/workflows/WorkflowLibraryWorkspace.tsx
apps/web/src/features/media-production/workflows/media-workflow-types.ts
apps/web/src/features/media-production/workflows/media-workflow-view-models.ts     new
apps/web/src/features/media-production/workflows/use-media-workflow-controller.ts
apps/web/e2e/ui2-media-production-workflow.spec.ts                                new
```

**S4 write set**

```text
apps/web/src/features/media-production/MediaProductionWorkspace.tsx         integration-only
apps/web/src/features/media-production/ProjectRunReviewDialog.tsx
apps/web/src/features/media-production/SceneResultPreviewDialog.tsx
apps/web/src/features/media-production/media-job-host-bridge.ts
apps/web/e2e/ui2-media-production-run-preview.spec.ts                      new
```

S4 对 `MediaProductionWorkspace.tsx` 的写权限只覆盖既有 `onOpenMediaJob` prop 的解构和 Run/Preview Dialog
callback wiring：Open task 必须先关闭 Preview、切换 `view="jobs"`，再选择当前 Media Job。不得修改 S0 resource/
overlay/selection、S1 Canvas、S2 Inspector 或 S3 Workflow 行为，也不得把 P10.1 Reuse 表单复制进 Production。

**S5 write set**

```text
apps/web/src/styles.css
apps/web/src/styles/media-production.css                                  delete
apps/web/src/styles/media-production-inspector.css                        delete
apps/web/src/styles/media-production-canvas-first.css                     delete
apps/web/src/styles/media-production-priority-refinement.css              delete
apps/web/src/styles/media-workflows.css                                   delete
apps/web/src/styles/features/media-production/index.css                   new
apps/web/src/styles/features/media-production/shell.css                   new
apps/web/src/styles/features/media-production/project-scene.css           new
apps/web/src/styles/features/media-production/canvas.css                  new
apps/web/src/styles/features/media-production/inspector.css               new
apps/web/src/styles/features/media-production/workflow.css                new
apps/web/src/styles/features/media-production/dialogs.css                 new
apps/web/e2e/media-production.spec.ts
apps/web/e2e/support/media-production-pixel.ts                             new
apps/web/e2e/ui2-media-production-evidence.spec.ts                         new
```

S5 closeout 已由单一 docs/evidence owner 写入：本合同、本文、P10.2 evidence metadata/PNG/sidecar、覆盖矩阵和
状态看板。后续只在真实回归失败时重新打开，不把 packaged Desktop pending 误写为 Web failure 或 complete。

### 5.3 Parallel protocol

- 默认依赖为 S0 -> (S1 / S2 / S3) -> S4 -> S5；S1/S2/S3 只在 S0 contracts 冻结后并行。
- 多执行者时，S0 完成并冻结 props/types/fixture 后，S1/S2/S3 可以并行编码，因为写集合互斥；主 owner 必须按
  S1、S2、S3 数字顺序逐个集成和跑 exit gate。
- S3 对 `MediaProductionWorkspace.tsx` 的顺序交接仅限 `MediaWorkflowLibraryOverlay` ->
  `MediaWorkflowLibraryDialog` import/JSX rename；该文件的其他 S3 diff 必须为零。
- S4 必须等待 S2 readiness/Inspector 与 S3 workflow state 稳定；S5 必须等待所有 production slice。
- screenshot capture 可以按 Function ID 分工只读运行，但 metadata、SHA ledger 和 docs 由一个 S5 owner 串行写。
- locale catalog 只有 S0 owner 可写；禁止多个执行者共享同一 Vite/Playwright port 或同时写 CSS/evidence ledger。

## 6. Detailed slice execution

### 6.1 S0 Project/Scene/Delete/Loading owner

1. 先记录 S0 文件 hash/diff，逐个读取当前未提交改动；不从 HEAD 恢复。
2. 在 types/controller 建立 resource phase、failure owner、retry intent、scoped busy、epoch/request guard、structured outcome。
3. Workspace 只组合 controller、single overlay、shared Toast adapter、dock/view intent；移除 notice effect/timer。
4. `MediaProductionLoadState` 渲染 initial Skeleton、initial error、retained warning、authoritative empty。
5. Outline 使用 shared Select/Field/Button/IconButton/Collapsible/StatusIndicator；项目危险动作固定放在 Project settings
   的 Danger section，显示项目名和 scene count。
6. 新增 `ProjectDeleteDialog`；迁移 `SceneDeleteDialog` 到 shared Dialog。confirm await outcome，失败不关闭。
7. project delete 调现有 API，并按第 4.3 节 refresh/selection/focus 算法处理。
8. 在 `en-US.ts` / `zh-CN.ts` 一次性登记第 7.2 节全部 P10.2 copy groups 和动态插值 key；两份 catalog key
   集合完全相同。S0 exit 前运行 i18n gate，保证 S0 页面在 en-US/zh-CN 实页都不是 fallback key。
9. AppShell 只传 `onOpenMediaJob(jobId)` 等薄 callback；不得增加 helper/state/effect。
10. fixture 一次性冻结 initial/empty/retained/error/delay/race/delete success/delete failure/long list。

Exit gate：PROJECT/SCENE/DELETE focused 全绿；initial request 期间 Create CTA count=0；delayed old cwd/project response不提交；
project/scene confirm 双击各 1 request；失败 Dialog 留在原位；双语 catalog parity/missing key 为零；AppShell diff 只有 mount lines。

### 6.2 S1 Toolbar/Canvas

1. toolbar 全部 shared primitives，action projection只接收 view-model；不从 raw busy/string推导。
2. Dock rail 使用 shared IconButton/Tooltip；1280互斥和 Escape 次序由 Workspace contract消费。
3. Canvas nodes保持固定 `218x104`，顺序来自 scene sort，不因 position变化；React Flow领域能力保留。
4. focus/fit safe area使用 pure helper；normal motion max 250ms，reduced motion duration 0。
5. MiniMap阈值、controls和legend避免与两侧 Dock、toolbar、preview trigger重叠。
6. 100 scenes、far coordinates、long title、one/zero scenes均写 focused fixture/assertion。

Exit gate：TOOLBAR/CANVAS focused 全绿；Canvas stage dock前后 width/height差=0；selected node在 safe area；Canvas screenshot
非透明/非单色；reduced motion无 animated transform；document overflow=0。

### 6.3 S2 Inspector/scene run

1. `SceneInspector` 只做 header/Tabs/composition，抽 ResultPanel 和 RunHistory；不超过 220 行。
2. settings迁 shared Field/Input/Textarea/Select/Button/Checkbox；direct/workflow fields互斥，blocker有精确 repair callback。
3. view model返回 key+values/status/action，不返回中文 sentence；日期按 active locale。
4. title/prompt/reference/workflow field的 draft、save、failure按 target scene/field所有；切 scene恢复权威值。
5. prompt 的 Run 是显式 commit boundary：读取当前可见 draft，复用或等待 blur save，按 `scene PATCH success -> scene run POST` 串行执行；save failure 保留 draft 且禁止 POST。
6. `needs_prompt` 时 Run 保持可达；空值点击只触发 shared Field error 和 Textarea focus，不创建 Scene Run/Media Job。其他真实 blocker 与运行中 single-flight 规则不变。
7. current result、latest issue、history status只显示一个主状态；raw failure默认折叠。
8. run/cancel/select历史使用 S0 structured outcome/scoped busy；旧结果在 regeneration/failure期间保留。

Exit gate：INSPECTOR/SCENE/RUN focused 全绿；direct/workflow source drift、dirty/failure/retry、prompt 不失焦直接运行、空 prompt 聚焦且零 POST、result/history、cancel/select single-flight通过；关闭/打开 Inspector不改 selection/Canvas geometry。

### 6.4 S3 Workflow

1. 删除 `MediaWorkflowLibraryOverlay`，新增 controlled `MediaWorkflowLibraryDialog`，全部使用 shared Dialog/Tabs/Field/
   DataRow/Status/Feedback/Collapsible/Button。
2. controller建立 epoch/request、initial/retained phase、subject busy/failure；import draft与list selection分域。
3. connection create/update/check/delete按subject single-flight；delete必须 shared danger Dialog，被引用时 disabled reason。
4. JSON >5MB、非object、analyze validation、mapping invalid全部留在 import owner；import失败保留 draft。
5. test/activate/archive不虚构进度；test status来自 existing Media Job；raw diagnostics折叠。
6. workflow/connection选择在refresh后按当前有效、首个active、空字符串顺序修复。

Exit gate：WORKFLOW focused 全绿；source 中 `role="dialog"`、feature Escape listener、hand overlay count=0；busy dismiss、
focus return、draft retention、old cwd response、connection delete确认全部通过。

### 6.5 S4 Project run/Preview/P10.1 bridge

1. ProjectRunReview使用 shared Dialog；0 ready无 submit，mixed request只含 ready sceneIds；失败留 Dialog。
2. Preview 使用 shared Dialog + existing `MediaArtifactPreview`；用户点击 Preview 后 video 保留 controls、静音 autoplay，图片不自动播放。
3. content retry只重载 Artifact；不运行 scene、不改变 current run/scene selection。
4. Download使用 existing Artifact content URL；失败保留browser fallback，不向外部URL转发provider auth。
5. Open task先关闭preview、切 `view="jobs"`、调用S0薄 `onOpenMediaJob(currentJob.id)`；Reuse settings继续由P10.1拥有。
6. `media-job-host-bridge`保持pure，补missing workflow/connection context，不修改Media Jobs source。

Exit gate：RUN/PREVIEW focused全绿；project confirm双击1 request；preview open/close/retry不改selection；image decoded pixel
hash theme-equal；video computed style无filter/opacity/blend；Media Jobs selected row和Reuse action可达。

### 6.6 S5 CSS/i18n audit/evidence/closeout

1. 一次性迁移并删除5个旧CSS；`styles.css`只import focused `index.css`。
2. shared primitive chrome不在feature CSS重写；feature CSS只拥有domain layout、Canvas node、Dock sizing和preview frame。
3. 对 S0 预登记 catalog 与 S0-S4 source 做 parity、missing、unused 和用户可见硬编码审计；S5 不新增或修改
   locale key。发现缺口时退回对应 source owner 或 S0 catalog owner修正，再重新进入 S5 gate。
4. 更新legacy spec只适配真实shared UI与locale，不减少已有8个业务场景。
5. 跑focused、legacy、P10.1、Model、Approvals、AppShell、theme selected regression。
6. 生成36张2x2原图、JSON sidecar、SHA-256、console/overflow/pixel ledger并逐图检查。
7. 全部真实通过后已更新 P10.2 docs/evidence/coverage/status；未来任何回归必须重新打开受影响 ID 并记录精确失败。

Exit gate：第12节全部命令green；line/color/cascade guardsgreen；36/36截图存在且hash匹配；9 IDs各有完整账本；
无packaged Desktop时只关闭Web，不声称Desktop完成。

## 7. i18n exact migration

### 7.1 File ownership

S0 在任何后续 source 调用 `t()` 前，一次性登记第 7.2 节完整 en-US/zh-CN catalog。18 文件按切片消费
预登记 key，不在 S5 回头改 source 或 locale：

| Slice | Files |
|---|---|
| S0 | 先写 en-US.ts/zh-CN.ts 完整 catalog；再迁 Workspace、ProjectSceneOutline、SceneDeleteDialog、production controller |
| S1 | CanvasToolbar、DockRail、StoryboardCanvas |
| S2 | SceneExecutionSettings、SceneInspector、media-production-view-models |
| S3 | Workflow Dialog/Connection/Field/Mapping/Library/controller 六个文件 |
| S4 | ProjectRunReviewDialog、SceneResultPreviewDialog |

S1-S4 只能消费 S0 已存在的 key，不能增补 locale。S5 只运行 parity/missing/unused/硬编码清理 gate和最终实页验收；
若 gate 失败，修复必须回到拥有该 source 的 S0-S4 或拥有 catalog 的 S0，保持写集合互斥。每个 source 使用英文
copy key；动态语序只用插值。

### 7.2 S0 complete catalog checklist

| Prefix/group | 必须包含 |
|---|---|
| project | initial loading、empty、refreshing、load failed、retry、clear、create、rename、default source、delete consequence |
| scene | empty、create、duplicate、reorder、move、save、delete、long count/status |
| toolbar/canvas | studio、tasks、open docks、check、generate count、configure、zoom/fit、legend、preview label |
| inspector | settings/result/history、direct/workflow、prompt/ratio/duration/reference、blocker、technical details |
| workflow | connection/library/import/mapping/test/activate/archive/delete、validation、health、busy/failure |
| run | ready/skipped、queued/running/approval/succeeded/failed/cancelled、regenerating、set current |
| preview | loading/unavailable/retry/download/open task/reuse settings/close、image/video title |
| feedback | owner-specific product fallback、saved/submitted/deleted/imported success |

Exact rules：

- S0 exit 时本表所有 group 都必须同时存在于 en-US/zh-CN；后续 slice 不得引入 catalog 外 key。
- `t("Generate {count} scenes", { count })`，不得拼接中英文count语序。
- `t("Delete project {name}?", { name })`、`t("Delete scene {name}?", { name })`。
- status view model返回 `{labelKey, values}`；technical server message不进入locale。
- `new Intl.DateTimeFormat(locale, ...)`，不得写死 `toLocaleString("zh-CN")`。

## 8. CSS migration and static deletion matrix

| 旧 owner | 目标 owner | S5动作 |
|---|---|---|
| `media-production.css` | shell + project-scene + canvas | selector逐条迁移后整文件删除 |
| `media-production-inspector.css` | inspector + dialogs | selector逐条迁移后整文件删除 |
| `media-production-canvas-first.css` | shell + canvas | 合并domain layout，删除重复/后置覆盖 |
| `media-production-priority-refinement.css` | focused owners | 将真实规则并入owner，禁止保留patch layer |
| `media-workflows.css` | workflow + dialogs | shared Dialog/Tabs/Field chrome删除，domain mapping保留 |

Static rules：

- focused CSS禁止 hex/rgb/hsl literal；只用shared/theme tokens、`transparent`、`currentColor`。
- 禁止重写 `.ling-ui-*` primitive内部结构；只允许feature wrapper/grid/size。
- 禁止 `!important`、feature z-index逃逸、filter/blur媒体、negative letter-spacing、viewport font scaling。
- Canvas node/toolbar/Dock/Dialog固定尺寸在hover/busy/long copy前后不变。
- `@media (prefers-reduced-motion: reduce)`覆盖Dock/Canvas focus的domain transition。

## 9. Focused E2E scenario matrix

| Scenario | Function IDs | Fixture/actions | Required assertions |
|---|---|---|---|
| `MP-01-initial-empty` | PROJECT/SCENE | delayed list -> empty | no fake CTA during load；Skeleton；authoritative empty after success |
| `MP-02-project-retry-race` | PROJECT | initial fail、retained fail、cwd/project delay race | Retry/Clear；old response/finally ignored；selection atomic |
| `MP-03-project-mutations` | PROJECT/DELETE | create/update/delete fail+success | scoped busy；Dialog retained；existing DELETE once；next selection |
| `MP-04-scene-mutations` | SCENE/DELETE | create/edit/duplicate/reorder/move/delete | target busy；rollback/focus；long tree overflow 0 |
| `MP-05-toolbar` | TOOLBAR | no project/source/ready/mixed/jobs | exact primary action；keyboard；long 1280 geometry |
| `MP-06-canvas-layout` | CANVAS | zero/one/100/far nodes、both docks | nonblank；fit safe area；minimap/controls no overlap；stage stable |
| `MP-07-canvas-motion` | CANVAS | reduced motion、rapid dock toggles | duration0；no selection/position/order drift |
| `MP-08-inspector-direct` | INSPECTOR/SCENE | direct ready/missing/model drift/dirty fail | exact fields/repair；draft retained；per-field busy |
| `MP-09-inspector-workflow` | INSPECTOR/WORKFLOW | workflow ready/missing/archived/connection issue | exact repair target；no direct controls |
| `MP-10-run-history` | RUN/INSPECTOR | queued/running/approval/success/fail/cancel/select | one status；old result retained；per-run single-flight |
| `MP-11-workflow-load` | WORKFLOW | delayed/empty/retained fail/cwd race | shared Dialog focus；no fake empty；Retry/Clear；stale ignore |
| `MP-12-workflow-connection` | WORKFLOW | create/edit/check/delete referenced/free | field error；scoped busy；shared danger confirm |
| `MP-13-workflow-import` | WORKFLOW | >5MB/bad JSON/validation/mapping/import fail/success | draft retention；busy dismiss blocked；Toast scope |
| `MP-14-workflow-test` | WORKFLOW/RUN | queued/running/fail/success/activate/archive | no percent；existing job truth；repair/action precedence |
| `MP-15-project-run` | RUN/TOOLBAR | 0 ready、mixed、submit fail/success/double click | request sceneIds exact；Dialog owner/focus |
| `MP-16-preview` | PREVIEW | image/video/load error/retry/download/close | explicit-click muted autoplay；controls retained；content retry only；selection stable；pixel style |
| `MP-17-open-task` | PREVIEW/TOOLBAR | preview current job -> tasks -> reuse | selected Media Job；P10.1 Reuse可达；no Media Jobs source change |
| `MP-18-cross-cutting` | all 9 IDs | 2x2 themes/viewports、zh/en、keyboard/reduce | console/pageerror=0；overflow=0；IDs/evidence ledger complete |

每个spec建立console/pageerror collector；expected mock HTTP failure只允许出现在fixture request ledger，不能污染console allowlist。

## 10. Keyboard, motion, overflow and pixel assertions

### 10.1 Shared helpers

`media-production-fixtures.ts`提供权威数据和delayed/failure route control；S0后只读。
`media-production-pixel.ts`提供PNG dimensions、decoded pixel hash、unique color/non-background ratio和computed effect chain；
S5创建，不能从Media Jobs spec复制后产生两套漂移helper。

### 10.2 Per-Function common assertions

每个Function ID的focused scenario必须调用：

```text
assertNoUnexpectedConsoleOrPageErrors()
assertNoDocumentHorizontalOverflow()
assertOwnerContentReachableAt1440And1280()
assertKeyboardFocusVisibleAndReturned()
```

Dialog IDs额外断言focus trap、Escape/outside、busy dismiss；Canvas额外断言nonblank/safe-area；Preview额外断言媒体pixel/effect。

### 10.3 Canvas pixel thresholds

- `.storyboard-canvas` element screenshot width/height > 0。
- decoded RGB unique colors >= 16，非透明像素 >95%，与最大背景色不同的像素占比 >=2%。
- scene node、selected stroke、controls各自bounding box可见；controls与MiniMap/Dock交集面积=0。
- Light/Dark Canvas UI hash可以不同；真实 Artifact image 排除 8px 圆角边缘裁切后的 decoded pixels 必须相同。
- video/image effect chain每一级 `filter:none`、`opacity:1`、`mixBlendMode:normal`；任何父级失败即gate失败。

## 11. Screenshot and evidence ledger

Evidence target：`docs/design/ui2.0升级/evidence/features/media-production/`。完成账本已创建：
[Media Production evidence](../evidence/features/media-production/metadata.md)。

Closeout facts：36 张原尺寸 PNG、36 份 JSON sidecar、9 张 canonical contact sheet；9 个 Function ID 各 4 个
changed states，18 张 Light/en-US、18 张 Dark/zh-CN。全部 viewport、SHA-256、console/page error、
document/owner overflow、Canvas nonblank 和 media pixel/effect-chain gate 通过。

每个Function ID固定4张2x2原尺寸changed-state截图：

| Function ID | 1440x960 Light | 1280x800 Light | 1440x960 Dark | 1280x800 Dark |
|---|---|---|---|---|
| `PROD-PROJECT-001` | `1440x960-ling-light-project-loaded.png` | `1280x800-ling-light-project-retry.png` | `1440x960-ling-dark-project-delete.png` | `1280x800-ling-dark-project-loading.png` |
| `PROD-SCENE-001` | `1440x960-ling-light-scene-long-tree.png` | `1280x800-ling-light-scene-empty.png` | `1440x960-ling-dark-scene-editing.png` | `1280x800-ling-dark-scene-delete.png` |
| `PROD-TOOLBAR-001` | `1440x960-ling-light-toolbar-ready.png` | `1280x800-ling-light-toolbar-long.png` | `1440x960-ling-dark-toolbar-check.png` | `1280x800-ling-dark-toolbar-tasks.png` |
| `PROD-CANVAS-001` | `1440x960-ling-light-canvas-100-scenes.png` | `1280x800-ling-light-canvas-exclusive-dock.png` | `1440x960-ling-dark-canvas-far-fit.png` | `1280x800-ling-dark-canvas-reduced-motion.png` |
| `PROD-INSPECTOR-001` | `1440x960-ling-light-inspector-direct.png` | `1280x800-ling-light-inspector-blocked.png` | `1440x960-ling-dark-inspector-result.png` | `1280x800-ling-dark-inspector-history.png` |
| `PROD-WORKFLOW-001` | `1440x960-ling-light-workflow-empty.png` | `1280x800-ling-light-workflow-import.png` | `1440x960-ling-dark-workflow-connection-error.png` | `1280x800-ling-dark-workflow-test.png` |
| `PROD-RUN-001` | `1440x960-ling-light-run-review.png` | `1280x800-ling-light-run-approval.png` | `1440x960-ling-dark-run-regenerating.png` | `1280x800-ling-dark-run-failed.png` |
| `PROD-PREVIEW-001` | `1440x960-ling-light-preview-image.png` | `1280x800-ling-light-preview-error.png` | `1440x960-ling-dark-preview-video.png` | `1280x800-ling-dark-preview-open-task.png` |
| `PROD-DELETE-001` | `1440x960-ling-light-delete-project.png` | `1280x800-ling-light-delete-scene.png` | `1440x960-ling-dark-delete-failure.png` | `1280x800-ling-dark-delete-busy.png` |

每张PNG对应JSON sidecar，字段固定：`filename`、`capturedAt`、`viewport`、`theme`、`locale`、`fixture`、
`state`、`functionIds`、`sourceCommitOrWorktree`、`consoleErrors`、`pageErrors`、`documentOverflow`、
`ownerOverflow`、`canvasPixel`、`mediaPixelHash`、`sha256`。`metadata.md`列出36张原图、Function IDs、
测试命令/结果和人工审查结论。空字段写`null`，不得省略或伪造。

## 12. Verification commands

### 12.1 Static/package gates

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
```

```bash
rg -n 'CreateDialogShell|role="dialog"|media-workflow-overlay|noticeMessage|noticeTimer|setTimeout' \
  apps/web/src/features/media-production
rg -n 'SelectControl|primary-button|secondary-button|icon-button|inline-error' \
  apps/web/src/features/media-production
rg -n '[\p{Han}]' \
  apps/web/src/features/media-production/MediaProductionCanvasToolbar.tsx \
  apps/web/src/features/media-production/MediaProductionDockRail.tsx \
  apps/web/src/features/media-production/MediaProductionWorkspace.tsx \
  apps/web/src/features/media-production/ProjectRunReviewDialog.tsx \
  apps/web/src/features/media-production/ProjectSceneOutline.tsx \
  apps/web/src/features/media-production/SceneDeleteDialog.tsx \
  apps/web/src/features/media-production/SceneExecutionSettings.tsx \
  apps/web/src/features/media-production/SceneInspector.tsx \
  apps/web/src/features/media-production/SceneResultPreviewDialog.tsx \
  apps/web/src/features/media-production/StoryboardCanvas.tsx \
  apps/web/src/features/media-production/media-production-view-models.ts \
  apps/web/src/features/media-production/use-media-production-controller.ts \
  apps/web/src/features/media-production/workflows/*.ts \
  apps/web/src/features/media-production/workflows/*.tsx
```

以上三个 `rg` 在S5必须无输出；如注释/测试id包含合法文本，先改为ASCII语义id，不加allowlist。

```bash
rg -n '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|!important|filter:|backdrop-filter:' \
  apps/web/src/styles/features/media-production
wc -l apps/web/src/features/media-production/*.{ts,tsx} \
  apps/web/src/features/media-production/workflows/*.{ts,tsx} \
  apps/web/src/styles/features/media-production/*.css
```

### 12.2 Focused browser gate

```bash
corepack pnpm --filter @ling-stack/web exec playwright test \
  apps/web/e2e/ui2-media-production-project-scene.spec.ts \
  apps/web/e2e/ui2-media-production-canvas.spec.ts \
  apps/web/e2e/ui2-media-production-inspector.spec.ts \
  apps/web/e2e/ui2-media-production-workflow.spec.ts \
  apps/web/e2e/ui2-media-production-run-preview.spec.ts \
  apps/web/e2e/ui2-media-production-evidence.spec.ts \
  --workers=1
```

### 12.3 Behavior regression

```bash
corepack pnpm --filter @ling-stack/web exec playwright test \
  apps/web/e2e/media-production.spec.ts \
  apps/web/e2e/media-jobs.spec.ts \
  apps/web/e2e/ui2-media-jobs.spec.ts \
  apps/web/e2e/model-workbench.spec.ts \
  apps/web/e2e/model-workbench-productization.spec.ts \
  apps/web/e2e/approvals.spec.ts \
  --workers=1
```

### 12.4 Shell/theme selected regression

```bash
corepack pnpm --filter @ling-stack/web exec playwright test \
  apps/web/e2e/app-shell-selectors.spec.ts \
  apps/web/e2e/ui2-app-shell-state.spec.ts \
  apps/web/e2e/dark-mode.spec.ts \
  apps/web/e2e/ui2-navigation-overlays.spec.ts \
  apps/web/e2e/ui2-dialog-controls.spec.ts \
  apps/web/e2e/ui2-feedback-data-display.spec.ts \
  --workers=1
```

### 12.5 Scope/diff/evidence gate

共享脏树不能用全局 `git status` 归责。每个slice保存开始时allowlist文件hash，并只审查该slice路径：

```bash
git diff --check -- <slice-write-set>
git diff --stat -- <slice-write-set>
git diff -- <slice-write-set>
```

S5另验证：36张PNG和sidecar一一对应、metadata Function IDs计数9、SHA-256重算一致、原尺寸与sidecar viewport一致。

## 13. Regression and evidence stop rules

- focused任一失败：停在当前slice，不进入下一slice。
- legacy/P10.1回归失败：先证明是当前slice还是既有失败；不能删除断言、放宽selector或写“偶发”后继续。
- console/pageerror非空、document/owner overflow、Canvas blank、media pixel hash漂移：对应Function ID不完成。
- 36 张中任一缺失、重复状态、尺寸错误、hash 不一致或未目检：重新打开受影响的 P10.2 Web ID。
- packaged Electron未运行只影响Desktop closeout；不得把Web证据写成packaged Desktop通过。
- real provider、secret、外部ComfyUI不是本验收依赖；fixtures只模拟既有API，禁止真实生成或外部副作用。

## 14. Risks and mitigations

| Risk | 触发 | 固定处理 |
|---|---|---|
| 共享脏树覆盖 | 从HEAD复制或全文件重写未读内容 | slice前读当前文件/hash，allowlist diff逐文件审查，禁止git清理命令 |
| S0过宽 | controller/types/workspace同时变化 | 只做Project/Scene/Delete/Loading；Canvas/Inspector/Workflow文件不碰 |
| request race仍泄漏 | catch/finally漏token gate | 同一`isCurrent`覆盖success/catch/finally/Toast；delayed E2E强制 |
| blanket busy复发 | UI使用`Boolean(anyBusy)` | components只接收owner-specific booleans；static/test检查无关controls可用 |
| Dialog双owner | shared Dialog外仍注册Escape/outside | feature document listener/hand role dialog static count=0 |
| i18n catalog与source错序 | S1-S4调用尚未登记的key，切片实页显示fallback | S0先一次性登记完整双语catalog并跑parity；S1-S4只消费；S5只审计，失败退回唯一owner |
| CSS级联漂移 | 保留5旧文件又加focused CSS | S5同一slice迁移、切import、删除旧文件；禁止patch layer |
| P10.1被破坏 | preview/task bridge修改Media Jobs | 只改host bridge/AppShell props；Media Jobs source write count=0；联合回归 |
| 媒体像素被主题污染 | parent filter/opacity/artwork | effect-chain + decoded hash；任何祖先污染直接失败 |
| evidence提前闭环 | 有test无原图/sidecar | 36图+sidecar+SHA+目检全部存在后才改状态 |

## 15. Hard stops and rollback boundaries

### 15.1 Hard stops

- 需要新增API字段、route、Core resolver、DB schema/storage mutation或改变DELETE语义。
- 需要修改Media Jobs production/CSS/E2E才能完成Preview/Reuse；应保留“Open task”既有边界并报告blocker。
- 需要在AppShell增加controller/effect/overlay/business view model。
- 任何slice必须修改另一slice文件才能继续，说明接口未冻结；先修订计划，不得越界。
- 当前共享文件出现无法与本slice兼容的并发改动；停止写该文件，保留双方内容并重新审计。

### 15.2 Rollback

- rollback只撤销当前slice自己记录的patch，不使用reset/checkout/stash，不触碰其他工作树改动。
- S0 rollback不得移除现有项目/场景能力；project delete未能安全完成时隐藏/disable新action并保留designed。
- S3 rollback不得恢复手写overlay作为“临时完成”；Workflow保持旧能力或disabled，但P10.2不关闭。
- S5 CSS rollback恢复slice前精确imports/files，不恢复已被别的任务删除的Media Jobs CSS。
- evidence 回归失败不回滚正确生产代码；重新打开受影响的 Web ID，记录失败命令/截图并继续修复同 slice。

## 16. Definition of done

- 9个Function ID与设计合同完全一致，没有别名、漏项或合并计数。
- S0-S5任务全部由其互斥写集合完成；首切片确为Project/Scene/Delete/Loading owner。
- AppShell只mount；API/Core/contracts/storage/Desktop/Media Jobs production零改动。
- initial/retained load、Retry/Clear、scoped busy、cwd/request identity、single overlay和shared Toast owner全部实现。
- project delete复用现有API；项目/场景/Workflow危险确认及run/preview Dialog全部使用shared primitive。
- 18文件i18n、5旧CSS删除、focused line/color/cascade guards通过。
- MP-01..MP-18、legacy、P10.1、Model、Approvals、AppShell/theme regression全部通过。
- 9 IDs各有Light/Dark x 1440/1280四张证据，总计36张原图与sidecar；console/overflow/Canvas/media pixel gate全绿。
- 实际结果、命令、数量和 packaged Desktop 边界已如实写入 closeout；Desktop host integration 继续独立 pending。
