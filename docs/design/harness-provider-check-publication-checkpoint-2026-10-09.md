# Provider check publication checkpoint, 2026-10-09

## Scope and baseline

Continue T13A in the sole E6 tree, `codex/e6-safe-continuation`, from
`f60deb29`. This slice repairs saved Provider checks, not model discovery,
runtime observations, all credential stores or the entire E6 goal.
Pi1.1 and supported Expo57 migrations are already implemented and saved;
do not repeat them or silently add Expo58 next. See
[migration checkpoint](pi1-expo57-migration-checkpoint-2026-10-08.md) and
[security follow-through](security-upgrade-followthrough-2026-10-09.md).

Root checkout, independent delegation-writer WIP, real databases, credentials
and Keychains are untouched. No push, release, CI enablement, advisory dismissal,
native approval/signing or packaged GUI acceptance is performed here.

## Confirmed failure and contract

Manual check previously wrote by Provider ID after awaiting the network, then
appended an event separately. Startup compared only lastCheck JSON; import
compared updatedAt and pending.checkedAt. Configuration changes at the same
timestamp, A/B/A, deleted/recreated IDs and later admitted checks could therefore
receive an older successful result or a ghost success event.

Migration156 adds independent Provider authority tombstones. It is distinct
from MCP155 and execution Attempt authority. The Host admits a synchronous
snapshot and ticket before any network operation. Manual, startup and model
import share latest-admitted-wins request revisions. The network uses the
admitted Provider, never an older candidate list paired with a newer ticket.

The synchronous publication transaction checks existence, configuration
revision, request revision, one-shot consumption and persisted request source;
then commits result, consumption, durable event and replay state together.
Rejected publication changes none of them. Rollback permits the same ticket
to retry; BEGIN failure does not adopt or roll back another caller's transaction.
Only the committed event may be broadcast. A notification exception emits
a fixed safe warning and cannot reverse the durable receipt. Manual success
returns the committed snapshot, even if notification synchronously edits the
Provider. Manual stale results return HTTP409, code
`provider_check_result_superseded`, only error/message/reason, no old payload.

Configuration INSERT/UPDATE/DELETE triggers retain tombstones across same-ID
recreation. Local-secret INSERT/UPDATE/DELETE invalidates all API/header-ref
consumers; ownership moves invalidate both OLD and NEW owners. Revision range
CHECKs and exact JS integer reads refuse exhaustion, not wrap or rounding.
Marked migration reopen validates the exact table and trigger definitions,
not merely equal object names. It refuses drift without repairing or rewriting
untrusted history. Existing Provider rows and historical checks are preserved
when backfilling authority; no synthetic child runs are created.

Startup has a separate workspace refresh generation: superseded then/catch
cannot change phase/diagnostics or admit remaining candidates. Joining a
completed refresh does not replay warming or diagnostics. Publication results
remain historical receipts; readiness independently reads current canonical
terminal failures. A later failed manual check cannot be misreported ready;
an old A failure cannot make checked-successful B degraded. `checking` and
missing checks are unknown, not known failures. A ready warmup phase does not
attest that every Provider is verified healthy, and no new health listener is
introduced. Unexpected errors use fixed public messages, not raw secret/path
text. Import admits on enqueue, preserves the ticket in the queue, refuses
shutdown publication and observes background publication errors.

## Deterministic evidence

All fixtures use explicit isolated storage/home/workspace and synthetic
secrets. Network probes are real loopback HTTP with request-arrived/release
gates, not sleep-based ordering. Evidence lives in `output/e6-20260928`.

- Original manual HTTP three cases were all RED, then GREEN: config edit,
  deletion ghost event, and newer failure overwritten by older success.
  `t13a-provider-http-red-20261009.raw.log` retains original failures.
- Core contract tests first failed29/29 against old compiled code. Independent
  review added six cases: four RED (source tampering, same-name empty trigger,
  required-column drift, OLD secret consumer) and two already safe integer
  exhaustion cases. Latest Core focused result is35/35, raw
  `t13a-provider-core-green-v2-20261009.raw.log`. Initial Core RED and review
  RED were direct terminal outputs, not fabricated raw-log files.
- Background six cases were RED before modifying startup/import, against the
  newly built Core/manual layer plus old background layer, not all of old HEAD.
  `t13a-provider-background-red-20261009.log` records that exact baseline.
- Further real RED proved both readiness directions and fake exception-marker
  disclosure. Final background15 plus startup7 pass22/22, raw
  `t13a-provider-background-final-v2-20261009.log`.
- Manual API final17/17 covers three obsolete-result cases, notification error,
  postcommit edit and row/event/replay faults. Its earlier receipt predates the
  last background-only change; final joint/full gates must certify final bytes.
- New source-admission inventory case was RED before adding required leaves.
  The68/68 reviewed-source gate uses real esbuild but synthetic native/signing;
  it is not a real approval row or packaged GUI test. No production review
  manifest is fabricated.
- First Core full2598/2599 exposed an old schema153 fixture retaining156.
  The fixture now explicitly removes only new temporary overlays, checks
  actual max-version153, all historical SQL/markers/rows and Provider backfill,
  and reopens twice. Its first correction also exposed a missing exclusion
  for the new table's SQLite autoindex; final focused regression passes.
- The first Daemon full was precisely stopped at owned PID94064 before the
  readiness/privacy fix; it has no full terminal counts and is not a passing
  receipt. Final fulls use frozen source, not that cancelled run.

## Final gate state

Final Core is2599/2599, Daemon3726/3726, Desktop unit1926 pass plus3 Windows-only
skips, Node24 combined67/67 and workspace typecheck exit0. All have real exit0
terminal receipts, not running logs. No final gate remains running.
The16-path digest manifest is `t13a-provider-final-source-20261009.sha256`.
Do not modify frozen source during the final gate. Desktop full includes the
updated68-case real-esbuild/synthetic-native source-admission group; this does
not certify a real native approval/signing operation or packaged macOS GUI.

| Final gate | Result | Receipt in output/e6-20260928 |
| --- | --- | --- |
| Core full | 2599/2599, exit0 | t13a-provider-core-full-final-20261009.tap |
| Daemon full, isolated Node22 | 3726/3726, exit0 | t13a-provider-daemon-full-final-20261009.tap |
| Desktop Node22 unit full | 1926 pass, 3 Windows-only skips, exit0 | t13a-provider-desktop-full-final-20261009.tap |
| Node24 Core/background/manual joint | 67/67, exit0 | t13a-provider-node24-combined-final-20261009.tap |
| Background15 plus startup7 | 22/22, exit0 | t13a-provider-background-final-v2-20261009.log |
| Workspace typecheck | exit0 | t13a-provider-workspace-types-final-20261009.log |
| Docs/public/diff and source identity | pass,16 paths match | t13a-provider-docs-final-20261009.log; t13a-provider-public-final-20261009.log; t13a-provider-final-source-20261009.sha256 |

The source, tests and this checkpoint are saved together via explicit paths;
the independent writer-design WIP is excluded. No remote push, release or
cloud-CI enablement follows this local checkpoint.

## Remaining scope and unresolved decisions

This contract covers durable configuration/order and SQLite local-secret
mutation, not external credential version authority. Resolver status, ref,
updatedAt, configured=true or an ordinary secret hash cannot prove unobserved
external env/Keychain A/B/A. No default revision0 is invented. Shared external
secret mutations also originate in media/external-work and cross workspaces;
their trusted mutation/invalidation boundary remains to be designed and wired.
A private keyed value snapshot could prove current-value equality, not external
monotonic history or a cross-system SQLite/Keychain atomic transaction.

Subsequent T13A producers remain model-discovery publication revalidation,
Web request identity and runtime observation scope/actual-run error attribution.
They should share configuration/credential authority without competing for
saved-check request revisions. Deferring these leaves their stale publication
risks open; this slice must not be called complete T13A.

H10 writer-budget D1 is still unanswered; do not default, re-ask or dispatch
writers/dynamic children. H09 trusted producer, Office native review/isolated
Keychain, Mobile native target/compile/device and fresh macOS12-case acceptance
remain open. Native preparations and loopback tests do not replace them.
