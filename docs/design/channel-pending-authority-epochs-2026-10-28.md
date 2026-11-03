# 待确认频道操作的持久权限版本

状态：2026-10-28 实现与定向验收中；不是新包 GUI、Office 审核或合并完成记录。

## 问题与目标

待决操作已冻结完整命令、参与者、输入和只允许填写的槽位。回答不能重新生成执行图。
但“当前权限值 + updatedAt”不能证明等待期间权限未改变：A→B→A 可恢复相同值，
调用者也可以提供相同时间戳。相反，只更新保存时间却会使正常任务误失效。

目标是让真正的权限/执行配置变化永久使旧待决操作过期，同时允许主题变更及真实 no-op。
这不新增权限，不自动执行工具，也不把当前频道绑定视为无限读取授权。

## 存储与实际调用链

新增迁移 192 和 `channel_pending_authority_versions(scope, owner_id, revision)`。
通过原有 Store 初始化路径注册，在既有父表修复之后安装；不重写旧会话、决策或执行记录。

| 版本归属 | 影响该版本的写入 |
| --- | --- |
| workspace | workspace 执行默认配置、四项规范化权限默认值、工具审批策略/允许写路径 |
| channel | 绑定/状态/运行策略/工具/默认路由、成员关系、协作协议、council 绑定和其有效配置/成员 |
| participant | 实际 Agent 的能力、审批、状态、模型/runner 和执行指令配置 |

SQL trigger 在原写入的同一事务内推进版本，不依赖应用调用者记得另写一次版本。
owner 删除保留 tombstone，重建同 ID 继续推进；回滚也回滚版本。
版本限制为非负安全整数，溢出拒绝原变更，不绕回零。
首次已有 owner 回填零；后续打开数据库不从当前值重建版本。

`RunStore.getChannelPendingAuthorityVersions({ workspaceId, channelId, participantIds })`
读取精确 owner closure，核对工作区归属、持久 marker、table/trigger 定义和整数完整性。
缺失/损坏不能退回 updatedAt、默认零或当前值；以 `channel_pending_authority.*` 错误向上传播，
不伪装成模型槽位填写错误。

Daemon 先读取 effective protocol、参与者、Ling executor 和审批策略，使懒初始化先结束，
再读取版本。fingerprint 同时包含真实值与持久版本，但不再把 caller updatedAt 当版本。
实际 participants 包括直接成员与 council 来源，Ling 存在时也必须纳入。

## 冻结、续接与失败

1. 冻结：保留完整 pending 图、source/assignment/required participant manifest 和新 fingerprint。
2. 回答：只应用已命名的槽位，先验证 source/answer/draft identity，再核当前权限。
3. 发布：在原同步 SQLite 原子消费事务内再次核权限；中间无 await 或工具副作用。
4. 版本变化：持久化 `channel_pending_operation_authority_changed`，零 resolution/proposal/Run/tool。
   恢复原值、重启或重放该回答不能复活旧操作；新任务需要新的用户请求及规划。
5. 无关 reply/no_reply 不进入执行恢复，不因旧操作过期而被错误阻断。

新 fingerprint 不兼容旧的无持久版本待决 hash：它们安全过期，而非隐式升级或扩权。
已经完成的历史和已持久化结果继续按原恢复路径读取，不自动重放工具。
此版本不是授权凭据，真正启动时仍走既有权限、沙盒、命令审批及效果证据链。

## 证据与后续门槛

功能证据位于 `output/e6-20260928/engine-lifecycle-native-acceptance-20261028/`：

- 018/019：五类真实 Store ABA 连续 RED，25 pass / 5 fail。
- 020/021：加入 council policy/member/status 与三项 timestamp-only no-op，连续 RED 为
  25 pass / 11 fail；均为产品行为错误，不是 fixture/import 失败。
- 022/023：Core/Daemon TypeScript emit，actual exit0。
- 024：完全相同的 36 项命令 GREEN，零失败/跳过/取消。静态模型、临时 SQLite，非 GUI。
- Core 的迁移、完整性、删除/重建、回滚与相邻持久化验证，以及 025 相邻 Daemon 矩阵
  另保留各自完整回执；不能把未结束的命令预记为通过。

最终本地结果：025 Daemon 相邻矩阵 145/145；026 待决续接扩展矩阵 38/38；
028 Core 权限/迁移/审批/队友/频道/council 组合 245/245，均 actual exit0，零跳过/取消。
旧 schema fixture 只在自有临时数据库移除精确 migration192 结构后再构造历史形态；
未放松生产完整性校验。两轮连续 RED 和所有原行为断言保留。
后继独审报告 `pending-authority-epochs-independent-review-20261028.md` 已绑定这些终态，
本次精确差量无剩余确认问题，不等于全分支审查。

029 已用未修改的正式 reader 核验 QA-only 精确映射：15 native / 1,642 packaging，
正式 row SHA256 `d9614f8fac98b80ad5574513b5cfb12cd242a2d7d0491e0f2b2578944a9c4410`。
沿用用户既有隔离 QA 授权，未发布；原 proposal 保持 false/null。新包 GUI 尚未完成。

后继独审必须覆盖新 Core/Daemon 字节；固定 Office 输入清单显式纳入新 runtime leaf，
但列入清单不等于批准。独审闭合、原正式 reader 接受精确审核映射后才能构建新的隔离包。
真实客户端需重验受影响待决续接、权限过期诊断、恢复及共享展示，旧包截图不能代替。
