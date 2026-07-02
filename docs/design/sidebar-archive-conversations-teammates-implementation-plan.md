# Sidebar Archive for Conversations and Teammates Implementation Plan

## Summary

Implement sidebar archive for recent conversations and AI teammates by reusing
existing non-destructive primitives: Ling thread archive for conversations and
teammate `hidden` for AI teammates. Update Settings to restore both item types.
Recent conversations also expose a section overflow action to archive all visible
conversation threads through the same existing thread archive endpoint.

## Goals

- Recent conversation rows can be archived from the sidebar.
- Recent conversations can be bulk archived from the section overflow menu.
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
- Add `archiveAllConversationThreads` to the conversation domain. It confirms,
  batches the existing thread archive call across visible recent conversations,
  removes successful archives immediately, and reports partial failures.
- Add `archiveAiTeammate` to the teammate domain.
- Extend archived settings controller state/actions for conversations and
  teammates.
- Extend archived settings UI with Conversations and AI Teammates groups.
- Update sidebar/settings i18n copy.
- Update conversation daemon archive guard from `status === "archived"` to
  `status === "archived" || archivedAt`.

## Module Boundaries

- `SidebarNavigation.tsx`
  - Presentational row action rendering and section overflow menu rendering.
  - No API calls.
- `use-conversation-domain.ts`
  - Conversation archive mutation, bulk archive batching, refresh, selected-thread
    cleanup, and user-facing archive failure formatting.
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
- Bulk archive uses the current visible conversation projection. It does not
  discover hidden/archived conversations, and it does not create a new backend
  batch API.
- Bulk archive is best-effort: successful archives are removed immediately, while
  active-work or unexpected failures stay visible and surface an inline/global
  error.
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
6. Add Recent conversations section overflow menu with `Archive all
   conversations`.
7. Expand archived settings controller and panel.
8. Add i18n copy.
9. Add daemon archived-thread guard.
10. Run typechecks and targeted e2e where feasible.
11. Verify in desktop browser if services are available.

## Test Plan

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/daemon typecheck`
- Targeted Web e2e:
  - sidebar archive recent conversation
  - sidebar recent conversations overflow menu
  - sidebar archive all recent conversations
  - archive-all partial failure feedback
  - settings restore conversation
  - sidebar archive teammate
  - settings restore teammate
  - channel/branch archive regression
- Manual desktop checks:
  - Row archive buttons appear on hover/focus only.
  - Archive removes the item from the sidebar without deleting data.
  - Restore returns the item.
  - Archive all asks for confirmation, archives visible recent conversations,
    and leaves active-work failures visible.
  - Archived conversation cannot be continued until restored.

## Risks

- Current working tree has unrelated modifications. Do not revert them.
- `AppShell.tsx` is architecture debt. Keep this slice to callback wiring.
- `SidebarNavigation.tsx` is near the 800-line guardrail. Avoid broad
  navigation refactors in this slice.
- If a teammate was hidden for a reason other than sidebar archive, it will show
  in Archived Items. This matches the current single `hidden` primitive.
- Bulk archive fans out existing per-thread archive calls. It can partially
  succeed when some conversations still have active work; the UI must not imply
  all-or-nothing semantics.

## Assumptions

- Hidden, non-disabled teammates are the correct definition of archived teammate
  sidebar items.
- Disabled teammates should not be restored by this settings group.
- Conversation archive does not require confirmation because Settings restore is
  available and no data is deleted.
- Bulk conversation archive requires confirmation because it can hide many rows
  at once, even though data remains restorable.

## Open Questions

- Should the archived settings page later separate built-in teammates from custom
  teammates?
- Should row-level archive eventually support undo toast? This slice avoids toast
  noise and relies on Settings restore.
- Should bulk archive later include filters such as only completed or only idle
  conversations? Current behavior archives the visible recent conversation list.

## Verification Checklist

- [x] Docs landed.
- [x] Conversation archive action exists and refreshes active recents.
- [x] Conversation bulk archive action exists and best-effort archives visible
  recents through the existing thread archive endpoint.
- [x] Teammate archive action exists and hides active sidebar teammate.
- [x] Sidebar recent and teammate rows expose archive actions.
- [x] Sidebar Recent conversations section exposes an overflow menu with
  `Archive all conversations`.
- [x] Settings lists archived conversations and teammates.
- [x] Settings restores archived conversations and teammates.
- [x] Conversation stream rejects `archivedAt` threads.
- [x] Archive guard allows idle open turns without runs and blocks truly active
  work.
- [x] Web typecheck passes.
- [x] Daemon typecheck passes.
- [x] App e2e covers recent conversation archive, teammate archive, channel
  archive regression, archive-all menu, and active-work guard behavior.
