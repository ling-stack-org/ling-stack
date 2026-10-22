import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parse } from "smol-toml";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { runEngineLogin } from "../dist/features/execution-engines/native-login.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const localOnly = { skip: process.platform === "win32", timeout: 15_000 };
const nativeConnectionOnly = { skip: process.platform !== "darwin", timeout: 15_000 };
const model = { providerType: "kimi", baseUrl: "https://api.moonshot.ai/v1", modelId: 'kimi-test."literal', maxContextSize: 262144 };

async function fixture(t, scenario = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-kimi-key-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const store = new ExecutionEngineProfileStore(paths);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const executable = join(root, "kimi");
  const bytes = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]);
  writeFileSync(executable, bytes, { mode: 0o700 });
  const key = 'private-fixture-key"\\literal';
  let currentKey = key;
  const profile = store.save({ engineId: "kimi-acp", executablePath: executable, authProfileId: "old-account",
    secretRef: "env:KIMI_KEY_FIXTURE", kimi: model }, 0);
  const oldHome = await prepareNativeAuthHome(paths, profile.configuration);
  writeFileSync(join(oldHome, "config.toml"), "# preserve old account\n", { mode: 0o600 });
  const controller = new AbortController();
  const launches = [];
  const messages = [];
  const secrets = [];
  const options = {
    method: "apiKey", signal: controller.signal,
    secretResolver: { resolve(ref, purpose) {
      secrets.push({ ref, purpose });
      return { ref, configured: Boolean(currentKey), value: currentKey };
    } },
    onChallenge: () => assert.fail("API-key setup cannot fabricate a browser/device challenge"),
    adopt(configuration) {
      assert.ok(launches.length >= 2);
      for (const { child, cwd } of launches) {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(existsSync(cwd), false);
      }
      if (scenario === "commit-failed") throw new Error("fixture-write-failed");
      if (scenario === "referenced") store.retainReference("kimi-acp", 1, { workspaceId: "workspace", referenceId: "pending" });
      return store.save(configuration, 1);
    },
    spawn(file, args, options) {
      const wrapped = file === "/usr/bin/sandbox-exec";
      const nativeArgs = wrapped ? args.slice(3) : args;
      const nativeFile = wrapped ? args[2] : file;
      assert.notEqual(nativeFile, executable);
      assert.deepEqual(readFileSync(nativeFile), bytes);
      assert.equal(options.shell, false);
      assert.equal(options.env.KIMI_API_KEY, undefined);
      assert.equal(options.env.KIMI_MODEL_API_KEY, undefined);
      assert.equal(options.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
      assert.equal(JSON.stringify(args).includes(key), false);
      let program;
      if (nativeArgs[0] === "--version") {
        program = 'console.log("0.1.0-alpha.4");';
      } else {
        assert.deepEqual(nativeArgs, ["acp"]);
        assert.equal(options.env.KIMI_CODE_HOME.startsWith(paths.stateDir + "/"), !wrapped,
          "login writes a fresh owned generation; a connection check reads a temporary snapshot");
        program = `
          import {readFileSync} from 'node:fs';
          import {join} from 'node:path';
          import {createInterface} from 'node:readline';
          import {parse} from ${JSON.stringify(import.meta.resolve("smol-toml"))};
          const config = parse(readFileSync(join(process.env.KIMI_CODE_HOME, 'config.toml'), 'utf8'));
          const configured = Boolean(config.providers?.ling?.api_key && config.models?.['ling-default']?.model);
          createInterface({input:process.stdin}).on('line', line => {
            const m = JSON.parse(line);
            if(m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{
              protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'0.1.0-alpha.4'},agentCapabilities:{},
              authMethods:[{id:'login',type:'terminal',name:'Login',args:['--login']}]
            }}));
            else if(m.method === 'authenticate') {
              if(${JSON.stringify(scenario)} === 'pending') return;
              console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(configured && ${JSON.stringify(scenario)} !== 'required'
                ? {result:{}} : {error:{code:-32000,message:'private-fixture-account'}})}));
            } else process.exit(91);
          });
          setInterval(() => {}, 1000);
        `;
      }
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], options);
      launches.push({ child, cwd: options.cwd, home: options.env.KIMI_CODE_HOME, wrapped });
      if (nativeArgs[0] === "acp") {
        child.stdout.on("data", chunk => messages.push(chunk.toString()));
        child.once("close", () => {
          if (scenario === "rotate") currentKey = "private-fixture-rotated";
          if (scenario === "revoke") currentKey = undefined;
          if (scenario === "cancel") controller.abort();
          if (scenario === "tamper") writeFileSync(join(options.env.KIMI_CODE_HOME, "config.toml"), 'default_permission_mode = "yolo"\n');
        });
      }
      return child;
    },
  };
  return { root, paths, store, profile, oldHome, key, options, launches, secrets, messages, controller,
    setKey: value => { currentKey = value; } };
}

test("Kimi API-key setup stages official TOML, verifies ACP and adopts only after process cleanup", localOnly, async (t) => {
  const f = await fixture(t);
  const updated = await runEngineLogin(f.profile, f.paths, f.options);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.configuration.authProfileId, f.profile.configuration.authProfileId);
  assert.deepEqual(updated.configuration.kimi, model);
  const home = await prepareNativeAuthHome(f.paths, updated.configuration);
  assert.notEqual(home, f.oldHome);
  assert.equal(readFileSync(join(f.oldHome, "config.toml"), "utf8"), "# preserve old account\n");
  const configPath = join(home, "config.toml");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(parse(readFileSync(configPath, "utf8")), {
    default_model: "ling-default", default_permission_mode: "manual", telemetry: false, merge_all_available_skills: false,
    providers: { ling: { type: "kimi", base_url: model.baseUrl, api_key: f.key } },
    models: { "ling-default": { provider: "ling", model: model.modelId, max_context_size: model.maxContextSize } },
  });
  assert.equal(JSON.stringify(updated).includes(f.key), false);
  assert.equal(f.messages.join("").includes(f.key), false);
  assert.deepEqual(f.secrets, Array.from({ length: 2 }, () => ({ ref: "env:KIMI_KEY_FIXTURE", purpose: "provider_api_key" })));
});

test("Kimi saved API-key configuration is checked through an isolated connection home", nativeConnectionOnly, async (t) => {
  const f = await fixture(t);
  const updated = await runEngineLogin(f.profile, f.paths, f.options);
  const configPath = join(f.store.getAuthProfileDirectory(updated), "config.toml");
  const before = readFileSync(configPath, "utf8");
  const probe = await probeEngineConnection(updated, f.paths, { store: f.store, spawn: f.options.spawn, secretResolver: f.options.secretResolver });
  assert.equal(probe.status, "connected");
  assert.equal(probe.authentication, "configured_unverified");
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.deepEqual(f.store.get("kimi-acp"), updated);
  assert.equal(f.launches.at(-1).wrapped, true);
  assert.equal(existsSync(f.launches.at(-1).home), false);
});

for (const [scenario, expected] of [
  ["required", "engine_native_auth_mismatch"], ["rotate", "engine_secret_changed"], ["revoke", "engine_secret_missing"],
  ["cancel", "engine_login_cancelled"], ["tamper", "engine_native_auth_mismatch"],
  ["commit-failed", "fixture-write-failed"], ["referenced", "profile_in_use"], ["pending", "engine_login_timed_out"],
]) {
  test(`Kimi key ${scenario} preserves the old profile and removes only the failed generation`, localOnly, async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(runEngineLogin(f.profile, f.paths, { ...f.options, timeoutMs: 1500 }),
      error => (error.code ?? error.message) === expected);
    assert.deepEqual(f.store.get("kimi-acp"), f.profile);
    assert.equal(readFileSync(join(f.oldHome, "config.toml"), "utf8"), "# preserve old account\n");
    assert.equal(f.launches.length, 2);
    for (const { child, cwd, home } of f.launches) {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(cwd), false);
      assert.equal(existsSync(home), false);
    }
  });
}

test("Kimi secret setup rejects missing keys, configuration and unsupported methods before native launch", localOnly, async (t) => {
  const f = await fixture(t);
  for (const [configuration, options, expected] of [
    [{ ...f.profile.configuration, kimi: undefined }, {}, "engine_login_configuration_required"],
    [{ ...f.profile.configuration, secretRef: undefined }, {}, "engine_login_unsupported_auth"],
    [f.profile.configuration, { method: "chatgptDeviceCode" }, "engine_login_method_unavailable"],
    [f.profile.configuration, { platform: "win32" }, "engine_login_unsupported_platform"],
    [f.profile.configuration, { secretResolver: undefined }, "engine_secret_missing"],
    [f.profile.configuration, { secretResolver: { resolve() { throw Error("private-fixture"); } } }, "engine_secret_unavailable"],
    [f.profile.configuration, { secretResolver: { resolve() { return { configured: true, value: "key\ninvalid" }; } } }, "engine_secret_invalid"],
  ]) {
    await assert.rejects(runEngineLogin({ ...f.profile, configuration }, f.paths, { ...f.options, ...options }), { code: expected });
    assert.equal(f.launches.length, 0);
  }
  assert.deepEqual(f.store.get("kimi-acp"), f.profile);
});

test("Kimi connection checks never repair missing, changed, oversized or redirected native configuration", nativeConnectionOnly, async (t) => {
  for (const scenario of ["missing", "changed-key", "invalid-toml", "oversized", "symlink", "unexpected-provider"]) {
    const f = await fixture(t);
    const updated = await runEngineLogin(f.profile, f.paths, f.options);
    const home = await prepareNativeAuthHome(f.paths, updated.configuration);
    const path = join(home, "config.toml");
    if (scenario === "missing") rmSync(path);
    if (scenario === "changed-key") f.setKey("private-fixture-new-key");
    if (scenario === "invalid-toml") writeFileSync(path, "private-fixture-[");
    if (scenario === "oversized") writeFileSync(path, "#".repeat(65537));
    if (scenario === "symlink") { rmSync(path); symlinkSync(join(f.oldHome, "config.toml"), path); }
    if (scenario === "unexpected-provider") writeFileSync(path, readFileSync(path, "utf8") + '\n[providers.other]\napi_key = "private-fixture"\n');
    const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const count = f.launches.length;
    const result = await probeEngineConnection(updated, f.paths, { store: f.store, spawn: f.options.spawn, secretResolver: f.options.secretResolver });
    assert.equal(result.status, "auth_required");
    assert.equal(result.errorCode, scenario === "missing" ? "engine_native_auth_missing"
      : ["changed-key", "unexpected-provider"].includes(scenario) ? "engine_native_auth_mismatch" : "engine_native_auth_invalid", scenario);
    assert.equal(result.authentication, "required");
    assert.equal(result.connection, "not_checked");
    assert.equal(JSON.stringify(result).includes("private-fixture"), false);
    assert.equal(f.launches.length, count + 1, "only the installation check can run; no native account check after invalid config");
    assert.equal(existsSync(path) ? readFileSync(path, "utf8") : undefined, before);
    assert.deepEqual(f.store.get("kimi-acp"), updated);
  }
});

async function httpFixture(t, scenario) {
  const f = await fixture(t, scenario);
  const origin = "http://127.0.0.1:5175";
  const feature = new EngineManagementFeature({ userPaths: f.paths, allowedOrigins: [origin],
    secretResolver: f.options.secretResolver, login: { spawn: f.options.spawn }, probe: { spawn: f.options.spawn } });
  const pending = new Set();
  const server = createServer((request, response) => {
    const handling = feature.handle(request, response);
    pending.add(handling);
    handling.finally(() => pending.delete(handling));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close();
    server.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const headers = { Origin: origin, Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken, "Content-Type": "application/json" };
  async function request(path, method = "GET", body, selectedHeaders = headers) {
    const response = await fetch(base + path, { method, headers: selectedHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { ...f, origin, request, headers };
}

test("Kimi HTTP API-key setup consumes only the saved reference and publishes configuration after owned cleanup", localOnly, async (t) => {
  const f = await httpFixture(t);
  for (const headers of [{ Origin: f.origin }, { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }]) {
    assert.ok([401, 403].includes((await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "apiKey" }, headers)).status));
  }
  const raw = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "apiKey", apiKey: f.key });
  assert.equal(raw.status, 400);
  assert.equal(JSON.stringify(raw).includes(f.key), false);
  assert.equal((await f.request("/kimi-acp/auth", "POST", { expectedRevision: 0, method: "apiKey" })).status, 409);
  assert.equal(f.launches.length, 0);
  assert.equal(f.secrets.length, 0);
  const start = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "apiKey" });
  assert.equal(start.status, 202);
  let result;
  await waitUntil(async () => {
    result = await f.request(`/kimi-acp/auth/${start.body.id}`);
    return !["starting", "waiting", "cancelling"].includes(result.body.status);
  });
  assert.equal(result.body.status, "completed", JSON.stringify(result));
  assert.equal(result.body.authentication, "configured_unverified");
  assert.equal(result.body.challenge, undefined);
  assert.equal(result.body.profileRevision, 2);
  for (const { child, cwd } of f.launches) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(cwd), false);
  }
  const saved = await f.request("/kimi-acp/profile");
  assert.equal(saved.body.profile.revision, 2);
  assert.notEqual(saved.body.profile.configuration.authProfileId, f.profile.configuration.authProfileId);
  assert.equal(JSON.stringify(saved).includes(f.key), false);
  const check = await f.request("/kimi-acp/probe", "POST", { expectedRevision: 2, mode: "connection" });
  assert.equal(check.body.status, process.platform === "darwin" ? "connected" : "unsupported_platform");
  assert.equal(check.body.authentication, process.platform === "darwin" ? "configured_unverified" : "not_checked");
  assert.equal(readFileSync(join(f.oldHome, "config.toml"), "utf8"), "# preserve old account\n");
});

for (const action of ["cancel", "revoke"]) {
  test(`Kimi HTTP ${action} cleans a pending key setup and leaves the previous account selected`, localOnly, async (t) => {
    const f = await httpFixture(t, "pending");
    const enrollment = await f.request("/enrollments", "POST", { origin: f.origin });
    const session = await f.request("/session", "POST", { code: enrollment.body.code }, { Origin: f.origin, "Content-Type": "application/json" });
    const headers = { ...f.headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
    const start = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "apiKey" }, headers);
    assert.equal(start.status, 202);
    await waitUntil(() => f.launches.length === 2 && f.messages.length > 0);
    assert.equal((await f.request(`/kimi-acp/auth/${start.body.id}`)).status, 404, "another principal cannot view the login operation");
    assert.equal((await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "apiKey" }, headers)).body.error, "engine_probe_busy");
    assert.equal((await f.request("/kimi-acp/probe", "POST", { expectedRevision: 1, mode: "connection" })).body.error, "engine_probe_busy");
    if (action === "cancel") {
      const cancelled = await f.request(`/kimi-acp/auth/${start.body.id}`, "DELETE", undefined, headers);
      assert.equal(cancelled.body.status, "cancelled");
    } else assert.equal((await f.request("/session", "DELETE", undefined, headers)).status, 200);
    await waitUntil(() => f.launches.every(({ child, cwd, home }) => (child.exitCode !== null || child.signalCode !== null)
      && !existsSync(cwd) && !existsSync(home)));
    assert.deepEqual((await f.request("/kimi-acp/profile")).body.profile, f.profile);
    assert.equal(readFileSync(join(f.oldHome, "config.toml"), "utf8"), "# preserve old account\n");
  });
}

async function waitUntil(condition) {
  const deadline = Date.now() + 3000;
  while (!(await condition()) && Date.now() < deadline) await delay(10);
  assert.ok(await condition(), "native setup must reach the expected state before the deadline");
}
