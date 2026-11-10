# Ling UI 2.0 官方主题系统

## Product Model

Ling 的最小外观单元是官方内置 Theme Pack。当前共 6 套：`ling-light`、`ling-dark` 是经典工作区主题；`ling-breeze`、`ling-ocean`、`ling-night`、`ling-journey` 是场景主题。远行问剑使用整合静态母图；新 Core IP 和启动动画暂停，项目保留原 Logo。System 是选择策略，不是第三个主题。

主题可以改变语义 token、已批准的组件圆角/边界/局部阴影/材质、官方 scene metadata 和表现强度；控件高度、命中区域、布局、组件结构、Logo、图标、业务文案、键盘行为和业务状态机保持稳定。

## Authoritative Contracts

1. [官方主题产品模型](01-独立主题包产品模型.md)
2. [主题 Schema 与 Token](02-主题包Schema与Token合同.md)
3. [官方主题资源与安全](05-主题资源导入与安全.md)
4. [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
5. [图标与主题控件](../components/05-图标与主题控件.md)
6. [官方场景主题、背景与交互动效统一设计](../../theme-background-motion-contract.md)
7. [Ling 远行问剑 UI 视觉适配实施方案](../../ling-journey-ui-adaptation-implementation-plan.md)
8. [阅读保护、播放与构图偏好](../../theme-background-hardening-plan.md)
9. [共享组件外观、主题制作与新模块接入](../../component-theme-presentation.md)

## 新主题与新模块的开发入口

- 制作新主题：先提交背景与组件外观矩阵，再更新 typed manifest、registry、受管资源与共享主题 CSS 参数；完整语义 token 不能缺省，组件参数可沿用通用默认值。
- 开发新组件：优先复用共享库；新增外观能力必须有组件参数、完整默认值、唯一消费入口和状态/可访问性验证，不能让主题反过来修改组件内部结构。
- 开发新模块：模块设计必须说明共享组件复用、参数所有权、背景表面策略和全部内置主题的验收方式；Feature 只消费参数，不按具体主题写分支或覆盖共享外观。
- 精确参数和步骤集中维护在[共享组件合同](../../component-theme-presentation.md)。组件外观参数目前是应用内 CSS 合同，不能任意追加到 manifest/JSON，也不开放用户自定义 CSS。

## Current Boundary

- 主题来源只有应用内置；产品不提供主题包导入、重新导入、修复、删除或 Theme Studio 生成入口。
- 历史 local-import / local-generated 数据保留但不作为可继续扩展的产品能力；历史选择按颜色模式回退到官方浅色或深色主题。
- 官方场景主题由 tokens、scene metadata、Presentation Profile 和应用内场景资源组成。
- 所有主题与模块的组件外观由[共享组件合同](../../component-theme-presentation.md)拥有；Night/Ocean/Journey 的具体矩阵在该合同维护，Journey 原方案保留历史与背景适配边界。不允许业务组件读取主题 ID。
- 自定义背景是独立用户偏好：支持本地静态图片、MP4/WebM 动态壁纸；可见度、横纵焦点与暂停按主题保存。首页与工作页共用连续背景，工作页可见度上限 45%；正文实底、布局透明。播放与构图读取[本轮合同](../../theme-background-hardening-plan.md)，导入与发布读取[实施方案](../../full-window-theme-background-implementation-plan.md)和[验收矩阵](../../full-window-theme-background-acceptance-matrix.md)。
- Desktop `appData` 存储、原子发布、typed IPC、packaged restart 和跨平台证据仍由 Desktop 发布与背景验收管理。

## Ownership

- `@ling-stack/ui-react`：types、validator、built-ins、scene renderer、registry、token mapping、Profile registry。
- Web/Desktop adapter：持久化、首帧 bootstrap、系统外观和受管用户背景资源。
- Feature：只消费 semantic/component variables 与共享视图模型，负责业务布局，不读取 manifest 或主题 ID，不遮蔽共享组件外观参数。

## Evidence

主题行为按 [UI2 验收规范](../03-UI2.0验收总规范.md)、[官方场景主题与背景验收矩阵](../../full-window-theme-background-acceptance-matrix.md)和 [Desktop 发布清单](../release/01-Desktop跨平台发布验收清单.md)验证。截图、hash 和逐次测试数字不在本目录维护。
