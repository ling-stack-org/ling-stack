# Media Jobs UI 2.0

Status: `P10.1 Web verified / packaged Desktop pending`。

本文件冻结 Media Jobs 的产品、交互、状态和展示合同。实施文件边界、迁移顺序、CSS 删除清单、测试与
截图证据见 [Media Jobs implementation plan](12-Media-Jobs-implementation-plan.md)。本文只覆盖 P10.1；
Storyboard、Scene、Workflow Library 的完整升级仍由 `13-Media-Production.md` 所有。

## 0. Implementation Evidence

- Web 四个 canonical Function ID 已按本文合同实现并 verified；P10.2 Media Production 仍独立记账。
- focused `ui2-media-jobs.spec.ts` 为 `11/11`，legacy `media-jobs.spec.ts` 为 `5/5`，与完整
  `media-production.spec.ts` 的最终串行联合结果为 `24/24`。
- 三份旧 Media Jobs CSS 共 `985` 行已删除，focused owner 为 `521` 行；聚合 CSS 中 Media Jobs selector
  归零，Feature source 最大文件 `201` 行。
- 12 张 Light/Dark/imported Theme 原尺寸 changed-state 截图、JSON sidecar、SHA-256、overflow 和逐图审查见
  [Media Jobs evidence metadata](../evidence/features/media-jobs/metadata.md)。
- `MediaArtifactPreview` 对 mock/损坏内容显示真实 fallback，不把不可解码字节伪装为可播放媒体；Theme Pack
  只改变 UI surface，不改变媒体像素。
- packaged Electron macOS/Windows、Retina/DPI 和 high-contrast 继续为 P13 release gate。

## 1. 页面目标

Media Jobs 是当前 workspace 最近 100 条图片/视频生成任务的操作面。用户必须能在默认层回答：

1. 哪些任务可以开始、正在生成、需要处理或已经完成；
2. 当前任务使用什么生成来源，结果是否真实可用；
3. 失败后应重试、修复模型、修复工作流还是处理审批；
4. 如何查看、下载、复制和复用一个真实结果。

它不是 provider 响应日志、执行句柄或 workflow 调试控制台。Task ID、provider route ID、workflow
version ID、raw input、external operation、poll attempts、adapter、transport 和原始错误默认折叠。

## 2. 非目标与硬边界

- 不新增或修改 daemon API、API client、contracts、数据库、路由、`ViewId` 或运行状态机。
- 不改变创建任务只持久化为 `queued`、用户随后显式开始生成的现有语义。
- 不新增独立 Media Job 的取消、删除、归档、编辑或数值百分比进度；现有公开 API 不提供这些能力。
- 不把 Media Production 的 scene-run 取消冒充成所有 Media Job 都可取消。
- 不改变 provider/workflow 的真实执行、审批、artifact 收集、secret redaction 或重试语义。
- 不把 workflow 来源的任务错误引导到 Model Workbench，也不把 provider 来源错误引导到 Workflow Library。
- 不以主题、Presentation Profile 或 Desktop 平台分支改变媒体像素、任务状态或行动可用性。
- 不纳入移动端；Web desktop `1440x960`、`1280x800` 是本切片验收面。

## 3. 唯一可达入口与当前调用链

当前没有独立 `/media-jobs` 页面路由，也没有 Settings 入口。唯一真实入口是：

```text
SidebarNavigation
  -> SidebarPrimaryNavigation / "Media Production"
  -> onOpenView("media")
  -> useAppNavigationController.openPlainView("media")
  -> AppShell activeView === "media"
  -> refreshProviders() + refreshMediaJobs()
  -> LazyMediaProductionWorkspace
  -> MediaProductionWorkspace，默认 view="studio"
  -> 顶部 SegmentedControl / "Generation tasks"
  -> view="jobs"
  -> jobsPanel(jobContext, hostActions)
  -> LazyMediaJobsPage
```

精确文件：

- `apps/web/src/features/navigation/SidebarPrimaryNavigation.tsx`
- `apps/web/src/app/use-app-navigation-controller.ts`
- `apps/web/src/app/AppShell.tsx`
- `apps/web/src/app/lazy-pages.tsx`
- `apps/web/src/features/media-production/MediaProductionWorkspace.tsx`
- `apps/web/src/features/media-production/MediaProductionCanvasToolbar.tsx`
- `apps/web/src/features/media/MediaJobsPage.tsx`

`MediaJobsPage` 现有 `embedded=false`、`PageActionHeader` 分支没有生产调用方。P10.1 删除该不可达分支，
只保留 Media Production 内的嵌入态；不能为保留死分支制造第二套视觉。

## 4. 当前架构与权威数据链

```text
MediaJobsPage / List / Detail / Create
  -> useMediaDomain state + actions
  -> apps/web/src/api/media.ts
  -> @ling-stack/api-client admin endpoints
  -> daemon /media-jobs routes
  -> core SqliteMediaStore
  -> provider-executor or workflow-executor
  -> RunArtifact records and artifact content endpoint
```

### 4.1 当前 Web owners

| Owner | 当前责任 | 审计结论 |
|---|---|---|
| `MediaJobsPage.tsx`，368 行 | 本地 Dialog/filter/starting、provider 过滤、页面组合 | 接近 400 行，混入展示派生与异步协调 |
| `MediaJobList.tsx`，213 行 | client filter、row selection、row run | 仍使用 `StatusActionRow` 和 raw button |
| `MediaJobDetailPanel.tsx`，348 行 | summary、result、failure、raw details、copy | 三类责任混合；copy label 与真实内容不一致 |
| `MediaJobAdvancedFields.tsx`，118 行 | operation-specific form fields | raw input + `SelectControl`，未使用共享 Field |
| `MediaArtifactPreview.tsx`，57 行 | image/video tile/hero/scene | hero 当前 `cover`，没有 load-error fallback |
| `media-job-view-models.ts`，503 行 | 状态、行动、失败字符串解析 | 已超过新增 decision owner 的 400 行上限 |
| `use-media-domain.ts`，252 行 | list/create/run/artifact/poll | refresh/create 共用 loading，错误外泄到 AppShell |
| `AppShell.tsx`，3140 行 | domain wiring 与跨页面导航 | 只允许薄 props/callback，不增加业务派生 |
| `MediaProductionWorkspace.tsx`，398 行 | studio/jobs host、workflow state | 已在 400 行边界，接入前必须先抽纯 helper/bridge |

### 4.2 权威类型与 API

- `packages/contracts/src/media.ts`
  - `MediaOperation = image_generate | image_edit | video_generate`；
  - `MediaJobStatus = queued | running | waiting_for_approval | succeeded | failed | cancelled`；
  - `MediaJob.executionSource` 区分 provider 与 workflow；
  - `artifactIds` 只声明关联，不保证每个内容当前都可加载。
- `GET /media-jobs?cwd&limit=100`：按 `created_at DESC` 返回当前 workspace 最近 100 条；没有分页总数。
- `POST /media-jobs?cwd`：创建 `queued` 任务，不自动执行。
- `POST /media-jobs/:id/run?cwd`：开始、继续或重试；可能返回 `200` 或异步 `202`。
- `GET /media-jobs/:id/artifacts?cwd`：返回该任务全部 artifact。
- `/artifacts/:id/content?cwd`：真实图片、视频或辅助 artifact 内容。

P10.1 不读取或展示内部 `MediaJobExecutionHandle`。它未通过 Web API 暴露，不能据此虚构阶段或百分比。

## 5. Canonical Function IDs

全产品覆盖矩阵只有以下四个 canonical ID。旧文档中的 `PROGRESS/FAILURE/DETAIL/MODEL` 不再作为
独立计数项，分别并入 LIST、RESULT 和 REPAIR。

| Function ID | 真实触发 | 当前文件与数据 | 目标行动与状态 |
|---|---|---|---|
| `MEDIA-JOB-LIST-001` | 点击“生成任务”、Refresh、状态筛选、选择行、Start/Retry | `MediaJobsPage.tsx`、`MediaJobList.tsx`、`use-media-domain.ts`；`MediaJob[]`、artifact load state、provider/workflow context | initial/retained refresh、empty/no-result、100-row scroll、queued/approval/starting/running/failed/cancelled/completed、选择与轮询 |
| `MEDIA-JOB-CREATE-001` | “新建生成任务”或“配置生成模型” | `MediaJobsPage.tsx`、`MediaJobAdvancedFields.tsx`、`media-payloads.ts`；`MediaJobFormState`、provider runtime state | image generate/edit/video、Field validation、advanced disclosure、submit busy/failure/success、provider drift、focus return |
| `MEDIA-JOB-RESULT-001` | 选择任务，查看结果、下载、复制、复用、展开详情 | `MediaJobDetailPanel.tsx`、`MediaArtifactPreview.tsx`、artifact endpoint；all/media artifacts | image/video hero、multi artifact、partial/unavailable、copy success/failure、reuse、raw technical details、pixel invariants |
| `MEDIA-JOB-REPAIR-001` | provider/workflow/approval blocker 或生成失败 | core provider runtime resolver、failure view-model、Model Workbench、Workflow Library、Approvals | reason-first InlineFeedback、specific repair target、retry、return refresh、raw error folded |

## 6. 产品真相边界

### 6.1 列表与历史

- 页面显示“已加载任务数”，不是 workspace 全历史总数；当前 API 窗口上限是 100。
- 服务器顺序是权威顺序，客户端不按状态或 `updatedAt` 重排。
- status filter 只过滤已加载的 100 条，不暗示 server-side search 或分页。
- 没有 job archive/delete API，P10.1 不显示 More/Delete/Archive。
- workspace 变化立即清空旧 workspace 的任务、选择、表单、timer 和 overlay；旧响应不得写回。

### 6.2 生成来源

- `executionSource.kind="provider"`：来源身份来自当前 `ProviderPreset`；可运行性来自
  `resolveMediaProviderRuntimeState(provider, operation)`。
- `executionSource.kind="workflow"`：来源身份来自 `MediaWorkflowDefinitionDetail` 与 version；修复入口是
  Workflow Library 或 Connection tab，不是 Model Workbench。
- Create Dialog 只能选择 provider model route。当前 `CreateMediaJobRequest` 必须提交 `providerPresetId`，没有
  创建 workflow job 的公开合同；workflow job 只会由现有 Media Production/workflow 流程进入历史列表。
- 因此 Create Dialog 的字段名固定为 `Generation model`，不得泛化成会暗示可选 workflow 的
  `Generation source`。P10.1 不增加 workflow picker 或把 workflow version 填入 provider 字段。
- 来源已经被删除时仍保留历史任务与结果。默认层显示“来源不可用”，raw ID 只在技术详情。
- 已完成任务即使当前来源后来失效，结果仍保持 `Completed`；只有再次复用/重试时才要求修复来源。

### 6.3 图片与视频任务

- `image_generate`：prompt 必填；size、count、seed、watermark 是高级参数。
- `image_edit`：prompt 必填；source image URL 是核心输入，mask URL 是可选输入。当前后端不强制 URL，
  前端只做 URL 形态校验，不擅自把可选 mask 改成必填。
- `video_generate`：prompt、ratio、duration 是核心输入；watermark 是高级参数。已验证 provider capability
  存在时只显示其允许 ratio/duration，否则使用当前兼容 fallback 值。
- 创建成功只产生 `queued` 任务。页面选择新行并显示“可开始”，不伪装为已经生成。

### 6.4 进度、轮询与取消

- 可显示的进度只有 `Starting`、`Ready to start`、`Waiting for review`、`Generating` 和终态。
- API 没有百分比、阶段名、预计剩余时间；不得显示假进度条或百分数。
- `queued/running` 保持现有 2 秒轮询，但轮询是 quiet refresh，不让页面或所有行进入 loading。
- 独立 job 没有 cancel endpoint。P10.1 不显示 Stop/Cancel。
- `cancelled` 是可读终态，主要行动是 Retry 或修复来源；scene-run Cancel 继续属于 P10.2。

### 6.5 审批

- 新建 standalone task 当前不写 `input.approvalGate`，正常开始不创建 media-cost approval。
- 来自 Media Production 的任务可能带 `approvalGate="media_cost"` 并处于 `waiting_for_approval`。
- 带 gate 且有 pending approval：显示 `Waiting for review`，行动是打开 Review Queue。
- 不带 gate 的 legacy `waiting_for_approval`：保持现有兼容语义，显示 `Ready to start` 并允许直接运行。
- 带 gate 但 approval 缺失：显示持久 warning，Refresh 同时刷新 jobs 与 approvals；不得直接运行绕过审批。

### 6.6 Artifact 与结果

- primary result 只从 `image` 或 `video` artifact 选择；markdown/json 等辅助 artifact 不冒充媒体结果。
- `succeeded + media artifact` 才是 `Completed`。
- `succeeded + artifactIds but media artifact unavailable/absent` 是 `Needs attention`，不得显示成功空框。
- 多个媒体 artifact：第一个作为 hero，其余进入结果列表；辅助 artifact 进入折叠技术详情。
- artifact 内容加载失败不删除记录；显示可下载/外部打开的 fallback 和对象级 Retry。
- View/Open/Download 都使用现有 artifact content URL，不复制媒体字节到 Web state。

### 6.7 Copy 与 Reuse

- `Copy prompt` 只复制完整 prompt。
- `Copy result link` 只复制当前 primary artifact URL。
- 旧 `Copy details` 实际只复制 prompt，P10.1 删除该误导名称。
- clipboard 不存在或拒绝时显示结果区域 InlineFeedback；不能静默失败。
- `Reuse settings` 是纯前端动作：把 operation、prompt 和 allowlist 参数填入新的 Create Dialog；不修改原 job。
- allowlist 只有 `size/n/seed/watermark/imageUrl/maskUrl/ratio/duration`。未知 raw input、approvalGate、
  workflow input、secret、adapter 字段不得复制到 `inputText`。
- 原 provider 仍存在时保留原选择；已删除时 provider 留空。不得静默替换成另一个模型。
- workflow job 的通用 Reuse 只复制 operation/prompt/通用参数到 direct-provider Create Dialog；不伪造 workflow
  form。要复用 workflow 本身，用户进入 Workflow Library。

## 7. 目标页面结构

```text
MediaProductionWorkspace / view="jobs"
  MediaJobsSurface
    MediaJobsHeader
      identity + concise loaded summary
      Refresh IconButton
      New generation task Button / Configure model Button
    MediaJobFilterBar
      SegmentedControl: All / Ready / Generating / Needs attention / Completed
    MediaJobsFeedback
      initial error or retained stale only
    MediaJobsContent
      MediaJobList
        Skeleton / EmptyState / no-result / DataRow[]
      MediaJobInspector
        EmptyState / summary / result / repair / sections
    MediaJobCreateDialog
```

- Header 第一行高度 `56-64px`；筛选独占第二行，避免 1280px 下与标题/行动挤压。
- 内容区使用 `minmax(360px, .78fr) minmax(0, 1.22fr)`；列表与 Inspector 各自纵向滚动。
- 页面根、`.media-production-jobs-view` 和 workspace surface 不产生横向滚动。
- 1280px 不改成移动 Drawer，也不隐藏状态或主行动；长文本收敛，不挤压 actions。
- Detail 内容最大可读宽度 `880px`，在右侧 panel 内左对齐，不做营销式大卡片。

## 8. 统一状态与行动优先级

### 8.1 Product state precedence

从高到低：

1. 当前 job 本地 request 正在提交：`starting`；
2. server `running`：`generating`；
3. `waiting_for_approval + approvalGate`：`waiting_for_review`；
4. provider/workflow 当前不可运行且 job 尚无可用完成结果：`needs_attention`；
5. `failed/cancelled/errorMessage/missing media result`：`needs_attention`；
6. `succeeded + >=1 media artifact`：`completed`；
7. `queued` 或无 gate 的 legacy waiting：`ready_to_start`；
8. 任何无法识别的漂移：`unknown`。

每行只显示一个 `StatusIndicator`。不叠 server status、provider state、artifact state 和 scene state。

### 8.2 Primary action matrix

| Product state | Row primary | Inspector primary | Secondary |
|---|---|---|---|
| ready_to_start | Start generation | Start generation | Copy prompt / Reuse |
| starting | disabled Starting | disabled Starting | none |
| generating | disabled Generating | disabled Generating | Copy prompt |
| waiting_for_review | Open review queue | Open review queue | Refresh |
| needs_attention + source blocked | Configure model/workflow | same repair action | Copy prompt / raw details |
| needs_attention + source runnable | Retry generation | Retry generation | Copy prompt / Reuse |
| completed | none | View result | Download / Copy prompt / Copy result link / Reuse |
| unknown | none | Refresh | Raw technical details |

## 9. MEDIA-JOB-LIST-001

### 9.1 Header 与筛选

- Summary 永远显示 loaded task count；`generating`、`needs attention` 只在非 0 时追加。
- Refresh 使用共享 `IconButton + RefreshCw`，只由 refresh phase 控制 loading。
- Create 使用共享 `Button + Plus`；无 runnable source 时同一位置变为 `Configure model + Box`。
- Filter 使用共享 `SegmentedControl`，不使用五个手写按钮。
- filter count 不使用彩色 chip；首版不显示 count，避免与 summary 重复。

### 9.2 列表状态

- first load：6 行结构匹配的 Skeleton，Inspector 同时保持稳定 skeleton；
- empty：`No generation tasks yet` + Create/Configure action；
- filter no-result：`No tasks match this status` + `Show all`；
- retained refresh：保留 rows、selection、scroll，Refresh 自身 busy；
- refresh failure with data：warning InlineFeedback + Retry，rows 标记 stale 但仍可查看结果；
- refresh failure without data：danger InlineFeedback + Retry，不显示空态；
- 100 rows：唯一 list scroll owner，header/filter 不随列表滚走。

### 9.3 Row

- 使用共享 `DataRow`，identity、summary、status、actions 四区稳定。
- identity 优先 project/scene context，否则使用 prompt 摘要；空 prompt 使用 operation label。
- summary 显示 operation + source name；meta 只显示结果数与更新时间。
- prompt 最多两行；source、project、scene 和时间过长时 ellipsis + `title`。
- 行 Enter/Space 选择；内部 action 阻止行选择；选中态不改变行高度。
- filter 改变后，如果当前选择不再可见，选择第一条可见 row；无可见 row 时 Inspector 显示 no-result。
- refresh 后保留仍存在的 selected ID；删除/不可见时选择当前 filter 第一条，不能按 array index 错选。

## 10. MEDIA-JOB-CREATE-001

### 10.1 Dialog 合同

- 使用共享受控 Dialog，size `lg`；body 是唯一滚动 owner。
- Header 只有标题和关闭；Footer 顺序是 Cancel、单一 primary `Create task`。
- idle 时 Esc/outside/Close 均关闭并恢复 Create trigger focus。
- submit busy 时阻止 Esc/outside/Close/重复提交；失败后恢复关闭能力并保留全部输入。
- API 成功后才关闭 Dialog、选择新 job，并发出 scoped success Toast；不能点击后立即关闭。

### 10.2 字段顺序

```text
Operation SegmentedControl or Select
Generation model Select (provider routes only)
Prompt Textarea + 0/2000 counter

image_generate advanced, default closed:
  Size / Result count / Seed / Watermark

image_edit core:
  Source image URL / optional Mask image URL

video_generate core:
  Aspect ratio / Duration
video_generate advanced, default closed:
  Watermark
```

- 所有字段使用共享 `Field/Input/Textarea/Select`；placeholder 不替代 label。
- operation 改变时只列支持该 operation 的 provider model route。首次新建可选首个 runnable model。
- Reuse 模式不自动改为另一个 model；原 model 不可用时保留并显示 Field repair，已删除时留空。
- provider 在 Dialog 打开期间刷新/删除时保留 draft，并在 Generation model Field 显示 blocker。
- `cwd`、provider model、prompt 是提交 gate；image-edit URL 若非空必须是 `http/https`。
- count 只接受整数 `>=1`，seed 只接受整数，duration 接受 provider capability 内值或数值 `>=1`。
- Field validation 在输入变化时清除；server/create failure 留在 Dialog 到重试或关闭。

## 11. MEDIA-JOB-RESULT-001

### 11.1 Inspector 信息层级

1. operation、单一 product state、source、project/scene context；
2. media hero 或真实 loading/unavailable fallback；
3. primary result actions；
4. 参数摘要；
5. full prompt `InspectorSection`，默认折叠；
6. all media results；
7. technical details，默认折叠。

不再常驻显示 Provider/Status/Created/Updated 四格卡。Created/Updated、raw IDs、raw status、raw input、
auxiliary artifacts 放入 Technical details。

### 11.2 媒体展示

- image/video hero 使用稳定 frame 与 `object-fit: contain`，不裁掉真实结果；tile 可使用 `cover`。
- hero image 不加 `filter`、`opacity`、`mix-blend-mode`、色彩校正或主题 overlay。
- hero video 默认不 autoplay，使用 controls、`playsInline`、`preload="metadata"`；tile 不播放且不接收 pointer。
- 媒体加载失败显示 artifact title、type、Open/Download 和 Retry preview；结果记录不消失。
- Preview 的 `img/video` 内容错误由 `MediaArtifactPreview` 按 artifact identity 独立持有。Retry preview
  只递增该 artifact 的本地 retry nonce，并在 canonical content URL 上追加 `previewRetry=<nonce>` 重新挂载
  媒体元素以绕过浏览器失败缓存；Open/Download/Copy result link 始终使用不带 nonce 的 canonical URL。
- alt/ARIA 使用 i18n，不保留硬编码中文“打开”。
- primary artifact 改变只发生在选择另一个 job；主题切换、刷新、展开 details 不替换媒体源。

### 11.3 参数与 raw details

- 默认参数摘要只显示存在的用户参数；不使用 `--` 占位撑满格子。
- provider source 显示 model route 的产品名；workflow source 显示 workflow name/version。
- raw provider response、raw `errorMessage`、IDs、operation/status enum、unknown input 和辅助 artifact 默认折叠。
- secret/token/header 不得进入 DOM、title、Tooltip、copy text、截图或 raw details。

## 12. MEDIA-JOB-REPAIR-001

### 12.1 Repair source precedence

1. completed result：不因当前来源失效而遮住结果；
2. pending media-cost approval：Review Queue；
3. current provider runtime reason：specific Model Workbench repair；
4. current workflow/version/connection state：specific Workflow Library/Connection repair；
5. missing result；
6. normalized rate limit / timeout / network / rejected request；
7. unknown error fallback。

### 12.2 Provider reason mapping

| Runtime reason | 产品标题 | 主行动 |
|---|---|---|
| provider missing | Model route is unavailable | Configure generation model |
| provider_disabled | This model route is disabled | Edit this model |
| operation_unsupported | This model does not support this task type | Choose or edit a model |
| base_url_missing | This model route needs a Base URL | Edit this model |
| secret_missing | This model needs an API key | Add API key |
| live_transport_invalid / required | Real generation is not connected | Edit this model |
| unsupported_live_adapter | This model cannot run this generation type | Choose another model |

已知 provider ID 必须打开该 provider 的现有编辑 Dialog；provider 已删除才打开对应 image/video setup。
修复后返回 Media Jobs 时刷新 providers/jobs，原失败仍保持到用户 Retry 或权威状态改变。

### 12.3 Workflow reason mapping

- version/definition missing：`Workflow is unavailable` -> Workflow Library；
- definition draft/blocked/archived：`Workflow is not ready` -> 对应 workflow；
- connection unchecked/error/disabled：`Workflow connection needs attention` -> Connections tab；
- workflow provider/raw execution failure：产品摘要 + Retry；原始 ComfyUI/provider 响应进入 details。

### 12.4 Runtime error mapping

- rate limit/quota/429：稍后 Retry；
- timeout/network/fetch：检查连接后 Retry；
- invalid request/rejected/400：修复 source 或输入；
- no usable result：Retry；
- unknown：`Generation failed` + Retry + raw details。

主文案不能直接显示 raw daemon/provider message，也不能把 raw string 传给 `t()` 当 locale key。

## 13. Feedback ownership

| Event | Owner | Presentation | Clear rule / scope |
|---|---|---|---|
| first load failure | Media Jobs surface | danger InlineFeedback + Retry | successful refresh / `media-jobs:load` |
| retained refresh failure | surface above content | warning InlineFeedback, data retained | successful refresh / `media-jobs:refresh` |
| no workspace/source | header or source Field | persistent InlineFeedback | cwd/provider change |
| create validation | exact Field | Field error | input change |
| create server failure | Create Dialog | danger InlineFeedback | retry/input/close / `media-job:create` |
| create success | global Toast | `Generation task created`，3000ms | provider lifecycle / `media-job:<id>:create` |
| run accepted/running/completed | row + Inspector state | no duplicate Toast | authoritative status |
| run failure | selected row + Inspector | persistent repair InlineFeedback | retry/success/source change |
| copy success | global Toast | 3000ms | `media-job:<id>:copy-prompt|copy-result` |
| copy failure | result action group | danger InlineFeedback | next copy/job change |
| reuse success | global Toast + opened Dialog | 3000ms | `media-job:<id>:reuse` |
| artifact load failure | result/technical section | warning/danger InlineFeedback | retry/artifact signature change |
| navigation to repair | authoritative navigation | no Toast | N/A |

`useMediaDomain` 不再写 `AppShell.errorMessage`。Media load/create/run/artifact errors由 Media domain 的
结构化 scoped state 持有，surface 决定 Field、InlineFeedback 或 Toast。Feature 不创建 Toast timer/viewport。

## 14. Busy、竞态、刷新与 identity

- `initialLoad`、`manualRefresh`、`backgroundPoll`、`create`、`runByJobId`、`artifactByJobId` 分开建模。
- Create busy 不锁 Refresh/list；row A run 不让 row B 或 Header spinning；Refresh 不锁可查看结果。
- 同一 job 的 Start/Retry single-flight；不同 job 保持现有可并行语义，busy 以 ID map 表达。
- manual refresh 与 poll 不能重叠提交；较新的 manual intent 使较旧 poll response 失效。
- create/run mutation 建立 request barrier；mutation 前启动的 list response 不能覆盖新 job/status。
- artifact request 以 `cwd + jobId + artifactIds signature` 为 identity；失败只影响该 job。
- preview content 以 `cwd + artifactId + canonical content URL` 为 identity；切换 identity 清空本地 error/nonce，
  同一 artifact Retry 只更新 nonce，不触发 list refresh 或其他 artifact busy。
- list/artifact 使用 latest-request guard；不要求 API client 新增 AbortSignal。
- refresh 不重置 filter、selected ID、list scroll、Inspector scroll 或已展开的 details。
- newly-created job 可显式选中；后台出现的新 job 不抢当前 selection/focus。
- 轮询或 refresh 返回时，只有仍存在且签名变化的 artifact 重新加载；未变结果复用缓存。
- initial artifact loading 不把 `succeeded` 暂时误判为 missing result；使用明确 `loading` phase。
- unmount、view switch、cwd switch 清理 timer，并使所有旧 request token 失效。

## 15. Component mapping 与文件边界

| Current | UI 2.0 target |
|---|---|
| raw/legacy header buttons | `Button` / `IconButton` |
| five raw filter buttons | `SegmentedControl` |
| `StatusActionRow` | `DataRow` |
| `status-badge` | one `StatusIndicator` |
| `CreateDialogShell` | shared controlled `Dialog` |
| `DialogSection` / raw details | `InspectorSection` / shared `Collapsible` |
| raw label/input/textarea + `SelectControl` | `Field/Input/Textarea/Select` |
| `OperationEmptyState` | `EmptyState` |
| `ArtifactRow` compatibility surface | focused `MediaJobArtifactRow` using shared Button/IconButton |
| raw `primary-button/secondary-button/ghost-icon-button` | shared Button/IconButton |
| `AppShell.errorMessage` | Media scoped feedback state |

边界要求：

- API 调用只留在 `use-media-domain.ts`；组件不 import API client。
- UI-only filter/Dialog/copy/reuse/focus state进入 `useMediaJobsPageController`。
- status/action/source/repair/input hydration 是纯 view-model，不写进 JSX/i18n。
- `AppShell.tsx` 只传 props/callback；不得增加条件矩阵。
- production owner 硬上限 800 行；新增或主要 decision owner 硬上限 400 行。
- 当前 503 行 view-model 必须先拆再加；398 行 MediaProductionWorkspace 必须先抽 helper 再接 host bridge。

## 16. CSS owner 与预算

目标唯一入口：

```text
apps/web/src/styles/features/media-jobs/
  index.css                 imports only, <= 8 lines
  shell.css                 host/header/filter/split/scroll, <= 150 lines
  list.css                  row/thumbnail/long text, <= 210 lines
  detail.css                inspector/result/repair/details, <= 240 lines
  create-dialog.css         feature form grid only, <= 180 lines
  artifact-preview.css      image/video geometry and fallback, <= 120 lines
```

- 新 CSS 颜色字面量、`!important`、`transition: all`、private keyframe、Theme/Profile ID selector 均为 0。
- Feature 只设置领域 grid、scroll、media geometry；不得命中 `.ling-ui-*` 内部。
- `media.css` 779 行、`media-create-dialog.css` 115 行、`media-job-detail.css` 91 行在同一切片删除。
- `components.css`、`strict-console.css` 中所有 `.media-job-*` 和 `.media-create-overlay` 视觉 selector 同步移除。
- `styles.css` 的三个旧 import 合并为一个 focused `features/media-jobs/index.css` import。
- `media.css` 开头无生产调用的 `provider-layout/provider-list-panel` 和冲突的 `provider-form-panel min-height`
  同步删除；Model Workbench focused CSS 已拥有真实 editor geometry。
- `.media-production-jobs-view > .media-jobs-page` 的 host height 规则迁入 `shell.css`，从
  `media-production.css` 删除，避免双 owner。

## 17. Theme、Desktop 与媒体像素

- `ling-light`、`ling-dark` 和已验证 imported Theme Pack 只通过 semantic tokens 改变 UI surface。
- `activeView="media"` 的 Presentation surface 是 `media-canvas`；所有 Profile 使用 domain surface，
  artwork/decoration 不能进入 Inspector 或媒体 frame。
- 对 hero `img/video` 断言 `filter:none`、`opacity:1`、`mix-blend-mode:normal`；image/video 内容区域
  不受 surface transparency 或 backdrop filter 影响。
- 同一 fixture image 在 Light/Dark/imported Theme 下的 element screenshot bytes 必须一致。
- Web Vite 截图只能关闭 Web Function ID。Electron main BrowserWindow 复用同一 Web feature，但 packaged
  macOS/Windows、Retina/DPI、forced-colors 证据仍属于 P13，不能由 Web 截图冒充。
- 不新增 Desktop-only Media Jobs CSS、Electron import 或平台业务分支。

## 18. i18n、键盘、ARIA 与 Motion

- visible copy、Tooltip、status、disabled reason、alt/ARIA 同时有 `zh-CN/en-US`；raw enum 不直接显示。
- Refresh、Copy、Open provider 等 icon-only action `>=32x32px`，共享 Tooltip + `aria-label`。
- SegmentedControl 用方向键切换；row Enter/Space 选择；Dialog focus trap/Esc/focus return 使用 shared owner。
- Details/InspectorSection 使用原生 summary keyboard；failure `role=alert`，refresh/loading 使用 `status`。
- 只对选中 job 的状态区使用 `aria-live=polite`，避免 100 行轮询同时播报。
- hover/selected 只用 `120ms` shared token；Dialog/disclosure 使用共享 transition。
- 不逐行 stagger，不对 media 做动画；reduced motion 停止 shimmer/位移，仅保留静态 loading 或短 opacity。
- focus 前后 Input/Select/Textarea 外框尺寸必须相同，native control 不产生第二层边框或高度溢出。

## 19. 必须验收的可达状态

### LIST

`no cwd`、first loading、empty、loaded、retained refreshing、initial failure、stale failure、filter no-result、
100 rows、long zh/en、source missing、queued、legacy waiting、approval waiting/missing、starting、running、failed、
cancelled、succeeded loading artifacts、completed、succeeded no media、unknown drift、selection removed、cwd race。

### CREATE

closed/open、fresh/reuse、image generate/edit/video、provider list empty、provider blocked/removed、prompt empty/max、
URL invalid、count/seed/duration invalid、advanced closed/open、submitting、server failure、success、Esc/outside/focus return、
busy dismiss blocked、long labels、1280 internal scroll。

### RESULT

no selection、result loading、one/multiple image、one/multiple video、mixed auxiliary artifacts、missing artifact、
preview unavailable、copy prompt/link success/failure、reuse provider present/missing/workflow、full prompt/raw details closed/open、
Open/Download、media pixel invariant。

### REPAIR

provider missing/disabled/operation unsupported/base URL/API key/transport/adapter、workflow missing/not-ready/connection error、
rate limit、timeout/network、invalid request、missing result、unknown failure、approval pending/missing、repair return + refresh + retry。

每组还需覆盖 default/hover/focus-visible/disabled/loading、Light/Dark/imported Theme、zh/en、keyboard、
reduced motion、console、overflow。N/A：destructive confirmation、job delete/archive、numeric progress、standalone cancel。

## 20. 完成定义

四个 canonical Function ID 只有在以下证据全部成立后才可从 `inventory` 晋级 `verified`：

1. 共享 primitives、controller/view-model/CSS owner 按合同落地；
2. old compatibility imports/selectors 在 Media Jobs 调用点归零；
3. focused + legacy + selected regression 全绿；
4. Light/Dark 双 viewport changed-state 截图与 metadata 完整且原尺寸目检；
5. imported Theme 媒体像素 invariant 通过；
6. browser console、root overflow、keyboard、focus、reduced motion 全通过；
7. Web verified 与 packaged Desktop pending 分开记账；
8. 没有 API/contracts/DB/route/state-machine diff，没有新增 >400 行 decision owner。
