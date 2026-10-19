import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixtureCredentials } from "./fixtures/engine-lifecycle-host.mjs";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/index.js");
const origin = "http://127.0.0.1:5175";

test("foreground Web enrollment rejects redirected output before starting a daemon", async () => {
  await assert.rejects(exec(process.execPath, [cli, "engine", "authorize", "--origin", "http://127.0.0.1:5175", "--start-daemon"], {
    timeout: 5000,
  }), (error) => error.code === 2 && `${error.stdout}${error.stderr}`.includes("engine_terminal_required"));
});

// macOS Expect gives the public CLI a real PTY, not an isTTY mock or Windows pass.
test("foreground CLI owns Web enrollment, renews after refresh and stops on Ctrl+C", { skip: process.platform !== "darwin", timeout: 30_000 }, async (t) => {
  const terminal = await startTerminal(t);
  const first = await terminal.code(1);
  const redeem = (code, requestOrigin = origin) => fetch(`${terminal.baseUrl}/execution-engines/session`, {
    method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ code }),
  });
  assert.notEqual((await redeem(first, "http://127.0.0.1:5176")).status, 200);
  const response = await redeem(first);
  assert.equal(response.status, 200);
  const session = await response.json();
  const headers = { Origin: origin, Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(`${terminal.baseUrl}/execution-engines`, {
    headers: { Origin: origin, Authorization: `Bearer ${session.token}` },
  })).status, 200);
  const profileUrl = `${terminal.baseUrl}/execution-engines/codex-app-server/profile`;
  const profile = { expectedRevision: 0, configuration: { engineId: "codex-app-server", executablePath: process.execPath, authProfileId: "test-no-account" } };
  assert.equal((await fetch(profileUrl, { method: "PUT", headers, body: JSON.stringify(profile) })).status, 403);
  const saved = await fetch(profileUrl, { method: "PUT", headers: { ...headers, "X-Ling-Engine-Csrf": session.csrfToken }, body: JSON.stringify(profile) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).profile.revision, 1);
  assert.equal((await (await fetch(profileUrl, { headers })).json()).profile.configuration.authProfileId, "test-no-account");
  assert.notEqual((await redeem(first)).status, 200);
  terminal.input("\n");
  const second = await terminal.code(2);
  assert.notEqual(second, first);
  assert.equal((await redeem(second)).status, 200);
  assert.equal(existsSync(join(terminal.root, "state", "engine-management")), false);
  terminal.input("\x03");
  await terminal.exited;
  await assert.rejects(fetch(`${terminal.baseUrl}/health`, { signal: AbortSignal.timeout(1000) }));
});

test("occupied port refuses foreground setup without touching its listener", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  let connections = 0;
  const existing = createServer((socket) => { connections++; socket.end(); });
  await new Promise((done) => existing.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => existing.close(done)));
  const terminal = await startTerminal(t, `http://127.0.0.1:${existing.address().port}`);
  assert.notEqual(await terminal.exited, 0);
  assert.match(terminal.output(), /engine_daemon_start_failed/);
  assert.doesNotMatch(terminal.output(), /One-use code:|engine_daemon_stop_timeout/);
  assert.equal(connections, 0, "ownership must come from bind, not probing another server");
  assert.equal(existing.listening, true);
});

test("foreground owner closes on terminal EOF and accepts no later enrollment", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  const terminal = await startTerminal(t);
  const code = await terminal.code(1);
  terminal.input("\x04");
  assert.equal(await terminal.exited, 0);
  await assert.rejects(fetch(`${terminal.baseUrl}/execution-engines/session`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(1000),
  }));
});

test("foreground terminal rejects remote, HTTPS, credentials and non-root daemon URLs", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  for (const url of ["https://127.0.0.1:17891", "http://remote.example:17891", "http://user:password@127.0.0.1:17891",
    "http://127.0.0.1:17891/other", "http://127.0.0.1:17891?other=1", "http://127.0.0.1:17891#fragment", "http://127.0.0.1:0"]) {
    const terminal = await startTerminal(t, url);
    assert.equal(await terminal.exited, 2);
    assert.match(terminal.output(), /engine_daemon_url_invalid/);
    assert.doesNotMatch(terminal.output(), /One-use code:|password@/);
  }
  const json = await startTerminal(t, undefined, ["--json"]);
  assert.equal(await json.exited, 2);
  assert.match(json.output(), /engine_terminal_required/);
});

test("foreground lifecycle: stop during pending startup prevents enrollment and closes once", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  const terminal = await startTerminal(t, undefined, [], "startup");
  await terminal.event("startup-pending");
  terminal.input("\x03");
  await terminal.event("signal", (event) => event.signal === "SIGINT");
  assert.equal(terminal.events().some((event) => event.event === "stop-called"), false, "startup must settle before cleanup");
  await terminal.release("startup");
  assert.equal(await terminal.waitForExit(), 0);
  assert.equal(terminal.events().some((event) => event.event === "enrollment-request"), false);
  assertClosedOnce(terminal, 0);
  await assertListenerReleased(terminal.baseUrl);
});

for (const scenario of ["enrollment", "renewal"]) {
  test(`foreground lifecycle: stop fences a late ${scenario} response`, { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
    const terminal = await startTerminal(t, undefined, [], scenario);
    const expectedCodes = scenario === "renewal" ? 1 : 0;
    if (expectedCodes) {
      await terminal.code(1);
      terminal.input("\n");
    }
    await terminal.event("enrollment-pending");
    terminal.input("\x03");
    await terminal.event("enrollment-aborted");
    await terminal.release("enrollment");
    assert.equal(await terminal.waitForExit(), 0);
    await terminal.event("enrollment-released");
    assertClosedOnce(terminal, expectedCodes);
    await assertListenerReleased(terminal.baseUrl);
  });
}

test("foreground lifecycle: repeated stop signals do not duplicate cleanup or issue more codes", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  const terminal = await startTerminal(t, undefined, [], "cleanup-open");
  await terminal.code(1);
  terminal.input("\x03");
  await terminal.event("cleanup-pending");
  const { pid } = await terminal.event("listening");
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    const before = terminal.events().filter((event) => event.event === "signal" && event.signal === signal).length;
    process.kill(pid, signal);
    await terminal.until(() => terminal.events().filter((event) => event.event === "signal" && event.signal === signal).length > before);
  }
  terminal.input("\n");
  await terminal.release("cleanup");
  assert.equal(await terminal.waitForExit(), 0);
  assertClosedOnce(terminal, 1);
  await assertListenerReleased(terminal.baseUrl);
});

for (const [scenario, pendingEvent, expectedCodes, expectedStops] of [
  ["startup", "startup-pending", 0, 0],
  ["enrollment", "enrollment-pending", 0, 0],
  ["cleanup-open", "cleanup-pending", 1, 1],
  ["cleanup-closed", "cleanup-pending", 1, 1],
]) {
  test(`foreground lifecycle: shutdown deadline bounds stalled ${scenario}`, { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
    const terminal = await startTerminal(t, undefined, [], scenario);
    if (expectedCodes) await terminal.code(1);
    else await terminal.event(pendingEvent);
    const stoppedAt = Date.now();
    terminal.input("\x03");
    await terminal.event("signal", (event) => event.signal === "SIGINT");
    if (expectedStops) await terminal.event(pendingEvent);
    assert.equal(await terminal.waitForExit(8000), 1, "unfinished shutdown must not exit successfully");
    assert.ok(Date.now() - stoppedAt < 8000, "shutdown must honor its five-second deadline");
    assert.equal(terminal.output().match(/engine_daemon_stop_timeout/g)?.length, 1);
    assert.equal(terminal.events().filter((event) => event.event === "stop-called").length, expectedStops);
    assert.equal(terminal.output().match(/One-use code:/g)?.length ?? 0, expectedCodes);
    await assertListenerReleased(terminal.baseUrl);
  });
}

function assertClosedOnce(terminal, expectedCodes) {
  for (const name of ["stop-called", "listener-closed", "stopped"]) {
    assert.equal(terminal.events().filter((event) => event.event === name).length, 1, `${name} must occur exactly once`);
  }
  assert.equal(terminal.output().match(/One-use code:/g)?.length ?? 0, expectedCodes);
  assert.doesNotMatch(terminal.output(), /engine_daemon_stop_timeout/);
}

async function assertListenerReleased(baseUrl) {
  const url = new URL(baseUrl);
  const listener = createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(Number(url.port), url.hostname, resolve);
    });
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
}

async function startTerminal(t, requestedUrl, extraArgs = [], fixtureScenario) {
  const root = mkdtempSync(join(tmpdir(), "ling-engine-terminal-"));
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = requestedUrl ?? `http://127.0.0.1:${server.address().port}`;
  await new Promise((done) => server.close(done));
  const wrapper = new URL("./fixtures/engine-lifecycle-import.mjs", import.meta.url);
  wrapper.searchParams.set("scenario", fixtureScenario ?? "");
  const nodeArgs = fixtureScenario ? ["--import", wrapper.href] : [];
  const child = spawn("/usr/bin/expect", [resolve(import.meta.dirname, "fixtures/engine-terminal.exp"), process.execPath, ...nodeArgs, cli, "--daemon-url", baseUrl,
    "engine", "authorize", "--origin", origin, "--start-daemon", ...extraArgs], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, LING_STACK_HOME: root,
      LING_STACK_DEFAULT_WORKSPACE_CWD: root, TERM: "xterm", NODE_NO_WARNINGS: "1" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const events = () => [...output.matchAll(/ENGINE_LIFECYCLE (\{[^\r\n]+\})/g)].map((match) => JSON.parse(match[1]));
  const release = async (gate) => {
    const response = await fetch(`${baseUrl}/__fixture/release/${gate}`, { method: "POST", signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    await response.json();
  };
  const until = async (condition) => {
    for (let i = 0; i < 200; i++) {
      const value = condition();
      if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Owner exited before fixture event: ${output}`);
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.fail(`Owner did not reach fixture event: ${output}`);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write("\x03");
      if (fixtureScenario) {
        for (const gate of ["startup", "enrollment", "cleanup"]) await release(gate).catch(() => undefined);
      }
      let timer;
      await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 6000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        const ownerPid = events().find((event) => event.event === "listening")?.pid;
        if (ownerPid) {
          try { process.kill(ownerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        } else child.kill("SIGTERM");
      }
    }
    await exited;
    rmSync(root, { force: true, recursive: true });
    if (fixtureScenario) {
      for (const credential of Object.values(fixtureCredentials)) assert.equal(output.includes(credential), false, "root authority must not reach terminal output");
    }
  });
  return { baseUrl, root, exited, output: () => output, input: (value) => child.stdin.write(value),
    events, release, until,
    event: (name, predicate = () => true) => until(() => events().find((event) => event.event === name && predicate(event))),
    waitForExit: async (timeoutMs = 7000) => {
      let timer;
      try {
        return await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Owner did not exit within ${timeoutMs}ms: ${output}`)), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    code: async (count) => {
      for (let i = 0; i < 200; i++) {
        const codes = [...output.matchAll(/One-use code: ([a-zA-Z0-9_-]{32})/g)];
        if (codes.length >= count) return codes[count - 1][1];
        if (child.exitCode !== null) assert.fail(`Owner exited before enrollment: ${output}`);
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.fail("Foreground owner did not issue enrollment before timeout");
    },
  };
}
