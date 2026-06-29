# Channel Workspace v1.28 Environment Git Status Implementation Plan

## Status

Implemented on 2026-06-29.

This is the canonical implementation plan for
[Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md).

It depends on:

- [Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md)
- [Channel Workspace v1.28 Environment Git Status Detailed Design](channel-workspace-v1.28-environment-git-status-detailed-design.md)

## Second-Version Verdict

Implement read-only daemon-backed Git status and split Environment `Changes` from
Environment `Review`.

v1.28 is complete when the channel Environment surface can answer:

```text
Does the selected channel workspace have real Git changes?
How many changed files are there?
What are the additions/deletions when safely available?
How many Ling Review items also need inspection?
```

It must still not answer:

```text
Can Ling commit these changes?
Can Ling push these changes?
Can Ling create or merge a branch?
```

Those remain later slices.

The important correction from v1.27 is:

```text
Review queue count is not a code change count.
```

If the user has local code changes, the second version must show a Git-derived change
count. If the user only has Review queue items, it must show Review, not Changes.

## Hard Non-Goals

- No commit.
- No push.
- No checkout or branch switch.
- No merge, rebase, stash, clean, pull, or fetch.
- No GitHub PR creation.
- No browser-side Git probes.
- No Web filesystem probing.
- No mutation approval flow.
- No shared cross-surface Environment package extraction.

## Expected File Scope

Contracts:

- `packages/contracts/src/channels.ts`
- `packages/contracts/src/index.ts` if required by export style

API client:

- `packages/api-client/src/endpoints/channels.ts`
- `apps/web/src/api/channels.ts`

Daemon:

- `packages/daemon/src/features/channels/workspace.ts`
- optional new `packages/daemon/src/features/channels/git-status.ts`
- `packages/daemon/src/server/routes.ts`
- `packages/daemon/src/server/router.ts`

Web:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/i18n.tsx`
- `apps/web/src/styles/components.css`

Tests:

- `apps/web/e2e/channel.spec.ts`
- `apps/web/e2e/support/mock-daemon.ts`
- parser tests near daemon code if the repo has a suitable daemon test pattern

Docs:

- `docs/design/channel-workspace.md`
- `docs/design/channel-workspace-v1.28-environment-git-status.md`
- `docs/design/channel-workspace-v1.28-environment-git-status-detailed-design.md`
- `docs/design/channel-workspace-v1.28-environment-git-status-implementation-plan.md`

Do not edit unrelated channel UX slices unless required by type propagation.

## Route And Ownership Decision

Use the existing channel workspace route shape:

```text
GET /channels/:channelId/workspace/git-status?cwd=<workspaceCwd>
```

Ownership:

- contracts own the response shape,
- api-client owns the typed transport method,
- daemon owns Git execution and parsing,
- Web owns rendering and stale-response handling,
- e2e mock owns deterministic clean/dirty/review-only/unavailable scenarios.

The browser must not call Git, read files, or infer dirty state from Review artifacts.

## Slice 0: Preflight

Goal: verify current v1.27 state and avoid mixing unrelated local changes.

Tasks:

1. Check `git status -sb`.
2. Confirm current v1.27 Environment code compiles.
3. Confirm `tmp/` and generated test artifacts are not staged.
4. Locate anchors:
   - `ChannelWorkspaceBinding`
   - `ChannelWorkspaceResponse`
   - `getChannelWorkspace`
   - `handleChannelWorkspace`
   - `WorkspaceClientView` Environment summary
   - `mockDaemon` channel workspace route

Done when:

- The implementation knows exact file anchors.
- No unrelated dirty files are staged.
- `tmp/` remains untracked and unstaged.
- Existing v1.27 Environment behavior is understood before changing it.

## Slice 1: Contracts

Goal: add a stable read-only Git status contract.

Tasks:

1. Add `WorkspaceGitStatusState`.
2. Add `WorkspaceGitFileKind`.
3. Add `WorkspaceGitStatusFile`.
4. Add `WorkspaceGitStatus`.
5. Add `ChannelWorkspaceGitStatusResponse`.
6. Export types consistently.
7. Include top-level `cwd` in `ChannelWorkspaceGitStatusResponse`.

Done when:

- Contracts build passes.
- Type names clearly distinguish Git status from Ling channel branches.
- The contract can represent clean, dirty, not-git-repo, unavailable, and error states.

Validation:

```bash
corepack pnpm --filter @ling-stack/contracts build
```

## Slice 2: API Client

Goal: expose the read-only status endpoint through the existing client layer.

Tasks:

1. Add `getChannelWorkspaceGitStatus(cwd, channelId)` to
   `packages/api-client/src/endpoints/channels.ts`.
2. Add Web wrapper to `apps/web/src/api/channels.ts`.
3. Keep route style consistent with existing channel workspace endpoints.
4. Do not let Web call raw `fetch` from `WorkspaceClientView`.
5. Use this exact route pattern unless the router changes first:

   ```ts
   this._get(`/channels/${encodeURIComponent(channelId)}/workspace/git-status`, { cwd });
   ```

Done when:

- API client build passes.
- Web can import a typed method.

Validation:

```bash
corepack pnpm --filter @ling-stack/api-client build
```

## Slice 3: Daemon Read-Only Git Status

Goal: implement the endpoint and parser without Git mutations.

Tasks:

1. Extend channel route parsing in `packages/daemon/src/server/routes.ts` with
   `workspaceAction: "git-status"`.
2. Keep `packages/daemon/src/server/router.ts` routing workspace actions through
   `handleChannelWorkspace(...)`.
3. Add a `GET` branch for `action === "git-status"` in
   `packages/daemon/src/features/channels/workspace.ts`.
4. Add a focused helper module if useful:
   `packages/daemon/src/features/channels/git-status.ts`.
5. Resolve channel by `channelId`.
6. Resolve execution path with the same channel workspace rules used for runs.
7. Return `unavailable` if workspace is not ready.
8. Run allowed read commands only:
   - `git rev-parse --show-toplevel`
   - `git status --porcelain=v1 -b --untracked-files=all`
   - `git diff --numstat`
   - `git diff --cached --numstat`
   - `git rev-parse --short HEAD`
9. Parse counts and file summaries.
10. Return `not_git_repo` for non-repository paths.
11. Return `error` for unexpected Git failures.
12. Never surface raw stack traces or full command stderr in the UI payload.

Done when:

- Dirty, clean, not-git-repo, and unavailable states can be represented.
- No mutation commands are present in code or tests.
- Expected workspace states return HTTP 200 with `gitStatus.state`; malformed requests
  and missing channels still use HTTP errors.

Recommended parser checks:

```text
## main...origin/main
 M apps/web/src/foo.ts
?? docs/new.md
R  old.ts -> new.ts
UU packages/core/src/conflict.ts
```

## Slice 4: Web Data Loading

Goal: load Git status for the selected channel workspace.

Tasks:

1. Add `ChannelGitStatusLoadState`.
2. Fetch when selected channel and execution path are available.
3. Refresh when Environment page opens.
4. Refresh when progress popover opens.
5. Cancel or ignore stale responses when channel changes.
6. Keep transport errors separate from `gitStatus.state === "error"`.
7. Guard against stale responses when the user switches channel/workspace while a request
   is in flight.
8. Do not show `No code changes` while the request is loading or failed.

Done when:

- Environment UI receives a typed Git status or an explicit unavailable state.
- Network/daemon failure does not render as clean.
- Git status data is never applied to the wrong selected channel.

## Slice 5: Environment Summary Split

Goal: split Git changes from Review queue.

Tasks:

1. Replace v1.27 `changes` summary derived from `channelDockReviewItems`.
2. Add `gitChanges` from `WorkspaceGitStatus`.
3. Add `review` from `channelDockReviewItems`.
4. Build popover rows in this order:
   - `Changes`
   - `Review`
   - `Local environment`
   - `Working branch`
   - `Commit or push`
5. Keep `Commit or push` disabled.
6. Ensure Review row opens right dock Review.
7. Decide first-slice behavior for Changes click:
   - either open Review filtered to code changes if the right dock supports it,
   - or keep Changes row read-only until file detail UI exists.
8. Prefer the read-only first behavior if there is no real file-detail page yet. Do not
   pretend Review is a Git diff view.

Done when:

- Review-only state shows `Review`, not `Changes`.
- Git dirty state shows `Changes`.
- `+0 -0` is never rendered for missing stats.
- Dirty Git plus Review queue shows two rows, not a merged count.

## Slice 6: Full Environment Page UI

Goal: make the page explain both Git and Review state clearly.

Tasks:

1. Add a dedicated Changes section backed by Git status.
2. Add a dedicated Review section backed by right-dock Review queue.
3. Show Git status unavailable states:
   - clean,
   - dirty,
   - not Git repo,
   - unavailable,
   - error.
4. Keep Local, Working branch, Commit or push, Browser, Sources, and Output sections.
5. Prefer Git status branch over workspace binding branch when available.
6. If Git status is loading, show a compact status in the Changes section.
7. If Git status transport fails, show `Git status unavailable`; do not call it clean.

Done when:

- User can tell whether there are real code changes.
- User can tell whether there are only review items.
- The UI does not imply commit/push is available.

## Slice 7: Mock Daemon And E2E

Goal: lock the semantic boundary in tests.

Mock daemon tasks:

1. Add route for channel workspace Git status.
2. Add fixture state for:
   - dirty workspace with stats,
   - dirty workspace without stats,
   - clean workspace,
   - review-only,
   - not-git-repo,
   - daemon failure.

E2E cases:

1. Dirty workspace:

```text
Changes
2 changed files
+12 -3
```

2. Review-only:

```text
Review
2 review items
```

and no `Changes`.

3. Clean workspace and no review:

```text
No code changes
```

on full page; no Changes row in popover.

4. Not Git repo:

```text
Not a Git repository
```

on full page; no fake clean state.

5. Transport failure:

```text
Git status unavailable
```

not `No code changes`.

6. Dirty Git plus Review:

```text
Changes
2 changed files
Review
2 review items
```

and no combined `4` count.

Done when:

- E2E proves the exact user confusion from v1.27 cannot regress.
- Mock state can answer the Git endpoint without affecting unrelated channel tests.

## Slice 8: Verification

Required commands:

```bash
git diff --check
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/api-client build
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g "channel environment"
```

If the daemon package does not expose `build`, run the narrow package validation command
that the repo actually provides. If daemon parser unit tests are added, run the narrow
daemon test command used by the repo.

Manual smoke check:

1. Open a channel with a dirty selected workspace.
2. Open the floating Environment popover.
3. Confirm `Changes` shows changed file count and optional `+N -N`.
4. Open the full Environment page.
5. Confirm Review items, if any, are separate from Changes.
6. Confirm commit/push remains disabled.

## First PR Boundary For v1.28

Complete:

- Contract types exist.
- Daemon read-only endpoint exists.
- Web loads Git status through api-client.
- Environment popover splits Changes and Review.
- Environment full page explains Git unavailable states.
- Tests cover dirty, clean, review-only, and unavailable states.
- Docs match implemented route and data ownership.

Incomplete and must move later:

- commit
- push
- stage/unstage
- branch switch
- GitHub PR
- shared cross-surface Environment extraction

## Expected User-Visible Outcomes

When the local Git workspace has changes and no review items:

```text
变更
2 个变更文件
+12 -3
```

When the workspace is clean but Ling has review items:

```text
审查
2 个待审项
```

When both exist:

```text
变更
2 个变更文件

审查
2 个待审项
```

When Git status is unavailable:

```text
Git 状态不可用
```

Do not show:

```text
变更
2 个待审项
```
