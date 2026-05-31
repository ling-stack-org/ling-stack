import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("external-work github import posts a fixture payload and renders a human summary", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-"));
  try {
    const payloadFile = resolve(cwd, "payload.json");
    await writeFile(payloadFile, JSON.stringify(githubPullRequestPayload()), "utf8");

    const result = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "pull_request.opened",
      "--payload-file",
      payloadFile,
      "--workflow-path",
      "WORKFLOW.md",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /External work imported: openclaw\/openclaw#86279/);
    assert.match(result.stdout, /Duplicate: false/);
    assert.match(result.stdout, /Kind: github_pull_request/);
    assert.match(result.stdout, /Workflow: workflow_1 \(ready\)/);
    assert.match(result.stdout, /Step: step_1 \(queued\)/);
    assert.match(result.stdout, /Normalized external work item/);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0].method, "POST");
    assert.equal(daemon.requests[0].path, "/external-work/github/import");
    assert.equal(daemon.requests[0].cwd, cwd);
    assert.deepEqual(daemon.requests[0].body, {
      channelId: "channel_1",
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      workflowPath: "WORKFLOW.md",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work github import supports json output and inline workflow markdown", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-json-"));
  try {
    const payloadFile = resolve(cwd, "payload.json");
    const workflowFile = resolve(cwd, "workflow.md");
    await writeFile(payloadFile, JSON.stringify(githubPullRequestPayload()), "utf8");
    await writeFile(workflowFile, "Review {{ item.identifier }}.\n", "utf8");

    const result = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "pull_request.opened",
      "--payload-file",
      payloadFile,
      "--workflow-markdown-file",
      workflowFile,
    ]);

    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.externalWorkItem.identifier, "openclaw/openclaw#86279");
    assert.equal(response.workflow.id, "workflow_1");
    assert.equal(response.workflowStep.id, "step_1");
    assert.equal(response.duplicate, false);
    assert.equal(daemon.requests[0].body.workflowMarkdown, "Review {{ item.identifier }}.\n");
    assert.equal("workflowPath" in daemon.requests[0].body, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work github import validates local CLI inputs before calling the daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-errors-"));
  try {
    const payloadFile = resolve(cwd, "payload.json");
    await writeFile(payloadFile, JSON.stringify(githubPullRequestPayload()), "utf8");
    const invalidPayloadFile = resolve(cwd, "invalid.json");
    await writeFile(invalidPayloadFile, "{", "utf8");

    const missingChannel = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "github",
      "import",
      "--event-type",
      "pull_request.opened",
      "--payload-file",
      payloadFile,
    ]);
    assert.equal(missingChannel.code, 2);
    assert.match(missingChannel.stderr, /missing_option/);
    assert.match(missingChannel.stderr, /--channel/);

    const invalidJson = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "github",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "pull_request.opened",
      "--payload-file",
      invalidPayloadFile,
    ]);
    assert.equal(invalidJson.code, 2);
    assert.match(invalidJson.stderr, /invalid_json/);

    const mutuallyExclusiveWorkflowFlags = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "github",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "pull_request.opened",
      "--payload-file",
      payloadFile,
      "--workflow-path",
      "WORKFLOW.md",
      "--workflow-markdown-file",
      "workflow.md",
    ]);
    assert.equal(mutuallyExclusiveWorkflowFlags.code, 2);
    assert.match(mutuallyExclusiveWorkflowFlags.stderr, /mutually exclusive/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external-work github import prints readable daemon errors", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-daemon-error-"));
  try {
    const payloadFile = resolve(cwd, "payload.json");
    await writeFile(payloadFile, JSON.stringify(githubPullRequestPayload()), "utf8");

    const result = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "push",
      "--payload-file",
      payloadFile,
    ]);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /bad_request/);
    assert.match(result.stderr, /Unsupported GitHub event type: push/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work github poll renders human and json output", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-poll-"));
  try {
    const human = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "poll",
      "--channel",
      "channel_1",
      "--workflow-path",
      "WORKFLOW.md",
      "--limit",
      "25",
      "--execute-hooks",
    ]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /External work poll:/);
    assert.match(human.stdout, /Candidates: 1/);
    assert.match(human.stdout, /Claimed: 1/);
    assert.match(human.stdout, /openclaw\/openclaw#86279/);

    const json = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "poll",
      "--channel",
      "channel_1",
    ]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).claimed, 1);
    assert.equal(daemon.requests.at(-1).path, "/external-work/github/poll");
    assert.deepEqual(daemon.requests[0].body, {
      channelId: "channel_1",
      workflowPath: "WORKFLOW.md",
      limit: 25,
      executeHooks: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work reconcile renders human output and validates poll flags", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-reconcile-"));
  try {
    const reconcile = await runCli(daemon.url, cwd, [
      "external-work",
      "reconcile",
      "--channel",
      "channel_1",
      "--workflow-path",
      "WORKFLOW.md",
    ]);
    assert.equal(reconcile.code, 0, reconcile.stderr);
    assert.match(reconcile.stdout, /External work reconcile:/);
    assert.match(reconcile.stdout, /Checked: 1/);
    assert.match(reconcile.stdout, /Terminal: 1/);
    assert.equal(daemon.requests[0].path, "/external-work/reconcile");
    assert.deepEqual(daemon.requests[0].body, {
      channelId: "channel_1",
      workflowPath: "WORKFLOW.md",
    });

    const missingChannel = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "poll",
      "--limit",
      "25",
    ]);
    assert.equal(missingChannel.code, 2);
    assert.match(missingChannel.stderr, /--channel/);

    const invalidLimit = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "poll",
      "--channel",
      "channel_1",
      "--limit",
      "101",
    ]);
    assert.equal(invalidLimit.code, 2);
    assert.match(invalidLimit.stderr, /at most 100/);
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

async function startExternalWorkDaemon() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || !["/external-work/github/import", "/external-work/github/poll", "/external-work/reconcile"].includes(url.pathname)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const body = JSON.parse(await readRequestBody(request));
    requests.push({
      method: request.method,
      path: url.pathname,
      cwd: url.searchParams.get("cwd"),
      body,
    });
    if (body.eventType === "push") {
      writeJson(response, 400, { error: "bad_request", message: "Unsupported GitHub event type: push" });
      return;
    }
    if (url.pathname === "/external-work/github/poll") {
      writeJson(response, 200, externalWorkPollResponse());
      return;
    }
    if (url.pathname === "/external-work/reconcile") {
      writeJson(response, 200, externalWorkReconcileResponse());
      return;
    }
    writeJson(response, 201, externalWorkImportResponse());
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

function readRequestBody(request) {
  return new Promise((resolveRead, rejectRead) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolveRead(body));
    request.on("error", rejectRead);
  });
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function externalWorkImportResponse() {
  return {
    externalWorkItem: {
      id: "github:pull_request:openclaw/openclaw#86279",
      sourceKind: "github",
      kind: "github_pull_request",
      identifier: "openclaw/openclaw#86279",
      title: "Add dependency guard",
      state: "open",
      labels: ["CI", "Dependencies"],
      payloadRef: "pull_request.opened:openclaw/openclaw#86279",
      idempotencyKey: "github:pull_request:openclaw/openclaw:86279:head-sha-1:2026-05-29T20:26:56Z",
    },
    workflow: {
      id: "workflow_1",
      status: "ready",
    },
    workflowStep: {
      id: "step_1",
      status: "queued",
    },
    artifacts: [
      {
        id: "artifact_1",
        type: "json",
        path: "external-work/work_1/normalized-item.json",
        title: "Normalized external work item",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
      {
        id: "artifact_2",
        type: "markdown",
        path: "external-work/work_1/rendered-prompt.md",
        title: "Rendered workflow prompt",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    ],
    duplicate: false,
  };
}

function externalWorkPollResponse() {
  return {
    candidates: 1,
    claimed: 1,
    duplicates: 0,
    blocked: 0,
    retryScheduled: 0,
    terminalIgnored: 0,
    artifacts: [],
    results: [
      {
        action: "claimed",
        identifier: "openclaw/openclaw#86279",
        schedulerStatus: "ready",
        workflowId: "workflow_1",
        workflowStepId: "step_1",
      },
    ],
    schedulerStates: [
      {
        externalWorkId: "external_work_1",
        schedulerStatus: "ready",
        workflowId: "workflow_1",
        workflowStepId: "step_1",
      },
    ],
  };
}

function externalWorkReconcileResponse() {
  return {
    expiredLeases: 1,
    checked: 1,
    blocked: 0,
    retryReady: 0,
    terminal: 1,
    schedulerStates: [
      {
        externalWorkId: "external_work_1",
        schedulerStatus: "terminal",
        workflowId: "workflow_1",
        workflowStepId: "step_1",
      },
    ],
  };
}

function githubPullRequestPayload() {
  return {
    repository: {
      name: "openclaw",
      full_name: "openclaw/openclaw",
      default_branch: "main",
    },
    pull_request: {
      id: 1001,
      number: 86279,
      title: "Add dependency guard",
      state: "open",
      updated_at: "2026-05-29T20:26:56Z",
      head: {
        ref: "dependency-guard",
        sha: "head-sha-1",
      },
    },
  };
}
