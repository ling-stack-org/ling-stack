# Settings Profile Identity Redesign Implementation Plan

## Summary

Implement [Settings Profile Identity Redesign](settings-profile-identity-redesign.md) as a
frontend-only Settings productization pass. The goal is to make Settings `Profile` feel
like a focused identity configuration page instead of a personal analytics dashboard.

No daemon API, contracts, SQLite schema, or profile persistence behavior changes.

## Key Changes

- Replace the embedded hero-style `ProfilePage` in Settings with a Settings-native
  profile surface: identity card, display preview card, and compact usage summary.
- Extract small focused profile components instead of adding more JSX to the page shell:
  `ProfileIdentityCard`, `ProfilePreviewCard`, `ProfileUsageSummary`, and optionally
  `ProfileUsageDetails`.
- Keep existing profile save, avatar crop, run metrics, and skill metrics data flow; only
  change default presentation and visual priority.
- Keep `使用洞察` expanded by default, but make it compact: token heatmap, horizontal
  continuous-use metrics, and a compact skill list/empty state.
- Align copy and styling with Settings patterns: Chinese labels, compact section headers,
  Settings card tokens, no duplicate page/panel title stack.

## Implementation Steps

1. Split profile UI responsibilities:
   - Keep profile loading/saving logic in `ProfilePage` or a small local controller.
   - Extract identity form, preview, and usage summary components under
     `apps/web/src/features/profile/`.
   - Preserve `AvatarCropDialog` and current validation.

2. Add Settings-oriented rendering mode:
   - `ProfilePage` may accept a `variant="settings"` prop, or expose a new
     `ProfileSettingsSurface` component.
   - `PersonalInterfaceSettingsPanel` should render the Settings variant.
   - Standalone profile access, if still used elsewhere, can keep the fuller profile page.

3. Rework layout and styling:
   - Add scoped profile/settings classes in `profile.css` or a small profile settings CSS
     section.
   - Primary grid: identity card + preview card.
   - Secondary card: compact usage summary.
   - Show usage insight by default, with continuous-use metrics arranged horizontally.

4. Tighten copy and i18n:
   - Use Chinese-visible labels for this surface.
   - Remove or avoid duplicate `Profile identity` title above `个人资料`.
   - Ensure helper copy says this is local workspace identity.

5. Update tests and verification:
   - Add/update Settings/Profile e2e assertions for identity fields, save button, preview,
     and compact usage summary.
   - Confirm avatar crop entry still opens.
   - Confirm run/skill data absence shows compact empty state.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts profile.spec.ts`
- `git diff --check`
- Browser review on served desktop Web:
  - Settings -> `资料` shows identity editing as the primary task.
  - No duplicate heading stack.
  - Avatar/name edits update the preview before save.
  - Save success/error feedback appears near the form action.
  - Usage summary is secondary; usage insight is visible by default without a right-side
    vertical metric stack.
  - Page has no excessive empty center space at `1440x1000`.

## Assumptions

- Desktop web is the acceptance target.
- The existing profile API and avatar crop behavior are correct.
- The profile usage heatmap and continuous-use metrics are useful enough to show by
  default when they remain compact.
- If `ProfilePage` is used outside Settings, the implementation should avoid regressing
  that standalone surface by using a variant or wrapper component.

## Hard Stops

- Do not change daemon routes, contracts, database schema, or saved profile shape.
- Do not make run/skill analytics required for profile editing.
- Do not add new top-level Settings entries.
- Do not add major new behavior to `AppShell.tsx`.
- Do not grow an already-large file with unrelated responsibilities; extract first.

## Implementation Evidence

- Added a Settings-oriented profile surface with identity edit, display preview, and
  compact usage summary.
- `使用洞察` now opens by default and keeps continuous-use details in a horizontal compact
  metric row.
- Kept standalone `ProfilePage` behavior available via the default variant.
- Moved Settings-specific profile styles into `profile-settings.css`; touched profile
  source files remain under the 800-line guardrail.
- Verification:
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/profile.spec.ts`
  - `corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/settings.spec.ts`
  - `git diff --check`
