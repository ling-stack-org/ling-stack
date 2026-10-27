import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngineManagementClient } from "../dist/execution-engines.js";

// Regression: synchronous engine lifecycle operations need their own finite budgets.
// Found by independent review on 2026-10-28; no registry or installation is used.
// The real client owns the AbortSignal; only its clock and network peer are controlled.
const credentials = { token: "synthetic-lifecycle-session", csrfToken: "synthetic-lifecycle-csrf" };
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(new DOMException("Synthetic request deadline", "TimeoutError")), milliseconds);
    return abort.signal;
  });
  const requests = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => credentials,
    fetch(url, init) {
      const response = Promise.withResolvers();
      const abort = () => response.reject(init.signal.reason);
      init.signal.addEventListener("abort", abort, { once: true });
      if (init.signal.aborted) abort();
      requests.push({ url, signal: init.signal, complete: body => response.resolve(Response.json(body)) });
      return response.promise.finally(() => init.signal.removeEventListener("abort", abort));
    } });
  const observe = promise => promise.then(value => ({ value }), error => ({ error }));
  return { client, requests, observe };
}

for (const method of ["install", "discover"]) test(`${method} can finish after the ordinary management deadline`, async t => {
  const f = fixture(t);
  const pending = f.observe(method === "install" ? f.client.install("claude-agent-sdk") : f.client.discover());
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(12_000);
  const aborted = f.requests[0].signal.aborted;
  const body = method === "install"
    ? { install: { engineId: "claude-agent-sdk", phase: "installed", executablePath: "/synthetic/claude" } }
    : { checkedAt: "2026-10-28T00:00:00.000Z", candidates: [] };
  f.requests[0].complete(body);
  const result = await pending;
  assert.equal(aborted, false, "A valid slow lifecycle operation must not be aborted at the ordinary 10-second deadline");
  assert.deepEqual(result, { value: body });
  assert.equal(f.requests.length, 1, "Completion must not require retrying the operation");
});

for (const [method, deadline] of [["install", 300_000], ["discover", 20_000], ["listProfiles", 10_000]]) {
  test(`${method} still aborts at its finite deadline without retry`, async t => {
    const f = fixture(t);
    const pending = f.observe(method === "install" ? f.client.install("claude-agent-sdk") : f.client[method]());
    assert.equal(f.requests.length, 1);
    t.mock.timers.tick(deadline - 1);
    const prematureAbort = f.requests[0].signal.aborted;
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(prematureAbort, false, "The request must retain its entire operation-specific budget");
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(result.error?.name, "TimeoutError");
    assert.equal(f.requests.length, 1, "A timed-out operation must not be silently replayed");
  });
}
