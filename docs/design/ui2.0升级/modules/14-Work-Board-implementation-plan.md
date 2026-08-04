# Work Board 重新开放实施计划

Status: pending; released navigation remains hidden

## Goal

基于现有 Task、Run、Approval、Workflow、External Work 和 durable WorkItem API，重新验收并开放 workspace
级 Work Board。不得恢复旧入口或仅因保留代码存在就宣称功能可用。

## Required Work

1. **Authority audit**
   - 核对各 source 当前 API、上限、状态和 ID；确认 projection 不依赖 selected channel。
   - durable item 覆盖同 source derived row，禁止标题猜测去重。
   - capped、partial、stale 和缺失 source 不得显示全量或健康结论。

2. **Controller and races**
   - 建立 workspace read projection、request identity guard、selection repair 和 retained refresh。
   - busy/error 绑定 `itemId + action`；旧请求不能覆盖新 scope、selection 或 mutation。
   - 不创建第二份 Task/Run/Approval store，不改变状态机或自动启动 Run。

3. **Product surface**
   - 实现搜索、真实状态筛选、紧凑分组列表、唯一主状态、按需 Inspector 和明确下一步。
   - initial empty、no-result、selected missing、long list、capped/stale 和 mutation failure 独立呈现。
   - Channel 只复用同一 projection 的过滤结果；私聊创建 Task 后只导航，不自动执行。

4. **Actions**
   - claim/heartbeat/release/complete/fail 只使用 durable WorkItem 既有能力。
   - Approval、Run、Task、Channel 和 External Work 导航到真实 owner，不复制审批、诊断或编辑界面。
   - destructive/failure 流程使用共享 Dialog/InlineFeedback，保留权威数据和用户输入。

5. **Release gate**
   - Web typecheck、i18n、lint、focused Work Board 与相关回归通过。
   - 真实浏览器验证 `1440x960` Light、`1280x800` Dark、键盘、reduced motion、内部滚动、console。
   - 证据进入 CI/Release artifacts。全部通过后再恢复 Sidebar 入口并更新本合同状态。

## Hard Stops

- 需要新增数据库、第二套 ledger、route、权限或审批引擎。
- 只能依靠 selected-channel 数据伪装 workspace 全量。
- 需要在 Board 内复制完整 Run/Approval/Task 能力或弱化服务端状态约束。
