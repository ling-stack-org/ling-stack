# Managed Worktree Lifecycle

## Goal

Ling needs Codex-style isolated workspaces without losing the user's canonical checkout. A managed worktree is a repo-owned execution checkout created by Ling for a channel or direct teammate thread. The canonical workspace stays the durable project root, while the managed worktree absorbs agent edits, tests, and handoff artifacts.

This is not a generic temp directory. It is a Git worktree with explicit lifecycle state, recoverable branch metadata, and conservative cleanup rules.

## Workspace Taxonomy

- Canonical checkout: the user's normal project root, passed as `cwd`. The local
  daemon treats the configured workspace `cwd` as the canonical checkout.
- Managed worktree: a Ling-created Git worktree under `paths.worktreesDir`. It is safe for agent execution and can be inspected, refreshed, or cleaned up through Ling APIs.
- External path: a user-supplied execution path. Ling can check whether it exists, but does not own its lifecycle.
- Local binding: execution happens in the channel bound path or canonical workspace. Ling does not create or clean anything.

## Ownership

P0 ownership is scoped to:

- Channel workspaces: `worktrees/channels/<channelId>`, branch `ling/channel-<channelId>`.
- Direct teammate workspaces: `worktrees/teammates/<teammateId>/<threadId>`, branch `ling/teammate-<teammateId>-<threadId>`.

Run-level scratch worktrees are deferred. They need tighter integration with runtime supervisor leases and snapshot preservation before cleanup.

## State Contract

Managed bindings use the existing `ChannelWorkspaceStatus` values:

- `not_created`: Ling has metadata or a default binding, but no active worktree directory.
- `ready`: the execution path exists and the worktree can be used.
- `missing`: the binding points at a worktree that is no longer present.
- `blocked`: Ling could not create or safely manage the worktree.
- `unsupported`: reserved for future non-Git or provider-specific workspace modes.

Dirty state is not a runtime blocker. A normal agent run creates diffs, so refresh must keep a dirty worktree runnable. Dirty state is a cleanup blocker: Ling must not silently delete uncommitted or untracked work.

## Lifecycle

Creation:

1. Resolve the Git repo root from the channel bound path or workspace `cwd`.
2. Capture `baseCommit`, `baseBranch`, branch name, and worktree path.
3. Create the worktree only when the path does not already exist.
4. Persist a `managed_worktree` binding with status `ready` or `missing`.

Refresh:

1. Local and external bindings only check path availability.
2. Managed bindings check path existence and whether the path is a Git worktree.
3. A dirty managed worktree remains `ready`.
4. A missing managed worktree becomes `missing` when it had previously been created, otherwise `not_created`.

Cleanup:

1. Cleanup applies only to managed worktrees.
2. Missing paths update the binding to `not_created`.
3. Dirty worktrees return a `worktree_dirty` error and remain untouched.
4. Clean worktrees are removed with `git worktree remove`.
5. After successful removal, the binding returns to `not_created` and keeps branch/base metadata for later recreation.

P0 does not auto-merge worktree changes back into the canonical checkout. Return paths remain explicit: inspect diff, create a patch/PR, or ask Ling to apply a reviewed change.

## Recovery Rules

- If a managed path exists but is not a Git worktree, mark the binding `blocked`; do not delete it.
- If Git inspection fails, mark the binding `blocked` and preserve the original path.
- If cleanup fails, return the redacted Git error and keep the prior binding.
- If the branch still exists after cleanup, future create can reuse/reset it through the existing worktree creation flow.

## P0 Implementation Checklist

- Add a shared managed worktree helper for Git commands, inspect, create, and safe cleanup.
- Replace duplicated channel/direct Git helper code with the shared helper.
- Add `cleanup` workspace action for channel and direct teammate workspaces.
- Add focused tests for clean cleanup and dirty cleanup refusal.
- Keep canonical service execution rooted at the caller `cwd`; managed worktrees only affect channel/direct execution snapshots.
