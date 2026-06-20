import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createProcedureObservationInputFromJob,
  createProcedureObservationJobKey,
  createSqliteRunStore,
  procedureObservationHasJobKey,
} from "../dist/index.js";

const now = "2026-06-20T00:00:00.000Z";

function observationInput(overrides = {}) {
  return {
    id: overrides.id ?? "procedure_observation_test",
    source: overrides.source ?? "explicit_user_request",
    signals: overrides.signals ?? ["save_as_skill"],
    title: overrides.title ?? "Reusable UI verification flow",
    summary: overrides.summary ?? "Capture the UI verification flow as a candidate.",
    normalizedGoal: overrides.normalizedGoal ?? "verify web ui change",
    positiveTriggers: overrides.positiveTriggers ?? ["web ui change verification"],
    negativeTriggers: overrides.negativeTriggers ?? ["docs-only change"],
    procedureSteps: overrides.procedureSteps ?? [
      { title: "Run typecheck", instruction: "Run the Web typecheck.", requiredTools: ["bash"] },
    ],
    validationSteps: overrides.validationSteps ?? [
      { title: "Playwright smoke", commandOrCheck: "corepack pnpm --filter @ling-stack/web exec playwright test", expectedResult: "Relevant tests pass." },
    ],
    sourceRefs: overrides.sourceRefs ?? [{ type: "manual", id: "manual_observation_1", label: "Manual observation" }],
    confidence: overrides.confidence ?? "high",
    reusableScore: overrides.reusableScore ?? 80,
  };
}

async function withStore(prefix, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      await fn(store, cwd);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("sqlite procedure observations persist route state and survive migration idempotency", async () => {
  await withStore("ling-stack-procedure-observation-", async (store, cwd) => {
    const observation = store.createProcedureObservation(observationInput(), now);

    assert.equal(observation.routeKind, "skill");
    assert.equal(observation.routeReasonCode, "repeatable_procedure_with_validation");
    assert.deepEqual(observation.routeBlockers, []);
    assert.equal(store.listProcedureObservations({ routeKind: "skill" }).length, 1);
    assert.equal(store.listProcedureObservations({ clusterId: observation.clusterId })[0].id, observation.id);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      const persisted = reopened.listProcedureObservations({ limit: 10 });
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].clusterId, observation.clusterId);
      assert.equal(persisted[0].routeKind, "skill");
    } finally {
      reopened.close();
    }
  });
});

test("procedure observation router blocks authority expansion before skill candidate generation", async () => {
  await withStore("ling-stack-procedure-observation-policy-", async (store) => {
    const observation = store.createProcedureObservation(observationInput({
      id: "procedure_observation_policy",
      title: "Use bash without asking next time",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
    }), now);

    assert.equal(observation.routeKind, "approval_policy_review");
    assert.deepEqual(observation.routeBlockers, ["permission_expansion"]);
  });
});

test("procedure observation job helper creates stable bounded observation input", () => {
  const input = {
    source: "manual_recording",
    signals: ["save_as_skill", "user_approved_recording"],
    runId: "run_job_helper",
    channelId: "channel_job_helper",
    userConfirmed: true,
    destinationHint: "skill",
    title: "Recorded UI verification flow",
    summary: "Record the UI verification flow from bounded metadata.",
    normalizedGoal: "verify ui changes",
    positiveTriggers: ["ui verification"],
    negativeTriggers: ["docs-only change"],
    toolLabels: ["bash"],
    validationLabels: ["web typecheck passed"],
  };

  const jobKey = createProcedureObservationJobKey(input);
  const built = createProcedureObservationInputFromJob(input);

  assert.equal(built.jobKey, jobKey);
  assert.equal(built.observationInput.source, "manual_recording");
  assert.equal(built.observationInput.runId, "run_job_helper");
  assert.equal(built.observationInput.procedureSteps[0].requiredTools[0], "bash");
  assert.equal(built.observationInput.validationSteps[0].title, "web typecheck passed");
  assert.equal(procedureObservationHasJobKey({ sourceRefs: built.observationInput.sourceRefs }, jobKey), true);
  assert.equal(built.observationInput.sourceRefs.some((ref) => ref.type === "observation-job"), true);
});
