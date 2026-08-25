# Plugin Manager

## Product Boundary

Plugin Manager 是独立产品页面，不属于 Settings。它管理现有 plugin list、install/create、check、enable/
disable、runtime preview、uninstall 和 bundled Computer Use Driver 状态，不改变 daemon plugin authority、
签名、完整性、安全检查或 provider 状态机。

Chrome 是常显的内置插件。默认层只展示是否启用、是否需要安装扩展、是否等待 Chrome 和是否可用；
扩展 ID、配对传输、凭据摘要和逻辑 MCP 信息进入技术详情。Chrome 安装始终是浏览器拥有的显式用户操作，
Plugin Manager 不静默安装或启用扩展。

## Page And List

- 页面使用紧凑 Header、搜索/筛选和内部滚动表格，不显示统计卡或长用途说明。
- 搜索只匹配名称与说明，不因 raw plugin ID、cache path 或 hash 命中。
- 每行显示名称、来源、唯一主状态和操作。正常 ready 不堆 package/health/runtime 多枚标签。
- refresh 保留已有列表并标 stale；筛选变化不发请求，也不强制关闭当前详情。
- raw blocker、checksum、package hash、provider/tool/schema 明细进入折叠技术详情。

## Actions

- Add/Create、check、enable/disable、install 和 uninstall 各自拥有 scoped busy/error。
- bundled plugin 不自动 connect；“已请求启用但尚未生效”必须与 ready 区分。
- uninstall 使用共享 Dialog，明确影响和保留内容；失败保留对象和 Dialog。
- Runtime Preview 只展示真实 capability、policy 和 blocker，不伪造可执行状态。

## Computer Use Driver

- macOS 显示真实安装、路径、权限和重检状态；Windows 显示 provider、tool/schema 和平台 readiness 的单一
  产品状态。
- 正常状态不泄漏 raw health；异常提供一个主要修复行动和折叠诊断。
- 真实 Windows interactive session、DPI、high contrast、签名和 packaged 证据未完成前，不标记 release-ready。
- 修复 UI 不改变 CUA authority tuple、lease、feature gate、MCP fence 或签名校验。

## Architecture

- `features/plugins` 拥有页面、controller、view model 和 focused CSS；AppShell 只负责 mount/navigation。
- Web adapter 通过既有 daemon client 调用，不建立 Settings facade 或第二套 plugin store。
- 错误按 `pluginId + action + owner + requestId` 归属；禁止恢复单一全局 `errorMessage`。

## Acceptance

覆盖 loading/empty/no-result/stale、create validation、check failure、启停、uninstall、bundled CUA 修复、迟到
响应、键盘、Light/Dark、`1440x960`、`1280x800`，以及独立 packaged Desktop 门禁。
