# Normal context: TerminalReport fork 与摘要重建修复

## 范围与不变边界

接续 E6 全文独审后的 A14 / B-007；基线为已合并的 `f806aa8d`。
本组不重写会话、Provider session、报告发布或权限机制，不新增表、不修改日常历史。
UI 和 packaged macOS 验收独立于本组源码回归，不能以回归通过替代。
主 CI 按用户决定不查询、不启用、不等待，不作为本组门槛。

## A14：冻结 fork 历史的合法报告类型

Host 在读取普通会话历史时已经校验报告的发布 Item、所属 workspace/thread/Turn、
effective generation 和 evidence fingerprint。hydrator 由这些事实生成：

```text
origin = terminal_report
role = context
turnId = 被报告的 Turn
reportId = TerminalReport 记录 ID
sourceRefs = 一个 canonical conversation_item 引用
```

`reportId` 与发布 Item ID 属于不同身份，不能要求相等。
fork validator 应接受这一精确 variant，同时保持字段闭集、非空身份、
合法 Item sequence/revision 和单一 Item ref。不能把报告转成 assistant 叙述，
也不能因新增 variant 接受任意 origin 或 run/tool ref。

分支创建仍在原事务内完成；捕获失败不留下 child 或 seed。
子分支读取冻结 payload，不因后续父历史变化重新捕获，也不继承执行权限。
预算仍按完整 group 选择，摘要覆盖和预算省略不能截断报告或改变原分组。

首次真实回归：正式 `processTurnTerminalReport` 发布历史报告，后继终态 Turn 经
HTTP fork route 返回 `409 normal_fork_context_invalid`；失败前后 child/seed 均为零。
原日志保存在 `/tmp/ling-a14-b007.UEzCk4/a14-first-red.log`，不是手造报告 JSON。

## B-007：全历史单调版本分配

现有唯一键为 `(thread_id, segment_id, version)`，不含 scope/status。
旧实现从当前 active 记录计算版本，active 被纠正失效后会重用旧版本；
同 segment 的不同 scope 也可能分配相同版本。

在原 `BEGIN IMMEDIATE` 内、既有准入与 source/assignment/active fence 通过后，
读取同 workspace/thread、NULL-safe 同 segment 的全部状态/全部 scope：

```sql
SELECT COALESCE(MAX(version), 0) + 1 AS version
FROM conversation_context_summaries
WHERE workspace_id = ? AND thread_id = ? AND segment_id IS ?;
```

继续只 supersede 同 scope 的 active predecessor。invalidated 历史保持原字节，
不伪造 supersedes 关系；迟到结果继续返回 `discarded_stale`。
INSERT 失败必须整体回滚，不能留下已 superseded 的旧 active 或半个新摘要。

首次真实回归：public commit v1 → public assignment move → invalidated → fresh fence
重建，触发上述唯一键冲突；原日志为 `/tmp/ling-a14-b007.UEzCk4/b007-first-red.log`。
最小修复后 Core / Daemon 两完整相关文件实际 31/31，零 fail/cancel/skip/todo、exit 0。
包含多次重建、跨 scope、NULL segment、双 Store 迟到结果、两种 INSERT 故障完整回滚，
以及 coordinator 新 checkpoint 与不复活被移出主题的内容。

## 本组最终源码验证

九个相关包先 fresh 编译成功；两个最小产品修复后 Core / Daemon 再编译成功。
A14 新文件完整 41/41（八个主测试、33 个负例子测试），B-007 两完整文件 31/31，
八个完整邻近文件 99/99，三批均 actual exit 0、零 fail/cancel/skip/todo。
这些是三个独立命令，不是一次全仓库测试；不累加中间或重叠结果。

原始失败和最终成功日志已复制到 `output/e6-20260928/a14-b007-20261015/`。
Core / Daemon source+dist 的 3,147 项执行前后哈希一致；
13 个隔离 guard 文件累计网络/Keychain 尝试均为零。
未参与本次产品或测试新增部分的审阅者完成限定增量独审，无剩余已确认问题。
回执 `output/e6-20260928/a14-b007-final-independent-review-20261015.md`，
SHA-256 `930cc16a005cd9b003485f77a4e89c18eb5fd0b766de412fcda0c44f30dc3ddb`。
该独审只覆盖列明增量，`approved=false`，不是 Office 或 GUI 批准。

后继继续 A15 的 SSE / RPC WebSocket 出站背压和生命周期边界。
Office 受影响输入及具体用户批准、新包和 E6 真实 GUI 验收仍需分别收口。

没有新增未决产品设计选择；Office 具体审核批准仍是独立门槛，不自动生成 approved。
