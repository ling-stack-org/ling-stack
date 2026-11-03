# CI Test Execution

The existing quality check remains the required merge gate. Ready PRs run the
selected package graph. Draft previews retain the common fast lane; promotion,
`full-ci`, manual and scheduled runs retain their complete execution policy.

## Scope And Required Checks

Classification uses the entire PR diff from its merge-base, never just the last
commit. Rename detection is disabled so both old and new paths contribute.
Mixed changes union their affected packages and required lanes.

| Changed inputs | Selected product checks |
| --- | --- |
| Docs, nested READMEs, PR/Issue templates, CODEOWNERS, FUNDING | None; common checks and the required quality gate still run |
| Allowlisted Markdown-link and public-repository checks | Common fast checks only |
| Package tests and test support | Owning package; shared test-support importers are included |
| Package source or local build/typecheck configuration | Owning package and transitive consumers |
| Existing package manifest, with verified stable identity and unchanged complete script contents | Owner and consumers from the old/current graph, plus dependency policy |
| Dependency-security regression tests | Owning package plus dependency policy |
| Root manifest or TypeScript/build configuration, lockfile, workspace configuration, patches, CI workflows/scripts, unknown paths | Full regression |
| New, deleted, renamed, or unverifiable package identity, or changed scripts | Full regression |
| `full-ci`, manual dispatch, daily schedule | Full regression |

Package manifests are compared with the base checkout before narrowing. The
directory, name, test/typecheck entry presence and complete scripts fingerprint
must match. Missing baseline identity or any added, removed or changed script
forces full regression. Package-local tsconfig/build configuration selects the
owner and consumers; equivalent root configuration remains full scope. Changed
manifests propagate consumers over the union of old and current dependency edges.
Web's catalog importer is an explicit consumer because it reads Web source,
AST helpers and tsconfig without declaring a workspace dependency. The real
manifest graph also includes CLI's dependency on Web. Selecting those consumers
does not select core/daemon test shards just because a build needs their outputs.

Dependency policy runs for dependency inputs and its own regression tests, not
for every source/test edit. Typecheck and Linux unit jobs run only for nonempty
selections. Core test-only changes have four core entries and no empty packages job;
daemon-only test changes have no Linux unit entry. Daemon shards and Linux/macOS
native contracts remain coupled to daemon selection. A source change can select
additional consumers, so daemon source may still need the CLI unit entry.

The aggregate validates explicit dependency/typecheck/unit/daemon selectors.
Selected checks must succeed; only genuinely unselected checks may be skipped.
Failure, cancellation, missing or malformed results never pass as a skip. Docs
must select no product lanes, and full scope must select all lanes. No workflow
path filter suppresses the required aggregate or complete-tier history scan.

Other workflows retain their existing boundaries: installer/model-cache
contracts use path filters covering their actual imports, installer assets and
dependency inputs; translation automation uses catalog paths; desktop
prereleases require manual dispatch or an explicit label; catalog syncs are
scheduled/manual; `full-ci` label handling only dispatches a complete run. This
audit does not turn a repository merge into a desktop release or deployment.
All workflow Node setup steps use the product's validated runtime floor.

The daily schedule is a full Linux/macOS regression at 03:17 UTC (11:17
Asia/Shanghai), even without new commits. Daily success-evidence deduplication
and a weekly-only macOS tier are not implemented; timing caches do not skip tests.

Selected non-build package tasks fail before execution if any requested package
or required script is missing or blank. Only build closures permit packages
without a build artifact to omit a build script; validation never silently skips
a requested package via `--if-present`.

## Test Lanes

- Core: four Linux shards, two serial file workers per shard. These jobs are
  included in the existing `unit-tests` matrix only when core is selected.
- Other packages and Web checks: one Linux matrix entry only when at least one
  such package is selected, excluding core and daemon because their complete
  discovery runs in their own entries.
- Daemon: four `macos-26` shards, two serial file workers per shard. The Kimi Host
  read/terminal and delegation production-tool-surface files run serially in an
  exclusive phase before other files on their assigned runner.
- Linux restricted-command contracts and real macOS native smoke remain separate
  mandatory lanes. No daemon files have been moved to Linux or removed.

Core and daemon discovery includes top-level `test/*.test.mjs` and
`test/*.test.ts`; daemon's dependency-security test stays in its separate policy
lane. Each shard verifies fresh discovery against the shared plan.
Every file gets a private runtime home/workspace and a POSIX process group,
and each file process runs with `--test-concurrency=1`.
An assertion failure does not suppress later files. A file exceeding five
minutes fails and its group is terminated; it is not retried or forced green.
The known high-cost daemon integration fixture,
`test/recovery-discovery-fair-scan.test.mjs`, has an explicit ten-minute
watchdog because hosted macOS runs crossed five minutes while continuing to
make progress. This exception is file-scoped; every other daemon file keeps
the five-minute bound. Channel discussion, intent, workflow and workspace
tests are separate files in the ordinary parallel queue, each with the default
five-minute watchdog; their shared support fixture is not a test entrypoint.
SIGTERM gets up to five seconds before SIGKILL. Cancellation stops new work.
The core queue has a 20-minute deadline and daemon has a 30-minute deadline,
leaving setup and artifact upload time within their unchanged job caps.
Existing per-test assertion and timeout contracts still apply.

Detached/reparented leak cleanup uses per-file ownership tags and sampled process
ancestry in addition to process groups. This is CI leak cleanup, not a security
sandbox: processes that deliberately clear their ownership tags and escape
ancestry sampling are outside its guarantees.

## Plans And Evidence

Scope restores timing hints once and uploads `ci-test-plan`. Every shard uses
that same plan and verifies it against fresh discovery. Unknown/new files fall
back to source-size/category weights; invalid caches never reduce coverage.
Measured timings influence both outer shards and inner worker placement, not
test deadlines or platform selection.
Outer placement counts exclusive files against all workers they occupy, so a
serial integration file is not costed as if it could overlap an ordinary file.
Within a shard, ordinary files form one longest-estimated-first queue. An idle
worker takes the next file instead of waiting for a fixed worker bucket to drain.
The exclusive phase still finishes before that shared queue starts; no file can
move between the immutable outer shards during execution.

`ci-test-report-core-*` and `ci-test-report-daemon-*` contain JSON results and
per-file stdout/stderr logs. The JSON is updated before each file starts and
after it finishes, so interrupted runs retain the last active file. Timeouts,
cancellations, launch errors and log/cleanup failures fail the job. The aggregate
requires every planned file to have passed exactly once before saving new timing
hints. Only test-complete default-branch runs publish timing caches. Report
validation and cache publication still run after an unrelated policy lane fails;
that failure continues to fail the required quality gate. Missing, duplicate,
failed or cancelled test reports never produce a new baseline, and PRs cannot
publish timing hints.

Recovery-discovery fixtures retain the real 500-row paging boundary and SQLite
persistence. Stale blockers retain their shared Thread and Turn. Fixture seeding
defers only derived thread-metadata rebuilding, then flushes once per affected
Thread in `finally`; source writes and their transactions remain real. Scheduled
blockers keep distinct Threads and their own prepared Pi inputs, with one final
projection per Thread. Regressions check bounded rebuild work, ownership, frozen
input, store reopen, projection equivalence and restoration after source-write or
input-preparation failures. The existing fair-scan cases still exercise real
continuation execution; production storage and input preparation are unchanged.

The four split Channel suites and approval-policy integration tests opt in to
`test/test-support/sqlite-workspace-fixture.ts` for ordinary workspace directories.
Each test process creates one empty database through the current real Store and
migrations, closes its only connection, then copies that database into independent
temporary directories. Copies are exclusive files, never hard links or shared
Store objects. Normal constructors still check migrations, configure SQLite and
establish daemon-owned runtime capabilities. The template is deleted at file
teardown, is never committed or reused across processes, and contains no test Runs.
Only the main database is copied, not migration recovery manifests or backups;
migration/recovery tests must continue to use cold fixtures. External asset paths,
pure Git probes and custom storage-location fixtures keep their original setup.
The regression checks the complete schema and default rows against a cold Store
(normalizing initialization timestamps and generated default memory-scope IDs),
independent writes and scope changes, destination paths, reopen persistence,
foreign-key enforcement and rejection of daemon-only authority on ordinary fixture
Stores. It also checks distinct inodes; a hard-link mutation probe must fail.

On 2026-11-03, a local macOS comparison used Node.js v22.22.1 and the same isolated
file runner with `concurrency: 1`. Only the empty-database fixture change differed;
other runner changes stayed constant. This comparison preceded the Channel suite
split merged in #645; its single `channel-workspace.test.mjs` row covers the old
combined file, not the current smaller workspace suite. One before/after pair
measured:

| Integration file | Tests | Before (s) | After (s) | Reduction |
| --- | ---: | ---: | ---: | ---: |
| `channel-workspace.test.mjs` | 226 | 198.3 | 144.2 | 27.3% |
| `approval-policy-run.test.mjs` | 103 | 132.2 | 67.8 | 48.7% |
| Combined, serial | 329 | 330.5 | 212.0 | 35.8% |

Both unchanged integration test lists passed with no skips. The optimized run
also passed the two new fixture regressions in 3.5 seconds, for 331 passing tests.
These are local file timings from a single pair, not a hosted-CI latency claim or
a statistical benchmark; full CI setup, shard contention and total job time still
need hosted-runner measurement. This documentation sync does not establish that
the current changes have passed complete hosted CI.

## Timing Telemetry

The independent `timing-telemetry` job runs after `quality` and preserves a
best-effort `ci-telemetry` artifact for complete and preview runs. The mandatory
quality gate never depends on telemetry, so collection, download, parsing,
upload, or telemetry job failures cannot change that gate. Available shard
reports are downloaded even when the quality gate fails. The artifact retains
run/job/step observations, per-file results, cumulative shard file time,
imbalance by suite, and timeout/leaked-process counts from available reports.
The summary is appended to the GitHub step summary and the JSON is retained
for 14 days. Actions API jobs are restricted to the current run attempt.

Job start delay includes dependency waits; it is not a pure runner queue
measurement. Cumulative file time is not shard wall-clock time because files
run concurrently. Elapsed time through completed jobs is not a dependency-DAG
critical path and excludes in-progress jobs. Run duration is observed at
collection while the workflow is still in progress. Missing reports do not
establish zero failures across the full run.

Use at least 5-10 complete hosted runs to compare the observations before
changing shard counts, worker concurrency, or adding another E2E lane. The
telemetry does not establish a fixed speedup percentage by itself.

Telemetry and workflow regression tests are TypeScript files in the existing
`scripts/ci/*.test.ts` lane and are checked by `pnpm typecheck:ci-tests`.
The Node command diagnostic helper and its two owning daemon tests are also
TypeScript; daemon discovery includes both test files, while
`packages/daemon/tsconfig.test.json` checks the tests and helper through the
required `typecheck:ci` script. Runtime type stripping alone is not validation.
The diagnostic observes real child-process lifecycle events without changing
command timeouts, invocation assertions, output capture, or native skip rules.

Generate a local plan without running tests:

```sh
node scripts/ci/test-shard-plan.mjs \
  --packages='["@ling-stack/core","@ling-stack/daemon"]' \
  --output=.codex-artifacts/ci/test-plan.json
```

On the suite's required platform, run a shard with that immutable plan:

```sh
node scripts/ci/daemon-test-shard.mjs --shard=0 --shard-count=4 --concurrency=2 \
  --plan=.codex-artifacts/ci/test-plan.json \
  --report=.codex-artifacts/ci/reports/daemon-0.json
```

## Secret Scans

Complete-tier PRs scan every commit after the unique merge-base, including merged
branches and merge-resolution patches. Docs-only scope and the final file diff
never disable these history scans: an introduced-then-deleted secret is still
scanned. Draft preview runs continue to defer the scan; a Draft promoted to
complete by `full-ci` runs it.

Missing/ambiguous history or changes to scanner configuration/ignore policy
select full history. Scheduled/manual runs scan full reachable history. Checkout
must retain complete history; the scanner cannot reconstruct a shallow clone.

Gitleaks fingerprints bind a commit, path, rule and line. A merge that imports
reviewed evidence can produce distinct fingerprints for identical SHA-256
records. Verify each digest against the source bytes before adding exact
fingerprints to `.gitleaksignore`; do not exclude whole evidence paths, broaden
hash-pattern allowlists or omit merge patches.

## Validation

```sh
corepack pnpm typecheck:ci-tests
node --test --test-concurrency=1 scripts/ci/*.test.mjs scripts/ci/*.test.ts
corepack pnpm --filter @ling-stack/daemon typecheck:ci
```

CI-tool tests include both `.test.mjs` and `.test.ts` and run directly on the
pinned Node.js runtime in the common lane. The root `typecheck` command and the
selected CI typecheck lane run `typecheck:ci-tests`, whose strict, no-emit
`scripts/ci/tsconfig.test.json` includes `*.test.ts`; runtime type stripping alone
is not a typecheck. Docs scope and Draft preview do not run that typecheck lane.
Daemon package commands and both shard discovery paths also include `.test.ts`;
the owning `typecheck:ci` validates its new tests and imported TypeScript helpers.

Local fixture and package checks are not evidence of Linux/macOS hosted-runner
latency. Compare queue, setup, test-file and total durations after the next
authorized complete CI run before claiming a wall-clock improvement.
