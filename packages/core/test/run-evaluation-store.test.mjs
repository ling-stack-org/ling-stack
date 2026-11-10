import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T00:01:00.000Z";
const expiredAt = "2026-09-14T00:02:00.000Z";
const afterExpiry = "2026-09-14T00:03:00.000Z";
const nextExpiry = "2026-09-14T00:05:00.000Z";

async function fixture(t, terminal = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-store-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    try { database.close(); } catch {}
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Evaluation", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Evaluate", prompt: "grade" }, now);
  const run = store.createRun({
    id: "run-evaluation-1",
    cwd,
    taskId: task.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now,
  });
  if (terminal) store.markRunSucceeded(run.id, now);
  const suite = store.createArtifact({
    id: "artifact-evaluation-suite",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/suite.json",
    sealedPayload: { id: "suite-json", version: "1", cases: ["case-json"] },
    createdAt: now,
  });
  const testCase = store.createArtifact({
    id: "artifact-evaluation-case",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/case.json",
    sealedPayload: {
      schemaVersion: 1,
      kind: "deterministic_json_rule",
      graderId: "json-contract",
      graderVersion: "1",
      failureSeverity: "error",
      assertions: [{ type: "deep_equal" }],
    },
    createdAt: now,
  });
  const baseline = store.createArtifact({
    id: "artifact-evaluation-baseline",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/baseline.json",
    sealedPayload: { status: "ok", count: 2 },
    createdAt: now,
  });
  const candidate = store.createArtifact({
    id: "artifact-evaluation-candidate",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/candidate.json",
    sealedPayload: { count: 2, status: "ok" },
    createdAt: now,
  });
  const enqueue = {
    id: "evaluation-1",
    runId: run.id,
    suiteId: "suite-json",
    suiteVersion: "1",
    suiteArtifactId: suite.id,
    caseId: "case-json",
    caseVersion: "1",
    caseArtifactId: testCase.id,
    baselineId: "baseline-json",
    baselineVersion: "1",
    baselineArtifactId: baseline.id,
    candidateArtifactId: candidate.id,
    now,
  };
  return { cwd, store, database, run, suite, testCase, baseline, candidate, enqueue };
}

test("terminal evaluation enqueue binds sealed artifact digests and replays the complete identity", async (t) => {
  const f = await fixture(t);
  const first = f.store.enqueueRunEvaluation(f.enqueue);
  const replay = f.store.enqueueRunEvaluation(f.enqueue);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluation.id, first.evaluation.id);
  assert.equal(first.evaluation.suiteDigest, f.suite.contentSha256);
  assert.equal(first.evaluation.caseDigest, f.testCase.contentSha256);
  assert.equal(first.evaluation.baselineDigest, f.baseline.contentSha256);
  assert.equal(first.evaluation.candidateDigest, f.candidate.contentSha256);
  assert.match(first.evaluation.idempotencyKey, /^run-evaluation:/u);
  assert.equal(f.store.listRunEvaluations({ runId: f.run.id }).length, 1);

  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluations SET state='claimed' WHERE id=?",
  ).run(first.evaluation.id), /CHECK constraint failed/u);

  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluations SET case_version='2' WHERE id=?",
  ).run(first.evaluation.id), /identity is immutable/u);
});

test("a non-terminal run or unsealed cross-run artifact cannot enter the evaluation queue", async (t) => {
  const f = await fixture(t, false);
  assert.throws(() => f.store.enqueueRunEvaluation(f.enqueue), hasCode("evaluation.lineage_invalid"));
  f.store.markRunSucceeded(f.run.id, later);
  const unsealed = f.store.createArtifact({
    id: "artifact-unsealed",
    runId: f.run.id,
    type: "json",
    path: "unsealed.json",
    createdAt: later,
  });
  assert.throws(() => f.store.enqueueRunEvaluation({
    ...f.enqueue,
    candidateArtifactId: unsealed.id,
    id: "evaluation-unsealed",
  }), hasCode("evaluation.artifact_invalid"));
  assert.throws(() => f.store.enqueueRunEvaluation({
    ...f.enqueue,
    id: "evaluation-bad-time",
    now: "2026-09-14 00:00:00",
  }), /canonical UTC/u);
});

test("claim, start, and completion atomically append one immutable grade", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const claimed = f.store.claimRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 0,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    claimExpiresAt: nextExpiry,
    now: later,
  });
  assert.equal(claimed.ok, true);
  const grading = f.store.startRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 1,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    now: later,
  });
  assert.equal(grading.ok, true);
  const unsealedRationale = f.store.createArtifact({
    id: "artifact-unsealed-rationale",
    runId: f.run.id,
    type: "json",
    path: "evaluation/unsealed-rationale.json",
    createdAt: later,
  });
  assert.throws(() => f.store.completeRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    grade: {
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      rationaleArtifactId: unsealedRationale.id,
    },
    now: later,
  }), hasCode("evaluation.artifact_invalid"));
  assert.equal(f.store.getRunEvaluation(queued.id).state, "grading");
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 0);
  const completed = f.store.completeRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    grade: {
      id: "grade-1",
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      score: 1,
      latencyMs: 3,
    },
    now: later,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.evaluation.state, "completed");
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 1);
  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluation_grades SET verdict='fail' WHERE id='grade-1'",
  ).run(), /append-only/u);
  assert.throws(() => f.database.prepare(
    "DELETE FROM run_evaluation_grades WHERE id='grade-1'",
  ).run(), /append-only/u);
});

test("expired grading lease is reclaimed without duplicating the append-only grade", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  assert.equal(f.store.claimRunEvaluation({
    evaluationId: queued.id, expectedRevision: 0, claimOwner: "old-worker", claimToken: "old-token",
    claimExpiresAt: expiredAt, now: later,
  }).ok, true);
  assert.equal(f.store.startRunEvaluation({
    evaluationId: queued.id, expectedRevision: 1, claimOwner: "old-worker", claimToken: "old-token", now: later,
  }).ok, true);
  assert.equal(f.store.listClaimableRunEvaluations({ now: afterExpiry }).map((item) => item.id).includes(queued.id), true);
  const reclaimed = f.store.claimRunEvaluation({
    evaluationId: queued.id, expectedRevision: 2, claimOwner: "new-worker", claimToken: "new-token",
    claimExpiresAt: nextExpiry, now: afterExpiry,
  });
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.value.failureCode, "evaluation.lease_expired");
  assert.equal(f.store.startRunEvaluation({
    evaluationId: queued.id, expectedRevision: 3, claimOwner: "new-worker", claimToken: "new-token", now: afterExpiry,
  }).ok, true);
  assert.deepEqual(f.store.failRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "old-worker",
    claimToken: "old-token",
    failureCode: "evaluation.result_invalid",
    now: afterExpiry,
  }), { ok: false, code: "lease_mismatch" });
  assert.deepEqual(f.store.requeueRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "old-worker",
    claimToken: "old-token",
    failureCode: "evaluation.grader_unavailable",
    nextAttemptAt: nextExpiry,
    now: afterExpiry,
  }), { ok: false, code: "lease_mismatch" });
  const input = {
    evaluationId: queued.id,
    expectedRevision: 4,
    claimOwner: "new-worker",
    claimToken: "new-token",
    grade: {
      id: "grade-recovered",
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      score: 1,
    },
    now: afterExpiry,
  };
  const completed = f.store.completeRunEvaluation(input);
  const replay = f.store.completeRunEvaluation(input);
  assert.equal(completed.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 1);

  const conflict = f.store.appendRunEvaluationGrade({
    evaluationId: queued.id,
    grade: { ...input.grade, id: "grade-conflict", verdict: "fail" },
    now: afterExpiry,
  });
  assert.deepEqual(conflict, { ok: false, code: "grade_conflict" });
});

test("new suite, case, baseline, or grader versions append history instead of rewriting it", async (t) => {
  const f = await fixture(t);
  const original = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const suiteV2 = f.store.createArtifact({
    id: "artifact-evaluation-suite-v2",
    runId: f.run.id,
    type: "json",
    path: ".ling-stack/evaluations/suite-v2.json",
    sealedPayload: { id: "suite-json", version: "2", cases: ["case-json"] },
    createdAt: later,
  });
  const next = f.store.enqueueRunEvaluation({
    ...f.enqueue,
    id: "evaluation-2",
    suiteVersion: "2",
    suiteArtifactId: suiteV2.id,
    now: later,
  }).evaluation;
  assert.notEqual(next.idempotencyKey, original.idempotencyKey);
  assert.equal(f.store.getRunEvaluation(original.id).suiteVersion, "1");
  assert.equal(f.store.getRunEvaluation(next.id).suiteVersion, "2");
});

test("claim permanently fails invalid retained inputs without changing their lineage or another owner's pins", async (t) => {
  const cases = [
    ...["suite", "testCase", "baseline", "candidate"].map((artifact) => ({
      name: `${artifact} digest mismatch`, artifact, body: '{"tampered":true}',
    })),
    { name: "candidate body unavailable", artifact: "candidate", body: null },
    { name: "candidate body over budget", artifact: "candidate", body: `"${"x".repeat(16 * 1024 * 1024)}"` },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture(t);
    const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
    const ownHolder = activeEvaluationPins(f.database)[0].holder;
    const sibling = f.store.enqueueRunEvaluation({
      ...f.enqueue, id: "evaluation-sibling", caseVersion: "2",
    }).evaluation;
    f.store.pinHarnessArtifact({ artifactId: f[scenario.artifact].id, holder: "independent-review",
      reason: "audit_hold", now });
    const remainingPins = activeEvaluationPins(f.database).filter((pin) => pin.holder !== ownHolder);
    const sourceRun = f.store.getRun(f.run.id);
    const siblingBefore = f.store.getRunEvaluation(sibling.id);
    f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
      .run(scenario.body, f[scenario.artifact].id);
    const artifactBefore = f.database.prepare("SELECT * FROM artifacts WHERE id=?").get(f[scenario.artifact].id);

    assert.deepEqual(f.store.claimRunEvaluation(evaluationClaim(queued)),
      { ok: false, code: "evaluation.artifact_invalid" });

    const failed = assertInvalidEvaluation(f, queued.id, queued.revision + 2);
    assert.equal(failed.suiteDigest, queued.suiteDigest);
    assert.equal(failed.caseDigest, queued.caseDigest);
    assert.equal(failed.baselineDigest, queued.baselineDigest);
    assert.equal(failed.candidateDigest, queued.candidateDigest);
    assert.equal(failed.idempotencyKey, queued.idempotencyKey);
    assert.deepEqual(f.database.prepare("SELECT * FROM artifacts WHERE id=?").get(f[scenario.artifact].id), artifactBefore);
    assert.deepEqual(f.store.getRun(f.run.id), sourceRun);
    assert.deepEqual(f.store.getRunEvaluation(sibling.id), siblingBefore);
    assert.deepEqual(activeEvaluationPins(f.database), remainingPins);
    assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM harness_artifact_pin_events
      WHERE holder=? AND event='release'`).get(ownHolder).n, 4);
    assert.equal(f.store.listClaimableRunEvaluations({ now: later }).some((item) => item.id === queued.id), false);
  });
});

test("start permanently fails input corruption introduced after a valid claim", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const claimed = f.store.claimRunEvaluation(evaluationClaim(queued));
  assert.equal(claimed.ok, true);
  const sourceRun = f.store.getRun(f.run.id);
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run('{"tampered":true}', f.candidate.id);

  assert.deepEqual(f.store.startRunEvaluation(evaluationLease(claimed.value)),
    { ok: false, code: "evaluation.artifact_invalid" });
  assertInvalidEvaluation(f, queued.id, claimed.value.revision + 2);
  assert.deepEqual(f.store.getRun(f.run.id), sourceRun);
  assert.deepEqual(activeEvaluationPins(f.database), []);
});

test("same-owner claim and grading replays revalidate input bodies before returning success", async (t) => {
  for (const operation of ["claim", "start"]) await t.test(operation, async (t) => {
    const f = await fixture(t);
    const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
    const claimInput = evaluationClaim(queued);
    const claimed = f.store.claimRunEvaluation(claimInput);
    assert.equal(claimed.ok, true);
    const startInput = evaluationLease(claimed.value);
    const active = operation === "start" ? f.store.startRunEvaluation(startInput) : claimed;
    assert.equal(active.ok, true);
    f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
      .run('{"tampered":true}', f.candidate.id);

    // Replay intentionally uses the original request revision. The still-live matching
    // owner/token grants replay authority, not permission to skip body integrity checks.
    const replay = operation === "claim"
      ? f.store.claimRunEvaluation(claimInput) : f.store.startRunEvaluation(startInput);
    assert.deepEqual(replay, { ok: false, code: "evaluation.artifact_invalid" });
    assertInvalidEvaluation(f, queued.id, active.value.revision + 1);
    assert.deepEqual(activeEvaluationPins(f.database), []);
  });
});

test("corrupt input does not let stale revisions or a different live lease terminate an evaluation", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run('{"tampered":true}', f.candidate.id);
  const queuedPins = activeEvaluationPins(f.database);
  assert.deepEqual(f.store.claimRunEvaluation({ ...evaluationClaim(queued), expectedRevision: queued.revision + 1 }),
    { ok: false, code: "stale_revision" });
  assert.deepEqual(f.store.getRunEvaluation(queued.id), queued);
  assert.deepEqual(activeEvaluationPins(f.database), queuedPins);

  // Restore only this fixture's body so a legitimate owner can acquire the lease,
  // then corrupt it again from the independent connection before unauthorized calls.
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run(JSON.stringify(f.candidate.sealedPayload), f.candidate.id);
  const claimed = f.store.claimRunEvaluation(evaluationClaim(queued));
  assert.equal(claimed.ok, true);
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run('{"tampered":true}', f.candidate.id);
  const claimedPins = activeEvaluationPins(f.database);
  assert.deepEqual(f.store.claimRunEvaluation({
    ...evaluationClaim(claimed.value), claimOwner: "other-worker", claimToken: "other-token",
  }), { ok: false, code: "invalid_transition" });
  assert.deepEqual(f.store.startRunEvaluation({ ...evaluationLease(claimed.value), expectedRevision: queued.revision }),
    { ok: false, code: "stale_revision" });
  assert.deepEqual(f.store.startRunEvaluation({
    ...evaluationLease(claimed.value), claimOwner: "other-worker", claimToken: "other-token",
  }), { ok: false, code: "lease_mismatch" });
  assert.deepEqual(f.store.requeueRunEvaluation({
    ...evaluationLease(claimed.value), claimOwner: "other-worker", claimToken: "other-token",
    failureCode: "evaluation.grader_unavailable", nextAttemptAt: nextExpiry,
  }), { ok: false, code: "lease_mismatch" });
  assert.deepEqual(f.store.getRunEvaluation(queued.id), claimed.value);
  assert.deepEqual(activeEvaluationPins(f.database), claimedPins);
  assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
});

test("pin-holder conflicts are storage failures, not permanent invalid-input results", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  // Inject a real conflicting pin row rather than throwing a test-double error.
  f.database.prepare("UPDATE harness_artifact_pins SET reason='audit_hold' WHERE artifact_id=?")
    .run(f.candidate.id);
  const pins = activeEvaluationPins(f.database);
  const eventCount = f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n;

  assert.throws(() => f.store.claimRunEvaluation(evaluationClaim(queued)), hasCode("artifact.pin_holder_conflict"));
  assert.deepEqual(f.store.getRunEvaluation(queued.id), queued);
  assert.deepEqual(activeEvaluationPins(f.database), pins);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n, eventCount);
  assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
});

test("corrupt bodies cannot mask a same-owner audit hold or release any recovery pin", async t => {
  for (const operation of ["claim", "claim-replay", "start", "start-replay", "requeue"]) {
    for (const corrupted of ["candidate", "suite"]) await t.test(`${operation}: ${corrupted} body`, async t => {
      const f = await fixture(t);
      const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
      const claimInput = evaluationClaim(queued);
      let active = queued;
      if (operation !== "claim") {
        const claimed = f.store.claimRunEvaluation(claimInput);
        assert.equal(claimed.ok, true);
        active = claimed.value;
      }
      const startInput = evaluationLease(active);
      if (["start-replay", "requeue"].includes(operation)) {
        const grading = f.store.startRunEvaluation(startInput);
        assert.equal(grading.ok, true);
        active = grading.value;
      }
      const owner = activeEvaluationPins(f.database)[0].holder;
      // A corrupt first artifact must not hide a conflict on a later artifact.
      // The same-artifact case also catches the body-before-reason check ordering.
      f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
        .run('{"tampered":true}', f[corrupted].id);
      f.database.prepare("UPDATE harness_artifact_pins SET reason='audit_hold' WHERE artifact_id=? AND holder=?")
        .run(f.candidate.id, owner);
      const row = f.store.getRunEvaluation(queued.id);
      const pins = f.database.prepare("SELECT * FROM harness_artifact_pins ORDER BY artifact_id,holder").all();
      const events = f.database.prepare("SELECT * FROM harness_artifact_pin_events ORDER BY rowid").all();
      const artifacts = f.database.prepare("SELECT * FROM artifacts ORDER BY id").all();
      const run = f.store.getRun(f.run.id);
      f.database.exec(`CREATE TRIGGER forbid_release_before_reason_validation BEFORE UPDATE OF released_at ON harness_artifact_pins
        WHEN NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'release attempted before owner reason validation'); END`);

      const mutate = () => {
        if (["claim", "claim-replay"].includes(operation)) return f.store.claimRunEvaluation(claimInput);
        if (["start", "start-replay"].includes(operation)) return f.store.startRunEvaluation(startInput);
        return f.store.requeueRunEvaluation({ ...evaluationLease(active),
          failureCode: "evaluation.grader_unavailable", nextAttemptAt: nextExpiry });
      };
      assert.throws(mutate, hasCode("artifact.pin_holder_conflict"));
      assert.deepEqual(f.store.getRunEvaluation(queued.id), row);
      assert.deepEqual(f.database.prepare("SELECT * FROM harness_artifact_pins ORDER BY artifact_id,holder").all(), pins);
      assert.deepEqual(f.database.prepare("SELECT * FROM harness_artifact_pin_events ORDER BY rowid").all(), events);
      assert.deepEqual(f.database.prepare("SELECT * FROM artifacts ORDER BY id").all(), artifacts);
      assert.deepEqual(f.store.getRun(f.run.id), run);
      assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
    });
  }
});

test("terminal evaluation release validates every same-owner reason before updating any pin", async t => {
  for (const operation of ["fail", "complete"]) await t.test(operation, async t => {
    const f = await fixture(t);
    const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
    const claimed = f.store.claimRunEvaluation(evaluationClaim(queued));
    assert.equal(claimed.ok, true);
    const grading = f.store.startRunEvaluation(evaluationLease(claimed.value));
    assert.equal(grading.ok, true);
    const owner = activeEvaluationPins(f.database)[0].holder;
    f.database.prepare("UPDATE harness_artifact_pins SET reason='audit_hold' WHERE artifact_id=? AND holder=?")
      .run(f.candidate.id, owner);
    const pins = f.database.prepare("SELECT * FROM harness_artifact_pins ORDER BY artifact_id,holder").all();
    const events = f.database.prepare("SELECT * FROM harness_artifact_pin_events ORDER BY rowid").all();
    f.database.exec(`CREATE TRIGGER forbid_release_before_reason_validation BEFORE UPDATE OF released_at ON harness_artifact_pins
      WHEN NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'release attempted before owner reason validation'); END`);
    const mutate = () => operation === "fail"
      ? f.store.failRunEvaluation({ ...evaluationLease(grading.value), failureCode: "evaluation.result_invalid" })
      : f.store.completeRunEvaluation({ ...evaluationLease(grading.value), grade: {
        id: "grade-conflicted-owner", graderType: "rule", graderId: "json-contract", graderVersion: "1", verdict: "pass", score: 1,
      } });
    assert.throws(mutate, hasCode("artifact.pin_holder_conflict"));
    assert.deepEqual(f.store.getRunEvaluation(queued.id), grading.value);
    assert.deepEqual(f.database.prepare("SELECT * FROM harness_artifact_pins ORDER BY artifact_id,holder").all(), pins);
    assert.deepEqual(f.database.prepare("SELECT * FROM harness_artifact_pin_events ORDER BY rowid").all(), events);
    assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
  });
});

test("a storage failure while releasing invalid-input pins rolls terminalization back atomically", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const pins = activeEvaluationPins(f.database);
  const eventCount = f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n;
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run('{"tampered":true}', f.candidate.id);
  f.database.exec(`CREATE TRIGGER reject_evaluation_pin_release BEFORE UPDATE OF released_at ON harness_artifact_pins
    WHEN NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected pin release failure'); END`);

  assert.throws(() => f.store.claimRunEvaluation(evaluationClaim(queued)), /injected pin release failure/u);
  assert.deepEqual(f.store.getRunEvaluation(queued.id), queued);
  assert.deepEqual(activeEvaluationPins(f.database), pins);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n, eventCount);
  assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
});

test("a deferred COMMIT failure cannot return an invalid-input result or partially release pins", async t => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const pins = activeEvaluationPins(f.database);
  const eventCount = f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n;
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run('{"tampered":true}', f.candidate.id);
  f.database.exec(`
    CREATE TABLE evaluation_commit_fault (
      artifact_id TEXT REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER reject_evaluation_failed_commit AFTER UPDATE OF state ON run_evaluations
    WHEN NEW.state='failed' BEGIN
      INSERT INTO evaluation_commit_fault(artifact_id) VALUES ('missing-evaluation-commit-artifact');
    END;
  `);
  assert.throws(() => f.store.claimRunEvaluation(evaluationClaim(queued)), /FOREIGN KEY constraint failed/u);
  assert.deepEqual(f.store.getRunEvaluation(queued.id), queued);
  assert.deepEqual(activeEvaluationPins(f.database), pins);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n, eventCount);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM evaluation_commit_fault").get().n, 0);
  assert.deepEqual(f.store.listRunEvaluationGrades(queued.id), []);
});

test("a closed database remains a storage error rather than an invalid-input disposition", async t => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  f.store.close();
  assert.throws(() => f.store.claimRunEvaluation(evaluationClaim(queued)), /database is not open/u);
  const unchanged = f.database.prepare("SELECT state,revision,claim_owner FROM run_evaluations WHERE id=?").get(queued.id);
  assert.equal(unchanged.state, "queued");
  assert.equal(unchanged.revision, queued.revision);
  assert.equal(unchanged.claim_owner, null);
  assert.deepEqual(f.database.prepare("SELECT id FROM run_evaluation_grades WHERE evaluation_id=?").all(queued.id), []);
});

function evaluationClaim(evaluation) {
  return { ...evaluationLease(evaluation), claimExpiresAt: nextExpiry };
}

function evaluationLease(evaluation) {
  return { evaluationId: evaluation.id, expectedRevision: evaluation.revision,
    claimOwner: "evaluation-worker", claimToken: "claim-1", now: later };
}

function activeEvaluationPins(database) {
  return database.prepare(`SELECT artifact_id,holder,reason FROM harness_artifact_pins
    WHERE released_at IS NULL ORDER BY artifact_id,holder`).all();
}

function assertInvalidEvaluation(f, id, expectedRevision) {
  const evaluation = f.store.getRunEvaluation(id);
  assert.equal(evaluation.state, "failed");
  assert.equal(evaluation.failureCode, "evaluation.result_invalid");
  assert.equal(evaluation.revision, expectedRevision);
  assert.equal(evaluation.claimOwner, undefined);
  assert.equal(evaluation.claimToken, undefined);
  assert.equal(evaluation.claimExpiresAt, undefined);
  assert.equal(evaluation.nextAttemptAt, undefined);
  assert.equal(evaluation.completedAt, later);
  assert.deepEqual(f.store.listRunEvaluationGrades(id), []);
  return evaluation;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
