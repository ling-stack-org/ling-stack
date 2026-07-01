import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listChannelProposedPlanArtifacts,
  listProposedPlanArtifacts,
} from "../../api.js";
import type { ProposedPlanArtifact } from "../../types.js";

export interface UseChannelPlanHistoryInput {
  readonly cwd: string;
  readonly threadId?: string;
  readonly channelId?: string;
}

export interface UseChannelPlanHistoryResult {
  readonly proposedPlanArtifacts: readonly ProposedPlanArtifact[];
  readonly proposedPlanArtifactsById: ReadonlyMap<string, ProposedPlanArtifact>;
  readonly proposedPlanHistoryLoading: boolean;
  readonly proposedPlanHistoryError: string;
  readonly refreshProposedPlanHistory: () => void;
  readonly rememberProposedPlanArtifact: (plan: ProposedPlanArtifact) => void;
}

export function useChannelPlanHistory({
  cwd,
  threadId,
  channelId,
}: UseChannelPlanHistoryInput): UseChannelPlanHistoryResult {
  const [proposedPlanArtifactsById, setProposedPlanArtifactsById] = useState<ReadonlyMap<string, ProposedPlanArtifact>>(new Map());
  const [proposedPlanHistoryLoading, setProposedPlanHistoryLoading] = useState(false);
  const [proposedPlanHistoryError, setProposedPlanHistoryError] = useState("");
  const [proposedPlanHistoryRefreshKey, setProposedPlanHistoryRefreshKey] = useState(0);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || (!threadId && !channelId)) {
      setProposedPlanArtifactsById(new Map());
      setProposedPlanHistoryLoading(false);
      setProposedPlanHistoryError("");
      return;
    }
    let cancelled = false;
    setProposedPlanHistoryLoading(true);
    setProposedPlanHistoryError("");
    const loadPlans = channelId
      ? listChannelProposedPlanArtifacts(workspaceCwd, channelId, { scope: "channel", limit: 200 })
      : listProposedPlanArtifacts(workspaceCwd, threadId ?? "", { limit: 100 });
    void loadPlans
      .then((response) => {
        if (cancelled) {
          return;
        }
        setProposedPlanArtifactsById(new Map(response.plans.map((plan) => [plan.id, plan])));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProposedPlanArtifactsById(new Map());
          setProposedPlanHistoryError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProposedPlanHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, cwd, proposedPlanHistoryRefreshKey, threadId]);

  const proposedPlanArtifacts = useMemo(
    () => [...proposedPlanArtifactsById.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    ),
    [proposedPlanArtifactsById],
  );

  const refreshProposedPlanHistory = useCallback(() => {
    setProposedPlanHistoryRefreshKey((key) => key + 1);
  }, []);

  const rememberProposedPlanArtifact = useCallback((plan: ProposedPlanArtifact) => {
    setProposedPlanArtifactsById((current) => {
      const next = new Map(current);
      next.set(plan.id, plan);
      return next;
    });
  }, []);

  return {
    proposedPlanArtifacts,
    proposedPlanArtifactsById,
    proposedPlanHistoryLoading,
    proposedPlanHistoryError,
    refreshProposedPlanHistory,
    rememberProposedPlanArtifact,
  };
}
