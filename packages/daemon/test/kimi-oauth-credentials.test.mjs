import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile, symlink, link } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { createKimiOAuthCredentialSource } from "../dist/runtime/acp/kimi-oauth-credentials.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const fresh = (name = "fresh") => ({ access_token: `${name}-access-sentinel`, refresh_token: `${name}-refresh-sentinel`,
  expires_at: Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, scope: "model", token_type: "Bearer" });
const expired = () => ({ ...fresh("expired"), expires_at: 1 });

test("Kimi revoked OAuth composes with the live registry without retaining stale credentials", async t => {
  const f = await fixture(t, expired(), (_request, response) => {
    response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"invalid_grant"}');
  });
  const registry = new NativeSecretRegistry();
  const source = createKimiOAuthCredentialSource({ ...f.options, onSecrets: values => registry.register(values) });
  await assert.rejects(source.resolve(new AbortController().signal), /^Error: kimi_oauth_login_required$/);
  assert.equal((await f.read()).access_token, "");
  await assert.rejects(source.resolve(new AbortController().signal), /^Error: kimi_oauth_login_required$/);
  assert.equal(f.received.length, 1);
  assert.deepEqual(registry.getSnapshot(), ["expired-access-sentinel", "expired-refresh-sentinel"]);
  assert.throws(() => registry.register([""]), /capacity_exceeded/);
});

async function fixture(t, initial = expired(), handler) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-oauth-test-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host-store") });
  const store = new ExecutionEngineProfileStore(paths);
  const profile = store.save({ engineId: "kimi-acp", executablePath: process.execPath,
    authProfileId: "fixture", kimiLoginRegion: "mainland-cn" }, 0);
  const home = await prepareNativeAuthHome(paths, profile.configuration);
  await mkdir(join(home, "credentials"), { mode: 0o700 });
  const path = join(home, "credentials", "kimi-code.json");
  await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
  const received = [], secrets = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    received.push({ path: request.url, headers: request.headers, body: new URLSearchParams(body) });
    if (handler) await handler(request, response);
    else { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fresh("rotated"))); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const urls = [];
  const options = { home, store, profile, region: "mainland-cn", oauth: { storage: "file", key: "oauth/kimi-code" },
    assertCurrent() {}, onSecrets(values) { secrets.push(...values); },
    fetchImpl(url, init) { urls.push(String(url)); return fetch(`http://127.0.0.1:${server.address().port}/api/oauth/token`, init); } };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  return { home, path, paths, store, profile, urls, options, secrets, received, endpoint: `http://127.0.0.1:${server.address().port}/api/oauth/token`,
    read: async () => JSON.parse(await readFile(path, "utf8")) };
}

test("Kimi fresh native credentials register secrets without a refresh request", async t => {
  const f = await fixture(t, fresh()), source = createKimiOAuthCredentialSource(f.options);
  assert.equal(await source.resolve(new AbortController().signal), "fresh-access-sentinel");
  assert.equal(f.received.length, 0);
  assert.ok(f.secrets.includes("fresh-refresh-sentinel"));
});

test("Kimi expired native credentials rotate through the official regional form contract", async t => {
  const f = await fixture(t), source = createKimiOAuthCredentialSource(f.options);
  assert.equal(await source.resolve(new AbortController().signal), "rotated-access-sentinel");
  assert.deepEqual(f.urls, ["https://auth.kimi.com/api/oauth/token"]);
  const request = f.received[0];
  assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(request.body), { client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
    grant_type: "refresh_token", refresh_token: "expired-refresh-sentinel" });
  assert.equal((await f.read()).access_token, "rotated-access-sentinel");
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
  assert.ok(f.secrets.includes("expired-access-sentinel"));
  assert.ok(f.secrets.includes("rotated-refresh-sentinel"));
});

test("Kimi global account uses its explicit host and rejects a conflicting OAuth host", async t => {
  const f = await fixture(t);
  const profile = f.store.save({ ...f.profile.configuration, kimiLoginRegion: "global" }, f.profile.revision);
  const source = createKimiOAuthCredentialSource({ ...f.options, profile, region: "global", oauth: { ...f.options.oauth, oauth_host: "https://auth.kimi.ai" } });
  await source.resolve(new AbortController().signal);
  assert.deepEqual(f.urls, ["https://auth.kimi.ai/api/oauth/token"]);
  assert.throws(() => createKimiOAuthCredentialSource({ ...f.options, region: "global", oauth: { ...f.options.oauth, oauth_host: "https://auth.kimi.com" } }), /kimi_oauth_configuration_invalid/);
});

test("Kimi concurrent credential owners share a native lock and rotate once", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal)));
  assert.deepEqual(results, Array(6).fill("rotated-access-sentinel"));
  assert.equal(f.received.length, 1);
});

for (const action of ["delete", "revoke", "replace", "profile-change"]) test(`Kimi late refresh cannot overwrite ${action}`, async t => {
  let release, notify; const arrived = new Promise(resolve => { notify = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, expired(), async (_request, response) => {
    notify(); await held; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fresh("late")));
  });
  let current = true;
  const source = createKimiOAuthCredentialSource({ ...f.options, assertCurrent() { if (!current) throw Error("stale-profile"); } });
  const result = source.resolve(new AbortController().signal);
  const rejected = assert.rejects(result, /kimi_oauth_(credentials_changed|login_required|configuration_invalid)/);
  await arrived;
  if (action === "delete") await rm(f.path);
  if (action === "revoke") await writeFile(f.path, JSON.stringify({ ...fresh(), access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 }));
  if (action === "replace") {
    await writeFile(`${f.path}.new`, JSON.stringify(fresh("new-login")), { mode: 0o600 }); await rename(`${f.path}.new`, f.path);
  }
  if (action === "profile-change") current = false;
  release(); await rejected;
  if (action === "delete") await assert.rejects(readFile(f.path), { code: "ENOENT" });
  else assert.notEqual((await f.read()).access_token, "late-access-sentinel");
});

for (const status of [401, 403, 400]) test(`Kimi unauthorized refresh ${status} writes a native revoked tombstone`, async t => {
  const f = await fixture(t, expired(), (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" }); response.end('{"error":"invalid_grant","error_description":"secret-server-text"}');
  });
  await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal), /^Error: kimi_oauth_login_required$/);
  assert.deepEqual(await f.read(), { access_token: "", refresh_token: "", expires_at: 0, expires_in: 0, scope: "model", token_type: "Bearer" });
});

for (const failure of ["malformed", "oversized", "redirect", "server", "rate-limit"]) test(`Kimi ${failure} refresh preserves the old credential file`, async t => {
  const f = await fixture(t, expired(), (_request, response) => {
    response.writeHead(failure === "redirect" ? 302 : failure === "server" ? 503 : failure === "rate-limit" ? 429 : 200,
      { "content-type": "application/json", location: "http://127.0.0.1:1/never-follow" });
    response.end(failure === "oversized" ? "x".repeat(70_000) : '{"access_token":"server-secret-sentinel"}');
  });
  const before = await readFile(f.path, "utf8");
  await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal), /kimi_oauth_refresh_failed/);
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.ok(f.received.length <= 3);
});

test("Kimi cancellation stops an actual in-flight refresh without saving late credentials", async t => {
  let notify, release; const arrived = new Promise(resolve => { notify = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, expired(), async (_request, response) => { notify(); await held; response.end(JSON.stringify(fresh("late"))); });
  const controller = new AbortController(), before = await readFile(f.path, "utf8");
  const result = createKimiOAuthCredentialSource(f.options).resolve(controller.signal);
  const rejected = assert.rejects(result, /kimi_oauth_cancelled/);
  await arrived; controller.abort(); await rejected; release();
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("Kimi SQLite publication wait cannot write credentials past the refresh deadline", { timeout: 25_000 }, async t => {
  const f = await fixture(t, expired(), async (_request, response) => {
    await new Promise(resolve => setTimeout(resolve, 14_000));
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fresh("late")));
  });
  const before = await readFile(f.path, "utf8"), marker = join(f.home, "publication-locked");
  const code = `import { DatabaseSync } from "node:sqlite";
    import { writeFileSync } from "node:fs";
    const database = new DatabaseSync(process.argv[1]);
    process.on("message", () => {
      database.exec("BEGIN IMMEDIATE"); writeFileSync(process.argv[2], "locked");
      setTimeout(() => { database.exec("COMMIT"); database.close(); process.disconnect(); }, 2500);
    }); process.send("ready");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.paths.globalDatabasePath, marker],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  t.signal.addEventListener("abort", stopChild, { once: true });
  let publicationAttempted = false;
  try {
    await once(child, "message");
    const commit = f.store.commitAuthRefresh.bind(f.store);
    f.store.commitAuthRefresh = (profile, publish) => {
      publicationAttempted = true;
      child.send("hold");
      const deadline = performance.now() + 5000, wait = new Int32Array(new SharedArrayBuffer(4));
      // Keep the event loop blocked through the real SQLite wait, including its timeout callbacks.
      while (!existsSync(marker) && performance.now() < deadline) Atomics.wait(wait, 0, 0, 5);
      assert.ok(existsSync(marker), "Independent writer must hold the publication lock");
      return commit(profile, publish);
    };
    await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal),
      /^Error: kimi_oauth_refresh_failed$/);
    assert.ok(publicationAttempted, "The deadline must be crossed in publication, not during HTTP");
    assert.equal(await readFile(f.path, "utf8"), before);
    assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
    assert.deepEqual(await exited, [0, null]);
  } finally {
    t.signal.removeEventListener("abort", stopChild);
    stopChild();
    await exited;
  }
});

test("Kimi cancellation inside final ownership validation preserves the credential slot", async t => {
  const f = await fixture(t), controller = new AbortController(), before = await readFile(f.path, "utf8");
  let publishing = false, cancelled = false;
  const commit = f.store.commitAuthRefresh.bind(f.store);
  f.store.commitAuthRefresh = (profile, publish) => commit(profile, () => {
    publishing = true;
    try { publish(); } finally { publishing = false; }
  });
  const source = createKimiOAuthCredentialSource({ ...f.options, assertCurrent() {
    if (publishing) { cancelled = true; controller.abort(); }
  } });
  await assert.rejects(source.resolve(controller.signal), /^Error: kimi_oauth_cancelled$/);
  assert.ok(cancelled);
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
});

for (const alias of ["symlink", "hardlink"]) test(`Kimi rejects ${alias} credential slots`, async t => {
  const f = await fixture(t), other = join(f.home, "other.json");
  await rename(f.path, other);
  if (alias === "symlink") await symlink(other, f.path); else await link(other, f.path);
  await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal), /kimi_oauth_configuration_invalid/);
  assert.equal(f.received.length, 0);
});

test("Kimi refuses unsafe credential keys before touching another slot", async t => {
  const f = await fixture(t);
  for (const key of ["../other", "oauth/../other", "oauth/a/b", "/absolute", "oauth/", "oauth/a\\b"]) {
    assert.throws(() => createKimiOAuthCredentialSource({ ...f.options, oauth: { storage: "file", key } }), /kimi_oauth_configuration_invalid/);
  }
});

test("Kimi independent Node processes coordinate through the official credential-slot lock", async t => {
  const f = await fixture(t);
  const moduleUrl = new URL("../dist/runtime/acp/kimi-oauth-credentials.js", import.meta.url).href;
  const storeUrl = new URL("../../core/dist/storage/execution-engine-profile-store.js", import.meta.url).href;
  const code = `import { createKimiOAuthCredentialSource } from ${JSON.stringify(moduleUrl)};
    import { ExecutionEngineProfileStore } from ${JSON.stringify(storeUrl)};
    const store = new ExecutionEngineProfileStore(JSON.parse(process.argv[3]));
    const profile = store.get('kimi-acp');
    const source = createKimiOAuthCredentialSource({ home: process.argv[1], store, profile, region: "mainland-cn",
      oauth: { storage: "file", key: "oauth/kimi-code" }, assertCurrent() {}, onSecrets() {},
      fetchImpl: (_url, init) => fetch(process.argv[2], init) });
    const value = await source.resolve(new AbortController().signal);
    store.close();
    if (value !== "rotated-access-sentinel") throw Error("wrong-credential");`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code, f.home, f.endpoint, JSON.stringify(f.paths)], { stdio: "pipe" }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  const results = await Promise.all(children.map(async child => {
    let error = ""; child.stderr.on("data", data => { error += data; });
    const [code, signal] = await once(child, "exit"); return { code, signal, error };
  }));
  assert.deepEqual(results, Array.from({ length: 4 }, () => ({ code: 0, signal: null, error: "" })));
  assert.equal(f.received.length, 1);
});

test("Kimi cancellation while waiting for a native lock does not refresh or release the peer lock", async t => {
  const f = await fixture(t);
  const target = join(f.home, "oauth", "kimi-code");
  await mkdir(join(f.home, "oauth")); await writeFile(target, "");
  const release = await lockfile.lock(target, { stale: 5000 });
  t.after(() => release());
  const controller = new AbortController();
  const result = createKimiOAuthCredentialSource(f.options).resolve(controller.signal);
  const rejected = assert.rejects(result, /kimi_oauth_cancelled/);
  await new Promise(resolve => setTimeout(resolve, 50)); controller.abort(); await rejected;
  assert.equal(await lockfile.check(target), true);
  assert.equal(f.received.length, 0);
});

for (const state of ["missing", "revoked"]) test(`Kimi ${state} credentials never refresh or recover another account`, async t => {
  const f = await fixture(t);
  if (state === "missing") await rm(f.path);
  else await writeFile(f.path, JSON.stringify({ ...fresh(), access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 }));
  await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal), /kimi_oauth_login_required/);
  assert.equal(f.received.length, 0);
});

test("Kimi secret-registration failure prevents persistence of a rotated token", async t => {
  const f = await fixture(t), before = await readFile(f.path, "utf8");
  const source = createKimiOAuthCredentialSource({ ...f.options, onSecrets(secrets) {
    if (secrets.includes("rotated-access-sentinel")) throw Error("redactor-full");
  } });
  await assert.rejects(source.resolve(new AbortController().signal), /kimi_oauth_configuration_invalid/);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("Kimi credential-directory replacement invalidates the captured account home", async t => {
  const f = await fixture(t), source = createKimiOAuthCredentialSource(f.options);
  await rename(join(f.home, "credentials"), join(f.home, "previous-credentials"));
  await mkdir(join(f.home, "credentials")); await writeFile(f.path, JSON.stringify(fresh("other-account")));
  await assert.rejects(source.resolve(new AbortController().signal), /kimi_oauth_configuration_invalid/);
  assert.equal(f.received.length, 0);
});

test("Kimi retries a transient connection reset within the bounded refresh budget", async t => {
  let requests = 0;
  const f = await fixture(t, expired(), (request, response) => {
    if (++requests === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fresh("recovered")));
  });
  const token = await createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal);
  assert.equal(token, "recovered-access-sentinel");
  assert.equal(requests, 2);
});

test("Kimi stops after three transport failures and preserves the credential slot", async t => {
  const f = await fixture(t, expired(), request => { request.socket.destroy(); });
  const before = await readFile(f.path, "utf8");
  await assert.rejects(createKimiOAuthCredentialSource(f.options).resolve(new AbortController().signal),
    /^Error: kimi_oauth_refresh_failed$/);
  assert.equal(f.received.length, 3);
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
});

test("Kimi cancellation after a transport failure does not start another attempt", async t => {
  const f = await fixture(t, expired(), request => { request.socket.destroy(); });
  const controller = new AbortController(), before = await readFile(f.path, "utf8");
  const source = createKimiOAuthCredentialSource({ ...f.options, async fetchImpl(url, init) {
    try { return await f.options.fetchImpl(url, init); }
    catch (error) { controller.abort(); throw error; }
  } });
  await assert.rejects(source.resolve(controller.signal), /^Error: kimi_oauth_cancelled$/);
  assert.equal(f.received.length, 1);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("Kimi credential refresh requires a saved matching account owner", async t => {
  const f = await fixture(t);
  for (const patch of [
    { store: undefined }, { profile: undefined }, { region: "global" },
    { profile: { ...f.profile, revision: f.profile.revision + 1 } },
    { profile: { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:OTHER_KEY" } } },
  ]) assert.throws(() => createKimiOAuthCredentialSource({ ...f.options, ...patch }), /^Error: kimi_oauth_configuration_invalid$/);
  assert.equal(f.received.length, 0);
});

test("Kimi cannot bind another host's credential directory to the current profile", async t => {
  const owner = await fixture(t), other = await fixture(t);
  assert.throws(() => createKimiOAuthCredentialSource({ ...owner.options, home: other.home }), /^Error: kimi_oauth_configuration_invalid$/);
  assert.equal(owner.received.length, 0);
  assert.equal(other.received.length, 0);
});

for (const action of ["disconnect", "replace", "final-publication"]) test(`Kimi stored ${action} wins over a late credential refresh`, async t => {
  let release, notify;
  const arrived = new Promise(resolve => { notify = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, expired(), async (_request, response) => {
    notify(); await held; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(fresh("late")));
  });
  const other = new ExecutionEngineProfileStore(f.paths);
  t.after(() => other.close());
  const before = await readFile(f.path, "utf8"), source = createKimiOAuthCredentialSource(f.options);
  if (action === "final-publication") {
    const commit = f.store.commitAuthRefresh.bind(f.store);
    f.store.commitAuthRefresh = (profile, publish) => {
      other.disconnect("kimi-acp", profile.revision);
      return commit(profile, publish);
    };
  }
  const pending = source.resolve(new AbortController().signal);
  const rejected = assert.rejects(pending, /^Error: kimi_oauth_configuration_invalid$/);
  await arrived;
  if (action === "disconnect") other.disconnect("kimi-acp", f.profile.revision);
  if (action === "replace") other.save({ ...f.profile.configuration, authProfileId: "new-login" }, f.profile.revision);
  release(); await rejected;
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
});
