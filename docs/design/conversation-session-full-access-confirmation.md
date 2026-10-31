# 会话级完全访问确认

## Summary

完全访问采用“每个对话确认一次”，不是每条消息确认，也不是工作区永久授权。当前对话首次以
`full_access` 发起真实运行时显示确认 Dialog；也可在权限菜单主动选择时提前确认。确认后，同一会话后续请求复用该确认记录并继续随请求
提交给 daemon。页面刷新、renderer 重建或客户端重开后，同一 scope 仍复用已确认记录。

## Product Contract

- 普通对话以 thread 为会话；尚未创建 thread 时以当前新对话 draft generation 为临时身份，首条消息绑定
  thread 后必须继承同一次确认。
- 普通对话中，用户在当前对话的权限菜单里主动选择 `full_access` 时先显示确认 Dialog；确认成功后才切换
  为 `always + full_access`，取消则保留原来的两项选择。后续发送不再叠加第二个确认 Dialog。
  由工作区默认值继承 `full_access` 时，首次真实运行仍显示确认 Dialog。
- 频道以 workspace、实际执行路径、channel ID、canonical thread ID 和策略版本组成 scope；
  默认会话与每个具名会话独立确认。回到同一会话且路径/策略未变时复用该会话确认。
  新会话草稿仅向同一创建 key 返回的 thread 转移同次确认；旧 root/branch scope 升级后不批量继承。
- AI 队友私聊以当前 teammate direct conversation 为会话；切换队友后重新确认。
- AI 队友私聊中，用户在当前对话的权限菜单里主动选择 `full_access` 时先显示确认 Dialog；
  确认成功后切换预设，后续发送不再叠加第二个确认 Dialog。
- AI 队友私聊从工作区默认值继承 `full_access` 时，不视为用户在当前对话主动确认；首次真实运行仍显示确认 Dialog。
- 工作区执行路径改变、默认权限预设改变、授权模式改变或 Approval Policy 更新后重新确认。
- 确认以不可读 scope 摘要写入 Web/desktop renderer localStorage，最多保留最近 256 个对话；不保存路径明文、密钥或权限令牌。
- 不写入 workspace settings、SQLite 或 daemon；存储不可用或损坏时安全降级为重新确认。
- 每个 full-access 请求仍携带合法 `PermissionConfirmation`；daemon 的 full-access 校验不得跳过或弱化。
- 当前 scope 完成确认后，默认策略下的 `read`、`edit`、`write`、`bash` 等常规本地工具不再逐项打开运行时审批弹窗。
- Agent/Skill 的强制 Approval Profile、外部发送、部署、凭据操作和其他独立安全边界仍可要求审批；工作区明确 `deny` 的工具直接阻止，不因 full access 放宽。

## UI Contract

- 菜单长名称为“完全访问权限”，按钮保持“完全访问”。说明和确认框明确：用户确认后，本会话同时启用自动审批与 Full Access；系统权限和 Host 拒绝规则仍有效。不能把仅 `always`、仍受限沙盒的配置误标为完全访问，也不改变全局默认权限。
- 未确认时显示“完全访问”。
- 三种会话统一使用紧凑的“完全访问”按钮，当前 scope 已确认时通过辅助名称和 tooltip 显示“完全访问 · 本对话已确认”。
- 三种输入框均只保留一个权限入口；独立沙盒配置位于设置，保存为当前工作区默认值。请求审批/帮我审批保留沙盒，显式确认完全访问后才同时切换审批与沙盒；离开完全访问恢复先前沙盒，恢复历史会话而无先前值时使用工作区默认值。
- 该文案只说明当前会话 scope 已确认，不表示工作区或所有对话的永久授权。
- Dialog 保留工作区外文件、网络和工具风险说明，并明确确认只作用于当前对话。
- 取消确认不发送消息、不创建运行、不清空草稿。
- 主动选择完全访问并完成 Dialog 确认后，立即更新对应的确认状态；仅由默认值继承时保持未确认状态。

## Invalidation

以下任一变化都生成新的确认 scope：

1. 新建或切换普通对话。
2. 切换到尚未确认的频道会话；已确认会话仍按其原有有效 scope 查找。
3. 切换 AI 队友。
4. workspace cwd 或频道实际执行路径改变。
5. 默认 authorization/access/permission preset 变化。
6. Approval Policy `updatedAt` 变化。
普通对话首条消息从 draft 绑定到 thread 是同一会话的身份升级，不属于失效条件。
频道草稿绑定同一创建 key 返回的 canonical thread 同理；详见[频道下多会话](channel-sessions-detailed-design.md)。
页面刷新、renderer 重建和应用重开不再属于失效条件。

## Boundaries

- 不改 daemon route、public API、contracts、SQLite schema 或 full-access enforcement。
- 不增加“始终允许”“记住此工作区”或跨会话复用。
- 不把频道、普通对话和队友私聊合并为同一授权 scope。
- 三种会话在主动选择完全访问时完成本 scope 确认，后续运行复用；继承默认完全访问但尚未确认时，仍在首次真实运行前确认。
- Runtime tool approval 仅在更严格的 Agent/Skill Approval Profile 等有效策略仍要求 `ask` 时出现；外部动作及其他专用审批继续独立生效。
