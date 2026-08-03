# Ling UI 2.0 主题系统

## Product Model

Ling 的最小外观单元是独立 Theme Pack。`ling-light` 与 `ling-dark` 是两个完整内置主题；System 是
选择策略，不是第三个主题。主题只改变语义 token、受控 Desktop 材质和批准 artwork，不改变布局、
组件结构、Logo、图标、业务文案或状态机。

## Authoritative Contracts

1. [独立主题包产品模型](01-独立主题包产品模型.md)
2. [主题包 Schema 与 Token](02-主题包Schema与Token合同.md)
3. [主题资源导入与安全](05-主题资源导入与安全.md)
4. [AI 生成主题流程](07-AI生成主题产品流程.md)
5. [主题注册表与运行时切换](../architecture/07-主题注册表与运行时切换.md)
6. [图标与主题控件](../components/05-图标与主题控件.md)

## Current Boundary

- Web ThemeRegistry、内置主题、选择、预览和受限导入使用共同 schema。
- Quick 模式采用 D3=A：上传图片只参与本地配色和 token 生成，不发布运行时背景。
- Generate/Advanced 只有在各自模型、Compiler、资源检查和用户确认完成后才可标记实现。
- Desktop `appData` 存储、原子发布、typed IPC、packaged restart 和跨平台证据仍由
  [Desktop Theme Pack Persistence Plan](../modules/settings/10-Desktop-Theme-Pack-Persistence-implementation-plan.md)
  管理。

## Ownership

- `@ling-stack/ui-react`：types、validator、built-ins、registry、token mapping、Profile registry。
- Theme Compiler：结构化计划、对比度、资源和 allowlist 验证。
- Web/Desktop adapter：持久化、首帧 bootstrap、系统外观和受管资源。
- Feature：只消费 semantic variables 与共享视图模型，不读取 manifest 或主题 ID。

## Evidence

主题行为按 [UI2 验收规范](../03-UI2.0验收总规范.md)和
[Desktop 发布清单](../release/01-Desktop跨平台发布验收清单.md)验证。截图、hash 和逐次测试数字不在本目录维护。
