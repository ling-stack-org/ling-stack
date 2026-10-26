# Parallel Work Board

## Status

Status: design approved for implementation
Owner: Web / Daemon (runs, work-items)
Last verified: 2026-10-26

## Background and competitive reference

Codex Desktop's core experience is multi-tasking: agents run in separate
threads organized by projects, and the user watches several at once. Ling has
strong per-run observability (Run History, per-run evidence) and a
`work-items` daemon feature plus a `work_board` view id that exists in
navigation but whose product surface is explicitly pending. The user with
three teammates working in parallel today has to hop between runs.

## Goal

One page answering "what is everyone doing right now": all active
conversations, channels, runs, and automations as status cards with progress,
last activity, and one-click jump; stale/idle work visibly demoted.

## Design

### 1. Data: one projection, existing sources

`packages/daemon/src/features/work-items/` gains a `board` projection that
joins (read-only):

- active conversation/channel sessions (existing conversation facades),
- run states (runs feature),
- automation scheduler next-due + last outcome,
- external work in-flight items.

Output: `BoardCard { id, kind, title, ownerTeammateId?, state: "running"|"waiting_approval"|"waiting_user"|"failed"|"idle", lastActivityAt, progress?: { done, total }, deepLink }`.
No new source of truth — the board is a projection; if a source is missing a
card kind silently narrows (forward-compatible).

### 2. UI: work board view

- The existing `work_board` navigation entry renders
  `apps/web/src/features/work-board/WorkBoardPage.tsx`.
- Cards grouped by state columns (Running / Needs you / Stalled) — *not*
  Kanban drag-and-drop; this is a status wall, drag would be fake affordance.
- "Needs you" merges waiting_approval and waiting_user — the single most
  valuable column (it is the Review Queue's cross-surface view).
- Card click deep-links into the existing surface (channel/conversation/run);
  no embedded duplicate UI.
- Polling via the same refresh cadence the Runs page uses (no new stream in
  V1; the notifications stream from item 03 can later push updates).

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| `work_board` view id | completes | Already in `view-types.ts`; wiring a page is the missing piece, no navigation change. |
| Run History / Threads pages | unchanged | Board links out; it never duplicates run detail. |
| Review Queue | unchanged | Board aggregates its state but approvals are still acted on in place. |
| `work-items` daemon feature | extended | Projection added; existing item CRUD untouched. |

### 4. Incompatible-case upgrade path

`BoardCard.state` is a closed union; unknown states from a newer daemon are
rendered as `idle` with a "future state" badge rather than dropped, so
forward-deployed web builds degrade visibly. Card schema versioned via
`boardProjectionVersion` in the route response.

## Implementation plan

1. Daemon: board projection route + unit tests over synthetic joined state.
2. Contracts + api-client: `BoardCard`, board query method.
3. Web: `WorkBoardPage` with three state columns, stale demotion (>30 min no
   activity renders dimmed), deep links.
4. Tests: projection unit tests (missing sources → narrowed board),
   Playwright spec with mocked daemon: three cards across states, "Needs you"
   ordering, stale dimming, screenshots.

## Acceptance

- With mocked daemon, board shows running/waiting/failed cards and
  "Needs you" surfaces an approval-waiting run first; screenshots captured.
- Board page is reachable from existing navigation with zero route changes.
- Runs/conversations suites stay green.
