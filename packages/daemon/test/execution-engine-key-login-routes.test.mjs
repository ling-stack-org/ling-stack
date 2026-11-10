import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";

const engineId = "codex-app-server";
const origin = "http://127.0.0.1:5175";
const secretRef = "env:LING_KEY_LOGIN_FIXTURE";
const firstKey = "sk-test-private-fixture-key-generation-one";
const secondKey = "sk-test-private-fixture-key-generation-two";
const rawKey = "sk-test-private-fixture-rejected-http-field";
const loginBody = { expectedRevision: 1, method: "apiKey" };
const nativeTest = { timeout: 30_000, skip: process.platform === "win32" };

test("key login HTTP authority and CSRF checks run before any secret resolution", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const [credentials, headers, expectedStatus] of [
    [null, {}, 401],
    [{ token: "untrusted-fixture-token", csrfToken: "untrusted-csrf" }, {}, 401],
    [undefined, { "X-Ling-Engine-Csrf": "wrong-fixture-csrf" }, 403],
    [undefined, { Origin: "https://untrusted.example.test" }, 403],
  ]) {
    const denied = await f.request(`/${engineId}/auth`, "POST", loginBody, credentials, headers);
    assert.equal(denied.status, expectedStatus);
    assertPrivate(denied.body);
  }
  assert.deepEqual(f.secretCalls, []);
  assert.equal(f.children.length, 0);
  await f.assertUnchanged();
});

test("key login HTTP rejects a raw apiKey field instead of resolving or forwarding it", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const rejected = await f.request(`/${engineId}/auth`, "POST", { ...loginBody, apiKey: rawKey });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "engine_request_invalid");
  assertPrivate(rejected.body);
  assert.deepEqual(f.secretCalls, []);
  assert.equal(f.children.length, 0);
  await f.assertUnchanged();
});

test("key login HTTP adopts a private new auth generation after cleanup, with or without native notifications", nativeTest, async (t) => {
  for (const notifications of [true, false]) {
    const f = await fixture(t, { notifications });
    const owner = await f.enroll(), other = await f.enroll();
    const started = await f.start(owner);
    const path = `/${engineId}/auth/${started.id}`;
    const completed = await f.terminal(path, owner);
    assert.equal(completed.status, "completed");
    assert.equal(completed.authentication, "configured_unverified");
    assert.equal(completed.profileRevision, 2);
    assert.equal(completed.challenge, undefined);
    assert.equal(completed.errorCode, undefined);
    const profile = (await f.request(`/${engineId}/profile`)).body.profile;
    assert.equal(profile.revision, 2);
    assert.equal(profile.configuration.secretRef, secretRef);
    assert.notEqual(profile.configuration.authProfileId, "old-fixture");
    assert.equal("enabled" in profile, false);
    assert.equal("enabled" in profile.configuration, false);
    assert.equal(f.authHome(), join(f.paths.rootDir, "state", "execution-engines", engineId, "auth", profile.configuration.authProfileId));
    assert.notEqual(f.authHome(), f.oldHome);
    assert.equal(JSON.parse(readFileSync(join(f.authHome(), "auth.json"), "utf8")).OPENAI_API_KEY, firstKey);
    f.assertOwnedCleanup();
    f.assertPreservedState();
    const calls = f.secretCalls.length;
    for (const method of ["GET", "DELETE"]) {
      const denied = await f.request(path, method, undefined, other);
      assert.equal(denied.status, 404);
      assertPrivate(denied.body);
    }
    assert.equal(f.secretCalls.length, calls, "another session cannot resolve a secret through an owned operation");
    assert.equal((await f.request(path, "DELETE", undefined, owner)).body.status, "completed");
    for (const value of [started, completed, profile, (await f.request()).body]) assertPrivate(value);
    assert.deepEqual(f.methods(), ["initialize", "initialized", "account/read", "account/login/start", "account/read"]);
  }
});

test("key login HTTP maps missing resolvers and all defined secret resolution failures without changing the profile", nativeTest, async (t) => {
  const cases = [
    [{ noResolver: true }, "engine_secret_missing"],
    [{ resolveSecret: (ref) => ({ ref, configured: false }) }, "engine_secret_missing"],
    ...["secret_missing", "secret_access_denied", "secret_store_unavailable", "invalid_secret_ref"].map((errorCode) => [
      { resolveSecret: (ref) => ({ ref, configured: false, status: {
        ref, kind: "env", configured: false, errorCode, message: `private resolver detail ${firstKey}`,
      } }) }, `engine_${errorCode}`,
    ]),
  ];
  for (const [options, expectedCode] of cases) {
    const f = await fixture(t, options);
    const started = await f.start();
    const failed = await f.terminal(`/${engineId}/auth/${started.id}`);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, expectedCode);
    assert.equal(failed.challenge, undefined);
    assertPrivate(failed);
    assert.equal(f.authHome(), undefined, "an unresolved key must never reach an account process");
    await f.assertUnchanged();
  }
});

test("key login HTTP redacts resolver exceptions and native errors, preserving the old account on failure", nativeTest, async (t) => {
  for (const options of [
    { resolveSecret: () => { throw new Error(`private resolver exception ${firstKey}`); } },
    { nativeError: true },
  ]) {
    const f = await fixture(t, options);
    const started = await f.start();
    const failed = await f.terminal(`/${engineId}/auth/${started.id}`);
    assert.equal(failed.status, "failed");
    if (!options.nativeError) assert.equal(failed.errorCode, "engine_secret_unavailable");
    else {
      assert.match(failed.errorCode, /^engine_login_/);
      assert.ok(f.methods().includes("account/login/start"));
      assert.equal(existsSync(f.authHome()), false);
      f.assertOwnedCleanup();
    }
    assert.equal(failed.challenge, undefined);
    assertPrivate(failed);
    await f.assertUnchanged();
  }
});

test("key login HTTP rejects a changed secret before adoption and removes only the attempted generation", nativeTest, async (t) => {
  const f = await fixture(t, { holdAccount: true });
  const started = await f.start();
  await f.waitForKey();
  assert.equal(JSON.parse(readFileSync(join(f.authHome(), "auth.json"), "utf8")).OPENAI_API_KEY, firstKey);
  f.rotate();
  f.release();
  const failed = await f.terminal(`/${engineId}/auth/${started.id}`);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "engine_secret_changed");
  assert.equal(failed.challenge, undefined);
  assertPrivate(failed);
  assert.equal(existsSync(f.authHome()), false);
  f.assertOwnedCleanup();
  await f.assertUnchanged();
});

function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const key of [firstKey, secondKey, rawKey, "private resolver", "private native"]) assert.equal(text.includes(key), false);
  assert.equal(Object.hasOwn(value, "apiKey"), false);
}

async function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-key-login-routes-")));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const readyMarker = join(root, "peer-ready");
  const releaseMarker = join(root, "release-account");
  const methodsFile = join(root, "peer-methods.json");
  const unrelatedFile = join(root, "unrelated-user-state");
  writeFileSync(unrelatedFile, "preserve-fixture-user-state");
  const secretCalls = [], children = [];
  let currentKey = firstKey;
  let accountChild, authHome, nativeCwd, feature, server;
  t.after(async () => {
    try { await feature?.close(); }
    finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      for (const entry of children) if (!entry.closed) entry.child.kill("SIGKILL");
      await Promise.all(children.map((entry) => entry.done));
      rmSync(root, { recursive: true, force: true });
    }
  });
  const secretResolver = {
    status(ref, purpose) {
      secretCalls.push({ method: "status", ref, purpose });
      assert.equal(ref, secretRef);
      return { ref, kind: "env", configured: true };
    },
    resolve(ref, purpose) {
      secretCalls.push({ method: "resolve", ref, purpose });
      assert.equal(ref, secretRef);
      return options.resolveSecret ? options.resolveSecret(ref)
        : { ref, configured: true, value: currentKey, status: { ref, kind: "env", configured: true } };
    },
  };
  feature = new EngineManagementFeature({ userPaths: paths, allowedOrigins: [origin],
    ...(options.noResolver ? {} : { secretResolver }),
    login: { timeoutMs: 5000, spawn: (file, args, nativeOptions) => {
      assert.equal(file, realpathSync(process.execPath));
      assert.equal(nativeOptions.shell, false);
      for (const key of [firstKey, secondKey, rawKey]) assert.equal(JSON.stringify([args, nativeOptions.env]).includes(key), false);
      assert.equal(nativeOptions.env.OPENAI_API_KEY, undefined);
      assert.equal(nativeOptions.env.LING_KEY_LOGIN_FIXTURE, undefined);
      let child;
      if (args[0] === "--version") child = spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], nativeOptions);
      else {
        assert.equal(args[0], "app-server");
        assert.ok(args.includes('cli_auth_credentials_store="file"'));
        authHome = nativeOptions.env.CODEX_HOME;
        nativeCwd = nativeOptions.cwd;
        // The peer contains no key literal: its only credential input is the real protocol's stdin request.
        child = spawn(file, ["-e", `(${keyPeer.toString()})(${JSON.stringify({ readyMarker, releaseMarker, methodsFile,
          holdAccount: options.holdAccount ?? false, notifications: options.notifications ?? true, nativeError: options.nativeError ?? false })})`], nativeOptions);
        accountChild = child;
      }
      const entry = { child, closed: false };
      entry.done = new Promise((resolve) => child.once("close", () => { entry.closed = true; resolve(); }));
      children.push(entry);
      return child;
    } },
  });
  server = createServer(async (request, response) => {
    if (!await feature.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const rootCredentials = { token: feature.credentials.capability, csrfToken: feature.credentials.csrfToken };
  const request = async (path = "", method = "GET", body, credentials = rootCredentials, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin,
      ...(credentials ? { Authorization: `Bearer ${credentials.token}`, "X-Ling-Engine-Csrf": credentials.csrfToken } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) });
    return { status: response.status, body: await response.json() };
  };
  const configuration = { engineId, executablePath: process.execPath, authProfileId: "old-fixture", secretRef };
  assert.equal((await request(`/${engineId}/profile`, "PUT", { expectedRevision: 0, configuration })).status, 200);
  const originalProfile = (await request(`/${engineId}/profile`)).body.profile;
  const oldHome = await prepareNativeAuthHome(paths, configuration);
  const oldContents = JSON.stringify({ OPENAI_API_KEY: "old-isolated-fixture-account" });
  writeFileSync(join(oldHome, "auth.json"), oldContents, { mode: 0o600 });
  const assertPreservedState = () => {
    assert.equal(readFileSync(join(oldHome, "auth.json"), "utf8"), oldContents);
    assert.equal(readFileSync(unrelatedFile, "utf8"), "preserve-fixture-user-state");
  };
  return { request, secretCalls, children, paths, oldHome, authHome: () => authHome, assertPreservedState,
    methods: () => JSON.parse(readFileSync(methodsFile, "utf8")),
    rotate: () => { currentKey = secondKey; },
    release: () => writeFileSync(releaseMarker, "release-fixture-account-read"),
    waitForKey: async () => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (existsSync(readyMarker)) return;
        await delay(20);
      }
      assert.fail("peer did not receive account/login/start");
    },
    assertOwnedCleanup: () => {
      assert.ok(accountChild);
      assert.equal(children.find((entry) => entry.child === accountChild).closed, true);
      assert.equal(existsSync(nativeCwd), false);
    },
    assertUnchanged: async () => {
      assert.deepEqual((await request(`/${engineId}/profile`)).body.profile, originalProfile);
      assertPreservedState();
    },
    enroll: async () => {
      const issued = await request("/enrollments", "POST", { origin });
      assert.equal(issued.status, 200);
      const redeemed = await request("/session", "POST", { code: issued.body.code }, null);
      assert.equal(redeemed.status, 200);
      return redeemed.body;
    },
    start: async (credentials) => {
      const response = await request(`/${engineId}/auth`, "POST", loginBody, credentials);
      assert.equal(response.status, 202, JSON.stringify(response.body));
      assertPrivate(response.body);
      return response.body;
    },
    terminal: async (path, credentials) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const result = await request(path, "GET", undefined, credentials);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assertPrivate(result.body);
        assert.equal(result.body.challenge, undefined);
        if (["completed", "failed", "cancelled", "timed_out"].includes(result.body.status)) return result.body;
        await delay(20);
      }
      assert.fail("key login did not reach a terminal state");
    },
  };
}

function keyPeer(options) {
  const fs = require("node:fs"), path = require("node:path");
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const methods = [];
  let loggedIn = false, pendingAccount;
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    methods.push(message.method);
    fs.writeFileSync(options.methodsFile, JSON.stringify(methods));
    if (message.method === "initialize") send({ id: message.id, result: {
      userAgent: "fixture", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos",
    } });
    else if (message.method === "initialized") return;
    else if (message.method === "account/read") {
      if (message.params.refreshToken !== false) process.exit(71);
      if (loggedIn && options.holdAccount) pendingAccount = message.id;
      else send({ id: message.id, result: { requiresOpenaiAuth: true, account: loggedIn ? { type: "apiKey" } : null } });
    } else if (message.method === "account/login/start") {
      if (message.params.type !== "apiKey" || typeof message.params.apiKey !== "string" || !message.params.apiKey) process.exit(72);
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: message.params.apiKey }), { mode: 0o600 });
      fs.writeFileSync(options.readyMarker, "fixture-key-received-via-stdin");
      if (options.nativeError) {
        send({ id: message.id, error: { code: -32603, message: `private native save failure ${message.params.apiKey}` } });
        return;
      }
      loggedIn = true;
      send({ id: message.id, result: { type: "apiKey" } });
      if (options.notifications) {
        send({ method: "account/login/completed", params: { loginId: null, success: true, error: null, onboardingEntrypoint: null } });
        send({ method: "account/updated", params: { authMode: "apikey", planType: null } });
      }
    } else process.exit(73);
  });
  setInterval(() => {
    if (pendingAccount !== undefined && fs.existsSync(options.releaseMarker)) {
      send({ id: pendingAccount, result: { requiresOpenaiAuth: true, account: { type: "apiKey" } } });
      pendingAccount = undefined;
    }
  }, 10);
}
