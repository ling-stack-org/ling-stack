import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

// All process configuration, SQLite facts and artifacts belong to this fixture.
// The Runner uses the real Pi input assembler but makes no model/tool requests.
const ownedRoot = await mkdtemp(join(tmpdir(), "ling-a23-budget-heartbeat-"));
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

const { createSqliteRunStore, DEFAULT_WORKSPACE_ID } = await import("@ling-stack/core");
const { createDaemonServer } = await import("../dist/index.js");
const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
const emptySecrets = {
  status: ref => ({ ref, configured: false }),
  resolve: ref => ({ ref, configured: false }),
};

/** Loopback public routes and real SQLite/orchestration; no safety gates replaced. */
async function createCase(t) {
  const cwd = await mkdtemp(join(ownedRoot, "workspace-"));
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  const store = createSqliteRunStore(cwd), runnerInputs = [];
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } }, {
    secretResolver: emptySecrets,
    storeFactory: requestedCwd => { assert.equal(requestedCwd, cwd); return store; },
    runner: { prepareTaskInput: prepareFixtureTaskInput, async runTask(input) {
      const message = `A23_HEARTBEAT_REPORT_${runnerInputs.length + 1}`;
      runnerInputs.push({ runId: input.runId, cwd: input.cwd, task: structuredClone(input.task),
        tools: [...input.tools], provider: input.provider.provider, model: input.provider.model });
      input.onEvent?.({ type: "run_start", taskId: input.task.id, cwd: input.cwd,
        provider: input.provider.provider, model: input.provider.model });
      input.onEvent?.({ type: "message_end", role: "assistant", text: message });
      input.onEvent?.({ type: "run_end", taskId: input.task.id, messageCount: 1 });
      return { taskId: input.task.id, events: [], messages: [{ role: "assistant", content: message }] };
    } },
  });
  t.after(async () => { await daemon.stop(); });
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.server.address().port}`;
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "glm", displayName: "A23 heartbeat no-model fixture",
    providerId: "a23-heartbeat-static", model: "a23-heartbeat-model", api: "google-generative-ai",
    baseUrl: "https://a23-heartbeat-fixture.invalid/v1", authHeader: false, enabled: true,
    capabilities: ["chat"], input: ["text"] }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready",
    message: "Owned scripted Runner only, no provider transport", checkedAt: now });

  function url(path) { return `${base}${path}?cwd=${encodeURIComponent(cwd)}`; }
  async function api(path, body) {
    const response = await fetch(url(path), { method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }) });
    const result = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  return { cwd, store, provider, runnerInputs, url, api };
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).filter(block => block.trim()).map(block => {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith("event: "))?.slice(7);
    const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
    return { event, data: data ? JSON.parse(data) : undefined };
  });
}

/** Build the resumable source through the real normal-conversation input route. */
async function createNormalSource(fixture) {
  const response = await fetch(fixture.url("/conversations/stream"), {
    method: "POST", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "A23_NORMAL_SOURCE: record an ordinary local conversation, without tools.",
      providerPresetId: fixture.provider.id, tools: ["read"], permissionPreset: "read_only",
      idempotencyKey: "a23-real-normal-source" }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = parseSse(raw), terminal = events.find(item => item.event === "done")?.data;
  assert.ok(terminal?.run?.id, `normal source must finish through public SSE: ${raw}`);
  const run = fixture.store.getRun(terminal.run.id), thread = fixture.store.getLingThread(run.threadId);
  assert.equal(run.status, "succeeded");
  assert.equal(thread.kind, "conversation");
  assert.equal(thread.id, terminal.thread.id);
  assert.equal(thread.lastRunId, run.id);
  assert.equal(run.requestSnapshot.providerPresetId, fixture.provider.id);
  assert.ok(run.requestSnapshot.normalConversationAcceptedSnapshotId,
    "source is a real accepted ordinary conversation, not a seeded Run shortcut");
  assert.ok(run.requestSnapshot.normalConversationPreparedExecutionRef,
    "source passed the actual prepared SDK execution boundary");
  assert.equal(fixture.runnerInputs.length, 1);
  assert.equal(fixture.runnerInputs[0].runId, run.id);
  assert.equal(terminal.assistantMessage.content, "A23_HEARTBEAT_REPORT_1");
  return { run, thread };
}

async function waitForCompletedAutomation(fixture, response) {
  assert.ok(response.automationRun?.runId, JSON.stringify(response));
  const deadline = Date.now() + 10_000;
  let automationRun, run;
  do {
    automationRun = fixture.store.getAutomationRun(response.automationRun.id);
    run = fixture.store.getRun(response.automationRun.runId);
    if (automationRun?.status === "succeeded" && run?.status === "succeeded") return { automationRun, run };
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(`automation did not complete: ${JSON.stringify({ automationRun, run })}`);
}

test("A23 public heartbeat preserves normal source lineage and full instructions independently of max1", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t), source = await createNormalSource(fixture);
  const instruction = ["A23_HEARTBEAT_INSTRUCTION_BEGIN", "", "Continue this ordinary conversation.", "",
    "```txt", "A23_HEARTBEAT_FULL_BLOCK", "The whole multiline instruction must remain intact.", "```", "",
    "A23_HEARTBEAT_INSTRUCTION_END"].join("\n");
  const created = await fixture.api("/automations", { kind: "custom_prompt", title: "A23 real heartbeat",
    automationMode: "heartbeat", targetThreadId: source.thread.id, trigger: { type: "manual" },
    promptTemplate: { templateVersion: 1, promptMarkdown: instruction, maxContextItems: 1,
      contextSelectors: [{ kind: "recent_runs", limit: 8 }, { kind: "pending_approvals", limit: 8 }] },
  });
  assert.equal(created.automation.automationMode, "heartbeat");
  assert.equal(created.automation.targetThreadId, source.thread.id);
  assert.equal(created.automation.target.threadId, source.thread.id);
  assert.equal(created.automation.promptTemplate.maxContextItems, 1);
  assert.notEqual(created.thread.id, source.thread.id, "definition bookkeeping is not the resumed conversation");
  const response = await fixture.api(`/automations/${created.automation.id}/run`, { idempotencyKey: "a23-heartbeat-slot" });
  const { automationRun, run } = await waitForCompletedAutomation(fixture, response);
  assert.equal(fixture.runnerInputs.length, 2, "only the source and its heartbeat are dispatched");
  const actual = fixture.runnerInputs[1];
  assert.equal(actual.runId, run.id);
  assert.equal(run.threadId, source.thread.id);
  assert.equal(run.parentRunId, source.run.id);
  assert.equal(run.continuationReason, "manual_resume");
  assert.equal(run.requestSnapshot.threadId, source.thread.id);
  assert.equal(run.requestSnapshot.parentRunId, source.run.id);
  assert.equal(run.requestSnapshot.providerPresetId, source.run.requestSnapshot.providerPresetId);
  assert.equal(run.providerPresetId, source.run.providerPresetId);
  assert.deepEqual(actual.tools, fixture.runnerInputs[0].tools);
  assert.equal(actual.cwd, fixture.runnerInputs[0].cwd);
  assert.equal(actual.provider, fixture.runnerInputs[0].provider);
  assert.equal(actual.model, fixture.runnerInputs[0].model);
  const turn = fixture.store.getLingTurnForRun(run.id), sourceTurn = fixture.store.getLingTurnForRun(source.run.id);
  assert.notEqual(turn.id, sourceTurn.id);
  assert.equal(turn.threadId, source.thread.id);
  assert.equal(turn.sourceTurnId, sourceTurn.id);
  assert.equal(fixture.store.getLingThread(source.thread.id).lastRunId, run.id);
  for (const prompt of [actual.task.prompt, run.taskSnapshot.prompt, run.requestSnapshot.task.prompt]) {
    assert.ok(prompt.includes(instruction), "max1 cannot clip the independent heartbeat instruction");
    assert.equal(prompt.split(instruction).length - 1, 1);
    assert.match(prompt, /scheduled Ling thread heartbeat/);
    assert.equal(prompt.includes("# Automation Context"), false);
    assert.equal(prompt.includes("## Selected References"), false);
    assert.equal(prompt.includes("Use the following deterministic Ling context"), false);
  }
  assert.equal(response.context, undefined, "heartbeat response has no deterministic context projection");
  assert.equal(automationRun.contextPreviewArtifactId, undefined);
  assert.deepEqual(fixture.store.listArtifacts(run.id), [], "no refs/context artifact is created for a heartbeat");
  assert.equal(fixture.store.listAutomationRuns({ automationId: created.automation.id }).length, 1);
});

function durableSnapshot(fixture, automationId) {
  return {
    automation: fixture.store.getAutomationDefinition(automationId),
    automationRuns: fixture.store.listAutomationRuns({ limit: 100 }),
    runs: fixture.store.listRuns({ limit: 100 }),
    threads: fixture.store.listLingThreads({ includeArchived: true, limit: 100 }),
    turns: fixture.store.listLingTurns({ threadId: fixture.store.getAutomationDefinition(automationId).threadId }),
    artifacts: fixture.store.listRuns({ limit: 100 }).flatMap(run => fixture.store.listArtifacts(run.id)),
  };
}

test("A23 completed-key replay precedes validation of a now-invalid persisted context budget", { timeout: 25_000 }, async t => {
  const fixture = await createCase(t);
  const created = await fixture.api("/automations", { kind: "custom_prompt", title: "A23 completed duplicate",
    target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd: fixture.cwd }, trigger: { type: "manual" },
    promptTemplate: { templateVersion: 1, promptMarkdown: "A23 completed one-time report.", maxContextItems: 1,
      contextSelectors: [{ kind: "recent_runs", limit: 8 }] },
    executionPolicy: { providerPresetId: fixture.provider.id, allowedTools: ["read"], approvalProfile: { mode: "none" } },
  });
  const idempotencyKey = "a23-already-completed-slot";
  const first = await fixture.api(`/automations/${created.automation.id}/run`, { idempotencyKey });
  const completed = await waitForCompletedAutomation(fixture, first);
  assert.equal(fixture.runnerInputs.length, 1);
  assert.ok(completed.automationRun.contextPreviewArtifactId, "control actually used the deterministic builder");
  assert.ok(fixture.store.paths.databasePath.startsWith(`${ownedRoot}/`));
  const database = new DatabaseSync(fixture.store.paths.databasePath);
  try {
    const result = database.prepare("UPDATE automation_definitions SET prompt_template_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...created.automation.promptTemplate, maxContextItems: 0 }), created.automation.id);
    assert.equal(result.changes, 1);
  } finally {
    database.close();
  }
  const before = durableSnapshot(fixture, created.automation.id);
  assert.equal(before.automation.promptTemplate.maxContextItems, 0);
  const duplicate = await fixture.api(`/automations/${created.automation.id}/run`, { idempotencyKey });
  assert.equal(duplicate.automationRun.id, completed.automationRun.id);
  assert.equal(duplicate.automationRun.runId, completed.run.id);
  assert.equal(duplicate.automationRun.status, "succeeded");
  assert.equal(duplicate.run.id, completed.run.id);
  assert.equal(duplicate.run.status, "succeeded");
  assert.equal(duplicate.context, undefined, "completed duplicate does not rebuild the now-invalid context");
  assert.equal(fixture.runnerInputs.length, 1, "same completed key cannot start another Runner");
  assert.deepEqual(durableSnapshot(fixture, created.automation.id), before,
    "duplicate replay cannot mutate its old facts or create queued work, turns or artifacts");
  assert.equal(fixture.store.findAutomationRunByIdempotencyKey(idempotencyKey).id, completed.automationRun.id);
});
