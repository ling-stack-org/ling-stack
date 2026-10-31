# 执行详情归属与最终回复

状态：2026-10-27，共享 Web 实施契约。替代旧的“结尾再次展开整份 TerminalReport”展示契约；不修改事实存储、完成判定或模型文本。

## 目标和边界

普通会话、队友私聊、频道及嵌套子 Agent 使用同一份 timeline renderer。命令、工作目录、输出、耗时、退出码属于具体 `commandExecution`；文件变更属于 `fileChange` 及独立的已编辑文件卡。最终回复不再复制这些机器字段，也不再次铺完整报告。

这采用 Codex 的 typed-item 原则，并非声称开源 TUI 与桌面客户端的最终 DOM 相同。保留当前 `ConversationTimelineCommandRenderer` / `CommandDetail`，不重写工具 UI。

## 最终结果投影

先执行现有 `visibleTerminalReportTimelineItem` 隐私投影，再生成共享 `terminalReportFinalPresentation`，供 renderer 与日常 response copy 使用。

有已完成 final narration 时：

- 成功且无补充：不再展示第二份报告 summary。
- 非成功：显示紧凑真实状态，不因模型说“完成”而改为成功。
- 保留影响结果的检查结论，包括失败、阻塞、取消、未执行和未知；Host 明确标记 informational 的 skipped/not_run 可省略。
- 保留未完成参与者、待处理或未知风险、审批未决/拒绝/过期/取消，以及事实更正与非 file/diff/test_result 交付。
- 不重复已通过检查、已完成参与者叙述、完整 Changes / Sources 清单、命令、duration。

当前公开 participant 投影没有 required 字段，因此不能在 UI 猜测 optional 并隐藏；保守保留所有未完成参与者。required fan-in 仍由 Host 决定，不由 UI 计数推断。

无 final narration 时保留安全 fallback：

- outcome summary 仍可作为最终正文；Host fallback 可补有界文件名和检查 title/status。
- 不以原始 command 代替检查名称，不从输出拼总结，不从 metadata count 发明证据。
- 中断、未知影响及未执行检查仍有可见结尾；不会仅因工具 exit 0 宣称完成。
- attention 检查及风险在紧凑条目中呈现，不再同时附到 fallback 正文第二次。

## 复制与事实保留

`response.copyText` 仍包含本轮所有 agentMessage/commentary/final，不能退回“只复制最后一段”。仅 settled response 提供复制。

`timelineResponseCopyText` 在原文本后追加同一最终结果投影的可见补充；不得暗中附整份结构报告。模型正文若主动提及命令或退出码，不解析、不改写它。

`terminalReportCopyText` 保留为显式完整结构报告 serializer：继续隐私过滤、保留完整 Markdown、命令 fence 和报告全文测试；它不是日常 response copy。SQLite 报告、RunEvent/ExecutionAction、generation、sourceRefs 和终态判定不变。

独立的已编辑文件卡、总计/逐文件 +/-、变更跳转、child isolation、单一 footer 与可访问 disclosure 保持现有实现。

## 验证与非声明

先用 Vite SSR 加载真实 production renderer 做 RED→GREEN，再验证原 display policy、fallback、完整报告 serializer、response ownership、privacy 与 source contract。同步更新三入口的 mocked browser E2E 契约，不 skip 旧异常场景。

SSR / mocked E2E 不能代替 macOS packaged GUI。最终新包需要包含本次 UI 字节，由 Root 完成新 Office 输入差量、独审和真实客户端验收；旧包截图不覆盖当前实现。
