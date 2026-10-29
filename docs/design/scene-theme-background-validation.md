# 官方场景主题与自定义媒体背景本机验证记录

Status: S1–S3 implemented locally; reading/playback/profile hardening tracked in the current contract; Desktop release gates open
Owner: theme and presentation delivery track  
Last verified: 2026-10-27
Document type: implementation evidence and remaining acceptance gates  
Source: `gansx/theme-background`，`790eb2d37a787ca52cf7511edf1d9fa9d45e9c83` + 当前未提交改动；代码和截图只证明各自的本机源码快照，不推断远端同步状态  
Related: [本轮阅读/播放/构图合同与最新证据](theme-background-hardening-plan.md)、[统一合同](theme-background-motion-contract.md)、[实施方案](full-window-theme-background-implementation-plan.md)、[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)、[验收矩阵](full-window-theme-background-acceptance-matrix.md)

> 2026-10-26 产品修订：`ling-journey` 暂时回到静态主题。人物、剑光、远方黑烟、红色裂隙/余烬、云海和雾带使用同一张 `ling-journey-v4-depth-dark.webp` 母图，运行时不创建官方 video，也不叠加 SVG rider；Ling Core IP 与启动动画仍暂停。用户自定义 MP4/WebM 能力保留，但不属于官方主题默认行为。

## 已交付行为

主题设置现在只展示官方内置主题，不再展示主题包导入、创建、修复、重新导入、删除或预览操作。历史 local-import / local-generated manifests 不进入运行时 registry；历史 fixed selection 按颜色模式回退到官方浅色或深色主题，已有本地数据不删除。

主题列表包含 6 套官方主题：`ling-light`、`ling-dark`、`ling-breeze`、`ling-ocean`、`ling-night`、`ling-journey`。Breeze 使用实拍林间晨光；Night 于 2026-10-28 采用用户选定的 Titanfall 2 山谷眺望整图（3840×2160 下载像素），同步暖石墨与夕照铜金 UI；Ocean 于 2026-10-27 换成完整夏日漫画插画，并更换参考角色，适配浅青侧栏、暖白输入框及珊瑚操作色。全窗、同源缩略图和 UI 已完成本机专项验证，Night 背景已由用户确认，整体 UI 最终视觉复核及发布门槛仍开放，见[最新设计方向](scene-theme-refinement-directions.md)、[专项验证记录](photographic-scene-themes-validation.md)和 [v4 场景来源清单](../../apps/web/public/themes/scene-themes-v4.sources.json)。`ling-journey` 的缩略图和全窗都使用同一张整合静态母图；人物、黑烟、红色区域、云海和雾带都在图片内，运行时不存在官方 video 或 rider SVG 叠加。内置场景主题的浅色/深色首帧映射覆盖全部内置 ID，刷新后不会再先绘制浅色底。

无自定义媒体时，场景主题在普通工作区、顶部栏、左侧栏和主画布连续透出；保护路由继续实底。场景主题的 accent、focus、selection、sidebar、按钮和状态色使用同色系 tokens。正文、代码、输入、表格、审批、设置、诊断和弹层继续使用不透明语义表面。

自定义背景支持本地 PNG、JPEG、静态 WebP、MP4 和 WebM。图片继续按既有规则规范化；视频保存原始字节，不转码。背景可见度为 20%–100% 连续滑杆，默认 60%；旧 subtle / balanced / strong 读取时迁移为 45% / 60% / 75%。当前 preference v3 按主题保存可见度、横纵焦点与暂停状态，v1/v2 无损读取；媒体选择仍全局共用，工作页面的背景可见度上限为 45%。

动态壁纸与设置预览使用共享播放器和展示策略。隐藏页面、设置实底、窄窗与离开视口时暂停；减少动态效果默认静止，用户可临时手动恢复。播放失败保留解码静态帧或主题背景并提供重试，停滞恢复有次数上限。上传媒体优先于官方场景，恢复默认背景后回到当前主题场景或纯色。

## 前轮 S1–S3 本机证据（历史数字）

以下数字和旧截图证明前轮源码。阅读保护、共享播放器和每主题偏好更新后的执行结果与源码摘要见[加固合同](theme-background-hardening-plan.md)的当前证据。

执行机为 macOS arm64；Chromium 使用 Desktop Chrome 1440×960 配置。Web 为当前工作树 Vite 源码及最新工作区依赖 dist；daemon 使用受控 fixture，不运行真实模型或 Run。

| 检查 | 本轮结果 |
|---|---|
| 文档与规范 | `check:docs` 399 个 Markdown 文件链接通过；`git diff --check` 通过 |
| UI React | 82/82 tests passed，包括 scene manifests、非 built-in scene 拒绝、background v2 migration、视频签名、材质对比度、ThemePicker 和样式 guard |
| 本地化 | 55/55 catalogs、6806 keys、15/15 localization tests passed；中英文源文案更新为图片/视频媒体语义，其余 53 个目标语言重新翻译 |
| Web 静态检查 | typecheck、lint、check:i18n、production build 全部通过；build 仅有既有 chunk-size / ineffective dynamic import warnings |
| Desktop 静态检查 | main / preload / renderer typecheck 通过 |
| Desktop focused tests | codec 3、IPC 1、background repository 4 全部通过；覆盖图片 codec、exact IPC、revision/回执、崩溃恢复、symlink、MP4/WebM 原样保存和重启恢复 |
| 实际 Electron | `background-electron-smoke.mjs` 通过：生产 preload + IPC + native codec prepare/commit，完整进程退出后恢复、清除，再次退出后 GC |
| Full-window Chromium E2E | 18 passed、1 个录屏用例按设计 skipped；覆盖官方场景主题、缩略图、自定义覆盖、首帧主题映射、MP4/WebM 播放/暂停/reduced-motion、图片、存储、迁移、竞态、原生会话状态和保护路由 |
| Theme motion E2E | 7 passed；覆盖主题卡柔光/键盘、light/dark/breeze 背景拖放、边缘微光、forced-colors、普通会话附件上传和 blocked reset |
| Journey E2E | 2/2 passed；检查单一静态 `SceneArtwork`、`ling-journey-v4-depth-dark.webp`、无官方 video、无 rider SVG、刷新后暗色首帧一致；覆盖 Journey UI-01–UI-12、Composer/侧栏/右侧 dock/Overlay/设置保护回退、forced-colors、reduced-transparency、窄窗口和 console/page errors=0；用户自定义视频仍由独立用例覆盖 |
| 暗色实景照片 | 1 passed；浅色三档和深色均衡档保持照片可见，顶部无贯穿线、侧栏默认行透明、console/page errors 为 0 |
| 视觉复核 | 主题设置、Breeze/Ocean/Night 首页、MP4/WebM 壁纸截图和 Journey UI 状态截图均已人工查看；Journey 与 Ling Dark 有明显视觉差异，原有 `LingStackLogo` 保留 |

Journey UI 证据目录：`.ling-stack/acceptance/ui-browser/2026-10-27/journey-ui/`。两份 JSON 记录了主题 ID、surface、背景源、透明度、视口、computed styles、overflow 和 console/page errors；截图覆盖首页、compact rail、Composer focus/selected/error、普通会话、right dock、Popover、Menu、Dialog、Toast、设置实底、forced-colors、reduced-transparency、窄窗口和 Ling Dark 对比。

以下为历史初版视觉证据，不能作为当前照片/漫画版的美术定稿证据。当前版本以[专项记录](photographic-scene-themes-validation.md)为准。历史目录 `.ling-stack/acceptance/scene-theme-background/`：

- `official-scene-theme-picker.png`：官方 5 套主题，三套场景缩略图，无导入/创建入口；
- `ling-breeze-home.png`：绿色植物场景、角色、路径和树层；
- `ling-ocean-home.png`：蓝色海面、云、波浪、小船和角色；
- `ling-night-home.png`：星夜、极光、山层、月亮和角色；
- `dynamic-wallpaper.mp4-wallpaper.png` / `dynamic-wallpaper.webm-wallpaper.png`：本地视频作为共享动态壁纸；
- `.ling-stack/acceptance/theme-scene-candidates/ling-journey/ling-journey-depth-dark-home.png`：深色整合母图；上一轮 `output/ling-journey-integrated-motion/v2-contact.png` 仅作历史探索记录，不代表当前默认行为。

早期场景截图只证明背景资源和基础材质。组件级 P0–P6 已实施，UI-01–UI-12 的独立浏览器验收继续覆盖侧栏、顶栏、Composer、控件、Overlay、设置与保护回退；本轮源码的结果以[加固合同](theme-background-hardening-plan.md)为准。

## 未关闭门槛

本报告不证明跨平台产品发布完成。以下项目仍需按[验收矩阵](full-window-theme-background-acceptance-matrix.md)执行：

- macOS arm64/x64 和 Windows 签名安装包；
- Finder / Explorer 真实跨窗拖放和系统文件选择器全集；
- Desktop 安装包内 MP4/WebM 解码、暂停、首帧、性能和高 DPR 验收；
- 长时间视频壁纸 CPU/GPU/native RSS 预算；
- 极端图片/视频、自定义主题边界、完整屏幕阅读器和完整语言人工文案质量检查；
- 远端同步状态应在主题分支提交交付前另行核对，本轮未 fetch、提交或合并；
- 历史主题包 repository / IPC / 数据清理迁移（当前仅隐藏为产品能力，不代表旧代码已经删除）。

旧[整窗静态背景验证记录](full-window-theme-background-validation.md)只证明 superseded P2 静态图片实现，不关闭本轮 S1–S3。
