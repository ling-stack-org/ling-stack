# Native Execution Engines Validation

Source baseline: `708931accf7bc7de4d67abf2939500e1369969a2`
Branch: `gansx/execution-engine-integration`
Status: T0–T6 source implementation and current-host regression attribution are complete; T7 release acceptance remains incomplete.
Remote main was queried again on 2026-10-19 and still matches this baseline.

## Preserved baseline

The original 472 staged changes were preserved. No staging, reset, stash, commit,
push, or user configuration/database migration was performed. Both the original
staged binary patch and index entries match the saved baseline. The staged patch
SHA-256 is `a5042a7c835569f7c7f937ad2affc5f4f584bc834d1c228c46d4f0850123821e`.
The original complete tracked diff SHA-256 is
`321b446ae999cc28e5ca7e7715193614296d60da48d0536835d15abf74e1f60c`.
All runtime checks use temporary workspaces and a separate LING_STACK_HOME.

## Requirement audit

| Requirement | Implementation and evidence |
|---|---|
| N1 native production selection | Production catalog separates selection from execution. Host-owned, identity-bound evidence is required; final spawn/submit synchronously rechecks current profile, evidence, authorization and policy. Real certification is pending. |
| N2 legacy retirement | Endpoint execution/probes are retired. Runner-only legacy requests return migration-required. No native failure falls back to Pi or endpoint. HTTP policy regression passes with 409 migration status. |
| N3 workflow ownership | Captured owner, ready CAS and final admission protect the latest workflow ownership. The broad workflow suites passed; final native binding suite also passes. |
| N4 idempotency | Native duplicates preserve original Run/thread/resources. Canonical ordinary Pi replay passes after moving duplicate lookup before mutable provider preflight, limited to internal prepared requests. Existing recovery and answer continuations retain their separate admission paths. |
| N5 supervision | Shared Pi/native monotonic idle/hard budgets, heartbeat separation and approval pauses are covered by focused and broad regression. |
| N6 completion proof | Core journals validate durable native binding, complete submission/approval/tool inventory including tool_update, late writes and resource veto. Fresh Core group has 148 passes; its one outdated schema-column assertion was fixed and the historical153→175 upgrade independently passes. |
| N7 FIFO continuation | Production continuation executes canonical FIFO successors with original binding, lineage and independent permissions. Revoked authority blocks the successor without Pi fallback. Same-millisecond list/claim/prior-reply ordering now uses insertion order (created_at, rowid), with deterministic inverse-ID tests and existing Pi channel/direct FIFO regression passing. |
| N8 workspace policy | v2 explicit confirmation, CAS, deny-all and profile revision binding. Browser migration save succeeds in an isolated synthetic workspace. Direct legacy-default migration and Kimi OAuth→API-key model clearing have Web regressions. |
| N9 conversation/product integration | Native canonical input, default/explicit selection, SSE, editing/replay and availability projection. Typed Pi preparation/default/replay and new-input/replacement no-orphan preflights pass. Synthetic browser checks cover migration, blocked/ready/send/reply and revoked availability. A later isolated Electron harness verifies production IPC, migration/save and blocked composer; Electron send/revocation and complete Main acceptance remain open. |
| N10 existing functionality | Latest complete Core test:ci passes 3,602/3,602. Complete daemon test:ci exits 0 with 6,508 pass, zero fail/cancel and 7 explicit skips. Earlier Pi runner 407/407, contracts/api-client 197/197, Web 572/572, Desktop fixtures 35/35 and CLI 83/83 retain their own source checkpoints. These package results do not establish full repository/platform acceptance. |

## Verification records

- `final-web-refreshed.log`: 572 passed; Web lint and EN/ZH literal-key check passed.
- `web-build-refreshed.log`: TypeScript and production Web bundle passed.
- `final-runner-pi.log`: 407 passed.
- `final-contracts-api.log`: 197 passed.
- `final-desktop.log`: 35 passed after the documented development bundled-metadata staging prerequisite. Desktop main/preload/renderer typechecks passed.
- `final-kimi-terminal.log`: 28 passed independently. Five earlier lifecycle/timeout failures did not reproduce; no timeout was increased and no assertion removed.
- `green-core-final.log`: 148 passed, one fixture column assertion failed. `final-migration.log` proves the corrected historical153→175 migration test passes.
- `green-daemon-final.log`: 218 passed, three failed at that snapshot: migration HTTP status assertion and explicit/default typed Pi replay after provider revocation. Status assertion is fixed (`final-legacy-policy.log` passed); replay passes in `final-conversation-green.log`.
- `final-conversation-recheck.log`: 69 passed, one FIFO failure exposed same-millisecond random-ID ordering; this historical failure is fixed and deterministically covered below.
- `red-fifo-timestamp-native.log` / `red-fifo-timestamp-replies.log`: fixed identical timestamps and inverse-ordered IDs reproduce native queue reversal and missing prior replies before the Core fix. The distinct-timestamp control passes.
- `fifo-core-build.log`: final Core TypeScript build passed after the FIFO fix. `daemon-preflight-build.log` is the latest daemon build for conversation preflight and Pi replay changes; the subsequent source change is confined to Core intervention ordering and its tests.
- `final-conversation-green.log`: 70/70 passed across six ordinary/native conversation, edit, accepted-input, fork and model-validation files.
- `final-fifo-native-binding-green.log`: 79/79 passed across native binding, ordinary input and guidance receipt files; includes final evidence/profile revocation, owner CAS, supervision, FIFO and concurrent admission.
- `final-fifo-core-green.log`: 95/95 passed including nested approval tests, same/distinct-timestamp prior replies and canonical intervention ingestion.
- `final-channel-fifo-green.log`: 2/2 selected production channel/direct FIFO tests passed. These four final groups total 246 passing tests, with zero failures/cancellations; no combined full-repository pass is claimed.
- `final-daemon.log`: historical broad run, 1538 passed, 17 failed and 3 cancelled. It includes red tests added while implementation progressed and outdated fixtures; it is not a clean final suite. Remaining failures are reconciled by later named records, never counted as passes merely from source inspection.
- `final-core.log`: historical broad run, 547 passed and one old migration fixture failed. Later completion changes use the fresh Core records above.
- `continuation-cli-build.log` / `continuation-cli-regression.log`: CLI build and 83/83 tests passed, including isolated macOS Expect PTY pairing, refresh, cancellation/EOF, shutdown timing, deadlines and occupied-port protection. These use fixture services, not a real model account.
- `continuation-localization-final.log`: all 55 source catalogs contain 6,781 keys; full catalog validation, compilation and 15/15 localization tests passed after the last German wording correction. The 2,968 additions across 53 catalogs were generated by the repository's translation script. `localization-completion-preservation.json` confirms all previously present message values were preserved; this does not establish native-speaker review of every language.
- `continuation-web-build.log`: Web TypeScript and production build passed after completing the catalogs. Existing chunk-size/dynamic-import warnings remain; they are not build failures.
- `continuation-public-check.log`: the first public-repository scan found 15 synthetic credential fixtures without explicit test labels and two fixed macOS Data-volume aliases. Fixtures now identify themselves as test values; the path exception is limited to the exact OS-owned `/System/Volumes/Data` prefix. No credential detection rule was loosened.
- `continuation-public-scanner-green.log`: 11/11 scanner tests passed, including standalone volume, private path and lookalike rejection cases. `continuation-public-check-green.log`: all 5,396 repository files passed the public scan.
- `continuation-public-fixture-regression.log`: 113/113 tests passed across the seven affected daemon files, including credential handling and live macOS sandbox boundaries. Only fixture values and equivalent alias construction changed in those tests.
- `continuation-core-complete.log`: complete Core `test:ci` passed, 3,594/3,594 including nested tests (3,518 top-level); zero failures, cancellations or skips. This replaces the earlier partial Core baseline for this source checkpoint.
- `continuation-docs-final-check.log`: 379 Markdown documents passed. `continuation-public-final-check.log`: 5,397 files passed after the license review document was added.
- `continuation-license-check.log`: historical failure for Claude Agent SDK (`Unknown`, custom terms) and sharp/libvips (`LGPL-3.0-or-later`). Both have since been replaced without changing the policy; `native-dependency-license-green.log` passes for 1,218 versions / 23 license families. The native Cargo graph is checked separately. See [dependency replacement record](native-execution-engines-license-review.md).

## Real Codex candidate execution

The user authorized real engine tests in an isolated temporary workspace. Codex
0.158.0 was launched through production owned execution and SQLite journaling,
using the existing loopback provider/model (`gpt-6.1-sol`) in a temporary API-key
profile. User configuration, authentication files and databases were not modified;
temporary credential directories were removed and all children were closed.
No credentials or raw account data are stored in these result files.

The initial `real-codex-candidate-results.json` is retained as a failed historical
run: CLI 0.158.0 emitted `turn/moderationMetadata`, which the old normalizer rejected.
The normalizer now accepts only the schema-shaped diagnostic notification, discards
its contents and does not count it as meaningful business activity; malformed or
unknown messages still fail. Two formal RED tests and 136/136 GREEN regression
are recorded in `continuation-codex-moderation-*` logs.

Real command approval then exposed the new CLI's reserved `local` environment.
Only a unique local environment from the verified thread response is accepted,
with exact workspace/root strings and matching thread/command cwd. Remote, changed,
ambiguous or expanded environments remain rejected before execution. File-change
approval retains existing context/path/permission restrictions; named-environment
experimental turn permissions are still rejected.

`codex-environment-approval/real-full-lifecycle-results.json` records a fresh full
run on final production source: connection connected, conversation completed with
exact sentinel, SQLite close/reopen resume completed with the same native binding,
cancellation and durable submission cancelled, then one exact temporary touch
command approved once and completed with exit 0. The approval file was checked;
all owned children closed and temporary profiles were removed. Relevant automated
regression is 217/217, including 15/15 focused environment cases.

This lifecycle record is real CLI/model candidate evidence on macOS arm64. It does
not write trusted production certification or certify a signed app. File-change
approval has its own later candidate record below; other engines/platforms/surfaces
are not covered. Uncertified production combinations
remain blocked.

A later real file-change supplement made two isolated attempts with the same
read-only/on-request boundary and an exact single-file add whitelist. Both turns
and submissions completed, but emitted zero tool events, zero fileChange approval
requests and created no target file. The second assistant reply was classified
as tool_unavailable/unable; that reply alone does not prove the CLI actually
omitted the tool. File-change approval for that model remains **unverified**. No shell
fallback, expanded roots or network permission was granted; all children closed
and both private profiles were removed. `codex-real-file-change/validation-report.json`
preserves both outcomes and the test-only terminal-field comparison correction.
The four production source hashes match the earlier successful real lifecycle;
no production code was changed to force this supplementary check to pass.

A later no-prompt diagnosis confirmed that CLI 0.158.0's bundled/effective model
catalog omits `gpt-6.1-sol` and the CLI reports metadata fallback for it. No public
no-prompt API exposes the final tool inventory, so the exact missing-tool mechanism
is not claimed. The same provider lists the catalog-known `gpt-6-sol`, whose CLI
metadata explicitly declares freeform apply_patch support.

`codex-real-file-change-gpt6-sol-candidate/validation-report.json` records a **passed
scoped real file-change candidate**: only the private model input changed; the
same harness/prompt, readOnly/network=false/on-request/user and exact one-file add
approval remained. One model turn produced native `apply_patch`, one
`item/fileChange/requestApproval`, replyStatus `written`, a completed fileChange,
the exact temporary sentinel contents and completed durable submission/terminal.
Exit was 0. No shell, expanded roots or network permission was requested/granted;
all owned children and the private root were removed. This supports the metadata
hypothesis without proving deterministic causality for the old model. Production
certification remains false; historical failures remain unchanged.

## Compatible dependency replacements

Claude's selected CLI now supplies no-prompt public `auth status --json` metadata
in an isolated environment; the result remains `configured_unverified`.
`claude-cli-replacement/green-claude-contract-dependency-closed.log` has 40/40;
common login/connection regression has 83/83. A real 2.1.156 CLI was exercised with
an explicit synthetic key, without a model request or imported account. Agent SDK
was removed from declarations and lockfile; Claude execution remains unsupported.

sharp/libvips was replaced with the product-owned Rust helper and bounded Node
bridge. Actual PNG/JPEG/WebP decode, orientation, bounded ICC-to-sRGB conversion,
metadata removal, malformed/animated input rejection, limits and safe publication
remain implemented. The final repository Rust debug and release suites each pass
17 tests. The 144 copied source/dependency/fixture/license files match the reviewed
candidate byte for byte. CMS and JPEG reconstruction differ from libvips: RGB
rounding, CMYK and 4:2:0 limits are explicitly documented in the helper validation
and [license replacement record](native-execution-engines-license-review.md).
Alpha remains exact in the independent public fixture comparisons.

`native-image-icc-public-formal-red.log` proves the old non-ICC binary fails the
new independent color expectation (CMYK delta98 versus limit21). The earlier
`native-image-icc-public-red.log` used an incorrect jpg MIME and is not a valid
ICC defect reproduction. Initial post-ICC exact-sRGB assertions also exposed
expected one-unit CMS rounding; RGB uses the independently observed tolerance,
while directions, dimensions, alpha and metadata assertions stay strict.

The actual 18-version native graph selects MIT/BSD-3-Clause, retaining real license
texts/notices. The build guard rejects unknown/changed dependencies, checksums,
licenses/notices and same-name/version source ambiguity. The ambiguity had a
formal RED then GREEN regression. It records source/binary/notices digests before
Desktop signing; it does not verify runtime/post-signing digests or automatically
reconstruct upstream vendor provenance.

Desktop fixed-path resources and startup regression passed 39/39 and 10/10;
Desktop TypeScript passed. CI rebuilds a host codec on macOS rather than executing
the downloaded Linux binary, and includes Rust contracts. Neither the new GitHub
CI nor actual signed platform packages were run here.

## Browser evidence and limits

The existing Chrome was reused at `http://127.0.0.1:5198/` with a temporary daemon
at port17893. Vite serves current Web source and built workspace dependencies.
No real model/account/native executable was invoked by the synthetic dispatcher.
Final verified interactions: Chinese retirement notice, temporary profile save,
native model selection, explicit migration acknowledgement/save, blocked composer,
ready composer, send and visible `SYNTHETIC_NATIVE_UI_REPLY`. The dispatcher saw
exactly one native binding at profile revision1, the selected model and
workspace_write. After availability was revoked and refreshed, a populated
composer showed an explicit blocked explanation and disabled Send; dispatch count
remained one. No Pi/legacy fallback was observed.

`ui-final-checks.json` records these states. Screenshots are
`ui-final-migration-saved.png`, `ui-final-blocked.png`, `ui-final-reply.png` and
`ui-final-revoked.png`. Captured console warning/error records are empty. The
1920×958 settings/composer viewport has no outer horizontal or vertical overflow;
this is scoped layout evidence, not an all-page or mobile acceptance claim.
The earlier extension overlay no longer blocked this final pass; the existing
Chrome was reused without dismissing user-owned extension UI. Temporary UI
services and precise temporary roots are handled in the closeout cleanup record.
This does not validate a real model through the browser, Electron, signed packages,
or every UI workflow. Real CLI evidence above is a separate check.

## Electron boundary attempts and partial interaction evidence

`electron-native-candidate/build-results.json` records actual exit0 for current
Desktop Main TypeScript, bundled production preload and production Web builds.
The full Main was not started: it registers a browser Native Host and has no
existing skip switch, so running it would write user-owned browser directories.
Neither HOME/CODEX_HOME nor user configuration/security settings was changed.

The installed Electron package has no installed runtime; an existing same-version
44.7.0 macOS arm64 cached runtime was used only in a temporary directory. Resolving
the npm package implicitly attempted its built-in installer; no installed runtime
resulted, but the user cache may have been refreshed and was retained. A scoped
production renderer/preload/execution-engine IPC boundary harness with a synthetic
daemon was attempted. Playwright connected to its Node inspector but timed out
before a window appeared. A single ordinary launch of the unchanged isolated
harness also provided no daemon-started, Electron-started or window evidence and
no fixture listener. These two failed attempts remain unchanged in
`electron-native-candidate/validation-report.json`; they did not establish a
product or environment defect. Their exact child processes and temporary roots
were cleaned. The later `correction.json` also withdraws an invalid comparison
between a staged-patch digest and raw index digest: the complete stage entries
and staged binary patch were separately verified unchanged.

A subsequent single-variable candidate changed only the external harness's
top-level readiness scheduling: its existing ready-body runs from a callback,
allowing ESM entry evaluation to finish. The same production source and built
outputs were retained. One launch opened a real 1440×920 Electron window and
started its isolated production daemon with a synthetic dispatcher. This supports
the harness-bootstrap hypothesis; it does not demonstrate a production Main
startup defect. Production Main already starts its asynchronous lifecycle
without awaiting that lifecycle at the ESM entry level.

The real renderer/preload/window factory and execution-engine IPC/client path
verified `execution-engines:list`, `execution-engines:profile-save`, explicit
migration acknowledgement/save, and a populated blocked composer with disabled
Send and zero dispatcher calls. After synthetic availability was enabled, the
blocked banner disappeared. Screenshots `01-initial.jpg` through
`05-blocked-filled.png`, `blocked-state.json`, `engine-ipc.jsonl` and driver records
are in `electron-ready-callback-candidate/`. This is **partial Electron interaction
evidence**, with no real model invocation. Screenshot04 shows saving in progress;
its filename is not a settled-state visual signoff. Final persistence is established
by `saved-runtime-settings.json`; the settled migration visual remains unverified.

Send/reply and revoked-state checks were not completed. A hidden-checkbox
Playwright action timed out and reset the driver kernel; the application stayed
alive without a second launch. A main-process `write EPIPE` dialog was subsequently
observed, classified as a harness/driver output-pipe lifecycle failure. The complete
trigger chain was not isolated; no execution-engine product defect is established.
Renderer console records
also contain the development CSP warning, so a zero-warning/error result is not
claimed, and page-error capture was interrupted. Native input then returned an
explicit Mac-locked/physical-input gate
requiring the user to unlock manually. No automatic unlock or permission change
was attempted; dependent interaction stopped. Cleanup and precise boundaries
are recorded in that candidate's `validation-report.json`.

Complete Main, Electron send/revocation and signed target-package acceptance
remain open. Synthetic Chrome and real CLI evidence remain separate.

## Final complete daemon run and attribution

All four shard logs contain complete TAP summaries: 6,513 tests, 6,489 pass,
15 fail, 2 cancelled and 7 skipped. They are retained as failed runs, not rewritten
as passing after subsequent checks. The original shell handles were lost after an
interruption; shell exit codes were not durably captured and are not inferred.

All 17 top-level nonpassing results are accounted for:

| Group | Original cases | Follow-up evidence and boundary |
|---|---:|---|
| Existing mainline recovery | 3 | Stale reply child, enforced Harness startup resume and expired ToolExecution tail reproduce on immutable HEAD; `main-baseline-recovery-tests.log` and `main-baseline-harness-recovery-tests.log`. |
| Existing mainline restart fixture | 2 | Current and HEAD each fail the same two cases in the complete 41-test file with `runtime_already_running`. A test-only external candidate actually shuts down the first fixture; both candidates pass41/41 with all original assertions. The later repository fixture repair is recorded below; ownership guards were not relaxed. See `final-failure-review-spec/failure-attribution.json`. |
| Existing mainline tool/store fixtures | 6 | Tool materialization2, fair scan1, thread deletion2 and provider save1 reproduce on both current and HEAD. Startup recovery invalidates pre-start seeded owners, or fixtures claim the same store through different live supervisors/cwds. Worker and lock PID agree; cross-shard contamination/PID reuse is not the cause. See `final-failure-review-standards/REPORT.md`. |
| Outdated exact RGB assertions | 2 | ACP generic/Kimi attachments differed by one RGB unit after bounded ICC conversion. Independent color references support tolerance1 with alpha exact; final focused lifecycle/image regression passes these cases. Direction, corruption and metadata checks remain. |
| Timing-sensitive native fixtures | 4 | OpenClaw attachment deadline, Kimi terminal deadline, Kimi Edit observation and connection protocol response deadline. Relevant files were rerun without increasing deadlines. See the exact follow-up counts below. |

The final nine-file follow-up has 300 tests: 295 pass, zero fail and five cancelled,
exit1. All five cancellations are in the Kimi terminal file at its original
eight-second deadlines. Once other review test workers stopped, that complete
file passed28/28, exit0, with unchanged source, fixture, assertions and deadlines.
The nine-file run itself remains nonpassing; overlapping replays are not added
into a fabricated 300/300 result. Logs: `final-native-focused-regression.log` and
`final-kimi-host-terminal-isolated.log`, each with its result JSON.

Those historical follow-ups did not establish a passing complete daemon suite or
eliminate host-load sensitivity. The subsequent repair checkpoint below resolves the 11
original mainline cases through actual lifecycle corrections and a startup
recovery fix; the historical full-shard run remains nonpassing.

## Mainline startup recovery and fixture repair checkpoint

The new custody startup order fences abandoned execution before Core stale-Run
recovery. Core previously accepted only active WorkUnits, so it failed a logical
Harness Run that the daemon could otherwise continue. Preservation now also
accepts an exact startup-loss chain: matching active Attempt/work-unit/count,
`lost`, both startup error markers, and the first terminal audit found by the
complete work-unit/Attempt/runtime/token fence. The audit must be system-owned,
match endedAt and show claimed/running to stale. A cancelling-to-stale audit,
missing audit, unrelated loss or mismatched Attempt errors do not qualify.
Neither lock order nor later policy/checkpoint/approval/CAS gates are relaxed.
The indexed exact query works after more than 1,000 earlier runtime events.

Public Store RED records reproduce both the original erroneous failure and the
naive fix's cancellation/missing-audit gap. The final four-file run is **115/115,
exit0**, including nine Core startup cases and all existing channel dispatch,
Harness continuation and 502-row ToolExecution startup tests. Core and daemon
builds also pass. The prior complete 3,594-test Core pass belongs to its earlier
checkpoint. This repair group itself was scoped; the later complete Core/daemon
rerun is recorded separately below and does not establish a whole-repository pass.

Seven daemon fixture files now respect real lifecycle/ownership: close the first
supervisor before restart, await actual daemon start before reading startup
settlement, align the old child assertion to the official stale/lost state and
strengthen its old-Run failure evidence, seed active owners after startup, and
bind fixed stores to their actual cwd/supervisor. Existing business, pagination,
idempotency, safety and deadline assertions remain. The complete 41-test restart
file and four other complete fixture files (26 tests) pass separately with actual
exit0. Together with the 115-test final recovery run these disjoint groups give
**182 pass, zero fail/cancel/skip**; this is scoped closure, not a rewritten full
suite result. Records are in `mainline-fixture-repairs/`, with immutable before
copies, patches, commands, TAP, actual exit codes and precise cleanup results.

## Complete current-source Core and daemon rerun

`full-regression-after-repair/` pins both package runs to
`mainline-fixture-repairs/final-source-manifest-v3.json`. All 692 source and 4,384
built-output entries matched before and after testing. No code, build output,
assertion, deadline or test selection changed during the run. Each package used
its own temporary LING_STACK_HOME/workspace; Core and daemon ran sequentially.

| Actual command | Terminal result |
|---|---|
| `pnpm --filter @ling-stack/core test:ci` | exit 0; 3,602 tests, 3,602 pass, zero fail/cancel/skip |
| `pnpm --filter @ling-stack/daemon test:ci` | exit 0; 6,515 tests, 6,508 pass, zero fail/cancel, 7 skipped |

Six daemon skips require actual Windows process supervision; the seventh is the
conditional A11 fixture-child entry. They match the earlier skip inventory and
are not counted as passes. The complete package command also runs the separate
dependency-security file omitted by the earlier four-shard discovery, explaining
the two-test count difference. These results close the affected packages' current
automated regression gap; they do not certify real engines, complete Main,
signed packages, other platforms, every language, or the whole repository.

An earlier Core attempt was interrupted after 64 top-level tests, with no durable
exit code. Its original log and `prior-interruption.json` remain preserved.
After verifying the old process/handle was absent, the new detached runner
recorded PID identity, regular-file logs and actual package exit codes. Its own
and both package processes are now terminal, and both runner-owned isolation
roots were removed. The 38 A12 fixture roots deliberately retained by tests are
handled through the exact-root archive/cleanup record; their logs and SQLite
evidence are preserved before removal. No broad temporary-directory cleanup
was performed.

The separate read-only `acceptance-chain-audit.json` confirms that production
reads host-owned evidence and rechecks it immediately before spawn. The store
has a trusted `verifyAndPublish` primitive, but no production verifier-tool
caller exists in packages/apps. T7 must still supply trusted check orchestration
and actual release/host results for each identity; source review, connection
success and synthetic fixtures cannot supply those results or publish a pass.


## Repository Codex candidate tool

The [isolated candidate CLI](../../scripts/native-execution-engines/README.md)
now runs fixed scenes through the real connection probe and owned execution.
It accepts no caller-supplied check results, plugins or publishing option. The
tool freezes actual source/package-dist bytes before runtime imports, pins the
direct native executable (not only an npm launcher), rechecks isolated auth/config
at execution events and decisions, and records durable journals, exact effects,
child closure and callback drain. Runtime-dist symlinks and unsolicited tool items
are rejected; unknown submissions or unconfirmed drain retain the private root.

Eleven dedicated CLI/SQLite/protocol-peer tests pass with zero failures/skips on
this host. They include missing approved effects, effects after denial, authority
drift, unsolicited file changes, linked runtime bytes and denial ending in an
interrupted native turn. The six POSIX-peer tests explicitly skip Windows and do
not certify its supervisor. The existing common CI test set also passes 145/145;
the CLI preflight tests have been added to the fast common job. These increments
do not relabel the earlier frozen complete Core/daemon runs as new full-suite runs.

The first real CLI candidate correctly observed a written denial, declined tool,
no file and a durable cancelled turn, but its validator required completed for all
approvals. That report remains a failure in `codex-candidate-tool/real-run-01/`.
A new peer regression failed before the narrow denial-terminal fix and passed
after it. Approved effects still require completed; cancellation alone never
proves successful denial.

The second real CLI run on macOS arm64, Codex 0.158.0 and gpt-6-sol passed every
fixed scene: connection, exact text, SQLite reopen with the same native binding,
turn-start cancellation, exact command approval/denial and the single native file
patch. `codex-candidate-tool/real-run-02/report.json` records unchanged source/dist,
no unresolved submission, all child processes and local lifetimes drained, and
the exact temporary root removed. The wrapper independently confirmed unchanged
user config/auth and staged patch, and found no credential value in the reports.
The direct executable digest is pinned in the report; no other engine, model,
platform or workflow surface is inferred from this result.

Its deliberate terminal result is **exit 2, incomplete**. Narrow successes live
in candidateObservations; full release checks, authentication identity,
workspace_binding, production/resource admission and cross-workspace enforcement
remain not_run. Source/dist stability does not independently establish their build
correspondence; installed dependency bytes are not attested beyond the lockfile.
No signed target package was exercised, no trusted evidence was published, and
productionCertification/published remain false. The complete verifier and its
post-publication production request validation remain open in T7.

## Isolated embedded production HTTP rejection candidate

The later `production-rejection-candidate/` increment exercises the real HTTP,
RunStore, supervisor, target, installation probe and acceptance reader with no
injected target, probe or accepted evidence. Existing embedding dependencies use
`createCompositeSecretResolver({env:{}})` and disable the browser broker, avoiding
system keychain/browser access. Startup correctly records the secret resolver as
degraded. This is not full default startup acceptance.

An independent run with the actual Codex 0.158.0 binary observed blocked
availability with `native_execution_verification_missing`. Public conversation
SSE exposes the exact rejection message, not the internal code; the client closes
after the complete error event and observes its close events. Canonical accepted
and prepared input are linked correctly, the Thread is failed and Turn remains
open, with zero Run/WorkUnit/Attempt/native submissions through public RunStore
APIs. No successful production conversation is inferred. Daemon stop, listener
closure, isolated environment restoration and exact-root cleanup were observed;
source/dist snapshots were unchanged. This run used version probes and no real
authentication or model call; instantaneous process observation was not performed.

The current production target fixes modelProvider to openai; the previous
cliproxyapi owned-execution scenes do not prove production configuration
equivalence. The new receipt stays in candidateObservations.productionRejection;
productionAdmission/resourceAdmission and full release/host checks are not
upgraded. The earlier real-run-02 remains bound to its own prior tool snapshot,
not relabelled as a new complete CLI run after this integration.

The later dedicated test command passes 12/12 with zero failures, cancellations
or skips. Its controlled executable accepts only --version and records any other
invocation as a failure. The independent Spec reviewer reports no new blocking
finding in this increment; that read-only review is not a runtime test result.

## Independent source review

The existing Standards and Spec reviewers checked the final conversation preflight,
restricted Pi duplicate replay and FIFO ordering increments. Both report zero new
blocking findings; no source-review result is counted as a runtime test pass.
Both also reviewed the later public-scan exception and synthetic fixture changes;
neither found a new issue. This review was read-only and did not run tests.

## Current-host OpenClaw and Kimi acceptance (2026-10-19)

The user authorized the existing local OpenClaw Gateway and installation of the
official native Kimi Code CLI. All Ling profiles and databases in these checks
are isolated; the default Ling database and user Gateway/account configuration
were not changed. Gateway model calls create dedicated native test sessions.
No runner acceptance was published and production admission remains blocked.

OpenClaw 2026.9.5 connected to the existing local Gateway. `openclaw-run-03`
passed exact text and SQLite-reopen recovery with the same binding, native
session and dedicated session key. The official CLI had been spawning a detached
child outside the owned process group; the host environment now fixes
`OPENCLAW_NO_RESPAWN=1`. The real recovery observation then contained only the
owned root, and close completed in about 24 ms. The focused owned-process and
OpenClaw probe/execution regression passed 52/52.

OpenClaw acceptance is still **incomplete**. In `openclaw-run-02`, the authorized
exact temporary touch command completed without a Ling permission request;
the harness did not retain whether the model actually supplied `ask=always`,
so this does not prove that an explicit `always` argument was ignored. The
Gateway-to-ACP approval boundary remains unverified and no further tool tests
were performed. The run03 cancellation triggered too late to establish a
cancelled terminal, leaving a completed journal and an incomplete event stream.
The later `openclaw-run-04` timed out during its first text request, before the
new cancellation window ran. It correctly retained one unknown submission and
its isolated root; all enrolled local children/lifetimes closed. The failed
receipts are retained, and remote stop is not certified.

Official Kimi Code CLI 2.2.0 was installed from a pinned native release asset
with archive and binary SHA-256 verification, outside the repository dependency
graph. Its temporary Ling profile reused the existing authorized local
OpenAI Responses proxy and test model; no new model subscription or native
account login was required. This is not a Kimi redistribution-license review.

Kimi 2.2 required two fixed projected-home catalogs and a filesystem watcher
adaptation. The sandbox now allows only `workspaces.json`, its precisely bounded
atomic temporary names, and the literal legacy `session_index.jsonl`. Config,
credentials, arbitrary home writes, conflicting grants and symlink escapes stay
denied. Owned execution sets the official `KIMI_CODE_WATCH=false`; no filesystem
event Mach service or extra network permission was granted. Same-run native hot
reload is disabled. Explicit load by session ID survives a new projection;
cross-workspace native history discovery is not established.

Final Kimi boundary tests passed 17/17 and the focused owned execution checks
passed 2/2. A broader intermediate group had 146 passes and four timeout
cancellations; those exact four cases subsequently passed 4/4 without changing
their deadlines. These records are not a new complete daemon suite. The final
zero-model test used the production sandbox without injected rules and passed
new session and fresh-projection load with zero prompts/model requests.

`kimi-run-04/report.json` records a **passed current-host candidate**: exact real
model text, SQLite-reopen recovery with the same binding/session and an
unrepeated history token, and durable native cancellation all passed. Every
event is bound to the same submission, native sequence is continuous, terminal
and streamed/database event IDs agree, no tools ran, unresolved submissions are
zero, and the temporary root was removed after local lifetime drain. Source,
dist and source account configuration were unchanged during the run. The earlier
run03 remains historical: its old harness incorrectly expected an engine field
inside `nativeOutput`; the corrected oracle obtains it from the associated
binding and strengthens whole-journal validation.

These results cover production owned adapters and SQLite in an external
candidate harness. They do not certify Electron/default startup, public Run and
Attempt completion, native tool safety, signed packages, production evidence
publication, other platforms, or independent model identity. Evidence is under
`execution-engine-implementation/openclaw-kimi-host-acceptance/`; every real run
has immutable before/after source-build snapshots. Later reporting-only changes
are recorded separately.

## Ling-owned OpenClaw completion/cancellation repair (2026-10-19)

The user scoped this repair to Ling defects. OpenClaw Gateway approval and
remote-stop limitations remain external acceptance boundaries; no Gateway,
account, policy or real-model configuration was changed or exercised again.

The owned adapter previously checked user cancellation before each event even
when SQLite had already committed the completed output batch. Cancellation from
an observer could therefore interrupt delivery and reject a completed result.
A second race let a cancellation grace timer expire during child reaping and
replace the completed result with a cancellation error. Both were reproduced
through the production owned adapter, ACP child-process fixture and SQLite,
without a real model or timing sleeps.

Only host-generated completed output for the same submission, confirmed completed
in SQLite, may finish delivery after user cancellation. The adapter clears the
obsolete cancellation timer and does not start another after completion. Inner
execution cancellation, profile/secret/executable identity, Attempt fencing and
the existing host-authority callback remain enforced for every event. Host
authority exceptions, including AbortError, and observer exceptions remain
errors. After acceptance, cancellation grace expiry before a verified terminal
commit and unconfirmed remote stop still retain unknown status without prompt
replay.

The initial three event-delivery cases and three short-grace reaping cases each
failed before their corresponding repair. A separate negative test exposed
missing per-event host-authority checks; that check is now present. Final owned
execution regression passes 40/40 with zero failures, cancellations or skips.
Positive cases verify continuous native sequence, the final completed turn_end,
matching delivered/durable event IDs, exactly one session/prompt, process close
and credential/root cleanup. Negative cases cover six authority/identity
revocations, observer errors and cancellation grace expiry before commit.
The seven adjacent ACP, owned-process, Kimi and execution-binding files pass
306/306 with zero failures, cancellations or skips. The daemon build, Markdown
link check, public-repository scan and scoped diff check also pass. These focused
groups are not a fresh complete daemon or repository-wide suite.

The first full-file run is retained: two new assertions used the wrong existing
profile error code and one existing case timed out. The assertions now use the
unchanged profile-revision contract; the timed-out case passed alone with its
original deadline, then the full 40-case group passed. Evidence is under
`execution-engine-implementation/ling-cancel-terminal-fix/`; earlier real-engine
failed receipts remain historical. This is adapter regression evidence, not a
new real OpenClaw run, public Run/Attempt cancellation certification, signed
package acceptance or production publication.

## PR review follow-up: native request options

The review of PR #564 confirmed that the native dispatcher omitted requested tool
restrictions and system instructions. Workspace approval policy alone does not
enforce an empty or restricted request tool list. The repair projects Kimi's
request ceiling into its isolated tool configuration and host policy, and binds
that ceiling to native configuration identity. Codex/OpenClaw tool subsets are
explicitly unsupported before native preparation; ordinary complete-tool
conversation requests remain supported.

Codex uses its native base/developer instruction fields. ACP rejects explicit
system instruction fields. Ordinary ACP conversation tone/language preferences
retain the original typed settings, including follow_user, and are sent in a
labelled user-level block, with the original task in its own block. Continuations
preserve typed preferences; message replacements preserve original language intent;
this does not add a system role to ACP or rewrite previously accepted snapshots.
OpenClaw Gateway capabilities and user account configuration remain outside the
repair. Existing real-engine candidate receipts belong to earlier source
snapshots and do not certify these new option-projection paths.

Focused verification for the frozen repair snapshot passed 373 cases in grouped
runs, with zero final skips: six complete suites (run execution binding, ACP
journaled lifecycle, Kimi owned execution, conversation request builder, normal
conversation input and native conversation) passed 297; the Codex live-client and
OpenClaw owned-execution suites passed 69; and the complete native Codex candidate
suite passed 7 after its durable comparator was corrected. The earlier combined
adjacent run recorded 75/76, with only that stale candidate comparator failing;
its log remains historical. TypeScript and diff checks also passed. This is not
a single full-repository test run.

The `pr-delivery/native-request-contract-fix/` evidence directory contains raw
RED/GREEN logs, a handoff report and the 18-file SHA-256 source manifest verified
before staging. Final-commit CI is tracked separately in `pr-delivery/`; earlier
CI at `6048ced4` does not validate this repair. Synthetic native peers test
projection, refusal, journal identity and host callback boundaries; they do not
replace real-engine or signed-package acceptance.

## Remaining acceptance gates

- Real engines, accounts, platform/architecture/surface combinations and signed
  macOS/Windows packages have not been certified. Production without trusted
  evidence remains blocked. Synthetic records never certify real execution.
- The 55-locale catalog completeness, compilation and automated test gate is now
  closed. New translations are machine-generated and have only representative
  semantic review; full language-quality review remains unverified.
- Current-host dependency license checks now pass after compatible replacements.
  Target-platform distribution, signing and resource acceptance remain open;
  functional or current-host license checks do not close those gates.
- Electron has scoped IPC/migration/blocked-composer interaction evidence;
  send/revocation await device availability. Complete Main startup, formal
  packaging/signing and a fresh complete repository-wide test remain unverified.

## Evidence directory

All raw logs, baseline snapshots, browser screenshots, preservation checks and
source manifests are outside the repository under this chat's
`execution-engine-implementation` artifact folder. Earlier red/green records
belong to their own snapshots. The first resource-veto red fixture had an invalid
owner and is not counted as a reproduced product defect.
`final-source-manifest.json` and `verification-ledger.json` preserve the earlier
conversation/FIFO snapshot. The later `continuation-source-manifest.json` and
`continuation-verification-ledger.json` record the catalog, scanner and fixture
increments, current patch/index identity and their verification results. Earlier
test records remain scoped to unchanged modules and are not relabelled as a later
full-suite run.
`closeout-source-manifest.json`, `closeout-daemon-attribution.json` and
`closeout-verification-ledger.json` preserve the later dependency/Codex/image
changes, full-shard attribution, final browser pass, policy checks, cleanup and
fresh remote-main query. Earlier manifests remain immutable historical evidence.
`closeout-filechange-supplement.json` records the later unverified file-change
attempts and documentation-only delta from that frozen closeout checkpoint.

`mainline-fixture-repairs/` and `codex-real-file-change-gpt6-sol-candidate/` are
later evidence checkpoints. They supersede only their named failed/gap cases;
the frozen closeout manifests and original failed runs remain unchanged.
`electron-ready-callback-candidate/` adds partial desktop interaction evidence
against the v2 source/build manifest. The later v3 checkpoint in
`mainline-fixture-repairs/` records this documentation-only supplement and fresh
policy/preservation checks; it does not relabel earlier tests as new full runs.
`full-regression-after-repair/` adds the later complete package results, actual
exit codes and exact cleanup evidence. Subsequent documentation-only changes
are captured separately; original manifests and failed/interrupted runs remain
immutable. `electron-detached-candidate-preparation/` contains an unlaunched
next desktop harness; its syntax/precondition check is not runtime acceptance.
