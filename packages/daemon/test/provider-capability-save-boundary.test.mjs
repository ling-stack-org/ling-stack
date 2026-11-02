import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("HTTP provider saves reject explicit empty capabilities without inheriting or persisting chat", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-provider-empty-capabilities-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, host: "127.0.0.1", port: 0 }, { storeFactory: () => store });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const query = `cwd=${encodeURIComponent(cwd)}`;
    const original = {
      kind: "google",
      displayName: "Google",
      providerId: "google",
      model: "gemini-2.5-pro",
      api: "google-generative-ai",
      capabilities: ["chat", "reasoning"],
      thinkingModes: ["off", "auto", "high"],
      reasoning: true,
      input: ["text"],
      enabled: true,
    };
    const created = await request(`${url}/providers?${query}`, "POST", original);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const provider = created.body.provider;

    const selectedNonChat = {
      ...original,
      model: "gemini-2.5-flash-preview-tts",
      capabilities: [],
      thinkingModes: [],
      reasoning: false,
    };
    for (const [path, method, payload] of [
      [`/providers?${query}`, "POST", selectedNonChat],
      [`/providers/${encodeURIComponent(provider.id)}?${query}`, "PATCH", selectedNonChat],
      [`/providers/import-models?${query}`, "POST", {
        ...original,
        models: [{ id: selectedNonChat.model, capabilities: [], thinkingModes: [] }],
      }],
    ]) {
      const rejected = await request(`${url}${path}`, method, payload);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.message, /capabilities must contain at least one capability/u);
    }

    const unchanged = await request(`${url}/providers?${query}`, "GET");
    assert.equal(unchanged.body.providers.length, 1);
    assert.equal(unchanged.body.providers[0].model, original.model);
    assert.deepEqual(unchanged.body.providers[0].capabilities, original.capabilities);
    assert.deepEqual(unchanged.body.providers[0].thinkingModes, original.thinkingModes);

    const clearThinking = await request(`${url}/providers/${encodeURIComponent(provider.id)}?${query}`, "PATCH", {
      thinkingModes: [], reasoning: false,
    });
    assert.equal(clearThinking.status, 200, JSON.stringify(clearThinking.body));
    assert.deepEqual(clearThinking.body.provider.capabilities, original.capabilities);
    assert.deepEqual(clearThinking.body.provider.thinkingModes, []);
    const persisted = await request(`${url}/providers?${query}`, "GET");
    assert.deepEqual(persisted.body.providers[0].thinkingModes, []);
  } finally {
    await daemon.stop();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function request(url, method, payload) {
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP model import validates enriched and inherited token budgets before any batch writes or checks", async t => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-provider-import-token-budget-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, host: "127.0.0.1", port: 0 }, { storeFactory: () => store });
  let checks = 0;
  const modelServer = createServer((_request, response) => {
    checks += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  await new Promise(resolveReady => modelServer.listen(0, "127.0.0.1", resolveReady));
  t.after(async () => {
    await daemon.stop();
    await new Promise(resolveClosed => modelServer.close(resolveClosed));
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  const modelAddress = modelServer.address();
  const url = `http://127.0.0.1:${address.port}/providers/import-models?cwd=${encodeURIComponent(cwd)}`;
  const original = store.createProviderPreset({ kind: "openai-compatible", displayName: "Token fixture", providerId: "token-fixture",
    model: "custom-saved-model", api: "openai-completions", baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
    authHeader: false, capabilities: ["chat"], contextWindow: 8192, maxTokens: 1024, enabled: true }, "2026-10-23T00:00:00.000Z");
  const input = { kind: original.kind, displayName: original.displayName, providerId: original.providerId,
    api: original.api, baseUrl: original.baseUrl, authHeader: false, capabilities: ["chat"], enabled: true };

  for (const fields of [{ contextWindow: 1024 }, { maxTokens: 8192 }]) {
    const rejected = await request(url, "POST", { ...input, models: [
      { id: "new-before-invalid", contextWindow: 8192, maxTokens: 1024 },
      { id: original.model, ...fields },
    ] });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.message, /maxTokens must be less than contextWindow/);
    assert.deepEqual(store.listProviderPresets(), [original], "invalid later model must not persist an earlier valid model or touch the original");
    assert.equal(checks, 0, "rejected import must not enqueue provider checks");
  }
  const enriched = await request(url, "POST", { ...input, providerId: "openai", models: [
    { id: "gpt-4o", contextWindow: 1024 },
  ] });
  assert.equal(enriched.status, 400, JSON.stringify(enriched.body));
  assert.match(enriched.body.message, /maxTokens must be less than contextWindow/);
  assert.deepEqual(store.listProviderPresets(), [original]);
  assert.equal(checks, 0);
});
