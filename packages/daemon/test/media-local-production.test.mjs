import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installOwnedMediaNativeObserver } from "./support/media-owned-native-observer.mjs";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";

// Establish owned storage and the native observer before product imports capture
// fetch or config. No daily workspace, Provider or synthetic Response is used.
const ownedRoot = await mkdtemp(join(tmpdir(), "ling-media-local-production-"));
const isolatedHome = join(ownedRoot, "user"), initialWorkspace = join(ownedRoot, "initial-workspace");
await Promise.all([mkdir(isolatedHome), mkdir(initialWorkspace)]);
const originalEnvironment = new Map(["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]
  .map(key => [key, process.env[key]]));
process.env.LING_STACK_HOME = isolatedHome;
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = initialWorkspace;
after(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(ownedRoot, { recursive: true, force: true });
});
const nativeObserver = installOwnedMediaNativeObserver();
after(() => nativeObserver.restore());
const { createSqliteRunStore } = await import("@ling-stack/core");
const { createDaemonServer } = await import("../dist/index.js");

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const emptySecrets = { status: ref => ({ ref, configured: false }), resolve: ref => ({ ref, configured: false }) };

async function delayedImageServer() {
  let release, requested;
  let released = false, targetClosed = false, sends = 0;
  const releaseGate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the actual generation request. */ }
    assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/images/generations");
    sends++;
    response.once("close", () => { targetClosed = true; });
    // Enter actual native body consumption before shutdown, not only a response
    // header wait. The non-cooperative case still has to read the original EOF.
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":[{"b64_json":"');
    requested();
    await releaseGate;
    if (!response.destroyed) response.end(`${png}"}]}`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, started,
    get released() { return released; }, get targetClosed() { return targetClosed; }, get sends() { return sends; },
    release() { released = true; release(); },
    async close() {
      released = true; release();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}

function configureProviders(store, baseUrl) {
  const now = new Date().toISOString();
  const chat = store.createProviderPreset({ kind: "glm", displayName: "Local lifecycle fixture", providerId: "media-lifecycle-chat",
    model: "media-lifecycle-model", api: "google-generative-ai", capabilities: ["chat"], authHeader: false, enabled: true }, now);
  const image = store.createProviderPreset({ kind: "openai", displayName: "Delayed local image server", providerId: "openai",
    model: "gpt-image-1", api: "media-job", baseUrl, capabilities: ["image_generate"],
    compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, now);
  store.setProviderSecret(image.id, "local-fixture-only", now);
  store.updateProviderPreset(image.id, { apiKeyRef: `local:${image.id}` }, now);
  for (const provider of [chat, image]) store.recordProviderCheckResult(provider.id,
    { ok: true, code: "ready", message: "Local test server is ready.", checkedAt: now });
  store.updateWorkspaceSettings({ defaultProviderPresetId: chat.id,
    mediaGenerationDefaults: { image: { kind: "provider", providerPresetId: image.id } } }, now);
  return chat;
}

for (const sender of ["non-cooperative", "cooperative"]) test(
  `real daemon shutdown ${sender === "non-cooperative" ? "drains the actual media HTTP and artifact writer before closing SQLite" : "waits for cooperative native abort before releasing SQLite"}`,
  { timeout: 15_000, concurrency: false }, async t => {
  const cwd = await mkdtemp(join(ownedRoot, "workspace-"));
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const store = createSqliteRunStore(cwd);
  const upstream = await delayedImageServer();
  const wire = nativeObserver.register({ ignoreSignal: sender === "non-cooperative", matches: value =>
    value === `${upstream.url}/images/generations` });
  const provider = configureProviders(store, upstream.url);
  let closed = false, mediaJobId, stopped = false, stopPromise, ownerProbe, closeFacts;
  const originalClose = store.close.bind(store);
  store.close = () => {
    closeFacts = { ownerBusy: ownerProbe ? ownerIsBusy(ownerProbe) : undefined, native: { ...wire.record },
      job: mediaJobId ? store.getMediaJob(mediaJobId) : undefined,
      artifacts: mediaJobId ? store.listMediaJobArtifacts(mediaJobId) : [] };
    closed = true;
    return originalClose();
  };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    secretResolver: emptySecrets,
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    runner: { prepareTaskInput: prepareFixtureTaskInput, async runTask(options) {
      const result = await options.onMediaGenerationToolCall({ toolCallId: "actual-local-image", toolName: "image_generate",
        runId: options.runId, prompt: "A single fixture pixel.", task: options.task, cwd: options.cwd, signal: options.signal });
      assert.equal(result.isError, undefined);
      mediaJobId = result.details.mediaJobId;
      return { taskId: options.task.id, messages: [], events: [] };
    } },
  });
  t.after(async () => {
    // Cleanup can release only this owned upstream. It cannot turn an earlier
    // failed assertion into GREEN or replace actual native/body settlement.
    upstream.release();
    try { await bounded(stopPromise ?? daemon.stop(), "owned daemon cleanup", 6_500); }
    finally { ownerProbe?.close(); wire.close(); await upstream.close(); }
  });
  await daemon.start();
  ownerProbe = new DatabaseSync(join(store.paths.rootDir, "runtime.lock.coordination.sqlite"));
  ownerProbe.exec("PRAGMA busy_timeout=0");
  assert.equal(ownerIsBusy(ownerProbe), true, "the actual runtime owner holds its independent SQLite writer lease");
  const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/conversations/stream?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Generate one local fixture image.", providerPresetId: provider.id }),
  });
  assert.equal(response.status, 200);
  const transcript = response.text();
  await upstream.started;
  await transcript;
  await waitUntil(() => wire.record?.response, "the original native response enters body consumption");
  assert.ok(mediaJobId, "the real conversation handler must create and dispatch a Media job");
  assert.equal(store.getMediaJob(mediaJobId).status, "running");
  const abortObserved = new Promise(resolve => wire.record.signal.addEventListener("abort", () => resolve({ closed }), { once: true }));
  stopPromise = daemon.stop().then(() => { stopped = true; });
  assert.equal(stopped, false, "same-stack stop request is not actual native body settlement");
  assert.equal(closed, false);
  assert.equal((await abortObserved).closed, false, "the actual abort phase must precede SQLite close");
  assert.equal(wire.record.signal.aborted, true);
  if (sender === "non-cooperative") {
    await delay(75);
    assert.equal(stopped, false, "a returned tool result or completed parent Run cannot retire an actual non-cooperative HTTP writer");
    assert.equal(closed, false, "SQLite remains open while the actual media writer is pending");
    assert.equal(ownerIsBusy(ownerProbe), true, "shutdown does not release the original SQLite owner before real EOF");
    assert.equal(store.getMediaJob(mediaJobId).status, "running");
    assert.equal(wire.record.ignoreSignal, true); assert.equal(wire.record.aborts, 1);
    assert.equal(wire.record.bodySettled, 0); assert.equal(wire.record.completedEof, false);
    assert.equal(upstream.targetClosed, false); assert.equal(upstream.released, false);
    upstream.release();
    await bounded(stopPromise, "real non-cooperative EOF, artifact writer and daemon stop");
    assert.equal(closeFacts.native.completedEof, true); assert.equal(closeFacts.native.bodySettled, 1);
    assert.equal(closeFacts.native.bodyRejected, 0); assert.equal(closeFacts.job.status, "succeeded");
    const artifact = closeFacts.artifacts.find(item => item.type === "image");
    assert.ok(artifact, "real completed bytes must be persisted before SQLite close");
    assert.deepEqual(await readFile(join(store.paths.artifactsDir, artifact.path)), Buffer.from(png, "base64"));
  } else {
    await bounded(stopPromise, "original cooperative body abort and daemon stop before fixture release");
    await waitUntil(() => upstream.targetClosed, "local native abort closes the actual upstream response");
    assert.equal(upstream.released, false, "fixture EOF must not be responsible for product stop");
    assert.equal(closeFacts.native.ignoreSignal, false); assert.equal(closeFacts.native.aborts, 1);
    assert.equal(closeFacts.native.fetchSettled, 1); assert.equal(closeFacts.native.bodySettled, 1);
    assert.equal(closeFacts.native.bodyRejected, 1); assert.equal(closeFacts.native.completedEof, false);
    assert.equal(closeFacts.job.status, "running", "local abort cannot fabricate remote failure or success");
    assert.deepEqual(closeFacts.artifacts, [], "aborted body cannot mint a successful artifact");
  }
  assert.deepEqual(wire.record.errors, []); assert.equal(upstream.sends, 1);
  assert.equal(closeFacts.ownerBusy, false, "SQLite closes only after the actual runtime owner release");
  assert.equal(ownerIsBusy(ownerProbe), false);
  assert.equal(closed, true);
});

/** A different connection probes the real owner; successful probes roll back immediately. */
function ownerIsBusy(connection) {
  try { connection.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    assert.equal(typeof error.errcode, "number"); assert.equal(error.errcode & 0xff, 5);
    return true;
  }
  connection.exec("ROLLBACK"); return false;
}

async function bounded(promise, description, timeoutMs = 2_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
  })]); }
  finally { clearTimeout(timer); }
}

async function waitUntil(read, description) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (read()) return; await delay(10); }
  assert.fail(description);
}
