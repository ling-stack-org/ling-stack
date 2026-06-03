# Channel Workspace v1.23 Explicit Task Selection

## Status

Implemented in the Web channel workspace.

## Intent

The channel default view should be chat, even when the channel has historical tasks.
Entering a channel with no chat messages should not show a stale task detail just because
the task table has older records. Tasks remain channel-scoped durable work items, but task
detail is an explicit secondary surface.

## Behavior

- `task.channelId` defines task ownership. Different channels load different task lists.
- Refreshing a channel's tasks preserves the current selected task only if it still exists
  in that channel.
- If the previous selected task is not in the selected channel, selection clears instead
  of falling back to the first task.
- The Web client no longer treats `tasks[0]` as the selected task.
- The right details panel is closed by default when entering or switching channels.
- Floating progress and attention state are channel-scoped. Latest run, pending approval
  count, and attention items must be derived from the current channel's task/run/approval
  ownership, not global workspace state.
- A channel with no chat content should not render the floating progress/attention
  popover. Historical tasks, runs, approvals, or external work records may still be
  visible from explicit task/activity surfaces, but they should not make an empty chat
  look active.
- Task detail opens only after explicit user action:
  - clicking a task or task attention item,
  - opening a task from activity/details,
  - creating a task,
  - confirming an execution proposal,
  - opening a task from a run repair path.
- The `Tasks` side surface can be opened without selecting a task. In that state it shows
  an empty/select-or-create affordance instead of a historical task detail.
- The attention popover only renders when there are attention items and the channel has
  chat content. Empty channels should show the centered empty-chat state and bottom
  composer without task, progress, or attention chrome.
- Current-channel teammate management is a transient popover. It stays open for internal
  add/remove/default actions, closes on outside click or Escape, and hides the
  attention/progress popover while open so stacked popovers do not steal clicks. The
  popover is centered on the channel chat surface, and when the right details panel is
  open it follows the remaining chat area instead of anchoring to the global right edge.

## Non-Goals

- This slice does not remove task history.
- This slice does not change the task/run/approval data model.
- This slice does not add a full task list redesign. It only fixes default selection and
  drawer visibility boundaries.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test --grep "workspace opens as a task workbench|channel drawers match|workspace task detail panel|channel activity hides the attention queue|paused channels disable task run actions|workspace task runs only expose|workspace task run uses|workspace task detail actions|succeeded workspace tasks"
git diff --check
```
