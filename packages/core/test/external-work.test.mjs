import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSqliteRunStore,
  createGitHubExternalWorkAdapter,
  normalizeGitHubExternalWorkItem,
  parseExternalWorkflowMarkdown,
  pollGitHubExternalWork,
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
    () => parseExternalWorkflowMarkdown("---\nsource:\n  kind: linear\n  projectSlug: x\n---\nBody"),
    /Unsupported external source kind: linear/,
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
