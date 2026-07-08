# Settings Full-Surface Productization P10 Implementation Plan

## Related Docs

- [P10 Design](settings-full-surface-productization-p10.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)
- [Settings Interaction Depth P9](settings-interaction-depth-p9.md)
- [Ling Design System](ling-design-system.md)
- [Ling Design System P11 Implementation Plan](ling-design-system-p11-implementation-plan.md)

## Summary

Implement P10 by evidence slice. The first blocker is the Settings shell
boundary: run diagnostics opened from Settings must not switch into the main
app shell. After that, each screenshoted Settings page gets a concrete visual
and interaction fix.

## Navigation Matrix

| Surface | Action | Intended result |
| --- | --- | --- |
| Startup and diagnostics | Open Run Diagnostics | `open-settings-diagnostic`; stay in Settings. |
| Model Workbench | Open repair run | `open-settings-diagnostic`; stay in Settings. |
| Work Board | Select row | `stay-settings`; update inspector. |
| Work Board | Open run / View failure | `open-settings-diagnostic`; stay in Settings. |
| Work Board | Open task/channel/approval | `open-in-app-explicit`; label must include `in app`. |
| Council Workspace | Open AI Teammates / Manage teammates | `open-settings-tool`; stay in Settings. |
| Council Workspace | Open channel | `open-in-app-explicit`; label must include `in app`. |
| Teammate Management | Open chat | `open-in-app-explicit`; label must include `in app`. |
| External Work | View records / View CI triage | `stay-settings`; switch local Settings tab/inspector. |
| Any Settings page | Back to app | leave Settings. |

## Implementation Slices

1. **P0 shell boundary**
   - Add a Settings-owned run diagnostics surface that renders inside
     `SettingsPage`.
   - Route `Open Run Diagnostics` and Settings-owned run links to that embedded
     surface instead of `setActiveView("runs")`.
   - Add e2e assertions for `Settings sections` visible and
     `Ling Stack navigation` absent.

2. **P1 Council Workspace**
   - Fix channel access empty-state layout and remove oversized blank panels.
   - Tighten Settings-mode council settings to summary-first form layout.
   - Rename channel exit action to `Open channel in app`.

3. **P1 Work Board**
   - Keep row selection inside Settings.
   - Open run details in Settings diagnostics.
   - Rename work-object exits to explicit `Open ... in app`.

4. **P2 Default authorization**
   - Compact permission presets and effective summary.
   - Keep tool decisions, write paths, fallback internals, runner ids, and
     readiness blockers in details.

5. **P2 Skill Library**
   - Reduce Source sync and Review queue empty/default states.
   - Keep path, checksum, diff, context findings, and health evidence in
     disclosures.

6. **P3 Archived and Startup**
   - Keep Archived restore/delete rules as a single muted hint below the title.
   - Give each archived category its own scroll boundary so long lists do not
     stretch the Settings page.
   - Tighten Startup status and embedded diagnostics entry.

## Screenshot Task Checklist

| Evidence | Components | UI change | Navigation rule | E2E assertion |
| --- | --- | --- | --- | --- |
| Fig. 1 | `CouncilWorkspacePanels`, `councils.css` | Compact channel empty state; selector, attach, open-channel controls stay legible. | Attach stays; channel exit is `Open channel in app`. | Channel usage button label includes `in app`; no vertical empty-state text in browser QA. |
| Fig. 2 | `CouncilWorkspacePanels` | Settings-mode settings tab hides standalone page chrome; clone/archive move to low-frequency disclosure. | Save/clone/archive stay in Settings. | Settings Council Workspace has no H1/description; `Create council` only appears once. |
| Fig. 3 | `GlobalWorkBoardPage`, `WorkItemRow`, `AppShell` | Row selection updates detail; run action opens Settings diagnostics; work-object exits are explicit. | Run stays; task/channel/approval leave only with `in app` label. | Work Board run action shows `.settings-run-diagnostics-panel` and no `Ling Stack navigation`. |
| Fig. 4 | `ExecutionPermissionsSettingsPanel` | Compact presets and effective summary; advanced policy details are not forced open. | Policy save stays. | Raw workspace policy details are hidden until details expansion. |
| Fig. 5 | `ExecutionPermissionsSettingsPanel` | Runner rows show summary first; raw defaults move into `Current runner defaults`. | Runner actions stay. | Raw runner blockers remain accessible but not first-screen default. |
| Fig. 6 | `SkillLibraryWidgets`, `SkillLibrarySettingsPanel` | Source sync default layer hides root/path and health evidence behind details. | Sync preview/publish stay. | Source evidence details contain diff/checksum; row summary does not. |
| Fig. 7 | `SkillReviewQueuePanels`, `SkillLibrarySettingsPanel` | Review queue and health diagnostics are folded/compact by default. | Review actions stay. | Health panels are not visible on Skills list and details are closed by default. |
| Fig. 8 | `ArchivedSettingsPanel` | Rules become one muted hint below the title; each archived category gets an internal scroll boundary; row actions align icon/label centers. | Restore/delete stay. | Hint is visible without a disclosure/card, no footer rule block remains, all four lists scroll when long, and action icon/label center delta stays small. |
| Fig. 9 | `MaintenanceSettingsPanel` | Startup readiness keeps only status, blocker, refresh, and diagnostics entry visible. | Diagnostics stays in Settings. | `Open Run Diagnostics` keeps Settings shell. |
| Fig. 10 | `SettingsRunDiagnosticsPanel`, `SettingsPage`, `AppShell` | Embedded diagnostics panel replaces main app Run History for Settings-origin runs. | Refresh/select/close stay; no implicit main shell. | `Settings sections` visible, `Ling Stack navigation` count `0`, `.run-history-layout` count `0`. |

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts runtime.spec.ts dark-mode.spec.ts`
- Regressions:
  - `corepack pnpm --filter @ling-stack/web test:e2e -- councils.spec.ts work-board.spec.ts model-workbench.spec.ts teammates.spec.ts mcp.spec.ts`

## Acceptance Checklist

- [x] Fig. 10 shell boundary is fixed and protected by e2e.
- [x] Fig. 1 and Fig. 2 Council Workspace layouts are compact and legible.
- [x] Fig. 3 Work Board does not leave Settings for row/run diagnostics.
- [x] Fig. 4 and Fig. 5 Default authorization hides raw policy/runner internals.
- [x] Fig. 6 and Fig. 7 Skill Library deep states are summary-first.
- [x] Fig. 8 Archived rules do not dominate first screen.
- [x] Fig. 9 Startup diagnostics is task-first.
- [x] Desktop browser smoke at `1440x960` and `1280x800` shows no overflow,
  no Settings-to-main-shell leak, and no vertical empty-state text on the
  affected Settings surfaces.

## Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts runtime.spec.ts dark-mode.spec.ts`: passed, including Settings embedded run diagnostics and full Run History explicit app exit.
- `corepack pnpm --filter @ling-stack/web test:e2e -- councils.spec.ts`: passed.
- Regression group evidence from focused runs:
  `mcp.spec.ts`, `model-workbench.spec.ts`, `teammates.spec.ts`, and
  `work-board.spec.ts` passed during the combined regression run; `councils.spec.ts`
  was rerun after final assertion updates and passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- councils.spec.ts work-board.spec.ts model-workbench.spec.ts teammates.spec.ts mcp.spec.ts`: passed, 33 tests.
- Browser smoke on the running dev server `http://127.0.0.1:5173/`:
  `1440x960` and `1280x800` checked Council Workspace, Work Board, Default
  authorization, Skill library, Archived items, Startup and diagnostics, and
  Settings Run Diagnostics. Each surface kept `Ling Stack navigation` absent,
  `Settings sections` present, horizontal overflow at `0`, and no detected
  vertical empty-state text.

## Remaining Verification

- Full visual sign-off can still compare final screenshots against the user's
  ten references, but the implementation acceptance checks now cover shell
  boundary, collapsed diagnostics, explicit app exits, dark-mode token
  regressions, desktop overflow, and vertical text regressions.

## Assumptions

- Keep all existing backend behavior.
- Keep P8/P9 worktree changes and continue from them.
- Do not promote Work Board to primary navigation.
