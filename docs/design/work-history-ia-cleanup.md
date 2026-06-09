# Work History IA Cleanup

Status: P0 design decision
Date: 2026-06-09

Related docs:

- [Thread-First Work History](thread-first-work-history.md)
- [Thread-First Work History V2 Detailed Design](thread-first-work-history-v2-detailed-design.md)
- [Thread-First Work History Implementation Plan](thread-first-work-history-implementation-plan.md)
- [Codex-Inspired Conversation V1](codex-inspired-conversation-v1.md)

## Decision

Work History should no longer be treated as a customer-facing primary work surface.

The customer primary surface is:

```text
Channel Conversation
  -> conversation transcript
  -> Codex-like Work Cell
  -> channel branch tree
  -> branch-local actions
  -> inline evidence/details
```

The current `Runs / Work History` surface should be repositioned as:

```text
Settings
  Developer
    Run Diagnostics
```

or an equivalent advanced/admin area.

This is an IA correction over earlier V1/V2 Work History plans. Earlier plans used Work
History as the global index, restore surface, resume surface, fork surface, and
diagnostics surface. That made the page carry too many unrelated jobs and made it look
like a customer work-management product. Going forward, those jobs should be split by
actual user intent.

## Why

Ling Stack already has channels as the user's work boundary. A user should not need a
separate global Work Threads page to find normal work. If work is difficult to find, the
channel/conversation IA has failed and should be fixed at the source.

The customer wants to know:

- what happened in this conversation;
- what the AI changed or checked;
- whether the work needs attention;
- how to continue or branch the current work;
- how to restore something intentionally archived.

Those jobs belong near the channel conversation, branch tree, composer, Work Cell, and
Settings archive surfaces. They do not require a standalone Work History page.

## Target IA

### Customer Work Surface

Customer-facing work happens inside the channel conversation:

```text
Channel
  Conversation feed
    User messages
    Assistant messages
    Work Cell
      Work in progress
      Work result
      Evidence/details

  Branch tree
    current branch
    child branches
    archived state affordances

  Composer / Action drawer
    continue current branch
    fork
    fork-and-run
    resume from selected turn/run
```

The Work Cell remains the Codex-like default audit surface. It should show enough
evidence for customer confidence without exposing raw runtime internals by default.

### Archived Surface

Archived work should be discoverable from Settings, not from a global Work History main
page:

```text
Settings
  Archived
    Archived conversations
    Archived branches
    Restore
    Open in channel
```

Archived branch restore is a user lifecycle task, not a run-history task. It can reuse
the existing `archived=exclude|include|only` API, but the UX should be Settings/archive
or channel-local, not Work History-first.

### Developer Diagnostics

The former `Runs / Work History` surface should become an advanced diagnostic surface:

```text
Settings
  Developer
    Run Diagnostics
      raw runs
      run events
      shell snapshots
      approvals
      artifacts
      state transitions
      work units / leases / semaphores
      legacy run-only records
      thread/run binding inspection
```

Diagnostics exists for developers, support, and admin/debug workflows. It should not be
presented as the normal way customers find or manage AI work.

## Capability Placement

| Capability | Primary Placement | Notes |
| --- | --- | --- |
| View AI work result | Channel conversation Work Cell | Default customer audit path. |
| Expand evidence | Work Cell details | Keep raw events behind advanced drill-down. |
| Continue current work | Channel composer / action drawer | Not diagnostics. |
| Fork | Branch tree / action drawer | Creates child branch without running. |
| Fork-and-run | Branch tree / action drawer | Explicitly creates child branch and starts first child task. |
| Resume | Action drawer from current branch/selected work cell | Same branch continuation. |
| Archive branch | Branch tree row action | Hide from default channel branch tree. |
| Restore archived branch | Settings Archived / channel archived drawer | Not global Work Threads page. |
| Pin branch | Branch tree if still needed | Treat as channel-local prioritization. |
| Structured thread search | Diagnostics and future scoped search | Do not make global search a primary customer IA dependency. |
| Raw run events | Run Diagnostics | Developer/support only. |
| Shell snapshots | Run Diagnostics | Developer/support only. |
| State transitions | Run Diagnostics | Developer/support only. |
| Legacy run-only records | Run Diagnostics | Migration/debug fallback, not customer value. |

## What Changes From V2D

The V2D implementation remains useful, but its first Web placement is no longer the
target customer IA.

Keep:

- durable thread archive/pin fields;
- `archived=exclude|include|only`;
- structured search APIs;
- fork lineage;
- explicit fork-and-run route;
- Work Cell evidence model;
- run diagnostic data.

Move or reframe:

- Work History `Active / All / Archived` becomes Settings Archived or Diagnostics
  filtering;
- Work History search becomes diagnostics/search infrastructure, not a customer main
  page;
- Work History fork/resume/fork-and-run controls move to channel conversation actions;
- Run detail becomes Run Diagnostics;
- legacy run-only fallback stays inside diagnostics.

## P1 UI Navigation Adjustment

Goal: stop presenting Work History as a main customer destination.

Implemented in this slice:

- `Runs` is removed from the main navigation.
- Settings now has a `Developer` section with an `Open Run Diagnostics` entry.
- The former run-history view title is `Run Diagnostics`.
- The diagnostic rail labels are reframed around run records, thread bindings, and
  legacy run-only records.
- Direct run links and internal `Open run` flows still open the same view, but the
  sidebar remains anchored to Settings because diagnostics is no longer a customer
  primary nav item.

Implemented IA:

```text
Settings
  Developer
    Run Diagnostics
```

The first implementation keeps the existing `runs` view and route-compatible component.
It does not embed the full diagnostics component inside Settings yet, so the Settings
entry opens the existing full-page diagnostics surface. This is an intentional
transition boundary to avoid data-route churn while correcting the customer IA.

## P2 Capability Migration

Goal: move customer work actions back to the channel conversation.

Slices:

1. **Channel action drawer**
   - open from branch tree row or selected Work Cell;
   - hosts Resume, Fork, Fork-and-run;
   - reuses existing daemon routes.
2. **Settings Archived**
   - list archived conversations/branches;
   - restore or open in source channel;
   - uses existing archived filters.
3. **Work Cell evidence completion**
   - ensure customer-level audit evidence is available in the conversation;
   - keep raw diagnostics hidden by default;
   - expose `Open diagnostics` only for advanced users.
4. **Diagnostics cleanup**
   - keep raw runs, events, shell snapshots, state transitions, work units;
   - remove customer work-management language;
   - keep legacy run-only compatibility.

## Non-Goals

- Do not delete the diagnostics page in this IA cleanup.
- Do not remove durable run/thread history.
- Do not remove V2D archive/search/fork/fork-and-run APIs.
- Do not make global Work Threads a customer landing page.
- Do not use legacy run-only compatibility as a reason to add customer IA.
- Do not expose raw runtime diagnostics in normal conversation by default.

## Implementation Order

P0, this document:

- record the IA correction;
- mark Work History as no longer customer-primary;
- define placement for Archived and Run Diagnostics;
- identify where V2D capabilities should move.

P1:

- navigation and title/copy changes only;
- no route or data model changes required;
- keep existing page behavior available as diagnostics.

P2:

- migrate customer actions to channel conversation and Settings Archived;
- reduce Work History dependencies in customer flows.

Partial P2 alignment shipped with P1:

- Conversation Work Cell keeps evidence expansion inline for customer audit.
- Its strong drill-down action is labeled `Open diagnostics`, not `Open run`, because it
  opens raw run/debug detail.
- Fork, resume, fork-and-run, and Settings Archived remain future P2 implementation
  slices.

## Open Decisions

- Should the transitional diagnostics nav label be `Diagnostics`, `Run Diagnostics`, or
  `Developer`?
- Should Settings Archived include archived channels and archived branches in one list or
  separate tabs?
- Should branch pin survive as a customer feature, or should it become a diagnostics-only
  marker until a clear customer need appears?
- Should global structured search surface anywhere for customers, or stay internal until
  there is a concrete cross-channel workflow?
