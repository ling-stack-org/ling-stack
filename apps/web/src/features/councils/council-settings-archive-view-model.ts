import type { AiCouncil } from "../../types.js";

export interface CouncilSettingsDraft {
  readonly description: string;
  readonly displayName: string;
  readonly pinned: boolean;
}

export type CouncilSettingsMutationKind = "save" | "status";

export interface CouncilSettingsArchiveViewModel {
  readonly archiveAllowed: boolean;
  readonly canArchive: boolean;
  readonly canReset: boolean;
  readonly canSave: boolean;
  readonly canToggleStatus: boolean;
  readonly dirty: boolean;
  readonly managed: boolean;
  readonly nameInvalid: boolean;
  readonly statusAction: "pause" | "resume";
}

export function createCouncilSettingsDraft(council: AiCouncil): CouncilSettingsDraft {
  return {
    description: council.description,
    displayName: council.displayName,
    pinned: council.pinned,
  };
}

export function councilSettingsDraftChanged(
  draft: CouncilSettingsDraft,
  council: AiCouncil,
): boolean {
  return draft.displayName.trim() !== council.displayName ||
    draft.description.trim() !== council.description ||
    draft.pinned !== council.pinned;
}

export function buildCouncilSettingsArchiveViewModel({
  archiveBusy,
  council,
  draft,
  externallyBlocked,
  mutationKind,
}: {
  readonly archiveBusy: boolean;
  readonly council: AiCouncil;
  readonly draft: CouncilSettingsDraft;
  readonly externallyBlocked: boolean;
  readonly mutationKind?: CouncilSettingsMutationKind;
}): CouncilSettingsArchiveViewModel {
  const managed = council.source !== "user";
  const dirty = councilSettingsDraftChanged(draft, council);
  const nameInvalid = !draft.displayName.trim();
  const mutationBlocked = externallyBlocked || archiveBusy || Boolean(mutationKind);
  const archiveAllowed = !managed && council.status !== "archived";

  return {
    archiveAllowed,
    canArchive: archiveAllowed && !mutationBlocked,
    canReset: !managed && dirty && !mutationBlocked,
    canSave: !managed && dirty && !nameInvalid && !mutationBlocked,
    canToggleStatus: !managed && council.status !== "archived" && !mutationBlocked,
    dirty,
    managed,
    nameInvalid,
    statusAction: council.status === "paused" ? "resume" : "pause",
  };
}

export function councilSettingsRequest(draft: CouncilSettingsDraft): {
  readonly description: string;
  readonly displayName: string;
  readonly pinned: boolean;
} {
  return {
    description: draft.description.trim(),
    displayName: draft.displayName.trim(),
    pinned: draft.pinned,
  };
}

export function councilSettingsSnapshot(council: AiCouncil): string {
  return [
    council.id,
    council.displayName,
    council.description,
    council.pinned ? "1" : "0",
    council.status,
    council.source,
    council.updatedAt,
  ].join("\u0000");
}
