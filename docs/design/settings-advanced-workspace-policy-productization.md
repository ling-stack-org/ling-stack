# Settings Advanced Workspace Policy Productization

## Document Role

This document is the design contract for simplifying the expanded
`Settings > Default authorization > Advanced workspace policy` surface. It was
created from the July 2026 screenshot review and should be read before changing
the advanced permission editor.

The implementation checklist lives in
[Settings Advanced Workspace Policy Productization Implementation Plan](settings-advanced-workspace-policy-productization-implementation-plan.md).

## Related Docs

- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)
- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Codex-Inspired Settings Permission Presets](codex-inspired-settings-permission-presets.md)
- [Ling Design System](ling-design-system.md)

## Summary

The current advanced policy editor exposes seven internal tool ids as seven
large form rows, gives every tool a full-width select, colors normal `ask`
states as warnings, and uses a large textarea for write paths. The result is
technically complete but visually heavy and difficult to scan.

The target is a summary-first editor built around two user decisions:

1. What may Ling read or search without interruption?
2. What may Ling execute or modify without asking?

Per-tool control remains available, but only after the user chooses to customize
a permission group. Write paths become a structured list instead of a raw text
area. No runtime permission semantics change.

## Problem Evidence

The screenshot review identified five concrete problems:

- Seven tool rows compete at the same visual level.
- Internal ids such as `grep` and `bash` are the primary labels.
- Wide selects make a small three-state decision look like a large form.
- Warning backgrounds appear for ordinary `ask` behavior.
- The write-path textarea reserves a large empty region even when the only value
  is `.`.

This does not scale if Ling adds more tools. Adding another tool currently adds
another large row and increases the height of the default editor.

## Product Principles

- Group common decisions before exposing individual tools.
- Use product language first and technical ids second.
- Reserve warning color for blocked, invalid, or risky states that require
  attention.
- Keep normal `allow` and `ask` states neutral.
- Show structured values with structured controls.
- Keep the current policy payload and daemon behavior unchanged.
- Make the advanced editor compact enough to scan at 1280, 1440, and 1920
  desktop widths.

## Target Information Architecture

```text
Advanced workspace policy

  Read and search                         [Allow | Ask | Block]
  read, grep, find, ls                               Customize

  Execute and modify                     [Allow | Ask | Block]
  bash, edit, write                                  Customize

  Write access
  [Current workspace] [additional/path] [+ Add path]

                                             [Save changes]
```

The advanced editor remains collapsed by default. Expanding it reveals the two
group rows and the write-access list. Individual tool rows are not visible until
the user opens `Customize` for a group.

## Permission Groups

The first version uses two fixed frontend presentation groups:

| Group | Product label | Tools | Default description |
| --- | --- | --- | --- |
| `read_search` | Read and search | `read`, `grep`, `find`, `ls` | Inspect project content and locate files or text. |
| `execute_modify` | Execute and modify | `bash`, `edit`, `write` | Run commands and change workspace files. |

These groups are presentation only. They do not add a contract type and are not
stored by the daemon.

### Group State

- If every tool in a group has the same decision, the group shows that decision.
- If tool decisions differ, the group shows `Custom` and no single segment is
  selected.
- Selecting `Allow`, `Ask`, or `Block` at group level applies that decision to
  every tool in the group.
- Changing one tool in the detail view recalculates the group state immediately.

`Block` is the user-facing label for the existing `deny` value. The stored value
remains `deny`.

## Group Row Design

Each group is one quiet row with:

- Product label as the primary text.
- Tool count or technical ids as secondary text.
- A compact three-option segmented control.
- A small `Customize` disclosure action.

The row does not use a card background. A thin divider separates groups. The
active segment uses a check icon or subtle inset marker, not a strong fill.

When a group is `Custom`, the row displays a short `Custom` label beside the
control. It must not use warning color because a mixed policy is valid.

## Per-Tool Detail Design

Opening `Customize` expands a compact list directly below the group row.

Each tool row contains:

- A product label, such as `Read files` or `Run commands`.
- The technical id in subdued monospace text, such as `read` or `bash`.
- The same `Allow / Ask / Block` segmented control.

The detail list is single-column and constrained to the policy editor width.
It must not restore the current two-column grid of large form rows.

Suggested labels:

| Tool | Product label |
| --- | --- |
| `read` | Read files |
| `grep` | Search file contents |
| `find` | Find files |
| `ls` | List folders |
| `bash` | Run commands |
| `edit` | Edit files |
| `write` | Write files |

## Write Access Design

The existing newline-delimited form value remains the source of truth, but the
UI presents it as a path list.

Rules:

- `.` is displayed as `Current workspace`.
- Other entries display their path, truncated in the row with the full path in a
  tooltip.
- Every path has a remove icon with an accessible label.
- `Add path` opens one compact inline text input.
- Enter confirms a valid non-empty path; Escape cancels.
- Duplicate paths are ignored after trimming.
- Removing all entries is allowed and displays `No write paths allowed`.
- The first version does not open an operating-system directory picker and does
  not change global workspace selection.

The UI converts the path list back to `allowedWritePathsText` so the existing
payload conversion continues to send `allowedWritePaths` unchanged.

## Save And Dirty State

- `Save changes` remains inside the advanced editor.
- The button is disabled until tool decisions or write paths differ from the
  loaded policy.
- A lightweight `Unsaved changes` label may appear beside the button only while
  dirty.
- Saving uses the existing policy mutation.
- A successful save clears dirty state because the domain reloads the saved
  policy into the form.
- Save failures continue to use the existing persistent inline error.

No success toast is required.

## Visual Rules

- Policy editor content uses a maximum readable width of approximately 840px.
- Group rows use 40px to 44px minimum height.
- Per-tool rows use 36px to 40px minimum height.
- Segmented controls have stable option widths and do not resize when labels
  change.
- Normal states use existing surface, border, and text tokens.
- Only `Block`, validation errors, and runtime blockers may use warning or danger
  colors.
- Do not add nested cards or large gray explanation blocks.
- The expanded editor must not create horizontal page overflow.

## Interaction And Accessibility

- Group and tool decision controls expose a clear accessible group label.
- Every segment exposes its selected state with `aria-pressed` or equivalent
  single-choice semantics.
- `Customize` reports expanded state.
- Remove-path icon buttons have path-specific accessible labels.
- Keyboard users can change decisions and add or remove paths without relying on
  hover.
- Focus rings use the existing global focus token.

## State Flow

```text
Loaded ApprovalPolicy
  -> approvalPolicyToForm
  -> local tool decisions + newline path text
  -> permission group view model + path list view model
  -> user edits group, tool, or path
  -> ApprovalPolicyFormState
  -> existing updateApprovalPolicy request
```

The presentation model is derived. It never becomes a second persisted policy
model.

## Module Boundaries

- `ExecutionPermissionsSettingsPanel.tsx`
  - Keeps section composition, refresh, save, and domain callbacks.
  - Does not own detailed group/path rendering after this change.
- `AdvancedWorkspacePolicyEditor.tsx`
  - Owns group rows, per-tool details, path list, and dirty-state presentation.
- `permission-policy-view-model.ts`
  - Owns group definitions, labels, group-state calculation, group updates, path
    parsing, path serialization, and form equality helpers.
- `settings-permissions.css`
  - Owns permission preset, effective summary, advanced policy, and runner-local
    styles touched by this slice.
- `settings.spec.ts`
  - Owns browser-level policy interaction and payload regression coverage.

`settings.css` is already architecture debt at more than 3,000 lines. New
advanced-policy styles should not be appended there. The implementation should
extract the relevant permission styles into `settings-permissions.css` and load
it after `settings.css`.

## API And Types

- No daemon API change.
- No contract change.
- No database or migration change.
- No change to `ApprovalPolicyFormState`.
- No change to `ApprovalToolDecision` values.
- No change to `ToolName` values.
- Frontend-only types may include `PermissionToolGroupId`,
  `PermissionToolGroup`, and `PermissionGroupDecision`.

## Non-Goals

- No permission-engine rewrite.
- No new provider, model, runner, or approval behavior.
- No operating-system directory picker.
- No automatic policy recommendations.
- No mobile acceptance work.
- No change to conversation composer permission controls.
- No change to channel-specific permission previews.

## Acceptance Checklist

- [x] Advanced policy remains collapsed by default.
- [x] Expanding it shows two permission groups, not seven large tool rows.
- [x] Uniform group decisions show `Allow`, `Ask`, or `Block` correctly.
- [x] Mixed group decisions show `Custom` without warning styling.
- [x] Group-level changes update every member tool.
- [x] Per-tool customization remains available.
- [x] `.` displays as `Current workspace`.
- [x] Paths can be added and removed without editing a raw textarea.
- [x] Save payload remains identical to the current daemon contract.
- [x] Save is disabled when the policy form has not changed.
- [x] Normal `ask` states do not use warning backgrounds.
- [x] Desktop widths 1280, 1440, and 1920 have no horizontal overflow.
- [x] Dark mode uses existing tokens and remains legible.

## Implementation Evidence

- `AdvancedWorkspacePolicyEditor.tsx` renders the two permission groups,
  per-tool disclosures, structured path list, and dirty save footer.
- `permission-policy-view-model.ts` keeps grouping, mixed-state derivation,
  path normalization, and form equality outside React.
- `settings-permissions.css` owns the permission surface styles; the original
  Settings stylesheet was reduced instead of extended.
- Playwright browser review covered light mode at 1280 and 1440 widths and dark
  mode at 1280 width.
- E2E overflow assertions cover 1280, 1440, and 1920 widths.
- E2E covers group updates, mixed per-tool state, duplicate path suppression,
  path removal, unchanged save state, successful payload serialization, and
  failed-save edit preservation.
