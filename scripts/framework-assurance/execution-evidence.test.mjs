import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  adaptExecutionEvidence,
  loadExecutionEvidence,
  loadExecutionEvidenceBinding,
  parseExecutionEvidence,
  parseExecutionEvidenceBinding,
} from "./execution-evidence.mjs";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/framework-assurance/execution-evidence/", import.meta.url));
const evidence = loadExecutionEvidence(await readFile(`${fixtureRoot}valid.json`));
const binding = loadExecutionEvidenceBinding(await readFile(`${fixtureRoot}trusted-binding.json`));
const clone = value => structuredClone(value);
const errorCode = code => error => error?.code === code;

test("valid execution fixture binds to one Run, WorkUnit and Attempt and stays not_assessed", () => {
  const adapted = adaptExecutionEvidence(evidence, { binding });
  assert.equal(adapted.observation.evidenceKind, "fixture_replay");
  assert.equal(adapted.observation.executionStatus, "completed");
  assert.equal(adapted.observation.assessment, "not_assessed");
  assert.equal(adapted.observation.effectStatus, "confirmed");
  assert.deepEqual(adapted.lineage, {
    runId: "run-fixture-001",
    workUnitId: "work-unit-fixture-001",
    attemptId: "attempt-fixture-001",
    runtimeInstanceId: "runtime-fixture-001",
  });
  assert.equal(adapted.observedAt, evidence.observedAt);
  assert.ok(!JSON.stringify(adapted).includes("fence-fixture-001"));
  assert.ok(!JSON.stringify(adapted).includes("claimToken"));
});

test("replaying the same frozen evidence is idempotent and does not dispatch or mutate state", () => {
  const first = adaptExecutionEvidence(evidence, { binding });
  const second = adaptExecutionEvidence(evidence, { binding });
  assert.deepEqual(second, first);
});

for (const [name, mutate, code] of [
  ["sibling Run", value => { value.execution.runId = "run-sibling-001"; }, "evidence_lineage_mismatch"],
  ["sibling WorkUnit", value => { value.execution.workUnitId = "work-unit-sibling-001"; }, "evidence_lineage_mismatch"],
  ["old Attempt", value => { value.execution.attemptId = "attempt-old-001"; }, "evidence_stale_attempt"],
  ["old runtime instance", value => { value.execution.runtimeInstanceId = "runtime-old-001"; }, "evidence_stale_attempt"],
  ["old fencing token", value => { value.execution.fencingToken = "fence-old-001"; }, "evidence_stale_attempt"],
  ["changed Run snapshot revision", value => { value.snapshots.run.revision += 1; }, "evidence_snapshot_changed"],
  ["changed WorkUnit snapshot digest", value => { value.snapshots.workUnit.sha256 = "f".repeat(64); }, "evidence_snapshot_changed"],
  ["changed Attempt snapshot", value => { value.snapshots.attempt.sha256 = "f".repeat(64); }, "evidence_snapshot_changed"],
  ["missing artifact", value => { value.artifacts.pop(); }, "evidence_artifact_missing"],
  ["wrong artifact digest", value => { value.artifacts[0].contentSha256 = "f".repeat(64); }, "evidence_artifact_digest_mismatch"],
  ["unexpected artifact", value => { value.artifacts.push({ role: "extra", artifactId: "artifact-extra-001", contentSha256: "f".repeat(64) }); }, "evidence_artifact_unexpected"],
  ["lost claim", value => { value.execution.claimStatus = "expired"; }, "evidence_claim_lost"],
  ["held claim", value => { value.execution.claimStatus = "held"; }, "evidence_claim_lost"],
  ["unknown effects", value => { value.execution.effectStatus = "unknown"; }, "evidence_effect_unknown"],
  ["lost Attempt", value => { value.execution.attemptStatus = "lost"; }, "evidence_attempt_lost"],
  ["unfinished Attempt", value => { value.execution.attemptStatus = "started"; }, "evidence_execution_incomplete"],
  ["wrong task identity", value => { value.taskIdentity.taskId = "T02"; }, "evidence_input_mismatch"],
]) {
  test(`rejects ${name} without producing an observation`, () => {
    const candidate = clone(evidence);
    mutate(candidate);
    assert.throws(() => adaptExecutionEvidence(candidate, { binding }), errorCode(code));
  });
}

test("trusted binding has a separate closed shape and cannot carry candidate status or private fields", () => {
  assert.throws(() => parseExecutionEvidenceBinding({ ...clone(binding), claimToken: "private" }), errorCode("invalid_manifest"));
  assert.throws(() => parseExecutionEvidenceBinding({ ...clone(binding), execution: { ...binding.execution, attemptStatus: "succeeded" } }), errorCode("invalid_manifest"));
  assert.throws(() => parseExecutionEvidence({ ...clone(evidence), claimToken: "private" }), errorCode("invalid_manifest"));
});

test("execution fixture parser requires canonical observation time and bounded public evidence", () => {
  const invalidTime = clone(evidence);
  invalidTime.observedAt = "not-a-time";
  assert.throws(() => parseExecutionEvidence(invalidTime), errorCode("invalid_manifest"));
  const invalidDigest = clone(evidence);
  invalidDigest.artifacts[0].contentSha256 = "short";
  assert.throws(() => parseExecutionEvidence(invalidDigest), errorCode("invalid_manifest"));
});
