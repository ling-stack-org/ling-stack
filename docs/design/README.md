# Ling Design Documentation

Status: canonical documentation index
Owner: repository maintainers
Last verified: 2026-09-03
Document type: governance index
Code and test anchors: each linked contract owns its anchors

## Purpose

This directory keeps current product contracts, long-lived architecture decisions, and
security, migration, recovery, API, and release boundaries. Completed implementation
plans, version-by-version UI history, and screenshot evidence belong in Git history or
CI/Release artifacts instead of the default documentation tree.

## Current design handoff: Codex-style simple transcript

这次实现的目标不是再做一套“聊天气泡”，而是把 Codex 已验证的信息分层原则落到
Ling 的统一时间线：模型文本是文档，Host 事件是事实，完成结果是可追溯的结果行。
普通会话、队友私聊、频道 root/topic/branch 和 depth-1 子 Agent 只共享同一套
`ConversationTimeline`；surface 只提供 scope、chrome、policy 和 Host callback。

| 用户看到的内容 | 唯一 owner | 视觉形态 | 事实来源 |
| --- | --- | --- | --- |
| 用户、Agent、子 Agent 叙述；reasoning；plan | `DocumentBlock` | 左对齐文档流，保留 Markdown/代码换行 | `conversation_items` message anchor |
| 命令、读取、文件、工具、审批 | `FactRow` | 16px icon + 动词 + 文本状态 + 一个 disclosure | `RunEvent`/`ExecutionAction`/Approval/Artifact |
| execute turn 最终结论 | `ResultRow` | `Result · status · counters`，可展开但不复制 stdout | Completion Gate + `terminal_report` item |
| 当前运行环境 | `EnvironmentPopover` | active action 的最多两行浮层 | active run/action snapshot |

实现的唯一数据流：

```text
SQLite/Host/SSE -> scoped source snapshot -> EvidenceFold
               -> canonical atomic projector -> reversible display batch
               -> one ConversationTimeline -> surface shell / child rail
```

本页其余内容中的历史 `v3.7`/`v3.8` 小节只是决策背景；开工时以五份文档中标记为
`v3.9.1-final` 的实现锁为准。任何实现如果需要第二个 Timeline、第二个 summary、
surface-specific renderer、模型文本推断事实，必须先修改设计并重新跑 D0，而不是在
JSX/CSS 里加入兼容分支。

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
- [Project Defect Remediation Contract 2026-09](project-defect-remediation-contract-2026-09.md)
- [Project Defect Remediation Plan 2026-09](project-defect-remediation-plan-2026-09.md)
- [Conversation Shared Capabilities](conversation-shared-capabilities.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Channel Context Processing Layer](channel-context-processing-layer.md)
- [Channel Conversation Continuity v2](channel-conversation-continuity-v2.md)
- [Channel Environment Information Hierarchy](channel-environment-information-hierarchy.md)
- [Conversation Activity Summary And Exploration Batching](conversation-activity-summary-and-exploration-batching-detailed-design.md)
- [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
- [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
- [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
- [User Input And Native Sandbox Integration](conversation-user-input-and-sandbox-integration.md)
- [Platform Native Sandbox V1 Implementation Plan](platform-native-sandbox-v1-implementation-plan.md)
- [Conversation Right Dock Responsive Visibility Implementation Plan](conversation-right-dock-responsive-visibility-implementation-plan.md)
- [Channel Execution Completion Implementation Plan](channel-execution-completion-implementation-plan.md)
- [Post-Compaction Workspace Undo](post-compaction-undo.md)
- [Post-Compaction Snapshot Restore](post-compaction-snapshot-restore.md)
- [Channel Team Operating System](channel-team-operating-system.md)
- [Ling Agent Session](ling-agent-session.md)
- [Ling Agent Terminal Report Protocol](ling-agent-terminal-report-protocol.md)
- [Thread-First Work History](thread-first-work-history.md)

### Typed transcript authority (v3.9.1-final)

The current transcript work has five cooperating entry points. Read them in this order:

1. [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
   — canonical data, evidence, lineage, context, recovery, and completion semantics;
2. [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
   — document/fact/nested layout, row grammar, disclosure, and accessibility;
3. [Conversation Surface Contract](conversation-surface-contract.md)
   — surface-to-thread scope, shell chrome, interaction policy, and Host callbacks;
4. [Conversation Codex-Parity Component Detailed Design](conversation-codex-parity-component-detailed-design.md)
   — concrete component tree, renderer props, state ownership, migration map, and selectors;
5. [Codex-style Typed Transcript Implementation Plan](conversation-codex-style-transcript-implementation-plan.md)
   — implementation order, test matrix, packaged macOS evidence, and definition of done.

The activity-summary and command-batching documents are subordinate projection rules. They
may define eligibility and hard boundaries, but they must not introduce another timeline,
persistence table, renderer registry, or completion authority. When a historical section in
those documents mentions `ConversationWorkCell`, it means an adapter or migration input only;
the v3.9.1-final production owner is always `ConversationTimeline`.

Codex item 到 Ling kind 的逐项映射、事实来源和完成权威见详细设计 §5.1.1；视觉 row
grammar、EnvironmentPopover 和 disclosure 见视觉规范 §13–16。实现者不应从截图或旧
WorkCell 名称自行推导新的 item 类型。

本次开工补充设计集中在九个锁定小节，避免实现者在长历史文档中自行拼接规则：

- 详细设计 §1.4.7：Codex parity 开工锁，明确 child 使用父 Thread + participant span，
  以及开发阶段不保留 legacy renderer/fallback；
- 详细设计 §21：四条可见通道、Codex item 闭合映射、render cycle、Thread/scope、
  `contextSegmentId` 选择顺序和 fail-closed 状态；
- 视觉规范 §17：Document/Fact/Result 三种 primitive、首屏折叠阈值、统一 icon/文案和
  截图 + semantic + lineage 证据；§17.6 额外锁定 surface/child 等价性和无兼容入口；
- 组件细设计 §27：模块边界、唯一 mount/callback、child 递归边界和组件验收顺序；
- 组件细设计 §28：当前 per-message/per-activity mount 的实况审计、surface-level 单一
  Timeline、typed interaction、message presentation、virtualization 和 E4 删除顺序；
- 组件细设计 §29：生产组件树、display snapshot/row contract、child scope、
  EnvironmentPopover 状态和组件级停止条件；
- 实现计划 §4.13：六个工作包、逐文件职责、依赖/并行性和每个 PR 的最小交付格式；
- 实现计划 §4.14：把“共享 renderer”收口为真实 surface-level 单一 mount 的实施任务、
  机械断言和测试文件。
- 实现计划 §0.7：R5–R8 到 E1–E6 的唯一交接、模块边界、PR 形状和退出条件。

这些小节只补充实现接口，不改变 v3.9.1 的事实权威、SQLite 拓扑、completion gate 或
macOS-only 验收范围。

本轮设计冲突已明确收口：Topic/Branch 是真实 child Thread；Agent child 不是 Thread，
而是父 Thread 内的 participant span。生产路径不保留 `renderItem`、旧 WorkCell 或任意
`renderFactActions` fallback；旧 wire 行若仍需读取，只能停留在 source adapter，不能进入
生产 DOM。

命名也有固定的三层边界：SQLite/API 使用 `snake_case` wire kind，
`conversation-ui-core` 使用 `camelCase` projection kind，DOM/fingerprint 使用稳定的
dotted `rendererKey`。例如 `terminal_report → terminalReport → result.terminal`；三层
只能在 contract adapter 处转换一次，不能让 surface 或 CSS 直接消费 wire kind。详细映射
和未知 kind 的 fail-closed 规则见详细设计 §5.1.2。

#### Implementation lock（2026-09-03，v3.9.1-final）

设计文档已经锁定；v3.9.1-final 在不改变 v3.9 contract 的前提下补齐了接口级细设计。
D0–E5 的 source implementation 与自动化闸门已完成：Web `137/137`、UI-core `93/93`、
contracts `50/50`、API client `51/51`、runner-pi `25/25`、Desktop staging/path `89/89`，
Core/Daemon 全量、Web lint/typecheck/build、Markdown links 和 diff check 均通过。当前实现
也切断了 channel 的旧 `renderMessageFeedItem` 外部入口，频道只允许统一 Timeline，topic
panel 只接受真实 `resolvedThreadId`；生产代码没有旧 WorkCell 或独立 TerminalReport
renderer caller。
`terminal_report` 已进入 closed union，assistant 文本带 Host-assigned
`presentationRole`，SQLite publication 使用 `result_item_id`，canonical projector 会选择
最高 committed generation 并以 `result.terminal` 渲染；UI-core fixture 已覆盖单一结果、
summary 抑制、缺 anchor fail-closed。`WorkspaceClientView.tsx` 的
`TerminalReportDto` / projection DTO 类型边界已由 `terminalReportResultItemId()` 收口；
daemon fallback renderer 已移除，recovery/fan-in/late evidence 的自动化断言已通过。接下来
只进入 E6 packaged macOS 验收。只有同时具备 atomic evidence、统一
renderer fingerprint、recovery 结果和 macOS screenshot/semantic-state/lineage/log 四件套，
才可把实现标为完成。

开工时沿这五份文档执行：先完成 v3.9.1-final 的 D0 contract gate（区分
`TimelineSourceSnapshot` 与 `TimelineSnapshot`），建立 parity fixture 和 evidence
闸门，再实现共享
`ConversationTimeline`，最后按实现计划完成 surface cutover 和 packaged macOS 验收。
“简单好看”的验收不是主观截图评审，而是文档 lane、事实 row、原地 revision、可逆
disclosure、唯一 Feed viewport scroll owner、Host capability 二次校验和跨 surface fingerprint
的组合约束。v3.7 还明确 UI 状态所有权和迁移顺序：user/agent 统一左对齐，事实状态
使用闭集文案，先接 durable evidence，再切换 shared Timeline，最后删除旧
WorkCell/activity caller；不保留运行时兼容 renderer，也不允许 batch/output 形成第二个
纵向 scroll owner。

E2 的 batching 入口已经锁定为纯 projection：`projectDisplayBatches()` 返回可逆的
`items` 和仅供测试/诊断的 `boundaries`（`BatchSplitReason`），
`expandDisplayBatch()` 返回原子 child。没有已提交的 context segment 时保持原子展示并以
`context_scope` 记录边界；这些诊断不落 SQLite，也不参与 TerminalReport、retry 或 fan-in。

最终实现锁和开工入口：

- [Typed Transcript §1.4：实现锁](conversation-typed-transcript-detailed-design.md#14-v391-final-实现锁开工者的一页合同)
- [Visual Specification §16：视觉实现锁](conversation-codex-parity-visual-spec.md#16-v391-final-视觉实现锁)
- [Component Design §26：开工细设计](conversation-codex-parity-component-detailed-design.md#26-v391-final-开工细设计)
- [Component Design §28：Surface-level single Timeline cutover](conversation-codex-parity-component-detailed-design.md#28-surface-level-single-timeline-cutover)
- [Implementation Plan §4.13：实现启动包](conversation-codex-style-transcript-implementation-plan.md#413-v391-final-实现启动包本次设计更新)
- [Implementation Plan §4.14：Surface-level cutover work package](conversation-codex-style-transcript-implementation-plan.md#414-surface-level-cutover-work-package本次补充)

#### Implementation brief（给实现者的一页输入）

下面这组决定是 v3.9.1-final 的不可变输入（继承 v3.9 contract）；如果实现需要改变其中任何一项，先更新五份权威
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

#### Codex-parity 开工速查

下面是实现者每天都应该能直接对照的最短版本。它不是新的 contract；如果它与历史
`v3.7`/`v3.8` 段落冲突，以五份权威文档中的 v3.9.1-final 实现锁为准。

| 用户看到的内容 | 唯一 renderer | 数据权威 | 首屏规则 |
| --- | --- | --- | --- |
| 用户/Agent/子 Agent 叙述、reasoning、plan | `document.*` | `conversation_items` + message anchor | 文档流、左对齐、保留 Markdown/代码换行 |
| 命令、读取、文件、工具、审批 | `fact.*` | `RunEvent`/`ExecutionAction`/Approval/Artifact | `icon + 动词 + 状态 + 一个 disclosure` |
| execute turn 的最终结果 | `result.terminal` | Completion Gate + atomic evidence | 只显示一个 `terminalReport`，不再追加总结卡 |
| 子 Agent | `agent.nested` + 同一 Timeline registry | participant span + child atomic evidence | 只增加 participant label/1px rail，最大 depth=1 |
| 当前环境浮窗 | shell chrome | active run/action | 最多两行 ambient hint，settled 后关闭 |

```text
Host/SQLite/SSE -> scoped source snapshot -> evidence fold -> atomic projector
                                      -> reversible display batch -> ConversationTimeline
                                      -> normal/private/channel/topic/branch/child shell
```

实现前先回答四个问题：这个 row 的 Host evidence 是什么、`actionId`/`runId`/`attemptId`
和 `sourceRefs` 是否齐全、它由哪个 renderer 唯一拥有、失败时用户看到的是哪条
`diagnostic(blocked)`。回答不了就停在 adapter/contract 层，不在 JSX 里补文案或复制旧
WorkCell。完成判定永远读取 atomic evidence，不读取 batch 数量、plan 进度或模型的
`ready/done` 叙述。

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
- [Workspace Command Rule Approval Implementation Plan](workspace-command-rule-approval-implementation-plan.md)
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
- [UI 2.0 Documentation](ui2.0升级/README.md)
- [UI 2.0 Product Contract](ui2.0升级/00-UI2.0整体升级方案.md)
- [UI 2.0 Acceptance Contract](ui2.0升级/03-UI2.0验收总规范.md)
- [Ling Design System](ling-design-system.md)
- [Secondary Copy And Information Density](secondary-copy-and-information-density.md)
- [Data Revalidation And Manual Refresh Policy](data-revalidation-and-manual-refresh-policy.md)
- [Web Modularization](web-modularization.md)
- [Web E2E Acceptance Matrix](web-e2e-acceptance-matrix.md)
- [Codex Window Shell Parity](codex-window-shell-parity.md)
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
