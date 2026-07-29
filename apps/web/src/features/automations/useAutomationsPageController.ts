import { useEffect, useMemo, useRef, useState } from "react";
import { listLingThreads } from "../../api.js";
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationSchedulerState,
  BuiltinAutomationTemplate,
  Channel,
  LingThread,
} from "../../types.js";
import {
  buildAutomationDefinitionViewModel,
  buildAutomationDraftViewModel,
  buildAutomationRunViewModel,
  buildAutomationTabs,
  buildSchedulerViewModel,
  definitionsForTab,
  latestRunByAutomationId,
  matchesAutomationSearch,
  summarizeAutomationsPage,
  type AutomationDefinitionViewModel,
  type AutomationDraftViewModel,
  type AutomationRunViewModel,
  type AutomationTab,
  type AutomationTranslate,
} from "./automation-view-models.js";

export type AutomationCreateMode = "chat" | "manual" | "template";

export interface AutomationsPageController {
  readonly activeTab: AutomationTab;
  readonly archiveAutomation?: AutomationDefinition;
  readonly createMode: AutomationCreateMode;
  readonly createOpen: boolean;
  readonly definitionViewModels: readonly AutomationDefinitionViewModel[];
  readonly draftViewModels: readonly AutomationDraftViewModel[];
  readonly discardDraft?: AutomationDraft;
  readonly recentRunViewModels: readonly AutomationRunViewModel[];
  readonly scheduleAutomation?: AutomationDefinition;
  readonly schedulerViewModel: ReturnType<typeof buildSchedulerViewModel>;
  readonly search: string;
  readonly selectedAutomation?: AutomationDefinition;
  readonly selectedDraft?: AutomationDraft;
  readonly selectedLatestRun?: AutomationRun;
  readonly summary: ReturnType<typeof summarizeAutomationsPage>;
  readonly tabs: ReturnType<typeof buildAutomationTabs>;
  readonly threadLoadError: string;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly threads: readonly LingThread[];
  readonly threadsLoading: boolean;
  readonly visibleDefinitions: readonly AutomationDefinitionViewModel[];
  readonly visibleDrafts: readonly AutomationDraftViewModel[];
  readonly visibleRuns: readonly AutomationRunViewModel[];
  readonly closeArchive: () => void;
  readonly closeCreate: () => void;
  readonly closeDiscard: () => void;
  readonly closeSchedule: () => void;
  readonly openArchive: (automationId: string) => void;
  readonly openCreate: (mode?: AutomationCreateMode) => void;
  readonly openDiscard: (draftId: string) => void;
  readonly openSchedule: (automationId: string) => void;
  readonly setActiveTab: (tab: AutomationTab) => void;
  readonly setCreateMode: (mode: AutomationCreateMode) => void;
  readonly setSearch: (value: string) => void;
}

export function useAutomationsPageController(input: {
  readonly automations: readonly AutomationDefinition[];
  readonly automationDrafts: readonly AutomationDraft[];
  readonly automationRuns: readonly AutomationRun[];
  readonly channels: readonly Channel[];
  readonly cwd: string;
  readonly schedulers: readonly AutomationSchedulerState[];
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly t: AutomationTranslate;
}): AutomationsPageController {
  const [activeTab, setActiveTab] = useState<AutomationTab>("enabled");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<AutomationCreateMode>("template");
  const [archiveAutomationId, setArchiveAutomationId] = useState("");
  const [discardDraftId, setDiscardDraftId] = useState("");
  const [scheduleAutomationId, setScheduleAutomationId] = useState("");
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState("");
  const threadRequestSequenceRef = useRef(0);
  const cwdRef = useRef(input.cwd.trim());
  cwdRef.current = input.cwd.trim();

  useEffect(() => {
    const cwd = input.cwd.trim();
    const requestId = ++threadRequestSequenceRef.current;
    if (!cwd) {
      setThreads([]);
      setThreadsLoading(false);
      setThreadLoadError("");
      return undefined;
    }
    setThreadsLoading(true);
    setThreadLoadError("");
    void listLingThreads(cwd, { limit: 100 })
      .then((response) => {
        if (cwdRef.current !== cwd || threadRequestSequenceRef.current !== requestId) return;
        setThreads(response.threads.filter((thread) => thread.status !== "archived" && !thread.archivedAt));
      })
      .catch((caught: unknown) => {
        if (cwdRef.current !== cwd || threadRequestSequenceRef.current !== requestId) return;
        setThreadLoadError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (cwdRef.current === cwd && threadRequestSequenceRef.current === requestId) setThreadsLoading(false);
      });
    return () => {
      threadRequestSequenceRef.current += 1;
    };
  }, [input.cwd]);

  const threadTitleById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.title] as const)),
    [threads],
  );
  const latestRunById = useMemo(() => latestRunByAutomationId(input.automationRuns), [input.automationRuns]);
  const definitionViewModels = useMemo(
    () => input.automations
      .filter((automation) => automation.status !== "archived")
      .map((automation) => buildAutomationDefinitionViewModel({
        automation,
        channels: input.channels,
        latestRun: latestRunById.get(automation.id),
        threadTitleById,
        t: input.t,
      })),
    [input.automations, input.channels, input.t, latestRunById, threadTitleById],
  );
  const draftViewModels = useMemo(
    () => input.automationDrafts
      .filter((draft) => draft.status !== "confirmed" && draft.status !== "discarded")
      .map((draft) => buildAutomationDraftViewModel({ draft, channels: input.channels, threadTitleById, t: input.t })),
    [input.automationDrafts, input.channels, input.t, threadTitleById],
  );
  const recentRuns = useMemo(
    () => [...input.automationRuns].sort((left, right) => right.firedAt.localeCompare(left.firedAt)).slice(0, 100),
    [input.automationRuns],
  );
  const automationById = useMemo(
    () => new Map(input.automations.map((automation) => [automation.id, automation] as const)),
    [input.automations],
  );
  const recentRunViewModels = useMemo(
    () => recentRuns.map((run) => buildAutomationRunViewModel({ run, automationById, t: input.t })),
    [automationById, input.t, recentRuns],
  );
  const summary = useMemo(
    () => summarizeAutomationsPage({ definitions: definitionViewModels, drafts: draftViewModels, recentRuns }),
    [definitionViewModels, draftViewModels, recentRuns],
  );
  const tabs = useMemo(
    () => buildAutomationTabs({ definitions: definitionViewModels, drafts: draftViewModels, recentRuns, t: input.t }),
    [definitionViewModels, draftViewModels, input.t, recentRuns],
  );
  const schedulerViewModel = useMemo(
    () => buildSchedulerViewModel({ scheduler: input.schedulers[0], scheduledCount: summary.scheduledCount, t: input.t }),
    [input.schedulers, input.t, summary.scheduledCount],
  );
  const visibleDefinitions = useMemo(
    () => definitionsForTab(definitionViewModels, activeTab).filter((item) => matchesAutomationSearch(item.searchableText, search)),
    [activeTab, definitionViewModels, search],
  );
  const visibleDrafts = useMemo(
    () => activeTab === "attention"
      ? draftViewModels.filter((item) => matchesAutomationSearch(item.searchableText, search))
      : [],
    [activeTab, draftViewModels, search],
  );
  const visibleRuns = useMemo(
    () => activeTab === "history"
      ? recentRunViewModels.filter((item) => matchesAutomationSearch(`${item.automationTitle} ${item.triggerLabel}`.toLocaleLowerCase(), search))
      : [],
    [activeTab, recentRunViewModels, search],
  );
  const selectedAutomation = input.automations.find((automation) => automation.id === input.selectedAutomationId);
  const selectedDraft = input.automationDrafts.find((draft) => draft.id === input.selectedDraftId);

  return {
    activeTab,
    archiveAutomation: input.automations.find((automation) => automation.id === archiveAutomationId),
    createMode,
    createOpen,
    definitionViewModels,
    draftViewModels,
    discardDraft: input.automationDrafts.find((draft) => draft.id === discardDraftId),
    recentRunViewModels,
    scheduleAutomation: input.automations.find((automation) => automation.id === scheduleAutomationId),
    schedulerViewModel,
    search,
    selectedAutomation,
    selectedDraft,
    selectedLatestRun: selectedAutomation ? latestRunById.get(selectedAutomation.id) : undefined,
    summary,
    tabs,
    threadLoadError,
    threadTitleById,
    threads,
    threadsLoading,
    visibleDefinitions,
    visibleDrafts,
    visibleRuns,
    closeArchive: () => setArchiveAutomationId(""),
    closeCreate: () => setCreateOpen(false),
    closeDiscard: () => setDiscardDraftId(""),
    closeSchedule: () => setScheduleAutomationId(""),
    openArchive: setArchiveAutomationId,
    openCreate: (mode = "template") => {
      setCreateMode(mode);
      setCreateOpen(true);
    },
    openDiscard: setDiscardDraftId,
    openSchedule: setScheduleAutomationId,
    setActiveTab,
    setCreateMode,
    setSearch,
  };
}
