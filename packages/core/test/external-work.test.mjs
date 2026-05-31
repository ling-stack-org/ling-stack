import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSqliteRunStore,
  normalizeGitHubExternalWorkItem,
  parseExternalWorkflowMarkdown,
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
