# E6 N03 — 十二轮真实对话验收（2026-10-26）

结论：**N03 的纯对话事实回忆/纠正子集通过；不是完整 N03 或 E6 已完成。**

复用源码 checkpoint20ad9ee1 的 R03 Observation QA 包，ASAR
`0276a506cff02445eec9f9f09337be3b99e475175db90a8992a4a59fdace0a99`，
未重包、未改生产代码。文档基线52cb4199。

独立 profile 为 `output/e6-20260928/p3-long-context-current-package-20261026/profile`；
Main45785→Host45789，window57211，17928，runtime_d1bcb5db-4228-4de8-9732-23da17217a6a。
本地 CPA/gpt-6.1-sol；仅引用 env:OPENAI_API_KEY，不保存密钥。

通过真实 GUI 在同一会话串行发送12条输入：早期五项事实、预算/主题纠正、
中间多轮不重述事实的任务、临时话题、回到项目、最终回忆。Host读回24条消息、
12个Turn/Run，每Run一个Attempt与唯一created/start/end/result，没有tool事件或action。
最后回复准确为：

```json
{"代号":"青枫","校验码":"QF-7294","预算上限":17,"主题":"靛蓝","界面语言":"中文"}
```

会话：`thread_normal_8a1b94e294cf38def72c7aa2a850e26f210ea3d248b262b3586a66c448f12501`。
最后Run：`run_f01af894-951e-4c81-8160-df2fa56d3e30`。
最后Attempt：`work_unit_attempt_e14fb9b3-4cb7-4aef-87df-4885da2f5d12`。

证据均在上述profile的父目录：`qa-report-n03-dialog-2026-10-26.md`、
`03-final-recall.png`、完整native JSON、semantic-state/lineage、captures007/008。
离线断言验证精确输入、所有Turn/Run/Attempt join、先完成后发送顺序、最终JSON与同窗口AX，exit0。
截图SHA256 `a6677dd8e496907425688f6cb9c2c1966bc65e7b90f3b1e4ffc95563467ed512`。
capture007 observation文件SHA256 `abac77b4d2ff1c8d3fcfea4574bda300e33e288f455cb78f5883ecaf2922f1d3`。
materialized evidence SHA256 `9c395cc4aa44a2a335776206eabd90eec196e8cd60713b8f2636d014e34d4950`，
scoped verdict pass/open[]；002/004 CLI exit2仍incomplete并在限制中保留，没有刷绿重放。

内置Computer Use绑定旧同bundle窗口且不支持该windowId入口，才对新实例使用精确PID/window备用；
旧实例和历史全部保留。Provider usage未提供，不证明费用或H09硬输出上限。

本次没有验证N03要求中的任务产物/约束一致及重开历史，也不证明压缩、重启记忆、
无限记忆、私聊/多Agent或几何/虚拟化计数。新实例与案例保留供检查。
总目标active；接续只推进尚缺的P3/P4/P5，不重复这12轮，不重包，不修改旧unknown状态。

## 后续完成记录：第十三轮真实任务与重开历史

本节追加在上述历史子集记录之后，不抹除当时尚未验证的事实。
复用同一包、profile、PID/window和thread，只提交一次第十三轮任务，
没有重做前十二轮。任务不重复早期五个答案，明确允许在本QA workspace调用工具。

实际创建`n03-project.json`，123bytes、五字段正确（青枫/QF-7294/17/靛蓝/中文），
SHA256 `26c709fe9484cdad8ae771e49e9f5e7364470c8be10a22b8d90881b8e08710b4`。
write成功、+7−0；Node命令经过真实GUI「允许一次」，exit0/48ms、stderr0，
stdout打印精确JSON及「校验通过」。该Run冻结context sourceRefs包含第一、二轮原user item。

第十三Run为`run_32276131-a90e-4fd0-91fd-80bd86519918`，
唯一Attempt为`work_unit_attempt_4356656a-ecd7-4dcc-9f49-10f222021aab`；
总计26messages/13Turns/13Runs。该Run created/start/end/result各1，
tool_start/end各2、host_command_prepared/settled各1、审批请求/批准各1。

GUI实际切「新建对话」至空首页，再从最近历史重开同一会话；最终回复、
文件卡（1文件/+7−0）和空composer均可见。完成与重开后的Host读回深比较
messages/turns/runs/context/taskRun/events/actions/artifact相等，没有重复执行。
离线assert capture017 exit0，原始证据与截图保留在
`output/e6-20260928/p3-n03-task-reopen-20261026/`。
报告`qa-report-n03-task-reopen-2026-10-26.md`列出全部002–017 checkpoint及限制；
重开截图`06-reopened-history.png` SHA256
`7cb3b7e7df36545ee5206076fda8acda03e27f26ce308dc4fa81ab6888bf8167`。
materialized evidence仅发布一次，SHA256
`4cb51718fea248e27f84cfddbf105e58e3a08ddad24825be7ed2f44462941ae0`，scoped pass/open[]。

报告事实单独披露：capture009 reports为空，015出现generation1 deterministic_fallback，
正确引用本Turn/Run/文件/verification；validationCodes含terminal_report_unverified_success_claim。
没有声称report相等、模型结构化总结通过或推断出现原因；不提升未知descendant containment。
备用CLI多项exit2仍保留incomplete，由独立017/native看图与Host事实支撑本案范围；
016仅离线expected缺省runId字段预期错误，修正wire shape后017通过，没有重放产品操作。

合并两轮证据，**N03的连续上下文回忆/纠正、真实产物约束一致和历史重开要求已通过**。
不是压缩/安全重启/无限记忆、H09费用/cap或整个E6通过。案例保留供检查，不再重复13轮或重包。
本轮仅验收文档追加；未push/PR/merge/发布，总Goal仍active。
