# Workspace Tools 嵌入态重新开放计划

Status: pending; Settings entry remains hidden

## Goal

让模型、AI 队友和 Council 在 Settings 中复用真实业务页面，同时保持 Settings 导航、返回、滚动和 overlay
边界。不得恢复旧 overview、iframe、重复 H1 或第二套领域状态。

## Required Work

- `SettingsWorkspaceToolSurface` 只提供壳层、label 和滚动 containment；业务状态留在各 Feature。
- Model、Teammate、Council 的 editor/Dialog 使用全局 overlay root，Esc 与焦点恢复一致。
- Settings 内部切换工具不丢失 Settings return target；显式“打开对话/频道”才离开 Settings。
- 页面、Settings content 和领域列表各自只有一个滚动 owner；`1440/1280/980` 宽度不双滚或裁切。
- 删除无生产 owner 的旧 overview 和 selector，不复制领域 CSS、颜色或控件视觉。

## Reopening Gate

- 重新核对三个入口的用户价值和信息层级，隐藏无可操作或纯技术页面。
- 运行 Settings、Model、Teammate、Council、AppShell 和 Dark focused/回归测试。
- 真实浏览器验证跨工具切换、Dialog、返回、长列表、Light/Dark、console 和 overflow。
- 证据进入 CI/Release artifacts；验证完成后才恢复 Settings 可见入口。

## Hard Stops

需要新增 API、route、ViewId、权限、领域状态副本，或通过移动 Portal/复制页面才能实现时重新设计。
