import assert from "node:assert/strict";
import test from "node:test";
import { fetchProvider, PROVIDER_CONNECT_TIMEOUT_MS } from "../dist/provider-http.js";

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
