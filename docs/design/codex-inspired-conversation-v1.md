# Codex-Inspired Conversation Experience v1

Status: design baseline for the next Web UI polish and implementation slices
Date: 2026-06-05
Scope: channel chat, teammate private chat, run/thread evidence, right drawer, shared
message components, and progressive disclosure

## Summary

Ling Stack should borrow the strongest interaction ideas from Codex-style coding
workbenches without becoming a single-agent terminal clone.

The product direction is:

```text
conversation first
-> agent work second
-> evidence folded
-> authority always visible
```

The center surface should read like a durable conversation. Agent work, runtime events,
memory recall, tool calls, approvals, and file changes should remain inspectable, but
they should not flood the default chat feed. The user should be able to skim the main
thread, expand the work that matters, and inspect exact evidence when needed.

This document connects existing Ling Stack designs:

- [Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md)
- [Channel Workspace v1.21 Codex-Style Chat Workspace](channel-workspace-v1.21.md)
- [Channel Workspace v1.22 Long Conversation Virtual Feed](channel-workspace-v1.22.md)
- [Channel Workspace v1.24 Right Drawer Workspace](channel-workspace-v1.24.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Run Interruption And Continuation](run-interruption-continuation.md)
- [Ling Memory v1](ling-memory-v1.md)
- [Ling Skill Import v1](ling-skill-import-v1.md)

## Reference Boundary

Useful Codex-style patterns:

- a long-lived conversation or thread is the primary object the user returns to,
- execution progress is summarized in compact timeline rows,
- tool calls, diffs, logs, and runtime details are hidden behind expandable evidence,
- timestamps and copy actions are available without dominating the message body,
- the user can interrupt, redirect, continue, or resume work with visible lineage,
- project instructions, local files, and execution environment are part of the context
  model rather than loose chat decoration.

Ling-specific changes:

- Ling is multi-agent; every assistant message, run, memory recall, and skill execution
  must show which teammate owned it.
- Ling has channels; channel memory and private teammate memory must not leak into each
  other.
- Ling has explicit skills, MCP bindings, provider presets, approvals, and retention
  policy; persona text cannot grant those permissions.
- Ling has workspace-level and channel-level work surfaces; the left drawer must remain
  stable when switching between channel chat, private chat, teammate settings, model
  workbench, runs, approvals, and settings.

Do not borrow:

- a terminal-first visual style as the default Web workspace,
- single-agent assumptions,
- hidden context transfer,
- mid-run prompt injection,
- auto-approved side effects,
- raw event spam as the normal conversation surface.

## Codex Reference Mapping

This design borrows interaction shape from the current open-source Codex CLI, not its
terminal aesthetic.

References checked on 2026-06-05:

- [OpenAI Codex open-source repository](https://github.com/openai/codex)
- [Codex TUI `chatwidget.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget.rs)

The relevant Codex ideas are:

- Codex is a local coding agent with a durable conversation around project work.
- Its TUI separates committed transcript history from an active in-flight cell that can
  mutate while streaming or while tool work is still running.
- Its transcript overlay can show committed history plus the live tail of the active
  cell, so runtime detail is available without making the main viewport unreadable.
- Its bottom pane exposes a single task-running indicator and interrupt hints instead of
  duplicating progress state in every row.
- Slash commands are accepted through the composer, but command dispatch and transcript
  recording stay separate so the conversation remains coherent.

Ling translations:

| Codex pattern | Ling UI translation |
| --- | --- |
| Committed transcript cells | Durable channel/private/run conversation rows |
| Active in-flight cell | One mutable streaming reply or active run summary row |
| Transcript overlay live tail | Right drawer or evidence disclosure with live details |
| Task-running indicator | Compact run status strip plus queue/redirect controls |
| Tool/execution cells | Folded evidence sections, not default feed spam |
| Project instructions context | Workspace/channel/teammate persona and skill sources with explicit boundaries |
| Interrupt hints | `Queue follow-up` and `Stop and redirect`, never prompt injection |

Ling must not inherit Codex's single-agent assumption. Any Codex-style row that says
"assistant worked" becomes a Ling row that names the teammate, selected skill, provider
state, approval state, and memory scope when those facts matter.

## Design Details To Borrow

The implementation should borrow these specific interaction details from Codex-style
workbenches:

| Codex detail | Ling design detail | Why it matters |
| --- | --- | --- |
| Transcript cells are stable | Every durable message, reply, and run summary has one stable row | The feed does not look like duplicated status cards |
| One active mutable cell | A streaming private reply or active run summary mutates in place | The user sees progress without extra assistant duplicates |
| Bottom task status | Active work has one compact status strip near the composer | Progress stays visible without flooding the feed |
| Folded tool/runtime cells | Memory, tools, approvals, files, and runtime are evidence sections | Audit remains available but default chat stays readable |
| Transcript overlay/live tail | The right drawer shows detail and drill-down evidence | Deep inspection does not navigate away from the conversation |
| Commands are parsed separately | Composer actions route to message, task, queue, or redirect explicitly | A normal chat message is not silently injected into active work |

These details are product behavior, not styling. Ling should keep its current Web app
visual language, shared drawer, teammate roster, settings pages, and audit surfaces.

## Product Principle

The main feed is for decisions, requests, replies, and compact work summaries. The
evidence layer is for everything the user may need to audit.

```text
Main feed:
  human message
  teammate reply
  proposal
  compact run summary
  blocked or approval-needed summary

Expandable evidence:
  tool calls
  memory used
  approval payload
  run events
  artifacts
  file changes
  provider and skill resolution
  continuation lineage
```

The user should be able to understand the current state without expanding anything. The
user should be able to verify the exact cause without leaving the thread.

## Duplication Removal Rules

The default UI should prefer one authoritative representation of a fact.

Remove or fold:

- repeated API/provider columns when the row already has provider status,
- repeated readiness/check columns when blocked reasons are available in evidence,
- separate `Next step` text when primary actions already express what to do,
- raw ids in visible row copy,
- repeated memory/tool/file counts across adjacent cards,
- activity event rows that duplicate a run summary already visible in the feed.

Keep visible:

- blocked reason,
- approval needed state,
- failed state,
- selected teammate,
- requested or selected skill when it changes user expectation,
- private/deleted placeholder when historical context needs explanation.

## Detail Hierarchy

The conversation UI uses four disclosure levels:

| Level | Name | User sees by default | Examples |
| --- | --- | --- | --- |
| 0 | Conversation | yes | human message, teammate reply, task request |
| 1 | Work summary | yes | run summary, approval needed, blocked skill |
| 2 | Evidence | collapsed | memory used, selected skill, tool calls, files, lineage |
| 3 | Raw detail | drawer/evidence only | logs, JSON payloads, raw run events, provider metadata |

Rules:

- Level 0 and Level 1 are allowed in the main feed.
- Level 2 is one click away through `EvidenceDisclosure` or the right drawer.
- Level 3 is never shown in the default feed.
- Any state that affects user authority, safety, or next action must be visible at Level
  1 even when Level 2 is collapsed.

This avoids the current failure mode where a channel page looks like duplicated system
data instead of a conversation.

## Information Architecture

### Stable App Drawer

The left drawer is a global navigation component, not a page-specific sidebar.

Rules:

- expanded desktop width stays aligned with the accepted 232px drawer,
- collapsed desktop rail stays aligned with the accepted 48px rail,
- drawer row treatment, bottom settings group, notification markers, and teammate rows
  remain consistent across pages,
- private teammate chat does not swap in a different left drawer,
- teammate settings, Workspace Skill Library, model workbench, runs, approvals, and
  settings render inside the center workspace area.

### Cross-Surface Blueprint

Codex has one conversation surface and one terminal context. Ling has several related
surfaces, so each page needs a clear role:

| Surface | Primary job | Secondary detail surface | Must not do |
| --- | --- | --- | --- |
| Channel chat | Shared conversation and compact work summaries | Right drawer | Become a raw task/run event dashboard |
| Teammate private chat | Direct conversation with one teammate | Light context rail or compact evidence | Show configuration tabs by default |
| Single-agent settings | Durable teammate profile and capability settings | Center settings workspace | Grant permissions through persona text |
| Workspace Skill Library | Workspace skill definitions and import drafts | Global settings page | Decide per-teammate executability alone |
| Run thread | Linked run summaries and continuation lineage | Evidence drawer | Show raw runtime spam as the default thread |
| Model Workbench | Operational model/provider status and actions | Row expansion or right drawer | Duplicate API/check/next-step columns |

The shared left drawer is outside this table because it remains global and stable across
all surfaces.

### Channel Workspace

The selected channel keeps chat as the permanent center surface.

Root details live in the right drawer:

- Progress,
- Files,
- Context,
- Settings.

Drill-down pages open inside that drawer:

- task detail,
- approval detail,
- run summary,
- evidence detail,
- selected file/artifact detail.

Default channel feed should show:

- ordinary human messages,
- AI teammate replies,
- execution proposal cards,
- compact collaboration summaries,
- compact run summaries,
- approval-needed or blocked summaries.

Default channel feed should not show:

- raw task/run/state-transition audit cards,
- run ids as visible copy,
- long tool logs,
- full approval payloads,
- every workflow step event,
- duplicated API/provider/readiness columns.

Channel row examples:

| Scenario | Default row copy | Evidence summary |
| --- | --- | --- |
| teammate replied | `Ada replied in #design` | `Used 2 memories` |
| run started | `Ada started Model Workbench review` | `Designer skill, Pi, approval profile` |
| run blocked | `Ada cannot run Designer Review` | `Missing provider capability` |
| approval needed | `Approval needed: edit 2 files` | `Run, files, risk, approval payload` |
| run complete | `Ada completed Model Workbench review` | `3 files, 2 tool calls, 1 memory` |

The channel feed should use concrete event filter naming. `Activity filters` is too
vague; use `Filter channel events` for the menu and `Channel event filters` for the
panel.

### Teammate Private Workspace

Clicking a teammate opens only private chat.

Private chat owns:

- durable direct messages,
- streamed AI reply state,
- private attachments,
- recent Used Memory chips,
- compact task-from-message entry points,
- a settings icon that opens the single-agent settings page.

Private chat should not show configuration tabs or management panels. Configuration
lives in the single-agent settings page.

Private chat row examples:

| Scenario | Default row copy | Evidence summary |
| --- | --- | --- |
| user sends message | right-aligned message bubble | attachments as chips |
| streamed AI reply | one left-aligned row mutates in place | provider/model visible on hover or evidence |
| provider blocked | `Reply blocked: provider not ready` | provider preset and reason |
| memory used | normal AI answer | `Used memory` disclosure |
| private attachment | compact attachment chips | no automatic AI read unless explicitly included |

The private chat page is not the teammate settings page. It should have one settings
entry point and otherwise behave like a focused direct conversation.

### Single-Agent Settings

Single-agent settings owns profile and capability configuration:

- Profile,
- Model,
- Permissions,
- Channels,
- Skills,
- Memory,
- MCP,
- Danger.

Skills uses the Effective Skill read model. It should show whether a skill is executable
for this teammate and why it is blocked.

### Workspace Skill Library

Workspace Skill Library belongs in global settings, not inside a single teammate by
default.

It owns:

- built-in skill inventory,
- imported custom skill drafts,
- published workspace skills,
- archived/disabled workspace skills,
- provider capability requirements,
- global import warnings,
- references to teammate bindings.

Single-agent Skills then answers:

```text
Can this teammate execute this skill here?
If not, why?
```

### Model Workbench

Model Workbench uses the same conversation/detail hierarchy even though it is more
operational than chat.

Primary table should show:

- model/provider display name,
- status using the shared state vocabulary,
- compact capability summary,
- current binding or owner when relevant,
- primary action icons with hover/focus explanations.

Primary table should not show:

- an `API` column unless the user opens provider detail,
- a standalone `Check` column when blocked reasons and status already explain readiness,
- a standalone `Next step` column when actions already express the next action,
- long provider metadata,
- raw capability payloads.

Detail belongs in row expansion or the right drawer:

- endpoint/API mode,
- capability mismatch,
- install/setup guidance,
- provider credential state,
- optional vector retrieval provider state,
- recent validation results.

Status should match the accepted Stitch direction and the shared vocabulary:

| State | Meaning |
| --- | --- |
| `ready` | configured and usable |
| `running` | validation or setup is active |
| `blocked` | missing credential, tool, provider, or policy |
| `waiting_for_approval` | user approval is required before a change |
| `failed` | last validation attempted and failed |
| `optional_not_installed` | optional capability such as vector retrieval is not installed |

Every icon-only action needs a tooltip or adjacent right-side explanation so the user can
understand what each button does without guessing.

### Run Thread Workspace

Run history should read like a work thread rather than a raw event log.

Default run thread rows:

- objective summary,
- user instruction,
- teammate work summary,
- approval request summary,
- interruption or continuation summary,
- final result summary.

Raw run events, tool output, provider payloads, memory ids, and file diffs belong in
evidence sections or the right drawer.

Run thread row examples:

| Scenario | Default row copy | Evidence summary |
| --- | --- | --- |
| active run | `Ada is reviewing Model Workbench` | `Designer skill, 2 memories, 1 tool` |
| queued follow-up | `Follow-up queued after active run` | source message and target run |
| interrupt redirect | `Stopped and redirected` | cancelled run, partial artifacts, continuation |
| stale completion | not shown as success | evidence records ignored stale result |
| failed run | `Run failed: typecheck failed` | command, exit status, affected files |

## Message Model

Introduce a shared message/feed component model before doing more page-specific polish.
The implementation-level component contract is defined in
[Codex-Inspired Conversation Components v1](codex-inspired-conversation-components-v1.md).

```ts
type ConversationSurface = "channel" | "teammate_direct" | "run_thread";

type ConversationItemKind =
  | "human_message"
  | "teammate_message"
  | "system_summary"
  | "run_summary"
  | "approval_summary"
  | "proposal"
  | "memory_summary"
  | "artifact_summary";

interface ConversationItem {
  id: string;
  surface: ConversationSurface;
  kind: ConversationItemKind;
  title?: string;
  body: string;
  teammateId?: string;
  channelId?: string;
  taskId?: string;
  runId?: string;
  threadId?: string;
  status?: "ready" | "running" | "waiting_for_approval" | "blocked" | "failed" | "succeeded";
  createdAt: string;
  evidence?: ConversationEvidenceBundle;
}
```

The UI can derive this model from existing channel messages, direct messages, runs,
approvals, memory events, and artifacts before adding a new durable table.

## Shared Components

### MessageComposer

Already shared between channel chat and private chat. Keep consolidating:

- same textarea spacing,
- same attachment preview strip,
- same send action geometry,
- surface-specific tools through props,
- no page-specific composer width drift.

### ConversationFeed

New shared component target:

- virtualized scroll area,
- latest-message pinning,
- centered empty state,
- scroll-to-latest button,
- local user message treatment,
- AI teammate message treatment,
- compact summaries,
- keyboard and screen-reader support.

### MessageRow

New shared component target:

- author/avatar area,
- message body,
- optional attachments,
- optional Used Memory chips,
- optional proposal card,
- footer with copy action and timestamp,
- hover/focus actions only.

### EvidenceDisclosure

New shared component target:

- collapsed by default,
- summary row always visible,
- shows what was used and what changed,
- sections for memory, skill, tools, approvals, files, artifacts, logs, and lineage,
- preserve audit data without forcing it into the main feed.

### RightDrawer

New shared component target:

- root pages,
- drill-down stack,
- back action,
- page-level empty states,
- no duplicate close button inside drawer body when the header owns show/hide,
- stable width and responsive behavior.

## Evidence Layer

Evidence summaries should be short and auditable:

```text
Used 2 memories
Requested Designer skill
Blocked: missing provider capability
Waiting for approval: file write
Changed 3 files
Produced 1 artifact
Continued from interrupted run
```

Expandable sections:

| Section | Shows | Default |
| --- | --- | --- |
| Memory | memory titles, scopes, recall reason, used-memory event ids | collapsed |
| Skill | requested skill, selected skill, effective-skill blocked reasons | collapsed |
| Tools | required tools, called tools, approval status | collapsed |
| Files | changed files, artifacts, attachment references | collapsed |
| Runtime | runner, provider, model, timestamps, status transitions | collapsed |
| Lineage | source run, continuation reason, intervention request | collapsed |

Never hide authority-critical information completely. Approval-needed, blocked, failed,
and permission-denied states must be visible in the collapsed summary.

## State Semantics

Use one state vocabulary across channel, private chat, run history, and drawers:

- `ready`: visible and usable,
- `streaming`: assistant reply is still arriving,
- `running`: run or workflow is active,
- `waiting_for_approval`: user action required before side effect,
- `blocked`: cannot proceed without configuration or permission change,
- `failed`: attempted and failed,
- `succeeded`: terminal success,
- `cancelled`: stopped by user or policy,
- `deleted`: historical reference only.

Private teammate hard delete should remove private data but leave channel/run references
rendered as `Deleted teammate` where needed for historical explanation.

## Memory Boundary

Memory should be useful but inspectable.

Default recall behavior:

- channel reply can use workspace memory, current channel memory, current task/run memory,
  and the selected teammate's allowed memory when policy permits,
- private chat can use the selected teammate's private memory and allowed workspace memory,
  but not unrelated channel memory by default,
- a teammate can be allowed to query its own memory from another channel only through an
  explicit cross-channel recall policy and used-memory audit,
- every used memory must produce a UsedMemoryEvent.

UI rules:

- show a compact `Used memory` summary near the relevant AI message or run summary,
- expand to titles, scopes, and recall reason,
- never show secret-adjacent memory in default collapsed text,
- memory settings must show vector retrieval as optional/not installed until a provider
  is explicitly installed.

## Skill Boundary

Skills are workspace-managed definitions with teammate-specific execution eligibility.

UI rules:

- Workspace Skill Library manages importing and publishing skills.
- Single-agent Skills shows executable state for this teammate.
- Run/task surfaces let the user request a skill.
- The run record shows selected skill and blocked reasons.

Persona text can influence behavior, but it cannot grant tools, approvals, secrets,
provider capabilities, MCP bindings, memory scopes, or external-send permissions.

## Interruption And Continuation

The user should be able to steer active work without unsafe prompt injection.

Modes:

- Queue follow-up: active run continues; next linked run starts after terminal state.
- Stop and redirect: active run is cancelled/interrupted; a linked continuation run
  starts from durable partial context.

Conversation UI:

- the composer stays available while work runs,
- active run summary shows pending follow-ups,
- redirect requires explicit instruction,
- continuation messages show lineage in collapsed summary,
- evidence expansion shows source run, partial output summary, used memory, and selected
  skill/provider state.

## Visual Rules

Use the accepted Web console direction:

- no marketing hero treatment,
- no decorative gradients or glass,
- no nested cards for page structure,
- compact icon buttons with tooltips,
- stable column widths,
- text must not overflow compact controls,
- message feed and composer widths stay consistent across channel and private chat,
- empty conversation states are centered inside the feed area,
- right drawer compresses the center column instead of overlaying chat on desktop.

## Implementation Plan

### Slice 1: Documentation And Naming

- Add this design baseline.
- Rename vague labels such as `Activity filters` to channel-scoped language in UI copy.
- Keep old activity tools discoverable, but frame them as filtering channel events rather
  than a separate dashboard.

### Slice 2: Shared Conversation Components

- Extract `ConversationFeed`.
- Extract `MessageRow`.
- Keep `MessageComposer` shared and remove page-specific layout drift.
- Make empty states, footer actions, timestamps, and copy actions consistent.

### Slice 3: Evidence Disclosure

- Add compact run summaries to channel and run-thread surfaces.
- Fold memory, tools, approvals, artifacts, and lineage behind `EvidenceDisclosure`.
- Keep blocked/approval states visible in collapsed summaries.

### Slice 4: Right Drawer Consolidation

- Extract shared `RightDrawer`.
- Keep root pages stable: Progress, Files, Context, Settings.
- Move drill-down task/approval/evidence pages into a drawer stack.

### Slice 5: Private Chat Alignment

- Make private chat use the same feed and row primitives.
- Keep the left drawer unchanged when entering private chat.
- Keep settings as a separate single-agent page.
- Show Used Memory and attachments with the same disclosure model as channel chat.

### Slice 6: Run Thread Polish

- Render LingThread as a conversation-like work thread.
- Show linked runs as compact summaries.
- Show continuation/interruption lineage inline.
- Keep raw run events in evidence.

### Slice 7: E2E And Visual Regression

- Add browser checks for channel/private feed width consistency.
- Add checks for empty state centering.
- Add checks that no raw event spam appears in the default feed.
- Add checks that approval/blocked states remain visible while details are collapsed.

## Acceptance Criteria

- Switching channel, private chat, teammate settings, model workbench, runs, approvals,
  and settings does not resize or replace the global left drawer.
- Channel and private chat share composer geometry.
- Channel and private chat share message row spacing and empty-state alignment.
- Default feeds show conversation plus compact summaries, not raw audit/event spam.
- Evidence remains one click away and includes memory, skill, tools, approvals, files,
  runtime, and lineage when available.
- Approval-needed, blocked, failed, and permission-denied states are visible without
  expanding evidence.
- A user can tell which teammate acted, which skill was requested/selected, which memory
  was used, and why work was blocked.

## Non-Goals

- No new vector retrieval provider implementation.
- No new durable conversation table in the first UI extraction slice.
- No Codex visual clone.
- No terminal-first Web UI.
- No hidden cross-channel memory recall.
- No automatic permission changes from persona, skill, or imported markdown.
- No mid-run prompt injection into an active runner session.

## Verification

Design/doc-only baseline:

```bash
git diff --check
```

Implementation slices should additionally run:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
```

Targeted browser validation should cover:

- channel feed,
- teammate private chat,
- single-agent settings,
- Workspace Skill Library,
- run thread/evidence drawer.
