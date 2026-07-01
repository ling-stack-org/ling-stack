# Sidebar Archive for Conversations and Teammates Implementation Plan

## Summary

Implement sidebar archive for recent conversations and AI teammates by reusing
existing non-destructive primitives: Ling thread archive for conversations and
teammate `hidden` for AI teammates. Update Settings to restore both item types.

## Goals

- Recent conversation rows can be archived from the sidebar.
- AI teammate rows can be archived from the sidebar.
- Settings > Archived Items lists and restores archived conversations and
  archived teammates.
- Existing channel and branch archive behavior remains unchanged.
- Archived conversation threads cannot accept new conversation messages.

## Non-goals

- No hard delete or soft-disable from sidebar archive.
- No database/schema migration.
- No new HTTP endpoint.
- No teammate direct chat rewrite.
- No mobile-specific work.

## Key Changes

- Add docs under `docs/design` to make archive semantics explicit.
- Extend `SidebarNavigation` props with archive callbacks for recent
  conversations and teammates.
- Convert teammate/recent sidebar rows to the existing `sidebar-row-shell`
  structure so row actions are not nested inside buttons.
- Add `archiveConversationThread` to the conversation domain.
- Add `archiveAiTeammate` to the teammate domain.
- Extend archived settings controller state/actions for conversations and
  teammates.
- Extend archived settings UI with Conversations and AI Teammates groups.
- Update sidebar/settings i18n copy.
- Update conversation daemon archive guard from `status === "archived"` to
  `status === "archived" || archivedAt`.

## Module Boundaries

- `SidebarNavigation.tsx`
  - Presentational row action rendering.
  - No API calls.
- `use-conversation-domain.ts`
  - Conversation archive mutation, refresh, and selected-thread cleanup.
- `use-teammates-domain.ts`
  - Teammate archive mutation, refresh, and active teammate cleanup.
- `useArchivedSettingsController.ts`
  - Archived item loading and restore actions across channels, branches,
    conversations, and teammates.
- `ArchivedSettingsPanel.tsx`
  - Archived groups and row controls.
- `AppShell.tsx`
  - Callback wiring only.
- `conversations/routes.ts`
  - Backend guard only.

## API / Types

- Reuse:
  - `archiveLingThread(cwd, threadId, request)`
  - `unarchiveLingThread(cwd, threadId, request)`
  - `listLingThreads(cwd, { kind: "conversation", archived })`
  - `updateAiTeammate(cwd, teammateId, { hidden })`
- No new contract fields.
- No new database fields.

## State / Data Flow

- Active sidebar conversations keep using the existing
  `conversationThreads` projection.
- Archived conversations are loaded directly in Settings with
  `archived: "only"`.
- Active sidebar teammates keep filtering `!hidden && status !== "disabled"`.
- Archived teammate settings list filters `hidden && status !== "disabled"`.
- Settings `onChanged` must refresh channels, conversation threads, and
  teammates so restored items return to the sidebar without a full reload.

## Implementation Steps

1. Land design and implementation-plan docs.
2. Add conversation domain archive action.
3. Add teammate domain archive action.
4. Wire AppShell callbacks with a small shared archived-items refresh helper.
5. Add SidebarNavigation row archive buttons.
6. Expand archived settings controller and panel.
7. Add i18n copy.
8. Add daemon archived-thread guard.
9. Run typechecks and targeted e2e where feasible.
10. Verify in desktop browser if services are available.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/daemon typecheck`
- Targeted Web e2e:
  - sidebar archive recent conversation
  - settings restore conversation
  - sidebar archive teammate
  - settings restore teammate
  - channel/branch archive regression
- Manual desktop checks:
  - Row archive buttons appear on hover/focus only.
  - Archive removes the item from the sidebar without deleting data.
  - Restore returns the item.
  - Archived conversation cannot be continued until restored.

## Risks

- Current working tree has unrelated modifications. Do not revert them.
- `AppShell.tsx` is architecture debt. Keep this slice to callback wiring.
- `SidebarNavigation.tsx` is near the 800-line guardrail. Avoid broad
  navigation refactors in this slice.
- If a teammate was hidden for a reason other than sidebar archive, it will show
  in Archived Items. This matches the current single `hidden` primitive.

## Assumptions

- Hidden, non-disabled teammates are the correct definition of archived teammate
  sidebar items.
- Disabled teammates should not be restored by this settings group.
- Conversation archive does not require confirmation because Settings restore is
  available and no data is deleted.

## Open Questions

- Should the archived settings page later separate built-in teammates from custom
  teammates?
- Should row-level archive eventually support undo toast? This slice avoids toast
  noise and relies on Settings restore.

## Verification Checklist

- [x] Docs landed.
- [x] Conversation archive action exists and refreshes active recents.
- [x] Teammate archive action exists and hides active sidebar teammate.
- [x] Sidebar recent and teammate rows expose archive actions.
- [x] Settings lists archived conversations and teammates.
- [x] Settings restores archived conversations and teammates.
- [x] Conversation stream rejects `archivedAt` threads.
- [x] Web typecheck passes.
- [x] Daemon typecheck passes.
- [x] Desktop browser flow verified through Playwright Chromium app flow.
