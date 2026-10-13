# Provider runtime production cutover checkpoint

## Scope and accepted decision

This follows the [accepted scope design](provider-runtime-observation-scope-detailed-design.md),
the [logical invocation foundation](provider-runtime-invocation-checkpoint-2026-10-10.md)
and the [immutable numeric budget](provider-runtime-budget-checkpoint-2026-10-10.md).
Provider D1 is the user's actual **A** answer: managed credentials use durable
configuration revision; env/Keychain credentials use a Host-private comparison
of the current effective key and all headers. External A→B→A establishes sampled
equality only, not a complete mutation history or an atomic SQLite/Keychain read.
Restart, failed reads and missing proof make observations unknown without
disabling ordinary Provider execution. H10's root budget is a separate unanswered
decision and is not settled by this checkpoint.

All implementation is confined to the dedicated `codex/e6-safe-continuation`
worktree. The root checkout and independent delegation-storage design WIP are
not modified or staged. This is a local checkpoint, not a release or E6 acceptance.

## Root cause and implemented boundaries

The former process-global window cache used Provider id/kind/API/model, but
lacked Store, configuration revision and credential authority. It could
reuse a previous endpoint/capacity/credential's window, retain expired minima and
attribute a late error by rereading the new preset. Incident consumers limited
historical candidates before checking applicability. An error's prose or an
earlier discussion pack was not an authentic SDK invocation or its budget.

The complete production chain now consumes authentic invocation facts:

| Module | Responsibility |
| --- | --- |
| Core migration 157 and provenance store | Atomically publish the incident and private safe provenance; keyset candidate reads |
| Daemon runtime-failure domain | Store/Host-scoped private proofs, current applicability, TTL and deduplication |
| Existing execution producers | Original task/reply/selector/reviewer invocation and Attempt lineage |
| Context and health consumers | Filter before accepted limits; never reconstruct private authority from public history |
| Focused tool-budget module | Bind active hydration to its original actual Provider and opaque scope; use frozen static data for HTTP/history |

### Core durable provenance and candidate pagination

- New generic incidents retain the public API and atomically tag their origin.
  Runtime publication atomically stores only safe original invocation identity,
  role, task/Run/Attempt references and times. No key, header value, keyed proof,
  raw error, prompt or payload is persisted in the sidecar.
- Runtime scalar and nested model-signature fields are copied from an exact
  own-data primitive whitelist. Extra fields, getters and `toJSON` are rejected
  before execution/publication; the signature must agree with source identity.
- Public incident DTOs and historical snapshots are unchanged. There is no
  historical backfill or inferred provenance based on summary text. Legacy
  Provider/model rows are unknown for current health; legacy unrelated
  agent-only rows retain their old behavior. Newly tagged generic rows remain
  generic, including those associated with a Provider.
- Nominal keyset cursors bind lane, time and row-ID high-water. The Host scans
  successive pages until its **accepted** limit or EOF, including more than
  500 rejected historical rows. High-water establishes an append boundary,
  not an MVCC snapshot under concurrent update/delete or row-ID reuse.

### Host current observations

- A per-Store WeakMap replaces the global cache. Authentic late A failures stay
  in original A history and do not become B health or window facts.
- Window expiry runs before reads and minimum merging, retaining the existing
  strict six-hour `>` boundary. Negative ages are unknown, not fabricated time.
- Private context/incident registries each have a bounded 4096-entry FIFO.
  Eviction or restart loses proof and therefore current applicability, but does
  not delete durable history. Genuine handles are deduplicated; an atomic
  publication failure does not permanently mark a handle recorded.
- The agent lane can restrict runtime incidents to its current effective
  Provider; missing effective Provider is unknown. Generic and unrelated old
  agent incidents retain their separate semantics.
- A consumer's expected original scope is checked for private ownership and
  equality **before one current sample**. Two independent A/B samples cannot
  be composed into authority for B's learned window.

### Production producers and consumers

- Trusted Pi task/reply execution records domain facts and then preserves the
  original private sink return value, including async rejection draining.
  Aggregate catches and early discussion-pack window learning are removed.
- Route/intent retries and JSON repair each resolve their actual Provider and
  install a fresh observer. Reviewer execution and recovery have their own
  runtime task/Attempt rather than borrowing the outer task Attempt.
- Reply/intent/route context packs, workflow/compaction, channel continuation,
  interventions, summary assessment, observer's two 50-result lanes, metrics'
  500 accepted results and new snapshots' 200 accepted results use the shared
  current projection. Historical snapshot GET/diff does not rebuild history.
  A caller without a resolver uses static capability, not implicit env access.
- Active tool hydration uses the captured original scope/preset with the actual
  Provider object. HTTP/history without live proof reads only frozen own-data
  model/API/numeric Run fields, never keys, headers or arbitrary serialization.
  The existing large orchestrator only passes this authority to the focused
  module; it does not acquire another cache or budget implementation.

## Actual verification on the frozen cutover source

| Gate | Evidence |
| --- | --- |
| Core complete suite, Node 22 | 2641/2641, actual exit 0; zero fail/cancel/skip/todo |
| Daemon complete suite, Node 22 | 3907/3907, actual exit 0; zero fail/cancel/skip/todo |
| Core provenance/lifecycle focused, Node 22 and 24 | 44/44 each, exit 0 |
| Scoped domain and tool budget, Node 22 and 24 | 40/40 each, exit 0 |
| Actual context/observer/HTTP metrics and snapshots, Node 22 and 24 | 13/13 each, exit 0 |
| Real Pi/loopback production task/reply/route/intent/reviewer, Node 22 | 11/11, exit 0 |
| Joint source matrix, Node 22 and 24 | 478/478 each, actual exit 0; zero fail/cancel/skip/todo |
| Migration fixture correction, Node 22 and 24 | 73/73 each, exit 0; also covered by final Core full |
| Final Daemon TypeScript build | exit 0 |
| Workspace typecheck | exit 0; explicit `WORKSPACE_TYPECHECK_EXIT=0` receipt |
| Documentation and public-repository checks | 316 Markdown files and 4440 repository files, exit 0 |
| Independent production review | no remaining P1/P2 in this slice |

Overlapping matrices are not summed into a unique test count. The complete
Core/Daemon suites independently ended with real process exit 0. Root recovered
joint processes 57753 and 33964 through their original terminal handles; both
returned `exit_code: 0` after their full TAP footers. The independent reviewer
read the footers but did not poll these Root handles.
The joint command contained an unmatched lifecycle test pattern; the actual
`channel-team-lifecycle-store.test.mjs` is covered by the Core 44 and full suite,
not by that unmatched pattern. Older Runner full results belong to their
earlier frozen slice and are not a new full-monorepo/Desktop/Mobile claim.

Raw logs under `output/e6-20260928/` include:

- `t13a-runtime-cutover-core-full-final-20261010.tap`
- `t13a-runtime-cutover-daemon-full-final-20261010.tap`
- `t13a-runtime-cutover-final-joint-node22-20261010.tap` and `node24`
- `provider-domain-tool-budget-node22-20261010-final.tap` and `node24`
- `t13a-runtime-consumers-node22-20261010.tap` and `node24`
- `t13a-runtime-cutover-real-producers-node22-final-20261010.tap`
- `t13a-runtime-migration-157-fixture-node22-20261010.tap` and `node24`
- `t13a-runtime-cutover-final-source-20261010.sha256` (41 source/test paths)

The original endpoint/window cache counterexamples are mapped to production
GREEN regressions. Two independently reproduced tool-budget REDs are retained:
active A accidentally reading B's window, and two current samples incorrectly
joining A's original authority to B's window. Both now retain the correct 6656
budget instead of 1024. Source and regression hashes remain frozen.

The first Core full had 2640/2641 because a schema-153 fixture retained new
overlay 157; only that test setup was corrected, preserving old SQL/rows/markers.
Earlier ScriptedRunner tests asserted Provider facts from untrusted error text;
they now assert no publication while preserving retry/ready behavior. The real
Pi positive tests above replace neither those assertions nor authentic receipts.
Empty tool-snapshot fixtures now contain their real frozen model/budget facts.
All original failure logs remain preserved; GREEN does not overwrite RED.

Logical SDK admission is not per-wire retry accounting. Real loopback HTTP/Pi,
disposable SQLite and local server-router checks do not prove an external model
request or packaged GUI. Reviewer executor plus independent Core Attempt is
covered; a complete packaged approval-recovery scenario is not certified here.

## Completion and remaining decisions

Runtime production cutover is implemented and regression-verified. No new
decision remains for Provider D1 A. The full D0/E1–E6, U/T and Harness goal
remains active. H09 trusted human/repeat/model producer, H10's independent root
budget, formal Office packaged-source review, isolated Keychain acceptance,
Mobile compile/sign/install and fresh macOS packaged 12-case acceptance remain
separate unfinished gates. No approval record is fabricated and no old/mixed
App package is used as evidence for the new source. No remote push, release,
cloud-CI enablement, real database/credential mutation or advisory dismissal
is included in this checkpoint.
