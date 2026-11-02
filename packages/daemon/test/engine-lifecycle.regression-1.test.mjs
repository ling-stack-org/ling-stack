import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getManagedEnginePackage } from "@ling-stack/contracts";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";
import { EngineManagementController } from "../dist/features/execution-engines/controller.js";
import { EngineManagementAuthority, engineManagementCsrf } from "../dist/features/execution-engines/authority.js";
import { installManagedEngine } from "../dist/features/execution-engines/managed-engine-installer.js";
import { discoverEngines } from "../dist/features/execution-engines/engine-scanner.js";

// Regression: lifecycle completion must remain owned through revocation and shutdown.
// Found by /qa on 2026-10-28
// Report: output/e6-20260928/main374-integration-and-lifecycle-20261028.md
// Value: protects=shutdown drains installs and revoked discovery/install cannot publish;
// fails_when=close omits an active job or completion skips current authority/cancellation;
// why_new=existing lifecycle routes cover completed installs only; seam=none (existing adapters);
// no_claim=registry/native installation acceptance (deferred synthetic installer and discovery).
const origin = "http://127.0.0.1:5175";
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { install, discover } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "ling-engine-lifecycle-regression-"));
  const feature = discover ? undefined : new EngineManagementFeature({ userPaths: { rootDir }, allowedOrigins: [origin], lifecycle: { install } });
  const capability = feature?.credentials.capability ?? "synthetic-only-capability-00000000000";
  const authority = feature ? undefined : new EngineManagementAuthority({ capability, allowedOrigins: [origin] });
  const controller = feature ?? new EngineManagementController({ authority, discover,
    getStore() { throw new Error("discovery must not open a profile store"); } });
  const cleanup = { expectedCloseFailure: undefined };
  const server = createServer((request, response) => void controller.handle(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    let failure;
    try { await feature?.close(); }
    catch (error) { if (error !== cleanup.expectedCloseFailure) failure = error; }
    authority?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
    if (failure) throw failure;
  });
  const host = { Authorization: `Bearer ${capability}`, "X-Ling-Engine-Csrf": engineManagementCsrf(capability) };
  async function request(path, method = "GET", body, credentials = host) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/execution-engines${path}`, {
      method, headers: { Origin: origin, "Content-Type": "application/json", ...credentials },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function browser() {
    const enrollment = await request("/enrollments", "POST", { origin });
    const session = await request("/session", "POST", { code: enrollment.body.code }, {});
    assert.equal(session.status, 200);
    return { Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  }
  const result = { engineId: "claude-agent-sdk", version: "2.1.311", executablePath: join(rootDir, "synthetic-claude"), integrity: "synthetic-only", installedAt: new Date(0).toISOString() };
  return { feature, request, browser, result, cleanup };
}

test("feature close waits for the cancelled install's actual settlement", { timeout: 8000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let signal;
  const f = await fixture(t, { async install(_id, _paths, options) { signal = options.signal; started.resolve(); await release.promise; return f.result; } });
  const request = f.request("/claude-agent-sdk/install", "POST", {});
  await started.promise;
  let closed = false;
  const closing = f.feature.close();
  assert.equal(f.feature.close(), closing, "repeated close must share its settlement");
  closing.then(() => { closed = true; });
  await turn();
  try {
    assert.equal(signal.aborted, true);
    assert.equal(closed, false, "requesting cancellation is not actual drain");
  } finally {
    release.resolve();
    await closing;
    const response = await request;
    assert.equal(response.status, 401);
  }
});

test("a revoked install cannot publish installed after its worker returns late", { timeout: 8000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let signal;
  const f = await fixture(t, { async install(_id, _paths, options) { signal = options.signal; started.resolve(); await release.promise; return f.result; } });
  const browser = await f.browser();
  const pending = f.request("/claude-agent-sdk/install", "POST", {}, browser);
  await started.promise;
  try {
    assert.equal((await f.request("/session", "DELETE", undefined, browser)).status, 200);
    assert.equal(signal.aborted, true);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 401);
  const current = await f.request("/claude-agent-sdk/install");
  assert.equal(current.body.install.phase, "idle");
});

test("discovery is authority-cancelled and cannot reveal a result after revocation", { timeout: 8000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let signal;
  const f = await fixture(t, { async discover(value) { signal = value; started.resolve(); await release.promise;
    return { checkedAt: new Date(0).toISOString(), candidates: [{ executablePath: "/synthetic/private/codex" }] }; } });
  const browser = await f.browser();
  const pending = f.request("/discovery", "GET", undefined, browser);
  await started.promise;
  try {
    await f.request("/session", "DELETE", undefined, browser);
  } finally { release.resolve(); }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(signal?.aborted, true);
  assert.equal(JSON.stringify(response.body).includes("/synthetic/private/codex"), false);
});

test("an already cancelled installer performs no registry request", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "ling-engine-install-preabort-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(installManagedEngine("claude-agent-sdk", { rootDir }, { signal: controller.signal,
    platform: "darwin", arch: "arm64", async fetchImpl() { calls++; throw new Error("synthetic registry must not be reached"); } }));
  assert.equal(calls, 0);
});

test("shutdown preserves a real cleanup failure rather than treating every abort as success", { timeout: 8000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const cleanupFailure = new Error("synthetic cleanup failure");
  const f = await fixture(t, { async install() { started.resolve(); await release.promise; throw cleanupFailure; } });
  f.cleanup.expectedCloseFailure = cleanupFailure;
  const pending = f.request("/claude-agent-sdk/install", "POST", {});
  await started.promise;
  const closing = f.feature.close();
  const expected = assert.rejects(closing, error => error === cleanupFailure);
  release.resolve();
  await expected;
  assert.equal(f.feature.close(), closing);
  assert.equal((await pending).status, 401);
});

test("discovery stops after a cancelled lookup without probing another engine", async () => {
  const controller = new AbortController();
  let lookups = 0;
  await assert.rejects(discoverEngines({ signal: controller.signal,
    async resolveExecutable() { lookups++; controller.abort(); return "/synthetic/must-not-probe"; } }),
    error => error === controller.signal.reason);
  assert.equal(lookups, 1);
});

for (const stage of ["list", "extract"]) test(`cancelled archive ${stage} waits for its owned process to close`, { timeout: 8000 }, async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "ling-engine-tar-cancel-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const controller = new AbortController();
  const bytes = Buffer.from("synthetic archive; only owned Node fixture processes will read the tar stages");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  let owned, closed = false, spawns = 0;
  t.after(async () => {
    if (owned && !closed) {
      const drained = new Promise(resolve => owned.once("close", resolve));
      owned.kill("SIGKILL");
      await drained;
    }
  });
  const pending = installManagedEngine("claude-agent-sdk", { rootDir }, {
    signal: controller.signal, platform: "darwin", arch: "arm64",
    packageOverride: { ...getManagedEnginePackage("claude-agent-sdk"), pinnedIntegrityByPlatform: { "darwin-arm64": integrity } },
    async fetchImpl(url) { return String(url).endsWith(".tgz") ? new Response(bytes) :
      Response.json({ dist: { tarball: "https://registry.npmjs.org/synthetic.tgz", integrity } }); },
    spawnImpl(command, args, options) {
      assert.equal(command, "tar");
      spawns++;
      const cancel = stage === "list" || args[0] === "-xzf";
      const child = spawn(process.execPath, ["--eval", cancel
        ? 'process.stdout.write("owned-ready\\n"); setInterval(() => {}, 1000);'
        : 'process.stdout.write("package/claude\\n");'], options);
      if (cancel) {
        owned = child;
        child.once("close", () => { closed = true; });
        child.stdout.once("data", () => controller.abort());
      }
      return child;
    },
  });
  await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(closed, true, "rejection alone is not child close evidence");
  assert.equal(spawns, stage === "list" ? 1 : 2);
  assert.ok(owned?.pid);
  assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
});
