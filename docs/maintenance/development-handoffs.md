# Development Handoffs

Status: retained implementation handoffs; historical checkpoints are not current acceptance
Owner: repository maintainers
Last verified: 2026-10-08 (document relocation and links only)
Document type: maintenance handoff
Code and test anchors: the owning plans and source modules linked below

## Reading Boundary

This page preserves the implementation handoff previously embedded in the design index
and five source checkpoints. Their test counts, branch names, remaining work and local
instructions describe the recorded snapshot, not today's `main` or a new authorization.
Use [Implementation Status](../design/implementation-status.md), the
[Typed Transcript implementation plan](../design/conversation-codex-style-transcript-implementation-plan.md),
[Office Documents implementation plan](../design/office-documents-native-plugin-implementation-plan.md),
[Office V2 contract](../design/office-local-directory-native-v2.md), and
[Harness implementation plan](../design/ling-harness-gap-closure-implementation-plan.md)
for current delivery and safety boundaries. Resume instructions below must be reconciled
with those owners and the current source before acting.

These records remain together while the owning package, recovery and native safety gates
are open. Once their unique rules have been consolidated and the gates close, remove
completed checkpoints in favor of Git history. Raw logs, databases and capture artifacts
are not published here. The relay URL and temporary development checkout are examples.

## Contents

- [Typed transcript handoff](#typed-transcript-handoff)
- [Office writer verification, 2026-10-04](#office-writer-verification-2026-10-04)
- [Office no-start checkpoint, 2026-10-05](#office-no-start-checkpoint-2026-10-05)
- [Office observation boundary, 2026-10-05](#office-observation-boundary-2026-10-05)
- [Office readonly closure facts, 2026-10-06](#office-readonly-closure-facts-2026-10-06)
- [Reasoning-summary and automatic-review checkpoint, 2026-09-14](#reasoning-autoreview-checkpoint-2026-09-14)

## Typed Transcript Handoff

### Current design handoff: Codex-style simple transcript

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

#### Typed transcript authority (v3.9.1-final)

The current transcript work has five cooperating entry points. Read them in this order:

1. [Conversation Typed Transcript — Detailed Design](../design/conversation-typed-transcript-detailed-design.md)
   — canonical data, evidence, lineage, context, recovery, and completion semantics;
2. [Conversation Codex-Parity Visual Specification](../design/conversation-codex-parity-visual-spec.md)
   — document/fact/nested layout, row grammar, disclosure, and accessibility;
3. [Conversation Surface Contract](../design/conversation-surface-contract.md)
   — surface-to-thread scope, shell chrome, interaction policy, and Host callbacks;
4. [Conversation Codex-Parity Component Detailed Design](../design/conversation-codex-parity-component-detailed-design.md)
   — concrete component tree, renderer props, state ownership, migration map, and selectors;
5. [Codex-style Typed Transcript Implementation Plan](../design/conversation-codex-style-transcript-implementation-plan.md)
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

##### Implementation lock（2026-09-03，v3.9.1-final）

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

- [Typed Transcript §1.4：实现锁](../design/conversation-typed-transcript-detailed-design.md#14-v391-final-实现锁开工者的一页合同)
- [Visual Specification §16：视觉实现锁](../design/conversation-codex-parity-visual-spec.md#16-v391-final-视觉实现锁)
- [Component Design §26：开工细设计](../design/conversation-codex-parity-component-detailed-design.md#26-v391-final-开工细设计)
- [Component Design §28：Surface-level single Timeline cutover](../design/conversation-codex-parity-component-detailed-design.md#28-surface-level-single-timeline-cutover)
- [Implementation Plan §4.13：实现启动包](../design/conversation-codex-style-transcript-implementation-plan.md#413-v391-final-实现启动包本次设计更新)
- [Implementation Plan §4.14：Surface-level cutover work package](../design/conversation-codex-style-transcript-implementation-plan.md#414-surface-level-cutover-work-package本次补充)

##### Implementation brief（给实现者的一页输入）

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

##### Codex-parity 开工速查

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

## Office Writer Verification 2026-10-04

### Office local writer：成员与 FD 异常验证（2026-10-04）

这是 E6/U 执行链的一个已实现增量，不是整个目标完成，也不是生产 route 或 safe receipt 验收。原远端 Draft PR #507 的保存点仍为 `76600b95`；本页记录其后的实现。

#### 模块边界与实际修复

- `office-local-members.ts`：成员路径读回、inode identity 校验、固定 FD/50 MiB 读取预算。`refresh` 只能推进已有节点或固定 syscall 的显式身份；`observeFinal` 只观察，不能修改 expected/授予 cleanup 权威。超预算和路径变化用固定错误码记录。
- `office-local-writer.ts`：原 syscall/Tracker gate、执行顺序和 FD 所有权。open 返回后先登记 descriptor 再 fstat/readback；close-entered 与 closed 分开，未知 close 不重放；关闭原 descriptor 不依赖已可能被外部替换的路径 ledger。
- `office-local-writer.test.mjs`：真实 SQLite/SDK 字节和真实文件/FD 故障注入，不用 ready 文本充当执行证据。

目录有独立约束：`mkdirSync` 不返回原节点 identity，事后 `lstat(path)` 仅能约束后续路径检查，不能证明 cleanup ownership。失败时不自动 `rmdir`，目录残留进入完整成员 manifest；未来原生 creator receipt 和 Core verifier 必须显式处理，不能靠目录为空就删除或判 safe。

#### 真实反例与当前证据

1. 原保存点 writer 当前重跑 **3/5**，两个真实失败：外部 temp inode 被收编/删除、成员读回使用无界 `readFileSync(path)`；Tracker mode 已 GREEN。
2. 加入只读 final/inode 同内容替换等反例后，旧实现实际 **4/8**，4 fail。第一批修复实际 **8/8**。
3. FD 反例实际 **7/10**，3 fail：路径已替换阻止原 FD 关闭、open 后首次 fstat 失败丢 FD、close 失败后同 inode 复用的 FD 被再次关闭。对应修复后 **10/10**。
4. 目录首次观察收编反例真实失败；删除该不具权威的 rmdir 路径。另补 oversized residue 不读/不授予权威测试和预算固定错误码。
5. 最新定向 writer **12/12** 加 snapshot **12/12**，合计 **24/24**，0 fail/cancel/skip，exit 0。Daemon build:ci 与 diff check exit 0。
6. Tracker mode 独立执行 **1/1**，exit 0，执行前后指纹一致。三文件独立静态窄审查剩余确认 finding 0；它不是 combined review。

Daemon 全套 session73621 已真实结束，**2,780/2,780**，0 fail/cancel/skip，exit 0。Node 内建 reporter 完整日志位于本地 `output/e6-20260928/U-office-writer-daemon-full-20261004.log`；3 个产品/测试文件的运行前后 SHA-256 完全一致。TAP 顶层 `1..2673` 含 nested cases，最终 tests/pass 均为 2780，不把顶层序号冒充测试总数。

#### 明确未完成的正式事实链

- native API 真实返回必须在原返回点锁存；不能把后续 ledger/readback/Host COMMIT 错误写成 native 未返回。
- write 要有实际 `bytesWritten`，不能用请求 `sizeBytes` 代替。
- 正式 Host resource lifetime ID 要绑定 open effect/source/member，数字 FD 不提供可恢复权威；未知/retained FD 的完整持有和恢复仍需补齐。
- complete members/resources/effects 终态，以及纯 Core whole-file verifier、原 parent+producer pair 原子封口与全部 children fan-in 尚未实现。
- 固定 production route、live Office/Cua/Chrome enforcement、retained restart、answer continuation/ACK/recovery 和 fresh packaged macOS 联合验收仍按总计划继续。

本增量不开放 U gate、不颁发 safe、不放宽旧 patch verifier、不改真实数据库或历史。Node 路径检查不冒称 hostile ABA 的原子 OS 保护。失败残留和 retained/unknown 不会被标作完整收尾。

## Office No-Start Checkpoint 2026-10-05

### Office no-start implementation checkpoint — 2026-10-05

This is a user-requested WIP backup for the existing Draft PR #507, not a release,
merge or acceptance verdict. The implementation workspace remains the dedicated
E6 continuation worktree on `codex/e6-safe-continuation`. The preceding saved commit is
`47c2e829fa8ef0d486a0b94e5bcc712997a6cad1`.

#### Saved implementation

- Independent, append-only Office no-start receipt types and migration 151.
- Receipt records revalidate the original prepared execution, effects, resources,
  required descendants and source; the journal pair is settled atomically.
- Original live Office and journal entry latches must agree; a callback that entered
  is not no-start merely because the native operation did not enter.
- Irreversible reservation/plan closure is separate from settlement intent.
  Pending children cannot prematurely claim receipt identity or settlement time.
- Receipt digest/time intent is retained across transaction rollback and lost ACK.
  Tracker release remains after the committed producer/parent settlement.
- Closed Office ancestors block forward execution and new children without denying
  an already-entered child its original, bounded cleanup capability.
- Fifteen standard no-start regression cases were added, covering actual writer
  closure, descendants, transaction faults, stale/foreign capabilities and retained
  readonly resource rejection.

#### Verification boundary

All three authors froze their files before this checkpoint. Whitespace checks and
the new test file's Node 22.22.1 syntax check pass. The no-start implementation has
**not** yet been uniformly built, independently reviewed or run against its new
standard suite. Do not claim this checkpoint is GREEN.

The preceding baseline Core full result is 1897/1897, exit 0, with 1643 consumed
inputs unchanged. It ran on the existing dist and does not validate the newly added
no-start sources. The preceding Daemon full 2872/2872 likewise does not prove this
new implementation. The original actual no-start repro was 0/1, exit 1.

#### Resume once, from the first incomplete gate

1. Root reads the frozen receipt, migration and live-state settlement changes.
2. Uniform Core/Daemon build; run the original no-start repro and new standard suite.
3. Required Office regressions and current-input full gates; preserve actual failures.
4. Creator-bound directory proof and all six fixed local Office production routes.
5. Remaining live/restart/answer/ACK/delivery/recovery/API/UI checks, fresh packaged
   macOS Computer Use, combined review, CI and final integration.

The public U gate remains closed. The complete D0/E1–E6, U/T and Harness objective
remains active. Do not redo completed duration/H2/R03/MCP/Media/Reviewer slices or
repeat this backup without a new user request.

## Office Observation Boundary 2026-10-05

### Office writer observation and no-start boundary

#### Scope and status

Continuation of the current E6/U implementation, after the saved no-start
checkpoint `178f1169`. This is not a release, packaged acceptance, or completion
of D0/E1–E6/U/T/Harness. Public user-input admission remains disabled until the
whole production/recovery/GUI chain is proven.

#### Confirmed failure

Two actual Node FS/SQLite scenarios returned `known_no_start` and released both
original barriers while a real readonly target FD remained open:

1. Terminal INSERT was rolled back by a COMMIT failure before native COMMIT.
2. Terminal artifact creation failed before the original seal API was entered.

Both had zero mutating callback/native/effect entry. The original receipt reader
checked resources only if a persisted terminal existed. A missing terminal was
incorrectly treated as absence of resource observation. A retained terminal
claim alone did not protect the artifact-before-seal case.

#### Authority chain

`fixed writer -> Tracker -> original Core ticket -> pair/owner/forward gate`

- Before the writer can retain even a readonly native resource, Core latches
  `writerObservationStarted` on the original WeakMap-owned execution state.
- The bit is monotonic across COMMIT rollback and lost acknowledgement. It does
  not mark either journal role as mutating/launched.
- Admission already closed: reject outside all final-observation paths. Do not
  open resources or fabricate a failed terminal merely to explain rejection.
- No-start first permanently closes the original Office lifecycle. If observation
  started or a seal claim exists, the exact original persisted terminal must be
  present. Validation failure retains both blockers and does not pin a receipt
  digest/timestamp.
- A failed terminal can support no-start only when it is unpublished, every
  resource is an actually closed member-read resource, and all existing exact
  effect/descendant/history checks also succeed.
- A never-observed original ticket may still close as genuine no-start. Empty
  persisted rows, reconstructed tickets and caller booleans remain insufficient.

#### Persistence reconciliation, not execution retry

After no-start closure rejects a missing terminal, only the fully identical
pre-existing `sealClaim` may use the dedicated terminal persistence gate. It
revalidates the original live pair/current owner, admitted/launched roles, and
absence of a settlement/receipt intent. No new artifact/digest, resource read,
child, forward effect or generic closed-lifecycle mutation is authorized.

Artifact-before-seal failure has no retained claim and remains blocked; this
change does not invent a manifest or reopen the original writer.

#### Historical evidence

The canonical no-start payload now includes
`terminal: null | { terminalArtifactId, terminalDigest }`. Every public history
read requires exact existence/identity/digest equality and both fully verified
canonical journal roles. Deleting/replacing a bound terminal is not converted
into a weaker no-terminal proof. SQL tables/columns are unchanged; no backfill
or real history mutation is performed. Earlier unverified WIP payload shapes
are not upgraded into authority by a compatibility reader.

#### Verification record

Raw RED and corrected runs remain separate. Two expected-error-code assertion
mistakes and outdated reservation retry assertions are test defects, not product
RED evidence. The meaningful product RED is the actual retained-FD failure above.

- Core/Daemon builds: exit 0 after the product change.
- Migration 151: 115/115, exit 0, real isolated populated upgrades, rollback,
  CHECK/FK/append-only/OR REPLACE boundaries.
- Corrected original Office matrix: 94/94, exit 0; independent original terminal
  suite also passed on the same frozen product build.
- New native resource boundary: final 5/5, exit 0; both real retained-FD scenarios
  retain terminal=0, receipt=0, blockers=2, local releases=0.
- Current Core full: 2019/2019, exit 0. Product inputs are frozen; later only one
  Daemon-only test assertion changed from an unprefixed to its actual typed code.
- Daemon final full: 2892/2892, exit 0, with zero failures/cancellations/skips;
  original handle 37204 was collected to completion, not restarted. The final
  3821-input manifest was rechecked after completion, exit 0. The old 2872
  baseline and deliberately interrupted intermediate run are not this result.
- Independent closed-readonly positive: 1/1, exit 0. The original target FD
  was actually read and closed (then EBADF); a complete failed terminal enabled
  original-ticket no-start with exact terminal binding. Independent SQLite
  readback confirmed pair COMMIT before binary and parent barrier release.
- Independent product-path review: no additional blocking finding, read-only.

Detailed receipts/logs are in the local E6 acceptance directory. This record
does not establish creator-bound directory authority, six fixed Office production
routes, full user-input continuation/delivery/restart recovery, packaged GUI or
combined review/CI completion. Those remain mandatory next work.

#### Remote checkpoint boundary

The user requested an additional WIP backup to existing Draft PR #507. This
checkpoint contains this observation-boundary implementation, its standard
regressions and this design record. It does not upload ignored QA databases,
native fixture output, packaged apps, screenshots or credentials. No main
merge, release/version bump or history rewrite is part of this save request.

## Office Readonly Closure Facts 2026-10-06

### Office T2 — original readonly descriptor closure observations

#### Scope and authority

`ProtectedHostStagePaths.readTerminalClosureFacts()` is an immutable snapshot
of the original directory descriptor capture and close slots. It is not a
live custody capability, mkdir creator proof, continuous canonical window,
Core certificate, journal settlement or permission to delete a path.

The reader performs no filesystem I/O. It never exposes an FD integer,
reopens a pathname, stats a potentially reused descriptor or adopts another
inode. Original uid/mode come from the first successfully matched acquired
descriptor, rather than a post-close observation.

| Observation | Meaning |
|---|---|
| `acquisition: returned`, `firstIdentity: matched` | Original open returned and its first fstat matched the captured directory identity. |
| `state: retained`, `close: not_entered` | Historical slot still holds its original descriptor; this is not a current-path check. |
| `state: unknown`, `close: unknown` | The original close was entered and tombstoned before the call; its return is not confirmed. |
| `state: closed`, `close: returned` | That original close returned normally. |
| `state: unknown`, `close: not_entered` | Original descriptor loss/reuse was detected before close; no close was issued against the foreign integer. |

Every snapshot and row is frozen. Later close operations do not mutate an
earlier snapshot. An unknown outcome stays unknown; reading or repeating
cleanup cannot change it to returned. Original close order, tombstoning,
partial-capture cleanup and all existing pathname/source/native guards remain
unchanged.

#### Necessary remaining T2 work

The fixed original Supervisor/cache/runtime/scope bridge must bind to the
original Core V2 ticket. It must verify actual actor inventory, source,
canonical destination and protection coverage, independently of replaceable
fixture methods. The bridge must separate closing original readonly FDs from
releasing the controlled-process protection lease.

The intended settlement order remains:

1. Original parent/producer tickets and required child roster are ready.
2. Lock forward admission; verify original retained custody in the owning
   Core readonly transaction window.
3. Close original Host FDs once, retaining the protection map as
   `closed_pending`.
4. Independently verify and commit the V2 certificate and atomic journal pair.
5. Read back that same original committed pair before releasing protection.

The closure facts added here support step 3; they cannot implement steps 2,
4 or 5 by themselves. The Core safe-unavailable stub and current native-only
`coreSafe: false` outcomes remain in force. No product MCP route is enabled by
this change.

Full Access or another unrestricted same-UID program is outside the controlled
process isolation promise. This change does not expand that boundary.

#### Verification recorded on 2026-10-06

- Test-only baseline: five new cases failed because the reader was absent.
- Fresh Daemon TypeScript build passed with Node 22.22.1.
- Five new real-FD cases passed, covering immutable no-I/O snapshots, actual
  close return loss/foreign reuse, actual EBADF/reused inode and path displacement.
- A sixth focused case passed at the synchronous close-entry boundary:
  reentrant reads see unknown before the syscall returns, never premature closed.
- Eight existing original-descriptor cleanup regression cases passed.
- All selected cases had zero failures and zero skips. These are local
  descriptor lifecycle tests, not full Office product, macOS 26 kernel,
  continuous-window, hosted CI or packaged GUI acceptance.

Raw logs remain in the isolated ignored QA output; no database, private content,
credentials or descriptor integers are published in the evidence API.

## Reasoning Autoreview Checkpoint 2026-09-14

```yaml
---
status: in-progress
branch: codex/reasoning-summary-autoreview-implementation
timestamp: 2026-09-14T08:19:13+08:00
files_modified:
  - docs/maintenance/development-handoffs.md#reasoning-autoreview-checkpoint-2026-09-14
  - docs/design/ling-harness-gap-closure-implementation-plan.md
---
```

### 推理摘要与自动审核执行检查点

> 本文是防止上下文压缩后重复研究的执行检查点，不是新的产品设计提案。
> 恢复工作时先读本文，直接从“下一步执行顺序”继续。除非实现或测试出现与本文矛盾的真实证据，否则禁止重新进行整轮 Codex 源码核对。

#### 1. 当前目标与约束

- 更新基线：实际实现树已包含 `origin/main` 的 `76790031`。分支为 `codex/reasoning-summary-autoreview-implementation`；H07 已提交到 `47338dc1`，H08 evaluation foundation 由包含本文更新的下一笔原子提交记录。
- 实际开发树：`<isolated-implementation-worktree>`。
- 同事的 `<main-checkout>` 只读，禁止修改、清理、reset 或覆盖其中 WIP。
- 原 `<historical-recovery-worktree>` 暂不直接修改；验证完成后再受控同步差异。
- 只测试和打包 macOS，不处理 Windows。
- 当前不推送、不创建 PR。用户已在 2026-09-12 明确允许：未提交内容过多并妨碍继续开发时，可先创建本地恢复检查点提交。此类提交只用于保存和恢复，不代表 PR-ready，也不能替代后续按功能审查、测试和整理提交历史。
- 真实模型验收使用配置的兼容 relay（示例 `https://relay.example.com/v1`）；密钥只从环境中后缀 `_2` 的变量读取，禁止写入文档、日志、命令输出或截图。
- 历史 combined WIP 已通过本地检查点提交保存；后续继续按独立、已验证的功能边界创建本地提交，不把恢复检查点本身直接当成可合并 PR。

#### 2. 已完成且不得重复的源码核对

##### 2.1 Codex 推理摘要产品语义

Codex 设置提供四档：

- 自动
- 简洁
- 详细
- 无

结论已经确认：推理摘要是可公开的模型摘要，不等于原始推理过程。UI 可以显示安全摘要，但不得把原始 chain-of-thought、流式 thinking 文本或 provider 私有 reasoning content 当作摘要展示。

##### 2.2 Pi SDK 0.84.4 与 OpenAI Responses 行为

已确认：

- OpenAI Responses 请求在存在 reasoning effort 时默认发送 `reasoning.summary = "auto"`。
- `SimpleStreamOptions` 没有公开 `reasoningSummary` 字段，但现有 `onPayload` 边界可以安全调整为 `auto`、`concise`、`detailed`，或删除 summary 实现 `none`。
- Pi 会把 `response.reasoning_summary_text.delta` 和 `response.reasoning_text.delta` 都转换为 `thinking_delta`，因此不能依据流式 `thinking_delta` 判断哪些文字可以公开。
- 最终 thinking block 的 `thinkingSignature` JSON 保存 `item.summary` 和 `item.content`。

安全规则锁定为：

1. 只从通过校验的 `thinkingSignature.item.summary` 读取公开摘要。
2. 禁止读取 `block.thinking` 或 `item.content` 作为公开摘要。
3. provider 没有安全摘要时，运行中只显示“正在思考”，完成后不伪造摘要。
4. 原始 `assistant_thinking_delta` 只驱动运行状态，不进入持久化公开 transcript。
5. 非 OpenAI Responses provider 不修改 payload，也不把普通 thinking 当安全摘要。

##### 2.3 推理摘要事件与投影决策

采用独立的 typed reasoning-summary read model，不把推理摘要伪装成 `ExecutionAction`。原因是 `ExecutionAction` 是命令、工具和文件等事实的执行证据；混入摘要会污染 TerminalReport、multi-agent fan-in 和完成判定。

事件建议保持：

```ts
assistant_reasoning_summary {
  text: string;
  parts: string[];
  semantic: "safe_summary";
  source: "openai_responses";
  truncated: boolean;
}
```

投影规则：

- 由 Runner 在任务边界从合法 signature 提取。
- Contracts 负责类型与运行事件校验。
- Daemon 持久化并通过 reconnect/restart 可重建的 canonical 数据源公开。
- `conversation-ui-core` 投影为独立 reasoning item。
- 普通会话、Agent 私聊、频道外层和频道 child Agent 复用同一个 renderer。
- `ConversationTimelineReasoningRenderer` 不再使用事实行 `TimelineFactRow`，改为弱化的 document lane。

##### 2.4 自动审核实现前基线

现有设置已经有：

- `ask`
- `smart / Help me approve`
- `always`

当时 `createRunApprovalHandler()` 仍然只创建 pending approval 并等待人工，`smart` 不是完整自动审核。该差距现已按第 2.5 节原则实现；本段只保留为设计决策来源，不代表当前源码状态。

已存在 `resolvedBy: "system-reviewer"` 的公开/读取合同，但 Store resolve 输入仍只允许 `"local-user"`。`WorkUnitKind` 也尚无 `approval_review`。`approvals.ts` 已约 1335 行，禁止继续把完整 reviewer 堆进这个大文件。

##### 2.5 自动审核实现原则

锁定为：

- 使用当前获准 provider/model 创建独立 Pi reviewer session。
- reviewer `tools: []`，禁用 MCP、Memory、Skills、媒体、委派和递归审批。
- 严格输出 `approve | deny | manual`。
- 非法 JSON、异常、超时、证据不足全部回退人工，不自动放行。
- 使用共享总 deadline 和有限技术重试；明确拒绝不重试。
- 使用 approval revision、attempt、policy 和 action fingerprint 做 CAS，避免审核旧动作后批准新动作。
- 自动批准成功写入 `resolvedBy = "system-reviewer"`。
- 复用现有 WorkUnit、RuntimeEvent 和 approval checkpoint，不新增服务或 SQLite 表。
- 自动审核不等于 Full Access；执行前必须重新核验 action、cwd、参数、策略和 attempt fence。
- reviewer 拆为 parser、evidence builder、executor、deadline scheduler、CAS resolver、handler integration 等小模块。

#### 3. 当前实现状态

##### 3.1 安全推理摘要

已完成并有源码证据：

- Runner 新增 `packages/runner-pi/src/reasoning-summary.ts`，只读取通过校验的 `thinkingSignature.item.summary`。
- Runner 在 `message_end` 前输出 `assistant_reasoning_summary`，包含 `text`、`parts`、`semantic`、`source` 和 `truncated`。
- 提取最多 32 个 part、24,000 字符；非法签名 fail-closed，禁止回退到 raw `thinking` 或 `item.content`。
- Responses payload 已支持 `auto/concise/detailed/none`，并保留已有 `onPayload` 返回结果；非 Responses provider 不修改。
- Contracts 已加入事件类型和严格 payload 校验。
- `reasoningSummary` 已贯通 RunRequest、schema、workspace 默认设置、request snapshot、prepared input、continuation、automation 和四档 UI。
- Daemon 从已有 RunEvent 派生 `CanonicalReasoningSummaryRecord`，支持超过 1000 条事件分页扫描及 daemon restart 重建，不新增 SQLite 表。
- conversation detail / reconnect 对缺失 reasoning 集合 fail-closed；topic/thread reply 和 child Agent 已按 thread/run 贯通 reasoning timeline。
- raw `assistant_thinking_delta` 不进入公开摘要；Host 排序已改为预建 sequence Map，避免重复 `items.find()` 的 O(n^2) 路径。
- `conversation-ui-core` 已覆盖 stale/equal revision、reconnect merge、participant/run/attempt 隔离，以及 reasoning 不进入 TerminalReport/fan-in evidence。
- 普通会话、私聊、频道外层及 child Agent 已接入共享 `ConversationTimelineReasoningRenderer`；最终视觉结果仍须由 packaged macOS E6 验收。

本轮准确测试结果：

- Runner Pi：180/180 pass。
- Contracts：338/338 pass。
- Daemon reasoning/config/prepared-input focused：52/52 pass。
- conversation-ui-core：181/181 pass。
- Web unit：338/338 pass。
- Core/Daemon typecheck、Daemon build 和 Runner build 已通过；完整 combined gate 仍须按总计划重新运行。

##### 3.2 自动审核

已完成并有专项测试证据：

- reviewer 使用独立模块、严格 parser、bounded evidence 和敏感信息裁剪；原始 prompt/output、raw reasoning 和 API Key 不持久化。
- `smart` 已接入自动审核；`ask` 与 `always` 保持各自既有语义。
- 非法输出、证据不足、异常、共享 deadline 超时和技术重试耗尽均 fail-closed 到人工处理。
- CAS resolve 支持 `system-reviewer`，并绑定 approval revision、policy、action fingerprint、Run 和 Attempt ownership。
- approve 后先重新核验 action/policy/attempt fence，再创建 fenced replacement Attempt 执行原动作。
- deny 后原子关闭 Run、WorkUnit 和 Task；取消、stale reviewer 和晚到结果不得重新放行动作。
- daemon restart 只恢复精确 pending approval、lost `runtime_suspend` Attempt 和匹配 checkpoint/policy/action/evidence fingerprint 的 reviewer；reviewer 最多一次恢复，总 Attempt 上限 2。
- 外部媒体恢复会绑定新的 Attempt，但不会重复提交已接受的付费任务。

专项结果：Core approval-policy 67/67、approval-policy-run 94/94、automatic reviewer focused 17/17、conversation media 25/25、Daemon build pass、`git diff --check` pass。

##### 3.3 一并验证的既有链路

- Allow similar commands：规则真正持久化、匹配成功后命令实际继续执行，失败时不展示成已允许。
- 会话内审批卡与设置中的 sandbox/approval policy 职责分离。
- 最终总结只在存在真实执行/修改证据时生成对应事实区；纯问答不伪造操作总结。
- 三种会话共享 transcript、复制按钮、颜色层级和最终回复聚合。
- 子 Agent 叙述、工具、问题/回答和收尾按真实事件顺序展示。
- daemon restart、SSE reconnect、取消、超时、retry supersession、multi-agent fan-in、TerminalReport lineage。
- 压缩失败处理、单次长任务压缩、Memory 召回与新鲜度、工具结果预算。
- restricted command、HTML opener 和既定七项执行能力矩阵。

##### 3.4 Harness H06 文件变更权威

已完成并有专项测试证据：

- Pi 原生 `edit/write` fallback 已删除；Host 遗漏 `handledResult` 时 fail-closed，不再绕过 Ling。
- Daemon 已统一接管 native write、exact edit 和 Codex-compatible apply-patch，并接入同一个 ToolExecution prepare/approval/claim/execute/evidence 生命周期。
- typed `file_create` 使用 existing-parent、hard-link no-clobber；patch-shaped typed create 直接拒绝，不会退回普通覆盖写入。
- 写入前重新核验取消、Attempt、policy、路径、symlink 和 `.ling-stack`；更新使用同目录 fsync + atomic rename，并保留文件执行权限。
- 多文件部分失败只回滚本次已写入且仍匹配 postimage 的路径；外部并发修改触发 `diverged/unknown_outcome`，不会被覆盖。
- 启动恢复使用 policy artifact 中的 hash-only pre/post basis，把过期文件执行区分为 `not_applied`、`applied`、`diverged`；状态和 evidence refs 在同一 SQLite 事务提交。
- H06 证据：Runner Pi 182/182、Core Harness/ToolExecution 24/24、Daemon broker/approval/workflow/patch/recovery 233/233、窄边界 41/41；Runner/Core/Daemon build 与 `git diff --check` 通过。

这部分尚未做完整仓库测试和 packaged macOS 验收，因此这里只声明 H06 实现完成，不声明整个 Harness 或总计划完成。

##### 3.5 Harness H07 External Runner 工具一致性

已完成并有专项测试证据：

- External runner 不再读取可由配置自报的 `conformancePassed` 布尔值；工具授权来自与 adapter revision 绑定的 typed receipt。
- Registry 在选择 runner 时校验 curated tools、side-effect class、evidence commit、abort propagation、Attempt fencing 与 workspace boundary；失败写入稳定的 `runner_tool_conformance_failed` 原因。
- Adapter 收到实际 `tool_proposal` 后再次校验 receipt、revision 和本次 Run 的 requested tools，缺 receipt、旧 revision、未请求工具和副作用工具全部 fail-closed。
- 当前 Codex App Server 与 OpenClaw ACP 只开放 `read/grep/find/ls` 和 `none/workspace_read`；原生命令、写入、网络、凭据、外部投递与 MCP 继续禁用。
- `approvalBridgeVerified` 硬编码已删除；外部 backend 宣称 approval/native-resume 能力不会自动成为 Ling 的执行事实。
- Readiness API 改为逐项输出 tool execution conformance evidence，不再由一个 boolean 推导工具面、审批、workspace 和 artifact 全部已验证。

专项结果：Daemon build pass；runner registry/readiness/external adapter/bridge/conformance、hydration、reconstruction 与 approval recovery 63/63；Contracts 85/85；API client 52/52；Core fallback/migration 2/2；Web typecheck 与 `git diff --check` pass。全仓与 packaged macOS 仍属于最终 combined gate。

##### 3.6 Harness H08 Evaluation Foundation

已完成并有专项和全量测试证据：

- migration 137 新增 `run_evaluations` 与 append-only `run_evaluation_grades`；不为历史 Run 伪造评分。
- suite、case、baseline、candidate 都绑定精确 artifact ID、sealed payload SHA-256 和稳定 hashed idempotency key；定义或 artifact identity 变化会追加新 evaluation，不会覆写旧事实。
- evaluation claim 使用 SQLite lease、claim token、revision CAS 和 canonical UTC 时间；数据库约束禁止无 lease 的 `claimed/grading` 状态，过期 worker 不能 complete、fail 或 requeue 新 owner 的任务。
- grade identity 由 evaluation、grader type/id/version 唯一约束；grade update/delete 被 trigger 禁止；grade 与 evaluation terminal transition 在同一事务提交。
- deterministic rule grader 只接受封闭 JSON schema，支持 `deep_equal`、`contains`、`exists` 和 `number_range`；未知字段、未知 assertion、循环对象、非有限数字和 sealed artifact digest 不一致全部 fail-closed。
- Daemon evaluation scheduler 使用独立低优先级并发池，默认并发 1；SQLite claim 是 authority，timer 只是唤醒；不调用普通 Run semaphore。worker 内部异常会被 registry 收口，未完成 lease 保留给过期恢复。
- shutdown 先停止 evaluation 唤醒，再等待 in-flight worker，最后才关闭 store；不会让后台 grader 在 SQLite close 后继续写入。

本轮准确验证结果：

- H08 Core/迁移兼容集中门禁：30/30 pass。
- H08 Daemon scheduler：7/7 pass。
- Contracts：85/85 pass。
- Core 全量：990/990 pass。
- Daemon harness config、scheduler 与真实 shutdown 集成：25/25 pass。
- Core/Daemon build 与 `git diff --check` pass。

这只代表 H08 完成。model/human grader、cost/latency artifact、promotion report 与 G15/G18 仍属于 H09；完整仓库 combined gate 和 packaged macOS 验收仍未执行。

#### 4. 下一步执行顺序

1. 从 Harness T9/H09 继续：实现 model/human grades、cost/latency artifact 和 promotion report，并保持 model grader shadow-only。
2. 完成 Harness dynamic delegation T10–T12，并按依赖顺序接入现有 Run/Attempt/Workflow 边界，不重建顶层 orchestrator。
3. 按 `conversation-codex-style-transcript-implementation-plan.md` §6.2 重新执行当前 HEAD 的 G-00–G-12 combined gates，记录基线、源码、行为、安全与合并质量证据。
4. 对 Host capability/open viewer、既定七项执行能力、structured user-input lifecycle、native sandbox 后代停止与恢复、TerminalReport/fan-in/reconnect/restart 做真实正向和故障路径验证；修复当前 HEAD 可复现的问题。
5. 运行完整 test、typecheck、build，以及 docs/i18n/public/security/license 检查；不得用本节专项测试替代全量 gate。
6. 打包最新 macOS 客户端，使用真实 relay 完成普通会话、私聊、频道、多 Agent、审批、Allow similar commands、推理摘要四档、恢复、复制、最终总结和完整小项目案例。
7. 每个 E6 案例保存 screenshot、`semantic-state.json`、`lineage.json`、脱敏日志和 `case.json`；必须记录 build hash、thread/run/attempt、model 与 `simulation=false`。
8. 全部验证通过后，再评估如何受控同步或整理提交；仍不碰同事工作区、不推送、不创建 PR。

#### 5. 防止再次死循环的恢复协议

上下文压缩或新会话恢复后：

1. 先读本文。
2. 用 `git rev-parse HEAD`、`git status --short` 和最近测试结果确认增量状态。
3. 从第 4 节第一个未完成步骤继续；当前唯一实现起点是 Harness T9/H09 evaluation calibration。
4. 不重新浏览整套 Codex 推理摘要源码，不重新输出同一份设计总结。
5. 只有以下情况才允许局部复查外部源码：
   - 本地依赖版本变化导致 API 与本文不一致；
   - 编译错误证明记录的字段或事件名不成立；
   - 测试捕获到安全语义冲突；
   - 用户明确要求重新核验最新上游实现。
6. 后续进度汇报只包含新增代码、测试结果、真实 GUI 证据和具体阻塞。

#### 6. 完成定义

必须同时满足：

- 安全摘要不泄露 raw reasoning。
- 四档设置真实影响请求和展示。
- 自动审核具备 fail-closed、CAS、deadline、恢复和执行前 fence。
- 三种会话与 child Agent 使用共享 transcript 语义并保持归属隔离。
- 专项、全量、typecheck、build 通过。
- 最新 macOS packaged app 真实 GUI 验收通过并留有截图。

在这些条件达成前，不得声称“已完成”。

#### 7. 未决决策

无。现阶段剩余内容是实现与验证，不需要再次讨论推理摘要的基本语义或重新选择投影方向。
