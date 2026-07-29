# P7A.3 Default Authorization Implementation Plan

Status: `verified` on 2026-07-20. Slice owner: P7A.3.

## Scope

只迁移 Settings 当前真实可达的两个默认授权选择：

- `SETTINGS-AUTH-PRESET-001`：Authorization mode 与 Workspace access 的选择和键盘操作。
- `SETTINGS-AUTH-EFFECTIVE-001`：当前解析值及所选项后果摘要。

以下模块文档候选没有生产入口，本切片保持 `inventory`：

- `SETTINGS-AUTH-TOOLS-001`
- `SETTINGS-AUTH-PATHS-001`
- `SETTINGS-AUTH-RUNNER-001`
- `SETTINGS-AUTH-ADVANCED-001`

不新增 API、contract、数据库字段、Settings section、权限模式、Runner、write path 或 policy editor 入口。

## Current Audit

- `ExecutionPermissionsSettingsPanel.tsx` 约 104 行，只接收 AppShell 已派生的两组设置和 callback。
- 当前唯一可见控件是两次 `RichChoiceSelect`；该组件只有本页一个调用方，自建 listbox、outside listener、
  focus timer 和 CSS popover，不属于 UI 2.0 shared primitive。
- 当前 `settings.spec.ts` 明确断言 Tool permission policy、Execution runners、Advanced workspace policy
  和 Effective permissions 不可见。
- `AdvancedWorkspacePolicyEditor.tsx` 没有 production import，不能作为可达产品能力或迁移完成证据。
- callback 类型为同步 `void`；当前没有真实 row-level saving/error 状态，不能用 timeout 伪造。

## Target Structure

```text
Default Authorization
  DataRow
    Authorization mode
    selected consequence
    SegmentedControl [Ask | Smart | Always]
  DataRow
    Workspace access
    selected consequence
    SegmentedControl [Read only | Workspace | Full]
```

- 页面不渲染重复 H2、说明卡、彩色状态或高级入口。
- 每组显示当前选择的一条后果说明，不同时铺开三段灰字。
- SegmentedControl 使用现有 AuthorizationMode/WorkspaceAccessMode 值，不生成 UI 专用枚举。
- `resolveAuthorizationMode` 和 `resolveWorkspaceAccessMode` 继续兼容 legacy permission values。

## Module Boundaries

- `ExecutionPermissionsSettingsPanel.tsx`：纯展示 adapter；翻译选项、解析当前值、调用既有 callback。
- `SettingsPage.tsx`：保持现有 props 接线，不新增展示或状态逻辑。
- `AppShell.tsx` / workspace settings controller：保持现有持久化、legacy mapping 和错误所有权。
- `settings-default-authorization.css`：仅拥有两行布局、长文案和窄 Desktop 约束。
- `ui2-settings-authorization-personalization.spec.ts`：状态、键盘、截图和 overflow owner。

## Implementation Order

1. 在覆盖矩阵把 coarse `SETTINGS-AUTH-001` 拆为可达与未接线 Function ID。
2. 新增 focused spec，先锁定真实两项、禁止高级入口、键盘和持久化语义。
3. 将两组选择迁到 shared DataRow + SegmentedControl。
4. 删除 `RichChoiceSelect.tsx`、barrel export 和 `.rich-choice-*` CSS；保留 native Select adapter。
5. 将 `.settings-global-approval-card/.settings-decision-*` 从 `settings.css` 迁到 focused CSS 并删除源 owner。
6. 跑 package/static/focused/Settings/Dark 回归和真实 Vite 双主题双 viewport 验收。
7. 回写 evidence、覆盖、E2E、CSS、selector 和状态看板。

## State Matrix

| State | Trigger | Required result |
|---|---|---|
| resolved default | open Settings with legacy/current values | current mode and access are selected without transient fallback |
| pointer select | click another segment | exactly one existing callback fires and state persists |
| keyboard select | focus group and use arrows | visible focus, one selected item, persisted value follows focus contract |
| current consequence | selection changes | one concise consequence updates with no layout jump |
| long English | fixed 1280 viewport | labels remain horizontal; consequence wraps without document overflow |
| Dark | fixed `ling-dark` | package tokens control selected/focus/hover; no hard-coded light panel |
| disabled | no truthful upstream state exists | N/A; do not invent disabled or busy state |
| save error | callback exposes no local result | existing global owner remains authoritative; no fake success or spinner |

## Tests

- focused: `ui2-settings-authorization-personalization.spec.ts`。
- regression: `settings.spec.ts`、`ui2-settings-shell.spec.ts`、`ui2-form-controls.spec.ts`、
  `ui2-navigation-overlays.spec.ts`、`dark-mode.spec.ts`。
- screenshots: 1440x960 `ling-light` and 1280x800 `ling-dark` changed selections。

## Exit Gate

- Production contains no `RichChoiceSelect` import or `.rich-choice-*` selector。
- Default Authorization only exposes the two current product choices。
- Shared SegmentedControl/DataRow own control visuals and keyboard behavior。
- `settings.css` decreases and focused CSS has zero color literals、`!important`、theme/profile selector、
  `transition: all`、private keyframe or package-private selector。
- API、authorization values、legacy mapping and persistence semantics are unchanged。
- Focused E2E、selected regression、real Vite evidence and metadata all pass before status becomes `verified`。

## Closeout Evidence

- Both reachable decisions use shared `DataRow` and `SegmentedControl`; pointer and keyboard persistence are verified.
- `RichChoiceSelect.tsx`, its export and `.rich-choice-*` selectors were deleted.
- Focused `settings-default-authorization.css` is 48 lines; `settings.css` decreased from 2,899 to 2,656 across P7A.3.
- Shared package `40/40`, focused P7A.3 `5/5` and final selected browser regression `33/33` passed.
- Light `1440x960` and Dark/reduced-motion `1280x800` screenshots, hashes, console and overflow results are recorded in
  [P7A.3 evidence](../../evidence/settings/settings-authorization-personalization/metadata.md).
- `SETTINGS-AUTH-PRESET-001` and `SETTINGS-AUTH-EFFECTIVE-001` are `verified`; the four unreachable candidates remain
  `inventory`.

## Hard Stops

- Do not import or expose `AdvancedWorkspacePolicyEditor`。
- Do not add Runner、write path、tool decision or effective-policy API。
- Do not add saving/error UI without a real observable result from the existing controller。
- Do not modify `AppShell.tsx` beyond unavoidable existing prop wiring。
