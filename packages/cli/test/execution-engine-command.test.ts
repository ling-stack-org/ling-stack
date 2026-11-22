import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import test from "node:test";
import { readExecutionEngineHostAuthority, type ExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";
import { runExecutionEngineCommand } from "../dist/execution-engine-command.js";
import type { CliResult } from "./fixtures/cli-result.js";

const exec = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "../dist/index.js");
const daemonPath = resolve(import.meta.dirname, "../../daemon/dist/cli.js");
const origin = "http://127.0.0.1:5175";

test("owning launcher enrolls Web through inherited authority; standalone CLI cannot borrow a file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ling-engine-bootstrap-"));
  const home = join(root, "host-home");
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((done) => probe.close(done));
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    LING_STACK_HOME: home, LING_STACK_PORT: String(port), LING_STACK_HOST: "127.0.0.1",
    LING_STACK_ENGINE_AUTHORITY_FD: "3", LING_STACK_DEFAULT_WORKSPACE_CWD: root };
  let child: ChildProcess | undefined;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  async function start() {
    child = spawn(process.execPath, [daemonPath], { cwd: root, env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    const channel = child.stdio[3];
    assert.ok(channel instanceof Readable);
    assert.ok(child.pid);
    return readExecutionEngineHostAuthority({ channel, baseUrl, pid: child.pid, timeoutMs: 15_000 });
  }
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  const first = await start();
  assert.equal(existsSync(join(home, "state", "engine-management")), false);
  const captured: string[] = [];
  t.mock.method(console, "log", (line: string) => { captured.push(line); });
  const authorize = async (authority: ExecutionEngineHostAuthority) => {
    const code = await runExecutionEngineCommand(["authorize", "--origin", origin], { daemonUrl: baseUrl, json: true, getAuthority: async () => authority });
    assert.equal(code, 0);
    const line = captured.at(-1);
    assert.ok(typeof line === "string", "expected CLI enrollment output");
    return line;
  };
  const args = [cliPath, "--daemon-url", baseUrl, "--json", "engine", "authorize", "--origin", origin];
  const stdout = await authorize(first);
  const enrollment = JSON.parse(stdout);
  assert.deepEqual(Object.keys(enrollment).sort(), ["code", "expiresAt", "origin"]);
  assert.equal(enrollment.origin, origin);
  assert.equal(stdout.includes(first.credentials.capability), false);
  const redeem = await fetch(`${baseUrl}/execution-engines/session`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: enrollment.code }) });
  assert.equal(redeem.status, 200);
  const session = await redeem.json();
  const sessionHeaders = { Origin: origin, Authorization: `Bearer ${session.token}` };
  assert.equal((await fetch(`${baseUrl}/execution-engines`, { headers: sessionHeaders })).status, 200);
  // Even a formerly valid same-user record must not grant a standalone CLI host authority.
  const oldDirectory = join(home, "state", "engine-management");
  mkdirSync(oldDirectory, { mode: 0o700, recursive: true });
  const key = createHash("sha256").update(baseUrl).digest("hex");
  writeFileSync(join(oldDirectory, `${key}-${first.instanceId}.json`), JSON.stringify({ ...first, publishedAt: Date.now() }), { mode: 0o600 });
  await assert.rejects(exec(process.execPath, args, { cwd: root, env, timeout: 10_000 }), (error) => {
    const failure = error as CliResult;
    return failure.code === 1 && `${failure.stdout}${failure.stderr}`.includes("engine_host_authority_unavailable");
  });
  await stop();
  const second = await start();
  assert.notEqual(second.instanceId, first.instanceId);
  assert.notEqual(second.credentials.capability, first.credentials.capability);
  assert.equal((await fetch(`${baseUrl}/execution-engines`, { headers: sessionHeaders })).status, 403);
  assert.equal((await fetch(`${baseUrl}/execution-engines`, { headers: {
    Origin: baseUrl, Authorization: `Bearer ${first.credentials.capability}`,
  } })).status, 401);
  assert.ok(JSON.parse(await authorize(second)).code);
});

test("CLI rejects remote origins, shell-like arguments and extra commands before contacting the host", async () => {
  for (const args of [["authorize", "--origin", "https://remote.example"], ["authorize", "--origin", "http://localhost:5175/"], ["install"], ["authorize", "--exec", "/tmp/program"]]) {
    await assert.rejects(exec(process.execPath, [cliPath, "--json", "engine", ...args], { timeout: 5000 }), (error) => {
      const failure = error as CliResult;
      return failure.code === 2 && `${failure.stdout}${failure.stderr}`.includes("invalid_engine_command");
    });
  }
});
