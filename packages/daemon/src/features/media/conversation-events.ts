import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";

export function publishConversationMediaProjectionChange(input: {
  readonly store: RunStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly mediaJobId: string;
  readonly createdArtifactIds?: readonly string[];
}): void {
  const mediaJob = input.store.getMediaJob(input.mediaJobId);
  if (!mediaJob) return;

  const workUnits = input.store
    .listWorkUnits({ kind: "media_job", linkedMediaJobId: mediaJob.id, limit: 100 })
    .filter((workUnit) => workUnit.ownerType === "conversation_run" && workUnit.linkedRunId);
  if (workUnits.length === 0) return;

  const now = new Date().toISOString();
  for (const workUnit of workUnits) {
    appendControlPlaneEvent(input.store, input.controlPlaneEvents, {
      workspaceId: workUnit.workspaceId || DEFAULT_WORKSPACE_ID,
      cwd: input.store.paths.cwd,
      domain: "work_units",
      entityType: "work_unit",
      entityId: workUnit.id,
      action: "media_job.updated",
      data: {
        runId: workUnit.linkedRunId,
        messageId: workUnit.linkedMessageId ?? null,
        mediaJobId: mediaJob.id,
        status: mediaJob.status,
      },
    }, now);
    for (const artifactId of uniqueStrings(input.createdArtifactIds ?? [])) {
      appendControlPlaneEvent(input.store, input.controlPlaneEvents, {
        workspaceId: workUnit.workspaceId || DEFAULT_WORKSPACE_ID,
        cwd: input.store.paths.cwd,
        domain: "artifacts",
        entityType: "artifact",
        entityId: artifactId,
        action: "artifact.created",
        data: {
          runId: workUnit.linkedRunId,
          messageId: workUnit.linkedMessageId ?? null,
          mediaJobId: mediaJob.id,
        },
      }, now);
    }
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
