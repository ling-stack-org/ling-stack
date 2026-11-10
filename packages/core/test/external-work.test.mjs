import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSqliteRunStore,
  createGitHubCiTriageAdapter,
  createGitHubExternalActionAdapter,
  createGitHubExternalWorkAdapter,
  createLinearExternalWorkAdapter,
  executeExternalWorkAction,
  ExternalWorkActionExecutionError,
  normalizeGitHubExternalWorkItem,
  normalizeLinearExternalWorkItem,
  parseExternalWorkflowMarkdown,
  pollGitHubExternalWork,
  pollLinearExternalWork,
  proposeExternalWorkAction,
  triageGitHubExternalWorkCi,
  cancelExternalWorkAction,
  syncExternalWorkActionForApproval,
  renderExternalWorkflowPrompt,
  updateExternalWorkflowSecretRef,
} from "../dist/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");

const workflowMarkdown = `---
source:
  kind: github
  repository: openclaw/openclaw
scheduler:
  maxConcurrentWorkItems: 2
agent:
  teammateId: engineer
---

Review {{ item.identifier }}.

Title: {{ item.title }}
Labels: {{ item.labels }}
Head: {{ item.headSha }}
`;

test("workflow prompt rendering handles long malformed placeholders without backtracking", () => {
  const template = `${"{{".repeat(50_000)}${" ".repeat(100_000)}`;
  assert.equal(renderExternalWorkflowPrompt(template, { item: { identifier: "#1" } }), template);
});

const linearWorkflowMarkdown = `---
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

test("external WORKFLOW.md parser reads front matter and renders strict item variables", () => {
  const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
  assert.equal(workflow.config.source.kind, "github");
  assert.equal(workflow.config.source.repository, "openclaw/openclaw");
  assert.equal(workflow.config.scheduler.maxConcurrentWorkItems, 2);
  assert.equal(workflow.config.scheduler.pollIntervalMs, 30000);

  const item = normalizeGitHubExternalWorkItem({
    eventType: "pull_request.opened",
    payload: githubPullRequestPayload(),
    repositoryFullName: workflow.config.source.repository,
  });
  const prompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item });
  assert.match(prompt, /Review openclaw\/openclaw#86279/);
  assert.match(prompt, /Title: Add dependency guard/);
  assert.match(prompt, /Labels: ci, dependencies/);
  assert.match(prompt, /Head: head-sha-1/);
});

test("external WORKFLOW.md parser rejects missing source, unsupported source, missing body, and unknown variables", () => {
  assert.throws(
    () => parseExternalWorkflowMarkdown("No front matter body."),
    /source\.kind is required/,
  );
  assert.throws(
    () => parseExternalWorkflowMarkdown("---\nsource:\n  kind: jira\n  projectSlug: x\n---\nBody"),
    /Unsupported external source kind: jira/,
  );
  assert.throws(
    () => parseExternalWorkflowMarkdown("---\nsource:\n  kind: github\n  repository: openclaw\/openclaw\n---\n"),
    /prompt body is required/,
  );
  const workflow = parseExternalWorkflowMarkdown("---\nsource:\n  kind: github\n  repository: openclaw/openclaw\n---\n{{ item.missing }}");
  const item = normalizeGitHubExternalWorkItem({
    eventType: "issue.opened",
    payload: githubIssuePayload(),
    repositoryFullName: "openclaw/openclaw",
  });
  assert.throws(
    () => renderExternalWorkflowPrompt(workflow.promptTemplate, { item }),
    /Unknown workflow prompt variable: item\.missing/,
  );
});

test("external WORKFLOW.md secret ref updater writes only source.secretRef", () => {
  const updated = updateExternalWorkflowSecretRef(workflowMarkdown, "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
  assert.match(updated, /secretRef: keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN/);
  assert.match(updated, /Review \{\{ item.identifier \}\}/);
  const workflow = parseExternalWorkflowMarkdown(updated);
  assert.equal(workflow.config.source.secretRef, "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");

  assert.throws(
    () => updateExternalWorkflowSecretRef("Body only", "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN"),
    /front matter is required/,
  );
});

test("GitHub PR and issue fixtures normalize into stable external work items", () => {
  const pullRequest = normalizeGitHubExternalWorkItem({
    eventType: "pull_request.synchronize",
    payload: githubPullRequestPayload(),
    repositoryFullName: "openclaw/openclaw",
  });
  assert.equal(pullRequest.kind, "github_pull_request");
  assert.equal(pullRequest.identifier, "openclaw/openclaw#86279");
  assert.equal(pullRequest.baseSha, "base-sha-1");
  assert.equal(pullRequest.headSha, "head-sha-1");
  assert.deepEqual(pullRequest.labels, ["ci", "dependencies"]);
  assert.equal(pullRequest.idempotencyKey, "github:pull_request:openclaw/openclaw:86279:head-sha-1:2026-05-29T20:26:56Z");

  const issue = normalizeGitHubExternalWorkItem({
    eventType: "issue.opened",
    payload: githubIssuePayload(),
    repositoryFullName: "openclaw/openclaw",
  });
  assert.equal(issue.kind, "github_issue");
  assert.equal(issue.identifier, "openclaw/openclaw#42");
  assert.equal(issue.idempotencyKey, "github:issue:openclaw/openclaw:42:2026-05-29T19:00:00Z");
});

test("Linear issue fixtures normalize into stable external work items", () => {
  const workflow = parseExternalWorkflowMarkdown(linearWorkflowMarkdown);
  assert.equal(workflow.config.source.kind, "linear");
  assert.equal(workflow.config.source.projectSlug, "ling-stack");

  const issue = normalizeLinearExternalWorkItem({
    eventType: "issue.created",
    payload: linearIssuePayload(),
    projectSlug: workflow.config.source.projectSlug,
  });
  assert.equal(issue.sourceKind, "linear");
  assert.equal(issue.kind, "linear_issue");
  assert.equal(issue.identifier, "LIN-123");
  assert.equal(issue.state, "Todo");
  assert.deepEqual(issue.labels, ["external-work", "phase-7"]);
  assert.equal(issue.idempotencyKey, "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z");

  const prompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item: issue });
  assert.match(prompt, /Review LIN-123/);
  assert.match(prompt, /Title: Wire Linear external work/);
});

test("GitHub external work examples stay parseable and render for PR and issue fixtures", async () => {
  const workflow = parseExternalWorkflowMarkdown(await readExampleText("WORKFLOW.md"));
  assert.equal(workflow.config.source.kind, "github");
  assert.equal(workflow.config.source.repository, "openclaw/openclaw");
  assert.deepEqual(workflow.config.source.events, ["pull_request.opened", "pull_request.synchronize", "issue.opened"]);

  const pullRequest = normalizeGitHubExternalWorkItem({
    eventType: "pull_request.opened",
    payload: await readExampleJson("pull-request-opened.json"),
    repositoryFullName: workflow.config.source.repository,
  });
  assert.equal(pullRequest.kind, "github_pull_request");
  assert.equal(pullRequest.identifier, "openclaw/openclaw#86279");
  assert.equal(pullRequest.idempotencyKey, "github:pull_request:openclaw/openclaw:86279:head-sha-1:2026-05-29T20:26:56Z");
  const pullRequestPrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item: pullRequest });
  assert.match(pullRequestPrompt, /github_pull_request openclaw\/openclaw#86279/);
  assert.match(pullRequestPrompt, /Title: Add dependency guard/);

  const issue = normalizeGitHubExternalWorkItem({
    eventType: "issue.opened",
    payload: await readExampleJson("issue-opened.json"),
    repositoryFullName: workflow.config.source.repository,
  });
  assert.equal(issue.kind, "github_issue");
  assert.equal(issue.identifier, "openclaw/openclaw#42");
  assert.equal(issue.idempotencyKey, "github:issue:openclaw/openclaw:42:2026-05-29T19:00:00Z");
  const issuePrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item: issue });
  assert.match(issuePrompt, /github_issue openclaw\/openclaw#42/);
  assert.match(issuePrompt, /Title: Dashboard fails to load/);
});

test("sqlite external work import reuses workflow by idempotency and stores evidence artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const item = normalizeGitHubExternalWorkItem({
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      repositoryFullName: workflow.config.source.repository,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item });

    const first = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem: item,
        workflowDefinition: workflow,
        renderedPrompt,
      },
      now,
    );
    assert.equal(first.duplicate, false);
    assert.equal(first.workflow.status, "ready");
    assert.equal(first.workflowStep.status, "queued");
    assert.equal(first.workflowStep.prompt, renderedPrompt);

    const artifact = store.createArtifact({
      externalWorkId: first.externalWork.id,
      type: "json",
      path: "external-work/item.json",
      title: "Normalized external work item",
      contentType: "application/json; charset=utf-8",
      sizeBytes: 12,
      createdAt: now,
    });
    const updated = store.updateExternalWorkArtifacts(first.externalWork.id, [artifact.id], now);
    assert.deepEqual(updated.artifactIds, [artifact.id]);
    assert.deepEqual(store.listExternalWorkArtifacts(first.externalWork.id).map((item) => item.id), [artifact.id]);
    assert.equal(store.getArtifact(artifact.id).externalWorkId, first.externalWork.id);

    const second = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem: item,
        workflowDefinition: workflow,
        renderedPrompt,
      },
      "2026-05-30T00:01:00.000Z",
    );
    assert.equal(second.duplicate, true);
    assert.equal(second.workflow.id, first.workflow.id);
    assert.equal(second.workflowStep.id, first.workflowStep.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite external work actions propose, reuse, approve, and cancel with approval evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-actions-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const item = normalizeGitHubExternalWorkItem({
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      repositoryFullName: workflow.config.source.repository,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item });
    const imported = store.createOrReuseExternalWorkWorkflow({
      channelId: channel.id,
      externalWorkItem: item,
      workflowDefinition: workflow,
      renderedPrompt,
    }, now);

    const proposed = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_comment",
        payload: { type: "github_comment", body: "Looks ready for review." },
        approvalRequirement: "strict",
      },
      now,
    });
    assert.equal(proposed.duplicate, false);
    assert.equal(proposed.action.status, "waiting_for_approval");
    assert.equal(proposed.action.actionKind, "github_comment");
    assert.equal(proposed.action.target.repository, "openclaw/openclaw");
    assert.equal(proposed.action.target.number, 86279);
    assert.equal(proposed.action.target.expectedHeadSha, "head-sha-1");
    assert.equal(proposed.approval.externalWorkActionId, proposed.action.id);
    assert.equal(proposed.approval.risk, "high");
    assert.equal(proposed.artifacts.length, 3);
    assert.equal(store.listApprovalRequests({ externalWorkActionId: proposed.action.id }).length, 1);
    const preview = await readFile(resolve(store.paths.artifactsDir, proposed.artifacts[2].path), "utf8");
    assert.match(preview, /Looks ready for review/);

    const duplicate = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_comment",
        payload: { type: "github_comment", body: "Looks ready for review." },
        approvalRequirement: "strict",
      },
      now: "2026-05-30T00:01:00.000Z",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.action.id, proposed.action.id);
    assert.equal(store.listExternalWorkActions({ externalWorkId: imported.externalWork.id }).length, 1);

    const approved = store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:02:00.000Z");
    const synced = syncExternalWorkActionForApproval(store, approved, "2026-05-30T00:02:00.000Z");
    assert.equal(synced.status, "approved");

    const review = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_pr_review",
        payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix the failing CI before merge." },
      },
      now: "2026-05-30T00:02:30.000Z",
    });
    assert.equal(review.action.actionKind, "github_pr_review");
    assert.equal(review.action.approvalRequirement, "strict");
    assert.equal(review.approval.risk, "high");
    const reviewPreview = await readFile(resolve(store.paths.artifactsDir, review.artifacts[2].path), "utf8");
    assert.match(reviewPreview, /Review event: REQUEST_CHANGES/);
    assert.match(reviewPreview, /Please fix the failing CI/);

    assert.throws(
      () => proposeExternalWorkAction({
        store,
        request: {
          externalWorkId: imported.externalWork.id,
          actionKind: "github_pr_review",
          approvalRequirement: "standard",
          payload: { type: "github_pr_review", event: "COMMENT", body: "Standard review should fail." },
        },
        now: "2026-05-30T00:02:45.000Z",
      }),
      /require strict approval/,
    );

    const issueImport = createImportedIssueWork(store, cwd, "2026-05-30T00:02:50.000Z");
    assert.throws(
      () => proposeExternalWorkAction({
        store,
        request: {
          externalWorkId: issueImport.externalWork.id,
          actionKind: "github_pr_review",
          payload: { type: "github_pr_review", event: "COMMENT", body: "Issue target should fail." },
        },
        now: "2026-05-30T00:02:55.000Z",
      }),
      /require github_pull_request/,
    );

    const label = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_label",
        payload: { type: "github_label", labels: ["agent-ready", "needs-review"] },
      },
      now: "2026-05-30T00:03:00.000Z",
    });
    assert.equal(label.action.approvalRequirement, "standard");
    const cancelled = cancelExternalWorkAction({
      store,
      actionId: label.action.id,
      request: { reason: "No longer needed." },
      now: "2026-05-30T00:04:00.000Z",
    });
    assert.equal(cancelled.action.status, "cancelled");
    assert.equal(cancelled.approval.status, "denied");
    assert.equal(cancelled.artifacts.at(-1).title, "External action cancellation");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite external work route updates local queue ownership without external mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-route-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const sourceChannel = store.createChannel({ name: "GitHub intake", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const targetChannel = store.createChannel({ name: "Runtime board", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const item = normalizeGitHubExternalWorkItem({
      eventType: "pull_request.opened",
      payload: githubPullRequestPayload(),
      repositoryFullName: workflow.config.source.repository,
    });
    const imported = store.createOrReuseExternalWorkWorkflow({
      channelId: sourceChannel.id,
      externalWorkItem: item,
      workflowDefinition: workflow,
      renderedPrompt: renderExternalWorkflowPrompt(workflow.promptTemplate, { item }),
    }, now);
    store.upsertExternalWorkSchedulerState({
      externalWorkId: imported.externalWork.id,
      channelId: sourceChannel.id,
      subjectKey: "github:openclaw/openclaw#86279",
      sourceKey: "github:openclaw/openclaw",
      workflowId: imported.workflow.id,
      workflowStepId: imported.workflowStep.id,
      schedulerStatus: "ready",
      maxRetryBackoffMs: 300000,
    }, now);
    const proposed = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_comment",
        payload: { type: "github_comment", body: "Route test." },
      },
      now,
    });

    const routed = store.routeExternalWorkRecord(imported.externalWork.id, { channelId: targetChannel.id, priority: 7 }, "2026-05-30T00:01:00.000Z");
    assert.equal(routed.channelId, targetChannel.id);
    assert.equal(routed.item.priority, 7);
    assert.equal(store.getExternalWorkSchedulerState(imported.externalWork.id).channelId, targetChannel.id);
    assert.equal(store.getExternalWorkAction(proposed.action.id).channelId, targetChannel.id);
    assert.equal(store.listExternalWorkRecords({ channelId: sourceChannel.id }).length, 0);
    assert.equal(store.listExternalWorkRecords({ channelId: targetChannel.id }).length, 1);
    assert.equal(store.listExternalWorkActions({ channelId: targetChannel.id }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external action execution requires approval, revalidates, mutates only allowed endpoints, and redacts token evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-action-execute-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const calls = [];
  try {
    const imported = createImportedPullRequestWork(store, cwd, now);
    const proposed = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_comment",
        payload: { type: "github_comment", body: "Ready for maintainer review." },
      },
      now,
    });

    await assert.rejects(
      () => executeExternalWorkAction({
        store,
        actionId: proposed.action.id,
        githubToken: "github-token-secret",
        fetch: createGitHubActionFetch(calls),
        now: "2026-05-30T00:01:00.000Z",
      }),
      /not approved/,
    );
    assert.equal(calls.length, 0);

    const approved = store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:02:00.000Z");
    syncExternalWorkActionForApproval(store, approved, "2026-05-30T00:02:00.000Z");
    const executed = await executeExternalWorkAction({
      store,
      actionId: proposed.action.id,
      githubToken: "github-token-secret",
      fetch: createGitHubActionFetch(calls),
      now: "2026-05-30T00:03:00.000Z",
    });

    assert.equal(executed.action.status, "succeeded");
    assert.equal(executed.action.executionAttemptCount, 1);
    assert.equal(executed.action.executedAt, "2026-05-30T00:03:00.000Z");
    assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
      "POST /repos/openclaw/openclaw/issues/86279/comments",
    ]);
    assert.doesNotMatch(JSON.stringify(executed.artifacts), /github-token-secret/);
    const executionArtifact = executed.artifacts.find((artifact) => artifact.title === "External action execution result");
    assert.ok(executionArtifact);
    const executionEvidence = await readFile(resolve(store.paths.artifactsDir, executionArtifact.path), "utf8");
    assert.doesNotMatch(executionEvidence, /github-token-secret/);
    assert.match(executionEvidence, /\[REDACTED\]/);
    assert.match(executionEvidence, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/86279#issuecomment-1/);

    const label = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_label",
        payload: { type: "github_label", labels: ["agent-ready"] },
      },
      now: "2026-05-30T00:04:00.000Z",
    });
    const labelApproved = store.approveApprovalRequest(label.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:05:00.000Z");
    syncExternalWorkActionForApproval(store, labelApproved, "2026-05-30T00:05:00.000Z");
    const labelExecuted = await executeExternalWorkAction({
      store,
      actionId: label.action.id,
      fetch: createGitHubActionFetch(calls),
      now: "2026-05-30T00:06:00.000Z",
    });
    assert.equal(labelExecuted.action.status, "succeeded");
    assert.equal(calls.at(-1).init.method, "POST");
    assert.equal(new URL(calls.at(-1).url).pathname, "/repos/openclaw/openclaw/issues/86279/labels");

    const review = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_pr_review",
        payload: { type: "github_pr_review", event: "COMMENT", body: "Review body from Ling." },
      },
      now: "2026-05-30T00:07:00.000Z",
    });
    const reviewApproved = store.approveApprovalRequest(review.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:08:00.000Z");
    syncExternalWorkActionForApproval(store, reviewApproved, "2026-05-30T00:08:00.000Z");
    const reviewExecuted = await executeExternalWorkAction({
      store,
      actionId: review.action.id,
      fetch: createGitHubActionFetch(calls),
      now: "2026-05-30T00:09:00.000Z",
    });
    assert.equal(reviewExecuted.action.status, "succeeded");
    assert.deepEqual(calls.slice(-2).map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
      "POST /repos/openclaw/openclaw/pulls/86279/reviews",
    ]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("B003 cancel wins while GitHub GET is withheld and late execution cannot send or overwrite cancellation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-b003-cancel-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let execution;
  try {
    const imported = createImportedPullRequestWork(store, cwd, now);
    const proposed = proposeExternalWorkAction({
      store,
      request: { externalWorkId: imported.externalWork.id, actionKind: "github_comment", payload: { type: "github_comment", body: "Cancellation race." } },
      now,
    });
    const approved = store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, now);
    syncExternalWorkActionForApproval(store, approved, now);
    const delegate = createGitHubActionFetch(calls);
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          entered.resolve();
          await release.promise;
        }
        return delegate(url, init);
      },
    });
    await entered.promise;
    const cancelled = cancelExternalWorkAction({ store, actionId: proposed.action.id, now });
    assert.equal(cancelled.action.status, "cancelled");
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "cancelled");
    release.resolve();
    const result = await execution;
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    assert.equal(result.action.status, "cancelled");
    assert.equal(result.dispatchState, "not_sent");
    assert.equal(result.executionSettled, true);
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "cancelled");
    assert.deepEqual(result.action.artifactIds, cancelled.action.artifactIds);
  } finally {
    release.resolve();
    await execution?.catch(() => {});
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const outcome of ["stale", "missing", "no-op", "throw"]) {
  test(`B003 cancelled action rejects late GET ${outcome} without new evidence`, async () => {
    const fixture = await createB003Fixture(outcome === "no-op" ? { type: "github_label", labels: ["ci"] } : undefined);
    const { store, now, proposed } = fixture;
    const calls = [];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const delegate = createGitHubActionFetch(calls, outcome === "stale" ? {
      pullRequest: { ...githubPullRequestPayload().pull_request, head: { sha: "changed-head" } },
    } : {});
    let execution;
    try {
      execution = executeExternalWorkAction({
        store, actionId: proposed.action.id, now,
        fetch: async (url, init) => {
          if (init?.method === "GET") {
            entered.resolve();
            await release.promise;
            if (outcome === "throw") throw new Error("Offline GET failure");
            if (outcome === "missing") { calls.push({ url, init }); return jsonResponse({}, { ok: false, status: 404 }); }
          }
          return delegate(url, init);
        },
      });
      await entered.promise;
      const cancelled = cancelExternalWorkAction({ store, actionId: proposed.action.id, now });
      const artifactCount = store.listExternalWorkArtifacts(fixture.imported.externalWork.id).length;
      release.resolve();
      const result = await execution;
      assert.equal(result.action.status, "cancelled");
      assert.equal(result.dispatchState, "not_sent");
      assert.equal(result.executionSettled, true);
      assert.deepEqual(result.action.artifactIds, cancelled.action.artifactIds);
      assert.equal(store.listExternalWorkArtifacts(fixture.imported.externalWork.id).length, artifactCount);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    } finally {
      release.resolve();
      await execution?.catch(() => {});
      await fixture.close();
    }
  });
}

test("B003 dispatch wins cancellation; approval sync and second execution cannot reopen executing action", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed, approved } = fixture;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => {
        const result = await delegate(url, init);
        if (init?.method === "POST") { entered.resolve(); await release.promise; }
        return result;
      },
    });
    await entered.promise;
    const executing = store.getExternalWorkAction(proposed.action.id);
    assert.equal(executing.status, "executing");
    assert.throws(() => cancelExternalWorkAction({ store, actionId: proposed.action.id, now }), /cannot be cancelled from status: executing/);
    const before = store.listExternalWorkArtifacts(fixture.imported.externalWork.id).length;
    assert.equal(syncExternalWorkActionForApproval(store, approved, now).status, "executing");
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: delegate }), /cannot execute from status: executing/);
    assert.equal(store.listExternalWorkArtifacts(fixture.imported.externalWork.id).length, before);
    assert.equal(store.listResourceLeases({ status: "active", resourceType: "external_subject" }).length, 1);
    release.resolve();
    const result = await execution;
    assert.equal(result.action.status, "succeeded");
    assert.equal(result.dispatchState, "effect_confirmed");
    assert.equal(result.executionSettled, true);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { release.resolve(); await execution?.catch(() => {}); await fixture.close(); }
});

test("B003 simultaneous execution during GET is blocked without releasing the first exact lease", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => { if (init?.method === "GET") { entered.resolve(); await release.promise; } return delegate(url, init); },
    });
    await entered.promise;
    const lease = store.listResourceLeases({ status: "active", resourceType: "external_subject" })[0];
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: delegate }), /External subject is locked/);
    assert.equal(store.getBlockingResourceLease(lease.resourceType, lease.resourceKey).id, lease.id);
    release.resolve();
    assert.equal((await execution).action.status, "succeeded");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { release.resolve(); await execution?.catch(() => {}); await fixture.close(); }
});

for (const change of ["released", "expired"]) {
  test(`B003 ${change} lease during GET cannot authorize dispatch or release a same-owner successor`, async () => {
    const fixture = await createB003Fixture();
    const { store, now, proposed } = fixture;
    const calls = [];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const delegate = createGitHubActionFetch(calls);
    let execution;
    try {
      execution = executeExternalWorkAction({
        store, actionId: proposed.action.id, now,
        fetch: async (url, init) => { if (init?.method === "GET") { entered.resolve(); await release.promise; } return delegate(url, init); },
      });
      await entered.promise;
      const lease = store.listResourceLeases({ status: "active", resourceType: "external_subject" })[0];
      if (change === "released") store.releaseResourceLease(lease.id, lease.ownerType, lease.ownerId, now);
      else store.expireResourceLeases("2026-05-30T00:06:00.000Z");
      const successor = store.acquireResourceLease({ ...lease, acquiredAt: now, expiresAt: "2026-05-30T00:30:00.000Z" });
      assert.ok(successor);
      release.resolve();
      const result = await execution;
      assert.equal(result.dispatchState, "not_sent");
      assert.equal(result.executionSettled, false);
      assert.equal(result.action.status, "approved");
      assert.equal(result.action.executionAttemptCount, 0);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
      assert.equal(store.getBlockingResourceLease(lease.resourceType, lease.resourceKey).id, successor.id);
      assert.deepEqual(result.action.artifactIds, proposed.action.artifactIds);
    } finally { release.resolve(); await execution?.catch(() => {}); await fixture.close(); }
  });
}

test("B003 production clock rechecks lease expiry at dispatch, not only before the HTTP await", async (t) => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id,
      fetch: async (url, init) => { if (init?.method === "GET") { entered.resolve(); await release.promise; } return delegate(url, init); },
    });
    await entered.promise;
    t.mock.timers.tick(5 * 60 * 1000 + 1);
    release.resolve();
    const result = await execution;
    assert.equal(result.action.status, "approved");
    assert.equal(result.dispatchState, "not_sent");
    assert.equal(result.executionSettled, false);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
  } finally { release.resolve(); await execution?.catch(() => {}); t.mock.timers.reset(); await fixture.close(); }
});

test("B003 POST transport failure is effect-unconfirmed, redacted and cannot be automatically replayed", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  const delegate = createGitHubActionFetch(calls);
  try {
    const result = await executeExternalWorkAction({
      store, actionId: proposed.action.id, now, githubToken: "b003-private-token",
      fetch: async (url, init) => { const response = await delegate(url, init); if (init?.method === "POST") throw new Error("Lost remote response b003-private-token"); return response; },
    });
    assert.equal(result.action.status, "failed");
    assert.equal(result.action.lastErrorCode, "external_action_effect_unconfirmed");
    assert.equal(result.dispatchState, "effect_unconfirmed");
    assert.equal(result.executionSettled, true);
    assert.doesNotMatch(JSON.stringify(result), /b003-private-token/);
    const failure = result.artifacts.find((artifact) => artifact.title === "External action execution failure");
    const evidence = await readFile(resolve(store.paths.artifactsDir, failure.path), "utf8");
    assert.match(evidence, /effect_unconfirmed/);
    assert.doesNotMatch(evidence, /b003-private-token/);
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: delegate }), /cannot execute from status: failed/);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { await fixture.close(); }
});

test("B003 lost lease after POST retains unconfirmed executing state without stale evidence or successor release", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => { const result = await delegate(url, init); if (init?.method === "POST") { entered.resolve(); await release.promise; } return result; },
    });
    await entered.promise;
    const lease = store.listResourceLeases({ status: "active", resourceType: "external_subject" })[0];
    store.releaseResourceLease(lease.id, lease.ownerType, lease.ownerId, now);
    const successor = store.acquireResourceLease({ ...lease, acquiredAt: now, expiresAt: "2026-05-30T00:30:00.000Z" });
    assert.ok(successor);
    release.resolve();
    const result = await execution;
    assert.equal(result.action.status, "executing");
    assert.equal(result.dispatchState, "effect_unconfirmed");
    assert.equal(result.executionSettled, false);
    assert.deepEqual(result.action.artifactIds, proposed.action.artifactIds);
    assert.equal(store.getBlockingResourceLease(lease.resourceType, lease.resourceKey).id, successor.id);
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: delegate }), /cannot execute from status: executing/);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { release.resolve(); await execution?.catch(() => {}); await fixture.close(); }
});

test("B003 separate SQLite connection cancellation wins an in-flight GET", async () => {
  const fixture = await createB003Fixture();
  const { store, cwd, now, proposed } = fixture;
  const second = createSqliteRunStore(cwd);
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => { if (init?.method === "GET") { entered.resolve(); await release.promise; } return delegate(url, init); },
    });
    await entered.promise;
    assert.equal(cancelExternalWorkAction({ store: second, actionId: proposed.action.id, now }).action.status, "cancelled");
    release.resolve();
    const result = await execution;
    assert.equal(result.action.status, "cancelled");
    assert.equal(result.executionSettled, true);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    assert.equal(second.getExternalWorkAction(proposed.action.id).status, "cancelled");
  } finally { release.resolve(); await execution?.catch(() => {}); second.close(); await fixture.close(); }
});

test("B003 cancellation CAS rejects a stale read after separate-connection dispatch commits", async () => {
  const fixture = await createB003Fixture();
  const { store, cwd, now, proposed, imported } = fixture;
  const second = createSqliteRunStore(cwd);
  let intercepted = false;
  try {
    const lease = second.acquireResourceLease({ workspaceId: proposed.action.workspaceId, ownerType: "system", ownerId: "b003-independent-executor", resourceType: "external_subject", resourceKey: imported.externalWork.item.id, acquiredAt: now, expiresAt: "2026-05-30T00:05:00.000Z" });
    assert.ok(lease);
    const staleReadStore = new Proxy(store, {
      get(target, key) {
        if (key === "getExternalWorkAction") return (id) => {
          const snapshot = target.getExternalWorkAction(id);
          if (!intercepted) {
            intercepted = true;
            const executing = second.commitExternalWorkActionTransition({
              actionId: id, expectedStatus: snapshot.status, expectedExecutionAttemptCount: snapshot.executionAttemptCount,
              expectedApprovalId: snapshot.approvalId, approvalStatus: "approved",
              subjectLease: { id: lease.id, ownerId: lease.ownerId, resourceKey: lease.resourceKey },
              update: { status: "executing", executionAttemptCount: 1 },
            }, now);
            assert.equal(executing.status, "executing");
          }
          return snapshot;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const count = store.listExternalWorkArtifacts(imported.externalWork.id).length;
    assert.throws(() => cancelExternalWorkAction({ store: staleReadStore, actionId: proposed.action.id, now }), /changed before cancellation/);
    assert.equal(second.getExternalWorkAction(proposed.action.id).status, "executing");
    assert.equal(store.getApprovalRequest(proposed.approval.id).status, "approved");
    assert.equal(store.listExternalWorkArtifacts(imported.externalWork.id).length, count);
  } finally { second.close(); await fixture.close(); }
});

test("B003 foreign approval identity during GET rejects dispatch and stale approval sync", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed, imported, approved } = fixture;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delegate = createGitHubActionFetch(calls);
  let execution;
  try {
    execution = executeExternalWorkAction({
      store, actionId: proposed.action.id, now,
      fetch: async (url, init) => { if (init?.method === "GET") { entered.resolve(); await release.promise; } return delegate(url, init); },
    });
    await entered.promise;
    const other = proposeExternalWorkAction({ store, request: { externalWorkId: imported.externalWork.id, actionKind: "github_label", payload: { type: "github_label", labels: ["other-action"] } }, now });
    const otherApproved = store.approveApprovalRequest(other.approval.id, { resolvedBy: "local-user" }, now);
    syncExternalWorkActionForApproval(store, otherApproved, now);
    store.updateExternalWorkAction(proposed.action.id, { approvalId: other.approval.id }, now);
    assert.equal(syncExternalWorkActionForApproval(store, approved, now).approvalId, other.approval.id);
    release.resolve();
    const result = await execution;
    assert.equal(result.action.status, "approved");
    assert.equal(result.dispatchState, "not_sent");
    assert.equal(result.executionSettled, false);
    assert.deepEqual(result.action.artifactIds, proposed.action.artifactIds);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: delegate }), /does not belong/);
  } finally { release.resolve(); await execution?.catch(() => {}); await fixture.close(); }
});

test("B003 cancellation evidence failure atomically rolls back pending approval denial and action", async () => {
  const fixture = await createB003Fixture(undefined, false);
  const { store, now, proposed, imported } = fixture;
  try {
    const artifactCount = store.listExternalWorkArtifacts(imported.externalWork.id).length;
    const failingStore = new Proxy(store, { get(target, key) {
      if (key === "createArtifact") return () => { throw new Error("Isolated cancellation evidence persistence failure"); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.throws(() => cancelExternalWorkAction({ store: failingStore, actionId: proposed.action.id, now }), /evidence persistence failure/);
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "waiting_for_approval");
    assert.equal(store.getApprovalRequest(proposed.approval.id).status, "pending");
    assert.equal(store.listExternalWorkArtifacts(imported.externalWork.id).length, artifactCount);
    const cancelled = cancelExternalWorkAction({ store, actionId: proposed.action.id, now });
    assert.equal(cancelled.action.status, "cancelled");
    assert.equal(cancelled.approval.status, "denied");
  } finally { await fixture.close(); }
});

test("B003 post-send success evidence persistence failure is not reported as zero effect", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  let failedOnce = false;
  try {
    const failingStore = new Proxy(store, { get(target, key) {
      if (key === "createArtifact") return (input) => {
        if (!failedOnce && input.title === "External action execution result") { failedOnce = true; throw new Error("Isolated result persistence failure"); }
        return target.createArtifact(input);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeExternalWorkAction({ store: failingStore, actionId: proposed.action.id, now, fetch: createGitHubActionFetch(calls) });
    assert.equal(result.action.status, "failed");
    assert.equal(result.action.lastErrorCode, "external_action_effect_unconfirmed");
    assert.equal(result.dispatchState, "effect_unconfirmed");
    assert.equal(result.executionSettled, true);
    assert.equal(result.artifacts.filter((artifact) => artifact.title === "External action execution result").length, 0);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { await fixture.close(); }
});

test("B003 approved label no-op settles without claiming a POST was sent", async () => {
  const fixture = await createB003Fixture({ type: "github_label", labels: ["ci"] });
  const calls = [];
  try {
    const result = await executeExternalWorkAction({ store: fixture.store, actionId: fixture.proposed.action.id, now: fixture.now, fetch: createGitHubActionFetch(calls) });
    assert.equal(result.action.status, "succeeded");
    assert.equal(result.dispatchState, "not_sent");
    assert.equal(result.executionSettled, true);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 0);
    assert.ok(result.artifacts.some((artifact) => artifact.title === "External action already satisfied"));
  } finally { await fixture.close(); }
});

test("B003 total post-send evidence persistence outage throws typed unconfirmed error without leaking raw secrets", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  try {
    const failingStore = new Proxy(store, { get(target, key) {
      if (key === "createArtifact") return () => { throw new Error("Raw persistence detail b003-private-token"); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(() => executeExternalWorkAction({ store: failingStore, actionId: proposed.action.id, now, githubToken: "b003-private-token", fetch: createGitHubActionFetch(calls) }), (error) => {
      assert.ok(error instanceof ExternalWorkActionExecutionError);
      assert.equal(error.code, "external_action_effect_unconfirmed");
      assert.equal(error.dispatchState, "effect_unconfirmed");
      assert.doesNotMatch(String(error), /b003-private-token|Raw persistence detail/);
      return true;
    });
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "executing");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: createGitHubActionFetch(calls) }), /cannot execute from status: executing/);
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { await fixture.close(); }
});

for (const noop of [false, true]) {
  test(`B003 exact lease cleanup failure preserves ${noop ? "no-op without send" : "confirmed mutation"} outcome`, async () => {
    const fixture = await createB003Fixture(noop ? { type: "github_label", labels: ["ci"] } : undefined);
    const { store, now, proposed } = fixture;
    const calls = [];
    try {
      const failingStore = new Proxy(store, { get(target, key) {
        if (key === "releaseResourceLease") return () => { throw new Error("Raw cleanup detail b003-private-token"); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      await assert.rejects(() => executeExternalWorkAction({ store: failingStore, actionId: proposed.action.id, now, fetch: createGitHubActionFetch(calls) }), (error) => {
        assert.ok(error instanceof ExternalWorkActionExecutionError);
        assert.equal(error.code, "external_action_cleanup_failed");
        assert.equal(error.dispatchState, noop ? "not_sent" : "effect_confirmed");
        assert.doesNotMatch(String(error), /b003-private-token|Raw cleanup detail|final state could not be persisted/);
        return true;
      });
      assert.equal(store.getExternalWorkAction(proposed.action.id).status, "succeeded");
      assert.equal(calls.filter((call) => call.init.method === "POST").length, noop ? 0 : 1);
      await assert.rejects(() => executeExternalWorkAction({ store, actionId: proposed.action.id, now, fetch: createGitHubActionFetch(calls) }), /cannot execute from status: succeeded/);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, noop ? 0 : 1);
    } finally { await fixture.close(); }
  });
}

test("B003 total post-send persistence and cleanup outage cannot replace the original unconfirmed send boundary", async () => {
  const fixture = await createB003Fixture();
  const { store, now, proposed } = fixture;
  const calls = [];
  try {
    const failingStore = new Proxy(store, { get(target, key) {
      if (key === "createArtifact" || key === "releaseResourceLease") return () => { throw new Error("Raw outage detail b003-private-token"); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(() => executeExternalWorkAction({ store: failingStore, actionId: proposed.action.id, now, fetch: createGitHubActionFetch(calls) }), (error) => {
      assert.ok(error instanceof ExternalWorkActionExecutionError);
      assert.equal(error.code, "external_action_effect_unconfirmed");
      assert.equal(error.dispatchState, "effect_unconfirmed");
      assert.doesNotMatch(String(error), /Raw outage detail|b003-private-token/);
      return true;
    });
    assert.equal(store.getExternalWorkAction(proposed.action.id).status, "executing");
    assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  } finally { await fixture.close(); }
});

test("GitHub external action execution marks stale target before mutation when PR head changes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-action-stale-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const calls = [];
  try {
    const imported = createImportedPullRequestWork(store, cwd, now);
    const proposed = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_comment",
        payload: { type: "github_comment", body: "Ready for maintainer review." },
      },
      now,
    });
    const approved = store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:01:00.000Z");
    syncExternalWorkActionForApproval(store, approved, "2026-05-30T00:01:00.000Z");

    const stale = await executeExternalWorkAction({
      store,
      actionId: proposed.action.id,
      fetch: createGitHubActionFetch(calls, {
        pullRequest: {
          ...githubPullRequestPayload().pull_request,
          head: { ...githubPullRequestPayload().pull_request.head, sha: "head-sha-2" },
        },
      }),
      now: "2026-05-30T00:02:00.000Z",
    });

    assert.equal(stale.action.status, "stale_target");
    assert.match(stale.action.lastErrorMessage, /head SHA changed/);
    assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
    ]);
    const staleArtifact = stale.artifacts.find((artifact) => artifact.title === "External action stale target");
    assert.ok(staleArtifact);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external action execution marks stale target before mutation when issue state or update time changes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-action-issue-stale-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const calls = [];
  try {
    const imported = createImportedIssueWork(store, cwd, now);
    const proposed = proposeExternalWorkAction({
      store,
      request: {
        externalWorkId: imported.externalWork.id,
        actionKind: "github_label",
        payload: { type: "github_label", labels: ["needs-triage"] },
      },
      now,
    });
    const approved = store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, "2026-05-30T00:01:00.000Z");
    syncExternalWorkActionForApproval(store, approved, "2026-05-30T00:01:00.000Z");

    const stale = await executeExternalWorkAction({
      store,
      actionId: proposed.action.id,
      fetch: createGitHubActionFetch(calls, {
        issue: {
          ...githubIssuePayload().issue,
          state: "closed",
          updated_at: "2026-05-30T00:02:00Z",
        },
      }),
      now: "2026-05-30T00:02:00.000Z",
    });

    assert.equal(stale.action.status, "stale_target");
    assert.match(stale.action.lastErrorMessage, /state changed/);
    assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/issues/42",
    ]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external action adapter calls only explicit action mutation endpoints", async () => {
  const calls = [];
  const adapter = createGitHubExternalActionAdapter({ fetch: createGitHubActionFetch(calls) });
  await adapter.createIssueComment({
    repository: "openclaw/openclaw",
    number: 86279,
    body: "Ready",
    token: "github-token-secret",
  });
  await adapter.addIssueLabels({
    repository: "openclaw/openclaw",
    number: 86279,
    labels: ["agent-ready"],
    token: "github-token-secret",
  });
  await adapter.createPullRequestReview({
    repository: "openclaw/openclaw",
    number: 86279,
    event: "APPROVE",
    body: "Approved by Ling.",
    token: "github-token-secret",
  });

  assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
    "POST /repos/openclaw/openclaw/issues/86279/comments",
    "POST /repos/openclaw/openclaw/issues/86279/labels",
    "POST /repos/openclaw/openclaw/pulls/86279/reviews",
  ]);
});

test("GitHub read-only adapter loads PRs and standalone issues without double-importing PR-shaped issues", async () => {
  const calls = [];
  const adapter = createGitHubExternalWorkAdapter({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/pulls?")) {
        return jsonResponse([githubPullRequestPayload().pull_request]);
      }
      if (url.includes("/issues?")) {
        return jsonResponse([
          githubIssuePayload().issue,
          { ...githubIssuePayload().issue, number: 43, pull_request: { url: "https://api.github.test/pulls/43" } },
        ]);
      }
      return jsonResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" });
    },
  });

  const items = await adapter.loadCandidates({
    repository: "openclaw/openclaw",
    events: ["pull_request.opened", "issue.opened"],
    activeStates: ["open"],
    token: "github-token",
    limit: 10,
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.kind), ["github_pull_request", "github_issue"]);
  assert.equal(items[0].identifier, "openclaw/openclaw#86279");
  assert.equal(items[1].identifier, "openclaw/openclaw#42");
  assert.match(calls[0].init.headers.Authorization, /Bearer github-token/);
});

test("Linear read-only adapter loads project issues through GraphQL", async () => {
  const calls = [];
  const adapter = createLinearExternalWorkAdapter({
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, "POST");
      return jsonResponse({
        data: {
          issues: {
            nodes: [
              linearIssuePayload(),
              linearIssuePayload({
                id: "linear-issue-other",
                identifier: "OTHER-1",
                project: { name: "Other", slug: "other" },
              }),
            ],
          },
        },
      });
    },
  });

  const items = await adapter.loadCandidates({
    repository: "ling-stack",
    events: ["issue.created"],
    activeStates: ["Todo"],
    token: "linear-token",
    limit: 10,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "linear_issue");
  assert.equal(items[0].identifier, "LIN-123");
  assert.match(calls[0].init.headers.Authorization, /Bearer linear-token/);
  assert.match(JSON.parse(calls[0].init.body).query, /issues/);
});

test("GitHub external work poll creates scheduler state and blocks active subject duplicates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-poll-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const fetch = createGitHubPollFetch(() => [githubPullRequestPayload().pull_request], () => []);

    const first = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      fetch,
      now: "2026-05-30T00:00:00.000Z",
    });
    assert.equal(first.candidates, 1);
    assert.equal(first.claimed, 1);
    assert.equal(first.artifacts.length, 2);
    assert.equal(first.schedulerStates[0].schedulerStatus, "ready");
    assert.ok(first.schedulerStates[0].workspacePath.includes(".ling-stack"));
    assert.equal(store.listChannelWorkflows({ channelId: channel.id }).length, 1);
    assert.equal(store.listExternalWorkRecords({ channelId: channel.id }).length, 1);
    assert.equal(store.listExternalWorkRecords({ schedulerStatus: "ready" }).length, 1);
    assert.equal(store.listExternalWorkRecords({ workItemKind: "github_pull_request" })[0].identifier, "openclaw/openclaw#86279");
    assert.equal(store.listExternalWorkRecords({ schedulerStatus: "terminal" }).length, 0);

    const duplicate = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      fetch,
      now: "2026-05-30T00:01:00.000Z",
    });
    assert.equal(duplicate.duplicates, 1);
    assert.equal(store.listChannelWorkflows({ channelId: channel.id }).length, 1);

    const changedHeadFetch = createGitHubPollFetch(() => [{
      ...githubPullRequestPayload().pull_request,
      updated_at: "2026-05-30T00:02:00Z",
      head: { ...githubPullRequestPayload().pull_request.head, sha: "head-sha-2" },
    }], () => []);
    const blocked = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      fetch: changedHeadFetch,
      now: "2026-05-30T00:02:00.000Z",
    });
    assert.equal(blocked.blocked, 1);
    assert.match(blocked.results[0].message, /another idempotency key/);
    assert.equal(store.listChannelWorkflows({ channelId: channel.id }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Linear external work poll creates scheduler state with the shared workflow pipeline", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-linear-external-work-poll-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Linear", boundPath: cwd, defaultTeammateId: "engineer" }, "2026-06-01T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(linearWorkflowMarkdown);
    const result = await pollLinearExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      linearToken: "linear-token-secret",
      fetch: async () => jsonResponse({ data: { issues: { nodes: [linearIssuePayload()] } } }),
      now: "2026-06-01T00:00:00.000Z",
    });

    assert.equal(result.candidates, 1);
    assert.equal(result.claimed, 1);
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.schedulerStates[0].schedulerStatus, "ready");
    assert.match(result.schedulerStates[0].workspacePath, /external-workspaces\/linear/);
    assert.equal(store.listExternalWorkRecords({ sourceKind: "linear" }).length, 1);
    assert.equal(store.listExternalWorkRecords({ workItemKind: "linear_issue" })[0].identifier, "LIN-123");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work poll runs workspace hooks as redacted evidence artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-hooks-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(`---
source:
  kind: github
  repository: openclaw/openclaw
  events:
    - pull_request.opened
hooks:
  beforeRun: 'printf "github-token-secret"'
  timeoutMs: 5000
---

Review {{ item.identifier }}.
`);
    const result = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      fetch: createGitHubPollFetch(() => [githubPullRequestPayload().pull_request], () => []),
      githubToken: "github-token-secret",
      executeHooks: true,
      now: "2026-05-30T00:00:00.000Z",
    });

    assert.equal(result.claimed, 1);
    const hookArtifact = result.artifacts.find((artifact) => artifact.title === "External work hook: beforeRun");
    assert.ok(hookArtifact);
    const content = await readFile(resolve(store.paths.artifactsDir, hookArtifact.path), "utf8");
    assert.doesNotMatch(content, /github-token-secret/);
    assert.match(content, /\[REDACTED\]/);
    assert.deepEqual(store.getExternalWorkSchedulerState(result.schedulerStates[0].externalWorkId).hookArtifactIds, [hookArtifact.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub external work poll records failed hook evidence and schedules capped retry", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-hook-fail-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(`---
source:
  kind: github
  repository: openclaw/openclaw
  events:
    - pull_request.opened
scheduler:
  maxRetryBackoffMs: 1000
hooks:
  beforeRun: 'printf "github-token-secret"; exit 7'
  timeoutMs: 5000
---

Review {{ item.identifier }}.
`);
    const result = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: channel.id,
      workflowDefinition: workflow,
      workflowDirectory: cwd,
      fetch: createGitHubPollFetch(() => [githubPullRequestPayload().pull_request], () => []),
      githubToken: "github-token-secret",
      executeHooks: true,
      now: "2026-05-30T00:00:00.000Z",
    });

    assert.equal(result.retryScheduled, 1);
    assert.equal(result.schedulerStates[0].schedulerStatus, "retry_wait");
    assert.equal(result.schedulerStates[0].nextAttemptAt, "2026-05-30T00:00:01.000Z");
    const hookArtifact = result.artifacts.find((artifact) => artifact.title === "External work hook: beforeRun");
    assert.ok(hookArtifact);
    assert.deepEqual(result.schedulerStates[0].hookArtifactIds, [hookArtifact.id]);
    const content = await readFile(resolve(store.paths.artifactsDir, hookArtifact.path), "utf8");
    assert.doesNotMatch(content, /github-token-secret/);
    assert.match(content, /exitCode/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub CI triage adapter reads PR checks, workflow jobs, and redacted logs", async () => {
  const calls = [];
  const adapter = createGitHubCiTriageAdapter({ fetch: createGitHubCiFetch(calls) });

  const current = await adapter.getPullRequest({
    repository: "openclaw/openclaw",
    number: 86279,
    token: "github-token-secret",
  });
  assert.equal(current.identifier, "openclaw/openclaw#86279");
  assert.equal(current.headSha, "head-sha-1");

  const failures = await adapter.listFailures({
    repository: "openclaw/openclaw",
    subjectNumber: 86279,
    headSha: "head-sha-1",
    token: "github-token-secret",
    limit: 5,
  });

  assert.deepEqual(failures.map((failure) => failure.checkName), ["web e2e", "lint"]);
  assert.equal(failures[0].workflowName, "CI");
  assert.equal(failures[0].jobName, "web e2e");
  assert.equal(failures[0].firstFailingCommand, "corepack pnpm --filter @ling-stack/web test:e2e");
  assert.equal(failures[0].suspectedSourcePath, "apps/web/e2e/app.spec.ts");
  assert.doesNotMatch(failures[0].logExcerpt, /github-token-secret/);
  assert.match(failures[0].logExcerpt, /\[REDACTED\]/);
  assert.match(failures[0].failureKey, /workflow_job:123:failure/);
  assert.match(failures[1].failureKey, /check_run:456:failure/);
  assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
    "GET /repos/openclaw/openclaw/pulls/86279",
    "GET /repos/openclaw/openclaw/actions/runs",
    "GET /repos/openclaw/openclaw/actions/runs/99/jobs",
    "GET /repos/openclaw/openclaw/actions/jobs/123/logs",
    "GET /repos/openclaw/openclaw/commits/head-sha-1/check-runs",
  ]);
  assert.match(calls[0].init.headers.Authorization, /Bearer github-token-secret/);
});

test("GitHub CI triage creates durable records, artifacts, tasks, and reuses duplicates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ci-triage-"));
  const store = createSqliteRunStore(cwd);
  try {
    const imported = createImportedPullRequestWork(store, cwd, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const fetch = createGitHubCiFetch([]);

    const first = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: imported.externalWork.id,
      workflowDefinition: workflow,
      githubToken: "github-token-secret",
      fetch,
      now: "2026-05-30T00:01:00.000Z",
    });

    assert.equal(first.triaged, 2);
    assert.equal(first.taskCreated, 2);
    assert.equal(first.duplicates, 0);
    assert.deepEqual(first.records.map((view) => view.triage.status), ["task_created", "task_created"]);
    assert.equal(store.listExternalWorkCiTriage({ externalWorkId: imported.externalWork.id }).length, 2);
    assert.equal(store.listTasks({ channelId: imported.externalWork.channelId }).length, 2);
    assert.ok(first.records[0].task);
    assert.ok(first.records[0].artifacts.length >= 4);
    assert.match(first.records[0].task.prompt, /Do not push commits, comment on GitHub/);

    const logArtifact = first.records[0].artifacts.find((artifact) => artifact.title === "GitHub CI log excerpt");
    assert.ok(logArtifact);
    const log = await readFile(resolve(store.paths.artifactsDir, logArtifact.path), "utf8");
    assert.doesNotMatch(log, /github-token-secret/);
    assert.match(log, /\[REDACTED\]/);
    assert.match(log, /corepack pnpm --filter @ling-stack\/web test:e2e/);

    const duplicate = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: imported.externalWork.id,
      workflowDefinition: workflow,
      fetch,
      now: "2026-05-30T00:02:00.000Z",
    });
    assert.equal(duplicate.triaged, 0);
    assert.equal(duplicate.taskCreated, 0);
    assert.equal(duplicate.duplicates, 2);
    assert.equal(store.listTasks({ channelId: imported.externalWork.channelId }).length, 2);
    assert.deepEqual(
      duplicate.records.map((view) => view.triage.id).sort(),
      first.records.map((view) => view.triage.id).sort(),
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub CI triage can add tasks later for existing no-task triage records", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ci-triage-late-task-"));
  const store = createSqliteRunStore(cwd);
  try {
    const imported = createImportedPullRequestWork(store, cwd, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const fetch = createGitHubCiFetch([]);

    const recordsOnly = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: imported.externalWork.id,
      workflowDefinition: workflow,
      fetch,
      createTask: false,
      now: "2026-05-30T00:01:00.000Z",
    });
    assert.equal(recordsOnly.triaged, 2);
    assert.equal(recordsOnly.taskCreated, 0);
    assert.equal(store.listTasks({ channelId: imported.externalWork.channelId }).length, 0);

    const withTasks = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: imported.externalWork.id,
      workflowDefinition: workflow,
      fetch,
      now: "2026-05-30T00:02:00.000Z",
    });
    assert.equal(withTasks.triaged, 0);
    assert.equal(withTasks.duplicates, 2);
    assert.equal(withTasks.taskCreated, 2);
    assert.equal(store.listTasks({ channelId: imported.externalWork.channelId }).length, 2);
    assert.deepEqual(withTasks.records.map((view) => view.triage.status), ["task_created", "task_created"]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GitHub CI triage marks stale PR head without reading CI or creating tasks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ci-triage-stale-"));
  const store = createSqliteRunStore(cwd);
  const calls = [];
  try {
    const imported = createImportedPullRequestWork(store, cwd, "2026-05-30T00:00:00.000Z");
    const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
    const stale = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: imported.externalWork.id,
      workflowDefinition: workflow,
      fetch: createGitHubCiFetch(calls, {
        pullRequest: {
          ...githubPullRequestPayload().pull_request,
          head: { ...githubPullRequestPayload().pull_request.head, sha: "head-sha-2" },
        },
      }),
      now: "2026-05-30T00:01:00.000Z",
    });

    assert.equal(stale.stale, 1);
    assert.equal(stale.records[0].triage.status, "stale");
    assert.match(stale.records[0].triage.lastErrorMessage, /no longer matches/);
    assert.equal(store.listTasks({ channelId: imported.externalWork.channelId }).length, 0);
    assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      "GET /repos/openclaw/openclaw/pulls/86279",
    ]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function githubRepository() {
  return {
    name: "openclaw",
    full_name: "openclaw/openclaw",
    default_branch: "main",
    owner: {
      login: "openclaw",
    },
  };
}

async function createB003Fixture(payload = { type: "github_comment", body: "B003 isolated action." }, approve = true) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-b003-matrix-"));
  const now = "2026-05-30T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const imported = createImportedPullRequestWork(store, cwd, now);
    const proposed = proposeExternalWorkAction({ store, request: { externalWorkId: imported.externalWork.id, actionKind: payload.type, payload }, now });
    const approved = approve ? store.approveApprovalRequest(proposed.approval.id, { resolvedBy: "local-user" }, now) : undefined;
    if (approved) syncExternalWorkActionForApproval(store, approved, now);
    return { cwd, store, now, imported, proposed, approved, close: async () => { store.close(); await rm(cwd, { recursive: true, force: true }); } };
  } catch (error) { store.close(); await rm(cwd, { recursive: true, force: true }); throw error; }
}

function createImportedPullRequestWork(store, cwd, now) {
  const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, now);
  const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
  const item = normalizeGitHubExternalWorkItem({
    eventType: "pull_request.opened",
    payload: githubPullRequestPayload(),
    repositoryFullName: workflow.config.source.repository,
  });
  const renderedPrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item });
  return store.createOrReuseExternalWorkWorkflow({
    channelId: channel.id,
    externalWorkItem: item,
    workflowDefinition: workflow,
    renderedPrompt,
  }, now);
}

function createImportedIssueWork(store, cwd, now) {
  const channel = store.createChannel({ name: "GitHub", boundPath: cwd, defaultTeammateId: "engineer" }, now);
  const workflow = parseExternalWorkflowMarkdown(`---
source:
  kind: github
  repository: openclaw/openclaw
---

Review {{ item.identifier }}.

Title: {{ item.title }}
`);
  const item = normalizeGitHubExternalWorkItem({
    eventType: "issue.opened",
    payload: githubIssuePayload(),
    repositoryFullName: workflow.config.source.repository,
  });
  const renderedPrompt = renderExternalWorkflowPrompt(workflow.promptTemplate, { item });
  return store.createOrReuseExternalWorkWorkflow({
    channelId: channel.id,
    externalWorkItem: item,
    workflowDefinition: workflow,
    renderedPrompt,
  }, now);
}

function createGitHubActionFetch(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/pulls/86279/reviews")) {
      return jsonResponse({
        id: 7,
        html_url: "https://github.com/openclaw/openclaw/pull/86279#pullrequestreview-7",
        state: "APPROVED",
      }, { status: 200, statusText: "OK" });
    }
    if (url.includes("/pulls/86279")) {
      return jsonResponse(options.pullRequest ?? githubPullRequestPayload().pull_request);
    }
    if (url.match(/\/issues\/42$/)) {
      return jsonResponse(options.issue ?? githubIssuePayload().issue);
    }
    if (url.includes("/issues/86279/comments")) {
      return jsonResponse({
        id: 1,
        html_url: "https://github.com/openclaw/openclaw/pull/86279#issuecomment-1",
      }, { status: 201, statusText: "Created" });
    }
    if (url.includes("/issues/86279/labels")) {
      return jsonResponse([{ name: "agent-ready", url: "https://api.github.test/labels/agent-ready" }], { status: 200, statusText: "OK" });
    }
    return jsonResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" });
  };
}

function githubPullRequestPayload() {
  return {
    repository: githubRepository(),
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

function githubIssuePayload() {
  return {
    repository: githubRepository(),
    issue: {
      id: 2001,
      number: 42,
      title: "Dashboard fails to load",
      body: "The local dashboard returns 500.",
      html_url: "https://github.com/openclaw/openclaw/issues/42",
      state: "open",
      labels: ["bug"],
      updated_at: "2026-05-29T19:00:00Z",
    },
  };
}

function linearIssuePayload(overrides = {}) {
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
    ...overrides,
  };
}

async function readExampleText(fileName) {
  return await readFile(resolve(repoRoot, "examples/external-work/github", fileName), "utf8");
}

async function readExampleJson(fileName) {
  return JSON.parse(await readExampleText(fileName));
}

function createGitHubPollFetch(pulls, issues) {
  return async (url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(pulls());
    }
    if (url.includes("/issues?")) {
      return jsonResponse(issues());
    }
    return jsonResponse({ message: "not found" }, { ok: false, status: 404, statusText: "Not Found" });
  };
}

function createGitHubCiFetch(calls, options = {}) {
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
          display_title: "CI",
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
        "github-token-secret",
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
