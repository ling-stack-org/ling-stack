# 自动化 recurrence 准入与故障隔离

日期：2026-10-13。范围：A09 RRULE、不可变锚点、草稿确认和定时器恢复；不是完整 E6 或 Office 发布批准。

## 唯一事实与模块边界

- `packages/core/src/automation-recurrence.ts` 是唯一纯领域计算模块，直接 type-import AutomationDefinition/AutomationSchedule，不依赖 Daemon、SQLite、网络或 Core barrel。
- Daemon 的 `features/automations/recurrence.ts` 只转出共享领域 API；schemas 做支持范围校验，routes 在普通 create 写 thread 前校验实际下一槽位。
- SQLite Store 对 create 和作者的 trigger/rrule/enable 修改在写入前校验；内部 nextRunAt/error 写入不重新准入，以便隔离历史坏定义。
- Scheduler 区分 typed `AutomationRecurrenceError` 与持久化故障。前者只隔离该定义；后者撤销整个 entry 的 timer 并进入可恢复 error。
- Draft 使用既有 `draft_json` 保存 rrule，进入 canonical snapshot/CAS；不新增表，不改历史数据，不猜测历史字符串是否来自派生投影。

## 有限规则合同

支持 `MINUTELY`、`DAILY`、`WEEKLY` 与 INTERVAL、BYDAY、BYHOUR、BYMINUTE、BYSECOND、WKST 的已实现有限子集；MINUTELY 不支持 BY* 和 WKST。重复/未知字段、ordinal BYDAY、COUNT、UNTIL、DTSTART 和非法数值明确拒绝，不声明完整 RFC 5545。

1. 持久化 `createdAt` 是相位与创建下限，`updatedAt` 不参与排程。查询严格 after，不给 999ms 宽限。
2. DAILY/WEEKLY 使用 timezone 本地日历；WEEKLY 的 WKST 默认 Monday，省略 BYDAY 时取创建日的星期。
3. MINUTELY 使用固定 createdAt 的 elapsed-time 相位并保留毫秒。`cadence=interval` 保留独立 everyMs 合同，不将它改成四舍五入的 RRULE。
4. DST gap 跳过，不顺延成另一个墙钟时间；overlap 只允许较早 fold，同一本地时刻不在第二 fold 再执行。
5. 按周期跳转而非固定天数 lookahead；最多搜索 370 个周期，无法产生可表示下一槽位时明确失败，不退回无关 daily。
6. 每日缓存时区偏移与有效墙钟区间；密集 gap 按区间剪枝，已过去的 first-fold 秒按 UTC 下限有界二分定位。精确 timezone roundtrip 和最终 UTC 判断仍是权威；无法解析的探针不得作为删掉候选的证据。

## 草稿与 SQL NULL

Draft create/GET/PATCH/preview/confirm 共用 rrule 字段；PATCH 省略表示不改、null 表示清除。未齐全草稿不因缺下一槽位而拒绝补齐；实际确认才按即将写入 definition 的确认时间作新 createdAt 锚点。

确认保持原 A08 顺序：BEGIN IMMEDIATE → fresh draft → already_confirmed 事实核验或 ready/CAS/source 冲突核验 → 用实际 now 校验 recurrence → 创建 thread/definition/source association → COMMIT。失败回滚；已确认重试不重新准入、不重建，不因后来的规则变化推翻已提交事实。

Definition 的 GET RRULE 可以由 trigger 派生，但 update 保留值必须读取 raw SQL rrule 列。原 NULL 和 null-clear 继续保持 NULL，不能被 scheduler 的 due 更新固化为 explicit。显式字符串即使刚好与派生字符串相同，也仍是显式作者意图。

## 运行与错误归属

历史不可运行定义清除 durable nextRunAt，在 item 留可读错误；合法任务继续有 timer，修正后显式 refresh 可以恢复。若清 due 的数据库写入失败，不能谎称已隔离，仍走 failEntry。

调度前的重读/计划替换故障不增加执行 tick、lastRunAt，不制造 Run/AutomationRun 或改 definition 为执行失败。进入 runAutomation 才进入执行错误边界。

成功执行后的下一次注册，不属于已完成执行：同 generation 和 refresh 后 generation 共用 scheduling recovery；数据库错误撤销 entry，不重写成功 Run/AutomationRun。已撤销的 durable due 在未进入执行时不得被 finally 自动重新准入；旧 entry/generation/callback 仍不能影响后继。

## 实际验证与失败保留

证据根目录：`output/e6-20260928/office-full-content-review-20261010/`。所有新增产品 Node 入口 fresh HOME/LING_STACK_HOME/default workspace 双隔离、env -i；没有使用线上模型或日常数据库。

| 场景 | 真实初始结果 | 最终结果 |
| --- | --- | --- |
| 密集纽约 spring gap / Apia 整日 gap | 2 fail；Intl 调用 36,012 / 864,022；exact next 正确但预算失败 | 最终 33 / 35 次，原 128 次预算未放宽 |
| 密集纽约第二 fold | 1 fail；7,227 次 Intl 调用 | 65 次，仍只取 first fold；Lord Howe 半小时 gap 32 次 |
| Core Draft/author admission | 11 tests 中 10 fail、1 already_confirmed 正例 pass | 最终完整矩阵包含全部 11 例 |
| HTTP author admission / Draft RRULE | create 返回 201 而非 400；修正缺 contextSelectors 的 fixture 后，Draft 真实因丢 rrule 失败 | 写入前拒绝；Draft 全链、null-clear、确认回滚与幂等通过 |
| start/refresh 历史坏规则隔离 | 2 fail，抛错经全局 catch 撤销 workspace | 隔离后合法槽位恰一次；坏 due 清除 SQL 故障仍 failEntry |
| 同 generation 完成后的 due/cleanup 写故障 | 2 fail：scheduler 假 running、definition 被标 error，而 Run 实际成功 | 与 refresh rearm 共用正确边界，成功事实保留 |
| 第一次 finally 重构的 due revocation 回归 | 182 tests 中 181 pass、1 fail，原已撤销 due 被自动重新准入 | executionEntered 守卫后原断言通过；preexecution SQL 故障新增只记 GREEN，不补造 RED |
| Office authored inventory | 新 recurrence 缺清单 1 fail；后继正例另暴露此前 A21 八个漏列源码 | 显式补清单，不生成 approved；最终 full suite 296/296 |

最终：八个完整 Core/Daemon 文件 **184/184**，fail/cancel/skip 0、actual exit 0；packaged-source input full suite **296/296**，fail/skip 0、actual exit 0；Core/Daemon build 与最终 typecheck actual exit 0。54 个纯计算用例包含于 184，不累计重复运行次数。

最终日志：`a09-final-matrix-green-20261013.log`、`a09-final-inventory-green-20261013.log`；16 个源码/测试冻结：`a09-final-source-freeze-20261013.txt`。中间 134/132/2、182/181/1 和所有原 RED/fixture 故障保留，不改写成首次即通过。

## 验收与后续

打包测试使用真实 esbuild、源码哈希和缺失/变更输入拒绝链；Native compiler/codesign 仅 synthetic fixture，产物未执行，不能冒称 packaged GUI 或 Office native 通过。

未实施者最终增量独审已完成：`a09-final-independent-review-20261013.md`，SHA `13379c8cf5c2a0e400a647fc8087529b6d2641a24f5d2be72499b734c2078a95`，`PASS_SCOPED_WITH_LIMITS`、`approved=false`；16/16 冻结输入一致，范围内无剩余已确认 finding。审阅者读回 Root 的实际日志，没有本人重复运行测试。

下一步仅限定 commit/远端 draft 备份，再处理 main 锁文件受控整合、A11 上层 API 等未完项、具体 Office 用户批准和 fresh macOS 联合验收。现有 approved 不覆盖新模块与新哈希，不自动刷新；保存结果以接续入口和 live PR head 为准。

本有界设计没有待用户选择的新增产品决策；局部 GREEN 不替代完整 E6 门槛，未通过的 PR 不合并。
