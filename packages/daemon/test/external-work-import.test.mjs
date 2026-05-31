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

test("external work actions propose, list, show, approve-sync, execute, and cancel with approval gating", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-actions-"));
  const runner = new FailingRunner();
  const githubCalls = [];
  const daemon = await startDaemonForTest(runner, createGitHubActionFetchMock(githubCalls));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });
    const imported = await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    const importedList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    const externalWorkId = importedList.externalWork[0].externalWork.id;
    assert.equal(imported.workflow.id, importedList.externalWork[0].workflow.id);

    const proposed = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_comment",
      approvalRequirement: "strict",
      payload: { type: "github_comment", body: "Ready for maintainer review." },
    });
    assert.equal(proposed.duplicate, false);
    assert.equal(proposed.action.status, "waiting_for_approval");
    assert.equal(proposed.action.target.repository, "openclaw/openclaw");
    assert.equal(proposed.action.target.expectedHeadSha, "head-sha-1");
    assert.equal(proposed.approval.externalWorkActionId, proposed.action.id);
    assert.equal(proposed.artifacts.length, 3);

    const duplicate = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_comment",
      approvalRequirement: "strict",
      payload: { type: "github_comment", body: "Ready for maintainer review." },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.action.id, proposed.action.id);

    const list = await getJson(`${daemon.url}/external-work/actions?cwd=${encodeURIComponent(cwd)}&externalWorkId=${encodeURIComponent(externalWorkId)}&status=waiting_for_approval`);
    assert.equal(list.actions.length, 1);
    assert.equal(list.actions[0].action.id, proposed.action.id);
    assert.equal(list.actions[0].approval.status, "pending");

    const detail = await getJson(`${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.action.action.id, proposed.action.id);
    assert.equal(detail.action.artifacts.length, 3);

    const approved = await postJson(`${daemon.url}/approvals/${encodeURIComponent(proposed.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Looks safe.",
    });
    assert.equal(approved.approval.status, "approved");
    const approvedDetail = await getJson(`${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(approvedDetail.action.action.status, "approved");

    const executed = await postJson(`${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}/execute?cwd=${encodeURIComponent(cwd)}`, {
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(executed.action.status, "succeeded");
    assert.equal(executed.action.executionAttemptCount, 1);
    assert.equal(executed.artifacts.at(-1).title, "External action execution result");
    assert.deepEqual(githubCalls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
      "POST /repos/openclaw/openclaw/issues/86279/comments",
    ]);

    const label = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_label",
      payload: { type: "github_label", labels: ["agent-ready"] },
    });
    const cancelled = await postJson(`${daemon.url}/external-work/actions/${encodeURIComponent(label.action.id)}/cancel?cwd=${encodeURIComponent(cwd)}`, {
      reason: "No longer needed.",
    });
    assert.equal(cancelled.action.status, "cancelled");
    assert.equal(cancelled.approval.status, "denied");
    assert.equal(cancelled.artifacts.at(-1).title, "External action cancellation");
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external work action execute marks stale target without GitHub mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-action-stale-"));
  const runner = new FailingRunner();
  const githubCalls = [];
  const daemon = await startDaemonForTest(runner, createGitHubActionFetchMock(githubCalls, {
    pullRequest: {
      ...githubPullRequestPayload().pull_request,
      head: { ...githubPullRequestPayload().pull_request.head, sha: "head-sha-2" },
    },
  }));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      allowedTools: ["read"],
    });
    await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    const importedList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    const externalWorkId = importedList.externalWork[0].externalWork.id;
    const proposed = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_comment",
      payload: { type: "github_comment", body: "Ready for review." },
    });
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(proposed.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Looks safe.",
    });

    const stale = await postJson(`${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}/execute?cwd=${encodeURIComponent(cwd)}`, {
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(stale.action.status, "stale_target");
    assert.match(stale.action.lastErrorMessage, /head SHA changed/);
    assert.deepEqual(githubCalls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
    ]);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub CI triage creates local records, artifacts, and tasks without starting runner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-ci-"));
  const runner = new FailingRunner();
  const githubCalls = [];
  const daemon = await startDaemonForTest(runner, createGitHubCiFetchMock(githubCalls));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      allowedTools: ["read"],
    });
    await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    const importedList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    const externalWorkId = importedList.externalWork[0].externalWork.id;

    const first = await postJson(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      workflowPath: "WORKFLOW.md",
      limit: 5,
    });
    assert.equal(first.triaged, 2);
    assert.equal(first.taskCreated, 2);
    assert.equal(first.duplicates, 0);
    assert.equal(first.records[0].triage.status, "task_created");
    assert.equal(first.records[0].triage.checkName, "web e2e");
    assert.ok(first.records[0].task.id);
    assert.equal(runner.runs.length, 0);
    assert.deepEqual(githubCalls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
      "GET /repos/openclaw/openclaw/actions/runs",
      "GET /repos/openclaw/openclaw/actions/runs/99/jobs",
      "GET /repos/openclaw/openclaw/actions/jobs/123/logs",
      "GET /repos/openclaw/openclaw/commits/head-sha-1/check-runs",
    ]);

    const logArtifact = first.records[0].artifacts.find((artifact) => artifact.title === "GitHub CI log excerpt");
    assert.ok(logArtifact);
    const log = await getText(`${daemon.url}/artifacts/${encodeURIComponent(logArtifact.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(log, /github-token-secret/);
    assert.match(log, /\[REDACTED\]/);

    const githubCallCountAfterTriage = githubCalls.length;
    const listTriage = await getJson(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}&externalWorkId=${encodeURIComponent(externalWorkId)}&channelId=${encodeURIComponent(channel.channel.id)}&status=task_created&limit=10`);
    assert.equal(listTriage.records.length, 2);
    assert.equal(listTriage.records[0].triage.externalWorkId, externalWorkId);
    assert.equal(listTriage.records[0].externalWork.id, externalWorkId);
    assert.ok(listTriage.records[0].task.id);
    assert.ok(listTriage.records[0].artifacts.length > 0);
    assert.equal(githubCalls.length, githubCallCountAfterTriage);

    const detailTriage = await getJson(`${daemon.url}/external-work/github/ci/triage/${encodeURIComponent(first.records[0].triage.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detailTriage.record.triage.id, first.records[0].triage.id);
    assert.equal(detailTriage.record.task.id, first.records[0].task.id);
    assert.equal(githubCalls.length, githubCallCountAfterTriage);

    const missingTriage = await getJsonExpectError(`${daemon.url}/external-work/github/ci/triage/external_work_ci_triage_missing?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingTriage.status, 404);
    assert.equal(missingTriage.body.error, "ci_triage_not_found");

    const invalidTriageStatus = await getJsonExpectError(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}&status=ready`);
    assert.equal(invalidTriageStatus.status, 400);
    assert.match(invalidTriageStatus.body.message, /status must be one of/);

    const duplicate = await postJson(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(duplicate.triaged, 0);
    assert.equal(duplicate.taskCreated, 0);
    assert.equal(duplicate.duplicates, 2);
    const tasks = await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(tasks.tasks.length, 2);

    const startRun = await postJsonExpectError(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      workflowPath: "WORKFLOW.md",
      startRun: true,
    });
    assert.equal(startRun.status, 400);
    assert.match(startRun.body.message, /startRun is not supported/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub CI triage run bridge starts an explicit local fix run and links it to triage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-ci-run-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner, createGitHubCiFetchMock([]));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const provider = await createStaticChatProvider(daemon.url, cwd);
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      allowedTools: ["read"],
    });
    await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    const importedList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    const externalWorkId = importedList.externalWork[0].externalWork.id;
    const triage = await postJson(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      workflowPath: "WORKFLOW.md",
      limit: 1,
    });
    const triageId = triage.records[0].triage.id;
    const taskId = triage.records[0].triage.taskId;

    const sse = await postSse(`${daemon.url}/external-work/github/ci/triage/${encodeURIComponent(triageId)}/run?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
      tools: ["read"],
      thinkingLevel: "low",
    });
    const runId = readReadyRunId(sse);
    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].task.id, taskId);
    assert.equal(runner.runs[0].cwd, cwd);
    assert.deepEqual(runner.runs[0].tools, ["read"]);

    const duplicateSse = await postSse(`${daemon.url}/external-work/github/ci/triage/${encodeURIComponent(triageId)}/run?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.provider.id,
      skipProviderPreflight: true,
    });
    assert.equal(readReadyRunId(duplicateSse), runId);
    assert.equal(runner.runs.length, 1);

    const duplicateTriage = await postJson(`${daemon.url}/external-work/github/ci/triage?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      workflowPath: "WORKFLOW.md",
      limit: 1,
    });
    assert.equal(duplicateTriage.records[0].triage.status, "run_requested");
    assert.equal(duplicateTriage.records[0].triage.runId, runId);
    assert.equal(duplicateTriage.records[0].run.id, runId);
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

class RecordingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    return {
      taskId: options.task.id,
      messages: [],
      events: [],
    };
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

async function getText(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.ok(response.ok, text);
  return text;
}

async function postSse(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return text;
}

function readReadyRunId(sseText) {
  for (const block of sseText.split(/\r?\n\r?\n/)) {
    if (!block.includes("event: ready")) {
      continue;
    }
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }
    return JSON.parse(dataLine.slice("data:".length).trim()).runId;
  }
  return undefined;
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

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
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

function createGitHubActionFetchMock(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/pulls/86279")) {
      return jsonResponse(options.pullRequest ?? githubPullRequestPayload().pull_request);
    }
    if (url.includes("/issues/86279/comments")) {
      return jsonResponse({
        id: 1,
        html_url: "https://github.com/openclaw/openclaw/pull/86279#issuecomment-1",
      }, { status: 201, statusText: "Created" });
    }
    if (url.includes("/issues/86279/labels")) {
      return jsonResponse([{ name: "agent-ready", url: "https://api.github.test/labels/agent-ready" }]);
    }
    return jsonResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" });
  };
}

function createGitHubCiFetchMock(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/pulls/86279")) {
      return jsonResponse(options.pullRequest ?? githubPullRequestPayload().pull_request);
    }
    if (url.includes("/actions/runs?")) {
      return jsonResponse({
        workflow_runs: [{
          id: 99,
          name: "CI",
          conclusion: "failure",
          html_url: "https://github.com/openclaw/openclaw/actions/runs/99",
          updated_at: "2026-05-30T00:00:00Z",
        }],
      });
    }
    if (url.includes("/actions/runs/99/jobs")) {
      return jsonResponse({
        jobs: [{
          id: 123,
          name: "web e2e",
          conclusion: "failure",
          html_url: "https://github.com/openclaw/openclaw/actions/runs/99/job/123",
          completed_at: "2026-05-30T00:00:30Z",
        }],
      });
    }
    if (url.includes("/actions/jobs/123/logs")) {
      return textResponse([
        "2026-05-30T00:00:01Z ##[group]Run corepack pnpm --filter @ling-stack/web test:e2e",
        "Authorization: Bearer github-token-secret",
        "apps/web/e2e/app.spec.ts:12: expected visible text",
      ].join("\n"));
    }
    if (url.includes("/commits/head-sha-1/check-runs")) {
      return jsonResponse({
        check_runs: [{
          id: 456,
          name: "lint",
          conclusion: "failure",
          html_url: "https://github.com/openclaw/openclaw/runs/456",
          completed_at: "2026-05-30T00:00:20Z",
          output: {
            title: "Lint failed",
            summary: "Run corepack pnpm lint",
            text: "packages/core/src/index.ts:1 lint error",
          },
        }],
      });
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

function textResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
  };
}
