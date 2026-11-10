import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";

export function useChannelProtocolResetController({
  channelId,
  onReset,
}: {
  readonly channelId: string | undefined;
  readonly onReset: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inFlightRef = useRef(false);
  const resetTargetRef = useRef<{
    readonly channelId: string;
    readonly onReset: () => Promise<unknown>;
  } | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onOpenChange = useCallback((nextOpen: boolean): void => {
    if (inFlightRef.current) return;
    if (nextOpen && resetTargetRef.current?.channelId !== channelId) return;
    setOpen(nextOpen);
    setError("");
    if (!nextOpen) resetTargetRef.current = undefined;
  }, [channelId]);

  const openDialog = useCallback((): void => {
    if (inFlightRef.current || !channelId) return;
    resetTargetRef.current = { channelId, onReset };
    setError("");
    setOpen(true);
  }, [channelId, onReset]);

  useEffect(() => {
    if (!open || inFlightRef.current || resetTargetRef.current?.channelId === channelId) return;
    resetTargetRef.current = undefined;
    setError("");
    setOpen(false);
  }, [channelId, open]);

  useEffect(() => {
    if (!open || busy) return undefined;
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [busy, onOpenChange, open]);

  const confirm = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    const resetTarget = resetTargetRef.current;
    if (!resetTarget || resetTarget.channelId !== channelId) {
      resetTargetRef.current = undefined;
      setError("");
      setOpen(false);
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      await resetTarget.onReset();
      resetTargetRef.current = undefined;
      setOpen(false);
      showToast({
        message: t("Protocol reset"),
        scope: `channel:${resetTarget.channelId}:protocol-reset`,
        tone: "success",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [channelId, showToast, t]);

  return {
    busy,
    confirm,
    error,
    open,
    openDialog,
    onOpenChange,
    triggerRef,
  };
}
