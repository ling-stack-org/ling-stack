# Public execution snapshot privacy repair

Status: implementation and focused regression complete; independent review and
real Pi/workflow combined acceptance remain owned by the main task. This is not
an approval, release record, or claim that E6 is complete.

## Confirmed cause and boundary

Workflow role memory must not enter the accepted `task.prompt`. Moving its body
to the initial system prompt alone is insufficient: frozen
`requestSnapshot.runnerExecutionInput` contains the full prepared prompt, and a
real answer continuation also copies `systemPrompt` and `appendSystemPrompt`
into its request's top level.

The repair projects only known transport DTOs. `projectPublicRunSession` removes
`runnerExecutionInput`, `preselectedMemoryUse`, `systemPrompt`, and
`appendSystemPrompt` from `Run.requestSnapshot` without modifying the stored Run.
`projectPublicWorkUnit` applies the same projection to `request` only for
`task_run`, `conversation_run`, `channel_ai_reply`, and `teammate_direct_reply`.
Other WorkUnit kinds and nested user/tool data retain identically named fields.
Accepted task fields, execution metadata, policy, context projection, and runner
resolution remain available. Internal recovery inputs are unchanged.

Public boundaries covered:

- Run list/detail/cancel, including terminal conflict responses.
- WorkUnit list/detail/active/stuck/cancel/retry/reconcile responses.
- Thread evidence, resume preview, fork/fork-run/resume responses.
- Run intervention terminal/redirect/promote responses and WebSocket cancellation.
- Ordinary conversation detail and SSE `done`/`blocked` frames.
- Automation run and run-detail responses.
- Workflow evidence handlers are connected by the main task, not this implementer.

Trace and ControlPlane snapshots already use explicit execution-metadata
allowlists rather than serializing these recovery payloads. The internal
`buildWorkflowEvidence` must stay unmodified because TerminalReport also consumes it.

## Verification

Candidate compiler:

`node node_modules/typescript/bin/tsc -p output/e6-20260928/project-inputs-final-build/tsconfig.json`

Result: exit 0. Normal `packages/daemon/dist` was not compiled or changed.

New regression: `packages/daemon/test/public-execution-snapshots.test.mjs`.
Four tests passed, zero skips. It includes a real temporary SQLite
source Run → answered request → delivery claim →
`prepareUserInputContinuationRequest` path. That path retains the original
private system input internally while the complete projected successor Run and
WorkUnit JSON omit its synthetic canary. It also checks read-only HTTP views,
terminal control responses, absence of source mutation, and preservation of
unrelated same-name user/tool fields.

Negative control: `public-projection-red-loader.mjs` replaces only the two DTO
projection functions with identity functions. The same four tests fail, exit 1
(0 passed, 4 failed), including the real prepared continuation and HTTP canary.
No production or source behavior was changed for the negative control.

Affected regression matrix: **48 passed, 0 failed, 0 skipped, exit 0**:

- public-execution-snapshots.test.mjs
- normal-conversation-fork.test.mjs
- normal-conversation-context-streaming.test.mjs
- automations-api.test.mjs
- rpc-run-detach-backpressure.test.mjs
- runtime-supervisor.test.mjs

These ran with fresh `LING_STACK_HOME`, `LING_STACK_DEFAULT_WORKSPACE_CWD`, and
`LING_WORKSPACE_CWD`, test concurrency 1, and the isolated candidate loader.
Candidate Daemon and Contracts were used; this matrix used current Core dist,
not the main task's later Core memory-freshness candidate. No model call, actual
Daemon restart, packaged GUI validation, or historical database modification is
claimed by this report. `git diff --check` passed for the implementation files.

The existing candidate loader resolved before remapping, so Node rejected the
new helper because it did not exist in normal dist. The output-only
`public-projection-test-loader.mjs` maps new Daemon dist references before
resolution and delegates other resolution to the existing candidate loader.
No production loader or ordinary dist workaround was introduced.

## Frozen implementation SHA256

| File under packages/daemon | SHA256 |
| --- | --- |
| src/features/runs/public-execution-snapshots.ts | 7b6cb84889a3aced4bd8ffa545911b3a71404ea61e136cd7d717bd726278582f |
| src/features/runs/routes.ts | 7444feb7d053e47810ed93facbed4e417a6f6719a9da391d1446d4b07351b0e9 |
| src/runtime/routes.ts | e1adce54f2bd6192e9e8aba165caef57b63ccd6fb603faf841f08df76e84656c |
| src/features/runs/thread-routes.ts | d08086657d9c19ddc918c3bde7c8691bd097138e4beb1194bf36381e8c358541 |
| src/features/runs/interventions.ts | 358ba51eac0131496389487577eec640c179d7a47cf0a65df1270a4b23fe3a75 |
| src/server/rpc.ts | 7d80045de514bf729e661f7df1be7fca6507ea57a821b59f56fa51fc00cc3baf |
| src/features/conversations/routes.ts | ec25fae29928c3f6cb0f33500ffb1e0b6c3485c3e744e96d36fc263c1e126469 |
| src/features/automations/routes.ts | b2cbeca0b817dbfd9d18201151ba9411a2b5237444309e88b3e97dc869499540 |
| test/public-execution-snapshots.test.mjs | 62fdacf51172de7c3db962957cf43acbdf39eaa0abbe9565325f9387204246d5 |

There are nine authored implementation/test files and three output-only
verification artifacts (this report and two loaders). No commit or approval
record was created. The investigation lock acquisition preserved another
owner's boundary; no ownership token was acquired and none was released.
