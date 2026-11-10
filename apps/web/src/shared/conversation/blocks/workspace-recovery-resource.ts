import { useCallback, useEffect, useState } from "react";
import type { ConversationWorkspaceRecoveryTarget } from "@ling-stack/conversation-ui-core";
import type { RunWorkspaceChangesResponse, TurnWorkspaceChangesResponse, WorkflowWorkspaceChangesResponse } from "@ling-stack/contracts";
import { getRunWorkspaceChanges, getTurnWorkspaceChanges, getWorkflowWorkspaceChanges } from "../../../api.js";

export type WorkspaceRecoveryResponse = RunWorkspaceChangesResponse | TurnWorkspaceChangesResponse | WorkflowWorkspaceChangesResponse;
export interface WorkspaceRecoveryResource {
  readonly recovery?: WorkspaceRecoveryResponse;
  readonly status: "idle" | "loading" | "loaded" | "unavailable";
  readonly refresh: () => void;
  readonly update: (response: WorkspaceRecoveryResponse) => void;
}

export async function getWorkspaceRecovery(cwd: string, target: ConversationWorkspaceRecoveryTarget): Promise<WorkspaceRecoveryResponse> {
  const response = await (target.kind === "workflow" ? getWorkflowWorkspaceChanges(cwd, target.id)
    : target.kind === "turn" ? getTurnWorkspaceChanges(cwd, target.id) : getRunWorkspaceChanges(cwd, target.id));
  if (response.review && (response.review.scope.kind !== target.kind || response.review.scope.id !== target.id)) {
    throw new Error("Change review does not match the requested work scope.");
  }
  return response;
}

/** One scoped read shared by the final file card and its recovery controls. */
export function useWorkspaceRecovery(cwd: string | undefined, target: ConversationWorkspaceRecoveryTarget | undefined, revisionKey = ""): WorkspaceRecoveryResource {
  const key = JSON.stringify([cwd, target?.kind, target?.id, revisionKey]);
  const [state, setState] = useState<{ key: string; recovery?: WorkspaceRecoveryResponse; status: WorkspaceRecoveryResource["status"] }>({ key, status: "idle" });
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const update = useCallback((recovery: WorkspaceRecoveryResponse) => setState({ key, recovery, status: "loaded" }), [key]);
  const kind = target?.kind;
  const id = target?.id;
  useEffect(() => {
    if (!cwd || !kind || !id) { setState({ key, status: "idle" }); return; }
    let cancelled = false;
    setState({ key, status: "loading" });
    void getWorkspaceRecovery(cwd, { kind, id }).then((recovery) => {
      if (!cancelled) setState({ key, recovery, status: "loaded" });
    }, () => { if (!cancelled) setState({ key, status: "unavailable" }); });
    return () => { cancelled = true; };
  }, [cwd, kind, id, key, refreshKey]);
  // A changed scope must never render the old scope while its effect is pending.
  return { ...(state.key === key ? state : { status: cwd && target ? "loading" as const : "idle" as const }), refresh, update };
}
