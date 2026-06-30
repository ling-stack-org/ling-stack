# Channel Workspace v1.27 Environment Surface

## Status

Proposed on 2026-06-29. First read-only implementation landed on 2026-06-29.

The landed first slice includes the channel Environment menu item, full Environment page,
floating popover Environment rows, direct Changes-to-Review navigation, and a disabled
commit/push modal shell. It intentionally does not include daemon Git status, real
commit/push, or browser-side Git probes.

This slice extends the v1.25 Codex-inspired progress popover with a concrete environment
model and adds a channel-level Environment page opened from the channel `...` menu. It
does not add Git mutations, daemon shell probes, or persistent workspace-status storage
in the first implementation.

Detailed implementation shape:
- [Channel Workspace v1.27 Environment Surface Detailed Design](channel-workspace-v1.27-environment-surface-detailed-design.md)
- [Channel Workspace v1.27 Environment Surface First Implementation Plan](channel-workspace-v1.27-environment-surface-implementation-plan.md)

## Summary

The channel UI needs a compact place to answer:

```text
What environment is this channel using?
What changed?
Which working branch is active?
Is there anything to review, commit, push, or source-check?
```

The answer belongs in two surfaces:

1. A floating Environment section inside the existing channel progress popover.
2. A full channel Environment page, opened from the channel `...` menu, using the same
   full-page pattern as Channel Settings.

The design borrows the Codex pattern of an environment/status panel that can show changes,
local environment, branch, commit/push affordances, browser, and sources. Ling must adapt
that pattern to a channel-scoped, multi-agent product. The UI must not assume every
channel is a Git repository, and it must not confuse Ling channel branches with Git
branches.

Reference pattern boundary:

- OpenAI Codex open-source project: <https://github.com/openai/codex>
- Codex CLI docs: <https://developers.openai.com/codex/cli>

The public Codex project is useful for behavior and information architecture, but Ling
should not depend on private Desktop UI source or copy its single-agent repo assumptions.

## Terminology

| Term | Meaning |
| --- | --- |
| Channel environment | The current channel's workspace/runtime context and evidence summary. |
| Local environment | The local filesystem/worktree path the channel currently uses. |
| Git branch / working branch | A repository branch from Git status. This is not a Ling channel branch. |
| Ling channel branch | A product conversation lane under a channel. It never implies Git checkout, merge, push, or delete-branch operations. |
| Changes | Reviewable changed files or diff artifacts already known to Ling through review/file/artifact projections. |
| Commit/push | A future Git mutation surface. First implementation may show the modal shell but must not execute mutations. |

Naming rule: user-facing UI should use `Git branch` or `Working branch` when it means
repository state. It should use `Channel branch` only for Ling conversation lanes.

## Product Boundaries

### In Scope

- Add `Environment` to the channel `...` menu.
- Open a channel Environment page that fills the central channel area and has a
  `Back to channel` control.
- Add an Environment section to the floating progress popover when environment data is
  available.
- Show change counts from existing review/diff projections.
- Let the Change row open the right dock Review page.
- Show local workspace mode and path from existing channel workspace state.
- Show Git branch only when it is already available from an existing channel workspace
  status source.
- Add a centered commit/push modal shell with disabled or no-op mutation actions until
  daemon Git actions exist.
- Show Browser and Sources sections only when real evidence/source data exists; otherwise
  use compact empty states.

### Out Of Scope For First Implementation

- No browser-side `git status`, `git branch`, `git diff`, `git commit`, or `git push`.
- No new daemon Git status endpoint unless a later implementation plan explicitly adds
  it.
- No real commit, push, branch creation, or checkout.
- No GitHub PR creation or merge from this surface.
- No automatic opening of the right dock when the user opens the Environment page.
- No raw run IDs, artifact IDs, workflow IDs, or JSON payloads in the default UI.
- No dark-only restyle of the channel workspace.

### Future Scope

The follow-up
[Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md)
may add a real workspace status source:

```text
daemon workspace/git status
-> current branch
-> dirty file count
-> additions/deletions
-> remote ahead/behind
-> commit/push readiness
```

That source must go through daemon APIs. Mutating actions still need existing
approval-policy boundaries and are not part of v1.28.

## Surface 1: Floating Environment Popover

The existing progress popover remains a transient, glanceable surface. It should not
become a second drawer.

Section order:

```text
Environment
  Changes
  Local
  Git branch
  Commit or push
Browser
Sources
Progress
```

Rules:

- Hide the `Environment` section only when there is no local workspace, no changes, no
  branch, and no commit/push affordance.
- `Changes` appears when review items or known diff stats exist.
- `Local` appears when selected channel workspace state exists.
- `Git branch` appears only when a real branch value is available.
- `Commit or push` appears only when there are changes or a future Git status source says
  commit/push is relevant.
- `Browser` appears only when browser evidence exists.
- `Sources` appears only when context/source evidence exists.
- Empty output/source states may appear in the full Environment page. The floating
  popover should omit empty optional sections unless the whole panel would otherwise look
  misleading.

Expected row examples:

```text
Environment
  Changes         +4,360 -0        opens right dock Review page
  Local           /Users/...       read-only first slice
  Git branch      main             read-only first slice
  Commit or push                   opens commit modal shell

Browser
  Ling Stack      127.0.0.1:5173

Sources
  13 sources      globe icon stack
```

Interaction:

- Opening the popover closes teammate manager, channel settings page, channel environment
  page, side panel, and channel `...` menu.
- Opening the right dock or a full-page utility closes the popover.
- Clicking `Changes` opens the right dock and navigates to the Review page.
- Clicking `Commit or push` opens the centered commit modal.
- Escape and outside click close the popover.

Visual:

- Use the existing channel popover shell and semantic tokens.
- Do not copy Codex's large dark panel directly into the daylight channel surface.
- Rows are icon-led, single-line where possible, and may wrap secondary text safely.
- Counts use review/diff colors: additions green, deletions red.
- Do not nest cards inside the popover shell.

## Surface 2: Channel Environment Page

The channel `...` menu should include:

```text
Settings
Environment
Context
Filter channel events
```

Clicking `Environment` opens a full channel page, like Channel Settings:

```text
<- Back to channel       Environment
                         # v0.1 Smoke

Local environment
  ling-stack-test
  /Users/tianxiao/ling-stack-test

Changes
  +4,360 -0
  View review

Git branch
  main
  Working branch

Commit
  Commit message
  Include unstaged changes
  Commit / Commit and push / Push

Browser
  Ling Stack 127.0.0.1:5173

Sources
  source icon stack or "No sources"

Output
  No artifacts
```

Layout:

- Reuse the channel settings full-page frame: same top back control, same central page
  width, same scroll behavior.
- The Environment page is current-channel scoped.
- The page may show richer empty states than the floating popover.
- The page should not render right-dock internals directly; it may provide buttons that
  open right-dock pages.
- The page should not hide the main left sidebar unless the existing channel settings
  page also does so.

State exclusivity:

Opening the Environment page closes:

- progress popover,
- teammate manager,
- channel settings page,
- side panel,
- activity/tools menu,
- channel `...` menu,
- conversation detail overlay.

Closing the Environment page returns to the same channel, not to global Settings.

## Surface 3: Commit / Push Modal Shell

The first modal is a UI shell. It must not mutate Git until the daemon action model
exists.

Modal content:

```text
main                     +4,360 -0

Commit message (empty will auto-generate) ...

[x] Include unstaged changes

Commit
Commit and push
Push
```

Rules:

- Open from `Commit or push` row or Environment page commit section.
- Center over the current channel page with a scrim.
- Show current branch only when available.
- Show change stats only when available.
- Disable commit/push buttons in the first implementation unless a real daemon action is
  available.
- If actions are disabled, use concise copy such as `Git actions are not connected yet`.
- Future mutation actions must create explicit approvals when policy requires
  `git_commit` or `git_push`.

Do not:

- Run Git commands from the browser.
- Store commit messages in channel memory.
- Auto-commit without user confirmation.
- Show real push as enabled when remote status is unknown.

## Presentation Model

The implementation should derive a deterministic presentation model before rendering.

```ts
interface ChannelEnvironmentSummary {
  readonly workspace?: ChannelEnvironmentWorkspace;
  readonly changes?: ChannelEnvironmentChanges;
  readonly git?: ChannelEnvironmentGitStatus;
  readonly browser?: ChannelEnvironmentBrowser;
  readonly sources?: ChannelEnvironmentSources;
  readonly output?: ChannelEnvironmentOutput;
  readonly commitAction?: ChannelEnvironmentCommitAction;
}

interface ChannelEnvironmentWorkspace {
  readonly mode: "local" | "managed_worktree" | "external_path";
  readonly label: string;
  readonly path: string;
  readonly status: "ready" | "missing" | "unknown";
}

interface ChannelEnvironmentChanges {
  readonly reviewItemCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly hasReviewTarget: boolean;
}

interface ChannelEnvironmentGitStatus {
  readonly branchName: string;
  readonly dirtyFileCount?: number;
  readonly aheadCount?: number;
  readonly behindCount?: number;
  readonly source: "workspace_status" | "channel_workspace";
}

interface ChannelEnvironmentBrowser {
  readonly title: string;
  readonly urlLabel: string;
  readonly evidenceCount: number;
}

interface ChannelEnvironmentSources {
  readonly count: number;
  readonly groups: readonly { readonly id: string; readonly label: string; readonly count: number }[];
}

interface ChannelEnvironmentOutput {
  readonly artifactCount: number;
  readonly latestLabel?: string;
}

interface ChannelEnvironmentCommitAction {
  readonly available: boolean;
  readonly disabledReason?: string;
}
```

First implementation sources:

| Field | Existing source | First implementation behavior |
| --- | --- | --- |
| `workspace` | `selectedChannelWorkspace`, `selectedChannelExecutionPath`, `cwd` | Show mode and path. |
| `changes` | `channelDockReviewItems`, known `DockReviewChangeStats`, file/diff artifacts | Show counts; open right dock Review page. |
| `git.branchName` | existing workspace binding branch if present | Show only if present. Do not shell out. |
| `browser` | browser evidence group | Show count and best label if available. |
| `sources` | active progress source summary/context groups | Show icon stack/count if available. |
| `output` | file/artifact items | Show artifact count or `No artifacts`. |
| `commitAction` | changes + future Git action readiness | First slice may be disabled shell only. |

## State Matrix

| State | Floating popover | Environment page |
| --- | --- | --- |
| No selected channel | Hidden | Existing no-channel empty state. |
| Local workspace ready, no work | Environment with Local only if the progress icon is otherwise available; otherwise page shows Local. | Shows Local, Output empty, Sources empty. |
| Review changes exist | Shows Changes with `+/-`; clicking opens right dock Review. | Shows Changes section and `View review`. |
| No review changes | Omit Changes in popover. | Shows `No changes` only if the page would otherwise be ambiguous. |
| Branch unavailable | Omit Git branch row. | Show `Working branch unavailable` only in the full page. |
| Browser evidence exists | Show Browser section. | Show Browser section with evidence count. |
| No browser evidence | Omit in popover. | Show compact `No browser evidence`. |
| Sources exist | Show Sources section or source icon stack. | Show source groups. |
| No sources | Omit in popover. | Show `No sources`. |
| Commit action unavailable | Omit or disabled row. | Show disabled commit section with reason. |
| Side panel/right dock open | Popover hidden. | Environment page hidden unless user explicitly opens it. |

## Implementation Plan

The canonical first-version sequencing lives in
[Channel Workspace v1.27 Environment Surface First Implementation Plan](channel-workspace-v1.27-environment-surface-implementation-plan.md).

### Slice 1: Document And Read-Only UI

Files likely touched:

- `docs/design/channel-workspace-v1.27-environment-surface.md`
- `docs/design/channel-workspace-v1.27-environment-surface-detailed-design.md`
- `docs/design/channel-workspace.md`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/styles/components.css`
- `apps/web/src/i18n.tsx`

Tasks:

1. Add `channelEnvironmentPageOpen` state next to `channelSettingsPageOpen`.
2. Add `openChannelEnvironmentPage` and `closeChannelEnvironmentPage`.
3. Add `Environment` item to the channel `...` menu.
4. Build `ChannelEnvironmentSummary` from existing client state.
5. Add Environment rows to `ProgressPopover`.
6. Add the full Channel Environment page.
7. Add a centered commit modal shell with disabled actions.
8. Add focused browser smoke for:
   - popover with changes,
   - Environment page open/back,
   - Changes row opens right dock Review,
   - empty output/source state,
   - commit modal shell opens and closes.

### Slice 2: Workspace Status Source

Tracked by
[Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md).
Only after Slice 1 lands cleanly:

1. Add a daemon read-only workspace status endpoint.
2. Include branch, dirty file count, additions/deletions, ahead/behind.
3. Cache status with explicit refresh; do not poll aggressively.
4. Keep browser client free of shell/Git probes.

### Slice 3: Commit / Push Actions

Only after a daemon status source exists:

1. Add daemon actions for `git_commit` and `git_push`.
2. Route through existing approval policy for `git_commit` and `git_push`.
3. Reflect action state back into the Environment page and popover.
4. Record action evidence in Review/Evidence surfaces, not in memory.

## Acceptance Criteria

- Channel `...` includes `Environment`.
- Environment page uses the same full-page return pattern as Channel Settings.
- Floating popover can show Changes count and environment rows without becoming a drawer.
- Changes row opens right dock Review.
- Local row uses actual channel workspace state.
- Git branch is omitted unless available from a real status source.
- Commit/push modal shell does not execute Git in the first slice.
- No browser-side Git commands are added.
- Ling channel branches and Git branches remain visually and copy-wise distinct.
- Empty output/source states are quiet and compact.
- Typecheck and diff whitespace checks pass.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

Focused browser checks should use the current local app:

```text
http://127.0.0.1:5173/
-> v0.1 Smoke
-> open progress popover
-> open Environment from channel menu
-> open right dock Review from Changes
-> open/close commit modal shell
```
