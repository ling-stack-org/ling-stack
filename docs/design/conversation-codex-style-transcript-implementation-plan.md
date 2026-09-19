# Codex 风格 Typed Transcript 实现计划

Status: implementation plan; approved to start after baseline gate
Date: 2026-08-30
Owner: conversation UI、conversation-ui-core、daemon runtime maintainers
Canonical design: [Ling Typed Transcript Detailed Design](conversation-typed-transcript-detailed-design.md)
Visual contract: [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)

本计划只覆盖 typed transcript 的实现和迁移，不把当前 checkout 的未提交 WIP 当作
已完成证据。R0 会重新核对最新 `origin/main`、真实调用方和测试结果；只有通过 R0，
后续“已完成”才可以写进 release/PR 描述。

## 1. 成功标准

```text
canonical facts -> pure typed projector -> one shared timeline -> replayable UI
```

完成后，普通会话、队友私聊、频道 root/topic/branch 和 depth-1 子 Agent：

- 使用同一个 `ConversationTimeline` 和 exhaustive renderer registry；
- 文本是文档流，事实是简洁 activity rail；
- command/file/tool/approval 都有真实动作描述、状态、bounded detail 和 source refs；
- tool update 原地更新，retry/reconnect/restart 不重复；
- fan-in/TerminalReport 只读取 atomic evidence；
- 无旧 WorkCell production caller、无第二 summary owner、无第二纵向 activity panel。

## 1.1 R0-R8 交付分解

| 阶段 | 交付物 | 退出条件 | 依赖 |
| --- | --- | --- | --- |
| R0 基线闸门 | 最新 main、字段/调用方/测试清单 | 事实来源和缺口有代码证据，未提交 WIP 未被覆盖 | — |
| R1 typed contract | item union、lineage、source refs、revision、fixtures | contracts/core typecheck + fixture contract green | R0 |
| R2 evidence fold | start/update/end 折叠、terminal immutability、invalidation | daemon focused + replay/late-event tests green | R1 |
| R3 canonical projection | scope/anchor/order/attempt/owner/child/fan-in | projector 全分支和 malformed diagnostic tests green | R1、R2 |
| R4 shared renderer | registry、document flow、fact row、Markdown/code/path/diff | component/a11y/semantic selector tests green | R3 |
| R5 surface cutover | normal/private/channel/topic/branch/child 统一 timeline | production WorkCell caller/route-local renderer 清零 | R4 |
| R6 recovery matrix | retry、approval、failure、cancel、SSE、restart、fan-in | browser E2E + daemon restart/reconnect evidence green | R2-R5 |
| R7 packaged macOS | packaged app、真实文件/命令/多 Agent 场景 | build hash、截图、semantic state、lineage、脱敏日志齐全 | R6 |
| R8 ship gate | 文档/测试/PR 证据收口 | `git diff --check`、全套 relevant checks、无未决阻塞项 | R7 |

R0-R4 如果在其他分支已有实现，也必须通过同一组验收；不能仅凭 commit 名称或
“之前做过”跳过。R5 之前不得调整视觉细节来掩盖事实层缺口。

## 2. 基线和分支纪律

1. 在开始实现前记录 `origin/main` 的 commit hash，并在独立 `codex/` 分支开发。
2. 当前 checkout 的既有 WIP 不 reset、不 clean、不批量 stage；设计提交与实现提交分开。
3. 如果需要携带当前分支 bug 修复，先通过 cherry-pick/merge 明确列出 commit，再在
   设计里记录其是否改变 evidence contract。
4. 本计划不要求兼容未发布旧客户端；可以直接删除旧 renderer、旧 selector 和旧 item
   spelling，但要保留 SQLite canonical records 的可读性。

开工命令只用于建立可审计基线，不会覆盖现有 WIP：

```bash
git fetch origin --prune
git show-ref --verify refs/remotes/origin/main
git worktree add /private/tmp/ling-typed-transcript-impl -b codex/typed-transcript-v2-impl origin/main
```

实现分支必须在首个代码提交中记录 `origin/main` SHA、运行时版本和测试基线。若基线
分支已有 Continuity v2 提交，使用显式 cherry-pick/merge 清单带入；禁止把整个脏工作树
复制到实现分支，也禁止 reset/clean/force-push。

## 3. 模块边界

```text
packages/contracts
  typed item、lineage、source ref、revision、snapshot DTO

packages/conversation-ui-core
  canonical projector、attempt/owner/anchor validation、batching、pure view models

apps/web/src/shared/conversation/timeline
  ConversationTimeline、TimelineFactRow、exhaustive renderer registry、view state

apps/web/src/features/*
  surface adapter：scope、policy、SSE/snapshot、Host callbacks、Composer wiring

packages/daemon
  action evidence fold、snapshot/delta、TerminalReport/fan-in atomic consumers

apps/desktop
  packaged macOS shell、daemon lifecycle、trusted file/diff Host actions
```

禁止 shared UI package 读取 SQLite、解析 raw SSE、调用 provider、做审批或完成判断。
禁止 surface adapter 自己按 item kind 分支或注册第二个 renderer map。

### 代码入口与责任表

| 责任 | 入口 | 允许做什么 | 明确禁止 |
| --- | --- | --- | --- |
| durable history | `LingThread/LingTurn/ConversationItem` 查询 | 提供顺序、文本和 anchor | 为 UI 新增 session/batch/summary 表 |
| execution truth | `RunEvent/ExecutionAction/Artifact/Approval/ParticipantSpan` | 折叠 evidence、分配 revision、暴露 source refs | 以模型文本补齐缺失事实 |
| pure projection | `packages/conversation-ui-core` | scope、排序、attempt、owner、batch | 读 SQLite、发请求、修改状态 |
| renderer | `apps/web/src/shared/conversation/timeline` | 按 `kind` 渲染、disclosure、a11y | 重新分类、重新计数、判断完成 |
| surface adapter | `apps/web/src/features/*` | 选择 policy、订阅 snapshot、绑定 callback | route-local renderer、第二 summary owner |
| host action | Desktop/Web Host bridge | trusted file/diff、retry、approval、focus | 任意 `file://`/模型路径导航 |

生产实现只允许沿这条调用链流动：

```text
Host snapshot/SSE
  -> daemon merge + evidence fold
  -> core projector (pure)
  -> ConversationTimeline (shared)
  -> surface policy chrome / Host callbacks
```

### 当前已有能力（复用，不重建）

| 已有模块/流程 | 已经解决的部分 | 本计划如何复用 |
| --- | --- | --- |
| `packages/contracts/src/execution-actions.ts` | action status、target refs、command evidence、output tail | 扩展/复用 lineage 与 revision，不在 React 造 action |
| `packages/contracts/src/runtime.ts` | RunEvent envelope 和 typed event data | daemon fold 的输入；SSE arrival 不是排序 authority |
| `packages/conversation-ui-core/src/activity-projection.ts` | WorkCell 行的 activity summary、exploration batching | 迁移算法与边界到 canonical atomic items，删除重复投影 |
| `packages/conversation-ui-core/src/command-batching.ts` | 低风险命令的相邻 batching | 保留为纯 wrapper，改为接受 typed atomic items |
| `packages/conversation-ui-core/src/work-cell-view-model.ts` | 现有 operation/file/command view model | 只作为 migration adapter 输入，终态 API 不再依赖 WorkCell row |
| `apps/web/src/shared/conversation/blocks/MessageBodyRenderer.tsx`、`CodeBlock.tsx` | Markdown、代码、路径的既有渲染基础 | 抽到 shared timeline renderer，保留安全协议和高亮能力 |
| `apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx` | 当前事实行、artifact、approval 的遗留壳 | 逐步拆出 kind renderer；R4 后无 production caller |
| `apps/web/src/lib/conversation-turn-projector.ts` | 现有 turn/block 投影边界 | 作为 surface adapter 的过渡入口，最终只调用 core projector |
| `packages/daemon` TerminalReport/fan-in | 已有终态报告和协作完成判断 | 改读 atomic evidence，不引入第二 summary owner |

计划明确不再维护一套“新 typed timeline + 旧 WorkCell 完成语义”。迁移期间旧 adapter
只负责把已有 row 转成 canonical input，所有事实判断只能走同一份 projector。

现有 `ConversationWorkCellItem` 的 `command_batch`/`exploration_batch` 是迁移输入
拼写；进入 shared renderer 前一次性归一化为 `commandBatch`/`explorationBatch`。新
renderer、semantic selector 和文档示例只使用 camelCase，避免把旧 spelling 继续扩散。

### 这不是重写：保留事实层，替换投影和渲染 owner

本计划不是重做会话、provider 或 SQLite。已有 `LingThread → LingTurn →
ConversationItem` 历史、`RunEvent`、`ExecutionAction`、Artifact、Approval 和
ParticipantSpan 继续作为事实来源；改动集中在“事实如何折叠成 read model、由谁渲染、
如何恢复”三层：

```text
已有 durable records
        │  保留
        ▼
daemon evidence fold + lineage adapter
        │  新增稳定 revision / sourceRefs
        ▼
纯 projector + display-only batching
        │  新增统一 owner arbitration
        ▼
ConversationTimeline / TimelineFactRow
        │  替换 route-local WorkCell / summary
        ▼
normal = private = channel = child（只差 surface policy）
```

禁止把这次工作扩大成以下无关迁移：Codex session schema、provider resume 协议、全量
SQLite 重建、Windows packaged QA、第二套 runtime。若基线核对发现某个 lineage 无法
从现有记录稳定推导，优先补一个窄的 daemon/contract adapter，并在该提交的测试中
证明它不会改变现有历史；不要在 React 层拼接字段。

### 稳定的 read-model API（实现前冻结）

实现前先把以下边界写成 TypeScript contract 和 fixture，不允许各 surface 自己定义
同名但不同形状的对象：

```ts
type ConversationTimelineProps = {
  items: readonly ConversationTimelineItem[];
  policy: ConversationSurfacePolicy;
  depth: 0 | 1;
  callbacks: ConversationTimelineCallbacks;
};

type ConversationTimelineCallbacks = {
  onToggleDetail(id: string): void;
  onOpenTrustedFile(ref: string): void;
  onOpenTrustedDiff(ref: string): void;
  onRetry(actionId: string): void;
  onResolveApproval(approvalId: string, decision: "allow" | "deny"): void;
  onFocusSource(sourceRef: ConversationOperationSourceRef): void;
};
```

`ConversationTimeline` 不接收 raw SSE、SQLite handle、provider payload 或翻译文案；
`policy` 只控制 chrome/可见性，不控制事实状态和顺序。所有 callback 都以稳定 id/ref
作为参数，禁止使用数组下标或 basename 作为 action identity。

### 依赖关系与并行化

共享事实、排序和 renderer 有强依赖，不能把同一个模块拆到多个 worktree 并行重写。
可拆的最小工作流如下：

| 步骤 | 触碰模块 | 依赖 |
| --- | --- | --- |
| S0 contract/fixtures | `packages/contracts`、core tests | — |
| S1 evidence fold | `packages/daemon`、runtime contracts | S0 |
| S2 projector/batching | `packages/conversation-ui-core` | S0、S1 |
| S3 timeline renderer | `apps/web/src/shared/conversation/timeline`、CSS | S2 |
| S4 surface cutover | `apps/web/src/features`、surface adapters | S2、S3 |
| S5 recovery/packaged QA | `apps/web/e2e`、`apps/desktop` | S1–S4 |

S0 和部分 S1 contract 测试可以由不同人准备，但合并前必须顺序集成；S2 之后所有
步骤共享同一个 item union 和 registry，采用 sequential implementation，避免两个
renderer 分支产生不同语义。

本计划采用两套编号但只表示一个执行顺序：R0-R8 是对外的交付闸门，S0-S5 是代码
工作包。对应关系为 `R0→S0`、`R1→S0`、`R2→S1`、`R3→S2`、`R4→S3`、
`R5→S4`、`R6/R7/R8→S5`。PR、测试报告和发布说明统一使用 R 编号，避免把同一
阶段误报成两次完成。

## 4. 顺序化工作包

### S0 — Baseline / contract freeze

- 从最新 `origin/main` 建立实现分支，记录 hash、Node/pnpm、macOS build target。
- 为 typed item union、lineage、source refs、revision 和 semantic DOM selectors 建立
  contract tests。
- 确认现有 `ExecutionAction`、RunEvent、TerminalReport、channel snapshot API 的真实
  字段；不存在的字段先补 contract，不在 React 临时拼接。

Exit：设计文档与代码字段一致；旧 WIP 未被覆盖；有一组可运行的 canonical fixture。

预计首批文件边界（最终以 R0 搜索结果为准）：

| 层 | 首批新增/修改位置 | 责任 |
| --- | --- | --- |
| contracts | `packages/contracts/src/conversation-timeline.ts`、`packages/contracts/src/execution-actions.ts`、`packages/contracts/src/index.ts` | typed item、lineage、source ref、revision DTO |
| daemon | `packages/daemon/src/features/runs/`、`packages/daemon/src/features/channels/` | action evidence fold、snapshot/delta、TerminalReport/fan-in 原子判断 |
| core | `packages/conversation-ui-core/src/canonical-transcript-projector.ts`、`activity-projection.ts`、`command-batching.ts`、`index.ts` | 纯 projector、owner arbitration、display-only batching |
| shared UI | `apps/web/src/shared/conversation/timeline/`、`apps/web/src/styles/shared/` | exhaustive registry、document flow、fact row、disclosure/a11y |
| surface | `apps/web/src/features/workspace/`、`apps/web/src/features/teammates/`、`apps/web/src/domains/conversations/` | scope/policy/callback；不再维护 route-local renderer |
| tests | `packages/*/test/`、`apps/web/e2e/`、`apps/desktop/` smoke harness | contract、replay、surface parity、packaged macOS evidence |

如果 R0 证明某个目录已有等价实现，复用并迁移测试，不平行创建同名模块。

### S1 — Evidence truth / action revision

- daemon 将 `tool_start/update/end` 折叠为一个 `ExecutionAction` / delta。
- 传播 `actionId/runId/attemptId/participantId/workflowStepId/sourceRefs`。
- 使用 numeric monotonic revision；拒绝旧、重复、equal-conflict 和 terminal 后迟到事件。
- 对 stdout/stderr 做 bounded tail 和 redaction；不把每个 chunk 变成消息。
- `tool_update` 触发 live evidence/revision invalidation。

测试：fold replay、revision conflict、late event、terminal immutability、redaction、
SQLite lineage round-trip、SSE delta merge。

### S2 — Canonical projector

- 新增 `projectCanonicalConversationTimeline`，只接 canonical snapshot。
- 实现 scope/anchor validation、`threadSequence + partIndex` 排序、latest attempt、
  owner arbitration、child span placement 和 blocked diagnostics。
- 生产路径禁止接收 `ConversationWorkCellRow`；旧 WorkCell 仅保留 migration test adapter。
- canonical projector 只返回 atomic items；`batchCanonicalTranscriptItems` 在 adapter
  中显式调用一次，不能在 projector 内部或 Timeline 内再次 batching。
- 将 TerminalReport 和 multi-agent fan-in 的 completion credit 改为 atomic evidence。

测试：输入乱序收敛、缺 anchor、跨 thread、malformed lineage、duplicate owner、retry
supersession、child waiting/blocked/succeeded、fan-in partial evidence。

### S3 — Shared renderer / visual grammar

- 建立 exhaustive `renderer-registry.tsx` 和一个 `TimelineFactRow`。
- `userMessage/agentMessage` 使用 document flow；reasoning、plan、command、file、
  exploration、MCP/dynamic/collab、approval、image、compaction、generic blocked 各有
  focused renderer。
- 先做结构正确性：换行、列表、代码 fence、命令 stdout、basename/path、diff hunk；
  再做 icon、token、hover/focus 和动画。
- 增加 `data-conversation-timeline-*` 语义 selector，替换 legacy WorkCell selector。

测试：DOM kind/id/revision/status/depth、Markdown/code newline、command output folding、
trusted file activation、diff fallback、keyboard disclosure、reduced-motion、long labels。

### S4 — Surface cutover / remove duplicate owners

- normal、teammate-private、channel root/topic/branch 全部调用同一个 timeline。
- 子 Agent 在父 item anchor 下调用同一 registry，固定 `depth=1`。
- 删除 route-local WorkCell/activity/summary/completion renderer；不是 CSS hide。
- pending approval 只保留一个 live dialog/control，resolved approval 历史只显示一次。
- EnvironmentPopover 仅 active-run ambient state，settled 后消失。

Exit search：production `<ConversationWorkCell>` caller 为 0；route-local renderer map 为 0；
Composer 下没有重复 summary/TerminalReport；feed 没有第二个纵向 activity scroll owner。

### S5 — Recovery / packaged macOS evidence

- browser E2E 先覆盖三种 surface、子 Agent、批处理、失败/审批/retry。
- 构建 packaged macOS client，实测 daemon restart、SSE reconnect、reload、文件打开和
  multi-agent fan-in；fixture/screenshot 不能替代真实 packaged evidence。
- 每个案例保存 build hash、截图、semantic DOM state、SQLite lineage、脱敏日志。

### 实现启动闸门（不是代码工作包）

S0-S2 的 contract、evidence fold 和 projector 通过后，才允许切换真实 surface。启动
闸门必须同时满足：

1. 同一 fixture 经过 normal/private/channel/child 得到相同 `kind/id/order/status`；
2. `tool_start/update/end` 在 replay 和 SSE 乱序下只产生一个 action row；
3. delegated `ready` 没有 terminal evidence 时是 `waiting/blocked`，不是成功；
4. TerminalReport/fan-in 使用 atomic evidence，batch 只作为 display wrapper；
5. 旧 WorkCell caller、第二 summary owner 和第二 scroll owner 已经定位并有迁移清单。

闸门未通过时，只修事实层和测试，不通过 CSS 或临时隐藏让页面“看起来完成”。

## 4.1 每阶段具体任务清单

### R0 基线闸门

- [ ] `git fetch origin main`，记录 `origin/main` SHA、Node/pnpm、macOS target 和当前
  worktree 状态。
- [ ] 搜索实际 production caller：`ConversationWorkCell`、route-local summary、
  `TerminalReport`、第二个 activity scroll container、旧 `data-*` selector。
- [ ] 对照 `packages/contracts`、daemon action/event、core projector、Web surface
  的真实字段；缺失字段登记到 R1，不在 UI 临时拼接。
- [ ] 保存基线测试输出；既有 SQLite dirty 数据导致的 migration failure 单独记录，
  不通过删数据或改 migration 绕过。

### R1 typed contract

- [ ] 在 contracts 中冻结 `ConversationTimelineItem`、`ConversationOperationLineage`、
  `ConversationOperationSourceRef`、`revision` 和 `depth` 的类型。
- [ ] 为每种 kind 建立最小 fixture：plain text、Markdown/code、command、file/diff、
  approval、child、blocked、malformed。
- [ ] 为每个 fixture 写 expected `kind/id/order/status/lineage`，禁止以 array index
  或翻译标题作为断言。

### R2 evidence fold

- [ ] `tool_start` 创建 action；`tool_update` 只更新同一 action 的 bounded live evidence；
  `tool_end` 写 terminal evidence。三类事件的真实 `run_event.id` 都进入该 action 的
  `sourceRefs`，batch 只汇总这些 refs，不生成新的事实事件。
- [ ] 校验 old/duplicate/equal-conflict/late event；terminal 后禁止 reopen。
- [ ] 对 stdout/stderr 做 redaction + tail cap；完整输出只引用 artifact。
- [ ] 每次 update 触发 live evidence/revision invalidation，确保 UI 不依赖 `updatedAt`
  偶然变化。

### R3 canonical projection

- [ ] 先 merge durable snapshot，再做 scope/anchor/attempt/owner 校验和排序，得到 atomic
  items；然后只在 display projector 调用一次 batch。完成判断永远在 batching 之前执行。
- [ ] latest attempt 只进入主 feed，旧 attempt 进入 audit/detail；缺 attempt lineage
  的 action 不得批处理。
- [ ] required participant 必须有 terminal atomic evidence 或 structured blocked；
  narration、plan checkmark、batch count 不得给 fan-in credit。
- [ ] 无 anchor、跨 thread、lineage 损坏、owner 冲突都输出 visible blocked diagnostic。

### R4 shared renderer

- [ ] 建立 exhaustive registry；未注册 kind 由 typecheck 阻断，只有 generic blocked
  fallback 可运行。
- [ ] `agentMessage` 走 Markdown AST document flow；代码 fence、空行、列表、长路径和
  失败高亮都有明确 fallback。
- [ ] `TimelineFactRow` 统一 icon/title/status/disclosure；command/file/tool/approval/
  child 只在这一行展开 bounded detail。
- [ ] 迁移 semantic selectors：`data-conversation-timeline-*`、`data-conversation-action-id`、
  `data-conversation-run-id` 等，禁止新代码依赖 WorkCell selector。

### R5 surface cutover

- [ ] normal、teammate-private、channel root/topic/branch 只传 typed items；surface
  仅提供 policy/chrome/callback。
- [ ] child Agent 在父 item 下以 `depth=1` 复用同一 registry；depth>1 只进 detail/audit。
- [ ] 删除 route-local activity/summary/completion renderer 和 Composer 下重复 summary；
  不用 CSS hide 掩盖双 owner。
- [ ] EnvironmentPopover 只投影 active run，settled 后卸载；点击 source 聚焦 owning row。

### R6 recovery matrix

- [ ] 单元测试覆盖 revision、late event、malformed lineage、batch boundaries、owner
  arbitration；集成测试覆盖 approval/retry/failure/cancel/fan-in。
- [ ] Playwright 覆盖三种 surface、连续追问、代码/文件操作、多 Agent 串并行、SSE reconnect。
- [ ] daemon restart 后从 SQLite snapshot 重建同一 timeline；不能依赖内存 transcript。

### R7 packaged macOS

- [ ] `CI=true corepack pnpm --filter @ling-stack/desktop package:mac` 生成最新包并记录
  build hash。
- [ ] 使用 `cua-driver` 真实启动 packaged app；每次交互前后读取 window state。
- [ ] 对 TT-01–TT-17 保存 `case.json`、`build.txt`、`screen.png`、`semantic-state.json`、
  `lineage.json`、`logs.redacted.txt`。

### R8 ship gate

- [ ] 文档索引、设计状态、测试命令和 selector 名称一致；删除已迁移的旧生产 caller。
- [ ] 运行 core/Web/daemon/typecheck/lint/Playwright 与 packaged smoke；失败项保留日志。
- [ ] 只在所有 required evidence 到齐、无重复 owner、无 unresolved blocking decision
  后创建 PR；Windows 不纳入本轮验收。

## 5. 测试矩阵

| ID | 场景 | 断言 |
| --- | --- | --- |
| TT-01 | plain answer | 一条 document-flow agentMessage，无方形卡 |
| TT-02 | Markdown/list/code | 空行、列表、fence、indent、language 保留 |
| TT-03 | adjacent reads/commands | 只合并合法相邻项，展开恢复 exact children |
| TT-04 | live update | start/update/end 是同一个 DOM id，revision 单调 |
| TT-05 | file/path/diff | basename 优先，trusted ref 才能打开，diff 结构化 |
| TT-06 | approval | pending 只有一个控制，resolved 历史只出现一次 |
| TT-07 | failed/cancelled/blocked | 状态清晰，有 retry/repair/detail，不假成功 |
| TT-08 | retry | 最新 committed attempt 在主 feed，旧 attempt 在 audit |
| TT-09 | fan-in | required child 无 terminal evidence 时 parent 不成功 |
| TT-10 | reconnect/restart | id/order/status/revision 收敛，无重复 final |
| TT-11 | late event | terminal action/report 不被 reopen |
| TT-12 | child agent | 子 Agent 可有 agentMessage，和外层同 renderer，depth=1 |
| TT-13 | environment | active-only popover 原地更新，settled 后消失 |
| TT-14 | surface parity | normal/private/channel/topic/branch/child 共享 kind/geometry |
| TT-15 | density/overflow | bounded detail，feed/Composer 无横向滚动 |
| TT-16 | lineage | row/batch 可追溯 action/run/attempt/participant/step/sourceRefs |
| TT-17 | malformed | blocked diagnostic 可见，未知 payload 不进入正文 |

### 5.1 Fixture 结构与证据要求

每个 fixture 都同时保存 canonical 输入、projection 输出和用户可见 DOM；不能只保存
截图：

```text
fixture.json
  ├─ turns/items（含 threadSequence / anchor）
  ├─ actions/events（含 actionId / revision / status）
  ├─ participants/approvals/artifacts
  └─ expected
       ├─ timeline items（kind/id/order/status/depth）
       ├─ lineage/sourceRefs
       └─ visible DOM selectors + disclosure result
```

必须额外覆盖四个容易被旧实现漏掉的反例：

- **ready-only**：子 Agent 只输出 `ready` 文本，父 fan-in 保持 waiting，并显示缺
  evidence 的 blocked diagnostic；
- **late update**：action 已 terminal 后收到更高到达序但更低 revision 的 update，
  terminal 状态和输出不变；
- **same revision conflict**：相同 revision 携带不同 payload，主 feed fail closed，
  诊断可追溯到两个 source refs；
- **surface parity**：同一 canonical snapshot 在三个 surface 和 depth=1 下 DOM kind、
  stable id、renderer 名称完全一致，只有 header/roster/chrome 不同。

代码路径覆盖图：

```text
event fold
  ├─ start -> running                  [unit]
  ├─ update -> same id/new revision    [unit + E2E]
  ├─ end -> terminal                   [unit]
  ├─ old/equal-conflict/late           [unit]
  └─ reconnect/restart                 [E2E + packaged macOS]

projector
  ├─ anchor/order/latest attempt       [unit]
  ├─ owner conflict/blocked diagnostic [unit]
  ├─ child placement/fan-in            [unit + channel E2E]
  └─ batching after atomic projection  [unit]

renderer
  ├─ document flow/code/path/diff      [component + E2E]
  ├─ fact row/status/disclosure        [component + a11y]
  ├─ same registry at depth 0/1        [component + E2E]
  └─ overflow/reduced motion           [E2E]
```

## 6. 生产失败模式与防线

| 失败 | 防线 | 用户可见结果 |
| --- | --- | --- |
| SSE 重复/乱序 | numeric revision merge | 保留最新 row，detail 有 diagnostic |
| action terminal 后迟到 update | terminal immutability | 状态不回退 |
| missing anchor | fail-closed diagnostic | blocked/不可用，而不是假位置 |
| required child 只有 ready 文本 | atomic fan-in gate | parent waiting/blocked |
| retry 旧证据覆盖新证据 | attempt selection | 主 feed 只显示最新 attempt |
| batch 跨 agent/run | strict scope key | 原子行分开显示 |
| 未信任本地路径 | Host ref gate | 只能复制 basename/path，不能跳转 |
| 长 stdout/code | bounded detail | 首屏可读，完整内容可展开 |
| child timeline 套娃 | depth cap | depth>1 进入 detail/audit |
| stale hydration | `(itemId, revision)` cache key | 新内容不会被旧内容覆盖 |

## 7. 实现提交拆分与回滚

建议按以下独立提交，方便审查和回滚：

1. `contracts: add typed transcript lineage and evidence DTOs`
2. `core: project canonical transcript and atomic completion evidence`
3. `core: add deterministic command/exploration batching`
4. `web: add shared timeline registry and fact renderers`
5. `web: cut normal/private/channel/child surfaces to timeline`
6. `qa: add recovery and packaged macOS acceptance evidence`

不要在同一提交同时改 storage、runtime、renderer CSS 和 surface geometry；先让事实
和 projector 稳定，再做视觉切换。

## 8. NOT in scope

- Codex session schema/provider protocol/TUI 迁移：只借鉴 typed transcript 原则。
- 新 SQLite session/batch 表或 summary write-back：现有 Thread/Turn/Item + evidence 足够。
- Windows packaged QA：本轮 macOS 优先。
- 超过一层的 nested timeline：先保证 depth=1 可读和可恢复。
- 模型自动修改 context segment：模型只能建议，不能拥有 context authority。
- 用 LLM 生成 activity summary：summary/batch 必须 deterministic。

## 9. 未决项

无阻塞性架构决策。只有实现中若发现现有 daemon 字段无法提供完整 lineage，才允许
回到 S1 增补 contract；不得在 React 层临时猜字段。实现完成的判定以 TT-01–TT-17、
production caller 清零和 packaged macOS evidence 同时满足为准。
