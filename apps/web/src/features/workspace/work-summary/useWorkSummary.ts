import { useCallback, useEffect, useRef, useState } from "react";
import { daemonClient } from "../../../api/client.js";
import type { WorkSummaryResponse } from "./work-summary.types.js";
import { retainSummaryEvidence } from "./work-summary-model.js";

const snapshots = new Map<string, WorkSummaryResponse>();
const pending = new Map<string, Promise<WorkSummaryResponse>>();
export const workSummaryInvalidatedEvent = "ling:work-summary-invalidated";

function readSummary(cwd: string): Promise<WorkSummaryResponse> {
  const existing = pending.get(cwd);
  if (existing) return existing;
  const request = daemonClient.getWorkSummary(cwd).then((response) => {
    const retained = retainSummaryEvidence(response, snapshots.get(cwd));
    snapshots.set(cwd, retained);
    if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
    return retained;
  }).finally(() => { if (pending.get(cwd) === request) pending.delete(cwd); });
  pending.set(cwd, request);
  return request;
}

export function useWorkSummary(cwd: string, visible: boolean) {
  const [state, setState] = useState<{ cwd: string; data?: WorkSummaryResponse; loading: boolean; error?: string }>({ cwd, data: snapshots.get(cwd), loading: false });
  const identity = useRef({ cwd });
  if (identity.current.cwd !== cwd) identity.current = { cwd };
  const owner = identity.current;
  const refresh = useCallback(async () => {
    if (!cwd.trim()) return;
    setState((current) => ({ cwd, data: current.cwd === cwd ? current.data : snapshots.get(cwd), loading: true }));
    try {
      const data = await readSummary(cwd);
      if (identity.current === owner) setState({ cwd, data, loading: false });
    } catch (error) {
      if (identity.current === owner) setState((current) => ({ ...current, cwd, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [cwd, owner]);

  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden && !stopped) timer = setTimeout(tick, 15_000);
    };
    const tick = async () => {
      if (document.hidden || stopped) return;
      await refresh();
      schedule();
    };
    const invalidate = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.cwd && event.detail.cwd !== cwd) return;
      clearTimeout(timer);
      if (!document.hidden && !stopped) timer = setTimeout(tick, 350);
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void tick(); };
    void tick();
    window.addEventListener(workSummaryInvalidatedEvent, invalidate);
    window.addEventListener("online", visibility);
    document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener(workSummaryInvalidatedEvent, invalidate); window.removeEventListener("online", visibility); document.removeEventListener("visibilitychange", visibility); };
  }, [cwd, visible, refresh]);

  return { data: state.cwd === cwd ? state.data : snapshots.get(cwd), loading: state.cwd === cwd && state.loading,
    error: state.cwd === cwd ? state.error : undefined, refresh };
}
