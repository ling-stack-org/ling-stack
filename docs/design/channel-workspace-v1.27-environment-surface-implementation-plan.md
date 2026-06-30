# Channel Workspace v1.27 Environment Surface First Implementation Plan

## Status

Proposed on 2026-06-29. First read-only implementation landed on 2026-06-29.
This is the canonical first-version implementation plan for
[Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md).

It depends on:

- [Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md)
- [Channel Workspace v1.27 Environment Surface Detailed Design](channel-workspace-v1.27-environment-surface-detailed-design.md)

## First-Version Verdict

Implement a read-only channel Environment surface plus a disabled commit/push shell.

The first version must answer these questions without adding a new runtime contract:

```text
What local workspace is this channel using?
What reviewable changes does Ling already know about?
Where can the user inspect those changes?
Is commit/push conceptually available later?
Which browser, source, or output evidence is already linked?
```

The first version must not execute Git, shell commands, branch operations, commit, push,
or GitHub operations.

## Hard Non-Goals

- No browser-side `git status`, `git diff`, `git branch`, `git commit`, or `git push`.
- No new daemon Git status endpoint.
- No new contracts package type for workspace Git status.
- No commit/push mutation.
- No hidden approval bypass.
- No raw artifact IDs, run IDs, workflow IDs, or JSON payloads in the UI.
- No placeholder browser/source rows unless backed by real evidence.
- No visual copy that mixes Ling channel branches with Git branches.
- No shared `@ling-stack/conversation-ui-*` package extraction for Environment in this
  slice. Keep Environment channel-specific until another surface reuses it.

## Allowed Data Sources

The implementation may only read data that already exists in the Web client:

| Data | Allowed source | First-version UI |
| --- | --- | --- |
| Channel workspace | `selectedChannelWorkspace`, `selectedChannelExecutionPath`, `cwd` | Local environment row and page section. |
| Review changes | `channelDockReviewItems` and `DockReviewItem.stats` | Changes row, review item count, `+N -N` stats. |
| Browser evidence | existing right-dock evidence groups | Browser section only when real browser evidence exists. |
| Sources | active context/source summary and evidence groups | Sources section only when real source data exists. |
| Output/files | existing dock file items/artifact projections | Output section and compact empty state. |
| Git branch | only an existing workspace binding/status field if already present | Hidden when unavailable. |
| Commit/push | derived from existing changes only | Disabled modal shell with explanatory copy. |

If a data field is not already available, the first version hides the row in the popover
and uses a quiet unavailable state on the full Environment page.

## File Scope

Expected first-version files:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/features/workspace/right-dock/WorkspaceRightDock.tsx`
- `apps/web/src/styles/components.css`
- `apps/web/src/i18n.tsx`
- `apps/web/e2e/channel.spec.ts`
- `docs/design/channel-workspace.md`
- `docs/design/channel-workspace-v1.27-environment-surface.md`
- `docs/design/channel-workspace-v1.27-environment-surface-detailed-design.md`
- `docs/design/channel-workspace-v1.27-environment-surface-implementation-plan.md`

Files that should not change in this first version:

- `packages/contracts/*`
- daemon API/server Git endpoints
- `packages/api-client/*`
- `@ling-stack/conversation-ui-core` or `@ling-stack/conversation-ui-react`, unless a
  later review finds a tiny dock-navigation primitive is impossible inside the workspace
  wrapper.

## Slice 0: Preflight And Guardrails

Goal: confirm the implementation starts from the current UI architecture and does not
inherit unrelated local artifacts.

Tasks:

1. Check `git status -sb`.
2. Confirm `tmp/` is not staged.
3. Locate current anchors:
   - `channelSettingsPageOpen`
   - `channelMoreOpen`
   - `progressPopoverOpen`
   - `ProgressPopover`
   - `WorkspaceRightDock`
   - `channelDockReviewItems`
4. Confirm right dock Review is still the first launcher page and PR #287 inline review
   accordion behavior still exists.

Done when:

- The implementer knows the exact state anchors.
- No unrelated files are included.
- The implementation branch has a clear before/after diff boundary.

## Slice 1: Right Dock Review Navigation Request

Goal: allow the Environment `Changes` row to open the right dock directly on Review,
not merely open the dock launcher.

Recommended implementation:

1. Add a small page-request prop to `WorkspaceRightDock`:

```ts
interface WorkspaceRightDockPageRequest {
  readonly page: DockPageKind;
  readonly nonce: number;
}
```

2. Add `pageRequest?: WorkspaceRightDockPageRequest` to `WorkspaceRightDockProps`.
3. Inside `WorkspaceRightDock`, add an effect that reacts to `pageRequest.nonce`:
   - ignore when dock is closed,
   - ignore when `forcedDetail` is active,
   - find the matching page manifest,
   - if the manifest has a launcher item and is not hidden/disabled, set stack to one
     `createDockPageEntry(...)`.
4. In `WorkspaceClientView.tsx`, add local state:

```ts
const [rightDockPageRequest, setRightDockPageRequest] = useState<WorkspaceRightDockPageRequest>();
```

5. Add helper:

```ts
function openRightDockPage(page: DockPageKind): void {
  setSidePanelOpen(true);
  setProgressPopoverOpen(false);
  setChannelMoreOpen(false);
  setRightDockPageRequest({ page, nonce: Date.now() });
}
```

6. Pass `rightDockPageRequest` to `WorkspaceRightDock`.

Fallback if time is constrained:

- Opening `Changes` may open the right dock launcher only, but this should be treated as
  incomplete for the first-version target.

Done when:

- A caller can request `review`.
- The dock opens on Review page with existing Review UI.
- Existing dock launcher clicks, back button, forced detail, and close behavior remain
  unchanged.

## Slice 2: Environment Page State And Channel Menu

Goal: add the full Environment page using the same full-page return pattern as Channel
Settings.

Tasks:

1. Add local state near channel settings state:

```ts
const [channelEnvironmentPageOpen, setChannelEnvironmentPageOpen] = useState(false);
```

2. Add modal state for later slices:

```ts
const [environmentCommitDialogOpen, setEnvironmentCommitDialogOpen] = useState(false);
const [environmentCommitMessage, setEnvironmentCommitMessage] = useState("");
const [environmentIncludeUnstaged, setEnvironmentIncludeUnstaged] = useState(true);
```

3. Add `channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen`.
4. Add open/close helpers:
   - `openChannelEnvironmentPage()`
   - `closeChannelEnvironmentPage()`
5. Opening Environment closes:
   - channel settings page,
   - progress popover,
   - side panel,
   - teammate manager,
   - activity tools menu,
   - channel more menu,
   - conversation detail overlay.
6. Opening Settings closes Environment.
7. Add `Environment` directly under `Settings` in the channel `...` menu.
8. Header/back behavior:
   - when Environment is open, show the same left back control pattern as Settings,
   - label is `Back to channel`,
   - title is `Environment`.

Done when:

- Channel `...` -> `Environment` opens a full central page.
- `Back to channel` returns to the same channel.
- Settings and Environment cannot be open at the same time.
- Existing Settings page still works.

## Slice 3: Channel Environment Summary Model

Goal: build one presentation model so popover and page do not re-derive data separately.

Tasks:

1. Add local types in `WorkspaceClientView.tsx`:
   - `ChannelEnvironmentSummary`
   - `ChannelEnvironmentWorkspace`
   - `ChannelEnvironmentChanges`
   - `ChannelEnvironmentBrowser`
   - `ChannelEnvironmentSources`
   - `ChannelEnvironmentOutput`
   - `ChannelEnvironmentPopoverRow`
2. Build summary with `useMemo`.
3. Derive changes:

```ts
const changes = reviewItems.reduce(
  (acc, item) => ({
    reviewItemCount: acc.reviewItemCount + 1,
    additions: acc.additions + (item.stats?.additions ?? 0),
    deletions: acc.deletions + (item.stats?.deletions ?? 0),
  }),
  { reviewItemCount: 0, additions: 0, deletions: 0 },
);
```

4. Include `Changes` when `reviewItemCount > 0` or stats are non-zero.
5. Include `Local` when workspace path/mode is available.
6. Include `Git branch` only if an existing value is already present.
7. Include `Browser`, `Sources`, and `Output` only from existing evidence/projections.
8. Include disabled `Commit or push` only when changes exist.

Done when:

- JSX receives a ready summary.
- Both surfaces use the same summary.
- Missing branch/source/browser data does not create fake rows.

## Slice 4: Full Environment Page UI

Goal: render the readable, quiet full page.

Sections:

1. Local environment
2. Changes
3. Working branch
4. Commit
5. Browser
6. Sources
7. Output

Rules:

- Use the Settings page frame and central width.
- Do not render right-dock internals inside the Environment page.
- `Changes` has a `View review` button that calls `openRightDockPage("review")`.
- Additions and deletions use review colors.
- Working branch section says unavailable when no branch source exists.
- Commit section is disabled and points to the modal shell.
- Empty Browser/Sources/Output states are compact.

Done when:

- Page fills the channel center area.
- No large blank review-like cards appear.
- The page remains useful when only local workspace data exists.
- The right dock does not auto-open just because the page opened.

## Slice 5: Floating Popover Environment Rows

Goal: make the existing progress popover show environment context before progress.

Tasks:

1. Extend `ProgressPopover` props:
   - `environmentSummary?: ChannelEnvironmentSummary`
   - callbacks are already carried on rows.
2. Change popover visibility from progress-only to:

```ts
const channelHasProgressPopoverContent =
  attentionProgressRows.length > 0 || channelEnvironmentSummary.popoverRows.length > 0;
```

3. Render section order:

```text
Environment
Browser
Sources
Progress
```

4. Environment row order:
   - Changes
   - Local
   - Git branch
   - Commit or push
5. `Changes` row calls `openRightDockPage("review")`.
6. `Commit or push` row opens commit modal shell.
7. Browser and Sources stay hidden in the popover when they have no real evidence.

Done when:

- Popover opens when environment rows exist even if no active progress rows exist.
- It stays compact and does not become a second right drawer.
- Review count/stats are visible in the Changes row.

## Slice 6: Commit/Push Modal Shell

Goal: show the future commit/push flow without pretending mutation exists.

Tasks:

1. Add centered modal with scrim.
2. Include:
   - commit message textarea,
   - include unstaged checkbox,
   - `Commit`,
   - `Commit and push`,
   - `Push`,
   - close/cancel.
3. Disable mutation buttons.
4. Show reason:

```text
Commit and push require a daemon Git action and approval policy. This first version is read-only.
```

5. Close on:
   - Escape,
   - close button,
   - scrim click.

Done when:

- Modal can open from page and popover.
- No button executes Git.
- Closing returns to the previous Environment surface.

## Slice 7: CSS, I18n, And Accessibility

CSS classes to add or reuse:

- `attention-environment-section`
- `attention-environment-list`
- `attention-environment-row`
- `attention-environment-diff-stat`
- `channel-environment-page`
- `channel-environment-stack`
- `channel-environment-section`
- `channel-environment-row`
- `environment-commit-dialog-backdrop`
- `environment-commit-dialog`
- `environment-commit-actions`

I18n keys:

- `Environment`
- `Local environment`
- `Working branch`
- `Working branch unavailable`
- `Changes`
- `View review`
- `Commit or push`
- `Commit message`
- `Include unstaged changes`
- `Commit`
- `Commit and push`
- `Push`
- `No changes`
- `No browser evidence`
- `No sources`
- `No artifacts`

Accessibility:

- Full page back button has `aria-label`.
- Popover rows are buttons only when interactive.
- Disabled rows expose the disabled reason.
- Modal has `role="dialog"` and `aria-modal="true"`.
- Escape closes popover/modal using the existing interaction style.

Done when:

- English and Chinese strings exist.
- Keyboard navigation remains usable.
- No horizontal overflow on desktop or mobile widths.

## Slice 8: Verification

Commands:

```bash
git diff --check
corepack pnpm --filter @ling-stack/web typecheck
```

Focused browser smoke:

1. Open `http://127.0.0.1:5173/`.
2. Select `v0.1 Smoke`.
3. Open channel `...`.
4. Verify `Environment` appears directly below `Settings`.
5. Click `Environment`.
6. Verify the full Environment page replaces the chat center.
7. Click `Back to channel`.
8. Open the progress/environment popover.
9. Verify Changes row shows review count/stats only when review items exist.
10. Click Changes.
11. Verify the right dock opens on Review page.
12. Open Environment page again.
13. Click `Commit or push`.
14. Verify the modal opens and mutation buttons are disabled.
15. Close the modal with Escape and scrim click.
16. Verify Settings, Context, teammate manager, and right dock still close/open without
    overlapping Environment.

Regression checks:

- Channel Settings still fills the central page and returns correctly.
- Right dock Review accordion still expands inline.
- Popover hidden states still work when side panel or teammate manager is open.
- Private chat and normal conversation surfaces are unaffected.

## First PR Boundary

The first implementation is complete when:

- Environment menu item exists.
- Environment full page exists.
- Floating popover Environment rows exist.
- Changes row can open the right dock Review page directly.
- Commit/push modal shell exists but is disabled.
- Git branch is hidden unless an existing source provides it.
- No daemon/API/contract Git status work is included.
- Typecheck and `git diff --check` pass.

Anything beyond this belongs to later PRs:

1. Read-only daemon workspace Git status, tracked by
   [Channel Workspace v1.28 Environment Git Status](channel-workspace-v1.28-environment-git-status.md).
2. Approval-gated commit/push daemon actions.
3. Branch ahead/behind and remote tracking.
4. GitHub PR creation or publish flows.
5. Shared cross-surface Environment component extraction.
