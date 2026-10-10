import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore, digestRunEvaluationValue } from "../dist/index.js";
import { SqliteRunEvaluationHumanReadStore } from "../dist/storage/sqlite/run-evaluation-human-read-store.js";
import { SqliteRunEvaluationTaskStore } from "../dist/storage/sqlite/run-evaluation-task-store.js";
import { SqliteRunEvaluationQaStore } from "../dist/storage/sqlite/run-evaluation-qa-store.js";
import { SqliteControlPlaneStore } from "../dist/storage/sqlite/control-plane-store.js";
import { humanFixture } from "./support/evaluation-human-fixture.mjs";
import { now, sha, value } from "./support/evaluation-qa-fixture.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const refFor = (f, settled) => ({ taskId: f.humanEnrollment.taskId, eventId: settled.event.id, revision: settled.event.revision });
const unavailable = (result, reason) => assert.deepEqual(result, { status: "unavailable", reason });
function readStore(f, options = {}) {
  // Every getter and the snapshot use the very same connection; f.database is a second connection.
  const database = options.database ?? f.store.database;
  const artifact = options.artifact ?? (id => f.store.getArtifact(id));
  const tasks = new SqliteRunEvaluationTaskStore({ database }, {
    getRun: options.run ?? (id => f.store.getRun(id)),
    getRunEvaluation: options.evaluation ?? (id => f.store.getRunEvaluation(id)), getArtifact: artifact,
  });
  const qa = new SqliteRunEvaluationQaStore({ database }, tasks, f.cwd, artifact);
  const human = {
    getRunEvaluationHumanEvent: options.event ?? (id => f.store.getRunEvaluationHumanEvent(id)),
    getRunEvaluationHumanIntent: options.intent ?? (id => f.store.getRunEvaluationHumanIntent(id)),
    getRunEvaluationHumanHead: options.head ?? (id => f.store.getRunEvaluationHumanHead(id)),
  };
  return new SqliteRunEvaluationHumanReadStore({ database }, tasks, qa, human,
    options.audit ?? new SqliteControlPlaneStore({ database }), artifact);
}
function enrollHuman(f, ordinal, batch = f.humanBatch) {
  return value(f.store.enrollRunEvaluationQaTask({ ...f.enqueue, repeatOrdinal: ordinal,
    frozenGraderArtifact: f.humanPins.frozen, frozenGraderDigest: digestRunEvaluationValue(f.humanFrozen),
    artifactPins: f.humanPins, batchId: batch.id, reviewRef: "host-human-review:synthetic", now }));
}
function readFacts(f) {
  return {
    counts: f.counts(), run: f.store.getRun(f.run.id),
    scope: f.store.getRunEvaluationQaScope(),
    human: Object.fromEntries(["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads", "control_plane_events"].map(table => [table, f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n])),
    migrations: f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
    schema: f.database.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(),
  };
}

test("explicit QA metadata page and report source are available through the public trusted read ports", async t => {
  const f = await humanFixture(t), before = f.counts();
  const page = f.store.listRunEvaluationHumanEnrollments();
  assert.equal(page.items.length, 1); assert.equal(page.items[0].enrollmentId, f.humanEnrollment.id);
  const settled = f.commit(f.create());
  const read = f.store.readRunEvaluationHumanReportSource({ taskId: f.humanEnrollment.taskId, eventId: settled.event.id, revision: 1 });
  assert.equal(read.status, "available", JSON.stringify(read)); assert.equal(read.source.currentness, "current");
  assert.deepEqual(read.source.lineage.artifactPins, f.humanPins);
  assert.equal(read.source.audit.seq, settled.audit.seq); assert.equal(read.source.intent.payloadDigest, settled.intent.payloadDigest);
  assert.equal(read.source.head.eventId, settled.event.id); assert.ok(Object.isFrozen(read.source));
  assert.deepEqual(f.counts(), before);
});

test("unenrolled workspace returns an empty page without discovering ordinary content", async t => {
  const f = await humanFixture(t), other = createSqliteRunStore(`${f.cwd}/unenrolled`);
  t.after(() => other.close());
  assert.deepEqual(other.listRunEvaluationHumanEnrollments(), { schemaVersion: 1, items: [] });
  unavailable(other.readRunEvaluationHumanReportSource({ taskId: "ordinary", eventId: "missing", revision: 1 }), "qa_not_enrolled");
});

test("metadata page filters enrollment before LIMIT, includes every task state, never reads sealed evidence", async t => {
  const f = await humanFixture(t), states = ["queued", "active", "completed", "failed", "cancelled", "unknown_outcome"];
  const ordinary = [];
  for (let ordinal = 1; ordinal <= 110; ordinal++) ordinary.push(value(f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: ordinal })).id);
  const enrollments = [f.humanEnrollment, ...states.slice(1).map((_, index) => enrollHuman(f, index + 2))];
  // Only synthetic fixture task states are injected; this exercises the list projection, not transitions.
  for (let index = 1; index < states.length; index++) {
    f.claim(enrollments[index]);
    f.database.prepare("UPDATE run_evaluation_tasks SET state=?,completed_at=? WHERE id=?").run(states[index], states[index] === "active" ? null : now, enrollments[index].taskId);
  }
  let artifacts = 0;
  const reader = readStore(f, { artifact: () => { artifacts++; throw new Error("private sealed bytes"); } });
  const page = reader.listRunEvaluationHumanEnrollments({ limit: 50 });
  assert.equal(artifacts, 0); assert.equal(page.items.length, 6);
  assert.deepEqual(new Set(page.items.map(row => row.taskState)), new Set(states));
  assert.ok(page.items.every(row => !ordinary.includes(row.taskId)));
  assert.ok(Object.isFrozen(page.items)); assert.ok(Object.isFrozen(page.items[0]));
  const text = JSON.stringify(page);
  for (const excluded of [f.cwd, "canonicalWorkspaceCwd", "namespaceId", "artifactPins", "binding", "provider", "prompt", "log"]) assert.equal(text.includes(excluded), false);
});

test("keyset metadata pages are capped, ordered and do not duplicate enrolled rows across batches", async t => {
  const f = await humanFixture(t), secondBatch = value(f.store.createRunEvaluationQaBatch({ configSnapshotRef: f.humanConfigPin.artifactId, configDigest: digestRunEvaluationValue(f.humanConfig), now }));
  for (let ordinal = 2; ordinal <= 54; ordinal++) enrollHuman(f, ordinal, ordinal % 2 ? f.humanBatch : secondBatch);
  const first = f.store.listRunEvaluationHumanEnrollments(), capped = f.store.listRunEvaluationHumanEnrollments({ limit: 50 });
  assert.equal(first.items.length, 25); assert.equal(capped.items.length, 50);
  assert.equal(first.nextAfterEnrollmentId, first.items.at(-1).enrollmentId);
  const ids = []; let afterEnrollmentId;
  do {
    const page = f.store.listRunEvaluationHumanEnrollments({ limit: 7, ...(afterEnrollmentId ? { afterEnrollmentId } : {}) });
    ids.push(...page.items.map(row => row.enrollmentId)); afterEnrollmentId = page.nextAfterEnrollmentId;
  } while (afterEnrollmentId);
  assert.equal(ids.length, 54); assert.equal(new Set(ids).size, 54); assert.deepEqual(ids, [...ids].sort());
  assert.throws(() => f.store.listRunEvaluationHumanEnrollments({ afterEnrollmentId: "not-enrolled" }), /evaluation.task_invalid/u);
});

test("metadata and exact report DTOs reject overrides, getters and invalid bounds without reading them", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), ref = refFor(f, settled); let reads = 0;
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: undefined }, { cwd: f.cwd }, { namespaceId: "forged" }, { afterEnrollmentId: "" }, Object.create({})]) {
    assert.throws(() => f.store.listRunEvaluationHumanEnrollments(input), /evaluation.task_invalid/u);
  }
  assert.throws(() => f.store.listRunEvaluationHumanEnrollments({ get limit() { reads++; return 1; } }), /evaluation.task_invalid/u);
  for (const input of [{ ...ref, revision: 0 }, { ...ref, cwd: f.cwd }, { ...ref, reportDigest: "forged" }, { ...ref, eventId: "" }, Object.assign(Object.create({}), ref)]) {
    assert.throws(() => f.store.readRunEvaluationHumanReportSource(input), /evaluation.task_invalid/u);
  }
  assert.throws(() => f.store.readRunEvaluationHumanReportSource({ ...ref, get eventId() { reads++; return settled.event.id; } }), /evaluation.task_invalid/u);
  assert.equal(reads, 0);
});

test("exact refs never silently substitute another event, revision or unenrolled task", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), ref = refFor(f, settled), other = enrollHuman(f, 2);
  unavailable(f.store.readRunEvaluationHumanReportSource({ ...ref, eventId: "missing-event" }), "ref_not_found");
  unavailable(f.store.readRunEvaluationHumanReportSource({ ...ref, revision: 2 }), "ref_conflict");
  unavailable(f.store.readRunEvaluationHumanReportSource({ ...ref, taskId: other.taskId }), "ref_conflict");
  unavailable(f.store.readRunEvaluationHumanReportSource({ ...ref, taskId: "ordinary-task" }), "qa_not_enrolled");
  unavailable(readStore(f, { event: () => ({ ...settled.event, id: "substituted-event" }) }).readRunEvaluationHumanReportSource(ref), "lineage_invalid");
});

test("historical sources remain immutable and stale after correction/revoke; a revoked head never falls back", async t => {
  const f = await humanFixture(t), initial = f.commit(f.create()), ref = refFor(f, initial), before = f.store.readRunEvaluationHumanReportSource(ref);
  const corrected = f.commit(f.create("correct", { kind: "correct", supersedesEventId: initial.event.id,
    decision: { verdict: "fail", severity: "warning", rationale: "Synthetic correction" } }));
  const stale = f.store.readRunEvaluationHumanReportSource(ref);
  assert.equal(stale.status, "available"); assert.equal(stale.source.currentness, "stale");
  assert.deepEqual(stale.source.event, before.source.event); assert.deepEqual(stale.source.intent, before.source.intent);
  assert.deepEqual(stale.source.lineage, before.source.lineage); assert.deepEqual(stale.source.audit, before.source.audit);
  assert.equal(f.store.readRunEvaluationHumanReportSource(refFor(f, corrected)).source.currentness, "current");
  const revoked = f.commit(f.create("revoke", { kind: "revoke", revokesEventId: corrected.event.id, rationale: "Synthetic withdrawal" }));
  for (const settled of [initial, corrected, revoked]) {
    const read = f.store.readRunEvaluationHumanReportSource(refFor(f, settled));
    assert.equal(read.status, "available"); assert.equal(read.source.currentness, "stale");
    assert.deepEqual(read.source.head, { eventId: revoked.event.id, revision: 3, state: "revoked" });
  }
  assert.equal(f.store.listRunEvaluationHumanEnrollments().items[0].head.state, "revoked");
  assert.equal(before.source.currentness, "current");
});

for (const field of ["suite", "case", "baseline", "candidate", "frozen", "config"]) test(`source revalidates sealed physical ${field} bytes instead of trusting stored pin metadata`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), pin = field === "config" ? f.humanConfigPin : f.humanPins[field];
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ secret: "private-path-must-not-escape" }), pin.artifactId);
  unavailable(f.store.readRunEvaluationHumanReportSource(refFor(f, settled)), "artifact_invalid");
});

test("terminal source lineage drift is not mislabeled as a readable report or physical byte failure", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create());
  unavailable(readStore(f, { run: id => ({ ...f.store.getRun(id), status: "running" }) }).readRunEvaluationHumanReportSource(refFor(f, settled)), "lineage_invalid");
});

const intentDrifts = {
  state: intent => { intent.state = "pending"; delete intent.consumedAt; delete intent.consumedEventId; },
  consumed_event: intent => { intent.consumedEventId = "other-event"; },
  consumed_time: intent => { intent.consumedAt = now; },
  payload_digest: intent => { intent.payloadDigest = "e".repeat(64); },
  payload_bytes: intent => { intent.payload.rubric.instructions = "private changed instructions"; },
  expected_revision: intent => { intent.payload.expectedHeadRevision = 2; },
};
for (const [name, drift] of Object.entries(intentDrifts)) test(`source refuses consumed-intent ${name} drift with a fixed safe reason`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create());
  const reader = readStore(f, { intent: id => { const intent = clone(f.store.getRunEvaluationHumanIntent(id)); drift(intent); return intent; } });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, settled)), "lineage_invalid");
});
for (const field of ["requestId", "payloadDigest", "confirmedAt", "kind"]) test(`source refuses persisted confirmation ${field} drift`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create());
  const reader = readStore(f, { event: id => {
    const event = clone(f.store.getRunEvaluationHumanEvent(id));
    event.confirmation[field] = field === "payloadDigest" ? "e".repeat(64) : field === "confirmedAt" ? "2026-10-10T00:02:00.000Z" : "forged";
    return event;
  } });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, settled)), "lineage_invalid");
});

const auditDrifts = {
  seq: event => { event.seq++; }, workspace: event => { event.workspaceId = "other"; }, cwd: event => { event.cwd = "/private/not-exposed"; },
  timestamp: event => { event.ts = now; }, domain: event => { event.domain = "other"; }, entity_type: event => { event.entityType = "other"; },
  entity_id: event => { event.entityId = "other"; }, action: event => { event.action = "human_evaluation.correct"; },
  idempotency: event => { event.idempotencyKey = "other"; }, data: event => { event.data.intentId = "other"; },
  unknown_field: event => { event.privatePath = "/private/not-exposed"; }, missing_data: event => { delete event.data; },
};
for (const [name, drift] of Object.entries(auditDrifts)) test(`source checks actual durable audit ${name}, not only event.auditSeq`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), actual = new SqliteControlPlaneStore({ database: f.store.database });
  const reader = readStore(f, { audit: { getControlPlaneEventByIdempotency: (...args) => { const audit = clone(actual.getControlPlaneEventByIdempotency(...args)); drift(audit); return audit; } } });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, settled)), "audit_invalid");
});
test("missing audit and unreadable private SQLite error are fixed refusals, never raw diagnostics", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), ref = refFor(f, settled);
  unavailable(readStore(f, { audit: { getControlPlaneEventByIdempotency: () => undefined } }).readRunEvaluationHumanReportSource(ref), "audit_invalid");
  unavailable(readStore(f, { event: () => { throw new Error("/private/secret.sqlite missing credential"); } }).readRunEvaluationHumanReportSource(ref), "lineage_invalid");
});

test("latest head intent must match selected immutable report lineage even if its internal digest/audit agree", async t => {
  const f = await humanFixture(t), initial = f.commit(f.create());
  const corrected = f.commit(f.create("correct", { kind: "correct", supersedesEventId: initial.event.id, decision: { verdict: "fail", rationale: "Synthetic correction" } }));
  const intent = clone(corrected.intent); intent.payload.namespaceId = "forged-current-namespace"; intent.payloadDigest = sha(JSON.stringify(intent.payload));
  const event = clone(corrected.event); event.payloadDigest = intent.payloadDigest; event.confirmation.payloadDigest = intent.payloadDigest;
  const audit = clone(corrected.audit); audit.data.payloadDigest = intent.payloadDigest;
  const reader = readStore(f, {
    intent: id => id === intent.id ? intent : f.store.getRunEvaluationHumanIntent(id),
    event: id => id === event.id ? event : f.store.getRunEvaluationHumanEvent(id),
    audit: { getControlPlaneEventByIdempotency: (...args) => args[1] === audit.idempotencyKey ? audit : f.store.controlPlane.getControlPlaneEventByIdempotency(...args) },
  });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, initial)), "lineage_invalid");
});

const headDrifts = {
  task: head => { head.taskId = "other-task"; }, enrollment: head => { head.enrollmentId = "other-enrollment"; },
  evaluation: head => { head.evaluationId = "other-evaluation"; }, revision: head => { head.revision++; },
  state: head => { head.state = "revoked"; }, updated_at: head => { head.updatedAt = now; },
};
for (const [name, drift] of Object.entries(headDrifts)) test(`head ${name} drift cannot claim currentness or replace exact historical facts`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create());
  const reader = readStore(f, { head: id => { const head = clone(f.store.getRunEvaluationHumanHead(id)); drift(head); return head; } });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, settled)), "lineage_invalid");
});

const previousDrifts = {
  missing: () => undefined, id: event => ({ ...event, id: "other-event" }), task: event => ({ ...event, taskId: "other-task" }),
  enrollment: event => ({ ...event, enrollmentId: "other-enrollment" }), evaluation: event => ({ ...event, evaluationId: "other-evaluation" }),
  revision: event => ({ ...event, revision: 2 }),
  revoked: event => ({ ...event, submission: { kind: "revoke", revokesEventId: "earlier-event", rationale: "Synthetic" } }),
};
for (const [name, drift] of Object.entries(previousDrifts)) test(`correction verifies its preceding event ${name} rather than trusting the reference string`, async t => {
  const f = await humanFixture(t), initial = f.commit(f.create());
  const corrected = f.commit(f.create("correct", { kind: "correct", supersedesEventId: initial.event.id, decision: { verdict: "fail", rationale: "Synthetic correction" } }));
  const reader = readStore(f, { event: id => id === initial.event.id ? drift(initial.event) : f.store.getRunEvaluationHumanEvent(id) });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, corrected)), "lineage_invalid");
});

test("a stale historical read still validates the current head's actual durable audit", async t => {
  const f = await humanFixture(t), initial = f.commit(f.create());
  const revoked = f.commit(f.create("revoke", { kind: "revoke", revokesEventId: initial.event.id, rationale: "Synthetic withdrawal" }));
  const reader = readStore(f, { audit: { getControlPlaneEventByIdempotency: (...args) =>
    args[1] === revoked.audit.idempotencyKey ? undefined : f.store.controlPlane.getControlPlaneEventByIdempotency(...args) } });
  unavailable(reader.readRunEvaluationHumanReportSource(refFor(f, initial)), "audit_invalid");
});

test("one same-connection snapshot cannot combine old event facts with a concurrently committed correction", async t => {
  const f = await humanFixture(t), initial = f.commit(f.create()), second = f.open(), ref = refFor(f, initial);
  const correction = f.create("concurrent-correct", { kind: "correct", supersedesEventId: initial.event.id, decision: { verdict: "fail", rationale: "Concurrent synthetic correction" } }, second);
  const original = f.store.getArtifact.bind(f.store); let committed;
  f.store.getArtifact = id => { if (!committed) committed = f.commit(correction, second); return original(id); };
  const captured = f.store.readRunEvaluationHumanReportSource(ref);
  assert.equal(captured.status, "available"); assert.equal(captured.source.currentness, "current"); assert.equal(captured.source.head.eventId, initial.event.id);
  assert.equal(committed.head.revision, 2);
  const next = f.store.readRunEvaluationHumanReportSource(ref);
  assert.equal(next.status, "available"); assert.equal(next.source.currentness, "stale"); assert.equal(next.source.head.eventId, committed.event.id);
});

test("one same-connection snapshot cannot combine existing byte pins with a concurrent sealed-byte rewrite", async t => {
  const f = await humanFixture(t), initial = f.commit(f.create()), ref = refFor(f, initial), original = f.store.getArtifact.bind(f.store); let changed = false;
  f.store.getArtifact = id => {
    if (!changed) { changed = true; f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ changed: "candidate" }), f.humanPins.candidate.artifactId); }
    return original(id);
  };
  assert.equal(f.store.readRunEvaluationHumanReportSource(ref).status, "available");
  unavailable(f.store.readRunEvaluationHumanReportSource(ref), "artifact_invalid");
});

test("query_only rejects a write through a synchronous read callback and restores the caller setting", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), original = f.store.getArtifact.bind(f.store), before = readFacts(f); let refused = 0;
  f.store.getArtifact = id => {
    assert.throws(() => f.store.database.prepare("INSERT INTO schema_migrations VALUES(999,'forbidden-read-write',?)").run(now), /readonly/u); refused++;
    return original(id);
  };
  assert.equal(f.store.readRunEvaluationHumanReportSource(refFor(f, settled)).status, "available");
  assert.ok(refused >= 6); assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
  assert.deepEqual(readFacts(f), before);
});

test("an unrelated caller transaction is neither adopted nor committed/rolled back by report reads", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), database = f.store.database;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO schema_migrations VALUES(999,'caller-owned',?)").run(now);
    unavailable(f.store.readRunEvaluationHumanReportSource(refFor(f, settled)), "read_failed");
    assert.equal(database.isTransaction, true); assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=999").get().name, "caller-owned");
    assert.equal(database.prepare("PRAGMA query_only").get().query_only, 0);
  } finally { database.exec("ROLLBACK"); }
});

test("a preexisting query_only setting remains enabled after both metadata and report reads", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), database = f.store.database;
  database.exec("PRAGMA query_only=ON");
  assert.equal(f.store.listRunEvaluationHumanEnrollments().items.length, 1);
  assert.equal(f.store.readRunEvaluationHumanReportSource(refFor(f, settled)).status, "available");
  assert.equal(database.prepare("PRAGMA query_only").get().query_only, 1);
});

for (const phase of ["BEGIN DEFERRED", "COMMIT"]) test(`${phase} read fault cleans up only its own transaction and cannot leak source`, async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), underlying = f.store.database;
  const database = { prepare: sql => underlying.prepare(sql), exec: sql => { if (sql === phase) throw new Error("/private/secret.sqlite read fault"); return underlying.exec(sql); } };
  unavailable(readStore(f, { database }).readRunEvaluationHumanReportSource(refFor(f, settled)), "read_failed");
  assert.equal(underlying.isTransaction, false); assert.equal(underlying.prepare("PRAGMA query_only").get().query_only, 0);
  assert.equal(f.store.readRunEvaluationHumanReportSource(refFor(f, settled)).status, "available");
});

test("metadata/report reads change no source Run, quota, grade, human authority, schema or migration", async t => {
  const f = await humanFixture(t), settled = f.commit(f.create()), before = readFacts(f);
  for (let iteration = 0; iteration < 3; iteration++) {
    f.store.listRunEvaluationHumanEnrollments({ limit: 1 });
    const read = f.store.readRunEvaluationHumanReportSource(refFor(f, settled));
    assert.equal(read.status, "available");
    const text = JSON.stringify(read);
    for (const excluded of [f.cwd, "canonicalWorkspaceCwd", "namespaceId", "osSessionId", "osUserId", "daemonEpoch", "lockEpoch", "sealedPayload", "authority\":\"authentic", "promoted"]) assert.equal(text.includes(excluded), false);
    assert.throws(() => { read.source.lineage.artifactPins.suite.artifactId = "rewritten"; }, TypeError);
  }
  assert.deepEqual(readFacts(f), before);
});
