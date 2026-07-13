# Workspace Change Review, Recovery, And Open Actions

Status: implementation design
Date: 2026-07-13
Scope: conversation work-cell change actions, workspace review drawer, reversible Agent
patches, workspace file opening, and changed-file navigation

## Goal

Ling Stack should provide a Codex-like change workflow without treating every workspace
change as Agent-owned:

```text
completed work cell
  -> inspect current workspace changes
  -> review changed files in the existing right dock
  -> undo only the selected run's verified Agent patch
  -> reapply that same patch when the reverted baseline is still intact
  -> open a real workspace file in a local application or download a copy
```

The critical product rule is that review scope and recovery scope are different:

- review shows the active Git working tree,
- undo and reapply operate only on the selected run's recorded patch plans.

## Codex Reference Boundary

Checked against `openai/codex` main commit
`2f7d89b1419bf7064346855b0acde23514b1ebc5`:

- `codex-rs/app-server/README.md` documents `review/start` with
  `{"type":"uncommittedChanges"}` as staged, unstaged, and untracked files,
- `codex-rs/app-server-protocol/src/protocol/v2/review.rs` models review targets as
  uncommitted changes, base branch, commit, or custom instructions,
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs` represents file changes as
  structured path, kind, diff, and patch status,
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` explicitly states that thread
  rollback changes conversation history only and does not revert local files,
- `codex-rs/protocol/src/protocol.rs` assigns filesystem recovery responsibility to the
  client.

The Codex desktop UI shown in product screenshots is not present in the public repository.
Ling therefore borrows the public protocol semantics, not undocumented UI internals.

## Product Decisions

### Review Means Current Uncommitted Workspace

The Review page loads the active execution directory and includes:

- staged files,
- unstaged files,
- untracked files,
- rename and delete status,
- unified diff with three context lines,
- additions and deletions by file and in aggregate.

Staged and unstaged layers are loaded independently. This preserves an index change even
when a later worktree edit returns the file contents to `HEAD`. Tracked diff output is
streamed into a bounded preview while `--numstat` keeps full-file counts. Large untracked
text files expose a bounded prefix and set `truncated` instead of silently reporting an
empty diff.

The Review page must refresh from disk. Terminal reports and artifacts can provide a
fallback preview, but they are not the authority for current workspace state.

### Undo Means Run-Owned Patch Recovery

Undo is available only when all of these conditions hold:

- the run is no longer active,
- at least one approved `write` or `edit` action contains a
  `ling-apply-patch-v1` `PatchPlan`,
- all touched paths remain inside the run workspace and the current allowed write scope,
- current file hashes match the final hashes recorded by the run's patch sequence,
- no later user, shell, editor, or Agent modification has changed those files.

Undo applies the inverse patch plans in reverse order. It never executes
`git checkout`, `git reset`, or a repository-wide restore.

### Reapply Means Exact Patch Replay

After undo, Ling records a run event marking the patch set as undone. Reapply is enabled
only when:

- the latest recovery event is the undo event,
- current file hashes match the original hashes recorded before the run,
- the current write policy still authorizes every touched path.

Reapply uses the original patch plans in forward order. Any mismatch becomes a conflict
and disables both actions until the user resolves the workspace manually.

Patch plans retain old and new text-format metadata for line endings and final-newline
state. Inverse application must preserve CRLF and files without a trailing newline rather
than rebuilding every file as LF text.

### Unsupported Changes Stay Visible But Not Reversible

The following changes may appear in Review but do not receive automatic undo:

- files changed by Shell commands,
- files changed by an external editor,
- binary modifications,
- patches without stable before/after hashes,
- files changed again after the run,
- user changes that predate the run.

The UI should show Review while omitting or disabling Undo with a concrete reason.

## Right Dock Interaction

Ling keeps one workspace right dock.

```text
workspace right dock
  review page
    diff scroll surface
    optional internal changed-file navigator
```

The internal navigator:

- opens from a folder-tree icon in the Review header,
- overlays the right side of the Review page instead of changing the global layout,
- groups files by relative directory,
- shows file-type icons and per-file change stats,
- filters by path,
- scrolls the existing diff surface to the selected file,
- can be hidden without closing Review.

The navigator reads the same `WorkspaceChangesResponse` as the diff surface, so counts
and paths cannot diverge.

## Work-Cell Actions

The completed changed-files summary exposes:

- `Undo` when the run patch state is `applied`,
- `Reapply` when the state is `undone`,
- `Review` whenever a workspace directory is available.

Actions are placed in the changed-files summary header. They do not create a second card
or duplicate the file list.

Undo requires an explicit confirmation naming the file count. Reapply also confirms when
the patch contains deletes.

## Workspace File Open Actions

Workspace file detail provides an `Open with` menu. The daemon resolves and validates the
file before launching anything.

Options are derived from applications the daemon can actually launch. Ling does not show
a generic `Default app` entry. The supported discovery set starts with:

- Visual Studio Code, Cursor, Zed, Sublime Text, TextEdit, and Xcode when installed,
- PyCharm, WebStorm, and IntelliJ IDEA when installed,
- Finder reveal on macOS,
- Terminal at the containing directory,
- download copy through a workspace-scoped content endpoint.

Security rules:

- browser requests must come from a local HTTP(S) Origin; requests without Origin remain
  available to local CLI clients,
- the requested `cwd` must resolve to a daemon-known workspace, persisted channel binding,
  or run execution directory,
- both lexical and real paths must remain inside the active workspace root,
- only regular files can be opened or downloaded,
- commands use argument arrays; Windows `.cmd` and `.bat` shims use a controlled
  `cmd.exe` wrapper with the command and arguments passed through environment variables,
- run Artifact paths remain relative to `.ling-stack/artifacts` and are never treated as
  workspace file paths,
- downloads stream file bytes instead of buffering the complete file in daemon memory,
- unavailable applications are omitted or disabled,
- the Web client never receives an unrestricted local-file URL.

Line-addressed file references request a bounded text window around the target line. The
response carries the first visible source line so the right dock can preserve real line
numbers without loading the full file.

## Contracts

```ts
interface WorkspaceChangesResponse {
  readonly cwd: string;
  readonly state: WorkspaceGitStatusState;
  readonly repoRoot?: string;
  readonly branchName?: string;
  readonly headSha?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly WorkspaceChangeFile[];
  readonly totalFileCount: number;
  readonly truncated: boolean;
  readonly checkedAt: string;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

interface RunWorkspaceChangesResponse {
  readonly cwd: string;
  readonly runId: string;
  readonly state: "applied" | "undone" | "conflicted" | "unavailable";
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: PatchSummary;
  readonly unavailableReason?: string;
}
```

## API Surface

```text
GET  /workspace/changes?cwd=...
GET  /workspace-files/open-options?cwd=...&path=...
POST /workspace-files/open?cwd=...&path=...
GET  /workspace-files/content?cwd=...&path=...&download=1

GET  /runs/:runId/workspace-changes?cwd=...
POST /runs/:runId/workspace-changes/undo?cwd=...
POST /runs/:runId/workspace-changes/reapply?cwd=...
```

## Failure Handling

- A changed hash returns `409 workspace_change_conflict`; no file is written.
- A path outside the workspace returns `403`.
- A missing run or file returns `404`.
- An active run returns `409 run_not_terminal`.
- A run without reversible patch plans returns `200` with `state: unavailable` for GET
  and `409` for mutations.
- Multi-plan recovery performs a complete in-memory preflight before the first disk write.

## Verification

Required coverage:

- inverse patch generation for add, update, and delete,
- multi-action undo in reverse order and reapply in forward order,
- conflict detection after an intervening edit,
- workspace diff for staged, unstaged, and untracked files,
- staged and unstaged changes that cancel in the worktree but remain pending in the index,
- tracked diffs larger than the Git helper buffer and large untracked text files,
- NUL-delimited Git status parsing for non-ASCII and renamed paths,
- subdirectory workspace review using repository-root-relative paths,
- explicit changed-file truncation metadata,
- CRLF and no-trailing-newline undo/reapply round trips,
- target-line preview windows for files beyond the first preview chunk,
- local-Origin and daemon-known workspace enforcement,
- path escape rejection for preview, open, and download,
- work-cell action-state rendering,
- Review navigator open, filter, file click, and diff scroll,
- Open-with option menu and request payload,
- channel, normal conversation, and teammate-private shared rendering.
