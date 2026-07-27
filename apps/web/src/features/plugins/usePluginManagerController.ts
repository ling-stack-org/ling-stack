import { useEffect, useMemo, useState } from "react";
import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { filterPluginRows, hasActivePluginFilters } from "./plugin-manager-filter.js";
import { buildPluginActionFailure, pluginSnapshotFingerprint } from "./plugin-manager-feedback.js";
import { buildPluginRowView } from "./plugin-manager-row-view-model.js";
import type {
  PluginActionFailure,
  PluginActionId,
  PluginActionOwner,
  PluginManagerFilters,
  PluginRowView,
} from "./plugin-manager-types.js";

const defaultFilters: PluginManagerFilters = { query: "", source: "all", status: "all" };

interface PendingPluginMutation {
  readonly pluginId: string;
  readonly action: PluginActionId;
  readonly owner: PluginActionOwner;
  readonly baseline: string;
  readonly sawBusy: boolean;
}

interface PendingPluginRefresh {
  readonly baseline: readonly ManagedPluginView[];
  readonly sawLoading: boolean;
}

export interface PluginManagerController {
  readonly filters: PluginManagerFilters;
  readonly rows: readonly PluginRowView[];
  readonly visibleRows: readonly PluginRowView[];
  readonly hasActiveFilters: boolean;
  readonly createOpen: boolean;
  readonly detailPluginId: string;
  readonly guidePluginId: string;
  readonly uninstallPluginId: string;
  readonly retainedRefreshError: boolean;
  readonly setQuery: (query: string) => void;
  readonly setSource: (source: PluginManagerFilters["source"]) => void;
  readonly setStatus: (status: PluginManagerFilters["status"]) => void;
  readonly clearFilters: () => void;
  readonly openCreate: () => void;
  readonly closeCreate: () => void;
  readonly openDetails: (pluginId: string) => void;
  readonly closeDetails: () => void;
  readonly openGuide: (pluginId: string) => void;
  readonly closeGuide: () => void;
  readonly requestUninstall: (pluginId: string) => void;
  readonly cancelUninstall: () => void;
  readonly completeUninstall: () => void;
  readonly actionFailureFor: (pluginId: string, owner: PluginActionOwner) => PluginActionFailure | undefined;
  readonly runRefresh: (refresh: () => void) => void;
  readonly runMutation: (input: {
    readonly pluginId: string;
    readonly action: PluginActionId;
    readonly owner: PluginActionOwner;
    readonly mutate: () => void;
  }) => void;
}

export function usePluginManagerController(input: {
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly t: Translate;
}): PluginManagerController {
  const [filters, setFilters] = useState<PluginManagerFilters>(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailPluginId, setDetailPluginId] = useState("");
  const [guidePluginId, setGuidePluginId] = useState("");
  const [uninstallPluginId, setUninstallPluginId] = useState("");
  const [uninstallReturnPluginId, setUninstallReturnPluginId] = useState("");
  const [retainedRefreshError, setRetainedRefreshError] = useState(false);
  const [pendingRefresh, setPendingRefresh] = useState<PendingPluginRefresh>();
  const [pendingMutation, setPendingMutation] = useState<PendingPluginMutation>();
  const [actionFailures, setActionFailures] = useState<readonly PluginActionFailure[]>([]);
  const now = useMemo(() => new Date().toISOString(), [input.plugins]);
  const rows = useMemo(
    () => input.plugins.map((plugin) => buildPluginRowView(
      plugin,
      input.busyPluginId,
      input.busyAction,
      now,
      input.t,
      actionFailures.find((failure) => failure.pluginId === plugin.id && failure.owner === "row"),
    )),
    [actionFailures, input.busyAction, input.busyPluginId, input.plugins, input.t, now],
  );
  const visibleRows = useMemo(() => filterPluginRows(rows, filters), [filters, rows]);

  useEffect(() => {
    const ids = new Set(input.plugins.map((plugin) => plugin.id));
    if (detailPluginId && !ids.has(detailPluginId)) setDetailPluginId("");
    if (guidePluginId && !ids.has(guidePluginId)) setGuidePluginId("");
    if (uninstallPluginId && !ids.has(uninstallPluginId)) setUninstallPluginId("");
    setActionFailures((current) => current.filter((failure) => ids.has(failure.pluginId)));
  }, [detailPluginId, guidePluginId, input.plugins, uninstallPluginId]);

  useEffect(() => {
    if (!pendingRefresh) return;
    if (input.isLoading && !pendingRefresh.sawLoading) {
      setPendingRefresh({ ...pendingRefresh, sawLoading: true });
      return;
    }
    if (!pendingRefresh.sawLoading || input.isLoading) return;
    setRetainedRefreshError(input.plugins === pendingRefresh.baseline);
    setPendingRefresh(undefined);
  }, [input.isLoading, input.plugins, pendingRefresh]);

  useEffect(() => {
    if (!pendingMutation) return;
    const matchingBusy = input.busyPluginId === pendingMutation.pluginId
      && input.busyAction === pendingMutation.action;
    if (matchingBusy && !pendingMutation.sawBusy) {
      setPendingMutation({ ...pendingMutation, sawBusy: true });
      return;
    }
    if (!pendingMutation.sawBusy || matchingBusy) return;
    const currentPlugin = input.plugins.find((plugin) => plugin.id === pendingMutation.pluginId);
    const changed = pluginSnapshotFingerprint(currentPlugin) !== pendingMutation.baseline;
    if (changed) {
      setActionFailures((current) => current.filter((failure) =>
        failure.pluginId !== pendingMutation.pluginId || failure.owner !== pendingMutation.owner));
    } else {
      const failure = buildPluginActionFailure(
        pendingMutation.pluginId,
        pendingMutation.action,
        pendingMutation.owner,
        input.t,
      );
      setActionFailures((current) => [
        ...current.filter((candidate) =>
          candidate.pluginId !== failure.pluginId || candidate.owner !== failure.owner),
        failure,
      ]);
    }
    setPendingMutation(undefined);
  }, [input.busyAction, input.busyPluginId, input.plugins, input.t, pendingMutation]);

  return {
    filters,
    rows,
    visibleRows,
    hasActiveFilters: hasActivePluginFilters(filters),
    createOpen,
    detailPluginId,
    guidePluginId,
    uninstallPluginId,
    retainedRefreshError,
    setQuery: (query) => setFilters((current) => ({ ...current, query })),
    setSource: (source) => setFilters((current) => ({ ...current, source })),
    setStatus: (status) => setFilters((current) => ({ ...current, status })),
    clearFilters: () => setFilters(defaultFilters),
    openCreate: () => {
      setDetailPluginId("");
      setGuidePluginId("");
      setUninstallPluginId("");
      setCreateOpen(true);
    },
    closeCreate: () => setCreateOpen(false),
    openDetails: (pluginId) => {
      setCreateOpen(false);
      setGuidePluginId("");
      setUninstallPluginId("");
      setDetailPluginId(pluginId);
    },
    closeDetails: () => setDetailPluginId(""),
    openGuide: (pluginId) => {
      setCreateOpen(false);
      setDetailPluginId("");
      setUninstallPluginId("");
      setGuidePluginId(pluginId);
    },
    closeGuide: () => setGuidePluginId(""),
    requestUninstall: (pluginId) => {
      setUninstallReturnPluginId(detailPluginId === pluginId ? pluginId : "");
      setDetailPluginId("");
      setGuidePluginId("");
      setUninstallPluginId(pluginId);
    },
    cancelUninstall: () => {
      setUninstallPluginId("");
      if (uninstallReturnPluginId) setDetailPluginId(uninstallReturnPluginId);
      setUninstallReturnPluginId("");
    },
    completeUninstall: () => {
      setUninstallPluginId("");
      setUninstallReturnPluginId("");
    },
    actionFailureFor: (pluginId, owner) => actionFailures.find((failure) =>
      failure.pluginId === pluginId && failure.owner === owner),
    runRefresh: (refresh) => {
      if (input.isLoading || pendingRefresh) return;
      setPendingRefresh({ baseline: input.plugins, sawLoading: false });
      refresh();
    },
    runMutation: ({ pluginId, action, owner, mutate }) => {
      const plugin = input.plugins.find((candidate) => candidate.id === pluginId);
      setActionFailures((current) => current.filter((failure) =>
        failure.pluginId !== pluginId || failure.owner !== owner));
      setPendingMutation({
        pluginId,
        action,
        owner,
        baseline: pluginSnapshotFingerprint(plugin),
        sawBusy: false,
      });
      mutate();
    },
  };
}
