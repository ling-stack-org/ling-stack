import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore, readRunProgressFrozenExecution } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { readStoredRunnerExecution, rebuildExistingRunRequest } from "../dist/features/runs/existing-run-request.js";
import { ensureEmptyGitRepo } from "./git-test-helpers.mjs";
import { fileOperationCandidate } from "./support/channel-operation-candidate-fixture.mjs";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

for (const continuationMode of ["off", "enforce"]) {
test(`real Pi plus loopback SSE completes source-bound read and exclusive create with continuations=${continuationMode}`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-pi-e2e-"));
  await ensureEmptyGitRepo(cwd);
  await writeFile(join(cwd, "input.txt"), "source");
  const sourceQuote = "请让 Engineer 读取 input.txt 并创建 output.txt，内容为原文大写。";
  const owner = { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" };
  const execution = { schemaVersion: 2, operations: [
    fileOperationCandidate({ id: "read-input", kind: "file_read", path: "input.txt", sourceQuote, owner }),
    fileOperationCandidate({ id: "create-output", path: "output.txt", sourceQuote, owner, dependsOn: ["read-input"],
      contentSource: { kind: "generated_objective", text: "原文大写", sourceQuote: "原文大写", inputOperationIds: ["read-input"] } }),
  ] };
  let executionTurns = 0;
  const upstream = await startLoopbackPiProvider((request) => {
    const text = JSON.stringify(request.messages);
    if (/channel intent selector/.test(text)) return { text: JSON.stringify({ action: "execute", reason: "Static explicit source-bound graph", execution }) };
    if (/context segmentation policy proposer/.test(text)) return { text: JSON.stringify({ action: "uncertain", candidateSegmentIds: [] }) };
    executionTurns += 1;
    if (executionTurns === 1) return { tool: "read", input: { path: "input.txt" } };
    if (executionTurns === 2) {
      assert.ok(request.messages.some((message) => message.role === "tool" && message.content === "source"),
        "generated create must receive the actual Pi read result");
      return { tool: "write", input: { path: "output.txt", content: "SOURCE" } };
    }
    return { text: "Read input.txt and created output.txt with SOURCE." };
  });
  const stores = new Map();
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, channels: { intentSelector: true, terminalReports: false },
    harness: { continuations: { mode: continuationMode }, toolBroker: { mode: continuationMode } } }, {
    secretResolver: createCompositeSecretResolver({ env: { LING_TEST_LOOPBACK_KEY: "static-loopback-only" } }),
    storeFactory: (storeCwd) => { const store = createSqliteRunStore(storeCwd); stores.set(storeCwd, store); return store; },
  });
  try {
    await daemon.start();
    const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
    const scope = `cwd=${encodeURIComponent(cwd)}`;
    const provider = (await json(`${baseUrl}/providers?${scope}`, { kind: "glm", displayName: "Loopback static Pi", providerId: "loopback-static",
      model: "static-tools", api: "openai-completions", baseUrl: upstream.baseUrl, capabilities: ["chat", "tool_call"],
      input: ["text"], authHeader: false, apiKeyRef: "env:LING_TEST_LOOPBACK_KEY", enabled: true })).provider;
    const store = stores.get(cwd);
    store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: new Date().toISOString(), message: "Loopback fixture only" });
    await json(`${baseUrl}/teammates/teammate_builtin_engineer?${scope}`, { providerPresetId: provider.id }, "PATCH");
    const channel = (await json(`${baseUrl}/channels?${scope}`, { name: "Actual Pi bounded effects", boundPath: cwd, status: "active",
      defaultProviderPresetId: provider.id, autoReplyMode: "mentions_only", allowedTools: ["read", "write"] })).channel;
    await json(`${baseUrl}/teammates/${owner.participantId}/channels?${scope}`, { memberships: [{ channelId: channel.id }] }, "PUT");
    const turn = await json(`${baseUrl}/channels/${channel.id}/turns?${scope}`, { body: sourceQuote, teammateId: "ling_agent",
      requestAiReply: true });
    assert.ok(turn.autoStartedWorkflow, JSON.stringify({ turn, upstreamRequests: upstream.requests.length,
      decisions: store.listChannelIntentDecisions({ channelId: channel.id, limit: 10 }), runs: store.listRuns({ limit: 10 }) }));
    const [step] = turn.autoStartedWorkflow.workflowSteps;
    const deadline = Date.now() + 10_000;
    let run;
    let approvedCreates = 0;
    while (Date.now() < deadline) {
      for (const approval of store.listApprovalRequests({ status: "pending", limit: 20 })) {
        store.approveApprovalRequest(approval.id, { reason: "Static test user approves this bounded create once" }, new Date().toISOString());
        approvedCreates += 1;
      }
      const current = store.getChannelWorkflowStep(step.id);
      run = current.runId ? store.getRun(current.runId) : undefined;
      if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(run?.status, "succeeded", JSON.stringify({ runId: run?.id, error: run?.error,
      blocker: store.getChannelWorkflowStep(step.id).blocker, executionTurns }));
    const execution = readRunProgressFrozenExecution(run);
    assert.equal(run.taskSnapshot.prompt, execution.input.task.prompt);
    assert.equal(run.requestSnapshot.task.prompt, execution.input.task.prompt);
    assert.notEqual(store.getTask(run.taskId).prompt, execution.input.task.prompt,
      "the canonical Task remains the objective; the Run freezes its rendered workflow input");
    assert.equal(readStoredRunnerExecution(run)?.preparedInput.fingerprint, execution.preparedInput.fingerprint);
    const tampered = structuredClone(run);
    tampered.taskSnapshot.prompt += " changed after acceptance";
    assert.throws(() => readRunProgressFrozenExecution(tampered), { code: "checkpoint.lineage_mismatch" });
    if (continuationMode === "enforce") {
      const request = rebuildExistingRunRequest(run, "daemon_recovery");
      assert.deepEqual(request.task, execution.input.task);
      const checkpoints = store.database.prepare("SELECT source_event_seq FROM run_progress_checkpoints WHERE run_id=?").all(run.id);
      assert.ok(checkpoints.length >= 2, "both settled tool rounds must checkpoint before further model I/O");
    }
    assert.equal(executionTurns, 3, "read, create and final each occur once, without replaying tools");
    assert.equal(approvedCreates, 1);
    assert.equal(await readFile(join(cwd, "output.txt"), "utf8"), "SOURCE");
    assert.equal(await readFile(join(cwd, "input.txt"), "utf8"), "source");
    const actions = await fetch(`${baseUrl}/execution-actions?${scope}&runId=${run.id}`).then((response) => response.json());
    assert.deepEqual(actions.actions.filter((action) => action.status === "succeeded").map((action) => action.actionType).sort(), ["read", "write"]);
    assert.equal(store.getChannelWorkflowStep(step.id).metadata.executionVerification.status, "verified");
    assert.equal(run.requestSnapshot.workflowOperationExecution.plan.bindingVersion, 1);
  } finally {
    await daemon.stop(); await upstream.close(); await rm(cwd, { recursive: true, force: true });
  }
});
}

async function json(url, body, method = "POST") {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
