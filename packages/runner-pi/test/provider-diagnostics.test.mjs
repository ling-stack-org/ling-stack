import assert from "node:assert/strict";
import test from "node:test";
import { translatePiEvent } from "../dist/events.js";
import { classifyProviderError } from "../dist/provider-error-diagnostic.js";
import { compactionFixture, response } from "./support/pi-compaction-fixture.mjs";

const privateDetail = "PRIVATE_PROVIDER_BODY sk-fixture-secret /private/model-view";
const unknown = { schemaVersion: 1, category: "unknown", basis: "unclassified" };
const diagnostic = (category, httpStatus) => ({ schemaVersion: 1, category,
  basis: "sdk_error_marker", ...(httpStatus === undefined ? {} : { httpStatus }) });
const messageEnd = message => translatePiEvent({ type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", ...message } });

test("provider failures retain bounded HTTP categories, never the response body", () => {
  for (const [status, category] of [[400, "invalid_request"], [401, "authentication"],
    [403, "permission_denied"], [408, "timeout"], [429, "rate_limited"],
    [500, "provider_unavailable"], [503, "provider_unavailable"], [504, "timeout"]]) {
    const event = messageEnd({ errorMessage: `${status}: ${privateDetail}` });
    assert.deepEqual(event.errorDiagnostic, diagnostic(category, status));
    assert.equal(event.errorMessage, "Provider message ended with an error.");
    assert.equal(JSON.stringify(event).includes(privateDetail), false);
  }
});

test("structured codes can distinguish context or transport errors without publishing free text", () => {
  for (const [code, category] of [["context_length_exceeded", "context_limit"],
    ["ETIMEDOUT", "timeout"], ["ECONNRESET", "network"], ["insufficient_quota", "quota_exhausted"]]) {
    const event = messageEnd({ error: { code, message: privateDetail } });
    assert.deepEqual(event.errorDiagnostic, { schemaVersion: 1, category,
      basis: "structured_error_code", code });
    assert.equal(JSON.stringify(event).includes(privateDetail), false);
  }
  assert.deepEqual(messageEnd({ errorMessage: `400 {"code":"context_length_exceeded","message":"${privateDetail}"}` })
    .errorDiagnostic, { schemaVersion: 1, category: "context_limit", basis: "sdk_error_marker",
      httpStatus: 400, code: "context_length_exceeded" });
});

test("unknown, malformed and oversized provider details cannot become invented diagnoses", () => {
  for (const error of [{ errorMessage: privateDetail }, { errorMessage: "not a status: 429" },
    { error: { status: NaN, code: privateDetail } }, { errorMessage: "x".repeat(100_000) },
    { errorMessage: privateDetail + " Request timed out" }]) {
    const event = messageEnd(error);
    assert.deepEqual(event.errorDiagnostic, unknown);
    assert.equal(JSON.stringify(event).includes(privateDetail), false);
    assert.ok(JSON.stringify(event).length < 512);
  }
  assert.deepEqual(messageEnd({}).errorDiagnostic, unknown, "an error stop reason alone is still unknown");
  assert.equal(translatePiEvent({ type: "message_end", message: { role: "assistant", content: [],
    stopReason: "stop", errorDiagnostic: diagnostic("timeout") } }).errorDiagnostic, undefined);
  assert.equal(translatePiEvent({ type: "message_end", message: { role: "user", content: privateDetail,
    errorMessage: "429" } }).errorDiagnostic, undefined);
});

test("SDK retry metadata is factual, bounded and distinct from a Host execution attempt", () => {
  assert.deepEqual(translatePiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 1,
    delayMs: 2_000, errorMessage: `429: ${privateDetail}` }), {
    type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "scheduled",
    retryAttempt: 1, maxRetryAttempts: 1, delayMs: 2_000, errorDiagnostic: diagnostic("rate_limited", 429),
  });
  assert.deepEqual(translatePiEvent({ type: "auto_retry_end", attempt: 1, success: true,
    finalError: privateDetail }), {
    type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "settled",
    retryAttempt: 1, outcome: "succeeded",
  });
  assert.deepEqual(translatePiEvent({ type: "auto_retry_end", attempt: 1, success: false,
    finalError: `503: ${privateDetail}` }), {
    type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "settled",
    retryAttempt: 1, outcome: "failed", errorDiagnostic: diagnostic("provider_unavailable", 503),
  });
  assert.equal(translatePiEvent({ type: "auto_retry_end", attempt: 1, success: false,
    finalError: "Retry cancelled" }).outcome, "cancelled");
  for (const extra of [{ attempt: 0 }, { attempt: Infinity }, { maxAttempts: 0 },
    { maxAttempts: 0.5 }, { delayMs: -1 }, { delayMs: Infinity }]) {
    assert.equal(translatePiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 1,
      delayMs: 1, errorMessage: privateDetail, ...extra }), undefined);
  }
  assert.equal(translatePiEvent({ type: "auto_retry_end", attempt: 1, success: "true" }), undefined);
});

test("summary retry settlement is not misrepresented as a successful compaction", () => {
  const scheduled = translatePiEvent({ type: "summarization_retry_scheduled", attempt: 1,
    maxAttempts: 1, delayMs: 1, errorMessage: `503: ${privateDetail}` });
  assert.equal(scheduled.scope, "summarization");
  assert.equal(scheduled.phase, "scheduled");
  assert.equal(JSON.stringify(scheduled).includes(privateDetail), false);
  assert.deepEqual(translatePiEvent({ type: "summarization_retry_attempt_start", source: "compaction",
    reason: "threshold" }), { type: "provider_retry", policyVersion: "pi_sdk_retry_v1",
    scope: "summarization", phase: "attempt_start", source: "compaction", reason: "threshold" });
  assert.deepEqual(translatePiEvent({ type: "summarization_retry_finished" }), {
    type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "summarization", phase: "settled",
  });
  assert.equal(translatePiEvent({ type: "summarization_retry_attempt_start", source: "private_source" }), undefined);
});

test("diagnostic projection does not evaluate accessors or trust precomputed public fields", () => {
  let calls = 0;
  const value = { error: { get code() { calls += 1; return "ETIMEDOUT"; } },
    get errorMessage() { calls += 1; return privateDetail; }, errorDiagnostic: diagnostic("timeout") };
  assert.deepEqual(classifyProviderError(value), unknown);
  assert.equal(calls, 0);
  assert.deepEqual(classifyProviderError({ status: 401, message: privateDetail }), {
    schemaVersion: 1, category: "authentication", basis: "structured_http_status", httpStatus: 401,
  });
});

for (const succeeds of [true, false]) {
  test(`real SDK assistant retry ${succeeds ? "success" : "exhaustion"} survives public translation`,
    { timeout: 15_000 }, async t => {
      const f = await compactionFixture(t, { compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
        task: ({ index }) => index === 1 && succeeds ? response({ text: "Complete.", inputTokens: 100 })
          : new Response(JSON.stringify({ error: { message: privateDetail, type: "server_error" } }),
            { status: 503, headers: { "content-type": "application/json" } }),
      });
      await f.session.prompt("Run the isolated retry fixture.");
      await f.session.waitForIdle();
      const projected = f.events.map(translatePiEvent).filter(Boolean);
      const retries = projected.filter(event => event.type === "provider_retry");
      assert.deepEqual(retries.map(event => event.phase), ["scheduled", "settled"]);
      assert.equal(retries.at(-1).outcome, succeeds ? "succeeded" : "failed");
      assert.equal(f.requests.length, 2);
      assert.deepEqual(await f.effects(), [], "provider retries cannot invent tool execution");
      assert.equal(JSON.stringify(projected).includes(privateDetail), false);
    });
}

test("real SDK backoff cancellation does not start another provider request", { timeout: 15_000 }, async t => {
  const f = await compactionFixture(t, { compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 10_000, provider: { maxRetries: 0 } },
    task: () => new Response(JSON.stringify({ error: { message: privateDetail } }),
      { status: 503, headers: { "content-type": "application/json" } }),
    event: event => { if (event.type === "auto_retry_start") queueMicrotask(() => f.session.abortRetry()); },
  });
  await f.session.prompt("Cancel this isolated retry.");
  await f.session.waitForIdle();
  const retries = f.events.map(translatePiEvent).filter(event => event?.type === "provider_retry");
  assert.deepEqual(retries.map(event => event.phase), ["scheduled", "settled"]);
  assert.equal(retries.at(-1).outcome, "cancelled");
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.stringify(retries).includes(privateDetail), false);
});
