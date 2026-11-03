# P3-OFFLINE-002 — Host eager prefetch ignored Chinese offline wording

## Baseline and exact root cause

Real packaged GUI `E6-P01-LIVE-20261024` produced one approved bash command,
one succeeded Run and one final assistant response. Actual screenshots:
`p3-live-20261024/p01-final-command.png` and `p01-expanded-output.png`, with AX
captures. The original private historical three-file review also recovered +36/-0
and clicking cents.mjs/README.md selected their actual diffs in this package.

Public Host evidence: `p3-live-20261024/p01-host-lineage.json`, SHA256
`99d4e71959874d099b716c89b14d742445390be92c9b5207c4c3919c844a232e`.
Run `run_e3af2a94-a343-447c-bfd7-156e284613f2` has exactly one tool_start,
approval_requested, approval_approved, host_command_prepared, host_command_settled,
tool_end and result. Two internal model turns are not two user-level replies.

Offline-prefetch assertion FAILED. WorkUnit
`work_unit_9acd5e30-50d9-4d54-8d88-c23c7a08cc77` has web planning + four
blocked search attempts and web_evidence_recorded at 02:26:55.533–.539Z, before
Run.startedAt 02:26:55.540Z. No sources/read URLs. This does not prove network
transport; it proves unwanted Host web preparation, not a model web-tool call.

`features/teammates/direct-replies.ts` calls `buildWebEvidenceContext` on the
current source body before constructing the execution prompt/projection. Shared
`shouldRunWebSearchForText` recognized “当前” + “网页” as freshness/search intent,
but `hasExplicitOfflineInstruction` missed both “明确离线” and “不搜索网页”.
Channel prefetch uses the same helper. The fix is at that shared boundary, not
per-message UI suppression and not a new authorization policy.

## Regression and candidate repair

Value: protects=Chinese offline requests cause no eager progress/secrets/DNS/fetch;
fails_when=offline/negated-search clauses fail shared early return;
why_new=existing offline table lacks the exact live wording and independent Chinese clauses;
seam=none;
no_claim=unit spies do not prove packaged GUI or model transport behavior.

New native test `packages/daemon/test/web-evidence-service.regression-1.test.mjs`
first reproduced the exact source text: actual exit1, 1 failed / 1 passed.
The repair recognizes explicit offline execution language and negated
“搜索网页/网络/互联网”. It does not treat offline software subject matter or
“do not modify files” as a blanket offline instruction.

`corepack pnpm --filter @ling-stack/daemon exec tsc -p tsconfig.json` and isolated
`node --test packages/daemon/test/web-evidence-service.regression-1.test.mjs
packages/daemon/test/channel-web-tools.test.mjs` returned actual exit0,
21/21 pass, no skip. Fresh temporary LING_STACK_HOME and both workspace env names
were set before Node. No real DB mutation was used to reproduce or fix this bug.

Final independent review: `/root/p3_offline_delta_review` reproduced and closed
two candidate overmatching cases before approving the selected source delta.
Explicit execution clauses are anchored at sentence/clause boundaries; queries
about offline-mode documentation, offline-analysis tools and how to stay offline
remain eligible for web preparation. Final selected scope has zero remaining
confirmed findings. Daemon compilation and final isolated adjacent suite are
actual exit0, 21/21, no skip.

Final SHA256:

- `web-evidence-service.ts`: `1b1bcf3edd1a9a5af522a6dcbe5b365c5b1b37d3ec2cc937f2d9951d769c2b62`
- regression test: `a8832cb487efa8e6dacd4806177160d2e5f838bb9f9e982c44a3471fef61b1f0`

Status: source/unit candidate repaired and independently reviewed. Running package
still has the original bytes. Packaged offline revalidation remains required;
P01 is not wholly passed. Continue independent channel tests on the existing package
before the next combined reviewed rebuild. No release or main merge claimed.
