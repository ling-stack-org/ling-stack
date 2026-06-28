# Conversation Right Dock Workspace Tools

Status: active design addendum for shared conversation workspace tools
Date: 2026-06-29
Scope: normal conversation, channel root, channel branch, teammate private chat,
run/thread detail entry points, Web first, future Desktop/PC reuse

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation UI Package Extraction Implementation Plan](conversation-ui-package-extraction-implementation-plan.md)
- [Conversation Right Dock Workspace Tools Implementation Plan](conversation-right-dock-workspace-tools-implementation-plan.md)
- [Conversation Composer Unification](conversation-composer-unification.md)
- [Channel Workspace Design](channel-workspace.md)
- [Channel Workspace v1.24 Right Drawer Workspace](channel-workspace-v1.24.md)
- [Ling Agent Operation Cell UI](ling-agent-operation-cell-ui.md)
- [Multi-Agent Collaboration Cards And Ambient Audit](multi-agent-collaboration-cards-and-ambient-audit.md)

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
| Review item | A user-actionable or inspectable item requiring review, confirmation, or traceability. |
| Evidence item | A source, run event, file reference, search result, shell snapshot, or audit row. |
| Placeholder page | A real page entry with honest empty state and no fake content. |
| Surface adapter | Web code that maps channel/conversation/private-chat state into dock props. |

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

The Review page is Ling's unified review inbox. It is broader than code diff review.

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
  Group: Passed / Clean
    collapsed by default
```

Rules:

- High-risk review items may be actionable.
- Low-risk passed items stay collapsed.
- A review item opens a detail page in the page stack; it does not expand into a giant
  card inside the list.
- Review state must be honest: if no review data exists, show a clean empty state.
- The dock must not block the conversation unless the underlying approval policy blocks
  execution.

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
  [Conversation Right Dock Workspace Tools Implementation Plan](conversation-right-dock-workspace-tools-implementation-plan.md),
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
