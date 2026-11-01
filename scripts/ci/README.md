# CI Test Execution

The existing quality check remains the required merge gate. Ready PRs run the
selected package graph; Draft policy, dependency checks, Web checks and native
platform acceptance are unchanged.

## Test Lanes

- Core: four Linux shards, two serial file workers per shard. These jobs are
  included in the existing `unit-tests` matrix only when core is selected.
- Other packages and Web checks: one Linux matrix entry, excluding core and
  daemon because their complete discovery runs in their own entries.
- Daemon: four macOS shards, two serial file workers per shard. The native Kimi
  lifecycle files run exclusively before other files on their assigned runner.
- Linux restricted-command contracts and real macOS native smoke remain separate
  mandatory lanes. No daemon files have been moved to Linux or removed.

Every file gets a private runtime home/workspace and a POSIX process group.
An assertion failure does not suppress later files. A file exceeding five
minutes fails and its group is terminated; it is not retried or forced green.
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

`ci-test-report-core-*` and `ci-test-report-daemon-*` contain JSON results and
per-file stdout/stderr logs. The JSON is updated before each file starts and
after it finishes, so interrupted runs retain the last active file. Timeouts,
cancellations, launch errors and log/cleanup failures fail the job. The aggregate
requires every planned file to have passed exactly once before saving new timing
hints. Only successful default-branch runs publish timing caches.

## Timing Telemetry

The `quality` job also preserves a non-blocking `ci-telemetry` artifact for
complete and preview runs. It records workflow run and job timestamps,
estimated queue and execution time, step durations, shard/file durations,
`critical_path_duration`, `max_core_shard_duration`,
`max_daemon_shard_duration`, shard imbalance by suite, and timeout/leaked-process
counters. The summary is appended to the GitHub step summary and the raw JSON
is retained for 14 days. Collection uses the current run's Actions API data;
API or parsing failures create an unavailable observation and never change the
quality gate. Run duration is labelled as observed at collection because the
telemetry step runs inside the aggregate job.

Use at least 5-10 complete hosted runs to compare the observations before
changing shard counts, worker concurrency, or adding another E2E lane. The
telemetry does not establish a fixed speedup percentage by itself.

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

## Validation

```sh
node --test scripts/ci/*.test.mjs
```

Local fixture and package checks are not evidence of Linux/macOS hosted-runner
latency. Compare queue, setup, test-file and total durations after the next
authorized complete CI run before claiming a wall-clock improvement.
