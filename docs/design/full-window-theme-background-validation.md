# 整窗静态背景实现与本机验证记录（历史）

> 已被后续实现接管。本页中的分支 SHA、远端提交差距、三档设置和测试数字均为历史快照；当前行为与验证读取[阅读与播放加固合同](theme-background-hardening-plan.md)及[当前验证记录](scene-theme-background-validation.md)。

Status: historical local implementation evidence for the superseded static-image P2; not evidence for official scene themes, MP4/WebM wallpapers, continuous opacity, or the official-only theme boundary  
Owner: theme and presentation delivery track  
Last verified: 2026-10-21；2026-10-23 起由[官方场景主题与自定义媒体背景实施方案](full-window-theme-background-implementation-plan.md)接管后续交付  
Document type: implementation evidence and remaining acceptance gates  
Source: `gansx/theme-background`，`912e3e8e835f68a0d62161e3d5694ce9f9f7c6cb` + 当前未提交改动；本轮完整文件摘要保存在本地 `.ling-stack/acceptance/theme-background-photo-refinement/source-snapshot.json`，前轮 P2 与圆形波纹证据保留为历史。当前 `origin/main` 为 `9be62fed`，本报告只证明所列源码快照，不代表已重新同步这 67 个提交。  
Related: 当前[合同](theme-background-motion-contract.md)、[任务](full-window-theme-background-implementation-plan.md)、[矩阵](full-window-theme-background-acceptance-matrix.md)；本文件只保留旧 P2 证据

## 已交付行为

“设置 → 界面偏好 → 背景”可选择或拖入单张本地图片，先预览，再应用；支持三档可见度、替换、取消和恢复默认背景。切主题保留图片，材质读取新主题语义色；清除背景不重置主题。

共享头部检查在解码前限制输入：PNG、JPEG、静态 WebP；16 MiB、单边 8192、1600 万像素。APNG、动画 WebP、其他格式、伪扩展名和超界头部拒绝。方向/色彩规范化后，等比例缩小到单边 2560、400 万像素以内，不放大、不裁切；保存 PNG 仍有 16 MiB 硬限制。Web 使用高质量 sRGB Canvas 缩放，输出大小先于数组分配检查；Desktop 调用现有 Rust helper 的显式 `--background` 模式，artifact 原调用保留原尺寸语义。预览与提交使用同一规范化 PNG，界面告知保存尺寸，源文件保持不变。既有持久描述仍可读取此前有效的较大背景。主题包 D1=A 和 Quick D3=A 保持原边界。

Web 在 `ling-stack-ui2` v4 新增两个独立 store，同一事务发布图片、revision、引用和当前回执。旧主题与草稿保留，连接响应 versionchange，blocked 可恢复，迟到连接关闭。Desktop 在 `userData/backgrounds` 下保存，主进程串行化、同卷暂存、同步文件、原子替换配置后回收；配置是恢复权威。两端均阻止 stale revision、重复 ID 改 payload 和 clear 后的旧请求复活。

App 根部只有一张装饰图片，使用统一 `cover center`；普通工作区、桌面窗口顶部栏和展开 dock 透出同一坐标，顶部栏左侧前导区复用侧栏材质，中间标题区与工作区材质一致，正文、代码、输入与弹层继续使用不透明表面。保护路由、forced colors、减少透明度及窄窗优先回退；1280 以下强档限为均衡。材质比较黑/白最坏底色，必要时增加覆盖；无法可靠解析颜色时不透明。背景变化不重挂 AppShell，也不改变执行引擎选择。

首页与普通工作区共用 0.55 / 0.40 / 0.25 三档全窗遮罩。主画布使用主题解析的稳定轻材质，让三档真实改变照片可见度。桌面窗口顶部栏也接入同一材质：左侧标题栏前导区与侧栏使用 0.68 结构底色，中间标题栏和窗口控制区与工作区使用同一透明材质；背景模式不绘制贯穿整窗的底部分隔线，设置、审批等保护路由继续使用不透明标题栏及原有结构分隔。侧栏浅色、深色都使用 0.68 结构底色，默认菜单行、分组标题和普通列表行保持透明；仅悬停、选中和键盘焦点使用主题 `action.selection` 表面，背景启用时弱化文字使用 `text.default`。因此 balanced 下侧栏连续透出照片，不形成逐行横框，菜单内容和焦点仍保持清楚；未知颜色语法回退不透明侧栏。标题与标志不增加局部黑底，标题只使用紧贴文字的主题底色晕影；快捷按钮、正文、代码、输入和弹层继续保持清晰实底。未设背景时标题与标志仍居中。

文件位于有效拖放区时显示 1px 主题焦点色边界和 5% 强调色底。放下文件后，距离落点最近的边缘出现一段 56px × 2px 的焦点色微光，沿边缘移动约 13px，在 180ms 内淡出；背景导入同时把业务状态改为“已接收，正在处理…”。减少动态效果和强制颜色模式不渲染移动微光，只保留静态边界与状态文字。圆形波纹已从实现、测试和当前证据中移除。

草稿、持久偏好和可渲染资源分别拥有状态。候选处理串行，更新 generation 后丢弃迟到解码；离开设置清理草稿，已发出的持久提交由全局控制器核对。刷新合并为单个处理队列；释放 ImageBitmap、Canvas、候选与 object URL。静态背景没有持续动画或计时器。提交回执丢失后重新读取权威；已确认提交即使随后读图失败，也保留其偏好并回退纯色。

## 本机证据

执行机为 macOS arm64；Chromium 的设备配置使用 Desktop Chrome UA，不代表 Windows 原生验收。Web 为当前工作树的 Vite 源码及最新工作区依赖 dist；daemon 使用受控 fixture，不运行模型或真实 Run。本轮交互与录屏由 Playwright 驱动实际 Chromium 完成，未把旧 IAB 截图当作当前材质证据。

| 检查 | 本轮结果与证明范围 |
|---|---|
| UI 纯测试 | 7 项通过：背景模型、内容材质最坏底色、主画布 balanced 对比度与三档单调可见度、侧栏跨明暗主题透出与菜单/焦点对比度、资源限制与输出尺寸 |
| 本地化 | 55/55 catalog、6806 键通过；本轮 25 个 `background.*` 键在 53 个目标语言中增量翻译，中英文来源保持人工文案 |
| Desktop focused tests | 7 项通过：背景仓库、IPC、真实照片 codec、崩溃检查点与故障清理；无关 handlers 保留 |
| Chromium E2E | 14 项 P2 + 7 项 P1 通过；2026-10-21 顶部连续材质与侧栏调整后，`full-window-background` 为 14 passed、1 个独立录屏用例按设计跳过，`dark-photo-visual-acceptance` 为 1 passed。覆盖真实照片、统一三档遮罩、无顶部贯穿分隔线、侧栏默认透明行与交互态、无标题黑底、56px × 2px / 180ms 主题焦点色边缘微光、reduced-motion、IndexedDB、升级阻塞、跨标签页、事务失败、损坏、20 轮资源回收、迟到解码及原生选择五种状态 |
| 实际 Electron | 真实 4K 照片经生产 preload + IPC + 主进程仓库 + native codec 缩为 2560×1150；保存 → 完整退出进程 → 恢复 → 清除 → 再次完整退出 → 无图；临时 userData 隔离，未签名开发运行 |
| 崩溃恢复 | 在 asset-staged、asset-published、config-staged、config-published 检查点直接退出独立 Node 子进程；重新创建仓库后，提交点前无图、之后有图；暂存回收 |
| 当前视觉证据 | Fronalpstock 与 Dark mountain panorama 两张有许可的真实照片；暗色照片覆盖 light 三档与 dark balanced，顶部照片连续且无贯穿分隔线、标题无局部底板、正文/输入实底；另有 light balanced 侧栏及顶部栏默认、悬停、键盘焦点和选中态截图，计算样式确认标题栏主区域与工作区一致、前导区与侧栏一致、结构层 0.68、默认菜单与分组层透明，浏览器 console/page error 监听为零 |
| 动态证据 | 原速 WebM 记录真实 CSS 时长的卡片柔光、绿色拖入边界和 180ms 边缘微光；另存标明 4 倍慢放的局部片段。合成文件拖放事件不能替代 Finder/Explorer 跨窗验收 |
| 编译与规范 | Web / Desktop TypeScript、Web production build、lint、Web check:i18n、完整 55 语言 catalog 审核通过；文档链接、许可证、public safety、diff whitespace 见本轮最终检查 |

本轮当前证据位于 `.ling-stack/acceptance/theme-background-photo-refinement/unified-material-edge-glint/`：`video.webm` 是原速完整录屏，`edge-glint-4x.webm` 是标明 4 倍慢放的局部复核片段，`green-photo-home.png` 与 `opaque-conversation.png` 分别证明首页统一材质和会话实底，`motion-markers.json` 记录微光的 0.18s、主题焦点色与最近边缘。旧 `.ling-stack/acceptance/theme-background-p2/` 及本目录其他圆形波纹文件只作历史证据。

浅色/深色照片可见度证据位于 `.ling-stack/acceptance/theme-background-photo-refinement/light-dark-photo/`：输入为 Wikimedia Commons 的 [Dark mountain panorama](https://commons.wikimedia.org/wiki/File:Dark_mountain_panorama.jpg) 3840×2051 缩略图（Dreamy Pixel / Ales Krivec，CC BY 4.0，SHA-256 `36cfa069101785df232908458551dacf7c333d1398c03ddb3c913926dd907701`）；`ling-light-*-dark-photo-home.png` 记录浅色三档，`ling-dark-balanced-dark-photo-home.png` 记录深色均衡档，`browser-evidence.json` 记录实际 CSS、图片摘要以及零 console/page error。该图片与截图只作本地验收证据，不作为产品内置壁纸。

侧栏与顶部栏分层证据位于 `.ling-stack/acceptance/theme-background-photo-refinement/sidebar-material/`：`ling-light-balanced-dark-photo-home.png` 与 `ling-dark-balanced-dark-photo-home.png` 记录相同 0.68 结构底色下的明暗主题效果，且照片连续覆盖标题栏；`ling-light-balanced-sidebar-hover.png`、`ling-light-balanced-sidebar-focus.png` 和 `ling-light-balanced-sidebar-selected.png` 记录局部交互表面；`browser-evidence.json` 绑定输入图片、标题栏/侧栏计算样式、视口及零 console/page error。2026-10-20 另用现有 IAB 标签页通过可见系统文件选择器重新导入并应用同一照片，确认浅色侧栏空白区连续显示山体，菜单与输入卡保持清楚；该人工复核使用当前 Vite 源码，未代替安装包验收。

主要复验命令：

```sh
corepack pnpm --filter @ling-stack/ui-react build
corepack pnpm --filter @ling-stack/ui-react exec node --test test/background-model.test.mjs
corepack pnpm --filter @ling-stack/localization test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test theme-motion-pilots.spec.ts full-window-background.spec.ts
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop exec node --test tests/background-repository.test.mjs tests/background-ipc.test.mjs tests/background-codec.test.mjs
corepack pnpm --filter @ling-stack/desktop exec node tests/background-electron-smoke.mjs
```

Desktop codec 测试先运行 daemon 的 `scripts/build-image-sanitizer.mjs`；资源路径测试先构建 Web。Electron smoke 在本机 macOS 使用安装于当前项目的 Electron，不替代完整产品启动与包内资源验证。其他平台必须使用其实际 helper 和 Electron executable。

## 性能起点

本轮使用有细节的真实照片，不使用纯色或渐变图作为视觉/性能依据；微型合成输入仅用于协议与边界测试。

| 照片 | 输入 → 保存尺寸 | native 处理约耗时 |
|---|---|---|
| 用户提供的雪山照片 | 4096×2304 → 2560×1440 | 306ms |
| Hannes Röst 的 Fronalpstock | 3840×1725 → 2560×1150 | 118ms |
| Richard Palmer 的 Lake Mapourika | 2048×1536 → 2048×1536，不放大 | 48ms |

两张网络照片来自 Wikimedia Commons，均使用 CC BY-SA 3.0；Fronalpstock 作为测试 fixture，其来源/许可见 [fixture 说明](../../apps/web/e2e/fixtures/README.md)，湖景仅存本地验收目录。不是产品内置背景。

本机 Chromium 的 Fronalpstock 测量：1440×960 / DPR 1，处理约 315ms，应用约 160ms，PNG 6,348,908 字节。固定预算仍为处理和应用各小于 2 秒。20 轮替换/取消/清除后 object URL 为 0，强制 GC 后 renderer JS heap 增量 1,014,732 字节，预算 16 MiB。精确读数以本轮 `performance.json` / `resource-cycles.json` / `native-photos.json` 为准。前轮渐变图读数仅为历史，不能替代此轮照片证据。

动态演示的 `video.webm` 保持实际时长；`edge-glint-4x.webm` 是局部 4 倍慢放，产品动画仍为 180ms。`motion-markers.json` 记录主题焦点色、最近边缘和时长。静态背景本身没有动画；视频/程序背景未实现。

这些预算只覆盖指定 fixture、执行机和测量口径；JS heap 不包含图片解码内存、GPU 和整个进程 RSS。静态图无空闲动画；输入像素限制和候选串行属于硬上界。各平台仍需记录 4K/上界图的 native RSS、DPR、空闲 trace 和响应时延，才能关闭 BG-22。

## 矩阵状态与放行边界

以下为本机已有证据；“局部通过”表示不能关闭整条矩阵要求。各目标安装包全部保持待验收。

| ID | 本机结论 | 未关闭部分 |
|---|---|---|
| BG-01/02 | 共享头部、浏览器处理、实际 codec 的格式/方向/色彩与限制通过 | 目标包格式全集和平台色彩显示复验 |
| BG-03/04 | 单根图片、主题保图、只换图保色、dock 和状态自动化通过 | 各平台原生窗体与展开组合截图 |
| BG-05/06 | 最坏底色纯测试；真实照片三档、light/dark/green 首页与工作区统一遮罩；侧栏结构跨明暗主题固定 0.68、默认行透明，hover/focus/selected 语义实底；背景模式顶部无贯穿分隔线；标题无局部黑底；会话/输入实底；不确定颜色不透明 | 极端图片与自定义主题全集的人工可读性检查 |
| BG-07/08 | 中央策略全部保护 surface 的纯测试，设置/强制颜色/窄窗运行测试 | OS 减少透明度偏好、各保护业务路由及弹层全集 |
| BG-09 | 预览/取消/应用/清除与硬刷新通过 | 各目标包的相同操作 |
| BG-10/11/12 | 原子性、重复回执、stale writer、清除旧请求、失败恢复、迟到解码、提交中离开设置通过 | 目标包实测相同故障 |
| BG-13 | main-frame sender、exact payload、字节界限、受管路径/符号链接及 handler 并存通过 | 目标包的同用户权限边界实测 |
| BG-14 | 独立进程四个提交检查点退出/重开通过 | 目标包强退与清理期间的中断复验 |
| BG-15/16 | 缺失/损坏保留引用、纯色恢复；Web reload 与实际 Electron 完整进程重启通过 | 延迟启动录屏、签名包首帧与系统恢复 |
| BG-17 | 20 轮 URL/heap、离开设置、串行候选与释放通过 | 上界图长期 native/GPU 内存与窗口隐藏轨迹 |
| BG-18 | 中英文目录、英文自动化、键盘应用/取消、单次状态播报通过；减少动态时无移动微光 | 完整屏幕阅读器和 OS 选择器键盘验收 |
| BG-19 | 7 项 P1 回归通过，Quick 仍只生成 tokens；主题焦点色、56px × 2px 和 180ms 有自动化断言 | 各目标包安装/导入全集 |
| BG-20 | native ready/blocked/pending/error 与 Pi 的草稿、焦点、发送权限不变，无额外 Run | 各包真实 engine profile、文本选择、滚动和工作区切换组合 |
| BG-21 | 前轮 IAB 真实文件选择仍适用；本轮 Chromium synthetic drop 通过 | Finder/Explorer 跨窗真实拖放、多文件/取消原生选择器全集 |
| BG-22 | 真实 4K 照片缩小、处理/提交时延和 JS heap 起点固定，局部通过 | native RSS / GPU / 高 DPR 与目标机器预算 |
| BG-23 | 缺能力不写 Web 背景 store；codec 实际调用、退出/超时/取消；实际 Electron IPC 通过 | 最终包资源/错架构/缺失、签名后摘要与辅助窗检查 |
| BG-24 | v3→v4 保留主题/草稿、blocked 后恢复、跨 tab 冲突；保留 v4 opener 的兼容读取通过 | 实际回退安装包与重新升级；不能使用旧 v3 opener 回退或删 DB |

T1–T6 的实现已落地，本机可操作验证已执行；55 语言 catalog 门槛已关闭。T7 的完整矩阵放行仍有人工/性能项，T8 未关闭。macOS arm64/x64、Windows 的签名安装包、Finder/Explorer 原生拖放、native 内存与回退安装包尚无本轮证据，不能标记产品跨平台完成。视频、程序背景、自动取色与主题包运行时 artwork 继续不开放。
