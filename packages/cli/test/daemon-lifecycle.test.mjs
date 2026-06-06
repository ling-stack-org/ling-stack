import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("daemon lifecycle starts, reports status, reads logs, and stops a managed daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-daemon-"));
  const port = await getFreePort();
  const daemonUrl = `http://127.0.0.1:${port}`;
  let started = false;
  try {
    const start = await runCli(daemonUrl, cwd, ["daemon", "start", "--timeout", "10000"]);
    started = start.code === 0;
    assert.equal(start.code, 0, start.stderr);
    assert.match(start.stdout, /Daemon started/);
    assert.match(start.stdout, /PID:/);
    assert.match(start.stdout, /Log:/);

    const status = await runCli(daemonUrl, cwd, ["daemon", "status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.status, "running");
    assert.equal(statusBody.daemonUrl, daemonUrl);
    assert.equal(statusBody.health.service, "ling-stack-daemon");

    const logs = await runCli(daemonUrl, cwd, ["daemon", "logs", "--lines", "20"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /Ling Stack daemon listening/);

    const restart = await runCli(daemonUrl, cwd, ["daemon", "restart", "--timeout", "10000"]);
    assert.equal(restart.code, 0, restart.stderr);
    assert.match(restart.stdout, /Daemon restarted/);

    const restartedStatus = await runCli(daemonUrl, cwd, ["daemon", "status", "--json"]);
    assert.equal(restartedStatus.code, 0, restartedStatus.stderr);
    assert.equal(JSON.parse(restartedStatus.stdout).status, "running");

    const stop = await runCli(daemonUrl, cwd, ["daemon", "stop", "--timeout", "10000"]);
    started = false;
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /Daemon stopped:/);

    const stoppedStatus = await runCli(daemonUrl, cwd, ["daemon", "status", "--json"]);
    assert.equal(stoppedStatus.code, 3);
    assert.equal(JSON.parse(stoppedStatus.stdout).status, "not_running");
  } finally {
    if (started) {
      await runCli(daemonUrl, cwd, ["daemon", "stop", "--force", "--timeout", "10000"]);
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon restart removes stale pid metadata and starts a fresh daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-daemon-stale-"));
  const port = await getFreePort();
  const daemonUrl = `http://127.0.0.1:${port}`;
  let started = false;
  try {
    await writeStaleDaemonState(cwd, daemonUrl, port);

    const restart = await runCli(daemonUrl, cwd, ["daemon", "restart", "--timeout", "10000"]);
    started = restart.code === 0;
    assert.equal(restart.code, 0, restart.stderr);
    assert.match(restart.stdout, /Daemon restarted/);

    const status = await runCli(daemonUrl, cwd, ["daemon", "status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.status, "running");
    assert.equal(statusBody.daemonUrl, daemonUrl);
    assert.equal(statusBody.pidAlive, true);
    assert.notEqual(statusBody.pid, 999999999);
  } finally {
    if (started) {
      await runCli(daemonUrl, cwd, ["daemon", "stop", "--force", "--timeout", "10000"]);
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon restart refuses active work before stopping the daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-daemon-active-work-"));
  const activeDaemon = await startActiveWorkDaemon();
  try {
    const restart = await runCli(activeDaemon.url, cwd, ["daemon", "restart", "--timeout", "1000"]);

    assert.equal(restart.code, 4);
    assert.match(restart.stderr, /daemon_has_active_work/);
    assert.ok(activeDaemon.requests.includes("GET /health"));
    assert.ok(activeDaemon.requests.includes("GET /runtime/active"));
  } finally {
    await activeDaemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function runCli(daemonUrl, cwd, args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function writeStaleDaemonState(cwd, daemonUrl, port) {
  const rootDir = resolve(cwd, ".ling-stack");
  const daemonDir = resolve(rootDir, "daemon");
  const logsDir = resolve(rootDir, "logs");
  const pidPath = resolve(daemonDir, "daemon.pid");
  const statePath = resolve(daemonDir, "daemon.json");
  const logPath = resolve(logsDir, "daemon.log");
  const pid = 999999999;
  await mkdir(daemonDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(pidPath, `${pid}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    pid,
    host: "127.0.0.1",
    port,
    url: daemonUrl,
    cwd,
    defaultWorkspaceCwd: cwd,
    startedAt: "2026-06-06T00:00:00.000Z",
    pidPath,
    statePath,
    logPath,
    nodePath: process.execPath,
    nodeVersion: process.version,
    daemonCliPath: cliPath,
    createdByPid: process.pid,
  }, null, 2)}\n`, "utf8");
}

async function startActiveWorkDaemon() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "ling-stack-daemon" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/active") {
      writeJson(response, 200, {
        cwd: url.searchParams.get("cwd"),
        workUnits: [{ id: "work_active", status: "running" }],
      });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}
