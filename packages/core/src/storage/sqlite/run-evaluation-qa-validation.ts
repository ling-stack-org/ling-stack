import type { RunEvaluationTaskFence, EnqueueRunEvaluationTaskInput, AdmitRunEvaluationTaskDispatchInput, CompleteRunEvaluationTaskInput } from "../../harness/evaluation-tasks.js";
import { taskDigest, taskIdentity, taskInteger, taskLimit, taskRecord, taskTime, validateTaskArtifactPin, validateTaskInput } from "./run-evaluation-task-validation.js";
import { RunEvaluationInputError } from "../../harness/evaluation-json.js";
export const QA_FENCE_FIELDS = ["taskId", "attemptId", "expectedTaskRevision", "expectedAttemptRevision", "claimOwner", "claimToken", "now"] as const;
const ENQUEUE_FIELDS = ["evaluationId", "evaluationKey", "frozenGraderArtifact", "frozenGraderDigest", "repeatOrdinal", "now"] as const;
const ADMIT_FIELDS = [...QA_FENCE_FIELDS, "requestDigest", "executionScopeDigest"];
export function qaFence(value: RunEvaluationTaskFence): RunEvaluationTaskFence {
  return { taskId: value.taskId, attemptId: value.attemptId, expectedTaskRevision: value.expectedTaskRevision, expectedAttemptRevision: value.expectedAttemptRevision, claimOwner: value.claimOwner, claimToken: value.claimToken, now: value.now };
}
export function qaEnqueue(value: EnqueueRunEvaluationTaskInput): EnqueueRunEvaluationTaskInput {
  return { evaluationId: value.evaluationId, evaluationKey: value.evaluationKey, frozenGraderArtifact: value.frozenGraderArtifact, frozenGraderDigest: value.frozenGraderDigest, repeatOrdinal: value.repeatOrdinal, now: value.now };
}
export function qaAdmit(value: AdmitRunEvaluationTaskDispatchInput): AdmitRunEvaluationTaskDispatchInput {
  return { ...qaFence(value), requestDigest: value.requestDigest, executionScopeDigest: value.executionScopeDigest };
}
export function qaComplete(value: CompleteRunEvaluationTaskInput): CompleteRunEvaluationTaskInput { return { ...qaFence(value), result: value.result }; }

/** Final exact wire contract. No second output cap or sampling override can hide in extra keys. */
export function validateQaWirePayload(text: string, modelId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const payload = taskRecord(parsed, ["model", "stream", "messages", "max_tokens", "max_completion_tokens"], ["max_tokens", "max_completion_tokens"]);
    if (payload.model !== modelId || payload.stream !== false || Object.hasOwn(payload, "max_tokens") === Object.hasOwn(payload, "max_completion_tokens")) return false;
    if ((Object.hasOwn(payload, "max_tokens") ? payload.max_tokens : payload.max_completion_tokens) !== 1024) return false;
    if (!Array.isArray(payload.messages) || payload.messages.length !== 2) return false;
    for (const [index, role] of ["system", "user"].entries()) {
      const message = taskRecord(payload.messages[index], ["role", "content"]);
      if (message.role !== role || typeof message.content !== "string" || !message.content.length) return false;
    }
    return true;
  } catch { return false; }
}

/** Validate every outer descriptor before accessing values, then validate the exact legacy DTO. */
export function validateQaInput(value: unknown, kind: "batch" | "enroll" | "admit" | "complete" | "unknown" | "release" | "reconcile" | "list"): void {
  const fields = {
    batch: ["configSnapshotRef", "configDigest", "now"],
    enroll: [...ENQUEUE_FIELDS, "batchId", "reviewRef", "artifactPins"],
    admit: [...ADMIT_FIELDS, "batchId", "configDigest", "payloadUtf8", "estimatedInputTokens", "outputTokenLimit"],
    complete: [...QA_FENCE_FIELDS, "result", "requestId", "receipt"],
    unknown: [...QA_FENCE_FIELDS, "requestId"],
    release: ["requestId", "expectedRequestRevision", "now", "release"],
    reconcile: ["now"],
    list: ["batchId", "configDigest", "now", "limit"],
  };
  const input = taskRecord(value, fields[kind], kind === "list" ? ["configDigest", "limit"] : []);
  taskTime(input.now);
  for (const field of ["configSnapshotRef", "batchId", "reviewRef", "requestId"]) if (Object.hasOwn(input, field)) taskIdentity(input[field]);
  if (Object.hasOwn(input, "configDigest")) taskDigest(input.configDigest);
  if (kind === "list") taskLimit(input.limit);
  else if (kind === "enroll") {
    validateTaskInput(qaEnqueue(value as EnqueueRunEvaluationTaskInput), "enqueue");
    const pins = taskRecord(input.artifactPins, ["suite", "case", "baseline", "candidate", "frozen"]);
    for (const pin of Object.values(pins)) validateTaskArtifactPin(pin);
  } else if (kind === "admit") {
    validateTaskInput(qaAdmit(value as AdmitRunEvaluationTaskDispatchInput), "admit");
    if (typeof input.payloadUtf8 !== "string" || !input.payloadUtf8.length) invalid();
    taskInteger(input.estimatedInputTokens, 1);
    if (input.outputTokenLimit !== 1024) invalid();
  } else if (kind === "complete") {
    validateTaskInput(qaComplete(value as CompleteRunEvaluationTaskInput), "complete");
    const receipt = taskRecord(input.receipt, ["transport", "payloadSha256", "responseSha256", "responseStatus", "modelId", "dispatchedAt", "receivedAt", "usage"]);
    if (receipt.transport !== "owned_openai_chat_completions" || receipt.responseStatus !== 200) invalid();
    taskDigest(receipt.payloadSha256); taskDigest(receipt.responseSha256); taskIdentity(receipt.modelId);
    taskTime(receipt.dispatchedAt); taskTime(receipt.receivedAt);
    if (receipt.receivedAt < receipt.dispatchedAt) invalid();
    const usage = taskRecord(receipt.usage, ["state", "inputTokens", "outputTokens"], ["inputTokens", "outputTokens"]);
    if (usage.state === "unknown") { if (Object.hasOwn(usage, "inputTokens") || Object.hasOwn(usage, "outputTokens")) invalid(); }
    else if (usage.state === "measured") { taskInteger(usage.inputTokens); taskInteger(usage.outputTokens); }
    else invalid();
  } else if (kind === "unknown") validateTaskInput(qaFence(value as RunEvaluationTaskFence), "unknown");
  else if (kind === "release") {
    taskInteger(input.expectedRequestRevision);
    const release = taskRecord(input.release, ["kind", "auditRef"], ["auditRef"]);
    if (release.kind === "host_callback_drained") { if (Object.hasOwn(release, "auditRef")) invalid(); }
    else if (release.kind === "host_explicit_reconciliation") taskIdentity(release.auditRef);
    else invalid();
  }
}
function invalid(): never { throw new RunEvaluationInputError("evaluation.task_invalid"); }
