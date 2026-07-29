# P7B.2 Skill Library Implementation Plan

> Closeout status: seven reachable Function IDs verified on 2026-07-20; `SETTINGS-SKILL-SYNC-001` remains inventory.

## 1. Slice Contract

P7B.2 将 Settings > 技能库的当前可达 surface 迁移到 UI 2.0 shared primitives，并关闭：

- `SETTINGS-SKILL-NAV-001`
- `SETTINGS-SKILL-LIST-001`
- `SETTINGS-SKILL-INSPECT-001`
- `SETTINGS-SKILL-IMPORT-001`
- `SETTINGS-SKILL-EDITOR-001`
- `SETTINGS-SKILL-REVIEW-001`
- `SETTINGS-SKILL-ARCHIVE-001`

`SETTINGS-SKILL-SYNC-001` 由用户 A/B 决定：A 保持当前 IA 并继续 inventory；B 才新增官方来源更新入口。
本切片不以该决定为由阻塞其余七项。

## 2. Authoritative Baseline

| Owner | Baseline |
|---|---:|
| `SkillLibrarySettingsPanel.tsx` | 604 lines |
| `SkillEditorDialog.tsx` | 549 lines |
| `SkillReviewQueuePanels.tsx` | 543 lines |
| `SkillLibraryWidgets.tsx` | 432 lines |
| `skill-library-utils.ts` | 426 lines |
| `SkillLibraryRegistrySection.tsx` | 302 lines |
| `settings.css` | 2,521 lines |
| `settings-skill-editor.css` | 351 lines |
| `settings-interactions.css` | 220 lines |
| ownership/import E2E | 5 + 2 tests |
| `AppShell.tsx` | about 3,069 lines, composition only |

Current production navigation is `mine/evolution/builtin`; Evolution owns pending/generated/ignored. Official source
sync API exists but has no production UI entry and current tests assert its absence.

## 3. Module Boundaries

```text
SkillLibrarySettingsPanel.tsx                composition only, target <260
  useSkillLibraryDataController.ts           load, refresh, selection, projections, target <320
  useSkillLibraryActionsController.ts        scoped mutations/feedback/delete, target <360
  SkillLibraryNavigation.tsx                 top Tabs
  SkillLibraryRegistrySection.tsx            toolbar/list/inspector composition, target <260
    SkillLibraryToolbar.tsx                  Input/Select/actions
    SkillLibraryTable.tsx                    shared Table and row actions
    SkillLibraryInspectorPanel.tsx           inline Settings inspector
      SkillCompactInspector.tsx              summary and shared InspectorSections
  SkillEvolutionSection.tsx                  view composition
    SkillReviewQueuePanel.tsx                query/filter/list shell, target <300
    SkillReviewQueueCards.tsx                three item types, target <360
    skill-review-queue-model.ts               pure projections
  SkillImportDialog.tsx                      shared Dialog
  SkillEditorDialog.tsx                      shared Dialog composition, target <260
    SkillEditorCoreFields.tsx
    SkillEditorAdvancedFields.tsx
    SkillEditorFeedback.tsx
  SkillDeleteDialog.tsx                      shared confirmation Dialog
```

Rules:

- touched production files over 400 lines are split before adding behavior;
- new production files remain below 400 lines;
- `AppShell.tsx` and `SettingsPage.tsx` receive no new domain state;
- API/client/domain calls remain unchanged;
- Feature code imports shared primitives only through `shared/ui`.

## 4. Implementation Steps

### Step A: Reachability And View Models

- Replace the single coverage row with eight Function IDs.
- Map `mine/evolution/builtin` and pending/generated/ignored to stable view-model types.
- Move queue search/filter/sort and primary-state projections out of JSX.
- Keep source labels、candidate gates、route blockers and hard-delete eligibility in pure helpers.
- Do not move translated strings into types or locale-dependent business branches.

### Step B: Data And Action Controllers

- Extract load/refresh/selection/source artifact state from the 604-line panel.
- Keep the last authoritative data on load/refresh failure.
- Extract review/adopt/protocol/playbook/archive/source/delete mutations with scoped busy and errors.
- Use shared `useLingToast` for successful user-triggered mutations.
- Delete is controlled by `deleteTarget`; API call occurs only after Dialog confirmation.

### Step C: Registry And Inspector

- Search uses shared `Input` with Search prefix; sort/filter uses shared `Select`.
- Import/Create use shared `Button`; row actions use shared `IconButton`.
- Table uses shared Table primitives while retaining stable Skill semantic classes for E2E.
- Loading uses Skeleton; true empty/no-result use compact EmptyState.
- Replace conversation `RightDrawer` with a focused inline Inspector panel.
- Replace raw `<details>` with shared `InspectorSection`; source/raw details remain folded.
- Ensure row/Inspector focus restoration and bounded independent scroll.

### Step D: Import And Editor Dialogs

- Replace both hand-written overlays with shared Radix-backed `Dialog`.
- Busy Dialog cannot dismiss; Cancel/Close restore trigger focus.
- Import keeps one file input and all validation/failure inside Dialog.
- Editor uses shared Field/Input/Textarea/Select/SegmentedControl/IconButton/InspectorSection.
- Preserve dirty discard、authority confirmation、conflict reload and user draft.
- Split editor into focused components instead of retaining a 549-line owner.

### Step E: Evolution Queue

- Keep pending/generated/ignored Select and existing queue semantics.
- Use shared Tabs for type filters and shared Input/Select/Button/InspectorSection.
- Split pure queue projection from three cards.
- Keep technical IDs、source refs、gates、steps and blockers folded.
- Action busy/error is scoped to the queue/object; generated/ignored stay read-only where required.

### Step F: Archive/Delete And Feedback

- Archive remains direct non-destructive icon action with scoped busy.
- Hard delete moves from `window.confirm` to shared Dialog with Cancel initial focus.
- Delete failure remains in Dialog; success closes after authoritative refresh.
- Remove `.settings-inline-tip/.settings-inline-success` and persistent page success copy.
- Import/editor errors remain in their Dialog; source errors remain in Inspector; review errors remain in queue.

### Step G: Focused CSS

Create one feature owner directory:

```text
styles/settings-skill-library.css
styles/settings-skill-library/
  shell.css
  registry.css
  inspector.css
  evolution.css
  dialogs.css
```

- each file <=400 lines;
- shared primitive chrome remains package-owned;
- delete migrated Skill selectors from `settings.css` and `settings-interactions.css`;
- delete `settings-skill-editor.css` after editor migration;
- zero new color literals、`!important`、Theme/Profile selectors、`transition: all`、private keyframes or
  package-private `.ling-ui-*` selectors.

### Step H: Focused E2E

Add `ui2-settings-skill-library.spec.ts`; retain and update existing ownership/import specs.

Required cases:

1. loading, empty, no-result, refresh failure with authoritative rows retained;
2. My/Built-in/AI Evolution navigation, keyboard and counts;
3. 55-row internal scroll, long name/summary/tool/path and 1280 containment;
4. Inspector open/close/Esc/focus, read-only, metadata-only, source-backed, folded raw details;
5. Import open/file read/invalid/blocking/publish failure/success/busy dismissal;
6. Create/candidate/revision editor, dirty discard, authority change, conflict/reload, save failure/success;
7. pending/generated/ignored queue, search/sort/filter, candidate/playbook/cluster actions and failure;
8. archive, delete cancel/Esc/busy/failure/success and protected rows;
9. zh-CN/en-US, Light/Dark, normal/reduced motion, no console errors or document overflow;
10. explicit assertion for the user-selected official source sync decision.

## 5. Browser Evidence

Evidence directory:

```text
docs/design/ui2.0升级/evidence/settings/skill-library/
```

Minimum screenshots:

- `1440x960-ling-light-my-skills.png`
- `1440x960-ling-light-editor.png`
- `1280x800-ling-dark-evolution-review.png`
- `1280x800-ling-dark-inspector-source.png`
- `1280x800-ling-dark-import-failure.png`
- `1280x800-ling-dark-delete-failure-zh-CN.png`

`metadata.md` records branch、HEAD、dirty state、real Vite URL、fixture、trigger、viewport、Theme Pack、locale、
console、overflow、keyboard、reduced motion and SHA-256.

## 6. Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-skill-library.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- skill-library-ownership.spec.ts skill-import-productization.spec.ts settings.spec.ts dark-mode.spec.ts ui2-settings-shell.spec.ts ui2-dialog-controls.spec.ts ui2-form-controls.spec.ts ui2-feedback-data-display.spec.ts
```

Run broader Channel/MCP regression only if shared primitive、global overlay or closed Settings CSS ownership changes.

## 7. Documentation Closeout

After evidence passes, update README、temporary control guide、coverage matrix、page slice、E2E、status、CSS、selector、
motion and feedback matrices. Only code + automation + real browser evidence + metadata permits `verified`.

## 8. Stop Conditions

Stop and ask before:

- exposing Official Source Updates without the A/B decision;
- changing top-level Settings/Skill IA or adding a route;
- changing review/publish/authority/delete semantics;
- adding or changing daemon/API/contracts/database;
- merging AI teammate Skill binding management into this page;
- resolving remote/local conflicts by discarding either side.

No stop condition blocks the seven currently reachable Function IDs.

## 9. Closeout Result

- Steps A-G completed without daemon/API/contracts/database、IA、authority、review/publish or delete semantic changes.
- Final production boundaries: Panel 172 lines, data controller 208, action controller 322, Review cards 271,
  Review panel 172 and source Inspector 191; all touched production owners remain below 400 lines.
- `settings.css` moved from the 2,521-line baseline to 972 lines; Skill visuals now live only in the 975-line focused
  owner. Old widgets/review aggregate files and `settings-skill-editor.css` were removed.
- Search focus geometry and large-list horizontal overflow found by the existing ownership suite were fixed in
  focused CSS. Delete Dialog now receives the real row trigger and restores it after Cancel/Esc/failure.
- Final automation: ui-react `41/41`, focused `4/4`, ownership/import `7/7`, selected regression `27/27`, plus
  typecheck、i18n、lint and diff check.
- Six real Vite screenshots and SHA-256 metadata are stored under
  [`evidence/settings/skill-library/`](../../evidence/settings/skill-library/metadata.md).
- The seven reachable Function IDs move to `verified`. Source Sync remains `inventory` and does not block Archived
  Items, Diagnostics or embedded Settings tools.
