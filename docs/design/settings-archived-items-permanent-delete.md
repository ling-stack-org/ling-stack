# Settings Archived Items Permanent Delete P14

## Related Docs

- [Ling Design System](ling-design-system.md)
- [Settings Full Surface Productization P10](settings-full-surface-productization-p10.md)
- [Sidebar Archive for Conversations and Teammates](sidebar-archive-conversations-teammates.md)

## Summary

Settings > Archived Items is the recovery and final-retention surface for archived
product objects. P14 gives conversations, AI teammates, channels, and branches the same
row grammar: Restore as the visible recovery action and an icon-only permanent Delete
action.

Sidebar archive remains non-destructive. Permanent deletion is available only after the
object is archived and only from Settings.

## Product Semantics

- Restore returns the object to its normal list.
- Delete is permanent and cannot be undone.
- Channel and branch deletion keep their existing behavior.
- AI teammate deletion uses the existing private-data hard-delete path. It removes private
  chat, private attachments, avatar, teammate memory, and private bindings. Channel and
  run history retain a deleted-teammate reference.
- Conversation deletion removes the archived conversation, turns, attachments, goals,
  and proposed plans. Historical runs, events, and artifacts remain available but no
  longer reference the deleted conversation.

## Interaction Rules

- Each archived row shows Restore plus an icon-only Delete action with tooltip and
  accessible name.
- Delete asks for confirmation before starting. The confirmation names the object and
  summarizes what is removed or retained.
- The row that initiated deletion shows the loading spinner. Other rows are disabled only
  while the controller mutation is active, matching the existing archive panel behavior.
- Success refreshes archived lists and active shell projections. Failure remains visible
  as the panel inline error.
- The compact page hint reads: `Restored items return to their lists; deleting any
  archived item is permanent.`

## Conversation Delete Boundary

Only an archived `conversation` Ling thread may be permanently deleted.

Delete is rejected when:

- the thread is not archived;
- the thread kind is not `conversation`;
- the thread or one of its turns still has active work;
- an enabled automation still targets the thread.

Deletion runs in one database transaction:

- collect conversation attachment paths;
- write a retention tombstone;
- clear `run_sessions.thread_id` while preserving runs and their events/artifacts;
- delete thread goals and proposed plans that do not have foreign-key cascades;
- delete the thread, allowing turns, turn-run links, conversation attachments, and owned
  automation records to cascade;
- allow child threads to retain history with their parent reference cleared.

Attachment files are removed after the transaction. A missing file does not roll back
successful metadata cleanup.

## Module Boundaries

- Settings controller owns row mutation state, refresh, and product error delivery.
- Archived Settings panel remains presentational and owns confirmation copy only.
- A focused Ling thread cleanup store owns transactional deletion and count derivation.
- Thread routes own archived/kind/active-work/automation-target guards.
- API client and contracts expose a typed hard-delete operation; AppShell does not gain
  deletion business logic.

## Acceptance Criteria

- Conversations, AI teammates, channels, and branches all expose Restore and Delete.
- Conversation and teammate deletion require confirmation and disappear only after a
  successful response.
- Conversation content is removed while historical runs remain readable and unlinked.
- Teammate private data is removed while historical channel/run references remain.
- Non-archived, active, protected, or automation-target objects cannot be deleted.
- Sidebar archive never becomes a hard-delete action.
- English and Chinese confirmation/error copy have equivalent meaning.
- Desktop light and dark Settings keep existing scroll boundaries and action alignment.

## Hard Stops

- Do not delete run history as part of conversation deletion.
- Do not expose permanent delete in the sidebar.
- Do not implement conversation delete as another hidden/archived state.
- Do not bypass the Ling Agent teammate protection.
- Do not add deletion logic to `AppShell.tsx` or the existing large Ling thread store.
