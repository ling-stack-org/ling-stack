# Ling Core IP 设计合同

Status: V1.2 水墨灵台心印已落地，等待视觉验收  
Owner: theme and presentation delivery track  
Last verified: 2026-10-24  
Document type: product identity, motion and brand-mark contract  
Related: [官方场景主题、背景与交互动效统一设计方案](theme-background-motion-contract.md)、[官方场景主题与自定义媒体背景实施方案](full-window-theme-background-implementation-plan.md)

## 0. 当前原型状态

- 组件：`@ling-stack/ui-react` 的 `LingCoreMark`，源码在 `packages/ui-react/src/brand/LingCoreMark.tsx`，样式在 `packages/ui-react/src/styles/brand/ling-core-mark.css`。
- 视觉资产：`apps/web/public/brand/ling-core-ip.webp`。这是从选定水墨稿制作、去掉纸张背景后的透明 WebP，保留斜月、雾山、水面倒影和中心暖光。
- 已接入：Web 首页空态。产品 Logo 继续用于侧栏、应用图标和正式品牌位。
- 形态：斜月弧从右上方托住视线，三颗星点依次浮出，底部雾山形成极轻的灵台，中心暖光作为“心”。
- 动效：三颗星点按 `220ms / 620ms / 1020ms` 错峰出现；水墨场景整体有极轻呼吸。`data-state` 支持 `idle`、`thinking`、`receiving`、`completed`、`blocked`。
- 颜色：水墨主体使用固定的银灰、雾蓝和暖白；三颗星点、光晕和状态反馈取主题语义 token。
- 无障碍：只在 `prefers-reduced-motion: no-preference` 下播放动效；减少动态时直接显示完整画面；`forced-colors` 下保留星点和轮廓。
- 资产来源：选定稿保存在 `.ling-stack/acceptance/ling-core-mark/direction-b-inkwash.png`；透明生产资产与验收截图位于同一目录，不含第三方 IP、文字或水印。

## 1. 方向

Ling 的核心识别不是卡通吉祥物，而是一个**水墨灵台心印**。

它来自三层含义：

- Logo 顶层的连接节点，对应三颗依次出现的星；
- “灵台方寸山、斜月三星洞”共同指向的“心”；
- Ling 在工作台上思考、编排和陪伴时的那一点清明。

因此，核心画面只保留四个元素：

- 一道斜月；
- 三颗少量星点；
- 一层雾山/水面灵台；
- 一点暖色心光。

不画脸、手脚、卡通身体、古装人物、动物、法器、山洞或法阵。品牌感来自留白、节奏和光，而不是角色表情。

## 2. 视觉结构

| 元素 | 作用 | 规则 |
|---|---|---|
| 斜月 | 建立方向和“斜月”文化语义 | 一笔细弧，右下收锋，不闭合成环 |
| 三星 | 连接、思考、协作 | 三个大小不同的点，不排成对称皇冠 |
| 灵台 | 雾山与水面形成承托 | 边缘必须化开，不能成为硬质底座或卡片 |
| 心光 | 视觉中心与温度 | 暖白低饱和，强度低于正文与主按钮 |

三颗星的位置参考选定稿：右上、中央偏上、左下，形成一条不完全规则的斜线。它们不能连成网络图，也不能被理解为光环。

## 3. 动效时间轴

| 时间 | 事件 |
|---|---|
| 0–620ms | 斜月与雾山从低透明度缓慢显形；心光轻轻亮起 |
| 220ms | 第一颗星出现 |
| 620ms | 第二颗星出现 |
| 1020ms | 第三颗星出现 |
| 完成后 | 水面与心光做 5.2 秒呼吸，三颗星极轻漂移 |

三颗星必须错峰出现，不能同时弹出。位移保持在约 1–2px，整体动画可中断、可静止。

| 状态 | 动效 |
|---|---|
| `idle` | 水墨画面轻呼吸，三颗星缓慢漂移 |
| `thinking` | 整体呼吸略加深，出现轻微倾摆；不高速旋转 |
| `receiving` | 第一颗星向心光下沉一次 |
| `completed` | 三颗星按顺序轻亮一次 |
| `blocked` | 停止循环，星点与画面降低透明度；不使用红色警报 |
| reduced motion | 完整静态画面，所有出场与循环关闭 |

## 4. 主题适配

| 部位 | 颜色来源 |
|---|---|
| 水墨山水、斜月、暖光 | 受管水墨资产内的固定品牌材质 |
| 三颗星 | `--ling-text-link`、`--ling-border-focus` |
| 场景光晕 | `--ling-text-link` 的低透明度径向渐变 |
| 状态反馈 | 现有语义状态色 |

要求：

- 角色资产保持水墨原色，不随主题反相；
- 切换主题时只让星点、光晕和交互反馈融入当前主题；
- 深色主题依靠透明资产和背景遮罩，不另做一套红色/绿色水墨；
- 高对比度模式下关闭装饰光晕，保留星点和轮廓；
- CSS 不写硬编码颜色。

## 5. 产品使用边界

- 首页空态使用完整水墨构图；设置、审批、诊断和高密度页面默认不铺开大幅动画。
- IP 不承担错误、权限、审批和保存结果等业务语义。
- 不替换产品 Logo；侧栏继续使用正式 Logo，首页使用水墨心印。
- 不在正文、输入框或按钮上叠加星点、雾层或水墨纹样。
- 场景主题可以复用这些星点、斜月与灵台语言，但不能各自再造不同角色。
- 主题列表仍以完整氛围缩略图为入口，水墨心印是这些场景共用的品牌锚点。

## 6. 技术路线

| 层级 | 当前选择 | 用途 |
|---|---|---|
| V1.2 | 透明 WebP 水墨资产 + 内联 SVG 星点 + CSS animation | 保留水墨质感，星点保持实时状态反馈 |
| V2 可选 | SVG/Canvas 分层水墨 | 如果需要逐层山体、月弧和更精细的视差 |
| 暂缓 | Rive / WebGL | 当前首页尺寸不需要重型状态机或 3D |

角色资产必须通过受管本地路径提供；新的状态优先扩展现有 `data-state` 契约。

## 7. 参考资源

文化语义：

- [Journey to the West Research: The Alchemical Allegory of Subodhi’s Mountain Home](https://journeytothewestresearch.com/2020/01/27/the-alchemical-metaphor-of-subhutis-mountain-home/)
- [中国哲学书电子化计划：《西游记》第一回原文](https://ctext.org/xiyouji/ch1/zh)

动效与材质：

- [IBM Carbon Motion](https://carbondesignsystem.com/elements/motion/overview/)：高频工作界面保持克制，表现型动效只用于少数时刻。
- [Microsoft Fluent Motion](https://learn.microsoft.com/en-us/windows/apps/design/motion/)：动画用于表达关系与状态变化，而非持续争夺注意力。
- [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：动效应简短、准确、可中断，并支持减少动态。

## 8. 验收与下一步

V1.2 验收必须覆盖：

1. 水墨构图在 256 × 150 首页尺寸下仍可识别斜月、三星、灵台和心光；
2. 三颗星确实按 `220 / 620 / 1020ms` 错峰出现；
3. `ling-light`、`ling-dark`、`ling-breeze`、`ling-ocean`、`ling-night` 下透明边缘自然，没有白色纸底；
4. `thinking / receiving / completed / blocked` 状态可见但克制；
5. `prefers-reduced-motion: reduce` 下为完整静态画面；
6. Chrome 真浏览器截图、WebM 和 Console 检查通过；
7. Electron 打包后的渲染留待桌面壳层验收。

后续如果还需要增强，只做两件事：让雾山/水面有更细的分层视差，以及为场景主题提供同一套水墨心印的材质变体。不再回到卡通角色方向。
