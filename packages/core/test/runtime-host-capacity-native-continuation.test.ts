import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeHostCapacityStoreBinding, RuntimeHostCapacityBridge } from "../dist/runtime-host-capacity-store-bridge.js";
import { DEFAULT_WORKSPACE_ID, SqliteRunStore, toRuntimeAttemptFence } from "../dist/index.js";
import { hostCapacityFixture } from "./support/runtime-host-capacity-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";
import { claimedAt, userInputTranscriptFixture } from "./support/user-input-transcript-fixture.mjs";

const nativeBinding = { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 2 } as const;
const later = "2026-09-07T00:00:06.000Z";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ref = (value: { id: string; fingerprint: string }) => ({ id: value.id, fingerprint: value.fingerprint });
type UserInputDelivery = NonNullable<ReturnType<SqliteRunStore["claimUserInputDelivery"]>>;
type ClaimedUserInputDelivery = UserInputDelivery & { readonly claim: NonNullable<UserInputDelivery["claim"]> };
type ContinuationSnapshot = { readonly id: string; readonly fingerprint: string };
type NativePlan = {
  runnerId: string;
  requestSnapshot: Record<string, unknown>;
  runRequestSnapshot: Record<string, unknown>;
  preparedInput: Record<string, unknown> & { readonly fingerprint: string };
  preparedInputFingerprint: string;
  runnerExecutionInput: { runnerId: string; [key: string]: unknown };
  [key: string]: unknown;
};
type NativeInputFixture = {
  readonly cwd: string;
  readonly store: SqliteRunStore;
  readonly participantId: string;
  readonly thread: { readonly id: string };
  readonly turn: { readonly turnId: string };
  readonly run: { readonly id: string; readonly taskId: string };
  readonly submit: () => void;
  readonly claim: (input?: { readonly leaseMs?: number }) => ClaimedUserInputDelivery;
  delivery: ClaimedUserInputDelivery;
  seed: NonNullable<ReturnType<SqliteRunStore["getUserInputContinuationSeed"]>>;
  claimIdentity: { readonly threadId: string; readonly deliveryId: string; readonly expectedRevision: number; readonly ownerId: string; readonly claimToken: string };
  task: { readonly id: string; readonly title: string; readonly prompt: string };
  runRequest: Record<string, unknown>;
  preparedInput: Record<string, unknown> & { readonly fingerprint: string };
  preparedRequest: ContinuationSnapshot;
  plan: NativePlan;
  preparedExecution: ContinuationSnapshot;
};

test("native user input continuation rebinds and consumes its Host gate after Store reopen", async t => {
  // The shared transcript fixture remains MJS while its consumers migrate incrementally to TS.
  const fixture = await userInputTranscriptFixture(t, { runnerId: nativeBinding.engineId }) as unknown as NativeInputFixture;
  fixture.submit();
  fixture.delivery = fixture.claim({ leaseMs: 60_000 });
  const seed = fixture.store.getUserInputContinuationSeed(fixture.thread.id, fixture.delivery.deliveryId);
  assert.ok(seed);
  fixture.seed = seed;
  fixture.claimIdentity = { threadId: fixture.thread.id, deliveryId: fixture.delivery.deliveryId,
    expectedRevision: fixture.delivery.revision, ownerId: fixture.delivery.claim.ownerId, claimToken: fixture.delivery.claim.token };
  fixture.task = { id: fixture.run.taskId, title: "Continue", prompt: "Accepted answer: dark" };
  fixture.runRequest = { cwd: fixture.cwd, threadId: fixture.thread.id, turnId: fixture.turn.turnId, task: fixture.task,
    teammateId: fixture.participantId, parentRunId: fixture.run.id, continuationReason: "user_input_answer",
    runnerId: nativeBinding.engineId, tools: ["read"], executionBinding: nativeBinding };
  const modelInput = { schemaVersion: 1, boundary: "pi-model-context", taskId: fixture.task.id,
    systemPrompt: "Fixture", userPrompt: "Task: Continue\n\nAccepted answer: dark",
    model: { id: "fixture", provider: "fixture" }, tools: [], thinkingLevel: "off" };
  fixture.preparedInput = { ...modelInput, fingerprint: hash(modelInput) };
  fixture.preparedRequest = fixture.store.saveUserInputContinuationPreparation({ ...fixture.claimIdentity, stage: "request",
    parentRef: ref(fixture.seed), payload: fixture.runRequest }, claimedAt).snapshot;
  const runnerExecutionInput = { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
    input: { cwd: fixture.cwd, task: fixture.task, provider: { provider: "fixture", model: "fixture" }, tools: [] },
    preparedInput: fixture.preparedInput };
  fixture.plan = { schemaVersion: 1, runnerId: "pi", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: fixture.task, providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: fixture.runRequest,
    runRequestSnapshot: { ...fixture.runRequest, runnerExecutionInput }, preparedInput: fixture.preparedInput,
    preparedInputFingerprint: fixture.preparedInput.fingerprint, runnerExecutionInput };
  fixture.plan.runnerId = nativeBinding.engineId;
  fixture.plan.requestSnapshot = { ...fixture.plan.requestSnapshot, runnerId: nativeBinding.engineId, tools: ["read"], executionBinding: nativeBinding };
  fixture.plan.runRequestSnapshot = { ...fixture.plan.runRequestSnapshot, runnerId: nativeBinding.engineId, tools: ["read"], executionBinding: nativeBinding };
  fixture.plan.runnerExecutionInput.runnerId = nativeBinding.engineId;
  fixture.preparedExecution = fixture.store.saveUserInputContinuationPreparation({ ...fixture.claimIdentity, stage: "execution",
    parentRef: ref(fixture.preparedRequest), payload: fixture.plan }, claimedAt).snapshot;
  const host = hostCapacityFixture(t);
  let capacity = createRuntimeHostCapacityStoreBinding();
  let store = new SqliteRunStore({ cwd: fixture.cwd, paths: fixture.store.paths, runtimeHostCapacityBinding: capacity.binding });
  t.after(() => { if (testDatabase(store).isOpen) store.close(); });
  const journal = capacity.workspace(DEFAULT_WORKSPACE_ID);
  const bridge = new RuntimeHostCapacityBridge(journal, host.host);
  const claim = { ...fixture.claimIdentity, executionRef: { id: fixture.preparedExecution.id, fingerprint: fixture.preparedExecution.fingerprint },
    runtimeInstanceId: "native-input-runtime", now: claimedAt };
  const reserved = bridge.reserveUserInputContinuation(claim);
  assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));
  assert.ok(reserved.record.dispatchToken);

  const admitted = store.admitUserInputContinuation({ ...claim,
    hostCapacity: { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken },
  }, claimedAt);
  const reference = admitted.hostCapacity;
  assert.ok(reference);

  store.close();
  capacity = createRuntimeHostCapacityStoreBinding();
  store = new SqliteRunStore({ cwd: fixture.cwd, paths: fixture.store.paths, runtimeHostCapacityBinding: capacity.binding });
  const reopenedJournal = capacity.workspace(DEFAULT_WORKSPACE_ID);
  const base = { workspaceId: DEFAULT_WORKSPACE_ID, ...admitted.fence,
    acquiredAt: "2026-09-07T00:00:05.000Z", expiresAt: "2026-09-07T06:00:00.000Z" };
  assert.equal(store.acquireRuntimeSemaphoreSlots([
    { ...base, resourceType: "provider", resourceKey: "native:fixture:2", limit: 4,
      ownerType: "work_unit_attempt", ownerId: admitted.fence.attemptId },
    { ...base, resourceType: "runner", resourceKey: "kimi-acp", limit: 4,
      ownerType: "work_unit_attempt", ownerId: admitted.fence.attemptId },
  ]).status, "acquired");
  const beforeAcknowledgement = store.getUserInputDelivery(fixture.thread.id, fixture.delivery.deliveryId);
  const beforeWait = store.getUserInputWait(fixture.thread.id, fixture.seed.request.requestId);
  assert.ok(beforeAcknowledgement);
  assert.ok(beforeWait);
  assert.equal(beforeAcknowledgement.status, "claimed");
  assert.equal(beforeAcknowledgement.revision, admitted.deliveryRevision);
  assert.equal(beforeWait.status, "resuming");
  assert.equal(beforeWait.revision, admitted.waitRevision);

  const result = store.acknowledgeUserInputContinuation({
    threadId: fixture.thread.id, deliveryId: fixture.delivery.deliveryId,
    bindingRef: { id: admitted.id, fingerprint: admitted.fingerprint }, sourceFence: admitted.fence,
    claim: { ownerId: fixture.claimIdentity.ownerId, claimToken: fixture.claimIdentity.claimToken },
    receipt: { schemaVersion: 1, boundary: "pi-session-ready", runId: admitted.runId,
      attemptId: admitted.fence.attemptId, taskId: fixture.run.taskId, preparedInputFingerprint: fixture.preparedInput.fingerprint },
  }, later);
  assert.equal(result.replayed, false);
  assert.equal(reopenedJournal.getIntent(reference.intentId)?.dispatchedAt, later);
  assert.equal(host.host.counts().held, 1);
  assert.deepEqual(store.getWorkUnitAttempt(admitted.fence.attemptId)?.effectiveRunnerId, "kimi-acp");
  assert.deepEqual(toRuntimeAttemptFence(store.getWorkUnitAttempt(admitted.fence.attemptId)!), admitted.fence);
});
