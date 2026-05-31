import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("GitHub external work import creates a workflow, step, and evidence artifacts without running an agent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-"));
  const runner = new FailingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });

    const first = await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.workflow.status, "ready");
    assert.equal(first.workflowStep.status, "queued");
    assert.match(first.workflowStep.prompt, /Review openclaw\/openclaw#86279/);
    assert.match(first.workflowStep.prompt, /Add dependency guard/);
    assert.equal(first.artifacts.length, 2);
    assert.equal(runner.runs.length, 0);

    const normalizedArtifact = first.artifacts.find((artifact) => artifact.type === "json");
    assert.ok(normalizedArtifact);
    const normalized = await getJson(`${daemon.url}/artifacts/${encodeURIComponent(normalizedArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(normalized.kind, "github_pull_request");
    assert.equal(normalized.idempotencyKey, "github:pull_request:openclaw/openclaw:86279:head-sha-1:2026-05-29T20:26:56Z");

    const duplicate = await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.workflow.id, first.workflow.id);
    assert.equal(duplicate.workflowStep.id, first.workflowStep.id);
    assert.deepEqual(duplicate.artifacts.map((artifact) => artifact.id).sort(), first.artifacts.map((artifact) => artifact.id).sort());

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work import returns readable errors for invalid inputs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-errors-"));
  const outside = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-outside-"));
  const daemon = await startDaemonForTest(new FailingRunner());
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    await writeFile(resolve(outside, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      allowedTools: ["read"],
    });

    const missingChannel = await postJsonExpectError(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: "channel_missing",
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");

    const outsidePath = await postJsonExpectError(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      workflowPath: resolve(outside, "WORKFLOW.md"),
    });
    assert.equal(outsidePath.status, 400);
    assert.match(outsidePath.body.message, /inside the channel bound path/);

    const invalidWorkflow = await postJsonExpectError(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      workflowMarkdown: "Body only",
    });
    assert.equal(invalidWorkflow.status, 400);
    assert.match(invalidWorkflow.body.message, /source\.kind is required/);

    const unsupportedEvent = await postJsonExpectError(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "push",
      payload: githubPullRequestPayload(),
      workflowMarkdown: workflowMarkdown(),
    });
    assert.equal(unsupportedEvent.status, 400);
    assert.match(unsupportedEvent.body.message, /Unsupported GitHub event type/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("GitHub external work poll imports candidates, deduplicates, and reconciles terminal local state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-poll-"));
  const runner = new FailingRunner();
  const daemon = await startDaemonForTest(runner, createGitHubFetchMock());
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });

    const first = await postJson(`${daemon.url}/external-work/github/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(first.candidates, 1);
    assert.equal(first.claimed, 1);
    assert.equal(first.artifacts.length, 2);
    assert.equal(first.schedulerStates[0].schedulerStatus, "ready");
    assert.equal(runner.runs.length, 0);

    const list = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}&status=ready`);
    assert.equal(list.externalWork.length, 1);
    assert.equal(list.externalWork[0].externalWork.identifier, "openclaw/openclaw#86279");
    assert.equal(list.externalWork[0].schedulerState.schedulerStatus, "ready");
    assert.equal(list.externalWork[0].workflow.status, "ready");
    assert.equal(list.externalWork[0].workflowStep.status, "queued");
    assert.equal(list.externalWork[0].artifacts.length, 2);

    const detail = await getJson(`${daemon.url}/external-work/${encodeURIComponent(first.results[0].externalWorkId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.externalWork.externalWork.id, first.results[0].externalWorkId);
    assert.equal(detail.externalWork.schedulerState.workspaceMode, "per_subject");

    const duplicate = await postJson(`${daemon.url}/external-work/github/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(duplicate.duplicates, 1);

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 1);

    await patchJson(`${daemon.url}/workflow-steps/${encodeURIComponent(first.results[0].workflowStepId)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "skipped",
    });
    const reconciled = await postJson(`${daemon.url}/external-work/reconcile?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
    });
    assert.equal(reconciled.checked, 1);
    assert.equal(reconciled.terminal, 1);
    assert.equal(reconciled.schedulerStates[0].schedulerStatus, "terminal");

    const terminalList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&schedulerStatus=terminal`);
    assert.equal(terminalList.externalWork.length, 1);
    assert.equal(terminalList.externalWork[0].schedulerState.schedulerStatus, "terminal");

    const missing = await getJsonExpectError(`${daemon.url}/external-work/external_work_missing?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "external_work_not_found");

    const invalidStatus = await getJsonExpectError(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&status=running`);
    assert.equal(invalidStatus.status, 400);
    assert.match(invalidStatus.body.message, /schedulerStatus must be one of/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work poll returns readable errors for bad input and GitHub failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-poll-errors-"));
  const daemon = await startDaemonForTest(new FailingRunner(), async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    async json() {
      return { message: "rate limited" };
    },
    async text() {
      return JSON.stringify({ message: "rate limited" });
    },
  }));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      allowedTools: ["read"],
    });

    const missingChannel = await postJsonExpectError(`${daemon.url}/external-work/github/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: "channel_missing",
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");

    const githubError = await postJsonExpectError(`${daemon.url}/external-work/github/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(githubError.status, 400);
    assert.match(githubError.body.message, /GitHub read-only request failed/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class FailingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    throw new Error("External work import must not start the runner.");
  }
}

async function startDaemonForTest(runner, externalWorkFetch) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner, externalWorkFetch });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function getJsonExpectError(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJsonExpectError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function workflowMarkdown() {
  return `---
source:
  kind: github
  repository: openclaw/openclaw
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
Head: {{ item.headSha }}
`;
}

function githubPullRequestPayload() {
  return {
    repository: {
      name: "openclaw",
      full_name: "openclaw/openclaw",
      default_branch: "main",
      owner: {
        login: "openclaw",
      },
    },
    pull_request: {
      id: 1001,
      number: 86279,
      title: "Add dependency guard",
      body: "Protect generated dependency files.",
      html_url: "https://github.com/openclaw/openclaw/pull/86279",
      state: "open",
      labels: [{ name: "CI" }, { name: "Dependencies" }],
      updated_at: "2026-05-29T20:26:56Z",
      base: {
        ref: "main",
        sha: "base-sha-1",
      },
      head: {
        ref: "dependency-guard",
        sha: "head-sha-1",
      },
    },
  };
}

function createGitHubFetchMock() {
  return async (url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse([githubPullRequestPayload().pull_request]);
    }
    if (url.includes("/issues?")) {
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" });
  };
}

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
