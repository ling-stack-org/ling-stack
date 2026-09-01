# Codex-style Typed Transcript v3.8：实现计划

Status: implementation plan；v3.8 设计蓝图已锁定，D0 contract/result-anchor slice 正在实现、尚未验收；E1–E6 按顺序推进，packaged macOS 验收仍待执行
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`（已核对远端无新提交）
Canonical design: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Visual contract: [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
Surface contract: [Conversation Surface Contract](conversation-surface-contract.md)

目标不是重写会话，而是把已有 durable facts 投影成一个简单、可追溯、跨 surface
一致的 transcript。实现期间不修改用户当前 dirty checkout。

本计划把“好看”限定为可验证的工程约束：文档流不套重卡片，事实行有明确动作和
状态，详情原地 disclosure，三种会话及 depth-1 子 Agent 使用同一 renderer fingerprint。
任何视觉优化都不能改变 item kind、顺序、lineage、completion 或 context 语义。

v3.7 新增一条实现硬门槛：所有 surface 和子 Agent 必须通过同一个
`mountConversationTimeline` 组合入口；不能通过复制 JSX、复用旧 WorkCell 或在 Composer/
EnvironmentPopover 中补渲染来“看起来统一”。

v3.8 只补实现细节，不改变 v3.7 的事实权威和存储边界：SQLite 仍是 durable facts，
batch 仍是 display-only，`terminalReport` 仍是 execute turn 的唯一结果。实现者必须先
按本文的 work package 交付 evidence、projection、renderer、surface、recovery、packaged
macOS 六层，不能从某个页面的 CSS 或一段模型文本开始。

## Canonical phase naming（唯一执行编号）

为避免多个历史计划编号造成误解，开工和 PR 只使用下面的 `D0`、`E1`–`E6`：

| 唯一编号 | 责任 | 退出证据 | 历史文档中的别名（不是新阶段） |
| --- | --- | --- | --- |
| `D0` | 设计、contract、parity fixture 和 selector 锁定；不接业务 UI | 四份权威文档一致；reply/execute fixture、closed union、fingerprint 和 selector 全部通过 | `P0`、`S0`、`R0/R1` |
| `E1` | Host evidence fold：`tool_start/update/end`、revision、terminal fence、invalidation | 同一 `actionId` 原地收敛，乱序/重复/迟到事件有 audit | `P1`、`S1`、`R5` |
| `E2` | canonical atomic projector、owner/attempt/context 校验、display-only batching | fingerprint、split reason、child lineage 和 completion 隔离 | `P2`、`S2/S3`、`R6` |
| `E3` | shared Timeline registry、Markdown/fact/nested renderer、Host file/diff/artifact viewer、document row geometry | exhaustive registry、单滚动 owner、capability issue/redeem、无右侧 bubble | `P3`、`S4`、部分 `P1b` |
| `E4` | normal/private/channel/topic/branch/child surface cutover | 所有入口只调用一次 `mountConversationTimeline`，旧 caller 删除 | `P4`、`S5`、`R7` |
| `E5` | approval、retry、SSE reconnect、daemon restart、fan-in、TerminalReport recovery | atomic evidence 结论与 latest generation 收敛 | `P5`、`S6`、`R8` |
| `E6` | packaged macOS 真实 UI 与证据采集 | `simulation=false` 的 screenshot/semantic/lineage/log tuple | `P6`、`S7` |

后文若出现 `P`、`S` 或 `R` 编号，只用于对照旧讨论，不得新增分支、重复实现或改变
依赖关系。实现顺序固定为 `D0 → E1 → E2 → E3 → E4 → E5 → E6`；E1/E2 的纯测试可并行，
其余按该顺序串行推进。

实现 worktree `/private/tmp/ling-typed-transcript-v3-clean` 基于最新 `origin/main`，主
checkout 与历史实验 worktree 的 dirty WIP 不作为实现输入。任何代码提交都必须从本文的
设计闸门重新核验，不能把未审查的脏工作树当作基线。

## 0. 开工前置条件（D0：不切生产 UI）

设计 PR 合并后，先建立一个从同一 `origin/main`/design commit 派生的干净实现 worktree，
记录 Node、pnpm、Xcode/macOS target、当前测试基线和 commit SHA。现有 dirty checkout
与历史实验 worktree 不作为实现输入；候选实现只能按 commit 审查后 cherry-pick。

`D0` 的唯一产物是 contract/type、fixture/selector 的失败测试和边界清单；允许修改
closed union、纯 projector contract 和测试，但不切换 production surface。当前实现 worktree
为 `/private/tmp/ling-typed-transcript-v3-clean`，首批 contract、renderer registry 和
surface adapter 已在此基线上落地；后续提交按唯一的 E1→E6 切片推进。

当前代码核对还暴露了一个必须在 D0 先锁定的 breaking contract：
`ConversationItemV1` 没有 `terminal_report`，publisher 仍把报告写成
`assistant_message`，而 conversation detail 丢失 record 的 `generation` 和 result Item
identity。v3.7 不允许按时间或正文猜最高 report，因此 D0 必须先增加专用 final-result
Item、`ConversationTerminalReportProjectionDto(report + generation + resultItemId)` 和
assistant `presentationRole`。内部 `publishedMessageId` 一次性迁移为 `resultItemId`；不
保留双写、旧 renderer 或 feature flag。详细 contract 见 typed transcript 设计 §19。

| 产物 | 最小内容 | 通过条件 |
| --- | --- | --- |
| contract fixture | 六种 surface、成功/失败/等待/blocked/retry | 所有 item 有 anchor/lineage |
| semantic selector | id/kind/status/revision/depth/source ref | registry exhaustive |
| evidence matrix | start/update/end、重连、重启、fan-in | 明确 atomic owner |
| visual snapshot | document/fact/result/nested/approval | 无方形 bubble/重复 summary/Timeline 外结果卡 |

D0 还要把三层命名写进 fixture 的断言：持久化/API 的 `snake_case` wire kind 经过一次
contract adapter 映射为 core 的 `camelCase` projection kind，再映射为稳定的 dotted
`rendererKey`。fixture 必须同时记录这三列；任何 surface 直接把 wire kind 当 DOM kind、
或以未知 kind 回退到 `agentMessage`，都应在 D0 失败，而不是等到视觉回归才发现。

### D0：设计文档锁定（本轮先完成）

在写业务代码前，先把四份权威文档中的术语和边界锁成同一份实现输入：

- `TimelineSourceSnapshot` 只承载 durable records、coverage 和 revision watermark；
  `TimelineSnapshot` 只承载已完成 scope/owner/attempt/revision 校验的 typed items，
  是 React 唯一历史输入；
- `mountConversationTimeline()` 只负责纯渲染组合，不能再次排序、读取 SQLite、拼接
  message/action/approval 或创建 batch；
- `ConversationSurfacePolicy`/`ConversationSurfaceView` 等旧类型明确标为迁移输入，
  新代码统一使用 `ResolvedConversationSurface` + `ConversationInteractionPolicy`；
- document/fact/nested 三档视觉重量、单一 scroll owner、状态闭集和
  EnvironmentPopover/Composer/Right Dock/TerminalReport 的 owner 规则必须能在
  semantic selector 与视觉 fixture 中逐项验证。

**D0 退出条件**：四份文档互相链接；`TimelineSnapshot` 不再有双重定义；旧类型只出现在
标注为 migration input 的章节或明确的兼容别名说明；`node scripts/check-markdown-links.mjs` 和
`git diff --check` 通过。D0 未通过时不进入 E1，也不删除旧 caller。

**D0 当前状态（2026-09-01）**：四份权威文档已同步到同一套 v3.8 contract；实现 worktree
已有 `terminal_report` closed-union、Host `presentationRole`、`result_item_id` migration、
原子 publication item、纯 projector 的最高 generation join 和 `result.terminal` renderer
key WIP。已通过的最近窄范围证据为 contracts `50/50`、UI-core `88/88`、core `460/460`
和 daemon 定向测试 `322/322`；Markdown 链接与 `git diff --check` 也通过。当前 Web
typecheck 仍失败于 `WorkspaceClientView.tsx` 的 `TerminalReportDto` / projection DTO 边界：
旧 DTO 没有 `resultItemId`。因此 D0 尚未完成，更不能替代真实 daemon/API 与 packaged
macOS 验收。剩余必须补齐：

1. reply turn 以最终 `agentMessage` 收口；
2. execute turn 只产生一个 `terminalReport`；
3. report 只取最高 committed generation，并绑定 final-result item；
4. report 后没有重复 final assistant summary；
5. packaged Web DOM selector 能读出 `result.terminal`、report id、generation 和 lineage。

同时必须证明：report publication 使用专用 `conversation_item(kind="terminal_report")`，
而不是带 TerminalReport Markdown 的 `assistant_message`；execute 后的
`execution_summary` 被同一 turn outcome slot 抑制，普通 reply 的 `reply_result` 仍可见。

这五项以及 selector smoke 全部通过后，D0 才算完成。真实 surface cutover 仍属于 E4，
不能用它反向填补 D0 contract。
本次交接没有新增 SQLite 表、provider session 或运行时兼容 renderer。当前 worktree 中已有
的代码改动仍属于未验收 WIP，不能被当作 E1–E6 已完成的证据。

D0 不引入 feature flag，也不保留旧 renderer 兼容分支；测试先失败是预期的设计闸门。

### 0.1 当前基线与剩余工作

本计划不是从空白重写。当前实现 worktree 已经具备第一批基础设施，后续只补齐缺口，
不另起一套 transcript：

| 已落地 | 证据 | 仍需完成 |
| --- | --- | --- |
| closed item union、canonical snapshot、纯 projector、`protocolEvent`、`terminalReport` result anchor | `packages/conversation-ui-core` 与对应 tests | 对所有既有 channel caller 完成 cutover |
| 统一 `ConversationTimeline`、renderer registry、mount/fingerprint | `apps/web/src/shared/conversation/timeline` | 删除残留 route-local activity renderer |
| shared Timeline CSS/row shell | `apps/web/src/styles/shared/conversation-timeline.css`、`TimelineFactRow.tsx` | 收口状态文案为 `Queued/Working/Waiting/Waiting for approval/Succeeded/Failed/Cancelled/Blocked`，并移除 batch/output 的第二个纵向 scroll owner |
| `tool_start/update/end` 的 action identity 与 revision 基础、Host presentation role | daemon execution-action 模块、contracts | durable Host capability 签发和二次 scope 校验 |
| display-only command/exploration batching | core batching tests | recovery、fan-in、TerminalReport 的 atomic 回归 |
| source-ref adapter 的前端边界 | `source-ref.ts` 与 tests | daemon/desktop 真实 capability、symlink/跨 workspace 拒绝 |

因此实现顺序必须是“先接真实 evidence，再收口 surface，再做 packaged macOS 验收”。
不能用一张漂亮截图替代尚未接通的 Host 事实，也不能因为某个 surface 仍有旧 caller
就复制一个局部 renderer。

### 0.2 What already exists

这不是从零重写。当前 worktree 已有可复用的事实和投影入口：

| 已有入口 | 已覆盖内容 | 本计划的处理 |
| --- | --- | --- |
| `packages/conversation-ui-core/src/canonical-transcript-projector.ts` | scope、anchor、attempt、owner、terminal evidence、reconnect merge | 继续作为唯一纯 projector，不在 surface 重建 |
| `packages/conversation-ui-core/src/typed-transcript-batching.ts` | 相邻 read/command 的可逆 display batch | 补齐 consequential/跨 lineage split reason，不落库 |
| `apps/web/src/shared/conversation/timeline/*` | typed renderer registry、row、nested child、semantic selectors | 继续作为唯一 renderer；删除 route-local caller |
| `packages/daemon` RunEvent/ExecutionAction 与 TerminalReport | durable action/evidence、fan-in 和 recovery | 补齐 live invalidation、latest-generation replay 和真实重启验证 |
| `WorkspaceFileCapabilityRegistry` 与 source-ref adapter | capability scope、TTL、daemon epoch、realpath 校验 | 接通三个 surface 的 callback 二次校验 |

既有测试已经覆盖 projector 的 anchor/attempt/reconnect/batch 基础、web snapshot 的
full-history/context segment、source-ref 的跨 scope 拒绝、daemon capability 的 epoch 和
symlink 拒绝，以及 TerminalReport 的恢复发布。后续任务只补这些基础尚未证明的生产路径，
不另建 session、batch 表或第二个 renderer。

### 0.3 本轮交付边界

本轮只交付 typed transcript 的事实投影和统一展示，不改 provider session、SQLite
持久化拓扑或业务审批策略。D0 允许一次性把 TerminalReport 的 publication anchor 从
`published_message_id` 收口为 `result_item_id`；除此之外不新增持久化拓扑。实现结果必须
能让用户在同一时间线中看懂“说了什么、做了什么、现在是否需要处理”：

```text
Host/SQLite facts -> one snapshot -> atomic projector -> optional batch -> one Timeline
                                           │
                                           ├─ document lane (Markdown)
                                           ├─ fact rail (action/status)
                                           └─ nested rail (depth=1 participant)
```

### 0.4 NOT in scope

- provider session/schema、Pi loop、Codex/Claude runtime adapter：它们不是 transcript
  projection 的 owner，本轮不改其生命周期；
- 新增 `session`/`batch`/`activity_summary` SQLite 表，或把摘要写回
  `conversation_items`。D0 的 `result_item_id` 一次性 contract migration 属于本计划，
  但不得借此重写 SQLite 拓扑；已有 durable records 仍是事实来源；
- Windows 客户端、移动端和跨机器同步：本轮 packaged acceptance 只锁定 macOS；
- 新的 workflow engine、approval policy 或 fan-in 协议：只修复它们读取 atomic evidence
  的边界，不改变业务规则；
- 像素级截图在每一个 CI job 强制运行：semantic fingerprint、真实 packaged macOS
  evidence 是发布闸门，像素快照属于后续测试基础设施策略；
- 无法追溯的“兼容旧客户端” renderer：项目仍在开发阶段，旧行通过 strict adapter
  读取，缺 lineage 直接显示 blocked diagnostic。

这些排除项把本轮限制在“事实接入 → 统一投影 → 统一 UI → macOS 可验证”四个必要层，
避免把 provider session 或存储拓扑重写混进会话视觉改造。

### 0.5 本次设计收口（Codex-parity v3.7）

为了让实现不再靠截图猜测，本轮把以下视觉和语义决定视为锁定输入：

1. `ConversationTimeline` 的历史输入只有一个 immutable `TimelineSnapshot`；`policy` 和
   `callbacks` 只是控制/Host 依赖，不得把 message、action、approval 拆成多份列表，也不
   允许 surface 在 JSX 中二次拼接历史。
2. `userMessage`、`agentMessage`、`reasoning` 和 `plan` 保持 document/structured-document
   阅读顺序；统一左对齐，不再出现普通会话独有的右侧方形 bubble。`plan` 使用独立
   `document.plan` renderer，但不拥有命令完成语义。
3. command/file/tool/approval/protocol 是同一套 fact row：`icon + 动词 + 文本状态 + 一个
   disclosure`。状态词只使用 `Queued/Working/Waiting/Waiting for approval/Succeeded/
   Failed/Cancelled/Blocked`；审批由 Composer/approval gate 唯一控制。
4. 输出只显示 bounded tail；超过首屏使用同一 row 的 `Show more` 或 trusted artifact，
   不创建第二个纵向滚动容器。唯一 scroll owner 是 surface 的
   `ConversationFeedViewport`；`ConversationTimeline` 及其 child 都是普通文档流。
5. `EnvironmentPopover`、Composer、right dock、TerminalReport 只做 ambient/control/
   preview/final owner，不能复制 Timeline 文案、output 或 summary。

实现偏差必须先修改 canonical/visual 设计，再修改代码和 fixture；不得在某个 surface
中通过额外 CSS 或旧 WorkCell caller 绕过这些规则。

### 0.6 实现启动包（设计 PR 合并后）

实现从一个可复现的输入包开始，而不是从某个页面的 JSX 开始：

```text
D0 design/fixture lock
  -> E1 evidence fold
  -> E2 atomic projection + display batching
  -> E3 shared Timeline + Host viewers
  -> E4 surface cutover
  -> E5 recovery/fan-in
  -> E6 packaged macOS evidence
```

启动包必须固定以下内容：

1. `origin/main` 的 commit SHA、Node/pnpm 版本、macOS target 和基线测试结果；
2. 一份包含 paragraph/list/code/path、command、file/diff、tool、approval、nested
   Agent、retry、partial fan-in 和 blocked 的 canonical fixture；
3. 同一 fixture 在 normal/private/channel/topic/branch/child 的
   `itemKinds/order/rendererKeys/disclosureCount` 预期；
4. 每个事实行的 `actionId/runId/attemptId/participantId/workflowStepId/sourceRefs`，
   以及缺失证据时必须得到的 `diagnostic`；
5. packaged macOS 证据目录和脱敏规则。浏览器 mock 只能作为调试输入，不能替代真实
   客户端验收。

设计 PR 合并前不删除旧 caller；E1–E3 完成 parity fixture 后才进入 surface cutover，
E5 的 recovery/fan-in 通过后才允许执行 E6。这样每个阶段都能单独回滚，也不会把“视觉
变简单”和“事实来源已接通”混成一个不可定位的改动。

## 1. 成功标准

```text
durable facts -> evidence fold -> pure projector -> atomic timeline -> shared renderer
```

完成后，普通、私聊、频道 root/topic/branch 和 depth-1 子 Agent：

- 使用一个 item union、一个 projector、一个 renderer registry、一个 scroll owner；
- Markdown 保持文档结构，command/file/tool/approval 是小型事实行；
- `tool_update` 原地更新，同一 action id 不重复；
- retry、SSE reconnect、daemon restart、fan-in 仍由 atomic evidence 驱动；
- batch 可逆且不落 SQLite；
- 无旧 WorkCell/message-bubble 生产 caller、无第二 summary owner；
- packaged macOS 真实客户端有截图、semantic state、lineage 和脱敏日志证据。

## 2. 分支和基线纪律

```bash
git fetch origin --prune
git show-ref --verify refs/remotes/origin/main
git worktree add /private/tmp/ling-typed-transcript-v3-clean \
  -b codex/typed-transcript-v3-implementation origin/main
```

实现分支首个 commit 记录 `origin/main` SHA、Node/pnpm、macOS target 和测试基线。
现有 dirty checkout 不 reset、不 clean、不批量 stage。设计 commit 与代码 commit 分离。

如果后续要带入候选实现，只能显式 cherry-pick 已审查的 commit，并记录它是否改变
evidence contract；禁止把另一个 worktree 的整棵脏工作树复制进来。

## 3. 模块边界

| 层 | 入口 | 责任 | 禁止 |
| --- | --- | --- | --- |
| contracts | `packages/contracts/src/*` | item union、lineage、source refs、revision | React 临时字段 |
| daemon | `packages/daemon/src/features/runs/*` | start/update/end fold、snapshot/delta、terminal evidence | 以文案补事实 |
| core | `packages/conversation-ui-core/src/*` | pure projection、ordering、batch、policy | I/O、completion、SQLite |
| shared UI | `apps/web/src/shared/conversation/timeline/*` | registry、row、Markdown/code/path、a11y | raw SSE、DB、approval 决策 |
| surfaces | `apps/web/src/features/*` | scope、policy、Host callbacks、Composer wiring | route-local renderer |
| desktop | `apps/desktop/*` | packaged shell、daemon lifecycle、trusted Host action | mock-only acceptance |

生产调用链固定为：

```text
Host snapshot/SSE
  -> daemon merge + evidence fold
  -> core projector（pure）
  -> optional display batching
  -> ConversationTimeline
  -> surface policy/chrome + Host callbacks
```

### 3.1 现有代码的接入点

优先复用已有事实来源，不在 Web 端另建 session 或 action store：

| 既有能力 | 接入方式 | 迁移完成条件 |
| --- | --- | --- |
| `ConversationItem` / channel item page | `ConversationSnapshotAdapter` 转成 canonical position/source ref | 旧 message list 不再决定排序 |
| `RunEvent` / `ExecutionAction` | daemon evidence fold，按 `actionId + revision` 合并 | start/update/end 只产生一个 action row |
| TerminalReport / fan-in | 继续由 daemon 读取 atomic evidence | batch/visible row 不参与完成 |
| Approval / Artifact / diff | typed source ref + 唯一 owner callback | Composer/dialog 不复制结果 |
| 现有 surface feed | 只保留 scope/policy/chrome adapter | normal/private/channel 无 route-local renderer |

实现者必须先在每个 adapter 旁写出“输入 → projector → renderer → callback”的边界，
再改代码。若现有字段无法满足 strict envelope，新增的是 contract adapter 或诊断，
不能在 projector 中填充猜测值。

### 3.2 实现文件地图

第一轮实现按以下顺序寻找入口，避免在大型 surface 文件里重新堆逻辑：

1. `packages/conversation-ui-core/src/`：item union、纯 projector、排序、batch、
   fingerprint 和 fixture；
2. `packages/daemon/src/features/runs/`：evidence envelope、fold、revision、terminal
   fence、snapshot/replay 和 invalidation；
3. `apps/web/src/shared/conversation/timeline/`：registry、document lane、fact row、
   batch disclosure、nested depth、semantic attributes；
4. `apps/web/src/shared/conversation/`：trusted file/diff adapter 和 source refs；
5. `apps/web/src/features/workspace/NormalConversationFeed.tsx`、
   `apps/web/src/features/teammates/TeammatePrivateChatFeed.tsx`、
   `apps/web/src/features/workspace/ChannelMessageRenderers.tsx`：只保留 surface adapter；
6. `apps/desktop/`：packaged shell、daemon lifecycle、Host callback 和真实证据采集。

任何文件若同时承担 projection、renderer、approval 或 scroll ownership，先拆边界再
继续改；不要以“临时兼容”把旧 WorkCell 逻辑塞回 shared timeline。

## 4. 依赖顺序和交付闸门

```text
D0 design/fixture lock
  -> E1 evidence fold
  -> E2 atomic projection + display batching
  -> E3 shared Timeline + Host viewers
  -> E4 surface cutover
  -> E5 recovery + fan-in
  -> E6 packaged macOS
  -> ship gate
```

每个阶段都必须满足“代码、语义测试、视觉/恢复证据”三件套才可进入下一阶段。单元
测试通过但 semantic fingerprint 不一致，或截图漂亮但 lineage 缺失，都视为阶段失败。

本节的旧 `S0/S1/...` 小节是按职责拆开的实现说明，不是第二套阶段编号；执行时以本页
顶部的 `D0 → E1 → E6` 为准。

### D0（历史别名 S0 / R1）：contract 和 fixture 冻结

**实现**

- 建立 `ConversationTimelineItem` closed union（包含 `terminalReport`）、strict operation
  envelope、source refs、`TimelinePosition`、revision 和 semantic selectors；
- 扩展 canonical `ConversationItemV1`：增加 `terminal_report` payload 和 assistant
  `presentationRole=narration|reply_result|execution_summary`；conversation detail 使用
  `ConversationTerminalReportProjectionDto` 显式传递 generation/resultItemId；
- 为 normal/private/channel/topic/branch/child 准备同一份 canonical fixture；
- 核对现有 `ConversationItem`、`RunEvent`、`ExecutionAction`、`Approval`、`Artifact`、
  `ParticipantSpan`、TerminalReport 的真实字段；不存在的字段先补 contract adapter。

**退出条件**

contract/typecheck green；fixture 含 action/run/attempt/participant/workflow/source anchor，
没有通过缺字段放宽 projector 的测试；report/result Item 缺 join、generation 冲突或
evidence fingerprint 不一致时只产生 blocked diagnostic。

**统一 fixture 形状**（所有 surface 只替换 scope/chrome）：

```text
userMessage → plan(2 steps)
           → agentMessage(narration)
           → exploration ×3  → commandExecution(start/update/end)
           → fileChange(+diff) → subAgentActivity(depth=1)
           → terminalReport(sourceRefs，execute turn only)
```

fixture 同时提供：成功、失败、取消、审批等待、缺 evidence、retry supersession、乱序
delta、重复 end、跨 participant boundary。每个 item 都带 `actionId/runId/attemptId/
participantId/workflowStepId/sourceRefs`；无 action 的叙述 item 仍保留 `sourceRefs` 到
其 `conversation_item` anchor。

### E1（历史别名 S1 / R5）：evidence fold 和 live invalidation

**实现**

1. `tool_start/update/end` 归并为一个 action 和一个 DOM identity；
2. output tail bounded + redacted，revision 使用 monotonic number；
3. 第一个 durable end 是 terminal fence；迟到事件保留 diagnostic/source ref；
4. 每个接受的 revision 触发 live invalidation，拒绝 stale/equal-conflict；
5. daemon restart/SSE replay 可以重建相同 action state。
6. 一次性 SQLite migration 将可证明 lineage 的旧 TerminalReport assistant publication
   转成专用 result Item，并把 `publishedMessageId` contract 收口为 `resultItemId`；迁移后
   不保留运行时双读。

**实现细节**：eventId 先去重，entityId+revision 再合并，terminal fence 后只写 audit；
`tool_update` 的 accepted revision 必须触发同一 `data-conversation-timeline-id` 的
invalidation，禁止以追加 message 的方式“看起来有输出”。

**测试**

fold replay、duplicate end、late update、terminal immutability、redaction、SQLite lineage
round-trip、SSE delta merge、invalidation count。

**实现顺序固定为**：先落 durable event，再 fold，再发 invalidation，再投影 UI。禁止先
渲染 `tool_start` 文本、稍后用 `tool_end` 另插一行；`tool_update` 必须命中同一
`data-conversation-timeline-id`，terminal fence 后只追加 audit diagnostic。

### E2（历史别名 S2 / R6）：canonical projector 和 reversible batching

**实现**

- 按 `ConversationItem.sequence + partIndex` 排序，不按时间或 SSE arrival；
- 验证 scope、conversation-item anchor、owner、attempt supersession、revision conflict；
- 缺 lineage/anchor 生成 blocked diagnostic，不猜默认值；
- child span 放在父 anchor 后，只允许 depth 1；
- 将最高 committed generation 的 TerminalReport 绑定到同 thread/turn 的 final-result
  `conversation_item`；缺 anchor 时 fail closed；execute turn 投影 report 后抑制重复 final
  assistant summary，reply turn 不生成 report；
- 按 `terminal_report.payload.reportId/generation/evidenceFingerprint` 与
  `ConversationTerminalReportProjectionDto` 做严格 join；不得按 report 时间、数组顺序、
  Markdown 或相邻消息选择结果；
- `contextSegmentId` 只从已提交的 `TurnContextAssignment` 及其 ContextSnapshot/
  ContextSummary lineage 派生；
- atomic projection 完成后仅调用一次 `batchCanonicalTranscriptItems()`；
- command/exploration batch 保留 child ids、lineage、source refs，永不进入 completion。

**测试**

乱序 delta 收敛、retry/latest attempt、跨 thread、owner conflict、缺 anchor、context
segment、每个 hard boundary、batch 展开精确恢复、fan-in partial evidence，以及
TerminalReport latest-generation、missing-final-anchor、reply-vs-execute 和重复 summary
抑制。

**projection 伪代码**：

```text
items = snapshot.items
  .filter(scope == resolvedSurface.threadId)
  .flatMap(projectConversationItem)
  .flatMap(projectRunEvidence)
  .sort(sequence, partIndex, stableId)
atomic = resolveOwnerAndAttempt(items)
visible = batchCanonicalTranscriptItems(atomic)
```

`visible` 只用于绘制；TerminalReport、fan-in、retry 继续读取 `atomic`。任何 batch
wrapper 都必须携带 child ids 和 lineage，以便 disclosure 后恢复精确顺序。

### E3（历史别名 S3 / R7）：共享 Timeline 和 renderer registry

**实现**

- `ConversationTimeline` 使用 exhaustive registry；消息走 document lane，事实走
  `TimelineFactRow`，execute 结果走 `terminalReport` result row；user/agent 统一左对齐，plan 作为 structured-document 的低重量
  `document.plan` row，不承担执行完成语义；
- `TimelineFactRow` 的状态 label 必须统一为设计闭集；旧的 `Pending`、`Completed`、
  `Done` 等 raw copy 不能直接透传。`Waiting` 保留为非审批等待，审批等待必须显示
  `Waiting for approval`，两者都由 shared status mapper 生成；
- 频道 decision、handoff、summary、workflow/task/run 生命周期和 state-transition 先转换为
  `protocolEvent`，再进入同一 `TimelineFactRow`。它们是可追溯协议事实，不携带 execution
  completion 语义；旧操作按钮不得由 renderer callback 注入，控制权统一留在
  Composer/approval gate，Timeline 只提供状态、详情和 focus。
- Markdown AST 保留段落/list/fence/link/path；command output 使用 pre-wrap 和 bounded
  tail，不增加第二个纵向 scroll owner；
- file/path basename-first，点击前由 Host 授予 trusted ref；
- `tool_update` 复用稳定 DOM id；active row 与批次 disclosure 不互相覆盖；
- `subAgentActivity` 调用同一 registry(depth=1)，加 participant label + rail；
- `subAgentActivity` group 使用一个稳定 disclosure：实时 active/attention 默认展开，
  历史 safe-completed 可默认折叠；revision 不覆盖用户手动状态，group 内不创建滚动区；
- approval 只由 Composer/dialog gate 拥有；EnvironmentPopover 只显示 active ambient state；
- 删除 production WorkCell/message-bubble activity caller，测试迁移到 semantic selector。

**测试**

registry exhaustiveness、paragraph/list/code/path、row states、canonical status copy、
keyboard disclosure、reduced motion、dark/light geometry、normal/private/channel parity、
nested narration、no duplicate summary/action/TerminalReport；模型随口路径与 Host trusted file/diff ref
必须分别验证为“可复制不可导航”和“可导航但二次校验”。

**renderer 验收**：registry 对 closed union exhaustive；同一 fixture 在 normal/private/
channel/topic/branch/child 产生相同 `rendererKeys`、kind、status text、disclosure count；
只允许 shell title、roster、participant rail 和 policy hints 不同。
`ConversationFeedViewport` 是唯一 scroll owner；`ConversationTimeline` 和 nested depth=1
不得创建新的纵向 `overflow:auto|scroll`。

**Codex 风格 review gate**：document lane 不得有 fact-row 外框；fact row 首屏必须有
动词 + 状态；成功历史默认收敛；active/failed/approval 只展开一层；同一 action 不得
同时出现在 message、WorkCell、result row 和 Composer；execute turn 不得在
`terminalReport` 后再出现重复 final assistant summary。

**v3.7 组合 gate**：`mountConversationTimeline` 的输入只能是 resolved surface（scope +
policy + chrome）、canonical snapshot 和 Host callbacks；输出只能是一个 Timeline 和一个
fingerprint。
normal/private/channel/topic/branch/child 的 adapter 不得导出 renderer、排序函数、
batch 函数或第二个 scroll owner。nested depth=1 必须调用同一个 registry，depth=2
只能产生 `diagnostic(nested_depth_exceeded)`。

**实现验收顺序**：先让三种 surface 使用同一个 mount/fingerprint，再删除 route-local
旧 renderer。不能先删 UI 再靠截图猜测是否仍然保持 item 顺序；每次 cutover 必须同时
保留 semantic-state 和 lineage fixture，确保视觉简化不会降低事实可追溯性。

### E4（历史别名 S4 / R7）：surface cutover

所有 surface 只保留 adapter：

```text
normal      -> scope + model policy
private     -> scope + single participant policy
channel     -> scope + roster/topic/branch policy
child       -> parent anchor + depth=1 policy
```

adapter 不允许按 kind 自己分支；`ConversationTimeline` 只接已解析的 canonical snapshot。
禁止保留
旧 workflow skeleton、第二纵向 activity panel 或 Composer 下方 summary。

开发阶段不保留旧 renderer 兼容路径：

1. 先把旧 caller 迁移到 semantic selectors 和 canonical item fixture；
2. 删除旧 WorkCell/message-bubble activity renderer 及其 production imports；
3. 旧 SQLite 行仍可读，但缺 strict lineage 的行只显示 `diagnostic(blocked)`；
4. 同一 PR 不得通过恢复旧 class/selector 来“修”测试，测试必须迁移到 typed contract。

### E5（历史别名 S5 / R8）：recovery 和 fan-in

依次验证：

1. retry：失败 attempt → 成功 attempt，旧 completion 不污染主 lane；
2. approval：pending/allow/deny/expired，只有一个 control owner；
3. failure/cancel/blocked：事实行显示下一步，不能被 batch 隐藏；
4. SSE reconnect：active action 继续同一 row；
5. daemon restart：从 SQLite 恢复相同 fingerprint；
6. fan-in：所有 required participant evidence 或结构化 blocked 到齐后才 settle；
7. packaged macOS 不属于 E5；必须等 recovery/fan-in 通过后进入 E6。

TerminalReport commit、专用 result Item、supersession link 和 invalidation 必须在一个
publication transaction 中提交。任何中途失败整体回滚；不能出现 report 已 committed
但 Timeline 无结果，或 result Item 可见但 report 仍是 draft。

恢复测试必须把进程和传输故障放在 action 仍为 running 时注入：

```text
running action
  ├─ SSE disconnect ──> reconnect replay ──> same actionId/revision/row
  ├─ daemon restart ─> SQLite fold      ──> same fingerprint; old capability blocked
  └─ late end after terminal fence ───────> audit only; no second result
```

已知回归护栏：频道 reconnect 要等待 durable terminal projection，而不能用早期请求计数
或固定 sleep 推断 cursor；TerminalReport recovery 只重放每个 source 的最高已提交
generation，不能把历史 revision 重新发布成多张结果；approval deny 后必须停止旧
runner，不能继续写 post-terminal events。上述三项都要有 daemon integration test 和至少
一个 packaged smoke case，避免单元测试把进程寿命问题隐藏掉。

### E6（历史别名 S7 / P6）：packaged macOS

真实客户端必须执行命令、文件、代码、nested Agent、环境浮窗和恢复案例，并保存完整
evidence tuple。E6 不再新增 transcript renderer 或事实来源，只验证 E1–E5 在 packaged
shell 中的真实闭环。

**真实 UI 证据闸门**：每个案例必须同时保存 screenshot、semantic-state、lineage 和
脱敏日志；只有 mock/API 截图时，状态标记为 `simulation`，不能宣称 packaged acceptance。
SSE reconnect 与 daemon restart 必须在 action 仍为 running 时执行，恢复后比较 action
fingerprint、terminal fence 和 scroll owner，而不是只看最终文字。

## 4.1 按 PR 的实现切片

| PR/提交（唯一阶段） | 内容 | 不包含 |
| --- | --- | --- |
| D0 docs/fixture | 四份权威设计、source/canonical snapshot 分层、fixture 形状、selector 契约 | 业务代码 |
| E1 evidence | envelope、fold、revision、restart/replay | renderer/layout |
| E2 projection | canonical projector、attempt/owner、batch | React/CSS |
| E3 timeline | registry、Markdown/code/path、fact row、nested、Host viewer | route cleanup |
| E4 surfaces | normal/private/channel/topic/branch/child adapter cutover、删除旧 caller | 新事实模型 |
| E5 recovery | SSE、daemon restart、retry、approval、fan-in | 视觉重构 |
| E6 packaged QA | macOS package、真实案例、证据 tuple | mock-only 结论 |

每个 PR 只引入一条 ownership 变化，并在 PR 描述中列出旧 caller、删除项和回滚边界。
旧讨论里的 `P0–P6` 仅作为上述唯一阶段的历史别名，不再写入新分支名或测试名称。

## 4.2 开工清单（按文件和验收闭环）

下面是从当前 `codex/typed-transcript-v3-implementation` 基线继续执行的具体顺序。每一项都要
同时提交实现、单测和 semantic evidence；不能先做视觉，再用截图猜事实是否正确。

| 阶段 | 首要文件/模块 | 具体工作 | 退出条件 |
| --- | --- | --- | --- |
| E1 evidence | `packages/contracts/src/conversation-continuity.ts`、`packages/core/src/terminal-report-types.ts`、TerminalReport SQLite migration、`packages/daemon/src/features/runs/execution-actions.ts`、`execution-action-command-evidence.ts`、`execution-action-invalidation.ts`、`unified-exec.ts` | 增加专用 `terminal_report` Item/resultItemId；一次性迁移旧 publication；折叠 `tool_start/update/end`；固定 `actionId + revision + terminalFence`；bounded stdout/stderr；accepted update 发 invalidation | contract/migration round-trip、replay、重复 end、迟到 update、equal revision conflict 全绿；同一 action/result 只有一个 stable id；无运行时双读 |
| E2 projection | `packages/contracts/src/conversations.ts`、`packages/conversation-ui-core/src/canonical-transcript-projector.ts`、`typed-transcript-batching.ts`、`timeline-fingerprint.ts` | detail projection 传 generation/resultItemId；严格 join final-result Item；统一排序、owner/attempt、context segment；project latest committed `terminalReport` 并抑制 `execution_summary`；display-only batch；缺 lineage/anchor fail closed | 乱序、retry、reply/execute、report generation/anchor/fingerprint、跨 agent/run/attempt、非邻近和 consequential 边界均覆盖；batch 展开精确恢复 |
| E3 capability/viewer | daemon workspace-file action 与 `apps/web/src/shared/conversation/timeline/source-ref.ts` | 签发短期 opaque capability；绑定 workspace/thread/run/action/participant；callback 前二次 realpath/permission 校验；daemon epoch 失效；禁止 lineage 根据 path 自行填 `hostTarget` | 跨 workspace、symlink、过期、重启旧 token 全部 blocked；合法 file/diff 可打开，模型 path 仍只能复制 |
| E3 renderer | `apps/web/src/shared/conversation/timeline/*`、`packages/conversation-ui-react/src/styles/blocks/message-frame.css` | Markdown AST、command/output、file/diff、tool、approval、protocol、`terminalReport` result、diagnostic、nested depth=1；一个 disclosure；document row 几何统一左对齐 | registry exhaustive；DOM semantic selectors 稳定；无方形 message bubble、无第二滚动区 |
| E4 surface | normal/private/channel/topic/branch adapters 与 `apps/web/src/features/workspace/ChannelMessageRenderers.tsx` | 所有入口只构造 `ResolvedConversationSurface` 并调用 `mountConversationTimeline`；删除 route-local activity caller、旧 workflow skeleton 和 Composer summary | 同一 fixture 的 kind/order/status/disclosure/fingerprint 完全一致；差异仅 shell/policy/participant rail |
| E4b channel scope | channel thread resolver、protocol event adapter | `protocolThreadId()` 不再生成 `channel:<id>`；root/topic/branch 使用真实 `LingThread.id` 和 anchor；解析失败生成 `scope_mismatch` | protocol 行可由 `lineage.json` 回链 SQLite thread；synthetic id 永不进入 Timeline snapshot |
| E5 recovery | `workflow-fanin.ts`、`terminal-report-*`、retry/reconnect adapters | fan-in 等所有 required participant evidence 或 structured blocked；TerminalReport 只读 atomic；SSE/daemon restart 重建同 fingerprint | ready/plan/batch 数量不能 settle；旧 attempt 仅 audit；active row 原地恢复 |
| E6 packaged QA | `apps/desktop`、macOS packaging scripts、evidence harness | 构建 packaged macOS，执行真实 normal/private/channel/nested/approval/retry/reconnect/restart 案例，保存 evidence tuple | 每个 case 有 screenshot、semantic-state、lineage、脱敏日志；无 simulation 冒充真实验收 |

### 4.2.1 单个 action 的实现顺序

实现者必须按下面顺序接线，避免出现“先画一行文字、稍后再补事实”的竞态：

```text
Host emits tool_start/update/end
  -> durable RunEvent/ExecutionAction write
  -> evidence fold (dedupe + revision + terminal fence)
  -> invalidation(actionId, revision)
  -> canonical projector (scope/owner/attempt)
  -> optional display batching
  -> shared renderer (same DOM id)
```

任何步骤失败都保留上一份 durable evidence，并在 Timeline 显示
`diagnostic(blocked)` 或 `Reconnecting` shell hint；不得在 UI 中伪造一个成功 action。

### 4.2.2 真实 UI 案例编号

打包后的 macOS 客户端按固定 case id 执行，便于截图、日志和 lineage 对照：

| Case | 输入 | 必须看到 |
| --- | --- | --- |
| `N-01` | 普通会话：段落、列表、fenced code、模型 path | document lane 保留结构；path 只有复制/tooltip |
| `N-02` | 普通会话：read×3、command start/update/end、file diff | read batch 可展开；command 原地更新；file 有 trusted ref |
| `P-01` | 私聊复用 `N-02` fixture | fingerprint 与 normal 相同，仅 participant chrome 不同 |
| `C-01` | 频道两 participant + narration + read batch + command/file | participant rail；动作描述和状态完整；无旧 activity card |
| `C-02` | child 无 evidence、depth=2 child | child 显示 `Activity unavailable`；depth=2 结构化 blocked |
| `A-01` | approval pending → allow/deny/expired | 只有 Composer/dialog 一个 control owner |
| `R-01` | failed attempt → successful retry | 主 lane 只显示 latest；旧 attempt 可审计 |
| `R-02` | running action 中断 SSE 后 reconnect | 同一 action id/revision 继续；无第二 row |
| `R-03` | running action 时 daemon restart | capability 失效并重新签发；事实 fingerprint 不变 |
| `F-01` | partial fan-in → all required evidence | partial 只能 waiting；全部 evidence 后才 TerminalReport settled |
| `E-01` | active action + long cwd + dark/light + reduced motion | EnvironmentPopover 最多两行；不复制 timeline/summary |

每个 case 的 `case.json` 至少记录 `surface`、真实 `threadId`、turn/run/attempt、输入文本、
预期 owner 和是否 simulation。只有 `simulation=false` 且截图、semantic、lineage、日志
四件套齐全，才算 packaged acceptance。

### 4.3 依赖和可并行工作流

实现按模块边界拆成四条 lane；只有共享 `conversation-ui-core`/Timeline 的步骤顺序执行，
避免两个分支同时改同一套 renderer：

| Lane | 模块 | 先决条件 | 产物 |
| --- | --- | --- | --- |
| A Evidence | `packages/daemon`、`packages/contracts` | D0 contract fixture | fold、revision、terminal fence、invalidation |
| B Projection | `packages/conversation-ui-core` | A 的 envelope/fixture | projector、attempt/owner、batch、fingerprint |
| C Renderer | `apps/web/src/shared/conversation/timeline` | B 的 item union/fingerprint | document/fact/nested renderer、a11y selectors |
| D Surfaces + QA | `apps/web/src/features/*`、`apps/desktop` | C 的 mount contract | route cutover、packaged macOS evidence |

执行顺序：先并行启动 A 和不依赖代码的 fixture/selector 文档；A 合并后启动 B；B 合并
后启动 C；C 合并后 D 才能删除旧 caller 并进行真实 UI 验收。A 与 B 不应同时改同一
contracts 文件，C 与 D 不应同时改同一 surface adapter。

若团队只保留一个 worktree，则按 A → B → C → D 顺序串行执行；不为了并行而复制
`ConversationTimeline` 或维护两个 batch 算法。

### 4.4 Implementation Tasks

这些任务从当前基线的剩余缺口展开；每项都必须同时提交实现、测试和对应 semantic
evidence：

这里任务标题中的 `(P1)/(P2)` 是发布优先级，不是阶段编号；执行顺序只看 `D0/E1–E6`。

- [ ] **T1 (P1)** `packages/daemon` + shared source-ref adapter：接通 capability
  issue/redeem 的 UI callback 和 capability-bound preview，scope/realpath/permission/
  epoch/TTL 在 preview/open 前二次校验；transcript ref 走 `POST /workspace-files/preview`
  与 `POST /workspace-files/open`，跨 workspace、symlink、过期和重启后旧 token 均为
  blocked。
- [ ] **T2 (P1)** channel adapter：移除 `channel:<channelId>` synthetic scope，root/topic/
  branch 只使用真实 `LingThread.id` 和 anchor；解析失败输出 `diagnostic(scope_mismatch)`。
- [ ] **T3 (P1)** daemon recovery：latest-generation TerminalReport replay、approval deny
  后停止旧 runner、late event terminal fence 纳入同一 integration fixture；不产生第二
  action row 或 post-terminal event；report record + `terminal_report` Item + supersession +
  invalidation 原子提交。
- [ ] **T3a (P1)** final-result contract：移除 TerminalReport-as-assistant-message publication；
  增加 `presentationRole`、generation/resultItemId detail projection 和一次性 schema migration；
  迁移后 `rg` 不得存在 production `publishedMessageId`/TerminalReport Markdown renderer。
- [ ] **T4 (P1)** shared Timeline cutover：normal/private/channel/child 全部只调用
  `mountConversationTimeline`，删除生产 WorkCell/activity caller、旧 workflow skeleton、
  Composer/Popover/Right Dock 重复 summary；同一 fixture fingerprint 必须一致。
- [ ] **T4a (P1)** document geometry：保留 legacy `message-bubble-*` selector 作为迁移
  标记，但 document row 统一 leading-column、左对齐、无 card chrome；同步迁移
  `expectOwnMessageBubble` 一类旧断言，避免测试把右侧气泡重新锁回生产样式。
- [ ] **T5 (P1)** fan-in/completion：ready/plan/batch 数量不得 settle；required participant
  evidence 或 structured blocked 未齐时保持 waiting，并指明缺失 participant。
- [ ] **T6 (P2)** regression suite：补齐 Markdown AST fallback、single scroll owner、水平
  溢出、SSE reconnect、daemon restart、capability expiry、retry 和 nested depth-2 的
  unit/integration/Playwright 覆盖。
- [ ] **T7 (P1)** packaged macOS：执行 N/P/C/A/R/F/E 全部真实案例，写入 screenshot、
  semantic-state、lineage、redacted logs 四件套；`simulation=false` 才能过发布闸门。

执行顺序固定为 `T1/T2/T3 → T4/T5 → T6 → T7`。T1/T2/T3 可在不同模块 worktree
并行；T4/T5 必须等 canonical contract 收口后串行；T7 必须在 semantic 和 recovery
测试通过后进行。

### 4.5 v3.7 开工蓝图（按 Codex item 思路落地）

v3.7 不再以“页面看起来统一”作为完成条件，而是先把每个 Codex 风格 item 的事实
来源、renderer 和验收 selector 固定下来，再让 surface 只提供 scope/chrome。实现者按
下面的职责顺序提交，每一步都能单独回滚；这些是 `E1`–`E6` 的任务分解，不是新的
阶段编号：

```text
D0  contract fixture + selector
 └─ E1  evidence fold（start/update/end、revision、terminal fence）
     └─ E2  atomic projector + display projection（scope、owner、attempt、context、batch）
         └─ E3  shared renderer registry + Host viewers + one scroll owner
             └─ E4  normal/private/channel/child mount cutover
                 └─ E5  recovery + approval + fan-in integration
                     └─ E6  packaged macOS real UI evidence
```

#### 4.5.1 Item → renderer → evidence 对照表

| Item | Renderer | 事实来源 | 完成判定 |
| --- | --- | --- | --- |
| `userMessage` | `document.message` | `conversation_item` | durable item 已接受 |
| `agentMessage` | `document.message` | `conversation_item`/stream + Host `presentationRole` | narration/reply 可见；execution summary 不拥有结果 |
| `reasoning` | `document.reasoning` | safe summary | 不含 chain-of-thought |
| `plan` | `document.plan` | durable plan step | 不代表执行完成 |
| `commandExecution` | `fact.command` | RunEvent/ExecutionAction | exit/status/evidence |
| `fileChange` | `fact.file` | ExecutionAction/Artifact | stats/diff/source ref |
| typed tool | `fact.tool` | tool call/result | redacted result |
| `approval` | `fact.approval` | Approval record | Composer gate 决策 |
| `terminalReport` | `result.terminal` | committed TerminalReport + `conversation_item(kind="terminal_report")` + generation/resultItemId | Completion Gate + atomic publication barrier |
| `subAgentActivity` | `agent.nested` | ParticipantSpan + child items | required evidence 或 blocked |
| `commandBatch`/`explorationBatch` | `batch.*` | atomic child projection | 仅显示优化 |
| `protocolEvent`/`diagnostic` | `fact.protocol`/`fact.diagnostic` | protocol/audit record | source ref 可回链 |

#### 4.5.2 每个事实行的实现顺序

禁止先把模型文本画成“执行中”，再等待 Host 补证据。代码顺序固定为：

```text
Host event
  -> durable write
  -> fold + dedupe + revision
  -> invalidation(actionId)
  -> atomic projector
  -> optional batch
  -> renderer + semantic selectors
```

`tool_update` 的 accepted revision 必须能在同一 render cycle 读到；如果 daemon 重启或
SSE 断开，先从 SQLite 重建 atomic snapshot，再恢复同一个 DOM id。任何缺少 action/run/
participant/source ref 的事实都停在 `diagnostic(blocked)`，不能用 `ready`、`done`、plan
step 或 batch count 代替。

#### 4.5.3 三种 surface 的实现约束

每个入口只实现一个 adapter：

```text
NormalConversationFeed        -> ResolvedConversationSurface(normal)
TeammatePrivateChatFeed      -> ResolvedConversationSurface(private)
ChannelMessageRenderers       -> ResolvedConversationSurface(channel/topic/branch)
SubAgentActivity              -> ResolvedConversationSurface(child, depth=1)
                                   │
                                   └-> mountConversationTimeline()
```

adapter 不得导出 renderer、排序器、batch 函数、Markdown parser、status copy 或第二个
scroll owner。频道必须把真实 root/topic/branch `LingThread.id` 传入；解析失败只生成
`scope_mismatch` diagnostic。child 深度超过 1 只生成 `nested_depth_exceeded`。

#### 4.5.4 “简单好看”实现闸门

实现 PR 的 UI 截图和语义测试必须同时满足：

1. document lane 是自然 Markdown 流，不套方形 message bubble；
2. fact row 首屏有 `icon + 动作动词 + 文本状态`，详情只在同一 row disclosure 内；
3. 成功历史默认收敛，active/failed/waiting/blocked 才展开 bounded detail；
4. Composer、EnvironmentPopover、Right Dock 和 Timeline 外部区域不重复历史事实；
   execute turn 只有一个 `terminalReport` result row；
5. normal/private/channel/child 的 fingerprint 相同，差异仅为 shell/policy/participant
   rail；
6. 每个真实 macOS case 保存 `screenshot + semantic-state + lineage + redacted logs`，
   `simulation=true` 的截图只能用于调试，不能作为完成证据。

#### 4.5.5 文件能力实现注意事项

`capabilityTarget`（`open_file/open_diff/open_artifact`）和用户选择的 `appTarget`
（`vscode/cursor/zed/system`）必须使用不同字段。前端只能传递 Host 签发的
`capabilityId`；不能把模型正文中的 path、`file://` 或编辑器名称当成授权输入。实现
顺序为“issue → scope/realpath/permission/epoch/TTL 二次校验 → open”，diff/artifact
不能静默复用 `open_file` endpoint。

### 4.6 v3.7 开工执行板

下面是从当前实现 worktree 继续执行的唯一顺序。它把“设计已冻结”和“代码尚未验收”
分开，避免把已有基础设施误报成完成：

| 阶段 | 代码动作 | 必须留下的证据 | 不能提前做的事 |
| --- | --- | --- | --- |
| E1 evidence | 完成 `WorkspaceFileCapabilityAuthority` 测试；把 `tool_start/update/end`、terminal fence、live invalidation 接到 durable fold | action/revision/fence fixture、scope rejection fixture | 不在 UI 先画假的执行行 |
| E2 projection | 完成 atomic projector 的 owner/attempt/context 校验；收口唯一 batch 入口 | parity fixture、split reason、batch child lineage | 不把 batch 写入 SQLite 或参与 fan-in |
| E3 host viewer | 三种 capability target 接入各自 viewer；callback 传完整 item lineage | file/diff/artifact issue→redeem 测试 | 不把 diff/artifact 降级为 `open_file` |
| E4 surface cutover | normal/private/channel/topic/branch/child 只调用一次 `mountConversationTimeline`；移除 route-local WorkCell/summary | DOM fingerprint、`rg` caller audit、channel real-thread lineage | 不保留旧 production renderer |
| E5 recovery | approval deny、SSE reconnect、daemon restart、retry supersession、partial/complete fan-in | integration trace、latest-generation fingerprint | 不用 ready/plan/batch count settle |
| E6 packaged QA | 运行 N/P/C/A/R/F/E 案例并采集 macOS 证据 | screenshot + semantic-state + lineage + redacted logs | 不用浏览器 mock 截图冒充真实验收 |

阶段依赖为 `E1 → E2 → E3 → E4 → E5 → E6`。E1 的 daemon 单测和 E2 的纯 fixture 可以
在不同 worktree 并行；E3 以后必须串行，因为它们共享 callback、renderer registry 和
surface caller。任何阶段失败都保留失败证据并回到该阶段修复，不跳到下一阶段。

### 4.7 设计到代码的强制映射

实现提交必须在 PR 描述中逐项填写以下映射，防止“只改 CSS”或“只补截图”：

```text
typed item kind
  -> source of truth (ConversationItem / RunEvent / ExecutionAction / Artifact / Approval)
  -> projector function
  -> rendererKey + semantic selectors
  -> owning callback/viewer
  -> unit/component/integration/E2E evidence
```

最低审查命令：

```bash
rg -n "mountConversationTimeline\\(" apps/web/src/features apps/web/src/shared
rg -n "ConversationWorkCell|renderOperationTranscriptBlock|workflow skeleton|activity summary" \
  apps/web/src/features apps/web/src/shared
rg -n 'protocolThreadId|threadId:\s*`channel:|scope.*`channel:' \
  apps/web/src/features/workspace apps/web/src/shared/conversation packages/conversation-ui-core/src
rg -n "type TimelineSnapshot =|interface TimelineSnapshot" packages apps
rg -n "publishedMessageId|renderTerminalReportMarkdown|kind:\s*\"assistant_message\"" \
  packages/core packages/daemon packages/contracts
```

退出 surface cutover 的条件不是“找到一个 mount”，而是每个 canonical turn 只有一个
生产 DOM 输出，所有旧 caller 要么删除，要么明确标成 migration adapter 且不再进入 DOM。
频道若仍出现 synthetic `channel:<id>`，或者存在第二个 Timeline owner，阶段直接失败。
设计层还必须保证 `TimelineSnapshot` 只有一个 canonical 定义；durable 原始记录只能使用
`TimelineSourceSnapshot`，否则直接判定为 contract drift。

## 4.8 v3.8 实现启动板（从现在开始）

设计已经可以开工。下面是按“先事实、后投影、再视觉、最后真实客户端”排列的执行板；
每一项都有明确输入、代码边界和退出证据。除当前实现分支已有的 D0 WIP 外，不需要再
开第二套 transcript 或新建 SQLite 表。

### WP-0：收口 D0 基线（立即执行）

**输入**：`origin/main=63ab7c0e`、v3.8 四份设计、现有 contract/result-anchor WIP。

**动作**：

1. 完成剩余 daemon TerminalReport contract 迁移测试，修正 `resultItemId`、
   `terminal_report` item 和 partial-lineage fixture；
2. 更新 `apps/desktop/tests/run-packaged-continuity-smoke.mjs` 中残留的
   `publishedMessageId/published_message_id` 引用；
3. 通过 docs link、contract、core、daemon、web typecheck，并记录基线 SHA 和失败日志。

**退出证据**：D0 contract/selector fixture 全绿；`rg` 不再发现生产路径的旧
`publishedMessageId` 或 TerminalReport-as-assistant renderer；未解决的 daemon 失败必须
被归类为具体 P1，而不是用“基本通过”带过。

### WP-1：E1 evidence fold

**代码边界**：`packages/daemon` execution-action、RunEvent、invalidation；contracts 中
的 operation envelope。

**实现顺序**：

```text
tool_start/update/end
  -> durable RunEvent/ExecutionAction
  -> actionId map + dedupe + monotonic revision
  -> terminal fence
  -> invalidation(actionId, revision)
```

**必须覆盖**：重复 start/end、迟到 update、乱序 SSE、equal-revision conflict、输出脱敏
与 tail 限制、restart replay。任何被拒绝事件只写 audit diagnostic，不重新打开已结束行。

**退出证据**：同一 `actionId` 在所有事件序列中只产生一个 atomic item 和一个 DOM id，
accepted update 能在同一 render cycle 看到，旧 revision 永不覆盖新 revision。

### WP-2：E2 atomic projection + display batching

**代码边界**：`packages/conversation-ui-core` projector、attempt selection、owner join、
`commandBatch/explorationBatch`、fingerprint。

**实现顺序**：scope → sequence/part order → action owner → latest attempt → context
segment → TerminalReport join → atomic items → optional batch。batch 只接受相邻、同
participant/run/attempt/workflow step、成功终态的 read/command；≥3 才显示 header，
active/失败/审批/consequential 永远独立。

**退出证据**：同一 fixture 在 normal/private/channel/topic/branch/child 输出相同
`kind/order/rendererKey/status/disclosureCount`；batch 展开可恢复 exact child order；
`TerminalReport`、fan-in 和 `contextSegmentId` 的测试只读取 atomic projection。

### WP-3：E3 shared Timeline + Host viewer

**代码边界**：`apps/web/src/shared/conversation/timeline/*` 与 source-ref/capability
adapter。

**实现**：

- exhaustive renderer registry：document、fact、result、nested、batch、diagnostic；
- Markdown AST、fenced code、path、file/diff/artifact viewer；
- fact row 固定 `icon + verb + status + disclosure`，结果 row 固定 `Result · status`；
- `ConversationFeedViewport` 作为唯一纵向 scroll owner；detail 最大 240px，输出 bounded；
- capability callback 在 Host 端二次校验 workspace、realpath、permission、epoch、TTL。

**退出证据**：DOM selector/fingerprint 稳定；无右侧方形 bubble、无第二纵向滚动区、无
Composer/Popover/Right Dock 重复 summary；模型 path 可复制不可导航，trusted ref 才可
打开。

### WP-4：E4 surface cutover

**代码边界**：normal/private/channel/topic/branch/child surface adapters。

每个入口只构造 `ResolvedConversationSurface` 并调用一次 `mountConversationTimeline`；
删除生产 WorkCell/activity caller、旧 workflow skeleton、局部 status copy 和 Composer
summary。频道必须传真实 `LingThread.id`；topic/branch 解析失败只产生
`diagnostic(scope_mismatch)`。

**退出证据**：`rg` 审计只剩 migration adapter；所有 surface 的 renderer fingerprint
相同，差异仅 shell/policy/participant rail。

### WP-5：E5 recovery、approval、fan-in

**代码边界**：TerminalReport publication/recovery、retry、approval、fan-in consumers。

**必须覆盖**：failed→retry latest attempt、approval allow/deny/expired、SSE reconnect、
daemon restart、late terminal event、partial→complete fan-in、ready-only child、depth-2
child blocked。TerminalReport/report Item/supersedes/invalidation 必须同事务提交；fan-in
必须等待所有 required evidence 或结构化 blocked。

**退出证据**：旧 attempt 只在 audit；重连/重启得到同一 action fingerprint；不出现第二个
action row、TerminalReport 或 final summary；缺 participant 时用户看到明确 Waiting/Blocked。

### WP-6：E6 packaged macOS 真实验收

**代码边界**：`apps/desktop` packaged shell 和 evidence harness。Windows、移动端和
mock-only 浏览器不在本轮范围。

固定执行 `N-01/N-02/P-01/C-01/C-02/A-01/R-01/R-02/R-03/F-01/E-01`，每个案例保存
`case.json + screen-01.png + screen-02.png + semantic-state.json + lineage.json +
logs.redacted.txt`。`case.json` 必须写 `simulation=false`、bundle/version/hash、真实
thread/turn/run/attempt、输入和 daemon epoch。

**退出证据**：macOS packaged app 中可以看到完整 Markdown、真实 command/file/tool、
nested Agent、batch disclosure、approval、retry、SSE reconnect、daemon restart、fan-in
和 EnvironmentPopover；四件套缺一只能标为调试证据。

### 4.8.1 开工时的提交形状

按以下顺序提交，每个 commit 可单独回滚，且只 stage 本阶段文件：

```text
docs: v3.8 Codex-parity blueprint（本次）
feat(transcript): fold tool evidence and terminal fence
feat(transcript): project atomic timeline and reversible batches
refactor(web): mount shared ConversationTimeline and Host viewers
refactor(web): cut over normal/private/channel/child surfaces
test(transcript): recovery, approval, fan-in and renderer parity
test(desktop): packaged macOS evidence cases
```

如果某一阶段需要改变 `kind`、lineage、Thread 映射、context 分配或 completion authority，
先修改四份权威设计和 fixture，再修改代码。不能在实现分支里保留“临时兼容”作为第五
种 renderer。

## 5. 回归矩阵

| 领域 | 必测场景 | 证据 |
| --- | --- | --- |
| 内容 | paragraph/list/fence/inline code/path/link、user/agent 左对齐 | screenshot + semantic + component |
| 事实 | command/live update/file/diff/read/MCP/collab | stable id + source refs |
| 结果 | reply → final agentMessage；execute → 单一 terminalReport；report 后无重复 summary | result renderer + semantic owner count + lineage |
| 状态 | pending/running/waiting/succeeded/failed/cancelled/blocked | text + icon + detail |
| 批次 | 3 reads、3 commands、混合 kind、非邻近、跨 agent/run/attempt | child ids + split reason |
| 协作 | child narration、child command/file、blocked child、depth 2 | nested registry + blocked |
| 审批 | pending/allow/deny/expired/cancel | one Composer/dialog control |
| retry | old failed + new success + stale old end | latest lane + audit lineage |
| 完成 | ready 无 evidence、partial fan-in、complete fan-in | atomic evidence only |
| 恢复 | SSE reconnect、daemon restart、乱序/重复 delta | identical fingerprint |
| surface | normal/private/channel/topic/branch/child | same kind/order/geometry |
| shell | environment popover、长 cwd、dark、reduced motion、无右侧方形 bubble | no duplicate/scroll shift |
| packaging | packaged macOS launch + real interaction | build + screenshots + logs |

### 5.1 Test coverage map and failure modes

当前 test framework 是 Node `node:test`（core/daemon/web）加 Playwright（web/desktop）。
已有基础测试不是验收终点，下面的图把每条新链路和用户可见错误绑定起来：

```text
CODE PATHS                                      USER FLOWS / EVIDENCE
Host tool_start/update/end                     N-02 live command
  ├─ [covered] eventId dedupe                  ├─ [covered] same row revision update
  ├─ [covered] lower/equal revision reject     ├─ [gap→E2E] SSE disconnect while running
  ├─ [gap] terminal-fence late event audit     └─ [gap→E2E] daemon restart while running
  └─ [gap] bounded/redacted output tail
Workspace capability issue → callback          N-01/N-02 path and diff click
  ├─ [covered] scope/epoch/symlink reject       ├─ [covered] model path copy-only
  └─ [gap→E2E] expiry + callback re-check       └─ [gap→E2E] trusted file/diff open
Canonical projector → atomic → batch           C-01/F-01 multi-agent
  ├─ [covered] anchor/attempt/owner             ├─ [covered] partial fan-in waits
  ├─ [covered] batch excludes completion       ├─ [gap→E2E] child narration + action
  └─ [gap] all consequential split reasons     └─ [gap] ready-only child is blocked
Renderer registry → one Timeline               P-01/C-01/E-01 parity
  ├─ [covered] semantic selectors/fingerprint  ├─ [gap→E2E] normal/private/channel parity
  ├─ [gap] Markdown AST fallback               ├─ [gap→E2E] no duplicate summary/composer
  └─ [gap] single scroll owner                 └─ [gap→E2E] long output + reduced motion
TerminalReport/fan-in atomic consumers         R-01/A-01
  ├─ [covered] latest committed generation     ├─ [covered] retry latest attempt
  ├─ [gap] approval deny stops old runner      └─ [gap→E2E] failed → retry → settled
```

覆盖要求不是只看“函数被调用”：每个 `[gap]` 都要在同一 PR 增加对应的 unit/integration
或 `[→E2E]` Playwright/packaged case。生产失败必须满足“有测试、有错误处理、用户能看到
明确状态”三者；如果三者都没有，则视为 P1 critical gap：

| 失败模式 | 测试 | 处理 | 用户看到 |
| --- | --- | --- | --- |
| late event 穿过 terminal fence | P1 fold test | audit diagnostic | 原 row 不重开 |
| SSE/daemon 中断 | R-02/R-03 packaged | replay + reconnect hint | 原 action `Reconnecting` |
| capability 过期/跨 scope | capability integration + E2E | blocked diagnostic | 不可导航，可复制 |
| ready 无 evidence | fan-in integration | structured blocked | `Activity unavailable` |
| partial fan-in | F-01 | remain waiting | 明确缺哪个 participant |
| 旧 runner 在 deny 后继续发事件 | daemon integration | terminal fence + stop | 不追加第二结果 |
| channel feed 水平溢出 | desktop visual regression | `overflow-x:hidden` + one scroll owner | 不出现横向拖动 |

实现文件中的非显然状态机需要保留 ASCII 注释：`packages/daemon` evidence fold/
TerminalReport recovery、`packages/conversation-ui-core` projector/batch、以及
`apps/web/src/shared/conversation/timeline/ConversationTimeline.tsx` 的 nested depth/
scroll ownership。注释必须与本计划中的状态图同步，避免后续修复只改代码不改语义。

### 5.2 Performance and concurrency budget

- projector、attempt selection 和 batching 都是单次线性扫描，目标 `O(n)`；不得在每个
  row 中再次查询 SQLite、排序或请求 daemon；
- 一个 render cycle 只消费一个 immutable snapshot，避免 message/action/approval 的
  N+1 读取和不同步拼接；SSE 只触发按 `actionId` 的 invalidation；
- stdout/stderr 只保留 bounded tail（默认 8KiB/64 chunks），完整输出由 artifact ref
  延迟读取；batch 展开不得把完整日志复制进父 row；
- nested child 最多 depth 1；高密度 child 通过安全 batching 和 group disclosure 收敛，
  不使用局部 max-height 或第二个 scroll owner；
- reconnect/restart 使用 entity map 做幂等合并，旧 snapshot 可被 GC；不得把每次 SSE
  delta 追加到内存数组而不设 watermark；
- capability registry 只保存短期 opaque token 和 scope，TTL 默认不超过 5 分钟，daemon
  epoch 变化立即失效，避免长期 token 和无限增长缓存。

性能验收用 10、1,000、10,000 atomic items 的 synthetic fixture 检查 projector/batch
耗时、峰值内存和渲染节点数量；该基准只验证复杂度和上限，不替代 packaged UI 的真实
交互测试。

## 6. Packaged macOS evidence contract

```text
docs/design/ui2.0升级/evidence/conversations/packaged-macos/real-ui-<timestamp>/<case-id>/
  case.json
  build.txt
  screen-01.png
  screen-02.png
  semantic-state.json
  lineage.json
  logs.redacted.txt
```

最小真实案例：

1. 普通会话：Markdown、代码、path、command、file diff；
2. 私聊：同 fixture、同 renderer fingerprint；
3. 频道：两个 participant、nested narration、read batch、command、file、blocked child；
4. approval：pending → allow/deny；
5. long command：live update → terminal fence；
6. retry：failed attempt → success retry；
7. SSE reconnect 与 daemon restart 正在执行时恢复；
8. fan-in/TerminalReport lineage；
9. dense history + reduced-motion。

mock/API 截图可以辅助 debug，但不能替代 packaged macOS 证据。

### 6.1 验证命令与证据门槛

每个阶段先跑窄范围，再扩大范围；命令失败必须保留原始输出，不得用截图替代：

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core test
corepack pnpm --filter @ling-stack/conversation-ui-react test
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-conversation-work-cell-activity.spec.ts \
  e2e/ui2-conversation-file-diff.spec.ts \
  e2e/ui2-teammate-conversation-feed-composer.spec.ts
corepack pnpm check:docs
corepack pnpm --filter @ling-stack/desktop package:mac
```

退出 E6/ship gate 的必要条件是：相关 unit/component/E2E 全绿、`git diff --check` 通过、packaged
macOS 至少完成一轮真实案例，并且每轮 evidence tuple 的 `case.json` 写明 build hash、
thread/run/attempt、测试输入和是否为 simulation。全量 Web E2E 若含既有基线失败，必须
在报告中分开列出，不能混入 typed transcript 的通过结论。

## 7. Commit 形状

1. `docs(transcript): lock codex-style v3.7 design`
2. `feat(transcript): fold execution evidence and revisions`
3. `feat(transcript): project canonical items and reversible batches`
4. `refactor(web): adopt shared timeline renderer registry`
5. `test(transcript): add parity and recovery matrix`
6. `test(desktop): record packaged macOS transcript evidence`

每个 commit 可独立 review/revert。设计 commit 先合并；实现 PR 不应把 docs、evidence、
renderer 和大范围 route cleanup 混成一个不可审查提交。

## 8. Definition of done

- [ ] 四份权威设计文档互相链接、README 只保留一个 current entry point。
- [ ] normal/private/channel root/topic/branch/child 的 surface 到 `LingThread` 映射可由
  fixture 和 lineage 复现；Topic/Branch 不复制 parent transcript。
- [ ] `contextSegmentId` 由显式选择/结构规则/受限模型提议/服务端 policy 产生，且不受
  UI batch 影响。
- [ ] 所有事实行/batch 有完整 lineage，缺失时明确 blocked。
- [ ] `tool_update` 原地更新；terminal fence 不回退。
- [ ] TerminalReport 使用专用 `conversation_item(kind="terminal_report")`；detail API
  显式提供 generation/resultItemId；无 production assistant-message report publication。
- [ ] command/exploration batch 可逆且不参与完成判断。
- [ ] plan/agentMessage 只描述意图；真实命令、文件、工具和 execute `terminalReport`
  各有唯一 factual owner，Composer 不重复 summary。
- [ ] 普通/私聊/频道/topic/branch/child 使用同一 registry 与滚动 owner。
- [ ] 无生产 WorkCell/message-bubble activity caller、无重复 summary。
- [ ] TerminalReport/fan-in/retry 只读取 atomic evidence。
- [ ] SSE reconnect、daemon restart 收敛到同一 fingerprint。
- [ ] 频道 protocol event 使用真实 root/topic/branch `LingThread.id`，synthetic
  `channel:<id>` 不进入 Timeline snapshot。
- [ ] trusted file/diff/artifact ref 具备短期 capability、scope 二次校验和 daemon
  restart 失效/重新签发行为。
- [ ] packaged macOS 每个案例有完整证据 tuple。
- [ ] `git diff --check`、相关单测、E2E、typecheck、build 全绿。

未决设计：无。实现偏差必须先更新详细设计再改代码；任何与 Codex 风格相冲突的“临时
兼容”都必须作为明确的 blocked decision 提交，而不是静默保留旧渲染路径。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | 未运行，本轮为已确定的工程设计收口 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 未运行 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN (PLAN) | 4 个 P1 实现闸门仍未完成：capability callback、surface cutover、recovery/fan-in、packaged macOS |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 未运行；本轮已把 Codex-parity 视觉契约写入 v3.7 规范 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | 未运行 |

**VERDICT:** DESIGN UPDATED — v3.7 已统一四份权威文档，并新增 snapshot/mount、source-ref
lineage、专用 viewer、唯一 surface cutover、原子 recovery/fan-in 和执行板。实现尚未完成，
必须按 E1→E6 清掉 4 个 P1 闸门后，才能称为 Codex-parity 完成。

**OUTSIDE VOICE:** skipped；本轮没有引入新的外部架构建议，Codex 仅作为已记录的信息架构
参考。

NO UNRESOLVED DECISIONS
