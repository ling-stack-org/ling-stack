# Settings Visual Density Follow-up

## Related Docs

- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Product UX System P5](product-ux-system-p5.md)
- [Product UX Priorities P6](product-ux-priorities-p6.md)
- [P7 Usage Closure](product-ux-usage-closure-p7.md)
- [P7 Usage Closure Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P7 Usage Closure Implementation Plan](product-ux-usage-closure-p7-implementation-plan.md)

## Summary

Settings already has the right product IA after P2/P3, but the default visual layer still
explains too much at once. The left navigation, page header, subnav descriptions, and
row descriptions can all repeat the same intent, creating a heavy field of muted copy.

This follow-up keeps the Settings IA and behavior unchanged, and reduces default visible
explanation. The product rule is:

- Navigation names the destination.
- The active panel owns the task title.
- Controls and blocking states explain only what the user needs for the current action.
- Technical or diagnostic details stay inside their detail surfaces.

## Design Decisions

- Settings left navigation stays grouped and one-line. Long descriptions must not appear
  as visible text or hover titles in the section nav.
- The global Settings page header is removed from regular panel rendering. Each panel or
  nested workspace tool already owns its title, so this avoids duplicate headings such as
  "Interface preferences" appearing twice.
- Settings subnavs default to tabs only. Descriptions may remain in code for future help
  affordances, but they are not rendered as a persistent gray line.
- Workspace tool rows prioritize title, status chip, and action. Row-level descriptions
  are removed from the default row surface; group-level context may remain.
- Dense diagnostic content remains allowed in surfaces like Skill Library and Startup
  readiness, but first-screen copy should still avoid repeated product explanations.

## Acceptance Criteria

- Settings left nav still shows all existing destinations.
- Settings left nav buttons use their visible label for hover title, not long
  descriptions.
- The right pane does not show a duplicate global title above a panel with the same job
  title.
- Runtime, Skills, and nested Settings subnavs do not show a persistent description line.
- Workspace tool rows do not render default row descriptions.
- Settings dark mode and desktop layout keep existing tokens and no horizontal overflow.

## Implementation Evidence

- Settings left nav long descriptions were removed from section data; hover titles now
  use the visible destination label.
- The global Settings page header was removed so each panel or nested workspace tool owns
  the visible task title.
- `SettingsSubnav` now keeps descriptions hidden by default through a `showDescription`
  opt-in.
- Workspace tool rows no longer render row-level descriptions; they keep title, status
  chip, and action.
- The Settings-embedded Council Workspace no longer renders a duplicate page header;
  create and refresh actions live with the council list, while teammate management is
  exposed from the members surface.
- Verification:
  - `git diff --check`
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts`
  - `1280x800` Playwright run with the same Settings/dark-mode specs against a served
    Vite app on `http://127.0.0.1:4176/`

## Assumptions

- Desktop Web remains the acceptance target.
- This is not a Settings route or API redesign.
- The plan intentionally reduces explanatory copy in default UI, not status chips,
  warnings, errors, timestamps, or diagnostics needed to complete a task.
