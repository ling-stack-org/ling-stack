import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, ApprovalRisk, ExternalWorkActionView, RunSession } from "../../types.js";
import {
  buildApprovalQueueRows,
  filterApprovalQueueRows,
  type ApprovalCategoryFilter,
  type ApprovalQueueMode,
  type ApprovalRiskFilter,
} from "./approval-view-models.js";

export function useApprovalsPageController(input: {
  readonly approvals: readonly ApprovalRequest[];
  readonly repairRun?: RunSession;
  readonly repairRunId: string;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly inlineApprovalIds?: ReadonlySet<string>;
  readonly selectedApprovalId: string;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onSelectApproval: (approvalId: string) => void;
}) {
  const [mode, setMode] = useState<ApprovalQueueMode>("actionable");
  const [category, setCategory] = useState<ApprovalCategoryFilter>("all");
  const [risk, setRisk] = useState<ApprovalRiskFilter>("all");
  const [search, setSearch] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [refreshTracking, setRefreshTracking] = useState(false);
  const sawRefreshLoadingRef = useRef(false);
  const runsById = useMemo(
    () => input.repairRun ? new Map([[input.repairRun.id, input.repairRun]]) : undefined,
    [input.repairRun],
  );
  const allRows = useMemo(() => buildApprovalQueueRows({
    approvals: input.approvals,
    externalActionDetails: input.externalActionDetails,
    inlineApprovalIds: input.repairRunId ? undefined : input.inlineApprovalIds,
    runsById,
  }), [input.approvals, input.externalActionDetails, input.inlineApprovalIds, input.repairRunId, runsById]);
  const scopedRows = useMemo(
    () => input.repairRunId ? allRows.filter((row) => row.approval.runId === input.repairRunId) : allRows,
    [allRows, input.repairRunId],
  );
  const visibleRows = useMemo(
    () => input.repairRunId ? scopedRows : filterApprovalQueueRows({ rows: scopedRows, mode, category, risk, search }),
    [category, input.repairRunId, mode, risk, scopedRows, search],
  );
  const selectedRow = visibleRows.find((row) => row.id === input.selectedApprovalId) ?? visibleRows[0];

  useEffect(() => {
    if (selectedRow && selectedRow.id !== input.selectedApprovalId) input.onSelectApproval(selectedRow.id);
  }, [input, selectedRow]);

  useEffect(() => {
    if (!refreshTracking) return;
    if (input.isLoading) {
      sawRefreshLoadingRef.current = true;
      return;
    }
    if (!sawRefreshLoadingRef.current) return;
    setRefreshError(input.errorMessage.trim());
    setRefreshTracking(false);
    sawRefreshLoadingRef.current = false;
  }, [input.errorMessage, input.isLoading, refreshTracking]);

  function clearFilters(): void {
    setSearch("");
    setCategory("all");
    setRisk("all");
  }

  function runRefresh(refresh: () => void): void {
    setRefreshError("");
    sawRefreshLoadingRef.current = false;
    setRefreshTracking(true);
    refresh();
  }

  return {
    allRows,
    visibleRows,
    selectedRow,
    mode,
    category,
    risk,
    search,
    filtersActive: Boolean(search.trim() || category !== "all" || risk !== "all"),
    refreshError,
    pendingCount: allRows.filter((row) => row.status === "pending").length,
    categoryOptions: [...new Set(allRows.map((row) => row.category))],
    setMode,
    setCategory,
    setRisk: (value: ApprovalRisk | "all") => setRisk(value),
    setSearch,
    clearFilters,
    runRefresh,
  };
}
