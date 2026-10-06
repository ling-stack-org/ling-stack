import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listProviderModels } from "../dist/features/providers/models.js";

test("native Gemini discovery retains explicitly empty upstream capabilities", async () => {
  const model = await discoverModel({ capabilities: [] });
  assert.deepEqual(model.capabilities, []);
  assert.equal(model.capabilitySource, "upstream");
  assert.equal(model.contextWindow, 1048576);
});

test("native Gemini discovery retains explicitly empty upstream thinking modes", async () => {
  for (const field of ["thinkingModes", "thinking_modes", "reasoningLevels", "reasoning_levels"]) {
    const model = await discoverModel({ [field]: [] });
    assert.deepEqual(model.thinkingModes, [], field);
    assert.equal(model.thinkingSupport, undefined, field);
  }
});

test("native Gemini discovery retains empty thinking support and explicit false flags", async () => {
  const model = await discoverModel({
    thinking_support: { levels: [], dynamic_allowed: false, zero_allowed: false },
  });
  assert.deepEqual(model.thinkingModes, []);
  assert.deepEqual(model.thinkingSupport, { levels: [], dynamicAllowed: false, zeroAllowed: false });
});

test("native Gemini discovery gives explicit empty thinking modes priority over support levels", async () => {
  const model = await discoverModel({
    thinkingModes: [],
    thinking_support: { levels: ["off", "high"], dynamic_allowed: false, zero_allowed: false },
  });
  assert.deepEqual(model.thinkingModes, []);
  assert.equal(model.thinkingSupport.dynamicAllowed, false);
  assert.equal(model.thinkingSupport.zeroAllowed, false);
});

test("native Gemini discovery preserves an explicit off mode", async () => {
  const model = await discoverModel({ thinkingModes: ["off"] });
  assert.deepEqual(model.thinkingModes, ["off"]);
  assert.equal(model.thinkingSupport, undefined);
});

test("native Gemini discovery preserves non-empty thinking support and false flags", async () => {
  const model = await discoverModel({
    thinking_support: { levels: ["low", "high"], dynamic_allowed: false, zero_allowed: false, min_tokens: 128 },
  });
  assert.deepEqual(model.thinkingModes, ["low", "high"]);
  assert.deepEqual(model.thinkingSupport, {
    levels: ["low", "high"], dynamicAllowed: false, zeroAllowed: false, minTokens: 128,
  });
});

test("native Gemini discovery keeps family fallback when upstream thinking metadata is missing", async () => {
  const model = await discoverModel({});
  assert.deepEqual(model.thinkingModes, ["off", "auto", "low", "medium", "high"]);
  assert.equal(model.thinkingSupport.dynamicAllowed, true);
});

async function discoverModel(metadata) {
  const apiKey = "gemini-model-metadata-test-key";
  const server = createServer((request, response) => {
    assert.equal(request.url, "/models");
    assert.equal(request.headers["x-goog-api-key"], apiKey);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ models: [{
      name: "models/gemini-2.5-pro",
      supportedGenerationMethods: ["generateContent"],
      ...metadata,
    }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await listProviderModels({}, {
      kind: "google", providerId: "google", api: "google-generative-ai",
      baseUrl: `http://127.0.0.1:${address.port}`, apiKey,
    }, {
      resolve() { throw new Error("Discovery must not resolve another credential."); },
      status() { throw new Error("Discovery must not inspect another credential."); },
    });
    assert.equal(result.models.length, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
    return result.models[0];
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    });
  }
}
