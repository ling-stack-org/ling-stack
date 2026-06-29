# Channel Workspace v1.27 Environment Surface Detailed Design

## Status

Detailed design for
[Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md).
First read-only implementation landed on 2026-06-29.

First-version sequencing:
[Channel Workspace v1.27 Environment Surface First Implementation Plan](channel-workspace-v1.27-environment-surface-implementation-plan.md).

This document is intentionally implementation-shaped. It names the first React state,
presentation model, component split, click routing, CSS classes, and test cases so the
implementation can proceed without reinterpreting the product boundary.

## Current Code Anchors

Primary implementation file:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`

Supporting files:

- `apps/web/src/styles/components.css`
- `apps/web/src/i18n.tsx`
- `apps/web/e2e/channel.spec.ts`
- `docs/design/channel-workspace.md`
- `docs/design/channel-workspace-v1.27-environment-surface.md`
- `docs/design/channel-workspace-v1.27-environment-surface-implementation-plan.md`

Existing anchors in `WorkspaceClientView.tsx`:

| Area | Existing code shape | v1.27 change |
| --- | --- | --- |
| State | `channelSettingsPageOpen`, `progressPopoverOpen`, `sidePanelOpen`, `conversationDetailOverlay` | Add Environment page and commit modal state next to these UI modes. |
| Header full-page mode | Header switches when `channelSettingsPageOpen` is true | Make header switch for either Settings or Environment. |
| Channel `...` menu | `channelMoreOpen` menu opens Settings, Context, and filter tools | Add Environment menu item. |
| Popover | `ProgressPopover` receives progress rows and source summary | Add environment summary/model and environment row callbacks. |
| Main body | `channelSettingsPageOpen ? channel-settings-page : chat` | Add `channelEnvironmentPageOpen ? channel-environment-page : ...`. |
| Right dock | `WorkspaceRightDock` receives `channelDockReviewItems` | Use this existing review projection for Changes and Review navigation. |

Do not move this slice into `@ling-stack/conversation-ui-react` yet. The first slice is
channel-specific and depends on channel state. Extract only after the model is reused by
normal conversation or teammate private chat.

## First-Slice Goal

Implement a read-only Environment surface with one disabled Git action shell.

First slice supports:

1. The channel progress popover can show Environment rows above Progress.
2. The channel `...` menu can open an Environment page.
3. Environment page has the same return pattern as Channel Settings.
4. Changes row opens the right dock Review page.
5. Commit or push row opens a centered modal shell.
6. No real Git commands run.
7. Git branch rows are hidden unless already available from channel workspace binding.

## UI State Model

Add these local states near existing channel UI state:

```ts
const [channelEnvironmentPageOpen, setChannelEnvironmentPageOpen] = useState(false);
const [environmentCommitDialogOpen, setEnvironmentCommitDialogOpen] = useState(false);
const [environmentCommitMessage, setEnvironmentCommitMessage] = useState("");
const [environmentIncludeUnstaged, setEnvironmentIncludeUnstaged] = useState(true);
```

Optional first-slice simplification:

- If commit message persistence is not needed, keep it local in the modal component.
- Do not persist commit message to channel state, memory, localStorage, or daemon.

Derived booleans:

```ts
const channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen;
const channelHasProgressPopoverContent =
  attentionProgressRows.length > 0 || channelEnvironmentSummary.popoverRows.length > 0;
const progressPopoverVisible =
  progressPopoverOpen &&
  !teammateManagerOpen &&
  !sidePanelOpen &&
  !channelSettingsPageOpen &&
  !channelEnvironmentPageOpen &&
  channelHasProgressPopoverContent;
```

Replace places that currently check only `channelSettingsPageOpen` when the intent is
"full-page channel utility is open" with `channelUtilityPageOpen`.

Examples:

- header class,
- task workbench main class,
- hiding right dock side panel layout,
- progress popover visibility,
- toolbar click cleanup.

Do not replace checks where the intent is specifically Settings content.

## Open/Close Functions

Add:

```ts
function openChannelEnvironmentPage(): void {
  setChannelEnvironmentPageOpen(true);
  setChannelSettingsPageOpen(false);
  setSidePanelOpen(false);
  setCreateTaskOpen(false);
  setConversationDetailOverlay(undefined);
  setProgressPopoverOpen(false);
  setChannelMoreOpen(false);
  setActivityToolsOpen(false);
  setWorkspaceSettingsOpen(false);
  setTeammateManagerOpen(false);
  onChannelCreateOpenChange(false);
}

function closeChannelEnvironmentPage(): void {
  setChannelEnvironmentPageOpen(false);
}
```

Update existing open functions:

- `openChannelSettingsPage()` must call `setChannelEnvironmentPageOpen(false)`.
- `openSidePanelView()` must call `setChannelEnvironmentPageOpen(false)`.
- `openSourceGroupInConversationDetail()` must call `setChannelEnvironmentPageOpen(false)`.
- `openContextSummaryInConversationDetail()` must call `setChannelEnvironmentPageOpen(false)`.
- `toggleChannelTeammateManager()` must close Environment when opening teammate manager.
- Activity filter open action must close Environment.
- Toolbar side-panel open must close Environment via `openSidePanelView`.

Commit modal:

```ts
function openEnvironmentCommitDialog(): void {
  setEnvironmentCommitDialogOpen(true);
  setProgressPopoverOpen(false);
  setChannelMoreOpen(false);
}

function closeEnvironmentCommitDialog(): void {
  setEnvironmentCommitDialogOpen(false);
}
```

The modal should close on Escape, close button, or scrim click. It should not close the
Environment page itself.

## Presentation Model

Keep the model local in `WorkspaceClientView.tsx` for first implementation.

```ts
type ChannelEnvironmentRowTone = "neutral" | "info" | "success" | "warning" | "danger";

interface ChannelEnvironmentSummary {
  readonly workspace?: ChannelEnvironmentWorkspace;
  readonly changes?: ChannelEnvironmentChanges;
  readonly git?: ChannelEnvironmentGitStatus;
  readonly browser?: ChannelEnvironmentBrowser;
  readonly sources?: ChannelEnvironmentSources;
  readonly output?: ChannelEnvironmentOutput;
  readonly commitAction?: ChannelEnvironmentCommitAction;
  readonly popoverRows: readonly ChannelEnvironmentPopoverRow[];
}

interface ChannelEnvironmentPopoverRow {
  readonly id: "changes" | "local" | "git-branch" | "commit-push";
  readonly icon: ReactNode;
  readonly label: string;
  readonly value?: string;
  readonly stats?: { readonly additions: number; readonly deletions: number };
  readonly tone: ChannelEnvironmentRowTone;
  readonly onOpen?: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}
```

Builder signature:

```ts
function buildChannelEnvironmentSummary(input: {
  readonly cwd: string;
  readonly selectedChannel?: Channel;
  readonly selectedChannelWorkspace?: ChannelWorkspaceBindingView;
  readonly selectedChannelExecutionPath: string;
  readonly reviewItems: readonly DockReviewItem[];
  readonly evidenceGroups: readonly DockEvidenceGroupView[];
  readonly fileItems: readonly DockFileItem[];
  readonly sourceSummary?: ConversationContextSourceSummary;
  readonly t: Translate;
  readonly onOpenReview: () => void;
  readonly onOpenCommit: () => void;
}): ChannelEnvironmentSummary
```

This can start as an inline `useMemo` instead of a standalone function if typing imports
become noisy. The important boundary is that JSX receives a ready model.

## Data Derivation Rules

### Workspace

Source:

- `selectedChannelWorkspace`
- `selectedChannelExecutionPath`
- `cwd`

Rules:

- `label` uses `channelWorkspaceModeLabel(selectedChannelWorkspace.mode)`.
- `path` uses `selectedChannelExecutionPath`.
- page title may use `selectedChannel?.name`.
- popover Local row secondary text should use `shortWorkspacePath(...)`.
- Environment page should show the full path in title/tooltip or second line.

### Changes

Source:

- `channelDockReviewItems`
- `DockReviewItem.stats`
- review artifact previews when already enriched by right dock are not guaranteed; first
  slice should only use currently available stats.

Rules:

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

Show Changes row when:

- `reviewItemCount > 0`, or
- additions/deletions are non-zero.

If stats are all zero but review items exist, show count copy such as `2 items`.
If stats exist, show `+N -N` with green/red styling.

Click target:

- open the right dock,
- navigate to Review page.

Current right dock state only has `sidePanelOpen` and `WorkspaceRightDock` internal stack.
For first implementation there are two acceptable cuts:

1. Minimal: click Changes opens `sidePanelOpen = true`; Review remains first launcher
   page only if right dock root is visible.
2. Preferred: add a controlled initial/open page prop to `WorkspaceRightDock` so the click
   opens directly to Review.

Preferred detail:

```ts
type WorkspaceRightDockInitialPage = "review" | "evidence" | "files" | "activity" | "browser" | "terminal";

interface WorkspaceRightDockProps {
  readonly initialPage?: WorkspaceRightDockInitialPage;
}
```

The parent can set a short-lived `rightDockInitialPage` state to `"review"` before
opening the panel. `WorkspaceRightDock` converts it to `createDockPageEntry(...)` only
when opening from the parent. Avoid fighting the internal stack after the user navigates.

### Git Branch

First slice source:

- Only `selectedChannelWorkspace.branchName` or an equivalent already-present binding
  field if it exists in contracts.

Rules:

- If no branch name exists, omit from popover.
- Environment page may show `Working branch unavailable`.
- Do not infer branch from channel branch ID.
- Do not call `git`.
- Do not parse path names.

Copy:

- Popover label: `Git branch`
- Full page label: `Working branch`
- Never label this as just `Branch` in user-facing UI unless the local context already
  says `Git`.

### Browser

Source:

- `channelDockEvidenceGroups.find((group) => group.id === "browser")`

Rules:

- Popover shows Browser section only when count > 0.
- Page shows either browser evidence count or `No browser evidence`.
- Title can be `Ling Stack` and URL can be `127.0.0.1:5173` only if a real evidence item
  contains that label. Otherwise use evidence group label/count.

Do not hardcode localhost labels from the screenshot.

### Sources

Source:

- `activeProgressSourceSummary`
- `ConversationContextSourceSummary.groups`

Rules:

- Popover shows first 8-12 icons or a compact count.
- Page shows grouped rows.
- Empty page state: `No sources`.
- Empty popover state: omit section.

### Output

Source:

- `channelDockFileItems`
- filter by `kind === "artifact"` or generated/change kinds if available.

Rules:

- Page shows output section.
- Empty page state: `No artifacts`.
- Popover normally omits Output unless it is an active recent result.

## Component Split

First slice may keep components in `WorkspaceClientView.tsx` near `ProgressPopover`.
Suggested components:

```ts
function ChannelEnvironmentPage(props: {
  readonly summary: ChannelEnvironmentSummary;
  readonly selectedChannelName?: string;
  readonly onBack: () => void;
  readonly onOpenReview: () => void;
  readonly onOpenCommit: () => void;
}): JSX.Element

function ChannelEnvironmentPopoverSection(props: {
  readonly summary: ChannelEnvironmentSummary;
}): JSX.Element | null

function ChannelEnvironmentCommitDialog(props: {
  readonly summary: ChannelEnvironmentSummary;
  readonly message: string;
  readonly includeUnstaged: boolean;
  readonly onMessageChange: (value: string) => void;
  readonly onIncludeUnstagedChange: (include: boolean) => void;
  readonly onClose: () => void;
}): JSX.Element
```

Do not create a new `features/environment` folder in the first slice. If the component
body grows beyond roughly 250 lines or needs reuse across normal conversation/private
chat, split later.

## Header And Menu Detail

Header mode:

```tsx
const channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen;

<header className={channelUtilityPageOpen ? "channel-header task-workbench-header settings-page-header" : ...}>
```

Header title:

- Settings page:
  - icon: `SlidersHorizontal`
  - title: `Channel settings`
- Environment page:
  - icon: `Laptop` or existing `Command` if Laptop is not imported
  - title: `Environment`
  - subtitle: `#${selectedChannel.name}`

If `Laptop` is not already imported, add it from `lucide-react`. Prefer `Laptop` for
Local, `GitBranch` for Git branch, `ListChecks` for Changes, `CircleDot` or `Command`
for commit shell depending on available imports.

Channel `...` menu:

```tsx
<button
  className={channelEnvironmentPageOpen ? "channel-more-item active" : "channel-more-item"}
  type="button"
  role="menuitem"
  onClick={openChannelEnvironmentPage}
>
  <Laptop size={15} />
  <span>{t("Environment")}</span>
</button>
```

Placement:

- after Context,
- before `Filter channel events`,
- matching the user's screenshot where Environment sits under existing menu utilities.

## Progress Popover Detail

`ProgressPopover` props become:

```ts
function ProgressPopover({
  expanded,
  onExpandedChange,
  progressRows,
  environmentSummary,
  sourceSummary,
  onOpenSourceGroup,
}: {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly progressRows: readonly AttentionProgressRow[];
  readonly environmentSummary?: ChannelEnvironmentSummary;
  readonly sourceSummary?: ConversationContextSourceSummary;
  readonly onOpenSourceGroup?: (...args) => void;
})
```

Render order:

```tsx
<ChannelEnvironmentPopoverSection summary={environmentSummary} />
{browser section if present}
{sources section if present}
{progress section if progressRows.length > 0}
```

If all sections are empty, return `null`.

Important change:

- Current `ProgressPopover` returns `null` when `progressRows.length === 0`.
- v1.27 must return content when environment rows exist even if progress rows are empty.

This means the toolbar icon can open the popover when there is useful environment
content, not only when active work exists.

## Channel Environment Page Detail

Main conditional:

```tsx
{channelSettingsPageOpen ? (
  <section className="channel-settings-page" ...>{channelSettingsContent}</section>
) : channelEnvironmentPageOpen ? (
  <ChannelEnvironmentPage ... />
) : (
  chat content
)}
```

Class names:

- root: `channel-environment-page`
- content stack: `channel-environment-stack`
- section: `channel-environment-section`
- row: `channel-environment-row`
- row button: `channel-environment-row interactive`
- stats: `channel-environment-diff-stat`
- empty: `channel-environment-empty`

The page may reuse `.channel-settings-page` layout tokens, but should have its own class
for future refinement.

Recommended layout:

```text
channel-environment-page
  channel-environment-stack
    channel-environment-section.local
    channel-environment-section.changes
    channel-environment-section.git
    channel-environment-section.commit
    channel-environment-section.browser
    channel-environment-section.sources
    channel-environment-section.output
```

Avoid nested cards. The page can use section bands or simple bordered rows.

## Commit Dialog Detail

Render near `conversationDetailOverlayNode` or at the end of the channel workspace root
so it overlays both chat and Environment page:

```tsx
{environmentCommitDialogOpen ? (
  <ChannelEnvironmentCommitDialog ... />
) : null}
```

Class names:

- scrim: `environment-commit-dialog-backdrop`
- dialog: `environment-commit-dialog`
- header: `environment-commit-dialog-head`
- textarea: `environment-commit-message`
- action row: `environment-commit-actions`

First-slice behavior:

- textarea is editable,
- include checkbox toggles local state,
- Commit / Commit and push / Push buttons render disabled,
- disabled reason is visible as compact secondary text.

Disabled reason:

```text
Git actions are not connected yet.
```

Do not show a fake success toast.

## CSS Detail

Add CSS in `apps/web/src/styles/components.css` near existing channel settings and
attention popover styles.

Reuse:

- `.channel-settings-page` structure where possible.
- `.attention-context-row` and `.attention-progress-row` rhythm for popover rows.

Add:

```css
.attention-environment-section { ... }
.attention-environment-list { ... }
.attention-environment-row { ... }
.attention-environment-diff-stat { ... }
.channel-environment-page { ... }
.channel-environment-stack { ... }
.channel-environment-section { ... }
.channel-environment-row { ... }
.environment-commit-dialog-backdrop { ... }
.environment-commit-dialog { ... }
```

Visual constraints:

- no nested cards inside popover,
- one panel shadow for popover,
- full page scrolls inside the central channel area,
- modal uses one shadow and one border,
- long paths use ellipsis in popover and can wrap in full page,
- mobile uses one-column Environment page,
- modal width: `min(640px, calc(100vw - 32px))`,
- modal max-height: `min(80vh, 620px)`.

Stats styling:

- additions use `var(--success)`,
- deletions use `var(--danger)`,
- use monospace only for `+N -N`, not whole row copy.

## i18n Keys

Some keys already exist:

- `Environment`
- `Changes`
- `Back to channel`
- `Channel settings`

Add keys if missing:

- `Local environment`
- `Git branch`
- `Working branch`
- `Working branch unavailable`
- `Commit or push`
- `Commit`
- `Commit and push`
- `Push`
- `Commit message`
- `Empty message will be generated automatically.`
- `Include unstaged changes`
- `Git actions are not connected yet.`
- `View review`
- `No changes`
- `No sources`
- `No browser evidence`
- `No artifacts`
- `Output`
- `Sources`
- `Browser`
- `{count} review items`
- `{count} sources`
- `{count} artifacts`

Keep Chinese labels short. For example:

| English | Chinese |
| --- | --- |
| Local environment | 本地环境 |
| Git branch | Git 分支 |
| Working branch | 工作分支 |
| Commit or push | 提交或推送 |
| View review | 查看审查 |
| No artifacts | 暂无产物 |
| No sources | 暂无来源 |

## Accessibility

- Channel `...` item uses `role="menuitem"`.
- Environment page root uses `aria-label={t("Environment")}`.
- Commit dialog uses `role="dialog"` and `aria-modal="true"`.
- Commit dialog close button has `aria-label={t("Close")}`.
- Changes row button has `aria-label` including additions/deletions when available.
- Popover rows that navigate are `<button>`, passive rows are `<div>`.
- Disabled commit buttons should have visible disabled reason, not only `title`.

## Test Plan

Static:

```bash
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

Focused browser smoke:

1. Open `http://127.0.0.1:5173/`.
2. Select `v0.1 Smoke`.
3. Open progress/environment popover.
4. Verify Environment section shows Changes when review items exist.
5. Click Changes.
6. Verify right dock opens Review page.
7. Open channel `...` menu.
8. Click Environment.
9. Verify full Environment page replaces chat area and Back returns to channel.
10. Verify Output/Sources empty states are compact when no data exists.
11. Click Commit or push.
12. Verify centered commit dialog opens, buttons are disabled, and close returns to page.

Regression checks:

- Settings page still opens and returns correctly.
- Context side panel still opens and closes Environment page.
- Teammate manager still closes popover/page conflicts.
- Right dock review accordion from PR #287 still expands inline.
- Mobile width does not create horizontal scroll.

## Implementation Slices

The authoritative first-version implementation order is tracked in
[Channel Workspace v1.27 Environment Surface First Implementation Plan](channel-workspace-v1.27-environment-surface-implementation-plan.md).
The slices below remain as component-level detail and should not be read as permission to
add daemon Git status or Git mutation work in the first PR.

### Slice A: Read-Only Environment Page

- Add state and open/close functions.
- Add menu item.
- Add `ChannelEnvironmentSummary` builder.
- Add full page with Local, Changes, Browser, Sources, Output sections.
- Add Back behavior.
- No popover changes yet except closing conflicts.

### Slice B: Popover Environment Rows

- Pass summary into `ProgressPopover`.
- Add `ChannelEnvironmentPopoverSection`.
- Update popover visibility to allow environment-only content.
- Add Changes row routing to Review.

### Slice C: Commit Dialog Shell

- Add modal state.
- Add disabled commit/push dialog.
- Wire from popover and page.
- Add a11y and Escape/scrim close.

### Slice D: Focused Browser Checks

- Add or extend e2e only after the UI is stable.
- Keep tests scoped to channel smoke state and avoid broad selectors.

## Non-Negotiable Guardrails

- No Git command from browser code.
- No new daemon endpoint in first implementation.
- No real commit/push in first implementation.
- No confusion between Ling channel branches and Git branches.
- No raw IDs in default UI copy.
- No placeholder localhost/browser rows unless backed by evidence.
- No nested cards in the floating popover.
