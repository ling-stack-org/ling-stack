import {
  ToastProvider,
  ToastViewport,
  useToast,
  type ToastContextValue,
  type ToastInput,
  type ToastTone,
} from "@ling-stack/ui-react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n.js";
import { useTheme } from "../../theme.js";

export type LingToastTone = ToastTone;
export interface LingToastInput extends ToastInput {
  readonly message: string;
}

export interface LingToastContextValue extends Omit<ToastContextValue, "showToast"> {
  readonly showToast: (input: LingToastInput) => string;
}

export function LingToastProvider({
  children,
  portalContainer,
}: {
  readonly children: ReactNode;
  readonly portalContainer?: HTMLElement | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const viewport = <ToastViewport data-ling-overlay="toast-viewport" />;
  return (
    <ToastProvider closeLabel={t("Dismiss notification")} viewportLabel={t("Notifications")}>
      {children}
      <ThemeStorageToastBridge />
      {portalContainer ? createPortal(viewport, portalContainer) : viewport}
    </ToastProvider>
  );
}

export function useLingToast(): LingToastContextValue {
  return useToast() as LingToastContextValue;
}

function ThemeStorageToastBridge(): null {
  const { t } = useI18n();
  const { storageWarning } = useTheme();
  const { showToast } = useToast();
  useEffect(() => {
    if (!storageWarning) return;
    showToast({
      message: storageWarning === "save-failed"
        ? t("Theme preference could not be saved. The previous theme is still active.")
        : storageWarning === "active-sync-failed"
          ? t("Desktop could not confirm the active theme. Destructive theme actions remain blocked.")
          : storageWarning === "cleanup-pending"
            ? t("Desktop recovered the theme library, but some temporary files still need cleanup.")
            : t("Installed themes could not be loaded. Ling is using a built-in fallback."),
      scope: "theme:storage",
      tone: "warning",
    });
  }, [showToast, storageWarning, t]);
  return null;
}
