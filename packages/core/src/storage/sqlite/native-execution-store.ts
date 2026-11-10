import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isExternalExecutionEngineId, type RuntimeAttemptFenceV1 } from "@ling-stack/contracts";
import type { ApprovalRequest, CreateApprovalRequestInput } from "../../approval-types.js";
import { assertApprovalDecisionAvailable, isNativePermissionRequestPayload } from "../../approval-decisions.js";
import { NativeExecutionJournalError, type NativeExecutionStore, type NativeExecutionBinding,
  type NativeExecutionSelection, type NativeSubmission, type NativeSubmissionKey, type NativeSubmissionStatus,
  type NativeSubmissionTerminal, type NativeApprovalKey, type NativeApprovalCorrelation, type NativeApprovalRecord,
  type CreateNativeApprovalInput, type ReserveNativeExecutionInput, type ResolveNativeExecutionGenerationInput,
  type AppendNativeRunEventsInput,
  type BeginNativeSubmissionInput, type AcceptNativeSubmissionInput, type NativeHostAction, type NativeHostOperation,
  type ReserveNativeHostActionInput, type ClaimNativeHostOperationInput, type SettleNativeHostOperationInput,
  type AssertNativeHostOperationReplyInput, type ObserveNativeHostOperationReplyInput,
  type NativeHostTerminalKey, type AssertNativeHostTerminalReplyInput, type SettleNativeHostTerminalExitInput } from "../../native-execution-types.js";
import { redactSecrets } from "../../redaction.js";
import { normalizeOpenClawAgentId, validateNativeOpenClawSessionRoute } from "../../native-openclaw-session.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { publishNativeApprovalDecision, synchronizeNativeApprovalWait, type NativeApprovalWaitPorts } from "./native-approval-wait.js";
import { appendNativeRunOutput, validateNativeRunOutput } from "./native-run-output.js";
import { publishNativeArtifacts, validateNativeArtifacts, type NativeArtifactPorts } from "./native-run-artifacts.js";

interface Ports {
  readonly artifacts: NativeArtifactPorts;
  readonly wait: NativeApprovalWaitPorts;
  readonly createApprovalRequest: (input: CreateApprovalRequestInput, now: string) => ApprovalRequest;
  readonly getApprovalRequest: (id: string) => ApprovalRequest | undefined;
  readonly cancelApprovalRequest: (id: string, now: string) => void;
  readonly assertWorkspaceSnapshotFence: (cwd: string) => void;
}
interface BindingRow {
  id: string; thread_id: string; participant_id: string; cwd: string; generation: number; selection_json: string;
  native_session_id: string | null; created_at: string;
  openclaw_agent_id: string | null; openclaw_session_key: string | null; openclaw_accepted_at: string | null;
}
interface SubmissionRow {
  id: string; binding_id: string; run_id: string; work_unit_id: string; attempt_id: string;
  runtime_instance_id: string; fencing_token: string; status: NativeSubmissionStatus;
  native_turn_id: string | null; native_prompt_request_key: string | null; created_at: string; updated_at: string;
}
interface ApprovalRow {
  approval_id: string; submission_id: string; request_key: string; method: string; fingerprint: string;
  reply_status: NativeApprovalCorrelation["replyStatus"]; resolved_at: string | null;
}
interface OwnerRow {
  thread_id: string; participant_id: string; task_id: string; channel_id: string | null; cwd: string;
}
interface HostActionRow {
  id: string; submission_id: string; tool_call_id: string; action_fingerprint: string; policy_fingerprint: string;
  methods_json: string; authorization_json: string; approval_id: string | null;
  status: NativeHostAction["status"]; created_at: string; updated_at: string;
}
interface HostOperationRow {
  id: string; action_id: string; submission_id: string; step: number; request_key: string;
  method: NativeHostOperation["method"]; operation_fingerprint: string; status: NativeHostOperation["status"];
  result_fingerprint: string | null; claimed_at: string; settled_at: string | null;
  reply_status: NativeHostOperation["replyStatus"]; reply_observed_at: string | null;
  terminal_id: string | null; terminal_started_at: string | null; terminal_exit_json: string | null;
}
const activeStatuses = "('reserved', 'submission_pending', 'accepted', 'unknown')";

export class SqliteNativeExecutionStore implements NativeExecutionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  resolveNativeExecutionGeneration(input: ResolveNativeExecutionGenerationInput): number {
    const selected = canonicalSelection(input.selection);
    const owner = this.owner(input.runId, input.fence, selected.engineId);
    const row = this.context.database.prepare(`SELECT * FROM native_execution_bindings
      WHERE thread_id = ? AND participant_id = ? ORDER BY generation DESC LIMIT 1`)
      .get(owner.thread_id, owner.participant_id) as unknown as BindingRow | undefined;
    if (!row) return 1;
    const current = binding(row);
    if (current.cwd !== owner.cwd || !isDeepStrictEqual(current.selection, selected)) fail("native_binding_conflict");
    return current.generation;
  }

  reserveNativeExecution(input: ReserveNativeExecutionInput, now: string) {
    const selected = canonicalSelection(input.selection);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const owner = this.owner(input.runId, input.fence, selected.engineId);
      const db = this.context.database;
      const prior = db.prepare("SELECT * FROM native_submissions WHERE attempt_id = ?").get(input.fence.attemptId) as unknown as SubmissionRow | undefined;
      if (prior) {
        if (prior.run_id !== input.runId || !isDeepStrictEqual(submission(prior).fence, input.fence)) fail("native_owner_mismatch");
        const binding = this.getNativeExecutionBinding(prior.binding_id)!;
        if (binding.cwd !== owner.cwd || binding.generation !== input.generation || !isDeepStrictEqual(binding.selection, selected)) fail("native_binding_conflict");
        return { binding, submission: submission(prior), created: false };
      }
      const existingRow = db.prepare("SELECT * FROM native_execution_bindings WHERE thread_id = ? AND participant_id = ? AND generation = ?")
        .get(owner.thread_id, owner.participant_id, input.generation) as unknown as BindingRow | undefined;
      if (existingRow && (existingRow.cwd !== owner.cwd || !isDeepStrictEqual(binding(existingRow).selection, selected))) fail("native_binding_conflict");
      if (db.prepare(`SELECT id FROM native_submissions WHERE thread_id = ? AND participant_id = ? AND status IN ${activeStatuses}`)
        .get(owner.thread_id, owner.participant_id)) fail("native_session_busy");
      const bindingId = existingRow?.id ?? `native_binding_${randomUUID()}`;
      if (!existingRow) db.prepare(`INSERT INTO native_execution_bindings
        (id, thread_id, participant_id, cwd, generation, profile_id, selection_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(bindingId, owner.thread_id, owner.participant_id, owner.cwd, input.generation, selected.profileId, JSON.stringify(selected), now);
      const id = `native_submission_${randomUUID()}`;
      db.prepare(`INSERT INTO native_submissions (id, binding_id, thread_id, participant_id, run_id, work_unit_id,
        attempt_id, runtime_instance_id, fencing_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
        .run(id, bindingId, owner.thread_id, owner.participant_id, input.runId, input.fence.workUnitId,
          input.fence.attemptId, input.fence.runtimeInstanceId, input.fence.fencingToken, now, now);
      return { binding: this.getNativeExecutionBinding(bindingId)!, submission: this.getNativeSubmission(id)!, created: true };
    });
  }

  getNativeExecutionBinding(id: string): NativeExecutionBinding | undefined {
    const row = this.context.database.prepare("SELECT * FROM native_execution_bindings WHERE id = ?").get(id) as unknown as BindingRow | undefined;
    return row ? binding(row) : undefined;
  }

  getNativeSubmission(id: string): NativeSubmission | undefined {
    const row = this.context.database.prepare("SELECT * FROM native_submissions WHERE id = ?").get(id) as unknown as SubmissionRow | undefined;
    return row ? submission(row) : undefined;
  }

  listUnresolvedNativeSubmissions(limit = 100): NativeSubmission[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("native_journal_invalid");
    return (this.context.database.prepare(`SELECT * FROM native_submissions WHERE status IN ${activeStatuses} ORDER BY created_at, id LIMIT ?`)
      .all(limit) as unknown as SubmissionRow[]).map(submission);
  }

  listNativeAttemptSubmissions(source: HostOperationSource): readonly NativeSubmission[] {
    return (this.context.database.prepare(`SELECT * FROM native_submissions WHERE run_id=? AND work_unit_id=?
      AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? ORDER BY id`)
      .all(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken) as unknown as SubmissionRow[]).map(submission);
  }

  bindNativeExecutionSession(input: NativeSubmissionKey & { readonly nativeSessionId: string }, now: string): NativeExecutionBinding {
    if (!validText(input.nativeSessionId)) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const { binding: selected, submission: current } = this.ownedSubmission(input);
      if (selected.selection.engineId === "openclaw-acp" && !selected.openclawSession) fail("native_session_missing");
      if (selected.nativeSessionId) {
        if (selected.nativeSessionId !== input.nativeSessionId) fail("native_binding_conflict");
        return selected;
      }
      if (current.status !== "reserved") fail("native_submission_conflict");
      if (this.context.database.prepare("SELECT id FROM native_execution_bindings WHERE profile_id = ? AND native_session_id = ?")
        .get(selected.selection.profileId, input.nativeSessionId)) fail("native_binding_conflict");
      this.context.database.prepare("UPDATE native_execution_bindings SET native_session_id = ? WHERE id = ? AND native_session_id IS NULL")
        .run(input.nativeSessionId, selected.id);
      return this.getNativeExecutionBinding(selected.id)!;
    });
  }

  prepareNativeOpenClawSession(input: NativeSubmissionKey & { readonly agentId: string }, now: string) {
    const agentId = normalizeOpenClawAgentId(input.agentId);
    if (Object.keys(input).some(key => !["submissionId", "fence", "agentId"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const { binding: selected, submission: current } = this.ownedSubmission(input);
      if (selected.selection.engineId !== "openclaw-acp") fail("native_binding_conflict");
      if (current.status !== "reserved") fail("native_submission_conflict");
      if (selected.openclawSession) {
        if (selected.openclawSession.agentId !== agentId) fail("native_binding_conflict");
        return { agentId, sessionKey: selected.openclawSession.sessionKey,
          requireExistingSession: selected.openclawSession.acceptedAt !== undefined };
      }
      if (selected.nativeSessionId) fail("native_binding_conflict");
      const sessionKey = `agent:${agentId}:ling:${randomUUID()}`;
      const result = this.context.database.prepare(`UPDATE native_execution_bindings
        SET openclaw_agent_id = ?, openclaw_session_key = ? WHERE id = ? AND openclaw_session_key IS NULL`)
        .run(agentId, sessionKey, selected.id);
      if (result.changes !== 1) fail("native_binding_conflict");
      return { agentId, sessionKey, requireExistingSession: false };
    });
  }

  beginNativeSubmission(input: BeginNativeSubmissionInput, now: string): NativeSubmission {
    if ("nativeTurnId" in input) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const current = this.ownedSubmission(input);
      if (!current.binding.nativeSessionId) fail("native_session_missing");
      if (current.binding.selection.engineId === "openclaw-acp" && !current.binding.openclawSession) fail("native_session_missing");
      if (current.submission.status !== "reserved") fail("native_submission_conflict");
      if (isAcp(current.binding)) {
        if (!validRequestId(input.nativePromptRequestId)) fail("native_journal_invalid");
        this.context.database.prepare("UPDATE native_submissions SET native_prompt_request_key = ? WHERE id = ?")
          .run(JSON.stringify(input.nativePromptRequestId), current.submission.id);
      } else if (input.nativePromptRequestId !== undefined) fail("native_journal_invalid");
      return this.transition(current.submission, "submission_pending", now);
    });
  }

  acceptNativeSubmission(input: AcceptNativeSubmissionInput, now: string): NativeSubmission {
    return this.transaction(now, () => {
      const { submission: current, binding: selected } = this.ownedSubmission(input, true);
      if (isAcp(selected)) {
        if (!validRequestId(input.nativePromptRequestId) || input.nativeTurnId !== undefined) fail("native_journal_invalid");
        if (current.nativePromptRequestId !== input.nativePromptRequestId || current.nativeTurnId !== undefined) fail("native_submission_conflict");
        if (current.status === "accepted") return current;
        if (current.status !== "submission_pending") fail("native_submission_conflict");
        if (selected.selection.engineId === "openclaw-acp") {
          if (!selected.openclawSession) fail("native_session_missing");
          this.context.database.prepare("UPDATE native_execution_bindings SET openclaw_accepted_at = COALESCE(openclaw_accepted_at, ?) WHERE id = ?")
            .run(now, selected.id);
        }
        return this.transition(current, "accepted", now);
      }
      if (!validText(input.nativeTurnId) || input.nativePromptRequestId !== undefined) fail("native_journal_invalid");
      if (current.status === "accepted" && current.nativeTurnId === input.nativeTurnId) return current;
      if (current.status !== "submission_pending" || current.nativeTurnId) fail("native_submission_conflict");
      if (this.context.database.prepare("SELECT id FROM native_submissions WHERE binding_id = ? AND native_turn_id = ?")
        .get(current.bindingId, input.nativeTurnId)) fail("native_submission_conflict");
      this.context.database.prepare("UPDATE native_submissions SET native_turn_id = ? WHERE id = ?")
        .run(input.nativeTurnId, current.id);
      return this.transition(current, "accepted", now);
    });
  }

  markNativeSubmissionUnknown(input: NativeSubmissionKey, now: string): NativeSubmission {
    return this.transaction(now, () => {
      const { submission: current } = this.ownedSubmission(input, true);
      if (current.status === "unknown") return current;
      if (current.status !== "submission_pending" && current.status !== "accepted") fail("native_submission_conflict");
      this.retireHostActions(current.id, now);
      this.retireApprovals(current.id, now);
      return this.transition(current, "unknown", now);
    });
  }

  finishNativeSubmission(input: NativeSubmissionKey & { readonly outcome: NativeSubmissionTerminal }, now: string): NativeSubmission {
    return this.transaction(now, () => {
      const { submission: current } = this.ownedSubmission(input, true);
      if (current.status === input.outcome) return current;
      const allowed = input.outcome === "not_submitted" ? ["reserved", "submission_pending"].includes(current.status) && !current.nativeTurnId
        : input.outcome === "rejected" ? current.status === "submission_pending"
        : ["completed", "failed", "cancelled"].includes(input.outcome) && current.status === "accepted"
          && (current.nativeTurnId !== undefined || current.nativePromptRequestId !== undefined);
      if (!allowed) fail("native_submission_conflict");
      this.assertHostEffectsSettled(current.id);
      this.retireHostActions(current.id, now);
      this.retireApprovals(current.id, now);
      return this.transition(current, input.outcome, now);
    });
  }

  createNativeApproval(input: CreateNativeApprovalInput, now: string): NativeApprovalRecord {
    if (!validRequestId(input.requestId) || !validText(input.method, 160)
      || Object.keys(input.approval).some(key => !["actionType", "risk", "toolCallId", "title", "description", "payload", "expiresAt", "extraSecrets"].includes(key))) {
      fail("native_journal_invalid");
    }
    const { extraSecrets, ...data } = input.approval;
    const redacted = redactSecrets(data, extraSecrets ?? []) as typeof data;
    const nativeScope = redacted.payload.type === "native_permission_request";
    if (nativeScope && (redacted.actionType !== "runtime_permission_request" || !isNativePermissionRequestPayload(redacted.payload)
      || typeof redacted.expiresAt !== "string" || !Number.isFinite(Date.parse(redacted.expiresAt)))) fail("native_journal_invalid");
    const fingerprint = createHash("sha256").update(JSON.stringify([input.method, redacted])).digest("hex");
    return this.transaction(now, () => {
      const { submission: current, owner } = this.ownedSubmission(input);
      if (current.status !== "accepted") fail("native_submission_conflict");
      const db = this.context.database;
      const key = JSON.stringify(input.requestId);
      const prior = db.prepare("SELECT * FROM native_approval_requests WHERE submission_id = ? AND request_key = ?")
        .get(current.id, key) as unknown as ApprovalRow | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.method !== input.method) fail("native_approval_conflict");
        return this.approvalRecord(prior);
      }
      const approval = this.ports.createApprovalRequest({ ...redacted, runId: current.runId, taskId: owner.task_id,
        channelId: owner.channel_id ?? undefined, availableDecisions: [nativeScope ? "approve_permission_scope" : "approve_once", "deny"] }, now);
      db.prepare(`INSERT INTO native_approval_requests
        (approval_id, submission_id, request_key, method, fingerprint, reply_status) VALUES (?, ?, ?, ?, ?, 'pending')`)
        .run(approval.id, current.id, key, input.method, fingerprint);
      return { approval, correlation: this.getNativeApprovalCorrelation(approval.id)! };
    });
  }

  getNativeApprovalCorrelation(approvalId: string): NativeApprovalCorrelation | undefined {
    const row = this.approvalRow(approvalId);
    return row ? correlation(row) : undefined;
  }

  reserveNativeHostAction(input: ReserveNativeHostActionInput, now: string) {
    if (!validText(input.nativeSessionId) || !validText(input.toolCallId) || !digest(input.actionFingerprint)
      || !digest(input.policyFingerprint) || !validHostPlan(input.methods) || !input.authorization
      || Object.keys(input).some(key => !["submissionId", "fence", "nativeSessionId", "toolCallId", "actionFingerprint", "policyFingerprint", "methods", "authorization"].includes(key))) fail("native_journal_invalid");
    const grant = input.authorization;
    if (grant.kind === "policy" ? Object.keys(grant).length !== 1
      : grant.kind !== "approval" || !validText(grant.approvalId) || !grant.payload
        || Object.keys(grant).some(key => !["kind", "approvalId", "payload"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const { submission: current, binding } = this.ownedSubmission(input);
      if (!isAcp(binding) || binding.nativeSessionId !== input.nativeSessionId) fail("native_owner_mismatch");
      if (current.status !== "accepted") fail("native_submission_conflict");
      let authorization: NativeHostAction["authorization"] = { kind: "policy" };
      if (grant.kind === "approval") {
        const row = this.approvalRow(grant.approvalId);
        const approval = row && this.ports.getApprovalRequest(row.approval_id);
        if (!row || row.submission_id !== current.id || row.resolved_at || !approval
          || approval.toolCallId !== input.toolCallId || !isDeepStrictEqual(approval.payload, redactSecrets(grant.payload))
          || (row.method !== "session/request_permission" && row.method !== input.methods[0])
          || !hostPlanMatchesApproval(input.methods, approval)) fail("native_approval_unavailable");
        authorization = { kind: "approval", approvalId: grant.approvalId, fingerprint: hostApprovalFingerprint(approval) };
      }
      const db = this.context.database;
      const row = db.prepare("SELECT * FROM native_host_actions WHERE submission_id = ? AND tool_call_id = ?")
        .get(current.id, input.toolCallId) as unknown as HostActionRow | undefined;
      if (row) {
        const previous = hostAction(row);
        if (previous.actionFingerprint !== input.actionFingerprint || previous.policyFingerprint !== input.policyFingerprint
          || !isDeepStrictEqual(previous.methods, input.methods) || !isDeepStrictEqual(previous.authorization, authorization)) fail("native_host_operation_conflict");
        return { action: previous, created: false };
      }
      const approvalId = authorization.kind === "approval" ? authorization.approvalId : null;
      if (approvalId && db.prepare("SELECT id FROM native_host_actions WHERE approval_id = ?").get(approvalId)) fail("native_host_operation_conflict");
      const id = `native_host_action_${randomUUID()}`;
      db.prepare(`INSERT INTO native_host_actions (id, submission_id, tool_call_id, action_fingerprint, policy_fingerprint,
        methods_json, authorization_json, approval_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
        .run(id, current.id, input.toolCallId, input.actionFingerprint, input.policyFingerprint, JSON.stringify(input.methods),
          JSON.stringify(authorization), approvalId, now, now);
      return { action: this.getNativeHostAction(id)!, created: true };
    });
  }

  getNativeHostAction(id: string): NativeHostAction | undefined {
    const row = this.context.database.prepare("SELECT * FROM native_host_actions WHERE id = ?").get(id) as unknown as HostActionRow | undefined;
    return row ? hostAction(row) : undefined;
  }

  listNativeHostOperations(actionId: string): NativeHostOperation[] {
    return (this.context.database.prepare("SELECT * FROM native_host_operations WHERE action_id = ? ORDER BY step")
      .all(actionId) as unknown as HostOperationRow[]).map(hostOperation);
  }

  claimNativeHostOperation(input: ClaimNativeHostOperationInput, now: string): NativeHostOperation {
    if (!validText(input.actionId) || !validRequestId(input.requestId) || !Number.isSafeInteger(input.step)
      || input.step < 0 || input.step > 1 || !digest(input.operationFingerprint) || !digest(input.actionFingerprint)
      || !digest(input.policyFingerprint) || Object.keys(input).some(key => !["actionId", "fence", "step", "requestId", "operationFingerprint", "actionFingerprint", "policyFingerprint"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const action = this.getNativeHostAction(input.actionId);
      if (!action) fail("native_host_operation_conflict");
      const { submission } = this.ownedSubmission({ submissionId: action.submissionId, fence: input.fence });
      if (submission.status !== "accepted") fail("native_submission_conflict");
      const previous = this.listNativeHostOperations(action.id);
      if (action.actionFingerprint !== input.actionFingerprint || action.policyFingerprint !== input.policyFingerprint
        || action.status !== (input.step === 0 ? "reserved" : "running") || !action.methods[input.step]
        || previous.length !== input.step || previous.some(operation => operation.status !== "succeeded")) fail("native_host_operation_conflict");
      this.assertHostAuthorization(action, input.step, input.requestId, now);
      const db = this.context.database;
      if (db.prepare("SELECT id FROM native_host_operations WHERE submission_id = ? AND request_key = ?")
        .get(submission.id, JSON.stringify(input.requestId))) fail("native_host_operation_conflict");
      const id = `native_host_operation_${randomUUID()}`;
      db.prepare(`INSERT INTO native_host_operations (id, action_id, submission_id, step, request_key, method,
        operation_fingerprint, status, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?)`)
        .run(id, action.id, submission.id, input.step, JSON.stringify(input.requestId), action.methods[input.step]!, input.operationFingerprint, now);
      db.prepare("UPDATE native_host_actions SET status = 'running', updated_at = ? WHERE id = ?").run(now, action.id);
      return this.listNativeHostOperations(action.id)[input.step]!;
    });
  }

  settleNativeHostOperation(input: SettleNativeHostOperationInput, now: string): NativeHostOperation {
    if (!validText(input.operationId) || !["succeeded", "failed", "not_started", "unknown"].includes(input.outcome)
      || (input.resultFingerprint !== undefined && !digest(input.resultFingerprint))
      || Object.keys(input).some(key => !["operationId", "fence", "outcome", "resultFingerprint"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const db = this.context.database;
      const row = db.prepare("SELECT * FROM native_host_operations WHERE id = ?").get(input.operationId) as unknown as HostOperationRow | undefined;
      if (!row) fail("native_host_operation_conflict");
      if (row.method === "terminal/create" && (input.outcome === "succeeded" || input.outcome === "failed"
        || input.outcome === "not_started" && row.terminal_id !== null)) fail("native_host_operation_conflict");
      const action = this.getNativeHostAction(row.action_id)!;
      const { submission } = this.ownedSubmission({ submissionId: action.submissionId, fence: input.fence }, true);
      if (submission.status !== "accepted") fail("native_submission_conflict");
      if (row.status === input.outcome && row.result_fingerprint === (input.resultFingerprint ?? null)) return hostOperation(row);
      if (row.status !== "claimed" || action.status !== "running") fail("native_host_operation_conflict");
      db.prepare("UPDATE native_host_operations SET status = ?, result_fingerprint = ?, settled_at = ? WHERE id = ? AND status = 'claimed'")
        .run(input.outcome, input.resultFingerprint ?? null, now, row.id);
      const status = input.outcome === "succeeded" ? row.step === action.methods.length - 1 ? "succeeded" : "running"
        : input.outcome === "not_started" ? "cancelled" : input.outcome;
      db.prepare("UPDATE native_host_actions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, action.id);
      return this.listNativeHostOperations(action.id)[row.step]!;
    });
  }

  recordNativeHostTerminalStart(input: NativeHostTerminalKey, now: string): NativeHostOperation {
    validateTerminalKey(input, []);
    return this.transaction(now, () => {
      const { row, action } = this.ownedTerminal(input, true);
      if (row.terminal_id !== null) {
        if (row.terminal_id !== input.terminalId) fail("native_host_operation_conflict");
        return hostOperation(row);
      }
      if (row.status !== "claimed" || action.status !== "running" || row.reply_observed_at !== null) fail("native_host_operation_conflict");
      const db = this.context.database;
      if (db.prepare("SELECT id FROM native_host_operations WHERE submission_id = ? AND terminal_id = ?")
        .get(row.submission_id, input.terminalId)) fail("native_host_operation_conflict");
      db.prepare("UPDATE native_host_operations SET terminal_id = ?, terminal_started_at = ? WHERE id = ? AND terminal_id IS NULL")
        .run(input.terminalId, now, row.id);
      return hostOperation({ ...row, terminal_id: input.terminalId, terminal_started_at: now });
    });
  }

  settleNativeHostTerminalExit(input: SettleNativeHostTerminalExitInput, now: string): NativeHostOperation {
    validateTerminalKey(input, ["exit"]);
    const exit = input.exit;
    if (!exit || Object.keys(exit).some(key => !["exitCode", "signal"].includes(key))
      || !(exit.signal === null && Number.isSafeInteger(exit.exitCode) && exit.exitCode! >= 0 && exit.exitCode! <= 4294967295
        || exit.exitCode === null && typeof exit.signal === "string" && /^SIG[A-Z0-9]{1,28}$/.test(exit.signal))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const { row, action } = this.ownedTerminal(input, true);
      if (row.terminal_id !== input.terminalId || row.terminal_started_at === null) fail("native_host_operation_conflict");
      const encoded = JSON.stringify({ exitCode: exit.exitCode, signal: exit.signal });
      if (row.terminal_exit_json !== null) {
        if (row.terminal_exit_json !== encoded) fail("native_host_operation_conflict");
        return hostOperation(row);
      }
      if (row.status !== "claimed" || action.status !== "running") fail("native_host_operation_conflict");
      const status = exit.exitCode === 0 ? "succeeded" : "failed";
      const result = createHash("sha256").update(encoded).digest("hex");
      const db = this.context.database;
      db.prepare(`UPDATE native_host_operations SET terminal_exit_json = ?, status = ?, result_fingerprint = ?, settled_at = ?
        WHERE id = ? AND status = 'claimed'`).run(encoded, status, result, now, row.id);
      db.prepare("UPDATE native_host_actions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, action.id);
      return hostOperation({ ...row, terminal_exit_json: encoded, status, result_fingerprint: result, settled_at: now });
    });
  }

  assertNativeHostTerminalReply(input: AssertNativeHostTerminalReplyInput, now: string): NativeHostOperation {
    validateTerminalKey(input, ["kind"]);
    if (!["create", "output", "exit"].includes(input.kind)) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const { row, action } = this.ownedTerminal(input, false);
      if (row.terminal_id !== input.terminalId || row.terminal_started_at === null
        || !["claimed", "succeeded", "failed"].includes(row.status)
        || !["running", "succeeded", "failed"].includes(action.status)
        || (input.kind === "create" ? row.reply_observed_at !== null
          : row.reply_observed_at === null || row.reply_status !== "written")
        || input.kind === "exit" && row.terminal_exit_json === null) fail("native_host_operation_conflict");
      this.assertHostAuthorization(action, row.step, JSON.parse(row.request_key) as string | number, now, input.kind !== "create");
      return hostOperation(row);
    });
  }

  private ownedTerminal(input: NativeHostTerminalKey, allowCancelling: boolean) {
    const row = this.context.database.prepare("SELECT * FROM native_host_operations WHERE id = ?")
      .get(input.operationId) as unknown as HostOperationRow | undefined;
    if (!row || row.method !== "terminal/create") fail("native_host_operation_conflict");
    const action = this.getNativeHostAction(row.action_id)!;
    const { submission } = this.ownedSubmission({ submissionId: action.submissionId, fence: input.fence }, allowCancelling);
    if (submission.status !== "accepted") fail("native_submission_conflict");
    return { row, action };
  }

  private assertHostAuthorization(action: NativeHostAction, step: number, requestId: string | number, now: string, delivered = false): void {
    if (action.authorization.kind === "policy") return;
    const row = this.approvalRow(action.authorization.approvalId);
    const approval = row && this.ports.getApprovalRequest(row.approval_id);
    if (!row || row.submission_id !== action.submissionId || row.resolved_at || !approval
      || approval.status !== "approved" || approval.decisionKind !== "approve_once" || approval.toolCallId !== action.toolCallId
      || hostApprovalFingerprint(approval) !== action.authorization.fingerprint
      || !hostPlanMatchesApproval(action.methods, approval) || !approval.expiresAt
      || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.parse(now)
      || (step === 0 && row.method !== "session/request_permission" && row.request_key !== JSON.stringify(requestId))
      || row.reply_status !== (row.method === "session/request_permission" || step > 0 || delivered ? "written" : "pending")) fail("native_approval_unavailable");
    try { assertApprovalDecisionAvailable(approval, "approve_once"); } catch { fail("native_approval_unavailable"); }
  }

  assertNativeHostOperationReply(input: AssertNativeHostOperationReplyInput, now: string): NativeHostOperation {
    if (!validText(input.operationId) || !digest(input.resultFingerprint)
      || Object.keys(input).some(key => !["operationId", "fence", "resultFingerprint"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const row = this.context.database.prepare("SELECT * FROM native_host_operations WHERE id = ?")
        .get(input.operationId) as unknown as HostOperationRow | undefined;
      if (!row || row.method === "terminal/create" || row.status !== "succeeded"
        || row.result_fingerprint !== input.resultFingerprint) fail("native_host_operation_conflict");
      const action = this.getNativeHostAction(row.action_id)!;
      const { submission } = this.ownedSubmission({ submissionId: action.submissionId, fence: input.fence });
      if (submission.status !== "accepted") fail("native_submission_conflict");
      if (!["running", "succeeded"].includes(action.status)) fail("native_host_operation_conflict");
      this.assertHostAuthorization(action, row.step, JSON.parse(row.request_key) as string | number, now);
      return hostOperation(row);
    });
  }

  observeNativeHostOperationReply(input: ObserveNativeHostOperationReplyInput, now: string): NativeHostOperation {
    if (!validText(input.operationId) || !validRequestId(input.requestId)
      || !["written", "not_written", "unknown"].includes(input.outcome)
      || Object.keys(input).some(key => !["operationId", "fence", "requestId", "method", "outcome"].includes(key))) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const db = this.context.database;
      const row = db.prepare("SELECT * FROM native_host_operations WHERE id = ?").get(input.operationId) as unknown as HostOperationRow | undefined;
      if (!row || row.method !== input.method || row.request_key !== JSON.stringify(input.requestId)) fail("native_host_operation_conflict");
      // Transport callbacks may arrive after retirement. Annotate only the immutable
      // original owner, without restoring its execution authority or changing effects.
      const submission = this.getNativeSubmission(row.submission_id);
      if (!submission || !isDeepStrictEqual(submission.fence, input.fence)) fail("native_owner_mismatch");
      if (row.reply_observed_at !== null) {
        if (row.reply_status !== input.outcome) fail("native_host_operation_conflict");
        return hostOperation(row);
      }
      db.prepare("UPDATE native_host_operations SET reply_status = ?, reply_observed_at = ? WHERE id = ? AND reply_observed_at IS NULL")
        .run(input.outcome, now, row.id);
      return hostOperation({ ...row, reply_status: input.outcome, reply_observed_at: now });
    });
  }

  claimNativeApprovalReply(input: NativeApprovalKey, now: string): NativeApprovalRecord {
    return this.transaction(now, () => {
      const row = this.ownedApproval(input);
      const approval = this.ports.getApprovalRequest(input.approvalId)!;
      if (row.reply_status !== "pending" || row.resolved_at || !["approved", "denied"].includes(approval.status)
        || (approval.expiresAt && (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.parse(now)))) fail("native_approval_unavailable");
      if (approval.status === "approved") {
        const expected = approval.payload.type === "native_permission_request" ? "approve_permission_scope" : "approve_once";
        if (approval.decisionKind !== expected) fail("native_approval_unavailable");
        try { assertApprovalDecisionAvailable(approval, expected); }
        catch { fail("native_approval_unavailable"); }
      }
      this.context.database.prepare("UPDATE native_approval_requests SET reply_status = 'claimed' WHERE approval_id = ? AND reply_status = 'pending'")
        .run(input.approvalId);
      return { approval, correlation: this.getNativeApprovalCorrelation(input.approvalId)! };
    });
  }

  settleNativeApprovalReply(input: NativeApprovalKey & { readonly outcome: "written" | "not_written" | "unknown" }, now: string): NativeApprovalCorrelation {
    if (!["written", "not_written", "unknown"].includes(input.outcome)) fail("native_journal_invalid");
    return this.transaction(now, () => {
      const row = this.ownedApproval(input, true);
      if (row.reply_status !== "claimed" || row.resolved_at) fail("native_approval_unavailable");
      this.context.database.prepare("UPDATE native_approval_requests SET reply_status = ? WHERE approval_id = ?")
        .run(input.outcome, input.approvalId);
      return this.getNativeApprovalCorrelation(input.approvalId)!;
    });
  }

  resolveNativeApprovalRequest(input: NativeApprovalKey, now: string): NativeApprovalCorrelation {
    return this.transaction(now, () => {
      const row = this.ownedApproval(input, true);
      this.retireApproval(row, now);
      return this.getNativeApprovalCorrelation(input.approvalId)!;
    });
  }

  synchronizeNativeApprovalWait(input: NativeSubmissionKey, now: string) {
    return this.transaction(now, () => {
      const { submission: current } = this.ownedSubmission(input, true);
      const rows = this.context.database.prepare("SELECT * FROM native_approval_requests WHERE submission_id = ? ORDER BY rowid")
        .all(current.id) as unknown as ApprovalRow[];
      return synchronizeNativeApprovalWait(this.context, this.ports.wait, current, rows.map(row => this.approvalRecord(row)), now);
    });
  }

  publishNativeApprovalDecision(approvalId: string, now: string) {
    return this.transaction(now, () => {
      const row = this.approvalRow(approvalId);
      if (!row) return undefined;
      return publishNativeApprovalDecision(this.context, this.ports.wait, this.approvalRecord(row).approval);
    });
  }

  appendNativeRunEvents(input: AppendNativeRunEventsInput, now: string) {
    const events = validateNativeRunOutput(input);
    const artifacts = validateNativeArtifacts(input);
    return this.transaction(now, () => {
      const { submission: current, binding: selected } = this.ownedSubmission(input, Boolean(input.terminal));
      const matched = isAcp(selected)
        ? validRequestId(input.nativePromptRequestId) && current.nativePromptRequestId === input.nativePromptRequestId && input.nativeTurnId === undefined
        : validText(input.nativeTurnId) && current.nativeTurnId === input.nativeTurnId && input.nativePromptRequestId === undefined;
      if (!validText(input.nativeSessionId) || selected.nativeSessionId !== input.nativeSessionId || !matched) fail("native_owner_mismatch");
      if (current.status !== "accepted" && (!input.terminal || current.status !== input.terminal)) fail("native_submission_conflict");
      if (input.terminal) this.assertHostEffectsSettled(current.id);
      const published = publishNativeArtifacts(this.ports.artifacts, current, events, artifacts, now);
      const result = appendNativeRunOutput(this.context, this.ports.wait, current, input, published);
      if (input.terminal && current.status === "accepted") {
        this.retireHostActions(current.id, now);
        this.retireApprovals(current.id, now);
        this.transition(current, input.terminal, now);
      }
      return result;
    });
  }

  private ownedApproval(input: NativeApprovalKey, allowCancelling = false): ApprovalRow {
    const row = this.approvalRow(input.approvalId);
    if (!row) fail("native_approval_unavailable");
    const owned = this.ownedSubmission({ submissionId: row.submission_id, fence: input.fence }, allowCancelling);
    if (owned.submission.status !== "accepted") fail("native_approval_unavailable");
    return row;
  }

  private assertHostEffectsSettled(submissionId: string): void {
    if (this.context.database.prepare("SELECT id FROM native_host_operations WHERE submission_id = ? AND status IN ('claimed', 'unknown') LIMIT 1")
      .get(submissionId)) fail("native_host_effect_unresolved");
  }

  private retireHostActions(submissionId: string, now: string): void {
    const db = this.context.database;
    // Losing ownership after a claim cannot prove that the OS operation never ran.
    db.prepare("UPDATE native_host_operations SET status = 'unknown', settled_at = ? WHERE submission_id = ? AND status = 'claimed'")
      .run(now, submissionId);
    db.prepare(`UPDATE native_host_actions SET status = 'unknown', updated_at = ? WHERE submission_id = ?
      AND id IN (SELECT action_id FROM native_host_operations WHERE submission_id = ? AND status = 'unknown')`).run(now, submissionId, submissionId);
    db.prepare("UPDATE native_host_actions SET status = 'cancelled', updated_at = ? WHERE submission_id = ? AND status IN ('reserved', 'running')")
      .run(now, submissionId);
  }

  private approvalRow(id: string): ApprovalRow | undefined {
    return this.context.database.prepare("SELECT * FROM native_approval_requests WHERE approval_id = ?")
      .get(id) as unknown as ApprovalRow | undefined;
  }

  private approvalRecord(row: ApprovalRow): NativeApprovalRecord {
    const approval = this.ports.getApprovalRequest(row.approval_id);
    if (!approval) fail("native_approval_unavailable");
    return { approval, correlation: correlation(row) };
  }

  private retireApprovals(submissionId: string, now: string): void {
    const rows = this.context.database.prepare("SELECT * FROM native_approval_requests WHERE submission_id = ? AND resolved_at IS NULL")
      .all(submissionId) as unknown as ApprovalRow[];
    for (const row of rows) this.retireApproval(row, now);
  }

  private retireApproval(row: ApprovalRow, now: string): void {
    if (row.resolved_at) return;
    const approval = this.ports.getApprovalRequest(row.approval_id);
    if (approval?.status === "pending") this.ports.cancelApprovalRequest(approval.id, now);
    // A claim may have reached the pipe before a resolution callback overtook its writer.
    const status = row.reply_status === "claimed" ? "unknown" : row.reply_status === "pending" ? "not_written" : row.reply_status;
    this.context.database.prepare("UPDATE native_approval_requests SET reply_status = ?, resolved_at = ? WHERE approval_id = ?")
      .run(status, now, row.approval_id);
  }

  private ownedSubmission(input: NativeSubmissionKey, allowCancelling = false) {
    const current = this.getNativeSubmission(input.submissionId);
    if (!current || !isDeepStrictEqual(current.fence, input.fence)) fail("native_owner_mismatch");
    const selected = this.getNativeExecutionBinding(current.bindingId);
    if (!selected) fail("native_binding_conflict");
    const owner = this.owner(current.runId, input.fence, selected.selection.engineId, allowCancelling);
    if (owner.thread_id !== selected.threadId || owner.participant_id !== selected.participantId || owner.cwd !== selected.cwd) fail("native_owner_mismatch");
    return { submission: current, binding: selected, owner };
  }

  private owner(runId: string, fence: RuntimeAttemptFenceV1, engineId: string, allowCancelling = false): OwnerRow {
    if (!validText(runId) || !fence || ![fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken].every(value => validText(value))) {
      fail("native_owner_mismatch");
    }
    const row = this.context.database.prepare(`SELECT r.thread_id, COALESCE(r.teammate_id, '') AS participant_id,
      r.task_id, r.channel_id, r.cwd FROM run_sessions r
      JOIN ling_threads t ON t.id = r.thread_id
      JOIN work_units w ON w.id = r.work_unit_id AND w.linked_run_id = r.id
      JOIN work_unit_attempts a ON a.id = w.active_attempt_id AND a.work_unit_id = w.id
      WHERE r.id = ? AND w.id = ? AND a.id = ? AND a.runtime_instance_id = ? AND a.fencing_token = ?
        AND a.effective_runner_id = ? AND w.workspace_id = ? AND t.workspace_id = ?
        AND (a.status IN ('created', 'started', 'waiting_for_approval') OR (? = 1 AND a.status = 'cancelling'))
        AND (w.status IN ('queued', 'claimed', 'running', 'waiting_for_approval') OR (? = 1 AND w.status = 'cancelling'))
        AND r.status IN ('queued', 'running', 'waiting_for_approval') AND t.archived_at IS NULL`)
      .get(runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken,
        engineId, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, Number(allowCancelling), Number(allowCancelling)) as unknown as OwnerRow | undefined;
    if (!row) fail("native_owner_mismatch");
    this.ports.assertWorkspaceSnapshotFence(row.cwd);
    return row;
  }

  private transition(current: NativeSubmission, status: NativeSubmissionStatus, now: string): NativeSubmission {
    const result = this.context.database.prepare("UPDATE native_submissions SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(status, now, current.id, current.status);
    if (result.changes !== 1) fail("native_submission_conflict");
    return this.getNativeSubmission(current.id)!;
  }

  private transaction<T>(now: string, operation: () => T): T {
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) fail("native_journal_invalid");
    const db = this.context.database;
    db.exec("SAVEPOINT native_execution_journal");
    try {
      // Acquire the write reservation before owner/idempotency reads, including under WAL.
      db.prepare("UPDATE native_execution_bindings SET id = id WHERE 0").run();
      const result = operation();
      db.exec("RELEASE native_execution_journal");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK TO native_execution_journal; RELEASE native_execution_journal;"); }
      catch { /* SQLite can already have aborted the transaction; preserve the cause. */ }
      throw error;
    }
  }
}

function binding(row: BindingRow): NativeExecutionBinding {
  const selection = JSON.parse(row.selection_json) as NativeExecutionSelection;
  validateSelection(selection);
  const openclawSession = row.openclaw_session_key === null ? undefined : {
    agentId: row.openclaw_agent_id!, sessionKey: row.openclaw_session_key,
    ...(row.openclaw_accepted_at === null ? {} : { acceptedAt: row.openclaw_accepted_at }),
  };
  if (openclawSession) {
    validateNativeOpenClawSessionRoute({ agentId: openclawSession.agentId, sessionKey: openclawSession.sessionKey,
      requireExistingSession: openclawSession.acceptedAt !== undefined });
    if (selection.engineId !== "openclaw-acp" || (openclawSession.acceptedAt !== undefined
      && !Number.isFinite(Date.parse(openclawSession.acceptedAt)))) fail("native_journal_invalid");
  } else if (row.openclaw_agent_id !== null || row.openclaw_accepted_at !== null) fail("native_journal_invalid");
  return { id: row.id, threadId: row.thread_id, participantId: row.participant_id, cwd: row.cwd, generation: row.generation,
    selection, ...(row.native_session_id === null ? {} : { nativeSessionId: row.native_session_id }),
    ...(openclawSession ? { openclawSession } : {}), createdAt: row.created_at };
}
function submission(row: SubmissionRow): NativeSubmission {
  return { id: row.id, bindingId: row.binding_id, runId: row.run_id,
    fence: { workUnitId: row.work_unit_id, attemptId: row.attempt_id, runtimeInstanceId: row.runtime_instance_id, fencingToken: row.fencing_token },
    status: row.status, ...(row.native_turn_id === null ? {} : { nativeTurnId: row.native_turn_id }),
    ...(row.native_prompt_request_key === null ? {} : { nativePromptRequestId: JSON.parse(row.native_prompt_request_key) as string | number }),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function correlation(row: ApprovalRow): NativeApprovalCorrelation {
  return { approvalId: row.approval_id, submissionId: row.submission_id, requestId: JSON.parse(row.request_key) as string | number,
    method: row.method, replyStatus: row.reply_status, ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }) };
}
function hostAction(row: HostActionRow): NativeHostAction {
  return { id: row.id, submissionId: row.submission_id, toolCallId: row.tool_call_id,
    actionFingerprint: row.action_fingerprint, policyFingerprint: row.policy_fingerprint,
    methods: JSON.parse(row.methods_json) as NativeHostAction["methods"],
    authorization: JSON.parse(row.authorization_json) as NativeHostAction["authorization"],
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function hostOperation(row: HostOperationRow): NativeHostOperation {
  return { id: row.id, actionId: row.action_id, step: row.step, requestId: JSON.parse(row.request_key) as string | number,
    method: row.method, operationFingerprint: row.operation_fingerprint, status: row.status, claimedAt: row.claimed_at,
    replyStatus: row.reply_status, ...(row.reply_observed_at === null ? {} : { replyObservedAt: row.reply_observed_at }),
    ...(row.terminal_id === null ? {} : { terminal: { terminalId: row.terminal_id, startedAt: row.terminal_started_at!,
      ...(row.terminal_exit_json === null ? {} : { exit: JSON.parse(row.terminal_exit_json) as SettleNativeHostTerminalExitInput["exit"] }) } }),
    ...(row.result_fingerprint === null ? {} : { resultFingerprint: row.result_fingerprint }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }) };
}
function validHostPlan(value: unknown): value is NativeHostAction["methods"] {
  return Array.isArray(value) && (value.length === 1 && ["fs/read_text_file", "fs/write_text_file", "terminal/create"].includes(value[0])
    || value.length === 2 && value[0] === "fs/read_text_file" && value[1] === "fs/write_text_file");
}
function hostPlanMatchesApproval(methods: NativeHostAction["methods"], approval: ApprovalRequest): boolean {
  const { payload } = approval;
  if (payload.type === "bash") return methods.length === 1 && methods[0] === "terminal/create";
  if (payload.type === "file_write") return methods.at(-1) === "fs/write_text_file";
  if (payload.type === "file_edit") return methods.length === 2 && methods[0] === "fs/read_text_file" && methods[1] === "fs/write_text_file";
  return payload.type === "tool_call" && payload.toolName === "read" && methods.length === 1 && methods[0] === "fs/read_text_file";
}
function hostApprovalFingerprint(approval: ApprovalRequest): string {
  return createHash("sha256").update(JSON.stringify([approval.toolCallId, approval.actionType, approval.risk, approval.payload])).digest("hex");
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validateTerminalKey(input: NativeHostTerminalKey, extra: readonly string[]): void {
  if (!validText(input.operationId) || !validText(input.terminalId)
    || Object.keys(input).some(key => !["operationId", "fence", "terminalId", ...extra].includes(key))) fail("native_journal_invalid");
}
function validateSelection(value: NativeExecutionSelection): void {
  if (!value || !isExternalExecutionEngineId(value.engineId) || !validText(value.profileId)
    || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1 || (value.modelId !== undefined && !validText(value.modelId))
    || !/^[a-f0-9]{64}$/.test(value.profileFingerprint) || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint)
    || Object.keys(value).some(key => !["engineId", "profileId", "profileRevision", "profileFingerprint", "modelId", "configurationFingerprint"].includes(key))) fail("native_journal_invalid");
}
function canonicalSelection(value: NativeExecutionSelection): NativeExecutionSelection {
  validateSelection(value);
  return { engineId: value.engineId, profileId: value.profileId, profileRevision: value.profileRevision,
    profileFingerprint: value.profileFingerprint, configurationFingerprint: value.configurationFingerprint,
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }) };
}
function validText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function validRequestId(value: unknown): value is string | number {
  return validText(value) || (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0));
}
function isAcp(value: NativeExecutionBinding): boolean {
  return value.selection.engineId === "kimi-acp" || value.selection.engineId === "openclaw-acp";
}
function fail(code: NativeExecutionJournalError["code"]): never { throw new NativeExecutionJournalError(code); }
