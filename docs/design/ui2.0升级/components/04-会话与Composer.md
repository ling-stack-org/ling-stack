# 会话与 Composer

Status: active UI2 component contract
Owner: conversation UI packages
Last verified: 2026-08-03
Code anchors: `packages/conversation-ui-core/src/`, `packages/conversation-ui-react/src/`
Test anchors: `packages/conversation-ui-core/test/`, `packages/conversation-ui-react/test/`

会话组件负责跨频道、普通对话和队友私聊共享的消息结构、输入区与可访问交互，不拥有领域请求、
权限策略、模型选择或持久化。

## Messages

- 用户消息使用稳定浅灰气泡；AI 普通回复透明无边框，hover 不改变正文背景。
- 警告、阻断、审批和运行卡片持续显示自己的状态表面，不能依赖 hover。
- 头像与正文按顶部基线对齐；同一角色的普通消息和卡片消息使用同一几何。
- 消息操作在行 hover、行 focus-within 或按钮键盘焦点时出现，不点亮整条 AI 消息。
- raw tool payload、route、内部 ID 和重复的“收到”回执不进入默认 transcript。

## Composer

- 输入、附件、发送、停止、权限和模型阻断使用稳定区域；空白占位不得遮挡 transcript。
- 发送时立即消费已发送的排队引导；队列不等待 Agent 回复完成才移除。
- 普通消息与频道引导进入同一用户消息语义，不增加特殊标签。
- 缺少模型或权限时在 Composer 上方使用共享状态条；阻断不清空草稿。
- 发送、停止和附件操作具有稳定尺寸，输入增长达到上限后内部滚动。

## Accessibility

消息操作、附件和权限控件均可键盘到达；流式更新避免反复播报全文，停止和重试提供明确名称。
