import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createDaemonServer } from "../../../../packages/daemon/dist/index.js";
import { createRunnerRegistry } from "../../../../packages/daemon/dist/runtime/runners.js";
import { createEnvSecretResolver } from "@ling-stack/core";

/** Real Daemon/SQLite fixture; only owned Node protocol peers can be launched. */
export async function startExecutionEngineFixture({ port = 0, origin = "http://127.0.0.1:5176", includePolicyRunner = false,
  loginTimeoutMs = 10 * 60_000 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-engine-ui-")));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  const launches = [];
  const syntheticSecrets = new Map();
  let failSecretWrite = false;
  const completeMarker = join(root, "complete-login");
  const failureMarker = join(root, "fail-login");
  const daemon = createDaemonServer({ host: "127.0.0.1", port, defaultWorkspaceCwd: root,
    channels: { autoRoute: false, intentSelector: false } }, {
    remoteReplyDispatcher: null,
    secretResolver: createEnvSecretResolver({ LING_ENGINE_UI_TEST_KEY: "synthetic-ui-key-not-a-real-credential" }),
    runnerRegistry: includePolicyRunner ? createRunnerRegistry([
      { id: "pi", displayName: "Ling", status: "enabled" },
      { id: "policy-fixture", displayName: "Policy test fixture", status: "enabled" },
      ...["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"].map((id) => ({ id, displayName: id, status: "disabled" })),
    ].map((runner) => ({ ...runner, adapter: { async runTask() { throw new Error("UI fixture cannot execute tasks"); } } }))) : undefined,
    engineManagement: { allowedOrigins: [origin],
      secretStore: {
        write(ref, value) {
          if (failSecretWrite) throw new Error("synthetic storage failure");
          syntheticSecrets.set(ref, value);
        },
        remove(ref) { syntheticSecrets.delete(ref); },
        status(ref) { return { ref, kind: "keychain", configured: syntheticSecrets.has(ref) }; },
        resolve(ref) { return { ref, configured: syntheticSecrets.has(ref), value: syntheticSecrets.get(ref) }; },
      },
      login: { timeoutMs: loginTimeoutMs, spawn: (file, args, options) => {
        assert.equal(file, realpathSync(process.execPath));
        assert.equal(options.shell, false);
        launches.push(`login:${args[0]}`);
        if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], options);
        assert.equal(args[0], "app-server");
        rmSync(completeMarker, { force: true });
        rmSync(failureMarker, { force: true });
        return spawn(file, ["-e", `
          const send = value => console.log(JSON.stringify(value));
          const loginId = '90569017-265a-4efc-a355-fc4262704a5d';
          let started = false, completed = false, apiKey = false, failed = false;
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const message = JSON.parse(line);
            if (message.method === 'initialize') send({ id: message.id, result: {
              userAgent: 'owned-node-fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos'
            } });
            else if (message.method === 'account/read') send({ id: message.id, result: { requiresOpenaiAuth: true,
              account: apiKey ? { type: 'apiKey' } : completed ? { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } : null } });
            else if (message.method === 'account/login/start') {
              if (message.params.type === 'apiKey') {
                if (message.params.apiKey !== 'synthetic-ui-key-not-a-real-credential') process.exit(73);
                require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'auth.json'),
                  JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: message.params.apiKey }), { mode: 0o600 });
                apiKey = true;
                send({ id: message.id, result: { type: 'apiKey' } });
                return;
              }
              if (message.params.type !== 'chatgptDeviceCode') process.exit(73);
              started = true;
              send({ id: message.id, result: { type: message.params.type, loginId,
                verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-ONLY' } });
            } else if (message.method === 'account/login/cancel') send({ id: message.id, result: { status: 'canceled' } });
            else if (message.method !== 'initialized') process.exit(73);
          });
          setInterval(() => {
            if (started && !completed && !failed && require('node:fs').existsSync(${JSON.stringify(failureMarker)})) {
              failed = true;
              send({ method: 'account/login/completed', params: { loginId, success: false,
                error: 'private synthetic login failure diagnostic' } });
            }
            if (started && !completed && !failed && require('node:fs').existsSync(${JSON.stringify(completeMarker)})) {
              completed = true;
              send({ method: 'account/login/completed', params: { loginId, success: true } });
              send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
            }
          }, 20);
        `], options);
      } },
      probe: { spawn: (file, args, options) => {
        assert.equal(file, realpathSync(process.execPath));
        assert.equal(options.shell, false);
        launches.push(args[0]);
        if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], options);
        assert.equal(args[0], "app-server");
        return spawn(file, ["-e", `
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const message = JSON.parse(line);
            if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {
              userAgent: 'owned-node-fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos'
            } }));
            else if (message.method === 'account/read') {
              let account = null;
              const file = require('node:path').join(process.env.CODEX_HOME, 'auth.json');
              if (require('node:fs').existsSync(file)) {
                const auth = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
                if (auth.OPENAI_API_KEY === 'synthetic-ui-key-not-a-real-credential') account = { type: 'apiKey' };
              }
              console.log(JSON.stringify({ id: message.id, result: { account, requiresOpenaiAuth: true } }));
            }
            else if (message.method !== 'initialized') process.exit(73);
          });
          setInterval(() => {}, 1000);
        `], options);
      } },
    },
  });
  await daemon.start();
  const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${daemon.engineManagement.capability}`,
    "X-Ling-Engine-Csrf": daemon.engineManagement.csrfToken, "Content-Type": "application/json" };
  async function request(path, method = "GET", body) {
    const response = await fetch(`${baseUrl}/execution-engines${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }
  return { baseUrl, root, launches, executablePath: realpathSync(process.execPath), request,
    setSecretWriteFailure(fail) { failSecretWrite = fail; },
    completeLogin() { writeFileSync(completeMarker, "fixture-only"); },
    failLogin() { writeFileSync(failureMarker, "fixture-only"); },
    async enroll() { return request("/enrollments", "POST", { origin }); },
    async close() {
      await daemon.stop();
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startExecutionEngineFixture({ port: 17892, includePolicyRunner: true,
    ...(process.argv.includes("--short-login-timeout") ? { loginTimeoutMs: 15_000 } : {}) });
  console.log(JSON.stringify({ fixture: "owned-node-only", baseUrl: fixture.baseUrl, workspace: fixture.root, executablePath: fixture.executablePath }));
  const terminal = createInterface({ input: process.stdin });
  terminal.on("line", async (line) => {
    try {
      if (line === "code") console.log(JSON.stringify({ enrollment: await fixture.enroll() }));
      else if (line === "secret-fail") { fixture.setSecretWriteFailure(true); console.log("Synthetic secret storage failure enabled"); }
      else if (line === "secret-repair") { fixture.setSecretWriteFailure(false); console.log("Synthetic secret storage restored"); }
      if (line === "state") console.log(JSON.stringify({ ...await fixture.request(""), launches: fixture.launches }));
      if (line === "complete-login") { fixture.completeLogin(); console.log("fixture login completion requested"); }
      if (line === "fail-login") { fixture.failLogin(); console.log("fixture login failure requested"); }
      if (line === "policy-state" || line === "policy-conflict") {
        const url = `${fixture.baseUrl}/runtime/settings?cwd=${encodeURIComponent(fixture.root)}`;
        const options = line === "policy-conflict" ? { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ implicitRunnerFallback: "disabled" }) } : {};
        console.log(JSON.stringify(await (await fetch(url, options)).json()));
      }
      if (line === "conflict") {
        const { profile } = await fixture.request("/codex-app-server/profile");
        await fixture.request("/codex-app-server/profile", "PUT", { expectedRevision: profile.revision,
          configuration: { ...profile.configuration, authProfileId: `changed-in-another-window-${profile.revision}` } });
        console.log("fixture conflict saved");
      }
    } catch (error) { console.error(error.message); }
  });
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  terminal.close();
  await fixture.close();
}
