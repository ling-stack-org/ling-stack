import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  createGitHubCiTriageAdapter,
  createSqliteRunStore,
  normalizeGitHubExternalWorkItem,
  parseExternalWorkflowMarkdown,
  renderExternalWorkflowPrompt,
  resolveStoragePaths,
  triageGitHubExternalWorkCi,
} from "../../core/dist/index.js";
import {
  handleExternalGitHubCiTriage,
  handleExternalWorkCiTriageItem,
} from "../dist/features/external-work/ci-triage.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

// Deliberately synthetic public fixtures, never environment/Keychain credentials.
const DUMMY_TOKEN = "B009_DUMMY_NOT_A_CREDENTIAL_20261016";
const SHAPED_COMMAND = "sk-b009CommandFixtureOnly0001";
const SHAPED_PATH = "sk-b009PathFixtureOnly0001";
const forbidden = [DUMMY_TOKEN, SHAPED_COMMAND, SHAPED_PATH];
const repository = "b009-fixture/repo";
const now = "2026-10-16T08:00:00.000Z";
const workflowMarkdown = `---
source:
  kind: github
  repository: ${repository}
  secretRef: env:B009_SYNTHETIC_TOKEN
---

Review {{ item.identifier }}.
`;
const cases = [
  { name: "secret-shaped command", command: `pnpm test --probe ${SHAPED_COMMAND}`, path: "src/feature.ts" },
  { name: "current opaque token", command: `pnpm test --session ${DUMMY_TOKEN}`, path: "src/feature.ts" },
  { name: "secret-shaped path", command: "pnpm test", path: `src/${SHAPED_PATH}/feature.ts` },
];

for (const scenario of cases) {
  test(`B009 adapter redacts ${scenario.name} before exposing parsed or raw check failure`, async () => {
    const fixture = githubFixture(scenario);
    const adapter = createGitHubCiTriageAdapter({ fetch: fixture.fetch });
    const failures = await adapter.listFailures({ repository, subjectNumber: 42,
      headSha: "b009-head-1", token: DUMMY_TOKEN });
    assert.equal(failures.length, 1);
    assertDiagnostics(failures[0], scenario);
    assertSafe([{ name: "adapter complete candidate", value: failures[0] }]);
    assert.deepEqual(fixture.calls.map(call => call.path), [
      "/repos/b009-fixture/repo/actions/runs",
      "/repos/b009-fixture/repo/commits/b009-head-1/check-runs",
    ]);
  });

  test(`B009 new SQLite/artifact/late-task writes do not retain ${scenario.name}`, async t => {
    const fixture = await ownedStore(t), github = githubFixture(scenario);
    const input = { store: fixture.store, cwd: fixture.cwd,
      externalWorkId: fixture.imported.externalWork.id, workflowDefinition: fixture.workflow,
      githubToken: DUMMY_TOKEN, fetch: github.fetch, now };
    const initial = await triageGitHubExternalWorkCi({ ...input, createTask: false });
    assert.equal(initial.triaged, 1); assert.equal(initial.taskCreated, 0);
    assert.equal(initial.records.length, 1);
    assertDiagnostics(initial.records[0].triage, scenario);
    const surfaces = [{ name: "initial new-record response", value: initial }];
    // Duplicate reuse is only of the just-created fixture row. This is not a
    // migration of unsafe historical data or authorization to touch a user DB.
    const lateTask = await triageGitHubExternalWorkCi({ ...input, createTask: true });
    assert.equal(lateTask.triaged, 0); assert.equal(lateTask.duplicates, 1);
    assert.equal(lateTask.taskCreated, 1);
    assert.match(lateTask.records[0].task.prompt, /Do not push commits, comment on GitHub/u);
    assert.match(lateTask.records[0].task.prompt, /pnpm test/u);
    surfaces.push({ name: "late task duplicate response", value: lateTask });
    const repeated = await triageGitHubExternalWorkCi({ ...input, createTask: true });
    assert.equal(repeated.taskCreated, 0); assert.equal(repeated.duplicates, 1);
    assert.equal(fixture.store.listTasks({ channelId: fixture.channel.id }).length, 1);
    assert.equal(fixture.store.listRuns({ limit: 10 }).length, 0, "triage must never start an Agent");
    surfaces.push({ name: "idempotent new-row duplicate", value: repeated });
    surfaces.push(...await persistedSurfaces(fixture, lateTask.records[0]));
    assertSafe(surfaces);
  });
}

test("B009 complete check output remains bounded and diagnostic after secret filtering", async () => {
  const scenario = { ...cases[1], prefix: "harmless diagnostic padding\n".repeat(3_000) };
  const github = githubFixture(scenario);
  const failures = await createGitHubCiTriageAdapter({ fetch: github.fetch }).listFailures({
    repository, subjectNumber: 42, headSha: "b009-head-1", token: DUMMY_TOKEN });
  assert.equal(failures.length, 1);
  assertDiagnostics(failures[0], scenario);
  assert.ok(failures[0].logExcerpt.length <= 64_000, "keep the existing bounded excerpt contract");
  assert.match(failures[0].logExcerpt, /src\/feature\.ts:12/u);
  assertSafe([{ name: "bounded adapter complete candidate", value: failures[0] }]);
});

test("B009 workflow-job pre-parse redaction keeps legitimate command and source diagnostics", async t => {
  const fixture = await ownedStore(t), scenario = { ...cases[1], workflowJob: true };
  const github = githubFixture(scenario);
  const result = await triageGitHubExternalWorkCi({ store: fixture.store, cwd: fixture.cwd,
    externalWorkId: fixture.imported.externalWork.id, workflowDefinition: fixture.workflow,
    githubToken: DUMMY_TOKEN, fetch: github.fetch, createTask: true, now });
  assert.equal(result.triaged, 1); assert.equal(result.taskCreated, 1);
  const view = result.records[0];
  assert.match(view.triage.failureKey, /workflow_job:123:failure/u);
  assert.equal(view.triage.firstFailingCommand, "pnpm test --session [REDACTED]");
  assert.equal(view.triage.suspectedSourcePath, "src/feature.ts");
  assert.equal(fixture.store.listRuns({ limit: 10 }).length, 0);
  assertSafe([{ name: "workflow job response", value: result }, ...await persistedSurfaces(fixture, view)]);
});

test("B009 real POST/list/detail handlers only expose safe new check records and task/artifact projections", async t => {
  const fixture = await ownedStore(t);
  const scenario = { command: `pnpm test --session ${DUMMY_TOKEN} --probe ${SHAPED_COMMAND}`,
    path: "src/feature.ts", extraText: `secondary src/${SHAPED_PATH}/secondary.ts:3 error` };
  const github = githubFixture(scenario), resolutions = [];
  const registry = new RunStoreRegistry(cwd => {
    assert.equal(cwd, fixture.cwd, "no default or sibling Store may be opened");
    return fixture.store;
  }, { trustedWorkspaceRoots: [fixture.cwd] });
  const secretResolver = { resolve(ref, purpose) {
    assert.equal(ref, "env:B009_SYNTHETIC_TOKEN"); assert.equal(purpose, "github_token");
    resolutions.push({ ref, purpose });
    return { ref, configured: true, value: DUMMY_TOKEN };
  } };
  const config = { host: "127.0.0.1", port: 0, maxBodyBytes: 32_768 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const prefix = "/external-work/github/ci/triage";
    const handling = url.pathname === prefix
      ? handleExternalGitHubCiTriage(request, response, config, registry, secretResolver, github.fetch)
      : url.pathname.startsWith(`${prefix}/`)
        ? handleExternalWorkCiTriageItem(request, response, config, registry, decodeURIComponent(url.pathname.slice(prefix.length + 1)))
        : Promise.reject(new Error("B009 fixture refuses every unrelated handler"));
    handling.catch(error => { response.writeHead(500); response.end(JSON.stringify({ fixtureError: error.message })); });
  });
  fixture.beforeClose.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    registry.closeAll();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");
  const base = `/external-work/github/ci/triage?cwd=${encodeURIComponent(fixture.cwd)}`;
  const posted = await requestJson(address.port, "POST", base, { externalWorkId: fixture.imported.externalWork.id,
    workflowPath: "WORKFLOW.md", createTask: true });
  assert.equal(posted.status, 200); assert.equal(posted.body.triaged, 1);
  assert.equal(posted.body.taskCreated, 1); assert.equal(resolutions.length, 1);
  const view = posted.body.records[0];
  assertDiagnostics(view.triage, scenario);
  const count = github.calls.length;
  const listed = await requestJson(address.port, "GET", `${base}&externalWorkId=${encodeURIComponent(fixture.imported.externalWork.id)}`);
  const detailed = await requestJson(address.port, "GET",
    `/external-work/github/ci/triage/${encodeURIComponent(view.triage.id)}?cwd=${encodeURIComponent(fixture.cwd)}`);
  assert.equal(listed.status, 200); assert.equal(detailed.status, 200);
  assert.equal(listed.body.records.length, 1); assert.equal(detailed.body.record.triage.id, view.triage.id);
  assert.equal(detailed.body.record.task.id, view.task.id);
  assert.equal(github.calls.length, count, "GET must project stored safe facts without another GitHub request");
  assert.equal(resolutions.length, 1, "GET must not resolve a secret to conceal unsafe persistence");
  assert.equal(fixture.store.listRuns({ limit: 10 }).length, 0);
  assertSafe([{ name: "real POST JSON body", value: posted.body },
    { name: "real GET list JSON body", value: listed.body },
    { name: "real GET detail JSON body", value: detailed.body }, ...await persistedSurfaces(fixture, view)]);
});

/** Actual SQLite stores/artifacts, always under this test's explicit temporary root. */
async function ownedStore(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b009-ci-redaction-")));
  const cwd = join(root, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  assert.ok(paths.artifactsDir.startsWith(`${root}/`));
  const stores = [], beforeClose = [], open = () => { const store = createSqliteRunStore(cwd, paths); stores.push(store); return store; };
  const store = open();
  t.after(async () => {
    for (const close of beforeClose) await close();
    for (const current of stores.reverse()) if (current.database.isOpen) current.close();
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b009-ci-redaction-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(join(cwd, "WORKFLOW.md"), workflowMarkdown, "utf8");
  const workflow = parseExternalWorkflowMarkdown(workflowMarkdown);
  const channel = store.createChannel({ name: "B009 isolated CI", boundPath: cwd }, now);
  const item = normalizeGitHubExternalWorkItem({ eventType: "pull_request.opened",
    payload: { repository: repositoryPayload(), pull_request: pullRequestPayload() }, repositoryFullName: repository });
  const imported = store.createOrReuseExternalWorkWorkflow({ channelId: channel.id, externalWorkItem: item,
    workflowDefinition: workflow, renderedPrompt: renderExternalWorkflowPrompt(workflow.promptTemplate, { item }) }, now);
  return { root, cwd, paths, store, open, beforeClose, channel, workflow, imported };
}

/** Inspect every relevant persisted/newly projected sink, not only normalized JSON. */
async function persistedSurfaces(fixture, view) {
  const values = [{ name: "actual external_work_ci_triage SQL row",
    value: fixture.store.database.prepare("SELECT * FROM external_work_ci_triage WHERE id = ?").get(view.triage.id) }];
  if (view.task) values.push({ name: "actual tasks SQL row",
    value: fixture.store.database.prepare("SELECT * FROM tasks WHERE id = ?").get(view.task.id) });
  const reopened = fixture.open();
  values.push({ name: "reopened Store failure/metadata", value: reopened.getExternalWorkCiTriage(view.triage.id) });
  if (view.task) values.push({ name: "reopened Store task", value: reopened.getTask(view.task.id) });
  const artifacts = view.triage.artifactIds.map(id => fixture.store.getArtifact(id));
  for (const expected of ["Normalized GitHub CI failure", "GitHub CI log excerpt", "GitHub CI triage summary"])
    assert.ok(artifacts.some(artifact => artifact?.title === expected), `missing actual evidence artifact: ${expected}`);
  if (view.task) assert.ok(artifacts.some(artifact => artifact?.title === "CI fix task prompt"));
  for (const artifact of artifacts) {
    assert.ok(artifact);
    const path = resolve(fixture.store.paths.artifactsDir, artifact.path);
    const within = relative(fixture.store.paths.artifactsDir, path);
    assert.ok(within && !within.startsWith("..") && !within.startsWith("/"));
    const content = await fs.readFile(path, "utf8");
    values.push({ name: `actual artifact ${artifact.title}`, value: content });
    if (artifact.title === "GitHub CI log excerpt") assert.ok(content.length <= 64_001);
  }
  return values;
}

function assertDiagnostics(failure, scenario) {
  assert.equal(failure.checkName, "b009-check");
  assert.match(failure.firstFailingCommand, /^pnpm test\b/u);
  assert.equal(failure.reproductionCommand, failure.firstFailingCommand);
  if (scenario.path === "src/feature.ts") assert.equal(failure.suspectedSourcePath, "src/feature.ts");
}

function assertSafe(surfaces) {
  const exposed = surfaces.filter(surface => {
    const text = typeof surface.value === "string" ? surface.value : JSON.stringify(surface.value);
    return forbidden.some(secret => text.includes(secret));
  }).map(surface => surface.name);
  assert.deepEqual(exposed, [], "original synthetic secrets must be absent from every named durable/public sink");
}

/** Offline GitHub protocol fixture: reject unlisted URL/method, never delegate to network. */
function githubFixture(scenario) {
  const calls = [];
  const text = `${scenario.prefix ?? ""}Run ${scenario.command}\n${scenario.path}:12 diagnostic error\n${scenario.extraText ?? ""}`;
  const fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com"); assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${DUMMY_TOKEN}`);
    calls.push({ path: url.pathname, method: init.method });
    if (url.pathname === "/repos/b009-fixture/repo/pulls/42") return jsonResponse(pullRequestPayload());
    if (url.pathname === "/repos/b009-fixture/repo/actions/runs") return jsonResponse({ workflow_runs: scenario.workflowJob
      ? [{ id: 99, name: "B009 CI", conclusion: "failure", updated_at: now }] : [] });
    if (scenario.workflowJob && url.pathname === "/repos/b009-fixture/repo/actions/runs/99/jobs")
      return jsonResponse({ jobs: [{ id: 123, name: "b009-check", conclusion: "failure", completed_at: now }] });
    if (scenario.workflowJob && url.pathname === "/repos/b009-fixture/repo/actions/jobs/123/logs")
      return { ok: true, status: 200, statusText: "OK", text: async () => text, json: async () => { throw new Error("log is text"); } };
    if (url.pathname === "/repos/b009-fixture/repo/commits/b009-head-1/check-runs") return jsonResponse({ check_runs: scenario.workflowJob ? []
      : [{ id: 456, name: "b009-check", conclusion: "failure", completed_at: now,
        html_url: "https://github.com/b009-fixture/repo/runs/456",
        output: { title: "B009 synthetic failure", summary: text, text: "end of fixture" } }] });
    assert.fail(`B009 refused unlisted offline GitHub request: ${url.pathname}`);
  };
  return { fetch, calls };
}

function repositoryPayload() {
  return { name: "repo", full_name: repository, default_branch: "main", owner: { login: "b009-fixture" } };
}
function pullRequestPayload() {
  return { id: 1001, number: 42, title: "B009 synthetic PR", body: "No external execution.",
    html_url: "https://github.com/b009-fixture/repo/pull/42", state: "open", labels: [], updated_at: now,
    base: { ref: "main", sha: "b009-base-1" }, head: { ref: "fixture", sha: "b009-head-1" } };
}
function jsonResponse(value) {
  return { ok: true, status: 200, statusText: "OK", json: async () => value, text: async () => JSON.stringify(value) };
}

/** Real loopback HTTP to the selected production handler, no external fetch or proxy. */
async function requestJson(port, method, path, body) {
  return await new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ host: "127.0.0.1", port, method, path, agent: false,
      headers: bytes ? { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) } : {} }, response => {
      const chunks = [];
      response.on("error", reject); response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(3_000, () => request.destroy(new Error("B009 owned handler did not respond")));
    request.on("error", reject); request.end(bytes);
  });
}
