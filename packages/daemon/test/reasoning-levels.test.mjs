import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { listProviderModels } from "../dist/features/providers/models.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { parseTaskRunRequest } from "../dist/features/tasks/schemas.js";
import { resolveProviderRunThinkingLevel } from "../dist/features/runs/providers.js";

test("run and task requests preserve max and ultra and reject unknown levels", () => {
  for (const thinkingLevel of ["max", "ultra"]) {
    const request = parseRunRequest({ cwd: "/workspace", task: { id: "test", title: "Test", prompt: "Test" }, providerPresetId: "relay", thinkingLevel });
    assert.equal(request.thinkingLevel, thinkingLevel);
    assert.equal(parseTaskRunRequest({ providerPresetId: "relay", thinkingLevel }).thinkingLevel, thinkingLevel);
  }
  assert.throws(() => parseTaskRunRequest({ providerPresetId: "relay", thinkingLevel: "future-level" }), /thinkingLevel/);
});

test("unsupported top levels fail explicitly instead of silently turning reasoning off", () => {
  for (const level of ["max", "ultra"]) {
    assert.equal(resolveProviderRunThinkingLevel({ reasoning: true, thinkingLevelMap: { [level]: level } }, level), level);
    for (const provider of [{}, { reasoning: false }, { thinkingLevelMap: { [level]: null } }]) {
      assert.throws(() => resolveProviderRunThinkingLevel(provider, level), /does not support reasoning level/);
    }
  }
});

test("inline provider parsing preserves and validates the declared effort map", () => {
  const base = { cwd: "/workspace", task: { id: "test", title: "Test", prompt: "Test" } };
  const provider = { provider: "relay", model: "fixture", reasoning: true,
    thinkingLevelMap: { max: "max", ultra: "ultra", off: null } };
  for (const thinkingLevel of ["max", "ultra"]) {
    const request = parseRunRequest({ ...base, provider, thinkingLevel });
    assert.deepEqual(request.provider.thinkingLevelMap, provider.thinkingLevelMap);
    assert.equal(resolveProviderRunThinkingLevel(request.provider, request.thinkingLevel), thinkingLevel);
  }
  for (const thinkingLevelMap of [[], "max", { max: true }, { future: "future" }]) {
    assert.throws(() => parseRunRequest({ ...base, provider: { ...provider, thinkingLevelMap } }), /thinkingLevelMap/);
  }
});

test("Responses discovery uses explicit levels before protocol fallback and honors disabled reasoning", async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [
      { id: "relay-model", thinking_modes: ["xhigh", "max", "ultra"] },
      { id: "gpt-6.1-sol" },
      { id: "gpt-6.1-sol-2026-10-01", reasoning: false },
      { id: "gpt-6.1-sol-2026-10-02", thinking_modes: [] },
    ] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await listProviderModels({}, { kind: "openai-compatible", providerId: "relay", api: "openai-responses",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture" }, {});
  const modes = new Map(result.models.map(model => [model.id, model.thinkingModes]));
  assert.deepEqual(modes.get("relay-model"), ["xhigh", "max", "ultra"]);
  assert.deepEqual(modes.get("gpt-6.1-sol"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modes.get("gpt-6.1-sol-2026-10-01"), []);
  assert.deepEqual(modes.get("gpt-6.1-sol-2026-10-02"), []);
});
