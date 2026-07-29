# 模型工作台视频生产台

状态：active design contract

日期：2026-07-13

范围：桌面 Web 媒体生产、模型工作台视频能力、分镜项目、场景运行与视频产物

相关文档：

- [Provider Generation Runtime](provider-generation-runtime.md)
- [Provider Generation Runtime Implementation Plan](provider-generation-runtime-implementation-plan.md)
- [Media Automations Workbench Refinement](media-automations-workbench-refinement.md)
- [Model Workbench Productization](model-workbench-productization-p13.md)
- [媒体生产体验收口](media-production-experience-refinement.md)
- [媒体生产第三方工作流接入](media-production-external-workflows.md)

## Purpose

Ling 已能通过 Media Job 运行单次图片或视频生成。这个合同将它扩展为一个面向创作生产的媒体工作台：用户在分镜中组织场景与素材，选择模型工作台中已验证的生成模型，生成可追溯的视频片段。

本合同定义的直接生成路径不是剪辑软件，也不把第三方工作流伪装成 Provider Preset。ComfyUI 等可选工作流执行由独立的[媒体生产第三方工作流接入](media-production-external-workflows.md)合同管理，不改变本文的模型工作台边界。

## Product Model

```text
Media Project
  -> ordered Media Scenes
    -> Media Scene Runs
      -> existing Media Jobs
        -> existing Artifacts
```

| Object | Owns | Does not own |
| --- | --- | --- |
| Media Project | 项目名称、默认模型、画布视口、场景集合 | 视频文件、供应商任务状态 |
| Media Scene | 分镜内容、顺序、模型覆盖、比例、时长、参考素材、节点坐标 | 历史运行结果 |
| Media Scene Run | 一次场景运行的模型/输入快照与 Media Job 关联 | Provider 密钥、最终 artifact 字节 |
| Media Job | 单次 Provider 生成的状态、错误、artifact id | 项目画布和场景编辑状态 |

场景的 `sortOrder` 是唯一的生成顺序来源。画布位置仅服务于可读性，拖动节点不改变场景生成顺序。每次运行都新增一条 Scene Run。场景首次成功生成并保存 artifact 后自动采用该 Scene Run；后续重新生成只进入历史，由用户明确“设为当前”后才替换当前结果。

删除项目或场景仅删除项目、场景和关联记录，不删除既有 Media Job、Artifact、审批或审计历史。

## Experience Contract

顶部入口名称为“媒体生产”。页面有两个页内视图：

- `生产台`：默认视图。左侧项目与场景列表，中间分镜画布，右侧场景检查器和素材选择器。
- `生成任务`：既有 Media Job 列表、详情、失败恢复和产物下载。项目生成的子任务也在这里可见。

分镜画布使用节点表达场景和已绑定的参考素材：

- 场景节点显示标题、简短提示词、模型、比例、时长、状态和当前选用结果缩略信息；
- 参考素材节点只能指向当前工作区中已有的 image artifact；
- 场景间顺序连线按 `sortOrder` 渲染；节点坐标不会生成隐式依赖；
- 选择场景后，所有可编辑字段进入右侧检查器，不在节点上堆叠复杂输入；
- 有当前结果的场景节点显示固定预览图标，点击后打开当前选用视频，不改变场景选择且不触发生成；
- 新建、复制、删除、重新排序和拖动都有明确操作；删除有确认，复制不带运行历史。

生产台主动作是“生成本场景”和“按顺序生成”。场景已有当前结果时，单场景主动作改为“重新生成”；重新生成中和失败时当前结果仍可预览。项目级“按顺序生成”只提交尚未生成且准备完成的场景，已有结果明确列入跳过项。用户点击单场景生成，或在批量确认面板点击“生成 N 个场景”，即构成本次媒体生成的明确授权；任务创建后由 daemon 直接启动，不再二次进入审批中心。保存项目、编辑提示词、拖动节点、选择素材和切换模型不会生成媒体或产生费用。第一期输出独立视频片段与素材包，不显示“导出成片”“拼接”“转场”“字幕”或其他未真实接入的编辑能力。

单场景“运行”同时是当前可见提示词的显式提交边界。用户不需要先点击页面空白处触发失焦保存：若提示词草稿与场景已保存内容不同，Web 必须先保存当前草稿，保存成功后再创建 Scene Run；失焦保存已经进行时，运行复用并等待同一次保存，不重复发送 PATCH。保存失败时保留用户输入并停在场景检查器，不创建 Media Job。提示词为空时，运行按钮仍可点击，但点击后只在提示词字段下显示“请输入提示词”，聚焦输入框且不下发任务。daemon 继续执行相同的空提示词校验，不能把前端校验当作安全边界。

## Model Workbench Boundary

`MediaOperation` 继续使用 `video_generate`。图片参考不是一个伪造的新 operation，而是视频模型的输入模式。

```ts
type VideoGenerationInputMode = "text" | "image_reference";

interface VideoGenerationCapabilities {
  readonly inputModes: readonly VideoGenerationInputMode[];
  readonly aspectRatios?: readonly string[];
  readonly durationsSeconds?: readonly number[];
}
```

Generation Runtime Resolver 只有在 Provider Preset 已启用、密钥和 Base URL 完整、`video_generate` 真实可运行、并且有专用 Adapter 时，才将上述能力返回给 Web。

规则：

1. 未知模型不能通过手填 JSON 获得 `image_reference` 能力。
2. Seedance 初始只声明 `text`，因为当前 Adapter 仅发送文本、比例、时长和水印。
3. 只有供应商字段映射、真实 smoke 和最终视频 artifact 校验都完成后，Adapter 才能声明 `image_reference`。
4. 聊天、频道和 AI 队友的模型选择逻辑不消费这些媒体输入模式。

## Execution And Recovery

长视频生成不能由浏览器请求等待到最终完成。Media Adapter 统一使用下列恢复接口：

```ts
submit(request) -> pending handle | completed artifacts
poll(handle) -> pending | succeeded artifacts | failed
cancel(handle) -> cancelled | unsupported
collectArtifacts(handle) -> artifacts
```

Provider 返回的任务 ID、必要的无密钥状态定位信息和 Adapter 类型保存在 Media Job Execution Handle 中。密钥、Authorization Header 和完整 Provider 响应不能写入该记录。

后台 dispatcher 负责提交、轮询、取消和恢复：

- 项目“按顺序生成”按 `sortOrder` 创建 Scene Run 与既有 Media Job；
- 同一场景同一时间只允许一个未终态任务，重复提交返回明确冲突，不创建第二条付费任务；
- 同一 Provider 继续使用已有 runtime semaphore；
- daemon 启动时扫描未终态 Handle 并恢复轮询；
- 终态后下载 artifact，更新 Media Job，并让 Scene Run 反映关联 job 的状态；
- 成功保存 artifact 后按 Media Job 查找 Scene Run；仅当场景还没有当前结果时自动写入 `selectedMediaSceneRunId`，后续成功、失败或取消都不覆盖已有选择；
- 取消只取消尚未终态的 Scene Run/Media Job；Provider 不支持取消时显示可读说明并停止本地继续调度。

独立 Media Job 仍可从“生成任务”运行。它们在异步 Adapter 上也使用同一 Handle 恢复机制，避免项目任务与独立任务有两套状态语义。

## Storage And Safety

新增项目、场景、场景运行与执行句柄表；既有 `media_jobs` 和 `artifacts` 保持兼容。所有引用素材必须：

- 属于当前 workspace；
- 是已有 artifact；
- 内容类型为 image；
- 只在模型声明 `image_reference` 时进入 provider payload。

Provider snapshot、输入 snapshot 和错误信息必须进行现有密钥脱敏。下载最终视频仍不得向产物 URL 转发 Provider Authorization Header。

## Non-Goals

- 任意 HTTP、Webhook 或把工作流伪装成模型；受控 ComfyUI 媒体工作流见独立合同；
- 视频裁切、拼接、转场、字幕、配音、FFmpeg 渲染与最终成片；
- 外部 URL、浏览器本地绝对路径或未归档文件作为参考素材；
- 自动选择未知模型、自动运行项目或对运行中场景修改输入快照；
- 移动端专项设计。

## Acceptance Criteria

- 用户可创建项目、组织并编辑场景，在不触发生成的情况下保存画布；
- 用户输入提示词后可直接点击“运行”；系统先保存屏幕上的当前输入再提交生成，不要求用户先让输入框失焦；
- 空提示词点击“运行”时只显示字段内错误并聚焦输入框，不创建 Scene Run 或 Media Job；
- 只有真实可运行的视频模型可被选择；
- 文本模型不显示参考素材入口；未来已验证图片参考模型可选择当前工作区图片 artifact；
- 场景历史运行、失败和产物均可追溯，独立 Media Job 历史不受影响；
- 首次成功结果自动显示“已生成”；重新生成中保留旧视频，第二次成功只有在用户设为当前后才更新预览；
- 用户点击画布预览后，视频使用真实 controls、静音自动播放并允许手动取消静音；图片保持静态预览。弹窗支持 Esc、遮罩和关闭按钮，关闭后停止播放；
- 重启 daemon 后未完成的视频任务可恢复到可读状态；
- 1440x1000 和 1280x800 中文白天模式下，页面壳不滚动，画布、素材列表和任务列表在各自区域内滚动。
