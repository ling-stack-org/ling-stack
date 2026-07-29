import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listTeammateActivity } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type { TeammateActivityItem } from "../../types.js";
import {
  buildTeammateActivityRows,
  filterTeammateActivityRows,
  type TeammateActivityFilter,
} from "./teammate-activity-view-models.js";

export function useTeammateActivityController({
  cwd,
  enabled,
  teammateId,
}: {
  readonly cwd: string;
  readonly enabled: boolean;
  readonly teammateId: string;
}) {
  const { t } = useI18n();
  const identityKey = `${cwd.trim()}::${teammateId}`;
  const identityRef = useRef(identityKey);
  const requestSequenceRef = useRef(0);
  const loadedIdentityRef = useRef("");
  const itemsRef = useRef<readonly TeammateActivityItem[]>([]);
  identityRef.current = identityKey;

  const [items, setItems] = useState<readonly TeammateActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<TeammateActivityFilter>("all");

  const rows = useMemo(() => buildTeammateActivityRows(items, t), [items, t]);
  const visibleRows = useMemo(
    () => filterTeammateActivityRows(rows, searchQuery, filter),
    [filter, rows, searchQuery],
  );

  const refresh = useCallback(async (mode: "initial" | "refresh" = "refresh"): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const requestIdentity = `${workspaceCwd}::${teammateId}`;
    const requestId = ++requestSequenceRef.current;
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError("");
    try {
      const response = await listTeammateActivity(workspaceCwd, teammateId, 100);
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      itemsRef.current = response.items;
      setItems(response.items);
      setStale(false);
    } catch {
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      setStale(itemsRef.current.length > 0);
      setError(t("Recent activity could not be loaded. Try again."));
    } finally {
      if (identityRef.current === requestIdentity && requestId === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, t, teammateId]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    loadedIdentityRef.current = "";
    itemsRef.current = [];
    setItems([]);
    setLoading(false);
    setRefreshing(false);
    setStale(false);
    setError("");
    setSearchQuery("");
    setFilter("all");
  }, [identityKey]);

  useEffect(() => {
    if (!enabled || loadedIdentityRef.current === identityKey) return;
    loadedIdentityRef.current = identityKey;
    void refresh("initial");
  }, [enabled, identityKey, refresh]);

  function clearFilters(): void {
    setSearchQuery("");
    setFilter("all");
  }

  return {
    error,
    filter,
    loading,
    refreshing,
    rows,
    searchQuery,
    stale,
    visibleRows,
    clearFilters,
    refresh,
    setFilter,
    setSearchQuery,
  };
}

export type TeammateActivityController = ReturnType<typeof useTeammateActivityController>;
