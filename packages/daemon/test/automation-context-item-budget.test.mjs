import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

// The Daemon, Store, provider configuration and all selector facts belong to
// this process. No model transport, external work polling, daily DB or Git setup.
const ownedRoot = await mkdtemp(join(tmpdir(), "ling-a23-context-item-budget-"));
const ownedHome = join(ownedRoot, "home"), initialWorkspace = join(ownedRoot, "initial-workspace");
await Promise.all([mkdir(ownedHome), mkdir(initialWorkspace)]);
const environmentKeys = ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"];
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.LING_STACK_HOME = ownedHome;
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = initialWorkspace;
after(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(ownedRoot, { recursive: true, force: true });
});

const { createSqliteRunStore, getBuiltinAutomationTemplate, parseExternalWorkflowMarkdown,
  readAutomationContextItemBudget, validateAutomationDraft, automationDraftToCreateRequest } = await import("@ling-stack/core");
const { createDaemonServer } = await import("../dist/index.js");
const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
const emptySecrets = {
  status: ref => ({ ref, configured: false }),
  resolve: ref => ({ ref, configured: false }),
};
const timestamp = index => new Date(Date.UTC(2026, 9, 15) + index * 1_000).toISOString();
const refIdentity = ref => ({ kind: ref.kind, id: ref.id });

/** Real public HTTP routes and orchestration, with a no-LLM recording runner. */
async function createCase(t) {
  const cwd = await mkdtemp(join(ownedRoot, "workspace-"));
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const store = createSqliteRunStore(cwd), runnerInputs = [];
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    secretResolver: emptySecrets,
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    runner: { prepareTaskInput: prepareFixtureTaskInput, async runTask(input) {
      runnerInputs.push({ task: structuredClone(input.task), cwd: input.cwd });
      input.onEvent?.({ type: "run_start", taskId: input.task.id, cwd: input.cwd,
        provider: input.provider.provider, model: input.provider.model });
      input.onEvent?.({ type: "run_end", taskId: input.task.id, messageCount: 1 });
      return { taskId: input.task.id, events: [], messages: [{ role: "assistant", content: "A23 owned fixture report" }] };
    } },
  });
  t.after(async () => { await daemon.stop(); });
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.server.address().port}`;
  const provider = store.createProviderPreset({ kind: "glm", displayName: "A23 no-model fixture",
    providerId: "a23-static-chat", model: "a23-static-model", api: "google-generative-ai",
    baseUrl: "https://a23-fixture.invalid/v1", authHeader: false, enabled: true,
    capabilities: ["chat"], input: ["text"] }, timestamp(0));
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready",
    message: "Scripted runner fixture only; no provider request", checkedAt: timestamp(0) });
  const channel = store.createChannel({ name: "A23 context budget", boundPath: cwd,
    defaultProviderPresetId: provider.id, allowedTools: ["read", "grep", "find", "ls"] }, timestamp(0));

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, {
      method, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function api(path, body) {
    const result = await request(path, { method: body === undefined ? "GET" : "POST", body });
    assert.ok(result.status >= 200 && result.status < 300, `${result.status}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const items = seedThirtyThreeWholeItems(store, channel, cwd);
  return { cwd, store, channel, runnerInputs, items, api, request,
    async createAutomation(maxContextItems) {
      const template = getBuiltinAutomationTemplate("daily_brief");
      const result = await api("/automations", { kind: "daily_brief", title: "A23 deterministic daily brief",
        channelId: channel.id, trigger: { type: "manual" },
        ...(maxContextItems === undefined ? {} : { promptTemplate: { ...template.defaultPromptTemplate, maxContextItems } }),
      });
      return result.automation;
    },
  };
}

/** Seed legal public Store facts, not context output, returned refs or fake rows. */
function seedThirtyThreeWholeItems(store, channel, cwd) {
  const objective = "A23_BRIEF_BEGIN\n\n```txt\nwhole brief body, not a character budget\n```\n\nA23_BRIEF_END";
  const brief = store.updateChannelBrief(channel.id, { objective, scope: "Owned context budget fixture",
    acceptanceCriteria: [], openQuestions: [], risks: [], updatedBy: "local-user" }, timestamp(0));
  const runs = [], approvals = [], externalWork = [], artifacts = [];
  const workflow = parseExternalWorkflowMarkdown("---\nsource:\n  kind: github\n  repository: a23/owned\n---\nReview {{ item.identifier }} from supplied facts only.");
  for (let index = 1; index <= 8; index++) {
    const tag = String(index).padStart(2, "0"), at = timestamp(index);
    const taskId = `A23_RUN_${tag}_END`;
    const run = store.createRun({ id: `run_a23_context_${tag}`, cwd, taskId, channelId: channel.id,
      providerName: "a23-static-chat", providerModel: "a23-static-model",
      taskSnapshot: { id: taskId, title: taskId, prompt: "Owned selector fixture, never dispatched" },
      providerSnapshot: { provider: "a23-static-chat", model: "a23-static-model" },
      requestSnapshot: { cwd }, createdAt: at });
    runs.push({ kind: "run", id: run.id, marker: taskId });
    const approvalTitle = `A23_APPROVAL_${tag}_END`;
    const approval = store.createApprovalRequest({ runId: run.id, taskId, channelId: channel.id,
      actionType: "bash", risk: "medium", title: approvalTitle, description: "Owned pending approval, never executed",
      payload: { type: "bash", cwd, command: "a23-fixture-not-executed", riskFlags: [] } }, at);
    approvals.push({ kind: "approval", id: approval.id, marker: approvalTitle });
    const artifactTitle = `A23_ARTIFACT_${tag}_BEGIN\n\n\`\`\`txt\nwhole artifact summary ${tag}\n\`\`\`\n\nA23_ARTIFACT_${tag}_END`;
    const artifact = store.createArtifact({ id: `artifact_a23_context_${tag}`, runId: run.id,
      type: "markdown", path: join(cwd, `a23-artifact-${tag}.md`), title: artifactTitle, createdAt: at });
    artifacts.push({ kind: "artifact", id: artifact.id, marker: artifactTitle });
    const identifier = `a23/owned#${index}`;
    const imported = store.createOrReuseExternalWorkWorkflow({ channelId: channel.id,
      externalWorkItem: { id: `a23-owned-issue-${tag}`, sourceKind: "github", kind: "github_issue",
        identifier, title: `A23 owned issue ${tag}`, state: "open", labels: [],
        payloadRef: `a23:owned:${tag}`, idempotencyKey: `a23:owned:${tag}`, updatedAt: at },
      workflowDefinition: workflow, renderedPrompt: `Review ${identifier} from owned facts; never dispatched.` }, at);
    assert.equal(imported.duplicate, false);
    externalWork.push({ kind: "external_work", id: imported.externalWork.id, marker: identifier });
  }
  // Built-in daily selectors retain their configured order. Within each list,
  // distinct durable timestamps make newest-first order unambiguous.
  const items = [{ kind: "channel_brief", id: brief.id, marker: objective },
    ...runs.reverse(), ...approvals.reverse(), ...externalWork.reverse(), ...artifacts.reverse()];
  assert.equal(items.length, 33);
  const seededRuns = store.listRuns({ limit: 100 }).filter(run => run.channelId === channel.id);
  assert.equal(seededRuns.length, 8);
  assert.equal(store.listApprovalRequests({ status: "pending", limit: 100 }).length, 8);
  assert.equal(store.listExternalWorkRecords({ channelId: channel.id, limit: 100 }).length, 8);
  assert.equal(seededRuns.reduce((count, run) => count + store.listArtifacts(run.id).length, 0), 8);
  return items;
}

function assertWholeItemParity(context, items, expectedCount) {
  assert.equal(context.selectedRefs.length, expectedCount, "global budget applies before refs and whole body rendering");
  assert.deepEqual(context.selectedRefs.map(refIdentity), items.slice(0, expectedCount).map(refIdentity),
    "stable selector/item order selects one shared bounded set");
  for (const [index, item] of items.entries()) {
    const anchor = item.marker.split("\n")[0];
    assert.equal(context.contextMarkdown.includes(anchor), index < expectedCount,
      `an omitted item cannot leave even a partial body for ${item.kind}:${item.id}`);
    assert.equal(context.contextMarkdown.includes(item.marker), index < expectedCount,
      `refs and complete body agree for ${item.kind}:${item.id}`);
    assert.equal(context.renderedPrompt.includes(anchor), index < expectedCount,
      `the rendered model prompt cannot retain a partial omitted item for ${item.kind}:${item.id}`);
    assert.equal(context.renderedPrompt.includes(item.marker), index < expectedCount,
      `rendered model prompt cannot retain an omitted body for ${item.kind}:${item.id}`);
  }
}

async function runAndReadRecordedRequest(fixture, automation, idempotencyKey = "a23-owned-manual-run") {
  const result = await fixture.api(`/automations/${automation.id}/run`, { idempotencyKey });
  assert.ok(result.automationRun.runId, "public route admitted a real Run");
  const deadline = Date.now() + 10_000;
  while (fixture.store.getRun(result.automationRun.runId)?.status !== "succeeded" && Date.now() < deadline) await delay(15);
  const run = fixture.store.getRun(result.automationRun.runId);
  assert.equal(run?.status, "succeeded", JSON.stringify(run));
  assert.equal(fixture.runnerInputs.length, 1, "one real scripted runner invocation, not a StartRun spy");
  assert.ok(result.context?.contextMarkdown);
  assert.ok(fixture.runnerInputs[0].task.prompt.includes(result.context.contextMarkdown),
    "actual prepared runner task contains the context returned by the production run builder");
  assert.ok(run.taskSnapshot.prompt.includes(result.context.contextMarkdown),
    "durable real Run request retains the same context, not an API-only refs projection");
  const artifact = fixture.store.listArtifacts(run.id)
    .find(item => item.id === result.automationRun.contextPreviewArtifactId);
  assert.ok(artifact, "the production run persists its context-preview artifact");
  const artifactPath = join(fixture.store.paths.artifactsDir, artifact.path);
  assert.ok(artifactPath.startsWith(`${ownedRoot}/`), "only this fixture's artifact is read");
  const artifactMarkdown = await readFile(artifactPath, "utf8");
  assert.ok(artifactMarkdown.includes(result.context.renderedPrompt),
    "the durable context artifact retains the same bounded complete prompt");
  const references = artifactMarkdown.split("## Selected References\n\n")[1]?.split("\n\n## Warnings")[0];
  assert.ok(references, "the real artifact records selected refs separately from model text");
  for (const item of fixture.items) {
    assert.equal(references.includes(`- ${item.kind}:${item.id}`),
      result.context.selectedRefs.some(ref => ref.kind === item.kind && ref.id === item.id),
      `artifact refs cannot retain an omitted ${item.kind}:${item.id}`);
  }
  return result;
}

test("A23 public preview applies the built-in max32 to 33 eligible whole context items", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation();
  assert.equal(automation.promptTemplate.maxContextItems, 32, "the real built-in default is the budget under test");
  const preview = await fixture.api(`/automations/${automation.id}/preview`, {});
  assert.equal(fixture.runnerInputs.length, 0, "preview is deterministic and cannot invoke a model runner");
  assertWholeItemParity(preview.context, fixture.items, 32);
  assert.ok(preview.context.warnings.some(warning => /omit|budget|maxContextItems|truncat/i.test(warning)),
    "a budget omission must be disclosed, not silently presented as complete context");
});

test("A23 public run enforces max32 in refs, durable request and actual runner prompt", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation();
  const result = await runAndReadRecordedRequest(fixture, automation);
  assertWholeItemParity(result.context, fixture.items, 32);
  const prompt = fixture.runnerInputs[0].task.prompt;
  for (const [index, item] of fixture.items.entries()) {
    assert.equal(prompt.includes(item.marker.split("\n")[0]), index < 32,
      `the actual runner cannot receive even a partial omitted body for ${item.kind}:${item.id}`);
    assert.equal(prompt.includes(item.marker), index < 32,
      `the actual runner receives only selected whole items for ${item.kind}:${item.id}`);
  }
});

test("A23 sufficient budget preserves all 33 items through public preview and actual run", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(64);
  const preview = await fixture.api(`/automations/${automation.id}/preview`, {});
  assertWholeItemParity(preview.context, fixture.items, 33);
  assert.deepEqual(preview.context.warnings, []);
  const result = await runAndReadRecordedRequest(fixture, automation);
  assertWholeItemParity(result.context, fixture.items, 33);
  assert.deepEqual(result.context.selectedRefs, preview.context.selectedRefs);
  assert.deepEqual(result.context.warnings, []);
});

test("A23 one-item budget keeps the entire multiline brief in public preview and Runner", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(1);
  const preview = await fixture.api(`/automations/${automation.id}/preview`, {});
  assertWholeItemParity(preview.context, fixture.items, 1);
  assert.match(preview.context.warnings.join("\n"), /omitted 32 whole context items/);
  const result = await runAndReadRecordedRequest(fixture, automation);
  assertWholeItemParity(result.context, fixture.items, 1);
  assert.deepEqual(result.context.selectedRefs, preview.context.selectedRefs);
});

test("A23 omitted budget retains custom selector limits rather than inventing a max32", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const { maxContextItems: _builtinBudget, ...promptTemplate } = getBuiltinAutomationTemplate("daily_brief").defaultPromptTemplate;
  const { automation } = await fixture.api("/automations", { kind: "custom_prompt", title: "A23 omitted cap",
    channelId: fixture.channel.id, trigger: { type: "manual" }, promptTemplate });
  assert.equal(automation.promptTemplate.maxContextItems, undefined);
  const preview = await fixture.api(`/automations/${automation.id}/preview`, {});
  assertWholeItemParity(preview.context, fixture.items, 33);
  assert.deepEqual(preview.context.warnings, []);
  const result = await runAndReadRecordedRequest(fixture, automation);
  assertWholeItemParity(result.context, fixture.items, 33);
  assert.deepEqual(result.context.warnings, []);
});

function storedFactCounts(store) {
  return {
    definitions: store.listAutomationDefinitions({ includeArchived: true, limit: 500 }).length,
    drafts: store.listAutomationDrafts({ includeTerminal: true, limit: 500 }).length,
    threads: store.listLingThreads({ kind: "automation", includeArchived: true, limit: 500 }).length,
    automationRuns: store.listAutomationRuns({ limit: 500 }).length,
    runs: store.listRuns({ limit: 500 }).length,
  };
}

function draftRequest(fixture, promptTemplate) {
  return { source: "manual", partialAutomation: { kind: "custom_prompt", title: "A23 editable draft",
    channelId: fixture.channel.id, trigger: { type: "manual" }, promptTemplate } };
}

function assertInvalidBudgetResponse(response) {
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.match(response.body.message, /maxContextItems.*positive.*safe integer/i);
}

test("A23 public create, PATCH and draft admissions reject invalid budgets before any mutation", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(2);
  const { draft } = await fixture.api("/automation-drafts", draftRequest(fixture, automation.promptTemplate));
  assert.equal(draft.status, "ready_for_confirmation");
  const thread = fixture.store.getLingThread(automation.threadId);
  const before = storedFactCounts(fixture.store);
  // Only JSON-representable values are used here; non-finite values are covered
  // at Core admission rather than silently becoming null during JSON encoding.
  for (const invalidBudget of [0, -1, 0.5, null, "2", true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const promptTemplate = { ...automation.promptTemplate, maxContextItems: invalidBudget };
    assertInvalidBudgetResponse(await fixture.request("/automations", { method: "POST", body: {
      kind: "custom_prompt", title: "A23 must not create a thread", channelId: fixture.channel.id,
      trigger: { type: "manual" }, promptTemplate,
    } }));
    assertInvalidBudgetResponse(await fixture.request(`/automations/${automation.id}`, { method: "PATCH",
      body: { title: "A23 must not replace title", promptTemplate } }));
    assertInvalidBudgetResponse(await fixture.request("/automation-drafts", { method: "POST",
      body: draftRequest(fixture, promptTemplate) }));
    assertInvalidBudgetResponse(await fixture.request(`/automation-drafts/${draft.id}`, { method: "PATCH",
      body: { partialAutomation: { title: "A23 must not replace draft", promptTemplate } } }));
    assert.deepEqual(storedFactCounts(fixture.store), before);
    assert.deepEqual(fixture.store.getAutomationDefinition(automation.id), automation);
    assert.deepEqual(fixture.store.getLingThread(automation.threadId), thread);
    assert.deepEqual(fixture.store.getAutomationDraft(draft.id), draft);
  }
  const maximum = await fixture.request(`/automations/${automation.id}`, { method: "PATCH", body: {
    promptTemplate: { ...automation.promptTemplate, maxContextItems: Number.MAX_SAFE_INTEGER },
  } });
  assert.equal(maximum.status, 200);
  assert.equal(maximum.body.automation.promptTemplate.maxContextItems, Number.MAX_SAFE_INTEGER);
  assert.equal(fixture.runnerInputs.length, 0);
});

test("A23 Core writers and draft domain reject invalid budgets without relying on HTTP", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(2);
  const { draft } = await fixture.api("/automation-drafts", draftRequest(fixture, automation.promptTemplate));
  const before = storedFactCounts(fixture.store);
  const invalidBudgets = [0, -1, 0.5, null, "2", true, {}, [], NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const [index, invalidBudget] of invalidBudgets.entries()) {
    const promptTemplate = { ...automation.promptTemplate, maxContextItems: invalidBudget };
    const expected = /maxContextItems.*positive.*safe integer/i;
    assert.throws(() => readAutomationContextItemBudget(invalidBudget), expected);
    assert.throws(() => fixture.store.createAutomationDefinition({ ...automation,
      id: `automation_a23_invalid_${index}`, promptTemplate }, timestamp(100)), expected);
    assert.throws(() => fixture.store.updateAutomationDefinition(automation.id,
      { title: "A23 must not replace title", promptTemplate }, timestamp(100)), expected);
    assert.throws(() => fixture.store.createAutomationDraft({ ...draft,
      id: `automation_draft_a23_invalid_${index}`, promptTemplate }, timestamp(100)), expected);
    assert.throws(() => fixture.store.updateAutomationDraft(draft.id,
      { title: "A23 must not replace draft", promptTemplate }, timestamp(100)), expected);
    const invalidDraft = { ...draft, promptTemplate };
    const validated = validateAutomationDraft(invalidDraft);
    assert.equal(validated.status, "needs_user_input");
    assert.ok(validated.warnings.some(warning => warning.code === "invalid_prompt_template" && expected.test(warning.message)));
    assert.throws(() => automationDraftToCreateRequest(invalidDraft), /not ready for confirmation/);
    assert.deepEqual(storedFactCounts(fixture.store), before);
    assert.deepEqual(fixture.store.getAutomationDefinition(automation.id), automation);
    assert.deepEqual(fixture.store.getAutomationDraft(draft.id), draft);
  }
  assert.equal(readAutomationContextItemBudget(undefined), undefined);
  assert.equal(readAutomationContextItemBudget(1), 1);
  assert.equal(readAutomationContextItemBudget(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  const discarded = fixture.store.discardAutomationDraft(draft.id, timestamp(101));
  assert.deepEqual(fixture.store.updateAutomationDraft(draft.id,
    { promptTemplate: { ...draft.promptTemplate, maxContextItems: 0 } }, timestamp(102)), discarded,
  "a terminal draft remains a no-op, not a new failing write path");
  assert.equal(fixture.runnerInputs.length, 0);
});

/** Historical corrupt input is inserted only into this fixture's owned SQLite. */
function persistOwnedBadDefinitionBudget(fixture, automation) {
  assert.ok(fixture.store.paths.databasePath.startsWith(`${ownedRoot}/`));
  const database = new DatabaseSync(fixture.store.paths.databasePath);
  try {
    const result = database.prepare("UPDATE automation_definitions SET prompt_template_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...automation.promptTemplate, maxContextItems: 0 }), automation.id);
    assert.equal(result.changes, 1);
  } finally {
    database.close();
  }
}

test("A23 historical invalid definition cannot reserve queued work and can recover using the same key", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(1);
  persistOwnedBadDefinitionBudget(fixture, automation);
  const before = storedFactCounts(fixture.store), idempotencyKey = "a23-invalid-then-repaired";
  assertInvalidBudgetResponse(await fixture.request(`/automations/${automation.id}/preview`, { method: "POST", body: {} }));
  for (let attempt = 0; attempt < 2; attempt++) {
    assertInvalidBudgetResponse(await fixture.request(`/automations/${automation.id}/run`, { method: "POST", body: { idempotencyKey } }));
    assert.deepEqual(storedFactCounts(fixture.store), before);
    assert.equal(fixture.store.findAutomationRunByIdempotencyKey(idempotencyKey), undefined,
      "bad context must not create a queued/idempotent tombstone");
    assert.equal(fixture.runnerInputs.length, 0);
  }
  assert.throws(() => fixture.store.updateAutomationDefinition(automation.id, { status: "enabled" }, timestamp(100)),
    /maxContextItems.*positive.*safe integer/i);
  const repaired = await fixture.request(`/automations/${automation.id}`, { method: "PATCH", body: {
    promptTemplate: automation.promptTemplate,
  } });
  assert.equal(repaired.status, 200);
  const result = await runAndReadRecordedRequest(fixture, repaired.body.automation, idempotencyKey);
  assertWholeItemParity(result.context, fixture.items, 1);
  const duplicate = await fixture.api(`/automations/${automation.id}/run`, { idempotencyKey });
  assert.equal(duplicate.automationRun.id, result.automationRun.id);
  assert.equal(fixture.runnerInputs.length, 1, "a duplicate key must not redispatch after successful recovery");
  persistOwnedBadDefinitionBudget(fixture, automation);
  const paused = fixture.store.updateAutomationDefinition(automation.id,
    { status: "paused", nextRunAt: null, lastErrorMessage: "A23 quarantined invalid context" }, timestamp(101));
  assert.equal(paused.status, "paused", "historical bad context must still be quarantinable");
  assert.equal(fixture.store.archiveAutomationDefinition(automation.id, timestamp(102)).status, "archived");
});

test("A23 historical invalid ready draft fails preview and transactional confirmation before thread creation", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(1);
  const { draft } = await fixture.api("/automation-drafts", draftRequest(fixture, automation.promptTemplate));
  assert.equal(draft.status, "ready_for_confirmation");
  assert.ok(fixture.store.paths.databasePath.startsWith(`${ownedRoot}/`));
  const database = new DatabaseSync(fixture.store.paths.databasePath);
  try {
    const changed = database.prepare("UPDATE automation_drafts SET draft_json = json_set(draft_json, '$.promptTemplate.maxContextItems', 0) WHERE id = ?")
      .run(draft.id);
    assert.equal(changed.changes, 1);
  } finally {
    database.close();
  }
  const historical = fixture.store.getAutomationDraft(draft.id), before = storedFactCounts(fixture.store);
  for (const suffix of ["preview", "confirm"]) {
    const rejected = await fixture.request(`/automation-drafts/${draft.id}/${suffix}`, { method: "POST", body: {} });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.draft.status, "needs_user_input");
    assert.ok(rejected.body.draft.warnings.some(warning => warning.code === "invalid_prompt_template"));
    assert.deepEqual(storedFactCounts(fixture.store), before);
    assert.deepEqual(fixture.store.getAutomationDraft(draft.id), historical,
      "rejection cannot silently rewrite historical source data");
  }
  assert.equal(fixture.store.confirmAutomationDraft(historical, timestamp(100)).outcome, "not_ready");
  assert.deepEqual(storedFactCounts(fixture.store), before);
  const repaired = await fixture.request(`/automation-drafts/${draft.id}`, { method: "PATCH", body: {
    partialAutomation: { promptTemplate: automation.promptTemplate },
  } });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.draft.status, "ready_for_confirmation");
  const preview = await fixture.api(`/automation-drafts/${draft.id}/preview`, {});
  assertWholeItemParity(preview.context, fixture.items, 1);
  const confirmed = await fixture.api(`/automation-drafts/${draft.id}/confirm`, {});
  assert.equal(confirmed.automation.promptTemplate.maxContextItems, 1);
  assert.equal(fixture.runnerInputs.length, 0, "confirming a manual definition does not start a Runner");
});

test("A23 exhausted public preview retains later missing and unsupported warnings without empty sections", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const automation = await fixture.createAutomation(1);
  const updated = await fixture.request(`/automations/${automation.id}`, { method: "PATCH", body: { promptTemplate: {
    ...automation.promptTemplate, contextSelectors: [...automation.promptTemplate.contextSelectors,
      { kind: "channel_brief", channelId: "channel_a23_missing_owned" }, { kind: "doctor_summary" }, { kind: "mcp_status" }],
  } } });
  assert.equal(updated.status, 200);
  const { context } = await fixture.api(`/automations/${automation.id}/preview`, {});
  assertWholeItemParity(context, fixture.items, 1);
  for (const expected of [/No channel brief found/, /doctor_summary/, /mcp_status/, /omitted 32 whole context items/]) {
    assert.match(context.warnings.join("\n"), expected);
  }
  assert.deepEqual(context.contextMarkdown.match(/^## .+$/gm), ["## Channel Brief", "## Warnings"],
    "exhausted sections must not leave standalone headings or filter descriptions");
  assert.equal(fixture.runnerInputs.length, 0);
});
