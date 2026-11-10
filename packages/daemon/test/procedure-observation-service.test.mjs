import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createProcedureObservationInputFromJob, createSqliteRunStore } from "@ling-stack/core";
import { processProcedureObservationJob } from "../dist/features/skills/procedure-observation-service.js";

const now = "2026-10-01T00:00:00.000Z";
const job = { source: "manual_recording", signals: ["save_as_skill", "user_approved_recording"], runId: "run_amber",
  channelId: "channel", userConfirmed: true, destinationHint: "skill", title: "Amber ledger reconciliation",
  summary: "Reconcile the amber ledger against its signed receipt.", normalizedGoal: "reconcile amber ledger",
  positiveTriggers: ["amber ledger reconciliation"], negativeTriggers: ["ledger has no signed receipt"],
  procedureSteps: [{ title: "Compare receipt totals", instruction: "Compare the amber ledger row total with its signed receipt total.",
    requiredTools: ["read"], expectedEvidence: "Both totals and the receipt source reference." }],
  validationSteps: [{ title: "Confirm equal totals", commandOrCheck: "Compare the two recorded totals", expectedResult: "Both totals agree." }] };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-observation-service-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  const published = [];
  const controlPlaneEvents = { publish(event) {
    assert.equal(database.prepare("SELECT count(*) AS n FROM control_plane_events WHERE seq = ?").get(event.seq).n, 1,
      "SSE notification must follow the durable transaction commit");
    published.push(event);
  } };
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, store, database, published,
    process(values = {}) { return processProcedureObservationJob({ cwd, store, controlPlaneEvents, job: { ...job, ...values }, now }); } };
}

test("manual and background callers share an idempotent candidate commit and post-commit notification", async t => {
  const f = await fixture(t);
  const first = f.process();
  assert.equal(first.body.action, "candidate_created");
  assert.equal(first.body.candidate.status, "pending");
  assert.equal(f.published.length, 1);
  const repeated = f.process({ id: "client_retry" });
  assert.equal(repeated.body.reusedObservation, true);
  assert.equal(repeated.body.observation.id, first.body.observation.id);
  assert.equal(f.store.listSkillCandidates().length, 1);
  assert.equal(f.store.listCandidateGenerationDecisions().length, 1);
  assert.equal(f.published.length, 1);
});

test("downstream failure commits no orphan observation, candidate, decision or notice", async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_generation_decision BEFORE INSERT ON candidate_generation_decisions BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END");
  assert.throws(() => f.process(), /synthetic commit failure/);
  for (const table of ["procedure_observations", "procedure_observation_jobs", "skill_candidates", "candidate_generation_decisions", "control_plane_events"]) {
    assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(f.published.length, 0);
  f.database.exec("DROP TRIGGER fail_generation_decision");
  assert.equal(f.process().body.action, "candidate_created", "retry must complete after the failed transaction");
});

test("legacy source replay is reused only for the same scope, without creating another candidate", async t => {
  const f = await fixture(t);
  const built = createProcedureObservationInputFromJob(job);
  f.store.createProcedureObservation({ ...built.observationInput, id: "legacy",
    sourceRefs: built.observationInput.sourceRefs.map(ref => ref.type === "observation-job" ? { ...ref, id: built.legacyJobKey } : ref) }, now);
  const same = f.process();
  assert.equal(same.body.reusedObservation, true); assert.equal(same.body.observation.id, "legacy");
  const other = f.process({ channelId: "other" });
  assert.equal(other.body.reusedObservation, false);
  assert.notEqual(other.body.observation.id, "legacy");
});

test("existing governance off/recording policy still stops generation in the shared service", async t => {
  const f = await fixture(t);
  const current = f.store.getWorkspaceSettings().skillGovernancePolicy;
  f.store.updateWorkspaceSettings({ skillGovernancePolicy: { ...current, generationMode: "off" } }, now);
  assert.equal(f.process().body.action, "evidence_recorded");
  assert.equal(f.store.listSkillCandidates().length, 0);
  f.store.updateWorkspaceSettings({ skillGovernancePolicy: { ...current, recordingMode: "disabled" } }, now);
  assert.equal(f.process({ runId: "another" }).body.error, "skill_recording_disabled");
  assert.equal(f.published.length, 0);
});
