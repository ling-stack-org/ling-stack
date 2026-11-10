import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { WorkSummarySession } from "./work-summary.types.js";

interface WorkSummaryContextValue {
  readonly cwd: string;
  readonly onOpenSession: (session: WorkSummarySession) => void;
  readonly rememberTrigger: () => void;
  readonly restoreFocus: () => void;
}

const WorkSummaryContext = createContext<WorkSummaryContextValue | null>(null);

/** Shares project navigation and focus; each surface keeps its existing summary placement. */
export function WorkSummaryProvider({ cwd, onOpenSession, children }: {
  readonly cwd: string;
  readonly onOpenSession: (session: WorkSummarySession) => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLElement | null>(null);
  const rememberTrigger = useCallback(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  const restoreFocus = useCallback(() => { triggerRef.current?.focus(); }, []);
  const value = useMemo(() => ({ cwd, onOpenSession, rememberTrigger, restoreFocus }),
    [cwd, onOpenSession, rememberTrigger, restoreFocus]);

  return <WorkSummaryContext.Provider value={value}>
    {children}
  </WorkSummaryContext.Provider>;
}

export function useWorkSummaryContext(): WorkSummaryContextValue | null {
  return useContext(WorkSummaryContext);
}
