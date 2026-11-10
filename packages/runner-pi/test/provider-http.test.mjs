import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchProvider, PROVIDER_CONNECT_TIMEOUT_MS } from "../dist/provider-http.js";

test("provider dispatcher works with the actual Node fetch on a loopback connection", { timeout: 5000 }, async t => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "loopback-model" }] }));
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetchProvider(`http://127.0.0.1:${server.address().port}/v1/models`, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "loopback-model" }] });
});

test("provider fetch supplies a bounded Undici dispatcher and preserves caller overrides", async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (_input, init) => {
    observed.push(init);
    return new Response("ok");
  };
  try {
    await fetchProvider("https://example.test/v1/chat/completions");
    const customDispatcher = { custom: true };
    await fetchProvider("https://example.test/v1/chat/completions", { dispatcher: customDispatcher });

    assert.equal(observed.length, 2);
    assert.ok(observed[0].dispatcher);
    const optionsSymbol = Object.getOwnPropertySymbols(observed[0].dispatcher)
      .find((symbol) => String(symbol) === "Symbol(options)");
    assert.equal(observed[0].dispatcher?.[optionsSymbol]?.connect?.timeout, PROVIDER_CONNECT_TIMEOUT_MS);
    assert.equal(observed[1].dispatcher, customDispatcher);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
