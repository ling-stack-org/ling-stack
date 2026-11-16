# Conversation Change Summary Implementation Plan

Status: active
Owner: Web conversation and daemon workspace review
Contract: [Conversation Change Summary](conversation-change-summary.md)

## Scope and sequence

1. Define the lightweight latest-Turn summary contract and read-only daemon endpoint.
   Reuse immutable net review in a read snapshot; exclude private workflow content.
   Add TypeScript behavior tests for selection, scope, reversion and bounded evidence.
2. Expose the endpoint through the typed client. Implement a scope-aware refresh resource
   with invalidation coalescing, single-flight/trailing refresh, submission reset and
   visibility/daemon-observation gates. Validate lifecycle boundaries in TypeScript.
3. Add the shared composer slot, chip and accessible upward file popover. Connect normal,
   channel and teammate-private conversation identities and scoped review navigation.
   Add localized copy and shared theme styles; keep surface wiring small.
4. Verify live-summary review refresh while preserving historical disclosure boundaries.
   Exercise all three surfaces with repository Playwright, including running/completed,
   net-zero reset, late response isolation, file selection and narrow/overflow layouts.
5. Run the narrow regression suites and owning typechecks, build, lint, i18n and docs
   checks. Inspect the final diff and synchronize the durable contract with observed
   behavior and acceptance boundaries. Transfer durable rules and remove this completed
   plan according to the design-index maintenance policy.

## Delivery boundary

All work is isolated on `codex/conversation-diff-summary` from `origin/main`.
The original worktree's uncommitted work remains untouched. This plan authorizes source
implementation and local verification; deployment, merge and installed-client acceptance
are separate activities.
