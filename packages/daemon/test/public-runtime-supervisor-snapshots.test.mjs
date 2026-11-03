import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { handleGetRuntimeSupervisor } from "../dist/runtime/routes.js";

test("supervisor HTTP projects every nested Run-owned collection without changing service facts", async t => {
  const canary = "PRIVATE_SUPERVISOR_MEMORY_BODY";
  const diagnostics = {
    runtime: { id: "runtime_fixture", status: "healthy" }, leases: [], semaphoreSlots: [],
    ...Object.fromEntries(["active", "stuck", "queued", "stale"].map((name, index) => [name, [{
      id: `work_${name}`, kind: ["task_run", "conversation_run", "channel_ai_reply", "teammate_direct_reply"][index],
      status: name === "active" ? "running" : name,
      request: { task: { prompt: "Accepted objective" }, runnerExecutionInput: { input: { systemPrompt: canary } },
        systemPrompt: canary, appendSystemPrompt: [canary], preselectedMemoryUse: { renderedPrompt: canary },
        userPayload: { systemPrompt: "User-authored domain field" } },
    }]])),
  };
  const before = structuredClone(diagnostics);
  const server = createServer((request, response) => handleGetRuntimeSupervisor(response,
    new URL(request.url, "http://localhost"), { getStore: () => ({}) }, { getDiagnostics: () => diagnostics }));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/runtime/supervisor?cwd=fixture`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(canary, "u"));
  for (const name of ["active", "stuck", "queued", "stale"]) {
    assert.equal(body[name][0].id, `work_${name}`);
    assert.deepEqual(body[name][0].request, { task: { prompt: "Accepted objective" },
      userPayload: { systemPrompt: "User-authored domain field" } });
  }
  assert.deepEqual(body.runtime, diagnostics.runtime);
  assert.deepEqual(body.leases, diagnostics.leases);
  assert.deepEqual(body.semaphoreSlots, diagnostics.semaphoreSlots);
  assert.deepEqual(diagnostics, before);
});
