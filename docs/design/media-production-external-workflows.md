# 媒体生产第三方工作流接入

状态：active design contract

日期：2026-07-14

范围：桌面 Web 媒体生产、单场景生产流程、ComfyUI 连接与可恢复执行

相关文档：

- [模型工作台视频生产台](model-workbench-video-production-studio.md)
- [媒体生产画布优先布局](media-production-canvas-first-layout.md)
- [Provider Generation Runtime](provider-generation-runtime.md)

## Purpose

Ling 已有两层媒体能力：模型工作台管理可直接调用的图片、视频模型；媒体生产管理项目、分镜、场景运行和产物。本合同在不取代现有直接生成的前提下，为场景增加可选的第三方工作流执行路径。

ComfyUI 作为独立服务运行。Ling 不内嵌 ComfyUI 源码、Python 运行时、模型文件或自定义节点；Ling daemon 只通过受控 API adapter 提交工作流、追踪状态并把返回文件导入 Ling Artifact。

## Product Model

```text
Media Project
  -> ordered Media Scenes
    -> execution mode: direct provider | external workflow
      -> Media Scene Run
        -> Media Job
          -> provider adapter | media workflow adapter
            -> Artifact
```

直接生成和工作流生成必须并存：

- `direct` 继续使用模型工作台 Provider Preset 和现有 Media Adapter；
- `workflow` 使用媒体生产流程库中已验证的工作流；
- 项目可保存默认执行方式，场景可继承或覆盖；
- 切换执行方式不删除另一条路径的配置，便于用户来回比较；
- 历史 Scene Run 始终保留当时的 Provider 或 Workflow Version 快照。

## Workflow Domain

| Object | Owns | Does not own |
| --- | --- | --- |
| Media Workflow Connection | workspace、adapter kind、Base URL、secret ref、信任策略、健康状态 | graph、模型文件、原始密钥 |
| Media Workflow Definition | 稳定名称、描述、连接、当前启用版本、归档状态 | 运行中状态 |
| Media Workflow Version | 不可变 graph 快照、digest、输入 schema、输出规则、检查结果 | 密钥、场景最新参数 |
| Media Workflow Run | Workflow Version、场景输入快照和 Media Job 关联 | 最终文件字节 |

工作流版本一旦启用便不再就地修改。重新导入 JSON 创建新版本，新版本启用前显示受影响场景数量。旧运行不跟随新版本变化。

## ComfyUI V1 Contract

V1 支持自托管 ComfyUI 和 Comfy Cloud，只接受 API-format JSON。

连接检查通过 `/api/object_info` 验证节点可用性，并自动识别当前 jobs API 或 legacy prompt/history API。运行流程为：

1. daemon 校验场景、工作流版本、连接和密钥状态；
2. 将 prompt、ratio、duration、seed 和引用 Artifact 写入受控 node/input 映射；
3. 参考图由 daemon 上传到 `/api/upload/image`，不传递本地绝对路径；
4. 通过 `/api/prompt` 提交 graph，持久化 `prompt_id` 或 job id；
5. 优先查询 `/api/jobs/{id}`，旧版回退到 history；
6. 精确取消只在 API 支持指定 job 时开放，不调用会中断其他任务的全局 interrupt；
7. 产物只通过 adapter 知道的同源 `/api/view` 路径下载，然后导入 Ling Artifact。

Ling 不解析或管理 ComfyUI 内部使用的模型。这些模型由 ComfyUI 环境负责，不出现在 Ling 模型工作台。

## Input And Output Schema

导入时从 graph 和 object info 生成安全表单。V1 只允许：

- text、number、boolean、select 等标量字段；
- image artifact 引用；
- `prompt / negative_prompt / ratio / duration / seed / reference_image / custom` 语义；
- 精确的 node id + input name 映射。

不允许用户编写 JavaScript、JSONPath、URL 表达式、Header 模板或本地路径。

输出规则只能选择 graph 中的输出节点和期望的 `image / video`。试运行必须实际返回对应媒体，流程才能启用。

## Experience Contract

- 媒体生产左侧浮动项目面板提供“生产流程”入口；
- 流程库使用临时 overlay，不新增常驻侧栏；
- 流程库有“流程 / 连接”两个页内视图；
- 导入步骤为“选择 JSON → 检查节点 → 映射输入输出 → 试运行 → 启用”；
- 连接检查和静态检查不产生媒体成本；
- 用户点击“试运行”“生成本场景”或批量确认中的“生成 N 个场景”即构成明确授权，任务创建后由 daemon 直接启动，不再二次进入审批中心；
- 默认层不显示 graph JSON、remote id、node id、secret ref 和原始响应。

## Durable Execution

媒体执行不得在一个 HTTP 请求中循环等待长时任务。提交成功后返回 `202`，后台 dispatcher 按 execution handle 的 `nextPollAt` 调度单次 poll：

- 每次 poll 后持久化状态和下次时间；
- daemon 重启后继续非终态任务；
- runtime work unit 和 semaphore lease 持续到任务终态；
- Provider 和 Workflow 执行共享状态、取消、事件、Artifact 和生成任务页；历史 `media_cost` 审批记录继续可读，但新媒体生产任务不再创建该审批。

## Security Boundaries

- 密钥只使用 `env:` 或 `keychain:` ref，浏览器不接收密钥值；
- Base URL 锁定 origin，redirect 必须重新校验；
- localhost 和局域网连接需要用户显式标记为可信自托管连接；
- 防止 DNS rebinding、重定向绕过、跨 workspace Artifact 和无限文件下载；
- 图片沿用 25 MB 单文件限制，视频沿用 512 MB 单文件限制；
- execution handle 不存储 API Key、Authorization Header、完整外部响应或未脱敏输入。

## Non-Goals

- 把 ComfyUI 源码、模型或 Python 运行时打包进 Ling；
- 在 Ling 内编辑 ComfyUI 节点图；
- 项目级工作流、视频拼接、剪辑、转场、字幕、配音和 FFmpeg 成片；
- 任意 HTTP、Webhook、用户自定义请求模板；
- V1 同时实现 Dify、Flowise、Langflow、fal 或 Replicate；
- 修改聊天、频道、AI 队友或模型工作台的选择语义。

## Acceptance Criteria

- 旧项目、场景和 Media Job 自动迁移为直接生成，Seedance 与独立生成任务不回退；
- 用户可在媒体生产中创建 ComfyUI 连接、导入 API JSON、完成映射、试运行并启用；
- 场景可在直接生成和已验证工作流之间切换；
- 按顺序生成可同时包含两种执行来源，每个场景仍有独立 Media Job；
- daemon 重启后 ComfyUI 任务恢复轮询，产物进入 Ling Artifact；
- 未验证、节点缺失、密钥缺失、跨界素材或超限产物都以中文可读原因阻断；
- 1440x1000 和 1280x800 下流程库关闭后画布恢复完整空间。
