import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("doctor reports a ready workspace", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    const result = await runCli(daemon.url, cwd, ["doctor"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ling Stack doctor/);
    assert.match(result.stdout, /Daemon: ok/);
    assert.match(result.stdout, /Providers: 1 total, 1 runnable, 1 preflight ready/);
    assert.match(result.stdout, /Channels: 1 total, 1 with default provider/);
    assert.match(result.stdout, /Tasks: 1 total/);
    assert.match(result.stdout, /Approval policy: ok/);
    assert.match(result.stdout, /Ready: yes/);
    assert.ok(daemon.requests.includes("GET /health"));
    assert.ok(daemon.requests.includes("GET /providers"));
    assert.ok(daemon.requests.includes("GET /channels"));
    assert.ok(daemon.requests.includes("GET /tasks"));
    assert.ok(daemon.requests.includes("GET /approval-policy"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor exits non-zero and prints next step when provider preflight is missing", async () => {
  const daemon = await startDoctorDaemon({
    providers: [
      {
        ...readyProvider(),
        lastCheck: undefined,
      },
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    const result = await runCli(daemon.url, cwd, ["doctor"]);

    assert.equal(result.code, 4);
    assert.match(result.stdout, /Providers: 1 total, 1 runnable, 0 preflight ready/);
    assert.match(result.stdout, /Ready: no/);
    assert.match(result.stdout, /ling-stack provider check-all/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor json exposes readiness counters", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    const result = await runCli(daemon.url, cwd, ["doctor", "--json"]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.ok, true);
    assert.equal(body.daemon.url, daemon.url);
    assert.equal(body.workspace.cwd, cwd);
    assert.deepEqual(body.providers, {
      total: 1,
      runnable: 1,
      preflightReady: 1,
      unchecked: 0,
      failed: 0,
    });
    assert.deepEqual(body.channels, {
      total: 1,
      withDefaultProvider: 1,
    });
    assert.deepEqual(body.tasks, {
      total: 1,
    });
    assert.deepEqual(body.approvalPolicy, {
      ok: true,
    });
    assert.deepEqual(body.next, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("daemon status remains a thin health check", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    const result = await runCli(daemon.url, cwd, ["daemon", "status"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Daemon: ok/);
    assert.doesNotMatch(result.stdout, /Ready:/);
    assert.deepEqual(daemon.requests, ["GET /health"]);
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

async function startDoctorDaemon(overrides = {}) {
  const requests = [];
  const providers = overrides.providers ?? [readyProvider()];
  const channels = overrides.channels ?? [readyChannel()];
  const tasks = overrides.tasks ?? [readyTask()];
  const policy = overrides.policy ?? {
    workspaceId: "workspace_default",
    toolDecisions: {
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      bash: "ask",
      edit: "ask",
      write: "ask",
    },
    allowedWritePaths: ["."],
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "ling-stack-daemon" });
      return;
    }

    if (!url.searchParams.get("cwd")) {
      writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), providers });
      return;
    }

    if (request.method === "GET" && url.pathname === "/channels") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), channels });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), tasks });
      return;
    }

    if (request.method === "GET" && url.pathname === "/approval-policy") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), policy });
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

function readyProvider() {
  return {
    id: "provider_ready",
    kind: "openai-compatible",
    displayName: "Ready Provider",
    providerId: "local-relay",
    model: "gpt-5.5",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKeyRef: "env:LOCAL_RELAY_API_KEY",
    apiKeyConfigured: true,
    enabled: true,
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    lastCheck: {
      ok: true,
      code: "ok",
      message: "ready",
      checkedAt: "2026-05-21T00:00:00.000Z",
    },
  };
}

function readyChannel() {
  return {
    id: "channel_engineering",
    workspaceId: "workspace_default",
    name: "Engineering",
    boundPath: ".",
    defaultProviderPresetId: "provider_ready",
    allowedTools: ["read", "grep", "find", "ls"],
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function readyTask() {
  return {
    id: "task_ready",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Inspect workspace",
    prompt: "Summarize the repo.",
    status: "todo",
    assigneeTeammateId: null,
    currentRunId: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
