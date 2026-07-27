# External Work

Implementation plan: [P7A.5 External Work](04-External-Work-implementation-plan.md).

Verified on 2026-07-20: P7A.5 migrated the reachable status、workflow、credential、operations and count summary
surface. Workflow deletion and a full Settings record list remain absent because no truthful API/surface exists.

## Goal

External Work 默认层显示连接/工作流状态、主行动和需处理事项。token、secret、raw workflow
和 audit evidence 进入正确的安全层级。

## Function Points

- `SETTINGS-EXTERNAL-STATUS-001`：整体 readiness 和刷新。
- `SETTINGS-EXTERNAL-WORKFLOW-001`：创建、修复和查看 workflow 状态。
- `SETTINGS-EXTERNAL-TOKEN-001`：token storage 状态和修复。
- `SETTINGS-EXTERNAL-SECRET-001`：secret 创建、更新和删除。
- `SETTINGS-EXTERNAL-OPERATIONS-001`：Poll、Reconcile、GitHub background start/stop。
- `SETTINGS-EXTERNAL-RECORD-001`：records、CI triage 和 actions 的计数摘要。
- `SETTINGS-EXTERNAL-ERROR-001`：连接、权限和验证失败。
- `SETTINGS-EXTERNAL-WORKFLOW-DELETE-001`：未来 workflow 删除能力；当前无 endpoint，保持 absent。

## Layout

summary-first DataRows。Secret 不显示值；创建/更新使用就地渐进表单，永久删除使用 Dialog。删除确认贴近
对象并说明影响。Settings 只显示 status response 的 count summary；CI triage 和 records 的完整列表继续归
Channel Activity，不使用静态 fixture 或无目标跳转伪装深层页面。

## States

no channel、loading、load failed、unconfigured、partial、ready、checking、workflow missing/invalid、
token missing/invalid/unavailable、secret busy、delete confirmation、GitHub background running/stopped/failed、
Linear background unsupported、operation error、long/localized、reduced motion。

## Tests

`ui2-settings-external-work.spec.ts`、`settings.spec.ts`、`ling-light` / `ling-dark`。覆盖 token/secret 全流程、
scoped busy/error、Dialog Esc/focus、键盘、overflow、summary truthfulness 和 Settings shell。

Evidence: [P7A.5 External Work](../../evidence/settings/external-work/metadata.md). Seven reachable Function IDs
are `verified`; `SETTINGS-EXTERNAL-WORKFLOW-DELETE-001` remains `inventory`.
