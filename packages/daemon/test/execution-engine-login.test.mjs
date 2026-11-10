import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { runEngineLogin } from "../dist/features/execution-engines/native-login.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";

test("native login adopts a new auth generation only after process cleanup, preserving the existing account", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  let child, cwd, newHome;
  const challenges = [];
  const updated = await runEngineLogin(f.profile, f.paths, {
    method: "chatgptDeviceCode", signal: new AbortController().signal,
    spawn: peer((process, options) => { child = process; cwd = options.cwd; newHome = options.env.CODEX_HOME; }),
    onChallenge: (challenge) => challenges.push(challenge),
    adopt: (configuration) => {
      assert.ok(child.exitCode !== null || child.signalCode, "native process must close before profile mutation");
      assert.equal(existsSync(cwd), false, "temporary process directory must be removed before adoption");
      return f.store.save(configuration, 1);
    },
  });
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.configuration.authProfileId, f.profile.configuration.authProfileId);
  assert.notEqual(newHome, f.oldHome);
  assert.equal(readFileSync(join(f.oldHome, "auth.json"), "utf8"), "old-fixture-account");
  assert.equal(existsSync(join(newHome, "auth.json")), true);
  assert.deepEqual(challenges, [{ type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }]);
  assert.equal(JSON.stringify(updated).includes("new-private-fixture-account"), false);
});

test("late reference/commit failure or cancellation removes only the attempted auth home", { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
  for (const scenario of ["reference", "write-failure", "cancel", "timeout"]) {
    const f = await fixture(t);
    const controller = new AbortController();
    let newHome, child;
    const outcome = runEngineLogin(f.profile, f.paths, { method: "chatgptDeviceCode", signal: controller.signal,
      timeoutMs: scenario === "timeout" ? 1500 : 5000,
      spawn: peer((process, options) => { child = process; newHome = options.env.CODEX_HOME; }, scenario === "timeout" ? "pending" : "success"),
      onChallenge: () => {
        if (scenario === "reference") f.store.retainReference("codex-app-server", 1, { workspaceId: "new-workspace", referenceId: "conversation" });
        if (scenario === "cancel") controller.abort();
      },
      adopt: (configuration) => {
        if (scenario === "write-failure") throw new Error("fixture-database-write-failure");
        return f.store.save(configuration, 1);
      },
    });
    const expected = { reference: "profile_in_use", "write-failure": "fixture-database-write-failure", cancel: "engine_login_cancelled", timeout: "engine_login_timed_out" }[scenario];
    await assert.rejects(outcome, (error) => error.message === expected);
    assert.equal(f.store.get("codex-app-server").revision, 1);
    assert.deepEqual(f.store.get("codex-app-server").configuration, f.profile.configuration);
    assert.equal(readFileSync(join(f.oldHome, "auth.json"), "utf8"), "old-fixture-account");
    assert.equal(existsSync(newHome), false);
    assert.ok(child.exitCode !== null || child.signalCode);
  }
});

test("unsupported login routes never launch native processes or mutate profiles", async (t) => {
  const f = await fixture(t);
  const options = { method: "chatgptDeviceCode", signal: new AbortController().signal,
    spawn: () => { throw new Error("must-not-spawn"); }, onChallenge: () => assert.fail(), adopt: () => assert.fail() };
  for (const [profile, overrides, code] of [
    [f.profile, { method: "chatgpt" }, "engine_login_method_unavailable"],
    [f.profile, { platform: "win32" }, "engine_login_unsupported_platform"],
    [{ ...f.profile, configuration: { ...f.profile.configuration, engineId: "kimi-acp" } }, {}, "engine_login_method_unavailable"],
    [{ ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:OPENAI_API_KEY" } }, {}, "engine_login_unsupported_auth"],
  ]) await assert.rejects(runEngineLogin(profile, f.paths, { ...options, ...overrides }), { code });
  assert.equal(f.store.get("codex-app-server").revision, 1);
});

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-native-login-")));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const store = new ExecutionEngineProfileStore(paths);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const profile = store.save({ engineId: "codex-app-server", executablePath: process.execPath, authProfileId: "old-fixture" }, 0);
  const oldHome = await prepareNativeAuthHome(paths, profile.configuration);
  writeFileSync(join(oldHome, "auth.json"), "old-fixture-account", { mode: 0o600 });
  return { root, paths, store, profile, oldHome };
}

function peer(onLaunch, behavior = "success") {
  return (file, args, options) => {
    assert.equal(file, realpathSync(process.execPath));
    assert.equal(options.shell, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], options);
    const child = spawn(file, ["-e", `
      const { createInterface } = require('node:readline');
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const send = message => console.log(JSON.stringify(message));
      const loginId = '90569017-265a-4efc-a355-fc4262704a5d';
      let loggedIn = false;
      createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } });
        else if (m.method === 'account/read') send({ id: m.id, result: { account: loggedIn ? { type: 'chatgpt', email: 'private@example.test', planType: 'plus' } : null, requiresOpenaiAuth: true } });
        else if (m.method === 'account/login/start') {
          if (m.params.type !== 'chatgptDeviceCode') process.exit(71);
          send({ id: m.id, result: { type: m.params.type, loginId, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } });
          writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'new-private-fixture-account', { mode: 0o600 });
          if (${JSON.stringify(behavior)} === 'success') {
            loggedIn = true;
            send({ method: 'account/login/completed', params: { loginId, success: true, error: null } });
            send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
          }
        } else if (m.method === 'account/login/cancel') send({ id: m.id, result: { status: 'canceled' } });
        else if (m.method !== 'initialized') process.exit(72);
      });
      setInterval(() => {}, 1000);
    `], options);
    onLaunch?.(child, options);
    return child;
  };
}
