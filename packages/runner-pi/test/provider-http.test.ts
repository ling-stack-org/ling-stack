import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchProvider, PROVIDER_CONNECT_TIMEOUT_MS } from "../dist/provider-http.js";

type DispatcherRequest = RequestInit & { dispatcher?: object };

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
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetchProvider(`http://127.0.0.1:${address.port}/v1/models`, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "loopback-model" }] });
});

test("provider fetch supplies a bounded Undici dispatcher and preserves caller overrides", async () => {
  const originalFetch = globalThis.fetch;
  const observed: (DispatcherRequest | undefined)[] = [];
  globalThis.fetch = async (_input, init) => {
    observed.push(init);
    return new Response("ok");
  };
  try {
    await fetchProvider("https://example.test/v1/chat/completions");
    const customDispatcher = { custom: true };
    const init: DispatcherRequest = { dispatcher: customDispatcher };
    await fetchProvider("https://example.test/v1/chat/completions", init);

    assert.equal(observed.length, 2);
    const dispatcher = observed[0]?.dispatcher;
    assert.ok(dispatcher);
    const optionsSymbol = Object.getOwnPropertySymbols(dispatcher)
      .find((symbol) => String(symbol) === "Symbol(options)");
    assert.ok(optionsSymbol);
    const options: { connect?: { timeout?: number } } | undefined = Reflect.get(dispatcher, optionsSymbol);
    assert.equal(options?.connect?.timeout, PROVIDER_CONNECT_TIMEOUT_MS);
    assert.equal(observed[1]?.dispatcher, customDispatcher);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
