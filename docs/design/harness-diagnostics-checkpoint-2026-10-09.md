# Harness metadata diagnostics — T13B checkpoint

Status: this read-only slice is implemented and locally verified on
`codex/e6-safe-continuation`; no remote publication or packaged acceptance.
This slice does not complete T13, Harness or the packaged E6 acceptance set.

## Scope and module boundary

The existing Run debug disclosure gains a lazy, read-only continuation/tool
diagnostic section. No conversation renderer, summary card, database table,
execution policy or recovery algorithm changes. UI observation never grants
an execution claim or authorizes use of a displayed Attempt fence.

| Layer | Responsibility |
| --- | --- |
| Contracts | Closed scope, page, cursor, record and observation DTOs |
| Core | Explicit metadata SQL, strict mapping, ownership and bounded keyset |
| Daemon | Observation time, lease interpretation and safe HTTP failures |
| API client | GET transport, encoded WorkUnit identity and JSON cursor |
| Web | Lazy disclosure, paged reads, refresh, safe errors and scope isolation |
| Desktop | Explicit authored-source review inventory and actual esbuild audit |

## Read contract

`GET /work-units/:id/harness?cwd=...&limit=100&cursor=...`

- The independent route runs before ordinary Store resolution and
  `RuntimeSupervisor.getRuntime`. Registry observation only returns an already
  initialized Store; it never creates one or invokes startup recovery.
- Cold workspace: HTTP 503 `harness_workspace_uninitialized`. This is not an
  empty history or permission to initialize, recover or dispatch execution.
- Missing WorkUnit: 404. Missing linked Run or mismatched reciprocal lineage:
  explicit response status, no execution items.
- Scope and Attempt lookups select only metadata. They do not parse private
  WorkUnit requests, Run task/provider/request snapshots or Attempt fallback
  JSON. Damage to those unrelated payloads must not disable diagnostics.
- Records exclude claim tokens, resume handles, commands, tool inputs/results,
  result summaries and artifact bodies. Artifact IDs are inert references.
- Missing/foreign Attempts expose only ID and `missing`/`ownership_mismatch`;
  another WorkUnit's runtime owner and fence are not projected.
- Fences remain opaque strings. Lease state is an observation at `observedAt`:
  `unclaimed`, `held`, `expired` or `terminal_retained`, not claim authority.

## Pagination and failure semantics

- Default 100, maximum 500. Fetch `limit + 1`; validate the probe as well.
- Descending BINARY `(createdAt, kind, id)` keyset with exclusive cursor,
  bound to the original Run and WorkUnit. Both existing Run/creation indexes
  are used; no unbounded legacy list method or artificial 1000-row limit.
- Each Core page has a read-only SQLite snapshot. Pages are live observations,
  not one historical snapshot. New head rows require refresh; refresh starts
  a new pagination sequence. UI does not turn these observations into a
  completion, fan-in or recovery decision.
- Duplicate/unknown query keys, malformed/foreign cursor and illegal limits:
  400. Corrupt persisted metadata and database failures: visible 500, never
  a fabricated empty page. Responses do not include raw database messages.
- UI refresh resets rows/cursor. Workspace/Run/WorkUnit changes invalidate
  outstanding reads and immediately hide the old scope. Both late success
  and late failure are discarded. Pagination failure retains already-read
  rows with an explicit error; it does not mark the list complete.

## Validation evidence

Final Core tests pass 22/22, including 1001 mixed records, ties, reopen,
privacy, zero-write observation, SQL allowlists/index plans, corrupt probes
and damage isolation for the dedicated scope/Attempt metadata readers.
Real production HTTP regressions pass 6/6, including 1001 tools over 11
pages, a cold Store and route non-dispatch checks. Transport/controller/actual
React render regressions pass 29/29 after the bounded visual adjustment.

| Final local gate | Result | Raw evidence under output/e6-20260928 |
| --- | --- | --- |
| Core full | 2525/2525 | t13b-diagnostics-core-full-20261009.tap |
| Daemon full | 3688/3688 | t13b-diagnostics-daemon-full-20261009.tap |
| API client full | 87/87 | t13b-diagnostics-api-client-full-20261009.tap |
| Web final full | 455/455 | t13b-diagnostics-web-summary-final-full-20261009.tap |
| Workspace typecheck | exit 0 | t13b-diagnostics-workspace-typecheck-20261009.log |
| Final Web build | exit 0 | t13b-diagnostics-web-summary-final-build-20261009.log |
| Desktop authored-source gate | 44/44 | t13b-diagnostics-desktop-source-final-20261009.tap |

Core/Daemon full tests ran with per-process temporary workspaces and homes;
they did not modify real user databases. The final Web-only adjustment did
not change Core/Daemon or the reviewed authored runtime sources. Desktop
tests use real esbuild hash/byte admission and zero workspace-dist inputs,
with synthetic native compiler/signing. This is not production Office
approval or a fresh macOS packaged GUI result.

### Real-browser component check, not packaged App acceptance

Official Computer Use operated the actual production Run debug component
against production HTTP and a temporary SQLite fixture. No model/tool was
executed. The default collapsed disclosure issued no diagnostic request.
Opening loaded 100 records; Load more loaded the sole remaining record and
removed the button; Refresh started a new first-page sequence with 100 rows.
The saved receipt contains four diagnostic GETs (the earlier first check,
the final first page, its tail page and Refresh) and an unchanged 101-row
fixture. Expand exposes safe metadata, revision 0 and an opaque fence;
the private artifact-body sentinel is absent.

The initial browser check confirmed two scanability problems: identical
collapsed labels and a dot-only state, plus an unbounded list. Two added
regressions were red (7/9) before the fix and green (9/9) afterwards. Rows now
show tool name, bounded record identity with a full-ID tooltip and visible
state; full identity remains in the expanded metadata. A diagnostics-only
scroll region is capped at min(28rem, 55vh); other debug lists are unchanged.
At 480x800 the document width remains 480, the region is 440px high, and the
100-row content scrolls internally. The temporary viewport was reset.

Saved evidence: t13b-diagnostics-browser-101-desktop-20261009.jpg,
t13b-diagnostics-browser-expanded-desktop-20261009.jpg,
t13b-diagnostics-browser-expanded-narrow-20261009.jpg,
t13b-diagnostics-browser-final-dom-20261009.txt and
t13b-diagnostics-browser-http-receipt-20261009.json. These explicitly have
fixtureOnly=true and packagedApp=false, and do not certify E6.

## Remaining gates

- T13A stale publication, retention/performance and other Harness work remain
  tracked independently. H10 writer decisions are not defaulted by this slice.
- New Pi/macOS packaged acceptance and Expo/Mobile native-device acceptance
  remain open; prior unit/build results do not satisfy either gate.

No source is pushed or published by this checkpoint. Preserve the independent
delegation writer document WIP and the separate root checkout.
