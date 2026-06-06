import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("automations scheduler start, status, and stop render human and json output", async () => {
  const daemon = await startAutomationsDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-automations-"));
  try {
    const humanStart = await runCli(daemon.url, cwd, ["automations", "scheduler", "start"]);
    assert.equal(humanStart.code, 0, humanStart.stderr);
    assert.match(humanStart.stdout, /Automation scheduler started: automation_scheduler_1/);
    assert.match(humanStart.stdout, /Status: running/);
    assert.match(humanStart.stdout, /Automations: 2/);
    assert.equal(daemon.requests.at(-1).method, "POST");
    assert.equal(daemon.requests.at(-1).path, "/automations/scheduler/start");
    assert.equal(daemon.requests.at(-1).cwd, cwd);
    assert.deepEqual(daemon.requests.at(-1).body, {});

    const jsonStart = await runCli(daemon.url, cwd, ["--json", "automations", "scheduler", "start"]);
    assert.equal(jsonStart.code, 0, jsonStart.stderr);
    assert.equal(JSON.parse(jsonStart.stdout).scheduler.id, "automation_scheduler_1");

    const humanStatus = await runCli(daemon.url, cwd, ["automations", "scheduler", "status"]);
    assert.equal(humanStatus.code, 0, humanStatus.stderr);
    assert.match(humanStatus.stdout, /Automation schedulers:/);
    assert.match(humanStatus.stdout, /automation_scheduler_1/);
    assert.match(humanStatus.stdout, /Daily Brief/);
    assert.equal(daemon.requests.at(-1).method, "GET");
    assert.equal(daemon.requests.at(-1).path, "/automations/scheduler");

    const jsonStatus = await runCli(daemon.url, cwd, ["--json", "automations", "scheduler", "status"]);
    assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
    assert.equal(JSON.parse(jsonStatus.stdout).schedulers[0].items[0].automationId, "automation_daily");

    const humanStop = await runCli(daemon.url, cwd, ["automations", "scheduler", "stop"]);
    assert.equal(humanStop.code, 0, humanStop.stderr);
    assert.match(humanStop.stdout, /Automation scheduler stopped: automation_scheduler_1/);
    assert.match(humanStop.stdout, /Status: stopped/);
    assert.equal(daemon.requests.at(-1).method, "POST");
    assert.equal(daemon.requests.at(-1).path, "/automations/scheduler/stop");
    assert.deepEqual(daemon.requests.at(-1).body, {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
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

async function startAutomationsDaemon() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/automations/scheduler") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, automationSchedulerListResponse());
      return;
    }
    if (request.method === "POST" && (url.pathname === "/automations/scheduler/start" || url.pathname === "/automations/scheduler/stop")) {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        body: JSON.parse(await readRequestBody(request)),
      });
      writeJson(response, 200, {
        cwd: url.searchParams.get("cwd"),
        scheduler: automationScheduler(url.pathname.endsWith("/stop") ? "stopped" : "running"),
        duplicate: false,
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
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function automationSchedulerListResponse() {
  return {
    cwd: "/tmp/workspace",
    schedulers: [automationScheduler("running")],
  };
}

function automationScheduler(status) {
  return {
    id: "automation_scheduler_1",
    cwd: "/tmp/workspace",
    status,
    startedAt: "2026-06-06T00:00:00.000Z",
    stoppedAt: status === "stopped" ? "2026-06-06T00:10:00.000Z" : undefined,
    automationCount: 2,
    tickCount: 3,
    nextRunAt: status === "running" ? "2026-06-06T09:00:00.000Z" : undefined,
    lastRunAt: "2026-06-05T09:00:00.000Z",
    items: [
      {
        automationId: "automation_daily",
        title: "Daily Brief",
        nextRunAt: status === "running" ? "2026-06-06T09:00:00.000Z" : undefined,
        lastRunAt: "2026-06-05T09:00:00.000Z",
        lastAutomationRunId: "automation_run_1",
      },
    ],
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8") || "{}";
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
