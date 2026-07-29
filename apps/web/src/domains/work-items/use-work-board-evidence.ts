import { useEffect, useRef, useState } from "react";
import { listRunArtifacts } from "../../api/runs.js";
import type { WorkItemView } from "../../lib/work-items.js";
import type { WorkBoardEvidenceState } from "../../features/work-board/work-board-types.js";

export function useWorkBoardEvidence(cwd?: string, selectedItemId?: string) {
  const normalizedCwd = cwd?.trim() ?? "";
  const [cache, setCache] = useState<ReadonlyMap<string, WorkBoardEvidenceState>>(new Map());
  const cacheRef = useRef(cache);
  const requestRef = useRef(new Map<string, number>());
  const identityRef = useRef({ cwd: normalizedCwd, selectedItemId: selectedItemId ?? "" });
  cacheRef.current = cache;
  identityRef.current = { cwd: normalizedCwd, selectedItemId: selectedItemId ?? "" };

  useEffect(() => {
    requestRef.current.clear();
    setCache(new Map());
  }, [normalizedCwd]);

  function read(item: WorkItemView | undefined): WorkBoardEvidenceState | undefined {
    if (!item?.runId) return undefined;
    return cache.get(cacheKey(normalizedCwd, item.id, item.runId)) ?? { itemId: item.id, runId: item.runId, status: "idle", artifacts: [] };
  }

  async function load(item: WorkItemView, force = false): Promise<void> {
    if (!normalizedCwd || !item.runId) return;
    const key = cacheKey(normalizedCwd, item.id, item.runId);
    const previous = cacheRef.current.get(key);
    if (!force && previous && (previous.status === "loading" || previous.status === "ready" || previous.status === "empty")) return;
    const requestId = (requestRef.current.get(key) ?? 0) + 1;
    requestRef.current.set(key, requestId);
    update(key, { itemId: item.id, runId: item.runId, status: "loading", artifacts: previous?.artifacts ?? [] });
    try {
      const response = await listRunArtifacts(item.runId, normalizedCwd);
      if (!requestIsCurrent(key, requestId, item.id)) return;
      update(key, { itemId: item.id, runId: item.runId, status: response.artifacts.length > 0 ? "ready" : "empty", artifacts: response.artifacts });
    } catch (caught) {
      if (!requestIsCurrent(key, requestId, item.id)) return;
      const artifacts = previous?.artifacts ?? [];
      update(key, {
        itemId: item.id, runId: item.runId, status: artifacts.length > 0 ? "stale" : "error", artifacts,
        issue: { kind: "load", source: "runs", message: "Could not load run evidence", technicalMessage: caught instanceof Error ? caught.message : String(caught) },
      });
    }
  }

  function requestIsCurrent(key: string, requestId: number, itemId: string): boolean {
    return requestRef.current.get(key) === requestId && identityRef.current.cwd === normalizedCwd && identityRef.current.selectedItemId === itemId;
  }

  function update(key: string, value: WorkBoardEvidenceState): void {
    setCache((current) => new Map(current).set(key, value));
  }

  return { read, load };
}

function cacheKey(cwd: string, itemId: string, runId: string): string {
  return `${cwd}:${itemId}:${runId}`;
}
