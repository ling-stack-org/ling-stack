# Ling 远行问剑主题设计合同

状态：第一套官方静态场景主题；静态母图已接入真实浏览器，动态壁纸仅作为用户自定义能力保留

Owner：theme and presentation delivery track  
关联：[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)、[官方场景主题与自定义媒体背景实施方案](full-window-theme-background-implementation-plan.md)、[统一合同](theme-background-motion-contract.md)、[主题系统](ui2.0升级/themes/README.md)

## 1. 主题定位

`ling-journey` 是 Ling 的第一套修仙场景主题，展示一群匿名剑仙以不同身法、剑势和剑光穿过山海与云雾，奔向远处尚未平息的死域。主题表达“此去只向前”的决绝、孤独和责任感，强调远方、纵深、留白与余韵。每一位远行者都只向危险终点前进，构图不安排回折路径。

“剑来”只作为情绪参考：远行、山河、剑光、斩妖后的寂静。主题不复用其角色、服饰、地点、道具、台词、构图或可识别的美术资产，也不把任何现成壁纸直接作为 Ling 内置资源。

本主题暂时不依赖 Ling Core IP 和首页启动动画。远行者是场景中的匿名剪影；未来 IP 确认后，可以作为独立的可选叙事层接入，不修改主题 token、材质和背景生命周期。

## 2. 视觉母题

### 2.1 构图

- 画幅按 16:9 设计，适配全窗背景和主题卡缩略图。
- 左侧和中央约 55% 区域保持低细节、低对比，给侧栏、正文和输入框留安全区。
- 四至五位远行者、各自不同的剑光和妖潮集中在右侧远景，形成明确的右向远行方向；人物、黑烟、红色裂隙、余烬、云海和雾带在同一整幅画面中统一出现。
- 前景只保留较薄的墨色山脊或雾边，不使用覆盖大半屏幕的黑色底板。
- 危险终点表现为断裂山门、黑色死域、细窄的暗红裂隙、坠落剑光和少量余烬；不画可辨认的怪物脸、身体、血腥或爆炸。

### 2.2 色彩

主题采用暗色优先的墨蓝场景，强调色只保留一条克制的暖色剑光。

| Token | 值 | 用途 |
|---|---|---|
| `background.app` | `#0d141c` | 全窗基础色 |
| `background.panel` | `#111c27` | 主工作区材质底色 |
| `background.sidebar` | `#101923` | 左侧栏材质底色 |
| `background.subtle` | `#1b2a38` | hover、弱层次 |
| `background.pressed` | `#24384b` | pressed 状态 |
| `text.strong` | `#eef3f5` | 标题和强文本 |
| `text.default` | `#d2dde2` | 正文 |
| `text.muted` | `#9babb4` | 辅助文本 |
| `border.default` | `#2b3c49` | 常规边框 |
| `border.strong` | `#48606f` | 强边框 |
| `border.focus` | `#c49a63` | 焦点和有效拖放边界 |
| `action.accent` | `#c49a63` | 主按钮、剑光对应强调色 |
| `action.accentHover` | `#d5b47d` | hover |
| `action.accentPressed` | `#9a7448` | pressed |
| `action.selection` | `#304556` | 选中态 |
| `status.info` | `#83b8c8` | 信息状态 |
| `status.success` | `#8fb89b` | 成功状态 |
| `status.warning` | `#d2ab68` | 警告状态 |
| `status.danger` | `#d48779` | 错误状态 |

剑光的暖金色只用于少量强调，不扩散成大面积橙色渐变。妖潮的暗红只属于背景资产，不进入业务状态色。

## 3. 材质与界面适配

- 背景作为整窗连续环境层，由一个共享背景层负责，不按侧栏、顶部栏、主画布重复加载。
- 默认背景可见度为 60%，用户仍可用 20%–100% 连续滑杆调整。
- 左侧栏使用约 68% 的深色墨面材质；顶部栏和主工作区使用同源的低强度透明材质，让山雾连续透出。
- 主工作区的环境层保持轻透，Composer、正文、代码、输入框、表格、审批、设置和弹层保持不透明语义表面。
- 选中态使用冷蓝灰底色，焦点边框使用暖金色；不使用整行高亮或横向条纹装饰。
- 保护页面回退到 token-only 实底，背景不参与可读性判断。

主题切换只更新 manifest、场景资源和材质参数，不改变布局、字体、图标、Logo、业务状态机或当前会话。首帧主题脚本必须识别全部内置场景主题及其 color scheme，避免深色场景在刷新时先绘制浅色底。

UI 组件的视觉重塑由[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)单独拥有。该方案将侧栏、顶栏、Composer、按钮、列表行、弹层和设置页拆成 L0–L4 材质层，定义 Default/Hover/Focus/Pressed/Selected/Disabled/Error 状态，并以 1440×960 首页和普通会话截图作为“不能只是背景图”的验收门槛。

## 4. 静态背景设计

### 4.1 静态母图

`farbound-journey` 使用一张完整的静态 WebP 母图作为官方场景。人物、剑光、远方黑烟、暗红裂隙、余烬、云海和雾带都已经在同一张画面中合成，人物固定在右侧远景，中央留白继续为首页标题、Composer 和工作区内容提供安全区。运行时只创建一个共享的场景图层，不叠加 rider SVG，也不在画面中央生成额外人物。

主题切换、刷新和解码失败都指向同一张 `ling-journey-v4-depth-dark.webp`，保证首帧和页面截图一致。背景可见度只影响环境层和 UI 材质透明度，不改写图片颜色。

### 4.2 交互与状态

- 主题卡 hover 只显示低强度暖金柔光，不播放额外的剑光事件。
- 文件拖入使用现有 1px 主题焦点边框和短段边缘微光，不使用圆形波纹。
- `prefers-reduced-motion: reduce`、forced-colors、窗口隐藏或性能降级时，保留静态母图并关闭装饰性位移。
- 用户上传本地 MP4/WebM 后才启用自定义动态壁纸；恢复默认背景后回到这张静态母图。

### 4.3 技术形态

官方 `farbound-journey` 由 `SceneArtwork` 加载 `ling-journey-v4-depth-dark.webp`。静态资源作为主题缩略图和全窗背景的唯一来源；不运行时合成角色，不创建官方 `<video>`，也不逐帧提取颜色。

- 左侧栏、顶栏、工作区、Composer、按钮和弹层共享同一组墨蓝、冷蓝灰和暖金 token；
- 主工作区允许环境层透出，正文、代码、输入、设置和弹层保留不透明语义表面；
- 自定义动态壁纸仍只接受 MP4/WebM，官方主题不把 GIF、APNG 或动画 WebP 作为默认资源。

## 5. 资产规范

- 母版：3840×2160 PNG，保留纸张纹理和完整构图。
- 产品静态资源：2560×1440 WebP，目标 300–800KB；主题卡从同一母图裁切。
- 官方运行时资源：`apps/web/public/themes/ling-journey/ling-journey-v4-depth-dark.webp`；不使用远程 URL。上一轮整合 WebM 保留在资源目录中作为历史探索素材，但不由 `ling-journey` 默认加载。
- 不包含文字、水印、Logo 替换、第三方 IP、可辨认人物脸和品牌服饰。
- 当前候选：`.ling-stack/acceptance/theme-scene-candidates/ling-journey/ling-journey-v3-multiraid-sunset.png`、`ling-journey-v4-multiraid-ui-safe.png`、`ling-journey-v5-multiraid-night.png`、`ling-journey-v6-depth-dark.png`；运行时采用 `ling-journey-v6-depth-dark.png` 压缩后的 `ling-journey-v4-depth-dark.webp`。
- 候选母图属于视觉评审资产；`ling-journey-v4-depth-dark.webp` 作为主题卡和全窗背景的官方静态资源。正式发布仍待跨平台清晰度、可读性和签名安装包验收。

## 6. 实施拆分

| 阶段 | 工作 | 验收 |
|---|---|---|
| J0 | 选择母图方向，确认留白、远行者比例和妖潮强度 | 主题卡与全窗静态截图通过视觉评审 |
| J1 | 将主题 manifest、tokens、scene metadata 接入 built-in registry | validator、主题选择器和 fallback 通过 |
| J2 | 将母图裁切为产品资源，接入统一背景层和材质 resolver | 侧栏、顶部栏、主画布连续透出且正文清晰 |
| J3 | 固化高细节静态母图并接入整窗材质 | 检查中央无乱入、人物只在右侧远景、场景与 UI 透出自然、文字和输入保持清晰 |
| J4 | 真实浏览器和 Electron 预览验收 | 多状态截图、静态计算样式、console、性能和资源释放证据齐全 |

## 7. 公开参考与取舍

- Rive 的状态机和视差案例适合参考“多层独立运动 + 状态触发”的实现方式，不直接引入其素材：[Rive state machines](https://github.com/rive-app/help-center/blob/master/runtimes/state-machines.md)、[Rive parallax example](https://rive.app/community/files/299-648-the-balloonist/)。
- `shan-shui-wallpaper` 展示了山水、月光、雾和昼夜变化如何组成低频动态壁纸；其作者明确限制再利用，因此只作研究参考，不复制素材或训练风格：[shan-shui-wallpaper](https://www.int80h.de/wallpaper/lingdong/?lang=zh-Hans)。
- 剑光拖尾应借鉴“刀刃轨迹 + 短时命中闪光”的分层逻辑，但在 Ling 中收敛为一次细线事件，不使用游戏化爆炸效果：[Stride trail tutorial](https://doc.stride3d.net/4.0/en/Manual/particles/tutorials/create-a-trail.html)。

## 8. 当前结论

本主题的当前方向是“水墨长卷 + 剑仙群像 + 黑烟、红色死域、云雾凝固在同一张静态母图”，不是高亮战斗壁纸。运行时使用 `ling-journey-v4-depth-dark.webp` 作为主题卡和整窗背景；旧的 scenery-only + SVG rider 路径已移除，避免中央乱入和人物与背景脱层。
