import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveRuntimePaths } from "../dist/index.js";
import { SqliteRunEvaluationHumanStore } from "../dist/storage/sqlite/run-evaluation-human-store.js";
import { SqliteRunEvaluationTaskStore } from "../dist/storage/sqlite/run-evaluation-task-store.js";
import { SqliteRunEvaluationQaStore } from "../dist/storage/sqlite/run-evaluation-qa-store.js";
import { SqliteControlPlaneStore } from "../dist/storage/sqlite/control-plane-store.js";
import { humanFixture, binding, adjudicate, humanExpires } from "./support/evaluation-human-fixture.mjs";
import { now, later, sha, value } from "./support/evaluation-qa-fixture.mjs";

test("160 freezes an exact physical-pin payload, atomically consumes once and never changes137 grade/159 quota/source Run", async t => {
  const f = await humanFixture(t), before = f.counts(), runBefore = f.store.getRun(f.run.id);
  const intent = f.create();
  assert.equal(intent.payloadDigest, sha(JSON.stringify(intent.payload)));
  assert.deepEqual(intent.payload.artifactPins, f.humanPins);
  assert.deepEqual(intent.payload.rubric, f.humanRubric);
  assert.equal(intent.payload.expectedHeadRevision, 0);
  assert.ok(Object.isFrozen(intent.payload.submission.decision));
  assert.throws(() => { intent.payload.submission.decision.verdict = "fail"; }, TypeError);
  const settled = f.commit(intent);
  assert.equal(settled.intent.state, "consumed"); assert.equal(settled.head.revision, 1);
  assert.equal(settled.event.auditSeq, settled.audit.seq);
  assert.equal(settled.audit.entityId, settled.event.id);
  assert.deepEqual(f.store.listRunEvaluationHumanEvents({ taskId: f.humanEnrollment.taskId }), [settled.event]);
  const replay = f.store.commitRunEvaluationHumanIntent(f.commitInput(intent));
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.store.getRun(f.run.id), runBefore);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM control_plane_events WHERE entity_type='run_evaluation_human_event'").get().n, 1);
});

function humanCounts(f) {
  return Object.fromEntries(["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads", "control_plane_events", "control_plane_replay_state"].map(table => [table, f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
}
function directStore(f, options = {}) {
  const database = options.database ?? f.database;
  const artifact = options.artifact ?? (id => f.store.getArtifact(id));
  const tasks = new SqliteRunEvaluationTaskStore({ database }, { getRun: id => f.store.getRun(id), getRunEvaluation: id => f.store.getRunEvaluation(id), getArtifact: artifact });
  const qa = new SqliteRunEvaluationQaStore({ database }, tasks, f.cwd, artifact);
  return new SqliteRunEvaluationHumanStore({ database }, tasks, qa, options.controlPlane ?? new SqliteControlPlaneStore({ database }), artifact);
}
test("create retry keeps original expiry; changed task/submission/binding cannot replace exact request payload", async t => {
  const f = await humanFixture(t), input = f.createInput(), intent = f.create();
  const retry = f.store.createRunEvaluationHumanIntent({ ...input, now: "2026-10-10T00:01:10.000Z", expiresAt: "2026-10-10T00:04:00.000Z" });
  assert.equal(retry.replayed, true); assert.deepEqual(value(retry), intent);
  for (const changed of [ { taskId: "other-task" }, { binding: { ...binding, desktopEpoch: "changed" } }, { submission: { kind: "adjudicate", decision: { ...adjudicate.decision, verdict: "fail" } } } ]) assert.equal(f.store.createRunEvaluationHumanIntent({ ...input, ...changed }).code, "identity_conflict");
  assert.equal(f.store.createRunEvaluationHumanIntent({ ...input, now: humanExpires, expiresAt: "2026-10-10T00:04:00.000Z" }).code, "human_intent_expired");
  assert.equal(humanCounts(f).run_evaluation_human_intents, 1);
});
test("two connections freeze same absent head; only one intent can win its head CAS", async t => {
  const f = await humanFixture(t), second = f.open(), first = f.create("request-one"), other = f.create("request-two", adjudicate, second);
  const settled = f.commit(first);
  assert.equal(second.commitRunEvaluationHumanIntent(f.commitInput(other)).code, "human_head_changed");
  assert.equal(second.getRunEvaluationHumanIntent(other.id).state, "pending");
  assert.deepEqual(second.getRunEvaluationHumanHead(f.humanEnrollment.taskId), settled.head);
  assert.equal(humanCounts(f).run_evaluation_human_events, 1);
});
test("correct supersedes latest active event; revoke is append-only tombstone without falling back or promotion", async t => {
  const f = await humanFixture(t), before = f.counts(), initial = f.commit(f.create());
  const correction = { kind: "correct", supersedesEventId: initial.event.id, decision: { verdict: "fail", severity: "warning", rationale: "Synthetic correction" } };
  const intent = f.create("correct-request", correction), corrected = f.commit(intent);
  assert.equal(corrected.head.revision, 2); assert.deepEqual(f.store.getRunEvaluationHumanEvent(initial.event.id), initial.event);
  assert.equal(f.store.createRunEvaluationHumanIntent(f.createInput("stale-correction", correction)).code, "human_invalid_transition");
  const revoked = f.commit(f.create("revoke-request", { kind: "revoke", revokesEventId: corrected.event.id, rationale: "Synthetic withdrawal" }));
  assert.equal(revoked.head.state, "revoked"); assert.equal(revoked.head.revision, 3);
  assert.deepEqual(f.store.listRunEvaluationHumanEvents({ taskId: f.humanEnrollment.taskId, afterRevision: 1, limit: 1 }), [corrected.event]);
  assert.equal(f.store.createRunEvaluationHumanIntent(f.createInput("cannot-revive")).code, "human_invalid_transition");
  assert.equal(f.store.createRunEvaluationHumanIntent(f.createInput("cannot-revoke-again", { kind: "revoke", revokesEventId: revoked.event.id, rationale: "Again" })).code, "human_invalid_transition");
  const replay = value(f.store.commitRunEvaluationHumanIntent(f.commitInput(intent)));
  assert.equal(replay.head.state, "revoked"); assert.equal(replay.event.id, corrected.event.id);
  assert.deepEqual(f.counts(), before); assert.equal(humanCounts(f).run_evaluation_human_events, 3);
  assert.throws(() => f.database.prepare("UPDATE run_evaluation_human_events SET submission_json='{}' WHERE id=?").run(initial.event.id), /evaluation.human_invalid/u);
  assert.throws(() => f.database.prepare("DELETE FROM run_evaluation_human_events WHERE id=?").run(initial.event.id), /evaluation.human_invalid/u);
  assert.throws(() => f.database.prepare("DELETE FROM run_evaluation_human_heads WHERE task_id=?").run(f.humanEnrollment.taskId), /evaluation.human_invalid/u);
  assert.throws(() => f.database.prepare("DELETE FROM control_plane_events WHERE seq=?").run(initial.audit.seq), /FOREIGN KEY/u);
});
for (const field of Object.keys(binding)) test(`pending commit rejects exact ${field} drift without consume/event/audit`, async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f), input = f.commitInput(intent);
  input.binding[field] = "changed";
  assert.equal(f.store.commitRunEvaluationHumanIntent(input).code, "human_binding_changed");
  assert.deepEqual(humanCounts(f), before); assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
});
for (const kind of ["expired", "clock_rollback", "digest", "request", "confirmation_digest", "future_confirmation", "before_intent", "second_confirmation"]) test(`commit ${kind} fails closed; no partial authority`, async t => {
  const f = await humanFixture(t), intent = f.create(), input = f.commitInput(intent), before = humanCounts(f);
  if (kind === "expired") input.now = humanExpires;
  if (kind === "clock_rollback") input.now = now;
  if (kind === "digest") input.payloadDigest = "e".repeat(64);
  if (kind === "request") input.confirmation.requestId = "wrong-request";
  if (kind === "confirmation_digest") input.confirmation.payloadDigest = "f".repeat(64);
  if (kind === "future_confirmation") input.confirmation.confirmedAt = "2026-10-10T00:01:10.000Z";
  if (kind === "before_intent") input.confirmation.confirmedAt = now;
  if (kind === "second_confirmation") {
    f.commit(intent); input.now = "2026-10-10T00:01:10.000Z"; input.confirmation.confirmedAt = input.now;
  }
  const snapshot = humanCounts(f);
  assert.equal(f.store.commitRunEvaluationHumanIntent(input).ok, false);
  assert.deepEqual(humanCounts(f), kind === "second_confirmation" ? snapshot : before);
});
test("new real process boot cannot consume pending intent even replaying exact old Host binding", async t => {
  const f = await humanFixture(t), intent = f.create(), index = new URL("../dist/index.js", import.meta.url).href, input = f.commitInput(intent);
  delete input.assertAuthorityCurrent;
  const script = `import {createSqliteRunStore} from ${JSON.stringify(index)}; const s=createSqliteRunStore(${JSON.stringify(f.cwd)}); const result=s.commitRunEvaluationHumanIntent({...${JSON.stringify(input)},assertAuthorityCurrent:()=>{}}); console.log(JSON.stringify(result)); s.close();`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).code, "human_binding_changed");
  assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending"); assert.equal(humanCounts(f).run_evaluation_human_events, 0);
});
for (const field of ["suite", "case", "baseline", "candidate", "frozen", "config"]) test(`commit revalidates physical ${field} bytes after OS confirmation`, async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f), pin = field === "config" ? f.humanConfigPin : f.humanPins[field];
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ changed: field }), pin.artifactId);
  assert.equal(f.store.commitRunEvaluationHumanIntent(f.commitInput(intent)).code, "evaluation.artifact_invalid");
  assert.deepEqual(humanCounts(f), before);
});
test("missing QA enrollment and legacy fake rubric cannot mint human intent", async t => {
  const f = await humanFixture(t), old = f.enroll(), before = humanCounts(f);
  assert.equal(f.store.createRunEvaluationHumanIntent({ ...f.createInput(), taskId: "missing-task" }).code, "qa_not_enrolled");
  assert.equal(f.store.createRunEvaluationHumanIntent({ ...f.createInput(), taskId: old.taskId }).code, "human_rubric_invalid");
  assert.deepEqual(humanCounts(f), before);
});
for (const cut of ["audit", "event", "head", "consume"]) test(`160 fault at ${cut} rolls all consumption/head/event/audit/replay-state changes back`, async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f), replay = f.database.prepare("SELECT * FROM control_plane_replay_state").all();
  const targets = { audit: "BEFORE INSERT ON control_plane_events", event: "BEFORE INSERT ON run_evaluation_human_events", head: "BEFORE INSERT ON run_evaluation_human_heads", consume: "BEFORE UPDATE ON run_evaluation_human_intents" };
  f.database.exec(`CREATE TRIGGER human_inject ${targets[cut]} BEGIN SELECT RAISE(ABORT,'synthetic secret must not escape'); END`);
  assert.throws(() => f.commit(intent), error => error.message === "evaluation.task_invalid");
  assert.deepEqual(humanCounts(f), before); assert.deepEqual(f.database.prepare("SELECT * FROM control_plane_replay_state").all(), replay);
  assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
});
test("COMMIT fault rolls all durable facts back, leaves pending intent retryable", async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f);
  const wrapped = { prepare: sql => f.database.prepare(sql), exec: sql => { if (sql === "COMMIT;") throw new Error("synthetic"); return f.database.exec(sql); } };
  assert.throws(() => directStore(f, { database: wrapped }).commitRunEvaluationHumanIntent(f.commitInput(intent)), /evaluation.task_invalid/u);
  assert.deepEqual(humanCounts(f), before); assert.equal(f.database.isTransaction, false);
  assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
  assert.equal(f.commit(intent).head.revision, 1);
});
test("failed nested BEGIN preserves caller-owned transaction and unrelated writes", async t => {
  const f = await humanFixture(t), store = directStore(f), before = humanCounts(f);
  f.database.exec("BEGIN IMMEDIATE;");
  try {
    f.database.prepare("INSERT INTO schema_migrations VALUES(999,'caller-owned',?)").run(now);
    assert.throws(() => store.createRunEvaluationHumanIntent(f.createInput()), /transaction/u);
    assert.equal(f.database.prepare("SELECT name FROM schema_migrations WHERE version=999").get().name, "caller-owned");
    assert.deepEqual(humanCounts(f), before);
  } finally { f.database.exec("ROLLBACK;"); }
});
for (const cut of ["entry", "artifact", "audit", "final"]) test(`Host generation ${cut} rotation is rejected inside transaction before COMMIT`, async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f);
  let current = cut !== "entry", calls = 0;
  const controlPlane = new SqliteControlPlaneStore({ database: f.database });
  const store = directStore(f, {
    artifact: id => { if (cut === "artifact") current = false; return f.store.getArtifact(id); },
    controlPlane: { getControlPlaneEventByIdempotency: (...args) => controlPlane.getControlPlaneEventByIdempotency(...args), appendControlPlaneEventWithinTransaction: (...args) => { const event = controlPlane.appendControlPlaneEventWithinTransaction(...args); if (cut === "audit") current = false; return event; } },
  });
  const input = f.commitInput(intent);
  input.assertAuthorityCurrent = () => { calls++; if (cut === "final" && calls > 1) current = false; if (!current) throw new Error("old authority"); };
  assert.equal(store.commitRunEvaluationHumanIntent(input).code, "human_binding_changed");
  assert.deepEqual(humanCounts(f), before); assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
});
test("own-data validation refuses forged authority/getters/custom prototypes and never reads getter", async t => {
  const f = await humanFixture(t), input = f.createInput(); let reads = 0;
  assert.throws(() => f.store.createRunEvaluationHumanIntent({ ...input, get submission() { reads++; return adjudicate; } }), /evaluation.task_invalid/u);
  assert.equal(reads, 0);
  assert.throws(() => f.store.createRunEvaluationHumanIntent({ ...input, submission: { ...adjudicate, authenticated: true } }), /evaluation.task_invalid/u);
  assert.throws(() => f.store.createRunEvaluationHumanIntent({ ...input, binding: Object.assign(Object.create({}), binding) }), /evaluation.task_invalid/u);
  assert.throws(() => f.store.createRunEvaluationHumanIntent({ ...input, expiresAt: "2026-10-10T00:10:00.000Z" }), /evaluation.task_invalid/u);
  const intent = f.create(), commit = f.commitInput(intent);
  delete commit.assertAuthorityCurrent;
  assert.throws(() => f.store.commitRunEvaluationHumanIntent(commit), /evaluation.task_invalid/u);
});
for (const checker of [async () => {}, async () => { throw new Error("synthetic rejection"); }, () => ({ then: resolve => resolve() }), () => true]) test("private Host currentness must be synchronous undefined, not Promise/thenable/boolean", async t => {
  const f = await humanFixture(t), intent = f.create(), before = humanCounts(f), input = f.commitInput(intent);
  input.assertAuthorityCurrent = checker;
  assert.equal(f.store.commitRunEvaluationHumanIntent(input).code, "human_binding_changed");
  await Promise.resolve();
  assert.deepEqual(humanCounts(f), before); assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
});
for (const recursive of [0, 1]) test(`160 REPLACE cannot rewrite pending/consumed intents, events or revive tombstone with recursive_triggers=${recursive}`, async t => {
  const f = await humanFixture(t), intent = f.create();
  f.database.exec(`PRAGMA recursive_triggers=${recursive}`);
  assert.throws(() => f.database.prepare("INSERT OR REPLACE INTO run_evaluation_human_intents SELECT * FROM run_evaluation_human_intents WHERE id=?").run(intent.id), /evaluation.human_invalid/u);
  const initial = f.commit(intent), revoked = f.commit(f.create("revoke", { kind: "revoke", revokesEventId: initial.event.id, rationale: "Synthetic revoke" }));
  const before = humanCounts(f);
  for (const [table, key, id] of [["run_evaluation_human_intents", "id", intent.id], ["run_evaluation_human_events", "id", initial.event.id], ["run_evaluation_human_heads", "task_id", f.humanEnrollment.taskId]]) assert.throws(() => f.database.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE ${key}=?`).run(id), /evaluation.human_invalid/u);
  assert.deepEqual(f.store.getRunEvaluationHumanHead(f.humanEnrollment.taskId), revoked.head); assert.deepEqual(humanCounts(f), before);
});
test("input own-data snapshot cannot be rewritten by synchronous evidence callback", async t => {
  const f = await humanFixture(t), input = f.createInput(), store = directStore(f, { artifact: id => { input.submission.decision.verdict = "fail"; input.binding.desktopEpoch = "mutated"; return f.store.getArtifact(id); } });
  // Use a new DTO so this test never mutates the shared exported fixture decision.
  input.submission = JSON.parse(JSON.stringify(adjudicate)); input.binding = { ...binding };
  const intent = value(store.createRunEvaluationHumanIntent(input));
  assert.equal(intent.payload.submission.decision.verdict, "pass"); assert.equal(intent.payload.binding.desktopEpoch, "desktop-1");
  const commit = f.commitInput(intent), commitStore = directStore(f, { artifact: id => { commit.confirmation.payloadDigest = "e".repeat(64); return f.store.getArtifact(id); } });
  assert.equal(value(commitStore.commitRunEvaluationHumanIntent(commit)).event.confirmation.payloadDigest, intent.payloadDigest);
});
