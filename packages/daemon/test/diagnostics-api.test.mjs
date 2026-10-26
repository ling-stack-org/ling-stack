import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

async function withDaemon(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-diagnostics-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  try {
    await daemon.start();
    const port = daemon.server.address().port;
    await fn(`http://127.0.0.1:${port}`, cwd);
  } finally {
    await daemon.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

test("diagnostics doctor reports workspace store and config checks", async () => {
  await withDaemon(async (baseUrl, cwd) => {
    const response = await fetch(`${baseUrl}/diagnostics/doctor?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.doctorVersion, 1);
    assert.equal(body.cwd, cwd);
    assert.ok(Array.isArray(body.checks) && body.checks.length >= 3);
    const workspaceStore = body.checks.find((check) => check.id === "workspace_store");
    assert.equal(workspaceStore.status, "ok");
    const featureFlags = body.checks.find((check) => check.id === "feature_flags");
    assert.equal(featureFlags.status, "ok");
    assert.equal(["ok", "warning", "fail"].includes(body.overallStatus), true);
  });
});

test("diagnostics doctor reports missing log path as unchecked, not failed", async () => {
  const previous = process.env.LING_STACK_DAEMON_LOG_PATH;
  delete process.env.LING_STACK_DAEMON_LOG_PATH;
  try {
    await withDaemon(async (baseUrl, cwd) => {
      const response = await fetch(`${baseUrl}/diagnostics/doctor?cwd=${encodeURIComponent(cwd)}`);
      const body = await response.json();
      const logCheck = body.checks.find((check) => check.id === "log_file");
      assert.equal(logCheck.status, "unchecked");
      assert.equal(body.overallStatus, "ok");
    });
  } finally {
    if (previous !== undefined) process.env.LING_STACK_DAEMON_LOG_PATH = previous;
  }
});

test("diagnostics log tail is redacted and bounded", async () => {
  const logPath = join(tmpdir(), `ling-diagnostics-log-${Date.now()}.log`);
  await writeFile(
    logPath,
    [
      "2026-10-26T00:00:00.000Z info daemon started",
      "2026-10-26T00:00:01.000Z info key sk-abc123secretvalue processed",
      "2026-10-26T00:00:02.000Z info shutdown complete",
    ].join("\n"),
    "utf8",
  );
  const previous = process.env.LING_STACK_DAEMON_LOG_PATH;
  process.env.LING_STACK_DAEMON_LOG_PATH = logPath;
  try {
    await withDaemon(async (baseUrl, cwd) => {
      const response = await fetch(`${baseUrl}/diagnostics/logs?lines=2&cwd=${encodeURIComponent(cwd)}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.logVersion, 1);
      assert.equal(body.lines.length, 2);
      assert.equal(body.truncated, true);
      const joined = body.lines.join("\n");
      assert.equal(joined.includes("sk-abc123secretvalue"), false);
      assert.equal(joined.includes("shutdown complete"), true);
    });
  } finally {
    if (previous === undefined) delete process.env.LING_STACK_DAEMON_LOG_PATH;
    else process.env.LING_STACK_DAEMON_LOG_PATH = previous;
    await rm(logPath, { force: true }).catch(() => {});
  }
});

test("diagnostics logs without env advertises null path", async () => {
  const previous = process.env.LING_STACK_DAEMON_LOG_PATH;
  delete process.env.LING_STACK_DAEMON_LOG_PATH;
  try {
    await withDaemon(async (baseUrl, cwd) => {
      const response = await fetch(`${baseUrl}/diagnostics/logs?cwd=${encodeURIComponent(cwd)}`);
      const body = await response.json();
      assert.equal(body.logPath, null);
      assert.deepEqual(body.lines, []);
    });
  } finally {
    if (previous !== undefined) process.env.LING_STACK_DAEMON_LOG_PATH = previous;
  }
});

test("diagnostics routes reject non-GET methods", async () => {
  await withDaemon(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/diagnostics/doctor`, { method: "POST" });
    assert.equal(response.status, 405);
    const logs = await fetch(`${baseUrl}/diagnostics/logs`, { method: "POST" });
    assert.equal(logs.status, 405);
  });
});
