import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type RunStore, type WorkflowGraph } from "@ling-stack/core";
import { workflowGraphFingerprintV1, type NodeRerunGenerationResponseV1 } from "@ling-stack/contracts";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import type { ResolvedDaemonConfig } from "../dist/config.js";
import { handleGetNodeRerunGeneration } from "../dist/features/runs/node-rerun-generation.js";
import { prepareNodeRerunTargetExecution } from "../dist/features/runs/node-rerun-targets.js";
import { observeNodeRerunAdmission } from "../dist/features/runs/node-rerun-observation.js";
import { createFixture, createTerminalRun, prepareInput, ENDED_AT, NOW } from "./support/node-rerun-fixture.ts";

const database = (store: RunStore) => (store as unknown as { readonly database: DatabaseSync }).database;
const changes = (store: RunStore) => database(store).prepare("SELECT total_changes() AS n").get()!.n;
const rows = (store: RunStore, table: string) => database(store).prepare(`SELECT * FROM ${table}`).all();
const originalResults = (store: RunStore) => Object.fromEntries([
  "channel_workflows", "channel_workflow_steps", "artifacts", "run_evaluations", "run_evaluation_grades",
].map(table => [table, rows(store, table)]));

async function fixture(t: TestContext, branching = true) {
  let supervisor: RuntimeSupervisor | undefined;
  t.after(() => supervisor?.releaseAll());
  let f = await createFixture(t, { preparedExecution: true });
  const downstream = branching ? ["join", "left", "right"] : [];
  if (branching) {
    const addedNodes = ["left", "right", "join", "unrelated"].map(id => ({ id, kind: "step" as const,
      name: id, prompt: `Execute ${id}`, teammateId: "teammate_builtin_engineer" }));
    const addedEdges = [
      ["target", "left"], ["target", "right"], ["left", "join"], ["right", "join"], ["upstream", "unrelated"],
    ].map(([fromNodeId, toNodeId]) => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId: fromNodeId!, toNodeId: toNodeId!,
      condition: { kind: "all_succeeded" as const } }));
    const graph: WorkflowGraph = { ...f.graph, nodes: [...f.graph.nodes, ...addedNodes], edges: [...f.graph.edges, ...addedEdges] };
    f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata, workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, ENDED_AT);
    const stepIds = new Map([["upstream", f.upstreamStep.id], ["target", f.targetStep.id]]);
    for (const [index, node] of addedNodes.entries()) {
      const step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, position: index + 2,
        title: node.name, prompt: node.prompt, toParticipantId: node.teammateId, toParticipantLabel: "Engineer", status: "succeeded",
        metadata: { graphId: graph.id, graphNodeId: node.id,
          dependsOnStepIds: graph.edges.filter(edge => edge.toNodeId === node.id).map(edge => stepIds.get(edge.fromNodeId)!) } }, NOW);
      stepIds.set(node.id, step.id);
      const execution = await createTerminalRun(f.store, { id: `run-${node.id}`, taskId: `task-${node.id}`, stepId: step.id,
        channelId: f.workflow.channelId, teammateId: node.teammateId, cwd: f.cwd, policy: f.policy,
        title: node.name, prompt: node.prompt });
      const artifact = f.store.createArtifact({ id: `artifact-${node.id}`, runId: execution.run.id, type: "json",
        path: `fixture/${node.id}.json`, sealedPayload: { output: node.id }, createdAt: NOW });
      f.store.updateChannelWorkflowStep(step.id, { taskId: execution.task.id, runId: execution.run.id,
        metadata: { ...step.metadata, contextArtifactId: artifact.id, outputArtifactIds: [artifact.id] } }, ENDED_AT);
    }
    f = { ...f, graph, workflow: f.store.getChannelWorkflow(f.workflow.id)! };
  }
  supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    runners: {}, runtimeTools: {}, channels: {}, sandbox: {}, harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } } as ResolvedDaemonConfig);
  const runtime = supervisor.getRuntime(f.cwd, f.store);
  const prepared = f.store.prepareNodeRerunIntent(prepareInput(f, { downstreamNodeIds: downstream }));
  assert.ok(prepared.status === "created");
  const record = prepared.record;
  const now = new Date().toISOString();
  const revalidate = (intent: typeof record.intent) => observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns,
    intent, now });
  const approval = f.store.requestNodeRerunApproval({ recordId: record.id, now, revalidate });
  assert.ok(approval.status === "created");
  f.store.approveApprovalRequest(approval.approval.id, { resolvedBy: "local-user", decisionKind: "approve_once" }, now);
  const prepareTarget = () => f.store.prepareNodeRerunTarget({ recordId: record.id, runtimeInstanceId: runtime.runtimeInstanceId, now,
    revalidate, prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(f.store, source, f.target.attempt.id, taskId) });
  return { ...f, record, supervisor, prepareTarget };
}

test("F5-07 invalidates the exact descendant diamond only in its new generation and preserves source results", async t => {
  const f = await fixture(t), before = originalResults(f.store);
  const originalRuns = rows(f.store, "run_sessions"), originalUnits = rows(f.store, "work_units"), originalAttempts = rows(f.store, "work_unit_attempts");
  assert.equal(f.store.getNodeRerunGeneration(f.record.id), undefined);
  const prepared = f.prepareTarget(); assert.ok(prepared.status === "created");
  const writes = changes(f.store), generation = f.store.getNodeRerunGeneration(f.record.id)!;
  assert.equal(generation.generationId, prepared.target.generationId);
  assert.equal(generation.graphVersionDigest, f.record.intent.source.graphVersionDigest);
  assert.equal(generation.replacement.runId, prepared.target.runId);
  assert.deepEqual(generation.invalidatedDownstream.map(node => node.nodeId), ["join", "left", "right"]);
  assert.ok(generation.invalidatedDownstream.every(node => node.status === "invalidated" && !node.executionAuthorized));
  assert.deepEqual(generation.reusedUpstream, f.record.intent.source.dependencyClosure.upstream);
  assert.equal(generation.reusedUpstream[0]!.outputArtifacts[0]!.artifactId, f.upstreamOutput.id);
  assert.equal(generation.evidenceBasis, "frozen_target_preparation");
  assert.equal(generation.revalidateBeforeExecution, true);
  assert.equal(generation.downstreamDispatch, "disabled");
  assert.equal(generation.executionAuthorized, false);
  assert.equal(generation.graphMutation, "none");
  assert.deepEqual(f.store.getNodeRerunGeneration(f.record.id), generation);
  assert.equal(changes(f.store), writes);
  assert.deepEqual(originalResults(f.store), before);
  for (const [table, oldRows] of [["run_sessions", originalRuns], ["work_units", originalUnits], ["work_unit_attempts", originalAttempts]] as const)
    assert.deepEqual(rows(f.store, table).filter(row => oldRows.some(old => old.id === row.id)), oldRows);
  assert.equal(rows(f.store, "runtime_run_queue").length, 0);
  assert.equal(rows(f.store, "resource_leases").length, 0);
  assert.equal(rows(f.store, "runtime_semaphore_slots").length, 0);
  f.supervisor.releaseAll(); f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    const writes = changes(reopened);
    assert.deepEqual(reopened.getNodeRerunGeneration(f.record.id), generation);
    assert.equal(changes(reopened), writes);
    assert.deepEqual(originalResults(reopened), before);
  } finally { reopened.close(); }
});

test("F5-07 leaf projection has no invalidation and later mutable evidence cannot replace its frozen pins", async t => {
  const f = await fixture(t, false), prepared = f.prepareTarget(); assert.ok(prepared.status === "created");
  const generation = f.store.getNodeRerunGeneration(f.record.id)!;
  assert.deepEqual(generation.invalidatedDownstream, []);
  database(f.store).prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("f".repeat(64), f.upstreamOutput.id);
  f.store.updateApprovalPolicy({ allowedWritePaths: [] }, new Date().toISOString());
  const writes = changes(f.store);
  assert.deepEqual(f.store.getNodeRerunGeneration(f.record.id), generation);
  assert.equal(changes(f.store), writes);
  const observed = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: f.record.intent, now: new Date().toISOString() });
  assert.equal(observed.admission.decision, "blocked");
  assert.equal(generation.revalidateBeforeExecution, true);
});

test("F5-07 HTTP reads only initialized source scope, reports missing targets and fails closed on corrupt receipts", async t => {
  const f = await fixture(t, false);
  const registry = new RunStoreRegistry(() => assert.fail("generation reads must not initialize a Store"), { recoverOnOpen: false });
  // The initialized registry entry is supplied by the existing workspace owner.
  const ready = new RunStoreRegistry(() => f.store, { recoverOnOpen: false }); ready.getStore(f.cwd);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture"), parts = url.pathname.split("/");
    handleGetNodeRerunGeneration(request, response, url, url.searchParams.get("cwd") === f.cwd ? ready : registry,
      decodeURIComponent(parts[2]!), decodeURIComponent(parts[5]!));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${f.target.run.id}/node-rerun/intents/${f.record.id}/generation`);
  url.searchParams.set("cwd", f.cwd);
  assert.equal((await fetch(url)).status, 404);
  assert.ok(f.prepareTarget().status === "created");
  const writes = changes(f.store), response = await fetch(url), body = await response.json() as NodeRerunGenerationResponseV1;
  assert.equal(response.status, 200);
  assert.deepEqual(body.generation, f.store.getNodeRerunGeneration(f.record.id));
  assert.equal(body.executionAuthorized, false);
  assert.equal(changes(f.store), writes);
  assert.ok(!JSON.stringify(body).includes("Frozen memory and skill"));
  assert.ok(!JSON.stringify(body).includes(f.cwd));
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 405);
  url.pathname = url.pathname.replace(f.target.run.id, f.upstream.run.id);
  assert.equal((await fetch(url)).status, 404);
  url.pathname = url.pathname.replace(f.upstream.run.id, f.target.run.id);
  database(f.store).prepare("UPDATE node_rerun_targets SET generation_id='foreign-generation' WHERE intent_id=?").run(f.record.id);
  const corrupt = await fetch(url); assert.equal(corrupt.status, 503);
  assert.deepEqual(await corrupt.json(), { error: "node_rerun_generation_unavailable",
    message: "The Host could not read a consistent node rerun generation." });
  url.searchParams.set("cwd", f.cwd + "/cold"); assert.equal((await fetch(url)).status, 503);
  url.search = ""; assert.equal((await fetch(url)).status, 400);
});
