# 媒体生产图生视频详细设计

状态：implemented and locally verified；真实 Provider 验收等待显式付费授权

日期：2026-08-21

范围：桌面 Web 媒体生产、项目图片素材、Seedance 直接生成、场景运行快照与恢复

相关文档：

- [模型工作台视频生产台](model-workbench-video-production-studio.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [媒体任务与媒体生产](ui2.0升级/modules/12-媒体生产.md)

官方依据：[火山方舟创建视频生成任务](https://docs.volcengine.com/docs/82379/1520757)。

## 1. 目标与用户语义

媒体生产不增加独立的“文生视频 / 图生视频”总开关。系统根据场景是否绑定图片决定输入类型：

| 场景输入 | 用户看到的模式 | Provider 输入 |
| --- | --- | --- |
| 只有提示词 | 文生视频 | text |
| 提示词 + 一张起始画面 | 首帧图生视频 | text + first_frame |
| 提示词 + 一张或多张参考图片 | 参考图生视频 | text + reference_image[] |

提示词在三种模式下都必填。它描述主体动作、镜头运动、环境变化与结果要求；上传图片本身不构成运行授权。

## 2. 产品交互

### 2.1 场景检查器

场景检查器顺序调整为：

```text
场景名称
提示词
图片素材
模型、比例、时长
运行
当前结果
历史记录
```

图片素材区规则：

- 没有图片时显示“上传图片”和“从项目素材选择”，不显示用途控件；
- 上传完成后立即成为项目素材，再绑定到当前场景；
- 当前模型同时支持两种用途时显示 `参考图片 | 起始画面` 分段控件；
- 当前模型只支持一种用途时显示固定用途，不显示不可操作的二选一；
- 同时支持两种用途时，新上传图片默认作为参考图片；只支持首帧时默认作为起始画面；
- 参考图片允许多选并显示 `已选 N / 上限`；起始画面只能一张；
- 多张参考图片切换为起始画面时打开图片选择对话框，用户明确保留一张后才提交修改；
- 从起始画面切换为参考图片直接修改角色，不复制素材；
- 缩略图保持单行、固定尺寸和内部横向滚动，删除按钮不改变布局；
- 上传中、上传失败和角色不兼容使用素材区内反馈，不点亮整个场景检查器。

上传队列不属于可随场景切换卸载的 Inspector。Web 工作区按 `sceneId` 持有待上传文件、对象 URL、上传状态和
失败信息；切换场景或关闭右侧面板时继续显示该场景为不可运行，重新打开后恢复同一队列和重试入口。切换
Media Project、工作区或删除场景时取消该 UI 队列并释放对象 URL；已经发出的旧请求仍由既有
project/workspace lineage 丢弃，不能绑定到新选择。只有素材创建并成功写入原场景，或用户明确移除失败项后，
该场景才可恢复运行。项目批量运行必须把仍有待上传项的场景列为跳过项，但其他已就绪场景可以继续运行。
不同场景可各自上传图片，素材创建请求必须拥有独立并发身份；后发请求不得把先发请求误判为过期。

切换模型后不自动删除、改角色或更换模型。若现有输入不受新模型支持，场景保持原值并显示：
“当前模型不支持参考图片，请改为起始画面或切换模型”。运行点击只聚焦该问题，不创建任务。

默认模型缺失或仍在配置时，已有图片素材和用途仍必须可见；新增、素材选择和用途切换保持禁用，
数量只显示实际已选值，不显示虚假的模型上限。

### 2.2 项目素材库

素材库通过场景内选择器打开，不增加一级导航。它包含：

- 当前项目已上传图片；
- 用户明确从既有 image artifact 导入的图片副本；
- 文件名、缩略图、尺寸和创建时间；
- 未被场景使用的素材可删除；被使用时显示使用数量且删除返回冲突。

导入 artifact 必须复制字节到项目素材目录。场景不直接依赖原 artifact，避免来源 Media Job 或 Run 被清理后输入失效。

## 3. 合同与 API

### 3.1 类型

```ts
type VideoGenerationInputMode = "text" | "first_frame" | "reference_image";
type MediaSceneVideoImageRole = "first_frame" | "reference_image";

interface VideoGenerationCapabilities {
  readonly inputModes: readonly VideoGenerationInputMode[];
  readonly maxReferenceImages?: number;
  readonly aspectRatios?: readonly string[];
  readonly durationsSeconds?: readonly number[];
}

interface MediaProjectAsset {
  readonly id: string;
  readonly projectId: string;
  readonly fileName: string;
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly checksum: string;
  readonly sourceArtifactId?: string;
  readonly createdAt: string;
}

interface MediaSceneVideoImageInput {
  readonly assetId: string;
  readonly role: MediaSceneVideoImageRole;
}
```

`MediaScene`、`CreateMediaSceneRequest` 和 `UpdateMediaSceneRequest` 增加
`videoImageInputs`。`MediaProductionProjectResponse` 增加 `assets`。既有
`referenceArtifactIds` 保留，继续服务第三方工作流，不作为直接 Seedance 输入。

### 3.2 路由

```text
GET    /media-projects/:projectId/assets
POST   /media-projects/:projectId/assets
GET    /media-project-assets/:assetId/content
DELETE /media-project-assets/:assetId
```

创建请求为判别联合：

```ts
type CreateMediaProjectAssetRequest =
  | { kind: "upload"; fileName: string; contentType: string; contentBase64: string }
  | { kind: "artifact"; artifactId: string };
```

上传和 artifact 导入都返回 `MediaProjectAssetMutationResponse`。内容路由只读取当前 `cwd` 对应 store，
使用与 artifact/attachment 相同的 CORS 和路径边界；不接受外部 URL 或本地绝对路径。
Web 发起创建时必须显式携带打开检查器时的 `projectId`，不能在文件读取完成后重新取“当前选中项目”；
项目或工作区切换后的响应按既有 epoch/request lineage 丢弃，禁止把素材提交到新选择的项目。
公开列表、详情和创建响应只投影合同字段；内部相对磁盘 `path` 仅留在 Core/Daemon，不进入 Web 响应。

## 4. SQLite 与文件存储

新增 `media_project_assets`：

```sql
id TEXT PRIMARY KEY,
workspace_id TEXT NOT NULL,
project_id TEXT NOT NULL,
file_name TEXT NOT NULL,
content_type TEXT NOT NULL,
size_bytes INTEGER NOT NULL,
width INTEGER NOT NULL,
height INTEGER NOT NULL,
checksum TEXT NOT NULL,
source_artifact_id TEXT,
path TEXT NOT NULL,
created_at TEXT NOT NULL
```

`media_scenes` 新增 `video_image_inputs_json TEXT NOT NULL DEFAULT '[]'`。迁移只增加表和字段，不改写
`reference_artifact_ids_json`。旧场景自然读取为空图片输入。

`video_image_inputs_json` 是付费任务输入的持久化边界，读取时必须严格验证。只有合法 JSON 数组可以进入
`MediaScene`；数组项必须包含非空 `assetId` 和合法角色，同一数组不得重复素材或混用角色。JSON 损坏、根值
不是数组或任一数组项无效时，场景详情、场景列表和运行入口都必须失败关闭并返回可诊断错误。读取层不得丢弃
无效项，也不得把损坏值投影为 `[]`，否则原本的图生视频场景会被静默降级为文生视频。只有数据库中明确保存的
合法空数组 `[]` 才表示纯文字输入。

上传内容存放在：

```text
.ling-stack/attachments/media-projects/<project-id>/<asset-id>.<ext>
```

文件名仅作展示；磁盘名使用内部 id 和从实际 MIME 推导的扩展名。写入流程是：解码到内存、验证、写唯一临时文件、
原子改名、创建数据库记录；数据库失败时删除新文件。项目/素材删除先把目标文件原子改名为同目录 tombstone，
数据库删除失败时恢复原名，数据库提交后再清除 tombstone，避免接口报错但记录已经消失。所有路径都必须通过
当前附件根目录的词法边界和真实路径边界校验。写入不存在的文件前必须解析最近存在父目录；读取、物化和删除
已存在文件时必须拒绝符号链接，并确认真实路径仍位于当前附件根目录。数据库中的素材路径只能是
`media-projects/<project-id>/...` 下的内部相对路径，不能接受绝对路径或跨项目路径。

## 5. 验证规则

### 5.1 素材

- 允许 JPEG、PNG、WebP；不能只信请求 MIME、扩展名或文件头尺寸，必须校验完整容器结构并识别实际格式与尺寸；
- Daemon 当前不承诺逐像素重编码校验；PNG 必须包含完整 `IHDR/IDAT/IEND`，JPEG 必须包含帧与扫描段并正常结束，WebP 必须具有完整 RIFF 分块；
- 单张原始字节 `1..25 MiB`；请求体沿用 40 MiB 上传上限；
- 宽高均为 `300..6000`，宽高比为 `0.4..2.5`；
- 保存 SHA-256，项目内相同 checksum 可复用既有素材，避免重复文件；
- 场景输入的 asset 必须存在且属于同一 project/workspace；
- 一个 Provider 请求中图片原始字节合计不超过 45 MiB。

### 5.2 模型能力

| 模型 | text | first_frame | reference_image |
| --- | --- | --- | --- |
| Seedance 1.0 Pro / Fast | 是 | 1 张 | 否 |
| Seedance 1.5 Pro | 是 | 1 张 | 否 |
| Seedance 2.0 | 是 | 1 张 | 1-9 张 |
| Seedance 2.5 | 是 | 1 张 | 1-30 张 |
| 未知 Seedance 版本 | 是 | 否 | 否 |

Resolver 依据规范化 model id 匹配已验证版本。Provider kind、capability 或 `compat` 只能决定候选和传输，
不能向未知版本授予图片模式。新增 2.0/2.5 内置候选不改变已有默认模型。

同一场景的所有 `videoImageInputs` 必须使用同一角色。`first_frame` 数量必须为 1；
`reference_image` 数量受模型上限约束。任何不兼容都在创建所有批量任务前失败，保持零副作用。

## 6. Daemon 与 Provider 数据流

```text
Scene draft
  -> save videoImageInputs(asset ids + role)
  -> validate complete project run
  -> create Media Job with stable refs only
  -> materialize project asset bytes in daemon
  -> ephemeral data:image/...;base64 payload
  -> Seedance submit
  -> persist task id/status endpoint/safe summary
  -> poll and collect final video artifact
```

Seedance `content`：

```json
[
  { "type": "text", "text": "镜头缓慢推进" },
  {
    "type": "image_url",
    "image_url": { "url": "data:image/png;base64,..." },
    "role": "reference_image"
  }
]
```

首帧使用相同结构，`role` 改为 `first_frame`。首帧和参考图不能混用。

Media Job `input` 和 Scene Run `inputSnapshot` 只保存：

```json
{
  "ratio": "16:9",
  "duration": 5,
  "videoImageInputs": [
    { "assetId": "...", "role": "reference_image", "checksum": "sha256:..." }
  ]
}
```

Adapter 请求对象中的 Data URL 只存在于提交调用栈。Seedance Execution Handle 不再保存完整 request payload，
仅保存 external operation id、status endpoint、可选 final URL 和不含用户内容的安全摘要。日志、错误和测试快照禁止输出图片 Base64。

## 7. 状态与失败处理

- 上传中：允许继续编辑提示词；该场景不可运行，项目批量运行必须跳过该场景，但不阻止其他已就绪场景；
- 上传中切换场景或关闭 Inspector：队列由工作区继续持有，原场景保持不可运行，不得短暂回退成纯文字任务；
- 上传失败或上传成功但场景绑定失败：保留本地预览，提供重试和移除，并继续阻止运行，避免误发纯文字付费任务；
- 素材删除冲突：保持素材和场景绑定，显示正在被几个场景使用；
- 模型不兼容：保留输入，阻止单场景与项目运行；
- 提交前文件丢失、变成符号链接、真实路径越界或 checksum 改变：标记 `invalid_media_asset`，不调用 Provider；
- Provider 拒绝图片：保留 Scene Run 和 Media Job 失败记录，错误转为可处理中文，不自动回退文生视频；
- daemon 在任务已提交后重启：按原 Handle 恢复轮询，不需要再次读取输入图片；
- daemon 在提交前中断：未创建外部任务的工作单元可从稳定素材引用重新物化，幂等边界仍由现有 Media Job 执行状态控制。

## 8. 实施顺序

1. 合同、SQLite、项目素材 store 和 API；
2. Seedance 版本能力、场景校验、临时图片物化与请求构建；
3. Web 上传、项目素材选择、图片用途和错误状态；
4. 自动化、浏览器、packaged Desktop 和经确认的真实供应商验收。

每批完成后先运行该层测试再进入下一批。详细设计发生变化时先更新本文和 SDD 状态，不在实现中打补丁绕过。

## 9. 验收矩阵

- 纯文字场景的 Provider payload 与当前实现一致；
- 1.0/1.5 只出现起始画面，2.0/2.5 可选择参考图片；
- 首帧一张、2.0 参考图九张、2.5 参考图三十张边界均有测试；
- 多参考图切换首帧必须明确选择，不丢失项目素材；
- 延迟上传期间切换场景或关闭 Inspector，原场景仍不可运行且在项目批量运行中列为跳过；重新打开后队列仍可重试或移除；
- 模型切换、跨项目 id、坏图片、超限图片和批量半提交均失败关闭；
- Daemon 单图字节、宽高、宽高比和 Provider 聚合字节守卫必须复用生产路径，并直接验证 `1/25 MiB`、
  `300/6000`、`0.4/2.5`、`45 MiB` 的包含边界及越界一单位拒绝；HTTP 上传 `25 MiB + 1 byte`
  必须在素材落盘前返回 `invalid_media_asset`；
- 直接篡改 `video_image_inputs_json` 为损坏 JSON、非数组、无效项、重复素材或混合角色时，场景读取必须报错，
  不得返回空图片输入或创建 Media Job；
- 数据库、日志、Handle、控制面事件和 Web console 均无 Base64；
- 1440x1000、1280x800 中英文、明暗模式无溢出、重叠和页面级滚动；
- packaged Desktop 可上传、预览、运行并恢复；
- 经用户确认后，以无真人肖像的自有图片执行一次 5 秒 Seedance 2.0 参考图真实任务并得到可播放 artifact。

## 10. 实施与验证状态

截至 2026-08-21，合同、SQLite、项目素材 API、Seedance 图片输入、Web 场景交互和 Desktop 打包接入均已实施。
本地验证包括：

- Contracts `38/38`、Core `368/368`、Providers `30/30`、API Client `49/49`、Daemon `929/929`；
- Web `53/53`，并通过 typecheck、i18n、lint；
- 图生视频定向 Playwright `3/3`，覆盖上传、项目素材复用、生成结果导入、用途切换、跨场景待上传阻断和双场景并发上传；
- 媒体生产完整 Playwright `78/79`；唯一失败为 MP-11 的旧请求次数断言，已在未修改的 `main` 独立复现，
  不属于本功能回归；
- macOS arm64 Desktop 成功生成 `.app`、DMG 和 ZIP。使用临时用户目录、独立端口和本地 ad-hoc 重签副本完成
  daemon 启动、素材上传、内容回读、场景绑定、重载和图片预览验收，console 与 `pageerror` 均为 0；本轮又以
  本地 Seedance 模拟服务完成提交后关闭客户端、同一用户目录重启和任务恢复，确认只提交一次、重启后轮询原任务、
  最终生成视频 artifact，未调用真实供应商；持久化失败关闭修复后重新生成最终 `.app`、DMG 和 ZIP，并验证 ZIP、
  DMG 完整性以及安装包内置 daemon 已包含严格读取逻辑；边界测试加固后再次从最终源码重建 ZIP/DMG，完整性通过，
  `app.asar` 已确认包含统一的 Provider 图片聚合字节守卫；
- 直接损坏 `video_image_inputs_json` 的 Core 与 Daemon 回归均通过；运行接口在创建 Media Job 和调用 Provider 前
  返回错误，未发生图生视频向文生视频的静默降级；
- 单图大小、尺寸、宽高比和 Provider 聚合字节守卫的包含/越界测试均通过；真实 HTTP 超大上传在写文件前被拒绝；
- 开发机没有 Developer ID，正式分发签名与公证不属于本功能验收，原始开发产物保持未签名状态。

用户已明确授权并执行一次真实 Seedance 2.0 五秒参考图任务。Ling 完成项目素材、场景、Media Job 和生产 Adapter
提交后，Ark 以 `ModelNotOpen` 拒绝目标模型，因此没有生成视频，也没有自动改用其他模型或发起第二次付费请求。
隔离测试工作区检查确认仅保存环境变量凭据引用，不含 Provider secret 记录、原始 API key 或图片 Base64，检查后已删除。
本功能状态为“本地实现与自动化已验证，真实 Provider 验收因 Ark 账号尚未开通 Seedance 2.0 而阻塞”；账号开通后，
仍需用户确认再重试付费任务。
