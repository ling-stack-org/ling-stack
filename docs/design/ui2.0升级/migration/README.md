# UI2 迁移与遗留兼容

Status: active compatibility contract
Owner: UI platform maintainers
Last verified: 2026-10-23
Code anchors: `packages/ui-react/src/`, `apps/web/src/shared/ui/`, `apps/web/src/styles/`
Test anchors: `packages/ui-react/test/package-boundary.test.mjs`, `apps/web/e2e/ui2-components-zero-ref-prune.spec.ts`

## Current State

当前可达 Web UI2 主迁移已经关闭。本目录不再保存逐文件替换表、截图台账、完成百分比、selector 数量、
测试次数或阶段流水；这些历史由 Git 保留，新证据进入 CI 或 Release artifacts。

## Remaining Work

只保留以下尚未完成或需要独立发布验收的事项：

- Work Board 产品开发；
- Startup 与 Diagnostics 重新开放；
- Workspace Tools 嵌入态；
- 官方场景主题与自定义媒体背景的原生持久化与发布；
- Desktop 主窗口、Computer Use PiP 和 packaged macOS/Windows 验收；
- 各产品合同明确标记为 pending 的 Council runtime、MCP 或其他真实能力。

这些事项由对应模块实施计划和
[Desktop 跨平台发布清单](../release/01-Desktop跨平台发布验收清单.md)管理，不再建立第二套 UI2 状态看板。

## Compatibility Rules

- 生产 Feature 通过 Web shared adapter 使用 `@ling-stack/ui-react`，不直接依赖 primitive 内部结构。
- 兼容 facade 只能转发 API、事件和测试选择器，不能拥有第二套 JSX、状态或 CSS。
- 旧 selector、硬编码颜色、私有图标、原生确认框和命令式 overlay 在无生产 owner 后直接删除。
- `StatusBadge` 等仍有真实产品语义的组件按具体领域决定，不因历史迁移名称机械删除。
- Web 已验证不等于 packaged Desktop 已验证；Windows、签名、DPI、high contrast 和原生恢复必须使用
  本次发布证据。
- 安全、权限、审批、provider authority、SQLite、恢复、签名和供应链边界不得为视觉迁移而改变。

## Documentation Rule

新 UI2 工作优先更新基础合同、共享组件合同或具体产品模块合同。实施计划只在任务未完成期间存在；完成后
提取长期约束并删除。不得重新创建迁移矩阵或在设计目录保存运行截图。
