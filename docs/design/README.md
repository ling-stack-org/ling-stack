# Ling Design Documentation

Status: canonical documentation index
Owner: repository maintainers
Last verified: 2026-09-01
Document type: governance index
Code and test anchors: each linked contract owns its anchors

## Purpose

This directory keeps current product contracts, long-lived architecture decisions, and
security, migration, recovery, API, and release boundaries. Completed implementation
plans, version-by-version UI history, and screenshot evidence belong in Git history or
CI/Release artifacts instead of the default documentation tree.

## Product And Architecture

- [Implementation Status](implementation-status.md)
- [Product Design](../product-design.md)
- [Architecture](../architecture.md)
- [Platform Architecture](platform-architecture.md)
- [Ling Framework](ling-framework.md)
- [Contracts And API Client](contracts-api-client.md)
- [Daemon API](../daemon-api.md)
- [Architecture Decision Records](../adr/README.md)

## Conversations And Channels

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Taxonomy](conversation-surface-taxonomy.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md)
- [Conversation Full Access Confirmation](conversation-session-full-access-confirmation.md)
- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Conversation Activity Summary And Exploration Batching](conversation-activity-summary-and-exploration-batching-detailed-design.md)
- [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
- [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
- [Channel Execution Completion Implementation Plan](channel-execution-completion-implementation-plan.md)
- [Post-Compaction Workspace Undo](post-compaction-undo.md)
- [Post-Compaction Snapshot Restore](post-compaction-snapshot-restore.md)
- [Channel Team Operating System](channel-team-operating-system.md)
- [Ling Agent Session](ling-agent-session.md)
- [Ling Agent Terminal Report Protocol](ling-agent-terminal-report-protocol.md)
- [Thread-First Work History](thread-first-work-history.md)

### Typed transcript authority (v3.8)

The current transcript work has four cooperating entry points. Read them in this order:

1. [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
   — canonical data, evidence, lineage, context, recovery, and completion semantics;
2. [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
   — document/fact/nested layout, row grammar, disclosure, and accessibility;
3. [Conversation Surface Contract](conversation-surface-contract.md)
   — surface-to-thread scope, shell chrome, interaction policy, and Host callbacks;
4. [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
   — implementation order, test matrix, packaged macOS evidence, and definition of done.

The activity-summary and command-batching documents are subordinate projection rules. They
may define eligibility and hard boundaries, but they must not introduce another timeline,
persistence table, renderer registry, or completion authority. When a historical section in
those documents mentions `ConversationWorkCell`, it means an adapter or migration input only;
the v3.8 production owner is always `ConversationTimeline`.

Codex item 到 Ling kind 的逐项映射、事实来源和完成权威见详细设计 §5.1.1；视觉 row
grammar、EnvironmentPopover 和 disclosure 见视觉规范 §13–15。实现者不应从截图或旧
WorkCell 名称自行推导新的 item 类型。

命名也有固定的三层边界：SQLite/API 使用 `snake_case` wire kind，
`conversation-ui-core` 使用 `camelCase` projection kind，DOM/fingerprint 使用稳定的
dotted `rendererKey`。例如 `terminal_report → terminalReport → result.terminal`；三层
只能在 contract adapter 处转换一次，不能让 surface 或 CSS 直接消费 wire kind。详细映射
和未知 kind 的 fail-closed 规则见详细设计 §5.1.2。

#### Implementation lock（2026-09-01，v3.8）

设计文档已经锁定；v3.8 在不改变 v3.7 contract 的前提下补齐了可直接开工的实现蓝图；
D0 的第一段 contract/result-anchor slice 正在实现、尚未验收：
`terminal_report` 已进入 closed union，assistant 文本带 Host-assigned
`presentationRole`，SQLite publication 使用 `result_item_id`，canonical projector 会选择
最高 committed generation 并以 `result.terminal` 渲染；UI-core fixture 已覆盖单一结果、
summary 抑制、缺 anchor fail-closed。当前 Web typecheck 仍有
`WorkspaceClientView.tsx` 的 `TerminalReportDto` / projection DTO 类型边界错误，必须先
收口后再执行 selector smoke，再按 `E1 → E2 → E3 → E4 → E5 → E6` 接入真实 evidence fold、
统一 surface、recovery 和 packaged macOS 验收。只有同时具备 atomic evidence、统一
renderer fingerprint、recovery 结果和 macOS screenshot/semantic-state/lineage/log 四件套，
才可把实现标为完成。

开工时沿这四份文档执行：先完成 v3.8 的 D0 contract gate（区分
`TimelineSourceSnapshot` 与 `TimelineSnapshot`），建立 parity fixture 和 evidence
闸门，再实现共享
`ConversationTimeline`，最后按实现计划完成 surface cutover 和 packaged macOS 验收。
“简单好看”的验收不是主观截图评审，而是文档 lane、事实 row、原地 revision、可逆
disclosure、唯一 Feed viewport scroll owner、Host capability 二次校验和跨 surface fingerprint
的组合约束。v3.7 还明确 UI 状态所有权和迁移顺序：user/agent 统一左对齐，事实状态
使用闭集文案，先接 durable evidence，再切换 shared Timeline，最后删除旧
WorkCell/activity caller；不保留运行时兼容 renderer，也不允许 batch/output 形成第二个
纵向 scroll owner。

#### Implementation brief（给实现者的一页输入）

下面这组决定是 v3.8 的不可变输入（继承 v3.7 contract）；如果实现需要改变其中任何一项，先更新四份权威
文档并重新跑 D0，而不是在某个 surface 里加一个局部例外：

| 问题 | v3.7 决定 | 用户可观察结果 |
| --- | --- | --- |
| 历史存储 | `conversation_items` 是 canonical item timeline；`channel_messages` 只保留为旧 channel 读写的 adapter/index，不扩成第二套 item 表 | reload、resume、SSE reconnect、daemon restart 仍回到同一条历史 |
| Thread 拓扑 | normal/private/channel root/topic/branch 都解析真实 `LingThread.id`；topic 用 `parentThreadId + anchorItemId`，branch 用不可变 `forkContextSnapshotId`；child 不建可见 child thread | 三种会话和 child 使用同一个 Timeline，topic/branch 不复制 parent transcript |
| 事实与叙述 | `agentMessage/reasoning/plan` 只是 document lane；command/file/tool/approval/protocol/child action 必须来自 Host evidence；execute 终态进入唯一 `terminalReport` result row | “我会执行/已完成”不会变成绿色成功；首屏总能看到动作动词和文本状态，且不会出现第二张完成总结 |
| 上下文分段 | `contextSegmentId` 由“用户显式选择 → 结构规则 → 受权限约束的模型候选 → 服务端提交”单向确定；batch 不参与 | 自动换话题不会污染历史，且每次选择都可回溯 |
| 展示组件 | 一个 `ConversationTimeline`、一个 exhaustive renderer registry、一个外层 Feed viewport scroll owner；normal/private/channel/topic/branch/child 只改变 shell/policy/participant rail | 普通会话不再有右侧方形 bubble，频道和私聊不会各自发明一套 action 卡 |
| 活动折叠 | `commandBatch`/`explorationBatch` 只在内存中由相邻、同 lineage、安全终态 atomic items 计算；active/failed/approval/consequential 永不隐藏 | 成功历史安静，展开仍能看到每条原子命令，不影响 completion/fan-in |
| 文件与环境 | 模型 path 显示 basename + icon + 完整路径 tooltip，可复制；只有 Host capability 才能 `open_file/open_diff/open_artifact`。EnvironmentPopover 只显示当前 active run 的两行 ambient hint | path 简洁但不冒充授权；点击有权限才打开；浮窗不会重复历史、summary 或 TerminalReport |
| 多 Agent | `subAgentActivity` 增加 participant label + 1px rail，child 的 narration、plan、command、file、tool 复用同一 registry，最大 depth=1 | 子 Agent 可以正常叙述和显示真实动作，但不会乱码、不会出现第二套聊天 UI |
| 完成闸门 | `terminalReport`/fan-in 只读取 atomic evidence；required participant 缺 evidence 时只能 waiting 或 structured blocked | ready/plan/batch count 不会提前把任务显示为完成 |

实现顺序固定为 `D0 → E1 → E2 → E3 → E4 → E5 → E6`：先锁 fixture/selector，再接
evidence fold，再做 canonical projection 和可逆 batching，再切统一 renderer 与 Host
viewer，之后才移除旧 WorkCell caller，最后只用 packaged macOS 真实客户端验收。每个
阶段都必须同时有代码、语义测试和对应证据；只有截图而没有 `semantic-state.json`、
`lineage.json` 与脱敏日志，不算完成。

## Teammates, Memory, And Skills

- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [AI Teammates And Skills](ai-teammates-and-skills.md)
- [AI Councils](ai-councils.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Memory Health And Fan-In](memory-health-and-fanin.md)
- [Skill Capability Model](skill-capability-model-and-library-simplification.md)
- [Skill Library Ownership](skill-library-ownership-separation.md)
- [Skill Import Productization](skill-import-productization.md)
- [Skill Editing And Revision](skill-editing-and-revision.md)
- [Skill Library And AI Evolution](skill-library-height-and-ai-evolution-lifecycle.md)
- [Skill Source Sync](skill-source-sync-simplification-p15.md)

## Runtime, Security, And Storage

- [Approval Policy](approval-policy.md)
- [Inline Runtime Approval](inline-runtime-approval-detailed-design.md)
- [State Machines And Recovery](state-machine-recovery.md)
- [Multi-Channel Concurrency](multi-channel-concurrency.md)
- [Runtime Supervisor](runtime-supervisor.md)
- [Runtime Control Plane](runtime-control-plane-roadmap.md)
- [Secrets And Keychain](secrets-keychain.md)
- [Workspace State Storage](workspace-state-storage.md)
- [SQLite Storage Slices](sqlite-storage-ling-and-domain-slices.md)
- [Locked Computer Control](locked-computer-control-policy.md)
- [Bundled Computer Use Driver](cua-driver-bundled-embedded.md)
- [Remote Access Security Contract](mobile-remote-access.md)

The remote-access documents are retained for protocol and approval safety. Mobile is not
part of the current product acceptance scope.

## Models, Media, And Integrations

- [Provider Presets](provider-presets.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [Video Production Studio](model-workbench-video-production-studio.md)
- [Media Production Experience](media-production-experience-refinement.md)
- [Media Production Image To Video](media-production-image-to-video-detailed-design.md)
- [Media External Workflows](media-production-external-workflows.md)
- [Conversation Media Generation Tools](conversation-media-generation-tools.md)
- [Conversation Media Generation Tools Implementation Plan](conversation-media-generation-tools-implementation-plan.md)
- [Plugin Manager](plugin-manager.md)
- [Office Documents Native Plugin](office-documents-native-plugin.md)
- [Office Documents Native Plugin Implementation Plan](office-documents-native-plugin-implementation-plan.md)
- [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin.md)
- [Chrome Native Messaging Implementation Plan](chrome-browser-built-in-plugin-implementation-plan.md)
- [Automations](automations.md)
- [External Work Orchestration](external-work-orchestration.md)

## Web, Desktop, And UI 2.0

- [Internationalization And Language Parity](internationalization-language-parity.md)
- [Internationalization Language Parity Implementation Plan](internationalization-language-parity-implementation-plan.md)
- [UI 2.0 Documentation](ui2.0升级/README.md)
- [UI 2.0 Product Contract](ui2.0升级/00-UI2.0整体升级方案.md)
- [UI 2.0 Acceptance Contract](ui2.0升级/03-UI2.0验收总规范.md)
- [Ling Design System](ling-design-system.md)
- [Secondary Copy And Information Density](secondary-copy-and-information-density.md)
- [Data Revalidation And Manual Refresh Policy](data-revalidation-and-manual-refresh-policy.md)
- [Web Modularization](web-modularization.md)
- [Web E2E Acceptance Matrix](web-e2e-acceptance-matrix.md)
- [Desktop Shell](desktop-shell.md)
- [Sidebar, Approval, And Proposal Dialogs Implementation Plan](sidebar-approval-proposal-dialogs-implementation-plan.md)
- [Desktop Release](../release/desktop.md)

## Open Source And Release

- [Open-Source Readiness Checklist](../maintenance/open-source-readiness.md)
- [Release Policy](../release/README.md)
- [Security Policy](../../SECURITY.md)
- [Contribution Guide](../../CONTRIBUTING.md)

## Retention Rules

- Keep one canonical product contract per capability or bounded subsystem.
- Keep an implementation plan only while material work remains unfinished.
- Keep detailed designs for complex protocols and safety, migration, recovery, API,
  native release, signing, and supply-chain boundaries.
- Move screenshots, test captures, hashes, and run-by-run evidence to CI or Release
  artifacts.
- Use Git history instead of creating an archive directory.
- Every new long-lived document must declare status, owner, last verification date,
  canonical replacement when applicable, and code or test anchors.
