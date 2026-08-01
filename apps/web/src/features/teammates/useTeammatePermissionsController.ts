import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiTeammate, SkillApprovalProfile, ToolName, UpdateAiTeammateRequest } from "../../types.js";
import type { TeammateUpdateAction } from "./types.js";
import { useTeammateAsyncRequestOwner } from "./useTeammateAsyncRequestOwner.js";

export interface TeammatePermissionsController {
  readonly approvalMode: SkillApprovalProfile["mode"];
  readonly allowedTools: readonly ToolName[];
  readonly dirty: boolean;
  readonly error: string;
  readonly saving: boolean;
  readonly reset: () => void;
  readonly save: () => Promise<void>;
  readonly setApprovalMode: (mode: SkillApprovalProfile["mode"]) => void;
  readonly toggleTool: (tool: ToolName) => void;
}

export function useTeammatePermissionsController({
  teammate,
  onUpdateTeammate,
  onTeammateUpdated,
}: {
  readonly teammate: AiTeammate;
  readonly onUpdateTeammate: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateUpdateAction,
  ) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
}): TeammatePermissionsController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const requestOwner = useTeammateAsyncRequestOwner<"permissions">(
    teammate.id,
    JSON.stringify([teammate.id, teammate.updatedAt]),
  );
  const [allowedTools, setAllowedTools] = useState<readonly ToolName[]>(teammate.allowedTools);
  const [approvalMode, setApprovalModeState] = useState<SkillApprovalProfile["mode"]>(teammate.approvalProfile.mode);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAllowedTools(teammate.allowedTools);
    setApprovalModeState(teammate.approvalProfile.mode);
    setSaving(false);
  }, [teammate.allowedTools, teammate.approvalProfile.mode, teammate.id, teammate.updatedAt]);

  const dirty = useMemo(() => (
    approvalMode !== teammate.approvalProfile.mode || !sameToolSet(allowedTools, teammate.allowedTools)
  ), [allowedTools, approvalMode, teammate.allowedTools, teammate.approvalProfile.mode]);

  function toggleTool(tool: ToolName): void {
    requestOwner.clearActionError("permissions");
    setAllowedTools((current) => {
      if (current.includes(tool)) {
        if (current.length === 1) {
          requestOwner.reportImmediate("permissions", t("Keep at least one teammate capability enabled."));
          return current;
        }
        return current.filter((item) => item !== tool);
      }
      return [...current, tool];
    });
  }

  function setApprovalMode(mode: SkillApprovalProfile["mode"]): void {
    requestOwner.clearActionError("permissions");
    setApprovalModeState(mode);
  }

  function reset(): void {
    setAllowedTools(teammate.allowedTools);
    setApprovalModeState(teammate.approvalProfile.mode);
    requestOwner.clearActionError("permissions");
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    const operation = requestOwner.begin("permissions");
    if (!requestOwner.isActionCurrent(operation)) return;
    setSaving(true);
    try {
      const updated = await onUpdateTeammate(teammate.id, {
        allowedTools,
        approvalProfile: {
          ...teammate.approvalProfile,
          mode: approvalMode,
        },
      }, "permissions-save");
      if (!requestOwner.isActionCurrent(operation)) return;
      setAllowedTools(updated.allowedTools);
      setApprovalModeState(updated.approvalProfile.mode);
      onTeammateUpdated?.(updated);
      requestOwner.clearError(operation);
      showToast({
        message: t("Teammate permissions saved"),
        scope: `teammate:permissions:${operation.teammateId}:save`,
        tone: "success",
      });
    } catch {
      requestOwner.reportError(operation, t("Permission changes were not saved. Try again."));
    } finally {
      if (requestOwner.isActionCurrent(operation)) setSaving(false);
    }
  }

  return {
    approvalMode,
    allowedTools,
    dirty,
    error: requestOwner.latestError?.message ?? "",
    saving,
    reset,
    save,
    setApprovalMode,
    toggleTool,
  };
}

function sameToolSet(left: readonly ToolName[], right: readonly ToolName[]): boolean {
  return left.length === right.length && left.every((tool) => right.includes(tool));
}
