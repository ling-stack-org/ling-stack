import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiTeammate, UpdateAiTeammateRequest } from "../../types.js";
import type { TeammateUpdateAction } from "./types.js";
import { useTeammateAsyncRequestOwner } from "./useTeammateAsyncRequestOwner.js";

export interface TeammateRenameController {
  readonly error: string;
  readonly open: boolean;
  readonly saving: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement>;
  readonly value: string;
  readonly close: () => void;
  readonly openDialog: () => void;
  readonly setValue: (value: string) => void;
  readonly submit: () => Promise<void>;
}

export function useTeammateRenameController({
  teammate,
  onTeammateUpdated,
  onUpdateTeammate,
}: {
  readonly teammate: AiTeammate;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onUpdateTeammate: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateUpdateAction,
  ) => Promise<AiTeammate>;
}): TeammateRenameController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const requestOwner = useTeammateAsyncRequestOwner<"rename">(teammate.id);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [value, setValueState] = useState(teammate.displayName);
  const error = requestOwner.latestError?.message ?? "";

  useEffect(() => {
    setOpen(false);
    setSaving(false);
    setValueState(teammate.displayName);
    requestOwner.clearActionError("rename");
  }, [teammate.id]);

  function openDialog(): void {
    setValueState(teammate.displayName);
    requestOwner.clearActionError("rename");
    setOpen(true);
  }

  function close(): void {
    if (saving) return;
    requestOwner.clearActionError("rename");
    setOpen(false);
  }

  function setValue(nextValue: string): void {
    setValueState(nextValue);
    requestOwner.clearActionError("rename");
  }

  async function submit(): Promise<void> {
    const nextName = value.trim();
    if (!nextName || nextName === teammate.displayName || saving) return;
    const operation = requestOwner.begin("rename");
    if (!requestOwner.isActionCurrent(operation)) return;
    setSaving(true);
    try {
      const updated = await onUpdateTeammate(teammate.id, { displayName: nextName }, "rename");
      if (!requestOwner.isActionCurrent(operation)) return;
      onTeammateUpdated?.(updated);
      requestOwner.clearError(operation);
      setOpen(false);
      showToast({
        message: t("Teammate renamed"),
        scope: `teammate:rename:${operation.teammateId}`,
        tone: "success",
      });
    } catch {
      requestOwner.reportError(operation, t("Teammate name was not changed. Try again."));
    } finally {
      if (requestOwner.isActionCurrent(operation)) setSaving(false);
    }
  }

  return {
    close,
    error,
    open,
    openDialog,
    saving,
    setValue,
    submit,
    triggerRef,
    value,
  };
}
