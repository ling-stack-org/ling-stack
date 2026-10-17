import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import {
  acceptedAt,
  now,
  userInputTranscriptFixture,
} from "./support/user-input-transcript-fixture.mjs";

const afterAcceptedAt = "2026-09-07T00:00:02.000Z";

async function addDelivery(f, index, requestAt = now, answerAt = acceptedAt) {
  const runId = `pagination-run-${index}`;
  const unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: runId,
    idempotencyKey: `pagination-unit-${index}`,
    status: "running",
    createdByActor: "system",
    request: {},
    now: requestAt,
  });
  const attempt = f.store.createWorkUnitAttempt({
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: `pagination-runtime-${index}`,
    runnerId: "runner_pi_embedded",
    status: "started",
    now: requestAt,
  });
  f.store.createRun({
    id: runId,
    cwd: f.cwd,
    taskId: `pagination-task-${index}`,
    threadId: f.thread.id,
    turnId: f.turn.turnId,
    workUnitId: unit.id,
    providerName: "fixture",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: requestAt,
  });
  f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", now: requestAt });
  f.store.linkRunToWorkUnit(runId, unit.id, requestAt);
  const request = f.store.createUserInputRequest({
    sourceRunId: runId,
    sourceItemId: f.turn.item.id,
    sourceFence: toRuntimeAttemptFence(attempt),
    toolCallId: `question-${index}`,
    idempotencyKey: `question-${index}`,
    toolInput: {
      schemaVersion: 1,
      waitMode: "required",
      questions: [{ questionId: "theme", prompt: `Theme ${index}`, required: true, allowFreeText: true, options: [] }],
    },
  }, requestAt).request;
  return f.store.submitUserInputAnswer({
    threadId: f.thread.id,
    submission: {
      schemaVersion: 1,
      requestId: request.requestId,
      expectedVersion: 1,
      expectedStatusRevision: 1,
      idempotencyKey: `answer-${index}`,
      answers: [{ questionId: "theme", kind: "text", text: `value-${index}` }],
    },
  }, answerAt).deliveryId;
}

test("workspace recovery scan keyset drains more than 500 rows without duplicates and sees later inserts", async t => {
  const f = await userInputTranscriptFixture(t);
  const deliveryIds = [];
  f.submit();
  deliveryIds.push(f.receipt.deliveryId);
  for (let index = 1; index < 503; index += 1) deliveryIds.push(await addDelivery(f, index));

  const heldId = [...deliveryIds].sort()[0];
  f.db.prepare("UPDATE user_input_deliveries SET status='claimed',status_revision=2,attempt_count=1,"
    + "successor_run_id='run_held_for_recovery',claim_owner_id='held-worker',claim_token='held-token',claim_expires_at=?"
    + " WHERE delivery_id=?").run("2026-09-07T00:00:01.500Z", heldId);
  const first = f.store.listDueUserInputDeliveries({ limit: 500 }, acceptedAt);
  assert.equal(first.length, 500);
  const cursor = { createdAt: first.at(-1).createdAt, deliveryId: first.at(-1).deliveryId };
  const inserted = await addDelivery(f, 503, "2026-09-07T00:00:01.500Z", afterAcceptedAt);
  const second = f.store.listDueUserInputDeliveries({ after: cursor, limit: 500 }, afterAcceptedAt);

  assert.equal(second.length, 3);
  assert.ok(second.some(delivery => delivery.deliveryId === inserted));
  const scanned = [...first, ...second].map(delivery => delivery.deliveryId);
  assert.equal(new Set(scanned).size, scanned.length);
  assert.deepEqual(new Set(scanned), new Set([...deliveryIds.filter(id => id !== heldId), inserted]));
  assert.ok(!second.some(delivery => delivery.deliveryId === heldId), "a newly due row before the cursor waits for the next scan");
  assert.ok(f.store.listDueUserInputDeliveries({ limit: 500 }, afterAcceptedAt)
    .some(delivery => delivery.deliveryId === heldId), "the next authoritative scan recovers it");
  assert.ok(scanned.every(deliveryId => f.store.getUserInputDelivery(f.thread.id, deliveryId)?.threadId === f.thread.id));
  assert.deepEqual(f.store.listDueUserInputDeliveries({ threadId: "foreign-thread", limit: 500 }, afterAcceptedAt), []);
  f.db.prepare("UPDATE user_input_deliveries SET updated_at='invalid' WHERE delivery_id=?").run(inserted);
  assert.throws(
    () => f.store.listDueUserInputDeliveries({ after: cursor, limit: 500 }, afterAcceptedAt),
    error => error?.code === "invalid_record",
  );
});
