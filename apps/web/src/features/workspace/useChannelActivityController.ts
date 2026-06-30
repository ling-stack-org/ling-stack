import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Translate } from "../../i18n.js";
import { buildChannelActivityItems, type ChannelActivityItem } from "../../lib/channel-activity.js";
import {
  buildChannelActivityDrilldownItem,
  type ChannelActivityDrilldownItem,
} from "../../lib/channel-activity-drilldown.js";
import {
  allChannelActivitySavedViewId,
  applyActivityViewFilter,
  builtinChannelActivitySavedViews,
  clearCustomChannelActivitySavedViews,
  createCustomChannelActivitySavedView,
  maxCustomChannelActivitySavedViews,
  parseCustomChannelActivitySavedViewsValue,
  readCustomChannelActivitySavedViews,
  sanitizeSavedViewName,
  type ChannelActivitySavedView,
  type ChannelActivityViewAttentionFilter,
  type ChannelActivityViewCategoryFilter,
  type ChannelActivityViewFilter,
} from "../../lib/channel-activity-views.js";
import type {
  ApprovalRequest,
  ChannelContextSummary,
  ChannelDecision,
  ChannelHandoff,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunSession,
  StateTransitionEvent,
  Task,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettings,
} from "../../types.js";

type ActivityCategoryFilter = ChannelActivityViewCategoryFilter;
type ActivityAttentionFilter = ChannelActivityViewAttentionFilter;

const activityCategoryFilters: readonly ActivityCategoryFilter[] = ["all", "message", "work", "approval", "protocol", "runtime"];

interface ChannelActivityControllerInput {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly channelStateTransitions: readonly StateTransitionEvent[];
  readonly channelDecisions: readonly ChannelDecision[];
  readonly channelHandoffs: readonly ChannelHandoff[];
  readonly channelContextSummaries: readonly ChannelContextSummary[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly latestRun?: RunSession;
  readonly workspaceSettings: WorkspaceSettings | undefined;
  readonly onWorkspaceSettingsPatch: (patch: UpdateWorkspaceSettingsRequest) => void;
  readonly t: Translate;
}

export interface ChannelActivityController {
  readonly activityToolsOpen: boolean;
  readonly setActivityToolsOpen: Dispatch<SetStateAction<boolean>>;
  readonly activitySearch: string;
  readonly setActivitySearch: Dispatch<SetStateAction<string>>;
  readonly activityCategoryFilter: ActivityCategoryFilter;
  readonly setActivityCategoryFilter: Dispatch<SetStateAction<ActivityCategoryFilter>>;
  readonly activityAttentionFilter: ActivityAttentionFilter;
  readonly setActivityAttentionFilter: Dispatch<SetStateAction<ActivityAttentionFilter>>;
  readonly activitySavedViews: readonly ChannelActivitySavedView[];
  readonly activeActivityViewId: string;
  readonly activityFiltersExpanded: boolean;
  readonly setActivityFiltersExpanded: Dispatch<SetStateAction<boolean>>;
  readonly activityDrilldownItemId: string;
  readonly setActivityDrilldownItemId: Dispatch<SetStateAction<string>>;
  readonly activityItems: readonly ChannelActivityItem[];
  readonly searchedActivityItems: readonly ChannelActivityItem[];
  readonly currentActivityViewFilter: ChannelActivityViewFilter;
  readonly filteredActivityItems: readonly ChannelActivityItem[];
  readonly allActivitySavedViews: readonly ChannelActivitySavedView[];
  readonly savedViewCounts: Readonly<Record<string, number>>;
  readonly selectedActivitySavedView: ChannelActivitySavedView | undefined;
  readonly activityCategoryCounts: Readonly<Record<ActivityCategoryFilter, number>>;
  readonly activityAttentionCounts: Readonly<Record<Exclude<ActivityAttentionFilter, "all">, number>>;
  readonly activityFiltersActive: boolean;
  readonly auditActivityVisible: boolean;
  readonly activityDrilldown: ChannelActivityDrilldownItem | undefined;
  readonly customViewLimitReached: boolean;
  readonly applyActivityView: (view: ChannelActivitySavedView) => void;
  readonly saveActivityView: () => void;
  readonly renameActivityView: () => void;
  readonly deleteActivityView: () => void;
  readonly clearActivityFilters: () => void;
  readonly resetActivityForChannelSwitch: () => void;
}

export function useChannelActivityController({
  cwd,
  selectedChannelId,
  channelMessages,
  tasks,
  runs,
  approvals,
  channelStateTransitions,
  channelDecisions,
  channelHandoffs,
  channelContextSummaries,
  channelWorkflows,
  channelWorkflowSteps,
  latestRun,
  workspaceSettings,
  onWorkspaceSettingsPatch,
  t,
}: ChannelActivityControllerInput): ChannelActivityController {
  const [activityToolsOpen, setActivityToolsOpen] = useState(false);
  const [activitySearch, setActivitySearch] = useState("");
  const [activityCategoryFilter, setActivityCategoryFilter] = useState<ActivityCategoryFilter>("all");
  const [activityAttentionFilter, setActivityAttentionFilter] = useState<ActivityAttentionFilter>("all");
  const [activitySavedViews, setActivitySavedViews] = useState<readonly ChannelActivitySavedView[]>([]);
  const [activeActivityViewId, setActiveActivityViewId] = useState(allChannelActivitySavedViewId);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const [activityDrilldownItemId, setActivityDrilldownItemId] = useState("");
  const lastActivityDrilldownRef = useRef<ChannelActivityDrilldownItem | undefined>();
  const workspaceChannelActivityViewsRef = useRef<WorkspaceSettings["channelActivityViews"] | undefined>(workspaceSettings?.channelActivityViews);
  const onWorkspaceSettingsPatchRef = useRef(onWorkspaceSettingsPatch);

  useEffect(() => {
    workspaceChannelActivityViewsRef.current = workspaceSettings?.channelActivityViews;
    onWorkspaceSettingsPatchRef.current = onWorkspaceSettingsPatch;
  }, [onWorkspaceSettingsPatch, workspaceSettings?.channelActivityViews]);

  const applyActivityView = useCallback((view: ChannelActivitySavedView): void => {
    setActiveActivityViewId(view.id);
    setActivitySearch(view.filter.search);
    setActivityCategoryFilter(view.filter.categoryFilter);
    setActivityAttentionFilter(view.filter.attentionFilter);
  }, []);

  const clearActivityFilters = useCallback((): void => {
    setActivitySearch("");
    setActivityCategoryFilter("all");
    setActivityAttentionFilter("all");
    setActiveActivityViewId(allChannelActivitySavedViewId);
  }, []);

  const resetActivityForChannelSwitch = useCallback((): void => {
    clearActivityFilters();
    setActivityFiltersExpanded(false);
    setActivityDrilldownItemId("");
    setActivityToolsOpen(false);
  }, [clearActivityFilters]);

  const activityItems = useMemo(
    () => buildChannelActivityItems({
      channelId: selectedChannelId,
      messages: channelMessages,
      tasks,
      runs,
      approvals,
      stateTransitions: channelStateTransitions,
      decisions: channelDecisions,
      handoffs: channelHandoffs,
      summaries: channelContextSummaries,
      workflows: channelWorkflows,
      workflowSteps: channelWorkflowSteps,
      extraRun: latestRun,
    }),
    [
      approvals,
      channelContextSummaries,
      channelDecisions,
      channelHandoffs,
      channelMessages,
      channelStateTransitions,
      channelWorkflowSteps,
      channelWorkflows,
      latestRun,
      runs,
      selectedChannelId,
      tasks,
    ],
  );

  const searchedActivityItems = useMemo(() => {
    const query = activitySearch.trim().toLowerCase();
    if (!query) {
      return activityItems;
    }
    return activityItems.filter((item) => item.searchText.includes(query));
  }, [activityItems, activitySearch]);

  const currentActivityViewFilter = useMemo(
    () => ({
      categoryFilter: activityCategoryFilter,
      attentionFilter: activityAttentionFilter,
      search: activitySearch,
    }) satisfies ChannelActivityViewFilter,
    [activityAttentionFilter, activityCategoryFilter, activitySearch],
  );

  const filteredActivityItems = useMemo(
    () => applyActivityViewFilter(activityItems, currentActivityViewFilter),
    [activityItems, currentActivityViewFilter],
  );

  const allActivitySavedViews = useMemo(
    () => [...builtinChannelActivitySavedViews, ...activitySavedViews],
    [activitySavedViews],
  );

  const savedViewCounts = useMemo(
    () =>
      Object.fromEntries(
        allActivitySavedViews.map((view) => [view.id, applyActivityViewFilter(activityItems, view.filter).length]),
      ) as Record<string, number>,
    [activityItems, allActivitySavedViews],
  );

  const selectedActivitySavedView = allActivitySavedViews.find((view) => view.id === activeActivityViewId);

  const activityCategoryCounts = useMemo(
    () =>
      Object.fromEntries(
        activityCategoryFilters.map((filter) => [
          filter,
          filter === "all"
            ? searchedActivityItems.length
            : searchedActivityItems.filter((item) => item.category === filter).length,
        ]),
      ) as Record<ActivityCategoryFilter, number>,
    [searchedActivityItems],
  );

  const activityAttentionCounts = useMemo(
    () =>
      ({
        needs_attention: searchedActivityItems.filter((item) => item.attention !== "none").length,
        blocked: searchedActivityItems.filter((item) => item.attention === "blocked").length,
        failed: searchedActivityItems.filter((item) => item.attention === "failed").length,
        pending: searchedActivityItems.filter((item) => item.attention === "pending").length,
      }) satisfies Record<Exclude<ActivityAttentionFilter, "all">, number>,
    [searchedActivityItems],
  );

  const activityFiltersActive =
    activitySearch.trim().length > 0 ||
    activityCategoryFilter !== "all" ||
    activityAttentionFilter !== "all";
  const auditActivityVisible = activityToolsOpen || activityFiltersActive;
  const activityDrilldown = useMemo(() => {
    if (!activityDrilldownItemId) {
      lastActivityDrilldownRef.current = undefined;
      return undefined;
    }
    const item = activityItems.find((candidate) => candidate.id === activityDrilldownItemId);
    if (!item) {
      return lastActivityDrilldownRef.current?.id === activityDrilldownItemId
        ? lastActivityDrilldownRef.current
        : undefined;
    }
    const drilldown = buildChannelActivityDrilldownItem({
        item,
        workflows: channelWorkflows,
        workflowSteps: channelWorkflowSteps,
        contextSummaries: channelContextSummaries,
        tasks,
      });
    lastActivityDrilldownRef.current = drilldown;
    return drilldown;
  }, [activityDrilldownItemId, activityItems, channelContextSummaries, channelWorkflowSteps, channelWorkflows, tasks]);
  const customViewLimitReached = activitySavedViews.length >= maxCustomChannelActivitySavedViews;

  const persistActivitySavedViews = useCallback((nextViews: readonly ChannelActivitySavedView[]): void => {
    const cappedViews = nextViews.slice(0, maxCustomChannelActivitySavedViews);
    setActivitySavedViews(cappedViews);
    clearCustomChannelActivitySavedViews(cwd, selectedChannelId);
    onWorkspaceSettingsPatch({
      channelActivityViews: {
        ...(workspaceSettings?.channelActivityViews ?? {}),
        [selectedChannelId]: serializeCustomActivitySavedViews(cappedViews),
      },
    });
  }, [cwd, onWorkspaceSettingsPatch, selectedChannelId, workspaceSettings?.channelActivityViews]);

  const saveActivityView = useCallback((): void => {
    if (activitySavedViews.length >= maxCustomChannelActivitySavedViews) {
      globalThis.alert?.(t("Custom saved views are limited to 8."));
      return;
    }
    const name = globalThis.prompt?.(t("Saved view name"), t("Custom view"));
    if (name === undefined || name === null) {
      return;
    }
    const view = createCustomChannelActivitySavedView(name, currentActivityViewFilter);
    persistActivitySavedViews([...activitySavedViews, view]);
    applyActivityView(view);
  }, [activitySavedViews, applyActivityView, currentActivityViewFilter, persistActivitySavedViews, t]);

  const renameActivityView = useCallback((): void => {
    if (!selectedActivitySavedView || selectedActivitySavedView.builtin) {
      return;
    }
    const name = globalThis.prompt?.(t("Rename saved view"), selectedActivitySavedView.name);
    if (name === undefined || name === null) {
      return;
    }
    const nextViews = activitySavedViews.map((view) =>
      view.id === selectedActivitySavedView.id
        ? { ...view, name: sanitizeSavedViewName(name), updatedAt: new Date().toISOString() }
        : view,
    );
    persistActivitySavedViews(nextViews);
  }, [activitySavedViews, persistActivitySavedViews, selectedActivitySavedView, t]);

  const deleteActivityView = useCallback((): void => {
    if (!selectedActivitySavedView || selectedActivitySavedView.builtin) {
      return;
    }
    if (!globalThis.confirm?.(t("Delete saved view?"))) {
      return;
    }
    const nextViews = activitySavedViews.filter((view) => view.id !== selectedActivitySavedView.id);
    persistActivitySavedViews(nextViews);
    applyActivityView(builtinChannelActivitySavedViews[0]);
  }, [activitySavedViews, applyActivityView, persistActivitySavedViews, selectedActivitySavedView, t]);

  const selectedChannelActivityViews = workspaceSettings?.channelActivityViews?.[selectedChannelId];
  const workspaceSettingsLoaded = workspaceSettings !== undefined;

  useEffect(() => {
    const settingsViews = parseCustomChannelActivitySavedViewsValue(selectedChannelActivityViews);
    const legacyViews = readCustomChannelActivitySavedViews(cwd, selectedChannelId);
    const hasSelectedChannel = selectedChannelId.trim().length > 0;
    const shouldMigrateViews =
      workspaceSettingsLoaded &&
      hasSelectedChannel &&
      selectedChannelActivityViews === undefined &&
      legacyViews.length > 0;

    setActivitySavedViews(settingsViews.length > 0 ? settingsViews : (shouldMigrateViews || !workspaceSettingsLoaded ? legacyViews : []));
    applyActivityView(builtinChannelActivitySavedViews[0]);
    setActivityFiltersExpanded(false);
    setActivityDrilldownItemId("");
    if (shouldMigrateViews) {
      onWorkspaceSettingsPatchRef.current({
        channelActivityViews: {
          ...(workspaceChannelActivityViewsRef.current ?? {}),
          [selectedChannelId]: serializeCustomActivitySavedViews(legacyViews),
        },
      });
    } else if (workspaceSettingsLoaded && hasSelectedChannel && selectedChannelActivityViews !== undefined) {
      clearCustomChannelActivitySavedViews(cwd, selectedChannelId);
    }
  }, [applyActivityView, cwd, selectedChannelActivityViews, selectedChannelId, workspaceSettingsLoaded]);

  useEffect(() => {
    if (!activityDrilldownItemId) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setActivityDrilldownItemId("");
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [activityDrilldownItemId]);

  return {
    activityToolsOpen,
    setActivityToolsOpen,
    activitySearch,
    setActivitySearch,
    activityCategoryFilter,
    setActivityCategoryFilter,
    activityAttentionFilter,
    setActivityAttentionFilter,
    activitySavedViews,
    activeActivityViewId,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityDrilldownItemId,
    setActivityDrilldownItemId,
    activityItems,
    searchedActivityItems,
    currentActivityViewFilter,
    filteredActivityItems,
    allActivitySavedViews,
    savedViewCounts,
    selectedActivitySavedView,
    activityCategoryCounts,
    activityAttentionCounts,
    activityFiltersActive,
    auditActivityVisible,
    activityDrilldown,
    customViewLimitReached,
    applyActivityView,
    saveActivityView,
    renameActivityView,
    deleteActivityView,
    clearActivityFilters,
    resetActivityForChannelSwitch,
  };
}

function serializeCustomActivitySavedViews(views: readonly ChannelActivitySavedView[]): readonly Record<string, unknown>[] {
  return views
    .filter((view) => !view.builtin)
    .slice(0, maxCustomChannelActivitySavedViews)
    .map((view) => ({
      id: view.id,
      name: view.name,
      filter: view.filter,
      builtin: false,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    }));
}
