# Startup 与 Diagnostics 重新开放计划

Status: pending; Settings navigation remains hidden

## Product Goal

重新开放前先确认用户任务：默认层回答“Ling 是否可以正常工作、哪里需要处理、如何进入完整运行诊断”。
保留代码和历史测试不能作为当前发布证明。

## Surface

- Startup 默认只显示一个主状态、更新时间和真实问题；ready 不显示绿色健康卡或“没有诊断”空态。
- Refresh 为轻量 IconButton；失败保留旧 snapshot 并标 stale。
- blocker 显示用户可理解的问题和现有修复路径；raw phase、code、path 和 payload 折叠。
- Settings 诊断只展示最近 Run、主状态、最近活动和“打开完整诊断”，不复制 retry/cancel/intervention。
- initial、unavailable、starting、degraded、failed、stale 和 partial 必须由真实 API 状态投影。

## Implementation Boundary

- 复用 `GET /startup/status`、`POST /startup/refresh` 和现有 Runs domain；不新增 repair API、route 或状态机。
- Startup 与 Runs 使用独立 view model/controller；AppShell 只提供薄导航和数据 adapter。
- 旧请求不能写入新 Run；detail 失败不清空 list，refresh 失败不伪装为启动失败。
- focused CSS 只管理布局，复用共享状态、列表、Inspector 和反馈组件。

## Reopening Gate

- 重新审阅中文/英文产品文案和默认信息层级。
- 运行 Startup/Runtime/Settings focused 与回归测试。
- 真实浏览器覆盖 `1440x960` Light、`1280x800` Dark、长问题、内部滚动、键盘、console。
- 证据进入 CI/Release artifacts；通过后才恢复 Settings 导航入口。

## Hard Stops

需要伪造修复、吞掉 Runs error、删除审计记录，或改变 Startup/Runs API、权限和状态机时重新设计。
