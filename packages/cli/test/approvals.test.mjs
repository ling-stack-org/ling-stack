import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("approvals list can filter and render media job approvals", async () => {
  const daemon = await startApprovalsDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-approvals-"));
  try {
    const result = await runCli(daemon.url, cwd, [
      "approvals",
      "list",
      "--status",
      "pending",
      "--media-job-id",
      "media_job_approval",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Owner/);
    assert.match(result.stdout, /media:media_job_approval/);
    assert.match(result.stdout, /media_cost/);
    assert.doesNotMatch(result.stdout, /approval_run/);
    assert.deepEqual(daemon.requests, [
      {
        status: "pending",
        mediaJobId: "media_job_approval",
        runId: null,
      },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("approvals show prints media job owner details", async () => {
  const daemon = await startApprovalsDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-approvals-"));
  try {
    const result = await runCli(daemon.url, cwd, ["approvals", "show", "approval_media"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ID: approval_media/);
    assert.match(result.stdout, /Action: media_cost/);
    assert.match(result.stdout, /Media job: media_job_approval/);
    assert.match(result.stdout, /"type": "media_cost"/);
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

async function startApprovalsDaemon() {
  const requests = [];
  const approvals = [
    {
      id: "approval_media",
      mediaJobId: "media_job_approval",
      actionType: "media_cost",
      risk: "high",
      title: "Approve media job cost",
      description: "Seedream image_generate requires approval before live media execution.",
      payload: {
        type: "media_cost",
        providerPresetId: "provider_seedream",
        model: "seedream",
        operation: "image_generate",
        promptPreview: "Create a launch image.",
      },
      status: "pending",
      createdAt: "2026-05-24T00:00:00.000Z",
      expiresAt: "2026-05-24T00:30:00.000Z",
    },
    {
      id: "approval_run",
      runId: "run_approval",
      taskId: "task_approval",
      actionType: "bash",
      risk: "medium",
      title: "Approve shell command",
      description: "echo ok",
      payload: { type: "bash", cwd: "/tmp/workspace", command: "echo ok", riskFlags: [] },
      status: "pending",
      createdAt: "2026-05-24T00:01:00.000Z",
    },
  ];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.searchParams.get("cwd")) {
      writeJson(response, 400, { error: "bad_request" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/approvals") {
      requests.push({
        status: url.searchParams.get("status"),
        mediaJobId: url.searchParams.get("mediaJobId"),
        runId: url.searchParams.get("runId"),
      });
      const status = url.searchParams.get("status");
      const mediaJobId = url.searchParams.get("mediaJobId");
      const runId = url.searchParams.get("runId");
      writeJson(response, 200, {
        cwd: url.searchParams.get("cwd"),
        approvals: approvals.filter((approval) =>
          (!status || approval.status === status) &&
          (!mediaJobId || approval.mediaJobId === mediaJobId) &&
          (!runId || approval.runId === runId)
        ),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/approvals/approval_media") {
      writeJson(response, 200, { approval: approvals[0] });
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
