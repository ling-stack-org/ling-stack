# Settings Interaction Depth P9

## Related Docs

- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)
- [P9 Implementation Plan](settings-interaction-depth-p9-implementation-plan.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)
- [Skill Source Sync Simplification P15](skill-source-sync-simplification-p15.md)

## Summary

P6 and P8 reduced the default Settings surface, but many second-level states still
read like diagnostic output: subnav tabs, import dialogs, preview results,
inspectors, details panels, token flows, restore/delete flows, and runtime checks
can expose raw ids, hashes, paths, metadata, and explanatory gray text too early.

P9 extends the same product rule to every Settings interaction layer:

- Default page layer shows the task, current state, main action, and blockers.
- Switched tab layers stay task-first, not diagnostic-first.
- Dialogs guide one confirmable task and keep raw preview evidence behind details.
- Inspectors and details remain available, but they are summary-first and folded by
  default.
- High-risk flows keep warnings, but avoid repeating the same explanation in
  navigation, headers, cards, and rows.

P10 is the completion pass for the screenshoted Settings surfaces. It adds an
explicit navigation boundary so Settings-owned diagnostics and management
details cannot fall back into the main application shell.

## Design Rules

- Tab panels use one local title and one primary action. Counts and status chips
  are allowed; long descriptions and raw ids are not default content.
- Dialogs use a compact task structure: title, required inputs, preview summary,
  technical evidence details, and one primary confirmation action.
- Preview results show product status first. Raw checksums, context findings,
  diffs, source paths, and token estimates belong in `details`.
- Inspectors can expose technical facts only after a summary card that answers:
  what is this, is it usable, and what can I do next?
- Destructive, credential, and restore flows keep necessary warnings near the
  action, but do not duplicate general policy text.

## Surface Inventory

- Skill Library: skills list, review queue, source sync, import draft dialog,
  import preview, optimization preview, compact inspector, source/raw details.
- Plugin Manager: row details, runtime preview results, package validation,
  enable/disable/uninstall and linked-resource diagnostics.
- External Work: workflow setup, token storage, polling controls, background
  controls, records and triage entry points.
- Default Authorization: permission presets, advanced tool policy, effective
  preview, execution runner readiness.
- Maintenance: startup readiness, phases, diagnostics, run diagnostics entry.
- Archived Items: restore/delete groups and confirmation copy.

## Hard Stops

- Do not change Settings IA, routes, daemon APIs, contracts, database schema, or
  primary navigation.
- Do not remove diagnostic capability; move it to the correct layer.
- Do not shrink fonts as the solution to density.
- Do not add major behavior to files over 800 lines without extracting focused
  components or helpers first.
- Do not revert P8 Plugin Manager and Skill Library default-layer reductions.

## Acceptance Criteria

- Clicking every Settings tab, details section, dialog, and preview state keeps the
  same low-density product language as the first screen.
- Skill Library import, review, source sync, and inspector details do not expose
  raw ids, paths, checksums, diffs, or context findings by default.
- Plugin runtime previews and package checks show product status first; raw facts
  remain reachable in details.
- External Work, permissions, maintenance, and archived flows preserve warnings and
  actions without repeating explanatory gray text.
- Desktop Settings at `1440x960` and `1280x800` has no horizontal overflow, no
  stacked gray-copy walls, and no duplicate action areas.

## Assumptions

- Desktop Web is the only acceptance target.
- English and Chinese copy must remain aligned.
- P9 is a presentation and UX hierarchy pass, not an API or state-machine change.
