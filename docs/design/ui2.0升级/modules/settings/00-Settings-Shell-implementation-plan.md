# P7A.1 Settings Shell Implementation Plan

Status: `verified` on 2026-07-20. Evidence: [P7A.1 Settings Shell](../../evidence/settings/settings-shell/metadata.md).

## Scope

只迁移 Settings 壳层、导航、返回、内容边界和 embedded context。Default Authorization、Profile、
Personalization、Interface、External Work、MCP、Skill、Archived、Diagnostics 的领域内容保持当前行为，
后续逐 section 迁移。

## Module Boundaries

- `settings-shell-model.ts`：`SettingsSectionId`、section group/item 类型、静态 Lucide 映射和纯 helper。
- `SettingsShell.tsx`：纯展示 navigation/content composition，只接收已翻译 label、active ID、callbacks 和节点。
- `SettingsPage.tsx`：保留 active/workspace-tool/run-diagnostics 派生和领域 panel 接线，不继续拥有导航 JSX。
- `settings-shell.css`：Settings fullscreen、双列、双滚动、Button slot、active/hover/focus、resize owner。
- `ui2-settings-shell.spec.ts`：新行为和截图 owner；`settings.spec.ts` 只作为业务回归基准。

不新增 API、contract、数据库、`ViewId`、Settings ID、路由或 Desktop capability。

## Implementation Order

1. 新增 focused spec，先锁定 shell boundary、12 个入口、shared Button、scroll、Back 和 embedded tool。
2. 抽 `settings-shell-model.ts`，更新 AppShell 的 type import，不改变 ID 字符串。
3. 新增 `SettingsShell.tsx`，将 SettingsPage 导航 JSX 和外层 composition 迁入。
4. 新增 `settings-shell.css`，从 `settings.css` 与 `sidebar.css` 删除已迁 selector；在 legacy aggregate
   之后加载 focused owner。
5. 跑 package、Web static、focused、Settings/App/Dark/overlay 回归。
6. 用真实 Vite dev server 采 `1440x960 ling-light`、`1280x800 ling-dark`、`980x680` changed-state 图。
7. 写 metadata，回填覆盖、E2E、CSS、selector、motion、feedback 和状态看板。

## State Matrix

| State | Trigger | Required result |
|---|---|---|
| default | Settings from app | User profile active, app Sidebar absent |
| initial section | contextual Settings entry | requested local section active |
| workspace tool | Model/Teammate/Council item | tool stays inside Settings shell |
| run diagnostics | open from Startup | Diagnostics active, Back/Close semantics preserved |
| page error | failing section request | error remains in content owner, navigation usable |
| long navigation | short viewport | nav scrolls independently, active item reachable |
| long content | Skill/Diagnostics | content scrolls independently, document remains fixed |
| Back | from channel/management/tool | exact prior view and selection restored |
| resize | 1440x960 -> 980x680 | no overlap, horizontal overflow or remount |
| Dark | fixed `ling-dark` | semantic tokens only, no hard-coded light surface |

## Exit Gate

- `SettingsPage.tsx` decreases and contains no navigation button JSX.
- `settings.css` and `sidebar.css` only decrease; focused CSS is the sole Shell owner.
- All 12 actions are shared UI Buttons with one `aria-current=page`.
- navigation/content are the only Settings vertical scroll owners; document overflow is absent.
- embedded tools and diagnostics do not restore the main Sidebar or add an inner return row.
- package/static/focused/selected regression and real-page screenshots pass.
- Only P7A.1 Function IDs may move to `verified`; section-specific IDs remain open.

## Completion Record

- [x] focused shell spec added before closeout and kept outside the legacy 1,000-line Settings spec.
- [x] model and pure presentation shell extracted; `SettingsPage.tsx` reduced to 329 lines.
- [x] 12 section actions and Back migrated to shared Button.
- [x] Shell/navigation/content selectors moved to 211-line focused CSS and deleted from legacy owners.
- [x] i18n, typecheck, import/overlay guards, package tests and `git diff --check` passed.
- [x] focused `2/2`, Settings/conversation contract `23/23` and selected regression `65/65` passed.
- [x] four real Vite screenshots were dimension/hash checked and inspected at original resolution.
- [x] only Shell/Content/Back/Boundary moved to `verified`; section and deep-state IDs remain open.

## P5 Documentation Closeout

P7A.1 完成时 Subnav/Overlay 尚未逐面核验；后续所有 Settings section focused slices 已提供足够证据，
因此 P5 只做 reachability 和账本收口：

- [x] `SETTINGS-SUBNAV-001` 收窄为 Skill Library / Archived Items 的真实 Subnav；未使用的 description
  不纳入合同，也不恢复说明文字。
- [x] `SETTINGS-OVERLAY-001` 收窄为当前 19 Dialog / 4 Menu；Drawer/Popover 为 0，不伪造完成状态。
- [x] open、Esc、focus restore、busy dismiss、retained error、nested、overflow、Dark、reduced motion、i18n
  映射到既有 Profile/Theme/External/MCP/Skill/Archive/Model/Teammate/Council evidence。
- [x] modal 内 section switch 判为不可达；inline details/Inspector 不重复计入 overlay。
- [x] 两个 ID 只更新文档为 verified；不修改 code/CSS/E2E/PNG/metadata、Settings IA 或业务行为。
