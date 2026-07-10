# AI Teammate Custom Create Flow Implementation Plan

## Summary

Implement [AI Teammate Custom Create Flow](ai-teammate-custom-create-flow.md) as a
frontend-only slice. The existing template create path remains available, while the
custom path becomes a full setup and verification flow with visible progress.

No daemon API, contracts, database, route, or state-machine changes.

## Key Changes

- Add teammate create flow types under the teammate feature types module.
- Extend `useTeammatesDomain` with a progress-capable create action that:
  - validates workspace;
  - checks the selected provider;
  - creates the teammate;
  - uploads the selected custom avatar after the teammate record exists;
  - binds the optional channel;
  - checks default memory scope readiness;
  - refreshes teammates/channels;
  - opens the new teammate workspace on success.
- Update `TeammateCreateDrawer`:
  - `Start from blank` enters `custom_setup` instead of acting like a selected row;
  - custom setup fills the dialog with back button, avatar upload/tone fallback, name,
    model, brief, and optional channel;
  - `Create and verify` switches to a progress checklist and remains open until the
    flow finishes or fails;
  - successful setup closes the dialog automatically and opens the private chat;
  - template create can keep the existing compact behavior.
- Add focused CSS in the teammate create scope only.
- Update i18n keys in both English and Chinese locales.
- Update E2E coverage for success, model-blocked, and failure-before-create behavior.

## Implementation Notes

- Reuse `checkProvider` from provider APIs; do not duplicate provider preflight logic.
- Reuse `uploadTeammateAvatar`; do not add a pre-create avatar storage API because
  avatar attachments must belong to an existing teammate id.
- Do not add new behavior to `AppShell` beyond passing the existing `addAiTeammate`
  action to the drawer.
- Keep `CreateDialogShell` presentational.
- Do not move skills, MCP, permissions, or memory content controls into creation.
- Channel setup failure is partial success, not rollback.

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts settings.spec.ts dark-mode.spec.ts`

## Acceptance Evidence To Fill After Implementation

- [x] Custom setup page appears after `Start from blank`.
  - Evidence: `teammates.spec.ts` covers `Custom teammate setup`, back navigation,
    avatar tone controls, name, brief, model, and channel entry.
- [x] Custom setup supports avatar image selection and preview.
  - Evidence: `teammates.spec.ts` uploads `custom-avatar.png`, asserts the selected file
    appears in the custom setup page, and verifies the created teammate owns a
    `teammate_profile_avatar` attachment.
- [x] Progress checklist shows workspace, model, record, avatar, channel, memory, and
  refresh.
  - Evidence: `teammates.spec.ts` asserts `Workspace`, `Model check`, `Create teammate`,
    `Upload avatar`, `Join channel`, `Prepare memory`, and `Refresh workspace`.
- [x] Model failure stops before teammate creation.
  - Evidence: `custom teammate model check failure stops before teammate creation`
    asserts the model error and unchanged teammate count.
- [x] Success closes the dialog automatically and opens the created private teammate
  workspace.
  - Evidence: `teammates.spec.ts` waits for the create dialog to disappear after
    successful setup, then asserts the new private chat heading is visible.
- [x] No visible advanced settings in create dialog.
  - Evidence: existing teammate E2E still asserts `Advanced settings`, default memory,
    and private chat summary are absent from the create dialog.
- [x] Static checks and relevant E2E pass.
  - Evidence:
    - `git diff --check`
    - `corepack pnpm --filter @ling-stack/web check:i18n`
    - `corepack pnpm --filter @ling-stack/web typecheck`
    - `corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts`
    - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
