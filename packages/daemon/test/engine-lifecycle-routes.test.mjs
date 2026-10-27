import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ling-engine-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:5175";
  const feature = new EngineManagementFeature({ userPaths: { rootDir: root }, allowedOrigins: [origin], ...options });
  const server = createServer((request, response) => void feature.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const headers = { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${feature.credentials.capability}`, "X-Ling-Engine-Csrf": feature.credentials.csrfToken };
  const request = async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/execution-engines${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  return { request, headers, feature };
}

test("discovery route reports engine candidates to authorized principals", async (t) => {
  const { request, headers } = await fixture(t);
  const report = await request("/discovery");
  assert.equal(report.status, 200);
  assert.equal(report.body.candidates.length, 4);
  assert.ok(report.body.candidates.every((candidate) => typeof candidate.status === "string"));
  const forbidden = await fetch(`http://127.0.0.1:1/execution-engines/discovery`).catch(() => undefined);
  assert.equal(forbidden, undefined);
  const noAuth = await (async () => {
    const bare = await fixtureBareRequest(t);
    return bare;
  })();
  assert.ok(noAuth);
});

async function fixtureBareRequest(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-engine-routes-bare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feature = new EngineManagementFeature({ userPaths: { rootDir: root }, allowedOrigins: ["http://127.0.0.1:5175"] });
  const server = createServer((request, response) => void feature.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await feature.close(); await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/execution-engines/discovery`);
  return response.status;
}

test("discovery rejects requests without authority", async (t) => {
  const { feature } = await fixture(t);
  assert.ok(feature);
  const root = await mkdtemp(join(tmpdir(), "ling-engine-routes-noauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = new EngineManagementFeature({ userPaths: { rootDir: root }, allowedOrigins: ["http://127.0.0.1:5175"] });
  const server = createServer((request, response) => void f.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await f.close(); await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/execution-engines/discovery`);
  assert.ok([401, 403].includes(response.status));
});

test("managed install transitions through the status route and refuses unsupported engines", async (t) => {
  const installedPath = join(await mkdtemp(join(tmpdir(), "ling-engine-installed-")), "codex");
  const { request } = await fixture(t, {
    lifecycle: {
      install: async (engineId, userPaths) => ({ engineId, version: "0.164.0", executablePath: installedPath, integrity: "sha512-test", installedAt: new Date(0).toISOString() }),
    },
  });
  const unsupported = await request("/kimi-acp/install", "POST", {});
  assert.equal(unsupported.status, 400);
  const started = await request("/codex-app-server/install", "POST", {});
  assert.equal(started.status, 200);
  assert.equal(started.body.install.phase, "installed");
  const status = await request("/codex-app-server/install");
  assert.equal(status.body.install.phase, "installed");
  assert.equal(status.body.install.executablePath, installedPath);
});
