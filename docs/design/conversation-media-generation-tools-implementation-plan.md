# Conversation Media Generation Tools Implementation Plan

Status: active implementation plan
Date: 2026-08-11
Owning contract: [Conversation Media Generation Tools](conversation-media-generation-tools.md)

## Scope

把自然语言图片/视频生成接入 Ling 现有 RunSession、Runner Pi、MediaJob、WorkUnit、Artifact
和 Conversation Surface。按四个可独立验证的批次推进：Runner Tool、生成路由、后台投影、三会话接入。

设计合同必须先落地；实现不得在代码中发明与合同不同的选择顺序、持久化 owner 或错误语义。

## Baseline

- `@ling-stack/core` 已有 Provider generation resolver、MediaJob、MediaExecutionSource、WorkUnit
  与 artifact store。
- `@ling-stack/daemon` 已有 Provider/ComfyUI 后台执行、恢复、poll、取消和 artifact 收集。
- `@ling-stack/runner-pi` 已有第一方 ExtensionFactory 注册点和 daemon callback 模式。
- 普通对话、频道和队友私聊最终都进入 `executeRunRequest`。
- Conversation API 当前没有 MediaJob 投影；普通对话 WorkCell 的 artifact 映射也不包含 MediaJob artifact。
- Workspace settings 已以 JSON 保存，增加生成默认引用不需要数据库迁移。

## Module Boundaries

```text
packages/core
  media-generation-routing-types.ts
  media-generation-routing.ts
  workspace settings persistence
  conversation generated-media projection types

packages/contracts
  workspace settings DTOs
  conversation generated-media DTOs

packages/runner-pi
  extensions/media-generation.ts
  typed tool definitions, requests and callback results

packages/daemon
  features/media/conversation-targets.ts
  features/media/conversation-tool-handler.ts
  features/media/conversation-projection.ts
  orchestrator conditional injection
  conversation/channel/private API projection
  control-plane invalidation

apps/web
  shared ConversationGeneratedMediaBlock
  surface adapters only
  always-visible default-purpose controls in Model Workbench
```

Runner 不解析 Provider；Web 不解析目标 readiness；Media executor 不读取聊天消息；三个会话 adapter
不创建 MediaJob。

## Shared Types

新增并在 Core/Contracts 保持一致：

- `MediaGenerationKind = "image" | "video"`
- `MediaGenerationTargetRef`
- `WorkspaceMediaGenerationDefaults`
- `MediaGenerationTargetSummary`
- `MediaGenerationTargetResolution`
- `ConversationGeneratedMedia`

Runner Pi 增加：

- `PiRunnerMediaGenerationToolName`
- `PiRunnerMediaGenerationToolDefinition`
- `PiRunnerMediaGenerationRequest`
- `PiRunnerMediaGenerationResult`
- `onMediaGenerationToolCall`

`PiRunnerMediaGenerationResult` 只含产品安全字段；不直接复用完整 `MediaJob` 或 Provider Preset。

## Batch 1: Runner Tool

### Files

- `packages/runner-pi/src/types.ts`
- `packages/runner-pi/src/extensions/media-generation.ts`
- `packages/runner-pi/src/resource-loader.ts`
- `packages/runner-pi/src/index.ts`
- `packages/runner-pi/test/media-generation-extension.test.mjs`

### Changes

1. 注册 `image_generate`、`video_generate` typed tools。
2. schema 只接受 prompt、可选 target 和受控媒体参数。
3. 工具定义由 daemon 提供的可运行目标摘要构建，并逐目标列出 ratio、duration 和 count 能力；无目标时不注册。
4. execute 调用 `onMediaGenerationToolCall`，传入 `toolCallId`、`runId`、task、cwd、signal。
5. callback 缺失、参数无效或运行被取消时失败关闭。
6. 返回短文本供模型继续对话，完整任务状态由后台投影负责。
7. 会话 prompt 可以禁止工作区、MCP 和其他副作用，但不得把本批注入的两个第一方媒体工具一并
   禁用；频道首次回复与排队续跑都必须保留这个例外。

### Tests

- 有图片目标只注册图片工具；有视频目标只注册视频工具。
- 参数 schema、callback 参数和 cancellation 正确。
- 工具描述只声明目标真正支持的比例、时长与数量能力。
- callback 错误保持 `isError`，不泄漏 details。
- 没有 handler 时不注册工具。
- 频道 prompt 禁止其他工具时仍明确允许已注册的 `image_generate` / `video_generate`。

## Batch 2: Generation Routing

### Files

- `packages/core/src/media-generation-routing-types.ts`
- `packages/core/src/media-generation-routing.ts`
- `packages/core/src/workspace-types.ts`
- `packages/core/src/storage/sqlite/workspace-settings-store.ts`
- `packages/contracts/src/settings.ts`
- `packages/daemon/src/features/settings/effective-config.ts`
- `packages/daemon/src/features/media/conversation-targets.ts`
- `packages/daemon/src/features/media/conversation-tool-handler.ts`
- `packages/daemon/src/features/runs/orchestrator.ts`

### Changes

1. Workspace settings 增加 image/video 默认 TargetRef，并支持 null 清除。
   daemon 只接受存在、类型匹配且当前可运行的新默认；未改变的旧失效引用允许保留以支持逐项修复。
2. Core 纯函数实现固定 resolution ladder 和稳定错误 code。
3. daemon 从 Provider resolver、最近一次检查结果与 ready Workflow 构建安全 target inventory；Provider
   必须同时满足 runtime `canRun=true` 和最近检查通过。
4. Workflow target 在调用时从 Definition 锁定 current Version，并映射 prompt、ratio、duration 等语义字段。
5. 普通对话、频道和私聊的 RunRequest 都必须携带所属可见 Turn/消息的真实 `createdByActor`；
   `executeRunRequest` 只在 `local-user` 发起的用户可见会话 Run 中注入 target definitions 和 callback，
   非用户运行不注入。客户端不得传入 daemon-owned tool definitions 或 callback。
6. callback 以 `media_tool:${runId}:${toolCallId}` 查找或创建 child WorkUnit/MediaJob。
7. MediaJob 创建与幂等 owner 检查在同一 store transaction boundary 内完成；若现有 Store API
   无法原子表达，先新增 focused store method，不在 orchestrator 拼接竞态检查。
8. 成功创建后立即 dispatch 现有 executor，不等待完成。
9. Provider 与 Workflow executor 分别按 `cwd + mediaJobId` 合并同进程并发调用；并发 caller 共享同一
   promise，只有 owner 可执行 submit/poll/collect，promise settle 后再释放键。
10. 会话创建不自行添加或删除 `approvalGate`；MediaJob 已声明 `media_cost` 时继续由既有 executor 与
    approval route 执行等待和决策。本批不改变费用审批 enforcement。

### Workflow input mapping

- `prompt` 写入 prompt semantic field；
- `aspectRatio` 写入 ratio semantic field；
- `durationSeconds` 写入 duration semantic field；
- `count` 只写入明确支持批量图片输出的 Provider；Workflow 本轮不支持 count；
- 其他必填 field 必须已有 default；
- `negative_prompt`、seed 和 custom field 本轮不由聊天工具任意填写；
- 缺少必填输入时返回 `generation_input_invalid`，不创建任务。
- 用户提供的 ratio、duration 或 count 没有对应目标能力时同样返回 `generation_input_invalid`，不得忽略参数后继续生成。

### Tests

- 显式唯一目标、默认目标、唯一目标、多目标无默认四级选择顺序。
- 名称歧义、停用、能力不符和失效默认不回退。
- Provider 与 Workflow target readiness。
- 图片/视频默认互不覆盖。
- 同一 `runId + toolCallId` 只创建一个 MediaJob 和一个 child WorkUnit。
- 同一 MediaJob 的两个并发 dispatch 只产生一次 Provider/Workflow submit。
- Provider 已提交后重试仍绑定原 execution source。
- Observer/summary run 没有生成工具。

## Batch 3: Background Projection

### Files

- `packages/contracts/src/conversations.ts`
- `packages/daemon/src/features/media/executor.ts`
- `packages/daemon/src/features/media/provider-executor.ts`
- `packages/daemon/src/features/media/workflows/workflow-executor.ts`
- `packages/daemon/src/features/media/conversation-projection.ts`
- conversation/channel/private detail route builders
- `packages/daemon/src/features/control-plane/*`

### Changes

1. `startRuntimeWorkUnit` 支持 child media WorkUnit 的 `linkedRunId` 与 `linkedMessageId`。
2. Media executor 的 hook 发布 WorkUnit 状态和 artifact 失效事件，保持现有执行状态机。
3. `buildConversationGeneratedMediaProjection` 只从 child WorkUnit、MediaJob 和其 artifacts 组装 DTO。
4. 普通 conversation detail、channel conversation detail 与 teammate direct detail 返回同形投影。
5. target display snapshot 在 MediaJob/WorkUnit request 中持久化，后续重命名不改写历史展示。
6. API 重连时从数据库重建；SSE/Control Plane 只触发刷新，不成为权威状态。
7. 会话 DTO 只投影 child WorkUnit 的有限 `failureCode`；MediaJob 的 raw `errorMessage` 继续留在媒体任务
   诊断接口，不进入三类会话响应。
8. executor 接管预创建 child WorkUnit 后，成功、失败、取消都必须收口同一个 WorkUnit 与 attempt，
   不得创建第二个媒体 WorkUnit，也不得留下 running 终态漂移。
9. 启动恢复先把 pending MediaJob 对应的旧 active child attempt 标为 `lost`，再将同一 WorkUnit 从
   `stale` 重排到 `queued`。已有 Provider/Workflow execution handle 保留外部 operation 与 recovery 数据，
   但必须重新绑定新 attempt；没有 handle 的 queued task 重新执行首次派发。
10. 自动恢复只扫描 `queued/running` MediaJob，绝不使用 `retryTerminal`。显式 POST `/run` 是唯一可请求
    终态 MediaJob 重试的入口；只有没有外部 operation handle 时才允许重排并复用原 conversation child
    WorkUnit。带 handle 的终态任务只能收口原 operation，不能重新 submit；外部 operation handle 作为
    durable 幂等凭据保留，清除 poll 时间、WorkUnit 和 attempt 运行时绑定即可。仅尚未提交的本地占位
    handle 可以删除。既有 `POST /media-jobs/:id/run` 对这类任务返回 HTTP 200 与原失败快照以维持媒体生产
    API 兼容，但不得创建 attempt 或重新派发。
11. Provider 与 Workflow 定时 poll 必须显式处理 Promise rejection，不得产生进程级未处理拒绝。
12. Provider 图片可选参数从 Core 模型级已验证能力派生；Runner schema、daemon 校验和供应商请求共用
    同一份比例到尺寸映射。DALL-E 3 不暴露多图参数，无法证明的比例或张数保持隐藏。

### Tests

- queued/running/succeeded/failed/cancelled 投影。
- failureCode 产品化映射，原始 URL、secret、HTTP body 和 ComfyUI graph 不进入会话 DTO。
- artifact 只保留 `mediaJobId` owner，不重复为 Run artifact。
- executor 接管唯一 child WorkUnit，目标接受后失效时 MediaJob、WorkUnit 和 attempt 同步失败。
- 重命名/删除目标后历史投影仍使用快照。
- daemon 重启后 pending job 与会话投影都可恢复。
- daemon 在 child WorkUnit 启动但 execution handle 尚未写入时退出，重启后仍复用同一 WorkUnit；旧 attempt
  为 lost，新 attempt 继续执行。
- daemon 在 Provider/Workflow 已持久化可恢复 handle 后退出，重启后同一 WorkUnit 的新 attempt 继续 poll，
  不重复 submit；failed/cancelled 任务不会被启动恢复自动复活。
- 带外部 operation 的终态任务连续点击重试仍不得重新提交；handle 停止轮询但继续作为幂等凭据存在。
- DALL-E 3 不暴露 `count`，GPT Image 与 DALL-E 3 只暴露各自已验证比例，并把比例转换为模型对应尺寸。
- timer 触发的 Provider/Workflow poll 不产生 `unhandledRejection`。
- event 数据不含 prompt 以外的敏感配置、secret、URL、raw response 或 graph。

## Batch 4: Three Conversation Surfaces

### Files

- `apps/web/src/shared/conversation/ConversationGeneratedMediaBlock.tsx`
- shared conversation view-model helpers
- normal conversation adapter
- channel adapter
- teammate private adapter
- focused shared CSS and i18n
- Model Workbench default-purpose controls

### Changes

1. 新增一个共享媒体块，接受 `ConversationGeneratedMedia` DTO。
2. queued/running 使用固定尺寸占位；成功只使用现有 artifact preview/open/download，并与正文左边缘对齐，
   不重复显示成功标题、目标来源或 artifact 内部标题；失败持续显示产品化原因。
   queued/running 必须使用共享 `Spinner` 的真实无限旋转动画，不能依赖局部 `.spin` 类或静态 loading icon。
3. 三个 surface 只按 run/message id 附着同一组件，不实现各自 polling 或状态转换。
4. AppShell 现有 Control Plane 订阅使当前普通对话、频道消息页和队友私聊 query 同时失效，后台更新
   无需用户刷新；不为任一 surface 新增独立 SSE 或 polling。
5. 模型工作台在列表上方常显紧凑用途栏，不显示额外总标题；标签和下拉同一行，直接展示并编辑聊天模型、
   生图目标和生视频目标；图片/视频候选统一包含 Provider 与 active Workflow。自定义兼容入口批量导入的
   选项显示具体模型名，不重复入口名称。
6. generation Provider 的模型行主状态、摘要计数和“就绪”筛选复用默认目标的 checked runtime readiness；
   未通过最新检查的模型显示“需要检查”，不得仅凭密钥和 runtime 配置显示“就绪”。
6. 移除模型行默认星标的状态所有权，行内继续常显检查、编辑和更多；Workflow Library 继续管理
   Workflow 生命周期，但不再单独拥有默认选择入口。
7. 显式默认、自动唯一目标、使用时询问、未配置和失效需处理状态均由权威设置与 target inventory
   推导，不使用前端猜测；失效记录仍存在时展示名称，悬空引用只显示“原默认目标不可用”。
8. 多目标无默认时由工具结果驱动模型询问，不在 Composer 增加永久模型选择器。
9. 父 Run 成功且已存在 `ConversationGeneratedMedia` 时，空 assistant 正文保持成功并只渲染媒体块；
   没有正文也没有媒体投影时才进入既有 `empty_response` 失败。该判定来自共享 daemon 投影 helper，
   不允许三个 surface 各自猜测工具是否执行。
10. 普通频道 `channel_ai_reply` 无论是否产生工具事件，都不属于 Terminal Report 发布对象。实时调度、
    直接处理、启动恢复、报告 API 和频道 timeline 使用同一个资格 helper；升级前已持久化并发布的错误
    Terminal Report 只从公开投影隐藏，底层记录不删除。
11. Provider 返回 HTTP 成功但没有可用图片/视频数据时，adapter 使用稳定
    `media_result_unavailable`，会话投影映射为 `generation_result_unavailable`。兼容旧任务时也根据已脱敏
    的旧错误类别识别空结果，不能继续映射成“目标需要完成配置”。

### Tests

- 三个 surface 对同一 DTO 生成相同 DOM 状态和文案。
- 普通对话、频道首次回复、频道排队续跑和队友私聊都覆盖 tool-only 成功：正文为空、消息成功、
  媒体块可见；无工具的真正空响应仍失败。
- 生成中更新为 artifact 时不插入伪造消息、不改变滚动身份。
- 图片、视频预览、左对齐、打开、下载和错误态；成功态无重复标题、来源或 artifact caption；
  打开和下载默认隐藏在媒体右上角，hover/focus 显示且不增加预览下方高度。
- 上游内容策略拒绝映射为 `generation_content_policy_blocked`，不得误报为配置错误或泄漏 raw body。
- 上游成功响应但缺少目标媒体数据映射为 `generation_result_unavailable`，显示准确的脱敏修复提示；
  raw response、request id、密钥和 Provider URL 仍只留在受控诊断面。
- queued/running 的共享 Spinner 具有 `ling-ui-spinner-rotate` 无限动画，不只断言图标存在。
- 构造升级前已经 committed/published 的普通 `channel_ai_reply` Terminal Report：SQLite 记录继续存在，
  但频道 items、频道 reports collection 和单条 report API 均不可见；合法 workflow report 仍可见。
- 多任务顺序、长 prompt、Light/Dark、键盘 focus。
- 默认用途栏与 workspace settings 一致，且 Provider/Workflow 来源可辨识。

## API And Compatibility

- Workspace settings 更新保持 additive；旧 JSON 缺字段时视为没有媒体默认。
- Conversation detail 只增加字段，旧客户端可忽略。
- MediaJob schema 不变；Tool-created job 使用现有 execution source 字段。
- WorkUnit 表已有关联列，不新增数据库 migration。
- API client 从 Contracts 获取新增类型，不复制 DTO。
- 旧媒体任务、媒体生产项目、场景和工作流不迁移、不删除、不重写。

## Validation Order

1. `corepack pnpm --filter @ling-stack/contracts test`
2. `corepack pnpm --filter @ling-stack/core test`
3. `corepack pnpm --filter @ling-stack/runner-pi test`
4. `corepack pnpm --filter @ling-stack/daemon test`
5. `corepack pnpm --filter @ling-stack/api-client test`
6. `corepack pnpm --filter @ling-stack/web typecheck`
7. `corepack pnpm --filter @ling-stack/web lint`
8. `corepack pnpm --filter @ling-stack/web run check:i18n`
9. focused conversation/media/model-workbench Playwright
10. `corepack pnpm check:docs`
11. `git diff --check`

## Browser Acceptance

- 使用当前 dev source 启动 daemon 与 Web，记录真实 URL。
- 中文 Light `1440x960`：普通对话生成图片、频道生成图片、私聊生成图片。
- Dark `1280x800`：视频生成中、失败、成功预览状态。
- 多个目标且无默认时验证模型询问；设置默认后验证无需选择。
- 明确说出目标名称时验证单次覆盖，随后普通请求仍使用默认。
- 默认用途栏验证“自动选择（目标名）”“使用时询问”“未配置”和“需处理”。
- 同一个未检查 generation Provider 在模型行、摘要、就绪筛选和默认目标中保持一致；检查通过后四处同步
  变为可用。
- 刷新页面与重启 daemon 后验证投影恢复。
- 检查滚动、横向溢出、焦点、console 和 `pageerror`。

## Acceptance Criteria

- 设计合同与实现一致，五份相邻权威文档已同步。
- 两个工具只在真实可运行目标存在且 Run 来源允许时注册。
- 目标选择从不依赖创建顺序。
- 所有 MediaJob 都经过现有 resolver/executor 和恢复路径。
- 工具重放不能重复创建付费任务。
- 三个会话显示同一 shared media block。
- 工具调用成功后模型不补正文时，四条回复终结路径都不得制造空响应错误或收件回执。
- 普通频道回复在实时执行和 daemon 启动恢复后都不得追加第二条“任务已完成”报告；历史错误报告不删库、
  不投影。
- 生成中 Spinner 实际旋转；上游空结果使用准确脱敏原因，不误报目标未配置。
- 刷新和重启后状态不丢失。
- 没有新表、没有 artifact 双写、没有 secret/raw response 泄漏。

## Hard Stops

- 若需要新增关键词意图路由、第二套媒体队列或会话专用 MediaJob 表，停止。
- 若原子幂等创建需要改变 MediaJob schema，先重新审查；不得用前端去重代替。
- 若需要绕过 Provider resolver、Workflow readiness、审批 enforcement 或网络策略，停止。
- 若三个会话必须分别实现状态机，停止并补共享投影边界。
- 若测试只能通过删除、跳过或弱化现有 MediaJob/Run/approval 断言，停止。
- 不 commit、不 push，除非用户之后明确要求。
