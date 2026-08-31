# Codex-style Typed Transcript v3.2：实现计划

Status: implementation plan；设计 v3.2 已冻结，等待设计分支合并后开工
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Canonical design: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Visual contract: [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)

目标不是重写会话，而是把已有 durable facts 投影成一个简单、可追溯、跨 surface
一致的 transcript。实现期间不修改用户当前 dirty checkout。

本计划把“好看”限定为可验证的工程约束：文档流不套重卡片，事实行有明确动作和
状态，详情原地 disclosure，三种会话及 depth-1 子 Agent 使用同一 renderer fingerprint。
任何视觉优化都不能改变 item kind、顺序、lineage、completion 或 context 语义。

## 1.1 开工前置条件（S0 不写业务代码）

设计 PR 合并后，先建立一个从同一 `origin/main`/design commit 派生的干净实现 worktree，
记录 Node、pnpm、Xcode/macOS target、当前测试基线和 commit SHA。现有 dirty checkout
与历史实验 worktree 不作为实现输入；候选实现只能按 commit 审查后 cherry-pick。

S0 的唯一产物是 contract/fixture/selector 的失败测试和边界清单：

| 产物 | 最小内容 | 通过条件 |
| --- | --- | --- |
| contract fixture | 六种 surface、成功/失败/等待/blocked/retry | 所有 item 有 anchor/lineage |
| semantic selector | id/kind/status/revision/depth/source ref | registry exhaustive |
| evidence matrix | start/update/end、重连、重启、fan-in | 明确 atomic owner |
| visual snapshot | document/fact/nested/approval | 无方形 bubble/重复 summary |

S0 不引入 feature flag，也不保留旧 renderer 兼容分支；测试先失败是预期的设计闸门。

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
git worktree add /private/tmp/ling-typed-transcript-impl \
  -b codex/typed-transcript-v3-impl origin/main
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
R0 baseline
  -> S0 contract/fixtures
  -> S1 evidence fold
  -> S2 canonical projection + batching
  -> S3 shared renderer
  -> S4 surface cutover
  -> S5 recovery + packaged macOS
  -> R8 ship gate
```

每个阶段都必须满足“代码、语义测试、视觉/恢复证据”三件套才可进入下一阶段。单元
测试通过但 semantic fingerprint 不一致，或截图漂亮但 lineage 缺失，都视为阶段失败。

### S0 / R1：contract 和 fixture 冻结

**实现**

- 建立 `ConversationTimelineItem` closed union、strict operation envelope、source refs、
  `TimelinePosition`、revision 和 semantic selectors；
- 为 normal/private/channel/topic/branch/child 准备同一份 canonical fixture；
- 核对现有 `ConversationItem`、`RunEvent`、`ExecutionAction`、`Approval`、`Artifact`、
  `ParticipantSpan`、TerminalReport 的真实字段；不存在的字段先补 contract adapter。

**退出条件**

contract/typecheck green；fixture 含 action/run/attempt/participant/workflow/source anchor，
没有通过缺字段放宽 projector 的测试。

**统一 fixture 形状**（所有 surface 只替换 scope/chrome）：

```text
userMessage → plan(2 steps)
           → agentMessage(narration)
           → exploration ×3  → commandExecution(start/update/end)
           → fileChange(+diff) → subAgentActivity(depth=1)
           → TerminalReport(sourceRefs)
```

fixture 同时提供：成功、失败、取消、审批等待、缺 evidence、retry supersession、乱序
delta、重复 end、跨 participant boundary。每个 item 都带 `actionId/runId/attemptId/
participantId/workflowStepId/sourceRefs`；无 action 的叙述 item 仍保留 `sourceRefs` 到
其 `conversation_item` anchor。

### S1 / R5：evidence fold 和 live invalidation

**实现**

1. `tool_start/update/end` 归并为一个 action 和一个 DOM identity；
2. output tail bounded + redacted，revision 使用 monotonic number；
3. 第一个 durable end 是 terminal fence；迟到事件保留 diagnostic/source ref；
4. 每个接受的 revision 触发 live invalidation，拒绝 stale/equal-conflict；
5. daemon restart/SSE replay 可以重建相同 action state。

**实现细节**：eventId 先去重，entityId+revision 再合并，terminal fence 后只写 audit；
`tool_update` 的 accepted revision 必须触发同一 `data-conversation-timeline-id` 的
invalidation，禁止以追加 message 的方式“看起来有输出”。

**测试**

fold replay、duplicate end、late update、terminal immutability、redaction、SQLite lineage
round-trip、SSE delta merge、invalidation count。

**实现顺序固定为**：先落 durable event，再 fold，再发 invalidation，再投影 UI。禁止先
渲染 `tool_start` 文本、稍后用 `tool_end` 另插一行；`tool_update` 必须命中同一
`data-conversation-timeline-id`，terminal fence 后只追加 audit diagnostic。

### S2 / R6：canonical projector 和 reversible batching

**实现**

- 按 `ConversationItem.sequence + partIndex` 排序，不按时间或 SSE arrival；
- 验证 scope、conversation-item anchor、owner、attempt supersession、revision conflict；
- 缺 lineage/anchor 生成 blocked diagnostic，不猜默认值；
- child span 放在父 anchor 后，只允许 depth 1；
- `contextSegmentId` 只从已提交的 `TurnContextAssignment` 及其 ContextSnapshot/
  ContextSummary lineage 派生；
- atomic projection 完成后仅调用一次 `batchCanonicalTranscriptItems()`；
- command/exploration batch 保留 child ids、lineage、source refs，永不进入 completion。

**测试**

乱序 delta 收敛、retry/latest attempt、跨 thread、owner conflict、缺 anchor、context
segment、每个 hard boundary、batch 展开精确恢复、fan-in partial evidence。

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

### S3 / R7：共享 Timeline 和 renderer registry

**实现**

- `ConversationTimeline` 使用 exhaustive registry；消息走 document lane，事实走
  `TimelineFactRow`；
- Markdown AST 保留段落/list/fence/link/path；command output 使用 pre-wrap；
- file/path basename-first，点击前由 Host 授予 trusted ref；
- `tool_update` 复用稳定 DOM id；active row 与批次 disclosure 不互相覆盖；
- `subAgentActivity` 调用同一 registry(depth=1)，加 participant label + rail；
- approval 只由 Composer/dialog gate 拥有；EnvironmentPopover 只显示 active ambient state；
- 删除 production WorkCell/message-bubble activity caller，测试迁移到 semantic selector。

**测试**

registry exhaustiveness、paragraph/list/code/path、row states、keyboard disclosure、
reduced motion、dark/light geometry、normal/private/channel parity、nested narration、
no duplicate summary/action/TerminalReport；模型随口路径与 Host trusted file/diff ref
必须分别验证为“可复制不可导航”和“可导航但二次校验”。

**renderer 验收**：registry 对 closed union exhaustive；同一 fixture 在 normal/private/
channel/topic/branch/child 产生相同 `rendererKeys`、kind、status text、disclosure count；
只允许 shell title、roster、participant rail 和 policy hints 不同。`ConversationTimeline`
是唯一 scroll owner，nested depth=1 不得创建新的 `overflow:auto`。

**Codex 风格 review gate**：document lane 不得有 fact-row 外框；fact row 首屏必须有
动词 + 状态；成功历史默认收敛；active/failed/approval 只展开一层；同一 action 不得
同时出现在 message、WorkCell、TerminalReport 和 Composer。

### S4 / R7：surface cutover

所有 surface 只保留 adapter：

```text
normal      -> scope + model policy
private     -> scope + single participant policy
channel     -> scope + roster/topic/branch policy
child       -> parent anchor + depth=1 policy
```

adapter 不允许按 kind 自己分支；`ConversationTimeline` 只接 canonical items。禁止保留
旧 workflow skeleton、第二纵向 activity panel 或 Composer 下方 summary。

开发阶段不保留旧 renderer 兼容路径：

1. 先把旧 caller 迁移到 semantic selectors 和 canonical item fixture；
2. 删除旧 WorkCell/message-bubble activity renderer 及其 production imports；
3. 旧 SQLite 行仍可读，但缺 strict lineage 的行只显示 `diagnostic(blocked)`；
4. 同一 PR 不得通过恢复旧 class/selector 来“修”测试，测试必须迁移到 typed contract。

### S5 / R8：recovery 和 packaged macOS

依次验证：

1. retry：失败 attempt → 成功 attempt，旧 completion 不污染主 lane；
2. approval：pending/allow/deny/expired，只有一个 control owner；
3. failure/cancel/blocked：事实行显示下一步，不能被 batch 隐藏；
4. SSE reconnect：active action 继续同一 row；
5. daemon restart：从 SQLite 恢复相同 fingerprint；
6. fan-in：所有 required participant evidence 或结构化 blocked 到齐后才 settle；
7. packaged macOS：真实客户端操作命令、文件、代码、nested Agent 和环境浮窗。

**真实 UI 证据闸门**：每个案例必须同时保存 screenshot、semantic-state、lineage 和
脱敏日志；只有 mock/API 截图时，状态标记为 `simulation`，不能宣称 packaged acceptance。
SSE reconnect 与 daemon restart 必须在 action 仍为 running 时执行，恢复后比较 action
fingerprint、terminal fence 和 scroll owner，而不是只看最终文字。

## 4.1 按 PR 的实现切片

| PR/提交 | 内容 | 不包含 |
| --- | --- | --- |
| P0 docs | 本组三份设计、fixture 形状、selector 契约 | 业务代码 |
| P1 evidence | envelope、fold、revision、restart/replay | renderer/layout |
| P2 projection | canonical projector、attempt/owner、batch | React/CSS |
| P3 timeline | registry、Markdown/code/path、fact row、nested | route cleanup |
| P4 surfaces | normal/private/channel/child adapter cutover、删除旧 caller | 新事实模型 |
| P5 recovery | SSE、daemon restart、retry、approval、fan-in | 视觉重构 |
| P6 packaged QA | macOS package、真实案例、证据 tuple | mock-only 结论 |

每个 PR 只引入一条 ownership 变化，并在 PR 描述中列出旧 caller、删除项和回滚边界。

## 5. 回归矩阵

| 领域 | 必测场景 | 证据 |
| --- | --- | --- |
| 内容 | paragraph/list/fence/inline code/path/link | screenshot + semantic + component |
| 事实 | command/live update/file/diff/read/MCP/collab | stable id + source refs |
| 状态 | pending/running/waiting/succeeded/failed/cancelled/blocked | text + icon + detail |
| 批次 | 3 reads、3 commands、混合 kind、非邻近、跨 agent/run/attempt | child ids + split reason |
| 协作 | child narration、child command/file、blocked child、depth 2 | nested registry + blocked |
| 审批 | pending/allow/deny/expired/cancel | one Composer/dialog control |
| retry | old failed + new success + stale old end | latest lane + audit lineage |
| 完成 | ready 无 evidence、partial fan-in、complete fan-in | atomic evidence only |
| 恢复 | SSE reconnect、daemon restart、乱序/重复 delta | identical fingerprint |
| surface | normal/private/channel/topic/branch/child | same kind/order/geometry |
| shell | environment popover、长 cwd、dark、reduced motion | no duplicate/scroll shift |
| packaging | packaged macOS launch + real interaction | build + screenshots + logs |

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

退出 R8 的必要条件是：相关 unit/component/E2E 全绿、`git diff --check` 通过、packaged
macOS 至少完成一轮真实案例，并且每轮 evidence tuple 的 `case.json` 写明 build hash、
thread/run/attempt、测试输入和是否为 simulation。全量 Web E2E 若含既有基线失败，必须
在报告中分开列出，不能混入 typed transcript 的通过结论。

## 7. Commit 形状

1. `docs(transcript): lock codex-style v3.2 design`
2. `feat(transcript): fold execution evidence and revisions`
3. `feat(transcript): project canonical items and reversible batches`
4. `refactor(web): adopt shared timeline renderer registry`
5. `test(transcript): add parity and recovery matrix`
6. `test(desktop): record packaged macOS transcript evidence`

每个 commit 可独立 review/revert。设计 commit 先合并；实现 PR 不应把 docs、evidence、
renderer 和大范围 route cleanup 混成一个不可审查提交。

## 8. Definition of done

- [ ] 三份设计文档互相链接、只保留一个 current entry point。
- [ ] normal/private/channel root/topic/branch/child 的 surface 到 `LingThread` 映射可由
  fixture 和 lineage 复现；Topic/Branch 不复制 parent transcript。
- [ ] `contextSegmentId` 由显式选择/结构规则/受限模型提议/服务端 policy 产生，且不受
  UI batch 影响。
- [ ] 所有事实行/batch 有完整 lineage，缺失时明确 blocked。
- [ ] `tool_update` 原地更新；terminal fence 不回退。
- [ ] command/exploration batch 可逆且不参与完成判断。
- [ ] plan/agentMessage 只描述意图；真实命令、文件、工具和 TerminalReport 各有唯一
  factual owner，Composer 不重复 summary。
- [ ] 普通/私聊/频道/topic/branch/child 使用同一 registry 与滚动 owner。
- [ ] 无生产 WorkCell/message-bubble activity caller、无重复 summary。
- [ ] TerminalReport/fan-in/retry 只读取 atomic evidence。
- [ ] SSE reconnect、daemon restart 收敛到同一 fingerprint。
- [ ] packaged macOS 每个案例有完整证据 tuple。
- [ ] `git diff --check`、相关单测、E2E、typecheck、build 全绿。

未决设计：无。实现偏差必须先更新详细设计再改代码；任何与 Codex 风格相冲突的“临时
兼容”都必须作为明确的 blocked decision 提交，而不是静默保留旧渲染路径。
