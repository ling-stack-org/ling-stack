import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { runEngineLogin } from "../dist/features/execution-engines/native-login.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const localOnly = { skip: process.platform === "win32", timeout: 15_000 };

async function fixture(t, scenario = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-kimi-terminal-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const store = new ExecutionEngineProfileStore(paths);
  const beforeCleanup = [];
  t.after(async () => {
    for (const cleanup of beforeCleanup) await cleanup();
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const executable = join(root, "kimi");
  const bytes = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]);
  writeFileSync(executable, bytes, { mode: 0o700 });
  const profile = store.save({ engineId: "kimi-acp", executablePath: executable,
    authProfileId: "old-account", kimiLoginRegion: "global" }, 0);
  const oldHome = await prepareNativeAuthHome(paths, profile.configuration);
  writeFileSync(join(oldHome, "account-fixture"), "old-account", { mode: 0o600 });
  const controller = new AbortController();
  const launches = [];
  const challenges = [];
  const options = {
    method: "terminal", signal: controller.signal,
    onChallenge(challenge) { challenges.push(challenge); },
    adopt(configuration) {
      for (const { child, cwd } of launches) {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(existsSync(cwd), false);
      }
      return store.save(configuration, 1);
    },
    spawn(file, args, options) {
      assert.notEqual(file, executable);
      assert.deepEqual(readFileSync(file), bytes);
      assert.equal(options.shell, false);
      assert.equal(options.env.KIMI_API_KEY, undefined);
      assert.equal(options.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
      let program;
      if (args[0] === "--version") program = 'console.log("0.1.0-alpha.4");';
      else if (args.includes("--login")) {
        assert.deepEqual(args, ["acp", "--login", "--region", "global"]);
        program = `
          import {existsSync,writeFileSync} from 'node:fs';
          import {spawn} from 'node:child_process';
          import {join} from 'node:path';
          process.stderr.write(${JSON.stringify("\x1b[32mFixture terminal login: ABCD-1234\x1b[0m\n")});
          process.stderr.write(${JSON.stringify("\x1b]52;c;Y2xpcGJvYXJk\x07")});
          const complete = () => {
            writeFileSync(join(process.env.KIMI_CODE_HOME, 'account-fixture'), 'new-private-account', {mode:0o600});
            process.exit(0);
          };
          const scenario = ${JSON.stringify(scenario)};
          if (scenario === 'pending' || scenario === 'held') {
            setInterval(() => { if (existsSync(${JSON.stringify(join(root, "release"))})) complete(); }, 20);
          } else if (scenario === 'overflow') process.stderr.write('x'.repeat(65537));
          else if (scenario === 'required') process.exitCode = 0;
          else if (scenario === 'descendant') {
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
            writeFileSync(${JSON.stringify(join(root, "descendant-pid"))}, String(child.pid));
            child.once('spawn', complete);
          }
          else if (scenario === 'success') complete();
          else process.exitCode = 1;
        `;
      } else {
        assert.deepEqual(args, ["acp"]);
        assert.ok(launches.findLast(entry => entry.args.includes("--login"))?.child.exitCode === 0);
        program = `
          import {existsSync,readFileSync} from 'node:fs';
          import {join} from 'node:path';
          import {createInterface} from 'node:readline';
          const path = join(process.env.KIMI_CODE_HOME,'account-fixture');
          const configured = existsSync(path) && readFileSync(path,'utf8') === 'new-private-account';
          createInterface({input:process.stdin}).on('line', line => {
            const m = JSON.parse(line);
            if (m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{
              protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'0.1.0-alpha.4'},agentCapabilities:{},
              authMethods:[{id:'login',type:'terminal',name:'Login',args:['--login']}]
            }}));
            else if (m.method === 'authenticate') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,
              ...(configured ? {result:{}} : {error:{code:-32000,message:'private-fixture'}})}));
            else process.exit(91);
          });
          setInterval(() => {}, 1000);
        `;
      }
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], options);
      launches.push({ child, args, cwd: options.cwd, home: options.env.KIMI_CODE_HOME });
      return child;
    },
  };
  return { root, paths, store, profile, oldHome, controller, launches, challenges, options, beforeCleanup,
    releaseLogin: () => writeFileSync(join(root, "release"), "release") };
}

test("Kimi terminal login uses the selected region, human output and ACP post-check before adopting", localOnly, async (t) => {
  const f = await fixture(t);
  const updated = await runEngineLogin(f.profile, f.paths, f.options);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.configuration.authProfileId, f.profile.configuration.authProfileId);
  assert.equal(updated.configuration.kimiLoginRegion, "global");
  assert.equal(f.launches.length, 3);
  assert.equal(readFileSync(join(f.oldHome, "account-fixture"), "utf8"), "old-account");
  assert.ok(f.challenges.length);
  assert.ok(f.challenges.every(item => item.type === "terminal" && typeof item.text === "string"));
  const last = f.challenges.at(-1);
  assert.match(last.text, /Fixture terminal login: ABCD-1234/);
  assert.doesNotMatch(last.text, /\x1b|Y2xpcGJvYXJk/);
  assert.equal(JSON.stringify(updated).includes("ABCD-1234"), false);
  assert.equal(JSON.stringify(updated).includes("new-private-account"), false);
});

for (const [scenario, expected] of [["denied", "engine_login_login_failed"],
  ["required", "engine_native_auth_mismatch"], ["pending", "engine_login_timed_out"],
  ["overflow", "engine_login_output_limit"]]) {
  test(`Kimi terminal ${scenario} cannot adopt an account and reaps the owned process`, localOnly, async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(runEngineLogin(f.profile, f.paths, { ...f.options, timeoutMs: 1200 }), { code: expected });
    assert.deepEqual(f.store.get("kimi-acp"), f.profile);
    assert.equal(readFileSync(join(f.oldHome, "account-fixture"), "utf8"), "old-account");
    assert.equal(f.launches.length, scenario === "required" ? 3 : 2);
    for (const { child, home, cwd } of f.launches) {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(cwd), false);
      assert.equal(existsSync(home), false);
    }
  });
}

test("Kimi terminal cancellation and failed adoption preserve the old account", localOnly, async (t) => {
  for (const scenario of ["cancel", "reference", "write-failure"]) {
    const f = await fixture(t, scenario === "cancel" ? "pending" : "success");
    await assert.rejects(runEngineLogin(f.profile, f.paths, { ...f.options,
      onChallenge(challenge) {
        f.options.onChallenge(challenge);
        if (!challenge.text.includes("ABCD-1234")) return;
        if (scenario === "cancel") f.controller.abort();
        if (scenario === "reference") f.store.retainReference("kimi-acp", 1, { workspaceId: "workspace", referenceId: "chat" });
      },
      adopt(configuration) {
        if (scenario === "write-failure") throw new Error("fixture-write-failed");
        return f.options.adopt(configuration);
      },
    }), error => (error.code ?? error.message) === { cancel: "engine_login_cancelled", reference: "profile_in_use",
      "write-failure": "fixture-write-failed" }[scenario]);
    assert.deepEqual(f.store.get("kimi-acp"), f.profile);
    assert.equal(readFileSync(join(f.oldHome, "account-fixture"), "utf8"), "old-account");
    for (const { child, home, cwd } of f.launches) {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(cwd), false);
      assert.equal(existsSync(home), false);
    }
  }
});

test("Kimi terminal requires an explicit OAuth region and supported platform before any process", localOnly, async (t) => {
  const f = await fixture(t);
  for (const [configuration, overrides, code] of [
    [{ ...f.profile.configuration, kimiLoginRegion: undefined }, {}, "engine_login_configuration_required"],
    [{ ...f.profile.configuration, secretRef: "env:KEY" }, {}, "engine_login_unsupported_auth"],
    [f.profile.configuration, { platform: "win32" }, "engine_login_unsupported_platform"],
    [{ ...f.profile.configuration, engineId: "codex-app-server" }, {}, "engine_login_method_unavailable"],
  ]) await assert.rejects(runEngineLogin({ ...f.profile, configuration }, f.paths, { ...f.options, ...overrides }), { code });
  assert.equal(f.launches.length, 0);
});

test("Kimi terminal remains pending beyond startup after launch, then adopts after explicit completion", localOnly, async (t) => {
  const f = await fixture(t, "held");
  const output = Promise.withResolvers();
  const outcome = runEngineLogin(f.profile, f.paths, { ...f.options, startupTimeoutMs: 500, timeoutMs: 2500,
    onChallenge(challenge) {
      f.options.onChallenge(challenge);
      if (challenge.text.includes("ABCD-1234")) output.resolve();
    },
  });
  const observed = outcome.then(value => ({ value }), error => ({ error }));
  await output.promise;
  await delay(550);
  assert.equal(f.launches.at(-1).child.exitCode, null);
  assert.equal(f.launches.at(-1).child.signalCode, null);
  assert.deepEqual(f.store.get("kimi-acp"), f.profile);
  f.releaseLogin();
  const result = await observed;
  assert.equal(result.error, undefined);
  assert.equal(result.value.revision, 2);
});

test("Kimi terminal reaps same-group descendants holding output pipes before its ACP post-check", localOnly, async (t) => {
  const f = await fixture(t, "descendant");
  const updated = await runEngineLogin(f.profile, f.paths, f.options);
  assert.equal(updated.revision, 2);
  const pid = Number(readFileSync(join(f.root, "descendant-pid"), "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let attempt = 0; attempt < 200 && alive(); attempt++) await delay(10);
  assert.equal(alive(), false);
});

async function httpFixture(t) {
  const f = await fixture(t, "held");
  const origin = "http://127.0.0.1:5175";
  const feature = new EngineManagementFeature({ userPaths: f.paths, allowedOrigins: [origin], login: { spawn: f.options.spawn } });
  const server = createServer((request, response) => { void feature.handle(request, response); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.beforeCleanup.push(async () => {
    await feature.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const headers = { Origin: origin, Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken, "Content-Type": "application/json" };
  async function request(path, method = "GET", body, selectedHeaders = headers) {
    const response = await fetch(base + path, { method, headers: selectedHeaders,
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function waitFor(path, condition, selectedHeaders) {
    let last;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await request(path, "GET", undefined, selectedHeaders);
      last = result;
      if (condition(result.body)) return result;
      await delay(10);
    }
    assert.fail(`login status did not reach the expected fixture state: ${JSON.stringify(last)}`);
  }
  async function webHeaders() {
    const enrollment = await request("/enrollments", "POST", { origin });
    const session = await request("/session", "POST", { code: enrollment.body.code }, { Origin: origin, "Content-Type": "application/json" });
    return { ...headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  }
  return { ...f, request, headers, origin, waitFor, webHeaders };
}

test("Kimi HTTP terminal auth exposes only the owner's pending output and clears it after verified adoption", localOnly, async (t) => {
  const f = await httpFixture(t);
  const started = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "terminal" });
  assert.equal(started.status, 202);
  const path = `/kimi-acp/auth/${started.body.id}`;
  const waiting = await f.waitFor(path, body => body.challenge?.text?.includes("ABCD-1234"));
  assert.equal(waiting.body.status, "waiting");
  assert.equal(waiting.body.challenge.type, "terminal");
  assert.doesNotMatch(waiting.body.challenge.text, /\x1b/);
  assert.equal((await f.request("")).body.profiles[0].revision, 1);
  assert.equal(JSON.stringify((await f.request("")).body).includes("ABCD-1234"), false);
  const another = await f.webHeaders();
  assert.equal((await f.request(path, "GET", undefined, another)).status, 404);
  assert.equal((await f.request(path, "DELETE", undefined, another)).status, 404);
  f.releaseLogin();
  const completed = await f.waitFor(path, body => body.status === "completed");
  assert.equal(completed.body.authentication, "login_completed");
  assert.equal(completed.body.challenge, undefined);
  assert.equal(completed.body.profileRevision, 2);
  assert.equal(JSON.stringify(completed.body).includes("ABCD-1234"), false);
  const cancelled = await f.request(path, "DELETE");
  assert.equal(cancelled.body.status, "completed");
  assert.equal(readFileSync(join(f.oldHome, "account-fixture"), "utf8"), "old-account");
});

test("Kimi HTTP terminal input and authority validation cannot launch a native process", localOnly, async (t) => {
  const f = await httpFixture(t);
  const body = { expectedRevision: 1, method: "terminal" };
  for (const headers of [{ Origin: f.origin }, { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }]) {
    assert.ok([401, 403].includes((await f.request("/kimi-acp/auth", "POST", body, headers)).status));
  }
  for (const patch of [{ command: "sh" }, { args: ["--login"] }, { env: { KIMI_API_KEY: "fixture-private" } }, { region: "global" }]) {
    const result = await f.request("/kimi-acp/auth", "POST", { ...body, ...patch });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result).includes("fixture-private"), false);
  }
  assert.equal((await f.request("/kimi-acp/auth", "POST", { ...body, expectedRevision: 0 })).status, 409);
  assert.equal(f.launches.length, 0);
});

for (const action of ["cancel", "revoke"]) {
  test(`Kimi HTTP terminal ${action} clears private output and permits a later authorized retry`, localOnly, async (t) => {
    const f = await httpFixture(t);
    const owner = await f.webHeaders();
    const start = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "terminal" }, owner);
    assert.equal(start.status, 202);
    const path = `/kimi-acp/auth/${start.body.id}`;
    await f.waitFor(path, body => body.challenge?.text?.includes("ABCD-1234"), owner);
    assert.equal((await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "terminal" }, owner)).body.error, "engine_probe_busy");
    assert.equal((await f.request("/kimi-acp/probe", "POST", { expectedRevision: 1 })).body.error, "engine_probe_busy");
    if (action === "cancel") {
      const result = await f.request(path, "DELETE", undefined, owner);
      assert.equal(result.body.status, "cancelled");
      assert.equal(result.body.challenge, undefined);
      assert.equal(JSON.stringify(result.body).includes("ABCD-1234"), false);
    } else {
      assert.equal((await f.request("/session", "DELETE", undefined, owner)).status, 200);
      const result = await f.request(path, "GET", undefined, owner);
      assert.equal(result.status, 401);
      assert.equal(JSON.stringify(result).includes("ABCD-1234"), false);
    }
    for (let attempt = 0; attempt < 200 && f.launches.some(({ home }) => existsSync(home)); attempt++) await delay(10);
    assert.ok(f.launches.every(({ child, home }) => !existsSync(home) && (child.exitCode !== null || child.signalCode !== null)));
    assert.deepEqual((await f.request("/kimi-acp/profile")).body.profile, f.profile);
    f.releaseLogin();
    const retry = await f.request("/kimi-acp/auth", "POST", { expectedRevision: 1, method: "terminal" });
    assert.equal(retry.status, 202);
    const completed = await f.waitFor(`/kimi-acp/auth/${retry.body.id}`, body => body.status === "completed");
    assert.equal(completed.body.profileRevision, 2);
    assert.equal(completed.body.challenge, undefined);
  });
}
