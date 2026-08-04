# Desktop 紧凑窗口与能力控件

Status: active UI2 Desktop component contract
Owner: `@ling-stack/ui-react` Desktop components and Desktop renderers
Last verified: 2026-08-03
Code anchors: `packages/ui-react/src/desktop/`, `apps/desktop/renderer/`
Test anchors: `apps/desktop/tests/computer-use-preview-renderer.spec.mjs`, `apps/desktop/tests/computer-use-page-deck-view-model.test.mjs`

本合同覆盖 PiP、Computer Use preview 等紧凑 Desktop renderer 的共享窗口骨架，不拥有 Electron、
IPC、CUA 状态机或媒体生命周期。

- header 提供可拖动区域，所有交互控件标记 no-drag；窗口控制遵从 macOS/Windows 平台习惯。
- 最小窗口仍保留当前对象、主状态和唯一恢复行动，辅助信息可以折叠但不能造成无路可退。
- 当前会话能力控件在频道、普通对话和队友私聊使用同一组件和授权语义。
- IconButton、Menu、Tooltip、StatusIndicator 与反馈复用共享组件，点击区域不小于 `32x32px`。
- 状态 overlay 不遮挡关键内容；错误提供重试/关闭，运行中提供停止，正常状态不制造常驻标签。
- Theme、locale 和能力由 Desktop main 的 typed snapshot 注入；renderer 不直接访问本地设置或文件。
- reduced motion、reduced transparency、forced colors 和高 DPI 下保持可读、可操作和稳定几何。
