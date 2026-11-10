# A27 权限两轴与审批事实投影检查点

日期：2026-10-16。基线：已合并 #551，`da396aaf35c5ebe8302ff2fb33ef483676f02e00`。
本记录覆盖前置设计文档中的“实现与验证 pending”，仅说明 A27 当前源码检查点。
不是 E6 完成、Office approved、发布批准或真实 macOS App 验收。
主 CI 按用户要求不查询、不启用、不等待、不作为门槛。

## 已实现的范围

- 私聊 collection/SSE 透传独立的 authorizationMode / workspaceAccessMode。
- 三种会话共享 resume/fork builder 保留并校验源请求两轴；普通 resume 在接受新输入前拒绝非法已存轴。
- 新执行仍使用当前 workspace policy 与 Host gate；不复用源 effective policy 为新授权。
  普通 fork 仍移除父 Full Access receipt；未新确认的 Full Access child 明确拒绝，不静默降级。
- 共享只读 approval-event-state predicate 核对持久 Approval 的归属/决策和当前 Run 状态。
  即时 policy-deny 的审计事件不再误使 WorkUnit/Thread 进入等待或失败；真正审批等待保持原生命周期。
- 新 helper 纳入固定 authored source 清单和缺 digest/变字节/缺源码的 fail-closed 打包输入回归。

没有新增 SQLite 表、迁移、权限策略或兼容旁路。旧缺轴 read_only 合同与 first-class read_only
仍明确区分，没有借适配器修复改写旧权限语义。大型现有文件只作薄接线，新增规则集中在小 helper。

## Root 实际验证

全部使用隔离 HOME/workspace/SQLite 与 deterministic no-effects Runner，不调用真实模型、
真实凭据、Keychain 或日常数据库。fresh Daemon TypeScript 两次构建 actual exit 0。

| 完整文件组 | 结果 | 原始日志，位于 output/e6-20260928/a27-20261016/ |
| --- | --- | --- |
| 19 项 HTTP 权限 + 14 项审批 SQLite 投影 | 33/33，exit 0 | focused-postfix-full.log |
| 七个 prepared/fork/schema/permission/Turn/preview 邻近文件 | 125/125，exit 0 | neighbor-full.log |
| 三个审批生命周期/恢复/生产问答暂停文件 | 150/150，exit 0 | approval-lifecycle-full.log |
| 当前 Desktop authored source 输入 | 380/380，exit 0 | desktop-source-inputs.log |

四组均零 fail/cancelled/skipped/todo。单独 14/14 是上述 33 的子集，不重复加总。
未运行整个 Daemon glob。Desktop 使用真实 esbuild，但 native/compiler/signing 为 synthetic，
artifactExecuted=false，不能称新版 App 已启动或 GUI 已验收。

保留原始 fixture 错误和真实 RED：修正 URL 后原 15 项 0/15；修两轴后 14/15 暴露审计污染；
独立 SQLite 投影首轮 4 pass/10 fail；修正 normal fork message_end 前提后的两项 0/2。
未删断言、延长 timeout 或将 fixture 失败当产品 RED。

## 冻结与独审绑定

11 项最终输入清单 final-inputs-before.sha256：
`fa9a7f27bc23d5f889d1c8dbe67c1c81f9f9bfa71ceca5949660fca947f9379b`。
Root 在最终运行后再次核为 11/11 一致。

| 证据 | SHA-256 |
| --- | --- |
| focused-postfix-full.log | 5b65d997ee0af085e4fa96217baf9d5e43208cfde71f19c51165f85ce656f48a |
| neighbor-full.log | d82c5281936bcfad61d68bffd99414b9b7418bf5ca0828bd0533f434a0ced2eb |
| approval-lifecycle-full.log | 3b8cfff7885d225a814307299bff113e17cd783541323779862f505a569f29fd |
| desktop-source-inputs.log | ce61dd91ab8e701d902c1ef05be0a2cf20719b43c5c8bb732ce62b9fc6016715 |
| final-independent-review-20261016.md | 0160ffcd21bef26b769f26db59cb58e71eee8310a3e9fbeb8db32abb2c507045 |

独审结论 PASS_SCOPED_WITH_LIMITS、confirmed_remaining_findings=0、approved=false。
审阅者未实施产品；其本人编写 14 项 audit 测试，因此报告不将该测试文件称为独立测试审阅。
Root 已全文读报告并核 SHA。独审只覆盖冻结增量及必要接缝，不冒称整个 Daemon/Office 全文重审。

## 后续与未完成项

A28 的两项真实 index shutdown/runtime_suspend 业务 RED 仍未修；其细设计与六例测试不属于
本检查点。继续原子私聊写入、暂停分类、恢复终结同消息和晚回调隔离完整链路。
A18 受控 OS race、其余具名项、具体冻结 Office 用户批准、新 QA 包和 12 类真实 macOS GUI
验收仍待完成。总 goal 保持 active；没有新增待用户选择的 A27 产品决策。

另一 writer 文档保持 SHA 8acef2d140ed10724ab3a583533ec11b7cff4c3fabd45727c2159668e6e34044，
不纳入本提交。根 checkout 未动；不 reset/clean/stash/force/admin，不绕 hooks。
