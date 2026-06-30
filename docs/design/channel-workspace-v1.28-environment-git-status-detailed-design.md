# Channel Workspace v1.28 Environment Git Status Detailed Design

## Status

Detailed design for
[Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md).

Implementation sequencing:
[Channel Workspace v1.28 Environment Git Status Implementation Plan](channel-workspace-v1.28-environment-git-status-implementation-plan.md).

This document is implementation-shaped. It names the contracts, daemon endpoint, parser
rules, Web data flow, UI model, and tests required to avoid drifting back into the v1.27
review-count-as-change-count problem.

## Current Code Anchors

Existing v1.27 UI anchors:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/features/workspace/right-dock/WorkspaceRightDock.tsx`
- `apps/web/src/features/workspace/right-dock/projections.ts`
- `apps/web/src/styles/components.css`
- `apps/web/src/i18n.tsx`
- `apps/web/e2e/channel.spec.ts`

Existing channel workspace API anchors:

- `packages/contracts/src/channels.ts`
- `packages/api-client/src/endpoints/channels.ts`
- `apps/web/src/api/channels.ts`
- `packages/daemon/src/features/channels/workspace.ts`
- `packages/daemon/src/server/routes.ts`
- `packages/daemon/src/server/router.ts`
- `apps/web/e2e/support/mock-daemon.ts`

v1.28 should extend the channel workspace family rather than create an unrelated
workspace API.

## First Principle

Do not use right-dock Review items to infer real Git changes.

Review items answer:

```text
What should a human inspect?
```

Git status answers:

```text
What changed in the working tree or index?
```

The Environment summary model should carry both:

```ts
interface ChannelEnvironmentSummary {
  readonly workspace?: ChannelEnvironmentWorkspace;
  readonly gitStatus?: WorkspaceGitStatus;
  readonly changes?: ChannelEnvironmentGitChanges;
  readonly review?: ChannelEnvironmentReviewSummary;
  readonly git?: ChannelEnvironmentGitBranch;
  readonly browser?: ChannelEnvironmentEvidenceSummary;
  readonly sources?: ChannelEnvironmentEvidenceSummary;
  readonly output?: ChannelEnvironmentOutputSummary;
  readonly commitAction?: ChannelEnvironmentCommitAction;
  readonly popoverRows: readonly ChannelEnvironmentPopoverRow[];
}
```

This is not just a copy change. It is a data ownership split:

| UI concept | Owner | Allowed source | Forbidden source |
| --- | --- | --- | --- |
| `Changes` row | Environment Git status | `WorkspaceGitStatus` from daemon | Review queue item count |
| `Review` row | Right dock Review queue | `channelDockReviewItems` projection | Git changed-file count |
| Git branch | Git status when available | daemon Git status | Ling channel branch name |
| Commit/push affordance | future Git mutation slice | disabled shell only | v1.28 Git status alone |

## Contract Additions

Add to `packages/contracts/src/channels.ts`.

Recommended types:

```ts
export type WorkspaceGitStatusState =
  | "clean"
  | "dirty"
  | "not_git_repo"
  | "unavailable"
  | "error";

export type WorkspaceGitFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "unknown";

export interface WorkspaceGitStatusFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly kind: WorkspaceGitFileKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export interface WorkspaceGitStatus {
  readonly state: WorkspaceGitStatusState;
  readonly cwd: string;
  readonly repoRoot?: string;
  readonly branchName?: string;
  readonly upstream?: string;
  readonly headSha?: string;
  readonly changedFileCount: number;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  readonly conflictedFileCount: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly files: readonly WorkspaceGitStatusFile[];
  readonly checkedAt: string;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

export interface ChannelWorkspaceGitStatusResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly binding: ChannelWorkspaceBinding;
  readonly snapshot: ChannelWorkspaceSnapshot;
  readonly gitStatus: WorkspaceGitStatus;
}
```

Export these from `packages/contracts/src/index.ts` if the package uses explicit exports.

## API Client Additions

Add a read method to `packages/api-client/src/endpoints/channels.ts`:

```ts
async getChannelWorkspaceGitStatus(
  this: LingDaemonEndpointContext,
  cwd: string,
  channelId: string,
): Promise<ChannelWorkspaceGitStatusResponse>
```

Suggested route:

```text
GET /channels/:channelId/workspace/git-status?cwd=<workspaceCwd>
```

This route intentionally matches the current channel workspace transport style:

```ts
this._get(`/channels/${encodeURIComponent(channelId)}/workspace/git-status`, { cwd });
```

Do not add a `/workspaces/:cwd/...` variant in v1.28. `cwd` is the Ling workspace root,
not necessarily the Git execution path. The daemon must resolve the selected channel's
execution path before running Git.

Add Web wrapper in `apps/web/src/api/channels.ts`:

```ts
export async function getChannelWorkspaceGitStatus(
  cwd: string,
  channelId: string,
): Promise<ChannelWorkspaceGitStatusResponse>
```

## Daemon Endpoint

Extend `packages/daemon/src/features/channels/workspace.ts` or add a focused helper file
near it, for example:

```text
packages/daemon/src/features/channels/git-status.ts
```

Recommended split:

- `handleChannelWorkspaceGitStatus(...)` wires HTTP to store/channel lookup.
- `inspectWorkspaceGitStatus(executionPath, now)` runs read-only Git commands.
- `parseGitStatusPorcelain(stdout)` parses status lines.
- `parseGitNumstat(stdout)` parses additions/deletions.
- `buildUnavailableGitStatus(...)` returns non-throwing unavailable states.

Do not mix the parser into the React UI or api-client.

### Router Integration

The existing router parses channel workspace actions in
`packages/daemon/src/server/routes.ts`.

Extend the `workspaceAction` union:

```ts
readonly workspaceAction?:
  | "create-worktree"
  | "handoff"
  | "refresh"
  | "cleanup"
  | "git-status";
```

Extend the route matcher:

```ts
segments.length === 4 &&
segments[0] === "channels" &&
segments[2] === "workspace" &&
(segments[3] === "create-worktree" ||
  segments[3] === "handoff" ||
  segments[3] === "refresh" ||
  segments[3] === "cleanup" ||
  segments[3] === "git-status")
```

`packages/daemon/src/server/router.ts` should continue routing all workspace actions to
`handleChannelWorkspace(...)`.

### Workspace Handler Flow

`handleChannelWorkspace(...)` should handle Git status before mutation actions:

```ts
if (action === "git-status" && request.method === "GET") {
  const binding = channel.workspaceBinding ?? defaultChannelWorkspaceBinding(channel, cwd);
  const snapshot = createChannelWorkspaceSnapshot({ ...channel, workspaceBinding: binding }, cwd);
  const ready = assertChannelWorkspaceReady({ ...channel, workspaceBinding: binding }, cwd);
  const checkedAt = new Date().toISOString();
  const gitStatus = ready.ok
    ? await inspectWorkspaceGitStatus(ready.executionCwd, checkedAt)
    : buildUnavailableWorkspaceGitStatus(snapshot.executionCwd, checkedAt, ready.message);

  writeJson(response, 200, {
    cwd,
    channelId,
    binding,
    snapshot,
    gitStatus,
  });
  return;
}
```

The handler must return a structured `gitStatus.state` for expected workspace states
instead of converting them into HTTP errors. Use HTTP errors only for malformed requests
or missing channels.

## Daemon Command Policy

Allowed commands:

```bash
git rev-parse --show-toplevel
git status --porcelain=v1 -b --untracked-files=all
git diff --numstat
git diff --cached --numstat
git rev-parse --short HEAD
```

Recommended execution details:

- Use existing daemon command helpers if available.
- Set cwd to the resolved channel execution path.
- Use a short timeout, for example 3-5 seconds per command.
- Capture stdout/stderr with bounded buffers.
- Never invoke a shell string if an argv-based helper exists.
- If a command fails because the path is not a Git repository, return
  `state: "not_git_repo"`.
- If the path is missing or channel workspace is not ready, return `state:
  "unavailable"`.
- If Git returns an unexpected error, return `state: "error"` with safe summary text.

Do not run:

```text
git add
git checkout
git switch
git clean
git stash
git commit
git push
git pull
git fetch
git merge
git rebase
```

## Parsing Rules

### Branch Header

For `git status --porcelain=v1 -b`:

```text
## main...origin/main [ahead 1, behind 2]
 M apps/web/src/foo.ts
?? docs/new.md
```

Parse:

- branch name: `main`
- upstream: `origin/main`
- ahead/behind may be deferred in v1.28 unless easy to include.

Detached HEAD may appear like:

```text
## HEAD (no branch)
```

Represent branch as missing or `HEAD` with `headSha`.

### File Status

Each non-header line uses two status columns:

```text
XY path
```

Rules:

- `X` is index status.
- `Y` is worktree status.
- `??` is untracked.
- `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD` are conflicted.
- Rename/copy lines may contain `old -> new`; store `originalPath`.

Count a file once even if it is staged and unstaged.

Recommended field mapping:

| Porcelain status | `kind` | staged | unstaged | untracked | conflicted count |
| --- | --- | ---: | ---: | ---: | ---: |
| ` M path` | `modified` | false | true | false | no |
| `M  path` | `modified` | true | false | false | no |
| `MM path` | `modified` | true | true | false | no |
| `A  path` | `added` | true | false | false | no |
| ` D path` / `D  path` | `deleted` | depends on column | depends on column | false | no |
| `?? path` | `untracked` | false | false | true | no |
| `R  old -> new` | `renamed` | true | false | false | no |
| `C  old -> new` | `copied` | true | false | false | no |
| `UU path` / `AA path` / `DD path` / `AU path` / `UA path` / `DU path` / `UD path` | `conflicted` | true | true | false | yes |

For rename/copy, `path` should be the new path and `originalPath` should be the old
path. If parsing is ambiguous, keep the raw path as `path` and use `kind: "unknown"`.

### Numstat

For `git diff --numstat` and `git diff --cached --numstat`:

```text
12  3  apps/web/src/foo.ts
-   -  assets/image.png
```

Rules:

- Sum numeric additions/deletions.
- Ignore binary `- -` rows for additions/deletions.
- Do not set additions/deletions to `0` to mean unavailable.
- If both commands return no numeric rows, omit `additions` and `deletions` unless there
  are known text diffs with zero changed lines.

UI must not render `+0 -0` for omitted stats.

### Count Rules

Counts must come from the full parsed status output, not from the capped `files` preview:

```ts
changedFileCount = files.length;
stagedFileCount = files.filter((file) => file.staged).length;
unstagedFileCount = files.filter((file) => file.unstaged).length;
untrackedFileCount = files.filter((file) => file.untracked).length;
conflictedFileCount = files.filter((file) => file.kind === "conflicted").length;
```

If the implementation caps returned file previews, compute counts before the cap.

### State Rules

```ts
if (!workspaceReady) state = "unavailable";
else if (!insideGitRepo) state = "not_git_repo";
else if (unexpectedGitFailure) state = "error";
else if (changedFileCount > 0) state = "dirty";
else state = "clean";
```

Transport failure is a Web load state, not a Git state. Do not convert a failed HTTP
request into `clean`.

## Web Data Flow

In `WorkspaceClientView.tsx`:

1. Resolve `selectedChannelExecutionPath` as today.
2. When a selected channel has a ready workspace path, request Git status.
3. Cache per `selectedChannelId + selectedChannelExecutionPath`.
4. Refresh on:
   - channel selection change,
   - workspace binding refresh,
   - Environment page open,
   - progress popover open,
   - right dock Review open after an operation if a refresh hook exists.
5. Avoid tight polling in v1.28.

Suggested local state:

```ts
type ChannelGitStatusLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly statusValue: WorkspaceGitStatus }
  | { readonly status: "error"; readonly errorMessage: string };
```

If the API response itself has `gitStatus.state === "error"`, keep that as loaded data.
Use transport error only for daemon/network failure.

### Stale Response Guard

When a Git status request resolves, apply it only if the selected channel and execution
path still match the request. A minimal guard is:

```ts
const requestKey = `${selectedChannelId}:${selectedChannelExecutionPath}`;
```

Store the key with the loading state or close over a cancellation flag in the effect. This
prevents a slow status response from one channel from updating another channel's
Environment surface.

## Environment Presentation Model

Replace the v1.27 `changes` derivation:

```ts
const changes = channelDockReviewItems.reduce(...)
```

with two independent summaries:

```ts
const gitChanges = gitStatus && gitStatus.state === "dirty"
  ? buildGitChanges(gitStatus, t)
  : undefined;

const review = channelDockReviewItems.length > 0
  ? buildReviewSummary(channelDockReviewItems, t)
  : undefined;
```

Recommended types:

```ts
interface ChannelEnvironmentGitChanges {
  readonly changedFileCount: number;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  readonly conflictedFileCount: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly label: string;
}

interface ChannelEnvironmentReviewSummary {
  readonly reviewItemCount: number;
  readonly actionItemCount: number;
  readonly label: string;
}
```

`Changes` row uses `gitChanges`.

`Review` row uses `review`.

Suggested popover row ids:

```ts
type ChannelEnvironmentPopoverRowId =
  | "changes"
  | "review"
  | "workspace"
  | "git"
  | "commit"
  | "browser"
  | "sources"
  | "output";
```

`changes` should be visible only when `gitChanges` exists. `review` should be visible
only when `review` exists.

## UI Copy

English:

- `Changes`
- `Review`
- `No code changes`
- `Git status unavailable`
- `Not a Git repository`
- `1 changed file`
- `{count} changed files`
- `1 review item`
- `{count} review items`

Chinese:

- `变更`
- `审查`
- `暂无代码变更`
- `Git 状态不可用`
- `不是 Git 仓库`
- `1 个变更文件`
- `{count} 个变更文件`
- `1 个审查项`
- `{count} 个待审项`

Use `待审项` only for multi-item Review queue count if that matches current project copy.
Do not use `待审项` for Git file changes.

## UI States

| Git state | Review count | Popover rows |
| --- | ---: | --- |
| dirty | 0 | `Changes` |
| dirty | >0 | `Changes`, `Review` |
| clean | 0 | no Changes or Review row |
| clean | >0 | `Review` |
| not_git_repo | >0 | `Review`; full page says not a Git repo |
| unavailable/error | >0 | `Review`; full page says Git status unavailable/failed |

Full page always has room to explain unavailable Git status. Popover stays compact.

## Tests

Unit or focused parser tests should cover:

- clean porcelain output,
- modified tracked file,
- staged added file,
- untracked file,
- renamed file,
- conflicted file,
- detached HEAD,
- not a Git repo command failure,
- numstat with binary rows.

Web e2e/mock tests should cover:

- dirty Git status shows `Changes` and changed file count,
- dirty Git status with stats shows `+N -N`,
- review-only status shows `Review`, not `Changes`,
- clean Git plus no review hides both rows in the popover,
- not-git-repo full page shows compact unavailable state,
- daemon/network failure is not rendered as clean.

### Mock Fixtures

Mock daemon should support at least these fixture shapes:

```ts
clean: {
  state: "clean",
  changedFileCount: 0,
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  conflictedFileCount: 0,
  files: [],
}

dirtyWithStats: {
  state: "dirty",
  changedFileCount: 2,
  stagedFileCount: 1,
  unstagedFileCount: 1,
  untrackedFileCount: 0,
  conflictedFileCount: 0,
  additions: 12,
  deletions: 3,
}

notGitRepo: {
  state: "not_git_repo",
  changedFileCount: 0,
  unavailableReason: "Selected channel workspace is not a Git repository.",
}
```

Review-only tests should combine `clean` Git status with existing right-dock Review
fixtures. They should assert that `Changes` is absent and `Review` is present.

## Accessibility

- `Changes` and `Review` rows are separate buttons when they open different targets.
- `Changes` may open a file/change detail later; in v1.28 it may open Review or remain
  read-only if no file list UI exists.
- `Review` opens right dock Review.
- Numeric diff stats need an aria label like `12 additions, 3 deletions`.
- Unavailable state text must be visible, not title-only.

## Implementation Constraint

Do not enable commit/push because Git status is available. Status is evidence, not
permission.

## Explicit Non-Drift Rules

- Do not rename Ling channel branches to Git branches in UI copy.
- Do not show Review queue counts in the `Changes` section.
- Do not show Git changed-file counts in the `Review` section.
- Do not show `+0 -0` unless Git numstat actually returned numeric zero additions and
  numeric zero deletions for known text diff rows.
- Do not add polling faster than user-triggered refresh in v1.28.
- Do not introduce a reusable cross-surface Environment package in this slice. Keep that
  for the broader shared conversation UI work.
