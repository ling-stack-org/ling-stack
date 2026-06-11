# Channel Workspace v1.26 Channel Branches

## Status

Implemented first slice. This document records the accepted channel sidebar branch model,
the daemon contract, and the Web archive-management behavior.

## Summary

v1.26 adds one-level branches under a channel in the left app drawer.

The branch is a channel-scoped work lane, not a Git branch. It lets a user split a single
channel such as `Engineering` into focused lanes like `Model routing fix` or `Channel UI
simplification` without creating another top-level channel.

```text
channel
  -> branch
  -> branch
```

The branch model stays intentionally small:

- a top-level channel can create branches,
- a branch cannot create child branches,
- a top-level channel can be archived,
- a branch can be archived independently,
- row actions are hidden until hover or keyboard focus.

## Product Model

A channel remains the durable work scene: it owns teammates, provider defaults, path,
runtime policy, files, context, tasks, messages, and approvals.

A channel branch is a lightweight scoped lane inside that scene. It should eventually own
or filter:

- branch-scoped messages or branch-linked message threads,
- tasks created from that branch,
- runs and approvals linked to those tasks,
- branch-specific unread and attention state,
- branch archive state.

It must not own independent provider defaults, teammates, runtime policy, or filesystem
binding in the first implementation. Those stay on the parent channel so branches do not
become hidden channels.

## Interaction Model

### Default State

The left drawer shows only channel names and expanded branch names. It does not show row
actions by default.

```text
Channels
  # Engineering
      Model routing fix
      Channel UI simplification
```

The section header `+` still creates a top-level channel. It does not create a branch.

### Top-Level Channel Hover or Focus

When the pointer or keyboard focus is on a top-level channel row, the row's right edge
shows:

1. Create branch.
2. Archive channel.

Create branch opens a compact naming popover anchored to the row. The popover should
start with the branch name input focused and should support `Enter` to create and
`Escape` to cancel.

Archive channel should use the existing destructive-action confirmation pattern if the
channel contains active work, pending approvals, running tasks, or unarchived branches.

### Branch Hover or Focus

When the pointer or keyboard focus is on a branch row, the row's right edge shows only:

1. Archive branch.

A branch row must not expose create-branch. This keeps the hierarchy to one level and
prevents nested branch trees from taking over the drawer.

### Expand and Collapse

The parent channel controls whether its branches are visible. The first implementation can
keep branches expanded whenever the parent channel is selected or focused.

Follow-up behavior may add a disclosure control, but only if branch counts become large
enough to justify it. Do not add disclosure chrome before there is real density pressure.

## Codex Lifecycle Reference

Codex separates thread lifecycle actions instead of treating archive as delete:

- `thread/list` accepts an `archived` filter,
- `thread/archive` moves a thread out of the default active list,
- `thread/unarchive` restores an archived thread,
- `thread/delete` hard-deletes a thread and descendants.

Ling should borrow that lifecycle boundary for channels and branches, not the exact Codex
thread UI. Archive remains reversible; delete remains a separate destructive action.

## Archive Rules

Archive is a visibility and lifecycle state, not deletion.

Rules:

- archived branches are hidden from the default channel list,
- archived branches can be restored from Settings archived-items management,
- archiving a branch does not archive the parent channel,
- archiving a parent channel hides its branches with it,
- restoring a parent channel does not automatically restore previously archived branches,
- active runs, pending approvals, and running workflow steps should block archive or route
  through an explicit confirmation flow.

This follows the Codex thread lifecycle shape: archive hides the item from the default
list, restore moves it back, and delete is a separate irreversible operation.

Archive labels should be user-facing:

```text
Archive channel
Archive branch
```

Do not use Git terms such as `delete branch`, `checkout`, `merge`, or `push` in this UI.

## Archived Items Management

Archived channels and archived branches need a recovery surface. Do not make archive a
one-way drawer action.

The first UI should live under channel settings or workspace settings as `Archived
channels and branches`. It should be a management list, not part of the main channel
drawer.

Recommended information architecture:

```text
Settings
  Archived channels and branches
    Channels
      archived channel row
        Restore
        Delete
    Branches
      parent channel name / branch name row
        Restore
        Delete
```

Rules:

- archived top-level channels and archived branches are shown in the same settings surface,
  grouped by kind,
- archived branch rows must show their parent channel name,
- restoring a branch restores only that branch if the parent channel is active,
- if the parent channel is archived, restoring a branch should first require restoring the
  parent channel or offer a combined restore action,
- restoring a channel does not automatically restore its individually archived branches,
- deleting a channel permanently deletes or detaches its branches according to the final
  data model; the confirmation copy must name that consequence,
- deleting a branch permanently removes the branch record and its branch-only membership,
  but linked tasks/messages/runs should either remain on the parent channel or be deleted
  only if the delete confirmation explicitly says so.

## Delete Boundary

Delete is not archive. It is destructive and must be rare.

Labels:

```text
Delete channel
Delete branch
```

Delete should only be exposed in the archived management surface, not in the normal left
drawer hover actions. The left drawer should stay optimized for reversible archive.

Confirmation rules:

- require an explicit confirmation dialog for delete,
- copy must say `This cannot be undone`,
- channel delete copy must include counts for branches, messages, tasks, runs, approvals,
  files, or artifacts when available,
- branch delete copy must include counts for branch-linked work when available,
- delete should be blocked while the target has active runs, pending approvals, or running
  workflow steps,
- delete should emit a visible toast or management-list state update after success.

The product should prefer archive over delete. Delete exists for cleanup of mistaken,
empty, or obsolete records.

## Visual Spec

Use the existing strict daylight sidebar tokens:

| Element | Spec |
| --- | --- |
| Channel row height | 48px minimum |
| Channel row radius | 8px |
| Channel selected/hover fill | `#F5F5F5` |
| Channel icon | `#`, same weight as existing channel rows |
| Row actions | icon-only, 30-32px square, white or transparent background |
| Branch indent | 40-44px from parent row text start |
| Branch connector | 1px neutral vertical line with short horizontal elbows |
| Branch row height | 34-36px |
| Branch row radius | 7px |
| Branch text | 14px, medium weight |

The branch list is not a card. It is a tree continuation under the channel row. Avoid
nested panels, shadows, bright color badges, or decorative branch artwork.

## Accessibility

- Row actions must be reachable with keyboard focus.
- Hidden actions must become visible on `:focus-within`, not only `:hover`.
- Icon buttons need accessible names: `Create branch`, `Archive channel`, and
  `Archive branch`.
- The branch tree should expose parent/child relationship through list semantics or ARIA
  tree semantics if the implementation uses a real tree widget.
- The archive confirmation must identify whether the target is the channel or a branch.

## Data Boundary

The first daemon contract should model branches as channel-owned records:

```ts
interface ChannelBranch {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}
```

The client should not overload `Channel.workspaceBinding.branchName` or any Git workflow
field for this feature. Channel branches are product lanes; Git branches are repository
state.

## Acceptance Criteria

- A top-level channel row reveals create-branch and archive-channel actions on hover and
  focus.
- A branch row reveals only archive-branch on hover and focus.
- Branches render under exactly one parent channel with a one-level tree treatment.
- Branches do not inherit or override provider, teammate, path, or runtime settings in the
  first implementation.
- Archived branches are hidden by default and can be restored later without deleting their
  linked work.
- Archived channels and branches are discoverable in a settings management surface with
  restore and delete actions.
- Delete is unavailable from the normal channel drawer and requires an irreversible-action
  confirmation.
- The UI copy never suggests Git branch operations.
