import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Translate } from "../../i18n.js";
import type { AiCouncil, AiCouncilHealthReport } from "../../types.js";
import {
  buildCouncilListHealthOverview,
  buildCouncilListHealthRows,
  filterCouncilListHealthRows,
  type CouncilListHealthFilter,
  type CouncilListHealthRowView,
} from "./council-list-health-view-model.js";

export interface CouncilListHealthController {
  readonly clearFilters: () => void;
  readonly filter: CouncilListHealthFilter;
  readonly initialLoading: boolean;
  readonly overview: ReturnType<typeof buildCouncilListHealthOverview>;
  readonly query: string;
  readonly refresh: () => Promise<void>;
  readonly refreshBusy: boolean;
  readonly refreshError: string;
  readonly rows: readonly CouncilListHealthRowView[];
  readonly selectCouncil: (councilId: string) => void;
  readonly selectProjectedCouncil: (councilId: string) => void;
  readonly selectedRow?: CouncilListHealthRowView;
  readonly setFilter: (filter: CouncilListHealthFilter) => void;
  readonly setQuery: (query: string) => void;
  readonly stale: boolean;
  readonly visibleRows: readonly CouncilListHealthRowView[];
}

export function useCouncilListHealthController({
  councils,
  healthReport,
  loading,
  onRefresh,
  t,
}: {
  readonly councils: readonly AiCouncil[];
  readonly healthReport?: AiCouncilHealthReport;
  readonly loading: boolean;
  readonly onRefresh: () => void | Promise<void>;
  readonly t: Translate;
}): CouncilListHealthController {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CouncilListHealthFilter>("all");
  const [selectedCouncilId, setSelectedCouncilId] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshCompletion, setRefreshCompletion] = useState(0);
  const refreshFlightRef = useRef(false);
  const refreshAttemptRef = useRef<{ readonly baselineRevision: string; readonly completion: number }>();
  const mountedRef = useRef(true);
  const rows = useMemo(
    () => buildCouncilListHealthRows(councils, healthReport, t),
    [councils, healthReport, t],
  );
  const visibleRows = useMemo(
    () => filterCouncilListHealthRows(rows, query, filter),
    [filter, query, rows],
  );
  const overview = useMemo(() => buildCouncilListHealthOverview(rows), [rows]);
  const selectedRow = visibleRows.find((row) => row.council.id === selectedCouncilId) ?? visibleRows[0];
  const snapshotRevision = useMemo(
    () => `${healthReport?.generatedAt ?? "pending"}:${rows.map((row) => `${row.council.id}:${row.council.updatedAt}`).join("|")}`,
    [healthReport?.generatedAt, rows],
  );
  const snapshotRevisionRef = useRef(snapshotRevision);
  snapshotRevisionRef.current = snapshotRevision;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (rows.length === 0) {
      if (!loading && selectedCouncilId) setSelectedCouncilId("");
      return;
    }
    if (!selectedCouncilId || !rows.some((row) => row.council.id === selectedCouncilId)) {
      setSelectedCouncilId(rows[0]?.council.id ?? "");
    }
  }, [loading, rows, selectedCouncilId]);

  useEffect(() => {
    const attempt = refreshAttemptRef.current;
    if (!attempt || attempt.completion !== refreshCompletion || loading) return;
    if (snapshotRevision === attempt.baselineRevision) {
      setRefreshError(t("Council data could not be refreshed. The last available snapshot is still shown."));
    } else {
      setRefreshError("");
    }
    refreshAttemptRef.current = undefined;
    refreshFlightRef.current = false;
    setRefreshBusy(false);
  }, [loading, refreshCompletion, snapshotRevision, t]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setFilter("all");
  }, []);

  const selectProjectedCouncil = useCallback((councilId: string) => {
    setQuery("");
    setFilter("all");
    setSelectedCouncilId(councilId);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshFlightRef.current) return;
    refreshFlightRef.current = true;
    const baselineRevision = snapshotRevisionRef.current;
    const completion = refreshCompletion + 1;
    refreshAttemptRef.current = { baselineRevision, completion };
    setRefreshBusy(true);
    setRefreshError("");
    try {
      await onRefresh();
      if (mountedRef.current) setRefreshCompletion(completion);
    } catch {
      if (mountedRef.current) {
        setRefreshError(t("Council data could not be refreshed. The last available snapshot is still shown."));
        setRefreshBusy(false);
      }
      refreshAttemptRef.current = undefined;
      refreshFlightRef.current = false;
    }
  }, [onRefresh, refreshCompletion, t]);

  return {
    clearFilters,
    filter,
    initialLoading: loading && rows.length === 0,
    overview,
    query,
    refresh,
    refreshBusy,
    refreshError,
    rows,
    selectCouncil: setSelectedCouncilId,
    selectProjectedCouncil,
    selectedRow,
    setFilter,
    setQuery,
    stale: Boolean(refreshError && rows.length > 0),
    visibleRows,
  };
}
