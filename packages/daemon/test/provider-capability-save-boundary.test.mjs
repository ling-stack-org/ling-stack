import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("HTTP provider saves reject explicit empty capabilities without inheriting or persisting chat", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-provider-empty-capabilities-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
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
