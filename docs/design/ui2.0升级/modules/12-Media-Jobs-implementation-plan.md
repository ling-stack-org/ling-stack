# P10.1 Media Jobs UI 2.0 Implementation Plan

## 0. Execution Contract

本计划实施 [Media Jobs UI 2.0](12-Media-Jobs.md)，目标是让下一位实现者不再决定页面入口、状态优先级、
反馈 owner、busy/race 行为、文件拆分、CSS 归属、测试场景或截图文件名。

允许改变：

- Web feature component、controller、纯 view-model、展示 props/types；
- Media domain 的前端 load/mutation/feedback state 和 callback return shape；
- AppShell/Media Production/Provider Workbench 的薄导航 adapter；
- focused CSS、locale 文案、focused E2E、必要的 legacy assertion 和 evidence；
- copy/reuse/preview fallback 等不改变服务端数据的交互闭环。

禁止改变：

- daemon route、API client endpoint、contracts、core store、DB schema、provider/workflow executor；
- `MediaJob` status、execution source、artifact persistence、approval、secret redaction 和 retry 行为；
- `ViewId`、Sidebar IA、Media Production 的默认 `studio` view 或 Settings IA；
- standalone job cancel/delete/archive/edit、数值进度、server pagination/search；
- Logo、Theme Pack schema、Presentation Profile 或 Electron business bridge。

若实现发现必须修改上述禁止项，停止该能力，不用前端假状态绕过；记录 blocker 后继续其他独立切片。

本计划中的唯一简写映射为：`LIST = MEDIA-JOB-LIST-001`、`CREATE = MEDIA-JOB-CREATE-001`、
`RESULT = MEDIA-JOB-RESULT-001`、`REPAIR = MEDIA-JOB-REPAIR-001`。不创建第五个 Media Jobs Function ID。

## 1. Authoritative Baseline

实施前重新读取，不依赖本文行号猜测最新代码：

```text
apps/web/src/app/AppShell.tsx
apps/web/src/app/lazy-pages.tsx
apps/web/src/app/view-types.ts
apps/web/src/features/navigation/SidebarPrimaryNavigation.tsx
apps/web/src/features/media-production/MediaProductionWorkspace.tsx
apps/web/src/features/media-production/MediaProductionCanvasToolbar.tsx
apps/web/src/features/media-production/media-production-types.ts
apps/web/src/features/media-production/workflows/media-workflow-types.ts
apps/web/src/features/media/MediaJobsPage.tsx
apps/web/src/features/media/MediaJobList.tsx
apps/web/src/features/media/MediaJobDetailPanel.tsx
apps/web/src/features/media/MediaJobAdvancedFields.tsx
apps/web/src/features/media/MediaArtifactPreview.tsx
apps/web/src/features/media/media-job-view-models.ts
apps/web/src/features/media/media-job-display-context.ts
apps/web/src/domains/media/use-media-domain.ts
apps/web/src/api/media.ts
apps/web/src/api/media-payloads.ts
apps/web/src/styles.css
apps/web/src/styles/media.css
apps/web/src/styles/media-create-dialog.css
apps/web/src/styles/media-job-detail.css
apps/web/src/styles/media-production.css
apps/web/src/styles/components.css
apps/web/src/styles/strict-console.css
apps/web/e2e/media-jobs.spec.ts
apps/web/e2e/media-production.spec.ts
apps/web/e2e/dark-mode.spec.ts
apps/web/e2e/support/mock-daemon.ts
packages/contracts/src/media.ts
packages/contracts/src/media-workflows.ts
packages/api-client/src/endpoints/admin.ts
packages/core/src/provider-media-normalization.ts
packages/core/src/storage/sqlite/media-store.ts
packages/daemon/src/features/media/routes.ts
packages/daemon/src/features/media/provider-executor.ts
packages/daemon/src/features/media/workflows/workflow-executor.ts
```

### 1.1 Audited current metrics

| File | Current lines / facts | P10.1 rule |
|---|---:|---|
| `AppShell.tsx` | 3140 | thin props/callback only；不得新增业务矩阵 |
| `MediaProductionWorkspace.tsx` | 398 | 先抽 helper/host bridge，完成后 `<=390` |
| `MediaJobsPage.tsx` | 368 | 拆 composition/controller，完成后 `<=180` |
| `MediaJobList.tsx` | 213 | 拆 row，list `<=240` |
| `MediaJobDetailPanel.tsx` | 348 | 拆 result/repair/artifact，inspector `<=300` |
| `media-job-view-models.ts` | 503 | 先拆分；旧文件删除或仅 re-export `<=40` |
| `use-media-domain.ts` | 252 | 可扩至 `<=380`，复杂 helper 必须外抽 |
| `media-jobs.spec.ts` | 351 | 只保留 legacy regression；新状态进 focused spec |
| `media.css` | 779 / 113 selector blocks / 74 color literals | 删除 |
| `media-create-dialog.css` | 115 / 15 / 12 color literals | 删除 |
| `media-job-detail.css` | 91 / 12 / 0 color literals | 删除 |

三份 Media CSS 共 `985` 行、约 `140` 个 selector blocks、`86` 个颜色字面量。新 focused CSS
不允许把这些数值机械复制过去。

### 1.2 Confirmed current behavior

- production reachability 是 `Media Production -> Generation tasks`，默认先显示 studio；
- GET list 只取最近 100 条，client filter；
- create 成功只产生 queued job；
- run 可同步结束或返回 202 后由后台执行；Web 对 queued/running 每 2 秒刷新；
- provider 与 workflow job 共用 `MediaJob` 列表；
- standalone job 没有 cancel API，scene run 有独立 cancel API；
- numeric progress/ETA/handle 没有 Web contract；
- copy 直接调用 clipboard，当前没有 success/failure owner；
- current `Copy details` 实际只复制 prompt；
- reuse 当前不存在；
- create Dialog 当前触发后立即关闭，不等待 API；
- refresh/create 共用 `mediaJobsLoading`，错误同时进入 media domain 和 `AppShell.errorMessage`；
- artifact 并发加载任一失败会污染整次 refresh，且缺少 per-job load state；
- current workflow job 可能显示 `Unknown provider` 并被错误引导到 Model Workbench。

这些是 P10.1 必须修正的 presentation/controller 问题，不是修改 daemon 行为的理由。

## 2. Target File Tree And Line Guards

```text
apps/web/src/features/media/
  MediaJobsPage.tsx                    composition only, <=180
  MediaJobsHeader.tsx                  summary/filter/actions, <=150
  MediaJobList.tsx                     list states/composition, <=240
  MediaJobRow.tsx                      one DataRow, <=180
  MediaJobInspector.tsx                detail composition, <=300
  MediaJobResult.tsx                   hero/actions/results, <=220
  MediaJobRepair.tsx                   one repair surface, <=180
  MediaJobCreateDialog.tsx             shared Dialog/form, <=320
  MediaJobAdvancedFields.tsx           operation fields, <=180
  MediaJobArtifactRow.tsx              result/supporting row, <=150
  MediaArtifactPreview.tsx             media element/fallback, <=120
  useMediaJobsPageController.ts        UI-only state/actions, <=300
  media-job-types.ts                   display contracts, <=200
  media-job-state-view-models.ts       status/action/filter/summary, <=260
  media-job-repair-view-models.ts      source/error repair mapping, <=240
  media-job-form-view-models.ts        validation/reuse hydration, <=220
  media-job-result-view-models.ts      artifact/result projection, <=180
  media-job-display-context.ts         host context builders, <=180

apps/web/src/domains/media/
  media-domain-types.ts                scoped state/results, <=180
  media-domain-artifacts.ts            signature/allSettled helpers, <=220
  use-media-domain.ts                  API owner, <=380

apps/web/src/features/media-production/
  media-job-host-bridge.ts             workflow/source/open actions, <=180
  MediaProductionWorkspace.tsx         <=390 after extraction

apps/web/src/styles/features/media-jobs/
  index.css                            <=8
  shell.css                            <=150
  list.css                             <=210
  detail.css                           <=240
  create-dialog.css                    <=180
  artifact-preview.css                 <=120

apps/web/e2e/
  ui2-media-jobs.spec.ts               focused product/visual suite, target <=700
```

规则：

- production 文件硬上限 800；新增/主要 decision owner 硬上限 400；
- 不建立一个新的 700 行 “all media components” 文件；
- `AppShell` 不定义 media status、repair copy 或 form validation；
- `MediaProductionWorkspace` 不派生 Media Job row view；
- API domain 不 import React presentation component/i18n；
- view-model 只返回 locale keys/params、tone、action id 和 display data，不返回 JSX。

## 3. Exact Frontend State Contracts

新增 Web-only types；不能复制/修改 contract types：

```ts
export type MediaJobsLoadPhase =
  | "idle"
  | "initial"
  | "refreshing"
  | "polling";

export type MediaJobMutationPhase = "idle" | "submitting";
export type MediaJobArtifactPhase = "idle" | "loading" | "ready" | "error";

export interface MediaJobArtifactState {
  readonly signature: string;
  readonly phase: MediaJobArtifactPhase;
  readonly artifacts: readonly RunArtifact[];
  readonly errorMessage?: string;
}

export interface MediaScopedError {
  readonly owner:
    | "load"
    | "refresh"
    | "create"
    | `run:${string}`
    | `artifacts:${string}`;
  readonly message: string;
}

export interface MediaMutationResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly status?: MediaJobStatus;
}

export interface MediaJobsDomainState {
  readonly mediaJobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, MediaJobArtifactState>>;
  readonly loadPhase: MediaJobsLoadPhase;
  readonly createPhase: MediaJobMutationPhase;
  readonly runningJobIds: ReadonlySet<string>;
  readonly selectedMediaJobId: string;
  readonly form: MediaJobFormState;
  readonly errors: readonly MediaScopedError[];
}
```

`ReadonlySet` 只在 domain state 内使用；传给展示层前可派生 `isRunning(jobId)`，不序列化。

Actions 固定为：

```ts
refreshMediaJobs(cwd?: string, reason?: "manual" | "poll" | "enter" | "repair-return"): Promise<void>
createMediaJobFromForm(): Promise<MediaMutationResult>
executeMediaJob(jobId: string): Promise<MediaMutationResult>
retryMediaJobArtifacts(jobId: string): Promise<void>
clearMediaError(owner: MediaScopedError["owner"]): void
resetForCwd(): void
```

`MediaController` 继续满足 `DomainController`；`error` 可投影最新 scoped error 供调试，但 Media UI 只消费
`errors`，不再调用/接收 `AppShell.errorMessage`。

## 4. Pure View-Model Contracts

### 4.1 Row projection

`deriveMediaJobRowView(input)` 一次返回：

```ts
interface MediaJobRowView {
  readonly jobId: string;
  readonly identity: { title: string; description: string; titleTooltip?: string };
  readonly meta: readonly string[];
  readonly status: { id: MediaJobProductState; labelKey: string; tone: StatusTone };
  readonly primaryAction?: MediaJobActionView;
  readonly preview: MediaJobPreviewView;
  readonly stale: boolean;
}
```

输入必须包含 job、artifact phase/artifacts、provider/workflow source view、approval view、local run state、
project/scene context。JSX 不能重复判断优先级。

### 4.2 Action ids

```ts
type MediaJobActionId =
  | "start"
  | "retry"
  | "open_approval"
  | "repair_provider"
  | "repair_workflow"
  | "repair_connection"
  | "refresh"
  | "view_result"
  | "download"
  | "copy_prompt"
  | "copy_result_link"
  | "reuse_settings";
```

每个 action view 固定含 `labelKey`、`disabled`、`disabledReasonKey`、`emphasis`。组件只 dispatch ID。

### 4.3 Source projection

```ts
type MediaWorkflowConnectionView =
  | { kind: "available"; id: string; status: MediaWorkflowConnectionStatus }
  | { kind: "missing"; id: string };

type MediaJobSourceView =
  | { kind: "provider"; id: string; name: string; runtime: MediaProviderRuntimeState }
  | { kind: "provider_missing"; id: string }
  | { kind: "workflow"; versionId: string; definitionId: string; name: string; status: MediaWorkflowDefinitionStatus; connection: MediaWorkflowConnectionView }
  | { kind: "workflow_missing"; versionId: string; reason: "version_missing" | "definition_missing" };
```

Provider runtime 必须调用 core resolver；不在 Web 重写 secret/base URL/adapter precedence。Workflow source
由 `MediaProductionWorkspace` 已加载的 workflow/connection truth 构建。

### 4.4 Artifact projection

`deriveMediaJobResultView` 区分：

- `loading`：job 声明 artifactIds、当前 signature 正在加载；
- `ready`：至少一个 image/video；
- `missing`：succeeded 但无媒体 artifact；
- `unavailable`：artifact request/content 失败；
- `none`：queued/running 尚未产生结果。

不能把 `loading` 误判成 `missing`。Primary artifact 是返回顺序的第一个 image/video；不按 title/type
重新排序。

### 4.5 Form validation and reuse

`validateMediaJobForm` 返回 field-id keyed errors：

```ts
type MediaJobFieldId =
  | "workspace"
  | "operation"
  | "providerPresetId"
  | "prompt"
  | "imageUrl"
  | "maskUrl"
  | "count"
  | "seed"
  | "duration";
```

固定规则：

- cwd/source/prompt required；prompt trim 后 1..2000；
- image/mask URL 非空时只接受 `http:` / `https:`；
- count integer >=1；seed integer；duration finite >=1；
- capability 列表存在时 duration/ratio 必须在 allowlist；
- watermark 只允许 `"" | "true" | "false"`。

`mediaJobToReusableForm(job)` 只读 allowlist 参数：`size`、`n/count`、`seed`、`watermark`、
`imageUrl/image_url`、`maskUrl/mask_url`、`ratio/aspect_ratio`、`duration/duration_seconds`。所有其他 key
丢弃，`inputText=""`。原 provider missing 时 `providerPresetId=""`；不能自动选别的模型。

Create Dialog 的 source options 只能来自当前 `ProviderPreset[]`。`CreateMediaJobRequest` 没有 workflow
source 字段，所以不得把 workflow definition/version 放入该 Select，也不得扩展 payload。Workflow job
在列表中是现有 Media Production/workflow 运行产生的权威历史；通用 Reuse 仍只水合为
direct-provider form。

### 4.6 Preview content retry

`MediaArtifactPreview` 局部持有 `contentPhase: "loading" | "ready" | "error"` 和 `retryNonce`。

- identity 固定为 `cwd + artifact.id + canonicalContentUrl`；identity 改变重置 phase/nonce；
- `img.onLoad` 或 `video.onLoadedMetadata` -> `ready`，`onError` -> `error`；
- Retry preview 仅将 nonce `+1`，展示 busy fallback，并使用
  `appendPreviewRetry(canonicalContentUrl, nonce)` 追加 `previewRetry` query 后重建媒体元素；
- helper 使用 `new URL(canonicalContentUrl, window.location.origin)` 和 `searchParams.set`，不手工拼
  `?`/`&`；daemon 忽略未知 query，API 不变；
- Open/Download/Copy result link 始终使用 canonical URL，不泄漏 nonce；
- 该 Retry 不调用 `retryMediaJobArtifacts`；后者只重试 artifact metadata list。

### 4.7 Repair mapping

`deriveMediaJobRepairView` 固定使用合同第 12 节 precedence。Provider current runtime reason 高于历史 raw
error；来源已恢复为 runnable 时历史 missing-key/base-url error 不再导向 editor，而是 Retry。

Raw parser 只负责 rate-limit、timeout/network、invalid request、missing result 和 unknown fallback；不得
用 raw message 作为 locale key。纯测试覆盖每个 mapping。

## 5. Domain Load, Artifact And Polling Algorithm

### 5.1 Request guards

在 `use-media-domain.ts` 使用现有 `useLatestRequestGuard`/`useLatestKeyedRequestGuard`，并维护：

```text
workspaceEpoch     cwd/reset 变化递增
listRequestToken   每次 list intent 递增
mutationEpoch      create/run 开始与成功递增
artifact token     key = cwd:jobId:artifactSignature
```

list response 只有同时满足 captured cwd、workspaceEpoch、request token 和 mutation barrier 才能 commit。
manual refresh 比 poll intent 新；旧 poll 无权覆盖。

### 5.2 List commit

1. first load 无 rows：`initial` + skeleton；
2. retained manual refresh：`refreshing`，保留 rows/artifacts；
3. poll：`polling`，不显示全页 busy；
4. list 成功按 server order commit jobs；
5. selected ID 仍存在则保留，否则选择第一条；
6. 每个有 artifactIds 的 job 计算 stable signature；未变且 ready 的缓存保留；
7. 新/变 signature 标记 loading 并各自加载；使用 `Promise.allSettled`，不能一条失败使全部失败；
8. list failure 有旧 rows -> `refresh` error；无旧 rows -> `load` error；
9. successful refresh 清 load/refresh error，不清未解决 run/artifact error。

### 5.3 Polling

- 继续保持当前 `queued || running` 时 2000ms timeout；不改 daemon 生命周期；
- timer 到期调用 `refreshMediaJobs(cwd, "poll")`；已有 list request 时不再并发；
- poll 不显示 Toast，不改变 filter/focus/scroll；
- 所有 job 离开 queued/running 后停止；unmount/cwd reset 必须 clear timeout；
- 不引入 interval，不在 background poll 中重放 Skeleton。

当前 API 无法区分“standalone queued 等待用户开始”和“后台已接管的 queued”。优化该轮询需要新的
公开 execution state，不属于 P10.1；本轮只保证 quiet/single-flight，不伪造区别。

### 5.4 Create

- domain 开始 `createPhase=submitting`，只锁 Create Dialog submit；
- API 成功后 merge 新 job 到 server-order-compatible 头部、建立 empty artifact state、选择新 ID；
- 返回 `{ok:true, jobId, status:"queued"}`；UI 关闭 Dialog + Toast；
- 失败写 owner `create`，返回 `{ok:false}`；Dialog 保留 draft/open；
- create 开始使旧 list request 失效，防止旧列表抹掉新 job。

### 5.5 Run/retry

- 同 job 已在 `runningJobIds` 时直接返回 `{ok:false}`，不发第二次 request；
- 加入 ID map，选中 job，清该 job 的 run error；
- API response 无论 status 200/202 都 merge `mediaJob`；有返回 artifact 即更新；
- response job failed 不是 transport exception，仍写入 job truth，repair 由 object state显示；
- API throw 写 `run:<id>`，随后 quiet refresh；旧 request guard 不覆盖新 status；
- finally 只移除该 ID，不清其他并行 job；
- run accepted/completed 不弹 success Toast，authoritative row/Inspector 是反馈。

## 6. Host And Repair Navigation Boundary

### 6.1 Media Production host

扩展 render prop，不新增 route：

```ts
interface MediaJobHostActions {
  readonly openWorkflow: (workflowDefinitionId: string) => void;
  readonly openWorkflowConnection: (connectionId: string) => void;
}

jobsPanel(
  context: MediaJobDisplayContextMap,
  hostActions: MediaJobHostActions,
): ReactNode
```

`media-job-host-bridge.ts` 负责：

- 从 project/scene runs 建 project/scene context；
- 从 workflow version 找 definition/connection/name/status；
- 选择对应 workflow/connection，设置正确 library tab，再打开现有 `MediaWorkflowLibraryOverlay`。

把 `MediaProductionWorkspace.tsx` 当前 jobContext useMemo 抽到 helper，保证接线后不超过 390 行。

### 6.2 Provider repair

AppShell 提供：

```ts
onOpenProviderRepair(providerPresetId: string | undefined, operation: MediaOperation): void
```

- provider 存在：调用现有 `editProvider(provider)`，打开 Settings embedded Model Workbench，并通过
  Web-only `providerEditorRequest { providerId, sequence }` 让现有 Editor Dialog 打开；
- provider missing：`image_generate/image_edit -> setupIntent="generation"`，
  `video_generate -> setupIntent="video_generation"`；
- ProviderSettings 只消费该 request 并调用现有 `editor.openEdit/openNew`；不增加 provider API 行为；
- request 消费后清除，返回 Media Jobs 不重复打开。

### 6.3 Approval repair

Media Jobs 接收当前 `ApprovalRequest[]` 的只读投影与：

```ts
onOpenApproval(approvalId: string): void
onRefreshApprovals(): Promise<void>
```

AppShell 只设置现有 selected approval 并打开 `approvals` View。Media manual Refresh 使用
`Promise.all([refreshMediaJobs, refreshApprovals])`；background poll 只刷新 Media jobs，避免无关审批噪声。

## 7. Slice Plan And Weighted Progress

| Slice | Weight | Dependencies | Function IDs | Deliverable |
|---|---:|---|---|---|
| P10.1.0 Baseline/fixture freeze | 5% | none | all | current tests, fixture catalog, selector/line inventory |
| P10.1.1 Domain/types/view-model split | 21% | P10.1.0 | all | scoped state, guards, artifact loader, pure projections/tests |
| P10.1.2 Shell/list | 17% | P10.1.1 | LIST | shared header/filter/DataRow/loading/empty/stale |
| P10.1.3 Create Dialog | 17% | P10.1.1 | CREATE | shared form/Dialog, validation, busy/failure, provider drift |
| P10.1.4 Result/preview/copy/reuse | 17% | P10.1.1 | RESULT | summary-first Inspector, media/artifact fallback, clipboard/reuse |
| P10.1.5 Repair/host navigation | 10% | P10.1.1 + host truth | REPAIR | provider/workflow/approval specific routes and return refresh |
| P10.1.6 CSS/theme/a11y integration | 6% | P10.1.2-5 | all | focused CSS, old owner deletion, pixel/overflow/motion |
| P10.1.7 Regression/evidence/closeout | 7% | all previous | all | focused + selected suites, screenshots, metadata, status updates |

总计 `100%`。只有局部代码、测试和 visual evidence 都通过的 slice 才可完成；按文件数平均计进度无效。

## 8. Detailed Slice Execution

### 8.1 P10.1.0 Baseline and fixture freeze

记录 current line/selectors/raw controls 与测试结果。建立 focused fixture catalog：

| Fixture | Required truth |
|---|---|
| `media_empty_no_model` | no jobs, no runnable source |
| `media_mixed_100` | 100 server-ordered jobs, all status/source types, long zh/en |
| `media_refresh_stale` | retained rows + list failure then retry |
| `media_image_ready` | image result + auxiliary json/markdown |
| `media_video_running` | async running video, no percent |
| `media_video_ready` | paused video result + download/open |
| `media_missing_artifact` | succeeded ids, artifact list/content failure |
| `media_provider_blocked` | disabled/key/base-url/adapter reasons |
| `media_workflow_blocked` | workflow/connection missing and failed |
| `media_approval_waiting` | gated pending, gated missing, legacy waiting |
| `media_long_create` | all three operations, max prompt, capability constraints |

不得含真实 API key/secret、真实用户路径或远端受限 URL。

### 8.2 P10.1.1 Domain and view-model

1. 添加 types/request guards/artifact helper；
2. 移除 media domain 对 `setErrorMessage` 的依赖；
3. 分离 list/create/run/artifact phases；
4. 原子 merge 与 selection identity；
5. split 503-line view-model；
6. 建 provider/workflow/approval/result projections；
7. 为 precedence、action、repair、form/reuse 写纯测试；
8. 保持 existing API wrappers payload 完全不变。

Exit gate：domain/view-model production owner `<=400`；legacy E2E 不退；无 API/contracts diff。

### 8.3 P10.1.2 Shell and list

1. 删除 unreachable standalone header 分支与 `embedded` prop；
2. Header 迁 Button/IconButton，filter 迁 SegmentedControl；
3. List 迁 DataRow/StatusIndicator；
4. 实现 initial skeleton、true empty、filter no-result、retained stale；
5. row action propagation、selection/filter identity、100-row scroll；
6. queued/running poll 不让整页 busy。

Exit gate：LIST focused scenarios 全绿；root overflow 0；没有 raw button/StatusActionRow/OperationEmptyState。

### 8.4 P10.1.3 Create Dialog

1. 新建受控 `MediaJobCreateDialog`，移除 CreateDialogShell/DialogSection/SelectControl；
2. Field/Input/Textarea/Select 映射三种 operation；
3. advanced 默认折叠；image edit core 与 video core 保持可见；
4. field validation 和 disabled reason；
5. submit await Promise，busy 阻止 dismiss；
6. failure 保留 draft，success close/select/Toast；
7. provider refresh/removal 和 cwd reset identity。

Exit gate：Create Dialog focus/Esc/outside/busy/long content/reduced motion 全绿；focus 前后字段 geometry 不变。

### 8.5 P10.1.4 Result, preview, copy and reuse

1. 拆 `MediaJobInspector/Result/ArtifactRow`；
2. all artifacts 传入 Inspector，media/auxiliary 在 view-model 分层；
3. hero contain，video no autoplay，load error fallback；
4. content error Retry 使用 local nonce/cache-bust；View/Open/Download 使用 canonical existing URL；
5. clipboard Promise owner + scoped Toast/InlineFeedback；
6. reuse allowlist hydration + Dialog；
7. full prompt/technical details 默认折叠，secret scan。

Exit gate：RESULT focused scenarios、pixel hash、copy failure、reuse source drift 全绿。

### 8.6 P10.1.5 Repair and host routing

1. 扩展 host render-prop 与 source context；
2. provider known opens exact editor，missing opens correct setup intent；
3. workflow known opens exact definition，connection failure opens Connections tab；
4. gated waiting opens exact approval；legacy waiting remains runnable；
5. repair return refreshes provider/jobs，失败对象不被 success Toast 遮蔽；
6. raw error stays folded and product copy is stable。

Exit gate：每个 repair reason 有 E2E trigger/target/result；workflow 任务不出现 `Unknown provider`。

### 8.7 P10.1.6 CSS/theme/a11y

1. 新建 focused owner，先让新 components 可用；
2. 同一 slice 删除旧 files/import/selectors；
3. static guard 证明 0 literal/important/transition-all/keyframe/theme selector；
4. Light/Dark/imported Theme、1440/1280、long content、scroll/overflow；
5. pixel invariants、keyboard、ARIA、reduced motion；
6. console 0 error/warning。

### 8.8 P10.1.7 Closeout

1. 跑所有 gates；
2. 采集 ledger 规定截图；
3. 每张 original size 审查并记录 SHA-256、viewport、theme、locale、fixture、URL、served artifact；
4. 后续只在证据完整后更新 coverage/README/status/feedback/CSS matrices；本 docs-only audit 不改这些文件；
5. Web 四个 ID 可 verified；packaged Desktop 仍 separate pending。

## 9. Exact CSS Migration And Deletion Matrix

### 9.1 Target ownership

| Target file | Owns | Budget |
|---|---|---:|
| `index.css` | imports only | 8 |
| `shell.css` | workspace root、host jobs height、header/filter/feedback、split、scroll | 150 |
| `list.css` | list spacing、row slots、thumbnail、ellipsis、selected/stale layout | 210 |
| `detail.css` | Inspector width/scroll、repair、result actions、sections、meta | 240 |
| `create-dialog.css` | operation form grid、counter、1280 body layout；不重写 Dialog/Field | 180 |
| `artifact-preview.css` | tile/hero frame、contain/cover、video/fallback；媒体 pixel rules | 120 |

Total focused feature budget `<=908`，但目标净 CSS 必须低于当前 985 行；未达到净减少时不能 closeout。

### 9.2 Required deletions

| Current owner | Exact action |
|---|---|
| `styles.css` imports `media.css/media-job-detail.css/media-create-dialog.css` | 替换为一个 `features/media-jobs/index.css` import |
| `media.css:13-779` | 迁移必要 geometry 后删除；不保留 facade |
| `media.css:1-11` | 删除 dead `provider-layout/provider-list-panel` 与冲突 `provider-form-panel min-height`；P9 focused provider CSS 已拥有 editor geometry |
| `media-create-dialog.css` all | 删除；共享 Dialog 拥有 overlay/content/header/footer，focused 只拥有 form grid |
| `media-job-detail.css` all | 删除；repair/detail 进入 focused owner |
| `media-production.css` `.media-production-jobs-view > .media-jobs-page` | 迁入 Media Jobs shell owner后删除 |
| `components.css` grouped `.media-job-row/.media-job-error/.media-job-approval` 和 specific selected/text rules | 从 grouped selector 精确移除，不改其他成员 |
| `strict-console.css` 所有 `.media-job-*`、`.workspace-generation-surface .media-job-*`、`.media-create-overlay .primary-button` | 删除；新 token/focused owner接管 |
| `strict-console.css` dark blanket 中 `.workspace-generation-surface/.media-jobs-page` | 从 grouped selector 移除；shell semantic tokens 接管 |
| JSX legacy class `primary-button/secondary-button/ghost-icon-button/status-badge/status-action-row` | Media feature 调用归零 |
| `SelectControl/StatusActionRow/ArtifactRow/OperationEmptyState/PageActionHeader/CreateDialogShell/DialogSection` imports | Media feature 调用归零；不删除全局 component 文件 |

### 9.3 Static CSS gates

```bash
rg -n '#[0-9A-Fa-f]{3,8}|rgba?\(|!important|transition:\s*all|@keyframes|data-theme|data-ui-theme|data-ui-presentation' \
  apps/web/src/styles/features/media-jobs

rg -n 'media-job|media-jobs|media-create|media-model-alert|media-artifact-preview' \
  apps/web/src/styles/components.css \
  apps/web/src/styles/strict-console.css \
  apps/web/src/styles/media-production.css

rg -n 'StatusActionRow|OperationEmptyState|SelectControl|ArtifactRow|PageActionHeader|CreateDialogShell|DialogSection|primary-button|secondary-button|ghost-icon-button|status-badge' \
  apps/web/src/features/media

wc -l apps/web/src/styles/features/media-jobs/*.css apps/web/src/features/media/*.{ts,tsx}
```

第一条和第二/第三条的 Media legacy 结果必须为 0；`rg` exit 1 表示无匹配，是成功条件。

## 10. Feedback, Busy And Race Acceptance

| Case | Required assertion |
|---|---|
| manual refresh with rows | only Refresh busy；rows/result remain actionable |
| poll with rows | no visible global spinner/Skeleton；selection/scroll stable |
| create submitting | only Dialog submit busy；Esc/outside/close blocked；Refresh remains available |
| run A submitting | only A row/selected inspector busy；B does not spin |
| concurrent run A/B | both IDs independently settle；one finally cannot clear other |
| duplicate run same ID | exactly one POST |
| old list after create | new job/status not overwritten |
| cwd change during any request | old response ignored；old Dialog/timer/error cleared |
| provider removed during Dialog | draft stays；source Field blocker；no silent model change |
| artifact A failure | B artifacts remain ready；list refresh not globally failed |
| preview content failure | only that artifact fallback appears；Retry changes only its nonce/source；canonical actions unchanged |
| copy rejected | action InlineFeedback appears；no success Toast |
| repair navigation | no success Toast；target editor/library/approval opens exactly once |
| stale refresh retry success | stale warning clears；unrelated run/artifact error remains |

No feature timer is allowed for Toast. The only Media Jobs timer is the existing 2-second poll lifecycle.

## 11. Focused E2E Scenario Matrix

新增 `apps/web/e2e/ui2-media-jobs.spec.ts`，不要把以下状态继续塞入 351 行 legacy spec。

| Scenario ID | Function IDs | Trigger and assertions |
|---|---|---|
| `MJ-01-reach-empty` | LIST/CREATE/REPAIR | exact Sidebar -> Media Production -> Generation tasks；first skeleton；empty/no model；Configure opens image setup |
| `MJ-02-list-states` | LIST | all canonical states、provider/workflow source、filters、selection、Enter/Space、nested action、100-row scroll、long zh/en |
| `MJ-03-refresh-race` | LIST/RESULT | retained stale + Retry、manual vs poll single-flight、selection/scroll、cwd identity、per-job artifact allSettled |
| `MJ-04-create-modes` | CREATE | image generate/edit/video field order、advanced disclosure、capability values、validation、focus geometry |
| `MJ-05-create-busy-reuse` | CREATE/RESULT | submit failure retains open draft、busy dismiss blocked、success closes/selects/Toast、reuse allowlist/provider present/missing/workflow |
| `MJ-06-progress-approval` | LIST/REPAIR | queued/start/202 running/completed、no percentage/cancel button、gated approval action、legacy waiting direct run、duplicate run one POST |
| `MJ-07-results` | RESULT | image/video/multiple/auxiliary、Open/Download、copy prompt/link success/failure、details folded、secret absent |
| `MJ-08-preview-pixel` | RESULT | image/video content error fallback、hero contain、no autoplay、computed pixel styles、Light/Dark/imported screenshot hash |
| `MJ-09-provider-repair` | REPAIR | all core runtime reasons、known exact editor、missing correct setup intent、return refresh then Retry |
| `MJ-10-workflow-repair` | REPAIR | known workflow/connection exact overlay tab、missing workflow fallback、raw error folded、no Model Workbench misroute |
| `MJ-11-responsive-a11y` | all | 1440/1280 Light/Dark、dialog bounds、root overflow、hit area、keyboard、aria-live、reduced motion、console |

Legacy `media-jobs.spec.ts` 保留现有五类行为：list/run/create、empty model route、OpenAI Images runnable、
live no approval、legacy waiting direct run。允许把 private class assertion 改为 role/data contract，但不能删除行为。

## 12. Pixel, Geometry And Overflow Invariants

Playwright 必须机械断言：

```text
media-production-jobs-view.scrollWidth <= clientWidth
media-jobs-surface.scrollWidth <= clientWidth
list/detail scrollHeight > clientHeight only in their own scroll owner
all visible IconButton boxes >= 32 x 32
Dialog edges >= 16px from viewport and body owns overflow
Field/Input/Select/Textarea focused and unfocused outer boxes have equal width/height
hero img/video filter == none
hero img/video opacity == 1
hero img/video mixBlendMode == normal
hero img/video objectFit == contain
tile objectFit == cover
hero video.autoplay == false and controls == true
```

Pixel test：使用完全不透明且和 hero frame 同宽高比的本地 deterministic PNG；分别在 `ling-light`、`ling-dark`、
validated imported Theme 下截取 `img` element，SHA-256 必须相同。Video 使用 paused deterministic fixture，
断言 computed style、current source、controls 和 element bounds；若浏览器视频帧 hash 不稳定，不用不可靠 hash
替代真实断言，metadata 明确 image pixel hash + video computed invariant 的不同证据类型。

Long-content test 必须同时包含：2000-char prompt、80-char provider/workflow/project/scene、长中文、长英文 URL、
100 rows、5 artifacts。行动不得换成竖排或离开容器。

## 13. Screenshot Ledger

未来 evidence 目录固定为：

`docs/design/ui2.0升级/evidence/features/media-jobs/`

| File | Viewport/theme/locale | Fixture and changed state | IDs |
|---|---|---|---|
| `1440x960-ling-light-mixed-list-result.png` | 1440 Light en-US | mixed list，image completed selected，multi artifacts | LIST/RESULT |
| `1280x800-ling-dark-needs-attention-repair.png` | 1280 Dark zh-CN | rate limit/provider repair selected | LIST/REPAIR |
| `1440x960-ling-light-empty-model-repair.png` | 1440 Light en-US | no jobs + no runnable model | LIST/CREATE/REPAIR |
| `1280x800-ling-dark-filter-no-result.png` | 1280 Dark zh-CN | retained data + filter no-result | LIST |
| `1440x960-ling-light-create-image.png` | 1440 Light en-US | image create，advanced closed，valid prompt | CREATE |
| `1280x800-ling-dark-create-video-advanced.png` | 1280 Dark zh-CN | video fields + advanced open + long labels | CREATE |
| `1440x960-ling-light-create-provider-blocked.png` | 1440 Light en-US | Dialog source removed/blocked + retained draft | CREATE/REPAIR |
| `1280x800-ling-dark-retained-refresh-failure.png` | 1280 Dark en-US | rows retained，stale warning，Refresh retry | LIST |
| `1440x960-ling-light-generating.png` | 1440 Light zh-CN | selected video running，no fake percent/cancel | LIST/RESULT |
| `1280x800-ling-dark-preview-unavailable.png` | 1280 Dark en-US | completed metadata + content failure fallback | RESULT |
| `1440x960-imported-quiet-ocean-image-result.png` | 1440 imported en-US | validated imported Theme + exact image pixels | RESULT |
| `1280x800-ling-dark-workflow-repair.png` | 1280 Dark zh-CN | workflow connection failure + correct repair | REPAIR |

每张 metadata 行记录：Function IDs、fixture id、URL `/`、served artifact `Vite source`、locale、theme ID、
viewport、state trigger、expected action、console errors、root overflow、SHA-256。截图必须是 changed-state，不能只拍
默认空页。所有 PNG 原尺寸逐张目检；自动 hash/尺寸不能替代视觉审查。

## 14. Verification Commands

### 14.1 Static and package gates

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
```

### 14.2 Focused browser gate

```bash
LING_PLAYWRIGHT_PORT=4184 corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-media-jobs.spec.ts
```

### 14.3 Behavior regression gate

```bash
LING_PLAYWRIGHT_PORT=4184 corepack pnpm --filter @ling-stack/web test:e2e -- \
  media-jobs.spec.ts \
  media-production.spec.ts \
  model-workbench.spec.ts
```

### 14.4 Shell/theme/full selected regression

```bash
LING_PLAYWRIGHT_PORT=4184 corepack pnpm --filter @ling-stack/web test:e2e -- \
  app.spec.ts \
  dark-mode.spec.ts \
  ui2-settings-workspace-tools.spec.ts \
  ui2-theme-registry.spec.ts
```

若 selected suite 按 grep/单 test 重跑，metadata 必须写精确 filter 与通过数，不能写成全文件通过。任何
`ERR_CONNECTION_REFUSED` 先按 Playwright port/server 归属处理，修复后重跑，不能计为产品失败或成功。

### 14.5 Browser evidence gate

- 真实 Vite source，不使用旧 dist 或过期 packaged renderer；
- 两 viewport、Light/Dark、imported Theme；
- screenshot ledger 12 张全部存在；
- console error/unhandled rejection/React warning 为 0；
- root horizontal overflow 为 0；
- focused geometry/pixel/keyboard/reduced-motion assertions 通过。

## 15. Parallel Execution Plan

P10.1.1 是公共依赖，单 owner 完成并冻结 props/types 后，最多四路并行：

| Worker | Owned files | Forbidden overlap | Verification |
|---|---|---|---|
| A List | Header/List/Row + `shell.css/list.css` | domain/create/result/repair | LIST focused cases |
| B Create | CreateDialog/AdvancedFields/form view-model + `create-dialog.css` | list/result/domain | CREATE focused cases |
| C Result | Inspector/Result/Artifact/Preview/result view-model + detail/artifact CSS | list/create/domain | RESULT focused cases |
| D Repair/Tests | repair view-model/component、host bridge、focused E2E fixture scaffolding | domain state and A-C components | REPAIR focused cases |

Main integrator 独占：`AppShell.tsx`、`use-media-domain.ts`、`MediaJobsPage.tsx`、`styles.css`、legacy CSS selector
removal、final regression/metadata。子任务完成后必须立即回报文件、测试和风险；未冻结公共 types 前不得并行改 props。

P10.1.6 CSS cleanup 必须在 A-C 全部接入后由单 owner 完成，避免多个执行者同时删 grouped selectors。

## 16. i18n And Exact Product Copy

沿用项目 English-source key 形式；新增 key 同时写 `en-US/zh-CN`。核心 copy 冻结如下：

| English source | zh-CN |
|---|---|
| Generation tasks | 生成任务 |
| New generation task | 新建生成任务 |
| Configure generation model | 配置生成模型 |
| No generation tasks yet | 还没有生成任务 |
| No tasks match this status | 没有符合当前状态的任务 |
| Could not load generation tasks | 无法加载生成任务 |
| Could not refresh generation tasks. Showing the last loaded data. | 无法刷新生成任务，当前显示上次加载的数据。 |
| Ready to start | 可开始 |
| Starting generation | 正在启动生成 |
| Generating | 正在生成 |
| Waiting for review | 等待审批 |
| Needs attention | 需要处理 |
| Completed | 已完成 |
| Status unavailable | 状态不可用 |
| Start generation | 开始生成 |
| Retry generation | 重试生成 |
| Open review queue | 打开审批队列 |
| Edit this model | 编辑此模型 |
| Open workflow | 打开工作流 |
| Open connection settings | 打开连接设置 |
| Copy prompt | 复制提示词 |
| Copy result link | 复制结果链接 |
| Reuse settings | 复用设置 |
| Generation task created | 生成任务已创建 |
| Settings copied to a new task | 已将设置复制到新任务 |
| Could not copy to the clipboard | 无法复制到剪贴板 |
| Preview unavailable | 无法预览 |
| Technical details | 技术详情 |

Reason-specific copy 使用 contract 第 12 节英文标题与对应自然中文；raw message 不翻译、不进入 title/Tooltip。

## 17. Hard Stops And True Blockers

### 17.1 True API/business blockers

以下能力当前确实没有公开合同：

1. **Standalone Media Job Cancel**：只有 `/media-scene-runs/:id/cancel`，没有 `/media-jobs/:id/cancel`。
2. **Numeric progress/ETA/stage**：Web `MediaJob` 没有 percent/stage/ETA，execution handle 未公开。
3. **Job edit/delete/archive**：collection/item routes没有对应 mutation。
4. **Full history/pagination/server search**：list 只支持 limit/status/provider，Web 当前取 100。

它们不阻塞本 P10.1 UI migration，因为合同明确不显示这些控制；如果产品要求新增，必须另开 API/业务设计，
不能在本 slice invent。

### 17.2 Implementation hard stops

- 必须读取 secret/raw header 才能完成默认 UI；
- workflow task 只有 provider repair 路径；
- gated approval 被 UI 直接 run 绕过；
- create failure 需要关闭 Dialog 才能恢复；
- artifact failure 要清空全部任务才能处理；
- legacy test 要求恢复 raw button/manual overlay/global error；
- CSS 只能靠 Theme/Profile selector 或覆盖 `.ling-ui-*` 才能通过；
- 实现需要修改 daemon/contracts/DB/route/status machine。

出现时停止对应 slice，记录文件、调用链、已尝试方案和需要的上游合同；其他不依赖任务继续。

## 18. Rollback Boundary

- P10.1 只有 Web presentation/controller/view-model/CSS/test/doc 变更，无数据迁移；
- domain state 可按 `use-media-domain + media-domain-*` 整组回退，API wrapper 不变；
- list/create/result/repair 可按组件 slice 回退，但不能留下新 JSX + 旧 CSS 的混合 owner；
- 删除 old CSS 前先让 focused owner和对应 E2E通过；删除后同一 slice跑完整 regression；
- provider editor request 与 media-production host bridge 是独立 adapter，可单独撤回，不影响存储数据；
- rollback 不使用数据库修复，也不修改已有 MediaJob/Artifact 记录。

## 19. Desktop And Imported Theme Boundary

- Electron main BrowserWindow 使用同一 Web renderer，P10.1 不复制页面或 CSS；
- Web Vite 通过只能将四个 Web ID 关闭；不能声称 packaged macOS/Windows verified；
- packaged evidence 后续至少覆盖 macOS Retina、Windows 125%/150% DPI、native titlebar、forced colors、
  theme first frame 和 media playback；
- imported Theme Web fixture必须来自现有 validated registry/storage 流程，不手工设置任意未验证 CSS；
- `media-canvas` Presentation policy 关闭 artwork/decoration 对媒体 frame 的影响；
- imported Theme pixel hash 只能证明 Web media pixels，不能代替 Desktop GPU/video playback 证据。

packaged Desktop 不可用只阻塞 Desktop verified，不阻塞 Web closeout；metadata 必须写 `packaged Desktop pending`。

## 20. Completion Checklist

- [x] 唯一真实入口和 jobs tab 可达，dead standalone branch 删除。
- [x] 四个 canonical Function ID 均有真实 trigger、状态、action、E2E、截图。
- [x] provider/workflow/approval 三类 repair 不串路由。
- [x] standalone cancel、numeric progress、job delete/edit 不出现在 UI。
- [x] create 成功前 Dialog 不关闭，失败保留输入，busy dismiss 正确。
- [x] refresh/create/run/artifact busy 独立，cwd/mutation/request race 全覆盖。
- [x] image/video/multi/partial/unavailable/copy/reuse/raw details 全覆盖。
- [x] Media Jobs 不再消费 `AppShell.errorMessage`。
- [x] Media feature 共享 primitive 迁移完成，legacy imports/classes 归零。
- [x] 三份旧 Media CSS 删除，focused owner满足行数/颜色/cascade guard。
- [x] 1440 Light、1280 Dark、long content、keyboard、reduced motion、overflow、console 通过。
- [x] imported Theme image pixel hash 与 video computed invariants 通过。
- [x] focused、legacy、Media Production、Model、App、Dark、Settings embedded、Theme regression 全绿。
- [x] 12 张原尺寸截图和 metadata 完整目检。
- [x] 所有 production owner <800、decision owner <=400；AppShell 无新增主要逻辑。
- [x] Web verified 与 packaged Desktop pending 独立记账。

Closeout evidence: [Media Jobs evidence metadata](../evidence/features/media-jobs/metadata.md)。P10.2 和 packaged
Desktop 不由本 checklist 关闭。
