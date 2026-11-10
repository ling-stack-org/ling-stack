import assert from "node:assert/strict";
import test from "node:test";
import { isRunEventData, isRunEventType } from "../dist/index.js";

const errorDiagnostic = { schemaVersion: 1, category: "rate_limited", basis: "sdk_error_marker", httpStatus: 429 };
const retry = { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "scheduled",
  retryAttempt: 1, maxRetryAttempts: 1, delayMs: 2_000, errorDiagnostic, attemptId: "host-attempt" };

test("durable provider retry facts preserve SDK retry count and Host attempt separately", () => {
  assert.equal(isRunEventType("provider_retry"), true);
  assert.equal(isRunEventData("provider_retry", retry), true);
  assert.equal(isRunEventData("provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "assistant",
    phase: "settled", retryAttempt: 1, outcome: "succeeded" }), true);
  assert.equal(isRunEventData("provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "summarization",
    phase: "settled" }), true, "summary retry has no SDK success outcome");
});

test("diagnostics reject arbitrary payloads, invalid numbers and fabricated retry outcomes", () => {
  for (const patch of [{ httpStatus: NaN }, { httpStatus: 200 }, { category: "private" },
    { basis: "private" }, { schemaVersion: 2 }, { message: "PRIVATE" }, { code: "sk-private" }]) {
    const malformed = { ...errorDiagnostic, ...patch };
    assert.equal(isRunEventData("message_end", { role: "assistant", errorDiagnostic: malformed }), false);
    assert.equal(isRunEventData("run_error", { message: "Generic failure.", errorDiagnostic: malformed }), false);
  }
  for (const patch of [{ retryAttempt: 0 }, { retryAttempt: 2 }, { delayMs: Infinity },
    { phase: "fake" }, { errorMessage: "PRIVATE" }, { errorDiagnostic: undefined }, { attemptId: "" }]) {
    assert.equal(isRunEventData("provider_retry", { ...retry, ...patch }), false);
  }
  assert.equal(isRunEventData("provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "summarization",
    phase: "settled", outcome: "succeeded" }), false);
});

test("public retry diagnostics reject hidden fields, inheritance and accessors without evaluating them", () => {
  let calls = 0;
  const accessor = { ...errorDiagnostic, get code() { calls += 1; return "ETIMEDOUT"; } };
  const hidden = Object.defineProperty({ ...errorDiagnostic }, "privateBody", { value: "PRIVATE", enumerable: false });
  const inherited = Object.create(errorDiagnostic);
  const symbol = { ...errorDiagnostic, [Symbol("privateBody")]: "PRIVATE" };
  for (const malformed of [accessor, hidden, inherited, symbol]) {
    assert.equal(isRunEventData("message_end", { errorDiagnostic: malformed }), false);
  }
  assert.equal(isRunEventData("provider_retry", { ...retry,
    get delayMs() { calls += 1; return 1; } }), false);
  assert.equal(calls, 0);
});
