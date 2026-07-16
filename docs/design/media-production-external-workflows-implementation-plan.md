# 媒体生产第三方工作流接入实施计划

状态：implemented（2026-07-15）

日期：2026-07-14

相关文档：[媒体生产第三方工作流接入](media-production-external-workflows.md)

## Slice 1: Execution Source And Durable Dispatcher

1. 定义 `MediaExecutionSource = provider | workflow`，现有数据回填为 provider。
2. 将媒体执行拆成 coordinator、provider source、workflow source、dispatcher 和 artifact collector，不继续扩大现有 713 行 executor。
3. 提交后返回 `202`，dispatcher 每次只轮询一次并持久化 `nextPollAt`。
4. 持久化 runtime attempt 和 lease 信息，daemon 重启后恢复同一任务。
5. 现有直接图片、Seedance 和 Media Job 路由继续使用 provider source。

## Slice 2: Contracts And Storage

1. 在 contracts/core 增加 Workflow Connection、Definition、Version、Input Field、Output Rule 和对应 response/request。
2. 新增三张工作流表，为 workspace、connection、definition、status 和 current version 建索引。
3. 扩展 project/scene 保存执行方式、工作流引用和场景参数。
4. 重建 `media_jobs` 以支持 provider 或 workflow 二选一，增加 workflow version 外键。
5. 扩展 scene run execution snapshot 和 execution handle 调度字段，迁移必须幂等。

## Slice 3: ComfyUI Adapter And API

1. 实现只允许已知 endpoint 的 ComfyUI HTTP client，包括 object info、upload、prompt、jobs/history、cancel 和 view。
2. 实现 API-format graph 解析、node/input 发现、节点存在性检查、digest 和受控映射。
3. 实现连接 CRUD/check、workflow import/version/check/test/activate/archive routes。
4. 密钥使用新的 `workflow_api_key` purpose 和现有 env/keychain resolver；不新增明文密钥表。
5. 用可控 fake ComfyUI server 测试新旧 API、恢复、取消、脱敏、SSRF 和产物限制。

## Slice 4: Media Production Web

1. 新增 `features/media-production/workflows`，独立 controller 管理连接、导入、检查、试运行和启用。
2. 项目浮动面板增加流程库入口和默认生产方式，不新增常驻侧栏。
3. 拆分 Scene Inspector 直接生成字段和工作流字段，受控 schema 生成表单。
4. 画布节点、项目确认和任务详情使用产品化流程名称，技术信息进 disclosure。
5. 切换模式保留直接 Provider 选择和 Workflow 参数，不丢用户配置。

## Slice 5: Verification

- Core/contracts：迁移、快照、版本不可变、引用删除阻断。
- Providers/daemon：ComfyUI 提交、轮询、取消、上传、下载、审批、重启恢复、并发和脱敏。
- Web：连接、导入 JSON、映射、试运行、启用、场景切换、项目混合生成。
- 回归：Seedance、独立 Media Job、模型工作台、审批和历史 Artifact。
- 命令：core/contracts/providers/daemon tests，Web typecheck、media Playwright、i18n 和 `git diff --check`。

## Hard Stops

- 不删除或降级现有直接视频生成；
- 不用 Provider Preset 或伪模型记录工作流；
- 不在浏览器直连 ComfyUI；
- 不提供任意 HTTP/Webhook adapter；
- 不把项目级剪辑、拼接或成片能力偷渡进单场景 V1；
- 任一生产源文件即将超过 800 行时先拆分再继续。

## Completion Evidence

- ComfyUI 作为可选 workflow source 接入，现有 Seedance/provider 直接生成路径保持可用，单项目支持两类场景混用。
- 2026-07-16 产品行为收口：场景运行、项目批量运行和 ComfyUI 试运行由用户在当前页面的明确生成动作直接授权，daemon 创建任务后立即启动，不再创建新的 `media_cost` 审批；既有审批和独立生成任务保持兼容。
- workflow execution handle 已持久化，daemon 重启后可恢复轮询；取消场景会停止本地调度并调用支持的远端取消能力。
- 验证通过：Core 287 项、daemon 510 项、API client 41 项、Web typecheck、i18n、媒体生产定向 Playwright 6 项，以及媒体生产/生成任务/模型工作台/审批中心组合回归 31 项。
- 2026-07-16 直接执行 follow-up 验证：daemon `approval-policy-run` 78/78、workflow 4/4、媒体生产 Playwright 8/8、生成任务与审批回归 7/7，Web/daemon typecheck 与 `git diff --check` 通过；1200px 实际页面下控制栏贴底且不与左右 dock、MiniMap 重叠。
- 真实页面验收通过：流程 overlay 可用 Esc 关闭，浏览器控制台 0 error / 0 warning；未在无明确授权的情况下提交付费 Seedance 生成。
