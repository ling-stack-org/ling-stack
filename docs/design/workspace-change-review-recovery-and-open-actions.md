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

### Multi-Agent Undo Means Workflow-Owned Atomic Recovery

A completed multi-agent work cell can aggregate reversible patches from several runs.
Binding its `Undo` action to the latest run would be incorrect because the visible changed-
files summary can contain earlier Engineer, QA, or follow-up edits. Ling therefore uses a
workflow recovery target for channel workflow work cells.

Workflow recovery:

- collects every terminal run attached to the workflow's steps, including retry runs whose
  `workflowStepId` still points at the workflow;
- ignores read-only runs with no successfully applied reversible PatchPlan;
- requires every recoverable run to use the same execution directory;
- validates each PatchPlan against the write-scope snapshot of the run that created it and
  against the current workspace policy;
- orders plans by successful tool completion time, with workflow step position, run creation
  time, and in-run plan order as deterministic tie-breakers;
- preflights the complete cross-run patch sequence in memory before the first filesystem
  mutation;
- undoes the combined sequence in reverse order and reapplies it in forward order;
- commits all resulting file states with the same compare-before-write and best-effort
  rollback guarantees as run recovery;
- records one workflow-scoped recovery intent on a deterministic workflow run so daemon
  restart reconciliation can distinguish fully applied, fully reverted, and interrupted
  recovery states.

The workflow action is available only when at least one reversible PatchPlan exists. It
does not claim ownership of shell, external-editor, binary, or otherwise unrecorded
changes; those changes remain visible in Review but outside automatic recovery.

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

The same menu is available inline on workspace-backed output rows in the final
conversation artifact strip. This is not a generic Artifact action. The shared
conversation view model carries an optional `workspaceFilePath`, and the Web renderer
shows the menu only when that field is present.

Projection rules:

1. Collect the structured changed paths from `TerminalReport.changes[].paths`.
2. For each conversation-visible TerminalReport artifact, collect its user-visible
   `sourceRefs` whose kind is `file`.
3. Keep only file references whose normalized id exactly matches a structured changed path.
4. Populate `ConversationArtifactStripItem.workspaceFilePath` only when exactly one trusted
   changed path remains.
5. Do not infer workspace authority from the Artifact path, title, basename, href, or raw
   Run Artifact storage location. Missing or ambiguous file references leave the action
   unavailable.

The mapping is deliberately performed in `conversation-ui-core`, not in JSX. Channel,
normal-conversation, and teammate-private projections therefore receive the same semantic
item and cannot drift into separate UI rules.

The evidence collector establishes the trusted binding before synthesis. For `edit` and
`write` execution actions, each result Artifact inherits the action's structured file
target references. Deterministic fallback therefore retains the same binding without
trusting an Artifact storage path. Model synthesis may reuse only source references bound
to that same evidence Artifact; borrowing a file reference from another operation or
Artifact fails TerminalReport validation.

The row composition is:

```text
artifact row container
  preview button or link
  Open with menu
```

The menu must not be nested inside the preview button. Pointer and keyboard interaction on
the preview surface retains the existing two-second hover preview and immediate focus/click
preview. Pointer and keyboard interaction on `Open with` owns only its menu.

The wide conversation surface uses `Open with`; the right-dock file detail uses compact
`Open`. Both reuse `WorkspaceFileOpenMenu` and the same daemon endpoints. Conversation
rows choose above or below from the nearest clipping scroll container's available space;
the selected side's available height also bounds the scrollable popover. Opening the menu
must not increase feed scroll height or place menu actions outside that visible boundary.

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

interface WorkflowWorkspaceChangesResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly runIds: readonly string[];
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
}

type ConversationWorkspaceRecoveryTarget =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };
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

GET  /workflows/:workflowId/workspace-changes?cwd=...
POST /workflows/:workflowId/workspace-changes/undo?cwd=...
POST /workflows/:workflowId/workspace-changes/reapply?cwd=...
```

## Failure Handling

- A changed hash returns `409 workspace_change_conflict`; no file is written.
- A path outside the workspace returns `403`.
- A missing run or file returns `404`.
- An active run returns `409 run_not_terminal`.
- A run without reversible patch plans returns `200` with `state: unavailable` for GET
  and `409` for mutations.
- A workflow whose recoverable runs use different execution directories returns
  `state: unavailable`; Ling never spans one recovery across multiple worktrees.
- A workflow recovery conflict returns before the first file write. A write-time race
  triggers the same bounded rollback used by run recovery.
- Multi-plan recovery performs a complete in-memory preflight before the first disk write.

## Verification

Required coverage:

- inverse patch generation for add, update, and delete,
- multi-action undo in reverse order and reapply in forward order,
- multi-run workflow undo in reverse workflow order and reapply in forward workflow order,
- overlapping edits to the same file across two workflow runs,
- workflow recovery rejection for active runs, mixed execution directories, revoked write
  scope, and intervening file edits,
- interrupted workflow recovery intent reconciliation after the filesystem commit,
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
- shared work-cell routing for run and workflow recovery targets,
- Review navigator open, filter, file click, and diff scroll,
- Open-with option menu and request payload,
- inline Open-with rendering for TerminalReport artifacts with one trusted changed-file
  source reference,
- no inline Open-with action for raw Artifact storage paths, exact paths without a trusted
  file reference, or ambiguous file references,
- menu interaction does not trigger the artifact preview,
- channel, normal conversation, and teammate-private shared rendering.
