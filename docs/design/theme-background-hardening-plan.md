# 主题阅读保护、媒体播放与构图偏好实施合同

状态：H1–H4 本地实施与可执行验收已完成；2026-10-27。签名包、跨平台和长期资源门槛仍开放。当前状态与新增证据以本文为入口，旧截图和测试数字只证明各自记录的源码。

关联：[UI 适配合同](ling-journey-ui-adaptation-implementation-plan.md)、[背景验证](scene-theme-background-validation.md)。

## 产品目标与范围

用户在首页看到连续完整的背景，进入会话和管理页面后仍保留氛围，同时能稳定阅读正文。设置与受保护画布保持实底。用户可以调整当前主题的可见度与裁切焦点、暂停动态背景，并恢复推荐值；切换主题不会覆盖另一主题的构图。

保留原 Logo、现有模型/频道/队友和全局媒体选择；官方远行问剑继续使用静态整合母图。没有新 IP、云端上传、自动取色、主题分享、GIF/APNG/动画 WebP 转换、模型调用或移动端验收。本轮不提交或合并分支。

## 展示合同

- L0 为一张图片或一个视频，跨区域连续；首页使用用户选定强度，工作页面的可见度上限为 45%，避免亮部与运动抢占注意力。
- feed、timeline 和消息对齐框仅负责布局，始终透明。正文消息、代码、表格行和输入框消费 L3 语义实底；禁止重建贯穿整个消息区域的中央底板。
- 对话正文通过 conversation 共享样式变量接入，普通会话、频道、队友私聊不各写一套特判。
- 2026-10-28 组件统一后，背景材质读取当前主题的 ambient/content/shell 参数作为基准，设置预览和工作区共用 resolver。Night/Ocean/Journey 侧栏基准分别为 0.80/0.72/0.68；content 是正文对比度保护下限，shell 是导航材质基准。ambient 仅是开放画布的染色基准，实际 alpha = ambient × (1 − 有效可见度)，不能再用整屏文字对比度计算反向加浓。未知颜色语法退回实底；不改变 v3 偏好与媒体存储。组件外观与最新验证见[共享组件合同](component-theme-presentation.md)和[组件验证记录](component-theme-presentation-validation.md)。
- 背景和设置预览复用一个播放器。播放需要：当前页面可见、播放器展示、用户未暂停、系统允许动态效果。系统减少动态效果时默认静止；显式播放仅作为本次页面会话的许可，不写成系统偏好。
- 设置、窄窗、forced-colors、reduced-transparency 隐藏背景时立即暂停；预览滚出视口也暂停。重新展示时恢复原播放位置。清理监听与迟到的 play promise，防止隐藏后重新启动。
- 使用同一视频已解码的帧作为内存 poster。播放错误保留静态帧或当前主题场景，提供重试；无图可用时用语义底色。恢复监听覆盖 visibilitychange/pageshow/focus；停滞恢复次数有界，不能无限重载或新增隐藏播放器。

## 模块、状态和持久化

| 层 | 文件与职责 |
|---|---|
| 共享模型 | `packages/ui-react/src/theme/background/background-model.ts`：v3 preference、每主题 opacity/focusX/focusY/paused、v1/v2 无损读取；有效范围与推荐值 |
| 事务端口 | `background-port.ts`：可选 presentation 更新、canonical digest、共用提交合并；旧请求保留历史 digest 规则 |
| Web / Desktop | 既有 IndexedDB / native settings 原子事务保存 profile；继续 expectedRevision、requestId/receipt、并发冲突与崩溃恢复，不另设 localStorage 权威 |
| 背景 Provider | 持有当前主题 profile、实际 surface 可见策略、运行时播放许可与重试状态；媒体选择仍由同一仓库拥有 |
| 共享播放器 | `BackgroundVideo.tsx`：可见性、首帧、暂停/恢复、错误/停滞恢复；不负责媒体导入和持久化 |
| 展示策略桥 | `AppPresentationSurfaceBridge.tsx`：同一个 policy 同时驱动 CSS 与播放许可，避免只在 DOM 推断路由 |
| 设置 | `InterfaceBackgroundSettings.tsx`：本地草稿、当前主题焦点/强度/暂停、应用/取消/恢复推荐；切主题时丢弃未提交草稿并释放 lease |
| 样式 | `theme-background.css` 与共享 conversation 样式：工作页减弱、正文/表格保护、预览裁切与可访问控制 |

v3 保留全局 `selection` 和 `opacity` 作为迁移默认，新增有界 `profiles`（最多 24 项）。每主题 profile 含可见度 0.2–1、焦点 x/y 0–100、paused 布尔值。未定制主题继承旧可见度和居中焦点，不在读取时写入数据。新提交只更新指定主题并保留其他 profile；老请求不能清空 profile。所有字段都纳入校验与回执摘要，不通过字符串注入样式。

设置操作以进入草稿时的 revision 提交，冲突不覆盖其他窗口。恢复推荐值只修改草稿，应用后才保存。清除自定义媒体不清除主题构图，也不触碰模型或会话。

### 2026-10-28 设置预览与操作区修正

Codex 根据用户反馈修正设置交互：可见度/焦点/暂停等参数变化同样属于未应用草稿，状态提示必须明确要求应用，不能继续显示“当前默认背景”。设置小预览展示用户请求的完整 20%–100% 强度，不叠加实际窗口在 1180–1280px 的 60% 上限。预览中央仅有不承载文字的示意内容条，不再用整块显示文字保护层抵消可见度变化；示意内容条、侧栏和面板保留各自材质。遮罩和侧面板仍使用同一 resolver；真实页面的标题/正文/控件保护与工作页/窄窗减弱策略不变。

推荐按钮仅在当前编辑参数（opacity、focusX/Y、paused）至少一项与共享推荐 profile 不同时显示；媒体来源不参与此判断。点击只改草稿，应用才持久化；回到推荐值立即隐藏。选择媒体、应用/取消、恢复推荐、暂停/重试/清除进入同一个横向操作区，空间不足才自然换行；错误/状态信息独立排列，按钮不因显隐产生空白行。

实施切片：先保存本轮前状态，修改 `InterfaceBackgroundSettings.tsx` 的派生状态/预览/单一操作区及 `theme-background.css` 的行内对齐，再补既有 `theme-background-hardening.spec.ts` 的推荐显隐、键盘滑块、窄窗预览、应用/取消/刷新、按钮同排和媒体/暂停回归。Web lint/build、相关浏览器用例与实际 5173 截图/控制台完成后记录结果。本轮不改变 profile schema、存储/并发协议、主题配色、媒体或服务配置，不提交；证据编号 `2026-10-28/background-settings-controls`。

本机实现与范围验证完成：Web lint、TypeScript/Vite build、11 个不同 Chromium 用例及文档/仓库检查通过。新增的 5 项覆盖推荐按钮默认隐藏、可见度/焦点/暂停偏离后显示、恢复推荐后隐藏、媒体草稿不误触推荐、同一行无重叠、四场景在 1280px 的完整 20%–100% 预览、应用后按窗口策略显示、刷新持久化和取消恢复；其余 6 项回归播放恢复、阅读保护与 profile 隔离。不累计重复执行次数。

实际 5173 为本工作树 Vite + 既有共享包 dist；复用连接 IAB，检查 Ocean/Breeze 的滑块、状态提示、推荐显隐及同行按钮，留存 `live-breeze-100.png`、`live-recommended-final.png` 和 DOM/控制台记录。测试调整均取消，最终恢复原 Ocean、20%、焦点 50/50 的界面偏好页；真实页面未提交 profile 或媒体、未发送消息，新增 console error/warn 为空。daemon 仍离线，真实模型和原生发布未验收。第一轮 11 项日志保留；简化预览中央材质后重跑的 11 项才对应最终源码。

### 2026-10-28 设置卡片间距与实际首页可见度修正

用户报告所有主题的外观标题贴边、卡片相连，以及 Ocean 已保存 100% 后首页变化不明显。根因分别是：连续分区布局改成完整卡片后仍保留 gap=0、首卡无顶部 padding、末卡无底边的旧规则；首页全屏对比度 solver 在提高可见度时反向提高 workspace 覆盖。Ocean 在 60%/80%/100% 的图片有效曝光分别约为 36%/36.8%/36%，不是持久化失败。上节预览修正不能证明实际首页已经修复。

实施切片和职责：

1. 共享设置 CSS 统一卡片间距 16px、四周内边距 24px，去除相邻卡片内部补偿和末卡删边规则；不以主题 ID 特判布局。
2. 共享背景材质将开放画布染色改为随可见度递减，100% 时画布不额外覆盖原图。首页标题以局部字形 halo 保护，不新增矩形底板；正文、Composer、导航、菜单与桌面窗口控件保持各自阅读保护，工作页 45% 与窄窗策略不变。
3. 材质单测对每个可见度重新计算总曝光，覆盖六主题、严格单调和 100% 开放；浏览器覆盖六主题卡片边界/间距、四场景实际首页 60%→100%、刷新和既有阅读/播放回归。真实 5173 沿用用户 Ocean100 配置验证截图与日志，不启动 daemon。

本机实施与验收已完成，证据目录：`2026-10-28/settings-spacing-home-visibility`。共享 UI build 与 85/85 测试、Web lint/build、文档/公开仓库检查通过；Chromium 42 个不同用例通过，1 个既有录屏演示按规则跳过。首轮 41 项通过、1 项因森灵旧强调色断言失败；同步断言到此前已批准的 `#347b44` 后，该项与本次修改的加固用例共 13 项全部通过，不累计重复执行次数。四场景测试读取实际 scrim 与 workspace 的 computed style，验证总曝光从 60% 到 100% 明显增加，100% 为 1；六主题验证完整边框、24px 内边距、16px 卡片间距及无横向溢出。原有播放、存储、窄窗/强制颜色和三类会话阅读保护回归通过。

真实 5173 继续使用本工作树 Vite 与重建的 ui-react dist；Ocean100 刷新后 scrim/workspace 均为 0，标题背景透明且使用 2px 局部 halo，设置标题距卡片上边 25px（含 1px 边框），两处卡片间距为 16px。留存 `live-settings-before/after.png`、`live-ocean-100-before/after.png` 与 `live-dom-console.json`。共享包重建前曾因新旧接口混用产生开发 HMR 瞬时错误，刷新后完成首页/设置交互的新增 error/warn 为空。最终保留用户已保存的 Ocean100、焦点50/50及无草稿状态；未提交媒体、profile 或模型请求，未启动 daemon。原生签名包/真实模型仍未验收。之前 11 项通过仅证明其历史范围，不作为本次实际首页问题的通过证据。

### 2026-10-28 保存反馈与现行设置合同收敛

用户指出“背景已保存”持续显示并追问旧规则为何仍在。根因是背景编辑器自己的 `saved` 布尔值写成常驻状态，未接入已有共享 Toast；旧卡片规则在上一节已从唯一 CSS 定义原位删除，Git 历史和旧证据仅供追溯。当前模块文档明确以独立卡片为准，废弃规则不再通过主题覆盖保留。

实施切片：删除背景编辑器成功状态，保存及清除成功复用全局成功 Toast（稳定 scope、默认 3 秒、重入去重），错误仍内联；在已有反馈门禁登记背景编辑器为零独立计时器；同步界面偏好回归中仍要求两主题/导入入口/本地主题可选的旧断言，保留历史存储不可见且不删除的回归。验证成功通知真实关闭、连续保存去重/计时重置、失败持久且不误报、六主题卡片和 Web/Desktop 偏好交互。

本机实施与范围验证完成，证据目录：`2026-10-28/background-feedback-current-contract`。Web lint/build、文档/公开仓库检查与 `git diff --check` 通过；背景加固和界面偏好两个文件共 19 个 Chromium 用例全部通过。新增回归覆盖默认通知时长、连续保存去重与计时重置、清除媒体、持久化失败保留旧值/错误及成功恢复；同时覆盖六主题卡片和 Web/Desktop 偏好（Desktop 使用隔离桥夹具，不是原生包验收）。旧界面偏好用例已改为六套内置主题、导入/管理入口不可见、历史主题数据仍保留，删除了旧主题可选/别名验证的无效辅助代码。

源代码审查确认界面偏好卡片布局只有一个 CSS 定义和一次导入；上一节废弃的相邻补偿/末卡删边规则在当前源码中不存在。门禁要求背景编辑器零独立反馈计时器，避免用局部延时补丁恢复另一套生命周期。

实际 5173 使用 Vite 源码与既有共享包 dist；复用连接 IAB，将用户当前远行问剑 100% 暂改为99%保存，再恢复100%保存。顶部共享通知显示“背景已保存”，随后自动消失，背景区保留正确媒体来源说明，新增 error/warn 为空。留存 `live-toast-visible-restored-100.png`、`live-toast-expired-after.png` 和 DOM/控制台 JSON。最终仍为远行问剑100%、焦点50/50、无草稿；只验证本地 profile 保存，没有上传/清除用户媒体、发送消息或启动 daemon，没有提交远端。原生签名包与真实模型未验收。

## 分阶段实施与验证

1. **H1 阅读保护**：共享正文 surface、表格行实底、工作页背景减弱；截图检查亮色视频下正文、插件及空白区域。
2. **H2 播放统一**：共用播放器与 surface policy；验证设置只有预览播放、减少动态效果、窄窗、隐藏恢复、加载失败与显式重试。
3. **H3 构图偏好**：v3 迁移、跨主题隔离、焦点预览、应用/取消/推荐值；验证 Web 和 native 重启/回执/并发保持。
4. **H4 回归与状态收敛**：共享包测试、Web lint/typecheck/build、Desktop typecheck/focused tests；真实当前浏览器截图并检查日志与 overflow，保留用户媒体和数据。自动 fixture 只用于隔离回归，不替换现有 daemon。

桌面证据分层：本机 Electron IPC/restart smoke 可在本机执行；签名安装包、Windows/x64、Finder/Explorer 原生交互、长期 GPU/耗电与屏幕阅读器全集如本环境不具备则标 NOT_RUN，不能以 Chromium 或源码检查替代。

## 当前证据

实施前真实浏览器审查记录在 Codex 工件 `theme-audit-20261027/review.md`。代码修改前已在工件 `theme-hardening-20261027/before/` 保存受影响文件，并保存 staged/unstaged patch。既有 staged 主题改动保持不动。

本轮来源为 `gansx/theme-background` / `790eb2d37a787ca52cf7511edf1d9fa9d45e9c83` 加未提交改动。`theme-hardening-20261027/` 工件保存最终报告、日志、截图、源码 SHA-256 清单与修改前快照；这不是远端提交或发布证据。

| 验证 | 结果与证明范围 |
|---|---|
| 共享 UI / Conversation UI | 83/83、26/26 通过；主题模型迁移、profile 隔离/范围/digest、材质和共享消息样式 |
| Timeline 合同 | 21/21 通过；chrome 归属、单一 Timeline/scroll owner、类型化渲染路径 |
| 本地化 | 55/55 catalogs、6870 keys、15/15 测试；减少动态效果提示与“恢复”按钮文案一致 |
| Web 静态与构建 | typecheck、lint、i18n、production build 通过；保留既有大 chunk / 无效 dynamic import 提示 |
| Desktop | main/preload/renderer typecheck、codec/IPC/repository 9/9 通过；包含原子 profile 保存、回执重放、重启、跨主题保留和过期写入拒绝 |
| 实际 Electron macOS arm64 | 使用生产 preload/IPC/native codec 的隔离 smoke 通过；图片规范化、profile 提交、完整进程重启/恢复/清除/GC，以及 MP4/WebM 真实解码、时间推进、暂停；非签名安装包、非完整 Desktop UI 验收 |
| Full-window 浏览器回归 | 18 个通过、1 个独立录屏用例按设计跳过；媒体、IndexedDB、升级、竞态、20 轮资源回收、原生会话状态与保护路由 |
| Journey 组件验收 | production preview 2/2 通过；首页/会话/rail/dock/Composer/Overlay/设置及可访问性回退；新增工作摘要接口由本测试隔离，不请求用户 daemon |
| 阅读与偏好加固 | 6 个通过（分组执行，production preview 复核）；三类会话实底正文/透明布局、焦点/可见度隔离、取消/推荐值草稿、刷新保留、减少动态效果、暂停/恢复、首帧/重试、解码停滞恢复次数上限 |
| 浅深色会话回归 | 16/16 通过；普通会话、频道、队友私聊，含子 Agent 正文、引用、代码与交互事实颜色 |
| 真实连接浏览器 | 当前 5173 Vite + 原 daemon；首页、普通会话、Designer 私聊、插件和背景设置截图；短 AI 回复宽度随内容收缩，feed 外层透明，正文/表格行不透明；1280×720 无横向溢出 |
| 文档 | `check:docs` 408 个 Markdown 文件链接通过；`git diff --check` 通过 |

浏览器合计 42 个不同用例通过，另有 1 个录屏用例跳过；各组日志单独保留，失败首轮也保留为历史。停滞用例通过冻结测试播放器的时间进度并推进虚拟计时器，验证有界恢复；它不证明已经复现或消除了所有 GPU/compositor 黑帧问题。

真实页面沿用原花卉 MP4、远行问剑配色、`gpt-6-luna`、9 位队友及 2 条侧栏近期会话。焦点测试只修改草稿并取消，系统媒体偏好模拟已清除。本地原工作区没有频道，频道使用隔离 fixture 验证，未创建真实频道或调用模型。开发过程中一次 HMR context 更新出现过瞬时错误，刷新后的当前页面单独检查；不把整段开发日志称为零错误。

## 尚未关闭的发布验收

- **NOT_RUN**：签名 macOS arm64/x64 / Windows 安装包、完整 Desktop UI 的最小化/跨屏/高 DPR 生命周期、Finder/Explorer 原生拖放全集。
- **NOT_RUN**：长期 CPU/GPU/native RSS/耗电预算、屏幕阅读器全集、全部语言人工质量验收。
- 用户输入格式边界保持 PNG/JPEG/静态 WebP/MP4/WebM；GIF/APNG/动画 WebP/SVG 继续拒绝，本轮没有增加转换支持。
- 不以本机 Electron codec smoke 替代签名包验收；不以模拟停滞替代真实驱动/合成器问题复现。本轮没有提交、推送、合并或发布。
