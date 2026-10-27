# Ling UI 2.0 文档入口

Status: current design source of truth
Updated: 2026-10-23

## Current Boundary

当前可达 Web UI2 主迁移已经关闭。以下工作仍独立处于待开发或原生验收阶段：

- Work Board 产品重新开放；
- Startup 与 Diagnostics 重新开放；
- Workspace Tools 嵌入态；
- 官方场景主题与自定义媒体背景的原生发布与持久化；
- packaged macOS/Windows、Computer Use PiP 和签名发布验收；
- 产品合同明确标记 pending 的 Council runtime、MCP 或其他高级能力。

Web verified 不等于 Desktop release-ready。原生状态只由
[Desktop 发布清单](release/01-Desktop跨平台发布验收清单.md)判定。

## Reading Order

1. [UI2 总合同](00-UI2.0整体升级方案.md)
2. [UI2 验收规范](03-UI2.0验收总规范.md)
3. [视觉语言](foundations/01-视觉语言与设计原则.md)
4. [Design Tokens 与主题](foundations/02-Design-Tokens与主题.md)
5. [共享 UI 架构](architecture/01-ui-react共享包架构.md)
6. 当前页面对应的模块合同

## Contracts

- Foundations：视觉、Token、布局、无障碍、跨端表面、i18n、图标。
- Architecture：共享包、Radix 边界、CSS 所有权、Web/Desktop adapter、主题运行时。
- Components：基础表单、浮层反馈、导航数据、会话、主题控件、Desktop 紧凑窗口。
- Modules：AppShell、会话、队友、Council、模型、插件、运行审批、媒体、Desktop 与 Settings。
- Themes：[主题系统入口](themes/README.md)。
- Migration：[遗留兼容与未完成事项](migration/README.md)，不是新的功能看板。

## Documentation Policy

- 设计文档只记录长期产品语义、架构所有权、高风险边界和验收规则。
- 组件具体 API 由 TypeScript 类型、单元测试和示例负责。
- 实施计划只在工作未完成时保留，完成后提取长期约束并删除。
- 截图、hash、测试次数和逐次 closeout 不进入默认分支，统一进入 CI 或 Release artifacts。
- 安全、权限、审批、迁移、恢复、API、签名和发布合同删除前必须单独复核。
