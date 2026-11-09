import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual as same } from "node:util";
import type { HostAttemptEffectInventory } from "../../host-attempt-completion-types.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { normalizeWorkflowIntegrationRoundInputs, normalizeWorkflowIsolationScopePlan,
  workflowIntegrationRoundInputsDigest, workflowIsolationRecord as record } from "../../workflow-isolation.js";

type Call = NonNullable<HostAttemptEffectInventory["undispatchedIsolatedCalls"]>[number];
const names = ["read", "grep", "find", "ls", "write", "edit"];
const parse = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return record(parsed) ? parsed : undefined;
};

/** No error-text inference: the original Host attests producer non-entry; Core verifies its frozen scope and complete events. */
export function verifiedUndispatchedIsolatedCalls(database: DatabaseSync, source: HostOperationSource,
  values: readonly unknown[], ids: readonly string[], at: string): readonly Call[] | undefined {
  if (!values.length) return [];
  const calls = new Map<string, Call>();
  for (const value of values) {
    if (!record(value) || Object.keys(value).sort().join(",") !== "toolCallId,toolName"
      || typeof value.toolCallId !== "string" || !ids.includes(value.toolCallId) || calls.has(value.toolCallId)
      || typeof value.toolName !== "string" || !value.toolName) return undefined;
    calls.set(value.toolCallId, { toolCallId: value.toolCallId, toolName: value.toolName });
  }
  const row = database.prepare(`SELECT r.cwd,r.task_id,r.workflow_step_id,r.channel_id,r.teammate_id,r.request_snapshot_json,
    u.request_json,u.workspace_id,u.owner_type,u.owner_id,u.linked_run_id,a.effective_runner_id,
    b.plan_id,b.authority_basis,b.start_owner_json,b.task_id AS binding_task_id,p.plan_digest,p.plan_json,
    p.authority_basis AS plan_authority_basis,g.inputs_json,g.inputs_digest
    FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.id=?
    JOIN work_unit_attempts a ON a.work_unit_id=u.id AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=?
    JOIN workflow_isolation_bindings b ON b.run_id=r.id AND b.work_unit_id=u.id AND b.attempt_id=a.id
      AND b.runtime_instance_id=a.runtime_instance_id AND b.fencing_token=a.fencing_token AND b.status='ready'
    JOIN workflow_isolation_scope_plans p ON p.plan_id=b.plan_id
    JOIN workflow_integration_generations g ON g.round_id=p.round_id AND g.generation=p.generation
    JOIN workflow_isolation_receipts receipt ON receipt.receipt_id=b.creation_receipt_id AND receipt.outcome='confirmed'
    JOIN workflow_isolation_intents intent ON intent.intent_id=receipt.intent_id AND intent.status='confirmed'
      AND intent.kind='worktree_create' AND intent.scope_binding_id=b.binding_id AND intent.writer_binding_id=b.binding_id
    WHERE r.id=?`).get(source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken, source.runId);
  if (!row) return undefined;
  const plan = normalizeWorkflowIsolationScopePlan(parse(row.plan_json)), inputs = normalizeWorkflowIntegrationRoundInputs(parse(row.inputs_json));
  const snapshot = parse(row.request_snapshot_json), request = parse(row.request_json), owner = parse(row.start_owner_json);
  const payload = snapshot?.runnerExecutionInput;
  if (!plan || !inputs || workflowIntegrationRoundInputsDigest(inputs) !== row.inputs_digest
    || plan.planId !== row.plan_id || plan.planDigest !== row.plan_digest || plan.workflowId !== inputs.workflowId
    || plan.graphFingerprint !== inputs.graphFingerprint || !inputs.participants.some(p => p.workflowStepId === plan.workflowStepId)
    || inputs.safetyPins.find(p => p.workflowStepId === plan.workflowStepId)?.fingerprint !== plan.safetyFingerprint
    || plan.executionRoot !== row.cwd || plan.workflowStepId !== row.workflow_step_id || plan.canonicalWorkspaceId !== row.workspace_id
    || row.effective_runner_id !== "pi" || row.linked_run_id !== source.runId || row.owner_type !== "task"
    || row.owner_id !== row.task_id || row.binding_task_id !== row.task_id
    || owner?.taskId !== row.task_id || owner?.authorityBasis !== row.authority_basis || row.authority_basis !== row.plan_authority_basis
    || !same(snapshot?.workflowIsolationPlan, { planId: plan.planId, planDigest: plan.planDigest })
    || !record(payload) || !same(request?.runnerExecutionInput, payload) || payload.schemaVersion !== 1
    || payload.runnerId !== "pi" || payload.toolHydrationEnabled !== false || !record(payload.input)
    || payload.input.cwd !== row.cwd || !record(payload.input.task) || payload.input.task.id !== row.task_id
    || payload.input.task.channelId !== row.channel_id || !narrowHostProfile(payload.input)
    || !record(payload.preparedInput)) return undefined;
  const prepared = payload.preparedInput, { fingerprint, ...body } = prepared, selected = payload.input.tools;
  if (prepared.schemaVersion !== 1 || prepared.boundary !== "pi-model-context" || prepared.taskId !== row.task_id
    || fingerprint !== createHash("sha256").update(JSON.stringify(body)).digest("hex")
    || !Array.isArray(selected) || !Array.isArray(prepared.tools) || selected.length !== prepared.tools.length
    || new Set(selected).size !== selected.length || selected.some(name => !names.includes(String(name)))
    || prepared.tools.some(tool => !record(tool) || !selected.includes(tool.name))
    || new Set(prepared.tools.map(tool => record(tool) ? tool.name : undefined)).size !== selected.length) return undefined;
  // Any native producer contradicts this profile. A journalled effect can never be reclassified as undispatched.
  if (database.prepare("SELECT 1 FROM native_submissions WHERE run_id=? OR attempt_id=? LIMIT 1")
    .get(source.runId, source.attemptId)) return undefined;
  for (const call of calls.values()) {
    if (database.prepare(`SELECT 1 FROM host_operations WHERE (run_id=? OR attempt_id=?) AND tool_call_id=?
      UNION ALL SELECT 1 FROM harness_tool_executions WHERE (run_id=? OR attempt_id=?) AND tool_call_id=? LIMIT 1`)
      .get(source.runId, source.attemptId, call.toolCallId, source.runId, source.attemptId, call.toolCallId)) return undefined;
  }
  const started = new Set<string>(), closed = new Set<string>();
  for (const event of database.prepare(`SELECT type,ts,data_json FROM run_events WHERE run_id=?
    AND type IN ('tool_start','tool_update','tool_end','host_command_prepared','host_command_settled') ORDER BY seq`).iterate(source.runId)) {
    const data = parse(event.data_json);
    if (!data || typeof data.toolCallId !== "string" || !calls.has(data.toolCallId)) continue;
    const call = calls.get(data.toolCallId)!;
    if (data.attemptId !== source.attemptId || data.toolName !== call.toolName || typeof event.ts !== "string" || event.ts > at) return undefined;
    if (event.type === "tool_start") {
      if (started.has(call.toolCallId)) return undefined;
      started.add(call.toolCallId);
    } else if (event.type === "tool_end" || event.type === "tool_update") {
      if (!started.has(call.toolCallId) || closed.has(call.toolCallId)) return undefined;
      if (event.type === "tool_end") closed.add(call.toolCallId);
    } else return undefined;
  }
  return closed.size === calls.size ? [...calls.values()] : undefined;
}

function narrowHostProfile(input: Record<string, unknown>): boolean {
  if (input.isolatedToolsProfile !== "host_isolated_files_v1" || input.readonlyToolsProfile !== undefined) return false;
  if (["mcpTools", "hostCapabilityTools", "mediaGenerationTools"].some(key => input[key] !== undefined
    && (!Array.isArray(input[key]) || input[key].length !== 0))) return false;
  for (const [key, allowed] of [["initialToolSurface", ["mediaGeneration", "toolHydration", "userInput", "nativeFileCreate", "delegation"]],
    ["runtimeToolFeatures", ["requestPermissions", "unifiedExec", "shellSnapshot"]]] as const) {
    const flags = input[key];
    if (flags !== undefined && (!record(flags) || Object.entries(flags).some(([name, value]) =>
      !(allowed as readonly string[]).includes(name) || value !== false))) return false;
  }
  return true;
}
