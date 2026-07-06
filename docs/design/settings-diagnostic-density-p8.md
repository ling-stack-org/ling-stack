# Settings Diagnostic Density P8

## Related Docs

- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Product UX Usage Closure P7 Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P8 Implementation Plan](settings-diagnostic-density-p8-implementation-plan.md)
- [Settings Interaction Depth P9](settings-interaction-depth-p9.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)

## Summary

P8 tightens the Settings visual-density rule for diagnostic-heavy pages. Plugin
Manager and Skill Library currently expose too many internal facts in the default
view: raw ids, hashes, contribution records, runtime previews, policy overlays,
source checksums, diff records, and health evidence compete with the task the user
is trying to complete.

The product rule is: default Settings pages show what is usable, what needs
attention, and the next action. Diagnostics remain available, but they live inside
details or an inspector.

## Design Decisions

- Plugin Manager uses a summary-first list. Each row shows plugin name, status,
  source, a short readiness summary, and at most one primary action.
- Plugin details own raw ids, versions, package hashes, contribution tokens,
  linked resources, runtime preview facts, package validation, disable, and
  uninstall actions.
- Skill Library keeps the existing list plus inspector shape, but the list columns
  are reduced to status, skill name, source, stage, bound teammates, and actions.
- Skill requirements, approval profile, raw skill id, tools, prompt fragments, and
  source metadata belong in `SkillCompactInspector`.
- Review queue and Source sync are summary-first. Diff, checksum, context health,
  semantic detail, and warning evidence are hidden behind details until the user
  asks for them.

## Hard Stops

- Do not change Settings IA, routes, daemon APIs, plugin registry behavior, skill
  registry behavior, database schema, or primary navigation.
- Do not solve density by shrinking fonts below existing Settings norms.
- Do not create marketing cards, new global colors, or decorative backgrounds.
- Do not add major behavior to already-large Skill Library files without extracting
  focused helpers or widgets first.

## Acceptance Criteria

- Plugin Manager first screen no longer exposes raw id, package hash, contribution
  tokens, runtime preview details, or policy overlays by default.
- Plugin install, apply preset, enable, disable, check, runtime preview, validate,
  refresh package, and uninstall flows remain reachable and tested.
- Skill Library default list has no horizontal scroll at desktop widths and no
  required-tools or approval-profile column.
- Source sync preview still exposes diff, checksum, context findings, and semantic
  details, but only after opening details.
- Dark mode keeps existing Settings tokens and avoids gray-copy stacking.

## Assumptions

- Desktop Web remains the only acceptance target.
- Maintenance and External Work remain regression surfaces for this slice; they are
  not redesigned in P8.
- Raw diagnostic evidence is still valuable for advanced users, so this slice hides
  it by default rather than deleting it.

## Follow-up

P9 continues this work for interaction depth: tab panels, dialogs, preview
results, inspectors, and details surfaces must follow the same summary-first
rule as the P8 default list rows.

P10 continues this work with screenshot-by-screenshot evidence and adds the
Settings shell boundary for diagnostics opened from Settings.
