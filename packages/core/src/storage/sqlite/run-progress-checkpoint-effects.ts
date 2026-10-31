import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { isHostCommandPreparedV1, isHostCommandSettledV1 } from "@ling-stack/contracts";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HostOperationJournalError } from "../../host-operation-journal-types.js";
import type { RunEventEnvelope, RunSession, RunStore } from "../../run-types.js";
import { isRunProgressRecord as record, readRunProgressFrozenExecution } from "../../run-progress-checkpoint-lineage.js";
import { RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { readHostOperation, verifyHostOperationSafe, verifyHarnessFileExecutionReceipt } from "./host-operation-journal-evidence.js";
import { mapUserInputRequest, type UserInputRow } from "./user-input-records.js";
import { verifiedDelegationToolCall } from "./host-attempt-tracked-coverage.js";

export type RunProgressEffectStore = Pick<RunStore, "listEvents" | "listHarnessToolExecutions" | "getWorkUnitAttempt"
  | "listHostCommandWriteBlockers" | "listApprovalRequests">;

/** Complete, finite canonical sequence. No missing-page or latest-event shortcut. */
export function readRunProgressEvents(store: Pick<RunStore, "listEvents">, runId: string): RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  for (;;) {
    const page = store.listEvents(runId, { afterSeq: events.at(-1)?.seq ?? 0, limit: 1000 });
    for (const event of page) {
      if (event.seq !== events.length + 1 || events.length >= 10_000) throw blocked();
      events.push(event);
    }
    if (page.length < 1000) return events;
  }
}

/** Only genuinely pristine runs may continue without checkpoint authority. */
export function runHasOrdinaryProgress(events: readonly RunEventEnvelope[]): boolean {
  return events.some(event => event.type !== "run_created" && event.type !== "run_start");
}

/** Match the exact SDK pair to canonical tool facts and dedicated Host settlement. */
export function validateRunProgressEffects(store: RunProgressEffectStore, run: RunSession,
  events: readonly RunEventEnvelope[], modelView: readonly unknown[], sourceFence: RuntimeAttemptFenceV1, database: DatabaseSync,
  options: { readonly allowClosedFailedBash?: boolean } = {}): readonly string[] {
  const last = modelView.at(-1);
  if (modelView.length === 0 || modelView.length > 1000 || !record(last)) throw blocked();
  const first = modelView[0], prepared = readRunProgressFrozenExecution(run).preparedInput;
  if (!record(prepared) || typeof prepared.userPrompt !== "string" || !prepared.userPrompt.trim()
    || !record(first) || first.role !== "user" || !acceptedUserContent(first.content, prepared.userPrompt)) throw blocked();
  if (modelView.length === 1) {
    if (events.some(event => !["run_created", "run_start", "turn_start", "delegation_instruction_checkpointed"].includes(event.type))
      || store.listHarnessToolExecutions(run.id).length
      || store.listHostCommandWriteBlockers(run.cwd).some(item => item.runId === run.id)
      || store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length) throw blocked();
    assertNoUnsettledHostFacts(database, store, run.id, sourceFence.workUnitId);
    return [];
  }
  if (last.role !== "toolResult") throw blocked();
  const calls = new Map<string, Record<string, unknown>>(), results = new Map<string, Record<string, unknown>>();
  for (const [index, message] of modelView.entries()) {
    if (!record(message) || !["user", "assistant", "toolResult"].includes(String(message.role))) throw blocked();
    if (message.role === "user" && index !== 0) throw blocked();
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) throw blocked();
      for (const block of message.content) {
        if (!record(block) || block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !record(block.arguments) || calls.has(block.id)) throw blocked();
        calls.set(block.id, block);
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !calls.has(message.toolCallId) || results.has(message.toolCallId)
        || !Array.isArray(message.content) || typeof message.isError !== "boolean") throw blocked();
      results.set(message.toolCallId, message);
    }
  }
  const starts = new Map<string, Extract<RunEventEnvelope, { type: "tool_start" }>>();
  const ends = new Map<string, Extract<RunEventEnvelope, { type: "tool_end" }>>();
  const open = new Set<string>();
  for (const event of events) {
    if (["context_compaction_start", "context_compaction_end", "run_error", "run_cancelled", "run_end", "loop_detected"].includes(event.type)) throw blocked();
    if (event.type !== "tool_start" && event.type !== "tool_update" && event.type !== "tool_end") continue;
    const id = event.data.toolCallId;
    if (typeof id !== "string" || !id || typeof event.data.attemptId !== "string") throw blocked();
    if (event.type === "tool_start") {
      if (starts.has(id)) throw blocked();
      starts.set(id, event); open.add(id);
    } else {
      const start = starts.get(id);
      if (!start || !open.has(id) || start.data.toolName !== event.data.toolName || start.data.attemptId !== event.data.attemptId) throw blocked();
      if (event.type === "tool_end") { open.delete(id); ends.set(id, event); }
    }
  }
  if (open.size || !ends.size || calls.size !== ends.size || results.size !== ends.size) throw blocked();
  const executions = store.listHarnessToolExecutions(run.id);
  if (executions.some(execution => {
    const start = starts.get(execution.toolCallId), end = ends.get(execution.toolCallId);
    return !start || !end || execution.runId !== run.id || execution.workUnitId !== sourceFence.workUnitId
      || execution.attemptId !== start.data.attemptId || execution.toolName !== start.data.toolName
      || !["succeeded", "denied", "failed", "cancelled", "superseded"].includes(execution.state);
  })
    || store.listHostCommandWriteBlockers(run.cwd).some(item => item.runId === run.id)
    || store.listApprovalRequests({ runId: run.id, status: "pending", limit: 1 }).length) throw blocked();
  assertNoUnsettledHostFacts(database, store, run.id, sourceFence.workUnitId);
  const commandPairs = new Set<string>(), preparedById = new Map<string, Extract<RunEventEnvelope, { type: "host_command_prepared" }>>();
  const settledById = new Map<string, Extract<RunEventEnvelope, { type: "host_command_settled" }>>();
  const completedCommands = new Map<string, { prepared: Extract<RunEventEnvelope, { type: "host_command_prepared" }>;
    settled: Extract<RunEventEnvelope, { type: "host_command_settled" }> }>();
  for (const event of events) {
    if (event.type === "host_command_prepared") {
      if (!isHostCommandPreparedV1(event.data) || preparedById.has(event.data.executionId)
        || commandPairs.has(event.data.toolCallId)) throw blocked();
      preparedById.set(event.data.executionId, event); commandPairs.add(event.data.toolCallId);
    } else if (event.type === "host_command_settled") {
      if (!isHostCommandSettledV1(event.data) || settledById.has(event.data.executionId)) throw blocked();
      settledById.set(event.data.executionId, event);
    }
  }
  // All dedicated receipts must be represented, not merely the ones selected
  // by canonical ends. An extra terminal effect cannot hide behind broker-off.
  if (preparedById.size !== settledById.size) throw blocked();
  for (const prepared of preparedById.values()) {
    const id = prepared.data.toolCallId, start = starts.get(id), end = ends.get(id);
    const settled = settledById.get(prepared.data.executionId);
    const attempt = start && store.getWorkUnitAttempt(String(start.data.attemptId));
    if (!start || !end || start.data.toolName !== "bash" || !attempt || !settled
      || !isDeepStrictEqual(prepared.data.source, toRuntimeAttemptFence(attempt))
      || prepared.seq <= start.seq || settled.seq <= prepared.seq || settled.seq >= end.seq
      || settled.data.outcome !== "completed" || settled.data.ownerCurrent !== true) throw blocked();
    completedCommands.set(id, { prepared, settled });
  }
  let unsupportedFileEffect = false;
  for (const [id, end] of ends) {
    const start = starts.get(id)!, call = calls.get(id), result = results.get(id);
    const attempt = store.getWorkUnitAttempt(String(start.data.attemptId));
    if (!call || !result || !attempt || attempt.workUnitId !== sourceFence.workUnitId
      || call.name !== start.data.toolName || !isDeepStrictEqual(call.arguments, start.data.args)
      || result.toolName !== end.data.toolName || result.isError !== end.data.isError || !record(end.data.result)
      || !isDeepStrictEqual(result.content, end.data.result.content)) throw blocked();
    if (end.data.isError && end.data.toolName !== "read") {
      const command = completedCommands.get(id);
      // The opt-in belongs only to ordinary checkpoints. Compaction retains its
      // existing domain. Preserve the original error, never synthesize success.
      if (!options.allowClosedFailedBash || end.data.toolName !== "bash" || !command
        || !isClosedFailedBash(run, start.data.args, end, command.prepared, command.settled)) throw blocked();
    }
    if (end.data.toolName === "bash") {
      if (!commandPairs.has(id)) throw blocked();
    } else if (["spawn_agent", "send_message", "wait_agent", "interrupt_agent", "resume_agent"].includes(end.data.toolName)) {
      // Narrative or a matching name is insufficient: mutations require their
      // source-bound durable delegation facts. A wait is observation only and
      // never certifies child success, stop, fan-in or budget settlement.
      if (!verifiedDelegationToolCall(database, { runId: run.id, ...toRuntimeAttemptFence(attempt) },
        id, end.data.toolName, call.arguments as Record<string, unknown>)) throw blocked();
    } else if (!["read", "grep", "find", "ls"].includes(end.data.toolName)) {
      const execution = executions.filter(item => item.toolCallId === id && item.attemptId === attempt.id);
      if (!execution.length && ["write", "edit"].includes(end.data.toolName)
        && record(run.requestSnapshot) && record(run.requestSnapshot.harnessFeatureSnapshot)
        && run.requestSnapshot.harnessFeatureSnapshot.toolBroker === "off") {
        // An ordinary SDK file callback has no dedicated durable effect receipt.
        // This diagnoses unsupported recovery only, never authorizes a head or replay.
        unsupportedFileEffect = true;
      } else if (!["write", "edit", "apply_patch"].includes(end.data.toolName)
        || execution.length !== 1 || execution[0].state !== "succeeded" || !execution[0].evidenceArtifactIds.length) throw blocked();
      else {
        try {
          verifyHarnessFileExecutionReceipt(database, { source: { runId: run.id, ...toRuntimeAttemptFence(attempt) },
            toolCallId: id, toolName: end.data.toolName, executionId: execution[0].id,
            requestDigest: digestHarnessToolValue({ schemaVersion: 1, toolName: end.data.toolName, toolCallId: id,
              cwd: run.cwd, input: start.data.args }),
            policySnapshot: record(run.requestSnapshot) ? run.requestSnapshot.effectivePolicySnapshot : undefined });
        } catch (error) { if (error instanceof HostOperationJournalError) throw blocked(); throw error; }
      }
    }
  }
  // Unknown command/MCP/journal facts above take precedence over this precise capability diagnosis.
  if (unsupportedFileEffect) throw new RunProgressCheckpointError("checkpoint.effect_unjournaled");
  return [...ends.keys()];
}

/** A nonzero exit is a known result only when canonical output matches Host facts.
 * Normal leader close does not prove descendant termination or rollback; the
 * independent Host-operation unknown-outcome gate above must still reject it. */
function isClosedFailedBash(run: RunSession, args: unknown,
  end: Extract<RunEventEnvelope, { type: "tool_end" }>,
  prepared: Extract<RunEventEnvelope, { type: "host_command_prepared" }>,
  settled: Extract<RunEventEnvelope, { type: "host_command_settled" }>): boolean {
  const result = end.data.result;
  if (!record(args) || typeof args.command !== "string" || !args.command.trim() || !record(result)
    || !record(result.details) || result.details.denied !== undefined || !record(result.details.unifiedExec)) return false;
  const execution = result.details.unifiedExec;
  const command = { kind: "shell", command: args.command, shell: "bash" };
  if (execution.status !== "failed" || !Number.isSafeInteger(execution.exitCode) || (execution.exitCode as number) <= 0
    || execution.timedOut !== false || execution.cancelled !== false || execution.signal !== undefined || execution.denied !== undefined
    || execution.runId !== run.id || execution.taskId !== run.taskId || execution.toolCallId !== end.data.toolCallId
    || !isDeepStrictEqual(execution.command, command)
    || prepared.data.commandDigest !== createHash("sha256").update(JSON.stringify(command)).digest("hex")
    || !isDeepStrictEqual(execution.processObservation, settled.data.observation)) return false;
  if (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd.trim())) return false;
  const cwd = resolve(run.cwd, typeof args.cwd === "string" ? args.cwd : ".");
  const workspace = prepared.data.workspace;
  if (typeof execution.cwd !== "string" || !isAbsolute(execution.cwd) || !isAbsolute(workspace.path)
    || !isAbsolute(workspace.realPath) || !isAbsolute(prepared.data.cwd) || workspace.path !== resolve(run.cwd)) return false;
  const suffix = relative(workspace.path, cwd);
  if (suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) return false;
  // Use the persisted lexical/real workspace mapping, not today's filesystem.
  // It accounts for macOS /var aliases. Unprovable nested symlink aliases fail closed.
  const physicalCwd = resolve(workspace.realPath, suffix);
  return prepared.data.cwd === physicalCwd && (resolve(execution.cwd) === cwd || resolve(execution.cwd) === physicalCwd);
}

/** Recovery revalidates historical A and current B facts without borrowing a live-only lookup. */
export function assertNoUnsettledHostFacts(database: DatabaseSync, store: Pick<RunStore, "getWorkUnitAttempt">,
  runId: string, workUnitId: string): void {
  const rows = database.prepare("SELECT operation_id FROM host_operations WHERE run_id=? ORDER BY operation_id").all(runId);
  if (rows.length > 10_000) throw blocked();
  for (const row of rows) {
    try {
      const operation = readHostOperation(database, String(row.operation_id));
      const attempt = operation && store.getWorkUnitAttempt(operation.source.attemptId);
      if (!operation || !attempt || operation.phase !== "safe" || operation.source.workUnitId !== workUnitId
        || !isDeepStrictEqual(operation.source, { runId, ...toRuntimeAttemptFence(attempt) })
        || verifyHostOperationSafe(database, operation) !== operation.evidenceDigest) throw blocked();
    } catch (error) { if (error instanceof HostOperationJournalError) throw blocked(); throw error; }
  }
  const requests = database.prepare(`SELECT * FROM user_input_requests WHERE source_run_id=?
    AND status IN ('pending','answered') AND (wait_status IS NULL OR wait_status IN ('waiting','resuming'))`).all(runId);
  for (const row of requests) {
    const request = mapUserInputRequest(row as UserInputRow);
    if (request.waitMode === "required") throw blocked();
  }
}

function acceptedUserContent(value: unknown, prompt: string): boolean {
  if (typeof value === "string") return value === prompt;
  return Array.isArray(value) && value.length > 0 && value.every(block =>
    record(block) && block.type === "text" && typeof block.text === "string")
    && value.map(block => (block as { text: string }).text).join("") === prompt;
}

/** Post-checkpoint exception is narrow and requires a real current daemon-recovery B. */
export function validateRunProgressRecoveryBookkeeping(run: RunSession, events: readonly RunEventEnvelope[], attemptId: string): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.type) || event.data.attemptId !== attemptId) throw blocked();
    seen.add(event.type);
    // Both current Host markers (no embedded type) and Runner canonical
    // envelopes exist. A present embedded discriminator must match exactly.
    const hasType = Object.prototype.hasOwnProperty.call(event.data, "type");
    if (hasType && event.data.type !== event.type) throw blocked();
    const keys = Object.keys(event.data).sort().join(",");
    if (event.type === "run_start") {
      if (keys !== ["attemptId", "taskId", "cwd", "provider", "model", ...(hasType ? ["type"] : [])].sort().join(",")
        || event.data.taskId !== run.taskId || event.data.cwd !== run.cwd || event.data.provider !== run.providerName || event.data.model !== run.providerModel) throw blocked();
    } else if (event.type === "turn_start") {
      if (keys !== ["attemptId", ...(hasType ? ["type"] : [])].sort().join(",")) throw blocked();
    } else throw blocked();
  }
}
function blocked(): RunProgressCheckpointError { return new RunProgressCheckpointError("checkpoint.effect_unknown"); }
