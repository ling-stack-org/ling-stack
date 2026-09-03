import type {
  AiTeammate,
  AutomationDefinition,
  Channel,
  MediaJob,
  MediaJobStatus,
  RunSession,
  RunStatus,
  RunStore,
  WorkUnit,
  WorkUnitStatus,
} from "@ling-stack/core";

export type ProviderReferenceBlockerKind =
  | "workspace_default_provider"
  | "workspace_default_image_generation"
  | "workspace_default_video_generation"
  | "channel_default_provider"
  | "ai_teammate_provider"
  | "automation_execution_policy"
  | "conversation_thread_default"
  | "active_run"
  | "active_work_unit"
  | "active_media_job";

export interface ProviderReferenceBlocker {
  readonly kind: ProviderReferenceBlockerKind;
  readonly id: string;
  readonly label?: string;
  readonly status?: string;
  readonly active: boolean;
}

export interface ProviderReferenceInspection {
  readonly providerPresetId: string;
  readonly canDelete: boolean;
  readonly blockers: readonly ProviderReferenceBlocker[];
}

export type ProviderReferenceStore = Pick<
  RunStore,
  | "getWorkspaceSettings"
  | "listChannels"
  | "listAiTeammates"
  | "listAutomationDefinitions"
  | "listRuns"
  | "listWorkUnits"
  | "listMediaJobs"
>;

const REFERENCE_LIMIT = 500;
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "waiting_for_approval"];
const ACTIVE_WORK_UNIT_STATUSES: readonly WorkUnitStatus[] = [
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "cancelling",
  "stale",
];
const ACTIVE_MEDIA_JOB_STATUSES: readonly MediaJobStatus[] = ["queued", "running", "waiting_for_approval"];

export function inspectProviderReferences(
  store: ProviderReferenceStore,
  providerPresetId: string,
): ProviderReferenceInspection {
  const blockers: ProviderReferenceBlocker[] = [];
  const workspaceSettings = store.getWorkspaceSettings();
  if (workspaceSettings.defaultProviderPresetId === providerPresetId) {
    blockers.push({
      kind: "workspace_default_provider",
      id: "workspace",
      label: "Workspace default model",
      active: true,
    });
  }
  if (
    workspaceSettings.mediaGenerationDefaults?.image?.kind === "provider" &&
    workspaceSettings.mediaGenerationDefaults.image.providerPresetId === providerPresetId
  ) {
    blockers.push({
      kind: "workspace_default_image_generation",
      id: "workspace:image",
      label: "Workspace default image generation target",
      active: true,
    });
  }
  if (
    workspaceSettings.mediaGenerationDefaults?.video?.kind === "provider" &&
    workspaceSettings.mediaGenerationDefaults.video.providerPresetId === providerPresetId
  ) {
    blockers.push({
      kind: "workspace_default_video_generation",
      id: "workspace:video",
      label: "Workspace default video generation target",
      active: true,
    });
  }

  for (const channel of store.listChannels({ archived: false, defaultProviderPresetId: providerPresetId, limit: REFERENCE_LIMIT })) {
    blockers.push(channelBlocker(channel));
  }

  for (const teammate of store.listAiTeammates({
    includeDisabled: true,
    includeHidden: true,
    providerPresetId,
    limit: REFERENCE_LIMIT,
  })) {
    blockers.push(teammateBlocker(teammate));
  }

  for (const automation of store.listAutomationDefinitions({ includeArchived: false, providerPresetId, limit: REFERENCE_LIMIT })) {
    blockers.push(automationBlocker(automation));
  }

  for (const status of ACTIVE_RUN_STATUSES) {
    for (const run of store.listRuns({ providerPresetId, status, limit: REFERENCE_LIMIT })) {
      blockers.push(runBlocker(run));
    }
  }

  for (const status of ACTIVE_WORK_UNIT_STATUSES) {
    for (const workUnit of store.listWorkUnits({ providerPresetId, status, limit: REFERENCE_LIMIT })) {
      blockers.push(workUnitBlocker(workUnit));
    }
  }

  for (const status of ACTIVE_MEDIA_JOB_STATUSES) {
    for (const mediaJob of store.listMediaJobs({ providerPresetId, status, limit: REFERENCE_LIMIT })) {
      blockers.push(mediaJobBlocker(mediaJob));
    }
  }

  return {
    providerPresetId,
    canDelete: blockers.length === 0,
    blockers,
  };
}

export function formatProviderDeleteBlockedMessage(inspection: ProviderReferenceInspection): string {
  return formatProviderReferenceBlockedMessage(inspection, "deleted");
}

export function formatProviderReferenceBlockedMessage(
  inspection: ProviderReferenceInspection,
  action: "deleted" | "disabled" | "changed" | "credential removed",
): string {
  if (inspection.blockers.length === 0) {
    return "Provider has no blocking references.";
  }
  const preview = inspection.blockers
    .slice(0, 4)
    .map((blocker) => blockerSummary(blocker))
    .join(", ");
  const remaining = inspection.blockers.length > 4 ? ` and ${inspection.blockers.length - 4} more` : "";
  return `Provider is still used by ${inspection.blockers.length} item(s): ${preview}${remaining}. Choose replacement models or clear those references before it can be ${action}.`;
}

function channelBlocker(channel: Channel): ProviderReferenceBlocker {
  return {
    kind: "channel_default_provider",
    id: channel.id,
    label: clipLabel(channel.name),
    status: channel.status,
    active: true,
  };
}

function teammateBlocker(teammate: AiTeammate): ProviderReferenceBlocker {
  return {
    kind: "ai_teammate_provider",
    id: teammate.id,
    label: clipLabel(teammate.displayName),
    status: teammate.status,
    active: true,
  };
}

function automationBlocker(automation: AutomationDefinition): ProviderReferenceBlocker {
  return {
    kind: "automation_execution_policy",
    id: automation.id,
    label: clipLabel(automation.title),
    status: automation.status,
    active: true,
  };
}

function runBlocker(run: RunSession): ProviderReferenceBlocker {
  return {
    kind: "active_run",
    id: run.id,
    label: clipLabel(run.taskId || run.providerModel || run.id),
    status: run.status,
    active: true,
  };
}

function workUnitBlocker(workUnit: WorkUnit): ProviderReferenceBlocker {
  return {
    kind: "active_work_unit",
    id: workUnit.id,
    label: clipLabel(`${workUnit.kind} ${workUnit.id}`),
    status: workUnit.status,
    active: true,
  };
}

function mediaJobBlocker(mediaJob: MediaJob): ProviderReferenceBlocker {
  return {
    kind: "active_media_job",
    id: mediaJob.id,
    label: clipLabel(mediaJob.prompt || mediaJob.operation),
    status: mediaJob.status,
    active: true,
  };
}

function blockerSummary(blocker: ProviderReferenceBlocker): string {
  const kind = blocker.kind.replaceAll("_", " ");
  return blocker.label ? `${kind} "${blocker.label}"` : `${kind} ${blocker.id}`;
}

function clipLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
