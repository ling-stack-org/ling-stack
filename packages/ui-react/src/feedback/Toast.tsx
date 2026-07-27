import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, Check, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type ToastTone = "loading" | "success" | "info" | "warning" | "error";

export interface ToastAction {
  readonly altText: string;
  readonly label: ReactNode;
  readonly onSelect: () => void;
}

export interface ToastInput {
  readonly id?: string;
  readonly scope?: string;
  readonly title?: ReactNode;
  readonly message: ReactNode;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
  readonly action?: ToastAction;
}

export interface ToastUpdate extends Omit<Partial<ToastInput>, "id" | "scope"> {}

interface ToastItem extends Omit<ToastInput, "id" | "tone"> {
  readonly id: string;
  readonly tone: ToastTone;
  readonly open: boolean;
  readonly revision: number;
}

export interface ToastContextValue {
  readonly showToast: (input: ToastInput) => string;
  readonly updateToast: (idOrScope: string, update: ToastUpdate) => void;
  readonly dismissToast: (idOrScope: string) => void;
}

interface ToastStoreValue extends ToastContextValue {
  readonly closeLabel: string;
  readonly items: readonly ToastItem[];
  readonly viewportLabel: string;
}

const ToastContext = createContext<ToastStoreValue | undefined>(undefined);
const TOAST_EXIT_MS = 200;
const LOADING_DURATION_MS = 24 * 60 * 60 * 1000;

function defaultDuration(tone: ToastTone): number {
  if (tone === "loading") return LOADING_DURATION_MS;
  if (tone === "warning") return 5_000;
  if (tone === "error") return 6_000;
  return 3_000;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  readonly closeLabel?: string;
  readonly maxVisible?: number;
  readonly viewportLabel?: string;
}

export function ToastProvider({
  children,
  closeLabel = "Dismiss notification",
  maxVisible = 3,
  viewportLabel = "Notifications",
}: ToastProviderProps): JSX.Element {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const sequenceRef = useRef(0);
  const cleanupTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearCleanup = useCallback((id: string): void => {
    const timer = cleanupTimersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      cleanupTimersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback((idOrScope: string): void => {
    setItems((current) => current.map((item) => {
      if (item.id !== idOrScope && item.scope !== idOrScope) return item;
      clearCleanup(item.id);
      const id = item.id;
      cleanupTimersRef.current.set(id, setTimeout(() => {
        cleanupTimersRef.current.delete(id);
        setItems((latest) => latest.filter((candidate) => candidate.id !== id));
      }, TOAST_EXIT_MS));
      return { ...item, open: false };
    }));
  }, [clearCleanup]);

  const showToast = useCallback((input: ToastInput): string => {
    const tone = input.tone ?? "success";
    const requestedId = input.id ?? input.scope ?? `ling-toast-${++sequenceRef.current}`;
    setItems((current) => {
      const existing = input.scope
        ? current.find((item) => item.scope === input.scope)
        : input.id
          ? current.find((item) => item.id === input.id)
          : undefined;
      if (existing) {
        clearCleanup(existing.id);
        return current.map((item) => item.id === existing.id
          ? { ...input, id: existing.id, open: true, revision: existing.revision + 1, tone }
          : item);
      }
      const item: ToastItem = { ...input, id: requestedId, open: true, revision: 0, tone };
      return [item, ...current.filter((candidate) => candidate.open)].slice(0, Math.max(1, maxVisible));
    });
    return input.scope ?? requestedId;
  }, [clearCleanup, maxVisible]);

  const updateToast = useCallback((idOrScope: string, update: ToastUpdate): void => {
    setItems((current) => current.map((item) => {
      if (item.id !== idOrScope && item.scope !== idOrScope) return item;
      clearCleanup(item.id);
      return { ...item, ...update, open: true, revision: item.revision + 1, tone: update.tone ?? item.tone };
    }));
  }, [clearCleanup]);

  useEffect(() => () => {
    for (const timer of cleanupTimersRef.current.values()) clearTimeout(timer);
    cleanupTimersRef.current.clear();
  }, []);

  const value = useMemo<ToastStoreValue>(() => ({
    closeLabel,
    dismissToast,
    items,
    showToast,
    updateToast,
    viewportLabel,
  }), [closeLabel, dismissToast, items, showToast, updateToast, viewportLabel]);

  return (
    <ToastPrimitive.Provider swipeDirection="up">
      <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
    </ToastPrimitive.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

export interface ToastProps extends Omit<ToastPrimitive.ToastProps, "duration" | "title"> {
  readonly action?: ToastAction;
  readonly closeLabel: string;
  readonly durationMs?: number;
  readonly message: ReactNode;
  readonly title?: ReactNode;
  readonly tone?: ToastTone;
  readonly timerRevision?: number;
  readonly onDismiss?: () => void;
}

export const Toast = forwardRef<HTMLLIElement, ToastProps>(function Toast(
  { action, className, closeLabel, durationMs, message, onDismiss, onKeyDown, timerRevision = 0, title, tone = "success", ...props },
  ref,
) {
  const Icon = tone === "success"
    ? Check
    : tone === "warning"
      ? TriangleAlert
      : tone === "error"
        ? AlertCircle
        : tone === "loading"
          ? LoaderCircle
          : Info;
  return (
    <ToastPrimitive.Root
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-toast", className)}
      data-ling-overlay="toast"
      data-tone={tone}
      duration={(durationMs ?? defaultDuration(tone)) + (timerRevision % 2)}
      role={tone === "error" ? "alert" : "status"}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && event.key === "Escape") {
          event.preventDefault();
          onDismiss?.();
        }
      }}
    >
      <span className="ling-ui-toast-tone" aria-hidden="true"><Icon /></span>
      <span className="ling-ui-toast-copy">
        {title ? <ToastPrimitive.Title className="ling-ui-toast-title">{title}</ToastPrimitive.Title> : null}
        <ToastPrimitive.Description className="ling-ui-toast-description">{message}</ToastPrimitive.Description>
      </span>
      {action ? (
        <ToastPrimitive.Action asChild altText={action.altText}>
          <button className="ling-ui-toast-action" type="button" onClick={action.onSelect}>{action.label}</button>
        </ToastPrimitive.Action>
      ) : null}
      <ToastPrimitive.Close asChild>
        <button className="ling-ui-toast-close" type="button" aria-label={closeLabel} title={closeLabel}><X aria-hidden="true" /></button>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
});

export interface ToastViewportProps extends HTMLAttributes<HTMLOListElement> {
  readonly hotkey?: string[];
}

export const ToastViewport = forwardRef<HTMLOListElement, ToastViewportProps>(function ToastViewport(
  { className, hotkey, ...props },
  ref,
) {
  const context = useContext(ToastContext);
  if (!context) throw new Error("ToastViewport must be used within ToastProvider");
  return (
    <ToastPrimitive.Viewport
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-toast-viewport", className)}
      hotkey={hotkey}
      label={context.viewportLabel}
    >
      {context.items.map((item) => (
        <Toast
          key={item.id}
          action={item.action}
          closeLabel={context.closeLabel}
          data-scope={item.scope}
          durationMs={item.durationMs}
          message={item.message}
          open={item.open}
          title={item.title}
          tone={item.tone}
          timerRevision={item.revision}
          onDismiss={() => context.dismissToast(item.id)}
          onOpenChange={(open) => {
            if (!open) context.dismissToast(item.id);
          }}
        />
      ))}
    </ToastPrimitive.Viewport>
  );
});
