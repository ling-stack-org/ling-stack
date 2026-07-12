# Settings Advanced Workspace Policy Productization Implementation Plan

## Document Role

This is the executable frontend plan for
[Settings Advanced Workspace Policy Productization](settings-advanced-workspace-policy-productization.md).
It is intended to produce one focused UI PR after the design is approved.

## Related Docs

- [Settings Advanced Workspace Policy Productization](settings-advanced-workspace-policy-productization.md)
- [Settings Full-Surface Productization P10 Implementation Plan](settings-full-surface-productization-p10-implementation-plan.md)
- [Settings Semantic Convergence P3 Implementation Plan](settings-semantic-convergence-p3-implementation-plan.md)
- [Codex-Inspired Settings Permission Presets Implementation Plan](codex-inspired-settings-permission-presets-implementation-plan.md)

## Summary

Replace the expanded advanced policy grid with two group-level permission rows,
optional per-tool customization, and a structured write-path list. Preserve the
existing policy form, API payload, permission semantics, and Settings navigation.

The implementation stays frontend-only and should be landed as one small PR.

## Current Implementation Findings

- `ExecutionPermissionsSettingsPanel.tsx` is 357 lines and currently owns policy
  composition, seven tool selects, the write-path textarea, runner settings, and
  save actions.
- `settings.css` is approximately 3,500 lines and contains the current
  `.policy-tool-grid` and `.policy-tool-row` styles.
- `ApprovalPolicyFormState` already carries all required data as
  `toolDecisions` and `allowedWritePathsText`.
- `approvalPolicyFormToPayload` already normalizes newline paths into the
  existing `allowedWritePaths` request field.
- The daemon contract already supports `allow`, `ask`, and `deny` for all seven
  tools. No backend change is required.
- `settings.spec.ts` already verifies loading, changing, saving, and serializing
  tool decisions and write paths.

## Implementation Boundary

### UI

- Add `AdvancedWorkspacePolicyEditor.tsx` under
  `apps/web/src/features/settings/`.
- Render two group rows and local per-tool disclosures.
- Render the write-path list and inline add-path control.
- Keep the advanced editor inside the existing `details` disclosure.

### State

- Keep `ApprovalPolicyFormState` in the existing Settings domain.
- Keep expanded group ids and add-path input state local to
  `AdvancedWorkspacePolicyEditor`.
- Derive dirty state by comparing the current form with the loaded policy form.

### Domain Logic

- Add `permission-policy-view-model.ts` under
  `apps/web/src/features/settings/`.
- Keep group membership, group-state derivation, group updates, tool labels,
  path parsing, path serialization, duplicate handling, and form equality in
  that module.
- Do not place these helpers in `AppShell.tsx` or translation files.

### API And Types

- Reuse `onFormChange` and `onSave`.
- Reuse `ApprovalPolicyFormState`, `ApprovalToolDecision`, and `ToolName`.
- Do not change API client, contracts, daemon routes, or database code.

### Tests

- Extend `apps/web/e2e/settings.spec.ts` for browser behavior and request payloads.
- Add a focused unit test for the view-model helper if the existing web test
  setup supports direct TypeScript module tests without new infrastructure.
- Otherwise cover the helper through e2e and keep the module pure.

## Proposed Files

### New

- `apps/web/src/features/settings/AdvancedWorkspacePolicyEditor.tsx`
- `apps/web/src/features/settings/permission-policy-view-model.ts`
- `apps/web/src/styles/settings-permissions.css`

### Modified

- `apps/web/src/features/settings/ExecutionPermissionsSettingsPanel.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/styles/settings.css`
- `apps/web/src/i18n/locales/en-US.ts`
- `apps/web/src/i18n/locales/zh-CN.ts`
- `apps/web/e2e/settings.spec.ts`

No other production module should be required.

## Implementation Slices

### Slice 1: Extract The Presentation Model

Create fixed frontend group definitions:

```ts
read_search: ["read", "grep", "find", "ls"]
execute_modify: ["bash", "edit", "write"]
```

Add pure helpers for:

- Deriving `allow`, `ask`, `deny`, or `mixed` for a group.
- Applying one decision to every tool in a group.
- Returning a new `ApprovalPolicyFormState` when one tool changes.
- Parsing `allowedWritePathsText` into trimmed unique paths.
- Serializing paths back into newline text.
- Mapping `.` to the presentation label `Current workspace`.
- Comparing the current form to `approvalPolicyToForm(policy)`.

Acceptance:

- Helpers do not import React.
- Helpers do not depend on translated strings for logic.
- Existing stored and request values remain unchanged.

### Slice 2: Build The Grouped Policy Editor

Add `AdvancedWorkspacePolicyEditor` with props for:

- Loaded policy.
- Current form.
- Loading state.
- Form-change callback.
- Save callback.

Render:

- Two group rows.
- Stable `Allow / Ask / Block` segmented controls.
- `Custom` when a group is mixed.
- One disclosure per group for individual tool controls.
- Product labels with subdued technical ids.

Interaction rules:

- Clicking a group segment updates all group tools.
- Clicking a tool segment updates only that tool.
- Group state recalculates immediately.
- Opening one group does not close the other automatically.
- Group disclosures default closed each time the Settings page is mounted.

Acceptance:

- Seven large select rows are gone.
- No ordinary `ask` state uses warning-card styling.
- Keyboard focus and selected state are visible.

### Slice 3: Replace The Raw Path Textarea

Render parsed paths as compact rows or tokens.

Add path flow:

1. Click `Add path`.
2. Show one inline input.
3. Enter a path and press Enter or click confirm.
4. Trim the value, ignore duplicates, update
   `allowedWritePathsText`, and close the input.
5. Press Escape to cancel without changing the form.

Removal flow:

- Remove a path with an icon button.
- Removing `.` is allowed.
- An empty list shows `No write paths allowed` and still serializes to an empty
  string.

Display rules:

- `.` -> `Current workspace`.
- Long paths truncate visually and expose the full path through `title`.
- No OS directory picker is added in this PR.

Acceptance:

- The raw textarea is absent.
- Existing newline payload behavior remains unchanged.
- Duplicate and whitespace-only paths do not create rows.

### Slice 4: Save State And Section Composition

Replace the inline advanced-policy JSX in
`ExecutionPermissionsSettingsPanel.tsx` with the new editor.

- Keep the outer `Advanced workspace policy` disclosure.
- Move the save button into the advanced editor footer.
- Disable save when unchanged or while loading.
- Show `Unsaved changes` only while dirty.
- Keep existing refresh and error behavior in the parent section.

Acceptance:

- Preset selection and effective permission summary do not regress.
- Policy save still calls the existing mutation once.
- A successful save clears dirty state.
- A failed save leaves the edited form visible and the error persistent.

### Slice 5: Isolate Permission Styles

Create `settings-permissions.css` and import it immediately after
`settings.css` in `apps/web/src/styles.css`.

Move the permission-specific selectors touched by this slice out of the large
stylesheet, including:

- Permission preset chooser.
- Effective permissions summary.
- Advanced policy disclosure and editor.
- Policy group rows and segmented controls.
- Path list and editor footer.

Do not move unrelated runner or global Settings styles unless required for a
clean selector boundary.

Acceptance:

- No duplicate selectors remain across `settings.css` and
  `settings-permissions.css`.
- Global `.permission-preview-list` styles from other surfaces cannot override
  the Settings summary.
- Dark mode uses existing theme variables only.

### Slice 6: Copy And Localization

Add or reuse short keys for:

- Read and search.
- Execute and modify.
- Customize.
- Custom.
- Block.
- Read files.
- Search file contents.
- Find files.
- List folders.
- Run commands.
- Edit files.
- Write files.
- Write access.
- Add path.
- Current workspace.
- No write paths allowed.
- Unsaved changes.
- Save changes.
- Remove path.

Keep technical ids untranslated in secondary monospace text.

Acceptance:

- Chinese primary labels are product language, not raw tool ids.
- No technical explanation paragraph is added to the default editor.
- English and Chinese labels fit without changing control dimensions.

### Slice 7: Tests And Desktop QA

Update `settings.spec.ts` to cover:

- Advanced policy remains closed by default.
- Opening it shows two group rows and no `.policy-tool-row select` grid.
- A uniform group shows the correct selected decision.
- A mixed group shows `Custom`.
- Changing a group updates all member tool decisions in the saved request.
- Changing one tool updates only that tool and makes the group mixed.
- `.` renders as `Current workspace`.
- Adding a unique path updates the saved request.
- Adding a duplicate or blank path does nothing.
- Removing a path updates the saved request.
- Save is disabled when unchanged and enabled when dirty.
- Failed save keeps local edits and displays the error.

Run visual checks at:

- 1280 x 800.
- 1440 x 960.
- 1920 x 1080.

Check:

- No horizontal overflow.
- No two-column field wall.
- No warning background on normal `ask` groups.
- Segmented labels remain centered.
- Long paths truncate without pushing actions out of view.
- Dark mode does not introduce light borders or mismatched fills.

## Test Commands

```bash
git diff --check
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts
```

Focused browser test during development:

```bash
corepack pnpm --dir apps/web exec playwright test e2e/settings.spec.ts --grep "approval policy|permission preset"
```

## Regression Boundaries

- Default authorization choices remain unchanged.
- Effective permission preview remains horizontal and compact.
- Permission presets continue to resolve to the same modes.
- Runner settings remain below the policy section.
- Channel and conversation permission controls are not changed.
- Approval requests and runtime enforcement are not changed.

## Risks And Mitigations

### Group controls can hide mixed state

Mitigation: derive `mixed` explicitly and show `Custom`; never guess a selected
segment.

### Path list can drift from the persisted text form

Mitigation: keep pure parse/serialize helpers and always write back through
`onFormChange`.

### Save dirty state can be unstable because of whitespace

Mitigation: normalize paths before comparison and compare all seven tool
decisions explicitly.

### Shared CSS names can override the Settings editor

Mitigation: use Settings-scoped class names in `settings-permissions.css` and
avoid generic `.permission-preview-list` selectors.

### The parent component can become another large mixed-responsibility file

Mitigation: keep the new interaction and presentation logic in the extracted
editor and view-model modules.

## Definition Of Done

- [x] The design acceptance checklist is satisfied.
- [x] The advanced editor shows two default group rows.
- [x] Per-tool control remains available through disclosures.
- [x] The raw write-path textarea is replaced by a structured list.
- [x] Existing API payloads and backend behavior are unchanged.
- [x] Save dirty state is accurate after load, edit, failure, and success.
- [x] i18n, typecheck, targeted e2e, and dark-mode tests pass.
- [x] Desktop browser checks pass at 1280, 1440, and 1920 widths.
- [x] No new production file exceeds 800 lines.
- [x] Permission-specific CSS no longer grows the 3,500-line
  `settings.css` file.

## Verification Evidence

- `git diff --check`: passed.
- `corepack pnpm --filter @ling-stack/web check:i18n`: passed.
- `corepack pnpm --filter @ling-stack/web lint`: passed.
- `corepack pnpm --filter @ling-stack/web typecheck`: passed.
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`:
  passed, 21 tests including failed-save preservation.
- Focused policy regression run passed 3 tests.
- Real dev-server review used `http://127.0.0.1:5173/` and confirmed the
  grouped editor in light and dark themes.

## Assumptions

- This work remains desktop Web only.
- `read`, `grep`, `find`, and `ls` remain the read/search group.
- `bash`, `edit`, and `write` remain the execute/modify group.
- The current `ApprovalPolicyFormState` remains the editing contract.
- The current daemon policy mutation remains the persistence path.
- This PR does not introduce a persisted user-defined permission grouping model.
