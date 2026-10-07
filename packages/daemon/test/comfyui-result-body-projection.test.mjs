import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setImmediate as nextTick } from "node:timers/promises";

const build = process.env.LING_COMFY_RESULT_BUILD_DIR;
const moduleUrl = build ? pathToFileURL(`${build}/features/media/workflows/comfyui-client.js`)
  : new URL("../dist/features/media/workflows/comfyui-client.js", import.meta.url);
const { ComfyUiClient } = await import(moduleUrl.href);
const { createComfyUiWorkflowAdapter } = await import(new URL("./workflow-adapter.js", moduleUrl).href);
const operationId = "projection_job";
const connection = { id: "fixture", workspaceId: "fixture", name: "fixture", adapterKind: "comfyui",
  baseUrl: "http://127.0.0.1:9", authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "jobs_v1" };
const version = { id: "version", graphSnapshot: {}, inputFields: [],
  outputRules: [{ nodeId: "9", artifactType: "image", collect: "all" }] };
const handle = () => ({ adapterKind: "comfyui", externalOperationId: operationId, recovery: { protocolVariant: "jobs_v1" } });
const observation = rawStatus => ({ protocol: "comfy_jobs_v1", externalOperationId: operationId,
  identitySource: "echoed_id", rawStatus, outcome: rawStatus });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const adapter = fetchImpl => createComfyUiWorkflowAdapter({ store: {}, connection, version, fetchImpl });
const client = fetchImpl => new ComfyUiClient({ connection, fetchImpl });

for (const rawStatus of ["completed", "failed", "cancelled"]) {
  test(`Comfy adapter retains exact ${rawStatus} terminal observation`, async () => {
    const result = await adapter(async () => json({ id: operationId, status: rawStatus })).poll(handle());
    assert.deepEqual(result.terminalObservation, observation(rawStatus));
  });
}

test("Comfy terminal without mapped outputs survives collection failure", async () => {
  const instance = adapter(async () => json({ id: operationId, status: "completed" }));
  const poll = await instance.poll(handle());
  const result = await instance.collectArtifacts({ ...handle(), recovery: poll.recovery });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.terminalObservation, observation("completed"));
});

test("Comfy second download failure returns the first bytes and the real terminal, not a thrown empty result", async () => {
  const requests = [];
  const instance = adapter(async url => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname.startsWith("/api/jobs")) return json({ id: operationId, status: "completed",
      outputs: { "9": { images: [{ filename: "first.png" }, { filename: "second.png" }] } } });
    if (parsed.searchParams.get("filename") === "second.png") throw new Error("fixture second download interrupted");
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } });
  });
  const poll = await instance.poll(handle());
  const result = await instance.collectArtifacts({ ...handle(), recovery: poll.recovery });
  assert.equal(result.status, "failed");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].pathHint, "first.png");
  assert.deepEqual(result.artifacts[0].contentBytes, Uint8Array.of(1, 2, 3));
  assert.deepEqual(result.terminalObservation, observation("completed"));
  assert.deepEqual(requests, [`/api/jobs/${operationId}`, "/api/view", "/api/view"]);
});

test("Comfy reconstructed mutable recovery cannot mint terminal facts", async () => {
  const instance = adapter(async () => new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } }));
  const result = await instance.collectArtifacts({ ...handle(), recovery: { protocolVariant: "jobs_v1",
    terminalObservation: observation("completed"), resultPayload: { outputs: { "9": { images: [{ filename: "restored.png" }] } } },
  } });
  assert.equal(result.status, "succeeded");
  assert.equal(result.terminalObservation, undefined);
});

for (const rawStatus of ["success", "error"]) {
  test(`Comfy legacy adapter retains exact ${rawStatus} pairing`, async () => {
    const instance = adapter(async () => json({ [operationId]: {
      status: { status_str: rawStatus, completed: rawStatus === "success" },
    } }));
    const result = await instance.poll({ ...handle(), recovery: { protocolVariant: "prompt_legacy" } });
    assert.deepEqual(result.terminalObservation, { protocol: "comfy_prompt_legacy_v1",
      externalOperationId: operationId, identitySource: "exact_history_key", rawStatus,
      outcome: rawStatus === "success" ? "completed" : "failed" });
  });
}

test("Comfy complete collection retains terminal and edited handle does not inherit its identity", async () => {
  const instance = adapter(async url => new URL(url).pathname.startsWith("/api/jobs")
    ? json({ id: operationId, status: "completed", outputs: { "9": { images: [{ filename: "complete.png" }] } } })
    : new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } }));
  const poll = await instance.poll(handle());
  const result = await instance.collectArtifacts({ ...handle(), recovery: poll.recovery });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.terminalObservation, observation("completed"));
  const foreign = await instance.collectArtifacts({ ...handle(), externalOperationId: "foreign", recovery: poll.recovery });
  assert.equal(foreign.terminalObservation, undefined);
});

test("Comfy legacy 404 fallback consumes or cancels each body before the next exact request", async () => {
  const requests = [];
  const cleanups = [];
  const responseBodies = [];
  const instance = client(async url => {
    requests.push(new URL(url).pathname);
    const body = new ReadableStream({ start(controller) { responseBodies.push(controller); },
      cancel() { return new Promise(resolve => { cleanups.push(resolve); }); } });
    return new Response(body, { status: 404 });
  });
  const pending = instance.poll(operationId, "prompt_legacy");
  const observedRequestCounts = [];
  for (let index = 0; index < 3; index += 1) {
    await nextTick();
    observedRequestCounts.push(requests.length);
    cleanups[index]?.();
    try { responseBodies[index]?.close(); } catch { /* Already cancelled. */ }
  }
  const result = await pending;
  assert.deepEqual(observedRequestCounts, [1, 2, 3]);
  assert.equal(cleanups.length, 3);
  assert.equal(result.status, "pending");
  assert.equal(result.terminalObservation, undefined);
});

test("Comfy deadline keeps a late rejection observed without an unhandled Promise", async () => {
  let rejectCleanup;
  const body = new ReadableStream({ cancel() { return new Promise((_, reject) => { rejectCleanup = reject; }); } });
  const unhandled = [];
  const observe = error => unhandled.push(error);
  process.on("unhandledRejection", observe);
  try {
    await assert.rejects(client(async () => new Response(body, { status: 404 })).poll(operationId, "jobs_v1"));
    rejectCleanup(new Error("late cleanup failure"));
    await nextTick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
});

for (const [name, status, invoke, shouldReject] of [
  ["poll 404", 404, instance => instance.poll(operationId, "jobs_v1"), false],
  ["poll 500", 500, instance => instance.poll(operationId, "jobs_v1"), false],
  ["cancel 404", 404, instance => instance.cancel(operationId, "jobs_v1"), false],
  ["cancel 500", 500, instance => instance.cancel(operationId, "jobs_v1"), true],
  ["submit 500", 500, instance => instance.submit({}, "jobs_v1"), true],
  ["redirect", 302, instance => instance.poll(operationId, "jobs_v1"), true],
  ["oversize download", 200, instance => instance.downloadOutput({ filename: "large.png", artifactType: "image" }), true],
]) {
  test(`Comfy ${name} awaits actual response body cleanup before returning`, async () => {
    let finishCleanup;
    let controller;
    let cancelCalls = 0;
    const cleanup = new Promise(resolve => { finishCleanup = resolve; });
    const body = new ReadableStream({ start(value) { controller = value; },
      cancel() { cancelCalls += 1; return cleanup; } });
    const response = new Response(body, { status, headers: name === "oversize download" ? { "content-length": "99999999" } : {} });
    let settled = false;
    const pending = invoke(client(async () => response));
    pending.then(() => { settled = true; }, () => { settled = true; });
    await nextTick();
    const before = { settled, cancelCalls };
    finishCleanup();
    try { controller.close(); } catch { /* A successful cancellation already closed the fixture stream. */ }
    if (shouldReject) await assert.rejects(pending);
    else await pending;
    assert.equal(before.cancelCalls, 1, "early return must await native response cleanup");
    assert.equal(before.settled, false, "cleanup started is not cleanup completed");
  });
}

test("Comfy failed cleanup stays unknown instead of silently becoming a completed 404 observation", async () => {
  const body = new ReadableStream({ cancel() { throw new Error("fixture cleanup interrupted"); } });
  await assert.rejects(client(async () => new Response(body, { status: 404 })).poll(operationId, "jobs_v1"), /清理|cleanup/i);
});

test("Comfy a stalled cleanup is bounded, observed, and never minted as terminal", async () => {
  const body = new ReadableStream({ cancel() { return new Promise(() => {}); } });
  const started = Date.now();
  await assert.rejects(client(async () => new Response(body, { status: 404 })).poll(operationId, "jobs_v1"), /清理|cleanup/i);
  assert.ok(Date.now() - started < 2500, "cleanup must have a fixed deadline");
});
