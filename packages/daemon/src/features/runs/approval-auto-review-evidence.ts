import { createHash } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  approvalSideEffectFingerprintV1,
  redactSecrets,
  type ApprovalRequest,
  type EffectiveRunPolicySnapshot,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type {
  UserInputAnswerTranscriptV1,
  UserInputRequestTranscriptV1,
  UserInputTranscriptAnswerV1,
  UserInputTranscriptItemV1,
} from "@ling-stack/contracts";

const DEFAULT_MAX_SNAPSHOT_CHARS = 24_000;
const MAX_QUESTION_ANSWER_GROUPS = 32;

type EvidenceStore = Pick<RunStore,
  | "getApprovalPolicy"
  | "getLingThread"
  | "getLingTurnForRun"
  | "isCurrentRunExecutionOwner"
  | "isRecoverableApprovalReviewOwner"
  | "listConversationItemsForTurn"
  | "listLingTurnRuns"
  | "readUserInputTranscript"
>;

export interface ApprovalAutoReviewQuestionAnswerGroupV1 {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly waitMode: "optional" | "required";
  readonly questions: UserInputRequestTranscriptV1["questions"];
  readonly answers: readonly UserInputTranscriptAnswerV1[];
  readonly source: {
    readonly runId: string;
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly participantId: string;
    readonly requestItemId: string;
    readonly answerItemId: string;
  };
}

export interface ApprovalAutoReviewEvidenceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly context: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly participantId: string;
    readonly workflowStepId?: string;
    readonly cwd: string;
    readonly userInstruction: string;
  };
  readonly action: {
    readonly approvalId: string;
    readonly approvalCreatedAt: string;
    readonly toolCallId: string;
    readonly actionType: ApprovalRequest["actionType"];
    readonly risk: ApprovalRequest["risk"];
    readonly title: string;
    readonly description: string;
    readonly payload: ApprovalRequest["payload"];
    readonly fingerprint: string;
  };
  readonly policy: {
    readonly authorizationMode: "smart";
    readonly workspaceAccessMode?: EffectiveRunPolicySnapshot["workspaceAccessMode"];
    readonly conversationMode?: EffectiveRunPolicySnapshot["conversationMode"];
    readonly toolDecisions: EffectiveRunPolicySnapshot["toolDecisions"];
    readonly allowedWritePaths: readonly string[];
    readonly workspacePolicyUpdatedAt: string;
    readonly riskNotes: EffectiveRunPolicySnapshot["riskNotes"];
  };
  readonly questionAnswerGroups: readonly ApprovalAutoReviewQuestionAnswerGroupV1[];
}

export type ApprovalAutoReviewEvidenceFailureCode =
  | "approval_not_pending"
  | "approval_identity_mismatch"
  | "authorization_mode_mismatch"
  | "execution_stale"
  | "policy_stale"
  | "conversation_lineage_missing"
  | "question_answer_unavailable"
  | "question_answer_scope_mismatch"
  | "question_answer_incomplete"
  | "sensitive_evidence"
  | "evidence_over_budget";

export type ApprovalAutoReviewEvidenceResult =
  | {
      readonly ok: true;
      readonly snapshot: ApprovalAutoReviewEvidenceSnapshotV1;
      readonly fingerprint: string;
      readonly serialized: string;
    }
  | {
      readonly ok: false;
      readonly code: ApprovalAutoReviewEvidenceFailureCode;
      readonly reason: string;
    };

/**
 * Builds the only model-visible automatic-review payload. It deliberately
 * excludes provider credentials, raw request snapshots, Memory, skills,
 * assistant narration, tool output, and runtime fencing tokens.
 */
export function buildApprovalAutoReviewEvidence(input: {
  readonly store: EvidenceStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly maxSnapshotChars?: number;
  readonly sourceAuthority?: "active_execution" | "recoverable_suspension";
}): ApprovalAutoReviewEvidenceResult {
  if (input.approval.status !== "pending") {
    return failure("approval_not_pending", "Automatic review only accepts a pending approval.");
  }
  if (!input.approval.runId || !input.approval.toolCallId
    || input.approval.runId !== input.run.id || input.run.workUnitId !== input.sourceFence.workUnitId) {
    return failure("approval_identity_mismatch", "Automatic review approval and Run ownership do not match.");
  }
  if (input.effectivePolicySnapshot.authorizationMode !== "smart") {
    return failure("authorization_mode_mismatch", "Automatic review is available only in smart authorization mode.");
  }
  const sourceCurrent = input.sourceAuthority === "recoverable_suspension"
    ? input.store.isRecoverableApprovalReviewOwner(input.approval.id, input.sourceFence)
    : input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence, false);
  if (!sourceCurrent) {
    return failure("execution_stale", "Automatic review source Run or Attempt is no longer current.");
  }
  if (input.store.getApprovalPolicy().updatedAt !== input.effectivePolicySnapshot.workspacePolicyUpdatedAt) {
    return failure("policy_stale", "Automatic review policy changed before evidence capture.");
  }

  const turn = input.store.getLingTurnForRun(input.run.id);
  const thread = turn ? input.store.getLingThread(turn.threadId) : undefined;
  if (!turn || !thread || thread.workspaceId !== DEFAULT_WORKSPACE_ID || turn.workspaceId !== DEFAULT_WORKSPACE_ID
    || input.run.threadId !== thread.id || turn.threadId !== thread.id || turn.activeRunId && turn.activeRunId !== input.run.id
    || turn.taskId !== input.run.taskId || turn.teammateId !== input.run.teammateId
    || turn.workflowStepId !== input.run.workflowStepId) {
    return failure("conversation_lineage_missing", "Automatic review could not prove the current Thread and Turn lineage.");
  }
  const participantId = input.run.teammateId ?? "ling_agent";
  const linkedRun = input.store.listLingTurnRuns(turn.id).some((link) => link.runId === input.run.id);
  if (!linkedRun) {
    return failure("conversation_lineage_missing", "Automatic review Run is not linked to the current Turn.");
  }

  const anchors = input.store.listConversationItemsForTurn({ turnId: turn.id })
    .filter((item) => item.status === "committed"
      && (item.kind === "user_input_request" || item.kind === "user_input_answer"))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  if (anchors.length > MAX_QUESTION_ANSWER_GROUPS * 2) {
    return failure("evidence_over_budget", "Automatic review question history exceeds the bounded evidence budget.");
  }
  const transcript: UserInputTranscriptItemV1[] = [];
  for (let offset = 0; offset < anchors.length; offset += 500) {
    transcript.push(...input.store.readUserInputTranscript({
      threadId: thread.id,
      itemIds: anchors.slice(offset, offset + 500).map((item) => item.id),
    }));
  }
  if (transcript.some((record) => record.availability === "unavailable") || transcript.length !== anchors.length) {
    return failure("question_answer_unavailable", "Automatic review question or answer evidence is unavailable.");
  }
  const scoped = transcript as readonly (UserInputRequestTranscriptV1 | UserInputAnswerTranscriptV1)[];
  if (scoped.some((record) => record.source.workspaceId !== DEFAULT_WORKSPACE_ID
    || record.source.threadId !== thread.id || record.source.turnId !== turn.id || record.source.runId !== input.run.id
    || record.source.participantId !== participantId || record.source.workflowStepId !== input.run.workflowStepId)) {
    return failure("question_answer_scope_mismatch", "Automatic review question or answer belongs to another execution scope.");
  }
  const questionAnswerGroups = pairQuestionAnswerGroups(scoped);
  if (!questionAnswerGroups) {
    return failure("question_answer_incomplete", "Automatic review requires complete, applied question and answer groups.");
  }

  const actionFingerprint = approvalSideEffectFingerprintV1({
    actionType: input.approval.actionType,
    toolCallId: input.approval.toolCallId,
    sideEffect: input.approval.payload,
  });
  const snapshot: ApprovalAutoReviewEvidenceSnapshotV1 = {
    schemaVersion: 1,
    context: {
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: thread.id,
      turnId: turn.id,
      runId: input.run.id,
      attemptId: input.sourceFence.attemptId,
      workUnitId: input.sourceFence.workUnitId,
      participantId,
      ...(input.run.workflowStepId ? { workflowStepId: input.run.workflowStepId } : {}),
      cwd: input.run.cwd,
      userInstruction: turn.userInstruction,
    },
    action: {
      approvalId: input.approval.id,
      approvalCreatedAt: input.approval.createdAt,
      toolCallId: input.approval.toolCallId,
      actionType: input.approval.actionType,
      risk: input.approval.risk,
      title: input.approval.title,
      description: input.approval.description,
      payload: input.approval.payload,
      fingerprint: actionFingerprint,
    },
    policy: {
      authorizationMode: "smart",
      ...(input.effectivePolicySnapshot.workspaceAccessMode
        ? { workspaceAccessMode: input.effectivePolicySnapshot.workspaceAccessMode }
        : {}),
      ...(input.effectivePolicySnapshot.conversationMode
        ? { conversationMode: input.effectivePolicySnapshot.conversationMode }
        : {}),
      toolDecisions: input.effectivePolicySnapshot.toolDecisions,
      allowedWritePaths: input.effectivePolicySnapshot.allowedWritePaths,
      workspacePolicyUpdatedAt: input.effectivePolicySnapshot.workspacePolicyUpdatedAt,
      riskNotes: input.effectivePolicySnapshot.riskNotes,
    },
    questionAnswerGroups,
  };
  const redacted = redactSecrets(snapshot, input.extraSecrets ?? []) as ApprovalAutoReviewEvidenceSnapshotV1;
  if (JSON.stringify(redacted) !== JSON.stringify(snapshot)) {
    return failure("sensitive_evidence", "Automatic review evidence contains sensitive content and requires manual review.");
  }
  const serialized = JSON.stringify(redacted);
  const maxSnapshotChars = input.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  if (!Number.isSafeInteger(maxSnapshotChars) || maxSnapshotChars < 1 || serialized.length > maxSnapshotChars) {
    return failure("evidence_over_budget", "Automatic review evidence exceeds the bounded snapshot budget.");
  }
  return {
    ok: true,
    snapshot: redacted,
    serialized,
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
  };
}

function pairQuestionAnswerGroups(
  records: readonly (UserInputRequestTranscriptV1 | UserInputAnswerTranscriptV1)[],
): readonly ApprovalAutoReviewQuestionAnswerGroupV1[] | undefined {
  const grouped = new Map<string, {
    request?: UserInputRequestTranscriptV1;
    answer?: UserInputAnswerTranscriptV1;
  }>();
  for (const record of records) {
    const key = `${record.requestId}:${record.requestVersion}`;
    const group = grouped.get(key) ?? {};
    if (record.kind === "user_input_request") {
      if (group.request) return undefined;
      group.request = record;
    } else {
      if (group.answer) return undefined;
      group.answer = record;
    }
    grouped.set(key, group);
  }
  const result: ApprovalAutoReviewQuestionAnswerGroupV1[] = [];
  for (const group of grouped.values()) {
    if (!group.request || !group.answer || group.request.status !== "answered"
      || group.answer.delivery.status !== "applied"
      || group.request.source.runId !== group.answer.source.runId
      || group.request.source.attemptId !== group.answer.source.attemptId
      || group.request.source.workUnitId !== group.answer.source.workUnitId
      || group.request.source.participantId !== group.answer.source.participantId) {
      return undefined;
    }
    const questionIds = new Set(group.request.questions.map((question) => question.questionId));
    if (group.answer.answers.some((answer) => !questionIds.has(answer.questionId))) return undefined;
    for (const question of group.request.questions) {
      if (question.required && !group.answer.answers.some((answer) => answer.questionId === question.questionId)) {
        return undefined;
      }
    }
    result.push({
      requestId: group.request.requestId,
      requestVersion: group.request.requestVersion,
      waitMode: group.request.waitMode,
      questions: group.request.questions,
      answers: group.answer.answers,
      source: {
        runId: group.request.source.runId,
        attemptId: group.request.source.attemptId,
        workUnitId: group.request.source.workUnitId,
        participantId: group.request.source.participantId,
        requestItemId: group.request.itemId,
        answerItemId: group.answer.itemId,
      },
    });
  }
  return result;
}

function failure(code: ApprovalAutoReviewEvidenceFailureCode, reason: string): ApprovalAutoReviewEvidenceResult {
  return { ok: false, code, reason };
}
