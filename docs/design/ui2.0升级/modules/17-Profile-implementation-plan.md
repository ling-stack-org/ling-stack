# P7A.2 Settings Profile Implementation Plan

Status: `verified` on 2026-07-20. Evidence: [P7A.2 Settings Profile](../evidence/settings/settings-profile/metadata.md).

## Scope

只迁移 Settings 内的 Profile identity、avatar crop、usage insight 和 reachable states。Standalone Profile
继续保留现有业务入口；本切片不把 standalone dashboard 视觉扩展为 Settings 的验收范围。

Function IDs：

- `SETTINGS-PROFILE-001`
- `PROFILE-IDENTITY-001`
- `PROFILE-AVATAR-001`
- `PROFILE-NAME-001`
- `PROFILE-INSIGHT-001`
- `PROFILE-EMPTY-001`

`PROFILE-TOAST-001` 已 verified，只作为全局反馈回归基准。

## Current Audit

- `ProfileSettingsSurface.tsx` 为 296 行，产品结构已符合“身份编辑优先、使用洞察次级”，但仍手写头像、
  编辑按钮、名称 Input、三段切换、技能 row 和空态。
- `AvatarCropDialog.tsx` 为 290 行，自建 backdrop、global `window.keydown`、outside click、close/action
  button，并硬编码中文；focus trap、focus restore、busy dismiss 和 overlay root 没有共享合同。
- 初次 Profile 请求只设置 page loading boolean，Settings surface 没有 Skeleton 或 `aria-busy`，加载期间会
  暂时显示默认 identity/empty insight。
- `profile-settings.css` 为 324 行，但头像、heatmap、segmented、skill row 和 crop 仍依赖
  `profile.css`；后者包含硬编码 Heatmap Light/Dark 色和 `data-theme=dark` selector。
- `profile.spec.ts` 已覆盖名称 blur 保存、Toast timeout、avatar crop 输出和 identity propagation，但没有
  Settings loading、save failure、crop Esc/focus restore、long data、shared primitive 或双主题截图证据。

## Module Boundaries

- `ProfilePage.tsx`：保留 API、run/skill metrics、save rollback 和 Settings/standalone variant 接线；只新增
  `loading/loaded` 展示 props，不放新视觉结构。
- `ProfileSettingsSurface.tsx`：Settings presentation owner；使用 shared IconButton/Input/SegmentedControl/
  DataRow/EmptyState/Skeleton/InlineFeedback，不 import API 或 domain client。
- `AvatarCropDialog.tsx`：图像 decode、zoom、pointer drag、canvas export；overlay/focus/Esc/outside/busy/action
  使用 shared Dialog/Button/InlineFeedback。
- `profile-settings.css`：Settings identity、summary 和 stable geometry，目标 `<=360` 行。
- `profile-settings-activity.css`：Settings heatmap、streak 和 skill layout，目标 `<=220` 行。
- `profile-crop-dialog.css`：crop stage/range/domain geometry，目标 `<=190` 行；Dialog chrome 归 package。
- `ui2-settings-profile.spec.ts`：P7A.2 reachable states 和截图 owner；旧 `profile.spec.ts` 只保留业务回归。

不新增 API、contract、数据库字段、route、`ViewId`、Settings ID、profile shape 或 metrics 计算。

## Implementation Order

1. 新增 focused spec，锁定 initial loading、identity、inline name、avatar Dialog、loaded/empty/long usage、
   save failure、Light/Dark、1440/1280/980、console 和 overflow。
2. 将 Settings avatar/edit/name/activity switch/skill/empty/loading 迁到 shared primitives；保留稳定产品 ARIA。
3. 将 Avatar Crop 迁入 shared Dialog，删除 global Esc 和手写 backdrop；busy 时不可 dismiss，关闭恢复 avatar
   trigger focus。
4. 把 Settings-only activity 与 crop selector 从 `profile.css` 依赖中拆出；迁一组删一组，不复制旧视觉。
5. 补齐 crop 中英文，禁止把产品判断写进 locale。
6. 跑 package/static/focused/Profile/Settings/Feedback/Dark/Dialog/overlay 回归。
7. 真实 Vite 采 1440 Light identity/edit、1280 Dark crop/error/empty 和 980 long-data changed-state；写
   metadata 并回填 coverage/E2E/CSS/selector/motion/feedback/status。

## State Matrix

| State | Trigger | Required result |
|---|---|---|
| initial loading | open Profile before GET resolves | stable identity/usage Skeleton, no fake empty state |
| loaded | GET profile/runs/skills succeeds | avatar/name/read-only handle and secondary insight visible |
| load error | profile request fails | persistent content InlineFeedback; Settings navigation remains usable |
| name editing | Edit display name | shared Input focused/selected; external geometry stable |
| name saving | blur or Enter | local busy, one PATCH, editor exits; success uses existing global Toast |
| name cancel | Escape | draft discarded, no PATCH, focus returns to edit action |
| name save failure | PATCH fails | previous name restored and persistent InlineFeedback remains near Profile |
| avatar choose | camera action/file input | image file opens crop Dialog; invalid file stays inline |
| crop open | valid image | shared Dialog, focus trap, zoom and drag available |
| crop close | Cancel/Esc/outside | no save, focus restores to avatar action |
| crop confirm | Use avatar | circular transparent output, one PATCH, success Toast or persistent failure |
| insight loaded | runs/skills exist | four metrics, activity range, heatmap, streak and max five skill rows |
| insight empty | no runs/skills | one compact shared EmptyState, no empty dashboard wall |
| long data | long model/skill labels | truncate with accessible title, no column or document overflow |
| resize/theme | 1440/1280/live 980, Light/Dark | same hierarchy, semantic tokens, no hard-coded light surface |

## Exit Gate

- Settings Profile contains no hand-written visible Button/Input/Segmented/EmptyState/DataRow equivalent.
- Avatar crop uses the shared application overlay root and Radix Dialog dismissal/focus contract.
- Initial loading cannot masquerade as a real empty Profile.
- Username remains read-only; no save/reset footer, refresh, preview or text avatar button returns.
- Global Profile Toast remains the only transient success owner; errors persist inline.
- Settings Profile does not depend on standalone avatar/segmented/skill/crop selector ownership from `profile.css`.
- Focused CSS has zero color literals, `!important`, Theme/Profile ID selector, `transition: all`, private overlay
  keyframe or package-private class selector.
- New/focused production files stay below 800 lines; `ProfilePage.tsx` does not absorb presentation JSX.
- Package/static/focused/selected regressions and real-page evidence pass before Function IDs become `verified`.

## Hard Stops

- Do not change profile save semantics, handle editability, avatar encoding limits or metrics calculation.
- Do not add a separate analytics page or Profile tab.
- Do not modify AppShell business logic, daemon routes, storage or workspace identity propagation.
- Do not rewrite standalone Profile as part of Settings migration.
- Do not reintroduce a local Toast viewport, timer, browser alert, custom Dialog Esc listener or hard-coded theme branch.

## Completion Record

- [x] Shared identity/input/segmented/data/empty/loading primitives replace Settings hand-written equivalents.
- [x] Avatar crop uses shared Dialog, one-Esc dismissal, non-destructive initial focus and explicit trigger restore.
- [x] Loading, empty, load error, save failure, invalid file, long labels and locale formatting are covered.
- [x] Legacy crop and embedded Profile selectors were deleted while focused CSS stayed within line budgets.
- [x] Package/static/focused/Profile/selected regressions passed.
- [x] Four real Vite screenshots were dimension/hash checked and inspected at original resolution.
- [x] Six P7A.2 Function IDs moved to `verified`; standalone dashboard migration remains separate.

## P11.4 Regression Supplement

Date: 2026-07-23. Status: `verified`.

### Regression Boundary

- No design rebuild and no API, database, route, storage, locale, AppShell or standalone Profile expansion.
- Production Profile components and CSS stay unchanged unless the regression suite proves a real defect.
- `ui2-settings-profile.spec.ts` remains the focused state/evidence owner; `profile.spec.ts` remains the legacy
  business and identity-propagation regression owner.
- Evidence capture is delta-only: retain the four valid P7A.2 PNGs and add only missing current Toast and avatar
  save-error states.

### Added Coverage

- Name: keyboard entry, focused Input containment, blur autosave, observable loading/disabled action, success and
  global three-second Toast dismissal; existing failure rollback remains persistent inline.
- Avatar: real file chooser, crop initial focus, Cancel and trigger focus restore, invalid file, successful circular
  export in legacy coverage, failed crop save rollback and persistent error without a success Toast.
- Insight: default-expanded contract, keyboard SegmentedControl, loading/empty/data/long-skill states and bounded
  heatmap/rows.
- Cross-theme: 1440x960 fixed `ling-light`; 1280x800 fixed `ling-dark` with reduced motion; theme-token equality,
  console cleanliness, input containment and document root overflow are asserted.

### Verification Record

- Independent source/Vite port: `4197`; Playwright `workers=1`; all groups run serially.
- Focused `ui2-settings-profile.spec.ts`: `6/6`.
- Legacy `profile.spec.ts`: `3/3`.
- Settings `settings.spec.ts`: `17/17`.
- Dark `dark-mode.spec.ts`: `2/2`.
- Final regression total: `28/28`; delta evidence capture: `2/2`.
- Web UI 2.0 lint guards passed. Full Web typecheck was attempted but is currently blocked by the out-of-scope
  `WorkBoardInspector.tsx:78` `string | undefined` to `string` error; P11.4 did not modify the prohibited Work Board
  owner.
- No production defect was found, so no Feature or CSS fix was made.
- Focused spec is 478 lines; all Profile production files remain below 800 lines and existing module boundaries remain
  intact.

### U13 Handoff

- [x] Removed the `strict-console.css` `:root[data-theme="dark"] .profile-page` compatibility selector while retaining
  parent shell theme ownership.
- [x] Added stable Settings Profile identity/usage/name/summary data contracts and migrated the four historical E2E
  owners away from key Profile visual classes.
- [x] Preserved all active standalone selectors in `profile.css`; no prefix-based bulk deletion was performed.
- [x] Original cross-module stale Model Workbench empty-state locator was updated to the current shared EmptyState;
  exact repeat `3/3` and final selected regression `32/32` passed.
