# Settings Semantic Convergence P2

## Summary

P2 makes Settings read as a product configuration surface instead of a mixed set of
implementation panels. The main issue is the current `Personal and interface` section:
profile identity and interface preferences are different user jobs, so they should not
share one settings page.

This pass splits the mixed section, renames several settings destinations by product
semantics, and keeps existing configuration data and routes intact.

## Goals

- Separate user identity from interface preferences.
- Make every settings section answer "what am I managing?".
- Keep Settings workspace tools as the home for lower-frequency management surfaces.
- Keep existing panels, APIs, and persistence behavior.
- Preserve the fullscreen Settings shell and nested workspace tool return paths.

## Non-goals

- No daemon API change.
- No database or migration change.
- No route deletion.
- No mobile acceptance scope.
- No visual redesign of the individual tool pages.
- No AppShell refactor beyond existing Settings props.

## Target IA

```text
Configuration overview
  -> workspace tools, model workbench, teammate management, council workspace, work board, default authorization

Personal
  -> Profile

Preferences
  -> Interface and language

Workspace
  -> Runtime and permissions
  -> Connections
  -> Skills

Maintenance
  -> Data and diagnostics
```

## Section Semantics

| Section | User job | Includes | Does not include |
| --- | --- | --- | --- |
| Configuration overview | Open low-frequency workspace tools and key defaults | Model Workbench, Teammate Management, Council Workspace, Work Board, default authorization | Profile editing, language/theme controls |
| Profile | Manage the local user identity used in messages and app surfaces | Avatar, display name, handle, profile usage overview | Theme, locale, response language |
| Interface and language | Control how the app looks and responds linguistically | Theme, UI language, AI response language | User avatar or profile metrics |
| Runtime and permissions | Control what runs and what needs approval | Approval policy, default permission mode, runtime runners | Inbox decisions, provider setup |
| Connections | Connect Ling to outside systems | External work, MCP servers, plugins | Skill governance, provider/model presets |
| Skills | Manage skill availability and skill library | Skill governance, workspace skill library | AI teammate profile editing |
| Data and diagnostics | Inspect local data and system health | Archives, startup readiness, run diagnostics | Everyday workflow inbox |

## Key Changes

1. Replace `Personal and interface` with two settings sections:
   - `Profile`
   - `Interface and language`
2. Rename settings destinations to product-language labels:
   - `Execution and permissions` -> `Runtime and permissions`
   - `Integrations` -> `Connections`
   - `Data and maintenance` -> `Data and diagnostics`
3. Keep remote Settings IA structure:
   - `PersonalInterfaceSettingsPanel` exports personal profile and interface preference
     surfaces from one module.
4. Keep `Configuration overview` as the first settings section and keep nested workspace
   tools inside Settings.
5. Keep `SettingsPage` as the owner of section navigation, but do not add backend or
   AppShell business logic.

## Copy Rules

- Prefer product words over implementation words in settings navigation.
- Use `Connections` for external systems rather than `Integrations`, because this page
  mixes external work, MCP, and plugins.
- Use `Runtime and permissions` for policy plus runners, because the page is not only
  approval policy.
- Use `Data and diagnostics` for archive and readiness surfaces, because maintenance
  sounds broader than the actual page.
- Keep technical vocabulary inside detail panels where the user is intentionally
  inspecting a system detail.

## Module Boundaries

- `SettingsPage.tsx` owns the section list and routes props to focused settings panels.
- `PersonalInterfaceSettingsPanel.tsx` owns the user profile wrapper and interface
  preferences exports.
- `SettingsWorkspaceToolsPanel.tsx` continues to own workspace tool rows.
- Existing `ExecutionPermissionsSettingsPanel`, `IntegrationsSettingsPanel`,
  `SkillsSettingsPanel`, and `MaintenanceSettingsPanel` keep their internal logic.
- `AppShell.tsx` should not receive new settings business logic for this P2.

## API / Types

- No public API change.
- No contract change.
- No persistent state change.
- Settings section ids are frontend-only UI state.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
- Update assertions so:
  - `Personal and interface` no longer appears.
  - `Profile` and `Interface and language` appear as separate settings sections.
  - Profile contains profile identity UI but not theme/language controls.
  - Interface and language contains theme, UI language, and AI response language.
  - `Runtime and permissions`, `Connections`, `Skills`, and `Data and diagnostics`
    route to the existing panels.
  - Settings workspace tool nested pages still keep Settings fullscreen and return rows.

## Acceptance Checklist

- [x] Design document exists and states the target IA.
- [x] `Personal and interface` is removed from visible settings navigation.
- [x] `User profile` and `Interface and language` are separate settings sections.
- [x] Existing profile save/upload behavior still works.
- [x] Existing theme, locale, and response language behavior still works.
- [x] Existing permissions, connections, skills, and diagnostics panels remain reachable.
- [x] No backend/API/persistence changes.
- [x] No major behavior is added to large AppShell or workspace files.

## Implementation Evidence

- `corepack pnpm --filter @ling-stack/web typecheck`
- `git diff --check`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts app.spec.ts dark-mode.spec.ts profile.spec.ts mcp.spec.ts runtime.spec.ts`
  - First run: 50 passed, 1 settings assertion failed because the test still expected `Profile` instead of `User profile`.
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
  - Final focused rerun: 15 passed.

## Risks

- Several e2e tests select settings sections by visible labels; they must be updated with
  semantic labels rather than broad regexes that preserve the old mixed page.
- `SettingsPage.tsx` is a busy prop-routing file. Keep this pass focused on section ids,
  labels, and panel composition only.
- `i18n.tsx` is large; add copy keys only and avoid using translations as logic.
