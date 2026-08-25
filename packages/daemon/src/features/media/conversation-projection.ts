import type { RunStore } from "@ling-stack/core";
import type {
  ConversationGeneratedMedia,
  ConversationMediaFailureCode,
} from "@ling-stack/contracts";

export function buildConversationGeneratedMediaProjection(input: {
  readonly store: RunStore;
  readonly runIds: readonly string[];
}): ConversationGeneratedMedia[] {
  const projection: ConversationGeneratedMedia[] = [];
  const seenMediaJobIds = new Set<string>();

  for (const runId of uniqueStrings(input.runIds)) {
    const workUnits = input.store.listWorkUnits({
      kind: "media_job",
      linkedRunId: runId,
      limit: 100,
    });
    for (const workUnit of workUnits) {
      const mediaJobId = workUnit.linkedMediaJobId;
      if (!mediaJobId || seenMediaJobIds.has(mediaJobId)) continue;
      if (workUnit.ownerType !== "conversation_run" || workUnit.ownerId !== runId) continue;

      const request = readRecord(workUnit.request);
      if (request.source !== "conversation_media_tool") continue;
      const target = readTargetSnapshot(request.target);
      const mediaJob = input.store.getMediaJob(mediaJobId);
      if (!target || !mediaJob || !isConversationMediaOperation(mediaJob.operation)) continue;

      seenMediaJobIds.add(mediaJobId);
      projection.push({
        mediaJobId,
        runId,
        ...(workUnit.linkedMessageId ? { messageId: workUnit.linkedMessageId } : {}),
        operation: mediaJob.operation,
        target,
        prompt: mediaJob.prompt,
        status: mediaJob.status,
        artifacts: input.store
          .listMediaJobArtifacts(mediaJobId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
        ...(mediaJob.status === "failed" ? {
          failureCode: conversationMediaFailureCode(workUnit.errorCode, mediaJob.errorMessage),
        } : {}),
        createdAt: mediaJob.createdAt,
        updatedAt: mediaJob.updatedAt,
      });
    }
  }

  return projection.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.mediaJobId.localeCompare(right.mediaJobId),
  );
}

export function runHasConversationGeneratedMedia(
  store: RunStore,
  runId: string | undefined,
): boolean {
  if (!runId) return false;
  return buildConversationGeneratedMediaProjection({
    store,
    runIds: [runId],
  }).length > 0;
}

export function conversationMediaFailureCode(
  errorCode: string | undefined,
  legacyErrorMessage?: string,
): ConversationMediaFailureCode {
  if (
    errorCode === "provider_disabled" ||
    errorCode === "model_not_found" ||
    errorCode === "live_media_transport_required" ||
    errorCode === "unsupported_capability" ||
    errorCode === "generation_target_not_runnable"
  ) {
    return "generation_target_unavailable";
  }
  if (errorCode === "auth_failed" || errorCode === "secret_missing") {
    return "generation_authorization_required";
  }
  if (errorCode === "content_policy_blocked" || legacyContentPolicyFailure(legacyErrorMessage)) {
    return "generation_content_policy_blocked";
  }
  if (errorCode === "timeout") {
    return "generation_timed_out";
  }
  if (errorCode === "media_result_unavailable" || legacyResultUnavailableFailure(legacyErrorMessage)) {
    return "generation_result_unavailable";
  }
  if (errorCode === "bad_request" || errorCode === "invalid_request") {
    return "generation_configuration_required";
  }
  return "generation_failed";
}

function legacyResultUnavailableFailure(message: string | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("response did not include image data") ||
    normalized.includes("response did not include video data") ||
    normalized.includes("did not return a usable image") ||
    normalized.includes("did not return a usable video");
}

function legacyContentPolicyFailure(message: string | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("moderation_blocked") ||
    normalized.includes("safety_violations") ||
    normalized.includes("safety system") ||
    normalized.includes("content policy");
}

function readTargetSnapshot(value: unknown): ConversationGeneratedMedia["target"] | undefined {
  const target = readRecord(value);
  const ref = readRecord(target.ref);
  const kind = ref.kind;
  const id = readNonEmptyString(target.id);
  const displayName = readNonEmptyString(target.displayName);
  if ((kind !== "provider" && kind !== "workflow") || !id || !displayName) return undefined;
  return { kind, id, displayName };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isConversationMediaOperation(
  value: string,
): value is ConversationGeneratedMedia["operation"] {
  return value === "image_generate" || value === "video_generate";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
