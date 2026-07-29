# 会话级完全访问确认实施计划

## Module Boundaries

- `useFullAccessConfirmationController`：Dialog 生命周期、scope 查询和 draft-to-thread 绑定。
- `useFullAccessConfirmationController`：提供幂等的显式选择确认入口，只由普通对话和 AI 队友私聊的用户选择事件调用。
- `full-access-confirmation-storage`：不可读 scope 摘要的 localStorage 加载、校验、上限和安全降级。
- AppShell：组合 workspace、conversation identity 和 policy fingerprint；不持有 Dialog Promise 细节。
- Normal/Channel/Teammate composers：只接收 `fullAccessConfirmed` 展示状态，不访问缓存。
- 现有 API client/domain：继续透传 `PermissionConfirmation`，不改变 payload。
- E2E support：共享 scope 行为和 composer 状态断言，避免三套测试复制。

## Implementation Steps

1. 新增 `FullAccessConfirmationScope` 和纯 scope-key helper。
2. controller 从浏览器存储加载确认并保留内存 Map；同 scope 请求直接返回缓存证据，新 scope 打开 Dialog。
3. 普通对话首发成功绑定 thread 时复制 draft scope 确认到 thread scope。
4. AppShell 为频道、普通对话和队友私聊生成独立 scope，并把确认状态传给对应 composer。
5. 扩展权限菜单选项展示“完全访问 · 本对话已确认”，同步中英文文案。
6. 更新 Dialog 说明，明确只确认当前对话。
7. AI 队友私聊主动选择 `full_access` 时直接写入当前 teammate scope；工作区默认值同步只更新选中项，不触发确认。
8. 普通对话主动选择 `full_access` 时写入当前 draft/thread scope；首条消息绑定 thread 时继续继承同一次确认。

## Test Plan

- 同一普通对话首条消息确认，第二条消息不弹窗且请求仍带 confirmation。
- 普通对话从其他权限主动切到完全访问后立即显示已确认，首条运行不弹 Dialog 且请求携带 confirmation。
- 普通对话继承工作区完全访问默认值时保持未确认，首条运行仍弹 Dialog。
- 新建/切换普通对话重新确认；draft 绑定 thread 后不重复确认。
- 同一队友第二条私聊不弹窗，切换队友重新确认。
- 私聊从其他权限主动切到完全访问后立即显示已确认，首条运行不弹 Dialog 且请求携带 confirmation。
- 私聊继承工作区完全访问默认值时保持未确认，首条运行仍弹 Dialog。
- 同一频道后续 full-access 运行不重复确认，切换频道/分支重新确认。
- cwd、权限默认值或 Approval Policy revision 改变后重新确认。
- 页面重新加载、renderer 重建和应用重开后，同 scope 确认仍有效。
- localStorage 损坏、禁用或超限时安全降级；路径明文不进入持久化 payload。
- 取消确认保持 draft 和 mutation-free；每个实际请求仍包含合法 confirmation。
- Web typecheck、conversation package、focused Playwright、i18n、UI2 lint 和 `git diff --check`。

## Hard Stops

- 若 daemon 需要新增会话授权存储或放宽 full-access 校验，停止并重新设计。
- 若实现必须把确认写入 SQLite、workspace settings 或 daemon，停止。
- 若 Runtime approval、工具决策或审批 enforcement 语义发生变化，停止。
