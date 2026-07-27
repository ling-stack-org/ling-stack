# P7B.5 Settings Workspace Tools Embedded Implementation Plan

> Status: `verified` on 2026-07-20. Current APIs, routes and domain pages were sufficient; no product decision or backend change was required.

## 1. Slice Contract

本切片迁移四个新登记 Function ID：

- `SETTINGS-EMBED-MODEL-001`
- `SETTINGS-EMBED-TEAM-001`
- `SETTINGS-EMBED-COUNCIL-001`
- `SETTINGS-OPEN-APP-001`

已 verified 的 `SETTINGS-BOUNDARY-001` 是依赖，不重复计数。本切片只建立 Settings shared embedded surface、
删除死 overview、收敛 scroll/overlay/return owner、补 focused E2E 和六张证据；业务页面保留给 P8/P9。

## 2. Authoritative Baseline

| Owner | Baseline |
|---|---:|
| `SettingsPage.tsx` | 344 lines |
| `SettingsWorkspaceToolsPanel.tsx` | 162 lines, zero production imports |
| `ProviderSettings.tsx` | 705 lines |
| `AiTeammatesPage.tsx` | 620 lines |
| `CouncilWorkspacePage.tsx` | 584 lines |
| `CouncilWorkspacePanels.tsx` | 698 lines |
| `settings.css` | 662 lines |
| dead workspace-tools selector family | about 220 lines |
| Provider/Teammate/Council CSS | 2,943 / 4,735 / 859 lines; business migration debt |

Confirmed behavior：

- `openSettingsWorkspaceTool` refreshes real domains and preserves the Settings return target.
- all three domain pages already accept `settingsToolMode` and hide their independent H1/description.
- Provider editor、Teammate create/role detail and Council create already expose Dialog semantics.
- internal Model/Teammate/Council switching stays in Settings; Open chat/channel leaves explicitly.

## 3. Module Boundaries

1. `SettingsWorkspaceToolSurface.tsx`：pure wrapper；`view/label/children` only；target `<100` lines。
2. `SettingsPage.tsx`：derive content class and wrap existing detail；no domain import/state expansion；keep `<400`。
3. `settings-workspace-tools.css`：boundary/scroll/containment only；target `<=140` lines；zero color declarations preferred。
4. `SettingsWorkspaceToolsPanel.tsx`：delete; no replacement overview。
5. `settings.css`：delete dead selector family in the same patch; no new Settings tool selectors。
6. Feature pages：retain existing `settingsToolMode`; no new business branch or callback。

## 4. Implementation Steps

### Step A: Documentation And Coverage

- completed before implementation: coarse module note is replaced by the zero-decision contract and this plan;
- completed before implementation: four non-overlapping IDs are registered as `designed`; `SETTINGS-BOUNDARY-001` stays verified;
- completed before implementation: focused spec/evidence/CSS/selector/motion entries are registered and Function IDs are mechanically recounted.

### Step B: Shared Embedded Surface

- add `SettingsWorkspaceToolSurface` with stable data owner and translated label metadata;
- render it only when both `workspaceToolView` and `workspaceToolDetail` are present;
- add `settings-content-stack--workspace-tool` without changing section/diagnostics states;
- do not clone child, inspect child classes, remount by arbitrary key or relocate portals.

### Step C: CSS Ownership And Dead Code Removal

- add focused boundary CSS after `settings-shell.css` in cascade order;
- make workspace-tool content and wrapper height/min-size/overflow stable;
- keep all control/color/domain visuals in existing owners;
- delete `SettingsWorkspaceToolsPanel.tsx` and all unique dead selector families from `settings.css`;
- verify `settings.css` only decreases and focused CSS has no literals/important/transition/keyframe/theme selector.

### Step D: Focused E2E

- build `ui2-settings-workspace-tools.spec.ts` on the existing mock daemon;
- cover three entries, cross-tool switches, active nav, absent app nav/H1/return row, one surface owner;
- cover Model editor、Teammate create、Council create Dialog with Esc/focus/overlay-root checks;
- cover exact Back and explicit Open chat/channel behavior;
- assert Settings/content/domain scroll ownership, 1440/1280/980 containment, console and long content.

### Step E: Existing Regression

- run shared package and Settings shell specs first;
- run Settings + Model suites, then Teammates + Councils, then App + Dark;
- update only stale structural locators; do not restore dead overview or duplicate H1 to satisfy tests.

### Step F: Browser Evidence And Closeout

- capture six target PNGs from the real Playwright-managed Vite server;
- inspect all at original size for double scroll, hard-coded light blocks in Dark, clipping, action wrapping and overlay collision;
- write `evidence/settings/workspace-tools-embedded/metadata.md` with source mode, fixture, console, overflow and SHA-256;
- update coverage/E2E/CSS/selector/motion/feedback matrices, README, status board and temporary controller;
- only then mark four IDs `verified`; automated green without evidence is at most `implemented`.

## 5. Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-workspace-tools.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts model-workbench.spec.ts model-workbench-productization.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts councils.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-shell.spec.ts app.spec.ts dark-mode.spec.ts
```

顺序运行，避免多个 Playwright server 抢占 `4174`。截图必须来自真实 Vite source server，不使用旧 dist、代码截图
或静态 HTML。

## 6. Stop Conditions

立即询问用户：

- 需要新增/改变 API、route、`ViewId`、Settings IA、业务状态机、权限或跨窗口安全边界；
- Open chat/channel 无法用现有 callback 保持真实目标和 exact return；
- 正确 overlay/scroll 只能通过复制 domain state、移动 Portal 或重写三个业务页面实现；
- 远端与本地 UI 2.0 对同一嵌入语义无法同时保留；
- 需要 destructive Git、提交、推送、PR、合并或服务重启。

其余 wrapper、focused CSS、死代码删除、测试 locator、证据和文档问题由本切片连续完成。

## 7. Closeout Record

- Added the 24-line `SettingsWorkspaceToolSurface` and 27-line focused boundary CSS.
- Deleted `SettingsWorkspaceToolsPanel.tsx` and about 226 lines of unique dead CSS; `settings.css` is 436 lines.
- Migrated Provider Editor and Teammate Role detail to the shared Dialog/Portal contract.
- Fixed Provider right-sheet transform containment and long-list header shrink without changing shared Dialog or domain state.
- Passed `@ling-stack/ui-react` `41/41`, selected browser regression `88/88`, and final focused evidence `7/7`.
- Captured and inspected six real Vite screenshots; metadata and hashes are in
  [`../../evidence/settings/workspace-tools-embedded/metadata.md`](../../evidence/settings/workspace-tools-embedded/metadata.md).
- All four P7B.5 Function IDs are `verified`; the next slice is P7C.1 ThemePicker import/delete/preview.
