import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDeterministicTerminalReportContent, createCompositeSecretResolver, createSqliteRunStore } from "../../../core/dist/index.js";
import { createDaemonServer } from "../../dist/index.js";
import { listAllExecutionActionsForRun } from "../../dist/features/runs/execution-actions.js";
import { startLoopbackPiProvider } from "./loopback-pi-provider-fixture.mjs";

/** Real default Pi adapter and local SSE, with no fake runner or emitted tool events. */
export async function startRealPiChannelFixture(cwd, respond, hostConfig = {}) {
  const stores = new Map();
  const upstream = await startLoopbackPiProvider((request) => {
    if (!request.stream) return { text: "Static loopback provider check OK." };
    const system = systemText(request);
    if (/context segmentation policy proposer/i.test(system)) {
      return { text: JSON.stringify({ action: "uncertain", candidateSegmentIds: [] }) };
    }
    if (/terminal report synthesizer/i.test(system)) {
      const snapshotText = request.messages.map(messageText).join("\n")
        .match(/Evidence snapshot: (\{[^\n]+\})/u)?.[1];
      assert.ok(snapshotText, "report synthesis must receive real Host evidence");
      return { text: JSON.stringify(buildDeterministicTerminalReportContent(JSON.parse(snapshotText))) };
    }
    return respond(request);
  });
  const daemon = createDaemonServer({ ...hostConfig, host: "127.0.0.1", port: 0, channels: { intentSelector: true, terminalReports: true } }, {
    secretResolver: createCompositeSecretResolver({ env: { LING_TEST_LOOPBACK_KEY: "static-loopback-only" } }),
    storeFactory: (storeCwd) => { const store = createSqliteRunStore(storeCwd); stores.set(storeCwd, store); return store; },
  });
  try {
    await daemon.start();
  } catch (error) {
    await upstream.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${daemon.server.address().port}`,
    providerOverrides: { providerId: "loopback-static", model: "static-tools", api: "openai-completions",
      baseUrl: upstream.baseUrl, apiKeyRef: "env:LING_TEST_LOOPBACK_KEY", capabilities: ["chat", "tool_call"] },
    get store() { return stores.get(cwd); },
    get selectorRequests() { return upstream.requests.filter((request) => /channel intent selector/i.test(systemText(request))); },
    get requests() { return upstream.requests; },
    async close() { await daemon.stop(); await upstream.close(); },
    async assertWorkflowCompleted(created, { files, actionTypes, participantIds, approvalCount = files.length, settleTimeoutMs = 10_000 }) {
      const store = stores.get(cwd);
      const workflowId = created.autoStartedWorkflow.workflow.id;
      const source = store.getConversationItem((created.userItem ?? created.message).id);
      const steps = created.autoStartedWorkflow.workflowSteps;
      const stepIds = new Set(steps.map((step) => step.id));
      const approvals = new Set();
      const deadline = Date.now() + settleTimeoutMs;
      while (Date.now() < deadline) {
        for (const approval of store.listApprovalRequests({ status: "pending", limit: 20 })) {
          assert.ok(stepIds.has(store.getRun(approval.runId)?.workflowStepId), "only this workflow may request an approval");
          store.approveApprovalRequest(approval.id, { reason: "Static test user approves the exact file create once" }, new Date().toISOString());
          approvals.add(approval.id);
        }
        const workflow = store.getChannelWorkflow(workflowId);
        const report = store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 20 })[0];
        if (workflow.status === "succeeded" && store.getLingTurn(source.turnId)?.status === "succeeded" && report?.resultItemId) break;
        assert.ok(!["failed", "cancelled", "blocked"].includes(workflow.status), JSON.stringify({ status: workflow.status,
          steps: steps.map((step) => { const current = store.getChannelWorkflowStep(step.id); return { id: current.id,
            status: current.status, blocker: current.blocker, actions: current.runId ? listAllExecutionActionsForRun(store, current.runId) : [] }; }) }));
        await new Promise((done) => setTimeout(done, 25));
      }
      const workflow = store.getChannelWorkflow(workflowId);
      assert.equal(workflow.status, "succeeded", JSON.stringify(workflow));
      assert.equal(workflow.metadata.completionGate.status, "verified");
      assert.equal(store.getLingTurn(source.turnId).status, "succeeded");
      const runs = steps.map((step) => {
        const current = store.getChannelWorkflowStep(step.id);
        assert.equal(current.status, "succeeded");
        assert.equal(current.metadata.delegatedOutcome.kind, "completed");
        assert.equal(current.metadata.executionVerification.status, "verified");
        const run = store.getRun(current.runId);
        assert.equal(run.status, "succeeded");
        assert.equal(run.requestSnapshot.workflowOperationExecution.plan.bindingVersion, 1);
        assert.deepEqual(run.requestSnapshot.workflowOperationExecution.ownedOperationIds, current.metadata.executionOperationIds);
        const sourceInput = run.requestSnapshot.runnerExecutionInput;
        assert.ok(sourceInput, "actual channel execution must retain the full SDK source input");
        assert.equal(sourceInput.input.task.id, run.taskId);
        const sent = upstream.requests.find((request) => request.stream && request.messages.some((message) =>
          message.role === "user" && messageText(message) === sourceInput.preparedInput.userPrompt));
        assert.ok(sent, "persisted SDK input must match an actual loopback request, not model narration");
        assert.equal(systemText(sent), sourceInput.preparedInput.systemPrompt);
        assert.deepEqual((sent.tools ?? []).map((tool) => tool.function.name), sourceInput.preparedInput.tools.map((tool) => tool.name));
        return run;
      });
      const actions = runs.flatMap((run) => {
        const actions = listAllExecutionActionsForRun(store, run.id);
        for (const action of actions) assert.ok(Number.isSafeInteger(action.sourceEventSequence), "actual Pi actions require a Host event position");
        return actions.sort((left, right) => left.sourceEventSequence - right.sourceEventSequence);
      });
      assert.deepEqual(actions.map((action) => action.status), actionTypes.map(() => "succeeded"));
      assert.deepEqual(actions.map((action) => action.actionType), actionTypes);
      assert.equal(approvals.size, approvalCount, "every expected side effect must have its own actual approval");
      for (const file of files) {
        const writeAction = actions.find((action) => action.actionType === "write" && action.targetRefs.some((ref) => ref.path === file.path));
        assert.ok(writeAction, JSON.stringify({ file, actions }));
        const owningRun = runs.find((run) => run.id === writeAction.runId);
        assert.equal(await readFile(resolve(owningRun.cwd, file.path), "utf8"), file.content);
      }
      const reports = store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 20 });
      assert.equal(reports.length, 1);
      const report = reports[0];
      assert.equal(report.outcomeStatus, "succeeded");
      assert.equal(report.report.outcome.status, "succeeded");
      assert.equal(report.synthesisMode, "model", "static SSE report must pass the real report validator");
      assert.deepEqual(report.evidenceSnapshot.participants.map((participant) => participant.agentId).sort(), [...participantIds].sort());
      for (const file of files) assert.ok(report.evidenceSnapshot.operations.some((operation) => operation.changedPaths.includes(file.path)),
        `TerminalReport must contain Host-backed changed path ${file.path}`);
      for (const file of files) assert.ok(report.evidenceSnapshot.artifacts.some((artifact) => artifact.changedPaths.includes(file.path)),
        `TerminalReport artifact lineage must retain the actual output ${file.path}`);
      assert.equal(store.getConversationItem(report.resultItemId).kind, "terminal_report");
      assert.equal(store.listConversationItemsForTurn({ turnId: source.turnId }).filter((item) => item.id === report.resultItemId).length, 1);
      assert.equal(store.listStateTransitionEvents({ entityType: "turn", entityId: source.turnId }).filter((event) => event.toStatus === "succeeded").length, 1);
      assert.equal(store.listControlPlaneEvents({ workspaceId: source.workspaceId, domains: ["work_units"],
        entityType: "terminal_report", entityId: report.id, action: "terminal_report.published", limit: 20 }).length, 1);
      return { runs, actions, report };
    },
  };
}

export function systemText(request) {
  return request.messages.filter((message) => message.role === "system" || message.role === "developer").map(messageText).join("\n");
}

export function messageText(message) {
  return typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.map((part) => typeof part.text === "string" ? part.text : "").join("\n") : "";
}
