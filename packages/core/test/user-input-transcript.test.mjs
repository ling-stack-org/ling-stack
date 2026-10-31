import assert from "node:assert/strict";
import test from "node:test";

test("answered request without its acceptance record is unavailable", async t => {
  const f = await fixture(t); f.submit();
  f.db.prepare("DELETE FROM user_input_answers WHERE answer_id=?").run(f.receipt.answerId);
  assert.deepEqual(f.read([f.request.itemId]), [{ itemId: f.request.itemId, kind: "user_input_request", availability: "unavailable" }]);
});

test("pending status cannot coexist with an accepted answer in the public view", async t => {
  const f = await fixture(t); f.submit();
  f.db.exec("UPDATE user_input_requests SET status='pending'");
  assert.ok(f.read().every(item => item.availability === "unavailable"));
});

test("a source Turn moved outside the Thread invalidates content lineage", async t => {
  const f = await fixture(t);
  const other = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Other" }, now);
  f.db.prepare("UPDATE ling_turns SET thread_id=? WHERE id=?").run(other.id, f.turn.turnId);
  assert.equal(f.read()[0].availability, "unavailable");
});

test("failed and obsolete deliveries retain saved answers without exposing worker retry internals", async t => {
  const f = await fixture(t); f.submit(); const claimed = f.claim();
  f.store.retryUserInputDelivery({ threadId: f.thread.id, deliveryId: claimed.deliveryId,
    expectedRevision: claimed.revision, ownerId: claimed.claim.ownerId, claimToken: claimed.claim.token,
    retryAt: "2026-09-07T00:00:05.000Z", errorCode: "receiver_unavailable" }, claimedAt);
  assert.deepEqual(f.read()[1].delivery, { status: "failed", revision: 3, updatedAt: claimedAt });
  f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, claimedAt);
  const result = f.read();
  assert.equal(result[0].status, "answered", "cancelling delivery preserves the accepted answer");
  assert.equal(result[1].answers[0].label, "深色");
  assert.equal(result[1].delivery.status, "obsolete");
});

test("expiry is reported as persisted data and never mutated by a read", async t => {
  const f = await fixture(t);
  const before = f.db.prepare("PRAGMA data_version").get().data_version;
  f.read(); f.read();
  assert.equal(f.db.prepare("PRAGMA data_version").get().data_version, before);
  assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, "pending");
});
import { createSqliteRunStore } from "../dist/index.js";
import { userInputTranscriptFixture as fixture, now, acceptedAt, claimedAt } from "./support/user-input-transcript-fixture.mjs";

for (const surface of ["normal", "private", "channel"]) {
  test(surface + " hydrates exact canonical questions and accepted user answers", async t => {
    const f = await fixture(t, { surface });
    const [request] = f.read();
    assert.equal(request.availability, "available");
    assert.equal(request.kind, "user_input_request");
    assert.equal(request.status, "pending");
    assert.equal(request.statusRevision, 1);
    assert.deepEqual(request.questions, f.request.questions);
    assert.equal(request.source.participantId, f.participantId);
    assert.equal(request.source.sourceItemId, f.turn.item.id);
    assert.equal(request.source.attemptId, f.attempt.id);
    assert.deepEqual(request.answerAuthority, {
      schemaVersion: 1, threadId: f.thread.id, runId: f.run.id, attemptId: f.attempt.id,
      participantId: f.participantId, requestId: f.request.requestId, requestVersion: 1,
      statusRevision: 1, token: request.answerAuthority.token,
    });
    assert.match(request.answerAuthority.token, /^[a-f0-9]{64}$/u);
    f.submit();
    const result = f.read();
    assert.equal(result[0].status, "answered");
    assert.equal(result[0].statusRevision, 2);
    assert.equal(result[1].kind, "user_input_answer");
    assert.equal(result[1].answerId, f.receipt.answerId);
    assert.equal(result[1].acceptedAt, acceptedAt);
    assert.deepEqual(result[1].answers, [{ questionId: "theme", prompt: "选择主题\n保留换行", kind: "option", optionId: "dark", label: "深色" }]);
    assert.deepEqual(result[1].delivery, { status: "pending", revision: 1, updatedAt: acceptedAt });
  });
}

test("free text preserves Markdown without becoming an Agent message or authority payload", async t => {
  const f = await fixture(t);
  const text = "第一行\n\n```js\nconsole.log('fixture');\n```";
  f.submit([{ questionId: "theme", kind: "text", text }]);
  const answer = f.read()[1];
  assert.equal(answer.answers[0].text, text);
  assert.equal(answer.kind, "user_input_answer");
  assert.equal("permissions" in answer, false);
  assert.equal("markdown" in answer, false);
});

test("projection is an explicit whitelist and never leaks leases or authority", async t => {
  const f = await fixture(t); f.submit();
  const claimed = f.claim();
  const result = f.read();
  assert.deepEqual(result[1].delivery, { status: "claimed", revision: 2, updatedAt: claimedAt });
  assert.deepEqual(Object.keys(result[0]).sort(), ["availability", "createdAt", "itemId", "kind", "questions", "requestId", "requestVersion", "source", "runEventPosition", "status", "statusRevision", "updatedAt", "waitMode"].sort());
  assert.deepEqual(Object.keys(result[0].source).sort(), ["workspaceId", "threadId", "turnId", "runId", "attemptId", "workUnitId", "participantId", "sourceItemId"].sort());
  const json = JSON.stringify(result);
  for (const forbidden of [claimed.claim.token, claimed.claim.ownerId, claimed.successorRunId,
    f.cwd, "fencingToken", "runtimeInstanceId", "toolCallId", "taskBinding", "idempotencyKey", "submission_fingerprint"]) {
    assert.ok(!json.includes(forbidden), "must omit internal field/value: " + forbidden);
  }
});

test("only the current active or yielded owner receives answer authority while history stays readable", async t => {
  const active = await fixture(t);
  assert.match(active.read()[0].answerAuthority.token, /^[a-f0-9]{64}$/u);
  active.db.prepare("UPDATE work_unit_attempts SET status='lost',ended_at=? WHERE id=?").run(acceptedAt, active.attempt.id);
  const stale = active.read()[0];
  assert.equal(stale.availability, "available");
  assert.equal(stale.status, "pending");
  assert.equal(stale.answerAuthority, undefined);

  const yielded = await fixture(t);
  yielded.store.commitUserInputYield({
    threadId: yielded.thread.id, requestId: yielded.request.requestId, expectedRequestVersion: 1,
    sourceFence: { workUnitId: yielded.attempt.workUnitId, attemptId: yielded.attempt.id,
      runtimeInstanceId: yielded.attempt.runtimeInstanceId, fencingToken: yielded.attempt.fencingToken },
    quiescence: { kind: "runner_quiesced", runnerId: yielded.attempt.runnerId, stoppedAt: acceptedAt, lastRunEventSeq: 0 },
  }, acceptedAt);
  assert.match(yielded.read()[0].answerAuthority.token, /^[a-f0-9]{64}$/u);
});

test("read preserves item ordering, de-duplicates IDs and does not hydrate off-page answers", async t => {
  const f = await fixture(t); f.submit();
  assert.deepEqual(f.read([f.receipt.answerItemId, f.request.itemId, f.request.itemId]).map(x => x.itemId), [f.request.itemId, f.receipt.answerItemId]);
  assert.deepEqual(f.read([f.request.itemId]).map(x => x.kind), ["user_input_request"]);
  assert.deepEqual(f.read([f.receipt.answerItemId]).map(x => x.kind), ["user_input_answer"]);
  assert.deepEqual(f.read([f.turn.item.id, "missing-item"]), []);
});

test("cross-thread and missing scope reads reveal neither existence nor content", async t => {
  const f = await fixture(t); f.submit();
  const other = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Other" }, now);
  for (const threadId of [other.id, "missing-thread"]) {
    assert.deepEqual(f.store.readUserInputTranscript({ threadId, itemIds: [f.request.itemId, f.receipt.answerItemId] }), []);
  }
});

for (const surface of ["normal", "channel", "private"]) {
  test(surface + " excludes hidden or foreign-private anchors before decoding content", async t => {
    const f = await fixture(t, { surface });
    for (const visibility of ["operator", "agent_private"]) {
      f.db.prepare("UPDATE conversation_items SET visibility=?,visibility_owner_id=?,payload_json='invalid-json' WHERE id=?")
        .run(visibility, visibility === "agent_private" ? "other-agent" : null, f.request.itemId);
      f.db.prepare("UPDATE user_input_requests SET tool_input_json='invalid-json'").run();
      assert.deepEqual(f.read(), []);
    }
  });
}

const corruptions = [
  ["request body", f => f.db.exec("UPDATE user_input_requests SET tool_input_json='{}'")],
  ["request fingerprint", f => f.db.exec("UPDATE user_input_requests SET source_fingerprint='broken'")],
  ["request anchor", f => f.db.prepare("UPDATE conversation_items SET actor_id='other-agent' WHERE id=?").run(f.request.itemId)],
  ["request references", f => f.db.prepare("UPDATE conversation_items SET domain_refs_json='[]' WHERE id=?").run(f.request.itemId)],
  ["missing request", f => f.db.prepare("DELETE FROM user_input_requests WHERE request_id=?").run(f.request.requestId)],
  ["missing source", f => f.db.prepare("UPDATE conversation_items SET status='failed' WHERE id=?").run(f.turn.item.id)],
];
for (const [name, corrupt] of corruptions) {
  test(name + " becomes content-free unavailable, not fabricated question text", async t => {
    const f = await fixture(t); corrupt(f);
    assert.deepEqual(f.read(), [{ itemId: f.request.itemId, kind: "user_input_request", availability: "unavailable" }]);
  });
}

for (const [name, sql] of [
  ["answer fingerprint", "UPDATE user_input_answers SET submission_fingerprint='broken'"],
  ["answer body", "UPDATE user_input_answers SET submission_json='{}'"],
  ["missing delivery", "DELETE FROM user_input_deliveries"],
  ["unproven applied ACK", "UPDATE user_input_deliveries SET status='applied'"],
]) {
  test(name + " cannot publish accepted content or a false delivery success", async t => {
    const f = await fixture(t); f.submit(); f.db.exec(sql);
    assert.deepEqual(f.read([f.receipt.answerItemId]), [{ itemId: f.receipt.answerItemId, kind: "user_input_answer", availability: "unavailable" }]);
  });
}

test("cancelled history remains readable without resurrecting a Run or creating events", async t => {
  const f = await fixture(t);
  f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: f.request.requestId, expectedStatusRevision: 1 }, acceptedAt);
  const before = f.db.prepare("PRAGMA data_version").get().data_version;
  const result = f.read();
  assert.equal(result[0].status, "cancelled"); assert.equal(result[0].statusRevision, 2);
  assert.equal(f.db.prepare("PRAGMA data_version").get().data_version, before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_sessions").get().n, 1);
});

test("all content and status reads share one SQLite snapshot", async t => {
  const f = await fixture(t);
  const original = f.store.getUserInputRequest.bind(f.store);
  let once = false;
  f.store.getUserInputRequest = (...args) => {
    if (!once) {
      once = true;
      f.db.prepare("UPDATE user_input_requests SET status='cancelled',status_revision=2,updated_at=?").run(acceptedAt);
    }
    return original(...args);
  };
  assert.equal(f.read()[0].status, "pending", "external update must not split this read snapshot");
  assert.equal(f.read()[0].status, "cancelled", "the next snapshot must see the update");
});

test("database and unexpected port failures propagate instead of becoming unavailable", async t => {
  const f = await fixture(t);
  const error = new Error("synthetic infrastructure failure");
  f.store.getUserInputRequest = () => { throw error; };
  assert.throws(() => f.read(), e => e === error);
  f.db.exec("DROP TABLE user_input_deliveries");
  assert.throws(() => f.store.getUserInputDelivery(f.thread.id, "missing"));
});

test("reopening storage preserves content identity and revisions without writes", async t => {
  const f = await fixture(t); f.submit();
  const before = f.read();
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.read(), before);
});

test("read batch rejects malformed or unbounded inputs", async t => {
  const f = await fixture(t);
  for (const input of [{ threadId: f.thread.id, itemIds: Array(501).fill("id") },
    { threadId: f.thread.id, itemIds: [42] }, { threadId: "", itemIds: [] }, { threadId: f.thread.id, itemIds: null }]) {
    assert.throws(() => f.store.readUserInputTranscript(input), e => e.code === "invalid_input");
  }
  assert.deepEqual(f.read([]), []);
});
