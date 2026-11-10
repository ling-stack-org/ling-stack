# A27 full-run failure diagnosis — 2026-10-25

## Verdict

The 11 observed failures in `run-request-permission-axes.test.mjs` share one stale fixture assertion, not 11 different execution defects. All enter their actual isolated HTTP fixture and fail at `persistedRun()` line 465: the test requires the raw SQLite `request_snapshot_json` to equal the deliberately redacted public HTTP `requestSnapshot`.

This is a diagnosis of the first observed failure only. It does not establish that the remaining resume, retry, fork, or malformed-input assertions will pass after the fixture is corrected.

## Evidence and classification

Input: `output/e6-20260928/p3-memory-daemon-final-full-20261025.log`. The owned-child stdout/stderr are forwarded verbatim by `ownedCase()` lines 118–119, and their complete inner TAP errors are present in this log. The initial diagnosis was read-only; the subsequently authorized correction and fresh verification are recorded below.

Every failed child reports `A27 actual HTTP fixture entered`, exits with `code: 1, signal: null`, and has the same inner assertion message: `HTTP serialization must match a second read-only SQLite connection`. Its stack begins at `persistedRun():465`. The public Run status and the second read-only SQLite status have already passed `succeeded` checks at lines 461 and 464.

| Failed case | Inner TAP begins at log line | Private raw fields absent from HTTP | First caller after helper |
| --- | ---: | --- | --- |
| `direct-collection-workspace` | 8701 | `systemPrompt` | `directAxes():249` |
| `direct-collection-full-access` | 9029 | `systemPrompt` | `directAxes():249` |
| `direct-sse-workspace` | 9367 | `systemPrompt` | `directAxes():249` |
| `direct-sse-full-access` | 9695 | `systemPrompt` | `directAxes():249` |
| `resume-conversation-read-only` | 10033 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before resume |
| `resume-conversation-ask-workspace` | 11056 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before resume |
| `legacy-and-canonical` | 12176 | `systemPrompt` | `legacyAndCanonical():327` |
| `normal-prepared-retry-current-policy` | 12519 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before retry |
| `malformed-source-axis-rejected-before-input` | 13544 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before deliberate corruption |
| `fork-conversation-read-only` | 14569 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before fork |
| `fork-conversation-full-access-receipt-not-reused` | 15630 | `appendSystemPrompt`, `runnerExecutionInput` | `sourceRun():268`, before child confirmation fence |

Eight other owned A27 children report `code: 0`: the four teammate/channel read-only and ask-workspace resumes, channel Full Access resume, missing Full Access confirmation fence, teammate fork, and channel fork.

## Product path versus loader hypothesis

The actual route at `packages/daemon/src/features/runs/routes.ts:111` calls `projectPublicRunSession()`. `public-execution-snapshots.ts:35–42` deliberately removes `runnerExecutionInput`, `preselectedMemoryUse`, `systemPrompt`, and `appendSystemPrompt`; lines 61–70 explicitly preserve exact stored recovery input and project only at transport boundaries. The observed diffs match this contract exactly.

`ownedCase():105–110` launches a credential-clean child without forwarding `NODE_OPTIONS`, `process.execArgv`, or the candidate loader. That means the child imports ordinary package `dist`, not necessarily its parent's loader-mapped URL. This is a separate test-build provenance consideration, but it is not the observed cause of these 11 failures: none has an import/setup failure, missing-module error, resource-path error, timeout, or kill signal. Switching loaders alone cannot make a correct public projection equal its raw private snapshot.

## Minimal safe fixture correction for the integrating agent

Modify the test helper, not the public projection:

1. Keep the real HTTP 200/succeeded checks, second read-only SQLite connection, and raw SQLite status check.
2. Read the Store's raw Run independently and require its entire raw `requestSnapshot` to deep-equal the independently read SQLite JSON. This retains full persistence/recovery fidelity coverage.
3. Build an independent expected public snapshot by omitting the four private keys above from the raw snapshot, assert the HTTP snapshot equals it, and explicitly assert those keys are absent. Do not use the production projector as the sole assertion oracle.
4. Return the raw Store Run from `persistedRun()` to the permission/recovery exercises after validating both layers. Otherwise a follow-up false failure occurs at `resumeAxes():303/319`, `forkAxes():559/576`, and `forkFullAccessFence():586/595`: those checks compare `sourceBefore` with the unredacted Store snapshot and intentionally require that source authority is not rewritten. Returning raw also preserves the malformed fixture's full source before corruption at lines 435–450.
5. Preserve all permission-axis, effective-policy, original-receipt, source immutability, deny-before-dispatch, prepared retry reuse, and exactly-once assertions. Do not restore private fields to HTTP or remove the deep persistence check to obtain GREEN.

The A27 fixtures use normal/direct/channel discussion runs, not workflow-step Runs; workflow task-prompt redaction therefore does not require an extra exception in this helper.

## Scope and limitations

During the initial diagnosis only existing log and source files were read, and this report was the only output written. The main agent then explicitly authorized the one-helper fixture correction and one fresh standard-dist file run. No production source, build, candidate/dist, review record, or QA database was changed by this subtask.

## Authorized correction and fresh result

Changed only `packages/daemon/test/run-request-permission-axes.test.mjs`, `persistedRun()`:

- Raw SQLite JSON must deep-equal the Store's complete raw snapshot.
- The independent expected public snapshot removes exactly `runnerExecutionInput`, `preselectedMemoryUse`, `systemPrompt`, and `appendSystemPrompt`; HTTP must omit each own property and otherwise deep-equal the expectation.
- The helper returns the raw Store Run so the original source-immutability, recovery and deliberate malformed-input assertions still exercise exact durable state.
- No production projector is imported as the oracle. No other test assertion or production file was changed.

Fresh command, ordinary package dist with no inherited loader:

```sh
env -u NODE_OPTIONS node --test --test-reporter=spec packages/daemon/test/run-request-permission-axes.test.mjs
```

Execution session `45261` exited **0**. Fresh log: `output/e6-20260928/p3-permission-axes-standard-dist-fresh-20261025.log`. Result: **19 tests, 19 passed, 0 failed, 0 skipped**, duration **21,766.321625 ms**. All 19 owned children entered their actual HTTP fixture and exited `code: 0, signal: null`.

The original full-run RED log remains unchanged, SHA-256 `8c2a68b3473fe93789958123a592c3f53f320a1d7ff37a2f857cab2bdb408e9a`. `git diff --check` for the sole edited test file passed before this run.

Independent integrating review should check the three distinct assertions (SQLite-to-Store exactness, HTTP public equality, explicit private-field absence), the raw return needed by downstream assertions, and unchanged original permission/no-replay cases. This is a targeted A27 GREEN, not a claim that the full Daemon suite or E6 GUI acceptance is complete.
