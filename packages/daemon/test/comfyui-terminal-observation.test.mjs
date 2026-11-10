import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";

const clientModule = process.env.LING_COMFY_CLIENT_MODULE
  ? pathToFileURL(process.env.LING_COMFY_CLIENT_MODULE).href
  : new URL("../dist/features/media/workflows/comfyui-client.js", import.meta.url).href;
const { ComfyUiClient } = await import(clientModule);
const operationId = "exact-operation";
const outputs = { "9": { images: [{ filename: "partial.png", type: "output" }] } };

for (const rawStatus of ["completed", "failed", "cancelled"]) {
  test(`jobs_v1 observes only exact ${rawStatus} as a typed terminal fact`, async () => {
    const result = await mockClient({ id: operationId, status: rawStatus, outputs }).poll(operationId, "jobs_v1");
    assert.equal(result.status, rawStatus === "completed" ? "succeeded" : "failed");
    assert.deepEqual(result.terminalObservation, {
      protocol: "comfy_jobs_v1", externalOperationId: operationId, identitySource: "echoed_id",
      rawStatus, outcome: rawStatus,
    });
  });
}

for (const [name, response] of [
  ["pending with partial outputs", { id: operationId, status: "pending", outputs }],
  ["running with partial outputs", { id: operationId, status: "in_progress", outputs }],
  ["missing status with outputs", { id: operationId, outputs }],
  ["success alias", { id: operationId, status: "success", outputs }],
  ["succeeded alias", { id: operationId, status: "succeeded", outputs }],
  ["unknown status", { id: operationId, status: "done", outputs }],
  ["foreign identity", { id: "foreign-operation", status: "completed", outputs }],
  ["foreign failure identity", { id: "foreign-operation", status: "failed" }],
  ["foreign cancellation identity", { id: "foreign-operation", status: "cancelled" }],
  ["missing identity", { status: "completed", outputs }],
  ["foreign secondary identity", { id: operationId, prompt_id: "foreign-operation", status: "completed", outputs }],
  ["nested legacy status", { id: operationId, status: { status_str: "success", completed: true }, outputs }],
  ["contradictory execution status", { id: operationId, status: "completed", execution_status: { status_str: "error", completed: false }, outputs }],
  ["unknown normalized execution status", { id: operationId, status: "completed", execution_status: { status_str: "unknown", completed: false }, outputs }],
  ["uppercase status", { id: operationId, status: "COMPLETED", outputs }],
  ["malformed response", []],
]) {
  test(`jobs_v1 ${name} remains nonterminal`, async () => {
    const result = await mockClient(response).poll(operationId, "jobs_v1");
    assert.equal(result.status, "pending");
    assert.equal(result.terminalObservation, undefined);
  });
}

for (const [rawStatus, completed, expected] of [["success", true, "completed"], ["error", false, "failed"]]) {
  test(`legacy exact history ${rawStatus}/${completed} is the closed final status contract`, async () => {
    const result = await mockClient({ [operationId]: {
      status: { status_str: rawStatus, completed }, outputs,
      prompt: [0, operationId, {}, {}, []],
    } }).poll(operationId, "prompt_legacy");
    assert.equal(result.status, expected === "completed" ? "succeeded" : "failed");
    assert.deepEqual(result.terminalObservation, {
      protocol: "comfy_prompt_legacy_v1", externalOperationId: operationId, identitySource: "exact_history_key",
      rawStatus, outcome: expected,
    });
  });
}

for (const [name, response] of [
  ["foreign history key", { foreign: { status: { status_str: "success", completed: true }, outputs } }],
  ["unscoped top-level entry", { id: operationId, status: { status_str: "success", completed: true }, outputs }],
  ["partial outputs while running", { [operationId]: { status: { status_str: "running", completed: false }, outputs } }],
  ["missing completed field", { [operationId]: { status: { status_str: "success" }, outputs } }],
  ["nonboolean completed field", { [operationId]: { status: { status_str: "success", completed: "true" }, outputs } }],
  ["contradictory success", { [operationId]: { status: { status_str: "success", completed: false }, outputs } }],
  ["contradictory error", { [operationId]: { status: { status_str: "error", completed: true }, outputs } }],
  ["unknown completed status", { [operationId]: { status: { status_str: "completed", completed: true }, outputs } }],
  ["foreign prompt tuple", { [operationId]: { prompt: [0, "foreign-operation", {}, {}, []], status: { status_str: "success", completed: true }, outputs } }],
  ["foreign echoed id", { [operationId]: { id: "foreign-operation", status: { status_str: "success", completed: true }, outputs } }],
  ["cancel alias", { [operationId]: { status: { status_str: "cancelled", completed: false }, outputs } }],
]) {
  test(`legacy ${name} remains nonterminal`, async () => {
    const result = await mockClient(response).poll(operationId, "prompt_legacy");
    assert.equal(result.status, "pending");
    assert.equal(result.terminalObservation, undefined);
  });
}

test("404 and HTTP query failure are not remote terminal observations", async () => {
  for (const variant of ["jobs_v1", "prompt_legacy"]) {
    for (const status of [404, 500]) {
      const result = await mockClient({ error: "not found" }, status).poll(operationId, variant);
      assert.equal(result.status, status === 404 ? "pending" : "failed");
      assert.equal(result.terminalObservation, undefined);
    }
  }
});

test("a terminal observation is emitted only after the complete response body has been consumed", async () => {
  let body;
  const stream = new ReadableStream({ start(controller) {
    body = controller;
    controller.enqueue(new TextEncoder().encode(`{"id":"${operationId}","status":"completed"`));
  } });
  const client = mockClient(undefined, 200, async () => new Response(stream, { status: 200 }));
  let settled = false;
  const pending = client.poll(operationId, "jobs_v1");
  pending.then(() => { settled = true; }, () => { settled = true; });
  await nextTick();
  const beforeBodyEnd = settled;
  body.enqueue(new TextEncoder().encode("}"));
  body.close();
  const result = await pending;
  assert.equal(beforeBodyEnd, false, "headers and partial body must not produce a terminal observation");
  assert.equal(result.terminalObservation?.outcome, "completed");
  assert.equal(Object.isFrozen(result.terminalObservation), true);
  assert.throws(() => { result.terminalObservation.outcome = "failed"; }, TypeError);
});

test("malformed or interrupted response body cannot produce a terminal fact", async () => {
  for (const response of [new Response("{broken-json"), new Response(new ReadableStream({
    start(controller) { controller.error(new Error("interrupted status body")); },
  }))]) {
    const client = mockClient(undefined, 200, async () => response);
    await assert.rejects(client.poll(operationId, "jobs_v1"));
  }
});

test("closed exact terminal states do not infer successful artifact collection", async () => {
  for (const value of [{ id: operationId, status: "completed" },
    { id: operationId, status: "completed", execution_status: { status_str: "success", completed: true } }]) {
    const result = await mockClient(value).poll(operationId, "jobs_v1");
    assert.equal(result.terminalObservation?.outcome, "completed");
    assert.deepEqual(mockClient().collectOutputFiles(result.payload, [{ nodeId: "9", artifactType: "image", collect: "all" }]), []);
    assert.equal(Object.hasOwn(result.terminalObservation, "safe"), false);
  }
});

test("legacy fallback probes exact history routes but never accepts a foreign history record", async () => {
  const paths = [];
  const client = mockClient(undefined, 200, async url => {
    paths.push(new URL(url).pathname);
    return paths.length < 3 ? jsonResponse({}, 404) : jsonResponse({
      foreign: { status: { status_str: "success", completed: true }, outputs },
    });
  });
  const result = await client.poll(operationId, "prompt_legacy");
  assert.equal(result.status, "pending");
  assert.equal(result.terminalObservation, undefined);
  assert.deepEqual(paths, [`/api/history_v2/${operationId}`, `/api/history/${operationId}`, `/history/${operationId}`]);
});

test("a real scoped status request after cancel ACK is still pending until an observed terminal", async t => {
  const requests = [];
  let status = "in_progress";
  const server = createServer((request, response) => {
    request.resume();
    requests.push([request.method, request.url]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "POST"
      ? { id: operationId, status: "cancelled", accepted: true }
      : { id: operationId, status, outputs }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const client = new ComfyUiClient({ connection: connection({
    baseUrl: `http://127.0.0.1:${server.address().port}`, networkPolicy: "trusted_private_network",
  }) });
  assert.equal(await client.cancel(operationId, "jobs_v1"), true);
  assert.equal((await client.poll(operationId, "jobs_v1")).status, "pending");
  status = "cancelled";
  const terminal = await client.poll(operationId, "jobs_v1");
  assert.equal(terminal.terminalObservation?.rawStatus, "cancelled");
  assert.deepEqual(requests, [["POST", `/api/jobs/${operationId}/cancel`],
    ["GET", `/api/jobs/${operationId}`], ["GET", `/api/jobs/${operationId}`]]);
  assert.equal(await client.cancel(operationId, "prompt_legacy"), false);
  assert.equal(requests.length, 3, "legacy cancellation must not issue global interrupt");
});

function mockClient(value, status = 200, fetchImpl = async () => jsonResponse(value, status)) {
  return new ComfyUiClient({ connection: connection(), fetchImpl,
    resolveHostAddresses: async () => ["203.0.113.10"] });
}

function connection(overrides = {}) {
  return { id: "connection", workspaceId: "workspace_default", name: "Comfy",
    adapterKind: "comfyui", baseUrl: "https://comfy.example.test", authMode: "none",
    networkPolicy: "public_only", protocolVariant: "auto", status: "ready",
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", ...overrides };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
