import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "smol-toml";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";
import { prepareKimiExecutionHome } from "../dist/runtime/acp/kimi-execution-home.js";
import { NativeSecretRegistry, redactNativeOutput } from "../dist/runtime/adapters/native-stream-redaction.js";

const token = (name, expired = false) => ({ access_token: `${name}-access-sentinel`, refresh_token: `${name}-refresh-sentinel`,
  expires_at: expired ? 1 : Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, scope: "model", token_type: "Bearer" });

async function fixture(t, { protocol = "openai", expired = false, refresh } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-oauth-model-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const store = new ExecutionEngineProfileStore(paths);
  const profile = store.save({ engineId: "kimi-acp", executablePath: process.execPath,
    authProfileId: "test", kimiLoginRegion: "global" }, 0);
  const home = await prepareNativeAuthHome(paths, profile.configuration);
  await mkdir(join(home, "credentials"));
  const slot = join(home, "credentials", "kimi-code.json");
  await writeFile(slot, JSON.stringify(token("initial", expired)), { mode: 0o600 });
  const received = [], refreshes = [], registry = new NativeSecretRegistry();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    if (request.url === "/token") {
      refreshes.push(new URLSearchParams(body));
      if (refresh) return refresh(request, response);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(token("rotated"))); return;
    }
    received.push({ path: request.url, body: JSON.parse(body), headers: request.headers });
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end("data: local fixture\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { default_model: "default", providers: { selected: { type: ["openai", "kimi"].includes(protocol) ? protocol : "kimi", api_key: "",
    base_url: `${base}/unused/v1`, oauth: { storage: "file", key: "oauth/kimi-code", oauth_host: "https://auth.kimi.ai" },
    custom_headers: { "x-vendor-secret": "vendor-sentinel" } } }, models: {
    default: { provider: "selected", model: "default-wire", max_context_size: 32000 },
    chosen: { provider: "selected", model: "chosen-wire", ...(["anthropic", "openai_responses"].includes(protocol) ? { protocol } : {}),
      base_url: `${base}/chosen/v1`, max_context_size: 64000 } } };
  await writeFile(join(home, "config.toml"), stringify(config), { mode: 0o600 });
  const controller = new AbortController();
  const authentication = { store, profile, region: "global", fetchImpl(url, init) {
    assert.equal(String(url), "https://auth.kimi.ai/api/oauth/token"); return fetch(`${base}/token`, init);
  } };
  const prepare = async (overrides = {}) => {
    const projected = await prepareKimiExecutionHome(home, { policy: { toolDecisions: {}, allowedWritePaths: [] } }, false,
      controller.signal, { modelId: "chosen", authentication, secretRegistry: registry, ...overrides });
    t.after(() => projected.dispose());
    const configuration = parse(await readFile(join(projected.home, "config.toml"), "utf8"));
    return { ...projected, configuration, provider: configuration.providers.selected };
  };
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = async projected => {
    const suffix = protocol === "anthropic" ? "/v1/messages" : protocol === "openai_responses" ? "/responses" : "/chat/completions";
    return fetch(projected.provider.base_url + suffix, { method: "POST", headers: { ...projected.provider.custom_headers,
      "content-type": "application/json" }, body: JSON.stringify({ model: "chosen-wire", stream: true, messages: [] }) });
  };
  return { store, profile, home, slot, config, controller, registry, authentication, received, refreshes, prepare, send };
}

for (const protocol of ["openai", "kimi", "openai_responses", "anthropic"]) {
  test(`Kimi OAuth ${protocol} preserves selected native model and host-only credentials`, async t => {
    const f = await fixture(t, { protocol, expired: true });
    let preparationChecks = 0, executionChecks = 0;
    const home = await f.prepare({ assertPreparationCurrent() { preparationChecks++; }, assertCurrent() { executionChecks++; } });
    assert.ok(preparationChecks > 0); assert.equal(executionChecks, 0, "do not assert an active prompt during reserved preparation");
    assert.equal(f.refreshes.length, 1); assert.equal(f.received.length, 0);
    const response = await f.send(home); assert.equal(response.status, 200); await response.text();
    assert.ok(executionChecks > 0);
    assert.equal(f.received.length, 1);
    const sent = f.received[0];
    assert.equal(sent.body.model, "chosen-wire");
    assert.equal(sent.path, `/chosen/v1/${protocol === "anthropic" ? "messages" : protocol === "openai_responses" ? "responses" : "chat/completions"}`);
    assert.equal(sent.headers[protocol === "anthropic" ? "x-api-key" : "authorization"],
      protocol === "anthropic" ? "rotated-access-sentinel" : "Bearer rotated-access-sentinel");
    assert.equal(sent.headers["x-vendor-secret"], "vendor-sentinel");
    assert.equal(JSON.stringify(home.configuration).includes("sentinel"), false);
    assert.equal(JSON.stringify(home.configuration).includes("unused-old-key"), false);
    assert.equal(home.provider.oauth, undefined);
    await assert.rejects(readFile(join(home.home, "credentials", "kimi-code.json")), { code: "ENOENT" });
    for (const secret of ["initial-access-sentinel", "initial-refresh-sentinel", "rotated-access-sentinel", "rotated-refresh-sentinel"])
      assert.equal(redactNativeOutput(secret, f.registry), "[REDACTED]");
  });
}

test("Kimi OAuth request refresh updates the shared registry after preparation", async t => {
  const f = await fixture(t), home = await f.prepare();
  assert.equal(f.refreshes.length, 0);
  await writeFile(f.slot, JSON.stringify(token("initial", true)));
  const response = await f.send(home); assert.equal(response.status, 200); await response.text();
  assert.equal(f.refreshes.length, 1);
  assert.ok(f.registry.getSnapshot().includes("rotated-refresh-sentinel"));
  assert.equal(f.received[0].headers.authorization, "Bearer rotated-access-sentinel");
});

for (const kind of ["missing-owner", "other-home", "retired-profile", "conflicting-header", "mixed-key-oauth"]) {
  test(`Kimi OAuth ${kind} fails before relay use without key fallback`, async t => {
    const f = await fixture(t);
    const overrides = {};
    if (kind === "missing-owner") overrides.authentication = undefined;
    if (kind === "other-home") overrides.authentication = { ...f.authentication, profile: { ...f.profile,
      configuration: { ...f.profile.configuration, authProfileId: "other" } } };
    if (kind === "retired-profile") f.store.save({ ...f.profile.configuration, kimiLoginRegion: "mainland-cn" }, f.profile.revision);
    if (kind === "conflicting-header") {
      f.config.providers.selected.custom_headers.authorization = "Bearer unused-old-key";
      await writeFile(join(f.home, "config.toml"), stringify(f.config));
    }
    if (kind === "mixed-key-oauth") {
      f.config.providers.selected.api_key = "unused-old-key";
      await writeFile(join(f.home, "config.toml"), stringify(f.config));
    }
    await assert.rejects(f.prepare(overrides), /kimi_execution_configuration_invalid/);
    assert.equal(f.received.length, 0); assert.equal(f.refreshes.length, 0);
  });
}

for (const kind of ["cancel", "profile-change"]) test(`Kimi OAuth ${kind} during refresh sends no model request`, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, { refresh: async (_request, response) => {
    entered.resolve(); await release.promise;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(token("late")));
  } });
  const home = await f.prepare();
  await writeFile(f.slot, JSON.stringify(token("initial", true)));
  const sending = f.send(home).then(async response => ({ status: response.status, text: await response.text() }), () => ({ status: 0 }));
  await entered.promise;
  if (kind === "cancel") f.controller.abort();
  else f.store.save({ ...f.profile.configuration, kimiLoginRegion: "mainland-cn" }, f.profile.revision);
  release.resolve();
  assert.notEqual((await sending).status, 200);
  await home.dispose();
  assert.equal(f.received.length, 0);
  assert.equal(JSON.parse(await readFile(f.slot, "utf8")).access_token, "initial-access-sentinel");
});

test("Kimi OAuth invalid relay headers cannot refresh credentials during preparation", async t => {
  const f = await fixture(t, { expired: true });
  f.config.providers.selected.custom_headers.host = "forbidden.invalid";
  await writeFile(join(f.home, "config.toml"), stringify(f.config));
  await assert.rejects(f.prepare(), /kimi_execution_configuration_invalid/);
  assert.equal(f.refreshes.length, 0);
  assert.equal(JSON.parse(await readFile(f.slot, "utf8")).access_token, "initial-access-sentinel");
});

test("Kimi OAuth revoked request persists a tombstone and returns a credential-free error", async t => {
  const f = await fixture(t, { refresh: (_request, response) => {
    response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"invalid_grant"}');
  } }), home = await f.prepare();
  await writeFile(f.slot, JSON.stringify(token("initial", true)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.send(home); assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("sentinel"), false);
  }
  assert.equal(f.refreshes.length, 1); assert.equal(f.received.length, 0);
  assert.equal(JSON.parse(await readFile(f.slot, "utf8")).access_token, "");
});

test("Kimi OAuth registry exhaustion blocks rotated-token persistence and model forwarding", async t => {
  const f = await fixture(t), home = await f.prepare();
  await writeFile(f.slot, JSON.stringify(token("initial", true)));
  const remaining = 128 - f.registry.getSnapshot().length;
  f.registry.register(Array.from({ length: remaining }, (_, index) => `capacity-fixture-${index}`));
  const response = await f.send(home); assert.equal(response.status, 502); await response.text();
  assert.equal(f.refreshes.length, 1); assert.equal(f.received.length, 0);
  assert.equal(JSON.parse(await readFile(f.slot, "utf8")).access_token, "initial-access-sentinel");
});
