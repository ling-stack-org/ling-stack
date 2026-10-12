import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore, executeExternalWorkAction } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

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

test("External work status reports local workflow, token, counts, and background without provider calls", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-status-"));
  const outside = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-status-outside-"));
  const fetchCalls = [];
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error("status endpoint must not call external providers");
  }, { secretResolver: missingSecretResolver() });
  try {
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read"],
    });

    const missingWorkflow = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(missingWorkflow.workflow.exists, false);
    assert.equal(missingWorkflow.workflow.valid, false);
    assert.equal(missingWorkflow.workflow.sourceKind, "unknown");
    assert.equal(fetchCalls.length, 0);

    await writeFile(resolve(cwd, "WORKFLOW.md"), "Body only", "utf8");
    const invalidWorkflow = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(invalidWorkflow.workflow.exists, true);
    assert.equal(invalidWorkflow.workflow.valid, false);
    assert.match(invalidWorkflow.workflow.error, /source\.kind is required/);

    await writeFile(resolve(cwd, "WORKFLOW.md"), statusWorkflowMarkdown(), "utf8");
    await postJson(`${daemon.url}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
    });
    const githubStatus = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}&workflowPath=WORKFLOW.md`);
    assert.equal(githubStatus.workflow.valid, true);
    assert.equal(githubStatus.workflow.sourceKind, "github");
    assert.equal(githubStatus.workflow.repository, "openclaw/openclaw");
    assert.equal(githubStatus.secret.status, "missing");
    assert.equal(githubStatus.secret.ref, "env:GITHUB_TOKEN");
    assert.equal(githubStatus.records.externalWork.total, 1);
    assert.equal(githubStatus.background.status, "not_configured");

    await writeFile(resolve(cwd, "WORKFLOW.md"), statusWorkflowMarkdown(false), "utf8");
    const started = await postJson(`${daemon.url}/external-work/github/background/start?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
      runImmediately: false,
    });
    assert.equal(started.scheduler.status, "running");
    const backgroundStatus = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(backgroundStatus.background.status, "running");
    assert.equal(backgroundStatus.background.schedulerId, started.scheduler.id);

    await writeFile(resolve(cwd, "WORKFLOW.md"), linearStatusWorkflowMarkdown(), "utf8");
    const linearStatus = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(linearStatus.workflow.sourceKind, "linear");
    assert.equal(linearStatus.workflow.projectSlug, "ling-stack");
    assert.equal(linearStatus.background.status, "unsupported");

    await writeFile(resolve(outside, "WORKFLOW.md"), statusWorkflowMarkdown(), "utf8");
    const outsidePath = await getJsonExpectError(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}&workflowPath=${encodeURIComponent(resolve(outside, "WORKFLOW.md"))}`);
    assert.equal(outsidePath.status, 400);
    assert.match(outsidePath.body.message, /inside the channel bound path/);

    const missingChannel = await getJsonExpectError(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=channel_missing`);
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");
    assert.equal(fetchCalls.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("External work workflow setup creates or repairs local WORKFLOW.md without provider calls", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-workflow-"));
  const outside = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-workflow-outside-"));
  const fetchCalls = [];
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error("workflow setup endpoint must not call external providers");
  });
  try {
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read"],
    });

    const created = await postJson(`${daemon.url}/external-work/workflow/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      sourceKind: "github",
      repository: "https://github.com/openclaw/openclaw",
    });
    assert.equal(created.workflowCreated, true);
    assert.equal(created.workflowUpdated, true);
    assert.equal(created.workflow.valid, true);
    assert.equal(created.workflow.repository, "openclaw/openclaw");
    assert.deepEqual(created.workflow.events, ["pull_request.opened", "pull_request.synchronize", "issue.opened"]);

    const workflowText = await readFile(resolve(cwd, "WORKFLOW.md"), "utf8");
    assert.match(workflowText, /repository: openclaw\/openclaw/);
    assert.doesNotMatch(workflowText, /test-github-token/);

    const duplicate = await postJson(`${daemon.url}/external-work/workflow/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      sourceKind: "github",
      repository: "openclaw/openclaw",
    });
    assert.equal(duplicate.workflowCreated, false);
    assert.equal(duplicate.workflowUpdated, false);

    await writeFile(resolve(cwd, "WORKFLOW.md"), "Body only", "utf8");
    const repaired = await postJson(`${daemon.url}/external-work/workflow/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      sourceKind: "linear",
      projectSlug: "ling-stack",
    });
    assert.equal(repaired.workflowCreated, false);
    assert.equal(repaired.workflowUpdated, true);
    assert.equal(repaired.workflow.valid, true);
    assert.equal(repaired.workflow.sourceKind, "linear");
    assert.equal(repaired.workflow.projectSlug, "ling-stack");

    await writeFile(resolve(outside, "WORKFLOW.md"), statusWorkflowMarkdown(), "utf8");
    const outsidePath = await postJsonExpectError(`${daemon.url}/external-work/workflow/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      sourceKind: "github",
      repository: "openclaw/openclaw",
      workflowPath: resolve(outside, "WORKFLOW.md"),
    });
    assert.equal(outsidePath.status, 400);
    assert.match(outsidePath.body.message, /inside the channel bound path/);

    const missingChannel = await postJsonExpectError(`${daemon.url}/external-work/workflow/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: "channel_missing",
      sourceKind: "github",
      repository: "openclaw/openclaw",
    });
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");
    assert.equal(fetchCalls.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("External work secret setup saves keychain refs, updates workflow, and never calls providers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-secret-"));
  const fetchCalls = [];
  const externalSecretStore = createMemoryExternalSecretStore();
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error("secret setup endpoint must not call external providers");
  }, { externalSecretStore });
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), statusWorkflowMarkdown(false), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      boundPath: cwd,
      allowedTools: ["read"],
    });

    const configured = await postJson(`${daemon.url}/external-work/secrets/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      token: "test-github-token",
    });
    assert.equal(configured.sourceKind, "github");
    assert.equal(configured.secretRef, "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
    assert.equal(configured.secret.status, "configured");
    assert.equal(configured.workflowUpdated, true);
    assert.equal(externalSecretStore.resolve(configured.secretRef, "github_token").value, "test-github-token");

    const workflowText = await readFile(resolve(cwd, "WORKFLOW.md"), "utf8");
    assert.match(workflowText, /secretRef: keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN/);
    assert.doesNotMatch(workflowText, /test-github-token/);

    const status = await getJson(`${daemon.url}/external-work/status?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(status.secret.status, "configured");
    assert.equal(status.secret.ref, "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");

    const removed = await postJson(`${daemon.url}/external-work/secrets/delete?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
    });
    assert.equal(removed.secret.status, "missing");
    assert.equal(removed.workflowUpdated, false);

    const envRef = await postJsonExpectError(`${daemon.url}/external-work/secrets/configure?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      token: "second-test-github-token",
      secretRef: "env:GITHUB_TOKEN",
    });
    assert.equal(envRef.status, 400);
    assert.match(envRef.body.message, /keychain/);
    assert.equal(fetchCalls.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
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

test("external work route updates local channel ownership without external mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-route-"));
  const runner = new FailingRunner();
  const githubCalls = [];
  const daemon = await startDaemonForTest(runner, createGitHubBackgroundFetchMock(githubCalls));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const sourceChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub intake",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });
    const targetChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Runtime board",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });
    const polled = await postJson(`${daemon.url}/external-work/github/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: sourceChannel.channel.id,
      workflowPath: "WORKFLOW.md",
    });
    const externalWorkId = polled.results[0].externalWorkId;
    const proposed = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_comment",
      payload: { type: "github_comment", body: "Route after review." },
    });
    assert.equal(proposed.action.channelId, sourceChannel.channel.id);
    const callsBeforeRoute = githubCalls.length;

    const routed = await postJson(`${daemon.url}/external-work/${encodeURIComponent(externalWorkId)}/route?cwd=${encodeURIComponent(cwd)}`, {
      channelId: targetChannel.channel.id,
      priority: 9,
    });
    assert.equal(githubCalls.length, callsBeforeRoute);
    assert.equal(routed.externalWork.externalWork.channelId, targetChannel.channel.id);
    assert.equal(routed.externalWork.externalWork.item.priority, 9);
    assert.equal(routed.externalWork.schedulerState.channelId, targetChannel.channel.id);
    assert.equal(routed.actions[0].action.id, proposed.action.id);
    assert.equal(routed.actions[0].action.channelId, targetChannel.channel.id);
    assert.equal(routed.decision.channelId, targetChannel.channel.id);

    const sourceList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(sourceChannel.channel.id)}`);
    assert.equal(sourceList.externalWork.length, 0);
    const targetList = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(targetChannel.channel.id)}`);
    assert.equal(targetList.externalWork.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Linear external work import and poll use the shared local workflow pipeline without runner or mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-linear-external-work-"));
  const runner = new FailingRunner();
  const linearCalls = [];
  const daemon = await startDaemonForTest(runner, createLinearFetchMock(linearCalls));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), linearWorkflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Linear",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });

    const imported = await postJson(`${daemon.url}/external-work/linear/import?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      eventType: "issue.created",
      payload: linearIssuePayload(),
    });
    assert.equal(imported.duplicate, false);
    assert.equal(imported.externalWorkItem.sourceKind, "linear");
    assert.equal(imported.externalWorkItem.kind, "linear_issue");
    assert.equal(imported.externalWorkItem.identifier, "LIN-123");
    assert.match(imported.workflowStep.prompt, /Review LIN-123/);
    assert.equal(imported.artifacts.length, 2);
    assert.equal(runner.runs.length, 0);

    const poll = await postJson(`${daemon.url}/external-work/linear/poll?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
      limit: 5,
    });
    assert.equal(poll.candidates, 1);
    assert.equal(poll.duplicates, 1);
    assert.equal(poll.schedulerStates[0].schedulerStatus, "ready");
    assert.equal(linearCalls.length, 1);
    assert.equal(linearCalls[0].init.method, "POST");
    assert.match(JSON.parse(linearCalls[0].init.body).query, /issues/);
    assert.equal(runner.runs.length, 0);

    const list = await getJson(`${daemon.url}/external-work?cwd=${encodeURIComponent(cwd)}&sourceKind=linear&workItemKind=linear_issue`);
    assert.equal(list.externalWork.length, 1);
    assert.equal(list.externalWork[0].externalWork.identifier, "LIN-123");
    assert.equal(list.externalWork[0].schedulerState.schedulerStatus, "ready");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work background scheduler registers, ticks, deduplicates, and stops without runner or mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-background-"));
  const runner = new FailingRunner();
  const githubCalls = [];
  const daemon = await startDaemonForTest(runner, createGitHubBackgroundFetchMock(githubCalls));
  try {
    await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "GitHub",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
    });

    const started = await postJson(`${daemon.url}/external-work/github/background/start?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
      limit: 1,
    });
    assert.equal(started.duplicate, false);
    assert.equal(started.scheduler.status, "running");
    assert.equal(started.scheduler.channelId, channel.channel.id);
    assert.equal(started.scheduler.repository, "openclaw/openclaw");
    assert.equal(started.scheduler.tickCount, 1);
    assert.equal(started.scheduler.lastPoll.claimed, 1);
    assert.equal(started.startupReconcile.checked, 0);
    assert.equal(runner.runs.length, 0);
    assert.deepEqual(githubCalls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls",
      "GET /repos/openclaw/openclaw/issues",
      "GET /repos/openclaw/openclaw/pulls/86279",
    ]);

    const listed = await getJson(`${daemon.url}/external-work/background?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.schedulers.length, 1);
    assert.equal(listed.schedulers[0].id, started.scheduler.id);
    assert.equal(listed.schedulers[0].tickCount, 1);

    const githubCallCountAfterFirstTick = githubCalls.length;
    const duplicate = await postJson(`${daemon.url}/external-work/github/background/start?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
      limit: 1,
      runImmediately: false,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.scheduler.id, started.scheduler.id);
    assert.equal(githubCalls.length, githubCallCountAfterFirstTick);

    const stopped = await postJson(`${daemon.url}/external-work/background/${encodeURIComponent(started.scheduler.id)}/stop?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(stopped.scheduler.status, "stopped");
    assert.equal(stopped.scheduler.id, started.scheduler.id);

    const listedAfterStop = await getJson(`${daemon.url}/external-work/background?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedAfterStop.schedulers.length, 1);
    assert.equal(listedAfterStop.schedulers[0].status, "stopped");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work background scheduler returns readable local errors and stores GitHub poll failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-external-work-background-errors-"));
  const runner = new FailingRunner();
  const daemon = await startDaemonForTest(runner, async () => ({
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

    const missingChannel = await postJsonExpectError(`${daemon.url}/external-work/github/background/start?cwd=${encodeURIComponent(cwd)}`, {
      channelId: "channel_missing",
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(missingChannel.status, 400);
    assert.match(missingChannel.body.message, /Channel not found/);

    const githubError = await postJson(`${daemon.url}/external-work/github/background/start?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(githubError.scheduler.status, "running");
    assert.equal(githubError.scheduler.tickCount, 1);
    assert.equal(githubError.scheduler.lastErrorCode, "background_tick_failed");
    assert.match(githubError.scheduler.lastErrorMessage, /GitHub read-only request failed/);
    assert.equal(runner.runs.length, 0);
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

    const invalidReviewEvent = await postJsonExpectError(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_pr_review",
      payload: { type: "github_pr_review", event: "DISMISS", body: "Invalid event." },
    });
    assert.equal(invalidReviewEvent.status, 400);
    assert.match(invalidReviewEvent.body.message, /payload.event/);

    const standardReview = await postJsonExpectError(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_pr_review",
      approvalRequirement: "standard",
      payload: { type: "github_pr_review", event: "COMMENT", body: "Standard should fail." },
    });
    assert.equal(standardReview.status, 400);
    assert.match(standardReview.body.message, /require strict approval/);

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

    const review = await postJson(`${daemon.url}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
      externalWorkId,
      actionKind: "github_pr_review",
      payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix the failing CI before merge." },
    });
    assert.equal(review.action.approvalRequirement, "strict");
    assert.equal(review.approval.risk, "high");
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(review.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Strict PR review approved.",
    });
    const reviewExecuted = await postJson(`${daemon.url}/external-work/actions/${encodeURIComponent(review.action.id)}/execute?cwd=${encodeURIComponent(cwd)}`, {
      workflowPath: "WORKFLOW.md",
    });
    assert.equal(reviewExecuted.action.status, "succeeded");
    assert.deepEqual(githubCalls.slice(-2).map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
      "POST /repos/openclaw/openclaw/pulls/86279/reviews",
    ]);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B003 Host cancelled GET revalidation settles action and Runtime as cancelled without POST", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-cancel-"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const normalFetch = createGitHubActionFetchMock(calls);
  let store;
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    if (init?.method === "GET") {
      entered.resolve();
      await release.promise;
    }
    return await normalFetch(url, init);
  }, {
    storeFactory: (workspaceCwd) => {
      store = createSqliteRunStore(workspaceCwd);
      return store;
    },
  });
  let execution;
  try {
    const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
    const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
    execution = postJson(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    await waitForExternalActionBarrier(entered.promise);
    const concurrent = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    assert.equal(concurrent.status, 400);
    const stillActive = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.equal(stillActive.workUnits.length, 1);
    assert.equal(stillActive.workUnits[0].status, "running");
    const cancelled = await postJson(`${actionUrl}/cancel?cwd=${encodeURIComponent(cwd)}`, { reason: "Cancel before dispatch." });
    assert.equal(cancelled.action.status, "cancelled");
    release.resolve();
    const settled = await execution;
    assert.equal(settled.action.status, "cancelled");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    const detail = await getJson(`${actionUrl}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.action.action.status, "cancelled");
    assert.equal(detail.action.artifacts.at(-1).title, "External action cancellation");
    const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.equal(runtime.workUnits.length, 1);
    const unit = runtime.workUnits[0];
    assert.equal(unit.status, "cancelled");
    assert.equal(store.getWorkUnitAttempt(unit.activeAttemptId).status, "cancelled");
    const events = store.listRuntimeEvents(unit.id);
    assert.equal(events.filter((event) => event.type === "work_unit_cancelled").length, 1);
    assert.equal(events.some((event) => event.type === "work_unit_succeeded" || event.type === "work_unit_failed"), false);
  } finally {
    release.resolve();
    await execution?.catch(() => undefined);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B003 Host refuses cancellation after dispatch and preserves one successful execution", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-dispatch-"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const normalFetch = createGitHubActionFetchMock(calls);
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    const response = await normalFetch(url, init);
    if (init?.method === "POST") {
      entered.resolve();
      await release.promise;
    }
    return response;
  });
  let execution;
  try {
    const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
    const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
    execution = postJson(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    await waitForExternalActionBarrier(entered.promise);
    const cancellation = await postJsonExpectError(`${actionUrl}/cancel?cwd=${encodeURIComponent(cwd)}`, { reason: "Too late to withdraw." });
    assert.equal(cancellation.status, 400);
    assert.match(cancellation.body.message, /cannot be cancelled.*executing/);
    const concurrent = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    assert.equal(concurrent.status, 400);
    const duringDispatch = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.equal(duringDispatch.workUnits.filter((unit) => unit.status === "running").length, 1);
    assert.equal(duringDispatch.workUnits.filter((unit) => unit.status === "failed").length, 1);
    release.resolve();
    const settled = await execution;
    assert.equal(settled.action.status, "succeeded");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.equal(runtime.workUnits.length, 2);
    assert.equal(runtime.workUnits.filter((unit) => unit.status === "succeeded").length, 1);
    assert.equal(runtime.workUnits.filter((unit) => unit.status === "failed").length, 1);
  } finally {
    release.resolve();
    await execution?.catch(() => undefined);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B003 Host records a post-send unknown as failed and never resends the action", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-unknown-"));
  const calls = [];
  const normalFetch = createGitHubActionFetchMock(calls);
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    const response = await normalFetch(url, init);
    if (init?.method === "POST") throw new Error("Isolated response lost after send.");
    return response;
  });
  try {
    const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
    const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
    const settled = await postJson(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    assert.equal(settled.action.status, "failed");
    assert.equal(settled.action.lastErrorCode, "external_action_effect_unconfirmed");
    const retried = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    assert.equal(retried.status, 400);
    assert.match(retried.body.message, /cannot execute.*failed/);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.ok(runtime.workUnits.length > 0);
    assert.equal(runtime.workUnits.some((unit) => unit.status === "succeeded" || unit.status === "cancelled"), false);
    assert.ok(runtime.workUnits.some((unit) => unit.errorCode === "external_action_effect_unconfirmed"));
    const detail = await getJson(`${actionUrl}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.action.action.status, "failed");
    assert.equal(detail.action.action.lastErrorCode, "external_action_effect_unconfirmed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B003 Host rejects a stale invocation observing a successful successor without attributing its evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-successor-"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const oldCalls = [];
  const successorCalls = [];
  const normalFetch = createGitHubActionFetchMock(oldCalls);
  let store;
  const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
    if (init?.method === "GET") {
      entered.resolve();
      await release.promise;
    }
    return await normalFetch(url, init);
  }, {
    storeFactory: (workspaceCwd) => {
      store = createSqliteRunStore(workspaceCwd);
      return store;
    },
  });
  let execution;
  try {
    const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
    const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
    execution = postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
    await waitForExternalActionBarrier(entered.promise);
    const lease = store.listResourceLeases({ status: "active" }).find((candidate) => candidate.resourceType === "external_subject");
    assert.ok(lease);
    store.releaseResourceLease(lease.id, lease.ownerType, lease.ownerId, new Date().toISOString());
    const successor = await executeExternalWorkAction({
      store, actionId: proposed.action.id, fetch: createGitHubActionFetchMock(successorCalls),
    });
    assert.equal(successor.action.status, "succeeded");
    assert.equal(successor.executionSettled, true);
    release.resolve();
    const stale = await execution;
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "external_action_authority_lost");
    assert.equal(stale.body.action.status, "succeeded");
    assert.equal(stale.body.dispatchState, "not_sent");
    assert.equal(oldCalls.filter((call) => call.init.method === "POST").length, 0);
    assert.equal(successorCalls.filter((call) => call.init.method === "POST").length, 1);
    const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
    assert.equal(runtime.workUnits.length, 1);
    assert.equal(runtime.workUnits[0].status, "failed");
    assert.equal(runtime.workUnits[0].errorCode, "external_action_authority_lost");
    assert.equal(store.listRuntimeEvents(runtime.workUnits[0].id).some((event) => event.type === "artifact_created" || event.type === "work_unit_succeeded"), false);
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "succeeded");
  } finally {
    release.resolve();
    await execution?.catch(() => undefined);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const projectionUnavailable of [false, true]) {
  test(`B003 Host preserves post-send uncertainty when evidence${projectionUnavailable ? " and Runtime projection" : ""} persistence fails`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-persistence-"));
    const calls = [];
    let store;
    let database;
    const daemon = await startDaemonForTest(new FailingRunner(), createGitHubActionFetchMock(calls), {
      storeFactory: (workspaceCwd) => {
        store = createSqliteRunStore(workspaceCwd);
        return store;
      },
    });
    try {
      const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
      database = new DatabaseSync(store.paths.databasePath);
      database.exec(`CREATE TRIGGER b003_reject_execution_evidence BEFORE INSERT ON artifacts
        WHEN NEW.title IN ('External action execution result', 'External action execution failure')
        BEGIN SELECT RAISE(ABORT, 'isolated-private-persistence-detail'); END`);
      if (projectionUnavailable) {
        database.exec(`CREATE TRIGGER b003_reject_runtime_failure BEFORE INSERT ON runtime_events
          WHEN NEW.type = 'work_unit_failed'
          BEGIN SELECT RAISE(ABORT, 'isolated-private-runtime-detail'); END`);
      }
      const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
      const failed = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error, "external_action_effect_unconfirmed");
      assert.equal(failed.body.dispatchState, "effect_unconfirmed");
      assert.equal(failed.body.runtimeProjectionUnavailable === true, projectionUnavailable);
      assert.doesNotMatch(JSON.stringify(failed.body), /isolated-private/);
      assert.equal(store.getExternalWorkAction(proposed.action.id).status, "executing");
      const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
      assert.equal(runtime.workUnits.length, 1);
      assert.equal(runtime.workUnits[0].status, projectionUnavailable ? "running" : "failed");
      assert.equal(runtime.workUnits.some((unit) => unit.status === "succeeded" || unit.status === "cancelled"), false);
      const retried = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
      assert.equal(retried.status, 400);
      assert.equal(retried.body.runtimeProjectionUnavailable === true, projectionUnavailable);
      assert.doesNotMatch(JSON.stringify(retried.body), /isolated-private/);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    } finally {
      database?.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { eventType: "artifact_created", status: "succeeded", dispatchState: "effect_confirmed", postCount: 1 },
  { eventType: "work_unit_succeeded", status: "succeeded", dispatchState: "effect_confirmed", postCount: 1 },
  { eventType: "artifact_created", status: "cancelled", dispatchState: "not_sent", postCount: 0 },
  { eventType: "artifact_created", status: "failed", dispatchState: "effect_unconfirmed", postCount: 1 },
]) {
  test(`B003 Host preserves ${scenario.dispatchState} after ${scenario.status} when ${scenario.eventType} projection fails`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-b003-projection-"));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = [];
    const normalFetch = createGitHubActionFetchMock(calls);
    let store;
    let database;
    let execution;
    const daemon = await startDaemonForTest(new FailingRunner(), async (url, init) => {
      if (scenario.status === "cancelled" && init?.method === "GET") {
        entered.resolve();
        await release.promise;
      }
      const response = await normalFetch(url, init);
      if (scenario.status === "failed" && init?.method === "POST") {
        throw new Error("Isolated response lost after send.");
      }
      return response;
    }, {
      storeFactory: (workspaceCwd) => {
        store = createSqliteRunStore(workspaceCwd);
        return store;
      },
    });
    try {
      const proposed = await createApprovedExternalActionForTest(daemon.url, cwd);
      database = new DatabaseSync(store.paths.databasePath);
      database.exec(`CREATE TRIGGER b003_reject_result_projection BEFORE INSERT ON runtime_events
        WHEN NEW.type = '${scenario.eventType}'
        BEGIN SELECT RAISE(ABORT, 'isolated-private-result-projection-detail'); END`);
      const actionUrl = `${daemon.url}/external-work/actions/${encodeURIComponent(proposed.action.id)}`;
      execution = postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
      if (scenario.status === "cancelled") {
        await waitForExternalActionBarrier(entered.promise);
        const cancelled = await postJson(`${actionUrl}/cancel?cwd=${encodeURIComponent(cwd)}`, { reason: "Cancel before dispatch." });
        assert.equal(cancelled.action.status, "cancelled");
        release.resolve();
      }
      const failedProjection = await execution;
      assert.equal(store.getExternalWorkAction(proposed.action.id).status, scenario.status);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, scenario.postCount);
      assert.equal(failedProjection.status, 503);
      assert.equal(failedProjection.body.error, scenario.dispatchState === "effect_unconfirmed"
        ? "external_action_effect_unconfirmed" : "external_action_runtime_projection_failed");
      assert.equal(failedProjection.body.dispatchState, scenario.dispatchState);
      assert.equal(failedProjection.body.executionSettled, true);
      assert.equal(failedProjection.body.action.status, scenario.status);
      assert.equal(failedProjection.body.runtimeProjectionUnavailable, true);
      assert.doesNotMatch(JSON.stringify(failedProjection.body), /isolated-private/);
      const runtime = await getJson(`${daemon.url}/work-units?cwd=${encodeURIComponent(cwd)}&ownerId=${encodeURIComponent(proposed.action.id)}`);
      assert.equal(runtime.workUnits.length, 1);
      const unit = runtime.workUnits[0];
      assert.equal(unit.status, "running");
      assert.equal(store.getWorkUnitAttempt(unit.activeAttemptId).status, "started");
      assert.equal(store.listRuntimeEvents(unit.id).some((event) => ["work_unit_failed", "work_unit_succeeded", "work_unit_cancelled"].includes(event.type)), false);
      const retried = await postJsonExpectError(`${actionUrl}/execute?cwd=${encodeURIComponent(cwd)}`, { workflowPath: "WORKFLOW.md" });
      assert.equal(retried.status, 400);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, scenario.postCount);
      assert.equal(store.getExternalWorkAction(proposed.action.id).status, scenario.status);
    } finally {
      release.resolve();
      await execution?.catch(() => undefined);
      database?.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

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

async function startDaemonForTest(runner, externalWorkFetch, dependencies = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, { runner, externalWorkFetch, ...dependencies });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function createApprovedExternalActionForTest(baseUrl, cwd) {
  await writeFile(resolve(cwd, "WORKFLOW.md"), workflowMarkdown(), "utf8");
  const channel = await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "B003 GitHub", boundPath: cwd, allowedTools: ["read"],
  });
  await postJson(`${baseUrl}/external-work/github/import?cwd=${encodeURIComponent(cwd)}`, {
    channelId: channel.channel.id, eventType: "pull_request.opened", payload: githubPullRequestPayload(),
  });
  const imported = await getJson(`${baseUrl}/external-work?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
  const proposed = await postJson(`${baseUrl}/external-work/actions/propose?cwd=${encodeURIComponent(cwd)}`, {
    externalWorkId: imported.externalWork[0].externalWork.id,
    actionKind: "github_comment", payload: { type: "github_comment", body: "B003 isolated action." },
  });
  await postJson(`${baseUrl}/approvals/${encodeURIComponent(proposed.approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
    reason: "Approve isolated B003 test.",
  });
  return proposed;
}

async function waitForExternalActionBarrier(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("External action did not reach its request barrier.")), 10_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const preparedBody = await prepareChannelCreateBody(url, body);
  await ensureGitRepoForChannelPost(url, preparedBody);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preparedBody),
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

function statusWorkflowMarkdown(withSecret = true) {
  return `---
source:
  kind: github
  repository: openclaw/openclaw
${withSecret ? "  secretRef: env:GITHUB_TOKEN\n" : ""}scheduler:
  reconcileOnStartup: false
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
Head: {{ item.headSha }}
`;
}

function linearWorkflowMarkdown() {
  return `---
source:
  kind: linear
  projectSlug: ling-stack
  events:
    - issue.created
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
State: {{ item.state }}
`;
}

function linearStatusWorkflowMarkdown() {
  return `---
source:
  kind: linear
  projectSlug: ling-stack
  secretRef: env:LINEAR_TOKEN
  events:
    - issue.created
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
State: {{ item.state }}
`;
}

function missingSecretResolver() {
  return {
    status(ref) {
      return {
        ref,
        kind: "env",
        configured: false,
        errorCode: "secret_missing",
        message: `Secret is not configured: ${ref}`,
      };
    },
    resolve(ref) {
      return {
        ref,
        configured: false,
        status: this.status(ref),
      };
    },
  };
}

function createMemoryExternalSecretStore() {
  const values = new Map();
  return {
    status(ref) {
      if (!ref.startsWith("keychain:")) {
        return {
          ref,
          kind: ref.split(":", 1)[0] || "env",
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "Only keychain refs are supported by this test store.",
        };
      }
      const configured = values.has(ref);
      return {
        ref,
        kind: "keychain",
        configured,
        errorCode: configured ? undefined : "secret_missing",
        message: configured ? undefined : `Secret is not configured: ${ref}`,
      };
    },
    resolve(ref) {
      const status = this.status(ref);
      return {
        ref,
        configured: status.configured,
        value: status.configured ? values.get(ref) : undefined,
        status,
      };
    },
    setSecret(ref, value) {
      if (!ref.startsWith("keychain:")) {
        return this.status(ref);
      }
      values.set(ref, value);
      return this.status(ref);
    },
    deleteSecret(ref) {
      values.delete(ref);
      return this.status(ref);
    },
  };
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

function linearIssuePayload() {
  return {
    id: "linear-issue-123",
    identifier: "LIN-123",
    title: "Wire Linear external work",
    description: "Import and poll Linear issues through the external work pipeline.",
    url: "https://linear.app/ling-stack/issue/LIN-123/wire-linear-external-work",
    priority: 2,
    branchName: "tx/linear-external-work",
    updatedAt: "2026-06-01T00:00:00.000Z",
    state: {
      name: "Todo",
      type: "unstarted",
    },
    labels: {
      nodes: [{ name: "external-work" }, { name: "phase-7" }],
    },
    project: {
      name: "Ling Stack",
      slug: "ling-stack",
    },
    team: {
      key: "LIN",
      name: "Ling",
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

function createLinearFetchMock(calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    return jsonResponse({
      data: {
        issues: {
          nodes: [linearIssuePayload()],
        },
      },
    });
  };
}

function createGitHubBackgroundFetchMock(calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/pulls/86279")) {
      return jsonResponse(githubPullRequestPayload().pull_request);
    }
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
    if (url.includes("/pulls/86279/reviews")) {
      return jsonResponse({
        id: 7,
        html_url: "https://github.com/openclaw/openclaw/pull/86279#pullrequestreview-7",
        state: "CHANGES_REQUESTED",
      }, { status: 200, statusText: "OK" });
    }
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
