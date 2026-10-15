# Automation whole-item context budget — A23

## Scope and current evidence

A23 closes the existing `promptTemplate.maxContextItems` contract through the
deterministic automation context builder, public preview, durable Run request and
actual Runner input. It does not change selector query scope, permissions,
heartbeat continuation, recurrence, tables or existing history.

The first production-path test run used an owned temporary SQLite Store and real
loopback Daemon routes, with a no-model recording Runner. It produced **1 pass,
2 fail**: the built-in daily brief's explicit budget 32 returned 33 refs/bodies in
both preview and run; an explicit budget 64 preserved all 33 items. The actual
Runner input and durable task prompt were exercised, not a StartRun substitute.

- Raw: `output/e6-20260928/a23-20261015/context-budget-first.log`
- SHA-256: `9b05910f86222727e9c3199e2b7ccd4f5be878850da43b7c1f8b73f089f129c2`
- Public test input at first run:
  `58baed9683715307854d39c03bc7c3009e8924f910bec31b8f2b56eadb964c38`

This is a source repair specification, not a claim that the repair, packaged GUI,
Office full-content review or release has passed acceptance.

## Budget contract

1. Omitted `maxContextItems` adds no new global cap: retain the existing selector
   limits. The built-in daily brief already explicitly sets 32; that is not a
   default for every custom prompt.
2. An authored budget must be a positive safe integer. Reject `null`, strings,
   zero, negatives, fractions, non-finite numbers and unsafe integers. There is
   no new arbitrary maximum. A shared Core reader owns this check.
3. An item is one selector occurrence's fact with its ref and complete Markdown
   body. A channel brief counts as one item regardless of its body length.
   Headings, metadata and warnings are not items. This is not a character or
   token budget; never slice Markdown or keep a partial omitted body.
4. Choose a stable prefix in configured selector order and each selector's
   existing Store/query order. Repeated selectors retain their existing repeated
   occurrences; every occurrence consumes one item. Do not introduce deduping.
5. Select before rendering body text. `selectedRefs`, `contextMarkdown`, preview,
   context artifact, durable request and actual `task.prompt` share that chosen
   set. Empty/exhausted sections add no empty heading or status-filter note.
6. If eligible items were omitted, append a deterministic warning that names the
   budget and omitted count. Existing unavailable-selector and missing-brief
   warnings remain visible even when an earlier selector exhausted the budget.
7. Preserve all existing Store query limits, ordering, channel filtering and
   workspace visibility. This repair is not a permission-policy redesign.

## Admission and failure ordering

- The public create/PATCH/draft parser rejects invalid raw budgets before any
  thread or definition mutation. The resolved public create helper repeats the
  check before `createLingThread`, so generated inputs cannot leave an orphan.
- Core definition create and authored prompt/enabling updates check the same
  contract before SQL. Operational error/quarantine/archive updates must remain
  possible for a historical bad configuration; they must not silently enable it.
- Core draft create and authored prompt updates reject an invalid supplied
  budget before SQL. Domain draft validation also reports a blocking
  `invalid_prompt_template` warning for historical invalid drafts. Such a draft
  cannot preview as ready or create a thread/definition during confirmation.
  Existing confirmed/discarded no-op behavior is retained.
- The builder checks the budget before reading any selector facts. A historical
  invalid definition fails preview without partial context. A new non-heartbeat
  run builds/validates context after idempotent duplicate lookup but **before**
  inserting its queued AutomationRun or consuming its idempotency key.
- Heartbeat continues through its independent path and does not call the context
  builder. Do not change its ordering or derive a context budget for its resumed
  conversation.

## Modules and implementation order

1. `core/automation-context-budget.ts`: small pure optional-budget reader; export
   through the existing package-root index (no new subpath API is needed).
2. Core draft validation/SQLite writers and Daemon schema/resolved create:
   admission before side effects, with one validation rule and existing errors.
3. Daemon `automations/context.ts`: private whole-item section projection;
   existing selectors retain their query and body formatter; one common prefix
   selection supplies refs and rendering.
4. Daemon `automations/run.ts`: context validation/build before queued admission
   for non-heartbeat runs, with the existing duplicate/heartbeat behavior intact.
5. Source-only regressions: public preview/run and actual prompt, invalid public
   and direct Store writes, historical invalid row recovery, no queued/idempotency
   residue, all selectors, repeated selectors, small/large/omitted budget,
   empty/missing facts and unsupported warnings.

## Verification hand-off

Root owns fresh builds and actual test execution. Parallel test authors do not
build/import dist or modify Git; independent review is performed by an Agent
that did not implement these changes. Root also updates the Desktop frozen source
inventories for the new Core file. Main CI remains disabled by the user's
instruction and is neither a gate to wait for nor a service to re-enable.

Before acceptance, require fresh public and pure-projection suites, existing
automation/draft/heartbeat/scheduler regression checks, and an independent review
of failure-before-write ordering. Record real command results and raw hashes in
the A23 ledger. No unresolved product-policy decision remains for A23; unexecuted
validation and the separate E6/Office/package gates remain explicitly unfinished.
