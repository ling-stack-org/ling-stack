import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
