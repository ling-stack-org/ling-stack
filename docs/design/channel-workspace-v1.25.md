# Channel Workspace v1.25 Codex-Inspired Progress Popover

## Status

Implemented in the web channel workspace polish slice, then superseded on 2026-06-16
for drawer ownership: the floating popover remains, but the right drawer `Progress`
root page is retired. This remains a frontend-only refinement: no daemon API, database
table, or browser-side Git probe was added.

2026-06-24 conversation ownership update: this slice is also superseded for conversation
detail ownership. The right drawer must not own conversation artifacts, attachments,
links, operation evidence, task/run process, approvals, checks, source summaries, or
workflow/packet summaries. Those details belong in the main conversation page through
inline expansion, in-turn previews, or explicit raw/debug detail.

2026-06-29 environment extension: branch, change, commit/push, browser, and source
environment rows are now specified in
[Channel Workspace v1.27 Environment Surface](channel-workspace-v1.27-environment-surface.md).
The v1.25 rule still stands: the Web client must not probe Git state directly, and the
floating popover must stay a glanceable status surface rather than a persistent drawer.

## Summary

v1.25 refines the channel progress popover by borrowing the strongest part of the Codex
floating status panel: a compact operational glance that starts with context, then shows
current progress.

The goal is not to copy Codex's dark surface or single-agent repository model. Ling's
popover must stay channel-scoped, multi-agent-aware, approval-aware, and consistent with
the existing strict channel workspace.

```text
workspace context
-> current progress
```

## Problem

The previous attention popover was accurate but visually read like a backend queue. It
used many bordered cards, repeated status labels, and gave equal weight to progress,
counts, and historical attention items. That made the user do the hierarchy work.

The popover should answer three questions immediately:

1. Where is this work running?
2. What happened last, and what is waiting now?
3. Is there current progress worth keeping in view?

If the user needs raw audit detail, task detail, approval detail, CI triage, or run
evidence for a conversation turn, the owning conversation row owns that detail through
inline expansion or in-turn previews. The popover should not become the detail surface
itself, and neither should the right drawer.

## Reference Boundary

Useful Codex-inspired patterns:

- Put environment/work context at the top before progress.
- Use icon-led rows for status instead of large summary cards.
- Keep progress rows lightweight and icon-led.
- Hide the popover when there is no real progress row.

Do not borrow:

- Codex's single-agent assumption.
- A repo-only model where branch and commit/push are always primary.
- Large dark rounded panels inside the strict daylight channel workspace.
- A second persistent drawer disguised as a popover.
- Attention/history queues in the floating surface; those stay in Activity/audit logs.
- Raw run IDs, workflow IDs, audit payloads, or JSON in the default popover.

## Product Model

The popover is a temporary channel work glance.

```text
header progress icon
  -> transient popover
    -> context rows
    -> progress rows
```

The main conversation remains the durable detail surface for task, run, approval, context,
or CI triage records related to a turn. Opening one from the popover should close or leave
the popover behind and focus the owning conversation row or its in-turn preview, not move
the user into a drawer.

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
Run settings
  provider and permission rows
divider
Progress
  progress rows
```

Rules:

- Hide empty optional sections instead of rendering placeholder copy.
- Do not render an `Attention` section, counts, or top attention rows in the popover.
- If there are no progress rows, the header icon does not open an empty popover and
  does not route to the right drawer.
- The first visible section starts without a top divider.
- The last visible section ends without an extra divider.

## Information Architecture

### Run Settings

The top section is labeled `Run settings` in English and `运行设置` in Chinese.

Context rows are compact and optional. The popover should show only rows backed by
current client state or existing daemon state:

- selected/default provider,
- runtime policy or permission mode,
- active branch or git action state only if already available from an existing workflow
  or status source.

The popover is already scoped to the selected channel, and the channel header already
shows the local workspace path. Do not repeat current channel name or bound local path in
this popover. `defaultTeammateId` is preferred specialist evidence only under the Ling
Agent session model, so it must not render as a visible default responder or "preferred
teammate reply" row here.

The Web client must not start new Git probes merely to fill this section. If branch,
changes, or commit/push state is not already available, omit those rows. Ling should not
pretend every channel is a Git repository.

### Progress

Progress is a short list, not a card grid.

Progress is also not a completed-task history. It should project the current or most
recently actionable task. When a new task starts, the progress section refreshes around
that task. Completed work collapses to a one-line terminal summary and remains available
through details/history instead of keeping every completed step expanded in the popover.

Rows:

- latest run status when a channel run exists,
- current task status when an explicit task is selected or active,
- pending approval when work is waiting on the user,
- active workflow step when the channel has workflow state.

Each row has:

- an 18px status icon,
- one primary line,
- one optional secondary line,
- no separate bordered card.

The last incomplete row should use a waiting/running icon. Completed rows use a success
icon. Failed and blocked rows use failure/blocking icons. Do not show raw status strings
when a user-facing label exists.

Ordering:

1. blocked or failed actionable work,
2. waiting approval,
3. running/current task rows,
4. queued next work,
5. one-line completion summaries.

Completed step rows should not crowd out active/waiting rows. If all visible work is
terminal, show the most recent completion summary plus a details affordance.

### Attention Boundary

Attention-derived items remain available as Activity filters, saved views, details, and
audit history. They do not render in the floating progress popover. Terminal events such
as cancelled, denied, expired, and completed belong in the Activity/audit trail unless a
separate current approval or blocker needs user action.

### Source

An optional `Source` section may appear at the bottom when the progress row set comes
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

- `label` is a stable field label such as `Provider` or `Permission mode`.
- `value` is the current value and must fit with ellipsis or wrap safely on mobile.
- `primary` states the thing that happened or is waiting.
- `secondary` names the source or next action.
- `statusLabel` appears once as the trailing pill. Do not repeat the same status word in
  `title` unless it is the natural record title.
- `target` is optional only for passive context/source rows.

## State Matrix

| State | Run settings | Progress | Primary action |
| --- | --- | --- | --- |
| No channel selected | hidden | hidden | existing empty state |
| Channel has no chat/work content | available rows only | hidden | no progress surface |
| Channel has chat but no work | provider/permission rows | hidden | no progress surface |
| Latest run succeeded | context rows | `Last run · Succeeded` with success icon | focus linked conversation turn or in-turn task/run detail |
| Latest run running | context rows | running row with spinner/clock | focus linked conversation turn or active operation cell |
| Pending approval exists | context rows | approval-needed row | open approval detail |
| Workflow blocked | context rows | blocked workflow row | open task/context detail |
| New workflow starts after completion | context rows | new workflow row replaces prior completion rows | open workflow detail |
| Failed work exists | context rows | latest failed row if it is current | open task/run detail |
| Non-conversation side utility open | no popover | utility owns only settings/tools not conversation evidence | header icon does not route progress into the utility |
| Teammate manager open | no popover | hidden | teammate manager owns focus |
| Mobile viewport | same section order | compact rows | fixed bottom sheet |
| Chinese locale | same section order | labels may wrap | no horizontal overflow |

State priority:

1. `blocked`
2. `failed`
3. `pending`
4. `running`
5. `success`
6. `neutral`

This priority applies to choosing the strongest progress summary when multiple states
exist. Attention row ordering remains an Activity/audit-log concern.

## Visual Rules

- Width: keep the existing desktop lane, roughly 360-400px.
- Radius: use the channel system radius; do not copy the large rounded Codex dark panel.
- Background: keep the strict channel workspace surface in the channel UI. Dark mode
  should use semantic tokens only when the surrounding surface already uses dark tokens.
- Shadow: one panel shadow is enough. Do not add nested shadows to rows.
- Dividers: use one divider between Context, Progress, and Source sections.
- Cards: avoid nested card-in-card treatment. The popover shell is the panel; rows are
  rows.
- Icons: use lucide icons already present in the app. Status icons should share 18px
  size and 2.4px stroke with existing channel header icon rules.
- Typography: preserve the accepted progress popover scale:
  - section titles: 14px / 600,
  - progress rows: 12px / 500,
  - secondary copy: 12px / 400,
  - status/meta chips in Activity surfaces: 11px / 600.

## Interaction Rules

- The header progress icon remains icon-only and does not show a numeric badge.
- If a non-conversation side utility is open, the progress icon does not open or focus a
  Progress drawer page.
- If no conflicting utility is open and progress exists, the icon opens the popover.
- Opening a non-conversation side utility hides the popover.
- Opening teammate management hides the popover.
- Escape and outside click close the popover.
- Clicking a progress row focuses the most specific owning conversation target available.
- Attention/audit rows open from Activity, not from the popover.
- The progress section may collapse; the popover does not reveal hidden attention rows
  when collapsed.
- The popover must not cover the composer on mobile; it becomes the existing fixed bottom
  sheet behavior with the same section hierarchy.

## Copy Rules

Use user-facing action language instead of database status language.

Preferred examples:

- `Last run · Succeeded`
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
- channel execution proposals,
- workflow/workflow step summaries,
- existing external work CI triage read model.

Future data may add branch, change count, and commit/push readiness through the v1.27
Environment Surface, but only through a real workspace status source. The Web client
should not shell out or infer Git state from paths.

### Data Mapping

| UI field | Current source | Rule |
| --- | --- | --- |
| Provider | selected/default provider preset state | Show display name; omit if no selected/default provider exists |
| Runtime policy | existing permission/runtime policy state | Show short label only; full policy remains in settings utility |
| Branch | future workspace status source | Do not implement from browser inference or shell probes |
| Change count | future workspace status source | Do not implement until workspace status exists |
| Commit/push readiness | future workspace status source | Do not implement until a real git action status model exists |
| Latest run | `latestRun` | Use user-facing status label and linked task/run target |
| Current task | `selectedTask` or active task state | Show only explicit/current task, not first historical task |
| Pending approvals | `pendingChannelApprovals` | Count and rows open approval detail |
| Attention rows | `activityItems` / `buildAttentionQueueItems(activityItems)` | Activity/audit-log only; do not render in the popover |
| Proposals | `channelExecutionProposals` | Do not synthesize a Progress row without an actual waiting proposal/approval surface |
| Workflow step | workflow/workflow step arrays | Use visible user-facing title and status label |
| CI triage source | existing external work CI triage read model | Show source only when rows are from CI triage |

## Implementation Cut

1. Add a small presentation model for the progress popover inside the channel workspace
   path, or keep it local to `WorkspaceClientView.tsx` if the shape remains simple.
2. Replace the current progress preview with context + progress sections.
3. Remove floating attention counts/items from the popover; keep those records in
   Activity/audit surfaces.
4. Add missing English and Chinese labels for `Run settings`, row labels, and source
   labels.
5. Keep unrelated non-conversation side-utility behavior unchanged.
6. Add focused Web checks for desktop and mobile popover geometry.

Recommended file sequence:

1. `apps/web/src/features/workspace/WorkspaceClientView.tsx`
   - add the presentation model builder near the progress popover component,
   - derive context rows, progress rows, and source rows before JSX,
   - remove popover-only attention item routing,
   - avoid broad component extraction until duplication proves real.
2. `apps/web/src/styles/components.css`
   - keep progress rows as lightweight section rows,
   - keep existing desktop lane and mobile fixed sheet behavior,
   - add overflow constraints for long Chinese labels.
3. `apps/web/src/i18n.tsx`
   - add English and Chinese labels for `Run settings`, context row labels, progress row
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
- No global redesign of unrelated workspace utilities.
- No replacement of Activity history surfaces beyond the conversation-ownership rule.
- No Git probing from the browser client.
- No dark-mode-only restyle of the channel workspace.
- No removal of existing audit surfaces.

## Acceptance Criteria

- The popover first shows available context, then progress.
- The progress icon still has no numeric badge.
- Progress rows are not rendered as summary cards.
- Attention rows, blocked/failed/pending chips, and terminal audit history do not render
  inside the popover.
- Clicking progress rows routes to existing task, approval, context, or run destinations.
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

- desktop channel with side utility hidden and current progress present,
- desktop channel with non-conversation side utility open,
- desktop channel with no current-channel work,
- mobile viewport with progress popover open,
- Chinese locale with the longest blocked/pending labels.

Detailed QA matrix:

| Scenario | Expected result |
| --- | --- |
| Side utility hidden, progress present | Header icon opens popover with Run settings and Progress |
| Side utility open | Header icon does not overlay the popover or expose a Progress detail page |
| Teammate manager open | Progress popover is hidden and does not stack under the teammate manager |
| No current work | Popover does not invent latest run/current task rows from another channel |
| Pending approval | Progress row opens approval detail |
| Blocked workflow | Progress row opens workflow/context detail |
| Long Chinese labels | Row text wraps or truncates without horizontal scroll and without covering status pills |
| Mobile | Bottom sheet preserves section order and remains dismissible by Escape/outside click |
| Future Git state unavailable | Branch/change/commit rows are omitted, not shown as empty placeholders |
