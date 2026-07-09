# Settings Profile Identity Redesign Implementation Plan

## Summary

Implement [Settings Profile Identity Redesign](settings-profile-identity-redesign.md) as a
frontend-only Settings productization pass. The goal is to make Settings `Profile` feel
like a focused identity configuration page instead of a personal analytics dashboard.

No daemon API, contracts, SQLite schema, or profile persistence behavior changes.

## Key Changes

- Replace the embedded hero-style `ProfilePage` in Settings with a Settings-native
  profile surface: centered identity block and compact usage metrics.
- Extract small focused profile components instead of adding more JSX to the page shell:
  `ProfileIdentityCard`, `ProfileUsageSummary`, and optionally `ProfileUsageDetails`.
- Delete the display preview surface entirely: no `ProfilePreviewCard`, no static message
  preview, no preview usage chips, and no visible `Display preview` copy.
- Treat handle as read-only in Settings: show `@handle` near the avatar, but do not render
  a username input.
- Remove the Settings page header, refresh button, permanent display-name input, save
  button, reset button, and text `Change avatar` button.
- Edit display name inline from the pencil icon; blur or Enter saves, Escape cancels.
- Avatar crop confirmation saves immediately in Settings mode.
- Keep existing profile API, standalone profile save flow, avatar crop UI, run metrics,
  and skill metrics data flow; only change the Settings presentation and save trigger.
- Show `使用洞察` directly, but make it compact and clearly secondary: token heatmap,
  horizontal continuous-use metrics, and a compact skill list/empty state.
- Align copy and styling with Settings patterns: Chinese labels, compact section headers,
  Settings card tokens, no duplicate page/panel title stack.

## Implementation Steps

1. Split profile UI responsibilities:
   - Keep profile loading/saving logic in `ProfilePage` or a small local controller.
   - Extract identity form and usage summary components under
     `apps/web/src/features/profile/`.
   - Remove `ProfilePreviewCard`, `ProfilePreviewAvatar`, and `ProfilePreviewUsage` once
     they have no references.
   - Remove editable handle props from the Settings surface; standalone profile can keep
     its existing behavior unless that surface is redesigned separately.
   - Preserve `AvatarCropDialog` and current validation.

2. Add Settings-oriented rendering mode:
   - `ProfilePage` may accept a `variant="settings"` prop, or expose a new
     `ProfileSettingsSurface` component.
   - `PersonalInterfaceSettingsPanel` should render the Settings variant.
   - Standalone profile access, if still used elsewhere, can keep the fuller profile page.

3. Rework layout and styling:
   - Add scoped profile/settings classes in `profile.css` or a small profile settings CSS
     section.
   - Primary layout: centered avatar/name/handle identity block without a duplicate
     section title.
   - Name input is transient and inline; focus styles must not resize the block.
   - Name edit icon is a low-emphasis inline ghost action by default; hover/focus may
     reveal a subtle background.
   - Avatar edit is the corner camera icon only.
   - Profile save/saving/error feedback uses the shared `Ling Toast` from
     [Global Feedback Toast System](global-feedback-toast-system.md): porcelain neutral
     panel, subtle shadow, small status bead, 3-second auto-dismiss, reduced-motion fade.
   - Secondary layout: compact usage metrics plus directly visible insight content.
   - Remove `.profile-preview-*` styles after deleting the preview surface.

4. Tighten copy and i18n:
   - Use concise labels and aria labels for this surface.
   - Remove or avoid duplicate `Profile identity` title above `个人资料`.
   - Remove preview-only keys such as `Display preview`, `Profile display preview`, and
     `These places use your avatar and display name.` when no longer referenced.
   - Remove no-longer-visible Settings keys such as `Save profile`, `Reset changes`, and
     `Avatar adjusted. Save to apply.` once unused.
   - Do not replace the preview with another persistent gray explanatory paragraph.

5. Update tests and verification:
   - Add/update Settings/Profile e2e assertions for centered identity block, hidden
     username field, hidden permanent display-name field, inline edit save, absence of
     display preview, and compact usage summary.
   - Confirm avatar crop entry still opens and saves without a separate save button.
   - Confirm the toast appears outside the identity block and disappears automatically.
   - Confirm run/skill data absence shows compact empty state.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts profile.spec.ts dark-mode.spec.ts`
- `git diff --check`
- Browser review on served desktop Web:
  - Settings -> `资料` shows the centered identity block as the primary task.
  - No duplicate heading stack.
  - No visible `身份信息` / `Identity information` heading or editable username field.
  - No refresh button, permanent display-name input, text `Change avatar` button, or
    `保存资料` footer in Settings.
  - Name edit icon opens inline input; blur/Enter saves and Escape cancels.
  - Name edit icon is quiet by default and does not read as a standalone visible action.
  - Avatar crop confirm saves immediately.
  - No `显示预览` / `Display preview` section appears.
  - Save/saving/error feedback appears as a top-center neutral toast, not under the
    identity block, and disappears automatically.
  - Usage insight is directly visible and remains compact.
  - Page has no excessive empty center space at `1440x1000`.

## Assumptions

- Desktop web is the acceptance target.
- The existing profile API and avatar crop behavior are correct.
- The profile usage heatmap and continuous-use metrics are useful enough to keep
  available when they remain compact.
- If `ProfilePage` is used outside Settings, the implementation should avoid regressing
  that standalone surface by using a variant or wrapper component.

## Hard Stops

- Do not change daemon routes, contracts, database schema, or saved profile shape.
- Do not make run/skill analytics required for profile editing.
- Do not add new top-level Settings entries.
- Do not add major new behavior to `AppShell.tsx`.
- Do not grow an already-large file with unrelated responsibilities; extract first.

## Implementation Evidence

- Removed display preview components, styles, tests, and i18n keys.
- Removed Settings handle editing and redundant `Identity information` heading.
- Removed Settings header, refresh action, permanent display-name input, save/reset
  footer, and text avatar-change button.
- Added inline display-name editing with blur/Enter auto-save and Escape cancel.
- Tuned the display-name edit icon into a low-emphasis inline ghost action.
- Settings avatar crop confirmation now saves immediately.
- Replaced the profile status line with a top-center toast that auto-dismisses and stays
  outside the identity block. Follow-up: route it through the shared `Ling Toast`
  provider when the global feedback component ships.
- Kept standalone profile save/reset-style behavior, avatar crop, and profile usage
  summary working.
- Usage insights now render directly without a disclosure toggle.
- Verification:
  - `git diff --check`
  - `corepack pnpm --filter @ling-stack/web check:i18n`
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts profile.spec.ts dark-mode.spec.ts app.spec.ts`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- profile.spec.ts dark-mode.spec.ts`
