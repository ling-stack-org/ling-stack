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
