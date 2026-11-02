import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { userInputTranscriptFixture } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { resolveConfig } from "../dist/config.js";
import { handleUserInputAnswer } from "../dist/features/conversations/user-input-answer-route.js";

const ANSWER_TEXT = "http-answer-must-not-leak";

function answerCommand(authority, overrides = {}) {
  return {
    schemaVersion: 1,
    authority,
    idempotencyKey: "http-answer-1",
    answers: [{ questionId: "theme", kind: "text", text: ANSWER_TEXT }],
    ...overrides,
  };
}

async function startAnswerServer(t, fixture, onDeliveryAccepted) {
  const config = resolveConfig({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 64 * 1024,
    defaultWorkspaceCwd: fixture.cwd,
  });
  const registry = {
    isTrustedWorkspaceRoot(cwd) {
      return cwd === fixture.cwd;
    },
    getStore(cwd) {
      assert.equal(cwd, fixture.cwd);
      return fixture.store;
    },
  };
  const server = createServer((request, response) => {
    void handleUserInputAnswer(request, response, config, registry, onDeliveryAccepted).catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "unhandled_test_failure", message: String(error) }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/user-input-answers?cwd=${encodeURIComponent(fixture.cwd)}`;
}

async function postAnswer(url, command) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify(command),
  });
  const text = await response.text();
  return { response, text, body: JSON.parse(text) };
}

function readAuthority(fixture) {
  const authority = fixture.read()[0]?.answerAuthority;
  assert(authority, "the active request must expose current Host authority");
  return authority;
}

function assertRedactedRejection(result, command, expectedStatus, extraSensitiveValues = []) {
  assert.equal(result.response.status, expectedStatus);
  assert.deepEqual(result.body, {
    error: "user_input_answer_rejected",
    message: "The answer could not be accepted for the current question.",
  });
  const sensitiveValues = new Set([
    ANSWER_TEXT,
    command.idempotencyKey,
    command.authority.token,
    command.authority.requestId,
    command.authority.threadId,
    command.authority.participantId,
    command.authority.runId,
    command.authority.attemptId,
    ...extraSensitiveValues,
  ]);
  for (const value of sensitiveValues) {
    assert.ok(!result.text.includes(value), `error response must not expose ${value}`);
  }
}

test("POST accepts one durable answer and exact replay without claiming delivery", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  let wakeCount = 0;
  const url = await startAnswerServer(t, fixture, (store) => {
    assert.equal(store, fixture.store);
    wakeCount += 1;
  });
  const command = answerCommand(readAuthority(fixture));

  const accepted = await postAnswer(url, command);
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.receipt.replayed, false);
  assert.equal(accepted.body.receipt.requestId, fixture.request.requestId);
  assert.equal(accepted.body.delivery.status, "pending");
  assert.equal("answers" in accepted.body, false);
  assert.ok(!accepted.text.includes(ANSWER_TEXT));
  assert.ok(!accepted.text.includes(command.idempotencyKey));
  assert.ok(!accepted.text.includes(command.authority.token));
  assert.ok(!accepted.text.includes(command.authority.threadId));
  assert.ok(!accepted.text.includes(command.authority.participantId));

  const replay = await postAnswer(url, command);
  assert.equal(replay.response.status, 202);
  assert.equal(replay.body.accepted, true);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(replay.body.receipt.answerId, accepted.body.receipt.answerId);
  assert.equal(replay.body.receipt.deliveryId, accepted.body.receipt.deliveryId);
  assert.deepEqual(replay.body.delivery, { status: "pending" });
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_deliveries").get().count, 1);
  assert.equal(wakeCount, 2, "first acceptance and exact replay can both wake the durable outbox");
});

test("POST remains accepted when the postcommit wake observer fails", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  const url = await startAnswerServer(t, fixture, () => { throw new Error("wake_failed"); });
  const accepted = await postAnswer(url, answerCommand(readAuthority(fixture)));

  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.delivery.status, "pending");
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_deliveries").get().count, 1);
});

test("HTTP method, scope and body validation fail without reflecting private input", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  const url = await startAnswerServer(t, fixture);

  const method = await fetch(url, { method: "GET" });
  assert.equal(method.status, 405);
  assert.deepEqual(await method.json(), {
    error: "method_not_allowed",
    message: "Only POST is supported for user input answers.",
  });

  const missingScopeUrl = new URL(url);
  missingScopeUrl.search = "";
  const missingScope = await fetch(missingScopeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ privateAnswer: ANSWER_TEXT }),
  });
  assert.equal(missingScope.status, 400);
  const missingScopeText = await missingScope.text();
  assert.deepEqual(JSON.parse(missingScopeText), { error: "bad_request", message: "cwd query parameter is required." });
  assert.ok(!missingScopeText.includes(ANSWER_TEXT));

  const malformed = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{\"privateAnswer\":\"${ANSWER_TEXT}\"`,
  });
  assert.equal(malformed.status, 400);
  const malformedText = await malformed.text();
  assert.deepEqual(JSON.parse(malformedText), {
    error: "invalid_user_input_answer",
    message: "The answer request is invalid.",
  });
  assert.ok(!malformedText.includes(ANSWER_TEXT));
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 0);
});

test("POST rejects remote origins and untrusted workspaces before body parsing, Store access or wake", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  let wakeCount = 0;
  const url = await startAnswerServer(t, fixture, () => { wakeCount += 1; });

  const remoteOrigin = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: "{",
  });
  assert.equal(remoteOrigin.status, 403);
  assert.deepEqual(await remoteOrigin.json(), {
    error: "forbidden_origin",
    message: "Workspace file actions are only available from local Ling Stack pages.",
  });

  const untrustedUrl = new URL(url);
  untrustedUrl.searchParams.set("cwd", `${fixture.cwd}-foreign`);
  const untrusted = await fetch(untrustedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: "{",
  });
  assert.equal(untrusted.status, 403);
  assert.deepEqual(await untrusted.json(), {
    error: "workspace_not_trusted",
    message: "Workspace file actions are limited to daemon-known workspaces and run directories.",
  });

  assert.equal(wakeCount, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_deliveries").get().count, 0);
  assert.equal(fixture.store.getUserInputRequest(fixture.thread.id, fixture.request.requestId).status, "pending");
});

test("POST rejects forged token and request/status versions without leaking authority or answer", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  const url = await startAnswerServer(t, fixture);
  const authority = readAuthority(fixture);
  const forgeries = [
    { ...authority, token: "b".repeat(64) },
    { ...authority, requestVersion: authority.requestVersion + 1 },
    { ...authority, statusRevision: authority.statusRevision + 1 },
  ];

  for (const forgedAuthority of forgeries) {
    const command = answerCommand(forgedAuthority, { idempotencyKey: `forged-${forgedAuthority.token.slice(0, 8)}-${forgedAuthority.requestVersion}-${forgedAuthority.statusRevision}` });
    assertRedactedRejection(await postAnswer(url, command), command, 409, [authority.token]);
  }
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 0);
  assert.equal(fixture.store.getUserInputRequest(fixture.thread.id, fixture.request.requestId).status, "pending");
});

test("POST rejects cross-thread and cross-participant authority without disclosing either scope", async (t) => {
  const fixture = await userInputTranscriptFixture(t);
  const url = await startAnswerServer(t, fixture);
  const authority = readAuthority(fixture);
  const otherThread = fixture.store.createLingThread({
    kind: "conversation",
    title: "Foreign thread",
    objective: "Must not own the question",
  }, "2026-09-07T00:00:02.000Z");

  const crossThread = answerCommand({ ...authority, threadId: otherThread.id }, { idempotencyKey: "cross-thread-answer" });
  assertRedactedRejection(await postAnswer(url, crossThread), crossThread, 404, [authority.threadId]);

  const crossParticipant = answerCommand({ ...authority, participantId: "teammate_builtin_engineer" }, {
    idempotencyKey: "cross-participant-answer",
  });
  assertRedactedRejection(await postAnswer(url, crossParticipant), crossParticipant, 409, [authority.participantId]);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 0);
});

test("POST rejects authority captured before cancellation and expiry without content disclosure", async (t) => {
  const cancelled = await userInputTranscriptFixture(t);
  const cancelledUrl = await startAnswerServer(t, cancelled);
  const cancelledAuthority = readAuthority(cancelled);
  cancelled.store.cancelUserInputRequest({
    threadId: cancelled.thread.id,
    requestId: cancelled.request.requestId,
    expectedStatusRevision: cancelled.request.statusRevision,
  }, "2026-09-07T00:00:02.000Z");
  const cancelledCommand = answerCommand(cancelledAuthority, { idempotencyKey: "cancelled-answer" });
  assertRedactedRejection(await postAnswer(cancelledUrl, cancelledCommand), cancelledCommand, 409);

  const expired = await userInputTranscriptFixture(t);
  const expiredUrl = await startAnswerServer(t, expired);
  const expiredAuthority = readAuthority(expired);
  expired.db.prepare("UPDATE user_input_requests SET expires_at=? WHERE request_id=?")
    .run("2000-01-01T00:00:00.000Z", expired.request.requestId);
  const expiredCommand = answerCommand(expiredAuthority, { idempotencyKey: "expired-answer" });
  assertRedactedRejection(await postAnswer(expiredUrl, expiredCommand), expiredCommand, 409);

  for (const fixture of [cancelled, expired]) {
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_answers").get().count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM user_input_deliveries").get().count, 0);
  }
});
