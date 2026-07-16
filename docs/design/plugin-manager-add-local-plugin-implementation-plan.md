# 插件管理新增本地插件实施计划

## Slice 1: Contracts And Daemon

- 新增插件创建 request/response contracts 和 API client 方法。
- 扩展 `POST /plugins`，复用 MCP transport 校验。
- 新增 focused service 创建禁用 MCP server、managed plugin record 和 contribution link。
- 泛化插件健康检查：存在 MCP contribution 时检查真实关联 server。

## Slice 2: Web Domain And Drawer

- 在 plugin domain 增加 create action 和全局 toast。
- 新增 `PluginCreateDrawer`，支持本地命令和 HTTP 地址。
- `PluginManagerSettingsPanel` 只增加抽屉状态和必要接线，不把表单逻辑放进 `AppShell`。

## Slice 3: Table Density

- `PluginTableRowView` 增加产品化描述。
- 名称单元格改为名称加描述两行。
- 状态和操作列改为固定宽度、列内居中，行高保持 58–64px。

## Slice 4: Verification

- daemon 测试创建、默认停用、MCP 关联、真实检查和启用。
- Web E2E 覆盖新增抽屉、两种 transport、描述显示和防重复提交。
- 继续覆盖 30 插件内部滚动、详情抽屉、暗色和三种桌面宽度。

## Hard Stops

- 不增加远程插件下载。
- 不在请求或插件记录中保存明文 secret。
- 不默认启用新增插件。
- 不向 `AppShell.tsx` 添加表单或插件业务逻辑。
