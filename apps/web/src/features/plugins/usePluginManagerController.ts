import { useEffect, useMemo, useRef, useState } from "react";
import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import {
  PLUGIN_DRAFT_ID,
  type PluginActionError,
  type PluginActionErrorFilter,
  type PluginActionOwner,
  type PluginActionRequest,
  type PluginBusyAction,
  type PluginPendingAction,
} from "../../domains/plugins/use-plugins-domain.js";
import { filterPluginRows, hasActivePluginFilters } from "./plugin-manager-filter.js";
import { buildPluginActionFailure } from "./plugin-manager-feedback.js";
import { buildPluginRowView } from "./plugin-manager-row-view-model.js";
import type {
  PluginActionFailure,
  PluginManagerFilters,
  PluginRowView,
} from "./plugin-manager-types.js";

const defaultFilters: PluginManagerFilters = { query: "", source: "all", status: "all" };

export interface PluginManagerController {
  readonly filters: PluginManagerFilters;
  readonly rows: readonly PluginRowView[];
  readonly visibleRows: readonly PluginRowView[];
  readonly hasActiveFilters: boolean;
  readonly createOpen: boolean;
  readonly detailPluginId: string;
  readonly guidePluginId: string;
  readonly chromeConnectPluginId: string;
  readonly uninstallPluginId: string;
  readonly loadError: string;
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
  readonly openChromeConnect: (pluginId: string) => void;
  readonly closeChromeConnect: () => void;
  readonly requestUninstall: (pluginId: string) => void;
  readonly cancelUninstall: () => void;
  readonly completeUninstall: () => void;
  readonly actionFailureFor: (
    pluginId: string,
    owner: PluginActionOwner,
    action?: PluginBusyAction,
  ) => PluginActionFailure | undefined;
  readonly pendingActionFor: (
    pluginId: string,
    owner: PluginActionOwner,
    action?: PluginBusyAction,
  ) => PluginPendingAction | undefined;
  readonly runRefresh: (refresh: () => void) => void;
  readonly runMutation: <T>(input: {
    readonly pluginId: string;
    readonly action: PluginBusyAction;
    readonly owner: PluginActionOwner;
    readonly mutate: (request: PluginActionRequest) => Promise<T> | T;
  }) => Promise<T>;
}

export function usePluginManagerController(input: {
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly loadError: string;
  readonly pendingActions: readonly PluginPendingAction[];
  readonly actionErrors: readonly PluginActionError[];
  readonly clearActionErrors: (filter: PluginActionErrorFilter) => void;
  readonly t: Translate;
}): PluginManagerController {
  const [filters, setFilters] = useState<PluginManagerFilters>(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailPluginId, setDetailPluginId] = useState("");
  const [guidePluginId, setGuidePluginId] = useState("");
  const [chromeConnectPluginId, setChromeConnectPluginId] = useState("");
  const [uninstallPluginId, setUninstallPluginId] = useState("");
  const [uninstallReturnPluginId, setUninstallReturnPluginId] = useState("");
  const requestSequenceRef = useRef(0);
  const actionFailures = useMemo(
    () => input.actionErrors.map((failure) => buildPluginActionFailure(failure, input.t)),
    [input.actionErrors, input.t],
  );
  const now = useMemo(() => new Date().toISOString(), [input.plugins]);
  const rows = useMemo(
    () => input.plugins.map((plugin) => {
      const pending = findLatestOwnedAction(input.pendingActions, plugin.id, "row");
      const failure = findLatestOwnedAction(actionFailures, plugin.id, "row");
      return buildPluginRowView(
        plugin,
        pending?.pluginId ?? "",
        pending?.action,
        now,
        input.t,
        failure,
      );
    }),
    [actionFailures, input.pendingActions, input.plugins, input.t, now],
  );
  const visibleRows = useMemo(() => filterPluginRows(rows, filters), [filters, rows]);

  useEffect(() => {
    const ids = new Set(input.plugins.map((plugin) => plugin.id));
    if (detailPluginId && !ids.has(detailPluginId)) {
      input.clearActionErrors({ pluginId: detailPluginId, owner: "detail" });
      setDetailPluginId("");
    }
    if (guidePluginId && !ids.has(guidePluginId)) {
      input.clearActionErrors({ pluginId: guidePluginId, owner: "guide" });
      setGuidePluginId("");
    }
    if (chromeConnectPluginId && !ids.has(chromeConnectPluginId)) {
      input.clearActionErrors({ pluginId: chromeConnectPluginId, owner: "chrome-connect" });
      setChromeConnectPluginId("");
    }
    if (uninstallPluginId && !ids.has(uninstallPluginId)) {
      input.clearActionErrors({ pluginId: uninstallPluginId, owner: "uninstall" });
      setUninstallPluginId("");
    }
  }, [chromeConnectPluginId, detailPluginId, guidePluginId, input.clearActionErrors, input.plugins, uninstallPluginId]);

  function clearOverlayError(pluginId: string, owner: PluginActionOwner): void {
    if (pluginId) input.clearActionErrors({ pluginId, owner });
  }

  function closeCreate(): void {
    input.clearActionErrors({ pluginId: PLUGIN_DRAFT_ID, owner: "create" });
    setCreateOpen(false);
  }

  function closeDetails(): void {
    clearOverlayError(detailPluginId, "detail");
    setDetailPluginId("");
  }

  function closeGuide(): void {
    clearOverlayError(guidePluginId, "guide");
    setGuidePluginId("");
  }

  function closeChromeConnect(): void {
    clearOverlayError(chromeConnectPluginId, "chrome-connect");
    setChromeConnectPluginId("");
  }

  function cancelUninstall(): void {
    clearOverlayError(uninstallPluginId, "uninstall");
    setUninstallPluginId("");
    if (uninstallReturnPluginId) setDetailPluginId(uninstallReturnPluginId);
    setUninstallReturnPluginId("");
  }

  function actionFailureFor(
    pluginId: string,
    owner: PluginActionOwner,
    action?: PluginBusyAction,
  ): PluginActionFailure | undefined {
    return findLatestOwnedAction(actionFailures, pluginId, owner, action);
  }

  function pendingActionFor(
    pluginId: string,
    owner: PluginActionOwner,
    action?: PluginBusyAction,
  ): PluginPendingAction | undefined {
    return findLatestOwnedAction(input.pendingActions, pluginId, owner, action);
  }

  async function runMutation<T>({
    pluginId,
    action,
    owner,
    mutate,
  }: {
    readonly pluginId: string;
    readonly action: PluginBusyAction;
    readonly owner: PluginActionOwner;
    readonly mutate: (request: PluginActionRequest) => Promise<T> | T;
  }): Promise<T> {
    const request: PluginActionRequest = {
      owner,
      requestId: `plugin:${++requestSequenceRef.current}`,
    };
    return await mutate(request);
  }

  return {
    filters,
    rows,
    visibleRows,
    hasActiveFilters: hasActivePluginFilters(filters),
    createOpen,
    detailPluginId,
    guidePluginId,
    chromeConnectPluginId,
    uninstallPluginId,
    loadError: input.loadError,
    retainedRefreshError: Boolean(input.loadError),
    setQuery: (query) => setFilters((current) => ({ ...current, query })),
    setSource: (source) => setFilters((current) => ({ ...current, source })),
    setStatus: (status) => setFilters((current) => ({ ...current, status })),
    clearFilters: () => setFilters(defaultFilters),
    openCreate: () => {
      closeDetails();
      closeGuide();
      closeChromeConnect();
      cancelUninstall();
      input.clearActionErrors({ pluginId: PLUGIN_DRAFT_ID, owner: "create" });
      setCreateOpen(true);
    },
    closeCreate,
    openDetails: (pluginId) => {
      closeCreate();
      closeGuide();
      closeChromeConnect();
      cancelUninstall();
      if (detailPluginId && detailPluginId !== pluginId) clearOverlayError(detailPluginId, "detail");
      setDetailPluginId(pluginId);
    },
    closeDetails,
    openGuide: (pluginId) => {
      closeCreate();
      closeDetails();
      closeChromeConnect();
      cancelUninstall();
      if (guidePluginId && guidePluginId !== pluginId) clearOverlayError(guidePluginId, "guide");
      setGuidePluginId(pluginId);
    },
    closeGuide,
    openChromeConnect: (pluginId) => {
      closeCreate();
      closeDetails();
      closeGuide();
      cancelUninstall();
      if (chromeConnectPluginId && chromeConnectPluginId !== pluginId) {
        clearOverlayError(chromeConnectPluginId, "chrome-connect");
      }
      setChromeConnectPluginId(pluginId);
    },
    closeChromeConnect,
    requestUninstall: (pluginId) => {
      setUninstallReturnPluginId(detailPluginId === pluginId ? pluginId : "");
      closeCreate();
      if (detailPluginId && detailPluginId !== pluginId) closeDetails();
      setDetailPluginId("");
      closeGuide();
      closeChromeConnect();
      if (uninstallPluginId && uninstallPluginId !== pluginId) clearOverlayError(uninstallPluginId, "uninstall");
      setUninstallPluginId(pluginId);
    },
    cancelUninstall,
    completeUninstall: () => {
      clearOverlayError(uninstallPluginId, "uninstall");
      setUninstallPluginId("");
      setUninstallReturnPluginId("");
    },
    actionFailureFor,
    pendingActionFor,
    runRefresh: (refresh) => {
      if (!input.isLoading) refresh();
    },
    runMutation,
  };
}

function findLatestOwnedAction<T extends {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
  readonly owner: PluginActionOwner;
}>(
  actions: readonly T[],
  pluginId: string,
  owner: PluginActionOwner,
  action?: PluginBusyAction,
): T | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const candidate = actions[index];
    if (!candidate || candidate.pluginId !== pluginId) continue;
    if (!ownerMatches(candidate.owner, owner)) continue;
    if (action && candidate.action !== action) continue;
    return candidate;
  }
  return undefined;
}

function ownerMatches(candidate: PluginActionOwner, requested: PluginActionOwner): boolean {
  return candidate === requested || (requested === "row" && candidate === "detected-connect");
}
