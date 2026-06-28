# Conversation Right Dock Workspace Tools Implementation Plan

Status: active detailed implementation plan
Date: 2026-06-29
Scope: Web-local Right Dock implementation first, then optional
`@ling-stack/conversation-ui-core` and `@ling-stack/conversation-ui-react` extraction

Related docs:

- [Conversation Right Dock Workspace Tools](conversation-right-dock-workspace-tools.md)
- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Conversation UI Package Extraction Implementation Plan](conversation-ui-package-extraction-implementation-plan.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Channel Workspace Design](channel-workspace.md)

## Goal

Implement the shared Right Dock without reintroducing three separate right-side UI
systems.

The implementation must make channel, normal conversation, and teammate private chat use
the same dock primitives while preserving surface-specific policy:

- channel can show teammate activity and channel-scoped review/evidence,
- normal conversation cannot show teammate rosters or teammate `@` routing,
- teammate private chat stays one-to-one and private-scoped,
- run/thread detail can keep richer evidence views and later reuse the dock primitives
  where useful.

This is a staged Web implementation. Package extraction happens only after at least two
surfaces prove the same component API.

## Reference Implementation Notes

Use these references only to resolve implementation ambiguity:

| Reference | Use for | Guardrail |
| --- | --- | --- |
| Codex right dock | launcher-first empty state, page stack, review detail density | Keep Ling light-themed and cross-surface, not coding-only. |
| VS Code Source Control | grouped rows, status badges, explicit detail opening | Do not add staging/git-only concepts to generic Ling review. |
| GitHub Desktop | changed-file list and diff/detail split | Do not make file changes the only review model. |
| OpenHands | agent workspace transparency and tool/evidence separation | Do not expose terminal/browser controls before Ling permissions and lifecycle exist. |
| Zed side panels | compact side-panel chrome | Do not let side-panel navigation become the primary conversation route. |

If an implementation choice conflicts between a reference and Ling's existing
conversation contract, the Ling contract wins.

## Current Anchors

| Concern | Current anchor | Implementation note |
| --- | --- | --- |
| Temporary drawer shell | `apps/web/src/shared/conversation/blocks/RightDrawer.tsx` | Keep as compatibility until `RightDockShell` replaces channel use. |
| Channel drawer state | `WorkspaceClientView.tsx` `sidePanelView`, `sidePanelOpen` | Migrate to dock state without changing channel data in the first slice. |
| Channel drawer content | `channel-side-panel` styles and content | Re-home into dock pages; remove repeated settings/right-side duplicates. |
| Global inspector | `AppShell.tsx` `right-panel` and `PageInspector` | Do not merge in first slice; inventory only. |
| Run evidence | `RunHistory.tsx`, run evidence helpers, work cells | Use as evidence data source, not as new storage. |
| Conversation UI packages | `packages/conversation-ui-core`, `packages/conversation-ui-react` | Do not add dock primitives there until the Web API stabilizes. |
| Shared conversation export | `apps/web/src/shared/conversation/index.ts` | Can re-export Web-local dock components during transition. |

## File Layout

Start Web-local:

```text
apps/web/src/shared/conversation/dock/
  index.ts
  dock-types.ts
  dock-page-stack.ts
  RightDockShell.tsx
  DockLauncher.tsx
  DockPageHeader.tsx
  DockPageStack.tsx
  DockEmptyState.tsx
  ReviewQueuePage.tsx
  EvidencePage.tsx
  FilesPage.tsx
  TerminalPage.tsx
  BrowserPage.tsx
```

Surface adapters stay near their owning feature:

```text
apps/web/src/features/workspace/right-dock/
  channel-right-dock-adapter.tsx
  conversation-right-dock-adapter.tsx
  teammate-private-right-dock-adapter.tsx
  review-projections.ts
  evidence-projections.ts
  file-projections.ts
```

If the adapter files become too coupled to `WorkspaceClientView.tsx`, keep them as
helper builders first and pass all state through explicit props. Do not let shared dock
components import `WorkspaceClientView` state or daemon clients.

## Core View Models

Keep these Web-local in `dock-types.ts` first. Move them to
`conversation-ui-core/src/dock-types.ts` only after API stabilization.

```ts
export type DockSurfaceKind =
  | "channel"
  | "normal_conversation"
  | "teammate_direct"
  | "run_detail";

export type DockPageKind =
  | "launcher"
  | "review"
  | "evidence"
  | "files"
  | "activity"
  | "terminal"
  | "browser"
  | "detail";

export type DockSeverity = "neutral" | "info" | "warning" | "danger";

export interface DockPageStackEntry {
  readonly id: string;
  readonly page: DockPageKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly sourceId?: string;
  readonly parentId?: string;
}

export interface DockLauncherItem {
  readonly id: DockPageKind;
  readonly label: string;
  readonly description?: string;
  readonly statusLabel?: string;
  readonly count?: number;
  readonly severity?: DockSeverity;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export interface DockPageManifest {
  readonly id: DockPageKind;
  readonly label: string;
  readonly launcherItem: DockLauncherItem;
  readonly render: (entry: DockPageStackEntry) => React.ReactNode;
}
```

Rules:

- `DockPageKind` is generic. Page-specific detail ids belong in `sourceId`, not in the
  enum.
- `DockLauncherItem.count` must be real projected state.
- `disabledReason` is for honest placeholders such as terminal/browser not connected.
- View models carry labels only after Web i18n mapping. Shared components do not call
  `useI18n`.

## Component Contracts

### RightDockShell

```ts
export interface RightDockShellProps {
  readonly surface: DockSurfaceKind;
  readonly open: boolean;
  readonly collapsed?: boolean;
  readonly ariaLabel: string;
  readonly stack: readonly DockPageStackEntry[];
  readonly pages: readonly DockPageManifest[];
  readonly launcherTitle: string;
  readonly launcherSubtitle?: string;
  readonly onClose: () => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly onNavigate: (entry: DockPageStackEntry) => void;
  readonly onBack: () => void;
  readonly className?: string;
}
```

Responsibilities:

- render the dock frame,
- choose launcher vs active page from the stack,
- own the scroll container,
- render page header and page content,
- provide close/collapse hooks,
- keep visual state consistent across surfaces.

Must not:

- fetch data,
- mutate app routes,
- execute terminal/browser actions,
- decide whether evidence exists,
- hide authorization state during active work.

### DockLauncher

```ts
export interface DockLauncherProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly DockLauncherItem[];
  readonly onOpenPage: (page: DockPageKind) => void;
}
```

Rules:

- Render compact rows, not large cards.
- Show all available page entries for the surface.
- Placeholder entries are allowed only with honest statuses.
- Do not render `Activity` for normal conversation by default.

### DockPageHeader

```ts
export interface DockPageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly canGoBack: boolean;
  readonly actions?: React.ReactNode;
  readonly filters?: React.ReactNode;
  readonly onBack: () => void;
}
```

Rules:

- Header is one consistent row across Review, Evidence, Files, Terminal, Browser.
- Filters sit below or inside the header only when the page actually filters data.
- The back affordance returns to the previous stack entry, not to app navigation.

### DockPageStack

`DockPageStack` is a renderer, not a router. The state helper should live in
`dock-page-stack.ts`:

```ts
export function createDockRootEntry(title: string): DockPageStackEntry;
export function pushDockPage(
  stack: readonly DockPageStackEntry[],
  entry: DockPageStackEntry,
): readonly DockPageStackEntry[];
export function popDockPage(
  stack: readonly DockPageStackEntry[],
): readonly DockPageStackEntry[];
export function resetDockStack(title: string): readonly DockPageStackEntry[];
```

Rules:

- The launcher is represented by an empty stack or a root launcher entry. Pick one
  approach and use it consistently.
- Surface change resets invalid pages. Example: a channel `activity` entry cannot stay
  active in normal conversation.
- Detail pages are pushed only from explicit row actions.

## Page Contracts

### ReviewQueuePage

```ts
export type DockReviewGroup =
  | "action_required"
  | "risk"
  | "memory"
  | "evidence"
  | "files"
  | "runtime"
  | "channel_protocol";

export interface DockReviewItem {
  readonly id: string;
  readonly group: DockReviewGroup;
  readonly severity: Exclude<DockSeverity, "neutral">;
  readonly status: "pending" | "passed" | "blocked" | "failed";
  readonly title: string;
  readonly reason: string;
  readonly sourceLabel?: string;
  readonly actionLabel?: string;
  readonly timestampLabel?: string;
  readonly onOpenDetail?: () => void;
  readonly action?: React.ReactNode;
}

export interface ReviewQueuePageProps {
  readonly items: readonly DockReviewItem[];
  readonly activeFilter: DockReviewGroup | "all" | "needs_action";
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly onFilterChange: (filter: DockReviewGroup | "all" | "needs_action") => void;
}
```

Projection sources:

| Review group | First projection source | First-slice behavior |
| --- | --- | --- |
| `action_required` | pending approvals, blocked run state | Show actionable row or clean state. |
| `risk` | permission/risk approval state | Show only real high-risk or warning state. |
| `memory` | memory candidate/health APIs when present | Placeholder clean state if API unavailable. |
| `evidence` | run evidence, source projections | Show missing/failed evidence only when real signal exists. |
| `files` | file-change evidence, artifacts | Show changed/generated file summary when available. |
| `runtime` | run/work-unit status and audit | Show failure, timeout, fallback, cancellation, late completion. |
| `channel_protocol` | team metrics/protocol projections | Channel only; hidden from normal conversation by default. |

Rules:

- Pending and blocked rows are above passed rows.
- Passed rows are collapsed by default when there are pending rows.
- No fake "review passed" row if no review projection ran.
- High-risk actions use existing approval callbacks; the page does not create new
  permission behavior.

### EvidencePage

```ts
export type DockEvidenceKind =
  | "run"
  | "source"
  | "file"
  | "shell"
  | "browser"
  | "approval"
  | "teammate_note"
  | "raw";

export interface DockEvidenceItem {
  readonly id: string;
  readonly kind: DockEvidenceKind;
  readonly title: string;
  readonly summary?: string;
  readonly status?: "available" | "loading" | "failed";
  readonly sourceLabel?: string;
  readonly timestampLabel?: string;
  readonly onOpenDetail?: () => void;
}

export interface DockEvidenceGroupView {
  readonly id: DockEvidenceKind;
  readonly label: string;
  readonly items: readonly DockEvidenceItem[];
}
```

Rules:

- Render groups only when they have real items.
- Web/search evidence requires a real search or browser event.
- Failed fetch is an item-level error with retry if retry exists.
- Raw detail stays behind explicit action.

### FilesPage

First slice props:

```ts
export interface DockFileItem {
  readonly id: string;
  readonly name: string;
  readonly pathLabel?: string;
  readonly kind: "attachment" | "reference" | "artifact" | "change";
  readonly status?: "available" | "generated" | "changed" | "missing";
  readonly onOpen?: () => void;
}
```

Rules:

- Show attachments, referenced local files, artifacts, and file-change evidence.
- No full file explorer in the first slice.
- No path opening from package components; Web adapter owns `onOpen`.

### TerminalPage

First slice is honest placeholder plus shell snapshots:

- if no shell snapshot exists: show `No terminal evidence yet`,
- if snapshots exist: show command/status/output preview rows,
- no command input or terminal emulator.

### BrowserPage

First slice is honest placeholder plus search/browser evidence:

- if no browser/search event exists: show `No browser evidence yet`,
- if events exist: show title/url/source summary rows,
- no browser control UI.

### ActivityPage

Channel-only first slice:

- teammate notes,
- workflow progress,
- team metrics summary,
- channel protocol warnings.

Do not expose channel teammate roster/activity in normal conversation. Teammate private
chat may show only selected-teammate direct state if it is useful and private-scoped.

## Surface Adapters

### Channel Adapter

Inputs should come from `WorkspaceClientView` through explicit props:

- selected channel id and channel title,
- channel teammate membership and team metrics,
- channel files/attachments/artifacts,
- pending approvals and run state,
- channel protocol/runtime inspector data,
- current activity/progress projections.

Manifest:

```text
Review
Evidence
Files
Activity
Browser
Terminal
```

Rules:

- Channel settings remain full-page, not a dock page.
- `Activity` is channel-only by default.
- Existing task/detail drilldowns become stack details when possible.
- Do not auto-open dock because new activity exists. Activity indicators can show count.

### Normal Conversation Adapter

Inputs:

- selected conversation/thread id,
- transcript messages,
- mapped `runId` / `turnId` / `threadId`,
- attachments and file references,
- work cell/evidence projections,
- model/authorization state from composer context.

Manifest:

```text
Review
Evidence
Files
Browser
Terminal
```

Rules:

- No teammate roster.
- No teammate `@` routing.
- No channel protocol review.
- Model selection remains composer-owned, not dock-owned.

### Teammate Private Adapter

Inputs:

- selected teammate id/name/avatar,
- private thread messages,
- linked private runs,
- private attachments/file references,
- private approval/evidence state,
- read-only teammate model/provider identity if already available.

Manifest:

```text
Review
Evidence
Files
Browser
Terminal
```

Rules:

- One-to-one only.
- No teammate `@` routing.
- No model picker.
- Evidence is private-scoped by default.

## Styling Contract

Use stable class names from the start:

```text
.right-dock
.right-dock.is-collapsed
.right-dock-head
.right-dock-body
.right-dock-launcher
.right-dock-launcher-row
.right-dock-page-header
.right-dock-page-body
.right-dock-section
.right-dock-row
.right-dock-row-severity-info
.right-dock-row-severity-warning
.right-dock-row-severity-danger
.right-dock-empty
```

Visual targets:

- desktop width: 360px to 400px,
- min practical width: 320px,
- row height: 40px to 48px,
- header height: 44px to 52px,
- compact icon size: 16px,
- no nested card stacks,
- one subtle shadow/border system shared across surfaces.

The first implementation can keep CSS in `apps/web/src/styles/components.css` or split a
small `conversation-dock.css` if the existing stylesheet becomes harder to scan.

## Accessibility And Keyboard

Required:

- `aside` or complementary landmark with `aria-label`,
- launcher rows are real buttons,
- icon-only controls have `aria-label` and `title`,
- page filters use buttons or tabs with selected state,
- Escape may close transient detail only if it does not conflict with app shortcuts,
- focus returns to the triggering row after closing detail when practical.

## Migration Slices

### Slice 0: Inventory And No-Op Types

Work:

- add Web-local dock folder and type definitions,
- export nothing from packages yet,
- add projection helper stubs returning empty arrays,
- add unit tests for page-stack helpers if project test setup is already available.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

### Slice 1: Shell And Launcher In Channel Only

Work:

- implement `RightDockShell`, `DockLauncher`, `DockPageHeader`, `DockPageStack`,
- use it only where channel currently renders `RightDrawer`,
- keep existing side-panel content available behind equivalent dock pages,
- show launcher entries with real counts or honest placeholder status.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "channel"
git diff --check
```

### Slice 2: Channel Review, Evidence, Files Pages

Work:

- project current approvals/runs/files/evidence into dock view models,
- add `ReviewQueuePage`, `EvidencePage`, `FilesPage`,
- keep Browser and Terminal as placeholders unless real evidence exists,
- remove duplicate right-side settings or repeated evidence rows introduced by old
  channel drawer paths.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "review|evidence|files"
git diff --check
```

### Slice 3: Normal Conversation Adapter

Work:

- add the same dock shell to normal conversation after first message,
- map conversation runs/work cells/evidence/files to dock view models,
- forbid teammate activity and `@` features,
- preserve existing shared conversation layout width and composer placement.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "conversation"
git diff --check
```

### Slice 4: Teammate Private Adapter

Work:

- add the same dock shell to private chat,
- map private linked runs/evidence/files,
- keep one-to-one copy and no model picker,
- ensure empty private chat remains centered and the dock does not force a two-line
  private header.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "private"
git diff --check
```

### Slice 5: Package Extraction

Only start after channel plus one other surface uses the same Web-local API.

Work:

- move pure dock types and page-stack helpers to `conversation-ui-core`,
- move presentational shell/pages to `conversation-ui-react`,
- keep adapters and data projections in Web,
- update Web shared re-export boundary.

Validation:

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core test
corepack pnpm --filter @ling-stack/conversation-ui-react typecheck
corepack pnpm --filter @ling-stack/web typecheck
rg -n "apps/web/src|@ling-stack/api-client|@ling-stack/core|localStorage|useI18n" packages/conversation-ui-react/src packages/conversation-ui-core/src
git diff --check
```

## Regression Checklist

- Channel dock opens to launcher when no page is active.
- Channel Review shows clean state when there are no review items.
- Channel Evidence does not show web/search rows without real web/search evidence.
- Channel Files shows only real attachments, references, artifacts, or changes.
- Channel settings are not present in the dock.
- Normal conversation dock uses the same shell and does not show teammate activity.
- Normal conversation model controls remain in composer, not dock.
- Teammate private dock uses the same shell and remains one-to-one.
- Teammate private chat does not show `@` teammate routing or model picker.
- Terminal and Browser pages show honest placeholders when no real data exists.
- Page-stack Back returns to the previous dock page, not to app navigation.
- Surface navigation resets invalid active pages.
- Message action rows remain under the message, not duplicated in the dock.

## Hard Stops

Do not proceed with implementation if a slice requires:

- creating new backend tables only to feed the dock,
- moving channel settings back into the right side,
- adding terminal command execution controls,
- adding browser control UI,
- changing active authorization during an in-flight run,
- showing fake review/evidence/file/search rows to make the dock look populated,
- making private chat collaborative.

## Unresolved Decisions

No blocking decisions for Slice 0 through Slice 2.

Deferred decisions:

1. Whether dock page-stack state persists per surface across app route changes.
2. Whether Files later becomes a full tree explorer.
3. Whether terminal/browser controls ever live inside this dock or open separate tool
   views.

Deferring these does not block the first implementation because the first slices only
need the shell, launcher, review/evidence/files pages, and honest placeholders.
