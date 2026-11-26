import type { LingAppServerWorkItemFeedbackParams, LingAppServerWorkItemFeedbackResult } from "@ling-stack/contracts";
import { learningReviewJobId, workItemLearningReviewSourceKey, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { captureWorkItemLearningEvidence } from "./evidence.js";

export function enqueueWorkItemFeedback(
  store: RunStore, input: LingAppServerWorkItemFeedbackParams, cwd: string,
): LingAppServerWorkItemFeedbackResult {
  if (!Number.isSafeInteger(input.expectedWorkItemRevision) || input.expectedWorkItemRevision < 1
    || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new HttpError(400, "invalid_params", "Supply the current Work Item revision and a bounded request key.");
  }
  const { workItemId, sourceRunId, providerPresetId, expectedWorkItemRevision, idempotencyKey } = input;
  const item = store.getWorkItem(workItemId);
  if (!item) throw new HttpError(404, "workspace_binding_invalid", "The Work Item is unavailable.");
  const key = workItemLearningReviewSourceKey(item.workspaceId, workItemId, idempotencyKey);
  return store.withProcedureObservationJobTransaction(() => {
    const existing = store.getLearningReviewJob(learningReviewJobId(key));
    if (existing) {
      if (existing.sourceKey !== key || existing.evidence.workItem?.revision !== expectedWorkItemRevision
        || existing.evidence.runId !== sourceRunId || existing.providerPresetId !== providerPresetId) {
        throw new HttpError(409, "idempotency_conflict", "The feedback key belongs to a different source or review request.");
      }
      return { cwd, job: existing, replayed: true };
    }
    const governance = store.getWorkspaceSettings().skillGovernancePolicy;
    if (governance.generationMode === "off" || governance.recordingMode !== "user_initiated") {
      throw new HttpError(409, "learning_generation_disabled", "The workspace policy does not admit a learning review.");
    }
    const preset = store.getProviderPreset(providerPresetId);
    if (!preset?.enabled || !preset.capabilities.includes("chat")) {
      throw new HttpError(409, "learning_provider_unavailable", "Select an enabled learning review provider.");
    }
    const evidence = captureWorkItemLearningEvidence(store, sourceRunId, {
      id: workItemId, revision: expectedWorkItemRevision, requestKey: idempotencyKey,
    });
    const job = store.enqueueLearningReview({ mode: "explicit", evidence, providerPresetId }, new Date().toISOString());
    return { cwd, job, replayed: false };
  });
}
