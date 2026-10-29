# 共享组件与三主题外观验证记录

Codex 创建并验证于 2026-10-28。本文用于复核[组件合同](component-theme-presentation.md)及[实施方案](component-theme-presentation-implementation-plan.md)的本机交付，不代表发布或用户美术定稿。

## 当前 Breeze 自研背景（2026-10-29）

外部来源不明的 `forest-sky-v3.webp` / `forest-sky-v3-thumb.webp` 已删除，Breeze 改为本项目自研生成图 `forest-clearing-v1.webp`（1672×941，317870 bytes）与 640×360 同源缩略图（51878 bytes）。生成工具、完整提示词、负面约束与哈希见 [v7 清单](../../apps/web/public/themes/scene-themes-v7.sources.json)；Ocean/Night 资源未改动。

视觉复核要点：中央薄雾天空保持低细节低对比，正文与 Composer 可读性不受干扰；左上叶枝与右侧草坡只占边缘，不遮挡侧栏与面板；无人物、文字、水印、签名。浏览器实测结果见本轮验证表。

## 历史 Breeze 用户指定森林背景（2026-10-28，已由上述自研图取代）

用户否决上一张 StockCake 候选，直接指定上传的 5708×3212 PNG。本轮将该图完整无损导出为 `forest-sky-v3.webp`，同源缩略图使用 `forest-sky-v3-thumb.webp`；只替换默认资源与来源记录，保留上一轮绿色 UI、共享阅读保护和用户媒体优先级。源/导出像素及哈希见 [v6 清单](../../apps/web/public/themes/scene-themes-v6.sources.json)。原始作者与公开分发许可未独立确认，不沿用上一张图的 CC0。

本轮证据编号 `2026-10-28/breeze-user-forest`。主图 2003844 bytes、5708×3212，`webpinfo` 确认为静态 Lossless；同源缩略图 43214 bytes、640×360。源 PNG 原件、工作树快照、导出与最终来源哈希保存于本机证据目录。

| 检查 | 本轮结果与范围 |
|---|---|
| ui-react build / tests | 通过；重建实际 5173 消费的 dist；85/85 单测通过 |
| Breeze Chromium | 4/4；实际解码并断言新版资源 5708×3212，覆盖首页/缩略图、菜单/焦点、管理/设置保护、重载首帧、普通/私聊/频道正文、forced-colors 与窄窗；各例 console/page error 断言通过 |
| 浏览器环境 | 隔离 Vite `:4198`，禁止复用现有服务，daemon 为夹具；首次 grep 使用行首锚点未发现用例，移除锚点后执行以上 4 项，首轮日志保留，未放宽断言 |
| 实际 5173 | 复用 IAB，设置卡与首页确认新版图；DOM 为 `ling-breeze`、新版资源路径和原绿色 UI 参数；新增 console error/warn 为空。截图 `live-settings.png`、`live-home.png`，最终停留在 Breeze 首页供查看 |
| 文档/仓库检查 | `check:docs`、`check:public` 与 `git diff --check` 通过；本轮未改依赖或许可政策，用户供图权利状态单独登记 |

仅替换默认资源；可见度仍为 60%、焦点仍为 50/50，用户媒体优先级保持，其他主题与 UI 参数无改动。本地 daemon 仍离线，没有修改模型配置或启动服务；未调用模型、发送消息或改业务数据。本轮未重跑全仓 Web/原生发布测试，没有提交、推送或发布。下节测试与截图属于已被否决的候选图，不能作为本轮新资源验收。

## 历史 Breeze 候选图与 UI 改版（2026-10-28）

用户否决实拍森林并提供 WorkBuddy 清新森林参考。本轮改为现成森林插画、浅天空蓝底、鼠尾草侧栏和柔绿选中态、奶白 20px Composer、浅绿工具栏、绿色主操作/焦点，以及统一消息、引用、代码标题、卡片与浮层。未加边角/竖条/底线装饰。语义 manifest 与官方 CSS 同步，业务页面和组件继续共用消费者。

本机证据编号 `2026-10-28/breeze-illustrated-forest`；HEAD 仍为 `e97fdca53742bf8242effc0488fbc141eaf9e34e` 加本地未提交改动。`before/`、`before-status.z`、`before-hashes.json` 保存之前的 88 项工作树差异与源文件快照；本轮最终哈希、增量和验证结果另存本机，不使用旧截图替代本轮验收。

| 检查 | 本轮结果与范围 |
|---|---|
| ui-react build / tests | 通过；85/85，包括语义 manifest/CSS 同步、配色与背景阅读保护 |
| Web lint / build:ci | 通过；TypeScript + Vite 生产构建，保留既有大 chunk 提示 |
| 组件 Chromium | 11/11；新增 Breeze 首页/普通/私聊/频道四处 Composer computed style 一致；正文/消息/引用/代码、hover/pressed/disabled/loading/error、菜单键盘焦点、Dialog、强制颜色、六主题切换和管理表格；主题切换明确期待 Breeze 20px，未放宽断言 |
| 场景 Chromium | 12/12；三场景资源解码/配色/缩略图、首页/管理/设置保护/首帧、普通/私聊/频道阅读与透明对齐轨道。Breeze 明确断言新版资源 1024×576 和四个主色 |
| 浏览器错误 | 上述 23 个不同用例均通过各自 console/page error 断言；隔离 Vite `:4197`，禁止复用已有服务，daemon 为夹具，未真实调用模型 |
| 文档/依赖许可/仓库公开检查 | `check:docs`、`check:licenses`、`check:public`、`git diff --check` 通过；依赖许可检查不能替代美术来源权利记录 |
| 实际 5173 | 复用连接 IAB 的 Vite 源码 + ui-react dist，实际切换 Breeze 并检查首页/焦点/菜单/新建频道 Dialog/设置主题卡；未提交表单。服务仍离线，未改配置或启动新数据服务；重新加载后新增 console error/warn 为空 |

已人工查看首页、普通/频道/私聊、Dialog、缩略图与真实 IAB 截图。源图 [StockCake · Serene Anime Meadow](https://stockcake.com/de/i/ruhige-anime-wiese_2277689_1361523) 为来源站标注 AI 创作和 CC0 的现成图，本轮没有生成。原生 1024×1024，裁切 y=96..672 后导出 1024×576、137964 bytes；缩略图 640×360、40962 bytes，未放大，大屏/高 DPR 清晰度仍有限。源/导出哈希及裁切见 [v5 清单](../../apps/web/public/themes/scene-themes-v5.sources.json)。旧实拍资源保留回滚。

真实截图为 `live-breeze-*.png`；`components/` 与 `scenes/` 是实际生产组件在隔离 daemon 夹具下的截图，不表示用户数据或模型配置。验收后已恢复原 Night 主题与设置→界面偏好页，可见度及焦点仍为原值，留存 `live-restored-night-settings.png`。控制台保留了包热更新前的历史 ToastProvider 错误；本轮重新加载后未复现，未为此变更消息/Toast 代码。未执行全仓 Web 单测、真实模型、原生签名发布、跨平台或长期性能验收；没有提交、推送或合并，美术确认仍待用户审阅。

以下为历史轮次，资源与结果只对应各自当时的源码，不代表本轮 Breeze。

## 源码和证据归属

- 工作树标识：`photo-themes/ling-stack`，detached HEAD `e97fdca53742bf8242effc0488fbc141eaf9e34e` 加本地改动。
- 本机证据编号：`2026-10-28/component-theme-refinement`；日志与截图保存在执行者本机证据库，未随仓库发布。
- `before/`、`before.patch`、`before-status.txt` 保留本轮之前的源码和已有主题改动；`final-source.sha256`、`final-status.txt` 绑定最终本地来源。没有提交、推送、PR 或合并。
- 5173 为本工作树的 Vite 开发服务，ui-react/conversation-ui-react 样式由其已重建的包产物提供；测试为隔离 daemon 夹具下的真实生产组件，不替换用户后台或数据。

后续主题开发规范同步仅修改文档，并清理了本页的个人绝对路径。原运行时记录继续对应当时的源码与截图；旧哈希清单中的文档项属于当时版本，当前文档变更另按文档检查验收，不能据旧截图证明新的运行时行为。

## 实施结果

1. 默认组件参数进入 `ling.tokens.base`，三主题参数进入 `ling.tokens.theme`；共享组件读取变量，页面保留布局。三类会话和首页 Composer 的背景、圆角、默认/聚焦边界、阴影和工具栏 computed style 一致。
2. 清除首页 dark 阴影和三类 Composer 页面独立外观，清理导航重复选中规则、频道新建 Dialog 遮罩/外观、模型菜单与摘要浮层圆角/阴影覆盖。
3. 控件、导航/快捷入口、消息/引用/代码、管理卡片/表格和浮层分别消费对应组件参数；Night/Ocean/Journey 的 Composer 为 10/18/14px，Menu 为 8/14/10px，Dialog 为 10/18/14px。
4. 背景计算与设置预览读取同一主题基准，保留对比度保护、未知颜色实底和既有每主题媒体偏好协议。

## 可执行检查

| 检查 | 结果 | 日志与边界 |
|---|---|---|
| ui-react build / tests | 通过；85/85 | `ui-build-final.log`、`ui-tests-final.log`；含材质基准、clamp/NaN、未知颜色与对比度保护 |
| conversation-ui-react build / tests | 通过；26/26 | `conversation-build-final.log`、`conversation-tests-final.log` |
| Web lint / TypeScript + production build | 通过 | `web-lint-final.log`、`web-build-final.log`；保留既有大 chunk 等构建提示 |
| 组件浏览器 | 8 个不同用例通过 | `components-browser-r7.log` 的 7 项，加 `regression-followup.log` 的管理卡片/模型表格 1 项；首页/普通/频道/私聊一致、加载/错误、按钮 hover/pressed/disabled、菜单键盘 focus、弹窗、forced-colors、切换恢复 |
| 场景和背景回归 | 38 个不同用例通过、1 项演示录屏跳过 | `regression-browser-final.log` 与 `regression-followup.log`；包含 Photo 12、Journey 2、背景 18、hardening 6；分组执行，重复复验不累计 |
| Web 全套单测 | 592 通过、1 项环境阻塞 | `web-tests.log`：execution-engine-manager-http 在导入缺失的 `packages/daemon/dist/index.js` 时失败，未进入业务断言；尝试构建 daemon 又因 browser-host 缺少 workspace 依赖失败，见 `daemon-test-build.log`。未改变依赖或服务配置来绕过 |

浏览器合计为 **46 个不同用例通过、1 项演示录屏跳过**。首次背景回归仍期待海滩旧蓝色 `#235e7c`；已按当前珊瑚 `#b44536` 和机甲铜金 `#e7b38b` 修正明确断言，并增加已确认背景资源路径断言，复验通过；未放宽阈值或删除断言。首轮输出和失败现场保留在 `regression-first-results/`。

Journey 最终增量复验通过 `LING_THEME_COMMIT_SHA=working-tree@e97fdca53742bf8242effc0488fbc141eaf9e34e` 标注来源；早期截图元数据的默认提交标记不作为最终来源。所有代码与资源以最终哈希清单为准。

## 真实连接浏览器

复用用户当前 `http://127.0.0.1:5173/` 页面，通过设置 UI 依次切换 Ocean、Journey、Night，最终恢复原 Night。未填写消息、调用模型或创建真实频道。

- 真实 computed style：Ocean 暖白 Composer/浅青工具栏/18px，Journey 墨蓝/14px/暖金聚焦，Night 石墨/10px/内高光与集中暗影。
- Ocean 频道菜单为 14px，打开的新建频道 Dialog 为 18px；取消后返回。Night 设置页面保持实底。
- 三主题首页未发现横向溢出；记录视口为 1436×1344。窄窗、正文、频道/私聊与管理页由上述隔离浏览器用例覆盖；没有移动端验收。
- 当前控制台 error 查询为空；页面仍显示“本地服务暂时不可用”。原 daemon 未在线，模型/队友/会话的真实数据和推理路径无法在本轮验收。没有启动空数据后台、删除模型或更改用户媒体配置。

真实截图在 `live/`：`ling-ocean-home.png`、`ling-ocean-dialog.png`、`ling-journey-home.png`、`ling-journey-focus.png`、`ling-night-home.png`、`ling-night-settings.png`。`components/` 保存三主题各类会话、加载/错误/聚焦/弹窗、队友/模型列表，以及临时隐藏背景后的组件对比图；隐藏背景仅发生在测试页面。

## 未证明的范围

真实 daemon/模型调用、签名 Desktop 安装包、跨平台及长期 GPU/耗电测试未执行；沿用[背景合同](theme-background-hardening-plan.md)的发布验收边界。上述限制不影响本轮共享组件与三主题 UI 的本机实现结论，但不能据此声称全部项目测试、真实模型或 Desktop 发布验收通过。

## 第二轮：组件辨识度深化（2026-10-28）

本节为首轮及文档规范同步之后的独立增量记录。源码仍是 detached HEAD `e97fdca53742bf8242effc0488fbc141eaf9e34e` 加本地改动；本机证据编号为 `2026-10-28/theme-identity-refinement`。`before/`、`before-source.json` 和 `before.patch` 保存本轮前已有的 87 个修改/未跟踪文件；本轮增量与最终源码哈希单独留档，旧轮截图和哈希不代表当前实现。没有提交或发布。

### 实现与视觉复核

- Night 增加石墨金属内高光、Composer 四角短刻线、方正导航/快捷入口及铜金竖标记；Ocean 使用奶白上高光、浅青底缘/标题层、柔圆导航与快捷入口；Journey 使用平整墨蓝、Composer 短金线、导航短下划线和较弱阴影。
- 消息、引用、代码标题、卡片/表头、Menu/Dialog/Toast、Badge 和空状态底托在共享入口消费参数；默认值保持无装饰回退。未改变主题背景、Logo、布局尺寸、命中区域、业务状态、API、schema、依赖或模型配置。
- Composer 装饰为 `pointer-events: none` 的静态伪元素；forced-colors 清理放在更晚的 `ling.utilities` 层，避免主题层重新覆盖。ghost/danger 操作继续使用原语义表面。
- 人工检查了 `components-verified/` 的三主题无背景对照、Dialog、消息/代码、导航与管理页，以及 `live/` 的实际页面截图；可见差异集中在形状、工具栏、标记和浮层材质。美术定稿仍待用户复核。

### 本轮验证

| 检查 | 结果 | 本机证据 |
|---|---|---|
| ui-react build / tests | 通过；85/85 | `ui-build-final.log`、`ui-tests-final.log` |
| conversation-ui-react build / tests | 通过；26/26 | `conversation-build.log`、`conversation-tests.log` |
| Web lint / TypeScript + production build | 通过 | `web-lint-final.log`、`web-build-verified.log`；构建保留已有大 chunk 提示 |
| 组件、照片场景和 Journey 浏览器组合回归 | 23 个不同用例通过 | `browser-verified.log`；组件 9、照片场景 12、Journey 2，不将重复复验累加 |
| Journey 来源标记复验 | 2/2 通过，属于上述 23 项 | `journey-tests-verified.log`、`journey-verified/`；显式设置当前 working-tree 来源标记 |
| 文档、许可证、公开仓库检查与空白检查 | 通过 | `docs-check.log`、`licenses-check.log`、`public-check.log`、`diff-check.log` |

组件回归覆盖首页/普通/频道/私聊 Composer 的背景、材质、边角、工具栏和焦点一致性，按钮 hover/pressed/disabled、加载/错误，Menu/Dialog、六主题切换清理和 forced-colors；1280×800 验证导航选中标记、快捷入口、输入及弹窗命中、草稿保留和无横向溢出。引用与代码标题的实际 computed color/background 对比度逐一断言不低于 4.5。

首次新增导航测试在首页查找不存在的 `.nav-item.active` 失败，现场保留在 `browser-tests-first.log` / `browser-results/`。检查发现顶部“新建对话”有独立硬编码外观，已将其接入共享导航入口；测试同时检查顶部按钮，并实际进入插件管理检查选中项，复验通过。未删除或放宽断言。早期 Dialog 截图捕到淡入中间帧，已等待字体和有限动画完成，并断言实底与 opacity 后重拍；早期截图仅作过程记录。

实现审查中 Journey 引用底初拟 `#16232d` 配辅助文字 `#758893` 的对比度约 4.34，已调整为 `#101b25`，对比度约 4.73，并通过以上浏览器断言。组合回归中的 Journey 截图使用旧默认来源元数据，故另行显式设置 `LING_THEME_COMMIT_SHA=working-tree@e97fdca53742bf8242effc0488fbc141eaf9e34e` 重跑两项；最终使用 `journey-verified/` 和本轮哈希清单绑定来源，不引用旧默认标记。

### 真实页面与范围边界

复用用户已打开的 5173 页面，通过设置依次切换 Night、Ocean、Journey，并实际检查聚焦、频道菜单、Ocean 新建频道弹窗及 Night 实底设置页。弹窗取消，未创建频道或发送消息；最后恢复原 Night、紧凑侧栏和原未发送幻灯片草稿。`live/browser-console.json` 中本轮 error/warn 查询为空；真实截图含 `night-focus-after.png`、`ocean-focus-after.png`、`ocean-dialog-after.png`、`journey-focus-after.png`、`night-settings-after.png` 和 `night-restored-after.png`。

当前页面仍显示“本地服务暂时不可用”，实际用户数据及真实模型推理未验收；会话与管理页采用独立 4197 端口的隔离 daemon 夹具验证生产组件。未启动空数据后台、替换用户配置或更改现有服务。本轮未重跑 Web 全套单测，首轮已记录的 daemon 构建依赖环境阻塞未在本轮修复；签名 Desktop、移动端、长期 GPU/耗电和用户美术定稿不在本轮已证明范围内。

### Night 导航边缘视觉修正（2026-10-28）

用户反馈“新建对话”按钮像有错位。5173 实页测量确认按钮为 272×34px，图标与文字的纵向中心均为 77px，组合水平居中；没有 transform 或叠加伪元素。观感来自透明边框内的上亮、下暗两条不对称 inset 阴影。将 Night 共享 `--ling-navigation-selected-shadow` 改为四边一致的 1px 弱铜金内描边，保留配色和轻渐变，展开按钮及其余选中导航同步消费，不调整布局位置。

本机增量证据编号：`2026-10-28/theme-navigation-edge-fix`，原有第二轮截图中的 Night 导航边缘仅作修正前对照。ui-react 构建通过；现有六主题切换和三主题窄窗/命中/焦点/弹窗两项浏览器用例通过。5173 实际点击验证通过，修正前后按钮及子元素几何信息一致，控制台 error/warn 查询为空；`before.json`、`after.json` 与前后截图绑定本轮来源。未更改用户配置或服务，未提交。

### 移除 Night Composer 四角刻线（2026-10-28）

按用户明确要求，删除 Night 的 `--ling-composer-decoration` 四角刻线覆盖，默认与聚焦均继承共享的 `none`。保留石墨材质、边框、工具栏及聚焦高亮；首页、普通会话、频道和私聊由同一 Composer 同步生效。已同步当前设计合同，早期含刻线的截图只作历史记录。

本机增量证据编号：`2026-10-28/night-composer-decoration-removal`。ui-react 构建和现有组件浏览器 9 项用例通过，包含四类 Composer 默认/聚焦装饰为 `none`、六主题切换清理，以及其他两主题原有装饰与交互的回归。5173 开发服务使用已重建的共享包样式，实页默认和聚焦状态均确认刻线消失，保存 `live-default.png`、`live-focus.png` 及 computed style；控制台 error/warn 查询为空，验证后返回用户原来的界面偏好页。未发送消息、修改配置或操作后台服务；真实 daemon 仍离线，未进行模型调用验收。未提交。

### 移除 Journey Composer 顶部短金线（2026-10-28）

按用户要求，原位删除 Journey 的 `--ling-composer-decoration` 和 `--ling-composer-focus-decoration` 覆盖；默认与聚焦均继承共享 `none`。保留墨蓝表面、冷蓝边框、暖金焦点边框和工具栏；首页、普通会话、频道和私聊共用此修改。当前合同已移除短金线要求，第二轮的含线描述和截图仅作历史记录。

本机增量证据编号：`2026-10-28/journey-composer-decoration-removal`。ui-react 构建通过；现有组件浏览器 **11/11** 用例通过，包含四入口默认/聚焦一致性、四主题组件状态、六主题切换回退、窄窗命中和管理列表。浏览器回归使用独立 4200 端口及隔离 daemon 夹具，没有替换用户服务。

复用已有 5173 开发页面，使用已重建的共享包样式：Journey 默认和聚焦的 `::before` 背景均为 `none`，边框分别为 `rgb(72, 96, 111)` 与 `rgb(196, 154, 99)`，正常焦点阴影保留。已人工查看实页截图，保存 `live-default.png`、`live-focus.png`、`live-styles.json` 和 `live-console.json`；控制台 error/warn 查询为空。保留原主题、背景偏好和空草稿，最后取消输入框焦点。页面的既有服务离线及模型未配置提示仍在，真实模型调用不属于本次装饰修正验收。未发送消息、改配置或启动服务；未提交。
