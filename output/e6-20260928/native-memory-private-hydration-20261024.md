# Native Memory private hydration verification, 2026-10-24

Scope: native dispatcher, shared Memory prompt helpers, internal Run schemas, workflow selection, and their focused tests. The parent owns Pi orchestrator integration. No normal `dist`, real database, QA client, approval record, commit or release was changed.

## Confirmed cause and implementation

Native execution discarded `preselectedMemoryUse` from the durable request without moving its rendered role evidence into private model instructions. It did not validate selected Memory during asynchronous native admission or later Host authority boundaries.

The dispatcher now freezes selected/automatic Memory once in a SQLite read snapshot, hydrates `appendSystemPrompt`, omits `preselectedMemoryUse` from native inputs and durable requests, and retains canonical task/turn text. Workflow selection binds the exact actually recalled and retained sources with `sourceRevisions`: each contains a Memory ID and canonical SHA-256 semantic source hash. The complete Memory object is bound, including body, sources, scope, health, and `updatedAt`; only `lastUsedAt` is excluded. Selection without exact revisions fails closed. Before first hydration, after availability and at later native authority checks, the dispatcher validates current scope/eligibility and those source hashes in a SQLite read snapshot. `lastUsedAt` alone does not invalidate another consumer.

Usage evidence contains only IDs/query/policy metadata and is recorded once only after the exact native Attempt has a journaled `nativeTurnId`. Preparation and pre-acceptance failure do not count as use; failure after acceptance still counts. Queued native requests retain hydrated private instructions rather than the original one-time field.

The existing native target callback already reaches the outer authority check through `native-admission.ts`'s returned acceptance closure. Three-engine regressions prove that path, so `run-target-dispatcher.ts` required no source change. Codex maps private text to developer instructions; Kimi/OpenClaw already reject system instructions instead of degrading them to user input.

## Verification

- RED before source fix: 4 failed / 6 passed. Deterministic failures: no private hydration; revoke during availability still executed; body change during availability still executed; later Host Memory guard did not reject.
- GREEN focused: 10/10.
- Source binding RED before the follow-up fix: 2/2 failed. Both a body edit after selection but before dispatcher entry and a rendered selection without source revisions were incorrectly accepted.
- Final expanded regression: 114/114 passed, exit 0, no skip/cancel/todo. Files: `run-execution-binding.test.mjs`, `native-conversation.test.mjs`, `runner-settings-availability.test.mjs`, `memory-verification-prompt.test.mjs`, `agent-context-consistency.test.mjs`.
- After the final test-only extension, a fresh 1/1 targeted check also passed for another consumer changing `lastUsedAt` both before dispatcher entry and during availability.
- Candidate TypeScript: `./node_modules/.bin/tsc -p output/e6-20260928/project-inputs-final-build/tsconfig.json`, exit 0.
- Candidate tests use `output/e6-20260928/public-projection-test-loader.mjs` and fresh `LING_STACK_HOME`, `LING_STACK_DEFAULT_WORKSPACE_CWD`, `LING_WORKSPACE_CWD` per command.
- `git diff --check` for selected source/test: exit 0.
- This is synthetic Host/native journal integration, not a live model or packaged GUI certification.

## Shared helper contract and remaining integration

`features/memory/prompt.ts` exports:

```ts
createMemorySourceRevisions(memories: readonly MemoryObject[]): readonly MemorySourceRevision[]
assertPreselectedMemoryCurrent(store: RunStore, request: RunRequest): void
```

The first-hydration guard never recalls or reselects sources. Eligibility is checked before body decoding. Source revisions and rendered text must not be spread into captured `usedMemory`, which retains only IDs/query/policy. The parent owns invoking this guard for non-frozen first preparation and again after preparation awaits in Pi orchestrator; that combined integration has not been independently verified by this subtask. Frozen recovery remains on its existing frozen-input/eligibility contract, without re-recall or new source-revision requirements.

Native restart policy remains `stop_without_resume`; this change does not introduce a new native resume protocol or reinterpret Pi prepared input.

## Final selected input hashes

```text
644cd6bcc3cc7b1fb18dee1ba3b196fd99f3ac818e9dd4c1617ae8ac48ca03b5  packages/daemon/src/features/runs/native-run-dispatcher.ts
014f27a3b2e82908ad7c500beccb56820210132692e8f90f9d61daf2bb2b976d  packages/daemon/src/features/memory/prompt.ts
2f7fe96a1e84c8cad26d4e7ac68d3ce171180f5024a8e98cdea07e389174a089  packages/daemon/src/features/runs/schemas.ts
c7dc2b6d7e14a5055355ede3552a80094f8437b873a1d356fc8116a9d90d6c70  packages/daemon/src/features/channels/workflows.ts
2a3cbea390fc32680a1bd69273084bf6a4ab86f8f8bda37f356df41ac975fe6f  packages/daemon/test/run-execution-binding.test.mjs
718387b00b559a49352f156a7683643797cb8b37fb072ace3a17a1956f6f96ef  packages/daemon/test/memory-verification-prompt.test.mjs
98ad8852d6d56ceca6eea55a40ae743f8829d8e257c3df57625742d54443908e  packages/daemon/test/agent-context-consistency.test.mjs
7e982a422e3d06ad0a1e079504bb273db7591532ae2fc46524511ffb0b55bfc2  packages/daemon/src/features/execution-engines/run-target-dispatcher.ts (unchanged)
```
