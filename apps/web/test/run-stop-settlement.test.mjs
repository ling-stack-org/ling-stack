import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalRunStop, isWorkUnitStopSettled } from "../src/lib/run-stop-settlement.ts";

function receipt() {
  return { cwd: "/workspace", workUnit: { id: "work", status: "cancelled", activeAttemptId: "attempt", linkedRunId: "run" },
    attempts: [{ id: "attempt", workUnitId: "work", status: "cancelled", runtimeInstanceId: "runtime", fencingToken: "1" }],
    stopEvidence: { schemaVersion: 1, workUnitId: "work", attempts: [{ attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "1",
      localExecution: "drained", effects: "settled" }] },
    run: { id: "run", status: "cancelled" }, leases: [], semaphoreSlots: [] };
}

test("stopping settles only after WorkUnit, original execution and resource receipts agree", () => {
  const detail = receipt();
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), true);
  for (const changed of [
    { ...detail, workUnit: { ...detail.workUnit, status: "cancelling" } },
    { ...detail, run: { ...detail.run, status: "running" } },
    { ...detail, run: undefined },
    { ...detail, run: { ...detail.run, id: "foreign" } },
    { ...detail, attempts: [] },
    { ...detail, attempts: [{ id: "attempt", workUnitId: "foreign", status: "cancelled" }] },
    { ...detail, attempts: [{ id: "attempt", workUnitId: "work", status: "started" }] },
    { ...detail, leases: [{ status: "active" }] },
    { ...detail, semaphoreSlots: [{ status: "active" }] },
  ]) assert.equal(isWorkUnitStopSettled(changed, "attempt"), false);
});

test("a removed active pointer does not erase the original Attempt confirmation requirement", () => {
  const detail = receipt();
  detail.workUnit.activeAttemptId = undefined;
  detail.attempts = [];
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), false);
  detail.attempts = [{ id: "attempt", workUnitId: "work", status: "yielded", runtimeInstanceId: "runtime", fencingToken: "1" }];
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), true);
  assert.equal(isWorkUnitStopSettled(detail, "other-attempt"), false);
});

test("terminal and resource receipts never substitute for exact Host and callback evidence", () => {
  const detail = receipt();
  const proof = detail.stopEvidence.attempts[0];
  for (const stopEvidence of [
    undefined,
    { ...detail.stopEvidence, schemaVersion: 2 },
    { ...detail.stopEvidence, workUnitId: "other-work" },
    { ...detail.stopEvidence, attempts: [] },
    ...["draining", "unverified"].map(localExecution => ({ ...detail.stopEvidence, attempts: [{ ...proof, localExecution }] })),
    ...["pending", "unknown", "unverified"].map(effects => ({ ...detail.stopEvidence, attempts: [{ ...proof, effects }] })),
    { ...detail.stopEvidence, attempts: [{ ...proof, attemptId: "successor" }] },
    { ...detail.stopEvidence, attempts: [{ ...proof, runtimeInstanceId: "successor-runtime" }] },
    { ...detail.stopEvidence, attempts: [{ ...proof, fencingToken: "2" }] },
    { ...detail.stopEvidence, attempts: [proof, proof] },
  ]) assert.equal(isWorkUnitStopSettled({ ...detail, stopEvidence }, "attempt"), false);
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), true);
});

test("safe yielded execution is not completion without an authoritative logical cancellation", () => {
  const detail = receipt();
  detail.run.status = "yielded";
  detail.attempts[0].status = "yielded";
  assert.equal(isTerminalRunStop(detail.run), false);
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), true);
  for (const status of ["waiting_for_input", "running", "failed", "succeeded"]) {
    detail.workUnit.status = status;
    assert.equal(isTerminalRunStop(detail.run, detail), false);
    assert.equal(isWorkUnitStopSettled(detail, "attempt"), false);
  }
});

test("standalone WorkUnits without a Run still require their Attempt and resources to settle", () => {
  const detail = receipt();
  delete detail.workUnit.linkedRunId;
  delete detail.run;
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), true);
  detail.semaphoreSlots = [{ status: "active" }];
  assert.equal(isWorkUnitStopSettled(detail, "attempt"), false);
});
