import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createSqliteRunStore, DEFAULT_WORKSPACE_ID, externalWorkSecretPurposeForSource, getExternalSourceRegistration,
  parseExternalWorkflowMarkdown, pollExternalWork, pollGitHubExternalWork, pollLinearExternalWork,
  reconcileExternalWork, type ExternalSourceKind, type ExternalWorkFetchLike,
} from "../dist/index.js";

const now = "2026-11-16T00:00:00.000Z";
const issue = { id: 7, number: 7, title: "Review work", state: "open", updated_at: now };
const linearIssue = { id: "lin-7", identifier: "LIN-7", title: "Review work", state: "open", project: { slug: "project" }, updatedAt: now };

function markdown(kind: ExternalSourceKind, target = kind === "github" ? "owner/repo" : "project"): string {
  return `---
source:
  kind: ${kind}
  ${kind === "github" ? "repository" : "projectSlug"}: ${target}
  events: [issue.${kind === "github" ? "opened" : "created"}]
workspace:
  gitRemoteUrl: git@git.example.com:independent/checkout.git
---
Review {{ item.identifier }}.
`;
}

function fixture(t: TestContext) {
  const cwd = mkdtempSync(resolve(tmpdir(), "ling-source-registry-"));
  const store = createSqliteRunStore(cwd);
  t.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "External", boundPath: cwd }, now);
  return { store, cwd, channelId: channel.id, workflowDirectory: cwd, now };
}

function pollFetch(kind: ExternalSourceKind): ExternalWorkFetchLike {
  return async () => Response.json(kind === "github" ? [issue] : { data: { issues: { nodes: [linearIssue] } } });
}

test("fixed registrations resolve provider targets, source keys and token purposes without IO", (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("metadata lookup must not call a provider"); });
  for (const kind of ["github", "linear"] as const) {
    const registration = getExternalSourceRegistration(kind);
    const workflowDefinition = parseExternalWorkflowMarkdown(markdown(kind));
    const target = registration.resolveTarget(workflowDefinition.config.source);
    const expectedId = kind === "github" ? "owner/repo" : "project";
    assert.deepEqual(target, { kind, id: expectedId, label: expectedId });
    assert.equal(registration.sourceKey(target), `${kind}:${expectedId}`);
    assert.equal(externalWorkSecretPurposeForSource(kind), `${kind}_token`);
    assert.equal(registration.supportsRemoteTerminalReconcile, kind === "github");
    assert.equal(Object.isFrozen(registration), true);
    const item = registration.normalizeImport({
      eventType: kind === "github" ? "issue.opened" : "issue.created",
      payload: kind === "github" ? issue : linearIssue, workflowDefinition,
    });
    assert.equal(item.kind, kind === "github" ? "github_issue" : "linear_issue");
    assert.equal(item.identifier, kind === "github" ? "owner/repo#7" : "LIN-7");
    assert.equal(item.idempotencyKey, kind === "github" ? `github:issue:owner/repo:7:${now}` : `linear:issue:project:LIN-7:${now}`);
    const missing = { ...workflowDefinition.config.source, repository: undefined, projectSlug: undefined };
    assert.throws(() => registration.resolveTarget(missing), new RegExp(`source\\.${kind === "github" ? "repository" : "projectSlug"} is required`));
    assert.throws(() => registration.resolveTarget({ ...missing, kind: kind === "github" ? "linear" : "github" }), /Unsupported external source kind/);
  }
  for (const kind of ["gitlab", "git", "__proto__", "constructor", "toString"]) {
    assert.throws(() => getExternalSourceRegistration(kind), /Unsupported external source kind/);
  }
});

test("registered imports reject payloads from a different configured source", () => {
  const github = getExternalSourceRegistration("github");
  const githubWorkflow = parseExternalWorkflowMarkdown(markdown("github", "owner/repo"));
  assert.throws(() => github.normalizeImport({
    eventType: "issue.opened",
    payload: {
      repository: { full_name: "other/repo" },
      issue: { number: 7, title: "Wrong repository", state: "open" },
    },
    workflowDefinition: githubWorkflow,
  }), /does not match configured source/);

  const caseVariantWorkflow = parseExternalWorkflowMarkdown(markdown("github", "Owner/Repo"));
  const caseVariant = github.normalizeImport({
    eventType: "issue.opened",
    payload: { repository: { full_name: "owner/repo" }, issue: { number: 8, title: "Case variant", state: "open" } },
    workflowDefinition: caseVariantWorkflow,
  });
  assert.equal(caseVariant.identifier, "owner/repo#8");

  const linear = getExternalSourceRegistration("linear");
  const linearWorkflow = parseExternalWorkflowMarkdown(markdown("linear", "project"));
  assert.throws(() => linear.normalizeImport({
    eventType: "issue.created",
    payload: {
      id: "lin-other",
      identifier: "OTHER-7",
      title: "Wrong project",
      project: { slug: "other-project" },
    },
    workflowDefinition: linearWorkflow,
  }), /does not match configured source/);
});

test("GitHub adapters reject repository values that could alter the API URL", async () => {
  let fetchCalls = 0;
  const adapter = getExternalSourceRegistration("github").createAdapter({
    fetch: async () => {
      fetchCalls += 1;
      return Response.json([]);
    },
  });
  await assert.rejects(adapter.loadCandidates({
    repository: "owner/repo?state=closed",
    events: ["issue.opened"],
    activeStates: ["open"],
  }), /Invalid GitHub repository full name/);
  assert.equal(fetchCalls, 0);
});

test("GitHub adapters preserve valid dot-prefixed repository names", async () => {
  const calls: string[] = [];
  const adapter = getExternalSourceRegistration("github").createAdapter({
    fetch: async (url) => {
      calls.push(url);
      return Response.json([]);
    },
  });
  await adapter.loadCandidates({ repository: "owner/.github", events: ["issue.opened"], activeStates: ["open"] });
  assert.equal(calls[0], "https://api.github.com/repos/owner/.github/issues?state=open&per_page=50");
});

for (const kind of ["github", "linear"] as const) {
  test(`${kind} generic poll and compatibility wrapper share scheduler identity and evidence`, async (t) => {
    const f = fixture(t);
    const input = { ...f, workflowDefinition: parseExternalWorkflowMarkdown(markdown(kind)), fetch: pollFetch(kind) };
    const first = await pollExternalWork({ ...input, token: "fixture-source-token" });
    assert.deepEqual([first.candidates, first.claimed, first.duplicates, first.blocked, first.retryScheduled], [1, 1, 0, 0, 0]);
    assert.equal(first.schedulerStates[0].sourceKey, kind === "github" ? "github:owner/repo" : "linear:project");
    assert.equal(first.schedulerStates[0].schedulerStatus, "ready");
    assert.equal(first.artifacts.length, 2);
    const duplicate = kind === "github"
      ? await pollGitHubExternalWork({ ...input, githubToken: "fixture-source-token" })
      : await pollLinearExternalWork({ ...input, linearToken: "fixture-source-token" });
    assert.deepEqual([duplicate.candidates, duplicate.claimed, duplicate.duplicates, duplicate.blocked], [1, 0, 1, 0]);
    assert.equal(duplicate.schedulerStates[0].externalWorkId, first.schedulerStates[0].externalWorkId);
    assert.equal(f.store.listChannelWorkflows({ channelId: f.channelId }).length, 1);
    assert.equal(f.store.getBlockingResourceLease("external_source", first.schedulerStates[0].sourceKey), undefined);
  });

  test(`${kind} shared poll preserves source lease conflicts and releases ownership after read failure`, async (t) => {
    const f = fixture(t), sourceKey = kind === "github" ? "github:owner/repo" : "linear:project";
    const input = { ...f, workflowDefinition: parseExternalWorkflowMarkdown(markdown(kind)) };
    f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "external_source", resourceKey: sourceKey,
      ownerType: "system", ownerId: "fixture-blocker", acquiredAt: now, expiresAt: "2026-11-16T01:00:00.000Z" });
    const blocked = await pollExternalWork({ ...input, fetch: async () => { assert.fail("locked poll must not fetch"); } });
    assert.deepEqual([blocked.candidates, blocked.blocked], [0, 1]);
    assert.match(blocked.results[0].message!, /locked by system:fixture-blocker/);
    assert.equal(f.store.listExternalWorkRecords().length, 0);
    f.store.releaseResourceLeasesForOwner("system", "fixture-blocker", now);
    const failure = new Error("fixture transport failure");
    await assert.rejects(pollExternalWork({ ...input, fetch: async () => { throw failure; } }), error => error === failure);
    assert.equal(f.store.getBlockingResourceLease("external_source", sourceKey), undefined);
    assert.equal((await pollExternalWork({ ...input, fetch: pollFetch(kind) })).claimed, 1);
  });
}

test("reconcile checks only the registered target and keeps Linear remote checks disabled", async (t) => {
  const f = fixture(t);
  const github = parseExternalWorkflowMarkdown(markdown("github"));
  const otherGitHub = parseExternalWorkflowMarkdown(markdown("github", "other/repo"));
  const linear = parseExternalWorkflowMarkdown(markdown("linear"));
  const gh = await pollExternalWork({ ...f, workflowDefinition: github, fetch: pollFetch("github") });
  const other = await pollExternalWork({ ...f, workflowDefinition: otherGitHub, fetch: pollFetch("github") });
  const lin = await pollExternalWork({ ...f, workflowDefinition: linear, fetch: pollFetch("linear") });
  const local = await reconcileExternalWork({ ...f, workflowDefinition: linear, fetch: async () => { assert.fail("Linear reconcile must stay local"); } });
  assert.equal(local.checked, 3); assert.equal(local.terminal, 0);
  const calls: string[] = [];
  const remote = await reconcileExternalWork({ ...f, workflowDefinition: github, token: "fixture-read-token", fetch: async (url, init) => {
    calls.push(url); assert.equal(init?.method, "GET");
    assert.equal(init?.headers?.Authorization, "Bearer fixture-read-token");
    return Response.json({ ...issue, state: "closed" });
  } });
  assert.deepEqual(calls, ["https://api.github.com/repos/owner/repo/issues/7"]);
  assert.equal(remote.terminal, 1);
  assert.equal(f.store.getExternalWorkSchedulerState(gh.schedulerStates[0].externalWorkId)?.schedulerStatus, "terminal");
  for (const result of [other, lin]) {
    assert.equal(f.store.getExternalWorkSchedulerState(result.schedulerStates[0].externalWorkId)?.schedulerStatus, "ready");
  }
  f.store.updateChannelWorkflow(lin.schedulerStates[0].workflowId, { status: "succeeded" }, now);
  const completed = await reconcileExternalWork({ ...f, workflowDefinition: linear, fetch: async () => { assert.fail("local completion must not fetch"); } });
  assert.equal(completed.terminal, 1);
  assert.equal(f.store.getExternalWorkSchedulerState(lin.schedulerStates[0].externalWorkId)?.schedulerStatus, "terminal");
});

test("adapters reject another source's target before fetching and wrappers reject another source's workflow", async (t) => {
  const f = fixture(t);
  const github = getExternalSourceRegistration("github"), linear = getExternalSourceRegistration("linear");
  for (const [registration, otherKind] of [[github, "linear"], [linear, "github"]] as const) {
    const adapter = registration.createAdapter({ fetch: async () => { assert.fail("wrong source must not fetch"); } });
    await assert.rejects(adapter.loadCandidates({ target: { kind: otherKind, id: "target", label: "target" }, events: [], activeStates: [] }), /Unsupported external source kind/);
  }
  await assert.rejects(pollGitHubExternalWork({ ...f, workflowDefinition: parseExternalWorkflowMarkdown(markdown("linear")) }), /Unsupported external source kind: linear/);
  await assert.rejects(pollLinearExternalWork({ ...f, workflowDefinition: parseExternalWorkflowMarkdown(markdown("github")) }), /Unsupported external source kind: github/);
  assert.equal(f.store.listExternalWorkRecords().length, 0);
});
