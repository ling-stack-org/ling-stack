# Conversation Right Dock Workspace Tools

Status: active design addendum for shared conversation workspace tools
Date: 2026-06-29
Scope: normal conversation, channel root, channel branch, teammate private chat,
run/thread detail entry points, Web first, future Desktop/PC reuse

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)

## Purpose

Ling needs one right-side workspace tool surface across channel, normal conversation, and
teammate private chat. The current channel drawer and app inspector grew from local
needs, so they can drift into duplicated settings, repeated evidence labels, and
surface-specific cards.

The Right Dock is the shared shell for secondary workspace tools:

- review queues,
- evidence and audit trails,
- files and references,
- browser/search evidence,
- terminal or shell snapshots,
- channel-only teammate activity when policy allows it.

It is not a second transcript, a settings drawer, or a decorative empty panel. The center
conversation stays primary. The dock gives users a compact workbench for details that
should not clutter the chat feed.

## Product Decision

Build a shared `RightDockShell` model.

The evidence and approval closure slice is implemented:

- approval decisions synchronously reconcile their workflow/step owner and remain idempotent across recovery;
- browser evidence retains requested/final URLs and productized failure detail;
- proposed plans expose `available/deleted/unknown` source-message state before offering source navigation;
- Channel Team Metrics and Right Dock consume the same visible-evidence projection;
- file rows carry explicit task/run/workflow/message owner scope instead of relying on flat path grouping.

The Web must not infer workflow completion from an approval row, and the default Dock must not expose raw
identifiers or unbounded evidence payloads.

The shared part is the shell, navigation model, visual rhythm, empty states, page header,
page stack, disclosure behavior, and review/evidence layout. Surface adapters decide
which pages exist and which data is visible.

```text
RightDockShell
  DockLauncher
  DockPageHeader
  DockPageStack
  ReviewQueuePage
  EvidencePage
  FilesPage
  TerminalPage
  BrowserPage
```

Channel, normal conversation, and teammate private chat should not maintain separate
right-side UI systems. They should supply different page manifests and view models to
the same dock primitives.

### Toolbar Parity Addendum

Channel, normal conversation, and teammate private chat also share the same dock
discovery model. The top-right toolbar exposes the shared conversation controls, while
the right dock launcher is the entry point for secondary pages.

- `Review`, `Evidence`, `Files`, and private `Context` are dock launcher entries, not
  top-right toolbar buttons.
- `Details` is always the fallback toolbar entry for a surface that has a live
  conversation/thread context.
- Teammate private chat uses the shared dock for private context instead of keeping a
  second independent right column.
- Channel-only controls such as teammate activity, teammate stack, and governance stay
  channel-only. The bottom terminal becomes shared only when the surface has a real
  workspace folder and terminal session.
- P12 toolbar correction: channel is the baseline. Normal conversation and teammate
  private chat must move toward the channel toolbar grammar: same top-right container,
  same height, hover/focus, badge/chip rules, and details toggle position.
- Channel-specific controls remain channel-specific. The teammate avatar stack,
  governance notifications, progress popover, and bottom panel are not copied into
  private/normal conversation, and they must not be shrunk to make the other surfaces
  easier to match.

### P12b Behavior Parity

The previous toolbar parity slice only made button chrome consistent. P12b makes the
behavior model consistent with channel:

- The shared top-right toolbar default order is `Search / Refresh / Summary / Terminal /
  Details`.
- `Review`, `Evidence`, `Files`, and private `Context` are detail tools. They live in the
  right dock launcher and page stack, not as top-level toolbar buttons.
- `Summary` opens a compact popover next to the toolbar. It is the product-facing name
  for channel progress/context/environment summaries, normal conversation context, and
  private chat workspace state.
- `Terminal` opens the bottom terminal panel for the current workspace folder. It reuses
  the existing workspace terminal command flow and height resize behavior.
- `Details` opens the right dock. The right dock must be horizontally resizable on
  channel, normal conversation, and private chat.
- Channel-only controls remain additive slots: teammate stack, governance review, and
  channel-specific management menus. They do not change the shared five-action model.

### P12c Channel Visual Baseline

P12c locks the visual baseline after the second parity pass: the channel header toolbar is
the source of truth. Normal conversation and teammate private chat must match the channel
toolbar, summary popover, terminal panel, and conversation column rhythm instead of
inventing their own compact variants.

- The shared top-right toolbar order remains `Search / Refresh / Summary / Terminal /
  Details`, but every item is icon-only. Visible text labels are not allowed in the
  header toolbar; labels live in `aria-label`, `title`, and tooltip text.
- Private chat and normal conversation use the same icon button sizing, rounded shape,
  hover/focus state, active state, spacing, and details-toggle position as channel
  `Summary`, `Terminal`, and `Details`.
- `Review`, `Evidence`, `Files`, and private `Context` must stay in the right dock
  launcher/page stack. They must not return to the top-right toolbar to explain missing
  capability.
- `Details` opens the same workspace tool launcher used by channel. The launcher title is
  `Workspace tools`, the subtitle names the current channel/thread/teammate, and the
  visible launcher order is `Review / Plans / Evidence / Files / Activity / Browser /
  Terminal`. Normal conversation and private chat must not use separate visible titles
  such as `Conversation tools` or `Private chat tools`.
- Private or normal conversation context belongs inside the `Activity` page content. It
  must not appear as a separate first launcher row that breaks the channel baseline.
- Search expands into the header content lane without changing toolbar position. The
  search field has a fixed contained height; focus must not add border, padding, outline,
  or line-height changes that push the input outside the header.
- Summary opens exactly one popover anchored under the top-right toolbar. Its width,
  border, shadow, z-index, motion, and close behavior follow the channel
  Summary/Progress popover. Opening Search, Terminal, or Details closes Summary.
- Terminal opens the bottom terminal panel using the same visual contract as channel. If
  the surface has no workspace folder, the icon stays disabled with an accessible reason.
- The conversation record column and composer column for normal conversation and private
  chat use the channel conversation width baseline. Do not keep a separate arbitrary
  `920px` normal-conversation width or an unconstrained private-chat feed width.

Acceptance for this slice is visual, not just structural: at `1440x960` and `1280x800`,
channel, normal conversation, and teammate private chat should show the same top-right
icon rhythm, no search-input overflow on focus, one non-overlapping summary popover, and
matching conversation-column width.

## External Patterns To Borrow

Codex is the closest interaction reference: an empty dock is a tool launcher, while an
active page becomes a compact workbench with its own header and nested detail.

For review-specific structure, prefer mature workbench patterns:

- [VS Code Source Control](https://code.visualstudio.com/docs/sourcecontrol/overview):
  grouped resource states, compact rows, details opened on demand.
- [GitHub Desktop](https://github.com/desktop/desktop): changed-file list plus
  diff/detail viewer, with actions close to the selected item.
- [OpenHands](https://github.com/OpenHands/openhands): agent workspace pages and
  workspace-state transparency. Borrow the agent-workbench idea, not its entire control
  surface.
- [Zed Git panel](https://zed.dev/docs/git): lightweight side panels that do not compete
  with the editor/conversation.

Do not copy dark Codex styling. Ling should keep its current light theme, softer shadow,
compact rows, and low visual noise.

### Reference Pattern Decisions

| Reference | Borrow | Do not borrow |
| --- | --- | --- |
| Codex right dock | Launcher-first empty state, page stack, review/workbench density | Dark styling, coding-only assumptions |
| VS Code Source Control | Grouped review resources and explicit detail opening | Editor-specific staging workflow as the Ling default |
| GitHub Desktop | Changed-file list plus readable diff/detail hierarchy | Repository-only mental model for every review item |
| OpenHands | Agent workspace transparency and tool/evidence separation | Full terminal/browser controls before Ling authorization lifecycle exists |
| Zed side panels | Lightweight dock chrome and non-primary side panels | Editor-first panel semantics that hide conversation context |

Ling's dock should be a conversation-adjacent workbench. The references inform density,
navigation, and review structure, but the product vocabulary remains Ling-specific:
review, evidence, files, activity, browser evidence, terminal evidence, teammates.

### Review Detail Visual Target

The current review detail target is
`tmp/product-design/right-dock-review-diff-v5/index.html`.

The production dock is narrower than that mock, so Ling keeps the page-stack structure:
review list first, row click opens one focused detail page. The detail page should still
match V5's internal hierarchy:

- file header with file type, filename, path, and real `+/-` stats;
- file navigation minimap with green change, amber risk/note, red blocker, and gray
  fallback segments;
- display mode chips for `Unified`, `Split`, `Hide whitespace`, and note-focused review;
- dark diff card with one line-number column, mark, source, and note marker columns;
- folded unchanged context rows derived from hunk line-number gaps;
- inline review notes attached to the changed line, not rendered as large cards below;
- fallback preview cards for loading or unavailable artifacts without fake hunks.

The code palette is intentionally code-themed and borrowed from the V5 mock: `#101211`
background, `#151816` header, `#30362f` border, blue hunk rows, green additions, red
deletions, purple keywords, orange function identifiers, and green strings.

Syntax color should come from Shiki tokens, not from ad hoc regex styling. Ling still
owns the review-specific layers around the code: diff row background, line-number
gutter, `+/-` mark, note marker, inline note placement, folded context rows, and
fallback cards.

Review remains separate from approval. A blocker note can inform the Ling Agent team
flow, but permission approval continues to live in the approval surface.

## Non-Goals

First implementation must not:

- build a full terminal emulator,
- build a full browser controller,
- create new durable audit tables only for the dock,
- invent fake web search, fake files, or fake review items,
- move channel settings back into the right side,
- expose raw JSON, run IDs, provider payloads, or token counters by default,
- make private chat collaborative or expose teammate `@` routing.

Terminal and browser can exist as empty/placeholder pages until real runtime state is
available.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Dock | The right-side workspace tool container. |
| Launcher | The dock home page showing available tools and counts. |
| Page | A dock tool surface such as Review, Evidence, Files, Terminal, or Browser. |
| Page stack | Navigation model: launcher -> page -> detail -> nested detail. |
| Review item | An inspectable change, runtime issue, evidence gap, or risk signal. It can link to an approval, but it is not itself the approval control. |
| Approval item | A permission gate that authorizes a real action such as shell, edit, write, external send, deploy, provider change, or credential change. |
| Evidence item | A source, run event, file reference, search result, shell snapshot, or audit row. |
| Placeholder page | A real page entry with honest empty state and no fake content. |
| Surface adapter | Web code that maps channel/conversation/private-chat state into dock props. |

### Review vs Approval

The dock `Review` page is a review workbench, not the approval form.

- Review answers: what changed, what failed, what evidence is missing, and what should be
  inspected before trusting the result.
- Approval answers: whether Ling may execute a high-risk action.
- Review detail must not require a decision reason. Comments are optional future review
  annotations.
- Approval detail may require a reason for high/critical approvals because it writes an
  execution audit decision and may unblock real side effects.
- A review row can show an `Approval gate` signal and route the user to the approval
  surface, but the dock should not present the approval card as if it were code review.
- Code-oriented review detail uses the shared conversation code theme: mono type, diff
  add/remove colors, hunk/meta rows, and compact changed-file summaries.

## Surface Capability Matrix

| Capability | Channel root/branch | Normal conversation | Teammate private chat | Run/thread detail |
| --- | --- | --- | --- | --- |
| Shared dock shell | Yes | Yes | Yes | Optional rich detail |
| Launcher | Yes | Yes | Yes | Optional |
| Review queue | Yes | Yes | Yes, private-scoped | Yes, rich |
| Evidence page | Yes | Yes | Yes, private-scoped | Yes, rich |
| Files page | Channel files, refs, artifacts | Conversation refs, attachments, artifacts | Private refs, attachments, artifacts | Run artifacts |
| Terminal page | Placeholder, then linked shell snapshots | Placeholder, then linked shell snapshots | Placeholder, then linked shell snapshots | Rich shell snapshots |
| Browser page | Search/browser evidence only when present | Search/browser evidence only when present | Search/browser evidence only when present | Rich browser evidence |
| Teammate activity page | Yes | No by default | Selected teammate only if useful | Contextual only |
| Settings page | No; channel settings are full-page | No | No | No |
| Model selector | No | Not in dock; composer owns it | No | No |
| `@` teammate routing | No; composer owns channel mentions | No | No | No |

The dock follows the conversation surface rule: shared components, surface-specific
policy. A page can be unavailable on a surface, but the available pages must use the
same layout and states.

## Page Model

### Dock Launcher

The launcher is the default empty/entry page. It should look like a tool list, not an
instructional card stack.

Recommended entries:

| Entry | Shows when | Count/status source |
| --- | --- | --- |
| Review | Always | pending review items, warnings, confirmations |
| Evidence | Always | evidence bundles, work cells, source references |
| Files | Always | attachments, references, artifacts |
| Activity | Channel only by default | teammate notes, workflow activity, team metrics |
| Browser | Always as placeholder or when evidence exists | search/browser evidence state |
| Terminal | Always as placeholder or when snapshots exist | shell snapshots/runtime state |

Rules:

- Empty counts show quiet labels such as `Clean`, `No evidence yet`, or `Not connected`.
- Counts must come from real state. Do not infer `web search` from model text.
- Launcher rows should use compact icon + label + short status, not large cards.
- Keyboard focus and screen-reader labels are required for every row.

### ReviewQueuePage

The Review page is Ling's review workbench. It is broader than code diff review, but
file/diff review is the primary visual model. Approval gates appear as related risk
signals, not as the whole page.

Review groups:

| Group | Examples | First source |
| --- | --- | --- |
| Action required | approval requests, high-risk confirmation, blocked run | existing approval/run state |
| Risk review | dangerous permission, write/delete/network escalation, policy mismatch | existing risk/approval policy and run evidence |
| Memory review | promotable notes, stale candidates, verify-before-use warnings | memory health/candidate APIs when available |
| Evidence review | missing evidence, failed search/tool evidence, runner fallback audit | run evidence and source projections |
| File review | changed files, generated artifacts, patch summaries | run artifacts/file change evidence |
| Runtime review | model failure, timeout, overload, late completion, cancellation | run/work-unit status and runtime audit |
| Channel protocol review | teammate role drift, lifecycle warning, team metrics anomaly | channel operating-system projections |

Layout:

```text
DockPageHeader: Review
  filters: All / Needs action / Risk / Memory / Files / Runtime

ReviewQueuePage
  Summary row: Needs action 2, Warnings 1, Clean 5
  Group: Needs action
    row -> severity dot, title, short reason, source, action chip
    detail -> code-themed preview, review facts, evidence links, related approval signal
  Group: Passed / Clean
    collapsed by default
```

Rules:

- High-risk review items may be actionable.
- Low-risk passed items stay collapsed.
- A review item selects the current detail inside the Review workbench. On narrow docks
  the list and detail stack vertically; on wider docks they may split into list/detail
  columns.
- Review state must be honest: if no review data exists, show a clean empty state.
- The dock must not block the conversation unless the underlying approval policy blocks
  execution.
- Approval actions stay in the approval surface. Review detail can describe the gate but
  should not require a high-risk decision reason.
- Code preview rows must use real diff/file/command payloads. If a review item only has
  artifact metadata, the detail loads the artifact through the preview API. If preview
  content is unavailable, show an honest compact fallback row and do not synthesize fake
  diff hunks.

### Implemented Review Workbench Notes

The first Web implementation uses `ReviewQueuePage` from
`@ling-stack/conversation-ui-react` and shared dock view models from
`@ling-stack/conversation-ui-core`.

Implemented behavior:

- visible review rows show title, severity dot, and one short status/action pill only;
- row reasons, artifact paths, and command previews are hidden from the default row and
  remain available through title/detail;
- selected review detail lives in the review page instead of requiring a second click
  into a separate detail route;
- diff artifacts carry `artifactRef` and load real preview text through the existing
  artifact preview API;
- if preview loading fails or returns no text, the UI shows `Preview unavailable` rather
  than a fabricated patch;
- bottom review action bar is present but its buttons stay disabled until durable review
  packet handlers are wired.

### Narrow Dock Correction

The channel, normal conversation, and teammate private-chat right dock is usually about
`340px` wide. A wide `780px` design mock must not be treated as the production target.

For the narrow dock:

- do not render summary cards above the review list; use one compact status line instead;
- do not show disabled review-packet actions. If review packets are not wired, hide the
  action buttons rather than showing inert chrome;
- code previews should preserve code structure with horizontal scroll instead of wrapping
  source lines into unreadable fragments;
- code preview headers show the useful artifact/file title first. Long run artifact paths
  move to `title`/tooltip-level detail;
- selected item detail stays below the list in narrow docks. A two-column list/detail
  layout is allowed only when the dock container is actually wide enough.

### Production Review Dock Correction

The production Review page must be optimized for the real dock, not the presentation
mock. The V4/V5 mock remains the visual language reference: compact file list, colored
diff, inline risk placement, and no approval-form language. The production target is a
single narrow workbench:

```text
Header: Back + Review
Filters: All / Needs action / Risk / Runtime / Changes
Status card: 2 Pending · +42 -7
Rows: severity dot · short title · path · one compact diff/stat chip
Detail: a separate page-stack entry, not inline under the list
Code preview: file strip · dark diff card · single line-number column · horizontal scroll
```

Rules:

- remove the wide mock's permanent packet/action footer until review packet persistence
  exists;
- remove large summary cards and dense explanatory copy from the production dock;
- the production interaction follows the V3 prototype's two-state model: review list
  first, click a row to enter review detail. Do not show the list and full diff stacked
  together inside the 340-368px dock;
- channel list pages may keep channel-level quick actions such as new task and refresh;
  review detail pages hide unrelated global actions and keep only back, title, and close;
- channel review dock width should target the V3 list dock size, `368px`, when viewport
  space allows it;
- keep review separate from approval: review can point to an approval gate, but it must
  not ask for an approval reason or look like an approval form;
- code or diff is the primary object. If real preview text is unavailable, show a compact
  loading/unavailable row and do not synthesize fake code;
- diff artifact previews may be read once by the Web adapter to derive real row stats and
  share the loaded preview between list and detail. Do not fabricate `+/-` counts;
- use color and placement first, short labels second. Do not repeat the same risk meaning
  in dot, title, subtitle, badge, and footer at the same time;
- the dock may use horizontal scrolling inside code blocks. It must not wrap source into
  unreadable fragments to avoid horizontal scroll.

### EvidencePage

The Evidence page answers: "What did this answer or action rely on?"

Evidence groups:

- run/work evidence,
- source icon/search evidence,
- file references and artifacts,
- shell snapshots,
- browser snapshots,
- approval/risk audit,
- teammate notes when visible to the current surface.

Rules:

- Evidence is grouped by actual source type.
- Real source icons can stack visually, but detail rows stay readable.
- Web search appears only when an actual search/tool event exists.
- Raw detail is behind explicit developer disclosure.
- Failed evidence fetches use a small error row with retry, not a global blocking error.

### FilesPage

First version can be a placeholder plus real file references that already exist:

- message attachments,
- referenced local files,
- generated artifacts,
- file change evidence,
- run outputs.

The page should not become a full file explorer in the first slice. A later slice can add
tree navigation and diff preview if Web and Desktop both need it.

### TerminalPage

First version is a placeholder unless a real run/thread has shell snapshots.

Allowed first data:

- shell snapshot summaries,
- command status,
- last output preview,
- linked run/thread target.

Forbidden first data:

- fake terminal prompt,
- arbitrary command execution controls,
- raw terminal stream if authorization and lifetime are not implemented.

### BrowserPage

First version is a placeholder unless a real browser/search event exists.

Allowed first data:

- web search result references,
- browser snapshot metadata,
- page title/url,
- linked evidence item.

Forbidden first data:

- showing browser controls before a browser session exists,
- displaying `web_search` just because the model mentioned the web,
- storing page content in memory without review policy.

## Component Architecture

### Core Package Candidates

`@ling-stack/conversation-ui-core` should own only pure types and helpers when they
stabilize:

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

export interface DockLauncherItem {
  readonly id: DockPageKind;
  readonly label: string;
  readonly statusLabel?: string;
  readonly count?: number;
  readonly severity?: "neutral" | "info" | "warning" | "danger";
  readonly disabled?: boolean;
}

export interface DockPageStackEntry {
  readonly id: string;
  readonly page: DockPageKind;
  readonly title: string;
  readonly parentId?: string;
}

export interface DockReviewItem {
  readonly id: string;
  readonly group:
    | "action_required"
    | "risk"
    | "memory"
    | "evidence"
    | "files"
    | "runtime"
    | "channel_protocol";
  readonly severity: "info" | "warning" | "danger";
  readonly title: string;
  readonly reason: string;
  readonly sourceLabel?: string;
  readonly actionLabel?: string;
  readonly status: "pending" | "passed" | "blocked" | "failed";
}
```

Core must not import React, browser APIs, daemon clients, stores, routes, or CSS.

### React Package Candidates

`@ling-stack/conversation-ui-react` can own presentational primitives after the Web
adapter proves the API:

```text
packages/conversation-ui-react/src/dock/
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

These components accept view models, labels, callbacks, slots, and class names. They do
not fetch data, persist page state, navigate app routes, open local files, execute
commands, or mutate permissions.

### Web Adapter Responsibilities

Keep these in `apps/web`:

- selected channel/conversation/private thread state,
- dock open/collapsed state and app route integration,
- page stack persistence if needed,
- mapping approvals/runs/evidence/files/team metrics into view models,
- i18n labels,
- permission and authorization prompts,
- opening files, browser sessions, run detail, or full-page settings,
- CSS token implementation during the first Web-local slice.

### Current Component Migration

The current `apps/web/src/shared/conversation/blocks/RightDrawer.tsx` is a useful
temporary shell but not the final API. It owns only a static title, icon nav, actions,
and body.

Migration path:

1. Keep `RightDrawer` as compatibility while building Web-local `RightDockShell`.
2. Move channel `channel-side-panel` usage onto `RightDockShell` without changing data.
3. Add launcher and page stack.
4. Adapt normal conversation and teammate private chat to the same dock.
5. Only after at least two surfaces use the dock, extract stable presentational pieces to
   `conversation-ui-react`.

## State Model

Minimum Web-local state:

```ts
interface RightDockState {
  readonly open: boolean;
  readonly collapsed: boolean;
  readonly surface: DockSurfaceKind;
  readonly stack: readonly DockPageStackEntry[];
  readonly activeEntryId: string;
}
```

Rules:

- Closing the dock does not destroy loaded data.
- Opening a launcher row pushes a page stack entry.
- Back pops the stack; returning to launcher never loses the current conversation.
- Detail pages are entered from explicit rows only.
- Surface switches should reset invalid pages. Example: channel `activity` cannot remain
  active after navigating to normal conversation.
- Running/model-active states may lock actions but must not hide authorization status.

## Permission And Privacy Rules

The dock uses the same authorization model as the composer and run approvals.

- It may display permission state and pending approvals.
- It must not change active execution authorization mid-run.
- Terminal/browser pages cannot expose controls before the relevant permission path
  exists.
- Private chat evidence is private-scoped by default.
- Channel teammate notes are visible only according to channel policy.
- Memory candidates are review items until promoted; the dock does not auto-promote
  memory.

## Visual Rules

- Keep Ling's light theme. Do not copy Codex black panels.
- Use compact rows, small icons, and quiet status text.
- Avoid nested cards. Use list rows and section bands.
- The dock can have a subtle floating shadow, but it must not fight the conversation
  column.
- Empty pages use one concise state line and one optional action. No long instructions.
- Page header stays consistent across pages: back/launcher affordance, title, optional
  filters/actions.
- Review severity uses small dots or text color, not large alert boxes unless execution
  is blocked.
- Counts and labels must align with existing product vocabulary: use "teammates", not
  "experts".

## Data Gates

Use strict rendering gates:

| UI | Render only when |
| --- | --- |
| Web/search source | a real search/browser evidence event exists |
| File count | attachments, references, artifacts, or file-change evidence exist |
| Terminal count | shell snapshots or terminal sessions exist |
| Review count | review items exist from approval/risk/memory/evidence/runtime projections |
| Activity count | channel-visible teammate/workflow activity exists |
| Raw detail | user explicitly opens developer/raw detail |

When no data exists, show honest empty state. Do not show decorative source rows.

## Implementation Slices

### Slice A: Documentation And Adapter Inventory

Work:

- land this design,
- land the detailed
  Conversation Right Dock Workspace Tools,
- inventory current `RightDrawer`, `channel-side-panel`, `PageInspector`, run evidence,
  files, team metrics, and approval sources,
- identify duplicate right-side settings or evidence rows to remove during migration.

Validation:

```bash
git diff --check
```

### Slice B: Web-Local RightDockShell

Work:

- create `apps/web/src/shared/conversation/dock/`,
- add Web-local `RightDockShell`, `DockLauncher`, `DockPageHeader`, and
  `DockPageStack`,
- keep CSS in Web,
- keep all data mocked only through real empty view models from adapters.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

### Slice C: Channel Adapter

Work:

- migrate `channel-side-panel` to the dock shell,
- keep channel settings as full-page settings, not dock content,
- expose Review, Evidence, Files, Activity, Terminal placeholder, Browser placeholder,
- preserve current channel context/details behavior through page-stack detail pages.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "channel"
git diff --check
```

### Slice D: Normal Conversation And Teammate Private Adapters

Work:

- add the same dock shell to normal conversation and teammate private chat,
- expose Review, Evidence, Files, Terminal placeholder, Browser placeholder,
- forbid teammate activity by default in normal conversation,
- keep teammate private chat one-to-one with no `@` or model picker.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "conversation|private"
git diff --check
```

### Slice E: Review Queue View Models

Work:

- build Web adapter helpers that project approvals, risk state, memory candidates,
  evidence warnings, file changes, runtime audit, and channel protocol warnings into
  `DockReviewItem`,
- do not add durable storage unless an existing source cannot represent the item,
- add filters and detail pages.

Validation:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- --grep "review|evidence"
git diff --check
```

### Slice F: Package Extraction

Work:

- move pure dock types/helpers into `conversation-ui-core`,
- move presentational dock primitives into `conversation-ui-react` only after two Web
  surfaces use the API,
- keep Web adapter data ownership in `apps/web`.

Validation:

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core test
corepack pnpm --filter @ling-stack/conversation-ui-react typecheck
corepack pnpm --filter @ling-stack/web typecheck
rg -n "apps/web/src|@ling-stack/api-client|@ling-stack/core|localStorage" packages/conversation-ui-react/src packages/conversation-ui-core/src
git diff --check
```

## Acceptance Criteria

- Channel, normal conversation, and teammate private chat can use one dock shell.
- Empty dock state is a launcher, not a blank panel or repeated instructional copy.
- Review page shows real review items or an honest clean state.
- Evidence page shows real evidence only.
- Files, Terminal, and Browser pages can be honest placeholders until real data exists.
- Channel settings do not reappear inside the dock.
- Private chat does not expose teammate `@` routing or channel teammate activity.
- The dock does not duplicate the transcript or duplicate existing message action rows.
- Existing permission/approval policy remains the authority for blocking actions.
- The first implementation can ship Web-local without premature package extraction.

## Open Decisions

1. Whether the dock open/page-stack state should persist per surface or reset on route
   changes. Deferring this only affects convenience, not correctness.
2. Whether Review should be the first launcher item on all surfaces or only when pending
   items exist. Recommendation: always show it with a clean state.
3. Whether Files should later become a full tree explorer. Recommendation: defer until
   file-reference and artifact needs justify it.
4. Whether terminal/browser controls belong inside the dock or should open separate tool
   views. Recommendation: first show evidence/snapshots in the dock; add controls only
   after authorization and lifecycle are designed.
