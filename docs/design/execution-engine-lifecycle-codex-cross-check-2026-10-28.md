# Execution-engine lifecycle: Codex source cross-check

Date: 2026-10-28. Evidence: static upstream source and upstream test definitions,
not an execution of Codex's Rust tests or proof of its desktop settings internals.

Fixed upstream revision: `openai/codex@4c54667b408ea7c5d262f1a4171ca414a8f5be88`
(GitHub API reports commit time `2026-10-27T17:08:08Z`). The official
[App Server API overview](https://learn.chatgpt.com/docs/app-server#api-overview)
was also fetched. Explicit configuration writes are distinct from reads and
task interruption; that API list alone does not establish UI race handling.

## Direct source evidence

1. [TUI event_dispatch.rs, lines 1649–1720](https://github.com/openai/codex/blob/4c54667b408ea7c5d262f1a4171ca414a8f5be88/codex-rs/tui/src/app/event_dispatch.rs#L1649):
   MCP login reserves `pending_mcp_login_start` before starting asynchronous work.
   An overlapping start is rejected. Its record contains request ID, server name,
   originating thread, and early completions. The start response consumes the
   record only when its request ID matches; the active login ID is per server.
   Replacement completions whose login IDs no longer match are discarded.
   An early completed login does not open its browser flow afterward.
2. [TUI app_server_events.rs, lines 344–360](https://github.com/openai/codex/blob/4c54667b408ea7c5d262f1a4171ca414a8f5be88/codex-rs/tui/src/app/app_server_events.rs#L344):
   completions arriving before a pending start response are buffered for that
   server. Later completions must match its active login ID, rather than whichever
   operation or thread is currently visible.
3. [TUI mcp_login_tests.rs](https://github.com/openai/codex/blob/4c54667b408ea7c5d262f1a4171ca414a8f5be88/codex-rs/tui/src/app/tests/mcp_login_tests.rs):
   tests specify overlapping-start rejection, suppression of old completion and
   late browser opening on retry, origin-thread delivery after thread switching
   and session refresh, and retention of the previous result when retry fails.
   They were read, not run locally.
4. [App Server outgoing_message.rs, lines 538–647](https://github.com/openai/codex/blob/4c54667b408ea7c5d262f1a4171ca414a8f5be88/codex-rs/app-server/src/outgoing_message.rs#L538):
   pending callbacks are removed/consumed by request ID. Cancellation removes
   callbacks; cancellation by thread only removes entries owned by that thread.
   A late response without a registered callback is not attached to another one.
   Lines 578–596 additionally check owner connection and auth revision/identity
   for user-verification callbacks; this is not a universal check on every RPC.
5. [Same file, lines 679–714](https://github.com/openai/codex/blob/4c54667b408ea7c5d262f1a4171ca414a8f5be88/codex-rs/app-server/src/outgoing_message.rs#L679):
   sensitive checked responses reserve delivery capacity, then revalidate without
   another suspension before enqueueing. This supports a final publication fence,
   not a claim that all operations can be cancelled or rolled back.

## Application to Ling

- Discovery results are observations, not profile edits. Bind their publication
  to the original live view/authority scope and latest discovery identity.
- Reserve one in-flight install per engine synchronously before the API await.
  A terminal reply belongs to that install and engine, not the current editor.
- Retired view/auth scopes must not republish old discovery/install results,
  reopen a dialog, continue polling, or overwrite another engine's draft.
- An installation can complete on the Host after a view closes. Discarding an
  obsolete UI callback is not evidence that Host work stopped or rolled back.
  Host cancellation and actual drain need their own lifecycle evidence.
- Keep installation outcome, editable configuration, explicit profile save, and
  connection readiness separate. Prefilling must never replace user-authored
  draft fields or another engine's editor; saving keeps existing revision checks.

This is a transfer of proven ownership/cancellation patterns, not an assertion
that Codex's open source contains Ling's multi-engine installer or the same
React profile editor. Do not repeatedly re-research these fixed source findings
unless a new requirement or upstream change affects them.

## Ling repair and verification

Local integration commit `49121df7` merged fixed main `37413fe2` into the E6
branch. Builds/typechecks passed before this cross-check. Functional capture
012 passed 59 existing/new Host lifecycle tests. New deferred-API manager
regressions reproduced 7 failures / 1 pass in capture 013; exact unchanged replay
014 reproduced the same outcome. These are retained RED evidence, not the
current repair status.

The implemented source checkpoints are:

- `8cd5db5f`: synchronous per-engine install admission, live view/authority and
  latest-discovery fences, engine-matched replies, editor-revision protection,
  atomic detected/install prefills, and no duplicate mount discovery. Enrollment
  resumes discovery only after its authorization fence is released. A new
  deterministic test reproduced the missing resume before that final repair.
- `3de11693`: Host discovery/request lifetime propagation and final authority
  checks; installation publication checks; shutdown waits for tracked discovery
  and install settlement. Archive listing/extraction retain owned child/process
  lifetime through actual close, and cleanup failures are not swallowed.
- Final Host combination: capture 023, **67/67**, exit 0. The preceding capture
  022 had a 3000ms fixture version-probe timeout; unchanged exact replay 023
  passed, without weakening its expected version/classification.
- Final Web combination: capture 026, **40/40**, exit 0, including 17 new manager
  cases and real isolated Daemon/HTTP/owned protocol-process neighbors. These
  synthetic protocol peers are not actual engine/provider acceptance.
- Web/Daemon and Desktop main/preload TypeScript checks: exit 0. The original
  login fixture needed one missing helper export; no existing assertion was
  removed or relaxed.

Cancellation does not promise rollback of an installation already committed to
disk. This phase has self-review, not a new independent delta review or a new
packaged macOS UI result.

Evidence is under `output/e6-20260928/channel-policy-v1-functional-observations/`.
Current QA package still excludes the startup/negated-question repairs; no
fresh-package acceptance, new PR, remote merge of this integration, or release
is implied. The broader retained evidence chain materializes as **inconclusive**:
historical package observations and earlier command combinations remain
superseded/open, rather than being silently promoted by the two current passing
combinations. Full report:
`output/e6-20260928/main374-integration-and-lifecycle-20261028.md`.
Continue independent delta review and the existing packaged QA plan; do not
repeat the fixed Codex research or duration/copy acceptance.
