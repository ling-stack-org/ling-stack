# 官方场景主题与自定义媒体背景验收矩阵

Status: acceptance specification；本机执行状态见后续验证报告\
Owner: theme and presentation delivery track\
Last verified: 2026-10-27\
Document type: acceptance and platform gate specification\
Code and test anchors: [实施方案](full-window-theme-background-implementation-plan.md)、[UI 视觉适配实施方案](ling-journey-ui-adaptation-implementation-plan.md)、[统一合同](theme-background-motion-contract.md)

## 1. 测试层

| 标记 | 环境 | 可证明范围 |
|---|---|---|
| U | `ui-react` / shared model 纯测试 | manifest、scene、preference、asset、digest、迁移和对比度 |
| W | Web repository / IndexedDB | Web 候选、事务、revision、恢复、跨 tab 与兼容 |
| N | Desktop main/native fixture | 受管路径、IPC、摘要、大小、崩溃恢复和 codec/媒体边界 |
| B | Chromium E2E / 真实浏览器 | 设置流程、主题切换、截图、键盘、console、资源释放 |
| D | 目标 Desktop 安装包 | 原生文件交互、签名资源、首帧、性能、平台媒体解码 |

低层通过不能替代高层；Web 或 fixture 通过不能标记 Desktop 安装包通过。

## 2. 功能验收

| ID | 场景 | 通过标准 | 层 |
|---|---|---|---|
| BG-01 主题来源边界 | 打开界面偏好 | 只展示 built-in 主题；无导入、创建、修复、重新导入、删除或预览主题包入口 | B |
| BG-02 历史主题回退 | 历史 fixed selection 指向 local-import/local-generated | 首帧不闪回旧主题；registry ready 后按颜色模式回退官方浅色/深色；数据不被删除 | U、W、B |
| BG-03 内置场景 manifests | 三个 scene manifests | tokens 完整、对比度通过、scene ID 已知、非 built-in scene 被拒绝 | U |
| BG-03A Core IP 一致性 | Core turnaround 与五主题 variant sheet | 五个变体共享同一轮廓、脸部和比例；仅材质、道具、姿态和光影变化；无文字/水印/第三方 IP | 人工设计审核、B |
| BG-04 场景缩略图 | 主题列表 | scene 主题显示与全窗一致的矢量缩略图；经典主题保留色板；选中/焦点/disabled 正常 | B |
| BG-05 全窗场景 | 无自定义背景时选择 breeze/ocean/night/sakura/ember | 一张连续场景透出首页、侧栏、工作区；无独立面板裁切；角色和角落装饰可见但不遮挡操作 | B、D |
| BG-06 场景配色 | 五个 scene 主题 | 左侧栏、按钮、选中态、焦点、链接和状态色与场景同色系；正文/输入保持可读 | U、B、D |
| BG-07 保护路由 | settings、management、diagnostics、approvals、media-canvas、overlay | 实底；场景/媒体不透入正文、代码、输入、表格和审批 | B、D |
| BG-08 主题切换状态 | 有草稿、焦点、滚动、dock、native pending/ready/blocked/error 时切换主题 | 状态保留，不触发 Run；场景和 tokens 同步更新 | B、D |
| BG-09 自定义静态图片 | 选择/拖入 PNG、JPEG、静态 WebP | 预览、应用、替换、取消、恢复默认背景成功；图片规范化；失败保留旧配置 | U、W、N、B、D |
| BG-10 连续可见度 | 拖动滑杆 20%–100% | 预览和全窗一致；默认值 60%；旧三档迁移为 45%/60%/75%；1180–1280 高值收敛到 60% | U、W、N、B |
| BG-11 动态壁纸格式 | MP4、WebM；GIF/APNG/动画 WebP/SVG/远程 URL/多文件 | MP4/WebM 可预览和应用；其他格式明确拒绝；不导航打开文件 | U、W、N、B、D |
| BG-12 视频播放 | 应用本地视频壁纸 | 一个共享 muted loop playsInline video；无分面板播放器；无声音；不清空草稿/焦点 | B、D |
| BG-13 视频暂停与恢复 | 页面隐藏/显示、窗口失焦/聚焦 | 隐藏暂停，可见按偏好恢复；不重复解码或创建新 URL | B、D |
| BG-14 reduced-motion / forced-colors | OS 开启对应偏好 | 视频不自动播放或隐藏装饰；边界、焦点、业务文字保持可见 | B、D |
| BG-15 损坏与失败 | 损坏图片/视频、缺失资源、保存失败、解码失败 | 主题默认画面回退；旧 committed 不被覆盖；错误可恢复 | U、W、N、B、D |
| BG-16 存储竞态 | 跨 tab、快速替换、丢回执、stale revision、clear 后重试 | 无半提交、旧图复活或重复资产；权威 revision 收敛 | W、N |
| BG-17 崩溃恢复 | Desktop 在 asset staged/published、config staged/published 中断 | 提交点前旧状态、提交点后新状态；暂存回收 | N、D |
| BG-18 资源生命周期 | 替换/取消/清除 20 轮 | object URL、候选任务和旧资源归零；无持续 rAF/timer；无泄漏增长 | W、B、D |
| BG-19 原生文件交互 | 文件选择、单文件拖入、多文件、非文件、取消 | macOS Finder / Windows Explorer 真实跨窗可用；synthetic drag 另列 | D |
| BG-20 性能预算 | 4K 图片、64 MiB 视频、三主题、连续切换 | 操作不阻塞主流程；视频空闲 CPU/GPU/内存达到固定预算；无后台持续装饰动画 | B、D |
| BG-21 可访问性 | 键盘完成主题、背景选择、滑杆、应用、取消和恢复 | 焦点可见；结果播报一次；装饰 `aria-hidden`；中文/英文文案可读 | B、D |
| BG-22 首帧与重启 | Web 硬刷新、Desktop 完整退出重开 | 首帧正确主题默认画面；媒体就绪后显示；无白闪、错误主题或破图 | B、D |
| BG-23 Desktop capability | 缺 preload/background capability、codec/video helper 不可用 | 设置显示不可用或受控拒绝；不写 Web store 冒充 Desktop 保存 | N、D |
| BG-24 既有工作回归 | 普通会话、频道、主题卡柔光、文件拖放边缘微光、Quick/Theme 旧页面深层入口 | 现有业务不回归；旧深层入口不展示为新产品能力 | B、D |

## 2A. Ling Journey UI 视觉验收

以下条目专门验证“完整主题 UI”，不能用背景图可见或 token 存在代替。每条都需要在 `ling-journey` 下验证，并至少与 `ling-dark` 生成一张并排对比截图。

| ID | 场景 | 通过标准 | 层 |
|---|---|---|---|
| UI-01 材质层 | 首页、普通会话、设置页 | L0–L4 层级清楚；允许透出的区域与必须实底的区域符合 UI 方案；无组件自行叠加背景图 | B |
| UI-02 Shell | 侧栏、顶栏、收起 rail、right dock | 墨面、边界、分组间距和阴影统一；不再显示基础主题的白/灰外壳 | B、D |
| UI-03 Sidebar states | 导航行、频道、队友、最近对话 | Default/Hover/Focus/Pressed/Selected/Disabled 状态齐全；选中项使用冷蓝灰局部底和暖金边界 | B |
| UI-04 Home composition | 首页标题、快捷入口、背景右侧人物 | 标题和快捷入口位于安全区；人物和红色死域仍是右侧视觉重心；没有控件压在主体上 | B |
| UI-05 Composer shell | 输入框、附件、权限、模型、发送 | Composer 具有明确主题容器、统一圆角、L3 实底、主题边界和暖金主操作；不再像默认组件叠在图上 | B、D |
| UI-06 Composer states | focus、drag、attachment、error、disabled | 状态使用统一 focus/selection/status tokens；拖放没有持续粒子或布局跳动；错误不覆盖草稿 | B |
| UI-07 Controls | Button、IconButton、Input、Select、Tabs、Badge | 高度、圆角、hover、focus、pressed、disabled 和 icon 对齐统一；业务组件不读取主题 ID | U、B |
| UI-08 Content surfaces | List、Card、Table、Code、Terminal | L3 实底、薄边框、短阴影和滚动行为一致；背景不影响正文和代码阅读 | B、D |
| UI-09 Overlays | Dialog、Popover、Menu、Toast、Tooltip | L4 浮层使用同源 elevated surface、overlay shadow 和 focus；不出现默认白色浮层 | B |
| UI-10 Settings | 主题设置、背景设置、slider、保护设置页 | 设置页保持实底但使用同一套边框、选中、焦点和说明文字层级；主题默认背景与个人覆盖可区分 | B |
| UI-11 Visual delta | Journey 与 Ling Dark 并排 | 评审者无需查看 DOM 或 CSS 即能识别 Journey 的侧栏、Composer、按钮和弹层已换主题 | 人工设计审核、B |
| UI-12 Regression | 普通会话、频道、右侧 dock、窄窗口、forced-colors | 不改变业务状态机、权限、草稿、滚动和执行状态；无横向溢出；回退仍可读 | B、D |

## 3. 视觉证据要求

每个场景主题至少保留：

- 主题设置页缩略图截图；
- 1440×960 首页截图；
- 1440×960 普通会话截图；
- 浅色/深色系统外观下的回退截图（适用时）；
- 自定义图片和视频壁纸各一张对比截图；
- reduced-motion、forced-colors 或对应模拟状态截图；
- console/page errors 记录。

UI-01–UI-12 还必须保留：

- Journey / Ling Dark 1440×960 并排首页截图；
- Journey 普通会话 Composer 的 default、focus、selected、error 四张状态截图；
- 侧栏展开与收起 rail 截图；
- Dialog、Popover、Menu、Toast、Settings 各一张截图；
- 每张截图的主题 ID、背景源、opacity、系统外观、视口和 commit SHA。

## 4. 放行规则

S1 放行要求 BG-01–BG-08、UI-01–UI-06、UI-10–UI-11、BG-21、BG-24 通过。\
S2 放行要求 BG-09–BG-10、BG-15–BG-18、UI-07–UI-09、UI-12、BG-21–BG-22 通过。\
S3 放行要求 BG-11–BG-20、BG-23 通过。\
S4 只在目标签名安装包完成适用行后关闭；本机 Chromium 和 fixture 不能代替 macOS/Windows 放行。
