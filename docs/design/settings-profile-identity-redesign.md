# Settings Profile Identity Redesign

## Related Docs

- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)
- [Global Feedback Toast System](global-feedback-toast-system.md)

## Summary

The current Settings `Profile` page feels scattered because it embeds a full personal
dashboard inside a configuration surface. Avatar editing, display name editing, token
activity, streak stats, model usage, and skill usage all share the same visual weight.
That makes the page read like a personal homepage, not a Settings task.

The product direction is to turn this page into **Identity configuration first, usage
insight second**:

- Primary job: edit the local user identity shown in channel messages, private chats, and
  approval records.
- Secondary job: show a light, data-first usage summary after the identity task.
- Removed job: do not show a separate display preview card. The page should not explain
  profile usage through static message previews or muted usage chips.

No daemon API, storage, schema, or profile semantics should change.

## Current State Findings

- `ProfilePage` owns both profile editing and usage analytics. It fetches profile, runs,
  and skills together, then renders all of them in one page.
- Settings wraps `ProfilePage` inside a `Profile identity` panel, while `ProfilePage`
  renders its own topbar, hero, stats, heatmap, insight grid, and save message. This
  produces nested page hierarchy and duplicate purpose.
- The avatar is a centered hero object. That is appropriate for a profile homepage, but
  too dominant for Settings.
- The five-column token/streak strip and full-width heatmap consume more attention than
  the editable fields.
- Usage insight has weak action value in this location. It is useful context, but it is
  not what the user came to Settings to complete.
- The page uses `profile.css` as a separate visual language. It does not fully align with
  the compact `settings-panel`, `settings-section-head`, `settings-meta-line`, and row
  patterns used elsewhere in Settings.

## Product Model

Settings `Profile` should answer three questions in order:

1. **Who will I appear as?**
2. **Can I edit the visible name and avatar in place?**
3. **Is there any useful local activity summary attached to this profile?**

The page should not make the user interpret analytics before they can edit identity.
It should also not ask the user to read a preview card to understand why profile fields
exist; labels and the surrounding Settings context are enough.

## Detailed Design

### Page Structure

Use a Settings-native layout, not a profile hero layout:

1. Page header:
   - The Settings left navigation already says `个人资料`; the right content does not
     repeat a large `个人资料` title or show a refresh button.
   - No persistent explanatory paragraph by default.
   - No extra top-level `Profile identity` card title above the same content.

2. Primary area:
   - A centered identity block: avatar, display name, edit icon, and read-only `@handle`.
   - No visible card title, no username field, no permanent display-name input, no save
     footer.
   - The avatar corner camera icon is the avatar edit trigger; do not show a separate
     `更换头像` text button.
   - Handle is read-only in Settings and appears only as the compact `@handle` identity
     marker near the avatar.

3. Secondary area:
   - Usage metrics sit under the primary identity section without a duplicate `使用摘要`
     heading.
   - Show a short row of metrics first.
   - `使用洞察` renders directly after the metric row: token heatmap, continuous-use
     metrics, and skill usage should stay compact and secondary.

### Identity Editing Section

This is the main task surface.

- Avatar size: about 90px, centered with the name block, but not wrapped in a hero card.
- Avatar action: corner camera icon only; keep existing crop dialog.
- Fields:
   - No field is visible by default.
   - Clicking the low-emphasis edit icon beside the name turns the name text into an
     inline input.
   - The edit icon is a ghost inline action: it stays visually quiet by default and
     becomes clear on row hover, button hover, or keyboard focus.
   - Blur or Enter saves the name and exits editing; Escape cancels.
- Read-only identity:
   - `@用户名` appears near the avatar and cannot be edited in Settings.
- Actions:
   - No persistent `保存资料` or `重置更改` buttons in Settings.
   - Avatar crop confirmation saves immediately.
- Feedback:
  - Saving, success, and error feedback appear in a top-center transient toast, not under
    the avatar/name block.
  - Toast styling follows the global `Ling Toast` pattern: porcelain neutral panel,
    subtle border, light shadow, small status bead, and no large success-colored pill.
  - Toast duration is 3 seconds. Motion is a soft slide/fade; reduced-motion users get a
    fade-only variant.

### Removed Display Preview

The display preview area should be removed entirely.

- Do not render a `显示预览` / `Display preview` card.
- Do not render static message previews for the profile.
- Do not render usage chips such as `频道消息`, `AI 队友私聊`, or `审批记录`.
- Do not keep a muted paragraph explaining that these places use the avatar and display
  name.
- Remove unused preview-only components, styles, tests, and i18n keys once the
  implementation no longer references them.

Rationale: Settings `Profile` is an editing task. The preview repeats what the labels
already imply, adds gray explanatory copy, and makes the page feel like a personal
dashboard rather than a calm management surface.

### Usage Summary Card

Usage data should be summary-first.

- Default visible metrics:
  - `会话数`
  - `任务成功率`
  - `常用模型`
  - `已使用技能`
- Token totals and streaks may appear as inline secondary metadata, not as five equal
  large tiles.
- `使用洞察` is visible by default, but it must use a fixed-height area so it does not
  dominate the page.
- Continuous-use details are needed, but they should be a horizontal compact metric row,
  not a right-side vertical stack.
- If there is no meaningful activity, show one compact empty row:
  - `还没有足够的本地活动记录。`

### Visual Rules

- Use Settings-specific classes and tokens; do not rely on profile homepage styling for
  the embedded Settings page.
- No profile homepage header, refresh button, or save footer in Settings.
- The centered avatar/name block is the page task, not a decorative hero.
- No full-width stat strip as the first content after identity fields.
- No `显示预览` card or static profile preview.
- No duplicate `身份信息` or `使用摘要` section title under the `个人资料` page title.
- No editable username field in Settings.
- No permanent display-name input in Settings.
- No text `更换头像` button; the camera icon changes the avatar.
- Name edit affordance must stay low-emphasis by default; do not render it as a visible
  standalone round button.
- Save/saving/error feedback must not occupy the identity block. Use the top-center
  toast pattern instead.
- No usage-insight disclosure toggle; compact insight content is directly visible.
- No large gray field walls; neutral background is only for cards, selected rows, empty
  states, or warnings.
- Keep row height and spacing close to other Settings cards: compact, scannable, and
  operational.
- Desktop web is the acceptance target.

## Module Boundaries

- `ProfilePage` should stop being both the Settings page and the analytics page.
- Extract profile-specific UI into small components:
  - `ProfileIdentityCard`
  - `ProfileUsageSummary`
  - optional `ProfileUsageDetails`
- Remove `ProfilePreviewCard`, `ProfilePreviewAvatar`, and `ProfilePreviewUsage` when no
  longer referenced.
- Keep profile data loading in a small controller or the existing page until extraction is
  needed; do not move profile logic into `SettingsPage`.
- `PersonalInterfaceSettingsPanel` should render the Settings-oriented profile surface,
  not a full standalone profile homepage.
- Existing API calls remain:
  - `getUserProfile`
  - `updateUserProfile`
  - `listRuns`
  - `listSkills`

## Hard Stops

- Stop if this requires daemon API changes, contract changes, or SQLite migration.
- Stop if profile save semantics change.
- Stop if run/skill metrics become required for saving profile data.
- Stop if the page starts hiding profile edit controls behind a tab.
- Stop if broad Settings navigation IA changes become necessary.
- Stop if implementation needs to add major behavior to `AppShell.tsx`.

## Acceptance Criteria

- A user can identify the main task within one glance: edit avatar and nickname.
- Username/handle is not editable in Settings.
- The right content does not repeat a large `个人资料` heading and does not show a
  refresh button.
- Nickname editing is inline, saved on blur/Enter, and cancellable with Escape.
- Edit icon is subtle by default and only becomes prominent on hover/focus.
- Save/saving/error feedback uses the top-center neutral toast and disappears
  automatically.
- Avatar crop confirmation saves without a separate `保存资料` click.
- No `显示预览` / `Display preview` section is visible.
- The page does not rely on gray explanatory copy to justify profile fields.
- Usage analytics are visible but clearly secondary.
- Settings visual language matches the surrounding Settings pages.
- No duplicate `Profile identity` / `个人资料` heading stack.
- No full-page hero feeling inside Settings.
- Desktop `1440x1000` review shows balanced density and no excessive empty center space.

## Assumptions

- `Profile` remains a Settings entry.
- Detailed usage analytics are useful enough to keep available, but they remain secondary
  to identity editing and must not use a dashboard-style layout.
- The existing avatar crop dialog is functionally acceptable and should be retained.
- This pass should not create a new global analytics page.
- Removing display preview does not change where the saved profile identity is used.
