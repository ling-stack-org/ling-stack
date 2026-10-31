# P3 private Host delta independent review

2026-10-23. Isolated QA only; not release approval or packaged GUI acceptance.

Reviewer: real independent agent `/root/p3_private_diff_delta_review`, did not implement or edit these changes.
The primary agent records the returned review here; this is not a fabricated human approval.

## Reviewed inputs

| Input | SHA256 |
| --- | --- |
| packages/daemon/src/features/runs/workspace-change-review.ts | 6af5e18340c06ad8aa24b5874c0137367f1d5589a4cf106621dd497aaf387d36 |
| packages/daemon/test/workspace-change-review.test.mjs | b0a7992bc4eb54be7a1e776c724053f0f51587e43083709324ea1dde15c88efc |
| packages/daemon/src/features/web/web-evidence-service.ts | 2f4cad73c144d2d37b545b1d0a636aba514a032b511d16f3774b71865d031244 |
| packages/daemon/test/channel-web-tools.test.mjs | 20567bd723d67977927ef9cbebcc2c3676b63084c2ced9df0fca7adea228c766 |

## Scope and result

Reviewed the complete two production-file deltas against HEAD, related tests, Host snapshot creation,
public RunRequest parser, historical review callers, original path/hash/scope gates, and web prefetch callers.
Remaining confirmed findings in this selected scope: **0**.

Private review root: immutable Host request snapshot must be managed/ready, teammate must match,
and execution/worktree paths must match Run cwd. Public parser discards spoofed snapshot fields.
Only ancestor handling is exempted; relative internal metadata, traversal, siblings, device paths,
Windows trailing dots/spaces/ADS remain rejected. Raw sealed path identity and hashes remain mandatory.
Independent test: 17/17, actual exit0, 5999ms. Extra in-memory path/parser probe: 19/19.

Web prefetch: first independent review found direct negated URL opening and “不要访问网络” were
still eager-prefetched. Completely in-memory fetch stub reproduced fetchCalls=1, without network.
The implementation and regression cases were then extended; final independent narrow review closed it.
Final test: 19/19, actual exit0, zero skips. Replayed original three omissions and two extra negatives:
secrets/DNS/fetch/progress all zero. Adjacent affirmative URL reading still called stub fetch once.

Primary integration evidence: private review/native-write 22/22; recovery/direct context/projection
31/31; final web tests 19/19. Source compiled and diff-check passed. Full Daemon regression is tracked
separately and must not be inferred from this review.

## Limits

Not a full-tree re-review, native Windows run, new-package test, human authentication or release.
Offline matching is a finite conservative eager-prefetch hint, not natural-language permission
classification or a guarantee that the model will never request a network tool.
Unchanged inputs retain only their existing review coverage; no new coverage is invented.
