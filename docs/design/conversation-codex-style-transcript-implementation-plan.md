# Codex-style Typed Transcript v3.9.1-final：实现计划

Status: implementation plan；v3.9.1-final 组件级细设计已锁定，实现进行中。历史 D0–E5 pass 不证明当前 combined WIP；本轮单一 root window、pending ordering 和 effective-attempt 改动须复验，E6 packaged macOS 尚未验收。当前完成判定统一读取 §6.2–§6.3，不从历史通过数量推断
Date: 2026-09-01
Design revision: unified viewport and root display model 2026-09-05（设计先行；实现按 D0→E6 闸门推进）
Design baseline: `origin/main` @ `ebfadd1b`（历史设计基线；本轮记录 fetch 后远端 SHA、实现 SHA 和 WIP 内容指纹，不以本行证明已同步最新代码）
Canonical design: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Visual contract: [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)
Surface contract: [Conversation Surface Contract](conversation-surface-contract.md)
Component design: [Conversation Codex-Parity Component Detailed Design](conversation-codex-parity-component-detailed-design.md)
Execution-entry increment: [Channel Execution Capability Integration Plan](channel-execution-capability-integration-plan.md)（2026-09-06：已纳入计划，尚未实现）
User-input and sandbox increment: [联合细设计与执行顺序](conversation-user-input-and-sandbox-integration.md)（2026-09-07：用户要求一起处理，设计已纳入、实现未完成）

目标不是重写会话，而是把已有 durable facts 投影成一个简单、可追溯、跨 surface
一致的 transcript。实现期间不修改用户当前 dirty checkout。

本计划把“好看”限定为可验证的工程约束：文档流不套重卡片，事实行有明确动作和
状态，详情原地 disclosure，三种会话及 depth-1 子 Agent 使用同一 renderer fingerprint。
任何视觉优化都不能改变 item kind、顺序、lineage、completion 或 context 语义。

实现硬门槛：普通、私聊、频道共用 `ConversationTimelineFeed`、唯一 viewport、根
`ConversationTimeline`、display model 和 renderer registry。每个 surface 调用一次
`mountConversationTimeline`；子 Agent 是同一根窗口中的 depth-1 rows，不额外 mount。
频道只增加 participant/roster、topic/branch 和 multi-agent fan-in。旧
`ConversationVirtualFeed` 与仅测量一个 Timeline root 的外层 virtualizer 不保留。

v3.9.1-final 只补接口级组件实现细节，不改变 v3.9 的事实权威和存储边界：SQLite 仍是 durable facts，
batch 仍是 display-only，`terminalReport` 仍是 execute turn 的唯一结果。实现者必须先
按本文的 work package 交付 evidence、projection、renderer、surface、recovery、packaged
macOS 六层，不能从某个页面的 CSS 或一段模型文本开始。

## Canonical phase naming（唯一执行编号）

为避免多个历史计划编号造成误解，开工和 PR 只使用下面的 `D0`、`E1`–`E6`：

| 唯一编号 | 责任 | 退出证据 | 历史文档中的别名（不是新阶段） |
| --- | --- | --- | --- |
| `D0` | 设计、contract、parity fixture 和 selector 锁定；不接业务 UI | 五份权威文档一致；reply/execute fixture、closed union、fingerprint 和 selector 全部通过 | `P0`、`S0`、`R0/R1` |
| `E1` | Host evidence fold：`tool_start/update/end`、revision、terminal fence、invalidation | 同一 `actionId` 原地收敛，乱序/重复/迟到事件有 audit | `P1`、`S1`、`R5` |
| `E2` | canonical atomic projector、owner/attempt/context 校验、display-only batching | fingerprint、split reason、child lineage 和 completion 隔离；batch 可展开恢复原子 identity | `P2`、`S2/S3`、`R6` |
| `E3` | shared Timeline registry、Markdown/fact/nested renderer、Host file/diff/artifact viewer、document row geometry | exhaustive registry、单滚动 owner、capability issue/redeem、无右侧 bubble | `P3`、`S4`、部分 `P1b` |
| `E4` | normal/private/channel/topic/branch surface cutover + root-flattened child rows | 每个 surface 一次 mount、一个 viewport/root virtualizer，child 不另 mount；旧 caller 删除 | `P4`、`S5`、`R7` |
| `E5` | approval、retry、SSE reconnect、daemon restart、fan-in、TerminalReport recovery | atomic evidence 结论与 latest generation 收敛 | `P5`、`S6`、`R8` |
| `E6` | packaged macOS 真实 UI 与证据采集 | `simulation=false` 的 screenshot/semantic/lineage/log tuple | `P6`、`S7` |

后文若出现 `P`、`S` 或 `R` 编号，只用于对照旧讨论，不得新增分支、重复实现或改变
依赖关系。实现顺序固定为 `D0 → E1 → E2 → E3 → E4 → E5 → E6`；E1/E2 的纯测试可并行，
其余按该顺序串行推进。

当前实现 worktree 为 `/Users/tianxiao/ling-typed-transcript-v3-recovered-20260906`（2026-09-06
从保全的 WIP 与原 HEAD 恢复；原临时工作区不再开发）；是否包含最新 `origin/main`
必须在本轮通过 fetch/ancestry 和 build manifest 核验。主
checkout 与历史实验 worktree 的 dirty WIP 不作为实现输入。任何代码提交都必须从本文的
设计闸门重新核验，不能把未审查的脏工作树当作基线。

## 0. 开工前置条件（D0：不切生产 UI）

设计 PR 合并后，先建立一个从同一 `origin/main`/design commit 派生的干净实现 worktree，
记录 Node、pnpm、Xcode/macOS target、当前测试基线和 commit SHA。现有 dirty checkout
与历史实验 worktree 不作为实现输入；候选实现只能按 commit 审查后 cherry-pick。

`D0` 的唯一产物是 contract/type、fixture/selector 的失败测试和边界清单；允许修改
closed union、纯 projector contract 和测试，但不切换 production surface。当前实现 worktree
已从 `/private/tmp/ling-typed-transcript-v3-clean` 恢复到上述独立目录；首批 contract、renderer registry 和
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

在写业务代码前，先把五份权威文档中的术语和边界锁成同一份实现输入：

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

**D0 退出条件**：五份文档互相链接；`TimelineSnapshot` 不再有双重定义；旧 wire 类型只
出现在标注为 source/migration input 的章节，不能出现在生产 renderer 或兼容 JSX；
`node scripts/check-markdown-links.mjs` 和
`git diff --check` 通过。D0 未通过时不进入 E1，也不删除旧 caller。

**D0 当前状态（2026-09-03）**：五份权威文档已同步到 v3.9.1-final contract；实现分支
已有 `terminal_report` closed-union、Host `presentationRole`、`result_item_id` migration、
原子 publication item、纯 projector 的最高 generation join 和 `result.terminal` renderer。
当前合并后证据为 contracts `50/50`、UI-core `93/93`、API client `51/51`、runner-pi
`25/25`、Web `137/137`、Desktop staging/path `89/89`，Core 与 Daemon 全量测试均以
exit 0 结束；Web lint、TypeScript、production build、Markdown links 与 `git diff --check`
也通过。D0 的 contract 闸门已经完成；下面五项均已有自动化覆盖，但仍要在 E6 packaged
客户端中重放，不能用源代码测试替代真实 App 验收：

1. reply turn 以最终 `agentMessage` 收口；
2. execute turn 只产生一个 `terminalReport`；
3. report 只取最高 committed generation，并绑定 final-result item；
4. report 后没有重复 final assistant summary；
5. packaged Web DOM selector 能读出 `result.terminal`、report id、generation 和 lineage。

同时必须证明：report publication 使用专用 `conversation_item(kind="terminal_report")`，
而不是带 TerminalReport Markdown 的 `assistant_message`；execute 后的
`execution_summary` 被同一 turn outcome slot 抑制，普通 reply 的 `reply_result` 仍可见。

这五项和 selector smoke 已在自动化层通过。真实 surface cutover 的 source audit 属于 E4，
packaged 客户端中的视觉、交互与恢复证明属于 E6；两者不能反向填补彼此。
本次实现没有新增 batch SQLite 表、provider session 或运行时兼容 renderer。E1–E5 的
source/automated evidence 已完成，E6 未完成前仍不得发布或宣称整体完成。

D0 不引入 feature flag，也不保留旧 renderer 兼容分支；测试先失败是预期的设计闸门。

### 0.1 历史切片证据与当前复验边界

下表记录之前切片的通过报告，用来避免重复实现已有基础设施。数量不是当前测试结果；
本轮合并后的源码、窗口化和状态折叠修改必须按 §6.2 重新验证，E6 逐案验收见 §6.3：

| 已落地 | 历史证据（非本轮验收） | 仍需完成 |
| --- | --- | --- |
| closed item union、canonical snapshot、纯 projector、`protocolEvent`、`terminalReport` result anchor | contracts/UI-core/Web tests | packaged App 中验证唯一 result row |
| 统一 `ConversationTimeline`、renderer registry、mount/fingerprint | Web source audit 与 `137/137` | packaged normal/private/channel/topic/branch/child 视觉等价 |
| shared Timeline CSS/row shell、统一状态文案、单一 feed scroll owner | Web lint、semantic contracts、production build | 真实长输出、折叠和窄窗口 UI 验收 |
| `tool_start/update/end` action identity/revision、terminal fence、live invalidation | Daemon/Core 全量测试 | packaged SSE reconnect 与 daemon restart 重放 |
| display-only command/exploration batching | UI-core `93/93` | packaged mixed action/batch disclosure 验收 |
| file/diff/artifact capability issue/redeem 与专用 viewer | API/Web/Daemon capability tests | packaged 点击、tooltip、跨 workspace 拒绝证据 |

因此实现顺序必须是“先接真实 evidence，再收口 surface，再做 packaged macOS 验收”。
不能用一张漂亮截图替代尚未接通的 Host 事实，也不能因为某个 surface 仍有旧 caller
就复制一个局部 renderer。

### 0.2 What already exists

这不是从零重写。当前 worktree 已有可复用的事实和投影入口：

| 已有入口 | 已覆盖内容 | 本计划的处理 |
| --- | --- | --- |
| `packages/conversation-ui-core/src/canonical-transcript-projector.ts` | scope、anchor、attempt、owner、terminal evidence、reconnect merge | 继续作为唯一纯 projector，不在 surface 重建 |
| `packages/conversation-ui-core/src/typed-transcript-batching.ts` | 相邻 read/command 的可逆 display batch | `projectDisplayBatches()`、`BatchSplitReason`、边界诊断和 `expandDisplayBatch()`；不落库 |
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
   阅读顺序；正文内部保持左对齐，用户消息的头像在正文右侧、消息轨道靠右，Agent
   头像与叙述/事实轨道在左侧，不再出现普通会话独有的方形 bubble。`plan` 使用独立
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

### 0.7 Codex parity 开工交接（本轮新增）

从本节开始，R5–R8 只作为历史讨论的别名，工程实现只使用 `D0 → E1 → E2 → E3 → E4 →
E5 → E6`。对应关系固定如下：

| 历史说法 | 当前阶段 | 交付目标 |
| --- | --- | --- |
| R5 | E1 | Host `tool_start/update/end` 折叠、稳定 action identity、live invalidation |
| R6 | E2 | atomic projection、owner/attempt/context 校验、可逆 command/exploration batch |
| R7 | E3 + E4 | Codex-style renderer registry、统一 row grammar、normal/private/channel/topic/branch/child 单一 mount |
| R8 | E5 + E6 | recovery、approval、fan-in、TerminalReport 和 packaged macOS 真实验收 |

实现切片不是重写 provider session 或新建一套会话存储，而是复用现有 durable records：

```text
RunEvent/ExecutionAction/Approval/Artifact
  -> EvidenceFold
  -> CanonicalTranscriptProjector
  -> optional display batching
  -> ConversationTimeline renderer registry
```

#### 0.7.1 设计到代码的最小边界

| 模块 | 只负责 | 明确不负责 |
| --- | --- | --- |
| `packages/contracts` | closed item union、wire→projection 映射、lineage/source refs | React JSX、状态文案推断 |
| `packages/daemon` | durable evidence、revision、terminal fence、invalidation、capability | UI 排序、batch、summary 文案 |
| `packages/conversation-ui-core` | 纯 projector、attempt/owner/context、display batch、fingerprint | SQLite、网络、fan-in 副作用 |
| `apps/web/src/shared/conversation/timeline` | exhaustive renderer、Markdown/code/path、fact/result/nested row | raw SSE、DB、completion 判断 |
| `apps/web/src/features/*` | scope/policy/chrome、一次 mount、typed callbacks | route-local renderer、第二滚动区、第二 summary |
| `apps/desktop` | packaged shell、daemon lifecycle、真实 macOS smoke | mock 截图冒充验收 |

#### 0.7.2 PR 形状和退出条件

1. **PR-D0 `docs(transcript): lock codex-parity contract`**：更新本组设计文档和 parity
   fixture；确认 child 使用父 Thread + participant span，移除所有 legacy renderer/fallback
   入口描述。退出条件是 docs link、`git diff --check`、fixture/selector 通过。
2. **PR-E1 `feat(transcript): fold host evidence`**：实现 `actionId + revision + terminal
   fence` 和 live invalidation；重复/乱序/迟到事件进入 audit。退出条件是同一 action 只有
   一个 atomic row，reconnect/restart fingerprint 不变。
3. **PR-E2 `feat(transcript): project atomic items and batches`**：完成 scope/owner/attempt/
   context、TerminalReport join 和可逆 batch。退出条件是 batch 展开恢复 exact child ids，
   completion/fan-in 只读 atomic。
4. **PR-E3 `refactor(web): use Codex-style shared renderers`**：实现 document/fact/result/
   nested/batch/diagnostic renderer、Markdown/code/path、trusted ref、单 scroll owner。
   退出条件是 semantic fingerprint 稳定，无右侧 bubble、无第二纵向滚动区。
5. **PR-E4 `refactor(web): cut over all conversation surfaces`**：normal/private/channel/
   topic/branch 每个 viewport 调用一次 `mountConversationTimeline`；Topic/Branch 传真实 child
   Thread，Agent child 以 parent Thread + participant span 进入根 display rows。退出条件是
   `timelineOwnerCount=1`、`syntheticThreadCount=0`、所有旧 production caller 删除。
6. **PR-E5 `test(transcript): prove recovery and fan-in`**：approval、retry、SSE reconnect、
   daemon restart、partial/complete fan-in、TerminalReport generation/supersession。退出
   条件是 ready/plan/batch count 无法提前 settle，缺证据明确 waiting/blocked。
7. **PR-E6 `test(desktop): record packaged macOS evidence`**：真实 packaged App 执行 N/P/C/
   A/R/F/E cases，保存 screenshot、semantic-state、lineage、redacted logs。退出条件是
   每个 case `simulation=false` 且 build/thread/run/attempt 可回链。

PR-D0 先合并；E1/E2 的纯测试可分 lane，E3 之后必须串行，因为共享 registry、callback 和
surface adapter。任何阶段失败都停在该阶段修复，不以 CSS、截图或兼容层越过闸门。

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

缺 canonical anchor 的历史诊断不能按最新 watermark 插到新 Turn 尾部。adapter 仅可从
已验证的 Run → 唯一 TurnRun → 同 owner/workspace/thread 的 Turn.sourceItemId → 可见
用户消息关系产出 `diagnosticId → afterItemId` 显示定位信息；该关系不证明 canonical
Item 存在。共享 `buildSurfaceTimelineSnapshot` 在 batching 前统一应用定位，只移动
diagnostic，保留所有 item 对象、sequence、sourceRefs、blocked 状态和非诊断项相对顺序。
缺失、歧义、冲突、重复端点或非用户目标均保持原位；禁止 surface 自行二次排序、隐藏
诊断或为排版伪造 canonical anchor。normal/private/channel 使用同一纯投影契约。

### E3（历史别名 S3 / R7）：共享 Timeline 和 renderer registry

**实现**

- `ConversationTimeline` 使用 exhaustive registry；消息走 document lane，事实走
  `TimelineFactRow`，execute 结果走 `terminalReport` result row；用户头像在右、Agent 在左，正文内部均左对齐，plan 作为 structured-document 的低重量
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
icon + 动作 + basename/真实命令，非成功状态明确；成功历史默认收敛；
active/failed/approval 只展开一层；同一 action 不得
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

#### E3 验收：默认事实行与详情唯一展示规则（本次验收细化）

这是已确认 UI 规则的验收细化，不新增设计版本，也不改变事实状态或执行语义：

1. 默认事实行只有一行 `icon + 动作 + 文件 basename / 真实命令 + optional disclosure`。
   完整路径通过 hover/focus tooltip 展示；能否点击仍由 Host trusted ref 决定。
2. 成功由动作完成态表达，不额外重复 `Succeeded/已完成`、`exit 0` 或耗时。状态仍保留在
   typed model 和可访问语义中；本文其他状态枚举和示意图不是要求再显示一份成功标签。
3. exit code 和耗时仅在展开详情中各出现一次，不同时出现在摘要、标题和详情。
4. 展开只新增真实输出、错误、diff 或未展示的证据字段；不得复制标题、动作摘要或同一
   输出。不因工具没有额外结果而用摘要填充详情；无新增内容时不提供空 disclosure。
5. 失败、timeout、cancel 和 approval 必须明确显示，不能因“简洁”而隐藏，也不能合并
   到成功 batch 中。正在执行的状态同样必须可辨识。
6. normal、private、channel 和 child 使用同一个 renderer、batch/disclosure 规则。
   child 只增加 participant 标识和 depth=1 缩进，不维护自己的工具 UI 或滚动容器。
7. 同一消息的叙述按真实事件分段交错，但附件、生成媒体、错误和全文复制/反馈只由最后
   一个叙述段承载。该展示 owner 不修改 canonical identity，也不跨 run/attempt/participant
   共享；用户消息仍保留原编辑能力。复制动作明确对应整条消息，不能重复成每段一套。
8. document 用户行的头像位于正文右侧，且与正文处于同一 grid row；用户消息轨道靠右，
   正文内部保持左对齐。Agent 头像位于正文左侧，与叙述和事实行保持相同方向。
   复制/编辑独占正文之后的动作行。DOM 顺序不得让头像被自动排到动作行，形成貌似
   “空消息”的展示。不得把复用组件误解成用户和 Agent 都采用左侧头像。带独立作者栏的变体
   保留作者/正文/动作三行；普通会话无头像时不得新增空头像列。共享样式和三 surface 的
   宽/窄屏几何回归共同保证这一规则，不增加频道专属 renderer。

组件测试和 packaged macOS 验收均检查：折叠行单行、完整路径 tooltip、成功态无重复
元数据；展开后 exit/耗时各一次，且没有重复标题、摘要、输出。三 surface 与 child
使用同一 fixture 核验相同 renderer 行为。

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

#### E4 私聊单 Agent 边界（已确认行为的实现约束）

- 私聊只包含用户与选定 teammate。共享 UI 不代表共享参与者或调度权限；多 Agent 协作
  只属于频道。其他 Agent 的名字若是用户主动粘贴的普通文字，不因此获得 participant 身份。
- API、context builder、narration/media/transcript 与前端 adapter 必须核对
  `teammateId + directThreadId + canonical private LingThread`。Run 还必须同 owner/thread、
  无 channel/workflow，且有一致的 owning Turn/Run link；linked ID 本身不是授权。
- 已有回复的幂等早返先校验 owner/lane/author；history helper 不得把异属消息重新标记
  为当前 Agent。没有可证明的私聊归属时不读取 linked task/workflow 内容。
- Feed 在构造正文、消息动作、附件和 activeRun 前过滤 owner；显式 runId 不匹配时，
  禁止用 same-turn 兜底放行。切换 teammate 后旧 snapshot 与迟到响应均不得发布。
- 私聊不发布其他 Agent 的事实、来源引用或协作按钮。当前 owner 的协作/子 Agent/频道
  协议条目只能产生无外部目标与可操作 sourceRefs 的通用 scope-blocked 诊断；不能伪装成功。
- Host 必须约束私聊 delegation 能力，不能只改 prompt 或隐藏 UI。按实际注册 capability
  判定并在 dispatch/hydration 边界执行，不按工具名称猜测，也不禁用正常 read/bash/MCP。
  外部 runner 无法证明遵循时必须如实列为未验收，不宣称单 Agent 保证已完成。
- 用户显式“转为任务”仍可创建分配给当前 teammate 的频道任务，不能与自动跨 Agent
  转派混为一谈。UI 组件仍复用，禁止新增私聊专属工具 renderer。

最小回归：foreign author/owner/lane、同 turn 异 run、linked channel/foreign run、旧响应
幂等早返、owner 协作条目、晚到 SSE/GET、合法 owner narration/tools 不回归；另以真实
私聊请求确认没有跨 Agent 调度。该边界全部通过前不关闭 P 系列验收。

#### E4 频道启动叙述必须读取真实状态

proposal 被接受、workflow 已创建、Run 已启动是三件不同的事。pending 只表达正在检查
执行条件；编排返回 blocked/approval/idle 时不得留下固定 Starting now。可核验的
startedSteps/runId 只证明派发被接受；还需持久 Run 的 running + startedAt 才能表示已启动。
Run 可能在其他 participant 的派发 await 期间取消、失败或等待审批；当前持久状态优先于
started envelope，不得把 terminal/approval Run 写成排队或启动。多人混合状态分别列出，
部分启动不得声称全部 required participant 已启动；单个 Run 完成不代表 workflow/fan-in 成功。
这条规则不改变终态事实、权限或 fan-in；错误操作计划仍须独立修复，不能改文案后称
原 C01 完成。测试须覆盖 pending、blocked 正常返回、抛异常、审批、idle、部分及全部启动。

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
| D0 docs/fixture | 五份权威设计、source/canonical snapshot 分层、fixture 形状、selector 契约 | 业务代码 |
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
| E3 renderer | `apps/web/src/shared/conversation/timeline/*`、`packages/conversation-ui-react/src/styles/blocks/message-frame.css` | Markdown AST、command/output、file/diff、tool、approval、protocol、`terminalReport` result、diagnostic、nested depth=1；一个 disclosure；document row 按发送者统一定位，正文内部左对齐 | registry exhaustive；DOM semantic selectors 稳定；无方形 message bubble、无第二滚动区 |
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
- [ ] **T4 (P1)** shared Timeline cutover：normal/private/channel 每个 viewport 只调用一次
  `mountConversationTimeline`，child 只加入根 display rows；删除生产 WorkCell/activity caller、旧 workflow skeleton、
  Composer/Popover/Right Dock 重复 summary；同一 fixture fingerprint 必须一致。
- [ ] **T4a (P1)** document geometry：保留 legacy `message-bubble-*` selector 作为迁移
  标记，但 document row 统一按发送者定位：用户头像右侧、Agent 头像左侧，正文内部
  左对齐、无 card chrome；同步迁移 `expectOwnMessageBubble` 一类旧断言，分别检查
  左右位置与气泡外框，不能因取消气泡而取消用户消息的右侧身份。
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
| E4 surface cutover | normal/private/channel/topic/branch 每个 viewport 一次 mount，child 为根 display rows；移除 route-local WorkCell/summary | DOM fingerprint、`rg` caller audit、channel real-thread lineage | 不保留旧 production renderer |
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
生产 DOM 输出；所有旧 renderer/caller 必须删除。若确有旧 durable wire 行需要读取，只能
存在于 source adapter，且不得导出 JSX、状态文案或第二个 Timeline 入口，也不得进入生产 DOM。
频道若仍出现 synthetic `channel:<id>`，或者存在第二个 Timeline owner，阶段直接失败。
设计层还必须保证 `TimelineSnapshot` 只有一个 canonical 定义；durable 原始记录只能使用
`TimelineSourceSnapshot`，否则直接判定为 contract drift。

## 4.8 v3.9.1-final 实现启动板（从现在开始）

设计已经可以开工。下面是按“先事实、后投影、再视觉、最后真实客户端”排列的执行板；
每一项都有明确输入、代码边界和退出证据。除当前实现分支已有的 D0 WIP 外，不需要再
开第二套 transcript 或新建 SQLite 表。

### WP-0：收口 D0 基线（已完成）

**输入**：`origin/main=ebfadd1b`、v3.9.1-final 五份设计、已收口的 contract/result-anchor implementation。

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

基础案例为 `N-01/N-02/P-01/C-01/C-02/A-01/R-01/R-02/R-03/F-01/E-01`，本轮完整执行集
以 §6.3 为准，另含连续上下文、topic/branch、协议动作、全部 typed kind、长历史与完整小项目。
每个案例保存
`case.json + screen-01.png + screen-02.png + semantic-state.json + lineage.json +
logs.redacted.txt`。`case.json` 必须写 `simulation=false`、bundle/version/hash、真实
thread/turn/run/attempt、输入和 daemon epoch。

**退出证据**：macOS packaged app 中可以看到完整 Markdown、真实 command/file/tool、
nested Agent、batch disclosure、approval、retry、SSE reconnect、daemon restart、fan-in
和 EnvironmentPopover；四件套缺一只能标为调试证据。

### 4.8.1 开工时的提交形状

按以下顺序提交，每个 commit 可单独回滚，且只 stage 本阶段文件：

```text
docs: v3.9.1 Codex-parity component design（本次）
feat(transcript): fold tool evidence and terminal fence
feat(transcript): project atomic timeline and reversible batches
refactor(web): mount shared ConversationTimeline and Host viewers
refactor(web): cut over normal/private/channel/child surfaces
test(transcript): recovery, approval, fan-in and renderer parity
test(desktop): packaged macOS evidence cases
```

如果某一阶段需要改变 `kind`、lineage、Thread 映射、context 分配或 completion authority，
先修改五份权威设计和 fixture，再修改代码。不能在实现分支里保留“临时兼容”作为第六
种 renderer。

## 4.9 v3.9.1-final 组件级落地清单

本节把组件细设计翻译成可执行的文件和测试任务。实现者按阶段逐项勾选，不得把
所有逻辑塞回 `ConversationWorkCell.tsx` 或某个 surface 页面。

### 4.9.1 D0：先冻结输入，不切生产 UI

**代码边界**

- `packages/contracts/src/*conversation*`：wire kind、lineage、TerminalReport
  projection 的闭集契约；snake_case 只在 adapter 转换一次。
- `packages/conversation-ui-core/src/transcript-item.ts`、`timeline-snapshot.ts`、
  `canonical-transcript-projector.ts`：projection kind、snapshot 分层、owner/attempt
  选择和 blocked fallback。
- `packages/conversation-ui-core/test/*transcript*`：reply/execute、unknown kind、缺
  anchor/lineage、最高 generation、fingerprint fixture。

**退出证据**

```text
wire kind -> projection kind -> rendererKey
reply     -> agentMessage(reply_result)
execute   -> terminalReport(result.terminal)
unknown   -> diagnostic(fact.diagnostic, Blocked)
```

React 不接入 raw source snapshot；旧类型只在 migration adapter 中出现。

### 4.9.2 E1：证据折叠和刷新

**代码边界**

- `packages/core/src/storage/sqlite/run-event-store.ts`、
  `conversation-item-run-event-projection.ts`：读取 start/update/end，保留
  event sequence、bounded tail、artifact ref 和 redaction 标记。
- `packages/daemon/src/features/channels/workflow-operation-evidence.ts`、
  `terminal-report-evidence.ts`、执行 action/invalidation 路径：稳定 `actionId`、
  monotonic revision、terminal fence、重复/迟到事件审计。
- `packages/contracts/src/terminal-reports.ts`、`packages/core/src/terminal-report-*`：
  result anchor 与 publication/recovery 输入。

**必须先写的测试**

1. `start → update → end` 只产生一个 action row，DOM id 不变；
2. update 乱序、重复、equal revision 和 terminal 后迟到 update 都 fail-closed；
3. tail 受 40 行/8KiB/64 chunks 限制，完整内容只通过 artifact ref；
4. accepted update 触发按 `actionId + revision` 的 invalidation，旧 run key 不得成为
   唯一刷新条件；
5. reconnect/restart replay 后得到相同 `actionId/revision/terminalFence`。

### 4.9.3 E2：原子投影和可逆 batch

**代码边界**

- `packages/conversation-ui-core/src/canonical-transcript-projector.ts`：scope、order、
  owner、attempt、TerminalReport join 的唯一纯函数入口。
- `packages/conversation-ui-core/src/typed-transcript-batching.ts`、`command-batching.ts`、
  `activity-projection.ts`：相邻成功低风险 read/command 的 display-only grouping；输出
  `splitReason` 供测试和诊断使用，但不落库。
- `packages/conversation-ui-core/src/timeline-fingerprint.ts`：同 fixture 跨 surface 的
  kind/order/status/renderer/disclosure fingerprint。

**硬边界**

```text
same participant + run + attempt + workflow step + source scope
  -> may batch when safe and terminal
otherwise
  -> flush; keep atomic rows
```

approval、retry/resume/repair、failed/cancelled/active、consequential action、缺 lineage
均强制拆分。TerminalReport、fan-in、contextSegmentId 只读取 atomic items。

### 4.9.4 E3：一个 Timeline 和 Host viewer

**代码边界**

- `apps/web/src/shared/conversation/timeline/ConversationTimeline.tsx`：只接一个
  immutable snapshot，负责顺序组合、disclosure、focus 和 semantic selectors。
- `renderer-registry.tsx`：exhaustive registry；删除 unknown→generic message 的回退。
- `ConversationTimeline*Renderer.tsx`：document/fact/result/nested/batch/diagnostic 专用
  renderer；所有 action 标题从 typed payload 生成。
- `source-ref.ts` 与 Host capability adapter：issue/redeem 时校验 workspace、realpath、
  thread/run/action、daemon epoch 和 TTL。
- shared timeline CSS：document 无 bubble，fact 最小 28px，detail 最大 240px，唯一
  `ConversationFeedViewport` 纵向 scroll owner。

**特别处理**

旧 `renderFactActions` 注入点和 route-local action controls 已从当前实现删除。E3/E4
只允许 typed row action + callback；Composer/approval gate 保留唯一 allow/deny/stop/retry
控制。若后续发现缺少 action，必须补充 closed enum 和 Host callback，不能恢复任意
`ReactNode` 注入。

### 4.9.5 E4：surface cutover

**代码边界**

- `apps/web/src/domains/conversations/canonical-transcript-snapshot.ts`、
  `timeline-snapshot.ts`：统一 snapshot 组装。
- `NormalConversationFeed.tsx`、`TeammatePrivateChatFeed.tsx`、`ChannelMessageFeed.tsx`
  和 topic/branch adapters：只解析真实 `LingThread.id`、policy/chrome/callbacks，并
  调用一次 `mountConversationTimeline()`。
- `ChannelMessageRenderers.tsx`、`conversation-work-cell.ts`、
  `collaboration-task-work-cell.ts`、`WorkspaceClientView.tsx`：旧 activity caller 改为
  strict adapter 后删除，不在 production DOM 中保留 WorkCell、旧 workflow skeleton、
  activity summary 或 report card。

**退出证据**

```bash
rg -n "ConversationWorkCell|renderOperationTranscriptBlock|message_workflow_terminal|execution_summary" \
  apps/web/src/features apps/web/src/shared
```

结果只允许出现在 migration/test 文档或明确的 adapter；normal/private/channel/topic/
branch/child 使用同一 fixture 得到相同 fingerprint。

### 4.9.6 E5：恢复、审批、retry 和 fan-in

**代码边界**

- `packages/daemon/src/features/channels/terminal-report-coordinator.ts`、
  `terminal-report-publisher.ts`、`workflow-completion-gate.ts`：publication transaction、
  highest committed generation、supersession 和 blocked fallback。
- `workflow-fanin.ts`、`workflow-evidence.ts`、`workflow-participant-run-profile.ts`：按
  required participant 的 atomic evidence join，不按 batch/ready/plan 数量。
- `apps/web` reconnect/invalidation handlers：原地 revision、reconnecting hint、focus 和
  disclosure 保持。

**测试顺序**

```text
approval allow/deny/expired
  -> failed attempt -> retry success
  -> SSE disconnect/reconnect
  -> daemon restart replay
  -> partial fan-in waiting
  -> complete fan-in terminalReport
  -> ready-only child => structured blocked
```

### 4.9.7 E6：packaged macOS 真实验收

只验收 macOS packaged client；Windows、mock fixture 和浏览器截图不能代替本阶段。使用
`apps/desktop/tests/run-packaged-continuity-smoke.mjs` 扩展下列真实案例：

| Case | 必须看到 |
| --- | --- |
| `N-01` | paragraph/list/fenced code/path/link，换行与代码格式不丢 |
| `N-02` | read batch、live command update、file/diff viewer |
| `P-01` | private 与 normal 的 renderer fingerprint 相同 |
| `C-01` | 两个 participant、child narration、command/file/tool，同一 registry |
| `C-02` | ready-only child 或 depth=2 显示 structured Blocked |
| `A-01` | approval waiting、allow、deny/expired 只一个控制 owner |
| `R-01` | failed attempt → retry success，旧 attempt 进 audit |
| `R-02` | SSE reconnect 后同一 action/revision，不追加第二行 |
| `R-03` | daemon restart 后同一 fingerprint 和 disclosure |
| `F-01` | partial fan-in Waiting，证据齐全后单一 TerminalReport |
| `E-01` | EnvironmentPopover 只有 active action 两行，terminal 后关闭 |

每个 case 必须落盘 `case.json`、`screen-01.png`、`screen-02.png`、`semantic-state.json`、
`lineage.json`、`logs.redacted.txt`，并写 `simulation=false`、build hash、真实
thread/turn/run/attempt、daemon epoch。截图与语义/lineage/log 任一缺失都标为调试证据。

### 4.9.8 提交和回滚边界

按以下 commit 顺序推进，每个 commit 只触碰自身阶段文件：

```text
docs(transcript): lock v3.9.1-final component design
feat(transcript): fold host evidence and terminal fence
feat(transcript): project atomic timeline and reversible batches
refactor(web): mount shared timeline and host viewers
refactor(web): cut over normal private channel and child surfaces
test(transcript): recovery approval fan-in and parity matrix
test(desktop): capture packaged macOS evidence
```

任何需要改变 item kind、lineage、Thread 映射、contextSegmentId、completion owner 或
Host capability 边界的实现，必须先更新五份权威文档和 fixture；不允许在代码里加入
“临时兼容”作为第六条路径。

### 4.10 v3.9.1-final 开工细设计（实现者直接照此拆任务）

这一节把组件设计翻译成可执行的模块边界。它是本轮开工输入，不是新的架构层。

#### 4.10.1 一次 turn 的唯一数据流

```text
Host/SQLite/SSE
  -> TimelineSourceSnapshot (raw, scoped, coverage)
  -> EvidenceFold (action identity, revision, terminal fence)
  -> CanonicalTranscriptProjector (atomic items, owner, attempt, result join)
  -> DisplayBatchProjector (optional, reversible, display-only)
  -> mountConversationTimeline (one registry, one viewport)
```

每个箭头只能在一个模块发生一次。React 不能直接读取 source snapshot；surface 不能
重新排序或合并；batch 不能回写 SQLite；TerminalReport/fan-in 不能读取 display rows。

#### 4.10.2 模块与职责

| 模块 | 只负责 | 明确不负责 |
| --- | --- | --- |
| `packages/core` source readers | durable item/run/report/approval 读取 | 排序、UI 文案、batch |
| `packages/daemon` evidence fold | action identity、revision、terminal fence、invalidation | Markdown、CSS、完成摘要 |
| `conversation-ui-core` projector | scope/order/owner/attempt/context/result join | I/O、Host mutation、surface chrome |
| `conversation-ui-core` batch | 相邻安全终态 grouping、split reason | completion、fan-in、持久化 |
| `apps/web` shared timeline | renderer registry、disclosure、focus、a11y selector | raw source、排序、权限判定 |
| surface adapter | `LingThread`/scope/policy/chrome/callbacks | 自建 row、parser、status、scroll |
| Host viewer | capability issue/redeem、realpath/permission/epoch 校验 | 历史列表、summary、第二 action owner |
| packaged harness | 真实 macOS 案例与证据 tuple | mock 截图冒充验收 |

#### 4.10.3 关键实现伪代码

```ts
function projectSurface(source: TimelineSourceSnapshot): TimelineSnapshot {
  const folded = foldEvidence(source.runEvents);
  const atomic = projectCanonicalItems({ ...source, folded });
  const displayItems = projectDisplayBatches(atomic); // never used for completion
  return createTimelineSnapshot({
    scope: source.scope,
    activeRun: source.activeRun ?? null,
    items: displayItems,
    canonicalRevision: source.sourceRevision,
    sseCursor: source.cursor,
    contextSegmentIdByItemId: source.contextSegmentIdByItemId,
  });
}

function renderItem(item: ConversationTimelineItem, ctx: RendererContext): ReactNode {
  // Exhaustive switch. Unknown wire kinds are blocked before this function.
  return rendererRegistry[item.kind](item as never, ctx);
}
```

`createTimelineSnapshot` 只做不可变快照封装，不复制或重写 item。`fingerprint` 只包含
`kind/order/status/rendererKey/disclosureCount/lineage ids`，不包含文案、颜色或 shell 标题，
这样同一 fixture 可以在三个 surface 上做语义 parity 比较。

#### 4.10.4 开工闸门与停止条件

| 闸门 | 先写的失败测试 | 通过后才能做什么 |
| --- | --- | --- |
| G0 contract | closed union、unknown kind、scope mismatch | 建立 fixture 与 selector |
| G1 evidence | start/update/end、乱序、重复、迟到、equal conflict | 接入 live invalidation |
| G2 projection | owner/attempt/result join、缺 lineage blocked | 接入 batch |
| G3 display | 3 条安全 action、每类 split reason、展开可逆 | 接 shared Timeline |
| G4 surface | normal/private/channel/child fingerprint parity | 删除旧 WorkCell caller |
| G5 recovery | retry、approval、SSE、restart、fan-in | 打包 macOS |
| G6 packaged | `simulation=false` 四件套完整 | 宣布 Codex-parity 完成 |

任何闸门失败都必须停在该层修复。不得用 CSS 隐藏重复 row，不得用模型文本、plan
进度、batch 数量或 ready/done 文案填补缺失证据。

#### 4.10.5 真实 UI 的最小验收组合

最终 macOS packaged 验收至少展示一条连续时间线：

```text
Agent Markdown（段落 + list + fenced code + path）
  -> Read / Run / Edited（真实 Host facts，成功可折叠）
  -> child Agent narration + fact rows（depth=1 rail）
  -> Waiting for approval / Failed / Retry
  -> partial fan-in Waiting -> single TerminalReport result
```

同一案例还要在 SSE reconnect、daemon restart 后恢复为同一 action ids/revisions；
EnvironmentPopover 只在 action active 时出现两行，终态后关闭；Composer 只保留输入和
控制，不显示第二份 summary。没有这条连续证据链，截图只能算局部组件调试。

## 4.11 v3.9.1-final 当前实现接续单

设计已经锁定，下一步不是再开一个新的 v4 会话工程，而是在现有实现 worktree 继续收口。
当前 worktree 中的未提交 WIP 不自动视为完成，也不应被 reset；实施时只按下面顺序逐片
审查和提交。

### 4.11.1 先做的三件事

1. **E1 证据审计**：逐个核对 `tool_start/update/end` 的 `actionId`、revision、terminal
   fence、late/duplicate/equal-conflict 处理和按 action 的 invalidation；补 SSE reconnect、
   daemon restart 的同一 fingerprint 断言。
2. **E3/E4 真实挂载**：把 normal、teammate-private、channel root/topic/branch 和 child
   的 route adapter 收敛到一次 `mountConversationTimeline()`，删除生产 DOM 中的旧 WorkCell、
   workflow skeleton、局部 status copy 和第二个 summary owner；当前实现不保留
   `renderFactActions` 运行时兼容入口，所有控制都走 typed row action + 唯一 gate。
3. **E5/E6 验收闭环**：在真实 daemon/Host 上验证 capability issue/redeem、approval、
   retry、fan-in 和 TerminalReport；再用 packaged macOS 采集完整证据 tuple。Windows 不在
   本轮测试矩阵内。

### 4.11.2 实施者不得改变的合同

```text
模型文本 = narration
Host evidence = command/file/tool/approval/completion 的唯一事实
batch = reversible display projection，不能落库或参与完成
一个 actionId = 一个 owning row
一个 execute turn = 一个 terminalReport outcome
一个 surface = 一个 Feed viewport + 一个 ConversationTimeline
child = depth-1，同一 registry；depth-2 = structured blocked
```

任何实现需要增加 session/batch/summary 表、保留双写/旧 renderer、让模型文本证明完成、
让 batch count 参与 fan-in、让 surface 自己解析 Markdown/排序/滚动，或让 path 绕过 Host
capability 时，必须先停止编码并更新本设计和 fixture。开发阶段允许直接切换到新合同，
不接受“为了兼容旧客户端”而引入第六条路径。

### 4.11.3 每个 PR 的最小交付格式

```text
1. contract/fixture 变化（如有）
2. 实现代码（单一阶段边界）
3. 对应 unit/component/integration test
4. data-* semantic selector 断言
5. lineage/action/revision evidence
6. 未通过项和下一阶段阻塞原因
```

PR 只在对应阶段的测试和证据齐全后进入下一阶段；“截图看起来正确”不能替代事实来源、
恢复或完成闸门。

## 4.12 v3.9.1-final 开工执行板

从这里开始实现，不再从某个 surface 的 JSX 反推协议。每个阶段都以同一份 canonical
fixture、同一组 semantic selectors 和同一份 lineage 作为输入；阶段失败就停在该阶段，
不靠 CSS 隐藏或兼容 renderer 越过闸门。

| 阶段 | 先写的失败测试 | 实现目标 | 退出证据 |
| --- | --- | --- | --- |
| D0 | unknown kind、scope mismatch、缺 result anchor | 锁 closed union、lineage、`TimelineSourceSnapshot`/`TimelineSnapshot` 边界 | contracts/typecheck、fixture fingerprint |
| E1 | 乱序/重复/迟到 `tool_*`、equal revision conflict | `EvidenceFold`、terminal fence、同 action 原地 revision、live invalidation | fold replay + SQLite/SSE lineage |
| E2 | batch split、expand round-trip、retry/approval boundary | 纯 canonical projector + 可逆 command/exploration batch | atomic evidence 与 display rows 对照 |
| E3 | Markdown/code/path、bounded output、Host ref 过期 | shared Timeline、exhaustive registry、file/diff capability viewer | component/semantic selectors、单一 scroll owner |
| E4 | normal/private/channel/topic/branch 与 child parity | 每个 viewport 一次 shared mount，child 不额外 mount，删除旧 caller | 跨 surface fingerprint 完全一致 |
| E5 | approval、retry、SSE reconnect、daemon restart、partial fan-in | 原子恢复、latest generation、structured blocked | recovery/fan-in tests + lineage |
| E6 | packaged client 的真实连续 turn | 只验收 macOS packaged app，采集 UI/语义/事实证据 | `simulation=false` + screenshot/state/lineage/log 四件套 |

实现切片的固定顺序：

```text
contract/fixture -> evidence fold -> projector/batch -> shared Timeline/viewer
                -> surface cutover -> recovery/fan-in -> packaged macOS
```

任何变更若需要新增 item kind、改变 Thread 映射、改变 `contextSegmentId` 归属、让
Composer/Popover 再拥有历史事实，必须先回到五份设计文档和 fixture 更新；不得直接在
某个 surface 加局部例外。代码、测试、证据三件套齐全后，才把该阶段标为完成。

## 4.13 v3.9.1-final 实现启动包（本次设计更新）

这一节是开工时的执行顺序和文件级边界。它不引入新阶段，也不把旧 WIP 当作已经验收；
当前代码仍在实现 worktree 中，主 checkout 的 dirty WIP 不参与本计划。

### 4.13.1 六个工作包

| 工作包 | 主要模块 | 先写的失败测试 | 完成证据 |
| --- | --- | --- | --- |
| D0 contract lock | `packages/contracts`、`conversation-ui-core` fixtures | unknown kind、缺 lineage、scope mismatch、missing result anchor | closed union、三层 kind 映射、fingerprint fixture |
| E1 evidence fold | `packages/daemon/src/features/runs`、invalidation | 乱序/重复/低 revision/equal conflict/terminal fence late event | 同 `actionId` 原地 revision，audit 不重开 |
| E2 projector + batch | `packages/conversation-ui-core`、core projection | owner/attempt/retry、split boundary、expand round-trip | atomic rows 与 display rows 对照，batch 不参与完成 |
| E3 shared Timeline | `apps/web/src/shared/conversation/timeline`、Host viewer | Markdown/code/path、bounded output、capability 失效 | exhaustive registry、专用 viewer、单 scroll owner |
| E4 surface cutover | normal/private/channel/topic/branch adapters + child scope | 同 fixture parity、duplicate owner、synthetic thread id | 每 viewport 一次 mount，child 使用根窗口，旧 caller 删除 |
| E5 recovery/fan-in | daemon TerminalReport、approval、retry、SSE/restart | partial fan-in、ready-only child、latest generation、deny/expired | atomic evidence settle，单一 result row |
| E6 packaged macOS | `apps/desktop`、真实 daemon/Host | 连续 turn、live update、approval、retry、重连/重启 | `simulation=false` screenshot/semantic/lineage/log tuple |

### 4.13.2 开工时的逐文件边界

```text
source snapshot     = 读 durable/API/SSE + coverage，不做展示判断
core projector      = scope/owner/attempt/revision/order，不做 I/O
batch projection    = 只压缩相邻安全终态，不落库、不 completion
timeline renderer   = closed union -> Document/Fact/Result/Nested，不读 raw source
surface adapter     = real LingThread + policy/chrome/callbacks，不自建 renderer
composer/popover    = control/ambient hint，不复制历史事实
host viewer         = capability issue/redeem + scope/epoch/TTL/realpath 校验
```

### 4.13.3 依赖和可并行性

```text
D0
 ├─ E1 evidence fold
 └─ E2 projector/batch（纯函数部分可与 E1 的纯测试并行）
       └─ E3 shared Timeline/viewer
             └─ E4 surface cutover
                   └─ E5 recovery/fan-in
                         └─ E6 packaged macOS
```

只允许 E1 的 daemon 测试和 E2 的纯 projector 测试在独立 worktree 并行；E3 以后共享
renderer、fixture 和 surface adapter，必须串行合并，避免两个工作树同时改同一 owner。任何
工作包都不应把旧 WorkCell、第二个 summary 或 compatibility flag 带回生产路径。

### 4.13.4 每个 PR 的最小交付格式

```text
contract/fixture -> implementation -> unit/component/integration test
                 -> semantic selector -> lineage/action evidence
                 -> 未通过项和下一阶段阻塞原因
```

PR 的完成条件不是“截图像 Codex”，而是同一 fixture 在 normal/private/channel/topic/branch/
child 中的 `kind/order/status/rendererKey/disclosure/scrollOwner` 一致，且真实 Host evidence
能通过 recovery/fan-in/TerminalReport 闸门。开发阶段允许直接切换新合同，不保留旧渲染兼容层。

## 4.14 Surface-level cutover work package（本次补充）

当前 shared Timeline 已可渲染 typed item，但不能把“每个 row 都调用了 shared renderer”当成
统一完成。E4 的实现目标是一个真实 `LingThread` 对应一个 Timeline composition；normal、
private、channel/topic/branch 不再在各自的 MessageRow/activity caller 中重新拼接历史。

### 4.14.1 先改 contract，再改 caller

实现顺序固定为：

```text
Timeline item presentation metadata
  -> typed interaction callbacks
  -> fixture-only mountConversationSurface()
  -> normal/private/channel surface adapter
  -> 删除 route-local MessageRow/WorkCell/activity caller
```

第一步只扩充 projection contract，不切 production UI：

- message item 携带 `presentationRole`、actor、created/edited metadata 和 typed resources；
- attachment、web evidence、memory citation 通过 message resource/disclosure 表达，不在
  Timeline 外创建第二张历史证据卡；
- copy/edit/feedback/reply/create-task 通过 `ConversationTimelineInteraction` 提供状态和
  callback，禁止传任意 `ReactNode`；
- protocol item 暴露受 Host 验证的 `availableActions` enum，renderer 通过 typed callback
  执行，不能由 route 重新绘制 action card；
- protocol status 按 approval/decision/handoff/workflow/step/task/run/state-transition 分别
  穷尽映射；decision `active` 不伪装 running，cancelled/skipped/pending approval 保留正确
  语义；
- `supersede_decision` 走 `BEGIN IMMEDIATE + source-active CAS + single-successor unique
  index`，首次 `201`、等价复用 `200`、不同 payload 或 stale source `409`；
- owning row 在 mutation pending 时提供同步 in-flight guard、disabled 与 `aria-busy`，但
  正确性仍由 Store 事务和索引保证；
- approval row 只呈现状态和 disclosure，decision dialog 是唯一 allow/deny 控制 owner；
- `mountConversationTimeline` 的目标入参是 `ResolvedConversationSurface`，内部负责一次
  display projection 和 registry composition；surface 不再传第二份 message/action/report
  数组。

### 4.14.2 真实 surface cutover

| 顺序 | 模块 | 必须删除的旧路径 | 通过条件 |
| --- | --- | --- | --- |
| 1 | normal conversation | `NormalConversationMessageRow` 内 per-message Timeline | 一个 feed viewport 只 mount 一次，历史 message/fact/result 由同一 snapshot 排序 |
| 2 | teammate private | `TeammatePrivateChatFeed` 内 per-message Timeline；`private:<teammateId>` fallback | 真实 `LingThread.id`，缺 scope 只有一个 blocked diagnostic |
| 3 | channel root/topic/branch | `ChannelMessageRenderers` 的 turn/message/protocol/workflow/run 多处 mount | 一个 channel surface 一个 snapshot/Timeline；topic/branch 不复制 parent |
| 4 | child Agent | child-specific renderer 或独立 feed | depth=1 复用 registry，child 不拥有 virtualizer/scroll/history loader |
| 5 | shell controls | `renderFactActions`、外部重复 summary/output | typed row control 或唯一 dialog；Composer/Popover/Right Dock 不复制事实 |

#### E4a/E4b 切片记录与本轮统一窗口化

已落地的两个切片只改变 surface composition，不改变事实来源：

- normal：整个 feed 先构造一个 `TimelineSnapshot`，通过 `renderMessageChrome` 把既有作者、
  时间、编辑、附件、反馈和重试 chrome 包回 message item；`NormalConversationMessageRow`
  不再拥有 per-message Timeline fallback。
- private：整个私聊 feed 先按真实 `LingThread.id` 构造一个 snapshot，所有 direct message
  和其 facts 在同一时间线排序。曾经只测量一个 Timeline root 的外层 virtualizer 是已过时
  的过渡实现；现与 normal/channel 一起使用 `ConversationTimelineFeed` 纯 shell。消息 chrome
  由 surface adapter 提供。没有 verified thread 时只显示一个
  `diagnostic(scope_mismatch)`，不会生成 `private:<teammateId>` transcript id。

private adapter 的排序退出条件还包括“每条消息 slice 只 rebasing 一次”：slice 内的
`threadSequence` 从零开始，surface 统一加 `baseSequence`；必须有回归断言防止 message 被
重复偏移而落到其 facts 后面。这个是显示投影约束，不改变 SQLite 的 canonical sequence。

本轮继续收口 channel 的 surface contract：`ChannelMessageRenderers` 只导出
`renderUnifiedTimeline`，`WorkspaceClientView` 不再把 `renderMessageFeedItem` 传入 channel
feed；`ConversationTimelineFeed` 直接容纳一次 mounted Timeline，只有该 Timeline 对 display
rows 调用 `useVirtualizer`。已删除 `ConversationVirtualFeed`，`renderVirtualRow` 和
`virtualRowIdentity` 不再是生产或 fixture 合同。旧的 channel per-item
protocol/activity/workflow/run fact renderer 已删除，message chrome adapter 仍只负责作者、
附件和 typed callbacks，且不改变 durable facts；topic reply panel 也已通过真实
`resolvedThreadId` 构造一个 `topic_reply` snapshot，不能再直接 map `MessageRow`。此前
source-contract/typecheck/Web `137/137` 是历史切片报告；当前 combined WIP 必须重验，
不能把这些数量升级为本轮 E4 或 packaged 完成证明。

三种 feed 的 `timelineId` 只标识 shell 内容；实际滚动锚点使用根 display row 的稳定
`rowKey + offsetTop`。`older-loader`、首条消息或整个 Timeline root 均不能代替可见行。
display model 将 child 展开为 `header + child rows`，由根窗口统一测量。pending message
slice 的 `threadSequence` 与 private 一样仅 rebasing 一次，必须覆盖 `feedIndex > 0`。

本轮 E4 的 source/行为门槛集中在 §6.2；channel root/topic/branch/child 的真实视觉、
交互、SSE reconnect 和 daemon restart 必须继续在 §6.3 的 E6 packaged macOS 中验收。

### 4.14.3 机械验收断言

对同一 fixture，在 normal/private/channel/topic/branch/child 分别收集：

```text
item id + kind + order + status + rendererKey + disclosureCount
+ action owner count + result owner count + timeline owner count + scroll owner count
```

必须满足：

- `mount calls per surface viewport = 1`；
- `timeline owner count = 1`，child 只算 parent Timeline 的 nested rail；
- `scroll owner count = 1`、`surface shell virtualizer count = 0`；
- 长历史 `root virtualizer count = 1`，`nested Timeline/virtualizer count = 0`；
- `synthetic transcript thread ids = 0`；
- `route-local ordering/merge/renderFactActions = 0`；
- message/resource/fact/result 的 fingerprint 只因 shell title、roster、policy hint 和
  participant rail 改变；
- virtualizer 只裁剪 visible window，不改变顺序、batch、TerminalReport generation 或
  stable identity。

长历史与子 Agent 采用同一个 root-window contract：normal、private、channel 都把唯一
feed ref 传给 shared Timeline；展开的 `subAgentActivity.childItems` 先被纯 display-model
投影为 `header + child rows`，再进入根 virtualizer。禁止 child mount 第二个 Timeline 或
virtualizer。虚拟化启用判据使用 potential row count，避免 collapsed/expanded 切换 DOM
模式。500-child 用例的 CI 硬门槛为 mounted child rows `<=48`、一个 root virtualizer、零
nested scroll owner，并能定位首尾 child；展开 p95 `<100ms` 记录为本机性能证据。

### 4.14.4 E4 测试文件和断言

以下为本轮已确认存在的测试入口；所列断言是验收要求，不代表目前每个入口已经覆盖
整行。执行时按具体测试名确认覆盖，缺口在同一模块补齐；不为追随旧计划另建重复文件：

| 测试 | 类型 | 核心断言 |
| --- | --- | --- |
| `packages/conversation-ui-core/test/canonical-transcript-projector.test.mjs`、`surface-policy.test.mjs` | unit | 同 fixture 五种 surface 的 kind/order/status/renderer fingerprint 相同；policy 差异不改事实 |
| `apps/web/test/channel-timeline-renderer-contract.test.mjs`、`conversation-timeline-semantic-contract.test.mjs` | source contract | 每 surface 一次 mount；唯一 shared shell/root window；无 synthetic thread 或第二 fact-action JSX slot |
| `packages/conversation-ui-core/test/message-body.test.mjs`、`message-presentation.test.mjs` 和 Web 内容 E2E | unit + E2E | paragraph/list/code/path/resource、copy/edit/feedback callback 不破坏 item identity |
| `apps/web/test/channel-protocol-timeline-status.test.mjs` 与 `apps/web/e2e/channel.spec.ts` protocol actions | unit + E2E | kind-specific status；enum + callback 仅 owning row 调用；真实 mutation 与 pending guard，无外部重复卡 |
| `apps/web/test/conversation-timeline-display-model.test.mjs` | unit | collapsed/expanded flat rows、parent-isolated key、depth=2 diagnostic、collapsed child location |
| `apps/web/e2e/app.spec.ts`、`teammates.spec.ts`、`channel.spec.ts`、`ui2-conversation-work-cell-activity.spec.ts` | E2E | normal/private/channel/topic/branch/child 的 DOM、窗口化、anchor、disclosure 和单一 feed scroll owner |

失败路径必须单独断言：缺真实 Thread、缺 message lineage、过期 capability、未知 kind、
late event、depth=2、partial fan-in 和 execute 后 duplicate summary 均显示结构化 blocked/
waiting，而不是静默移除或回退到 agentMessage。

### 4.14.5 与现有 WIP 的关系

当前实现 worktree 的 evidence fold、TerminalReport、atomic projector、batch 和 shared
renderer 改动继续作为输入；本节不要求重写这些模块，也不改变 SQLite 拓扑。已有
surface-level mount、真实 Thread scope 和 protocol actions 与本轮统一 scroll shell、
child parent-flatten、pending sequence、effective-attempt 折叠一起接受 §6.2 的 combined
验证，再执行 §6.3 的 packaged macOS 真实验收。历史测试和截图不替代当前证据。

## 4.15 Codex-parity 实现启动计划（本次设计锁定）

下面是从设计到代码的最短闭环。每一步都先写失败测试，再写实现；不允许先改 CSS 或在
某个 surface 里临时接一套 renderer。人力和 Codex 时间是估算值，实际以当前测试基线为准。

| 阶段 | 代码动作 | 主要模块 | 必须先通过的测试 | 预计投入 |
| --- | --- | --- | --- | --- |
| D0 | 冻结 closed union、content part、lineage、surface fingerprint 和 fixtures | `packages/contracts`, `packages/conversation-ui-core` | contract/typecheck、reply/execute、unknown-kind blocked | 人：0.5 天 / Codex：20 分钟 |
| E1 | 折叠 `tool_start/update/end`，同一 action 原地更新并触发 invalidation | `packages/daemon/src/features/runs` | duplicate/late/equal-revision/terminal-fence | 人：1 天 / Codex：30 分钟 |
| E2 | 生成 atomic snapshot 和可逆 command/exploration batch | `packages/conversation-ui-core` | split reason、expand identity、completion 隔离 | 人：1 天 / Codex：30 分钟 |
| E3 | 完成 `mountConversationTimeline`、三种 primitive、Host source viewer | `apps/web/src/shared/conversation/timeline` | exhaustive registry、Markdown/code/path、a11y、single scroll owner | 人：1.5 天 / Codex：45 分钟 |
| E4 | normal/private/channel/topic/branch 每 viewport 一次 surface-level mount；child 进入根 display rows | `apps/web/src/features/*` | 同 fixture fingerprint、无旧 caller/synthetic thread | 人：1.5 天 / Codex：45 分钟 |
| E5 | 接 approval/retry/SSE reconnect/daemon restart/fan-in/TerminalReport | `packages/daemon`, `packages/core` | latest generation、required evidence、structured blocked | 人：2 天 / Codex：1 小时 |
| E6 | 启动 packaged macOS，执行真实 N/P/C/A/R/F/E 案例并保存证据 tuple | `apps/desktop`, `docs/design/ui2.0升级/evidence` | `simulation=false`、截图+semantic+lineage+脱敏日志 | 人：1 天 / Codex：30 分钟 |

### 4.15.1 第一轮实现的文件边界

第一轮只允许触碰下面的目录；如果发现必须修改 provider session、SQLite 拓扑或业务
审批策略，先停在 D0 更新设计：

```text
contracts       -> item union / source refs / terminal result anchor
daemon          -> evidence fold / revision / snapshot / invalidation
ui-core         -> pure projector / display batch / fingerprint
shared/timeline -> DocumentBlock / FactRow / ResultRow / nested rail
surface adapters-> scope + policy + Host callback（不拥有历史）
desktop         -> packaged shell + real evidence collector
```

### 4.15.2 开工任务拆分

- [ ] `T0` 建立同一份 parity fixture：normal、private、channel、topic、branch、child 各自
  只改变 scope/chrome，并记录三层 kind 名称和 lineage。
- [ ] `T1` 为每个 action 建立 `actionId/runId/attemptId/participantId/workflowStepId` 的
  稳定 selector；`tool_update` 只更新 revision，不追加 row。
- [ ] `T2` 实现 `projectDisplayBatches()`/`expandDisplayBatch()`，所有跨边界条件输出
  `BatchSplitReason`，且 completion/fan-in 永远读取 `atomicItems`。
- [ ] `T3` 让 `ConversationTimeline` 只接受 immutable snapshot；实现 Markdown AST、事实行、
  结果行和 depth-1 nested renderer，删除 generic message fallback。
- [ ] `T4` 把 normal/private/channel/topic/branch 的 caller 收口到每 viewport 一次
  `mountConversationTimeline()`，并为每个 surface 加 `timelineOwnerCount=1` 断言。
- [ ] `T5` 接通 Host capability 二次校验和 typed interaction；EnvironmentPopover 只显示
  active action 的两行，不复制历史。
- [ ] `T6` 完成 recovery/fan-in/TerminalReport 的 atomic 回归，再做 packaged macOS 实测；
  没有 `simulation=false` 的完整证据不得勾选完成。

### 4.15.3 开工停止条件

遇到以下任意情况立即停工并回到设计文档，不得靠兼容层继续：

1. 一个 viewport 出现两个 Timeline 或两个纵向 scroll owner；
2. 子 Agent 需要新建 session、Thread、virtualizer 或专用 renderer；
3. 只能从模型文本、plan 进度或 batch 数量推断事实/完成；
4. `terminalReport` 需要在 Timeline 外再追加 summary；
5. 旧 WorkCell、`renderItem`、`renderFactActions` 或 synthetic thread 仍是生产入口。

## 5. 回归矩阵

| 领域 | 必测场景 | 证据 |
| --- | --- | --- |
| 内容 | paragraph/list/fence/inline code/path/link、用户头像右/Agent 头像左、正文内部左对齐 | screenshot + semantic + component |
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
/private/tmp/ling-transcript-v3-acceptance-<timestamp>/<case-id>/
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

本轮使用新的独立证据目录；此前 conversation evidence 目录属于受保护的既有 WIP，
不读取、不覆盖、不把其历史截图当作本轮测试。最终给用户可直接打开的案例索引、App
名称和会话名称；目录的持久留存位置在交付 manifest 中注明。

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

### 6.2 当前 combined WIP 的 E1–E5 验收台账（2026-09-05）

本节是当前验收的唯一汇总入口。上文 `[covered]`、`137/137`、`93/93` 等只记录历史
切片，不能证明下列 combined 版本完成。此次文档审查已核对 production source 和现存
测试文件，但没有重跑测试；以下各项均需执行者关联本轮命令输出、测试名和代码指纹，
才可改为通过。不存在同名文件的旧计划测试名不是覆盖证据，应映射到现存用例或补缺。

| Gate | 本轮必须验证的行为 | 当前代码/现存测试入口 | 本轮验收状态 |
| --- | --- | --- | --- |
| `G-00` 基线 | fetch 后记录 remote main、实现 HEAD、dirty diff 指纹；证明 remote main ancestry 或列明冲突；package 与被测源码同一构建 | Git ancestry、build manifest、package manifest | 待关联本轮证据 |
| `G-01` E1 evidence | start/update/end 一个 actionId；accepted update 增 revision 并 invalidation；重复/乱序/equal-conflict/迟到事件不越 terminal fence；bounded/redacted tail | daemon `execution-action-command-evidence.test.mjs`、Core/Daemon evidence 相关测试 | 待 combined 复验 |
| `G-02` E1 publication | 专用 result Item、report、supersession、invalidation 原子提交/回滚；migration round-trip；不再 assistant-message 双写 | Core `terminal-report-migration/store/idempotency.test.mjs`；Daemon `terminal-report-publication/recovery.test.mjs` | 待 combined 复验 |
| `G-03` E2 projection | scope/anchor/owner/attempt/revision/context 校验；latest committed generation 严格 join；reply/execute 分流、重复 summary 抑制；所有 batch hard boundaries 与 exact child ids | UI-core projector/batching 与 `terminal-report-transcript.test.mjs` | 待 combined 复验 |
| `G-04` E2/E4 顺序 | private 与 pending channel slice 从 local sequence 开始且只加一次 base；`feedIndex > 0` 时 narration/plan/fact 顺序正确 | Web `channel-timeline-renderer-contract.test.mjs`、normal/private projection 测试 | 待 combined 复验 |
| `G-05` E3 render/Host | exhaustive kinds、paragraph/list/code/path、status copy、唯一 result/action owner；模型路径 copy-only；Host capability 的 scope/TTL/epoch/symlink 二次校验与 viewer | Web semantic/render/source-ref 测试；Web/Daemon `workspace-file-capability.test.mjs`；file/diff E2E | 待 combined 复验 |
| `G-06` E4 单一 UI | normal/private/channel 生产调用共享 `ConversationTimelineFeed`；shell 无 `useVirtualizer`；每 viewport 一个 Timeline 与 scroll owner，root-only window；无旧 VirtualFeed/WorkCell caller | 三份 Feed 源码；Web surface contracts；`app.spec.ts`、`teammates.spec.ts`、`channel.spec.ts` | 待 combined 复验 |
| `G-07` E4 parent-flatten | encoded parent-scoped row keys 不随 revision 变；manual disclosure 跨 SSE/虚拟卸载保留；collapsed child locator 先展开再定位；depth=2 diagnostic；retain key 清理有界 | `conversation-timeline-display-model.test.mjs`、`conversation-timeline-sub-agent-disclosure.test.mjs`、`conversation-timeline-view-retain-keys.test.mjs` | 待 combined 复验 |
| `G-08` E4 长历史/性能 | normal 120/private 106/channel 121 行首尾可达、older-load、latest、键盘/鼠标保持正常；动态高度 anchor 漂移 ≤4px；500-child 根 virtualizer=1、nested=0、mounted child≤48、首尾可达、SSE 后 disclosure 保留 | `app.spec.ts`、`teammates.spec.ts`、`channel.spec.ts`、`ui2-conversation-work-cell-activity.spec.ts`；本机 20 次展开 p95 和 10/1,000/10,000 atomic 基准 | 待 combined 复验；性能数字必须实测 |
| `G-09` E3/E5 protocol | 五个 typed mutations 仅 owning row 可调用；disabled/in-flight/aria-busy；kind-specific status；supersede 201/等价200/stale409，reject CAS，非法 status400；Inspector 无重复入口 | `channel-protocol-timeline-status.test.mjs`、Core decision/handoff idempotency tests、API client、Daemon channel tests、`channel.spec.ts` protocol actions | 待 combined 复验 |
| `G-10` E5 completion | 同一 logical step/Turn 先选有效 attempt，再跨 required steps severity fold；repair succeeded 可替代其 failed primary，无关 success/validation 不能覆盖其他失败；partial fan-in 不成功，ready-only 明确 blocked | Daemon `terminal-report-evidence.test.mjs`、channel workflow/fan-in integration、UI-core TerminalReport tests | 待 combined 复验 |
| `G-11` E5 recovery | running 时 SSE 中断/重连和 daemon restart；durable action/revision/fence/generation 收敛；deny/cancel 停止旧 runner；late end audit-only；restart 后旧 capability 无效 | Core `continuity-recovery.test.mjs`、Daemon TerminalReport recovery/channel tests、Web reconnect E2E | 待 combined 复验；真实进程/GUI 另需 E6 |
| `G-12` 合并质量 | 相关 Core/Daemon/API/UI-core/UI-react/Web tests、typecheck/build；Desktop Node/renderer/a11y；docs/public/licenses/dependency-security/i18n；diff whitespace | 各 package 实际 scripts 与 root `check:*`；必要时为受保护路径显式限定检查范围并记录限制 | 待关联本轮全部 required gates |

`G-10` 的 severity 聚合不能退化为“任何历史失败永远压过成功”：必须证明 supersession
lineage；也不能退化为“最新 completed 覆盖整个 participant”。同一 participant 的两个
独立 required step 中，一个 failed/blocked、另一个 completed 时，结论仍不能 succeeded。

### 6.3 E6 packaged macOS 完整案例清单

以下全部为待验收；用例表给出证明要求，不代表已经执行。可在同一真实会话中覆盖多项，
但每个 case id 都要指向相应截图时间点、语义状态和 SQLite lineage。运行模型使用本轮
用户指定的 OpenAI-compatible relay；manifest 只记录 provider/base URL、model 和
`apiKeyRef=env:OPENAI_API_KEY`，不记录密钥。不得写入源码、SQLite、配置 JSON、日志或截图。

| Case | 真实客户端操作 | 必须保留的断言/证据 |
| --- | --- | --- |
| `N-01` 内容 | 普通会话要求多个段落、标题/列表、inline/fenced code、链接及模型提及路径 | 用户轨道靠右、Agent 轨道靠左，正文内部左对齐；无头像时不占空列；换行/缩进/语言/copy 正常；basename+icon+完整路径 tooltip；模型路径不自动获导航权限 |
| `N-02` 真实任务 | 连续 read×3、command start/update/end、创建/修改文件并打开 diff | command 原 row 更新；真实命令/cwd/exit/output 可读；文件/差异/输出可追溯；成功折叠、活动详情与状态正确 |
| `N-03` 连续上下文 | 同一普通会话连续追问，给出项目关键事实/约束，跨超过 8 条消息继续完成相关任务并重开历史 | 关键事实正确使用且可追溯到历史/context source；任务产物与约束一致；明确选择性上下文边界，不能以一句“记得”证明记忆 |
| `P-01` 私聊一致 | 在私聊真实执行与 `N-01/N-02` 等价的内容、命令和文件任务 | 同 kind 的 renderer/status/disclosure/geometry 一致；差异只为 participant chrome；真实 LingThread，无私聊专属卡 |
| `C-01` 多 Agent | 频道至少两个 required participants 各有 narration、read、command/file/tool；展开每个 child | 每个动作有描述、icon、状态、命令/文件/输出；child 为根窗口 depth-1 rows，共享 registry；真实 participant/run/attempt lineage |
| `C-02` 子 Agent 异常 | 实际 delegated attempt 无可执行证据/返回 structured blocked；验证 depth limit 的真实可触发路径 | 无 evidence 不 succeeded；说明缺失与下一步；depth=2 仅一个 diagnostic。若 depth=2 只能通过 fixture 注入，该子项标 simulation/未完成，不能冒充真实 Agent 行为 |
| `C-03` 频道 scope | 从频道 root 新建 topic/reply 与 branch，分别继续任务、返回 parent | 真实各自 LingThread/anchor；不复制 parent transcript；相同 UI/状态/文件能力，root/topic/branch 都只有一个 viewport/Timeline |
| `C-04` 协议操作 | 在真实记录上 advance/cancel workflow、retry step、supersede/reject decision | 操作只在 owning row；pending disabled/aria-busy；无 Inspector 重复入口；状态与 API/SQLite 最终记录一致，不能把 active decision 当 working |
| `B-01` batch | 观察邻近安全 reads/commands 合并；再插入 narration、失败/审批、retry、不同 Agent/run/step 或 consequential action | 仅允许的邻近动作合并；exact child ids/sourceRefs 可还原；失败/审批/后果动作不被隐藏；contextSegmentId 与 fan-in 不受 batch 影响 |
| `T-01` typed 内容 | 实际触发 plan、允许展示的 reasoning、MCP/dynamic/collab 工具、image view 和 compaction；逐项记录可用工具/触发条件 | 每种 kind 命中共享 renderer；工具结果与模型叙述分层；compaction 可回链保留历史。未配置/未触发的 kind 留待验，不能以静态消息或 fixture 代替 |
| `A-01` 审批 | 在实际 gated action 上分别 pending→allow、deny、expired/cancel | 唯一 Composer/dialog 决策 owner；Timeline 等待状态可定位；deny/cancel/expiry 后旧 runner 不再执行新动作或追加成功结果 |
| `R-01` retry | 实际失败 attempt 后修复并 retry 成功；保留旧失败历史 | 主结果使用 latest effective attempt；旧 attempt 可审计；无关 validation/success 不消除另一个 required-step failure；最终只有一个有效 result |
| `R-02` SSE | 长命令仍 running 时断开传输，再重连 | 断开前/中/后截图与 cursor；同一 action row/lineage，revision 单调、terminal fence 不回退；disclosure/focus/scroll anchor 保持；不追加“恢复成功”结果卡 |
| `R-03` daemon | 长命令仍 running 时重启真实 QA daemon，重新连接 | 记录旧/新 PID 与 epoch；SQLite facts/result generation 正确恢复；已丢进程不能伪装仍执行或成功；旧 capability 拒绝、新 capability 按权重签；disclosure/anchor 恢复 |
| `F-01` fan-in | 两个 required participants 不同时间完成，至少观察一次 partial；再完成或显式 blocked | partial 明确 Waiting 和缺谁；required effective evidence 到齐才 settle；TerminalReport、专用 result Item、generation/fingerprint/sourceRefs 严格 join；batch/ready 文本不能完成任务 |
| `V-01` Host viewer | 真实点击文件、diff、artifact，测试合法资源与过期/跨 workspace/重启后的旧引用 | tooltip 完整路径；Host 二次 scope/realpath/permission/TTL/epoch 校验；合法资源跳转；拒绝清楚可理解，无敏感输出 |
| `H-01` 长历史 | 三种会话滚动首/尾、向上加载、回到底部、滚动中 streaming、动态内容展开、定位折叠 child | 每个 surface viewport=1、shell virtualizer=0、长历史 root virtualizer=1、nested Timeline=0；离底部>24px 不抢位置；anchor 漂移≤4px；键盘/focus/选择保持 |
| `H-02` 密集 child | packaged 窗口内检查大量 child rows 的展开/折叠、首尾定位和 SSE 刷新 | 500-child 的 root=1/nested=0/mounted≤48 与 p95 数据属于明确的规模验收。若 500 项来自 synthetic fixture，标 simulation=true 作为性能补充；真实多 Agent 交互仍由 C-01/F-01 独立证明 |
| `E-01` 环境/窄窗 | active action 下长 cwd、窄窗口、light/dark、reduced motion；用键盘开关 EnvironmentPopover | 最多两行 active ambient；terminal 后关闭；不复制 summary/输出；无水平溢出或第二纵向滚动，Escape 回到触发点，状态不只靠颜色 |
| `J-01` 完整小项目 | 在独立 QA 项目中从要求→规划→创建代码→运行测试→失败修复→多 Agent 验证→最终交付连续完成，再追问修改 | 保留真实项目文件、命令 exit/测试结果、参与者证据及单一 TerminalReport；用户可以重开客户端逐轮检查全过程，不只看到预置完成截图 |

每个案例都检查 Composer 下方、EnvironmentPopover、Inspector 不重复正文、事实或总结。
截图至少含执行中和终态/展开态；reconnect/restart/approval/partial fan-in 还要保留中间
状态。`semantic-state.json` 应带 kind/id/status/revision/rendererKey/depth/disclosure 和
viewport/root/nested owner 计数；`lineage.json` 带 thread/turn/action/run/attempt/participant/
workflowStep/sourceRefs、report/resultItem/generation，非适用字段明确 `null`。

验收记录区分 `pass`、`fail`、`not_run`、`simulation`，不以总体 green 隐藏单项未执行。
测试输入、packaged bundle 路径、version/build hash、daemon epoch/PID、relay model、日志
时间范围与截图必须对应同一轮。不能复用旧构建、手工拼图、API-only 截图或直接改 SQLite
制造成功；敏感字段扫描通过后再交付截图和日志。

未决设计判定：无。单一 UI/viewport/root window、child depth 与 completion authority
已经确定；尚未完成的是上表的执行证据和可能暴露的实现缺口。若真实工具/模型无法触发
某项，保留该项 `not_run` 并说明缺少的运行能力，整体 E6 不提前标记完成。

### 6.4 本机查询能力增量（2026-09-06，未实现/未验收）

来自任务「定位并确认问题修复状态」的本机 IP 查询盲区纳入当前计划，细节见
[能力整合方案](channel-execution-capability-integration-plan.md)。这是执行入口的缺口，
不是换 UI renderer 就能修复的问题，也不是重新实施 Continuity v2。

本增量沿用 `D0 → E1 → E2 → E3/E4 → E5 → E6`，不另起一套阶段编号：先锁定能力
contract/权限/失败 fixture，再迁移 shell 安全模块、接 Host executor，最后走现有原子
evidence、统一 Timeline 和 TerminalReport。旧 matcher 的自然语言发现职责最终删除，
安全校验迁出且保护测试通过后才删除原文件；不保留二线 fallback。

| 新增 case | 验收范围 | 当前状态 |
| --- | --- | --- |
| `K-01` 语义入口 | 查询本机 IP/网卡实际调用 Host 能力；询问 IP 概念或“先不要执行”只回复 | not_run |
| `K-02` Host 结果 | IPv4/IPv6、多网卡、loopback、空结果、异常；无 shell/公网/MAC；有采集时间与截断说明 | not_run |
| `K-03` 权限与输入 | 未授权、跨 participant/scope、未知能力、非法字段、缺命令、runner 不支持，均给精确原因 | not_run |
| `K-04` shell 保护 | exact-command、executable policy、引号/转义、危险 shell 结构与审批/evidence 一致；生产旧 matcher import 为零 | not_run |
| `K-05` 事实与恢复 | action identity、revision、retry/迟到事件、SSE/restart、结果不重新采集冒充旧事实；required fan-in | not_run |
| `K-06` surface parity | normal/private/channel/child 同一 tool renderer；私聊无额外 Agent；结果不出现在 Composer 或环境浮窗 | not_run |
| `K-07` packaged macOS | 新包真实自然语言查询，执行前后截图、API/SQLite lineage、模型/Host 证据和权限失败案例 | not_run |

上述用例是 §6.2 `G-00–G-12`、§6.3 `N/P/C/B/T/A/R/F/V/H/E/J` **之外的增量**，
不能覆盖、删减或把原表未完成项改成 pass。新能力的源代码、fixture 和新包须分别验收；
本轮仅定位与设计整合，不以 matcher probe 或复制按钮 QA 冒充能力端到端通过。

### 6.5 结构化提问与双平台沙盒增量（2026-09-07）

来自「查找 Codex 问题说明」的结构化提问设计与「确认 Ling 沙盒与 Codex 处理方式」的
原生沙盒 T0–T6 一起纳入。详见[联合细设计](conversation-user-input-and-sandbox-integration.md)
和[平台计划](platform-native-sandbox-v1-implementation-plan.md)，不合并来源任务旧分支。

- 同一总计划、独立模块：问答是用户决定，审批是权限事实，工具结果是执行事实；三者不互相代替。
- D0 统一 scope/participant/run/attempt、状态、N03 新快照及 approval/policy 引用；接着 E1 存储，
  E5 安全让出/定向恢复，平台 T2–T4 受限执行，E2–E4 共享 renderer/settings，最后 E6 联合验收。
- normal/private/channel/child 共用问答 UI；子 Agent 答案不广播，只暂停有依赖的工作。
  问答不进入 batch，不增加嵌套 Timeline，不用 Composer/Inspector/环境浮窗重复正文。
- 待输入不直接复用等待 terminal run 的普通引导队列；回答 receipt 与 delivery 分开，
  重启补投幂等，旧问题/取消/撤销权限不能唤醒旧 attempt。
- macOS 和 Windows 均在首版交付；Windows 实机由同事验收、UAC 由其显式操作。
  沙盒不可用时明确拒绝，不回退原始 Pi/宿主工具；不以配置 true 代替隔离证据。
- U-01–U-10 和 S-01–S-06 全部 not_run；S 组须覆盖平台计划 §10 全部断言。
  它们是 §6.2、§6.3、§6.4 的增量，原 G-00–G-12、packaged 全案例、K-01–K-07 一项不减。
- U0 内容协议与 U1-A 原子存储已完成本地源码切片：25 项协议专项、20 项 SQLite 专项 + 1 项 workflow source guard；
  Contracts 75/75、Core 529/529、UI-core 137/137、Web 216/216、Daemon 相关回归 40/40，
  五包 typecheck 通过。包括未知字段及来源快照完整性的红→绿。
  完整 U1 delivery/dependency、Runner/UI 未接，未更新 QA 包，不标完整 U 用例通过。
  核心运行状态 consumer 审计已落盘，完整状态接线仍未完成；见联合设计 §8.1/§8.2/§8.3
  及[运行生命周期细设计](conversation-user-input-runtime-lifecycle.md)。
- U2-P 前置修复：真实 Pi SDK 与内存 SSE 复现 3 红并修复（启动前取消仍发请求、Host 边界异常被吞后仍继续）。
  生命周期专项 13/13、Runner 全量 51/51，Runner build/typecheck、Daemon typecheck 通过；独立只读审查无阻塞项。
  U2-P 当时未新增 yielded；后续 U2-C 的新增状态与原子存储如下。完整安全让出/答案恢复未接，
  未开放提问工具、未打包/启动 App，不标 U2/U3 通过。
- U2-C Core 原子等待切片：migration 132、checkpoint 原子提交、旧 fence 资源/事件隔离、
  Turn sibling 等待投影、独立 workflow 状态与 lease、专用迟到审计和取消隔离已实现。
  Core 554/554（含暂停专项 25）、Contracts 75/75、UI-core 137/137、Web 219/219；
  Daemon 取消/审计 5/5、审批恢复/监督器 9/9，相关构建和状态消费者类型检查通过。
  [交接证据](../../output/user-input-atomic-wait-u2c-handoff-20260907.md)列出尚未接通的 Host/Runner/U1/U3/U4。
  此为源码切片，不减少 G-00–G-12、packaged 20 案、K-01–K-07、U-01–U-10、S-01–S-06。
- N03 prepared-request、G-08 batch root windowing 和 Daemon 7 项失败仍保留原状态；
  U2 captured hydration、两执行入口的原子写入准入与先获准后写总结已经继续落地，详见
  [生命周期 §8](conversation-user-input-runtime-lifecycle.md)与
  [本轮证据](../../output/user-input-execution-admission-u2-handoff-20260907.md)。
  此切片不完成完整暂停、投递/恢复、共享问答 UI，也不清除原 7 项能力失败。
  不能因沙盒计划加入便认为所有 execute/fan-in 问题自动修好。

本次已确认整合范围；实施前的状态/Runner 边界、T0 可构建性及外部测试授权见联合设计末尾。

U4-B1（2026-09-08）：共享问答 DTO 合并、request/delivery 防回退、同版本冲突关闭、
无正文撤回标记、Host cursor 分页范围、读取 epoch 和 ordinary/private/channel/topic 数据
接线已实现；详见联合设计 §8.13 与 [交接](../../output/user-input-u4b1-handoff-20260908.md)。
这不是完整 U4-B：typed rows/registry、child hydration、可关闭问答窗口及所有 packaged
问答案例仍未完成；不开放真实提问工具，不把数据回归计为 U-01–U-10 GUI 通过。

U4-B2-A（2026-09-08）：独立问答 typed union/projector、detail/child hydration、
normal/private 共享历史 renderer 与 hover/focus copy 已实现；UI-core 153/153、
Web 257/257，浏览器合成 DTO 案例 4/4、8 图检查。生产 channel feed 接线、窗口、
实际投递/receiver ACK 及新包真实案例仍未完成，继续纳入本次计划，不计 U-01–U-10
端到端通过。细节见联合设计 §8.14 与 [交接](../../output/user-input-u4b2a-handoff-20260908.md)。

### 6.6 Harness 四项可靠性增量（2026-09-07）

按用户最新结构化选择，将摘要失败/预算复核、Pi 单次长 Run 压缩、Memory 召回与新鲜度、
工具结果预算纳入当前总计划；自动经验提炼和语义检索后置。完整细设计、模块边界、H0–H5
执行顺序及 H-01–H-06 退出条件见 [Harness 联合设计](harness-context-reliability-integration.md)。
H1-A 执行协调层已验证（11 项专项、47 项相关回归）；完整 H1–H4 尚未完成，完整验收仍为
not_run。详见细设计 §7.1；不得用旧包或单测替代新包真实案例。
复用 Ling/Pi/SQLite，原 G/K/U/S/packaged 验收一项不减，既有权限待答仍独立有效。

### 6.7 Skills 与自动审核完整链路（2026-09-08）

按用户新要求纳入 SK1–SK4 与 AR0–AR6，细设计、Codex 固定 SHA 依据、模块边界、
错误/恢复路径、SK/AR 验收见 [联合实施增量](skills-autoreview-harness-integration.md)。
自动审核目标是“通过后自动批准并继续”，不是只给建议；实际启用需 reviewer/provider 和策略
配置及完整安全验收。复用 U/H/N03/T，原 E/G/K/U/S/H/packaged 案例不减。
SK/AR 当前只完成设计接线，不标实现；Memory 已按同文 §5 确认的共享范围修复误拦截，
73 项专项通过，不替代全量回归与真实模型/新包验收。

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

- [ ] 五份权威设计文档互相链接、README 只保留一个 current entry point。
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

### N03 后续切片：accepted-input 持久冻结（2026-09-06）

契约依据：typed transcript 详细设计 §22。当前已封存/安装 QA 包不包含本切片；源码与
包状态分别报告，不复用旧包验收结论。

- [x] **N03-A1 红测**：no-Run 同 key、新增历史 event 后 fingerprint 不变；关闭重开 DB
  后不调用 collector；两连接竞争只产生一份 source/snapshot；changed payload 拒绝。
- [x] **N03-A2 core**：复用 `conversation_context_snapshots`，区分 `fork_context` 与
  `normal_conversation_accepted_input`/version 1；增加原子 ingest+capture+snapshot facade，
  同连接同步事务，无 await，附件归属一起提交或回滚，capture/insert 失败全回滚，snapshot 永不覆盖。
- [x] **N03-A3 daemon**：normal/replacement/local-user continuation 共用 accepted snapshot；
  no-Run replay 不再 rehydrate；缺失、未知版本、篡改、错误用途、跨 scope fail closed；
  accepted/Run 双证据一致，新 Run 带内部快照 ID，旧 Run 仅恢复原 durable request。
- [x] **N03-A4 验证**：独立红→绿、SQLite migration/reopen/rollback/fork 兼容、core/daemon
  focused/typecheck/build；单独列实际文件表和新产物状态。构建使用 `output/.build-lock`。
  本切片证据：`output/n03-accepted-input-handoff-20260906.md`；core 全量 496/496，
  accepted 原子专项最终 12/12（含全量之后新增的 COMMIT 失败用例），daemon 聚焦 68/68。
  独立最终代码复审尚未完成；以上为实现者验证，不等同于重新打包或真实 QA 验收。
- [ ] **N03-P prepared request**：按 §22.3 首次持久化 materialization/config 后的最终输入；
  当前切片不得假装该要求已完成，也不提前创建假 Run/WorkUnit 代替 context snapshot。
  - [x] **P-store**（2026-09-08）：request/execution 两阶段首次写定，完整前驱指纹链，
    同步 SQLite 事务、只读序列化保护、reopen/rollback/跨 writer 收敛；复用现有表。
  - [x] **P-request**（2026-09-08）：普通/新建/编辑/local-user intervention/manual resume
    接统一 DTO 与准备 owner；no-Run 不重复配置/附件准备；Run/prepared 双证据校验；
    编辑 revision 幂等并保留 fileRefs；手动恢复带 accepted 与 prepared 引用；不写凭据。
    Core 全量 778/778；最新 Daemon 入口专项 55/55；build/typecheck 通过。
    全量与保留失败详见 `output/internal-chain-n03-request-handoff-20260908.md`。
  - [x] **P-execution-Pi**（2026-09-08）：真实 SDK 准备器接入 Orchestrator，execution 在
    WorkUnit/Run 前首次写定；no-Run/reopen/并发获胜、当前 provider/MCP/Memory/Skill/审批复验，
    新旧 Run 引用对照；初始 schema 与 handler 分离。新增 pre-Run SSE 必达收尾，见设计 §22.3.2。
    Runner 全量 125/125，Core 全量 779/779；最终普通输入/execution/SSE/媒体/停机专项
    79/79；Daemon 最终全量 1646/1653，仍有原 7 项 workflow capability gate 失败。
    Daemon 最终全量结果与保留项记录于 `output/internal-chain-n03-execution-handoff-20260908.md`。
  - [ ] **P-execution-other-adapters**：外部 Codex/OpenClaw 尚无自身准备/消费合同；新的
    normal prepared 输入明确拒绝，不伪装 Pi 边界、不静默丢弃 system/append/MCP 字段。
    外部 Relay 运行授权仍待单独决定；本次不调用外部模型或变更配置。
- [ ] **N03-T 后续 publication**：canonical terminal assistant publisher/payload/UI、system
  source 与真实跨 thread fork seed 分别验收，不能以 A1–A4 全绿称全 N03 完成。
  - [x] **T-system 内部接线**（2026-09-08）：持久 intervention/父 Run 来源验证；系统输入
    独立 accepted/request/Pi execution，保留 system actor，no-Run/reopen 不复用父 prompt；
    hydration 作为 context 数据；详情 DTO 保留 system role、按 intervention ID 去重（含
    no-Run/被替代 Turn）；终态报告来源对应关系复验和系统报告重开唯一性已验证。
    Core 全量 780/780、Web 324/324、联合专项 141/141；最终 Daemon 1655/1662，原 7 项
    workflow 失败名称不变。没有新增表或修改真实历史，没有新包/真实模型/GUI 证据。
    详见 `output/internal-chain-n03-system-handoff-20260908.md`。
  - [x] **T-assistant-publication 内部接线**（2026-09-08）：独立 typed narration 契约、
    固定 Run/Attempt 来源、消息边界/水位；同事务 Item/outbox、retry supersession、
    重开恢复、回滚、失败/取消和容量错误；终态调用与独立分页恢复 worker，详情 GET
    只读 canonical 记录。UI 分段复用共享 projection，保留流式 logical ID，单一复制归属，
    通过 logical/canonical 双身份抑制旧 DTO 双显；没有将 batch 当执行事实。
    失败执行的文字仍以 committed Item 保留，deliveryStatus 单独表示失败，下一轮上下文
    不丢失它。内部验证详见 output/internal-chain-n03-narration-handoff-20260908.md。
  - [ ] **T-assistant-publication packaged 验收**：上述为内部测试，不是新 GUI/真实模型、
    SSE 断网或真实 daemon restart 的验收；需与联合计划统一在专用 macOS 包验证。
  - [x] **T-fork 内部接线**（2026-09-08）：原子 normal seed 与用途隔离、稳定 fork key、
    父来源分组/消息边界/水位、共享 projector 接缝与预算遗漏、子 accepted/request/Pi
    execution、no-Run/reopen/Run replay、精确 inline 来源与脱敏拒绝、删除依赖保护已验证。
    Core 797/797，Contracts/UI-core/Web 579/579；Daemon 1675/1682，7 个原基线失败
    added=[] / removed=[]。详见 output/internal-chain-n03-fork-handoff-20260908.md。
  - [ ] **T-fork packaged 验收**：fork-only 后继续输入、fork-run、嵌套分支、真实
    断网/重启与 UI 案例仍需在专用 macOS 包验收。本次没有更新或启动客户端。

### 真实案例后续：总结兜底追溯与原始 Markdown（2026-09-06）

这是一轮局部修复/诊断，不替代 §6.2–§6.4 的完整验收。当前安装的
`child-order-hover-20260906` QA 包不包含下面新增的 synthesis provenance 修复。

- [x] 只读核验 C02R/C03 的 `runtime_events`：C02R 首次校验返回
  `terminal_report_unverified_success_claim`，第二次 synthesis 超时；C03 首次 synthesis
  45 秒超时。两者不是“未配置模型”，也不能算模型总结通过。
- [x] 修正 fallback builder/coordinator：`synthesis.attemptCount`、provider、model 从真实
  synthesis result 传递到 report JSON 与 SQLite，不再把已尝试 1/2 次写成 0。
  fallback mode、Host outcome、fingerprint、校验和超时规则不变；不回写既有历史。
- [x] 4 条新增回归先在旧实现失败；修复后构造、存储、发布、幂等与恢复相关测试
  80/80 通过，Core/Daemon 编译通过。
- [x] SDK SSE 字节级解析与 Ling 事件适配/叙述重放专项 9/9：独立空白 delta、中文
  分包、Markdown heading 与 fenced code 缩进原样保留；不通过 UI 正则补写源文本。
- [x] 扩大到 Core 与 Runner 全量本地测试 536/536 通过（包含上述新增用例，数字不累加）。
- [ ] C03 原始回复中 `。` 后紧接 `###` 的生成问题：持久化事件已确认没有换行，
  但未保留当时 relay 原始 HTTP payload，不能区分 relay 与模型端的生成原因。
  本地 SSE fixture 不是这项真实生成验收；需新包新案例验证有效 Markdown 输出。
- [x] 新 provenance 修复重新打包、安装：已随 `report-privacy-20260906` 安装至专用 QA App；四项 package manifest checks 通过。
- [ ] 新包实际生成报告的 SQLite/GUI 联合验收：启动涉及测试 Relay 凭据，被安全审核拦截，待用户确认外部端点。

本轮 `git fetch origin main` 后远端为 `44f48cf85e6218b1e07213de588222ef9a7719a8`，
实现 HEAD `284f8c3c05f468a256adb4cee64c4455da834a4b` 已包含该基线；WIP 未提交。
命令、结果和剩余项见 `output/terminal-report-provenance-handoff-20260906.md`。
未决设计判定：无新增设计选择。原全矩阵和隐私/source-ref、prepared request、恢复与
Host 本机查询等未完成项保持原状态，不以本轮局部通过上调 E6。

### 报告隐私完整链路增量（2026-09-06）

- [x] **Host enrichment 隐私收口**：补回 participant contribution/artifact refs 时携带
  完整 Host sourceRefs；保留模型弱标记供 validator 拒绝，不能用 Host 覆盖来掩盖降级。
  两项新增测试修复前 0/2、修复后 2/2。
- [x] **隐藏检查误重试修复**：只有 model-visible checks 才触发非空 verification 要求；
  不改变 Host terminal state、证据核验、Completion Gate。新增 core 2 项与 synthesis 1 项均红→绿。
- [x] **最终源码回归**：Core/UI-core 637/637；隐私与 synthesis 专项 25/25；
  Daemon 全量 1428/1435，7 项失败名称与此前完全相同，无新增失败；浏览器 fixture 10/10。
  日志 `output/privacy-final-core-ui-tests-20260906.log` 与
  `/private/tmp/ling-privacy-final-tests.q38dvb/daemon-loopback.log`；截图
  `output/playwright/privacy-host-enrichment-20260906/`。均不等于真实 packaged 验收。
- [x] **Host 增量重新打包**：已生成 `/private/tmp/ling-privacy-package-final.90JR0s/package/mac-arm64/Ling Stack.app`；
  5 项 manifest checks、严格签名校验通过，未安装/启动。仅 ad-hoc QA，不是公证发布包。
  Desktop Node 19 文件集合 134/134（不是全部 Node），独立 preview renderer 28/28、a11y 3/3；
  后两者使用模拟 IPC，不是真实频道验收。日志位于同一临时目录。
- [x] **最新展示增量打包**（2026-09-07）：重复文件入口修复已随最新 build 打包，
  `/private/tmp/ling-privacy-display-package.3chGBh/package-manifest.json` 的 6 项 checks 全 true；
  严格 codesign 校验 exit 0，资源路径测试 4/4。Web 在 ASAR 外，另外核对了 Web 文件树。
- [ ] **最新包真实验收**：新包未安装/启动，不能沿用旧 manifest/hash 或模拟截图宣称 packaged GUI 通过。
  外部 Relay 仍待用户明确确认。

- [x] Host 校验不可降级 visibility/sensitivity；同身份引用以最严格标记为准。
- [x] 总结模型输入按完整 section 过滤受限正文和引用，公开副本不可绕过；不修改 Host 原始快照。
- [x] Normal/private/channel 共用 DTO 隐私适配及内容投影，正文、命令、路径、详情与复制执行相同策略。
- [x] Canonical ref 去重保留最严格标记；restricted outcome 保留 Host 终态及本地化安全标题，不显示模型正文。
- [x] 红→绿回归；Core/UI-core 全量 635/635、Web 全量 211/211、Daemon 报告专项 85/85；构建/类型检查通过。
- [x] 浏览器 API fixture 10/10：三种 surface 的公开/受限 outcome、展开详情、复制过滤、hover/focus 与 touch。
  仅为 simulation，不冒充真实模型或 packaged GUI。截图位于 `output/playwright/privacy-20260906/`。
- [x] 前一版隐私 QA 包已安装；当时源码打包指纹、ASAR、Daemon bundle、Web tree 四项校验通过；旧包可恢复备份。
  该包不包含本节 Host enrichment/隐藏检查增量；已实测两处源码哈希与旧 manifest 不同。
- [ ] 新 QA 包启动与真实模型案例：安全审核拒绝通过 FIFO 注入凭据并连接 nobody.host；等待用户明确确认。
  已停止等待中的凭据传递进程。未改真实历史，新客户端目前未启动。
- [ ] Daemon 全量仍有 7 项失败（1425/1432）：频道命令/打开目标的能力绑定、participant execute 与 callback publication。
  记录在 `output/privacy-daemon-full-tests-20260906.log`，不得以报告专项通过代替这些闸门。

完整修复、证据、当前客户端状态见 `output/terminal-report-privacy-handoff-20260906.md`。
未决设计判定：无新增设计选择；测试端点授权待确认。§6.2–§6.4 全矩阵保持不变，整体仍未完成。

### 报告展示与复制增量验证（2026-09-06）

- [x] change/artifact fallback 与真实 ref 重复入口红→绿：旧实现浏览器 count=2，修后 count=1。
  helper 在隐私过滤后执行，仅去除冗余 fallback，保留不同真实 refs、原始身份、权限和完整路径 tooltip。
- [x] Web 全量 215/215；三种会话隐私/复制 fixture 10/10，保存默认隐藏与 hover 显示对照截图。
  详情 `output/privacy-display-final-handoff-20260906.md`；全部浏览器证据均 simulation=true。
- [x] G-08 本地长历史/虚拟化子集 4/4：normal 120/private 106/channel 121、anchor ≤4px、
  synthetic 500-child root=1/nested=0/mounted≤48 与键盘/刷新保留。
- [x] G-08 本地 p95（2026-09-07）：500-child 20 次展开最终 p95=29.5ms，最大采样挂载 38 行，root=1/nested=0。
  已补 10/1,000/10,000 叙述与读取的 projector/batch、worker RSS 和原始采样；不将纯投影行数当 DOM 数。
- [x] 性能根因修复：序号查找从反复全扫描改为所选修订索引；1,000 条的序号读取 1,004,999→8,999。
  同时红→绿补齐较新修订移入已占用序号的冲突校验。UI-core 136/136、Web 215/215、长历史/性能 E2E 4/4。
  完整方法、数据和限制见 `.gstack/benchmark-reports/2026-09-07-benchmark.md`。
- [x] G-08 各规模实际 DOM 测量（2026-09-07）：普通消息 10/1,000/10,000 的首/中/尾逻辑行数完整，
  3/3 通过，大规模最大挂载17行/351 DOM；读取与命令各3种规模也已采样，原始 action ids 完整。
- [x] G-08 batch 根窗口切片（2026-09-08）：header/atomic children 共用 root display rows，
  两层 disclosure 定位、leadingItems、稳定 identity 和 revision/回收保留已接通。原六项规模红测
  已过，10,000 读取/命令本次展开分别为296/232 DOM、22个事实行，完整10,003行首尾可达；
  三 scope 定位3/3、原长历史/500-child4/4、Web324/324、UI-core167/167。详见新交接，
  所有浏览器数据均 synthetic，不是 macOS 模型验收。
- [ ] G-08 全部 evidence joins 复杂度审计、packaged GUI、完整 channel batch SSE 验收仍未完成。
  扩展检查有6项既有消息/报告/引用断言失败，已用只读修改前源码覆盖复现，不因批次绿测消除。
  证据与逐项剩余清单：`output/internal-chain-batch-root-handoff-20260908.md`。
- [x] 新性能增量已重新打包：`/private/tmp/ling-g08-current-package.bErO54/package/mac-arm64/Ling Stack.app`；
  manifest 七项内容检查全 true，严格 codesign 通过；UI-core 136/136、Web 215/215、Desktop resource-paths 4/4。
  本次只是回读已有构建/测试日志，并未再次运行测试。包为 ad-hoc QA，未安装/启动，未真实模型/GUI 验收。
  源码 fingerprint `d9b62abfcb532fc0e1988d09bb7db49994645566c53f05756c219818b8136e9f`，
  manifest 位于同一临时目录；本轮后续文档整合不在该历史源码 fingerprint 中，不表示新问答/沙盒已编译。

未决设计判定（2026-09-08 更新）：内部 batch/N03/MCP/普通私聊完整链路范围已获授权，
不再按文件数量确认。batch 局部、N03 request/Pi execution 和 system 续接已接线，
terminal assistant publication 的内部存储/恢复/共享展示和 normal fork 的
冻结/独立接受/真实 Pi SDK preparation 已接通并回归；其他 Runner 边界、
fork 与 terminal publication 的 packaged/完整验收仍未完成；
外部 Relay、T2-B 和 AR 范围继续单独待决。

### U3 答案续接：原子输入 seed（2026-09-09）

- [x] 首次 delivery claim 同事务冻结结构化问题/已接受答案/checkpoint，与唯一 successorRunId 绑定；
  保留原 WorkUnit/Turn/participant/workflowStep，不创建新 Turn、不修改旧输入，不新增 SQLite 表。
- [x] 三 surface、stored Task/workflow 归属、两连接竞争、reopen/lease 重领、COMMIT 回滚、损坏拒绝、
  历史 assignment 冻结与取消保留审计；错误分类与正文/Host metadata 分层校验均有回归。
- [x] seed 专项 27/27，相关问答 174/174，Core 824/824；Daemon 1675/1682，原 7 fail 集合不变。
  Core/Daemon 构建和 Web typecheck 通过，代码与证据见 `output/user-input-continuation-seed-u3-handoff-20260909.md`。
- [ ] prepared request/execution、唯一 successor Run/Attempt 原子绑定、当前 fence、receiver ACK 和崩溃回查。
  seed 已存在不等于 applied；普通新运行入口仍创建 WorkUnit，不能直接当问答续接入口。
- [ ] U2 Host 安全停止、调度/恢复分流、U4 API/controller/共享回答窗口及 macOS 真模型/GUI 全矩阵。

本切片没有新增待决设计；既有外部 Relay、T2-B 和 AR 选择保持待决，不由内部链路授权代答。
总目标仍未完成，不以局部存储测试代替实际续接、客户端或多 Agent 验收。

### U3 准备：原子 Run 创建基础（2026-09-09）

- [x] 普通 Run 创建和内部 joined primitive 共用事务实现，Run/Turn/selected skill 审计一起提交。
  修复审计失败留下 Run 的半提交窗口、rollback 异常覆盖以及 snapshot 重入修改创建身份。
- [x] 内部 joined 方法不发模型请求、不创建 Attempt、不提交调用方事务、不写答案 applied；
  不增加公开续接接口，不放开 orchestrator 的 duplicate guard，不新增 SQLite 表。
- [ ] 后续 coordinator 仍须将 seed/prepared input、完整 fence、唯一 successor Attempt、
  原 WorkUnit/Turn/Task/step 的当前指针与真实 receiver ACK 一起接通并验证恢复。

完整证据见 `output/user-input-run-creation-transaction-u3-handoff-20260909.md`。
这是实际创建链路修复及 U3 的前置能力，不是完整问答续接已完成。

### U3 Runner 接收边界（2026-09-09）

- [x] 先补生命周期设计 §4.2，再增加 `onPreparedInputAccepted`、独立接收 helper 和 adapter 接线。
  SDK 输入匹配后、prompt 前回报不可变 Run/Attempt/task/fingerprint；准备阶段不回报。
- [x] Host 返回前不 prompt，拒绝/取消/迟到回调不继续执行；冻结基线防止回调期间重写并重算指纹。
  后续模型失败仍失败，多轮工具只接收一次，并发执行互不污染，重建后给 Host 相同幂等身份。
- [x] 原始 12 项红测 1 pass/11 fail；最终 Runner 148/148、Electron 内嵌 Node 专项 37/37；
  Runner/Daemon build 通过。完整中间结果、环境失败及 Daemon 重验见交接文档。
- [x] Daemon 使用独立临时配置/工作区重验 1675/1682，原 7 失败名称集合 added=[]、removed=[]；
  未将受限环境下的端口/数据库启动错误当成代码回归，也未抹去该次失败记录。
- [ ] Host 唯一 successor/prepared refs 原子 admission、完整 fence + durable receipt/ACK、applied/resumed、
  receiver 恢复和三 surface 接线。回调成功不是模型发送或任务成功，接口存在不表示产品已消费。
- [ ] U2 全部 executor 停止证明、U4 入口/回答窗口、原 7 Daemon 与 6 Web E2E、macOS 真模型/GUI 仍保留。

证据：`output/user-input-runner-receiver-u3-handoff-20260909.md`。未提交、未打包、未改真实数据库。
本切片无新增用户选择；完整后代所有权/生产回写机制和外部 Relay/AR 原待决不变。

### T2-B 执行副本与七项频道失败收尾（2026-09-09）

- [x] 用户已允许一并验证执行副本、受控回写与后代停止；覆盖前文 T2-B 的验证范围待答记录，
  不代表技术验收通过，也不代答外部 Relay、AR 或新的系统部署选择。
- [x] 七项频道失败重跑 7/7 fail，确认五项在同一 run_command 启动门禁被挡住，
  另两项分别缺独立 Host open capability 和自然语言命令目标绑定。不得删除断言或 skip 凑绿。
- [x] 临时执行副本/变更提案原型已加入；实机硬链接保护、源目录拒写、小型 Node 子命令与产物通过。
  夹具回写只演示单文件 replace、冻结输出与冲突拒绝，不是产品发布或多文件原子提交。
- [ ] 完整后代停止：实机 detached 后代仍在 leader 取消后写副本；required 测试保持 fail。
- [ ] 原生目录 FD、输入读取授权、依赖与 symlink 支持、并发回写 journal、崩溃恢复和权限接线。
- [ ] 恢复七项正向频道场景、全量回归和真实 macOS App 的项目/多 Agent 验收。

固定 Codex 源码、准确结果及限制见 `output/native-sandbox-t2b-copy-validation-20260909.md`。
此验证未修改产品源码、SQLite、QA App 或 Git index；完整联合目标继续 active。

### U3 Host admission / durable ACK（2026-09-09，当前增量）

本节更新前文 U3 seed、Run 创建和 Runner 切片中的未完成项；旧测试数仅保留为历史基线。

- [x] request/execution 的不可变持久化、父引用和 claim 校验；不新增表、不保存凭据。
- [x] 唯一 successor Run/Attempt、原 WorkUnit/Turn/Task/step 当前指针、完整 fence 与 resuming 原子提交。
- [x] Pi receiver → Host receipt / applied / resumed 的原子 ACK，重复接收不得再次请求模型。
- [x] stored Task、workflow step、取消/归档、独立审批、双连接竞争、COMMIT 回滚及损坏拒绝专项 48/48。
- [x] 最终 Core 882/882；Daemon 1683/1690，原 7 项失败名称 added=[] / removed=[]；Electron 内嵌 Node 专项 48/48。
  Core/Daemon build、Web typecheck 和 diff whitespace 均通过。Electron 运行时测试不是 GUI。
- [x] 从 seed 生成真实 prepared request 的 Daemon builder：完成情况由下节更新。
- [ ] 真实 prepared execution builder；执行配置/有效 options 解析仍未接通，不能把 fixture 当产品实现。
- [ ] 当前权限/资源/启动 CAS、真实 orchestrator/scheduler 消费、崩溃回查与丢失执行处理。
  不能只把新 helper 塞入旧入口：旧入口会新建 WorkUnit，且重复启动的失败不能误伤合法执行。
- [ ] U2 全 executor 停止、U4 API/共享窗口、原 7 Daemon/6 Web E2E、T2-B 和 macOS 真模型/GUI 验收。

证据：`output/user-input-host-admission-u3-handoff-20260909.md`。未 stage/commit/push，未改真实数据或 QA App。
没有新增内部设计决策；后代完整生命周期/生产回写、外部 Relay/AR 的原待决仍保留。总目标未完成。

### U3 请求构建与 SDK 接收联合验证（2026-09-09，当前增量）

- [x] 三 surface 请求从冻结 seed 与同 Run 事件构建；保留 WorkUnit/Turn/Task/participant/step、
  typed operation ownership、provider identity 与原 sourcePolicyIntent，不复制旧审批和凭据。
- [x] 缺源输入、历史断档、超预算、权限或 provider 漂移、取消/租约过期显式拒绝；普通新建 Run 入口
  拒绝 answer continuation，防止错误新建 WorkUnit。
- [x] 原请求专项 29/29；联合 SDK 接收专项 14/14，真实 builder 读取 SQLite 答案后，
  SDK 首个请求与冻结内容逐字一致；Markdown、重开、新话题隔离、重复接收与 ACK 失败均覆盖。
- [x] 合并 readiness 和副本原型的定向测试 65/65；Electron 内嵌 Node 联合 43/43；0 skip。
- [x] Daemon 最终 1718/1725，原 7 fail 名称 added=[] / removed=[]；Web typecheck、Daemon build 通过。
- [ ] 真实 execution builder/current provider+MCP+Skill+Memory+policy 重验与冻结有效 Runner options。
  原执行 SDK system prompt 内的运行时 Memory/Skill 尚未完整复用，不得使用新历史或新召回冒充恢复。
- [ ] coordinator startup CAS、资源所有权、真实 scheduler、restart/disconnect recovery；
  本轮测试仍手工组合 execution plan/启动状态，不是这些产品链路的实现。
- [ ] 原 7 Daemon 与 6 Web E2E 失败、U2 全 executor 停止、U4 API/共享窗口、T2-B、
  H1/H2/H4、SK/AR、外部 adapter，以及 macOS packaged 全 20 案/真模型/截图仍保留。

原七项根因与最新全量结果见 `output/user-input-prepared-request-u3-handoff-20260909.md`。
本增量未提交、未改 QA App、未调度 Agent；无新增内部设计决策，总目标仍未完成。

### U3 三 surface 源输入统一捕获（2026-09-09，当前增量）

- [x] 将原 normal 的 SDK 输入 capture/read/restore/Memory eligibility 提取为共享模块；normal 保留父引用/CAS。
- [x] 所有实际 Pi source Run 在执行前捕获真实 SDK 输入并持久化 `runnerExecutionInput`，保留运行时追加
  Memory/Skill 文本及有效工具定义；普通/私聊/频道共用同一接线，不接受外部伪造输入。
- [x] SDK/sandbox await 后重验当前 provider/MCP/Memory/runner，随后解析当前 Host policy；不恢复旧授权。
- [x] 专项27/27；Electron 内嵌 Node 联合70/70；真实本机 Pi SSE 创建/协作/续聊保存3/3；
  Daemon1728/1735（原7fail名称不变），build/Web typecheck/diff check PASS。
- [ ] U3 source snapshot 消费与 execution builder：原 request builder 仍需读取实际源 SDK task/追加文本，
  完整冻结新 Run 有效 options，并确保第二次问答仍能从 successor 的实际输入继续。
- [ ] 专用 coordinator/启动 CAS/资源/fence、U2 全 executor、U4窗口/API、原7/6失败、T2-B、
  H1/H2/H4、SK/AR、外部 adapter、macOS packaged20案/真模型/截图保持未完成。

证据：`output/run-source-prepared-input-u3-handoff-20260909.md`。未改 Git index、真实数据或 QA App；
没有新的内部设计决策。后代生命周期/生产回写与外部 Relay/AR 原待决仍保留，总目标继续 active。

### 七项收尾增量：Host 打开能力的结构化失败（2026-09-09）

- [x] 修复 capability 缺失被误报为 ready/clarify；按 source 持久化 blocked，
  缺执行能力不要求用户重复补文件内容，也不通过 bash/读取工具降级。
- [x] 完整绑定验证在 capability 判断之前；保留 malformed/source/owner/path/graph 拒绝。
- [x] failed decision 写入失败不进入 ordinary reply fallback；SQLite 重开补齐同一 blocker，
  并发重放保持一条 item/decision，后续新 turn 不受污染。
- [x] 10/10 新测试（含真实 Pi + 本机 HTTP/SSE）；Daemon 全量 1738/1745、7 fail、0 skip；build/diff check PASS。
- [ ] 独立 Host 打开工具、独立授权、实际打开回执与原第 2 项正向验收仍未完成。
- [ ] 原其余六项、T2-B、U2/U3、三种会话与 macOS packaged/真实模型/截图仍未完成。

证据：`output/channel-host-open-blocker-handoff-20260909.md`。不把错误路径已修复当成
打开能力已完成，不移除原七项测试。原生后代停止/生产回写的安全合同仍未改变；
采用 best-effort 取消或增加新的隔离运行环境属于待确认的架构变化，不在本轮代选。

### 七项收尾增量：独立 Host 工具桥接（2026-09-09）

- [x] 闭集 catalog/input validator、独立 Pi extension、Host 保留名称、执行前后 gate、
  durable approval ID、取消与失败传播；实际 SDK 准备/工具生命周期回归。
- [x] 非秘密 Host schema 进入实际 prepared input；撤销/替换拒绝，不继承新能力或旧 grant。
- [x] 独立 `host_capability` approval/action/target；SQLite 审批与恢复载荷读回；复用已有
  dynamicToolCall，不伪造 MCP/Bash 事实，不新增 renderer 或数据库表。
- [ ] Host executor/当前能力发现与三 surface 权限交集、生产 dispatcher 接线、typed open
  operation/effect/evidence、实际查看器回执。binder 仍 blocked，原第 2 项尚未通过。
- [ ] 原七项正向场景、macOS 命令取消保证待决、U2/U3/U4 其余链路及真模型/App/截图
  保持原范围，不能因为基础层通过而勾选完成。

证据：`output/host-capability-bridge-handoff-20260909.md`。这不是重新实现第 9 节错误
提示，而是在其后补真正工具的协议基础；不把 schema 注册或审批当成已打开文件。

以下仍是历史审查记录，不是本轮重新运行 gstack 的结果，也不证明
当前 combined WIP 已通过。2026-09-05 本次三文档核对后的完成判定，以 §6.2–§6.3 为准。

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | 未运行，本轮为已确定的工程设计收口 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 未运行 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN (PLAN) | 4 个 P1 实现闸门仍未完成：capability callback、surface cutover、recovery/fan-in、packaged macOS |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 未运行；本轮已把 Codex-parity 视觉契约写入 v3.7 规范 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | 未运行 |

**VERDICT:** DESIGN UPDATED — v3.9.1-final 已统一五份权威文档，并新增组件级 component tree、
renderer props、状态所有权、source-ref lineage、专用 viewer、唯一 surface cutover、原子
recovery/fan-in 和执行板。实现尚未完成，
必须按 E1→E6 清掉 4 个 P1 闸门后，才能称为 Codex-parity 完成。

**OUTSIDE VOICE:** skipped；本轮没有引入新的外部架构建议，Codex 仅作为已记录的信息架构
参考。

NO UNRESOLVED DECISIONS

2026-09-09 当前增量的未决判定：以上英文 verdict 仅为历史审查记录。
macOS 原生后代停止/回写合同仍待确认实现机制；本轮没有批准弱化为 best-effort，
也没有批准新的隔离运行环境。推迟该选择会继续阻塞原五项命令验收和严格 U2 停止凭据。
