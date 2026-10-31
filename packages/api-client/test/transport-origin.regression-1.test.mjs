import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

// Regression: R03-OBS — network loss lost its origin and duplicated business feedback.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
// Value: protects=fetch/HTTP/protocol error separation; fails_when=fetch cause loses typed origin;
// why_new=existing transport tests assert HTTP errors only; seam=existing configured fetch;
// no_claim=real Host or GUI recovery (synthetic fetch only).
for (const method of ["_get", "_requestJson", "_fetch"]) {
  test(`transport origin and cause survive ${method} without retry`, async () => {
    const cause = new TypeError("Failed to fetch");
    let calls = 0;
    const client = new api.LingDaemonClient({ fetch: async () => { calls++; throw cause; } });
    await assert.rejects(() => method === "_get" ? client._get("/runs")
      : method === "_requestJson" ? client._requestJson("GET", "/runs") : client._fetch("http://127.0.0.1/runs"), error => {
      assert.equal(error.name, "LingDaemonTransportError");
      assert.equal(error.phase, "fetch");
      assert.equal(error.cause, cause);
      assert.equal(error.message, cause.message);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("HTTP business errors and malformed JSON are not transport observation failures", async () => {
  for (const method of ["_get", "_requestJson"]) {
    const client = new api.LingDaemonClient({ fetch: async () => new Response(
      JSON.stringify({ error: "approval_invalid", message: "Failed to fetch" }), { status: 409 }) });
    await assert.rejects(() => method === "_get" ? client._get("/runs") : client._requestJson("GET", "/runs"),
      error => error instanceof api.LingDaemonError && error.code === "approval_invalid" && error.status === 409);
    const malformed = new api.LingDaemonClient({ fetch: async () => new Response("{invalid") });
    await assert.rejects(() => method === "_get" ? malformed._get("/runs") : malformed._requestJson("GET", "/runs"),
      error => error instanceof SyntaxError && error.name !== "LingDaemonTransportError");
  }
});

test("explicit fetch cancellation preserves AbortError identity instead of becoming observation loss", async () => {
  const cause = new DOMException("aborted", "AbortError");
  const client = new api.LingDaemonClient({ fetch: async () => { throw cause; } });
  await assert.rejects(client._get("/runs"), error => error === cause);
});
