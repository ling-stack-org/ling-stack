import type { LingTurnStatus, ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";

export function isChangeSummaryTurnActive(status: LingTurnStatus | undefined): boolean {
  return status === "open" || status === "running" || status === "waiting_for_approval" || status === "waiting_for_input";
}

/** A single-flight read loop with trailing invalidation and visibility admission. */
export function createChangeSummaryObserver(options: {
  readonly read: () => Promise<ThreadWorkspaceChangeSummaryResponse>;
  readonly publish: (response: ThreadWorkspaceChangeSummaryResponse | undefined) => void;
  readonly active: boolean;
  readonly pollMs?: number;
  readonly debounceMs?: number;
}) {
  let disposed = false;
  let paused = false;
  let epoch = 0;
  let inFlight = false;
  let dirty = false;
  let turnActive = false;
  let timerKind: "poll" | "invalidation" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; timerKind = undefined; };
  const schedule = (delay: number, kind: "poll" | "invalidation") => {
    clearTimer();
    if (!disposed && !paused) { timerKind = kind; timer = setTimeout(refresh, delay); }
  };
  function refresh(): void {
    clearTimer();
    if (disposed || paused) return;
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    dirty = false;
    const readEpoch = epoch;
    void options.read().then((response) => {
      if (disposed || paused || readEpoch !== epoch) return;
      turnActive = isChangeSummaryTurnActive(response.turn?.status);
      options.publish(response);
    }, () => {
      if (!disposed && !paused && readEpoch === epoch) options.publish(undefined);
    }).finally(() => {
      inFlight = false;
      if (disposed || paused) return;
      if (dirty) schedule(options.debounceMs ?? 250, "invalidation");
      else if (options.active || turnActive) schedule(options.pollMs ?? 1500, "poll");
    });
  }
  return {
    refresh,
    invalidate() {
      if (disposed || paused) return;
      if (inFlight) dirty = true;
      else if (timerKind !== "invalidation") schedule(options.debounceMs ?? 250, "invalidation");
    },
    setPaused(value: boolean) {
      if (paused === value) return;
      paused = value;
      epoch += 1;
      clearTimer();
      if (!paused) refresh();
    },
    dispose() { disposed = true; epoch += 1; clearTimer(); },
  };
}
