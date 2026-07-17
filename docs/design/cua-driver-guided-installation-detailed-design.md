# Cua Driver 自动检测与安装引导细节设计

## Status And Scope

本文是已实现 external provider fallback 的细节设计，适用于 standalone daemon、
Web/CLI、source/dev Desktop 和显式 `external_local` override。

Packaged macOS Desktop 的默认 provider、进程责任链、bridge lease、TCC、版本锁和
升级策略由
[Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)
定义。本文中的 `local_binary`、PATH 检测和安装抽屉不得覆盖 bundled embedded
状态。

## Canonical Model

`trusted-local:cua-driver` 是唯一产品条目。daemon 在构建 catalog 时继续读取
历史 bundled descriptor 和持久化记录，但从默认列表中过滤
`bundled:cua-driver`。按旧 id 请求详情、校验、安装和卸载仍保持兼容。

canonical 条目通过固定 MCP id `mcp_cua_driver` 识别现有接入，不依赖旧记录的
plugin id。连接时重新写入 canonical contribution，旧 bundled 记录保持禁用且
不可见，不做数据库迁移。

## External Setup Projection

`ManagedPluginView.setup`：

```ts
type ManagedPluginSetupState =
  | "detected"
  | "missing"
  | "unsupported"
  | "connected"
  | "ready";

interface ManagedPluginSetupView {
  kind: "local_binary";
  state: ManagedPluginSetupState;
  checkedAt: string;
  detectedCommand?: string;
  guide?: {
    documentationUrl: string;
    installCommand: string;
    supportsCustomCommand: boolean;
  };
}
```

规则：

- 非 macOS：`unsupported`。
- 找不到可执行文件：`missing`，附带 guide。
- 找到文件但没有 MCP，或旧 MCP 尚未建立 canonical 关联：`detected`。
- MCP 存在但插件/MCP 未启用：`connected`。
- 插件、contribution 和 MCP 均启用：`ready`。
- `guide` 只在 `missing` 时返回。

`GET /plugins` 每次请求使用 `resolveCuaDriverCommand()` 做只读检测，不写 health、
event 或数据库。优先级为显式路径、`PATH`、`~/.local/bin`、Homebrew 和
`/usr/local/bin`、系统 `/Applications/CuaDriver.app` 和用户 `~/Applications`
中的 App Bundle 可执行文件。

## External Connect API

```text
POST /plugins/trusted-local:cua-driver/connect?cwd=...
Content-Type: application/json

{ "command": "/optional/absolute/path" }
```

连接是幂等操作：

1. 校验平台和可执行文件。
2. 复用或创建 `mcp_cua_driver`。
3. transport 固定为 `stdio`，参数固定为 `mcp`。
4. 新接入或修复旧关联时，MCP、plugin record 和 contribution 全部写为 disabled；
   已完整处于 `ready` 的幂等重复请求不会主动降级用户已启用的连接。
5. 保存解析后的绝对 command。
6. 写入 `connected` audit event，但不启动 MCP、不列工具。

稳定错误：

- `plugin_binary_not_found`
- `plugin_command_not_executable`
- `plugin_platform_blocked`
- `plugin_connect_failed`

旧 `apply-preset` 继续兼容，内部执行 connect 后再走显式启用和工具同步。

## External Automatic Web Reconciliation

Web 列表刷新后，只对 canonical Cua Driver 执行一次自动接入：

```text
setup.state === detected
and no connect request in flight
and current refresh generation has not attempted connect
  -> POST connect
  -> replace plugin row from response
```

失败不循环重试。驱动消失或连接失败时显示局部错误；用户点击重新检测后才开始
下一次尝试。组件卸载、刷新或状态更新不能制造重复 connect 请求。

## Enable Transaction

用户点击启用后：

1. 启用 MCP 服务和 contribution。
2. 启动/检查 MCP。
3. 列出工具并应用 Cua Driver 默认审批覆盖。
4. 成功后启用 plugin record，保存 health 和工具。
5. 任一步失败时回滚 plugin、contribution 和 MCP 为 disabled，保存失败 health，
   返回 `plugin_enable_failed`。

只读工具如 `check_permissions`、`list_windows` 默认允许；点击、输入、录制等外部
副作用工具保持询问。

## External Web Presentation

- Cua Driver 行不显示 `Bundled`/`Trusted local` 双条目。
- `missing`：显示“尚未安装 Cua Driver”和主按钮“安装引导”。
- 引导使用轻量右侧抽屉，不使用全屏弹窗。
- 抽屉包含官方来源、复制命令、打开文档、绝对路径输入和重新检测。
- `detected`：显示轻量“已检测，正在接入”，无安装按钮。
- `connected`：显示“已检测，待启用”和启用按钮。
- `ready`：显示已启用，不出现安装说明。
- 复制成功使用短暂反馈；检测或连接错误持续到重新检测成功。

## Module Boundaries

- contracts 只定义 setup/connect wire types。
- daemon `presets.ts` 负责检测和官方引导元数据。
- `cua-driver.ts` 负责检测、连接和回滚，`cua-driver-activation.ts` 负责显式启用、
  MCP 检查和工具同步事务，避免继续扩大 routes。
- Web domain 负责自动接入去重和 mutation 状态。
- 新的 Cua Driver 安装引导组件负责抽屉，Plugin Manager 页面只组合展示。
