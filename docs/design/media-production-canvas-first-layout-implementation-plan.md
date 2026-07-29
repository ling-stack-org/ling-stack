# 媒体生产画布优先布局实施计划

状态：implemented（2026-07-15）

设计合同：[媒体生产画布优先布局](media-production-canvas-first-layout.md)

## Summary

在不改任何生成运行语义的前提下，将生产台从固定三栏改造成全尺寸画布、浮动左右 dock 与轻量顶栏。实施仅触及 Web feature、样式和 E2E；现有 controller、daemon API、SQLite、视频 preview 和 scene run 保持兼容。

## Slice 1: Canvas Shell

1. 新增 `MediaProductionCanvasToolbar.tsx`，承接项目摘要、`生产台/生成任务` 切换和批量生成；移除 `MediaProductionWorkspace` 中 H1、说明、刷新与顶部新建项目按钮。
2. 新增 `MediaProductionDockRail.tsx`，提供左“项目与分镜”和右“场景检查器”图标轨，所有按钮固定 40-44px hit area 并带 tooltip/aria label。
3. `MediaProductionWorkspace` 只持有 `view`、`leftDockOpen`、`rightDockOpen`；场景选择打开右 dock，新建场景后的 controller 选中状态也打开右 dock。
4. dock 打开状态可在 `localStorage` 中存储为纯 UI 偏好；无读取能力或历史值时默认左 dock 打开、右 dock 在选中场景后打开。

## Slice 2: Floating Docks

1. `ProjectSceneOutline` 接收关闭回调；新增项目按钮移入项目头部，项目设置继续 disclosure，场景列表与排序行为不变。
2. `SceneInspector` 接收关闭回调；只在存在被选场景时装配，关闭后保留在 DOM 中完成退出过渡，原来的空检查器不再占位。
3. CSS 将两者改成画布容器内 absolute overlay：left 288px、right 360px；加轻阴影、1px 边框、8px 圆角和 180-220ms 横移淡入淡出。展开不会改变 `.storyboard-canvas` 或 React Flow viewport 的尺寸。
4. 关闭顺序统一：modal -> right dock -> left dock；沿用现有 dialog 的 Esc 行为，不在 dock 内重复 document listener。

## Slice 3: Canvas Density

1. 移除 canvas panel 的永久 header 与分栏 border；背景降低对比度，canvas 成为工作台基底。
2. `StoryboardCanvas` 的 `fitViewOptions` 加 `maxZoom: 1`；节点调整为紧凑分镜卡，保留编号、标题、摘要、比例、时长、状态和真实结果缩略图。
3. Controls 在存在场景时显示；MiniMap 与布局提示在至少两个场景时显示。
4. 左下添加“适配视图”工具入口；不改变节点位置保存、`sortOrder` 或拖拽行为；两个及以上场景恢复显示缩略地图。

## Slice 4: Tests And Visual QA

1. 更新 `media-production.spec.ts`：标题不存在、项目新增入口位于左 dock、左右 dock 开关、选中场景自动开检查器、Esc 关闭、两场景 controls、五场景 minimap、批量确认与视频详情回归。
2. 回归 `media-jobs.spec.ts` 和 `model-workbench.spec.ts`，确认任务页和 Seedance 设置流程不受影响。
3. 运行：
   - `corepack pnpm --filter @ling-stack/web typecheck`
   - `corepack pnpm --filter @ling-stack/web run check:i18n`
   - `corepack pnpm --filter @ling-stack/web exec playwright test e2e/media-production.spec.ts e2e/media-jobs.spec.ts e2e/model-workbench.spec.ts`
   - `git diff --check`
4. 真实 Vite 页面验收 1440x1000、1280x800：空项目、两场景、展开左 dock、选中右检查器、视频任务详情。仅查看现有成功视频，不重新提交付费生成。

## Hard Stops

- 不改 `use-media-production-controller` 的 API 调用、Media Project/Scene/Run 数据契约或 `sortOrder` 语义；
- 不因布局需要新增 daemon route、SQLite migration 或 local secret；
- 不把 inspector 的场景表单塞回 React Flow node；
- 不在没有可运行模型时展示可用生成动作；
- 不将 dock 偏好作为服务端用户数据；
- 不加入时间线、剪辑、转场、字幕、配音、FFmpeg 或第三方媒体服务。

## Assumptions

- 桌面 Web 是唯一验收范围；
- 左 dock 初次进入默认打开，右 dock 初次进入只在有选中场景时打开；用户关闭后的状态在当前浏览器工作区记忆；
- “悬浮”表示覆盖画布，不表示随意可拖动；本轮不实现可拖拽/可调整宽度 dock；
- 项目/场景抽屉仍沿用当前中文文案和既有视觉 token。

## Completion Evidence

- 生产台已改为全尺寸 React Flow 画布，项目与分镜、场景检查器均为画布内浮动 dock，展开不改变画布容器尺寸。
- 顶部保留项目摘要、生产台/生成任务切换和按顺序生成；新建项目入口位于左 dock，页面级标题和刷新动作已移除。
- 1440x1000 与 1280x800 实际页面已验证左右 dock 展开/收起、流程 overlay Esc 关闭和画布可见性。
- 截图证据：`output/playwright/media-production-live-1440x1000-canvas.png`、`output/playwright/media-production-live-1280x800-panels.png`、`output/playwright/media-production-workflows-live-1440x1000.png`。
- Web/daemon 相关测试与 `git diff --check` 通过；本轮没有提交真实付费视频生成。

## Canvas Navigation Follow-up

- `StoryboardCanvas` 保存 React Flow instance，以可重复的 `sceneId + sequence` 请求聚焦左侧选中的场景，并保留当前缩放比例。
- 媒体项目切换重新挂载画布并执行 `fitView`；创建、复制和普通选择都会把目标场景带回可见区域。
- Controls 移到画布底部中央并在单场景时可用；MiniMap 使用半透明遮罩、选中态描边，并在右 dock 展开时避让。
- E2E 必须验证实际 viewport transform、节点可见区域、控件与 dock 矩形不相交以及 MiniMap 节点颜色，而不再只断言元素存在。

### Follow-up Completion Evidence

- `media-production.spec.ts` 覆盖平移到空白区域后选择和重复选择场景、创建/复制场景聚焦、远距离项目切换、单场景缩放、`Fit View` 最大缩放、MiniMap 节点可见性以及 dock/控件不重叠。
- `corepack pnpm --filter @ling-stack/web exec playwright test e2e/media-production.spec.ts`：7 passed。
- `corepack pnpm --filter @ling-stack/web exec playwright test e2e/media-production.spec.ts e2e/media-jobs.spec.ts e2e/model-workbench.spec.ts`：26 passed。
- Web typecheck、i18n 检查和 `git diff --check` 通过；真实页面控制台无 warning/error。
- 真实浏览器截图：`output/playwright/media-production-canvas-1440x1000-light.png`、`output/playwright/media-production-canvas-1280x800-light.png`、`output/playwright/media-production-canvas-1280x800-dark.png`。
- “按顺序生成”确认弹窗补做视觉收口：正文与标题统一左边界、场景改为单一紧凑列表、footer 恢复稳定内边距，并增加布局回归断言；前后与暗色截图为 `output/playwright/media-production-run-dialog-before.png`、`output/playwright/media-production-run-dialog-after.png`、`output/playwright/media-production-run-dialog-after-dark-1280x800.png`。

## Scene Result Lifecycle Follow-up

- Provider 与 ComfyUI 的首次成功 Scene Run 自动设为当前结果；后续成功、失败和取消保留原选择。
- `SceneReadiness` 同时携带当前 run/job/artifact、最新 run/job、重新生成标记和最近问题，卡片不会在重新生成时退回“可生成”。
- 场景检查器在已有结果时使用“重新生成”，并在最近一次重试失败时保留播放器和中文错误提示。
- 画布节点增加固定预览按钮；点击后弹窗复用真实 artifact 播放器，视频静音 autoplay 并保留 controls，且不改变节点选择。
- 生成任务状态或 artifact 签名变化时，工作区静默刷新当前项目，及时读取 daemon 自动写入的首次结果选择。
- 原布局阶段“不改运行语义”的 Hard Stop 只约束当时的布局切片；本 follow-up 由独立批准的结果生命周期计划授权，仍未新增 HTTP route 或 SQLite schema。
