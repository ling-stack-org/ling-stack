# E6 全量独审后的修复状态

日期：2026-10-13。实施分支：`codex/e6-safe-continuation`。
本记录区分局部修复、独立复核、远端备份、完整验收及合并，不替代正式审核批准。

## 已完成的局部闭环

| 根因 | 修复边界 | 实际回归 | 独立复核 |
| --- | --- | --- | --- |
| B003 | External-work 准入与取消使用原子状态 CAS 和精确 lease；Host 投影失败保留真实发送/执行事实，返回 503，不伪造执行失败或授予重发权限 | Core 完整 45/45；Host 完整 25/25；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核其发现的 Host 收尾缺口，无剩余已确认严重问题 |
| A08 | Draft 确认在同连接事务内建立 thread、definition 和 source pointer；反向 update/discard 不能覆写已确认终态；重复 discard 不改变原终态时间 | Core 完整 10/10；新 HTTP 与原 API 完整 12/12；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核真实双连接 RED→GREEN，反向 writer 候选关闭 |
| A22 | Parser 接受 exact primitive `approve/deny/manual`；Coordinator、Host、Core 各有独立权限守卫；畸形判词保持人工审批，不隐式写 deny | 新回归 55/55；五文件完整邻近 164/164；合法批准的真实命令仅执行一次，重复恢复不重放；build、直接类型检查及限定 diff check 通过 | 未参与实现的独立审阅者核对十个最终源码 SHA、控制流和日志，无已确认 finding |

上述回归均零跳过，实际执行者取得 exit 0。独立审阅者读取执行日志与源码，未重复执行测试；不能把继承的执行结果写成审阅者本人运行。

A22 首次 54 例的 43 个失败中，34 个是产品行为 RED，9 个是 fixture 血缘不足。修正 fixture 后，旧产品的 9 条真实链为合法 manual/deny 2 条通过、畸形判词 7 条失败。首轮 GREEN 的 approve 正例曾因 fixture 缺频道归属被生产准入正确拒绝；仅修正 fixture producer 后，最终 55/55 通过。失败记录保留，不声称首次即全绿。

## 正在处理，不能据此认定完成

- A09：长定时器 overflow、首次/refresh 的 SQLite next-due 写入故障已有初轮回归；独审发现的运行中 refresh 后异步收尾写入故障已真实复现。必须完成终态失败收口、可恢复 start 和后继 entry/generation 不被旧收尾撤销的验证及原审阅者复核。RRULE INTERVAL/anchor 是仍未关闭的独立失败面。
- A11：预览、正文物化和 ComfyUI `public_only` 必须将已审核 DNS 地址固定到实际 socket 连接；保持原 URL 的 Host/SNI/证书身份。准备离线真实 socket/TLS 回归，不以 fake fetch 或关闭 TLS 验证替代。
- A21/A33 及全量独审登记的其他根因：仍按各自回归入口继续，不能因上表三个局部闭环就全部清零。

## 不变的验收与合并门槛

1. 原完整输入阅读已到 EOF，不重复全文阅读；阅读覆盖不等于内容批准。后继变更必须重新绑定精确输入并完成受影响独立复核。
2. Office 的具体审核记录仍须用户批准；本记录不生成 `approved` 或 `contentReviewComplete`，不授权正式发布。
3. 后继 fresh packaged macOS、真实客户端案例、问答/恢复/沙盒/Harness 联合矩阵仍未全部完成。上述局部回归不是新包 GUI 验收。
4. E6 PR 保持草稿；备份不是验收通过。主 CI 停用且无 checks 的 PR 不能当成通过；有冲突、已确认缺口或未达到原验收门槛的 PR 不合并，不使用 admin bypass。
5. Dependabot #527–531 的处置分别保留 API/版本/许可适配或 hosted 安装、缓存、artifact round-trip 缺证，不能以文本可合并代替验证通过。

## 证据定位与保全

本地完整执行记录位于实施树的 `output/e6-20260928/office-full-content-review-20261010/`：

- `b003-core-red-green.md`、`b003-host-red-green.md`、`b003-independent-review.md`。
- `a08-confirmation-red-green.md`、`a08-independent-review.md`。
- `a22-exact-verdict-red-green.md`、`a22-final-source-sha256.txt`、`a22-independent-review.md`。
- A09/A11 的后继记录以各自实际执行回执更新，不能继承旧整文件 SHA 为新版本批准。

不修改根 checkout、日常数据库或另一 writer 的 `harness-delegation-storage-checkpoint-2026-10-09.md` WIP。仅对明确归属、完成局部闭环的修复作备份；未完成或他人 WIP 不批量 stage，不 reset、clean、stash、force-push 或删除分支。
