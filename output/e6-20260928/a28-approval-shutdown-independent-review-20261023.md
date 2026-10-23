# A28 ordinary approval shutdown: independent review

Current status: **R1/R2/R3 addressed; final A28 narrow review has no unresolved confirmed findings**, 2026-10-23. This is not a merge, Office, packaged-GUI, or complete E6 approval.

## Final R3 rereview and A28 behavior receipt

Final inputs independently read back twice with no drift:

- `orchestrator.ts`: SHA-256 `cf8e7fbe180ed15d1308bb42a8b487ce865726cb8d049947e3a8630cf970be5f`.
- `teammate-direct-pause-recovery.test.mjs`: SHA-256 `d1bde4492623ce35059c5f5fd6c2953d8010aa6146b228fbcb0393b68f3f2f33`.

R3 is addressed by the minimal local change: only each live event publication **after a successful original Core CAS** is exception-isolated. Original source/checkpoint/blocker validation, the CAS itself, and a false CAS result remain outside this catch and continue to block. The diagnostic is a fixed string with no event, exception, credential, or private payload. Each later durable invalidation is still attempted when a preceding live consumer fails; the SQLite facts remain replayable. No global Hub changes were made.

The observer comment now correctly says that fulfillment is not itself a durable receipt; the existing Core resource veto remains authoritative. The original main-completion and local-writer ordering chain is unchanged by R3, with no callback self-await.

The regression observes the original index Hub and registers/activates an actual throwing listener through `subscribeListener`. Its Hub and Store wrappers invoke the original methods via `Reflect.apply` and return their original results; they do not fabricate delivery or CAS receipts. Assertions require three real listener deliveries, exactly one successful original CAS, checkpoint revision +1, one fenced suspension audit, zero active original leases/slots, and successful real Host stop after actual writer drain. Existing owner/revision-change negative cases remain in the full run.

Causal RED independently read: `/private/tmp/e6-a28-live-listener-causal-red-20261023.tap` records the predecessor seam's one successful CAS, Attempt lost / checkpoint revision 2, one actual listener throw, then real Host-stop failure and actual child exit 1. Thus this regression distinguishes the repaired bug from setup failure or an invented failure result.

Final GREEN evidence independently read: `/private/tmp/e6-a28-private-recovery-notification-final-20261023.tap` ends with **14 tests / 14 pass / 0 fail / 0 cancelled / 0 skipped**, duration 56,401.959333 ms. The new case is `ok 14`, and the log contains the three fixed notification-failure diagnostics. A11 supplied its actual `write_stdin` session 66087 exit code 0; root separately confirmed that final exit and these same source/test hashes. Behavior tests were executed by A11/root, not by this independent reviewer.

Final finding state: **R1 closed, R2 closed, R3 closed for this exact final byte pair and narrow reviewed scope. Zero unresolved confirmed new correctness findings.** Wider Office content review, complete E6, packaged GUI, full SDK/remote effect coverage, and PR/merge authorization remain outside this conclusion.

Adjacent receipt added after the final A28 review: root's four-file run, session 18208, completed with actual exit 0. Its `/private/tmp/e6-daemon-a28-notification-neighbors-final-20261023.tap` was independently read and ends with **93 tests / 93 pass / 0 fail / 0 cancelled / 0 skipped**, duration 54,944.775 ms. Both previously failing real-reviewer late-drain cases are explicitly `ok` (user-input false and true); the group also covers ActiveRuns and shutdown/tree behavior. Root's whole-Daemon run, session 35284, was newly started and is not represented as passed here.

The report below preserves predecessor findings, hashes, and RED/13-case milestones in chronological layers. Their OPEN wording is historical, not the final finding state.

## Frozen-candidate narrow rereview

Inputs independently read back twice:

- `orchestrator.ts`: SHA-256 `03dc3cae4a0443a79c921a43a1d0c1c4907e0ba4ebe1b30bfcbd3eb9176eec09`.
- `teammate-direct-pause-recovery.test.mjs`: SHA-256 `cc4ccaa3f4eed0786bba58ddd65bc8111024c0e687aabd180413431b013c2cf2`.

R1's indefinite retain is repaired for an otherwise valid original approval wait. The code captures its original approval/checkpoint/status/revision/basis identity before waiting; only a still-closed group with actual pending writers can defer. After real drain, the same closure rechecks exact active/SQLite ownership, original checkpoint identity and known Host blockers, then invokes the original CAS. Revision or owner change cannot be adopted as fresh permission.

The deferred callback does not await itself: it commits synchronously, resolves original `runCompletion`, separately tracks the original durable completion, and only then finishes ordering. The registry subsequently retires only its exact captured active entry. The real completion promise remains registered throughout. An invalid source still blocks ordering and keeps SQLite authority/resources.

R2's bare Store injection is removed. The test now calls the original `RunStoreRegistry.getStore` first, verifies the exact isolated cwd/database and original return object, then installs only observers on that same Store. It does not substitute/re-enroll a Store or replace the original index factory. Cleanup releases the owned Runner gate and preserves original exercise errors alongside cleanup errors.

Behavior evidence independently **read**, not executed by this reviewer: `/private/tmp/e6-a28-private-recovery-late-drain-final-20261023.tap` ends with 13 tests / 13 pass / 0 fail, cancelled, skipped. A11 reports actual exit 0 for these exact frozen inputs. The log contains durable blocked evidence for request-before-approval; real local-writer late drain succeeds; checkpoint revision and owner changes during real drain reject with retained resources. Adjacent real-reviewer tests were still running when this rereview was recorded; no earlier failure is assumed cleared before their actual result.

### A28-R3 [P2]: a post-CAS live notification exception is treated as an uncommitted suspension

`orchestrator.ts:3673-3688` commits the authoritative Core approval suspension, then synchronously publishes control-plane events before the closure returns. The real Hub `features/control-plane/events.ts:165-178` calls `enqueueListenerEvent`; its active-listener path at `346-350` directly calls `client.onEvent(trimmed)` without exception isolation. Therefore a failing live consumer can throw after a successful SQLite CAS.

In the new deferred path, `3867-3872` sets `approvalSuspended=true` and clears `retainExecutionAuthority` only after the closure returns. A post-commit publish exception instead blocks ordering and omits `3881-3885`'s durable-completion-to-order-finish continuation, although the checkpoint/Attempt are already committed. This misclassifies a recoverable notification failure as a failed authoritative suspension and prevents the original Host shutdown from completing.

Required minimal repair: isolate successful-CAS event publication as best-effort/replayable notification; do not swallow Core CAS/revalidation failures or broaden into a global Hub refactor. Minimal regression should use an actual active `ControlPlaneEventHub.subscribeListener` consumer that throws, combined with the original delayed-writer drain. Assert that the original checkpoint/Attempt CAS occurs exactly once, real resources release, and ordering/Host stop complete; preserve existing revision/owner rejection tests.

No product/test source was changed and no behavior tests/build were run by this reviewer. An additional test-static sub-review could not be reactivated due the environment's agent thread limit; this narrow rereview was completed by the main independent reviewer.

## Historical interim snapshot (retained for traceability)

The following findings and RED results describe predecessor inputs, before the repairs above.

## Scope and custody

- Worktree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
- Read-only review of the ordinary approval/shutdown delta and the necessary original callback, local-writer, checkpoint, and resource-release seams.
- Reviewer did not edit product/test sources, emit/build, run behavior tests, change databases, or re-review unrelated evaluation work.
- Production input read back unchanged: `packages/daemon/src/features/runs/orchestrator.ts`, SHA-256 `c1992347578bfb613adcb7b1b328797d2ed58fb266a84d027782fa39c78dab50`.
- Test input is being actively repaired by A11. Latest observed SHA-256: `6b3045d36cf27ef2b29d382ed7afbbd24a583d893508e6770df0d7cb95a36d06`. This is not asserted to be the predecessor behavior-run input.

## Findings

### A28-R1 [P1]: valid approval wait becomes permanently retained after a local-drain observation timeout

`orchestrator.ts:3654-3657` first validates the original approval/checkpoint and waits at most 1,000 ms for actual local-writer drain. A slow real automatic-review Runner causes this observation to time out. The catch at `3682-3690` sets `retainExecutionAuthority`; the `3832-3840` retained callback only disposes supervision and resolves the original run completion after eventual drain. It never revalidates/commits the original approval suspension.

Consequently the completion observer can record a genuinely drained source, but the source Attempt remains started while Run/WorkUnit remain waiting. The existing Core resource veto (`cancelled-attempt-resource-veto.ts:91-106`) correctly rejects release because there is neither a suspended approval handoff nor terminal/stopped authority. The two active semaphore slots then remain indefinitely even after the actual reviewer finishes.

Behavior evidence independently read: `/private/tmp/e6-daemon-evidence-final-integrated-20261023.tap:713-755`; the real reviewer tests, `user-input-pause-production.test.mjs:631`, both fail at `691` with expected active slots `0`, actual `2`. Parent reports actual test exit 1, 128 total / 126 pass / 2 fail / 0 skip.

Required repair boundary: retain the same original approval continuation across a finite observer timeout and, only after real writer drain, reread exact source/checkpoint/revision/known blockers and use the original approval suspension CAS. Do not weaken Core resource veto or fabricate effect coverage. Missing/foreign/delegated/ordinary-pending/known-effect-blocked sources must remain blocked.

### A28-R2 [P1, test validity]: request-before-approval fixture bypasses original constructor custody

The currently reviewed fixture injects `storeFactory` and directly calls `core.createSqliteRunStore`. This replaces `index.ts:406-412`'s default original factory. That default factory installs the private original Store composition; `beforeRecovery` only establishes runtime ownership and does not create this composition.

The ordinary suspension path calls `readOriginalRunSuspensionLifecycle` through `orchestrator.ts:2518`. `store-composition.ts:166-168` requires the Store to exist in the constructor-owned WeakMap. The fixture's bare Store cannot satisfy that requirement, so ordinary `controller.request` throws `delegation.authority_invalid` before it can persist `hasPendingRunSuspension`.

The test then waits for a request that cannot exist. Its predecessor cleanup awaited `fixture.stop` while its fake Runner still awaited the unreleased approval gate, hiding the first 10-second failure behind a 65-second child interruption. The latest test now releases the gate in `finally` and guards listener close with `server.listening`; those repairs expose original failures but do not by themselves create valid constructor custody.

Behavior evidence read: `/private/tmp/e6-a28-private-recovery-final-20261023.tap`; 11 total, 6 pass / 5 fail. Case 7 has only entry plus 65-second interruption, no durable blocked evidence; cases 8-10 show cleanup `ERR_SERVER_NOT_RUNNING`, and case 11 shows retained-store shutdown failure. These results cannot be represented as a verified production blocked path or as complete A28 acceptance.

Required repair boundary: exercise the real original factory/composition through an owned test entry point. Do not relax production constructor capability checks just to make the injected bare Store pass.

## Static checks that remain useful, but are not a green verdict

- Exact ActiveRuns/SQLite fence and Run/WorkUnit/Attempt ownership checks; original approval/checkpoint/basis fingerprint and action identity checks.
- Original ordinary suspension requests and dynamic descendant evidence are not silently converted to approval-resume authority.
- Approval-committed-after-request hook targets the original wait, not a successor; final catch retains authority for blocked sources.
- Original approval suspension transaction performs checkpoint/Attempt/resource changes atomically and rolls back failures.
- Real local writer membership/drain is used; known pending/unknown Host journal effects remain release blockers.

The independent test-static sub-review also found the fixture custody/wait chain and excluded a mandatory HTTP/link-before-approval wait cycle: accepted SSE and run linkage are emitted before Runner execution. It ran no tests and changed no sources.

## Explicit coverage limits

Ordinary approval suspension retains its existing narrower contract: original adapter return plus actual local-writer drain plus absence of known journal blockers. This is **not** full SDK/remote effect coverage and must not be described as such. A broader approval effect-coverage contract needs separate Core/SDK boundary work.

The current 11-case suite is not an E2E dynamic-descendant test; its delegated-owner negative case changes owner type. A legal ordinary `parentRunId` positive case and approved/checkpoint-revision concurrent race are not separately established here.

Final byte freeze, fresh repaired A28 behavior run, the adjacent real-reviewer regressions, and final independent reread remain pending. No complete E6, Office, packaged QA, or PR merge approval is issued by this report.
