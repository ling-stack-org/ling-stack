# TerminalReport：已提交证据与已发布结果分开选择

## 已复现问题

R11 的 generation 2 已真正发布 canonical `terminal_report` Item；随后恢复生成的
generation 3 已提交 fallback，但因 `source_turn_conflict` 未发布。默认集合查询只按
最新 committed/fallback 选择，导致 generation 2 被遮住；前端正确拒绝没有匹配锚点的
generation 3，最终既没有收尾，也没有变更卡。真实 GET-only captures 177/178 保留原始证据。

## 契约

- `effectiveOnly` 原有内部语义不变：选择每个 source 最新 committed/fallback。
- 新增内部 `publishedOnly`：必须有准确匹配的 committed canonical result Item。
  同时校验 workspace/channel、存在时的 thread/turn、原用户 source Item 归属，以及 payload 的
  report/generation/source/fingerprint/outcome；只接受无私有 owner 的 `channel`/
  `thread_participants` 可见性，私有/操作员专用锚点不参与展示。单有 `result_item_id` 不能证明发布。
- 两个选项组合：只在已发布集合中选择最新 generation，筛选和去重均先于 LIMIT。
  未发布/断链/错误锚点的新版不能遮住最后真实发布的版本。
- 普通/频道默认报告集合和普通上下文事实选择采用组合查询；`includeHistory=true` 仍保留
  已提交未发布的审计历史，详情和协调器恢复策略不变。普通会话详情原有 result Item 校验不放宽。
- 审批 post-commit 收据仍读取最新 committed 证据，并要求对应出版证明；不得用旧报告替代
  当前审批效果是否完成的校验。

## 不做的事

不修改发布/结算事务、不允许 succeeded Turn 重结算、不重开成功 Turn、不自动重放工具、
不写真实历史、不补造锚点、不删除孤立报告、不放宽 UI exact-anchor guard、不新增表。
成功 Turn 同终态内容修订需要独立的不重结算发布契约，不属于本修复。

## 验证

原生回归通过实际 SQLite、真实发布入口和临时 Daemon HTTP 路由覆盖：发布失败保留旧结果；
悬空/错误 marker；LIMIT 前过滤；合法 blocked→retry→success 的发布替换；普通和频道列表；
无发布记录时默认空；审计保留所有版本。假模型/合成 Run 不是 live 模型或 GUI 验收。
修改后必须用精确后继 QA 包只读打开 R11，核验收尾与变更卡，不重新执行其工具。
