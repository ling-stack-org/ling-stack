# 频道下多会话实现计划

Status: isolated packaged persistence verified on 0.1.3; final repair candidate and landing pending
Owner: repository maintainers
Last verified: 2026-10-30 (Core/Daemon regression and real isolated 0.1.3 packaged migration, archive/restore and normal quit/restart; final repairs pending)
Document type: implementation plan
Canonical contract: [频道下多会话详细设计](channel-sessions-detailed-design.md)
Code and test anchors: 各阶段列出的现有入口；新增文件名在实现时按模块职责确定。

## 目标与交付边界

把现有频道主聊天与具名分支整理为“频道 → 多个会话”，复用 `LingThread` 连续性和现有执行链。
当前实现位于隔离工作区，保护原工作区 WIP；设计、实现和定向回归同步推进，未对用户生产
数据库执行迁移。源码 PR/合并与安装包发布分开记录；计划不代替外部操作所需的用户授权。

本次设计补充已确定[界面线框、全部会话目录、状态反馈与键盘布局](channel-sessions-detailed-design.md#45-界面线框与导航)。
这些是实现及验收目标，不能因已有部分组件就标记整套交互通过。

依赖顺序：`S0 契约 → S1 存储与 API → S2 上下文与执行归属 → S3 Web 集成 → S4 联合验收`。
每个切片必须在其依赖完成后交付；不能先只改“分支”为“会话”就标记功能完成。
开发时保护既有 WIP；若需要隔离实现，使用合适的独立工作区，不重置当前 checkout。

## S0：冻结身份、类型与兼容契约

状态：类型、严格输入验证和 API Client 已实现；Contracts 与 API Client 测试通过。

范围：

- `packages/contracts/src/conversation-continuity.ts`
- `packages/contracts/src/channel-conversations.ts`
- `packages/core/src/conversation-thread-topology-types.ts`
- `packages/core/src/workspace-types.ts`
- `packages/api-client/src/endpoints/channels.ts`

工作：

- 为独立频道会话新增 `channel_session` surface，保留 `relationKind=root`；不伪造 fork lineage。
- 定义 `ChannelSessionSummary`、sessions facade 请求/响应、错误码、筛选与分页游标。
- 固定 canonical thread ID 为 session ID、旧 branch ID 为兼容映射的规则。
- 确认所有严格枚举消费者、fixture、schema validator 和 remote protocol 的升级行为。
- 将输入限制、活动归档冲突、默认会话常驻以及旧无 key POST 的限制写入 contract 测试。

退出条件：Contracts/API Client 类型与兼容 fixture 通过；没有第二套 Session 历史或执行状态机；
默认 root、空白会话、真实 fork 和 topic 四类可区分。

## S1：存储事务、历史迁移与 API facade

状态：存储、迁移、生命周期与准入已实现；Core 定向回归、真实 SQLite/HTTP sessions facade
与旧 branch 兼容回归通过。归档后的 failed dispatch 重试返回 409，恢复后可重试。

现有入口：

- `packages/core/src/storage/sqlite/ling-thread-store.ts`
- `packages/core/src/storage/sqlite/conversation-thread-topology-store.ts`
- `packages/core/src/storage/sqlite/channel-core-store.ts`
- `packages/core/src/storage/sqlite/continuity-v2-legacy-import.ts`（只作历史输入参考，不改写已发迁移）
- `packages/core/src/storage/sqlite/channel-session-store.ts`
- `packages/core/src/storage/sqlite/channel-session-migration.ts`
- `packages/core/src/storage/sqlite/channel-session-admission.ts`
- `packages/core/test/channel-sessions.test.mjs`
- `packages/core/test/channel-sessions-migration.test.mjs`
- `packages/daemon/src/features/channels/session-routes.ts`
- `packages/daemon/src/features/channels/routes.ts`
- `packages/daemon/test/channel-workspace.test.mjs`

工作：

- 新增会话服务和新的前向迁移；线程、兼容目录与创建幂等记录一次事务完成。
- 按 workspace/channel/operation 隔离创建 key；相同 key 不同输入冲突。
- 为目录/thread 关联建立唯一性约束，检测跨频道、重复、缺失与混合 owner 记录。
- 迁移保留原 root、branch、Item、Turn、Run ID 与 lineage；无法证明的记录报告诊断。
- 为历史目录名称与 canonical title 建立确定性同步，后续从所有修改入口同事务维护。
- sessions facade 与旧 branches/generic thread 修改路由共用服务；GET 不再隐式创建或修复线程。
- 在频道创建时初始化默认会话；归档/恢复检查 active dispatch、Run、Approval 并与发送互斥。
- 保留永久删除兼容语义，避免 archived orphan thread 被新列表重新发现。
- 准备线程级通知 revision 的持久投影与幂等更新能力，不复用消息序号充当状态更新游标。

退出条件：

- 多会话列表、创建、重命名、归档、恢复与分页符合契约。
- 响应丢失/并发双击/故障注入后无半条目录、孤儿新线程或重复会话。
- 旧库 → 新库 → 重开保持身份、历史数量、引用与归档；坏数据不被静默丢弃。
- 归档与新发送、频道归档与新建会话的并发结果确定。
- 保存迁移前备份与版本回退说明；不直接降级写新库。
- 已整合主分支 `05aca19c`，保留 `177` 权限迁移与 `178` Runner ID 迁移；本功能目录迁移为 `179`，
  备份名同步为 `v179`。`180` 更新话题归属与归档准入，`181` 更新话题通知触发器；后两项不重新分类
  目录、不重放历史或清空通知水位。合并前再次确认迁移号未被最新主分支占用。
- 显式修复安全空目录；有歧义的历史保留诊断并禁止新工作，GET 不修复。

## S2：上下文、调度与来源归属

状态：上下文与来源归属已实现；Daemon/Core fixture 回归通过。测试使用合成执行对象，
不代表真实付费模型、媒体服务或 packaged 执行链已验收。

现有入口：

- `packages/daemon/src/features/channels/conversation-thread-resolution.ts`
- `packages/daemon/src/features/channels/conversation-surface.ts`
- `packages/daemon/src/features/channels/channel-conversation-api.ts`
- `packages/daemon/src/features/channels/context-processing/sources.ts`
- `packages/daemon/src/features/channels/context-processing/conversation-context-projector.ts`
- `packages/daemon/src/features/channels/context-processing/conversation-summary-coordinator.ts`
- `packages/core/src/storage/sqlite/conversation-turn-ingest-store.ts`

工作：

- items/turns/stream 统一按显式 thread 解析；默认 root 兼容入口返回同一身份。
- 所有 history/summary/segment/context inspect/recovery 查询限制在当前会话；保留频道共享资料权限。
- root 与独立会话、历史 branch 互不吸收消息；topic 仍属于原会话。
- 首条消息只创建本会话的 segment；空白会话不读取 fork snapshot。
- Task、Run、Approval、Workflow、Artifact、MediaJob 沿真实 Turn/Run lineage 定位。
- 对没有 thread 来源的旧工作对象保留频道级展示，不用当前 UI 选择补归属。
- 恢复与 TerminalReport 仍归最初会话；不改 Attempt fence、写锁与并发预算。
- 由可见助手回复/终态推进通知 revision，覆盖同一 Item 晚完成、事件重放与重连对账。

退出条件：同频道 A/B 的历史、摘要、自动回复、追问/停止、错误恢复与工作证据均不串会话；
共享 brief/已批准记忆可用且有来源；不同会话同目录写入仍受现有锁限制。

## S3：Web/desktop 会话导航与状态

状态：Web 核心导航、状态和生命周期已实现。补充交互已接入主区可选名称、侧栏同步草稿
标识、侧栏/标题区会话菜单、频道菜单、对象名称辅助标签、折叠目录诊断、默认行之后的
预览外选中项，以及首次加载骨架。创建结果未知时保留原 key/名称/输入；名称在该状态锁定，
明确校验失败后可修正。

验证：整合主分支前 Web 单元测试 628 项、生产构建浏览器回归 147 项、lint 与生产构建通过；
浏览器会话后端使用 mock daemon。长标题、名称字段超限、主区和侧栏名称同步、菜单键盘焦点、
目录诊断折叠、频道设置/改名入口及 CSS 200% 缩放均有相关浏览器用例；200% 的证据范围为
CSS zoom，不等同于所有系统缩放/辅助技术组合。亮暗截图已检查，草稿行换行问题已修复。

真实开发版 Desktop 使用当次 Web 构建、main、preload 和 bundled daemon，已通过首次发送、
独立历史/本地草稿，以及退出后重新启动保留 canonical ID、历史和草稿。隔离运行报告为
`/tmp/ling-channel-sessions-desktop-smoke-latest.json`；不使用模型模拟替代数据库或 HTTP。
该运行未打包、未签名，不能当作当次安装包或付费模型验收。

现有入口：

- `apps/web/src/features/navigation/SidebarNavigation.tsx`
- `apps/web/src/features/navigation/ChannelSessionNavigation.tsx`
- `apps/web/src/app/use-channel-sessions-controller.ts`
- `apps/web/src/app/channel-session-state.ts`
- `apps/web/src/app/use-app-navigation-controller.ts`
- `apps/web/src/app/use-channel-actions-controller.ts`
- `apps/web/src/app/channel-sidebar-archive-actions.ts`
- `apps/web/src/app/sidebar-status-projections.ts`
- `apps/web/src/app/full-access-confirmation-scopes.ts`
- `apps/web/src/app/channel-message-stream-projection.ts`
- `apps/web/src/features/workspace/ChannelSessionDraft.tsx`
- `apps/web/src/features/workspace/ChannelSessionHeading.tsx`
- `apps/web/src/shared/conversation/ChannelSessionActionsMenu.tsx`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/app/AppShell.tsx`（保持组装职责）

工作：

- 频道展开、上次会话恢复、常驻默认会话、具名会话行与“新建会话”入口。
- 新建本地草稿 → 幂等创建 thread → 幂等发送首条 Turn；失败保留输入和附件。
- 按 workspace/channel/thread 分区草稿、分页、scroll、pending send、错误和流式状态。
- 晚到请求/事件按源身份更新缓存；切换不取消后台运行，停止捕获明确目标。
- 新 facade 统一重命名、归档、恢复；默认会话不显示单独归档入口。
- 消费线程级通知 revision、本地已读水位与频道聚合；覆盖同一流式 Item 晚完成、未加载页、
  首次升级水位、对象计数去重和稳定活动排序。
- thread 级 full-access scope；旧 scope 安全失效、同次 draft 升级保持确认。
- 文案仅更改产品会话入口，不替换 Git/运行/队友分支术语。
- 10 项侧栏预览、频道内全部会话标题搜索与分页、加载/失败/空态及键盘操作。
- 预览外当前会话保留选中行，临时草稿仅显示一行；频道容器与当前会话的选中层级明确。
- 全部会话 Dialog 的活跃/归档筛选、默认会话搜索、每页 50 条、加载更多及失败重试。
- 归档只读查看与恢复；归档当前会话回默认会话并可撤销；归档失败不丢本地草稿。
- 运行/未读并列、waiting 有无审批文案、焦点期间稳定排序、长标题和 200% 缩放。
- 旧 channel/branch 导航解析，新显式 thread 目标与无效链接处理。

退出条件：组件/状态测试和 focused Playwright 覆盖创建、切换、生命周期、流式竞态、审批来源、
未读、断线、刷新与多页列表；新增逻辑有明确 domain/module owner。

## S4：联合验证与交付检查

状态：源码层联合回归、构建和真实开发版 Desktop 运行/重启已执行；隔离 `0.1.3` Human QA 包的
真实迁移、A/B 消息与草稿隔离、归档/恢复、正常退出及同 profile 重启已通过。最终修复后的候选、
`0.2.0` 元数据与安装包、冻结候选审查、文档 freshness 及远端 CI/PR/合并仍待完成。
维护者已选择版本 0.2.0，并确认先补齐安装包验收再合并；这不代表正式安装包发布。

2026-10-29 的只读打包预检使用原 `readReviewedPackagedOfficeSource` 入口，两次均返回
`packaged_office_native_toolchain_invalid`：本机编译器/SDK 和选定 Node headers 与已审核配置
不符。固定源码审核清单也与当前候选不符，其中已有主分支变化，新增会话模块尚未纳入固定
闭包。需独立审核当前源码闭包和适用工具链后，再沿原打包入口执行隔离验收；该预检没有
修改审核清单、编译或启动安装包，不计作 packaged 通过。

该历史前提随后通过独立固定源码闭包、工具链与原生输入审核解决，原守卫打包及 ad-hoc 签名完整性检查
已通过。2026-10-30 的实际 Human QA 使用全新合成工作区和 owned profile，未替换正式应用或迁移生产库。
首次就绪约 46 秒，同 profile 重启约 49 秒；正常退出后主进程、所属 daemon 和 `17928` 监听均已关闭。
实际 UI 验证旧默认历史、具名 A/B 的独立消息与未发送草稿、B 归档只读及恢复；重启后 canonical IDs、
Item IDs 和草稿保持不变，桌面启动诊断 IPC 可读。隔离配置未设置模型预设，发送后显示配置阻断，
因此未验证真实模型回复。QA 启动/重启期间两份浏览器宿主注册保持原字节；其他 QA 实例先前覆盖的注册
已按维护者选择恢复至正式安装目标。此记录仅适用于该 `0.1.3` 候选，不代替后续修复与 `0.2.0` 的验收。

先跑切片内最小相关测试，遇到失败或未解决风险再扩大。联合矩阵至少覆盖：

| 层级 | 必须验证 |
| --- | --- |
| Contracts/Core | 新 surface 枚举、空白 vs fork、目录唯一性、事务回滚、幂等、迁移重开 |
| Daemon/API Client | 新旧 API 一致、GET 无修复、归属校验、归档竞态、分页、thread 级消息与上下文 |
| Web 状态 | 身份分区、晚到响应、草稿/附件、停止目标、审批、未读和聚合 |
| 真实浏览器 | 创建 A/B、分别发消息、A 流式时切 B、返回继续、归档/恢复、旧链接与键盘流程 |
| 设计行为 | 默认会话常驻、预览外选中、草稿恢复、全部列表筛选/翻页/重试、只读归档与撤销、状态文案、主题和缩放 |
| Desktop | 同一 renderer 会话行为、重启恢复、生产构建后的真实 daemon lineage |

真实浏览器验收记录页面与操作结果；Desktop packaged 验收使用当次产物，不借用历史包证据。
付费模型/媒体流程、生产数据迁移、构建发布与外部发布按其独立授权范围执行。

完成定义：详细设计验收矩阵全部有对应证据；明确区分源码、测试、真实 UI、packaged 与发布状态。
合并前把长期规则同步到 owning contracts，并按文档治理移除已完成计划。

## 证据边界

切片进度不等于功能完成。S4 联合验收未结束前，不能标记整体验收、PR、合并或发布完成。
实现和测试在隔离工作区进行；原工作区 WIP 不进入本次交付。
当前回归覆盖迁移/重开、独立上下文、归档准入、幂等创建、流式切换、精确停止/审批、未读
对账、刷新和目录分页/重试。Core 先前的三项通知触发器回归已修复，本次完整复验
3654/3654 通过（`/tmp/ling-channel-sessions-core-full-recheck.log`）。浏览器证据使用 mock daemon；真实 SQLite/HTTP 证据
来自 Daemon 测试。跨工作区相同 ID 的晚到流新增 cwd 检查已代码复审，未单独执行该浏览器场景。
真实开发版桌面重启已有独立运行证据；此处保留原阶段边界，后续 packaged 结果见 S4 与下方追加记录。
合并与正式发布状态须独立核实；不将已有源码审查凭据复用于后续变更的完整候选。


### 主分支整合阶段的回归记录（2026-10-29）

已整合 `c128146c`（PR #615），频道会话使用迁移 179，保留主分支的 177/178。
整合后的 Core 全量 3663/3663、Daemon 定向 276/276、最新 Web 单元 628/628、Web lint/构建、
Desktop 类型检查及隔离的真实开发版完整退出/重启通过。

扩大至 148 条生产构建浏览器回归后，初次结果为 99 通过、49 失败；初次新增多会话 10 条均通过。
失败包含旧侧栏/默认范围假设、缺少持久来源的历史 fixture，以及默认会话被错误当成分支、
会话所属执行活动过滤和提示 scope 的真实回归。修复后，生产构建浏览器回归 147/147 通过，
开发模式专属演示用例另在开发服务器通过，不计入生产构建结果。初始失败记录保留于
`/tmp/ling-channel-sessions-browser-initial-148`，最新日志为
`/tmp/ling-channel-sessions-browser-owner-final.log`；没有放宽跨会话隔离契约。

末轮审查补充了已有会话查询和默认会话回退的工作区所有权检查，防止旧工作区的晚到查询
覆盖新工作区同 ID 会话，或返回过期的发送目标。生产 hook 的延迟响应回归先复现两个失败，
修复后 3/3 通过；同工作区正常查询和归档拒绝仍保留。快照重连测试先更新服务端水位，再
通知客户端刷新，仍严格断言重连水位 5、8、9；原时序连续失败 5 次，临时修正副本连续通过
5 次，正式源码随后纳入上述 147 项回归。

### 后续整合与审查修复记录（2026-10-30）

已整合主分支 `05aca19c`。最新 Core 完整 3705/3705、Daemon 会话与通知 17/17、Web 单元
637/637 通过；多会话浏览器流程 17/17、关联提案及正常会话审批回归通过。保留此前
Daemon 六文件 293/293、Desktop 相关 121/121 与原生打包守卫 815/815 的阶段证据，后续输入
发生变化的检查需重新验证。完整整合门禁尚未取得最终通过记录。

审查新增修复：`181` 将合法 topic 可见结果通知到所属会话；提案审批仅使用当前 canonical
会话中已加载的来源，缺失来源时不猜测归属，草稿和其他会话保留输入区；目录使用既有主题
token，无审批的等待状态显示通用等待。侧栏频道状态标记保留，模拟 API 的审批 ID 按真实
目录契约去重。明暗主题目录和 A/B 提案切换均有浏览器证据。

隔离 `0.1.3` 安装包已实际验收迁移、A/B 消息与精确草稿隔离、归档恢复和正常退出重启；
该证据早于上述审查修复，不能代替最终候选验收。模型未配置，已验证配置阻断及用户消息
持久化，没有真实模型回复证据。修复后候选包、`0.2.0` 元数据、最终审查与远端合并仍待完成。
