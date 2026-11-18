# Managed Worktree Lifecycle

## Goal

Ling needs Codex-style isolated workspaces without losing the user's canonical checkout. A managed worktree is a repo-owned execution checkout created by Ling for a channel or direct teammate thread. The canonical workspace stays the durable project root, while the managed worktree absorbs agent edits, tests, and handoff artifacts.

This is not a generic temp directory. It is a Git worktree with explicit lifecycle state, recoverable branch metadata, and conservative cleanup rules.

## Workspace Taxonomy

- Canonical checkout: the user's normal project root, passed as `cwd`. The local
  daemon treats the configured workspace `cwd` as the canonical checkout.
- Managed worktree: a Ling-created Git worktree under the workspace's configured
  worktree root, defaulting to `paths.worktreesDir`. It can be inspected, refreshed,
  or cleaned up through Ling APIs.
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
- `unsupported`: reserved for future provider-specific workspace modes. A non-Git
  directory uses a ready Local binding instead of an unsupported state.

Dirty state is not a runtime blocker. A normal agent run creates diffs, so refresh must keep a dirty worktree runnable. Automatic cleanup skips dirty worktrees; confirmed manual cleanup preserves their complete contents in a recovery snapshot.

## Lifecycle

Creation:

1. Resolve the Git repo root from the channel bound path or workspace `cwd`.
2. When Git can inspect a repository, capture `baseCommit`, `baseBranch`, branch name,
   and worktree path, then persist a `managed_worktree` binding.
3. When the directory is not a Git repository, Git is unavailable, the repository has no
   usable `HEAD`, or initial Git inspection fails, persist a ready Local binding at the
   selected path. Git provides isolation; it is not a prerequisite for channel or
   private-chat replies.
4. Explicit `create-worktree` actions remain strict and return the distinct
   `not_git_repository`, `git_unavailable`, or `git_inspection_failed` error instead of
   silently claiming that a managed worktree exists.
5. A selected workspace must be an existing, traversable directory. Missing,
   non-directory, or inaccessible paths never qualify for Local fallback, and a Local
   binding becomes `missing` if its directory later disappears. Automatic fallback
   revalidates the directory after Git inspection and immediately before persisting Local
   so a disappearing workspace cannot be mistaken for a missing Git executable.
6. A legacy direct-thread binding from a failed initial worktree attempt can move to
   Local only when it has never owned a created worktree. Previously created, cleaned,
   missing, or blocked managed worktrees retain their ownership metadata and recovery
   protections.
7. Direct-thread first-use initialization, refresh, handoff, cleanup, and explicit
   worktree creation share the workspace-wide mutation coordinator. Operations across
   the store's direct threads are serialized and reread the latest persisted binding
   before writing, so an explicit handoff cannot be overwritten by stale setup.

Refresh:

1. Local and external bindings only check path availability.
2. Settings checks that each recorded path is a linked worktree in the owning repo and
   is registered on the branch assigned to that owner. New bindings record the source
   repository and Git directories; changing a channel's bound path does not retarget
   its existing worktree. Legacy bindings must match the owner's source checkout and
   the default managed path before Settings can operate on them.
3. A dirty managed worktree remains `ready`.
4. A missing managed worktree becomes `missing` when it had previously been created, otherwise `not_created`.

Cleanup:

1. Cleanup applies only to recorded managed worktrees in the owning repository.
2. Manual cleanup follows the saved confirmation policy. Automatic cleanup skips pinned, active, shared, dirty, or unavailable worktrees.
3. A durable journal and the workspace snapshot fence precede any location change. Run creation, resumption, approvals and binding writes observe that fence.
4. `git worktree move` relocates the complete directory to a private sibling `.ling-recovery/<snapshot-id>` directory. The Git worktree is locked against pruning; its branch, index, staged/unstaged files, untracked and ignored files, symlinks and worktree metadata remain together.
5. The original path becomes absent and its binding becomes `not_created` while the same fence is still held. The snapshot continues to consume disk space. Cleanup does not permanently delete recovery snapshots.
6. Restore moves the recorded worktree back to its original path. An existing destination, foreign repository/branch/lock, active command or changed owner blocks restoration without overwriting content.

P0 does not auto-merge worktree changes back into the canonical checkout. Return paths remain explicit: inspect diff, create a patch/PR, or ask Ling to apply a reviewed change.

## Recovery Rules

- If a managed path exists but is not a Git worktree, mark the binding `blocked`; do not delete it.
- If Git inspection fails, mark the binding `blocked` and preserve the original path.
- Recovery Git failures return a redacted error. After an interrupted move, reconciliation
  checks the original and snapshot locations and linked Git identity before finalizing
  the observed binding. An unchanged original retains its binding; an archived directory
  becomes `not_created`. Ambiguous locations or failed finalization keep the fence and
  journal for recovery without deleting either directory.
- Creation restores a retained snapshot at its recorded path before using the worktree.
  A retained branch without a snapshot is reused without resetting its commits. New
  branches use the requested base branch or current `HEAD`.

## Worktree Settings and Management

The workspace Settings surface exposes General and Environment controls in a dedicated
Worktrees section. Policy is stored in workspace settings JSON without a schema migration:

- `rootDir`: empty uses `paths.worktreesDir`; a custom absolute root is namespaced by workspace identity. Existing bindings keep their paths across root changes, cleanup and restoration.
- `fetchBeforeCreate`: fetches the default remote before creating a new worktree, updating refs without merging. Fetch failure stops creation.
- `autoCleanup`: defaults to false. Workspace ownership starts maintenance on open and every 60 seconds; shutdown stops admission and drains pending operations.
- `retainCount`: 1–100, default 15. Maintenance removes the oldest eligible active directories until the target is reached. Protected directories can keep the total above the target.
- `confirmBeforeDelete`: defaults to true for manual cleanup. Automatic cleanup uses the enabled retention policy.
- `protectedOwners`: explicit per-owner Keep worktree selections. Pinned conversation threads and pinned private-chat teammates also protect their worktrees.
- `environment`: an enabled flag, user-authored setup script, environment variables and a 1–600 second timeout (default 120 seconds in the UI).

The managed inventory comes from all channel and direct-thread ownership records using
stable 500-row pages, with four concurrent Git inspections. It never enumerates arbitrary
machine worktrees as cleanup candidates. Other owners' recorded bound, execution and
worktree paths, including subdirectories, block cleanup. Active Run scopes and unsettled
host-command write blockers also prevent cleanup. Recently updated owner/chat metadata
orders retention; Git dirtiness and protected state are rechecked for each candidate.

`GET /worktrees?cwd=...` returns policy, inventory, recovery snapshots and the last
maintenance result. `POST /worktrees/actions?cwd=...` accepts `ownerKind`, `ownerId`, and
`action`: `open`, `cleanup`, `restore`, `pin` or `unpin`. Manual cleanup
requires `confirmed: true` while its confirmation policy is enabled; restore also names
`snapshotId`. Targets are always resolved from server-owned records. Local-origin and
trusted-workspace checks precede access to these routes, settings and effective-config
responses. Mutable channel/direct-workspace and reply/continuation HTTP entries enforce
the local-origin boundary before opening a store or creating a worktree.
Browser requests with fetch metadata and no Origin are rejected; native clients may
omit Origin.
Internal services and schedulers retain their existing admission paths. Legacy cleanup
routes use the same snapshot lifecycle and accept an optional confirmation body.

A workspace-wide mutation queue covers filesystem operations and binding changes.
Cleanup and restore additionally acquire the existing durable `workspace_default`
snapshot fence. Its SQLite checks exclude competing Run admission and binding writes,
including writes from another connection. An operation checks for already-active Runs
and physical command blockers after acquiring the fence. The fence covers every Run in
the store for the short location-change operation, even if it uses another worktree.
Independent local processes outside Ling are not governed by this admission fence.
Binding writes acquire the SQLite writer before checking the fence; owner finalization
checks the matching owner/epoch and managed path/branch in that transaction. Run
creation also checks a captured managed workspace against its current ready binding,
so a request that waited for provider/input preparation cannot admit an old path after
cleanup has released the fence. Internal delegated-child execution without workspace
snapshots and local-channel workflow isolation retain their existing contracts.

Pending recovery snapshots prevent HTTP workspace handoff and channel binding changes.
Owner deletion refuses managed bindings, and the HTTP deletion routes also preserve
owners with retained snapshots. Active Runs, unfinished WorkUnits and unsettled commands
prevent teammate hard-delete. Settled `yielded` Run history alone does not block deletion.
These checks keep restoration available through its recorded owner.

Recovery journals are published with private permissions, atomic rename and file fsync
before Git moves. POSIX additionally syncs directory metadata; Windows skips directory
fsync because it cannot open directories using the same file-descriptor interface.
Snapshots remain registered
and locked Git worktrees, so their branches cannot be pruned or accidentally reused by a
new checkout. Creation restores a retained snapshot instead of resetting or duplicating
its branch. Startup reconciles a known interrupted operation by checking the original
and snapshot locations against the linked Git identity, reinstating the snapshot's Git
lock and finalizing the matching owner binding before releasing its fencing epoch.
Finalization failure keeps the directory, journal and fence for reconciliation.
Ambiguous locations or identity mismatches preserve both data and fence
for manual inspection; startup never overwrites or deletes either directory. Snapshot
storage has no automatic expiration or permanent deletion policy.

### Settings Workflow

1. Select the workspace, open **Settings → Worktrees → General**, edit the root,
   fetch and retention options, and save. Root changes apply to future worktrees;
   existing paths and recovery locations stay recorded.
2. Enable automatic cleanup only when the saved retention policy should run in the
   background. **Keep worktree** protects an entry from retention cleanup.
3. For manual cleanup, select **Clean up** on the recorded worktree and confirm when
   prompted. The entry becomes recreatable and a recovery snapshot appears. Files
   and Git state stay in the snapshot and continue consuming disk space.
4. Select **Restore** on the snapshot to return it to the recorded path. Resolve an
   occupied destination or active task before retrying; restoration does not overwrite
   either location. Restore retained snapshots before switching workspace ownership.
5. Under **Environment**, enable initialization, enter the script, variables and
   timeout, and save before creating a worktree. A saved script appears as configured
   in Settings; enter new text to replace it, or use **Clear** and save to remove it
   and disable setup. New checkouts record a pending
   setup checkpoint without executing the script. In Ling Desktop, use **Retry setup**
   to review the script and approve it in the native dialog. A failed entry exposes
   redacted output and can be retried
   after the policy is corrected; existing and restored checkouts do not rerun setup
   automatically.

### Environment Initialization

Only the saved local policy selects a script; repository documents and discovered files
do not authorize execution. Creating a worktree records a pending checkpoint and never
executes the saved command. The Desktop main process requests a preview from the daemon
and displays the exact saved script, target path, variable names and timeout before requesting
approval. The daemon accepts the decision over the authenticated Desktop bridge and
consumes the two-minute challenge on either decision. It rechecks the saved environment
and the worktree identity before running the approved script. Browser requests cannot
approve scripts. Initialization uses the existing manual workspace-terminal actor with
the current OS shell and account permissions. Its
variables apply to that script. It does not grant a native Runner sandbox or
protected-stage proof. Existing worktrees and restored snapshots are not
reinitialized automatically.

A private marker in the linked worktree's Git administrative directory records pending,
running, succeeded or failed state. Output is bounded and configured variable values are
redacted from the retained output. Ordinary settings and list responses use `[configured]`
for the script and variable values. The Desktop approval preview includes the script
and variable names. Pending or failed setup retains the directory and
blocks normal workspace readiness; the settings list exposes explicit retry with the
current saved policy. On POSIX, timeout escalates from SIGTERM to SIGKILL for the process
group and successful completion stops remaining children in that group. A retained running marker
requires the recorded process group to be absent before retry; an unknown process
identity remains blocked for local inspection. Process groups do not claim containment
of programs that deliberately escape their group. Windows descendant-process termination
and signed Desktop runtime acceptance have not been established by the macOS checks.

### Theme Integration

The panel reuses shared `Button`, `Input`, `Switch`, `Field`, `DataRow`,
`StatusIndicator`, `InlineFeedback`, `Skeleton` and `Dialog` components. Feature CSS
owns layout and consumes existing semantic text, border and card tokens;
shared components retain control, overlay and feedback appearance. The settings shell
keeps its existing continuous backdrop policy. The worktree panel uses the semantic
`--ling-bg-panel` solid surface to protect dense content over that backdrop, with no
feature-owned background layer.
Loading, empty, failed-load/retry, edited/saved, dirty/in-use, confirmation and action
failure states are covered by the browser interaction suite. English and Chinese
use the compiled localization catalogs; other supported locales receive the same
message keys through the catalog translation pipeline.

### Verification

`packages/daemon/test/worktree-management.test.ts` uses temporary Git repositories,
SQLite stores, a local bare remote and the daemon/API client boundary. It covers
policy validation and persistence, root selection, cleanup/recreation with retained
commits, fetch without merging, fetch failure, active/shared/foreign worktree
refusal, complete ownership pagination, staged/unstaged/ignored/untracked and symlink
restoration, restart/fencing, retention protection, initialization retry and timeout and local-origin/workspace access checks.
`worktree-http-boundary.test.ts` covers redacted settings, rejected browser initialization,
and an approved Desktop request with cancellation and replay checks. Desktop
`worktree-ipc.test.ts` exercises the native confirmation handler and sender checks.
`managed-workspace-cleanup.test.ts` covers the optional legacy request
body with confirmation enabled and disabled. Core `workspace-binding-fence.test.ts` and
`managed-workspace-admission.test.ts` cover cross-connection owner writes and stale Run
snapshots, settled `yielded` history and unfinished work; `teammate-hard-delete-access.test.ts`
covers owner retention at deletion. The four daemon TypeScript suites are explicitly
assigned to Linux CI and included in the daemon test typecheck.

`apps/web/e2e/worktree-settings.spec.ts` covers saving and navigation persistence,
opening paths, retention/environment persistence, snapshot restore, keep selections,
cleanup cancellation/focus/error retry, load retry and empty states,
Chinese/English, desktop/narrow-window layout and all six built-in themes. Browser
tests use the mock daemon for UI states; real filesystem and API behavior are covered
separately by the daemon tests. Web screenshots do not establish signed Desktop or
deployed-runtime acceptance.
