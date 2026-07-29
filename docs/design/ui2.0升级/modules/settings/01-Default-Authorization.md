# Default Authorization

Implementation plan: [P7A.3 Default Authorization](01-Default-Authorization-implementation-plan.md).

## Goal

默认授权页面管理当前真实可达的 Authorization mode 与 Workspace access。高级工具决策、write paths、
Runner readiness 和 raw policy 当前没有生产入口，保持 future inventory，不因视觉升级重新接线。

## Function Points

- `SETTINGS-AUTH-PRESET-001`：授权模式和 workspace access 预设，P7A.3 可达范围。
- `SETTINGS-AUTH-EFFECTIVE-001`：解析后的当前值和所选项后果摘要，P7A.3 可达范围。
- `SETTINGS-AUTH-TOOLS-001`：工具权限决策。
- `SETTINGS-AUTH-PATHS-001`：write paths。
- `SETTINGS-AUTH-RUNNER-001`：Runner 名称、启用、可用性和主行动。
- `SETTINGS-AUTH-ADVANCED-001`：raw id、fallback、blocking reason 和 policy preview。

后四项没有生产 trigger、route 或 E2E，不能随 P7A.3 标记实现。

## Layout

两组当前选择使用紧凑 DataRow + SegmentedControl，不用大卡片或自建 listbox。每组默认层只显示字段、
当前选择和一条必要后果说明。未来 Runner/raw policy 的布局必须等独立业务入口获批后再执行。

## States

P7A.3：resolved default、pointer/keyboard selected、effective changed、long content、Light/Dark。
当前 callback 不暴露 row-level saving/error，禁止伪造。Runner/paths/advanced 状态为不可达候选。

## Tests

`ui2-settings-authorization-personalization.spec.ts`、`settings.spec.ts`、`dark-mode.spec.ts`。
验证两个预设、键盘、持久化、隐藏高级入口和无横向滚动。
