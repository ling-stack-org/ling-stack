# 模型工作台视频生产台实施计划

状态：implementation plan

日期：2026-07-13

范围：模型工作台驱动的视频生产项目、分镜画布、场景运行、异步视频恢复与 Web 回归

相关文档：[模型工作台视频生产台](model-workbench-video-production-studio.md)

## Slice 1: Contracts, Storage, And Provider Capability

1. 在 contracts/core 增加 `MediaProject`、`MediaScene`、`MediaSceneRun`、`MediaJobExecutionHandle` 和对应创建/更新输入类型；`MediaOperation` 维持 `video_generate`。
2. 定义 `VideoGenerationCapabilities` 和 `VideoGenerationInputMode`，把模型输入能力放在已有 generation runtime metadata 解析结果中。
3. 扩展 SQLite migration：新增 `media_projects`、`media_scenes`、`media_scene_runs`、`media_job_execution_handles`，并为 workspace、project、scene、media job 和非终态 handle 建索引。
4. 保持旧 `media_jobs` 与 artifact 行不变；项目删除与场景删除不级联删除它们。
5. Seedance 初始返回 `inputModes: ["text"]`。没有 Adapter 映射和 live artifact 证据时，任何其他模型不得返回 `image_reference`。

## Slice 2: Async Media Execution

1. 将 Provider Media Adapter 拆为 submit/poll/cancel/collect 的可恢复生命周期；快速图片 Adapter 可以在 `submit` 中直接返回最终 artifact。
2. Seedance 提交后立即持久化外部任务句柄，后台轮询直到终态；成功后下载视频 artifact，失败后写入脱敏错误。
3. 增加 media dispatcher：恢复 pending handle、遵守 Provider semaphore、更新 runtime event 和 Media Job 状态。
4. 独立 Media Job 与 Scene Run 共享此 dispatcher；HTTP run 请求返回已提交/运行状态，不等待长视频完成。
5. 取消 API 优先调用 Adapter；不支持远端取消时停止本地后续调度并说明状态，不伪造远端取消成功。

## Slice 3: Project And Scene API

1. 新增 daemon/API-client 路由：项目 list/create/update/delete，场景 create/update/delete/reorder，场景素材绑定，场景运行 list/select，单场景运行、项目按顺序运行和取消。
2. `MediaScene` 保存 `sortOrder`、节点位置、标题、提示词、模型覆盖、比例、时长、引用 artifact id 和当前选用 Scene Run id；position 仅用于画布。
3. 运行时创建标准 Media Job 和 Scene Run，持久化 Provider/输入快照；每次运行都是新 Scene Run，不覆盖历史。
4. 输入验证拒绝跨 workspace artifact、非图片 artifact、未支持图片参考的模型、空提示词、无效比例/时长、重复排序值和不属于当前项目的 Scene Run。

## Slice 4: Media Production Web

1. 新增 `features/media-production`，将页面壳、domain controller、API client、types、canvas、inspector、asset panel、run history 分离；任一生产源文件不超过 800 行。
2. 引入 `@xyflow/react` 实现分镜画布。场景和素材节点为受控节点，位置写入 Scene，顺序连线由 `sortOrder` 推导。
3. 将媒体顶部入口改为“媒体生产”，增加“生产台 / 生成任务”页内 tabs；既有 `MediaJobsPage` 只作为生成任务视图继续复用。
4. 场景检查器使用现有 SelectControl、ArtifactRow 和确认 dialog 视觉模式；参考素材只从当前 workspace 的图片 artifact 列表选择。
5. 默认创建空项目并引导添加第一场景；项目存在时画布占主要视觉区，右侧检查器按选择状态出现，任务/素材各自内部滚动。
6. 仅在 resolver 返回 `image_reference` 时渲染参考素材选择和输入连接；初始 Seedance 场景始终只展示文本生成字段。

## Tests And Verification

- Core：capability resolver、文本/参考图能力、scene validation、排序稳定性、migration 幂等性、旧 Media Job 兼容性。
- Providers/daemon：Seedance submit/poll/download、handle 恢复、取消、错误脱敏、dispatcher 并发、项目和场景 API、跨 workspace 素材阻断。
- Web：媒体生产项目创建、场景增删复制、节点拖拽、排序不随拖拽变化、文本模型不显示参考图、项目/场景运行、任务结果回流、历史选择、中文 i18n。
- 浏览器：1440x1000 与 1280x800，生产台与生成任务都无整页滚动；画布、素材、任务列表分别内部滚动。
- 回归：`core`、`daemon`、`web` tests/typecheck，`media-jobs.spec.ts`、新增 `media-production.spec.ts`、Model Workbench E2E、`check:i18n`、`git diff --check`。

## Slice 5: Scene Result Lifecycle Follow-up

状态：implemented（2026-07-15）

1. Core Store 增加按 Media Job 查询 Scene Run 的内部方法，复用 `idx_media_scene_runs_media_job`，不新增 route、表或字段。
2. Provider 与 ComfyUI 执行器在 artifact 保存且 Media Job 成功后调用统一 helper：只有场景没有当前结果时才自动采用首次成功 Scene Run。
3. Web 的 `SceneReadiness` 将当前结果与最新运行并行建模：重新生成中、失败或取消不会覆盖旧结果；已有结果的单场景按钮显示“重新生成”。
4. 项目批量运行只提交 `ready` 场景，已有结果以“已生成”原因明确跳过；不增加批量重新生成。
5. 画布节点增加同级预览按钮，`StoryboardCanvas` 只发出 `onPreviewResult(sceneId)`；`MediaProductionWorkspace` 管理弹窗与静默项目刷新。
6. `SceneResultPreviewDialog` 复用 `MediaArtifactPreview`，视频有 controls、无 autoplay，并统一支持 Esc、遮罩与关闭按钮。
7. 测试覆盖首次 Provider/ComfyUI 自动采用、后续成功和取消不覆盖、重新生成状态、失败保留、批量跳过、预览不触发生成和手动切换当前结果。

## Hard Stops

- 不接 ComfyUI、fal、Replicate、Webhook、外部工作流或第三方编辑服务。
- 不实现时间线、FFmpeg、拼接、字幕、配音和“最终成片”。
- 不让手工 capability 覆盖绕过真实 Adapter。
- 不删除或重写既有独立 Media Job/Artifact 历史。
- 如果异步恢复必须泄露 Provider 密钥、Authorization 或未脱敏响应，停止该切片并重新设计。
