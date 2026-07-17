# Cua Driver 自动检测与安装引导

## Status

本文记录已经实现的 external provider 接入与安装引导。它继续适用于 standalone
daemon、Web/CLI、source/dev Desktop 和显式 `external_local` override。

Packaged macOS 和 Windows Desktop 的默认目标已由
[Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md) 取代；细节见
[Bundled Embedded Cua Driver Detailed Design](cua-driver-bundled-embedded-detailed-design.md)。
当前代码尚未实现新目标，因此本文同时描述现有行为和后续 fallback 行为。

## Summary

Ling 只向用户展示一个 `Cua Driver`。在 external 模式下，它是用户电脑上的
外部本地驱动；Ling 负责检测、配置 MCP、同步工具和展示安装引导，但不静默
下载或执行外部安装脚本。Packaged Desktop 的 bundled embedded 模式不走
本安装流程，provider 随 Ling release 提供。

产品规则：

- 检测到 `cua-driver` 时不显示安装提示。
- 检测到但未接入时，Ling 静默创建禁用的 MCP 配置。
- 用户必须明确点击启用，Ling 才能获得电脑控制能力。
- macOS 未检测到时显示安装引导、官方链接、复制命令、指定路径和重新检测；
  Windows 当前不返回不适用的 Bash guide，仍保留 missing 状态和显式绝对路径 connect
  能力。
- 辅助功能、屏幕录制权限是安装后的独立状态，不伪装成“未安装”。

## External Fallback User Flow

```text
打开插件管理
  -> 检测本地 cua-driver
     -> 已检测
        -> 已接入：显示已连接或已启用
        -> 未接入：静默创建禁用 MCP 配置，显示待启用
     -> 未检测
        -> macOS 显示安装引导；Windows 显示未检测到外部 provider
        -> 用户从平台适用的官方渠道安装，或通过显式配置/API 指定绝对路径
        -> 重新检测
        -> 自动接入为禁用状态
     -> 平台不支持
        -> 显示不可用，不展示安装按钮
```

## External Fallback Visible States

| State | 用户可见状态 | 主操作 | 安装引导 |
| --- | --- | --- | --- |
| `missing` | 未检测到外部 Cua Driver | macOS 安装引导；Windows 重新检测/显式路径 | 仅存在 platform guide 时显示 |
| `detected` | 已检测，正在接入 | 无 | 隐藏 |
| `connected` | 已检测，待启用 | 启用 | 隐藏 |
| `ready` | 已启用 | 停用 | 隐藏 |
| `unsupported` | 当前平台不支持 | 无 | 隐藏 |

## External Fallback Installation Guidance

- 官方文档：<https://cua.ai/docs/cua-driver>
- 官方安装命令：

  ```bash
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```
- 该命令只作为 macOS guide 返回。Windows 在官方提供专用安全安装命令前不复用 Bash
  文案；高级用户通过显式绝对路径接入。

External 模式只允许用户主动复制命令或打开官方文档，不自动执行命令，不请求
`sudo`，也不把安装成功等同于系统权限已授权。Bundled embedded provider 只在
Ling 的受控构建/release 流程中获取、校验和打包，不在用户运行时下载。

## Single Entry Rule

- 可见 canonical id 固定为 `trusted-local:cua-driver`。
- `bundled:cua-driver` 是历史插件壳，只保留直接 API 和已保存记录兼容，不进入
  `/plugins` 默认列表。
- 已存在的 `mcp_cua_driver` 直接复用，不重复创建。
- 旧 bundled 记录产生的 MCP 服务可被 canonical 条目识别并重新建立关联。

## Safety Boundaries

- 自动接入只能创建或修复禁用状态的 MCP 配置。
- 自动检测和自动接入不能启用插件、调用工具或授予权限。
- 启用失败必须回滚插件、贡献和 MCP 服务为禁用状态。
- GUI 输入、屏幕捕获和应用控制继续服从现有 approval policy。
- 不记录安装脚本内容、屏幕数据或系统隐私权限结果到普通产品日志。

## Non-goals

- 不在用户运行时下载 provider、执行公开 installer 或独立升级 bundled provider。
- 不把 external 安装引导扩展成 packaged Desktop 的默认路径。
- 不在本 fallback 文档中实现 packaged macOS/Windows provider；Linux 仍不支持。
- 不创建插件市场或任意第三方安装能力。
- 不改变 MCP 工具审批语义。
- 不做移动端适配。

## Acceptance Criteria

- Packaged macOS/Windows Desktop 使用 bundled embedded 状态与平台修复引导，不显示本安装抽屉。
- 插件管理只有一个 Cua Driver。
- 驱动存在时不出现安装文案或安装按钮。
- macOS 驱动缺失时安装引导清楚说明外部来源并支持重新检测；Windows missing 不展示
  不适用的 Bash 命令。
- 自动接入保持禁用，只有用户启用后才同步和暴露工具。
- 旧接口和旧记录不导致第二个可见条目或重复 MCP 服务。
