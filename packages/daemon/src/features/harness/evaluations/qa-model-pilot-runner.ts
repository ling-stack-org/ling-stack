import { realpathSync } from "node:fs";
import type {
  RunEvaluationArtifactPinV1,
  RunEvaluationQaArtifactPinsV1,
  RunEvaluationQaBatchV1,
  RunEvaluationQaEnrollmentV1,
  RunEvaluationQaRequestV1,
  RunEvaluationTaskResultV1,
} from "@ling-stack/contracts";
import {
  digestRunEvaluationValue,
  type RunStore,
} from "@ling-stack/core";
import { createRunEvaluationQaModelHostAdapter } from "./qa-model-coordinator.js";
import {
  createRunEvaluationQaOwnedModelBatch,
  runEvaluationQaOwnedModelBatchFacts,
} from "./qa-model-owned-batch.js";
import {
  runEvaluationQaModelConfigurationFacts,
  type RunEvaluationQaModelConfiguration,
} from "./qa-model-preparation.js";
import type { RunEvaluationQaMaterializedProvider } from "./qa-model-transport.js";
import { copyQaModelJson } from "./qa-model-json.js";
import {
  processNextRunEvaluationTask,
  type RunEvaluationTaskProcessDisposition,
} from "./task-worker.js";

export interface RunEvaluationQaPilotCase {
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly repeatOrdinal: number;
  readonly artifactPins: RunEvaluationQaArtifactPinsV1;
}

/** Sealed input-review bytes. This is an explicit local review record, not identity authentication. */
export interface RunEvaluationQaPilotReviewV1 {
  readonly schemaVersion: 1;
  readonly kind: "run_evaluation_qa_input_review";
  readonly canonicalWorkspaceCwd: string;
  readonly configSnapshotRef: string;
  readonly configDigest: string;
  readonly frozenGraderDigest: string;
  readonly reviewedByRef: string;
  readonly reviewedAt: string;
  readonly policy: {
    readonly maxRequests: 1 | 2 | 3;
    readonly noRetry: true;
    readonly reportOnly: true;
  };
  readonly cases: readonly RunEvaluationQaPilotCase[];
}

export interface RunEvaluationQaPilotExecution {
  readonly taskId: string;
  readonly disposition: RunEvaluationTaskProcessDisposition;
  readonly enrollment: RunEvaluationQaEnrollmentV1;
  readonly request?: RunEvaluationQaRequestV1;
  readonly result?: RunEvaluationTaskResultV1;
}

export interface RunEvaluationQaPilotResult {
  readonly status: "completed" | "stopped";
  readonly stopReason?: "task_not_completed" | "usage_unknown";
  readonly batch: RunEvaluationQaBatchV1;
  readonly reviewRef: string;
  readonly executions: readonly RunEvaluationQaPilotExecution[];
}

export interface RunEvaluationQaPilotOptions {
  readonly store: RunStore;
  readonly qaWorkspaceCwd: string;
  readonly configuration: RunEvaluationQaModelConfiguration;
  readonly configSnapshotRef: string;
  readonly reviewArtifact: RunEvaluationArtifactPinV1;
  readonly review: RunEvaluationQaPilotReviewV1;
  readonly cases: readonly RunEvaluationQaPilotCase[];
  readonly materializeProvider: () => RunEvaluationQaMaterializedProvider | Promise<RunEvaluationQaMaterializedProvider>;
  readonly assertCredentialCurrent: () => void;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly executionTimeoutMs?: number;
  readonly transportTimeoutMs?: number;
  readonly clock?: () => string;
  readonly signal?: AbortSignal;
}

/** Canonical own-data helper. The caller must seal these exact bytes before running the pilot. */
export function createRunEvaluationQaPilotReview(input: {
  readonly canonicalWorkspaceCwd: string;
  readonly configSnapshotRef: string;
  readonly configuration: RunEvaluationQaModelConfiguration;
  readonly reviewedByRef: string;
  readonly reviewedAt: string;
  readonly cases: readonly RunEvaluationQaPilotCase[];
}): RunEvaluationQaPilotReviewV1 {
  const facts = runEvaluationQaModelConfigurationFacts(input.configuration);
  const cases = validateCases(input.cases);
  identity(input.configSnapshotRef);
  identity(input.reviewedByRef);
  canonicalTime(input.reviewedAt);
  const maxRequests = cases.length as 1 | 2 | 3;
  return copyQaModelJson({
    schemaVersion: 1,
    kind: "run_evaluation_qa_input_review",
    canonicalWorkspaceCwd: realpathSync(input.canonicalWorkspaceCwd),
    configSnapshotRef: input.configSnapshotRef,
    configDigest: facts.configDigest,
    frozenGraderDigest: facts.frozenGraderDigest,
    reviewedByRef: input.reviewedByRef,
    reviewedAt: input.reviewedAt,
    policy: { maxRequests, noRetry: true, reportOnly: true },
    cases,
  }) as unknown as RunEvaluationQaPilotReviewV1;
}

/**
 * Manual paid-pilot Host path. It validates one sealed review, creates one bounded batch,
 * executes each enrolled task at most once, and stops on the first uncertain or unknown-usage result.
 */
export async function runEvaluationQaModelPilot(options: RunEvaluationQaPilotOptions): Promise<RunEvaluationQaPilotResult> {
  options.signal?.throwIfAborted();
  const canonicalWorkspaceCwd = realpathSync(options.qaWorkspaceCwd);
  if (canonicalWorkspaceCwd !== realpathSync(options.store.paths.cwd)) throw new Error("evaluation_qa_workspace_invalid");
  const cases = validateCases(options.cases);
  const suppliedReview = copyQaModelJson(options.review) as unknown as RunEvaluationQaPilotReviewV1;
  const reviewArtifact = copyQaModelJson(options.reviewArtifact) as unknown as RunEvaluationArtifactPinV1;
  const expectedReview = createRunEvaluationQaPilotReview({
    canonicalWorkspaceCwd,
    configSnapshotRef: options.configSnapshotRef,
    configuration: options.configuration,
    reviewedByRef: suppliedReview.reviewedByRef,
    reviewedAt: suppliedReview.reviewedAt,
    cases,
  });
  if (digestRunEvaluationValue(suppliedReview) !== digestRunEvaluationValue(expectedReview)) {
    throw new Error("evaluation_qa_review_invalid");
  }
  validateReviewArtifact(options.store, reviewArtifact, expectedReview);
  validateSourceCases(options.store, cases);
  options.signal?.throwIfAborted();

  const now = pilotNow(options.clock);
  const ownedBatch = await createRunEvaluationQaOwnedModelBatch({
    store: options.store,
    qaWorkspaceCwd: canonicalWorkspaceCwd,
    configuration: options.configuration,
    configSnapshotRef: options.configSnapshotRef,
    materializeProvider: options.materializeProvider,
    assertCredentialCurrent: options.assertCredentialCurrent,
    now,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const batch = runEvaluationQaOwnedModelBatchFacts(ownedBatch);
  const reviewRef = reviewReference(reviewArtifact);
  const facts = runEvaluationQaModelConfigurationFacts(options.configuration);
  const enrollments = cases.map(item => {
    const enrolled = options.store.enrollRunEvaluationQaTask({
      evaluationId: item.evaluationId,
      evaluationKey: item.evaluationKey,
      frozenGraderArtifact: item.artifactPins.frozen,
      frozenGraderDigest: facts.frozenGraderDigest,
      repeatOrdinal: item.repeatOrdinal,
      batchId: batch.id,
      reviewRef,
      artifactPins: item.artifactPins,
      now: pilotNow(options.clock),
    });
    if (!enrolled.ok || enrolled.replayed) throw new Error("evaluation_qa_enrollment_rejected");
    return enrolled.value;
  });
  const adapter = createRunEvaluationQaModelHostAdapter({
    store: options.store,
    ownedBatch,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.transportTimeoutMs === undefined ? {} : { transportTimeoutMs: options.transportTimeoutMs }),
  });
  return executePilot({ options, batch, reviewRef, adapter, enrollments });
}

async function executePilot(input: {
  readonly options: RunEvaluationQaPilotOptions;
  readonly batch: RunEvaluationQaBatchV1;
  readonly reviewRef: string;
  readonly adapter: ReturnType<typeof createRunEvaluationQaModelHostAdapter>;
  readonly enrollments: readonly RunEvaluationQaEnrollmentV1[];
}): Promise<RunEvaluationQaPilotResult> {
  const executions: RunEvaluationQaPilotExecution[] = [];
  const expectedTaskIds = new Set(input.enrollments.map(value => value.taskId));
  for (let index = 0; index < input.enrollments.length; index += 1) {
    input.options.signal?.throwIfAborted();
    const outcome = await processNextRunEvaluationTask({
      store: input.options.store,
      workerId: input.options.workerId ?? "h09-owned-real-qa-pilot",
      hostAdapter: input.adapter,
      ...(input.options.leaseMs === undefined ? {} : { leaseMs: input.options.leaseMs }),
      ...(input.options.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: input.options.executionTimeoutMs }),
      ...(input.options.clock ? { clock: input.options.clock } : {}),
      ...(input.options.signal ? { signal: input.options.signal } : {}),
    });
    if (!outcome.taskId || !expectedTaskIds.delete(outcome.taskId)) throw new Error("evaluation_qa_pilot_task_invalid");
    const enrollment = input.options.store.getRunEvaluationQaEnrollment(outcome.taskId);
    if (!enrollment || enrollment.batchId !== input.batch.id || enrollment.reviewRef !== input.reviewRef) {
      throw new Error("evaluation_qa_pilot_task_invalid");
    }
    const request = input.options.store.getRunEvaluationQaRequestForTask(outcome.taskId);
    const result = input.options.store.getRunEvaluationTaskResult(outcome.taskId);
    const execution = Object.freeze({ taskId: outcome.taskId, disposition: outcome.disposition, enrollment,
      ...(request ? { request } : {}), ...(result ? { result } : {}) });
    executions.push(execution);
    if (outcome.disposition !== "completed") {
      return Object.freeze({ status: "stopped", stopReason: "task_not_completed", batch: input.batch,
        reviewRef: input.reviewRef, executions: Object.freeze(executions) });
    }
    validateCompletedReceipt(enrollment, request, result);
    if (request!.usage.state === "unknown") {
      return Object.freeze({ status: "stopped", stopReason: "usage_unknown", batch: input.batch,
        reviewRef: input.reviewRef, executions: Object.freeze(executions) });
    }
  }
  return Object.freeze({ status: "completed", batch: input.batch, reviewRef: input.reviewRef,
    executions: Object.freeze(executions) });
}

function validateCompletedReceipt(enrollment: RunEvaluationQaEnrollmentV1,
  request: RunEvaluationQaRequestV1 | undefined, result: RunEvaluationTaskResultV1 | undefined): void {
  if (!request || !result || request.state !== "completed" || !request.receipt || !request.releasedAt
    || request.releaseKind !== "host_callback_drained" || request.enrollmentId !== enrollment.id
    || request.taskId !== result.taskId || request.attemptId !== result.attemptId
    || request.invocationId !== result.invocationId || request.requestDigest !== result.requestDigest
    || request.executionScopeDigest !== result.executionScopeDigest || result.authority !== "unverified"
    || result.costAmountMicros !== undefined) throw new Error("evaluation_qa_pilot_receipt_invalid");
  if (request.usage.state === "measured"
    && (result.costInputTokens !== request.usage.inputTokens || result.costOutputTokens !== request.usage.outputTokens)) {
    throw new Error("evaluation_qa_pilot_receipt_invalid");
  }
  if (request.usage.state === "unknown"
    && (result.costInputTokens !== undefined || result.costOutputTokens !== undefined)) {
    throw new Error("evaluation_qa_pilot_receipt_invalid");
  }
}

function validateReviewArtifact(store: RunStore, pin: RunEvaluationArtifactPinV1, expected: RunEvaluationQaPilotReviewV1): void {
  pinValue(pin);
  const artifact = store.getArtifact(pin.artifactId);
  if (!artifact || artifact.contentSha256 !== pin.contentSha256 || artifact.sealedPayload === undefined
    || digestRunEvaluationValue(copyQaModelJson(artifact.sealedPayload)) !== digestRunEvaluationValue(expected)) {
    throw new Error("evaluation_qa_review_invalid");
  }
}

function validateSourceCases(store: RunStore, cases: readonly RunEvaluationQaPilotCase[]): void {
  for (const item of cases) {
    const evaluation = store.getRunEvaluation(item.evaluationId);
    if (!evaluation || evaluation.state !== "completed" || evaluation.idempotencyKey !== item.evaluationKey) {
      throw new Error("evaluation_qa_source_invalid");
    }
    for (const pin of Object.values(item.artifactPins)) {
      pinValue(pin);
      const artifact = store.getArtifact(pin.artifactId);
      if (!artifact || artifact.contentSha256 !== pin.contentSha256
        || (artifact.runId !== evaluation.runId && artifact.runId !== evaluation.rootRunId)) throw new Error("evaluation_qa_source_invalid");
    }
  }
}

function validateCases(input: readonly RunEvaluationQaPilotCase[]): readonly RunEvaluationQaPilotCase[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error("evaluation_qa_pilot_budget_invalid");
  const copied = copyQaModelJson(input) as unknown as RunEvaluationQaPilotCase[];
  const identities = new Set<string>();
  for (const item of copied) {
    identity(item.evaluationId);
    if (!/^run-evaluation:[a-f0-9]{64}$/u.test(item.evaluationKey)) throw new Error("evaluation_qa_source_invalid");
    if (!Number.isSafeInteger(item.repeatOrdinal) || item.repeatOrdinal < 1) throw new Error("evaluation_qa_source_invalid");
    for (const pin of Object.values(item.artifactPins)) pinValue(pin);
    const key = `${item.evaluationId}\0${item.repeatOrdinal}`;
    if (identities.has(key)) throw new Error("evaluation_qa_source_invalid");
    identities.add(key);
  }
  return Object.freeze(copied);
}

function reviewReference(pin: RunEvaluationArtifactPinV1): string {
  return `artifact:${pin.artifactId}#sha256:${pin.contentSha256}`;
}
function pinValue(pin: RunEvaluationArtifactPinV1): void {
  identity(pin.artifactId);
  if (!/^[a-f0-9]{64}$/u.test(pin.contentSha256)) throw new Error("evaluation_qa_source_invalid");
}
function identity(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 500 || value.trim() !== value || value.includes("\0")) {
    throw new Error("evaluation_qa_source_invalid");
  }
}
function canonicalTime(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("evaluation_qa_review_invalid");
}
function pilotNow(clock?: () => string): string {
  const value = clock?.() ?? new Date().toISOString();
  canonicalTime(value);
  return value;
}
