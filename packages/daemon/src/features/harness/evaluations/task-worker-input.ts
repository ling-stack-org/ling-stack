import type { RunEvaluationArtifactPinV1, RunEvaluationV1 } from "@ling-stack/contracts";
import { digestRunEvaluationValue, type RunEvaluationTaskClaim } from "@ling-stack/core";

export interface RunEvaluationTaskArtifactInputs {
  readonly suite: RunEvaluationArtifactPinV1;
  readonly testCase: RunEvaluationArtifactPinV1;
  readonly baseline: RunEvaluationArtifactPinV1;
  readonly candidate: RunEvaluationArtifactPinV1;
  readonly frozenGrader: RunEvaluationArtifactPinV1;
}

/** Immutable references only: no mutation Store, credentials, prompt body or producer certification. */
export interface RunEvaluationTaskExecutionInput extends RunEvaluationTaskClaim {
  readonly artifacts: RunEvaluationTaskArtifactInputs;
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
  readonly signal: AbortSignal;
}

/** Capture Host-owned identity before admission; Core revalidates the current sealed bytes at admission. */
export function prepareRunEvaluationTaskRequest(
  claim: RunEvaluationTaskClaim,
  evaluation: RunEvaluationV1 | undefined,
): { readonly artifacts: RunEvaluationTaskArtifactInputs; readonly requestDigest: string } {
  const frozenClaim = copyImmutableTaskData(claim);
  const source = copyImmutableTaskData(evaluation);
  if (!source || source.state !== "completed" || source.id !== frozenClaim.task.evaluationId
    || source.idempotencyKey !== frozenClaim.task.evaluationKey) {
    throw new Error("evaluation_task_worker_source_invalid");
  }
  const artifacts: RunEvaluationTaskArtifactInputs = Object.freeze({
    suite: pin(source.suiteArtifactId, source.suiteDigest),
    testCase: pin(source.caseArtifactId, source.caseDigest),
    baseline: pin(source.baselineArtifactId, source.baselineDigest),
    candidate: pin(source.candidateArtifactId, source.candidateDigest),
    frozenGrader: pin(frozenClaim.task.frozenGraderArtifact.artifactId,
      frozenClaim.task.frozenGraderArtifact.contentSha256),
  });
  const requestDigest = digestRunEvaluationValue({
    schemaVersion: 1,
    kind: "internal_evaluation_task_request",
    taskId: frozenClaim.task.id,
    attemptId: frozenClaim.attempt.id,
    evaluationId: source.id,
    evaluationKey: frozenClaim.task.evaluationKey,
    graderType: frozenClaim.task.graderType,
    frozenGraderDigest: frozenClaim.task.frozenGraderDigest,
    repeatOrdinal: frozenClaim.task.repeatOrdinal,
    artifacts,
  });
  return Object.freeze({ artifacts, requestDigest });
}

/** Copy bounded own-data DTOs without evaluating getters, custom prototypes or toJSON. */
export function copyImmutableTaskData<T>(value: T): T {
  let nodes = 0;
  let characters = 0;
  const invalid = (): never => { throw new Error("evaluation_task_worker_input_invalid"); };
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 2_048 || depth > 12) invalid();
    if (item === null || item === undefined || typeof item === "boolean") return item;
    if (typeof item === "string") {
      characters += item.length;
      if (item.length > 2_048 || characters > 65_536) invalid();
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || Array.isArray(item)) invalid();
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const fields = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(fields);
    if (keys.length > 64) invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("evaluation_task_worker_input_invalid");
      if (key.length > 100 || !Object.hasOwn(fields[key]!, "value")
        || !fields[key]!.enumerable) invalid();
      characters += key.length;
      if (characters > 65_536) invalid();
      Object.defineProperty(result, key, { value: copy(fields[key]!.value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  };
  return copy(value, 0) as T;
}

function pin(artifactId: string, contentSha256: string): RunEvaluationArtifactPinV1 {
  if (typeof artifactId !== "string" || artifactId.length < 1 || artifactId.length > 500
    || !/^[a-f0-9]{64}$/u.test(contentSha256)) throw new Error("evaluation_task_worker_source_invalid");
  return Object.freeze({ artifactId, contentSha256 });
}
