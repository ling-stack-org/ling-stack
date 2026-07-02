# Sidebar Archive for Conversations and Teammates

## Summary

The left sidebar needs row-level archive actions for conversation threads and AI
teammates. Archive means "hide from the active sidebar while preserving data"; it
does not mean delete.

Ling already has two compatible persistence primitives:

- Conversation threads use `LingThread.archivedAt` through the existing thread
  archive/unarchive endpoints.
- AI teammates use `hidden: true` to disappear from the active sidebar while
  keeping private chat history, memberships, and configuration.

This feature wires those primitives into the sidebar and archived settings page
without adding new storage, changing thread kinds, or calling destructive delete
paths.

## Goals

- Add archive actions to left-sidebar recent conversations.
- Add a section-level "Archive all conversations" action for visible recent
  conversation threads.
- Add archive actions to left-sidebar AI teammate rows.
- Keep archived conversations and hidden teammates restorable from Settings.
- Preserve all existing channel, branch, teammate, private chat, and conversation
  data.
- Prevent archived conversation threads from receiving new turns.
- Keep AppShell as light orchestration only; domain and settings controllers own
  data mutations.

## Non-goals

- No hard delete from the sidebar.
- No database schema migration.
- No new backend endpoint.
- No change to teammate direct-message thread semantics.
- No bulk restore or permanent delete for recent conversations in this slice.
- No mobile-specific acceptance scope.

## Key Changes

- Sidebar:
  - Recent conversation rows get a hover/focus archive icon button.
  - Recent conversations section gets a trailing overflow menu. The menu contains
    `Archive all conversations`, is disabled when there are no visible recent
    conversations, and asks for confirmation before archiving.
  - AI teammate rows get a hover/focus archive icon button.
  - Channel and branch archive controls keep their current behavior.
- Conversation domain:
  - Add an `archiveConversationThread(threadId)` action that calls the existing
    thread archive endpoint and refreshes active conversation threads.
  - Add an `archiveAllConversationThreads()` action that archives the current
    visible recent conversation threads through the same thread archive endpoint.
    Successful archives are removed immediately; failures are surfaced through
    the same sidebar/global error feedback path.
  - If the archived thread is open, return the workspace to the empty
    conversation home.
- Teammate domain:
  - Add an explicit `archiveAiTeammate(teammateId)` action that sets
    `hidden: true`.
  - Do not call teammate disable or hard-delete APIs for sidebar archive.
- Settings:
  - Archived Items expands from channels and branches to also show archived
    conversations and archived teammates.
  - Conversation restore calls thread unarchive.
  - Teammate restore sets `hidden: false`.
- Daemon guard:
  - Conversation send/reuse rejects both legacy `status: "archived"` and modern
    `archivedAt` threads.

## Module Boundaries

- UI:
  - `apps/web/src/features/navigation/SidebarNavigation.tsx`
    renders sidebar row actions only.
  - `apps/web/src/features/settings/ArchivedSettingsPanel.tsx`
    renders archived item groups and restore/delete buttons.
- State/domain:
  - `apps/web/src/domains/conversations/use-conversation-domain.ts`
    owns conversation thread archive and active selection cleanup.
  - `apps/web/src/domains/teammates/use-teammates-domain.ts`
    owns teammate hide/archive and active private chat cleanup.
  - `apps/web/src/features/settings/useArchivedSettingsController.ts`
    owns archived item loading and restore actions.
- API/client:
  - Existing `archiveLingThread`, `unarchiveLingThread`, and
    `updateAiTeammate` client calls are reused.
- Daemon:
  - `packages/daemon/src/features/conversations/routes.ts` keeps archived
    threads read-only for conversation streaming.
- App shell:
  - `apps/web/src/app/AppShell.tsx` only passes callbacks and refresh hooks.
    It must not grow new archive business logic.

## API / Types

- No new HTTP API.
- No storage changes.
- Existing types used:
  - `LingThread.archivedAt`, `LingThread.archivedReason`
  - `LingThreadArchiveRequest`
  - `AiTeammate.hidden`
- Sidebar callback props may be extended:
  - `onArchiveRecentConversation(conversation)`
  - `onArchiveAllRecentConversations()`
  - `onArchiveTeammate(teammateId)`

## State / Data Flow

### Archive Conversation

1. User clicks archive on a recent conversation row.
2. Sidebar calls `onArchiveRecentConversation`.
3. Conversation domain calls `POST /threads/:id/archive`.
4. Domain removes the thread from active recent conversations by refreshing
   `listLingThreads({ kind: "conversation", archived: "exclude" })`.
5. If the archived thread was selected, the workspace returns to conversation
   home.
6. Settings Archived Items can later restore it with
   `POST /threads/:id/unarchive`.

### Archive All Recent Conversations

1. User opens the Recent conversations section overflow menu.
2. If there are no visible recent conversations, `Archive all conversations` is
   disabled and shows `No conversations to archive`.
3. User confirms `Archive all conversations`.
4. Conversation domain calls `POST /threads/:id/archive` for each visible,
   unarchived conversation thread using the existing thread archive endpoint.
5. Successfully archived conversations are removed from the sidebar
   immediately. If the selected conversation was archived, the workspace returns
   to conversation home.
6. If some conversations cannot be archived because they still have active work,
   those conversations remain visible and the sidebar/global error message
   explains the partial failure.
7. Settings Archived Items can later restore successfully archived conversations
   with `POST /threads/:id/unarchive`.

### Archive Teammate

1. User clicks archive on an AI teammate sidebar row.
2. Sidebar calls `onArchiveTeammate`.
3. Teammate domain calls `PATCH /teammates/:id` with `{ hidden: true }`.
4. The active sidebar list filters hidden teammates out.
5. If that teammate private chat was selected, the app closes that active
   teammate view.
6. Settings Archived Items can later restore it with `{ hidden: false }`.

## Hard Stops

- Do not call `hardDeleteAiTeammate` for sidebar archive.
- Do not call teammate `DELETE` for sidebar archive; it disables the teammate and
  changes runtime semantics.
- Do not delete Ling threads or turns.
- Do not restore disabled teammates as active sidebar archive items unless a
  separate product decision is made.
- Do not allow archived conversation threads to receive new user messages.
- Do not add major archive logic to `AppShell.tsx`.
- Do not make section-level bulk archive a hard delete, database migration, or
  new endpoint. It is a client-side batch over the existing archive endpoint.
- Do not silently swallow partial archive failures; active-work blocks must stay
  visible and actionable.

## Test Plan

- Typecheck Web and daemon.
- E2E/sidebar:
  - Archive a recent conversation; it disappears from Recent conversations.
  - Open Recent conversations actions; `Archive all conversations` is disabled
    when there are no visible conversations.
  - Archive all recent conversations; archived rows disappear, Settings can
    restore them, and any active-work failures remain visible with an error.
  - Restore the conversation from Settings; it returns to Recent conversations.
  - Archive an AI teammate; it disappears from AI Teammates.
  - Restore the teammate from Settings; it returns to AI Teammates.
  - Channel and branch archive still work.
- API/daemon:
  - Archived conversation thread cannot be reused for `/conversations/stream`.
  - Existing thread archive/unarchive behavior remains idempotent.
- Settings:
  - Archived Items counts channels, branches, conversations, and teammates.
  - Conversation and teammate restore rows do not expose delete buttons.

## Risks

- `AppShell.tsx` is already very large. The implementation must keep changes to
  prop wiring and small refresh helpers.
- `SidebarNavigation.tsx` is close to the large-file threshold. Row rendering
  changes should reuse existing sidebar row shell classes instead of adding a new
  menu system.
- Treating hidden teammates as archived could be confused with disabled
  teammates. Settings should show hidden, non-disabled teammates as archived
  sidebar items.

## Assumptions

- "归档会话" means archive conversation threads, not channel work threads.
- "归档队友" means hide from the sidebar while preserving teammate data and chat
  history.
- Settings is the correct restore surface.
- Desktop Web is the acceptance target for this slice.

## Open Questions

- Should hidden built-in teammates be restorable in the same list as custom
  teammates, or should built-ins be separated visually later?
- Should conversation archive ask for confirmation, or is row-level archive with
  Settings restore enough?
- Should bulk archive eventually get a one-click undo affordance, or is Settings
  restore sufficient for the desktop sidebar?
