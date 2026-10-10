import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServer } from "../dist/index.js";
import { HumanEvaluationDesktopAuthority } from "../dist/features/harness/evaluations/human-evaluation-authority.js";
import { HumanEvaluationService } from "../dist/features/harness/evaluations/human-evaluation-service.js";
import { handleHumanEvaluationDesktopRoute } from "../dist/features/harness/evaluations/human-evaluation-routes.js";
import { humanEvaluationConfirmationBytes, readHumanEvaluationCommit, readHumanEvaluationIntentInput,
  readHumanEvaluationHandshake } from "../dist/features/harness/evaluations/human-evaluation-protocol.js";
import { fixture, now } from "./fixtures/run-evaluation-qa-model.mjs";
// Node >=22.18 strips this actual Main source; standalone Daemon CI need not
// build an Electron app to exercise the exact production client/signing code.
import { createHumanEvaluationDaemonClient, signHumanEvaluationConfirmation }
  from "../../../apps/desktop/main/human-evaluation/daemon-client.ts";

const root = "/harness/evaluations/human/desktop";
const decision = { verdict: "pass", score: 0.9, severity: "info", rationale: "Explicit reviewed QA verdict." };
const submission = { kind: "adjudicate", decision };
const mainSession = cwd => ({ platform: "darwin", desktopInstanceId: "owned-test-main", desktopEpoch: "main-epoch-1",
  workspaceCwd: cwd, session: { osSessionId: "owned-test-session", osUserId: "owned-test-user", lockEpoch: "unlocked-1", locked: false } });

async function humanFixture(t) {
  // Configuration/QA enrollment only; this fixture never sends a model request.
  const f = await fixture(t, "http://127.0.0.1:1/v1");
  const authority = new HumanEvaluationDesktopAuthority({ workspaceCwd: f.cwd, daemonEpoch: "daemon-epoch-1" });
  let time = now;
  let getStore = () => f.store;
  const published = [];
  let publish = event => {
    assert.ok(f.store.getRunEvaluationHumanEvent(event.entityId));
    published.push(event);
  };
  const service = new HumanEvaluationService({ authority, getStore: () => getStore(),
    events: { publish: event => publish(event) }, clock: () => time });
  t.after(() => service.close());
  const handshake = service.handshake(mainSession(f.cwd));
  const create = (requestId = "human-request-1", nextSubmission = submission, current = handshake) =>
    service.createIntent({ authority: current.authority, taskId: f.task.id, requestId, submission: nextSubmission });
  const signed = (intent, current = handshake, confirmedAt = time) => {
    const confirmation = { kind: "macos_device_owner_authentication", requestId: intent.payload.requestId,
      payloadDigest: intent.payloadDigest, confirmedAt };
    return { authority: current.authority, intentId: intent.id, confirmation,
      signature: createHmac("sha256", Buffer.from(current.confirmationKey, "base64url"))
        .update(humanEvaluationConfirmationBytes(current.authority, intent.id, confirmation)).digest("hex") };
  };
  return { ...f, authority, service, handshake, create, signed, published,
    setTime: value => { time = value; }, setStore: callback => { getStore = callback; },
    setPublish: callback => { publish = callback; } };
}

test("private handshake issues no human sample; bridge provenance alone cannot commit", async t => {
  const f = await humanFixture(t);
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
  assert.deepEqual(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }), []);
  const result = f.create();
  assert.equal(result.accepted, true);
  assert.equal(result.intent.state, "pending");
  const forged = f.signed(result.intent);
  forged.signature = "0".repeat(64);
  assert.equal(f.service.commit(forged).reason, "human_confirmation_invalid");
  assert.equal(f.store.getRunEvaluationHumanIntent(result.intent.id).state, "pending");
  assert.equal(f.published.length, 0);
});

test("exact signed confirmation commits one real head/event/audit; replay publishes no duplicate", async t => {
  const f = await humanFixture(t);
  const created = f.create();
  assert.equal(created.accepted, true);
  const result = f.service.commit(f.signed(created.intent));
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.intent.state, "consumed");
  assert.equal(result.head.revision, 1);
  assert.equal(result.head.state, "active");
  assert.equal(result.event.payloadDigest, created.intent.payloadDigest);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].seq, result.audit.seq);
  const replay = f.service.commit(f.signed(created.intent));
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 1);
  assert.equal(f.published.length, 1);
});

test("correct and revoke are append-only transitions, not edits to original facts", async t => {
  const f = await humanFixture(t);
  const first = f.service.commit(f.signed(f.create().intent));
  assert.equal(first.accepted, true);
  const correction = f.create("human-correct", { kind: "correct", supersedesEventId: first.event.id,
    decision: { ...decision, verdict: "fail", severity: "error", rationale: "Corrected QA decision." } });
  assert.equal(correction.accepted, true);
  const corrected = f.service.commit(f.signed(correction.intent));
  assert.equal(corrected.accepted, true);
  assert.equal(corrected.head.revision, 2);
  const revoked = f.service.commit(f.signed(f.create("human-revoke", { kind: "revoke",
    revokesEventId: corrected.event.id, rationale: "Withdraw the reviewed QA label." }).intent));
  assert.equal(revoked.accepted, true);
  assert.equal(revoked.head.state, "revoked");
  assert.equal(revoked.head.revision, 3);
  assert.equal(f.store.getRunEvaluationHumanEvent(first.event.id).submission.decision.verdict, "pass");
  assert.equal(f.store.getRunEvaluationHumanEvent(corrected.event.id).submission.decision.verdict, "fail");
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 3);
  assert.equal(f.published.length, 3);
});

test("one OS proof is payload-bound and cannot authenticate another intent, identity or epoch", async t => {
  const f = await humanFixture(t);
  const first = f.create("human-one").intent;
  const second = f.create("human-two", { kind: "adjudicate", decision: { ...decision, rationale: "Different final payload." } }).intent;
  for (const change of [
    signed => { signed.intentId = second.id; },
    signed => { signed.confirmation.payloadDigest = second.payloadDigest; },
    signed => { signed.confirmation.requestId = "other-request"; },
    signed => { signed.confirmation.confirmedAt = "2026-10-10T00:01:01.000Z"; },
    signed => { signed.authority = { ...signed.authority, osUserId: "different-user" }; },
    signed => { signed.authority = { ...signed.authority, lockEpoch: "locked-2" }; },
    signed => { signed.authority = { ...signed.authority, desktopInstanceId: "different-main" }; },
    signed => { signed.authority = { ...signed.authority, daemonEpoch: "other-boot" }; },
  ]) {
    const signed = structuredClone(f.signed(first));
    change(signed);
    assert.equal(f.service.commit(signed).accepted, false);
  }
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
  assert.equal(f.published.length, 0);
});

test("authority rotation and exact revocation fence old intents without retiring a replacement", async t => {
  const f = await humanFixture(t);
  const old = f.create().intent;
  const next = f.service.handshake({ ...mainSession(f.cwd), desktopEpoch: "main-epoch-2" });
  assert.notEqual(next.confirmationKey, f.handshake.confirmationKey);
  assert.notEqual(next.authority.connectionEpoch, f.handshake.authority.connectionEpoch);
  assert.equal(f.service.commit(f.signed(old)).accepted, false);
  assert.equal(f.service.revokeAuthority({ authority: f.handshake.authority }).accepted, false);
  assert.equal(f.authority.isCurrent(next.authority), true);
  assert.equal(f.service.revokeAuthority({ authority: next.authority }).accepted, true);
  assert.equal(f.authority.isCurrent(next.authority), false);
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
});

test("new Daemon boot, closed service, session switches and expiry cannot consume old intent", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  assert.equal(Date.parse(intent.payload.expiresAt) - Date.parse(intent.createdAt), 120_000);
  const otherAuthority = new HumanEvaluationDesktopAuthority({ workspaceCwd: f.cwd, daemonEpoch: "new-daemon-boot" });
  const other = new HumanEvaluationService({ authority: otherAuthority, getStore: () => f.store,
    events: { publish() { assert.fail("old intent must not publish"); } }, clock: () => now });
  t.after(() => other.close());
  other.handshake(mainSession(f.cwd));
  assert.equal(other.commit(f.signed(intent)).accepted, false);
  f.setTime(intent.payload.expiresAt);
  assert.equal(f.service.commit(f.signed(intent, f.handshake, now)).reason, "human_intent_expired");
  // A backward RTC read does not restore a previously expired intent.
  f.setTime(now);
  assert.equal(f.service.commit(f.signed(intent)).reason, "human_intent_expired");
  f.service.close();
  assert.throws(() => f.service.handshake(mainSession(f.cwd)));
  assert.equal(f.service.commit(f.signed(intent)).accepted, false);
});

test("Store/clock reentry and inside-transaction authority changes fail closed", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  f.setStore(() => {
    f.service.revokeAuthority({ authority: f.handshake.authority });
    return f.store;
  });
  assert.equal(f.service.commit(f.signed(intent)).reason, "human_binding_changed");
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
  f.setStore(() => f.store);
  const next = f.service.handshake(mainSession(f.cwd));
  const nextIntent = f.create("human-after-reentry", submission, next).intent;
  const original = f.store.commitRunEvaluationHumanIntent.bind(f.store);
  let transactionFenceCalls = 0;
  f.store.commitRunEvaluationHumanIntent = input => {
    const checked = { ...input, assertAuthorityCurrent() {
      if (++transactionFenceCalls === 2) f.service.revokeAuthority({ authority: next.authority });
      input.assertAuthorityCurrent();
    } };
    return original(checked);
  };
  assert.equal(f.service.commit(f.signed(nextIntent, next)).reason, "human_binding_changed");
  assert.equal(transactionFenceCalls, 2);
  assert.equal(f.store.getRunEvaluationHumanIntent(nextIntent.id).state, "pending");
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 0);
});

test("head conflict rejects a second differently confirmed pending intent", async t => {
  const f = await humanFixture(t);
  const one = f.create("human-race-one").intent;
  const two = f.create("human-race-two", { kind: "adjudicate", decision: { ...decision, verdict: "fail" } }).intent;
  assert.equal(f.service.commit(f.signed(one)).accepted, true);
  assert.equal(f.service.commit(f.signed(two)).reason, "human_head_changed");
  assert.equal(f.store.getRunEvaluationHumanIntent(two.id).state, "pending");
  assert.equal(f.published.length, 1);
});

test("expiry advancing inside the real terminal transaction rolls back late consumption", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  const original = f.store.commitRunEvaluationHumanIntent.bind(f.store);
  let fences = 0;
  f.store.commitRunEvaluationHumanIntent = input => original({ ...input, assertAuthorityCurrent() {
    if (++fences === 2) f.setTime(intent.payload.expiresAt);
    input.assertAuthorityCurrent();
  } });
  assert.equal(f.service.commit(f.signed(intent)).accepted, false);
  assert.equal(fences, 2);
  assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 0);
  assert.equal(f.published.length, 0);
});

test("exact intent request replay retains its original expiry rather than extending authorization", async t => {
  const f = await humanFixture(t);
  const one = f.create("human-idempotent");
  assert.equal(one.accepted, true);
  f.setTime("2026-10-10T00:01:30.000Z");
  const replay = f.create("human-idempotent");
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intent.id, one.intent.id);
  assert.equal(replay.intent.payload.expiresAt, one.intent.payload.expiresAt);
  f.setTime(one.intent.payload.expiresAt);
  assert.equal(f.create("human-idempotent").accepted, false);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 0);
});

test("synchronous commit reentry is busy and cannot nest another human transaction", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  const signed = f.signed(intent);
  const original = f.store.commitRunEvaluationHumanIntent.bind(f.store);
  let reentry;
  f.store.commitRunEvaluationHumanIntent = input => {
    reentry = f.service.commit(signed);
    return original(input);
  };
  const result = f.service.commit(signed);
  assert.equal(reentry.reason, "evaluation_human_busy");
  assert.equal(result.accepted, true);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 1);
  assert.equal(f.published.length, 1);
});

test("postcommit SSE delivery failure does not misreport durable settlement or duplicate audit", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  f.setPublish(() => { throw new Error("owned-test-publish-failure"); });
  const result = f.service.commit(f.signed(intent));
  assert.equal(result.accepted, true);
  assert.ok(f.store.getRunEvaluationHumanEvent(result.event.id));
  assert.equal(f.service.commit(f.signed(intent)).replayed, true);
});

test("actual SQLite audit failure rolls back intent consumption/head/event and emits no SSE", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  const before = f.database.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get().count;
  f.database.exec("CREATE TRIGGER owned_human_audit_failure BEFORE INSERT ON control_plane_events WHEN NEW.action LIKE 'human_evaluation.%' BEGIN SELECT RAISE(ABORT, 'owned-test-audit-failure'); END;");
  assert.throws(() => f.service.commit(f.signed(intent)));
  assert.equal(f.store.getRunEvaluationHumanIntent(intent.id).state, "pending");
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get().count, before);
  assert.equal(f.published.length, 0);
});

test("schema refuses Renderer authority booleans, unknown fields and getters without evaluating them", async t => {
  let getterCalls = 0;
  const malicious = Object.defineProperty({ platform: "darwin" }, "session", { enumerable: true,
    get() { getterCalls += 1; return {}; } });
  assert.throws(() => readHumanEvaluationHandshake(malicious));
  assert.equal(getterCalls, 0);
  assert.throws(() => readHumanEvaluationHandshake({ ...mainSession("/tmp"), authenticated: true }));
  assert.throws(() => readHumanEvaluationIntentInput({ authenticated: true, adjudicator: "owner" }));
  assert.throws(() => readHumanEvaluationCommit({ authenticated: true, verified: true }));
});

test("ordinary task and another workspace never become enrolled human facts", async t => {
  const f = await humanFixture(t);
  assert.throws(() => f.service.handshake(mainSession("/tmp")));
  const ordinary = f.service.createIntent({ authority: f.handshake.authority, taskId: "ordinary-not-enrolled",
    requestId: "ordinary-human", submission });
  assert.equal(ordinary.accepted, false);
  assert.equal(f.service.snapshot({ authority: f.handshake.authority, taskId: "ordinary-not-enrolled" }).reason, "qa_not_enrolled");
  assert.equal(f.store.getRunEvaluationHumanHead(f.task.id), undefined);
});

test("private readback exposes exact pending/consumed intent and refuses cross-task intent identity", async t => {
  const f = await humanFixture(t);
  const intent = f.create().intent;
  const pending = f.service.snapshot({ authority: f.handshake.authority, taskId: f.task.id, intentId: intent.id });
  assert.equal(pending.accepted, true);
  assert.equal(pending.intent.state, "pending");
  assert.equal(pending.head, undefined);
  const secondTask = f.enroll(2);
  assert.equal(f.service.snapshot({ authority: f.handshake.authority, taskId: secondTask.id,
    intentId: intent.id }).reason, "identity_conflict");
  const result = f.service.commit(f.signed(intent));
  assert.equal(result.accepted, true);
  const consumed = f.service.snapshot({ authority: f.handshake.authority, taskId: f.task.id, intentId: intent.id });
  assert.equal(consumed.intent.state, "consumed");
  assert.equal(consumed.headEvent.id, result.event.id);
  assert.equal(consumed.head.eventId, result.event.id);
  assert.equal(consumed.events.length, 1);
  assert.equal(consumed.nextAfterRevision, undefined);
  assert.throws(() => f.service.snapshot({ authority: f.handshake.authority, taskId: f.task.id, afterRevision: -1 }));
});

test("more than 100 append-only human events paginate without losing the actual latest head", async t => {
  const f = await humanFixture(t);
  // Every isolated surrogate is six JSON wire bytes, even though it is one
  // legal JS string code unit. Retain a Chinese character and the full 4000
  // code-unit contract to test UTF-8 and worst-case JSON escaping together.
  const boundaryDecision = { ...decision, rationale: `中${"\ud800".repeat(3999)}` };
  let current = f.service.commit(f.signed(f.create("human-page-1", { kind: "adjudicate", decision: boundaryDecision }).intent));
  assert.equal(current.accepted, true);
  for (let revision = 2; revision <= 101; revision += 1) {
    const prefix = `中${revision}`;
    const intent = f.create(`human-page-${revision}`, { kind: "correct", supersedesEventId: current.event.id,
      decision: { ...boundaryDecision, rationale: `${prefix}${"\ud800".repeat(4000 - prefix.length)}` } }).intent;
    current = f.service.commit(f.signed(intent));
    assert.equal(current.accepted, true);
  }
  const first = f.service.snapshot({ authority: f.handshake.authority, taskId: f.task.id });
  assert.equal(first.accepted, true);
  assert.equal(first.events.length, 100);
  assert.equal(first.nextAfterRevision, 100);
  assert.equal(first.head.revision, 101);
  assert.equal(first.headEvent.id, current.event.id);
  const second = f.service.snapshot({ authority: f.handshake.authority, taskId: f.task.id,
    afterRevision: first.nextAfterRevision });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].revision, 101);
  assert.equal(second.nextAfterRevision, undefined);
  assert.equal(second.headEvent.id, current.event.id);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") > 2 * 1_048_576,
    "the legitimate 100-event page exceeds 2 MiB after worst-case JSON escaping");
  const server = createServer(async (request, response) => {
    const handled = await handleHumanEvaluationDesktopRoute(request, response, { humanEvaluations: f.service,
      desktopBridgeToken: "owned-human-page-token", config: { maxBodyBytes: 1_000_000 } });
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeToken: "owned-human-page-token" });
  const signal = new AbortController().signal;
  const connection = await client.handshake(mainSession(f.authority.workspaceCwd), signal);
  const largePage = await client.snapshot({ authority: connection.authority, taskId: f.task.id,
    intentId: current.event.intentId }, signal);
  assert.equal(largePage.events.length, 100);
  assert.equal(largePage.nextAfterRevision, 100);
  assert.equal(largePage.head.revision, 101);
  assert.equal(largePage.headEvent.id, current.event.id);
  assert.equal(largePage.intent.state, "consumed");
  const lastPage = await client.snapshot({ authority: connection.authority, taskId: f.task.id,
    afterRevision: largePage.nextAfterRevision }, signal);
  assert.equal(lastPage.events.length, 1);
  assert.equal(lastPage.events[0].revision, 101);
  assert.equal(lastPage.headEvent.id, current.event.id);
});

test("actual Main snapshot client cancels an over-4MiB UTF-8 response instead of accepting unbounded data", async t => {
  const responseBody = JSON.stringify({ accepted: true, events: [], unexpected: "甲".repeat(1_410_000) });
  assert.ok(Buffer.byteLength(responseBody, "utf8") > 4 * 1_048_576);
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain owned local request */ }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(responseBody);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeToken: "owned-oversized-snapshot-token" });
  await assert.rejects(client.snapshot({ authority: { daemonEpoch: "fixture", desktopInstanceId: "fixture",
    desktopEpoch: "fixture", connectionEpoch: "fixture", osSessionId: "fixture", osUserId: "fixture", lockEpoch: "fixture" },
    taskId: "owned-over-budget-response" }, new AbortController().signal), /human_daemon_response_invalid/u);
});

test("real owned private HTTP rejects public/browser/mobile-equivalent routes and has no CORS", async t => {
  const f = await humanFixture(t);
  const server = createServer(async (request, response) => {
    const handled = await handleHumanEvaluationDesktopRoute(request, response, { humanEvaluations: f.service,
      desktopBridgeToken: "owned-test-bridge-token", config: { maxBodyBytes: 1_000_000 } });
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${url}${path}`, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json", "x-ling-desktop-bridge-token": "owned-test-bridge-token", ...headers }, body: JSON.stringify(body) });
  for (const headers of [{ "x-ling-desktop-bridge-token": "invalid" }, { origin: "http://localhost" },
    { "sec-fetch-site": "same-origin" }]) {
    const denied = await post(`${root}/handshake`, mainSession(f.cwd), headers);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await post("/harness/evaluations/human/commit", {})).status, 404);
  assert.equal((await post(`${root}/handshake?cwd=${encodeURIComponent(f.cwd)}`, mainSession(f.cwd))).status, 404);
  const noToken = await fetch(`${url}${root}/handshake`, { method: "OPTIONS", headers: { origin: "http://localhost" } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.headers.get("access-control-allow-origin"), null);
  const accepted = await post(`${root}/handshake`, mainSession(f.cwd));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  const current = await accepted.json();
  assert.equal(current.accepted, true);
  const created = await post(`${root}/intent`, { authority: current.authority, taskId: f.task.id,
    requestId: "owned-http-human", submission });
  assert.equal(created.status, 200);
  const intent = (await created.json()).intent;
  const committed = await post(`${root}/commit`, f.signed(intent, current));
  assert.equal(committed.status, 200);
  assert.equal((await committed.json()).head.revision, 1);
  const snapshot = await post(`${root}/snapshot`, { authority: current.authority, taskId: f.task.id });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).events.length, 1);
  const invalid = await post(`${root}/commit`, { authenticated: true });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { accepted: false, reason: "evaluation_human_request_rejected" });
});

test("actual Main client source crosses real HTTP handshake, payload-bound receipt, Core commit and revocation", async t => {
  const f = await humanFixture(t);
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.origin, undefined);
    const handled = await handleHumanEvaluationDesktopRoute(request, response, { humanEvaluations: f.service,
      desktopBridgeToken: "owned-main-client-token", config: { maxBodyBytes: 1_000_000 } });
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeToken: "owned-main-client-token" });
  const signal = new AbortController().signal;
  const connection = await client.handshake(mainSession(f.authority.workspaceCwd), signal);
  assert.equal(connection.workspaceCwd, f.authority.workspaceCwd);
  const intent = await client.intent({ authority: connection.authority, taskId: f.task.id,
    requestId: "actual-main-source-request", submission }, signal);
  // Synthetic owned test receipt only: this is protocol/SQLite evidence, not
  // a real OS confirmation or packaged GUI acceptance claim.
  const confirmation = { kind: "macos_device_owner_authentication", requestId: intent.payload.requestId,
    payloadDigest: intent.payloadDigest, confirmedAt: now };
  const result = await client.commit({ authority: connection.authority, intentId: intent.id, confirmation,
    signature: signHumanEvaluationConfirmation(connection, intent.id, confirmation) }, signal);
  assert.ok(result.event.id);
  assert.deepEqual(result.head, { revision: 1, state: "active" });
  assert.deepEqual(Object.keys(result).sort(), ["event", "head"]);
  assert.equal(f.published.length, 1);
  await client.revoke(connection.authority);
  await assert.rejects(client.intent({ authority: connection.authority, taskId: f.task.id,
    requestId: "old-main-source-replay", submission }, signal), /human_daemon_rejected/u);
  assert.equal(f.store.listRunEvaluationHumanEvents({ taskId: f.task.id }).length, 1);
});

test("production Daemon composition exposes independent human ingress before CORS, without CU or an active Run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-human-production-owned-"));
  const userRoot = await mkdtemp(join(tmpdir(), "ling-human-production-user-"));
  const previousUserRoot = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const secrets = {
    status(ref) { return { ref, kind: "env", configured: false, errorCode: "secret_missing" }; },
    resolve(ref) { return { ref, configured: false, status: this.status(ref) }; },
    setSecret() { throw new Error("owned-test-forbids-secrets"); },
    deleteSecret() { throw new Error("owned-test-forbids-secrets"); },
  };
  let daemon;
  try {
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
      desktopBridgeToken: "owned-production-main-token", secretResolver: secrets, externalSecretStore: secrets,
    });
    await daemon.start();
    const address = daemon.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${baseUrl}${root}/handshake`, { method: "OPTIONS", headers: { origin: "http://localhost" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: baseUrl, bridgeToken: "owned-production-main-token" });
    const signal = new AbortController().signal;
    const connection = await client.handshake(mainSession(realpathSync(cwd)), signal);
    assert.equal(connection.workspaceCwd, realpathSync(cwd));
    await assert.rejects(client.intent({ authority: connection.authority, taskId: "ordinary-no-QA-enrollment",
      requestId: "ordinary-must-remain-unenrolled", submission }, signal), /human_daemon_rejected/u);
    await client.revoke(connection.authority);
  } finally {
    await daemon?.stop();
    if (previousUserRoot === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousUserRoot;
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});
