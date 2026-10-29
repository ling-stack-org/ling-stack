# 三套场景主题专项验证：森灵晴空、夏日漫画与山谷机甲

状态：2026-10-27 Ocean 夏日漫画版已实施并完成本机检查；已更换参考图中的娜美形象。用户美术定稿及 Desktop 发布验收仍未关闭。本文由 Codex 更新，用于审阅当前主题和区分前轮照片证据。

关联：[设计与实施拆分](scene-theme-refinement-directions.md)、[共享阅读与播放合同](theme-background-hardening-plan.md)、[既有发布门槛](full-window-theme-background-acceptance-matrix.md)。

## 当前 Breeze 森灵晴空验证（2026-10-28）

（2026-10-29 已被取代：该用户供图来源不明，已删除，Breeze 现使用自研生成 `forest-clearing-v1.webp`，见 [v7 清单](../../apps/web/public/themes/scene-themes-v7.sources.json)。以下为历史记录。）

Breeze 当时使用用户直接上传并指定的 5708×3212 森林晴空 PNG，完整无损导出 WebP 与 640×360 同源缩略图，无新生成/角色叠加/放大。此前 StockCake 候选被用户否决；当前来源、处理和哈希见 [v6 清单](../../apps/web/public/themes/scene-themes-v6.sources.json)，不将旧候选 CC0 沿用到用户供图。原实拍图保留，其 CC BY-SA 4.0 归属不变。

浅天空蓝、鼠尾草侧栏、奶白 Composer/浮层、柔绿选中与消息、绿操作/焦点的共享参数保持不变。前轮 85 个 UI 包测试、11 个组件和 12 个场景浏览器用例只对应旧候选图及当时的 UI；本轮新背景的构建、Breeze 浏览器检查与真实截图单独记录在[当前组件验证记录](component-theme-presentation-validation.md)，证据编号 `2026-10-28/breeze-user-forest`。未提交或发布，真实模型与原生发布不在本轮范围。

## 当前 Night 山谷眺望验证（2026-10-28）

用户明确选用“山谷眺望 · Titanfall 2”。Night 使用完整下载图，不生成、不镜像、不叠加人物；WebP 保留下载像素 3840×2160，724910 bytes，同源缩略图 640×360，46522 bytes。CDN 输出尺寸不作为原生 4K 证明；游戏图公开分发许可仍开放，不能套用主题代码 MIT。来源、处理与 SHA-256 见 [v4 清单](../../apps/web/public/themes/scene-themes-v4.sources.json)。旧雨窗资源与来源保留。

UI 同步为暖钢铁石墨（app `#1e1c20`、正文/输入框 `#29262a`）、暖灰文字、夕照铜金操作/焦点 `#e7b38b`、铜灰选中 `#514039`、同系边框/滚动条/桌面背景。布局透明、正文实底、设置和弹层保护沿用共享规则；稳定 theme/scene ID 与其余主题不变。设置卡取图片上部，保留驾驶员和机甲头部，不改变全窗原图。

| 检查 | 结果与边界 |
|---|---|
| UI React | 84/84 通过，包括正文/辅助文字、操作状态及图片极值材质对比度；主题注册专项 7/7 通过 |
| Web 构建 | `build:ci` 通过（TypeScript + Vite），保留既有 chunk size 提示 |
| Night Chromium 专项 | 隔离 Vite `:4196` 的 4/4 通过：首页、输入焦点、菜单/Dialog、插件/自动化、设置保护、重载首帧、forced-colors、窄窗与普通/频道/私聊正文；实际图片解码及配色/输入框实底断言通过，console/page errors=0。缩略图取景微调后再次执行 |
| 首次测试环境 | 默认 `:4174` 首次返回其他主题后断连，4 项失败；保留 error-context，改为独立端口、禁止复用后重跑通过，没有放宽断言 |
| 已连接 IAB | `http://127.0.0.1:5173/` 为本工作树 Vite + UI dist。通过真实设置选择 Ling Night 并切换到内置图，保存首页/设置/管理页截图；后端未运行，未进行模型请求或真实任务验收。原自定义花卉视频先通过页面下载并另存本机证据，再切换背景选择，不修改模型/频道/工作区数据库 |

本机证据编号：`2026-10-28/ling-night-valley`，未随仓库发布。`connected-*.png` 为既有 IAB 页面；`ling-night-*.png` 为真实组件 + 隔离 daemon 数据专项，不代表用户会话。原视频保存在 `previous-custom-background.mp4`，可重新上传恢复。源码增量前状态、原始下载图、资源及截图摘要保存在对应本机证据目录。没有推送或合并 PR，也没有 Desktop 签名包、跨平台/高 DPR、长时性能或移动端验收。

## 当前 Ocean 夏日漫画验证（2026-10-27）

选用现成 [StockCake · Anime Beach Sunset](https://stockcake.com/i/anime-beach-sunset_4306699_1909957/)，长发碎花泳装角色、海浪与天空为一张完整图片。来源站声明 CC0/public domain 并标注 AI 创作；本轮没有生成新图。原生 1344×768 裁为 1344×756，未放大；同源 640×360 缩略图。设置卡片取上部构图保留人物头部，全窗焦点和图片不变。来源及 hash 见 [v3 清单](../../apps/web/public/themes/scene-themes-v3.sources.json)。

UI 同步为浅青侧栏、暖白 Composer/内容层、珊瑚主操作/选中/焦点、深海文字与统一浮层。原 Logo、主题/场景 ID、用户媒体及模型数据不变。

| 检查 | 结果与实际范围 |
|---|---|
| UI React | 84/84 通过；卡片取景修改后再次通过，包含正文/辅助字色、操作状态和图片极值对比度 |
| 场景主题 Chromium 专项 | 12/12 通过；Breeze/Ocean/Night 首页、菜单/Dialog、输入焦点、插件/自动化、设置、首帧、forced-colors、窄窗和普通/频道/私聊正文。卡片取景修改后 Ocean 4/4 再次通过 |
| 浏览器专项错误 | 12 项最终 console/page errors 为 0；Ocean 重跑 4 项同样为 0。实际解码 1344×756，验证版本化路径与同源缩略图 |
| 构建与静态检查 | Web `build:ci`、UI 包 build、Web lint 通过；生产构建保留既有 chunk 提示。最终摘要以本轮证据清单为准 |
| 已连接浏览器 | IAB `http://127.0.0.1:5173/` 消费当前 Vite 源码和 UI dist；实测主题卡、切换后配色与原自定义媒体保留。原全局视频优先显示，未清除媒体；实际 daemon 连接异常导致服务不可用提示，不能据此声称真实模型或会话已验收 |
| 人工视觉 | 已查看当前首页、普通会话、菜单及真实设置卡截图；没有独立人物层。正文保持实底、布局透明；美术喜好仍由用户确认 |

本机证据编号：`2026-10-27/scene-theme-refinement/summer-ocean`，未随仓库发布。`ling-ocean-*.png` 为真实生产组件在隔离 daemon 数据下的浏览器截图，`connected-settings.png` 为已连接 IAB 的真实设置页；`source-manifest.json` 记录源码/资源/证据摘要与运行边界。隔离数据截图不代表用户模型配置，不运行真实模型。

以下交付与执行表保留前轮照片证据；Ocean 的当前状态以本节为准。

## 前轮照片交付范围（历史）

- Breeze 林间晨光：Wikimedia Commons 的《Forest path to the sun》实拍照片，暖纸白内容层、鼠尾草侧栏、松绿操作/选中/焦点。
- Ocean 海盐晴空：当前临时使用 Wikimedia Commons 的《Borkum, Reede, Blick auf das Wattenmeer》实拍照片；开阔海天、低地平线、中心留白、右侧码头细节。瓷白内容层、冷蓝灰侧栏、深海蓝操作/选中/焦点。该照片没有满足用户的精细卡通要求，不能认定为 WorkBuddy 风格已交付。
- Night 雨夜书窗：Wikimedia Commons 的《Rainy night in Tallinn》雨夜实拍照片；石墨内容层、琥珀操作与焦点。保留 theme ID 以维持已保存的主题选择；资源路径可随版本更新。
- 旧几何树木、波浪、极光和独立机器人绘制已移除。稳定 theme/scene ID 保留，关闭 mascot/corner 装饰；没有新增场景分层、运行时视频或独立角色。
- 同时适配旧组件颜色别名，解决此前浅色主题下部分正文、代码、操作仍使用默认色的问题。公共控件、菜单、Dialog、输入框、错误/警告等继续消费共享语义变量。
- Journey、Ling Dark、Ling Light 作为回归基线。保留原 Logo、自定义媒体优先级、每主题可见度/焦点/暂停策略；不进行用户设置或模型配置迁移。

当前资源不再使用 imagegen，也不依赖生成模型。三张照片均来自 Wikimedia Commons，原始页面、作者、许可证、下载摘要和导出 SHA-256 记录在[公开照片来源清单](../../apps/web/public/themes/photographic-scenes-v2.sources.json)及[资源清单兼容别名](../../apps/web/public/themes/photographic-scenes-v1.provenance.json)中。导出流程只做 RGB 16:9 中心裁切和静态 WebP 压缩，缩略图来自同一张导出母图，没有叠加角色、文字、渐变或运行时合成。旧[生成提示词](../../apps/web/public/themes/photographic-scenes-v1.prompts.json)仅作为历史候选记录，不代表当前资源来源。

## 源码与证据归属

本轮开始于 `gansx/theme-background` 的 `790eb2d37a787ca52cf7511edf1d9fa9d45e9c83` 加既有未提交工作。工作期间原 `d096/ling-stack` 被归档移除；归档快照 `e97fdca53742bf8242effc0488fbc141eaf9e34e` 已包含摄影资源、兼容变量修复和测试。后续从该快照创建独立工作树 `photo-themes/ling-stack` 完成辅助文字对比度和夹具修正；未把改动复制进会话错误修复分支。

该归档快照不是远端发布提交。当前精确源码、资产与增量摘要记录在本机证据目录 `source-manifest.json`，不能仅凭基线 SHA 推断完整运行时内容。旧 staged patch 在归档前核对保持一致。Git 快照不能证明已保留 ignored 数据库或媒体目录，不把恢复源码视为恢复用户数据。

本机证据编号：`2026-10-27/scene-theme-refinement`，未随仓库发布；具体位置由执行者本机证据索引维护。

## 前轮照片执行结果（历史）

| 检查 | 当前结果与边界 |
|---|---|
| UI React | 84/84 通过。新增辅助文字在 panel/code/composer 和主操作各状态的 4.5:1 检查；既有图片极值材质检查扩展到六套内置主题 |
| 摄影主题 Chromium 专项 | 12/12 通过；三套首页/控件/菜单/Dialog/插件/自动化/设置保护/首帧/强制颜色/窄窗口，以及三套×普通/频道/私聊的正文保护 |
| 浏览器专项错误 | 最终 12 项 console/page errors 为 0；背景图片实际解码宽高均为 1672×941，主题卡使用同源缩略图 |
| Web 构建 | 恢复后的工作树生产构建通过；保留既有大 chunk / 动态导入提示，不将其计为功能失败 |
| Web 静态检查 | lint、typecheck、i18n 已在本轮执行；生产构建再次覆盖 TypeScript；恢复后 lint 再次通过 |
| 生产预览回归 | 6/6 通过；三个摄影主题的实页、官方缩略图/自定义覆盖、Journey 与 Ling Dark 对照及保护回退，生产 Vite preview :4175，console/page errors=0 |
| 人工视觉 | 已看母图和首页/会话截图；最初在已连接 IAB 中操作并查看 Breeze。原目录归档后 CUA 无法写入运行文件，后续检查由仓库 Playwright 执行，截图标明来源 |

过程中的失败日志保留：第一轮夹具未返回 cwd，发送权限正确变为 blocked；随后插件入口定位名称修正为 Plugin Manager；管理页 404 来自基础夹具缺少四个 automation 列表接口。修正夹具后完整重跑，不过滤控制台错误。最初浅色 soft 字色在 code 底色上低于 4.5:1，已加深并新增回归检查。

## 未执行或仍需用户确认

用户尚未确认三套的美术定稿，Ocean 夏日漫画实现与结果见本文当前章节及[最新设计方向](scene-theme-refinement-directions.md)。Ocean 原生 1344 宽的大屏清晰度、Windows/macOS 签名安装包、高 DPR/超大屏、跨平台解码、长时间 CPU/GPU/RSS、完整屏幕阅读器与系统拖放等门槛未关闭；本轮没有移动端验收，没有模型调用或真实任务执行，没有推送或合并 PR。
