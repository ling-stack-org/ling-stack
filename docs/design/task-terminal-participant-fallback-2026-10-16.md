# B-010：空贡献兜底不能伪称完成

日期：2026-10-16
状态：单 helper 产品修复、真实 RED→GREEN 和未实施者窄审已完成；尚非 packaged App 验收。

## 当前真实链

`maybeScheduleRunTerminalReport` 只把 conversation / teammate_direct 转到 Turn 路径；task thread
仍以 Run 为 source。`collectRunTerminalReportEvidence` 的 contribution 来自 assistant summary /
failure summary，而不是 Turn aggregator 的 typed-action 优先摘要。完成一次工具后没有 assistant
摘要便取消，Run 的 SQL `error_message IS NULL`（公开 mapper 暴露为 `errorMessage:undefined`）、
operations 非空、participant.status=cancelled 但贡献可空。

`processRunTerminalReport` → `synthesizeTerminalReportContent` 在无 runtime/provider、请求失败等
情况下真实进入 deterministic fallback。Core `terminal-report-fallback.ts` 仍对全部空贡献使用
`terminal_report.participant.completed`，因此 Store 中 outcome 和 participant 虽然 cancelled，
人类可见叙述却称“完成了分配的工作”。共享 view-model / copy 直接采用该 contribution，不会修复。

这是已确认的叙述准确性问题，不把它扩称任务状态成功、取消安全失效或权限绕过。

## 最小合同与实现边界

1. 只修 `buildDeterministicTerminalReportContent` 中真正空贡献的 fallback。已有贡献及 sourceRefs、
   participant status、整体 outcome、工具事实、证据指纹均保持不变。
2. participant.status=completed 时沿用原 completed 文案；failed / blocked / cancelled 不能出现
   assigned-work-completed 语义，使用明确失败/受阻/取消的状态句，或同样真实的中性句。
3. 最小实现可把 status 传入现 helper：completed 用现 participant.completed；其余三值复用
   已有本地化 `terminal_report.outcome.<status>`。participant 行已有身份，贡献无需再次拼名字。
   不新增多份前端补丁、不把错误叙述藏在 UI、不新增几十份 locale key。
4. 不改普通/私聊 Turn aggregator 已有的 typed-action 优先摘要，不以模型“说完成”覆盖 Host status，
   不顺便改 model synthesis 或执行完成判定。
5. Run 的合法终态没有 blocked。blocked 正例使用合法 Workflow / Step 状态和真实 Store 证据，
   不把 Run 写成非法 blocked 来凑测试。共享 fallback 对这种空贡献也不能用 completed 文案。
6. 不增加表、不修改真实数据、不迁移已有报告。仅未来重建/新报告采用修正后的 deterministic 文案。

## 专用测试与证据限制

- `packages/daemon/test/support/task-terminal-empty-contribution-fixture.mjs`：显式独立 repo-local
  SQLite；真实 task thread、Turn、Task、Run。fixture runner 实际读取临时文件，工具事件写入
  Store；读完后通过真实状态机终结，直接 SQL 断言 `error_message` 为 NULL，公开 DTO 断言
  `errorMessage` 为 undefined，不混淆两层合同。synthesis 使用无 runtime
  或抛错的本地 runner，不访问网络、Provider 服务、Keychain、日常 DB 或真实 GUI。
- `packages/daemon/test/task-terminal-participant-fallback.test.mjs`：en-US / zh-CN，cancelled /
  failed / succeeded，真实 synthesis unavailable / request-failed → fallback → commit / publication
  → reopen，验证 outcome / participant 及文案一致；合法 blocked 空贡献、已有贡献原样保留；
  conversation / teammate_direct 的 typed-action 摘要不退化。
- `apps/web/test/task-terminal-participant-fallback.test.mjs`：用同一真实 Store coordinator 产物
  经共享 `terminalReportToViewModel` 和真实 `terminalReportCopyText`，取消/失败/受阻不复制
  completed 文案；不是 fabricated DTO，也不声称跑过 DOM 或 packaged App。

Root 有效 RED 为 26 项中 10 pass / 16 fail、actual exit 1，目标是非完成状态被叙述为完成；
更早一次 SQL NULL/DTO undefined fixture setup 失败保留，但不计作产品 RED。Core 最小 helper
修复后 fresh Core build actual exit 0，11 完整文件联合 159/159、actual exit 0，零 fail/cancel/skip/todo。
当前 B009/B010 字节的 Desktop source-input 412/412、actual exit 0，native/compiler/signing 为
synthetic、fixtureOnly=true、artifactExecuted=false，不是包或 GUI 验收。

未实施者窄审 `output/e6-20260928/b010-task-fallback-independent-review-20261016.md`
结论 PASS_SCOPED_WITH_LIMITS，无当前窄范围确认残留，approved=false。共享 copy 函数测试
不是本轮真实剪贴板验证，已有历史报告没有迁移。本项不批准 Office 审核记录或正式发布。

无新用户决策。B-010 不替代其余 B 项或 packaged GUI 验收；保留大 evidence/coordinator 文件为
既有模块风险，本项只修改 Core 小 helper，不向这些大文件添加新职责。
