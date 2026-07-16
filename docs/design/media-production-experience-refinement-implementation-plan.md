# 媒体生产体验收口实施计划

状态：implementation plan

日期：2026-07-14

设计合同：[媒体生产体验收口](media-production-experience-refinement.md)

## Summary

在不引入剪辑能力或外部服务的前提下，把已真实可用的视频生产流程收口为可规划、可确认、可回看的创作工作台。实现分为两条边界清晰的链路：

1. 生产台前端的信息架构、场景准备度、顺序控制与视频结果展示；
2. 批量运行的请求契约与后端原子验证，保证不会产生“前面几个场景已提交、后一个失败”的半提交状态。

## Slice 1: View Models And API Contract

1. 新增 `media-production-view-models.ts`，输出：
   - `SceneReadiness`、`SceneRunSummary`、`ProjectRunReview`；
   - 依据场景、项目默认模型、Provider runtime、任务和 artifacts 派生待完善/可生成/生成中/需处理/已选结果；
   - 按 `sortOrder` 输出可提交和跳过场景，以及用户可见的中文原因。
2. 扩展 `RunMediaProjectRequest` 为可选 `sceneIds`，并扩展 project run response 的语义，但不修改既有 Media Job、Artifact、Scene Run 存储模型。
3. daemon 的项目批量运行先解析和去重 `sceneIds`、按项目 `sortOrder` 排序、对全部目标场景完成无副作用验证，再创建任一 Media Job/Scene Run。
4. 不传 `sceneIds` 的兼容调用继续代表项目全部场景，但也必须先全量预检并在失败时零创建；新 UI 永远传确认后的可运行 scene id。
5. 保留单场景运行行为和真实 Adapter 校验；不让前端 readiness 替代 server-side 权限、Provider、比例、时长和素材验证。

## Slice 2: Production Studio Shell

1. 从 `MediaProductionWorkspace.tsx` 抽出：
   - `ProjectSceneOutline.tsx`：项目选择、唯一的项目名称入口、默认模型、场景序列、上/下移、添加场景；
   - `ProjectRunReviewDialog.tsx`：批量生成确认与跳过原因；
   - `media-production-view-models.ts`：纯派生，不访问 API。
2. 工作台改为 `outline | canvas | inspector` 三栏；CSS 使用固定列和容器内滚动。小于可用宽度时优先缩小画布，不压缩操作按钮或检查器字段。
3. 删除工具栏内重复“项目名称”字段；项目选择器、名称编辑和默认模型只在项目栏出现。名称编辑和默认模型收在低频“项目设置” disclosure，关闭时显示当前默认模型摘要。
4. `StoryboardCanvas` 接收显式的 readiness summary，节点展示实际状态和当前结果，而不是模糊的 history 图标；移动节点保持不影响顺序。
5. 新建项目只创建空项目；空项目唯一主动作是添加场景。添加场景后自动选中并将焦点放到场景名称或提示词。
6. 保存成功改接全局 2 秒 toast，避免局部 absolute notice 遮住画布 header；场景数大于等于 2 时再显示画布缩放控件，大于等于 5 时显示缩略地图。

## Slice 3: Inspector And Result Media

1. 新增共享 `MediaArtifactPreview.tsx`：
   - image 使用安全的 `<img>`；
   - video 使用 `<video controls preload="metadata" playsInline>`；
   - 保留新窗口打开、下载和加载失败回退；不自动播放、不带 Provider header；
   - 只接收 artifact id/content URL，不接收密钥或 provider payload。
2. `SceneInspector` 拆出 `SceneRunHistory.tsx` 或保持组件不超过 800 行；新增当前结果预览，历史记录收紧为可选择/取消的行。
3. 每个字段保存有自己的 `busyAction`；对标题/提示词的成功保存使用局部两秒提示，错误保持在工作台顶部。
4. 删除场景前接入现有确认 dialog 模式；复制、上移、下移保留键盘可用的 label/title。

## Slice 4: Generation Tasks

1. `MediaJobsPage` 增加 `embedded` 显示模式。媒体生产内使用紧凑任务工具栏，独立页面仍保留现有 PageActionHeader。
2. 列表和详情共同复用 `MediaArtifactPreview`，让视频显示实际预览。详情的结果放到首屏，技术字段只在折叠 disclosure 中。
3. 创建任务对话框按 operation 调整：视频的比例/时长提升到主表单，水印折叠；基于 resolver 提供的真实能力渲染选项。没有能力元数据时采用既有安全默认选项。
4. 将默认层的英文状态/低价值 metadata 收敛为中文产品文案；保留模型和供应商专有名。

## CSS And i18n

- 在 `media-production.css` 中新增 production studio / outline / run review 的专用类，继续使用现有 token；
- 在 `media.css` 为 `embedded` 工具栏和 video preview 追加局部样式，避免全局覆盖独立任务页；
- 新增中文/英文词条；`check:i18n` 必须通过；
- 不使用硬编码 Provider error、raw job id 或 API key 作为默认可见文案。

## Tests

### Core / daemon

- `sceneIds` 为空、重复、跨项目、未知时被正确验证；
- 全量项目运行中任意场景无模型/提示词时，不创建任何 Job 或 Scene Run；
- 确认传入的可运行场景按 `sortOrder` 提交；旧不带 `sceneIds` 的调用保持兼容且不发生半提交；
- 单场景运行、取消、选择当前结果和已有 Media Job/Artifact 回归。

### Web / E2E

- 生产台出现项目栏、场景序列、画布、检查器；项目名称只有一个编辑入口；
- 上移/下移改变 `sortOrder`，画布拖动不改变顺序；
- 批量生成先显示 review，只有 ready 场景提交；无 ready 场景不能确认；
- 成功视频使用 `<video>`，列表有真实媒体预览，详情可打开和下载；
- 嵌入“生成任务”没有第二个页面级标题，不丢创建、刷新、筛选、重试和详情操作；
- 失败、空模型、空提示词、运行中、完成、删除确认和视频加载失败有稳定可见状态。

### Commands And Visual QA

- `corepack pnpm --filter @ling-stack/core test`
- `corepack pnpm --filter @ling-stack/daemon test`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web run check:i18n`
- `corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/media-production.spec.ts apps/web/e2e/media-jobs.spec.ts apps/web/e2e/model-workbench.spec.ts`
- `git diff --check`
- 真实浏览器：1440x1000、1280x800 的生产台空态、三场景项目、生成前 review、生成中、成功视频和生成任务页。

## Hard Stops

- 任何实现若需要把 API Key、Authorization Header、Provider raw response 或外部 task handle 传到浏览器，停止；
- 若批量确认无法在 server 端保证“全部验证后再创建”，停止并重新设计，不能仅靠前端过滤；
- 若视频预览需要从外部 URL 直接加载并绕过 Ling artifact 路由，停止；
- 若新增时间线、剪辑、拼接、字幕、配音或外部工作流，停止；
- 若重构要改写或删除独立 Media Job/Artifact 历史，停止。

## Assumptions

- 桌面 Web 是本轮唯一验收范围；
- 当前模型工作台已配置且通过真实生成的 Seedance 视频模型，是生产台的主要验证对象；
- 用户确认“按顺序生成”代表提交多个独立场景任务，不表示合成一个最终视频；
- 供应商当前没有可展示的可靠成本估算，因此确认层只说明提交数量和模型，不伪造价格；
- 当前工作树的其他未提交改动属于并行工作，本轮只合并媒体相关文件。
