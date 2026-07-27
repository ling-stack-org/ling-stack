# Council Workspace

## Goal

Council 页面统一列表、成员、频道接入和设置，显示真实 readiness 与关系状态，不成为另一套
独立聊天引擎。Ling Agent 继续是协调者，不新增 Leader 实体。

## Function Points

- `COUNCIL-LIST-001`：列表、置顶、状态和健康摘要。
- `COUNCIL-CREATE-001`：创建名称、描述、成员和 routing mode。
- `COUNCIL-MEMBERS-001`：添加、删除、启停、排序和可证明的 readiness 配置状态。
- `COUNCIL-CHANNELS-001`：频道选择、接入、移除和打开应用频道。
- `COUNCIL-SETTINGS-001`：名称、描述、状态、Clone、Archive。
- `COUNCIL-RUNTIME-001`：成员运行、审批、失败和恢复摘要。

## Layout

左侧 compact list，右侧 Details Tabs：Members、Channels、Settings。频道接入空态横向排版，
不出现竖排文字或超大空框。Settings 嵌入态去除重复页面标题。

## Actions

成员行只显示状态和一个主行动；排序/移除为 icon/menu。`Open channel in app` 是显式离开
Settings 的行动。Clone、Archive 放低频区。

## States

no council、no selection、paused、archived、no members、member unavailable、no channels、
attach saving、partial ready、member failed、waiting approval。

## Components And Tests

DataRow、Tabs、Dialog、Select、StatusIndicator、InspectorSection、EmptyState。运行投影若当前
API 不足，标 blocker，不能前端猜测。`councils.spec.ts`、`settings.spec.ts`、`ling-light` / `ling-dark`。

## Council A Progress

- `COUNCIL-CREATE-001`：`verified`。Create 成员/routing、零成员二次确认、Clone 审阅、busy/失败、超过
  100 条列表的 detail 权威确认和源成员/routing 漂移复核均有 focused E2E 与真实页面证据。
- `COUNCIL-LIST-001`：`verified`。Search/Health filter、显式 selection、单一主状态、partial report 防误报、
  retained refresh、empty/no-result、长列表滚动和 Settings 嵌入态已有 focused E2E 与五张真实页面证据。
- `COUNCIL-MEMBERS-001`：`verified`。自定义 Council 使用成员 GET preflight/整组 PUT 完成添加、移除、
  启停和展示排序；builtin/template 只读并引导 Clone。readiness 只来自成员配置和完整、新鲜的 Health
  report，不把顺序或 enabled 状态解释为运行事实。Focused `9/9`、List/Create `13/13`、旧 Council
  `2/2`、Settings workspace-tools `7/7` 和六张原图证据通过。
- `COUNCIL-CHANNELS-001`：`verified`。频道目录、接入/首选/解除、paused/archived removal-only、retained
  stale、row failure、GET/PUT identity race、100 行和真实 Open Channel 已迁移到 UI2 focused owner；focused
  `7/7`、Council/Settings/Dark selected `40/40` 和六张原图证据通过，只展示配置与关系事实，不声明 Council
  runtime provenance。
- `COUNCIL-SETTINGS-001`：`verified`。自定义 Council draft/reset/save、Pause/Resume、projection repair、managed
  read-only、Archive Portal/busy/failure/success、policy cleanup、no Delete 和 100 行边界已有 focused `7/7`、
  selected `66/66` 与六张原图证据。
- `COUNCIL-RUNTIME-001`：保持 inventory。现有数据没有稳定 Council 运行来源，不新增 provenance/API/字段，
  也不从一般 Runs 猜测 Council 正在运行。

List/Health 详细合同、实施计划和证据分别见 `08-Council-List-Health-A.md`、
`08-Council-List-Health-A-implementation-plan.md` 和 `evidence/features/council-list-health/metadata.md`。

Members A 的合同、实施结果和证据见 `08-Council-Members-A.md`、
`08-Council-Members-A-implementation-plan.md` 与 `evidence/features/council-members/metadata.md`。
Channels A 的合同、实施计划和证据见 `08-Council-Channels-A.md`、
`08-Council-Channels-A-implementation-plan.md` 与 `evidence/features/council-channels/metadata.md`。
Settings/Archive 的合同、实施计划和证据见 `08-Council-Settings-Archive.md`、
`08-Council-Settings-Archive-implementation-plan.md` 与
`evidence/features/council-settings-archive/metadata.md`。`COUNCIL-RUNTIME-001` 继续保持 inventory。
