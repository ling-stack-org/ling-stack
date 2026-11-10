import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HumanEvaluationDesktopAuthority } from "../dist/features/harness/evaluations/human-evaluation-authority.js";
import { HumanEvaluationService } from "../dist/features/harness/evaluations/human-evaluation-service.js";
import { handleHumanEvaluationDesktopRoute } from "../dist/features/harness/evaluations/human-evaluation-routes.js";
import { readHumanEvaluationList, readHumanEvaluationReport } from "../dist/features/harness/evaluations/human-evaluation-protocol.js";
import { fixture, now } from "./fixtures/run-evaluation-qa-model.mjs";
import { createHumanEvaluationDaemonClient, signHumanEvaluationConfirmation } from "./fixtures/human-evaluation-main-source.mjs";

const submission = { kind: "adjudicate", decision: { verdict: "pass", rationale: "Explicit synthetic QA review." } };
const session = cwd => ({ platform: "darwin", desktopInstanceId: "qa-main", desktopEpoch: "qa-desktop-epoch",
  workspaceCwd: cwd, session: { osSessionId: "qa-session", osUserId: "qa-user", lockEpoch: "qa-lock-epoch", locked: false } });
async function readFixture(t) {
  const f = await fixture(t, "http://127.0.0.1:1/v1");
  const authority = new HumanEvaluationDesktopAuthority({ workspaceCwd: f.cwd, daemonEpoch: "qa-daemon-epoch" });
  let store = f.store;
  const service = new HumanEvaluationService({ authority, getStore: () => store, events: { publish() {} }, clock: () => now });
  t.after(() => service.close());
  const connection = service.handshake(session(f.cwd));
  const commit = (value = submission, requestId = "qa-request") => {
    const created = service.createIntent({ authority: connection.authority, taskId: f.task.id, requestId, submission: value });
    assert.equal(created.accepted, true);
    const confirmation = { kind: "macos_device_owner_authentication", requestId,
      payloadDigest: created.intent.payloadDigest, confirmedAt: now };
    const committed = service.commit({ authority: connection.authority, intentId: created.intent.id, confirmation,
      signature: signHumanEvaluationConfirmation(connection, created.intent.id, confirmation) });
    assert.equal(committed.accepted, true); return committed;
  };
  return { ...f, authority, service, connection, commit, setStore: value => { store = value; } };
}
const ref = committed => ({ taskId: committed.event.taskId, eventId: committed.event.id, revision: committed.event.revision });
const count = f => f.database.prepare("SELECT (SELECT count(*) FROM run_evaluation_human_events) events,(SELECT count(*) FROM run_evaluation_human_intents) intents").get();

test("private list pages only explicit QA enrollment metadata and includes rows without a human head", async t => {
  const f = await readFixture(t), second = f.enroll(2);
  f.store.createTask({ channelId: f.run.taskId ? f.store.getTask(f.run.taskId).channelId : undefined,
    title: "Ordinary un-enrolled task", prompt: "private ordinary content must not be projected" }, now);
  const first = f.service.list({ authority: f.connection.authority, limit: 1 });
  assert.equal(first.accepted, true); assert.equal(first.canonicalWorkspaceCwd, f.authority.workspaceCwd);
  assert.equal(first.items.length, 1); assert.equal(first.items[0].head, undefined);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ["caseId", "caseVersion", "createdAt", "enrollmentId", "evaluationId", "suiteId", "suiteVersion", "taskId", "taskState"].sort());
  const next = f.service.list({ authority: f.connection.authority, afterEnrollmentId: first.nextAfterEnrollmentId, limit: 1 });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0].taskId, first.items[0].taskId);
  assert.deepEqual(new Set([next.items[0].taskId, first.items[0].taskId]), new Set([f.task.id, second.id]));
  assert.equal(JSON.stringify(first).includes("private ordinary"), false);
});

test("report generation is read-only, exact-ref and immutable across correction/revocation", async t => {
  const f = await readFixture(t), first = f.commit();
  const before = count(f), sourceEvaluation = f.store.getRunEvaluation(f.evaluation.id);
  const report = f.service.report({ authority: f.connection.authority, ...ref(first) });
  assert.equal(report.accepted, true); assert.equal(report.currentness, "current");
  assert.equal(report.report.authority, "report-only");
  assert.ok(Object.isFrozen(report.report.lineage.artifactPins));
  assert.equal(report.report.audit.seq, first.event.auditSeq);
  assert.equal(report.report.intent.payloadDigest, first.intent.payloadDigest);
  assert.deepEqual(count(f), before); assert.deepEqual(f.store.getRunEvaluation(f.evaluation.id), sourceEvaluation);
  const corrected = f.commit({ kind: "correct", supersedesEventId: first.event.id,
    decision: { verdict: "fail", rationale: "Explicit correction." } }, "qa-correct");
  const old = f.service.report({ authority: f.connection.authority, ...ref(first) });
  assert.equal(old.currentness, "stale"); assert.equal(old.report.reportDigest, report.report.reportDigest);
  assert.deepEqual(old.report, report.report);
  f.commit({ kind: "revoke", revokesEventId: corrected.event.id, rationale: "Explicit revocation." }, "qa-revoke");
  assert.equal(f.service.report({ authority: f.connection.authority, ...ref(first) }).currentness, "stale");
  assert.equal(f.service.report({ authority: f.connection.authority, ...ref(first), revision: 2 }).accepted, false);
  assert.equal(f.service.report({ authority: f.connection.authority, ...ref(first), taskId: "other-task" }).accepted, false);
  for (const key of ["binding", "osUserId", "confirmationKey", "canonicalWorkspaceCwd", "namespaceId"]) {
    assert.equal(JSON.stringify(report.report).includes(`"${key}"`), false);
  }
});

test("inspect report currentness revalidates sealed pins, not only a still-matching head", async t => {
  const f = await readFixture(t), committed = f.commit(), reportRef = ref(committed);
  const request = { authority: f.connection.authority, taskId: f.task.id, reportRef };
  const original = f.service.report({ authority: f.connection.authority, ...reportRef });
  assert.equal(f.service.snapshot(request).reportCurrentness, "current");
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ changed: "owned synthetic artifact" }), f.artifactPins.candidate.artifactId);
  const snapshot = f.service.snapshot(request);
  assert.equal(snapshot.accepted, true); assert.equal(snapshot.head.eventId, reportRef.eventId);
  assert.equal(snapshot.reportCurrentness, "unavailable");
  assert.equal(f.service.report({ authority: f.connection.authority, ...reportRef }).accepted, false);
  assert.equal(original.report.ref.eventId, reportRef.eventId);
});

for (const action of ["list", "report"]) {
  test(`${action} rejects epoch replacement/revocation and Store callback reentry`, async t => {
    const f = await readFixture(t), committed = f.commit();
    const request = { authority: f.connection.authority, ...(action === "report" ? ref(committed) : {}) };
    const method = action === "list" ? "listRunEvaluationHumanEnrollments" : "readRunEvaluationHumanReportSource";
    f.setStore(new Proxy(f.store, { get(target, key) {
      if (key === method) return (...args) => {
        const result = target[method](...args); f.authority.revoke(f.connection.authority); return result;
      };
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } }));
    assert.deepEqual(f.service[action](request), { accepted: false, reason: "human_binding_changed" });
    assert.deepEqual(f.service[action](request), { accepted: false, reason: "human_binding_changed" });
  });
}

test("list/report strict private DTOs reject scope/auth/grade smuggling and invalid bounds", async t => {
  const f = await readFixture(t), authority = f.connection.authority;
  for (const extra of [{ workspaceCwd: f.cwd }, { namespaceId: "other" }, { authenticated: true }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }]) {
    assert.throws(() => readHumanEvaluationList({ authority, ...extra }));
  }
  for (const extra of [{ grade: "pass" }, { adjudicator: "human" }, { revision: 0 }, { revision: 1.5 }]) {
    assert.throws(() => readHumanEvaluationReport({ authority, taskId: f.task.id, eventId: "event", revision: 1, ...extra }));
  }
  let reads = 0;
  assert.throws(() => readHumanEvaluationList(Object.defineProperty({ authority }, "limit", { get() { reads++; return 1; } })));
  assert.equal(reads, 0);
});

test("actual Main source private HTTP list/report roundtrip; no public/CORS/Mobile equivalent", async t => {
  const f = await readFixture(t);
  const server = createServer(async (request, response) => {
    await handleHumanEvaluationDesktopRoute(request, response, { humanEvaluations: f.service,
      desktopBridgeToken: "owned-bridge", config: { maxBodyBytes: 65_536 } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, signal = new AbortController().signal;
  const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: base, bridgeToken: "owned-bridge" });
  const connection = await client.handshake(session(f.cwd), signal);
  const page = await client.list({ authority: connection.authority, limit: 25 }, signal);
  assert.equal(page.items[0].taskId, f.task.id); assert.equal(page.canonicalWorkspaceCwd, f.authority.workspaceCwd);
  const intent = await client.intent({ authority: connection.authority, taskId: f.task.id, requestId: "http-review", submission }, signal);
  const confirmation = { kind: "macos_device_owner_authentication", requestId: "http-review", payloadDigest: intent.payloadDigest, confirmedAt: now };
  const committed = await client.commit({ authority: connection.authority, intentId: intent.id, confirmation,
    signature: signHumanEvaluationConfirmation(connection, intent.id, confirmation) }, signal);
  const report = await client.report({ authority: connection.authority, taskId: f.task.id, eventId: committed.event.id, revision: committed.head.revision }, signal);
  assert.equal(report.currentness, "current"); assert.equal(report.report.authority, "report-only");
  const reportRef = { taskId: f.task.id, eventId: committed.event.id, revision: committed.head.revision };
  assert.equal((await client.snapshot({ authority: connection.authority, taskId: f.task.id, reportRef }, signal)).reportCurrentness, "current");
  for (const action of ["list", "report"]) {
    for (const [path, headers, status] of [
      [`/harness/evaluations/human/desktop/${action}`, {}, 403],
      [`/harness/evaluations/human/${action}`, { "X-Ling-Desktop-Bridge-Token": "owned-bridge" }, 404],
      [`/harness/evaluations/human/desktop/${action}`, { "X-Ling-Desktop-Bridge-Token": "owned-bridge", Origin: "http://localhost" }, 403],
    ]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, status); assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  }
});
