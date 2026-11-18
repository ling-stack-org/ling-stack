import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { HostRunCapacityStore, createRuntimeHostCapacityStoreBinding } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import { createCompositeSecretResolver } from "@ling-stack/core";
import type { NodeRerunTargetDispatchResponseV1 } from "@ling-stack/contracts";
import { createRuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import type { McpBroker } from "../dist/context.js";
import { handleDispatchNodeRerunTarget } from "../dist/features/runs/node-rerun-targets.js";
import { prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { createFixture, prepareInput } from "./support/node-rerun-fixture.ts";

async function listen(server: Server): Promise<{ readonly port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port };
}

test("F5 dispatches a prepared target through the real Pi adapter and a local OpenAI-compatible provider", {
  timeout: 30_000,
}, async t => {
  const requests: Record<string, unknown>[] = [];
  const providerServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"rerun completed\"},\"finish_reason\":null}]}\n\n"
      + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
      + "data: [DONE]\n\n",
    );
  });
  const providerAddress = await listen(providerServer);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => providerServer.close(error => error ? reject(error) : resolve()));
    providerServer.closeAllConnections();
  });

  const capacity = createRuntimeHostCapacityStoreBinding();
  const provider = {
    provider: "node-rerun-live-fixture",
    model: "fixture-model",
    api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    authHeader: false,
    reasoning: false,
  };
  const f = await createFixture(t, { preparedExecution: true, runtimeHostCapacityBinding: capacity.binding, provider });
  const host = new HostRunCapacityStore({ globalDatabasePath: join(f.cwd, "host-capacity.sqlite") });
  t.after(() => host.close());
  assert.equal(host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: 1, installedAt: new Date().toISOString() }).status, "installed");

  const admission = createRuntimeHostCapacityAdmission({ host, workspace: capacity.workspace });
  const supervisor = new RuntimeSupervisor(resolveConfig({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd }),
    undefined, undefined, admission);
  t.after(() => supervisor.releaseAll());
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f));
  assert.equal(prepared.status, "created", JSON.stringify(prepared));
  assert.ok(prepared.status === "created");
  const now = new Date().toISOString();
  const revalidate = (intent: typeof prepared.record.intent) =>
    observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now });
  const approval = f.store.requestNodeRerunApproval({ recordId: prepared.record.id, now, revalidate });
  assert.equal(approval.status, "created", JSON.stringify(approval));
  assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const target = f.store.prepareNodeRerunTarget({ recordId: prepared.record.id, runtimeInstanceId: runtime.runtimeInstanceId,
    now, revalidate, prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) });
  assert.equal(target.status, "created", JSON.stringify(target));
  assert.ok(target.status === "created");

  const storeRegistry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false });
  storeRegistry.getStore(f.cwd);
  const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Pi live fixture", status: "enabled", adapter: new PiRunnerAdapter() }]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    void handleDispatchNodeRerunTarget(request, response, url, 1_048_576, storeRegistry, f.activeRuns, supervisor,
      runnerRegistry, createCompositeSecretResolver({ env: {} }), {} as McpBroker, f.target.run.id, prepared.record.id)
      .catch(() => { if (!response.headersSent) { response.writeHead(500); response.end(JSON.stringify({ error: "node_rerun_dispatch_failed" })); } });
  });
  const address = await listen(server);
  t.after(async () => {
    storeRegistry.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
  });

  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(f.target.run.id)}/node-rerun/intents/${encodeURIComponent(prepared.record.id)}/target/dispatch`);
  url.searchParams.set("cwd", f.cwd);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await response.json() as NodeRerunTargetDispatchResponseV1;
  assert.equal(response.status, 202, JSON.stringify({ body, run: f.store.getRun(target.target.runId),
    unit: f.store.getWorkUnit(target.target.fence.workUnitId), attempt: f.store.getWorkUnitAttempt(target.target.fence.attemptId),
    events: f.store.listRuntimeEvents(target.target.fence.workUnitId), host: host.counts() }));
  assert.equal(body.dispatchStatus, "dispatched");
  assert.equal(body.executionAuthorized, true);
  assert.equal(body.runId, target.target.runId);
  assert.equal(requests.length, 1, "the real provider must receive exactly one request");
  assert.equal(requests[0]?.model, provider.model);
  assert.equal(f.store.getRun(target.target.runId)?.status, "succeeded");
  assert.equal(f.store.getWorkUnit(target.target.fence.workUnitId)?.status, "succeeded");
  assert.equal(f.store.getWorkUnitAttempt(target.target.fence.attemptId)?.status, "succeeded");
  assert.equal(f.store.getNodeRerunTarget(prepared.record.id)?.executionAuthorized, false,
    "the durable target remains a historical receipt; execution authority is represented by the dispatched capacity proof");
  assert.deepEqual(host.counts(), { held: 0, released: 1, total: 1 });

  const duplicate = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const duplicateBody = await duplicate.json() as NodeRerunTargetDispatchResponseV1;
  assert.equal(duplicate.status, 200, JSON.stringify(duplicateBody));
  assert.equal(duplicateBody.dispatchStatus, "already_dispatched");
  assert.equal(requests.length, 1, "duplicate dispatch must not replay the provider request");
});
