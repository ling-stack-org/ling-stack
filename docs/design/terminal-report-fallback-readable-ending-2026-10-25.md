# TerminalReport 回退收尾：共享展示契约

状态：源码与自动回归通过；尚未纳入新的 macOS QA 包，不能视为 GUI 验收完成。

## 已确认的问题

真实 R11 generation 2 的模型总结在 45.075s 后超时，Host 正确保留了执行结果并
生成 fallback，但默认收尾只显示“任务已完成。完成2/2个步骤。”。报告已有真实
文件与检查信息；不需要重跑工具、延长模型预算或把子 Agent 的文字当成执行证据。

`fallbackOutcomeSummary` 只输出状态与步骤数；原共享展示没有 report provenance，
不能可靠区分 Host fallback 与正常模型总结。用文本正则识别来源会误伤正常回复。

频道的 Host `presentationRole=narration` 已在统一时间线的 `addItem` 阶段投影为
`phase=commentary`。保留“运行已开始”作为历史过程，不把它升级成最终回答，
也不按文字内容删除历史。已有终态叙述判定不允许 commentary 压掉唯一报告收尾。

## 设计与边界

1. 共享 terminalReport item 增加可选 `reportStatus: committed | fallback`，由已有
   Host 报告状态直传。canonical projector 与频道 adapter 使用相同字段；它不同于
   `outcomeStatus`，不新增 SQLite 字段、协议事件或完成凭据。
2. 只有明确为 fallback 且无有效最终模型叙述时，补充有界事实预览：至多四个
   去重文件路径、四条真实检查的 command/title 和原状态。正常 committed 与来源
   未知的报告维持原展示，不猜测来源，不生成新的自然语言结论。
3. 先执行既有隐私投影：混合 private/audit/developer_only/secret_adjacent 来源的
   内容整项隐藏；同 identity 的强限制不能被较弱副本覆盖。不展示子 Agent 自述、
   raw stdout/stderr、内部 source ID，也不由 section count 编造检查或文件。
4. 路径与命令按 literal inline code 展示，单项最多 160 字符，归一化控制字符并
   选择不会被原文反引号闭合的 fence。预览截断不影响完整报告、详情及复制。
5. 简短预览不分摊 change 的增删总数：一个 change 可包含多个文件，隐私投影
   也可能移除内部路径。精确逐文件 +/- 及 diff 导航继续由原文件卡片提供。
6. 失败、取消、blocked 的关键 run 中断/影响未确认提示保留，不能因补充交付
   事实而淡化风险。required fan-in、执行/审批、generation、复制 owner 和嵌套
   child 隔离均不变。

## 本轮证据与未完成项

- 原 fallback 事实测试 RED：9 项中 4 fail；provenance RED：10 项中 1 fail。
- 多文件总数误标 RED：目标 1 项失败，真实输出曾把 +12/-3 标到两个文件。
- 最终两个定向文件 20/20，无 fail/cancel/skip。
- 完整共享会话核心 197/197，完整 Web 831/831，Web typecheck 和 diff-check exit0。
- 日志位于 output/e6-20260928/fallback-final-{focused-green,conversation-suite,web-suite,web-types}-20261025.log；
  多文件 RED 保留于 fallback-multi-file-count-red-20261025.log。

运行中的 QA 包仍是 f5168a2f，不包含此 WIP。下一阶段需独立差量审查、按原
QA-only 契约更新冻结输入并构建后继包，再查看原 R11 结果的展示和复制，无须
重跑已完成的工具。本轮不能替代 R5 承接授权、SSE/Daemon 恢复、动态委派、
Office GUI 或 H09 的剩余验收，总目标保持 active。
