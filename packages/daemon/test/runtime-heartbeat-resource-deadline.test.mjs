import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { runProviderMediaJobExecution } from "../dist/features/media/provider-executor.js";
import { runWorkflowMediaJobExecution } from "../dist/features/media/workflows/workflow-executor.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { retryRuntimeWorkUnit, startRuntimeWorkUnit, transitionWorkUnitCancelled, transitionWorkUnitTerminal } from "../dist/runtime/work-units.js";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";

const WINDOW = 6 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const secretResolver = { resolve: ref => ({ ref, configured: false }), status: ref => ({ ref, configured: false }) };

/** Real local HTTP submission acknowledgments; never a replaced fetch/Response. */
async function remoteFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", bytes => chunks.push(bytes));
    request.on("end", () => {
      requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "POST" && request.url === "/api/prompt") response.end(JSON.stringify({ prompt_id: "b011-workflow-operation" }));
      else if (request.method === "POST" && request.url.endsWith("/contents/generations/tasks")) {
        response.end(JSON.stringify({ id: "b011-provider-operation", status: "queued" }));
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: "B011 unexpected owned route" })); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b011-host-heartbeat-")));
  let stores, supervisor, remote;
  const pending = new Set(), activeRuns = new ActiveRunRegistry();
  t.after(async () => {
    activeRuns.suspendAll("daemon_restart");
    await Promise.allSettled(pending);
    stores?.mediaLocalExecutions.beginShutdown();
    await stores?.mediaLocalExecutions.waitForIdle();
    supervisor?.releaseAll();
    stores?.closeAll();
    await remote?.close();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b011-host-heartbeat-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  stores = new RunStoreRegistry(requested => { assert.equal(requested, cwd); return createSqliteRunStore(cwd, paths); });
  supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  remote = await remoteFixture();
  const store = stores.getStore(cwd), observed = [];
  const originalHeartbeat = store.recordRuntimeHeartbeat.bind(store);
  // Transparent observation only: the actual input reaches real Core validation
  // and its SQLite transaction, and its actual result is returned unchanged.
  store.recordRuntimeHeartbeat = input => {
    const result = originalHeartbeat(input);
    observed.push({ input: structuredClone(input), result,
      slots: store.database.prepare("SELECT * FROM runtime_semaphore_slots WHERE attempt_id=? ORDER BY id").all(input.attemptId),
      heartbeat: store.database.prepare("SELECT * FROM runtime_heartbeats WHERE id=?").get(result.id) });
    return result;
  };
  const hooks = {
    startRuntimeWorkUnit: input => startRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
    recoverRuntimeWorkUnit: input => retryRuntimeWorkUnit({ ...input, runtimeSupervisor: supervisor }),
    transitionRuntimeWorkUnitTerminal: input => transitionWorkUnitTerminal(input.store, input),
    transitionRuntimeWorkUnitCancelled: input => transitionWorkUnitCancelled(input.store, input.workUnitId, input.attemptId, input.reason),
  };
  return { cwd, store, stores, supervisor, activeRuns, pending, observed, hooks, remote };
}

function assertCommittedDeadline(observation) {
  assert.ok(observation, "the actual Host entry must invoke and commit Core heartbeat");
  const { input, heartbeat, slots } = observation;
  assert.equal(new Date(input.ts).toISOString(), input.ts);
  assert.equal(new Date(input.resourceExpiresAt).toISOString(), input.resourceExpiresAt);
  assert.equal(Date.parse(input.resourceExpiresAt) - Date.parse(input.ts), WINDOW,
    "Host must use the same captured ts for exactly the trusted six-hour deadline");
  assert.equal(heartbeat.ts, input.ts);
  assert.equal(heartbeat.attempt_id, input.attemptId);
  assert.equal(heartbeat.runtime_instance_id, input.runtimeInstanceId);
  assert.equal(heartbeat.fencing_token, input.fencingToken);
  assert.ok(slots.length > 0, "this is a real occupied runtime slot, not only a call-argument assertion");
  for (const slot of slots) {
    assert.equal(slot.status, "active");
    assert.equal(slot.last_renewed_at, input.ts);
    assert.ok(slot.expires_at >= input.resourceExpiresAt);
    assert.equal(slot.work_unit_id, input.workUnitId);
    assert.equal(slot.runtime_instance_id, input.runtimeInstanceId);
    assert.equal(slot.fencing_token, input.fencingToken);
  }
}

test("B011 actual Run orchestrator supplies its captured heartbeat deadline and commits occupied slots", { timeout: 15_000 }, async t => {
  const f = await fixture(t), createdAt = now();
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "B011 no-model fixture",
    providerId: "b011-local-chat", model: "b011-scripted-model", api: "openai-completions", baseUrl: `${f.remote.url}/v1`,
    authHeader: false, contextWindow: 128_000, maxTokens: 16_384, capabilities: ["chat"], enabled: true }, createdAt);
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Owned scripted Runner", checkedAt: createdAt });
  const thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "B011 heartbeat fixture",
    objective: "Observe a real Host heartbeat without contacting a model." }, createdAt);
  let runnerCalls = 0;
  const adapter = { prepareTaskInput: prepareFixtureTaskInput, async runTask(options) {
    runnerCalls++;
    options.onEvent?.({ type: "assistant_text_delta", text: "B011 scripted completion; no external model." });
    return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "B011 scripted completion." }] };
  } };
  const errors = [];
  const execution = executeRunRequest({ cwd: f.cwd, workspaceCwd: f.cwd, threadId: thread.id, teammateId: "ling_agent",
    providerPresetId: provider.id, tools: [], agentDir: join(f.cwd, "fixture-agent"),
    task: { id: "b011-task-snapshot", title: "B011 heartbeat", prompt: "One fixture response, no tools." },
    idempotencyKey: "b011-run", createdByActor: "local-user" },
  { ...createDetachedRunExecutionSink(), writeError: (status, body) => errors.push({ status, body }) },
  createRunnerRegistry([{ id: "pi", displayName: "B011 scripted Runner", status: "enabled", adapter }]),
  f.stores, f.activeRuns, f.supervisor, secretResolver, {}, {});
  f.pending.add(execution);
  let runId;
  try { runId = await execution; } finally { f.pending.delete(execution); }
  assert.deepEqual(errors, []);
  assert.equal(runnerCalls, 1);
  assert.equal(f.store.getRun(runId).status, "succeeded");
  assertCommittedDeadline(f.observed.find(item => item.input.source === "runner" && item.input.detail?.event === "runner_started"));
  assert.deepEqual(f.remote.requests, [], "scripted Runner must not contact the configured model endpoint");
});

for (const source of ["provider", "workflow"]) {
  test(`B011 actual ${source} media executor supplies and commits its own heartbeat deadline`, { timeout: 15_000 }, async t => {
    const f = await fixture(t), createdAt = now();
    let job;
    if (source === "provider") {
      const provider = f.store.createProviderPreset({ kind: "seedance", displayName: "B011 local video submission",
        providerId: "seedance", model: "doubao-seedance-1-0-pro-250528", api: "media-job", baseUrl: f.remote.url,
        capabilities: ["video_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, createdAt);
      f.store.setProviderSecret(provider.id, "b011-owned-fixture-secret", createdAt);
      f.store.updateProviderPreset(provider.id, { apiKeyRef: `local:${provider.id}` }, createdAt);
      f.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Owned loopback server", checkedAt: createdAt });
      job = f.store.createMediaJob({ providerPresetId: provider.id, operation: "video_generate", prompt: "B011 fixture only." }, createdAt);
    } else {
      const connection = f.store.createMediaWorkflowConnection({ name: "B011 local workflow", baseUrl: f.remote.url,
        authMode: "none", networkPolicy: "trusted_private_network", protocolVariant: "jobs_v1" }, createdAt);
      f.store.updateMediaWorkflowConnection(connection.id, { status: "ready",
        health: { ok: true, message: "Owned loopback server", checkedAt: createdAt, protocolVariant: "jobs_v1" } }, createdAt);
      const definition = f.store.createMediaWorkflowDefinition({ connectionId: connection.id, name: "B011 graph" }, createdAt);
      const version = f.store.createMediaWorkflowVersion({ workflowDefinitionId: definition.id,
        sourceDigest: "b011-owned-graph", graphSnapshot: { "1": { class_type: "SaveImage", inputs: {} } },
        inputFields: [], outputRules: [{ nodeId: "1", artifactType: "image", collect: "first" }],
        validation: { ok: true, errors: [], warnings: [], checkedAt: createdAt } }, createdAt);
      f.store.updateMediaWorkflowDefinition(definition.id, { status: "ready", currentVersionId: version.id }, createdAt);
      job = f.store.createMediaJob({ workflowVersionId: version.id, operation: "image_generate", prompt: "B011 fixture only." }, createdAt);
    }
    const execute = source === "provider" ? runProviderMediaJobExecution : runWorkflowMediaJobExecution;
    const result = await execute({ cwd: f.cwd, storeRegistry: f.stores, secretResolver, mediaJobId: job.id, hooks: f.hooks });
    assert.equal(result.statusCode, 202, JSON.stringify(result.body));
    assert.equal(f.remote.requests.length, 1, "the actual owned server must receive one real submission");
    assert.equal(f.remote.requests[0].method, "POST");
    const observation = f.observed.find(item => item.input.source === "provider");
    assertCommittedDeadline(observation);
    assert.equal(f.store.getMediaJobExecutionHandle(job.id).attemptId, observation.input.attemptId);
    assert.equal(f.store.getMediaJob(job.id).status, "running", "remote queued ACK is not a fabricated completion");
  });
}
