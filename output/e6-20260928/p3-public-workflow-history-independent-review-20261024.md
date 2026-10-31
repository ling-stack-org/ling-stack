# Public workflow history: independent delta review, 2026-10-24

Final superseding status: **DONE, no unresolved finding in the scoped historical/search delta**, after the independent search recheck recorded below. The initial finding and initial hashes are retained as history, not the current verdict. This is not an E6 completion, QA-package approval, or release approval.

## Superseding search repair recheck

The root Agent repaired the search ownership classification and recompiled the candidate. This reviewer remained read-only and did not edit implementation or rebuild candidate output.

Static review of the repair confirms:

- `turn_instruction` looks up the referenced Store Turn, requires the same Thread, and uses the same `projectPublicLingTurn(turn, thread)` privacy decision as detail projection.
- `task_prompt` looks up the referenced Store Run, requires the same Thread, and uses the extracted `isWorkflowRunSession(run, store)` shared with Run DTO projection.
- Missing and cross-Thread Turn/Run references are rejected before returning their snippet. Ordinary local-user Turn and ordinary Run matches remain eligible.

The original independent mixed-ownership loopback canary was rerun against the rebuilt candidate. Its synthetic Store now supplies an ID-checked `getRun` method required by the repaired handler, rather than omitting that unused method as in the original probe. The private Thread/Run/Turn fixture and transport requests are otherwise the same. Actual result, exit 0:

```json
{"publicRunLeaks":false,"turnsLeak":false,"searchLeaks":false,"turnsStatus":200,"searchStatus":200,"matches":[]}
```

The newly added repository regression was also run in fresh isolated LING directories using the existing candidate loader:

```sh
node --experimental-loader ./output/e6-20260928/public-projection-test-loader.mjs \
  --test --test-name-pattern 'search uses referenced Run/Turn workflow ownership even under an ordinary Thread' \
  packages/daemon/test/public-workflow-history.test.mjs
```

Result: **1 passed, 0 failed, 0 cancelled, 0 skipped, exit 0**. The test drives real loopback HTTP and asserts both private matches absent and both ordinary control matches retained. The previous 11-test run below is historical adjacent coverage; this recheck did not rerun the full matrix or claim a fresh 12-test aggregate.

### Channel-workspace test assertion audit

The requested three test corrections were read with their surrounding execution assertions; no assertion-weakening defect was found:

1. Attachment streaming: the runner's `appendSystemPrompt` still must contain the friendly tone and latest-user language instructions (lines 3862-3863); only the public SSE Run snapshot now must omit `appendSystemPrompt`. Attachment prompt/content checks remain.
2. Model-assisted file follow-up: all three operation/literal/content regex assertions still run against the stored internal Run snapshot. The recorded Run snapshot is equated to that stored prompt, and a separate public GET must omit its prompt. Existing real file/evidence completion assertions remain.
3. Autoplan: the private Memory text must be absent from runner/stored task prompts and present in actual runner `appendSystemPrompt`; public Run/WorkUnit task prompts must be absent. Internal stored Run/WorkUnit negative checks and Memory-use audit checks remain. The injected `storeFactory` records the exact Store instance created for the same cwd; the test helper forwards this factory into Daemon dependencies, and the registry caches that returned instance. It does not introduce a second independent Store or replace execution with a mock.

No channel-workspace test suite was rerun for this audit. The separate context-window fixture adjustment in that file is outside these three requested assertion audits and is not covered by this verdict.

### Final reviewed hashes

Source/test SHA256, unchanged between recheck setup and completion:

```text
f4314b661c39b34facbbd2370260cade0924b2b495a5a2a9492ba77e5f9165a9  packages/daemon/src/features/runs/public-execution-snapshots.ts
a7940c96974f66922df88f66f798e34d5c12141c7614e6db035bd249d0db3d34  packages/daemon/src/features/runs/thread-routes.ts
fd474cd8803129e0a4f9cb6500523d1b9cc6fa6b3ffa5b9344c5085c292b2f40  packages/daemon/src/features/channels/channel-conversation-api.ts
24ed84346fe653fed61ff789464461ed44b72432ce744539f443112cfe3fd48e  packages/daemon/test/public-workflow-history.test.mjs
ba4fb874b988393220ef69bd42d4b30dad577bd694829a1e56135722a0ac770f  packages/daemon/test/channel-workspace.test.mjs
```

Rebuilt candidate JavaScript SHA256 consumed by this recheck:

```text
610d13388cdbdd9861a2a9e45c0791680c7e32a54cac82b233b990f5169f2d12  output/e6-20260928/project-inputs-final-build/daemon/features/runs/public-execution-snapshots.js
3466e8f6ee40514ae03c8817f4c5d77eab2e9105a8fe2d2d158b458b5379d0a2  output/e6-20260928/project-inputs-final-build/daemon/features/runs/thread-routes.js
4b3ed2fee6478e6cd13d268b61bd934f28789a4278e955ffe19bd4f36d7b07d5  output/e6-20260928/project-inputs-final-build/daemon/features/channels/channel-conversation-api.js
```

The original fixture/live/GUI coverage limits below still apply. Scoped `git diff --check` including the channel-workspace test exited 0.

## Scope and independence

- Reviewed the newly implemented historical public projections in `public-execution-snapshots.ts`, `thread-routes.ts`, and `channel-conversation-api.ts`, plus Store propagation at the existing Run/WorkUnit transport call sites.
- The historical projection implementation was written by the root Agent after it took over this subtask. This reviewer authored earlier Run/WorkUnit DTO work; that earlier component is not represented as independently authored-and-reviewed here. Its existing tests were rerun as adjacent regression coverage.
- No implementation source, candidate output, ordinary dist, real/QA database, audit record, Git index, or commit was modified by this review. Only this report was written.

## Initial finding (resolved by the superseding recheck above)

### 1. CRITICAL, confidence 10/10: workflow-marked historical input still leaks through search when its Thread is not marked workflow

Location: `packages/daemon/src/features/runs/thread-routes.ts:186`:

```ts
if (!isWorkflowExecutionThread(thread)) return true;
```

The new public Run projection recognizes both `run.workflowStepId` and owning Thread workflow metadata. The Turn projection likewise recognizes `turn.kind === "workflow_step"` or `turn.workflowStepId`, independently of the Thread kind. Search instead immediately permits all matches for a non-workflow Thread, including `task_prompt` and `turn_instruction` matches from explicitly workflow-marked Runs/Turns. The same historical body that is hidden in Run/Turn detail therefore remains visible in a search snippet.

Independent loopback HTTP probe, current candidate loader, no database:

- Thread: `{ id: "thread", kind: "task", title: "Safe task", objective: "Safe public objective" }`.
- System Turn: same Thread, `kind: "workflow_step"`, `workflowStepId: "step"`, private canary in `userInstruction`.
- Run: same Thread, `workflowStepId: "step"`, private canary in `taskSnapshot.prompt` and `requestSnapshot.task.prompt`.
- The Store's search result contains the corresponding `turn_instruction` and `task_prompt` matches. A loopback server invokes the actual `handleLingThreadItem` and `handleLingThreadsCollection` handlers.
- Result, exit 0:

```json
{"publicRunLeaks":false,"turnsLeak":false,"searchLeaks":true}
```

`GET /threads?cwd=fixture&q=private` serializes `HISTORICAL_MARKED_RUN_PRIVATE_CANARY` twice in `matches[].snippet`. This is a fixture/transport reproduction, not evidence that a real user's database contains this shape.

Recommended repair: classify `turn_instruction` and `task_prompt` matches using their referenced Store Turn/Run and the same private ownership predicates as the corresponding public detail projection, not only the Thread kind. Preserve ordinary local-user Turn text and genuinely ordinary Run prompts. Do not change stored history or internal model context.

## Confirmed behavior and verification

Command used fresh `LING_STACK_HOME`, `LING_STACK_DEFAULT_WORKSPACE_CWD`, and `LING_WORKSPACE_CWD` directories under `/tmp`, with `NODE_OPTIONS=`:

```sh
node --experimental-loader ./output/e6-20260928/public-projection-test-loader.mjs \
  --test --test-concurrency=1 \
  packages/daemon/test/public-workflow-history.test.mjs \
  packages/daemon/test/public-execution-snapshots.test.mjs
```

Result: **11 passed, 0 failed, 0 cancelled, 0 skipped, exit 0**. No candidate compilation was run by this reviewer.

Confirmed on the covered cases:

- Workflow Thread objective, system-dispatch Turn instruction, and system-dispatch `user_message` body are replaced with an explicit private-context placeholder. Editable current step text is not presented as historical input.
- Missing historical Turn provenance does not restore an item whose Host actor is `workflow-dispatch`.
- Public task prompt projection also recognizes an unmarked Run/WorkUnit whose owning Thread is workflow-marked; transport callers provide their actual Store.
- Typed channel page and turn-response DTOs invoke the public Thread/Turn/item projections without changing the internal message view used by model context.
- Local-user follow-ups remain visible in typed pages. Ordinary Thread/Turn/Run objects, nested user fields, question/answer items, tool results, and assistant messages remain unchanged in the helper regression cases.
- Workflow `resume-preview` replaces the private assembled `contextText` and projects its source Run. The internal assembled preview is not written back to history.
- Generic workflow resume throws `workflow_step_resume_required` at `buildLingThreadResumeContext` lines 1537-1539. The guard precedes normal-input preparation, continuation persistence, and the start callback; the HTTP test observes 409 and zero starts.
- Fork and fork-run project source Thread/Turn/Run and returned child DTOs; both failed-start response branches use the same projection calls. Existing tests cover successful responses; failure branches were checked statically.
- `git diff --check` for the scoped historical sources and test exited 0.

## Limits

- This is a scoped historical-projection review, not a full branch pre-landing review. No additional reviewer or external model was launched from this subreview.
- The reproduction deliberately uses synthetic Store data. It does not inspect or repair a real database and does not establish the frequency of the historical mixed Thread/Run ownership shape.
- No packaged macOS UI, live provider, SSE reconnect, daemon restart, or production workflow was exercised here.
- This reviewer did not compile or alter candidate output. The test loader consumed the existing candidate JavaScript identified below.
- No new gate relaxation was observed in the scoped added test. A full-branch gate inventory was outside this subtask.

## Reviewed source SHA256

```text
2dd83607e820f1ac539c374038ab015d457e667a9fac0c3fd46ce544c969f9de  packages/daemon/src/features/runs/public-execution-snapshots.ts
24738134fbfba9cc18c818791e196fff945e9a6ca55ca0c74e1813c5bf988052  packages/daemon/src/features/runs/thread-routes.ts
fd474cd8803129e0a4f9cb6500523d1b9cc6fa6b3ffa5b9344c5085c292b2f40  packages/daemon/src/features/channels/channel-conversation-api.ts
38c241ca54434d96281a1b5f7b2b140046a01cfe2f7fa5615f2691d9cfcb31ff  packages/daemon/src/features/runs/routes.ts
22bffec1e1a75c2b9ecc44a6170744e6725e4a7891a7ffc53d2feaf9d066f703  packages/daemon/src/features/runs/interventions.ts
df6d0553fda2d46b0b32b7a81bb004323284e3650b85444ad53acc5a4e924cb7  packages/daemon/src/features/conversations/routes.ts
62f1f835f60e5e36cdcf06239c8d5ffea742e7874f10d27eb7ec6213da8f361b  packages/daemon/src/features/automations/routes.ts
4fb1ba3b596155b8293d375f56c844293fe6e1b9481d8ab9da37d202c0ac340a  packages/daemon/src/features/teammates/direct-controls.ts
601734db7d14264dce7f0ed9a6d834e22ff42918ebc3fa97cd8ca99ecca02c7b  packages/daemon/src/runtime/routes.ts
01af43f6466e4c68b994fecfb82b0ccaeba34336ec57f5529c08826f7d971b2b  packages/daemon/src/server/rpc.ts
57dfbec8e072c739da0f7421056340a91a72a09f553a88ca1434b8a2d1902f7f  packages/daemon/src/features/channels/workflows.ts
95aefea8f75f8c37fb20c93e1515e00a25b9cab856fb209fe57dad1024b1b385  packages/daemon/test/public-workflow-history.test.mjs
253a2698112342699b098dd9dca0bfcbed1a8fb64f229dceb24304fcfe29adea  packages/daemon/test/public-execution-snapshots.test.mjs
```

Candidate JavaScript and loader SHA256 consumed by the independent test/probe:

```text
ee21ad51ad56e601185d15a6da048b234fa6d8afcfdc64c38a7257d6b9b32297  output/e6-20260928/project-inputs-final-build/daemon/features/runs/public-execution-snapshots.js
a382d7b8c5b5b829929bd992a0110cfa10d62fcf33b238eaa852fbb5cced73dc  output/e6-20260928/project-inputs-final-build/daemon/features/runs/thread-routes.js
4b3ed2fee6478e6cd13d268b61bd934f28789a4278e955ffe19bd4f36d7b07d5  output/e6-20260928/project-inputs-final-build/daemon/features/channels/channel-conversation-api.js
4f28c2a42d5f4d71e7b8dd90f904d63cbd95f75f62d71b4f1594f676b83b1961  output/e6-20260928/public-projection-test-loader.mjs
657ac558210459303273bd3e3baa2b568485bd01815072c0b589c2465c03117a  output/e6-20260928/project-inputs-final-build/final-build-loader.mjs
```
