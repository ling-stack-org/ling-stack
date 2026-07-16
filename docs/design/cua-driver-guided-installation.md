# Cua Driver 自动检测与安装引导

## Summary

Ling 只向用户展示一个 `Cua Driver`。它是用户电脑上的外部本地驱动，不是
Ling 自带的原生程序。Ling 负责检测、配置 MCP、同步工具和展示安装引导，
但不静默下载或执行外部安装脚本。

产品规则：

- 检测到 `cua-driver` 时不显示安装提示。
- 检测到但未接入时，Ling 静默创建禁用的 MCP 配置。
- 用户必须明确点击启用，Ling 才能获得电脑控制能力。
- 未检测到时才显示安装引导、官方链接、复制命令、指定路径和重新检测。
- 辅助功能、屏幕录制权限是安装后的独立状态，不伪装成“未安装”。

## User Flow

```text
打开插件管理
  -> 检测本地 cua-driver
     -> 已检测
        -> 已接入：显示已连接或已启用
        -> 未接入：静默创建禁用 MCP 配置，显示待启用
     -> 未检测
        -> 显示安装引导
        -> 用户从官方渠道安装或指定绝对路径
        -> 重新检测
        -> 自动接入为禁用状态
     -> 平台不支持
        -> 显示不可用，不展示安装按钮
```

## Visible States

| State | 用户可见状态 | 主操作 | 安装引导 |
| --- | --- | --- | --- |
| `missing` | 尚未安装 Cua Driver | 安装引导 | 显示 |
| `detected` | 已检测，正在接入 | 无 | 隐藏 |
| `connected` | 已检测，待启用 | 启用 | 隐藏 |
| `ready` | 已启用 | 停用 | 隐藏 |
| `unsupported` | 当前平台不支持 | 无 | 隐藏 |

## Installation Guidance

- 官方文档：<https://cua.ai/docs/cua-driver>
- 官方安装命令：

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

Ling 只允许用户主动复制命令或打开官方文档，不自动执行命令，不请求 `sudo`，
不托管安装包，也不把安装成功等同于系统权限已授权。

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

- 不实现 Ling 内下载、安装、升级或卸载 Cua Driver。
- 不扩展 Windows/Linux 产品支持。
- 不创建插件市场或任意第三方安装能力。
- 不改变 MCP 工具审批语义。
- 不做移动端适配。

## Acceptance Criteria

- 插件管理只有一个 Cua Driver。
- 驱动存在时不出现安装文案或安装按钮。
- 驱动缺失时安装引导清楚说明外部来源并支持重新检测。
- 自动接入保持禁用，只有用户启用后才同步和暴露工具。
- 旧接口和旧记录不导致第二个可见条目或重复 MCP 服务。
