# E6 topic pagination: fixture correction, not a product filter

## Confirmed cause

The API paging test in `packages/daemon/test/ling-turns-api.test.mjs` used a
`SuccessfulRunner` that returned plain `done` for every request, including
the strict JSON channel intent selector. After the C01-R7 fail-closed repair,
invalid selector output correctly creates a source-owned assistant blocker
with `channel_intent_selection_failed`, rather than silently continuing as
an ordinary discussion.

The failing topic page contained two user messages and two such real durable
blockers. The extra rows were not duplicate projection rows, model ordinary
answers, or an effect of the terminal-denial recency repair. HTTP response,
Store rows, failed intent decisions and runner call purposes were inspected
together in the isolated diagnostic capture 003.

## Minimal correction

Only the test runner's successful **intent selection** response now returns
`{"action":"reply","reason":"Synthetic discussion-only intent."}`.
Other runner responses remain `done`. All existing pagination, selector
rejection, sequence, scope, and uniqueness assertions are unchanged. No
production suppression, blocker, DTO filter, schema or permission changed.

Value: protects=stable canonical topic/root paging; fails_when=successful mock violates selector JSON protocol; why_new=existing paging regression reused, no duplicate test; seam=none; no_claim=packaged GUI or external model acceptance.

## Verification and limits

- Exact native pagination test: RED in capture 001, GREEN in capture 004.
- Complete turn API file plus existing malformed-intent regressions:
  **37/37**, zero failure/cancellation/skip, actual exit 0 in capture 006.
  This includes real Pi against a synthetic loopback HTTP/SSE provider:
  exhausted format repair still blocks, replays its own item, and starts no
  ordinary reply or execution.
- Capture 002's diagnostic reader typo and capture 005's 120-second timeout
  remain in the evidence. The latter omitted the repository's serial test
  mode and shared a default workspace across parallel file workers; capture
  006 uses documented `--test-concurrency=1` and fresh isolated workspace/home.
  The incorrect parallel invocation was not repeated or presented as passed.
- The P5 recency report's historical **84/85** remains unchanged. Its failing
  API case is resolved by this later fixture correction; its already passing
  62 recovery/narration/input checks were not repeated without a source impact.
- No new package, GUI, real SSE interruption, Daemon restart, external-model
  evaluation, remote push, PR or merge is implied.

Evidence: `output/e6-20260928/p5-topic-pagination-20261026/`.
Continue with the remaining R02/P3/P4/P5 plan; do not redo this fixture diagnosis.
