import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSqliteWorkflowTemplateRegistryStore } from "../../core/dist/index.js";
import { b013OwnedStore, b013FactCounts, b013ParticipantId } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { handleWorkflowTemplateRoute } from "../dist/features/channels/workflow-template-routes.js";
import { handleChannelWorkflowsCollection } from "../dist/features/channels/workflows.js";

async function fixture(t) {
  const f = await b013OwnedStore(t), registry = createSqliteWorkflowTemplateRegistryStore(f.store);
  const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled",
    adapter: { id: "pi", run() { assert.fail("authoring cannot execute a Runner"); } } }]);
  const storeRegistry = { getStore(cwd) { assert.equal(cwd, f.cwd); return f.store; } };
  const config = { maxBodyBytes: 1_048_576 };
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname === `/channels/${f.channel.id}/workflows`) {
      void handleChannelWorkflowsCollection(request, response, config, storeRegistry, f.channel.id, runnerRegistry);
      return;
    }
    void handleWorkflowTemplateRoute({ request, response, url: new URL(request.url, "http://localhost"),
      storeRegistry, config, runnerRegistry });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path = "/workflow-templates", method = "GET", body, query = `cwd=${encodeURIComponent(f.cwd)}`) => {
    const response = await fetch(`${base}${path}${query ? `?${query}` : ""}`, { method,
      headers: { "Content-Type": "application/json", Connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const template = { schemaVersion: 1, id: "route / review", name: "Route review", steps: [{ id: "inspect", name: "Inspect",
    prompt: "Read the current evidence", teammateId: b013ParticipantId, sideEffectClass: "analysis_readonly",
    parallelPolicy: { autoParallel: false } }] };
  return { ...f, registry, api, template };
}

test("HTTP authoring saves, imports, lists, pins, publishes, previews and archives without starting execution", async t => {
  const f = await fixture(t), before = b013FactCounts(f.store);
  assert.deepEqual((await f.api()).body, { cwd: f.cwd, templates: [] });
  const saved = await f.api("/workflow-templates", "POST", { id: f.template.id, version: "v1 / exact", template: f.template, expectedRevision: 0 });
  assert.equal(saved.status, 201, JSON.stringify(saved));
  assert.equal(saved.body.entry.kind, "workflow_template"); assert.equal(saved.body.entry.source, "workspace");
  assert.equal(saved.body.entry.reviewStatus, "draft"); assert.equal(saved.body.entry.revision, 1);
  assert.equal(saved.body.version.template.autoStartDefault, false);
  assert.equal((await f.api()).body.templates.length, 1);
  const { entry, version } = saved.body, item = `/workflow-templates/${encodeURIComponent(entry.id)}`;
  assert.deepEqual((await f.api(`${item}/versions/${encodeURIComponent(version.version)}`)).body, saved.body);
  const stale = await f.api(`${item}/review`, "PATCH", { reviewStatus: "published", version: version.version, digest: version.digest, expectedRevision: 0 });
  assert.equal(stale.status, 409, JSON.stringify(stale));
  const published = await f.api(`${item}/review`, "PATCH", { reviewStatus: "published", version: version.version,
    digest: version.digest, expectedRevision: entry.revision });
  assert.equal(published.status, 200, JSON.stringify(published));
  assert.deepEqual(published.body.entry.publishedVersion, { id: entry.id, version: version.version, digest: version.digest });
  // Inline draft preview and published registry preview share the same compiler, with no model execution.
  const inline = await f.api("/workflow-templates/preview", "POST", { channelId: f.channel.id, objective: "Read evidence", customTemplate: f.template });
  assert.equal(inline.status, 200, JSON.stringify(inline));
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Route fixture", providerId: "route-fixture",
    model: "route-fixture", api: "openai-completions", capabilities: ["chat"], enabled: true }, new Date().toISOString());
  f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id }, new Date().toISOString());
  f.store.updateWorkspaceSettings({ defaultProviderPresetId: provider.id }, new Date().toISOString());
  const preview = await f.api("/workflow-templates/preview", "POST", { channelId: f.channel.id, objective: "Read evidence",
    customTemplateId: entry.id, customTemplateVersion: version.version, customTemplateDigest: version.digest });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.body.steps[0].toParticipantId, b013ParticipantId);
  assert.equal(preview.body.steps[0].autoStart, false);
  assert.deepEqual(b013FactCounts(f.store), before);
  const archived = await f.api(`${item}/review`, "PATCH", { reviewStatus: "archived", expectedRevision: published.body.entry.revision });
  assert.equal(archived.status, 200); assert.equal((await f.api()).body.templates.length, 0);
  assert.equal((await f.api("/workflow-templates", "GET", undefined, `cwd=${encodeURIComponent(f.cwd)}&includeArchived=true`)).body.templates[0].reviewStatus, "archived");
  assert.equal((await f.api(`${item}/versions/${encodeURIComponent(version.version)}`)).body.version.digest, version.digest);
});

test("HTTP API rejects identity/authority fields, invalid definitions and stale saves atomically", async t => {
  const f = await fixture(t), save = { id: f.template.id, version: "v1", template: f.template, expectedRevision: 0 };
  const before = b013FactCounts(f.store);
  for (const extra of [{ source: "builtin" }, { visibility: { workspaceVisible: true } }, { reviewStatus: "published" },
    { now: "2099-01-01T00:00:00.000Z" }, { createdBy: "system" }, { expectedRevision: -1 }, { expectedRevision: 0.5 }]) {
    const result = await f.api("/workflow-templates", "POST", { ...save, ...extra });
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  for (const change of [template => ({ ...template, steps: [] }), template => ({ ...template, id: "other" }),
    template => ({ ...template, steps: [{ ...template.steps[0], dependsOn: ["missing"] }] }),
    template => ({ ...template, steps: [{ ...template.steps[0], dependsOn: ["inspect"] }] }),
    template => ({ ...template, steps: [{ ...template.steps[0], sideEffectClass: "readonly-looking" }] })]) {
    const result = await f.api("/workflow-templates", "POST", { ...save, template: change(f.template) });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(f.registry.list(), []);
  }
  assert.equal((await f.api("/workflow-templates", "POST", save)).status, 201);
  const conflict = await f.api("/workflow-templates", "POST", { ...save, version: "v2" });
  assert.equal(conflict.status, 409); assert.equal(f.registry.get(save.id).latestVersion, "v1");
  const item = `/workflow-templates/${encodeURIComponent(save.id)}`;
  for (const body of [{ reviewStatus: "builtin", expectedRevision: 1 },
    { reviewStatus: "published", expectedRevision: 1 }, { reviewStatus: "archived", expectedRevision: 1, version: "v1" }])
    assert.equal((await f.api(`${item}/review`, "PATCH", body)).status, 400);
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("HTTP read-only sources, missing workspace and unsupported methods have explicit errors", async t => {
  const f = await fixture(t);
  const saved = f.registry.saveVersion({ kind: "workflow_template", id: f.template.id, version: "v1", template: f.template,
    source: "builtin", visibility: { workspaceVisible: true, promotableToWorkspace: false }, expectedRevision: 0, now: new Date().toISOString() });
  const path = `/workflow-templates/${encodeURIComponent(saved.entry.id)}`;
  assert.equal((await f.api("/workflow-templates", "POST", { id: f.template.id, version: "v2", template: f.template, expectedRevision: 1 })).status, 403);
  assert.equal((await f.api(`${path}/review`, "PATCH", { reviewStatus: "archived", expectedRevision: 1 })).status, 403);
  assert.equal((await f.api("/workflow-templates", "GET", undefined, "")).status, 400);
  assert.equal((await f.api("/workflow-templates", "DELETE")).status, 405);
  assert.equal((await f.api("/workflow-templates/preview")).status, 405);
  assert.equal((await f.api(`${path}/versions/missing`)).status, 404);
});

test("workflow compilation preserves legacy inline errors and exposes registry version conflicts", async t => {
  const f = await fixture(t), path = `/channels/${f.channel.id}/workflows`;
  const cyclic = { ...f.template, steps: [
    { ...f.template.steps[0], id: "a", dependsOn: ["b"] },
    { ...f.template.steps[0], id: "b", dependsOn: ["a"] },
  ] };
  const invalid = await f.api(path, "POST", { objective: "Reject an inline cycle", customTemplate: cyclic });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "bad_request");
  const saved = await f.api("/workflow-templates", "POST", { id: f.template.id, version: "v1",
    template: f.template, expectedRevision: 0 });
  assert.equal(saved.status, 201);
  const input = { objective: "Use the exact registry version", customTemplateId: f.template.id,
    customTemplateVersion: saved.body.version.version, customTemplateDigest: saved.body.version.digest };
  const unpublished = await f.api(path, "POST", input);
  assert.equal(unpublished.status, 409);
  assert.equal(unpublished.body.error, "workflow_template_not_published");
  const published = await f.api(`/workflow-templates/${encodeURIComponent(f.template.id)}/review`, "PATCH",
    { reviewStatus: "published", version: saved.body.version.version, digest: saved.body.version.digest,
      expectedRevision: saved.body.entry.revision });
  assert.equal(published.status, 200);
  const stale = await f.api(path, "POST", { ...input, customTemplateVersion: "missing" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "workflow_template_version_conflict");
  assert.equal(f.store.listChannelWorkflows({ channelId: f.channel.id }).length, 0);
});

test("explicit template creation owns a canonical channel input without enqueuing execution", async t => {
  const f = await fixture(t), path = `/channels/${f.channel.id}/workflows`;
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Creation fixture", providerId: "creation-fixture",
    model: "creation-fixture", api: "openai-completions", capabilities: ["chat"], enabled: true }, new Date().toISOString());
  f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id }, new Date().toISOString());
  f.store.updateWorkspaceSettings({ defaultProviderPresetId: provider.id }, new Date().toISOString());
  const saved = f.registry.saveVersion({ kind: "workflow_template", id: f.template.id, version: "v1",
    template: f.template, source: "workspace", visibility: { workspaceVisible: true, promotableToWorkspace: false },
    expectedRevision: 0, now: new Date().toISOString() });
  f.registry.setReviewStatus({ id: saved.entry.id, reviewStatus: "published", version: saved.version.version,
    digest: saved.version.digest, expectedRevision: saved.entry.revision, now: new Date().toISOString() });
  const input = { objective: "Inspect the exact authored template", customTemplateId: saved.entry.id,
    customTemplateVersion: saved.version.version, customTemplateDigest: saved.version.digest };
  assert.equal((await f.api("/workflow-templates/preview", "POST", { ...input, channelId: f.channel.id })).status, 200);
  const count = table => Number(f.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  assert.equal(count("ling_turns"), 0);
  const response = await f.api(path, "POST", input);
  assert.equal(response.status, 201, JSON.stringify(response));
  const { workflow, workflowSteps } = response.body;
  assert.ok(workflow.metadata?.sourceTurnId);
  assert.ok(workflow.metadata?.sourceMessageId);
  const turn = f.store.getLingTurn(workflow.metadata.sourceTurnId), item = f.store.getConversationItem(workflow.metadata.sourceMessageId);
  assert.equal(turn.sourceItemId, item.id);
  assert.equal(turn.threadId, item.threadId);
  assert.equal(turn.channelId, f.channel.id);
  assert.equal(turn.userInstruction, input.objective);
  assert.equal(item.kind, "user_message");
  assert.equal(item.actorType, "local_user");
  assert.equal(item.payload.body, input.objective);
  assert.deepEqual(item.domainRefs, [{ type: "workflow", id: workflow.id }]);
  assert.equal(f.store.getLingThread(item.threadId).surfaceKind, "channel_root");
  assert.equal(workflowSteps.length, 1);
  assert.equal(workflowSteps[0].status, "queued");
  for (const table of ["work_units", "tasks", "run_sessions", "approval_requests"]) assert.equal(count(table), 0, table);
  assert.equal(count("ling_turns"), 1);
  assert.equal(count("conversation_items"), 1);
});

for (const failedTable of ["channel_workflow_steps", "conversation_items"]) {
  test(`failed ${failedTable} creation rolls back its workflow, steps and canonical source together`, async t => {
    const f = await fixture(t), path = `/channels/${f.channel.id}/workflows`;
    f.store.database.exec(`CREATE TEMP TRIGGER force_workflow_creation_failure BEFORE INSERT ON ${failedTable}
      BEGIN SELECT RAISE(ABORT, 'forced workflow creation failure'); END`);
    const response = await f.api(path, "POST", { objective: "Must not leave a partial workflow", customTemplate: f.template });
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.match(response.body.message, /forced workflow creation failure/);
    for (const table of ["channel_workflows", "channel_workflow_steps", "ling_turns", "conversation_items", "work_units", "run_sessions"])
      assert.equal(Number(f.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0, table);
    assert.equal(f.store.database.isTransaction, false);
    assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
    f.store.database.exec("DROP TRIGGER force_workflow_creation_failure");
    assert.equal((await f.api(path, "POST", { objective: "Retry explicit creation", customTemplate: f.template })).status, 201);
    assert.equal(f.store.listRuns({ limit: 10 }).length, 0);
  });
}
