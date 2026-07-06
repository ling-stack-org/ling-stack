# Settings Profile Identity Redesign

## Related Docs

- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)

## Summary

The current Settings `Profile` page feels scattered because it embeds a full personal
dashboard inside a configuration surface. Avatar editing, display name editing, token
activity, streak stats, model usage, and skill usage all share the same visual weight.
That makes the page read like a personal homepage, not a Settings task.

The product direction is to turn this page into **Identity configuration first, usage
insight second**:

- Primary job: edit the local user identity shown in channel messages, private chats, and
  approval records.
- Secondary job: show a light usage summary that reassures the user the profile is tied
  to local activity.
- Supporting job: show usage insight by default, but keep it compact and clearly
  secondary to identity editing.

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
2. **Where will this identity be used?**
3. **Is there any useful local activity summary attached to this profile?**

The page should not make the user interpret analytics before they can edit identity.

## Detailed Design

### Page Structure

Use a Settings-native layout, not a profile hero layout:

1. Page header:
   - Title: `个人资料`
   - Description: `设置你在频道、私聊和审批记录中的显示身份。`
   - No extra top-level `Profile identity` card title above the same content.

2. Primary area:
   - Two-column desktop grid.
   - Left column: `身份信息` card.
   - Right column: `显示预览` card.
   - Columns stay visually balanced; neither side should span the full page unless the
     viewport is narrow.

3. Secondary area:
   - `使用摘要` as a compact Settings card under the primary area.
   - Show a short row of metrics first.
   - `使用洞察` is expanded by default, but must remain compact: token heatmap, horizontal
     continuous-use metrics, and a compact skill list/empty state.

### Identity Information Card

This is the main task surface.

- Avatar size: 72-80px, left aligned with the form, not a centered 112px hero.
- Avatar action: icon button overlay or adjacent `更换头像`; keep existing crop dialog.
- Fields:
  - `昵称`
  - `用户名`
  - Inline helper: `仅用于本地工作区显示。`
- Actions:
  - Primary: `保存资料`, right aligned in the card footer.
  - Secondary: `重置更改` only when there are unsaved edits.
- Feedback:
  - Success is lightweight and temporary near the footer.
  - Save errors remain visible until another edit or retry.

### Display Preview Card

This card explains why the profile matters.

- Show a compact message preview using the current avatar, display name, and handle.
- Include three muted usage chips or rows:
  - `频道消息`
  - `AI 队友私聊`
  - `审批记录`
- Copy should be concrete: `这些位置会使用你的头像和昵称。`
- Do not add new behavior; this is a static preview derived from current form state.

### Usage Summary Card

Usage data should be summary-first.

- Default visible metrics:
  - `会话数`
  - `任务成功率`
  - `常用模型`
  - `已使用技能`
- Token totals and streaks may appear as inline secondary metadata, not as five equal
  large tiles.
- `使用洞察` should be expanded by default. The heatmap may be visible there, but it must
  use a fixed-height compact area so it does not dominate the page.
- Continuous-use details are needed, but they should be a horizontal compact metric row,
  not a right-side vertical stack.
- If there is no meaningful activity, show one compact empty row:
  - `还没有足够的本地活动记录。`

### Visual Rules

- Use Settings-specific classes and tokens; do not rely on profile homepage styling for
  the embedded Settings page.
- No centered avatar hero.
- No full-width stat strip as the first content after identity fields.
- No large gray field walls; neutral background is only for cards, selected rows, empty
  states, or warnings.
- Keep row height and spacing close to other Settings cards: compact, scannable, and
  operational.
- Desktop web is the acceptance target.

## Module Boundaries

- `ProfilePage` should stop being both the Settings page and the analytics page.
- Extract profile-specific UI into small components:
  - `ProfileIdentityCard`
  - `ProfilePreviewCard`
  - `ProfileUsageSummary`
  - optional `ProfileUsageDetails`
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

- A user can identify the main task within one glance: edit avatar, nickname, and handle.
- The page explains where the identity appears without needing long explanatory copy.
- Usage analytics are visible but clearly secondary.
- Settings visual language matches the surrounding Settings pages.
- No duplicate `Profile identity` / `个人资料` heading stack.
- No full-page hero feeling inside Settings.
- Desktop `1440x1000` review shows balanced density and no excessive empty center space.

## Assumptions

- `Profile` remains a Settings entry.
- Detailed usage analytics are useful enough to show by default, but they remain
  secondary to identity editing and must not use a dashboard-style layout.
- The existing avatar crop dialog is functionally acceptable and should be retained.
- This pass should not create a new global analytics page.
