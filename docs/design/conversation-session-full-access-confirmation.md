# 会话级完全访问确认

## Summary

完全访问采用“每个对话确认一次”，不是每条消息确认，也不是工作区永久授权。用户在权限菜单选择
`full_access` 时必须先显示确认 Dialog；只有确认后才切换权限预设。由工作区默认值继承完全访问时，
当前对话首次发起真实运行仍显示同一确认 Dialog。确认后，同一会话后续请求复用该确认记录并继续随
请求提交给 daemon。页面刷新、renderer 重建或客户端重开后，同一 scope 仍复用已确认记录。

## Product Contract

- 普通对话以 thread 为会话；尚未创建 thread 时以当前新对话 draft generation 为临时身份，首条消息绑定
  thread 后必须继承同一次确认。
- 普通对话中，用户在当前对话的权限菜单里主动选择 `full_access` 后先显示确认 Dialog；取消时保持
  原预设，确认时才记录本对话确认并切换预设。由工作区默认值继承 `full_access` 时，首次真实运行
  仍显示确认 Dialog。
- 频道以当前 channel conversation 为会话；切换频道或频道分支后重新确认。
- AI 队友私聊以当前 teammate direct conversation 为会话；切换队友后重新确认。
- AI 队友私聊中，用户在当前对话的权限菜单里主动选择 `full_access` 后使用同一确认流程，选择动作
  本身不再视为确认。
- AI 队友私聊从工作区默认值继承 `full_access` 时，不视为用户在当前对话主动确认；首次真实运行仍显示确认 Dialog。
- 工作区执行路径改变、默认权限预设改变、授权模式改变或 Approval Policy 更新后重新确认。
- 确认以不可读 scope 摘要写入 Web/desktop renderer localStorage，最多保留最近 256 个对话；不保存路径明文、密钥或权限令牌。
- 不写入 workspace settings、SQLite 或 daemon；存储不可用或损坏时安全降级为重新确认。
- 每个 full-access 请求仍携带合法 `PermissionConfirmation`；daemon 的 full-access 校验不得跳过或弱化。
- 当前 scope 完成确认后，默认策略下的 `read`、`edit`、`write`、`bash` 等常规本地工具不再逐项打开运行时审批弹窗。
- Agent/Skill 的强制 Approval Profile、外部发送、部署、凭据操作和其他独立安全边界仍可要求审批；工作区明确 `deny` 的工具直接阻止，不因 full access 放宽。

## UI Contract

- 权限选择遵循三态转换：打开 Dialog 时权限不变；取消时保留原权限；确认记录成功后才切换为完全访问。
- 未确认时显示“完全访问”。
- 当前 scope 已确认时显示“完全访问 · 本对话已确认”。
- 该文案只说明当前会话 scope 已确认，不表示工作区或所有对话的永久授权。
- Dialog 按“文件和文件夹”“终端命令”“互联网和已连接应用”三组说明能力范围，并明确提示敏感数据
  泄露和提示注入风险，以及确认只作用于当前对话。
- 取消确认不发送消息、不创建运行、不清空草稿。
- Dialog 打开期间背景 Composer 受模态可访问性约束而不可交互；取消后焦点回到仍然生效的权限选项，确认后焦点回到已生效的“完全访问”，不得因焦点恢复再次触发确认。
- 普通对话、频道和 AI 队友私聊只有在确认动作完成后才显示“完全访问 · 本对话已确认”；Dialog 打开
  或取消期间保持原权限文案。

## Invalidation

以下任一变化都生成新的确认 scope：

1. 新建或切换普通对话。
2. 切换频道或频道分支。
3. 切换 AI 队友。
4. workspace cwd 或频道实际执行路径改变。
5. 默认 authorization/access/permission preset 变化。
6. Approval Policy `updatedAt` 变化。
普通对话首条消息从 draft 绑定到 thread 是同一会话的身份升级，不属于失效条件。
页面刷新、renderer 重建和应用重开不再属于失效条件。

## Boundaries

- 不改 daemon route、public API、contracts、SQLite schema 或 full-access enforcement。
- 不增加“始终允许”“记住此工作区”或跨会话复用。
- 不把频道、普通对话和队友私聊合并为同一授权 scope。
- 频道、普通对话和 AI 队友私聊主动选择完全访问时统一先确认，取消不改变现有权限。
- Runtime tool approval 仅在更严格的 Agent/Skill Approval Profile 等有效策略仍要求 `ask` 时出现；外部动作及其他专用审批继续独立生效。
