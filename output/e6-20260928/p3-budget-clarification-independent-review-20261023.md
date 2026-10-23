# P3 budget and clarification independent delta review

2026-10-23. Isolated QA only. Not human authentication, an approved Office record,
packaged GUI acceptance, merge or release approval.

Real independent reviewers: `/root/p3_private_diff_delta_review` (budget/import)
and `/root/p2_cold_preflight_review` (clarification). Neither implemented these
changes. The main agent transcribes their returned evidence, not invented coverage.

## Findings and closure

Import now validates the final enriched/inherited token pair for the complete
deduplicated batch before writes or background checks. Original finding closed.

The budget reviewer independently reproduced unsafe legacy capacity and zero-budget
intent/route adapter calls. A context-length error also entered summary maintenance
with an invalid small budget. Core safe-integer parsing, complete tuple admission,
per-invocation rendered admission (initial/retry/graph repair), typed Host rejection
and small-budget maintenance guards close these findings. Final remaining findings:0.

Independent isolated probes:4 actual selector/route call paths,6 small/invalid
summary budgets, unsafe legacy capacity and typed error. No actual model/network
requests, real database access, shared build or source edits. The reviewer checked
the7-case valid causal RED→GREEN and28/28 focused logs without rerunning the batch.
Primary neighboring verification:68/68 selected channel integration tests and73/73
HTTP/provider/runtime/summary tests, actual exit0, zero failures/cancel/skips.

Clarification review separately checked the parser, normalized duplicate rejection
before question writes, ordinary-content target boundary, full operation graph,
source/owner/dependency/tool bindings. It independently ran45/45 in fresh isolated
state, actual exit0, zero skips. Removing localized literal matching did not remove
execution authority checks. Final remaining findings:0.

## Final budget input hashes

| Input | SHA256 |
| --- | --- |
| packages/core/src/provider-model-capabilities.ts | fcd55d1606bb040c474c2538efc6949176ee4bcefc2fe03e89887818695eaed8 |
| packages/daemon/src/features/channels/channel-reply-budget-admission.ts | 1feaeb5b949aecbde7eb9739738cfa769185ab145c608166d5a9181d15dbce74 |
| packages/daemon/src/features/channels/channel-intent-selector.ts | acc01db119e0d7e73570960399e53cd3906fefb3a3de02697c153d27a746644d |
| packages/daemon/src/features/channels/channel-message-router.ts | 3315d65d88255b804b48763898bb26fad723bfca99ce4437500d3c63fbcab978 |
| packages/daemon/src/features/channels/context-compaction.ts | 49ad81deee92e240adf1ed0e714cb3247c26c054297f2bb4f6cc2ba3c35422a7 |
| packages/core/test/provider-model-capabilities.test.mjs | bee9c1accd5ac9484fce16a9581e2b95dde1869f222f03783f3b50c76030b594 |
| packages/daemon/test/channel-output-reservation.test.mjs | 9e371ecf1e8024266ff5155d8de650d070512d1736c05d25360c86f445915f9a |
| packages/daemon/test/channel-selector-budget.test.mjs | 5f275f0b08800b322f956b117f44f79309dd5c0ce6600fd1ab71b5493239e6f8 |
| packages/daemon/test/channel-reply-budget-admission.test.mjs | 53a8147432db74a58737b34ae332b561ac483f965305d54702470e576f63f963 |
| output/e6-20260928/p3-budget-review-green-20261023.log | 5f1f2fd01a34530ccd2d994a40717226663f67e3fc1b90add496f421a8374577 |
| output/e6-20260928/p3-selector-budget-causal-red-20261023.log | d74e444ba1c5e4a65f6730c86059e150e2215da1386ebf6576153e943093de78 |

Clarification pre-gate parser review source hash was
`c88ea672975fc9501335590c97394fa64d5e7f9ed1b802b9066cd5a812740b4d`;
the later invocation gate changes its file digest as listed above, not parser logic.
The parser review's original nine-case regression hash was
`ac5dfb564275bb0b61d55afb93d1d519eda8f8dac0cc145f9303df50730c348d`.
After adding the real isolated HTTP entry regression, the ten-case file hash is
`3d77b0cde551309e7f3aa2f58cf79efd5427e553c949184c3ea9c5ddc8cbc27a`.
Primary execution:10/10, actual exit0, no skips; log
`p3-clarification-http-canonical-20261023.log`, SHA256
`efdf2f75d98a73a7c6de8787bda5195208f227bce5e9e9a3c59d1efcee40953c`.
The independent closure reviewer read the new HTTP test and its log, but did not
rerun it. It exercises local HTTP → channel turn → committed canonical
`assistantItems`, and asserts no Run/Task/workflow/proposal. SDK/Provider is a
stub; this is not a real-model or packaged GUI result.

This scope does not replace the pending new-package private/channel/recovery/Office
matrix or H09's independently unproved transport output cap.
