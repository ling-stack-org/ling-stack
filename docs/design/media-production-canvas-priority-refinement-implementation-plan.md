# 媒体生产画布优先体验优化实施计划

状态：implemented（2026-07-17）

日期：2026-07-17

设计合同：[媒体生产画布优先体验优化](media-production-canvas-priority-refinement.md)

## Summary

在保持全尺寸画布和覆盖式左右 Dock 的前提下，修正默认双 Dock、viewport 不随 Dock 更新、MiniMap 过早出现、零场景生成主动作、检查器信息过载、任务无法辨认和流程空态重复的问题。仅修改 Web UI、内部 view-model、CSS 和 E2E。

## Slice 1: Dock And Canvas

1. `MediaProductionWorkspace` 删除“读取 selected scene 后自动打开右 Dock”的 effect；显式选择和创建场景仍打开检查器。
2. 新增 stage 宽度测量和 Dock 互斥 helper；安全宽度低于 640px 时只允许一侧展开。
3. `StoryboardCanvas` 在 Dock、容器尺寸和场景边界变化时重新适配安全区；聚焦请求继续保留选择语义。
4. MiniMap 默认阈值调整为五场景，并根据安全宽度自动隐藏。
5. 更新 canvas-first CSS，Controls/MiniMap 只按实际可见状态避让，不改变画布容器尺寸。

## Slice 2: Commands And Inspector

1. `MediaProductionCanvasToolbar` 接收 ready count，根据状态显示“生成 N 个场景”“检查场景”或“配置视频模型”。
2. “检查场景”复用现有 review dialog；零可运行场景不展示付费主动作。
3. `SceneInspector` 增加 `settings/result/history` 本地视图；footer 生成动作保持固定。
4. 新增纯函数将底层错误映射为中文原因与建议，原始错误进入折叠技术信息。
5. 保持场景更新、运行、取消和结果选择调用不变。

## Slice 3: Lists And Workflow Empty State

1. `ProjectSceneOutline` 使用紧凑状态摘要，长说明进入 title。
2. `MediaProductionWorkspace` 根据当前项目、场景和 Scene Run 生成 job display context，并通过 render prop 传给嵌入的 `MediaJobsPage`。
3. `MediaJobList` 优先显示项目/场景身份；无上下文时显示 prompt 摘要。
4. `WorkflowLibraryWorkspace` 在真正空状态下渲染单列 onboarding，删除重复导入入口和空详情栏。

## Slice 4: CSS And Tests

1. 新增 `media-production-priority-refinement.css` 承接本轮覆盖规则，避免继续扩大已有 705/630/550 行样式文件。
2. 更新 `styles.css` import，并只在旧 CSS 中删除明确失效的规则。
3. 更新媒体生产 E2E，覆盖 Dock 默认、互斥、画布尺寸、MiniMap 阈值、零可运行场景、检查器 views、任务身份和流程空态。
4. 运行 Web typecheck、i18n、媒体相关 Playwright 和 `git diff --check`。
5. 真实 Vite 页面验收 1440x1000、1280x800；不触发真实付费生成。

## Public Interfaces

不修改 public API、daemon route、SQLite schema 或 core contract。允许新增前端内部类型：

- `MediaProductionJobContext`
- `SceneInspectorView`
- `CanvasSafeArea`

`MediaProductionPageProps.jobsPanel` 可从 `ReactNode` 调整为接收 job context 的 render function；该接口仅在 Web 内部使用。

## Hard Stops

- 不把左右 Dock 改回固定布局列；
- 不改变 React Flow 画布 DOM 尺寸来给 Dock 腾位置；
- 不新增 Media Job 项目/场景字段或 daemon 查询接口；
- 不改变模型、adapter、场景运行、取消、重试和结果选择语义；
- 不新增批量重新生成；
- 不执行真实付费媒体生成；
- 若任务身份必须修改后端数据契约，停止并保留 prompt 摘要 fallback。

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web run check:i18n`
- `corepack pnpm --filter @ling-stack/web exec playwright test e2e/media-production.spec.ts e2e/media-jobs.spec.ts e2e/model-workbench.spec.ts`
- `git diff --check`

浏览器验收：

- 左右 Dock 开关前后 `.storyboard-canvas` 宽高一致；
- 1280x800 下左右 Dock 互斥，节点不被覆盖；
- 1440x1000 下安全空间足够时可同时打开两侧；
- 两场景无 MiniMap，五场景有 MiniMap；
- 零可运行场景只显示“检查场景”；
- 检查器三视图、错误产品化、任务身份和流程空态符合设计合同；
- 页面无横向溢出，控制台无 error/warning。

## Assumptions

- 桌面 Web 是唯一验收范围；
- 左 Dock 偏好继续存 localStorage，右 Dock 不持久化；
- 当前项目任务可完整显示项目和场景身份，其他未加载项目任务使用提示摘要；
- Inspector 页内视图不使用 localStorage，切换场景时回到设置；
- 原始诊断只在用户主动展开时显示。

## Completion Evidence

- 左右 Dock 保持画布内 absolute overlay，E2E 验证开关前后画布 `clientWidth/clientHeight` 不变；安全宽度不足时两侧互斥。
- 进入已有项目时右检查器保持关闭，显式选择场景后打开；聚焦会将当前场景与相邻场景一起适配到未被 Dock 覆盖的安全区。
- 2 至 4 个普通场景不显示 MiniMap，5 个场景或明显超出安全区时显示；Controls 与 Dock、MiniMap 不重叠。
- 工具栏按状态显示“生成 N 个场景”“检查场景”或“配置视频模型”，零可运行场景的检查弹窗不再出现“生成 0 个场景”。
- 场景检查器已拆为设置、结果和历史；供应商错误复用生成任务的中文恢复文案，raw error 默认折叠。
- 当前项目任务显示“项目名 · 场景名”，独立任务使用提示摘要；未修改 Media Job 数据契约。
- 生产流程零数据空态收为单一导入动作和 720x460 紧凑弹窗；已有流程和导入草稿继续使用完整双栏工作区。
- 验证通过：Web typecheck、i18n、媒体生产定向 Playwright 8/8、媒体生产/生成任务/模型工作台组合回归 27/27、`git diff --check`。
- 真实浏览器验收：1280x800 与 1440x1000 中文白天模式；干净浏览器控制台 0 error、0 warning，未提交真实付费生成。
- 截图目录：`output/playwright/media-priority-refinement-20260717/`。
