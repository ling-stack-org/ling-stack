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

test("external-work linear import and poll render human and json output", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-linear-external-work-"));
  try {
    const payloadFile = resolve(cwd, "linear-issue.json");
    const workflowFile = resolve(cwd, "linear-workflow.md");
    await writeFile(payloadFile, JSON.stringify(linearIssuePayload()), "utf8");
    await writeFile(workflowFile, "Review {{ item.identifier }}.\n", "utf8");

    const imported = await runCli(daemon.url, cwd, [
      "external-work",
      "linear",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "issue.created",
      "--payload-file",
      payloadFile,
      "--workflow-path",
      "WORKFLOW.md",
    ]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /External work imported: LIN-123/);
    assert.match(imported.stdout, /Kind: linear_issue/);
    assert.equal(daemon.requests.at(-1).path, "/external-work/linear/import");
    assert.deepEqual(daemon.requests.at(-1).body, {
      channelId: "channel_1",
      eventType: "issue.created",
      payload: linearIssuePayload(),
      workflowPath: "WORKFLOW.md",
    });

    const jsonImport = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "linear",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "issue.created",
      "--payload-file",
      payloadFile,
      "--workflow-markdown-file",
      workflowFile,
    ]);
    assert.equal(jsonImport.code, 0, jsonImport.stderr);
    assert.equal(JSON.parse(jsonImport.stdout).externalWorkItem.kind, "linear_issue");
    assert.equal(daemon.requests.at(-1).body.workflowMarkdown, "Review {{ item.identifier }}.\n");
    assert.equal("workflowPath" in daemon.requests.at(-1).body, false);

    const poll = await runCli(daemon.url, cwd, [
      "external-work",
      "linear",
      "poll",
      "--channel",
      "channel_1",
      "--workflow-path",
      "WORKFLOW.md",
      "--limit",
      "5",
      "--execute-hooks",
    ]);
    assert.equal(poll.code, 0, poll.stderr);
    assert.match(poll.stdout, /External work poll:/);
    assert.match(poll.stdout, /LIN-123/);
    assert.equal(daemon.requests.at(-1).path, "/external-work/linear/poll");
    assert.deepEqual(daemon.requests.at(-1).body, {
      channelId: "channel_1",
      workflowPath: "WORKFLOW.md",
      limit: 5,
      executeHooks: true,
    });

    const jsonPoll = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "linear",
      "poll",
      "--channel",
      "channel_1",
    ]);
    assert.equal(jsonPoll.code, 0, jsonPoll.stderr);
    assert.equal(JSON.parse(jsonPoll.stdout).results[0].identifier, "LIN-123");

    const missingChannel = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "linear",
      "import",
      "--event-type",
      "issue.created",
      "--payload-file",
      payloadFile,
    ]);
    assert.equal(missingChannel.code, 2);
    assert.match(missingChannel.stderr, /--channel/);

    const mutuallyExclusiveWorkflowFlags = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "linear",
      "import",
      "--channel",
      "channel_1",
      "--event-type",
      "issue.created",
      "--payload-file",
      payloadFile,
      "--workflow-path",
      "WORKFLOW.md",
      "--workflow-markdown-file",
      workflowFile,
    ]);
    assert.equal(mutuallyExclusiveWorkflowFlags.code, 2);
    assert.match(mutuallyExclusiveWorkflowFlags.stderr, /mutually exclusive/);

    const invalidLimit = await runCli("http://127.0.0.1:9", cwd, [
      "external-work",
      "linear",
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

test("external-work github background start, list, and stop render human and json output", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-background-"));
  try {
    const humanStart = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "background",
      "start",
      "--channel",
      "channel_1",
      "--workflow-path",
      "WORKFLOW.md",
      "--limit",
      "5",
      "--execute-hooks",
      "--no-run-immediately",
    ]);
    assert.equal(humanStart.code, 0, humanStart.stderr);
    assert.match(humanStart.stdout, /External work background scheduler started: external_work_background_1/);
    assert.match(humanStart.stdout, /Status: running/);
    assert.match(humanStart.stdout, /Repository: openclaw\/openclaw/);
    assert.equal(daemon.requests.at(-1).path, "/external-work/github/background/start");
    assert.deepEqual(daemon.requests.at(-1).body, {
      channelId: "channel_1",
      workflowPath: "WORKFLOW.md",
      limit: 5,
      executeHooks: true,
      runImmediately: false,
    });

    const jsonStart = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "background",
      "start",
      "--channel",
      "channel_1",
    ]);
    assert.equal(jsonStart.code, 0, jsonStart.stderr);
    assert.equal(JSON.parse(jsonStart.stdout).scheduler.id, "external_work_background_1");

    const humanList = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "background",
      "list",
    ]);
    assert.equal(humanList.code, 0, humanList.stderr);
    assert.match(humanList.stdout, /External work background schedulers:/);
    assert.match(humanList.stdout, /external_work_background_1/);
    assert.equal(daemon.requests.at(-1).method, "GET");
    assert.equal(daemon.requests.at(-1).path, "/external-work/background");

    const jsonList = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "background",
      "list",
    ]);
    assert.equal(jsonList.code, 0, jsonList.stderr);
    assert.equal(JSON.parse(jsonList.stdout).schedulers[0].id, "external_work_background_1");

    const humanStop = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "background",
      "stop",
      "external_work_background_1",
    ]);
    assert.equal(humanStop.code, 0, humanStop.stderr);
    assert.match(humanStop.stdout, /External work background scheduler stopped: external_work_background_1/);
    assert.match(humanStop.stdout, /Status: stopped/);
    assert.equal(daemon.requests.at(-1).method, "POST");
    assert.equal(daemon.requests.at(-1).path, "/external-work/background/external_work_background_1/stop");
    assert.deepEqual(daemon.requests.at(-1).body, {});

    const missingChannel = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "background",
      "start",
    ]);
    assert.equal(missingChannel.code, 2);
    assert.match(missingChannel.stderr, /--channel/);

    const invalidLimit = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "background",
      "start",
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

test("external-work status renders human and json output", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-status-"));
  const daemon = await startExternalWorkDaemon();
  try {
    const human = await runCli(daemon.url, cwd, [
      "external-work",
      "status",
      "--channel",
      "channel_1",
      "--workflow-path",
      "WORKFLOW.md",
    ]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /External work status:/);
    assert.match(human.stdout, /Workflow valid: true/);
    assert.match(human.stdout, /Target: openclaw\/openclaw/);
    assert.match(human.stdout, /Background: running/);
    assert.equal(daemon.requests.at(-1).method, "GET");
    assert.equal(daemon.requests.at(-1).path, "/external-work/status");
    assert.equal(daemon.requests.at(-1).query.channelId, "channel_1");

    const json = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "status",
      "--channel",
      "channel_1",
    ]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).workflow.repository, "openclaw/openclaw");

    const missingChannel = await runCli(daemon.url, cwd, ["external-work", "status"]);
    assert.equal(missingChannel.code, 2);
    assert.match(missingChannel.stderr, /--channel/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work github ci triage renders human and json output", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-ci-"));
  try {
    const human = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "ci",
      "triage",
      "--external-work",
      "external_work_1",
      "--workflow-path",
      "WORKFLOW.md",
      "--limit",
      "5",
    ]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /External work CI triage:/);
    assert.match(human.stdout, /Triaged: 1/);
    assert.match(human.stdout, /Task created: 1/);
    assert.match(human.stdout, /web e2e/);

    const json = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "ci",
      "triage",
      "--external-work",
      "external_work_1",
      "--no-create-task",
    ]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).records[0].triage.checkName, "web e2e");
    assert.equal(daemon.requests.at(-1).path, "/external-work/github/ci/triage");
    assert.deepEqual(daemon.requests[0].body, {
      externalWorkId: "external_work_1",
      workflowPath: "WORKFLOW.md",
      limit: 5,
    });
    assert.deepEqual(daemon.requests.at(-1).body, {
      externalWorkId: "external_work_1",
      createTask: false,
    });

    const missingExternalWork = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "ci",
      "triage",
    ]);
    assert.equal(missingExternalWork.code, 2);
    assert.match(missingExternalWork.stderr, /--external-work/);

    const invalidLimit = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "ci",
      "triage",
      "--external-work",
      "external_work_1",
      "--limit",
      "26",
    ]);
    assert.equal(invalidLimit.code, 2);
    assert.match(invalidLimit.stderr, /at most 25/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work github ci run streams an explicit local fix run", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-ci-run-"));
  try {
    const result = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "ci",
      "run",
      "--triage",
      "external_work_ci_triage_1",
      "--provider",
      "provider_1",
      "--skip-preflight",
      "--tool",
      "read",
      "--thinking",
      "low",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Run: run_ci_fix_1/);
    assert.equal(daemon.requests.at(-1).method, "POST");
    assert.equal(daemon.requests.at(-1).path, "/external-work/github/ci/triage/external_work_ci_triage_1/run");
    assert.deepEqual(daemon.requests.at(-1).body, {
      providerPresetId: "provider_1",
      skipProviderPreflight: true,
      tools: ["read"],
      thinkingLevel: "low",
      appendSystemPrompt: [],
    });

    const json = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "github",
      "ci",
      "run",
      "--triage",
      "external_work_ci_triage_1",
      "--provider",
      "provider_1",
      "--skip-preflight",
    ]);
    assert.equal(json.code, 0, json.stderr);
    const lines = json.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "ready");
    assert.equal(lines[0].runId, "run_ci_fix_1");

    const missingTriage = await runCli(daemon.url, cwd, [
      "external-work",
      "github",
      "ci",
      "run",
      "--provider",
      "provider_1",
    ]);
    assert.equal(missingTriage.code, 2);
    assert.match(missingTriage.stderr, /--triage/);
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

test("external-work list and show render local scheduler state", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-list-"));
  try {
    const list = await runCli(daemon.url, cwd, [
      "external-work",
      "list",
      "--channel",
      "channel_1",
      "--status",
      "ready",
      "--work-item-kind",
      "github_pull_request",
      "--limit",
      "25",
    ]);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /External work:/);
    assert.match(list.stdout, /openclaw\/openclaw#86279/);
    assert.match(list.stdout, /ready/);
    assert.equal(daemon.requests[0].method, "GET");
    assert.equal(daemon.requests[0].path, "/external-work");
    assert.equal(daemon.requests[0].query.status, "ready");
    assert.equal(daemon.requests[0].query.workItemKind, "github_pull_request");

    const show = await runCli(daemon.url, cwd, [
      "external-work",
      "show",
      "external_work_1",
    ]);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /External work: external_work_1/);
    assert.match(show.stdout, /Scheduler: ready/);
    assert.match(show.stdout, /Artifacts:/);

    const json = await runCli(daemon.url, cwd, [
      "--json",
      "external-work",
      "show",
      "external_work_1",
    ]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).externalWork.externalWork.id, "external_work_1");

    const missingId = await runCli(daemon.url, cwd, [
      "external-work",
      "show",
    ]);
    assert.equal(missingId.code, 2);
    assert.match(missingId.stderr, /external-work show/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("external-work actions propose, list, show, cancel, and execute render action output", async () => {
  const daemon = await startExternalWorkDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-external-work-actions-"));
  try {
    const bodyFile = resolve(cwd, "comment.md");
    await writeFile(bodyFile, "Ready for review.\n", "utf8");
    const proposed = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "propose-comment",
      "--external-work",
      "external_work_1",
      "--body-file",
      bodyFile,
      "--approval",
      "strict",
    ]);
    assert.equal(proposed.code, 0, proposed.stderr);
    assert.match(proposed.stdout, /External work action proposed: external_work_action_1/);
    assert.match(proposed.stdout, /waiting_for_approval/);
    assert.equal(daemon.requests.at(-1).path, "/external-work/actions/propose");
    assert.equal(daemon.requests.at(-1).body.actionKind, "github_comment");
    assert.equal(daemon.requests.at(-1).body.payload.body, "Ready for review.\n");

    const labels = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "propose-labels",
      "--external-work",
      "external_work_1",
      "--label",
      "agent-ready",
      "--label",
      "needs-review",
    ]);
    assert.equal(labels.code, 0, labels.stderr);
    assert.equal(daemon.requests.at(-1).body.actionKind, "github_label");
    assert.deepEqual(daemon.requests.at(-1).body.payload.labels, ["agent-ready", "needs-review"]);

    const reviewFile = resolve(cwd, "review.md");
    await writeFile(reviewFile, "Please fix CI before merge.\n", "utf8");
    const review = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "propose-review",
      "--external-work",
      "external_work_1",
      "--event",
      "REQUEST_CHANGES",
      "--body-file",
      reviewFile,
    ]);
    assert.equal(review.code, 0, review.stderr);
    assert.match(review.stdout, /External work action proposed: external_work_action_1/);
    assert.equal(daemon.requests.at(-1).body.actionKind, "github_pr_review");
    assert.equal(daemon.requests.at(-1).body.approvalRequirement, "strict");
    assert.deepEqual(daemon.requests.at(-1).body.payload, {
      type: "github_pr_review",
      event: "REQUEST_CHANGES",
      body: "Please fix CI before merge.\n",
    });

    const list = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "list",
      "--external-work",
      "external_work_1",
      "--status",
      "waiting_for_approval",
    ]);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /External work actions:/);
    assert.match(list.stdout, /external_work_action_1/);

    const show = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "show",
      "external_work_action_1",
    ]);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /External work action: external_work_action_1/);
    assert.match(show.stdout, /Approval: approval_1/);

    const cancel = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "cancel",
      "external_work_action_1",
      "--reason",
      "No longer needed.",
    ]);
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, /External work action cancelled: external_work_action_1/);
    assert.match(cancel.stdout, /cancelled/);

    const execute = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "execute",
      "external_work_action_1",
      "--workflow-path",
      "WORKFLOW.md",
    ]);
    assert.equal(execute.code, 0, execute.stderr);
    assert.match(execute.stdout, /External work action executed: external_work_action_1/);
    assert.match(execute.stdout, /succeeded/);
    assert.equal(daemon.requests.at(-1).path, "/external-work/actions/external_work_action_1/execute");
    assert.deepEqual(daemon.requests.at(-1).body, { workflowPath: "WORKFLOW.md" });

    const invalidApproval = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "propose-comment",
      "--external-work",
      "external_work_1",
      "--body-file",
      bodyFile,
      "--approval",
      "fast",
    ]);
    assert.equal(invalidApproval.code, 2);
    assert.match(invalidApproval.stderr, /approval must be standard or strict/);

    const standardReview = await runCli(daemon.url, cwd, [
      "external-work",
      "actions",
      "propose-review",
      "--external-work",
      "external_work_1",
      "--event",
      "COMMENT",
      "--body-file",
      reviewFile,
      "--approval",
      "standard",
    ]);
    assert.equal(standardReview.code, 2);
    assert.match(standardReview.stderr, /github_pr_review actions require --approval strict/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

function runCli(daemonUrl, cwd, args) {
  return new Promise((resolveResult) => {
    const child = execFile(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
    child.stdin?.end();
  });
}

async function startExternalWorkDaemon() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/external-work") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkListResponse());
      return;
    }
    if (request.method === "GET" && url.pathname === "/external-work/external_work_1") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkDetailResponse());
      return;
    }
    if (request.method === "GET" && url.pathname === "/external-work/actions") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkActionsListResponse());
      return;
    }
    if (request.method === "GET" && url.pathname === "/external-work/actions/external_work_action_1") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkActionDetailResponse());
      return;
    }
    if (request.method === "GET" && url.pathname === "/external-work/background") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkBackgroundListResponse());
      return;
    }
    if (request.method === "GET" && url.pathname === "/external-work/status") {
      requests.push({
        method: request.method,
        path: url.pathname,
        cwd: url.searchParams.get("cwd"),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      writeJson(response, 200, externalWorkStatusResponse());
      return;
    }
    const isCiRunPath = /^\/external-work\/github\/ci\/triage\/[^/]+\/run$/.test(url.pathname);
    const isBackgroundStopPath = /^\/external-work\/background\/[^/]+\/stop$/.test(url.pathname);
    if (request.method !== "POST" || (!isCiRunPath && !isBackgroundStopPath && ![
      "/external-work/github/import",
      "/external-work/github/poll",
      "/external-work/linear/import",
      "/external-work/linear/poll",
      "/external-work/github/background/start",
      "/external-work/github/ci/triage",
      "/external-work/reconcile",
      "/external-work/actions/propose",
      "/external-work/actions/external_work_action_1/cancel",
      "/external-work/actions/external_work_action_1/execute",
    ].includes(url.pathname))) {
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
    if (isCiRunPath) {
      writeSseRun(response);
      return;
    }
    if (body.eventType === "push") {
      writeJson(response, 400, { error: "bad_request", message: "Unsupported GitHub event type: push" });
      return;
    }
    if (url.pathname === "/external-work/github/poll") {
      writeJson(response, 200, externalWorkPollResponse());
      return;
    }
    if (url.pathname === "/external-work/linear/poll") {
      writeJson(response, 200, externalWorkPollResponse("linear"));
      return;
    }
    if (url.pathname === "/external-work/github/background/start") {
      writeJson(response, 200, externalWorkBackgroundMutationResponse());
      return;
    }
    if (isBackgroundStopPath) {
      writeJson(response, 200, externalWorkBackgroundMutationResponse("stopped"));
      return;
    }
    if (url.pathname === "/external-work/github/ci/triage") {
      writeJson(response, 200, externalWorkCiTriageResponse());
      return;
    }
    if (url.pathname === "/external-work/reconcile") {
      writeJson(response, 200, externalWorkReconcileResponse());
      return;
    }
    if (url.pathname === "/external-work/actions/propose") {
      writeJson(response, 200, externalWorkActionMutationResponse(body.actionKind));
      return;
    }
    if (url.pathname === "/external-work/actions/external_work_action_1/cancel") {
      writeJson(response, 200, externalWorkActionMutationResponse("github_comment", "cancelled"));
      return;
    }
    if (url.pathname === "/external-work/actions/external_work_action_1/execute") {
      writeJson(response, 200, externalWorkActionMutationResponse("github_comment", "succeeded"));
      return;
    }
    writeJson(response, 201, externalWorkImportResponse(url.pathname.includes("/linear/") ? "linear" : "github"));
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

function writeSseRun(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ ok: true, runId: "run_ci_fix_1" })}\n\n`);
  response.write(`event: result\ndata: ${JSON.stringify({
    id: "event_1",
    runId: "run_ci_fix_1",
    seq: 1,
    ts: "2026-05-31T00:00:00.000Z",
    type: "result",
    data: { taskId: "task_1", messageCount: 0, runnerEventCount: 0 },
  })}\n\n`);
  response.end();
}

function externalWorkImportResponse(source = "github") {
  const isLinear = source === "linear";
  return {
    externalWorkItem: {
      id: isLinear ? "linear:issue:linear-issue-123" : "github:pull_request:openclaw/openclaw#86279",
      sourceKind: isLinear ? "linear" : "github",
      kind: isLinear ? "linear_issue" : "github_pull_request",
      identifier: isLinear ? "LIN-123" : "openclaw/openclaw#86279",
      title: isLinear ? "Wire Linear external work" : "Add dependency guard",
      state: isLinear ? "Todo" : "open",
      labels: isLinear ? ["external-work", "phase-7"] : ["CI", "Dependencies"],
      payloadRef: isLinear ? "linear:fixture:LIN-123" : "pull_request.opened:openclaw/openclaw#86279",
      idempotencyKey: isLinear
        ? "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z"
        : "github:pull_request:openclaw/openclaw:86279:head-sha-1:2026-05-29T20:26:56Z",
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

function externalWorkPollResponse(source = "github") {
  const isLinear = source === "linear";
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
        identifier: isLinear ? "LIN-123" : "openclaw/openclaw#86279",
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

function externalWorkCiTriageResponse() {
  return {
    cwd: "/repo",
    triaged: 1,
    taskCreated: 1,
    duplicates: 0,
    blocked: 0,
    stale: 0,
    failed: 0,
    records: [
      {
        triage: {
          id: "external_work_ci_triage_1",
          externalWorkId: "external_work_1",
          repository: "openclaw/openclaw",
          subjectNumber: 86279,
          status: "task_created",
          checkName: "web e2e",
          taskId: "task_1",
          artifactIds: ["artifact_ci_1"],
        },
        task: {
          id: "task_1",
          status: "todo",
          title: "Fix failing CI: web e2e",
        },
        artifacts: [
          {
            id: "artifact_ci_1",
            type: "log",
            path: "external-work/work_1/ci-triage/log-excerpt.txt",
            title: "GitHub CI log excerpt",
            createdAt: "2026-05-31T00:00:00.000Z",
          },
        ],
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

function externalWorkBackgroundScheduler(status = "running") {
  const scheduler = {
    id: "external_work_background_1",
    cwd: "/repo",
    sourceKind: "github",
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    repository: "openclaw/openclaw",
    pollIntervalMs: 30000,
    limit: 5,
    executeHooks: true,
    status,
    startedAt: "2026-06-01T00:00:00.000Z",
    tickCount: 1,
  };
  if (status === "stopped") {
    scheduler.stoppedAt = "2026-06-01T00:01:00.000Z";
  } else {
    scheduler.nextPollAt = "2026-06-01T00:00:30.000Z";
  }
  return scheduler;
}

function externalWorkBackgroundMutationResponse(status = "running") {
  return {
    cwd: "/repo",
    scheduler: externalWorkBackgroundScheduler(status),
    duplicate: false,
  };
}

function externalWorkBackgroundListResponse() {
  return {
    cwd: "/repo",
    schedulers: [externalWorkBackgroundScheduler()],
  };
}

function externalWorkStatusResponse() {
  return {
    cwd: "/repo",
    channel: {
      id: "channel_1",
      name: "Engineering",
      boundPath: "/repo",
    },
    workflow: {
      path: "/repo/WORKFLOW.md",
      exists: true,
      valid: true,
      sourceKind: "github",
      repository: "openclaw/openclaw",
      events: ["pull_request.opened", "issues.opened"],
      secretRef: "env:GITHUB_TOKEN",
    },
    secret: {
      ref: "env:GITHUB_TOKEN",
      purpose: "github_token",
      status: "configured",
    },
    records: {
      externalWork: { total: 2, ready: 1, blocked: 1, retryWait: 0, terminal: 0 },
      ciTriage: { total: 1, triaged: 0, taskCreated: 1, runRequested: 0, blocked: 0, stale: 0, failed: 0 },
      actions: { total: 1, waitingForApproval: 1, approved: 0, failed: 0, succeeded: 0, cancelled: 0, staleTarget: 0 },
    },
    background: {
      supported: true,
      running: true,
      schedulerId: "external_work_background_1",
      status: "running",
      lastTickAt: "2026-06-01T00:00:00.000Z",
      nextPollAt: "2026-06-01T00:00:30.000Z",
    },
    lastErrors: {},
  };
}

function externalWorkListResponse() {
  return {
    cwd: "/repo",
    externalWork: [externalWorkView()],
  };
}

function externalWorkDetailResponse() {
  return {
    cwd: "/repo",
    externalWork: externalWorkView(),
  };
}

function externalWorkView() {
  return {
    externalWork: {
      id: "external_work_1",
      channelId: "channel_1",
      workItemKind: "github_pull_request",
      identifier: "openclaw/openclaw#86279",
      workflowId: "workflow_1",
      workflowStepId: "step_1",
      item: {
        state: "open",
      },
    },
    workflow: {
      id: "workflow_1",
      status: "ready",
    },
    workflowStep: {
      id: "step_1",
      status: "queued",
    },
    schedulerState: {
      externalWorkId: "external_work_1",
      schedulerStatus: "ready",
      workspacePath: "/repo/.ling-stack/external-workspaces/github/hash",
      lastErrorMessage: "",
    },
    artifacts: [
      {
        id: "artifact_1",
        type: "json",
        path: "external-work/work_1/normalized-item.json",
        title: "Normalized external work item",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    ],
  };
}

function externalWorkActionMutationResponse(actionKind = "github_comment", status = "waiting_for_approval") {
  return {
    cwd: "/repo",
    action: externalWorkAction(actionKind, status),
    approval: {
      id: "approval_1",
      externalWorkActionId: "external_work_action_1",
      status: status === "cancelled" ? "denied" : "pending",
    },
    artifacts: [
      {
        id: "artifact_action_1",
        type: "json",
        path: "external-work/work_1/actions/action_1/payload.json",
        title: "External action proposed payload",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    ],
    duplicate: false,
  };
}

function externalWorkActionsListResponse() {
  return {
    cwd: "/repo",
    actions: [externalWorkActionView()],
  };
}

function externalWorkActionDetailResponse() {
  return {
    cwd: "/repo",
    action: externalWorkActionView(),
  };
}

function externalWorkActionView() {
  return {
    action: externalWorkAction(),
    externalWork: externalWorkView().externalWork,
    approval: {
      id: "approval_1",
      externalWorkActionId: "external_work_action_1",
      status: "pending",
    },
    artifacts: [
      {
        id: "artifact_action_1",
        type: "json",
        path: "external-work/work_1/actions/action_1/payload.json",
        title: "External action proposed payload",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    ],
  };
}

function externalWorkAction(actionKind = "github_comment", status = "waiting_for_approval") {
  return {
    id: "external_work_action_1",
    externalWorkId: "external_work_1",
    actionKind,
    status,
    approvalId: "approval_1",
    approvalRequirement: actionKind === "github_pr_review" ? "strict" : "standard",
    target: {
      repository: "openclaw/openclaw",
      number: 86279,
    },
    artifactIds: ["artifact_action_1"],
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
  };
}
