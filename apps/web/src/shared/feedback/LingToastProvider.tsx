import { Check, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";

export type LingToastTone = "success" | "info" | "warning" | "error";

export interface LingToastInput {
  readonly message: string;
  readonly tone?: LingToastTone;
  readonly durationMs?: number;
  readonly scope?: string;
}

interface LingToastItem extends Required<Omit<LingToastInput, "durationMs" | "scope">> {
  readonly id: string;
  readonly scope?: string;
  readonly durationMs: number;
}

interface LingToastContextValue {
  readonly showToast: (input: LingToastInput) => void;
  readonly dismissToast: (id: string) => void;
}

const LingToastContext = createContext<LingToastContextValue | undefined>(undefined);

export function LingToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<readonly LingToastItem[]>([]);
  const timeoutsRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string): void => {
    const timeout = timeoutsRef.current.get(id);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((input: LingToastInput): void => {
    const id = input.scope ?? `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tone = input.tone ?? "success";
    const durationMs = input.durationMs ?? (tone === "error" ? 6000 : 3000);
    const toast: LingToastItem = { id, message: input.message, tone, durationMs, scope: input.scope };
    const existingTimeout = timeoutsRef.current.get(id);
    if (existingTimeout !== undefined) {
      window.clearTimeout(existingTimeout);
    }
    setToasts((current) => [toast, ...current.filter((item) => item.id !== id)].slice(0, 3));
    timeoutsRef.current.set(id, window.setTimeout(() => dismissToast(id), durationMs));
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timeout of timeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    timeoutsRef.current.clear();
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);
  return (
    <LingToastContext.Provider value={value}>
      {children}
      <div className="ling-toast-viewport" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <div key={toast.id} className={`ling-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
            <span className="ling-toast-icon" aria-hidden="true">{toast.tone === "success" ? <Check size={14} /> : <Info size={14} />}</span>
            <span>{toast.message}</span>
            <button type="button" onClick={() => dismissToast(toast.id)} aria-label={t("Dismiss notification")} title={t("Dismiss notification")}><X size={14} /></button>
          </div>
        ))}
      </div>
    </LingToastContext.Provider>
  );
}

export function useLingToast(): LingToastContextValue {
  const context = useContext(LingToastContext);
  if (!context) {
    throw new Error("useLingToast must be used within LingToastProvider");
  }
  return context;
}
