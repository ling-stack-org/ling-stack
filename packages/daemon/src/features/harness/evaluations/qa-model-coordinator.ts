import { randomUUID } from "node:crypto";
import type { RunEvaluationQaEnrollmentV1, RunEvaluationTaskV1 } from "@ling-stack/contracts";
import { digestRunEvaluationValue, type RunEvaluationQaStore, type RunStore,
  type RunEvaluationTaskClaim, type RunEvaluationTaskFence, type RunEvaluationTaskMutationResult,
  type RunEvaluationTaskResultInput } from "@ling-stack/core";
import { copyImmutableTaskData, type RunEvaluationTaskArtifactInputs,
  type RunEvaluationTaskExecutionInput } from "./task-worker-input.js";
import type { RunEvaluationTaskHostAdapter, RunEvaluationTaskHostExecution } from "./task-worker-prepared.js";
import type { RunEvaluationTaskWorkerStore } from "./task-worker.js";
import { prepareRunEvaluationQaModelRequest, preparedRunEvaluationQaModelFacts,
  runEvaluationQaModelConfigurationFacts } from "./qa-model-preparation.js";
import { admitRunEvaluationQaModelTransport, createRunEvaluationQaModelTransport,
  executeRunEvaluationQaModelTransport, runEvaluationQaModelSuccessFacts, runEvaluationQaModelTransportRequestId,
  disposeRunEvaluationQaModelTransport,
  type RunEvaluationQaModelTransportSuccess } from "./qa-model-transport.js";
import { runEvaluationQaOwnedModelBatchInput, type RunEvaluationQaOwnedModelBatch } from "./qa-model-owned-batch.js";

type QaWorkerStore = RunEvaluationTaskWorkerStore & RunEvaluationQaStore & Pick<RunStore, "getArtifact" | "createArtifact">;
/** Explicit QA-only composition. No production registration, route, Agent SDK or history/Memory reader. */
export function createRunEvaluationQaModelHostAdapter(options: {
  readonly store: QaWorkerStore;
  readonly ownedBatch: RunEvaluationQaOwnedModelBatch;
  readonly clock?: () => string;
  readonly transportTimeoutMs?: number;
}): RunEvaluationTaskHostAdapter {
  const owned = runEvaluationQaOwnedModelBatchInput(options.ownedBatch);
  if (owned.store !== options.store) throw new Error("evaluation_qa_workspace_invalid");
  const facts = runEvaluationQaModelConfigurationFacts(owned.configuration);
  const canonicalCwd = owned.canonicalCwd;
  const originalScope = copyImmutableTaskData(options.store.getRunEvaluationQaScope());
  if (!originalScope || originalScope.canonicalWorkspaceCwd !== canonicalCwd) throw new Error("evaluation_qa_workspace_invalid");
  const assertScope = (): void => {
    const scope = copyImmutableTaskData(options.store.getRunEvaluationQaScope());
    if (!scope || scope.namespaceId !== originalScope.namespaceId || scope.canonicalWorkspaceCwd !== canonicalCwd) {
      throw new Error("evaluation_qa_workspace_invalid");
    }
  };
  const enrollmentFor = (task: RunEvaluationTaskV1): RunEvaluationQaEnrollmentV1 | undefined => {
    assertScope();
    const enrollment = copyImmutableTaskData(options.store.getRunEvaluationQaEnrollment(task.id));
    if (!enrollment) return undefined;
    const batch = copyImmutableTaskData(options.store.getRunEvaluationQaBatch(enrollment.batchId));
    if (!batch || batch.id !== owned.batch.id || batch.namespaceId !== originalScope.namespaceId || batch.configDigest !== facts.configDigest
      || enrollment.taskId !== task.id || enrollment.evaluationId !== task.evaluationId
      || enrollment.evaluationKey !== task.evaluationKey || enrollment.frozenGraderDigest !== facts.frozenGraderDigest
      || task.frozenGraderDigest !== facts.frozenGraderDigest || !enrollment.reviewRef) return undefined;
    return enrollment;
  };
  return Object.freeze({
    reconcile(now: string): void {
      assertScope();
      const reconciled = options.store.reconcileRunEvaluationQaScope({ now });
      if (!reconciled.ok) throw new Error("evaluation_qa_recovery_failed");
    },
    selectCandidate(now: string): RunEvaluationTaskV1 | undefined {
      assertScope();
      return options.store.listClaimableRunEvaluationQaTasks({ batchId: owned.batch.id, configDigest: facts.configDigest,
        now, limit: 1 })[0];
    },
    acceptsTask(task: RunEvaluationTaskV1): boolean { return enrollmentFor(task) !== undefined; },
    async prepare(input: Parameters<RunEvaluationTaskHostAdapter["prepare"]>[0]): Promise<RunEvaluationTaskHostExecution> {
      input.signal.throwIfAborted();
      const claim = copyImmutableTaskData(input.claim);
      const artifacts = copyImmutableTaskData(input.artifacts);
      const enrollment = enrollmentFor(claim.task);
      input.signal.throwIfAborted();
      if (!enrollment || !matchingPins(enrollment, artifacts)) throw new Error("evaluation_qa_not_enrolled");
      await owned.currentProvider(input.signal);
      input.signal.throwIfAborted();
      // All eligibility/config/pin checks precede the first sealed evidence content read.
      const prepared = await prepareRunEvaluationQaModelRequest({ configuration: owned.configuration,
        claim, evaluation: input.evaluation, artifacts, signal: input.signal,
        readArtifact: id => {
          input.signal.throwIfAborted();
          if (!Object.values(enrollment.artifactPins).some(pin => pin.artifactId === id)) throw new Error("evaluation_qa_not_enrolled");
          const artifact = options.store.getArtifact(id);
          input.signal.throwIfAborted();
          return artifact;
        } });
      input.signal.throwIfAborted();
      const provider = await owned.currentProvider(input.signal);
      input.signal.throwIfAborted();
      assertScope();
      input.signal.throwIfAborted();
      const transport = createRunEvaluationQaModelTransport({ prepared, provider, store: options.store,
        batchId: enrollment.batchId, assertGeneration: owned.assertGeneration, ...(options.clock ? { clock: options.clock } : {}),
        ...(options.transportTimeoutMs === undefined ? {} : { timeoutMs: options.transportTimeoutMs }) });
      input.signal.throwIfAborted();
      const preparedFacts = preparedRunEvaluationQaModelFacts(prepared);
      let settled = false;
      let completionAttempted = false;
      const claimAfterUnknown = (): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> => {
        const task = copyImmutableTaskData(options.store.getRunEvaluationTask(claim.task.id));
        const attempt = copyImmutableTaskData(options.store.getRunEvaluationTaskAttempt(claim.attempt.id));
        if (!task || !attempt || task.activeAttemptId !== attempt.id || task.state !== "unknown_outcome" || attempt.state !== "unknown_outcome") {
          return { ok: false, code: "invalid_transition" };
        }
        return { ok: true, replayed: true, value: { task, attempt } };
      };
      return Object.freeze({
        requestDigest: preparedFacts.requestDigest,
        executionScopeDigest: preparedFacts.executionScopeDigest,
        admit(fence: RunEvaluationTaskFence) {
          input.signal.throwIfAborted();
          assertScope();
          owned.assertGeneration();
          input.signal.throwIfAborted();
          return admitRunEvaluationQaModelTransport(transport, fence);
        },
        execute(execution: RunEvaluationTaskExecutionInput) {
          input.signal.throwIfAborted();
          if (!execution.attempt.invocationId || execution.requestDigest !== preparedFacts.requestDigest
            || execution.executionScopeDigest !== preparedFacts.executionScopeDigest) throw new Error("evaluation_qa_execution_invalid");
          return executeRunEvaluationQaModelTransport(transport, { taskId: execution.task.id, attemptId: execution.attempt.id,
            invocationId: execution.attempt.invocationId, signal: execution.signal });
        },
        complete(fence: RunEvaluationTaskFence, result: unknown) {
          if (completionAttempted) return { ok: false as const, code: "invalid_transition" as const };
          completionAttempted = true;
          input.signal.throwIfAborted();
          const success = runEvaluationQaModelSuccessFacts(transport, result as RunEvaluationQaModelTransportSuccess);
          const requestId = runEvaluationQaModelTransportRequestId(transport);
          if (!requestId || success.taskId !== fence.taskId || success.attemptId !== fence.attemptId
            || success.requestDigest !== preparedFacts.requestDigest || success.executionScopeDigest !== preparedFacts.executionScopeDigest) {
            throw new Error("evaluation_qa_receipt_untrusted");
          }
          const raw = options.store.createArtifact({ id: `evaluation_qa_output_${randomUUID()}`,
            runId: input.evaluation.runId, type: "json", path: `evaluation/qa/${fence.taskId}/${fence.attemptId}.json`,
            sealedPayload: success.output, createdAt: fence.now });
          input.signal.throwIfAborted();
          if (!raw.contentSha256) throw new Error("evaluation_qa_artifact_invalid");
          const usage = success.receipt.usage;
          const output: RunEvaluationTaskResultInput = Object.freeze({ verdict: success.output.verdict,
            ...(success.output.score === undefined ? {} : { score: success.output.score }),
            ...(success.output.severity === undefined ? {} : { severity: success.output.severity }),
            rawOutputArtifact: Object.freeze({ artifactId: raw.id, contentSha256: raw.contentSha256 }),
            ...(usage.state === "unknown" ? {} : { costInputTokens: usage.inputTokens, costOutputTokens: usage.outputTokens }),
            latencyMs: success.latencyMs });
          input.signal.throwIfAborted();
          const completed = options.store.completeRunEvaluationQaRequest({ ...fence, requestId, receipt: success.receipt, result: output });
          if (completed.ok) settled = true;
          return completed;
        },
        markUnknown(fence: RunEvaluationTaskFence) {
          const requestId = runEvaluationQaModelTransportRequestId(transport);
          if (!requestId) return { ok: false as const, code: "not_found" as const };
          const request = copyImmutableTaskData(options.store.getRunEvaluationQaRequest(requestId));
          if (request?.state === "unknown") return claimAfterUnknown();
          const task = copyImmutableTaskData(options.store.getRunEvaluationTask(fence.taskId));
          const attempt = copyImmutableTaskData(options.store.getRunEvaluationTaskAttempt(fence.attemptId));
          if (!task || !attempt || task.activeAttemptId !== attempt.id || attempt.claimOwner !== fence.claimOwner
            || attempt.claimToken !== fence.claimToken) return { ok: false as const, code: "lease_mismatch" as const };
          const marked = options.store.markRunEvaluationQaRequestUnknown({ ...fence, requestId,
            expectedTaskRevision: task.revision, expectedAttemptRevision: attempt.revision });
          if (marked.ok) return claimAfterUnknown();
          // The exact captured attempt may have expired while its callback was alive.
          options.store.reconcileExpiredRunEvaluationTaskAttempt({ taskId: fence.taskId, attemptId: fence.attemptId, now: fence.now });
          options.store.reconcileRunEvaluationQaScope({ now: fence.now });
          return claimAfterUnknown();
        },
        onDrained(): void {
          try {
            if (!settled) return; // Unknown and replay never gain automatic release authority.
            const requestId = runEvaluationQaModelTransportRequestId(transport);
            const request = requestId ? copyImmutableTaskData(options.store.getRunEvaluationQaRequest(requestId)) : undefined;
            if (!request || request.state !== "completed") throw new Error("evaluation_qa_drain_invalid");
            const released = options.store.releaseRunEvaluationQaLane({ requestId: request.id, expectedRequestRevision: request.revision,
              now: drainNow(options.clock, request.completedAt), release: { kind: "host_callback_drained" } });
            if (!released.ok) throw new Error("evaluation_qa_drain_invalid");
          } finally { disposeRunEvaluationQaModelTransport(transport); }
        },
      });
    },
  });
}

function matchingPins(enrollment: RunEvaluationQaEnrollmentV1, artifacts: RunEvaluationTaskArtifactInputs): boolean {
  return digestRunEvaluationValue(enrollment.artifactPins) === digestRunEvaluationValue({ suite: artifacts.suite,
    case: artifacts.testCase, baseline: artifacts.baseline, candidate: artifacts.candidate, frozen: artifacts.frozenGrader });
}
function drainNow(clock: (() => string) | undefined, completedAt: string | undefined): string {
  const value = clock?.() ?? new Date().toISOString();
  if (!completedAt || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value || value < completedAt) {
    throw new Error("evaluation_qa_drain_invalid");
  }
  return value;
}
