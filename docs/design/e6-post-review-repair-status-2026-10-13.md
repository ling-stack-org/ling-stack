# E6 全量独审后的修复状态

日期：2026-10-13。实施分支：`codex/e6-safe-continuation`。
本记录区分局部修复、独立复核、远端备份、完整验收及合并，不替代正式审核批准。

## 已完成的局部闭环

| 根因 | 修复边界 | 实际回归 | 独立复核 |
| --- | --- | --- | --- |
| B003 | External-work 准入与取消使用原子状态 CAS 和精确 lease；Host 投影失败保留真实发送/执行事实，返回 503，不伪造执行失败或授予重发权限 | Core 完整 45/45；Host 完整 25/25；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核其发现的 Host 收尾缺口，无剩余已确认严重问题 |
| A08 | Draft 确认在同连接事务内建立 thread、definition 和 source pointer；反向 update/discard 不能覆写已确认终态；重复 discard 不改变原终态时间 | Core 完整 10/10；新 HTTP 与原 API 完整 12/12；build、直接类型检查及限定 diff check 通过 | 原独立审阅者复核真实双连接 RED→GREEN，反向 writer 候选关闭 |
| A22 | Parser 接受 exact primitive `approve/deny/manual`；Coordinator、Host、Core 各有独立权限守卫；畸形判词保持人工审批，不隐式写 deny | 新回归 55/55；五文件完整邻近 164/164；合法批准的真实命令仅执行一次，重复恢复不重放；build、直接类型检查及限定 diff check 通过 | 未参与实现的独立审阅者核对十个最终源码 SHA、控制流和日志，无已确认 finding |
| A09 长定时器/失败收口 | Node 单段 timer 有界；唤醒重读真实 due；首次、refresh 和异步收尾持久故障进入可恢复 error；旧 entry/generation 不能撤销后继 | 产品矩阵 21/21，随后独立旧 entry 隔离 1/1，原 API 5/5；build、类型检查及限定 diff check 通过。不是拼成一次 22/22 | 原未实施者复核同一异步收尾 finding 的真实 RED→GREEN，限定源码字节范围关闭 |
| A11 实际连接/事实边界 | 一次审核 DNS 全答案并固定到实际 socket；不可变审核集合内的连接回退保 Host/SNI/TLS；redirect 每跳重审；绑定不可克隆/复用；清理先于 completed，COMMIT 后不重发 | 三组分别 6 tests/5 pass/1 skip、25/24/1 skip、4/4/0 skip，均 0 fail/exit 0；HTTP/TLS fallback 直接 child 各 1/1、0 skip。两个 suite skip 是防递归 child 占位入口，不能称零跳过；最新 build、直接 tsc/diff check 通过 | 未参与 A11 实现的审阅者核对十个最终源码 SHA、真实 child 接线和控制流，PASS_SCOPED_WITH_LIMITS，无新确认 P1/P2；上层真实 API/packaged/GUI 不在此结论中 |
| A33 readonly Attempt 血缘 | Core 在原 captured-owner 准入下对新 `tool_start/update/end` 缺失 Attempt 作精确 stamp，显式错配在 durable insert/JSONL 前拒绝；原 SQL fence 和既有审批历史不变 | 主最终 9/9、邻近 9/9、Core 全文件 8/8，均 exit 0、0 skip；26 次执行、19 个独立用例。真实 SDK read 只证明 start/end；Core update、单 read、主动重投旧 callback 不冒充 SDK update、跨 Attempt batch 或自然迟到 | 未参与实现者核对三文件、八份原始日志和真实 producer/consumer，PASS_SCOPED_WITH_LIMITS，无新确认 P1/P2；approved=false，不批准完整 E6 |

B003/A08/A22/A09 上述回归均零跳过；A11 的两个 child 入口 skip 如上明确保留。各自实际执行者取得 exit 0。独立审阅者读取执行日志与源码，未重复执行测试；不能把继承的执行结果写成审阅者本人运行。

A11 后继 TLS fixture 已移除固定 synthetic key/cert，改为 Node crypto 运行时随机 P-256、短期自签 CA/SAN certificate；随机 key 仅在 native TLS 测试 API 内存 export，不落盘/记录、不关闭验证。初次真实 socket setup 因 Node 不接受 KeyObject 失败，日志保留；修正 API 边界后三组最终为 7/6/0/1、26/25/0/1、4/4/0/0（tests/pass/fail/skip），均 exit 0，四个直接 TLS child 各 1/1、无 skip。Root 对两文件完整新增 diff/helper/native 接线及实际日志作限定复核，未发现新确认 P1/P2。此后继不是全历史 secret scan 通过；已提交 synthetic fixture 仍存在历史，不改写、不绕 hook，正常 push 与远端 head 另行核验。

A22 首次 54 例的 43 个失败中，34 个是产品行为 RED，9 个是 fixture 血缘不足。修正 fixture 后，旧产品的 9 条真实链为合法 manual/deny 2 条通过、畸形判词 7 条失败。首轮 GREEN 的 approve 正例曾因 fixture 缺频道归属被生产准入正确拒绝；仅修正 fixture producer 后，最终 55/55 通过。失败记录保留，不声称首次即全绿。

## 正在处理，不能据此认定完成

- A09 的 RRULE INTERVAL/anchor 是仍未关闭的独立失败面。上表不证明 error-entry restart 时旧 Run 仍 in-flight 的所有重叠执行边界；后继隔离正例等旧 Run 完成后才交付新 due，不冒充重叠执行验收。
- A11 的上层 Comfy connection-check/analyze/import/submit/poll/collect 真实 API 失败回归仍未完成；静态链确认安全传播失败，但现有公开 envelope 仍用 generic code，不能称网络错误细分已全链统一。IPv6 实际 socket、Electron packaged/GUI 未验收。原 sanity/旧 sender RED/ambient 逐字日志未保存，不用最终 GREEN 补造原 RED。
- A11 两次早期未隔离 fixture 进入 store 初始化栈；defaultWorkspaceCwd 确认是实施树，实际 opened DB 文件及 before/after 未证。不能扩称用户日常 DB 被改或未改，不为补证重开/重置数据库。后继全部产品 Node 入口使用 fresh home 与默认 workspace 双隔离。
- A21、B004/B005 及全量独审登记的其他根因仍继续；A33 的已完成局部回归和独审边界见上表，B004/B005 仅准备测试，不能把局部闭环全部清零。

## 不变的验收与合并门槛

1. 原完整输入阅读已到 EOF，不重复全文阅读；阅读覆盖不等于内容批准。后继变更必须重新绑定精确输入并完成受影响独立复核。
2. Office 的具体审核记录仍须用户批准；本记录不生成 `approved` 或 `contentReviewComplete`，不授权正式发布。
3. 后继 fresh packaged macOS、真实客户端案例、问答/恢复/沙盒/Harness 联合矩阵仍未全部完成。上述局部回归不是新包 GUI 验收。
4. E6 PR 保持草稿；备份不是验收通过。主 CI 停用且无 checks 的 PR 不能当成通过；有冲突、已确认缺口或未达到原验收门槛的 PR 不合并，不使用 admin bypass。
5. Dependabot #527/#528 仍保留 API/版本/许可适配或实际安装/build 缺证；#529–531 已由外部提交合入 main，head/merge checks 均无记录，不冒称 hosted 安装、缓存、artifact round-trip 通过或本轮由 Root 合并。
6. origin/main 已 fetch 到 `6ddd5e6b75e314cc0fbeee370991c70c7383a0ff`，尚未整合；三处文本冲突与真实依赖图按只读映射受控处理。main #535 的 35 roots / 1,211 packaging inputs 审核记录不能覆盖已提交 E6 merge candidate 的 38/1,282，更不能覆盖尚未重新枚举的后继 WIP。不会自动刷新 approved；同事范围审阅不替代本分支具体用户批准。

## 证据定位与保全

本地完整执行记录位于实施树的 `output/e6-20260928/office-full-content-review-20261010/`：

- `b003-core-red-green.md`、`b003-host-red-green.md`、`b003-independent-review.md`。
- `a08-confirmation-red-green.md`、`a08-independent-review.md`。
- `a22-exact-verdict-red-green.md`、`a22-final-source-sha256.txt`、`a22-independent-review.md`。
- `a09-long-timer-red-green.md`、`a09-independent-review.md`；最终 scheduler SHA 为 `16974df4346f96afd896ec139a67dc55b497ba2db64eff6a46ffd949e6bb0a7d`，测试 SHA 为 `bd98f7758fee78934f4db96f4a5448d0bf3ee8ff7aa74137ef90163485f411d1`。
- `a11-http-pin-red-green.md`、`a11-independent-review.md`；报告 SHA 分别为 `a60e671df32eaca0a079f9ee874bf434232ed0d6eae155f1e5508c2892112f64`、`7136f8098be9a3060521fa61f0a3cf8ef89b4a67574895bd03f8624693c01d9e`。后继整合改变任一 owned 字节就重新绑定证据，不继承旧整文件 SHA 为新版本批准。
- `a33-readonly-lineage-red-green.md`、`a33-frozen-sha256.txt`、`a33-independent-review.md`；实现与独审报告 SHA 分别为 `6219199f70763a24980f494cb50e8cbe039bb3c9a4909fd5f004109daa86036f`、`9569e2175ef6d6218770ffd0d8a6d17712929df1fb601a28cc6bfc49aad6d9a1`。主最终日志是 `a33-green-closed.log`，不得用旧名含 green 的中间失败日志代替。
- `a11-ephemeral-tls-checkpoint.md`、`a11-ephemeral-tls-independent-review.md`；实现与限定复核报告 SHA 分别为 `15e714da5b55b0db0ab871e1eaa1d6bd6b03ebfc83c66e57c346453663a472e1`、`6b86376cf692448e9dd248a02d78da2e8157183ecd6b850e1f9af2e1d9ede460`。旧 A11 报告/freeze 不覆盖后继两个测试文件。

不修改根 checkout、日常数据库或另一 writer 的 `harness-delegation-storage-checkpoint-2026-10-09.md` WIP。仅对明确归属、完成局部闭环的修复作备份；未完成或他人 WIP 不批量 stage，不 reset、clean、stash、force-push 或删除分支。
