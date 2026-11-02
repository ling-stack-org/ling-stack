import { createHash } from "node:crypto";
import { applyConversationModeToEffectiveRunPolicySnapshot, captureRunProgressCheckpointLineage,
  resolveSessionRunPolicy } from "../../dist/index.js";
import { SqliteRunSuspensionStore } from "../../dist/storage/sqlite/run-suspension-store.js";

/** Real Core persisted input for the existing isolated delegation fixture only. */
export function prepareSuspensionSource(f, now) {
  const run = f.store.getRun(f.root.id), task = { id: run.taskId, title: "Suspension fixture", prompt: "Read isolated evidence once." };
  const thread = run.threadId ? f.store.getLingThread(run.threadId) : f.store.createLingThread({ kind: "conversation",
    teammateId: "ling_agent", title: task.title, objective: task.prompt }, now);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: f.cwd }).snapshot, thread.conversationMode.mode);
  const provider = { provider: run.providerName, model: run.providerModel, api: "openai-responses", baseUrl: "https://provider.invalid/v1" };
  const prepared = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Fixture system", userPrompt: task.prompt,
    model: { id: run.providerModel, provider: run.providerName, api: provider.api, baseUrl: provider.baseUrl, reasoning: false,
      input: ["text"], contextWindow: 1000, maxTokens: 100 }, thinkingLevel: "off",
    tools: ["read", "write"].map(name => ({ name, description: `Fixture ${name}`, parameters: { type: "object" } })) };
  const execution = { schemaVersion: 1, runnerId: "pi", input: { cwd: f.cwd, task, provider, tools: ["read", "write"], systemPrompt: "Fixture system" },
    toolHydrationEnabled: false, preparedInput: { ...prepared, fingerprint: createHash("sha256").update(JSON.stringify(prepared)).digest("hex") } };
  f.store.database.prepare(`UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,context_view_id=?,context_view_created_at=?,thread_id=? WHERE id=?`)
    .run(JSON.stringify(task), JSON.stringify({ authorizationMode: "smart", workspaceAccessMode: "workspace_write", effectivePolicySnapshot: policy,
      runnerExecutionInput: execution }), `suspension-context-${run.id}`, now, thread.id, run.id);
  f.store.appendExecutionEvent(run.id, f.fence, "run_start", { taskId: task.id, cwd: f.cwd, provider: run.providerName, model: run.providerModel });
  const lineage = captureRunProgressCheckpointLineage(f.store, f.store.getRun(run.id)).lineage;
  return { input: { runId: run.id, sourceFence: f.fence, cause: "daemon_restart", expectedLineage: lineage, now },
    view: [{ role: "user", content: task.prompt, timestamp: 1 }], lineage };
}

/** Test-only constructor ports, never added to a public Store or transport DTO. */
export function requestSuspensionForFixture(f, now) {
  const { input } = prepareSuspensionSource(f, now);
  const methods = ["getRun", "getWorkUnit", "getWorkUnitAttempt", "getApprovalPolicy", "getLingThread", "getChannel", "getProviderPreset",
    "getAiTeammate", "listTeammateSkillBindings", "getSkillRegistryEntry", "getLatestWorkspaceProvenanceWatermark", "getArtifact",
    "readRunProgressCheckpointForRecovery", "getChannelWorkflowStep", "getChannelWorkflow"];
  const authority = new SqliteRunSuspensionStore({ database: f.store.database }, {
    ...Object.fromEntries(methods.map(name => [name, (...args) => f.store[name](...args)])),
    createArtifactWithinTransaction: value => f.store.artifacts.createArtifactWithinTransaction(value) });
  return authority.requestRunSuspension(input);
}
