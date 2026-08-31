# Codex-style Typed Transcript v3.0：实现计划

Status: implementation plan；等待设计分支合并后开工
Date: 2026-09-01
Base: `origin/main` @ `63ab7c0e`
Canonical design: [Conversation Typed Transcript — Detailed Design](conversation-typed-transcript-detailed-design.md)
Visual contract: [Conversation Codex-Parity Visual Specification](conversation-codex-parity-visual-spec.md)

目标不是重写会话，而是把已有 durable facts 投影成一个简单、可追溯、跨 surface
一致的 transcript。实现期间不修改用户当前 dirty checkout。

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

### S1 / R5：evidence fold 和 live invalidation

**实现**

1. `tool_start/update/end` 归并为一个 action 和一个 DOM identity；
2. output tail bounded + redacted，revision 使用 monotonic number；
3. 第一个 durable end 是 terminal fence；迟到事件保留 diagnostic/source ref；
4. 每个接受的 revision 触发 live invalidation，拒绝 stale/equal-conflict；
5. daemon restart/SSE replay 可以重建相同 action state。

**测试**

fold replay、duplicate end、late update、terminal immutability、redaction、SQLite lineage
round-trip、SSE delta merge、invalidation count。

### S2 / R6：canonical projector 和 reversible batching

**实现**

- 按 `ConversationItem.sequence + partIndex` 排序，不按时间或 SSE arrival；
- 验证 scope、conversation-item anchor、owner、attempt supersession、revision conflict；
- 缺 lineage/anchor 生成 blocked diagnostic，不猜默认值；
- child span 放在父 anchor 后，只允许 depth 1；
- `contextSegmentId` 只从 ContextSnapshot/ContextSummary ref 派生；
- atomic projection 完成后仅调用一次 `batchCanonicalTranscriptItems()`；
- command/exploration batch 保留 child ids、lineage、source refs，永不进入 completion。

**测试**

乱序 delta 收敛、retry/latest attempt、跨 thread、owner conflict、缺 anchor、context
segment、每个 hard boundary、batch 展开精确恢复、fan-in partial evidence。

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
no duplicate summary/action/TerminalReport。

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

### S5 / R8：recovery 和 packaged macOS

依次验证：

1. retry：失败 attempt → 成功 attempt，旧 completion 不污染主 lane；
2. approval：pending/allow/deny/expired，只有一个 control owner；
3. failure/cancel/blocked：事实行显示下一步，不能被 batch 隐藏；
4. SSE reconnect：active action 继续同一 row；
5. daemon restart：从 SQLite 恢复相同 fingerprint；
6. fan-in：所有 required participant evidence 或结构化 blocked 到齐后才 settle；
7. packaged macOS：真实客户端操作命令、文件、代码、nested Agent 和环境浮窗。

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

## 7. Commit 形状

1. `docs(transcript): lock codex-style v3 design`
2. `feat(transcript): fold execution evidence and revisions`
3. `feat(transcript): project canonical items and reversible batches`
4. `refactor(web): adopt shared timeline renderer registry`
5. `test(transcript): add parity and recovery matrix`
6. `test(desktop): record packaged macOS transcript evidence`

每个 commit 可独立 review/revert。设计 commit 先合并；实现 PR 不应把 docs、evidence、
renderer 和大范围 route cleanup 混成一个不可审查提交。

## 8. Definition of done

- [ ] 三份设计文档互相链接、只保留一个 current entry point。
- [ ] 所有事实行/batch 有完整 lineage，缺失时明确 blocked。
- [ ] `tool_update` 原地更新；terminal fence 不回退。
- [ ] command/exploration batch 可逆且不参与完成判断。
- [ ] 普通/私聊/频道/topic/branch/child 使用同一 registry 与滚动 owner。
- [ ] 无生产 WorkCell/message-bubble activity caller、无重复 summary。
- [ ] TerminalReport/fan-in/retry 只读取 atomic evidence。
- [ ] SSE reconnect、daemon restart 收敛到同一 fingerprint。
- [ ] packaged macOS 每个案例有完整证据 tuple。
- [ ] `git diff --check`、相关单测、E2E、typecheck、build 全绿。

未决设计：无。实现偏差必须先更新详细设计再改代码。
