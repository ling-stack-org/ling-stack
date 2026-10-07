import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const emptySecrets = { status: ref => ({ ref, configured: false }), resolve: ref => ({ ref, configured: false }) };

async function delayedImageServer(t) {
  let release, requested;
  const released = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the actual generation request. */ }
    requested();
    await released;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, started, release };
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

test("real daemon shutdown drains the actual media HTTP and artifact writer before closing SQLite", { timeout: 8000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-local-production-"));
  const store = createSqliteRunStore(cwd);
  const upstream = await delayedImageServer(t);
  const provider = configureProviders(store, upstream.url);
  let closed = false, mediaJobId, stopped = false, stopPromise;
  const originalClose = store.close.bind(store);
  store.close = () => { closed = true; return originalClose(); };
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
    upstream.release();
    await (stopPromise ?? daemon.stop());
    // The RED implementation has detached writers. Let their actual error
    // surface before deleting only this test's unique temporary directory.
    await new Promise(resolve => setTimeout(resolve, 20));
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/conversations/stream?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Generate one local fixture image.", providerPresetId: provider.id }),
  });
  assert.equal(response.status, 200);
  const transcript = response.text();
  await upstream.started;
  await transcript;
  assert.ok(mediaJobId, "the real conversation handler must create and dispatch a Media job");
  assert.equal(store.getMediaJob(mediaJobId).status, "running");
  stopPromise = daemon.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(stopped, false, "a returned tool result or a completed parent Run cannot retire the background HTTP writer");
  assert.equal(closed, false, "SQLite must remain open while the actual media writer is pending");
  upstream.release();
  await stopPromise;
  assert.equal(closed, true);
});
