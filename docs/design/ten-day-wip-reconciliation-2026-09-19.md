# 十几天主线与 WIP 清算记录（2026-09-19）

## 目的

这份记录固定本轮实现的基线和边界，避免把已经进入本地 `main` 的内容重复搬运，
也避免把当前脏工作区中的旧结构误删或直接混入新主线。

## Git 基线与保护边界

| 项目 | 值 |
| --- | --- |
| 新开发分支 | `codex/ten-day-wip-cleanup` |
| 新分支基线 | `main@fa7783b9a2437d8e0ffa6be99d5a31b7b3decdfb` |
| 新分支 worktree | `/private/tmp/ling-stack-ten-day-wip-cleanup` |
| 原 WIP 分支 | `codex/retry-report-supersession@8b259da0ff4302b97c69f9ef65e221fd108e0ee0` |
| 原 WIP 工作区 | `/Users/tianxiao/ling-stack` |
| 原 WIP 快照 | 71 个工作区条目：62 个已修改/删除，9 个未跟踪 |
| 远端操作 | 本轮未 push、未合并远程 PR、未改远程 `main` |

原工作区只作为证据和回溯来源，不在其上切分支、reset、clean、批量 stage 或提交。

## 已经在本地 main 的内容

以下主线不再从原 WIP 复制：

- Continuity / typed transcript / canonical timeline；
- 普通会话、队友私聊、频道共享 Timeline 投影；
- ExecutionAction、tool evidence、source refs、batch/disclosure；
- Harness durable continuation、Attempt fence、restart recovery；
- 自动审批、审批恢复、命令规则；
- TerminalReport 原子 evidence、retry/failure lineage；
- 多 Agent fan-in 与 evidence 校验；
- 频道工具 allowlist、命令审批设置和普通会话审批投影基础；
- 相关 localization、根 `package.json` 与设计文档。

原 WIP 中下列未跟踪文件与 `main` 内容完全一致，视为重复副本，不得再次移植；其中
`RuntimeApprovalDialogQueue` 是基线中已经被后续 Composer 设计取代的旧实验，不作为新入口：

- `apps/web/src/features/approvals/RuntimeApprovalDialogQueue.tsx`
- `apps/web/src/features/workspace/ChannelExecutionProposalEditor.tsx`
- `apps/web/e2e/ui2-channel-proposal-input-migration.spec.ts`
- 五份 Codex/typed-transcript/harness/sandbox 设计文档

## 尚未完成、需要在新分支继续的内容

### 1. 三种会话审批入口统一（本分支已开始修复）

基线 `main` 的真实接线是：

- 普通会话误接到 `RuntimeApprovalDialogQueue`；
- 频道和队友私聊仍使用 `RuntimeApprovalComposerGate`；
- 旧 `ConversationDecisionGate`、`RuntimeApprovalComposerGate` 和
  `ChannelExecutionProposalComposerGate` 仍然存在；
- `ChannelExecutionProposalEditor` 已存在，但与当前 typed timeline 的频道提案投影尚未
  完成闭环。

本分支已将普通会话切回 `RuntimeApprovalComposerGate`，并删除仅剩的旧
`RuntimeApprovalDialogQueue` 实现。三种会话现在复用同一个 runtime approval gate 和唯一
control owner；频道仍保留多 Agent 参与者语义，不把频道专属 proposal 误投影到普通会话或私聊。

这里不再引入全局 approval Dialog：它会抢焦点、改变 Composer 高度，并与 Codex-style
session-owned gate 及已有回归合同冲突。真正的 blocking approval 仍只在 owning session
的 Composer slot 展示。

### 2. 频道提案决策入口审计

原 WIP 的 `ChannelExecutionProposalDialog.tsx` 在 `main` 中不存在，不能直接恢复。现有
`ChannelExecutionProposalComposerGate` 已经复用 `ConversationDecisionGate`，并且频道回归合同
明确要求 proposal 只替换 owning channel 的 Composer。新分支不重新引入中心 Dialog，避免和
runtime approval 形成两个 control owner；后续只补齐 proposal 的 stale/concurrent decision、
cancel 和 participant isolation 回归。

### 3. 旧结构删除的处理原则

原 WIP 删除了以下文件，但新分支暂不直接删除：

- `apps/web/src/features/approvals/ConversationDecisionGate.tsx`
- `apps/web/src/features/approvals/RuntimeApprovalComposerGate.tsx`
- `apps/web/src/features/workspace/ChannelExecutionProposalComposerGate.tsx`
- `apps/web/src/lib/runtime-approval-ownership.ts`

这些删除只有在全部消费者迁移到新共享入口、类型检查和 UI 回归通过后，才作为单独提交执行。
它们目前在 `main` 中仍是有消费者的真实代码，不是可以凭“新设计”直接判定为废弃的文件。

## 本分支执行顺序

1. 先审计 approval/dialog 的真实 route → projection → renderer → decision endpoint 链，锁定
   三种会话的 owner、scope 和状态映射。
2. 以 `RuntimeApprovalComposerGate` 为共享外壳，确保普通会话、队友私聊和频道 runtime
   approval 接入同一 decision shell；
   不改变 daemon approval contract、SQLite 事实或 policy 语义。
3. 保留频道 proposal 的 Composer 接线并接入当前 `ChannelWorkflowProposalCards`，保留 proposal 与 runtime
   approval 的边界，补齐 stale/concurrent decision 和 participant isolation。
4. 只删除无消费者的旧 Dialog 文件；共享 ComposerGate、DecisionGate 和 ownership resolver
   不是旧骨架，不能因为“统一”而删除。
5. 运行 Web typecheck、相关单测、频道/私聊/普通会话 E2E；然后再做 macOS packaged GUI
   验收。逻辑测试通过不等于 packaged GUI 已完成。

## 完成门槛

- 三种会话只有一个可见的 approval control owner；
- 普通会话、私聊、频道都支持相同的 allow-once / allow-similar / deny / cancel 语义；
- 频道 proposal 仍严格限定在 owning channel 和 owning participant/run；
- approval、retry、SSE reconnect、daemon restart 不产生重复 action 或幽灵 pending；
- 所有事实来自 Host/daemon evidence，不能用 ready 文本、batch 数量或 UI 摘要判定完成；
- Web/Daemon 回归全绿，并完成真实 packaged macOS 案例后，才允许创建 PR。

## 不变边界

- 不改原 WIP 工作区；
- 不把原 WIP 中同名重复文件再次复制到新分支；
- 不直接修改远程 `main`，不自动合并或推送；
- 不用删除旧组件来掩盖尚未完成的接线；
- 不把 mock、fixture、build 或 reasoning summary 当作真实 macOS 验收证据。

## 本分支首个修复证据

变更：

- `ConversationHome` 改为与频道、队友私聊共享 `RuntimeApprovalComposerGate`；
- 普通会话重新把 `composerGateApprovals` 传给 Timeline 的非交互等待标记，避免重复审批卡；
- 删除无消费者的旧 `RuntimeApprovalDialogQueue`；
- 没有修改 Daemon/API/SQLite approval contract。

验证结果：

- Web typecheck：通过；
- Web 单元测试：338/338 通过；
- 普通会话审批 E2E（Allow once、Allow similar、Deny）：通过；
- 队友私聊审批 E2E（Allow similar、归属隔离）：通过；
- 频道 task proposal 与 runtime approval E2E：3/3 通过；
- Web UI 边界 lint：通过；
- 真实 packaged macOS、daemon restart、SSE reconnect 尚未在本记录中宣称完成。

## 当前未决判断

`sidebar-approval-proposal-dialogs-implementation-plan.md` 仍保留“频道 proposal 使用中心 Dialog”的
历史切片，但 `conversation-surface-contract.md`、`inline-runtime-approval-detailed-design.md` 和
现有 Playwright 合同都规定 proposal 使用 owning channel 的 Composer decision shell。为避免再次
出现两个 control owner，本分支暂以后一套为准：runtime approval 与 task proposal 都在共享
Composer slot 决策；只有在产品明确重新选择全局 Dialog 后，才另开设计变更，不在本修复中偷偷切换。

## 原 WIP 审计结论（不自动接入）

逐文件将原工作区内容与本地 `main` 比较后，发现：

- 多数未跟踪文件是 `main` 的逐字重复副本；
- 其余 UI WIP 包含将三种会话切回全局 Dialog、删除 ComposerGate，以及把
  `composerGateApprovals` 改名为 `dialogOwnedApprovals` 的整套替代方案；这与当前
  Composer-owned contract 冲突，本轮不移植；
- `packages/daemon/src/features/channels/terminal-report-coordinator.ts` 的 WIP 会在恢复时
  逐条重新发布所有 committed/fallback report，并删除“同一 source 只恢复最新 generation”的
  回归测试。这会重新引入旧 generation 重复结果，属于回退，明确不接入；
- 原 WIP 中删除 `ConversationDecisionGate`、`RuntimeApprovalComposerGate`、
  `ChannelExecutionProposalComposerGate` 和 ownership resolver 的动作，均没有满足消费者清零
  和新 adapter 证据，明确不接入。

因此本轮只提交了可验证的审批接线修复；其余 WIP 继续留在受保护的原工作区，等待逐项审计，
不会用一次大合并掩盖不同设计之间的冲突。
