import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import type { AiTeammate } from "../../types.js";
import { buildTeammateDangerViewModel } from "./teammate-danger-view-models.js";

type LifecycleAction = "disable" | "hard-delete";

export function useTeammateDangerController({
  teammate,
  onDisableTeammate,
  onHardDeleteTeammate,
}: {
  readonly teammate: AiTeammate;
  readonly onDisableTeammate: (teammateId: string) => Promise<void>;
  readonly onHardDeleteTeammate?: (teammateId: string, reason?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const viewModel = buildTeammateDangerViewModel(teammate);
  const identityKey = teammate.id;
  const identityRef = useRef(identityKey);
  const mountedRef = useRef(true);
  const disableBusyRef = useRef(false);
  const hardDeleteBusyRef = useRef(false);
  const hardDeleteTriggerRef = useRef<HTMLButtonElement>(null);
  identityRef.current = identityKey;

  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState("");
  const [hardDeleteBusy, setHardDeleteBusy] = useState(false);
  const [hardDeleteError, setHardDeleteError] = useState("");
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [hardDeleteReason, setHardDeleteReason] = useState("");

  useEffect(() => {
    disableBusyRef.current = false;
    hardDeleteBusyRef.current = false;
    setDisableBusy(false);
    setDisableError("");
    setHardDeleteBusy(false);
    setHardDeleteError("");
    setHardDeleteOpen(false);
    setHardDeleteReason("");
  }, [identityKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function isCurrent(operationIdentity: string): boolean {
    return mountedRef.current && identityRef.current === operationIdentity;
  }

  async function settleLifecycleMutation(operationIdentity: string): Promise<"current" | "removed" | "stale"> {
    for (let frame = 0; frame < 30; frame += 1) {
      await nextFrame();
      if (hasVisibleTeammateListFallback() || !mountedRef.current) return "removed";
      if (identityRef.current !== operationIdentity) return "stale";
    }
    return "current";
  }

  function requestHardDelete(): void {
    if (viewModel.protectedTeammate || !onHardDeleteTeammate || hardDeleteBusyRef.current) return;
    setHardDeleteOpen(true);
  }

  function setHardDeleteDialogOpen(open: boolean): void {
    if (!open && hardDeleteBusyRef.current) return;
    if (open) requestHardDelete();
    else setHardDeleteOpen(false);
  }

  function restoreHardDeleteFocus(): void {
    window.requestAnimationFrame(() => {
      if (hardDeleteTriggerRef.current?.isConnected) {
        hardDeleteTriggerRef.current.focus({ preventScroll: true });
        return;
      }
      focusTeammateListFallback();
    });
  }

  async function disable(): Promise<void> {
    if (viewModel.protectedTeammate || disableBusyRef.current) return;
    const operationIdentity = identityRef.current;
    disableBusyRef.current = true;
    setDisableBusy(true);
    setDisableError("");
    try {
      await onDisableTeammate(operationIdentity);
      const outcome = await settleLifecycleMutation(operationIdentity);
      if (outcome === "removed") {
        focusTeammateListFallback();
        return;
      }
      if (outcome === "stale") return;
      setDisableError(t("Unknown error"));
    } catch (caught) {
      if (isCurrent(operationIdentity)) setDisableError(errorMessage(caught, t("Unknown error")));
    } finally {
      if (isCurrent(operationIdentity)) {
        disableBusyRef.current = false;
        setDisableBusy(false);
      }
    }
  }

  async function confirmHardDelete(): Promise<void> {
    if (
      viewModel.protectedTeammate ||
      !onHardDeleteTeammate ||
      hardDeleteBusyRef.current
    ) return;
    const operationIdentity = identityRef.current;
    hardDeleteBusyRef.current = true;
    setHardDeleteBusy(true);
    setHardDeleteError("");
    try {
      await onHardDeleteTeammate(operationIdentity, hardDeleteReason);
      const outcome = await settleLifecycleMutation(operationIdentity);
      if (outcome === "removed") {
        focusTeammateListFallback();
        return;
      }
      if (outcome === "stale") return;
      setHardDeleteError(t("Unknown error"));
    } catch (caught) {
      if (isCurrent(operationIdentity)) setHardDeleteError(errorMessage(caught, t("Unknown error")));
    } finally {
      if (isCurrent(operationIdentity)) {
        hardDeleteBusyRef.current = false;
        setHardDeleteBusy(false);
      }
    }
  }

  return {
    disableBusy,
    disableError,
    hardDeleteBusy,
    hardDeleteError,
    hardDeleteOpen,
    hardDeleteReason,
    hardDeleteTriggerRef: hardDeleteTriggerRef as RefObject<HTMLButtonElement>,
    viewModel,
    confirmHardDelete,
    disable,
    requestHardDelete,
    restoreHardDeleteFocus,
    setHardDeleteDialogOpen,
    setHardDeleteReason,
  };
}

export type TeammateDangerController = ReturnType<typeof useTeammateDangerController>;

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function focusTeammateListFallback(): void {
  let remainingAttempts = 60;
  let stableFrames = 0;
  const tryFocus = (): void => {
    const candidate = document.querySelector<HTMLElement>(
      '[data-settings-workspace-tool="teammates"] [data-ling-input-native="true"]',
    ) ?? document.querySelector<HTMLElement>(
      '.teammate-management-list-panel [data-ling-input-native="true"]',
    ) ?? document.querySelector<HTMLElement>("main button");
    if (candidate?.isConnected) {
      if (document.activeElement !== candidate) candidate.focus({ preventScroll: true });
      stableFrames = document.activeElement === candidate ? stableFrames + 1 : 0;
      if (stableFrames >= 6) return;
    }
    remainingAttempts -= 1;
    if (remainingAttempts > 0) window.requestAnimationFrame(tryFocus);
  };
  window.requestAnimationFrame(tryFocus);
}

function hasVisibleTeammateListFallback(): boolean {
  const candidate = document.querySelector<HTMLElement>(
    '[data-settings-workspace-tool="teammates"] [data-ling-input-native="true"], .teammate-management-list-panel [data-ling-input-native="true"]',
  );
  return Boolean(candidate?.isConnected && candidate.getClientRects().length > 0);
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message.trim() ? caught.message : fallback;
}
