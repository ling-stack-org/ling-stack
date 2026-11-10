import type { ExternalExecutionEngineId, RuntimeAttemptFenceV1 } from "@ling-stack/contracts";
import type { ApprovalPayload, ApprovalRequest, CreateApprovalRequestInput } from "./approval-types.js";
import type { RunEventEnvelope, RunEventDataByType } from "./run-types.js";
import type { HostOperationSource } from "./host-operation-journal-types.js";

export interface NativeExecutionSelection {
  readonly engineId: ExternalExecutionEngineId;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileFingerprint: string;
  readonly modelId?: string;
  readonly configurationFingerprint: string;
}

export interface NativeExecutionBinding {
  readonly id: string;
  readonly threadId: string;
  readonly participantId: string;
  readonly cwd: string;
  readonly generation: number;
  readonly selection: NativeExecutionSelection;
  readonly nativeSessionId?: string;
  readonly openclawSession?: NativeOpenClawSession;
  readonly createdAt: string;
}

export interface NativeOpenClawSession {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly acceptedAt?: string;
}
export interface NativeOpenClawSessionRoute {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly requireExistingSession: boolean;
}

export type NativeSubmissionStatus = "reserved" | "submission_pending" | "accepted" | "unknown"
  | "not_submitted" | "rejected" | "completed" | "failed" | "cancelled";
export type NativeSubmissionTerminal = Exclude<NativeSubmissionStatus, "reserved" | "submission_pending" | "accepted" | "unknown">;

export interface NativeSubmission {
  readonly id: string;
  readonly bindingId: string;
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly status: NativeSubmissionStatus;
  readonly nativeTurnId?: string;
  readonly nativePromptRequestId?: string | number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveNativeExecutionInput {
  readonly runId: string;
  readonly generation: number;
  readonly fence: RuntimeAttemptFenceV1;
  readonly selection: NativeExecutionSelection;
}
export type ResolveNativeExecutionGenerationInput = Omit<ReserveNativeExecutionInput, "generation">;
export interface NativeSubmissionKey {
  readonly submissionId: string;
  readonly fence: RuntimeAttemptFenceV1;
}
export type NativeSubmissionCorrelation =
  | { readonly nativeTurnId: string; readonly nativePromptRequestId?: never }
  | { readonly nativePromptRequestId: string | number; readonly nativeTurnId?: never };
export type BeginNativeSubmissionInput = NativeSubmissionKey & { readonly nativePromptRequestId?: string | number };
export type AcceptNativeSubmissionInput = NativeSubmissionKey & NativeSubmissionCorrelation;
export interface NativeApprovalKey {
  readonly approvalId: string;
  readonly fence: RuntimeAttemptFenceV1;
}
export interface NativeApprovalCorrelation {
  readonly approvalId: string;
  readonly submissionId: string;
  readonly requestId: string | number;
  readonly method: string;
  readonly replyStatus: "pending" | "claimed" | "written" | "not_written" | "unknown";
  readonly resolvedAt?: string;
}
export interface NativeApprovalRecord {
  readonly correlation: NativeApprovalCorrelation;
  readonly approval: ApprovalRequest;
}
export interface NativeApprovalWaitSnapshot {
  readonly approvals: readonly NativeApprovalRecord[];
  readonly pendingApprovalIds: readonly string[];
  readonly events: readonly RunEventEnvelope[];
}
export interface CreateNativeApprovalInput extends NativeSubmissionKey {
  readonly requestId: string | number;
  readonly method: string;
  readonly approval: Pick<CreateApprovalRequestInput, "actionType" | "risk" | "toolCallId" | "title" | "description"
    | "payload" | "expiresAt" | "extraSecrets">;
}

export type NativeHostOperationMethod = "fs/read_text_file" | "fs/write_text_file" | "terminal/create";
export type NativeHostActionStatus = "reserved" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type NativeHostOperationOutcome = "succeeded" | "failed" | "not_started" | "unknown";
export interface NativeHostTerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}
export interface NativeHostAction {
  readonly id: string;
  readonly submissionId: string;
  readonly toolCallId: string;
  readonly actionFingerprint: string;
  readonly policyFingerprint: string;
  readonly methods: readonly NativeHostOperationMethod[];
  readonly authorization: { readonly kind: "approval"; readonly approvalId: string; readonly fingerprint: string } | { readonly kind: "policy" };
  readonly status: NativeHostActionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface NativeHostOperation {
  readonly id: string;
  readonly actionId: string;
  readonly requestId: string | number;
  readonly step: number;
  readonly method: NativeHostOperationMethod;
  readonly operationFingerprint: string;
  readonly status: "claimed" | NativeHostOperationOutcome;
  readonly replyStatus: "written" | "not_written" | "unknown";
  readonly replyObservedAt?: string;
  readonly resultFingerprint?: string;
  readonly claimedAt: string;
  readonly settledAt?: string;
  readonly terminal?: {
    readonly terminalId: string;
    readonly startedAt: string;
    readonly exit?: NativeHostTerminalExit;
  };
}
export interface ReserveNativeHostActionInput extends NativeSubmissionKey {
  readonly nativeSessionId: string;
  readonly toolCallId: string;
  readonly actionFingerprint: string;
  readonly policyFingerprint: string;
  readonly methods: readonly NativeHostOperationMethod[];
  /** Trusted target supplies its evaluated policy identity or exact saved approval payload. */
  readonly authorization: { readonly kind: "approval"; readonly approvalId: string; readonly payload: ApprovalPayload } | { readonly kind: "policy" };
}
export interface ClaimNativeHostOperationInput {
  readonly actionId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly step: number;
  readonly requestId: string | number;
  readonly operationFingerprint: string;
  readonly actionFingerprint: string;
  readonly policyFingerprint: string;
}
export interface SettleNativeHostOperationInput {
  readonly operationId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly outcome: NativeHostOperationOutcome;
  readonly resultFingerprint?: string;
}
export interface AssertNativeHostOperationReplyInput {
  readonly operationId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly resultFingerprint: string;
}
export interface ObserveNativeHostOperationReplyInput {
  readonly operationId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly requestId: string | number;
  readonly method: NativeHostOperationMethod;
  readonly outcome: NativeHostOperation["replyStatus"];
}
export interface NativeHostTerminalKey {
  readonly operationId: string;
  readonly fence: RuntimeAttemptFenceV1;
  readonly terminalId: string;
}
export interface AssertNativeHostTerminalReplyInput extends NativeHostTerminalKey {
  readonly kind: "create" | "output" | "exit";
}
export interface SettleNativeHostTerminalExitInput extends NativeHostTerminalKey {
  readonly exit: NativeHostTerminalExit;
}

export type NativeRunOutputType = "turn_start" | "turn_end" | "assistant_text_delta" | "assistant_thinking_delta"
  | "tool_start" | "tool_update" | "tool_end" | "message_end" | "progress";
export type NativeRunOutput = { [K in NativeRunOutputType]: { readonly type: K; readonly data: RunEventDataByType[K] } }[NativeRunOutputType];
/** Metadata for bytes already validated and materialized by the daemon, never a native file path. */
export interface NativeRunArtifact {
  readonly eventIndex: number;
  readonly contentIndex: number;
  /** Legacy field name for the source item identity, including assistant content items. */
  readonly toolCallId: string;
  readonly sourceKind?: "assistant";
  readonly kind: "image" | "text";
  readonly sha256: string;
  readonly sizeBytes: number;
}
export type AppendNativeRunEventsInput = NativeSubmissionKey & NativeSubmissionCorrelation & {
  readonly nativeSessionId: string;
  readonly firstSequence: number;
  readonly events: readonly NativeRunOutput[];
  readonly artifacts?: readonly NativeRunArtifact[];
  readonly terminal?: "completed" | "failed" | "cancelled";
  readonly extraSecrets?: readonly string[];
};

/** Internal persistence port. It neither grants workspace permission nor certifies an engine. */
export interface NativeExecutionStore {
  resolveNativeExecutionGeneration(input: ResolveNativeExecutionGenerationInput): number;
  reserveNativeExecution(input: ReserveNativeExecutionInput, now: string): {
    readonly binding: NativeExecutionBinding; readonly submission: NativeSubmission; readonly created: boolean;
  };
  getNativeExecutionBinding(id: string): NativeExecutionBinding | undefined;
  getNativeSubmission(id: string): NativeSubmission | undefined;
  listNativeAttemptSubmissions(source: HostOperationSource): readonly NativeSubmission[];
  listUnresolvedNativeSubmissions(limit?: number): NativeSubmission[];
  prepareNativeOpenClawSession(input: NativeSubmissionKey & { readonly agentId: string }, now: string): NativeOpenClawSessionRoute;
  bindNativeExecutionSession(input: NativeSubmissionKey & { readonly nativeSessionId: string }, now: string): NativeExecutionBinding;
  beginNativeSubmission(input: BeginNativeSubmissionInput, now: string): NativeSubmission;
  /** ACP acceptance requires validated native activity/result, not a successful pipe write. */
  acceptNativeSubmission(input: AcceptNativeSubmissionInput, now: string): NativeSubmission;
  markNativeSubmissionUnknown(input: NativeSubmissionKey, now: string): NativeSubmission;
  /** not_submitted requires live proof that transport was never invoked, never absence of an acknowledgement. */
  finishNativeSubmission(input: NativeSubmissionKey & { readonly outcome: NativeSubmissionTerminal }, now: string): NativeSubmission;
  createNativeApproval(input: CreateNativeApprovalInput, now: string): NativeApprovalRecord;
  reserveNativeHostAction(input: ReserveNativeHostActionInput, now: string): { readonly action: NativeHostAction; readonly created: boolean };
  getNativeHostAction(id: string): NativeHostAction | undefined;
  listNativeHostOperations(actionId: string): NativeHostOperation[];
  /** One durable effect permit, never reusable even with identical input or after reopen. */
  claimNativeHostOperation(input: ClaimNativeHostOperationInput, now: string): NativeHostOperation;
  settleNativeHostOperation(input: SettleNativeHostOperationInput, now: string): NativeHostOperation;
  /** Records the handle after a unique launch claim; does not settle the command. */
  recordNativeHostTerminalStart(input: NativeHostTerminalKey, now: string): NativeHostOperation;
  /** Only an observed process exit settles a started terminal, never delivery of its handle. */
  settleNativeHostTerminalExit(input: SettleNativeHostTerminalExitInput, now: string): NativeHostOperation;
  assertNativeHostTerminalReply(input: AssertNativeHostTerminalReplyInput, now: string): NativeHostOperation;
  /** Revalidate current non-cancelling ownership and authorization before disclosing an effect result. */
  assertNativeHostOperationReply(input: AssertNativeHostOperationReplyInput, now: string): NativeHostOperation;
  /** Records a transport observation for the original owner; never authorizes or replays work. */
  observeNativeHostOperationReply(input: ObserveNativeHostOperationReplyInput, now: string): NativeHostOperation;
  getNativeApprovalCorrelation(approvalId: string): NativeApprovalCorrelation | undefined;
  claimNativeApprovalReply(input: NativeApprovalKey, now: string): NativeApprovalRecord;
  settleNativeApprovalReply(input: NativeApprovalKey & { readonly outcome: "written" | "not_written" | "unknown" }, now: string): NativeApprovalCorrelation;
  resolveNativeApprovalRequest(input: NativeApprovalKey, now: string): NativeApprovalCorrelation;
  synchronizeNativeApprovalWait(input: NativeSubmissionKey, now: string): NativeApprovalWaitSnapshot;
  /** Publishes an already saved user decision, without changing execution state or granting a reply. */
  publishNativeApprovalDecision(approvalId: string, now: string): RunEventEnvelope | undefined;
  appendNativeRunEvents(input: AppendNativeRunEventsInput, now: string): { readonly events: readonly RunEventEnvelope[]; readonly created: boolean };
}

export class NativeExecutionJournalError extends Error {
  constructor(readonly code: "native_journal_invalid" | "native_owner_mismatch" | "native_binding_conflict"
    | "native_submission_conflict" | "native_session_missing" | "native_session_busy" | "native_approval_conflict"
    | "native_approval_unavailable" | "native_output_conflict" | "native_host_operation_conflict"
    | "native_host_effect_unresolved") { super(code); }
}
