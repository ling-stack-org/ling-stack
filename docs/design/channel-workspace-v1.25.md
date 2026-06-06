# Channel Workspace v1.25 Codex-Inspired Attention Popover

## Status

Implemented in the web channel workspace polish slice. This remains a frontend-only
refinement: no daemon API, database table, or browser-side Git probe was added.

## Summary

v1.25 refines the channel attention/progress popover by borrowing the strongest part of
the Codex floating status panel: a compact operational glance that starts with context,
then shows current progress, then shows the attention queue.

The goal is not to copy Codex's dark surface or single-agent repository model. Ling's
popover must stay channel-scoped, multi-agent-aware, approval-aware, and consistent with
the existing strict channel workspace.

```text
workspace context
-> current progress
-> attention counts
-> top actionable items
```

## Problem

The current attention popover is accurate but visually reads like a backend queue. It
uses many bordered cards, repeats status labels, and gives equal weight to progress,
counts, and every attention item. That makes the user do the hierarchy work.

The popover should answer three questions immediately:

1. Where is this work running?
2. What happened last, and what is waiting now?
3. Which items need a user action first?

If the user needs raw audit detail, task detail, approval detail, CI triage, or run
evidence, the popover should route them into the right drawer. It should not become the
detail surface itself.

## Reference Boundary

Useful Codex-inspired patterns:

- Put environment/work context at the top before progress.
- Use icon-led rows for status instead of large summary cards.
- Separate progress from attention with a thin divider.
- Put count chips near the attention heading, not in the header icon.
- Keep the top few attention items scannable with one title, one secondary line, and one
  status pill.

Do not borrow:

- Codex's single-agent assumption.
- A repo-only model where branch and commit/push are always primary.
- Large dark rounded panels inside the strict daylight channel workspace.
- A second persistent drawer disguised as a popover.
- Raw run IDs, workflow IDs, audit payloads, or JSON in the default popover.

## Product Model

The popover is a temporary channel work glance.

```text
header attention icon
  -> transient popover
    -> context rows
    -> progress rows
    -> attention list
      -> click opens drawer drill-down
```

The right drawer remains the durable detail surface. Opening a task, run, approval,
context item, or CI triage record from the popover should close or leave the popover
behind and move the user into the drawer.

## Layout Spec

The popover shell owns the only panel frame. Interior sections are separated by spacing
and thin dividers, not nested cards.

Desktop geometry:

| Property | Target |
| --- | --- |
| Width | `min(390px, calc(100vw - 380px))`, preserving the current attention lane |
| Top offset | anchored below the channel header, matching the existing `62px` top lane |
| Right offset | aligned with the current `18px` channel workspace inset |
| Padding | 14-16px shell padding |
| Radius | 8px unless the channel token changes globally |
| Max height | fit within the channel workspace viewport; list content scrolls inside the shell |
| Shadow | one panel shadow only |

Mobile geometry:

| Property | Target |
| --- | --- |
| Position | fixed bottom sheet using the existing mobile popover behavior |
| Inset | `auto 10px 10px` |
| Max height | `min(58vh, 520px)` |
| Overflow | shell scrolls; rows do not create horizontal overflow |
| Composer safety | sheet must not cover the composer while text input is focused |

Section order:

```text
Environment
  context rows
divider
Progress
  progress rows
divider
Attention + total count
  count chips
  top attention rows
divider
Source
  source rows
```

Rules:

- Hide empty optional sections instead of rendering placeholder copy.
- Keep `Attention` visible when there are attention items, even if `Progress` is
  collapsed.
- If all sections are empty, the attention icon should route to the Progress drawer page
  or stay inactive according to existing header behavior.
- The first visible section starts without a top divider.
- The last visible section ends without an extra divider.

## Information Architecture

### Context

The top section is labeled `Environment` in English and `环境信息` in Chinese.

Context rows are compact and optional. The popover should show only rows backed by
current client state or existing daemon state:

- current channel,
- bound local path,
- default teammate,
- selected/default provider,
- runtime policy or permission mode,
- active branch or git action state only if already available from an existing workflow
  or status source.

The Web client must not start new Git probes merely to fill this section. If branch,
changes, or commit/push state is not already available, omit those rows. Ling should not
pretend every channel is a Git repository.

### Progress

Progress is a short list, not a card grid.

Rows:

- latest run status when a channel run exists,
- current task status when an explicit task is selected or active,
- pending approval/proposal confirmation when work is waiting on the user,
- active workflow step when the channel has workflow state.

Each row has:

- an 18px status icon,
- one primary line,
- one optional secondary line,
- no separate bordered card.

The last incomplete row should use a waiting/running icon. Completed rows use a success
icon. Failed and blocked rows use failure/blocking icons. Do not show raw status strings
when a user-facing label exists.

### Attention

The attention section keeps the count visible:

```text
Attention                                      12
[Blocked 2] [Failed 0] [Pending 10]
```

Rules:

- `Blocked`, `Failed`, and `Pending` chips stay near the section heading.
- Zero counts may remain visible when needed for stability, but must be visually quiet.
- The list shows the first five actionable items.
- Items are sorted by blocked, failed, pending, then recency.
- Each row is one clickable target.
- Each row shows title, secondary source/status copy, and one status pill.

The row should be lighter than the current card style. Use a single soft border and
neutral background, with hover/focus as the only strong emphasis.

### Source

An optional `Source` section may appear at the bottom when the attention item set comes
from a recognizable external source:

- external work provider,
- GitHub issue/PR workflow,
- CI triage record group,
- imported channel workflow.

This is not a generic footer. If source metadata would be vague, omit it.

## Row Model Spec

The implementation should build a small presentation model before rendering JSX. This
keeps the visual component deterministic and prevents data derivation from leaking into
CSS or row rendering.

```ts
interface AttentionPopoverModel {
  readonly contextRows: readonly PopoverContextRow[];
  readonly progressRows: readonly PopoverProgressRow[];
  readonly attention: PopoverAttentionSection;
  readonly sourceRows: readonly PopoverSourceRow[];
}

interface PopoverContextRow {
  readonly id: string;
  readonly icon: "folder" | "laptop" | "user" | "bot" | "server" | "git-branch" | "settings";
  readonly label: string;
  readonly value: string;
  readonly target?: PopoverTarget;
}

interface PopoverProgressRow {
  readonly id: string;
  readonly icon: "check" | "clock" | "loader" | "shield" | "circle-alert" | "ban";
  readonly tone: "success" | "running" | "waiting" | "blocked" | "failed" | "neutral";
  readonly primary: string;
  readonly secondary?: string;
  readonly target?: PopoverTarget;
}

interface PopoverAttentionSection {
  readonly total: number;
  readonly blocked: number;
  readonly failed: number;
  readonly pending: number;
  readonly rows: readonly PopoverAttentionRow[];
}

interface PopoverAttentionRow {
  readonly id: string;
  readonly attention: "blocked" | "failed" | "pending";
  readonly title: string;
  readonly secondary: string;
  readonly statusLabel: string;
  readonly target: PopoverTarget;
}

interface PopoverSourceRow {
  readonly id: string;
  readonly icon: "globe" | "git-pull-request" | "file-check" | "workflow";
  readonly label: string;
  readonly value: string;
  readonly target?: PopoverTarget;
}

type PopoverTarget =
  | { readonly kind: "progress" }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "approval"; readonly approvalId?: string; readonly runId?: string }
  | { readonly kind: "context" }
  | { readonly kind: "ci-triage"; readonly taskId?: string; readonly runId?: string };
```

Rendering rules:

- `label` is a stable field label such as `Local`, `Default teammate`, or `Provider`.
- `value` is the current value and must fit with ellipsis or wrap safely on mobile.
- `primary` states the thing that happened or is waiting.
- `secondary` names the source or next action.
- `statusLabel` appears once as the trailing pill. Do not repeat the same status word in
  `title` unless it is the natural record title.
- `target` is optional only for passive context/source rows.

## State Matrix

| State | Environment | Progress | Attention | Primary action |
| --- | --- | --- | --- | --- |
| No channel selected | hidden | hidden | hidden | existing empty state |
| Channel has no chat/work content | available rows only | hidden | hidden | open Progress drawer only if user asks |
| Channel has chat but no work | channel/provider/teammate rows | `Waiting for proposal confirmation` only when proposals can exist | hidden | open Progress drawer |
| Latest run succeeded | context rows | `Last run · Succeeded` with success icon | current attention rows if any | open linked task/run drawer |
| Latest run running | context rows | running row with spinner/clock | pending approval rows if any | open linked task/run drawer |
| Pending approval exists | context rows | approval-needed row | pending chip and approval rows | open approval detail |
| Workflow blocked | context rows | blocked workflow row | blocked chip and workflow rows | open task/context detail |
| Failed work exists | context rows | latest failed row if it is current | failed chip and failed rows | open task/run detail |
| Right drawer open | no popover | Progress drawer page owns detail | Progress drawer page owns detail | header icon switches to drawer behavior |
| Teammate manager open | no popover | hidden | hidden | teammate manager owns focus |
| Mobile viewport | same section order | compact rows | compact rows | fixed bottom sheet |
| Chinese locale | same section order | labels may wrap | chips stay compact | no horizontal overflow |

State priority:

1. `blocked`
2. `failed`
3. `pending`
4. `running`
5. `success`
6. `neutral`

This priority applies to attention row ordering and to choosing the strongest progress
summary when multiple states exist.

## Visual Rules

- Width: keep the existing desktop lane, roughly 360-400px.
- Radius: use the channel system radius; do not copy the large rounded Codex dark panel.
- Background: keep the strict channel workspace surface in the channel UI. Dark mode
  should use semantic tokens only when the surrounding surface already uses dark tokens.
- Shadow: one panel shadow is enough. Do not add nested shadows to rows.
- Dividers: use one divider between Context, Progress, Attention, and Source sections.
- Cards: avoid nested card-in-card treatment. The popover shell is the panel; rows are
  rows.
- Icons: use lucide icons already present in the app. Status icons should share 18px
  size and 2.4px stroke with existing channel header icon rules.
- Typography: preserve the accepted attention popover scale:
  - section titles: 14px / 600,
  - progress rows: 12px / 500,
  - secondary copy: 12px / 400,
  - attention item titles: 13px / 600,
  - status/meta chips: 11px / 600.

## Interaction Rules

- The header attention icon remains icon-only and does not show a numeric badge.
- If the right drawer is open, the attention icon opens the Progress drawer page.
- If the drawer is hidden and attention/progress exists, the icon opens the popover.
- Opening the right drawer hides the popover.
- Opening teammate management hides the popover.
- Escape and outside click close the popover.
- Clicking a progress row opens the most specific drawer target available.
- Clicking an attention row opens task detail, approval detail, context detail, or the
  Progress drawer page according to its existing target.
- The progress section may collapse, but attention remains visible when progress is
  collapsed.
- The popover must not cover the composer on mobile; it becomes the existing fixed bottom
  sheet behavior with the same section hierarchy.

## Copy Rules

Use user-facing action language instead of database status language.

Preferred examples:

- `Last run · Succeeded`
- `Waiting for proposal confirmation`
- `Approval needed`
- `Workflow blocked`
- `Open approval`
- `Open task`

Avoid:

- raw IDs,
- snake_case as the only label,
- duplicated status words in both the row title and pill,
- explanatory helper text about how the popover works.

## Data Boundary

This slice should not require new daemon contracts.

Allowed current sources:

- selected channel state,
- selected task,
- latest channel run,
- pending channel approvals,
- derived attention queue items,
- channel execution proposals,
- workflow/workflow step summaries,
- existing external work CI triage read model.

Future data may add branch, change count, and commit/push readiness, but only through a
real workspace status source. The Web client should not shell out or infer Git state
from paths.

### Data Mapping

| UI field | Current source | Rule |
| --- | --- | --- |
| Current channel | `selectedChannel` | Show channel name or omit when no channel is selected |
| Bound local path | selected channel/workspace path state | Show shortened path; never show raw path if unavailable |
| Default teammate | current channel teammate/default teammate state | Show display name; omit if unknown |
| Provider | selected/default provider preset state | Show display name; omit if no selected/default provider exists |
| Runtime policy | existing permission/runtime policy state | Show short label only; full policy remains in Settings drawer |
| Branch | future workspace status source | Do not implement from browser inference or shell probes |
| Change count | future workspace status source | Do not implement until workspace status exists |
| Commit/push readiness | future workspace status source | Do not implement until a real git action status model exists |
| Latest run | `latestRun` | Use user-facing status label and linked task/run target |
| Current task | `selectedTask` or active task state | Show only explicit/current task, not first historical task |
| Pending approvals | `pendingChannelApprovals` | Count and rows open approval detail |
| Attention rows | `buildAttentionQueueItems(activityItems)` | Reuse existing target routing; restyle only |
| Proposals | `channelExecutionProposals` | Show waiting row when proposal confirmation is relevant |
| Workflow step | workflow/workflow step arrays | Use visible user-facing title and status label |
| CI triage source | existing external work CI triage read model | Show source only when rows are from CI triage |

## Implementation Cut

1. Add a small presentation model for the attention popover inside the channel workspace
   path, or keep it local to `WorkspaceClientView.tsx` if the shape remains simple.
2. Replace the current progress preview with context + progress sections.
3. Restyle attention items from heavy cards into lighter rows.
4. Add missing English and Chinese labels for `Environment`, row labels, and source
   labels.
5. Keep the right drawer navigation behavior unchanged.
6. Add focused Web checks for desktop and mobile popover geometry.

Recommended file sequence:

1. `apps/web/src/features/workspace/WorkspaceClientView.tsx`
   - add the presentation model builder near `AttentionQueue`,
   - derive context rows, progress rows, attention section, and source rows before JSX,
   - keep existing `openAttentionQueueItem` and target routing behavior,
   - avoid broad component extraction until duplication proves real.
2. `apps/web/src/styles/components.css`
   - replace heavy `.attention-progress-preview` and `.attention-queue-item` treatment
     with section and row styling,
   - keep existing desktop lane and mobile fixed sheet behavior,
   - add overflow constraints for long Chinese labels.
3. `apps/web/src/i18n.tsx`
   - add English and Chinese labels for `Environment`, context row labels, progress row
     copy, and source labels,
   - keep existing status translations.
4. `apps/web/e2e/app.spec.ts`
   - add or extend focused channel popover checks only after the UI implementation lands.
5. `docs/design/channel-workspace.md`
   - update Phase 33 checklist as implementation lands.

Implementation guardrails:

- Do not query Git state from the Web client.
- Do not add daemon APIs in this slice.
- Do not expose run IDs or workflow IDs in default row copy.
- Do not auto-open task detail from historical tasks.
- Do not turn the popover into a persistent drawer.
- Do not restyle the global app shell while touching this popover.

## Non-Goals

- No new database tables.
- No new daemon endpoints.
- No global redesign of the right drawer.
- No replacement of the activity drilldown drawer.
- No Git probing from the browser client.
- No dark-mode-only restyle of the channel workspace.
- No removal of existing audit surfaces.

## Acceptance Criteria

- The popover first shows available context, then progress, then attention.
- The attention icon still has no numeric badge.
- Progress rows are not rendered as summary cards.
- Attention rows are lighter than the current card-heavy treatment.
- Blocked, failed, and pending counts stay visible inside the popover.
- Clicking rows routes to existing task, approval, context, run, or Progress drawer
  destinations.
- Raw IDs and audit payloads stay out of the default popover.
- Channels without current work do not show invented progress.
- Mobile keeps the same hierarchy without covering the composer.
- Dark and light surfaces use semantic tokens and do not regress to legacy translucent
  gray/glass panels.

## Validation

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Focused browser checks:

- desktop channel with right drawer hidden and attention items present,
- desktop channel with right drawer open,
- desktop channel with no current-channel work,
- mobile viewport with attention popover open,
- Chinese locale with the longest blocked/pending labels.

Detailed QA matrix:

| Scenario | Expected result |
| --- | --- |
| Drawer hidden, attention items present | Header icon opens popover with Environment, Progress if present, and Attention |
| Drawer open | Header icon opens or focuses the Progress drawer page instead of overlaying the popover |
| Teammate manager open | Attention popover is hidden and does not stack under the teammate manager |
| No current work | Popover does not invent latest run/current task rows from another channel |
| Pending approval | Pending chip count increments and clicking row opens approval detail |
| Blocked workflow | Blocked row sorts above failed and pending rows |
| Long Chinese labels | Row text wraps or truncates without horizontal scroll and without covering status pills |
| Mobile | Bottom sheet preserves section order and remains dismissible by Escape/outside click |
| Future Git state unavailable | Branch/change/commit rows are omitted, not shown as empty placeholders |
