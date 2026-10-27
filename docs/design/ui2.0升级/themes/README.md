# Ling UI 2.0 官方主题系统

## Product Model

Ling 的最小外观单元是官方内置 Theme Pack。当前共 6 套：`ling-light`、`ling-dark` 是经典工作区主题；`ling-breeze`、`ling-ocean`、`ling-night`、`ling-journey` 是场景主题。远行问剑使用整合静态母图；新 Core IP 和启动动画暂停，项目保留原 Logo。System 是选择策略，不是第三个主题。

主题可以改变语义 token、受控 Desktop 材质、官方 scene metadata 和批准的表现强度；不能改变布局、组件结构、Logo、图标、业务文案、键盘行为或业务状态机。

## Authoritative Contracts

1. [官方主题产品模型](01-独立主题包产品模型.md)
2. [主题 Schema 与 Token](02-主题包Schema与Token合同.md)
3. [官方主题资源与安全](05-主题资源导入与安全.md)
4. [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
5. [图标与主题控件](../components/05-图标与主题控件.md)
6. [官方场景主题、背景与交互动效统一设计](../../theme-background-motion-contract.md)
7. [Ling 远行问剑 UI 视觉适配实施方案](../../ling-journey-ui-adaptation-implementation-plan.md)
8. [阅读保护、播放与构图偏好](../../theme-background-hardening-plan.md)

## Current Boundary

- 主题来源只有应用内置；产品不提供主题包导入、重新导入、修复、删除或 Theme Studio 生成入口。
- 历史 local-import / local-generated 数据保留但不作为可继续扩展的产品能力；历史选择按颜色模式回退到官方浅色或深色主题。
- 官方场景主题由 tokens、scene metadata、Presentation Profile 和应用内场景资源组成。
- `ling-journey` 的组件级视觉适配由 [UI 视觉适配实施方案](../../ling-journey-ui-adaptation-implementation-plan.md)拥有；它约束 L0–L4 材质、Shell、Composer、通用控件、Overlay、设置页和状态，不允许业务组件读取主题 ID。
- 自定义背景是独立用户偏好：支持本地静态图片、MP4/WebM 动态壁纸；可见度、横纵焦点与暂停按主题保存。首页与工作页共用连续背景，工作页可见度上限 45%；正文实底、布局透明。播放与构图读取[本轮合同](../../theme-background-hardening-plan.md)，导入与发布读取[实施方案](../../full-window-theme-background-implementation-plan.md)和[验收矩阵](../../full-window-theme-background-acceptance-matrix.md)。
- Desktop `appData` 存储、原子发布、typed IPC、packaged restart 和跨平台证据仍由 Desktop 发布与背景验收管理。

## Ownership

- `@ling-stack/ui-react`：types、validator、built-ins、scene renderer、registry、token mapping、Profile registry。
- Web/Desktop adapter：持久化、首帧 bootstrap、系统外观和受管用户背景资源。
- Feature：只消费 semantic variables 与共享视图模型，不读取 manifest 或主题 ID。

## Evidence

主题行为按 [UI2 验收规范](../03-UI2.0验收总规范.md)、[官方场景主题与背景验收矩阵](../../full-window-theme-background-acceptance-matrix.md)和 [Desktop 发布清单](../release/01-Desktop跨平台发布验收清单.md)验证。截图、hash 和逐次测试数字不在本目录维护。
