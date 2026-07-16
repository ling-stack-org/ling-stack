# Skill Capability Model And Library Simplification Implementation Plan

Status: active implementation plan
Date: 2026-07-11

## Source Of Truth

- [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md)

## Goal

Remove workflow-stage semantics from the skill domain and simplify the Skill Library
without changing skill execution, binding, approval, permissions, source ownership, or
real workflow phases.

## Slice 1: Contracts And Core Types

- Add `WorkflowPhase` to contracts and core skill types.
- Keep `SkillWorkflowPhase` as a deprecated alias.
- Change `WorkflowStepTemplate.phase` and other genuine workflow consumers to
  `WorkflowPhase`.
- Remove `workflowPhase` from `SkillDefinition`, `SkillCandidateDraftDefinition`, and
  `SkillCandidateHealthInput`.
- Preserve structural request compatibility by allowing parsers to ignore unknown legacy
  fields rather than adding them back to current response types.

## Slice 2: Producers, Recommendation, And Health

- Remove phase literals from built-in skill definitions.
- Remove Markdown and JSON import phase normalization and the default `operate` value.
- Sanitize nested legacy `skillDefinition` objects before publication.
- Remove phase generation from procedure observations and candidate publication.
- Make source-sync role inference use id and summary directly; use conservative empty
  state effects for inferred skills.
- Remove phase tokens and labels from recommendation scoring and reasons.
- Remove phase weighting and conflict fields from duplicate and health analysis.

## Slice 3: SQLite JSON Migration

Add migration version 94, `remove_skill_workflow_phase_metadata`.

| Table | JSON column | Removal scope |
| --- | --- | --- |
| `skill_definitions` | `definition_json` | root `workflowPhase` |
| `skill_import_drafts` | `draft_json` | each `definitions[].definition.workflowPhase` |
| `skill_candidates` | `definition_json` | root and nested `skillDefinition.workflowPhase` |

Malformed JSON is left unchanged, only named properties are removed, updates happen only
when content changes, and no workflow/task/automation table is rewritten.

## Slice 4: Skill Library UI

- Remove `UserSkillStatusFilter` and user status matching.
- Keep one non-archived user list with search plus updated/name sorting.
- Remove user summary counts and user status segmented controls.
- Use `Skill / Description / Bound teammates / Updated / Actions` for My Skills and
  omit the Actions column for Built-in Skills.
- Make whole rows keyboard and pointer selectable.
- Show status only for exceptional states.
- Fix the skill-name column near 200px, give description the flexible column, and use
  one-line truncation with a full-value tooltip.
- Replace the row More menu with direct Archive and Delete icon buttons. Delete is shown
  only for `custom`, `skill-directory`, and `agents-md` skills and must stop row
  selection.
- Render the shared `RightDrawer` only for a valid selected item and close it on Escape.
- Remove Stage from the inspector while preserving source details.

## Slice 4b: Imported Skill Hard Delete

- Keep `DELETE /skills/:id` as the recoverable archive operation.
- Add `POST /skills/:id/hard-delete` plus a typed client response. It validates source
  eligibility in daemon and core, never only in the browser.
- Reject hard delete for built-in, gstack, and workspace entries; reject any remaining
  teammate binding, active task/run, or automation execution-policy reference.
- Delete the registry row and related source snapshots in one SQLite transaction; source
  artifacts and compiled views follow existing foreign keys. Remove a pack only when it
  no longer contains a definition. Preserve historical runs, completed tasks, usage, and
  draft audit records.
- Use an explicit Chinese confirmation in the browser. Do not auto-unbind or modify
  work references.

## Slice 5: AI Teammate Skill Surfaces

- Remove skill-stage columns, chips, and search tokens from teammate skill management and
  role detail surfaces.
- Keep workflow-step phase labels in workflow inspectors and type them with
  `WorkflowPhase`.
- Recalculate table colspans and CSS widths after column removal.

## Module Boundaries

- `SkillLibrarySettingsPanel.tsx`: data loading and side effects only.
- `SkillLibraryRegistrySection.tsx`: ownership state, toolbar, table/drawer assembly.
- `skill-library-view-models.ts`: pure ownership, filtering, search, and sorting.
- `SkillLibraryTable.tsx`: table interaction and direct row actions only.
- `SkillCompactInspector.tsx`: detail content only.
- contracts/core/daemon parsers remain authoritative for data compatibility.

No touched production source file should be expanded beyond the 800-line guardrail. The
existing Settings panel remains below that limit.

## Test Plan

- `corepack pnpm --filter @ling-stack/contracts typecheck`
- `corepack pnpm --filter @ling-stack/core test`
- `corepack pnpm --filter @ling-stack/daemon test`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web run check:i18n`
- focused Playwright coverage for Settings, skill ownership/import, teammate skills, and
  source sync
- `git diff --check`

Browser acceptance is Chinese light mode at 1440x960 and 1280x800. The Settings page must
not grow with skill count, the direct actions must not open the drawer, and built-in skills
remain read-only.

## Hard Stops

- Any required SQLite schema change.
- Any rewrite of workflow/task/automation phase data.
- Any change to approval, permission, execution, binding, or source publication semantics.
- Any need to add built-in skill mutation or disabled-skill management.
