import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("runs show includes approval state in human-readable output", async () => {
  const daemon = await startRunsDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-runs-"));
  try {
    const result = await runCli(daemon.url, cwd, ["runs", "show", "run_approval"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ID: run_approval/);
    assert.match(result.stdout, /Approvals:/);
    assert.match(result.stdout, /approval_123\s+approved\s+bash\s+medium\s+Looks scoped/);
    assert.deepEqual(daemon.requests, [
      "GET /runs/run_approval",
      "GET /runs/run_approval/events",
    ]);
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

async function startRunsDaemon() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);

    if (request.method === "GET" && url.pathname === "/runs/run_approval") {
      writeJson(response, 200, {
        id: "run_approval",
        status: "succeeded",
        cwd: "/tmp/workspace",
        taskId: "task_approval",
        providerName: "test-provider",
        providerModel: "test-model",
        taskSnapshot: { title: "Approval task" },
        providerSnapshot: {},
        requestSnapshot: {},
        eventLogPath: "/tmp/events.jsonl",
        createdAt: "2026-05-21T00:00:00.000Z",
        updatedAt: "2026-05-21T00:01:00.000Z",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_approval/events") {
      writeJson(response, 200, {
        runId: "run_approval",
        nextSeq: 4,
        events: [
          {
            id: "evt_1",
            runId: "run_approval",
            seq: 1,
            ts: "2026-05-21T00:00:01.000Z",
            type: "approval_requested",
            data: {
              approvalId: "approval_123",
              actionType: "bash",
              risk: "medium",
              description: "Approve shell command",
            },
          },
          {
            id: "evt_2",
            runId: "run_approval",
            seq: 2,
            ts: "2026-05-21T00:00:02.000Z",
            type: "approval_approved",
            data: {
              approvalId: "approval_123",
              status: "approved",
              decisionReason: "Looks scoped",
            },
          },
        ],
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
