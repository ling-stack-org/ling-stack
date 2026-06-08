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
    assert.match(result.stdout, /approval_456\s+expired\s+write\s+high\s+Timed out/);
    assert.deepEqual(daemon.requests, [
      "GET /runs/run_approval",
      "GET /runs/run_approval/events",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("runs shell snapshot commands read list and detail endpoints", async () => {
  const daemon = await startRunsDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-runs-"));
  try {
    const list = await runCli(daemon.url, cwd, ["runs", "shell-snapshots", "run_shell", "--tool-call", "tool_bash"]);

    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /Run: run_shell/);
    assert.match(list.stdout, /tool_bash/);
    assert.match(list.stdout, /exited/);
    assert.match(list.stdout, /printf ok/);

    const detail = await runCli(daemon.url, cwd, [
      "--json",
      "runs",
      "shell-snapshot",
      "run_shell",
      "shell_snapshot:run_shell:tool_bash:000002",
    ]);
    assert.equal(detail.code, 0, detail.stderr);
    const parsed = JSON.parse(detail.stdout);
    assert.equal(parsed.snapshot.id, "shell_snapshot:run_shell:tool_bash:000002");
    assert.equal(parsed.snapshot.status, "exited");
    assert.equal(parsed.snapshot.output.stdoutHead, "ok\n");

    assert.deepEqual(daemon.requests.slice(-2), [
      "GET /runs/run_shell/shell-snapshots",
      "GET /runs/run_shell/shell-snapshots/shell_snapshot%3Arun_shell%3Atool_bash%3A000002",
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
        nextSeq: 5,
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
          {
            id: "evt_3",
            runId: "run_approval",
            seq: 3,
            ts: "2026-05-21T00:00:03.000Z",
            type: "approval_requested",
            data: {
              approvalId: "approval_456",
              actionType: "write",
              risk: "high",
              description: "Approve file write",
            },
          },
          {
            id: "evt_4",
            runId: "run_approval",
            seq: 4,
            ts: "2026-05-21T00:30:03.000Z",
            type: "approval_expired",
            data: {
              approvalId: "approval_456",
              status: "expired",
              decisionReason: "Timed out",
            },
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run_shell/shell-snapshots") {
      writeJson(response, 200, {
        runId: "run_shell",
        snapshots: [
          {
            id: "shell_snapshot:run_shell:tool_bash:000001",
            runId: "run_shell",
            toolCallId: "tool_bash",
            sequence: 1,
            createdAt: "2026-06-08T00:00:00.000Z",
            source: "exec_start",
            status: "starting",
            commandPreview: "printf ok",
            artifactId: "artifact_snapshot_start_json",
            textArtifactId: "artifact_snapshot_start_text",
          },
          {
            id: "shell_snapshot:run_shell:tool_bash:000002",
            runId: "run_shell",
            toolCallId: "tool_bash",
            sequence: 2,
            createdAt: "2026-06-08T00:00:01.000Z",
            source: "exec_end",
            status: "exited",
            commandPreview: "printf ok",
            durationMs: 10,
            exitCode: 0,
            artifactId: "artifact_snapshot_end_json",
            textArtifactId: "artifact_snapshot_end_text",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && decodeURIComponent(url.pathname) === "/runs/run_shell/shell-snapshots/shell_snapshot:run_shell:tool_bash:000002") {
      writeJson(response, 200, {
        artifactId: "artifact_snapshot_end_json",
        textArtifactId: "artifact_snapshot_end_text",
        snapshot: {
          id: "shell_snapshot:run_shell:tool_bash:000002",
          runId: "run_shell",
          taskId: "task_shell",
          toolCallId: "tool_bash",
          sequence: 2,
          createdAt: "2026-06-08T00:00:01.000Z",
          source: "exec_end",
          status: "exited",
          command: {
            cwd: "/tmp/workspace",
            commandKind: "shell",
            commandPreview: "printf ok",
            shell: "bash",
            pty: false,
            environmentSummary: { mode: "inherit_minimal", inheritedNames: [], explicitNames: [], omittedNames: [] },
          },
          process: {
            startedAt: "2026-06-08T00:00:00.000Z",
            endedAt: "2026-06-08T00:00:01.000Z",
            durationMs: 10,
            exitCode: 0,
          },
          output: {
            stdoutHead: "ok\n",
            stdoutByteCount: 3,
            stderrByteCount: 0,
            truncated: false,
          },
          artifacts: [],
          redaction: {
            redacted: false,
            extraSecretCount: 0,
            commandRedacted: false,
            stdoutRedacted: false,
            stderrRedacted: false,
            environmentValuesStored: false,
          },
        },
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
