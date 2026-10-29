import { useEffect, useRef, useState } from "react";
import {
  archiveAutomation,
  confirmAutomationDraft,
  createAutomation,
  createAutomationDraft,
  discardAutomationDraft,
  listAutomationDrafts,
  listAutomationRuns,
  listAutomations,
  listAutomationSchedulers,
  previewAutomation,
  previewAutomationDraft,
  runAutomation,
  startAutomationScheduler,
  stopAutomationScheduler,
  updateAutomationDraft,
  updateAutomation,
} from "../../api.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationSchedulerState,
  AutomationStatus,
  AutomationTarget,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  BuiltinAutomationTemplateId,
  Channel,
  CreateAutomationRequest,
} from "../../types.js";

export type AutomationMutationKind = "archive" | "preview" | "run" | "schedule" | "status" | "target";
export type AutomationDraftMutationKind = "confirm" | "discard" | "preview" | "update";
export type AutomationCreateKind = "chat-draft" | "definition" | "manual-draft" | "template-draft" | "";

export interface AutomationsState {
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly automationDrafts: readonly AutomationDraft[];
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly previewByAutomationId: Readonly<Record<string, AutomationContextPreview>>;
  readonly draftPreviewById: Readonly<Record<string, AutomationContextPreview>>;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly loadedOnce: boolean;
  readonly createAction: AutomationCreateKind;
  readonly schedulerAction: "start" | "stop" | "";
  readonly automationActionById: Readonly<Record<string, AutomationMutationKind | undefined>>;
  readonly draftActionById: Readonly<Record<string, AutomationDraftMutationKind | undefined>>;
  readonly refreshError: string;
  readonly createError: string;
  readonly schedulerError: string;
  readonly automationErrorById: Readonly<Record<string, string | undefined>>;
  readonly draftErrorById: Readonly<Record<string, string | undefined>>;
  readonly schedulers: readonly AutomationSchedulerState[];
}

export interface AutomationsActions {
  readonly setSelectedAutomationId: (automationId: string) => void;
  readonly setSelectedDraftId: (draftId: string) => void;
  readonly refreshAutomations: (cwd?: string) => Promise<boolean>;
  readonly createFromTemplate: (templateId: BuiltinAutomationTemplateId) => Promise<AutomationDraft | undefined>;
  readonly createManualDraft: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<AutomationDraft | undefined>;
  readonly createAutomationDefinition: (automation: CreateAutomationRequest) => Promise<AutomationDefinition | undefined>;
  readonly createChatDraft: (prompt: string) => Promise<AutomationDraft | undefined>;
  readonly updateDraft: (draftId: string, partialAutomation: Partial<CreateAutomationRequest>) => Promise<AutomationDraft | undefined>;
  readonly previewDraft: (draftId: string) => Promise<AutomationContextPreview | undefined>;
  readonly confirmDraft: (draftId: string) => Promise<AutomationDefinition | undefined>;
  readonly discardDraft: (draftId: string) => Promise<boolean>;
  readonly previewAutomationById: (automationId: string) => Promise<AutomationContextPreview | undefined>;
  readonly runAutomationById: (automationId: string) => Promise<AutomationRun | undefined>;
  readonly archiveAutomationById: (automationId: string) => Promise<boolean>;
  readonly setAutomationStatusById: (automationId: string, status: AutomationStatus) => Promise<AutomationDefinition | undefined>;
  readonly setAutomationScheduleById: (automationId: string, trigger: AutomationTrigger, rrule?: string) => Promise<AutomationDefinition | undefined>;
  readonly setAutomationTargetById: (automationId: string, target: AutomationTarget) => Promise<AutomationDefinition | undefined>;
  readonly startScheduler: () => Promise<boolean>;
  readonly stopScheduler: () => Promise<boolean>;
  readonly resetForCwd: () => void;
}

export interface AutomationsController {
  readonly state: AutomationsState;
  readonly actions: AutomationsActions;
}

export function useAutomationsDomain(input: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly translate: (value: string) => string;
}): AutomationsController {
  const [automations, setAutomations] = useState<readonly AutomationDefinition[]>([]);
  const [automationRuns, setAutomationRuns] = useState<readonly AutomationRun[]>([]);
  const [automationDrafts, setAutomationDrafts] = useState<readonly AutomationDraft[]>([]);
  const [templates, setTemplates] = useState<readonly BuiltinAutomationTemplate[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [previewByAutomationId, setPreviewByAutomationId] = useState<Record<string, AutomationContextPreview>>({});
  const [draftPreviewById, setDraftPreviewById] = useState<Record<string, AutomationContextPreview>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [createAction, setCreateAction] = useState<AutomationCreateKind>("");
  const [schedulerAction, setSchedulerAction] = useState<"start" | "stop" | "">("");
  const [automationActionById, setAutomationActionById] = useState<Record<string, AutomationMutationKind | undefined>>({});
  const [draftActionById, setDraftActionById] = useState<Record<string, AutomationDraftMutationKind | undefined>>({});
  const [refreshError, setRefreshError] = useState("");
  const [createError, setCreateError] = useState("");
  const [schedulerError, setSchedulerError] = useState("");
  const [automationErrorById, setAutomationErrorById] = useState<Record<string, string | undefined>>({});
  const [draftErrorById, setDraftErrorById] = useState<Record<string, string | undefined>>({});
  const [schedulers, setSchedulers] = useState<readonly AutomationSchedulerState[]>([]);
  const cwdRef = useRef(input.cwd.trim());
  const dataRequestSequenceRef = useRef(0);
  const automationBusyRef = useRef(new Set<string>());
  const draftBusyRef = useRef(new Set<string>());
  const createBusyRef = useRef(false);
  const schedulerBusyRef = useRef(false);

  cwdRef.current = input.cwd.trim();

  useEffect(() => {
    // Opening the automation workspace starts with the list only. Keep the
    // inspector closed until the user explicitly selects an automation.
    if (!selectedAutomationId || automations.some((automation) => automation.id === selectedAutomationId)) return;
    setSelectedAutomationId("");
  }, [automations, selectedAutomationId]);

  useEffect(() => {
    if (selectedDraftId && automationDrafts.some((draft) => draft.id === selectedDraftId)) return;
    setSelectedDraftId("");
  }, [automationDrafts, selectedDraftId]);

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (!cwd || automations.length === 0) return undefined;
    const interval = window.setInterval(() => void refreshRuntimeState(cwd), 15_000);
    return () => window.clearInterval(interval);
  }, [input.cwd, automations.length]);

  async function refreshAutomations(cwd = input.cwd.trim()): Promise<boolean> {
    const normalizedCwd = cwd.trim();
    const requestId = ++dataRequestSequenceRef.current;
    if (!normalizedCwd) {
      clearWorkspaceData();
      return false;
    }
    setRefreshing(true);
    setRefreshError("");
    try {
      const [definitionsResponse, draftsResponse, runsResponse, schedulersResponse] = await Promise.all([
        listAutomations(normalizedCwd),
        listAutomationDrafts(normalizedCwd, { limit: 100 }),
        listAutomationRuns(normalizedCwd, { limit: 100 }),
        listAutomationSchedulers(normalizedCwd),
      ]);
      if (!isCurrentDataRequest(normalizedCwd, requestId)) return false;
      setAutomations(definitionsResponse.automations);
      setTemplates(draftsResponse.templates?.length ? draftsResponse.templates : definitionsResponse.templates);
      setAutomationDrafts(draftsResponse.drafts);
      setAutomationRuns(runsResponse.automationRuns);
      setSchedulers(schedulersResponse.schedulers);
      setLoadedOnce(true);
      return true;
    } catch (caught) {
      if (isCurrentDataRequest(normalizedCwd, requestId)) setRefreshError(errorMessage(caught));
      return false;
    } finally {
      if (isCurrentDataRequest(normalizedCwd, requestId)) setRefreshing(false);
    }
  }

  async function refreshRuntimeState(cwd: string): Promise<void> {
    const requestId = ++dataRequestSequenceRef.current;
    try {
      const [definitionsResponse, runsResponse, schedulersResponse] = await Promise.all([
        listAutomations(cwd),
        listAutomationRuns(cwd, { limit: 100 }),
        listAutomationSchedulers(cwd),
      ]);
      if (!isCurrentDataRequest(cwd, requestId)) return;
      setAutomations(definitionsResponse.automations);
      setTemplates(definitionsResponse.templates);
      setAutomationRuns(runsResponse.automationRuns);
      setSchedulers(schedulersResponse.schedulers);
    } catch (caught) {
      if (isCurrentDataRequest(cwd, requestId)) setRefreshError(errorMessage(caught));
    }
  }

  async function createFromTemplate(templateId: BuiltinAutomationTemplateId): Promise<AutomationDraft | undefined> {
    const channelId = input.selectedChannelId || input.channels.find((channel) => channel.status === "active")?.id;
    return runCreateMutation("template-draft", async (cwd) => {
      if (!channelId) throw new Error(input.translate("Select project"));
      const response = await createAutomationDraft(cwd, { source: "template", templateId, partialAutomation: { channelId } });
      setSelectedDraftId(response.draft.id);
      upsertDraft(response.draft);
      return response.draft;
    });
  }

  async function createManualDraft(partialAutomation: Partial<CreateAutomationRequest>): Promise<AutomationDraft | undefined> {
    return runCreateMutation("manual-draft", async (cwd) => {
      const response = await createAutomationDraft(cwd, { source: "manual", partialAutomation });
      setSelectedDraftId(response.draft.id);
      upsertDraft(response.draft);
      return response.draft;
    });
  }

  async function createAutomationDefinition(request: CreateAutomationRequest): Promise<AutomationDefinition | undefined> {
    return runCreateMutation("definition", async (cwd) => {
      const response = await createAutomation(cwd, request);
      setSelectedAutomationId(response.automation.id);
      setSelectedDraftId("");
      upsertAutomation(response.automation);
      return response.automation;
    });
  }

  async function createChatDraft(prompt: string): Promise<AutomationDraft | undefined> {
    const channelId = input.selectedChannelId || input.channels.find((channel) => channel.status === "active")?.id;
    return runCreateMutation("chat-draft", async (cwd) => {
      const response = await createAutomationDraft(cwd, {
        source: "chat",
        prompt,
        partialAutomation: channelId ? { channelId } : undefined,
      });
      setSelectedDraftId(response.draft.id);
      upsertDraft(response.draft);
      return response.draft;
    });
  }

  async function updateDraft(draftId: string, partialAutomation: Partial<CreateAutomationRequest>): Promise<AutomationDraft | undefined> {
    return runDraftMutation(draftId, "update", async (cwd) => {
      const response = await updateAutomationDraft(cwd, draftId, { partialAutomation });
      upsertDraft(response.draft);
      return response.draft;
    });
  }

  async function previewDraft(draftId: string): Promise<AutomationContextPreview | undefined> {
    return runDraftMutation(draftId, "preview", async (cwd) => {
      const response = await previewAutomationDraft(cwd, draftId);
      setDraftPreviewById((current) => ({ ...current, [draftId]: response.context }));
      return response.context;
    });
  }

  async function confirmDraft(draftId: string): Promise<AutomationDefinition | undefined> {
    return runDraftMutation(draftId, "confirm", async (cwd) => {
      const response = await confirmAutomationDraft(cwd, draftId);
      setSelectedAutomationId(response.automation.id);
      setSelectedDraftId("");
      setAutomationDrafts((current) => current.filter((draft) => draft.id !== draftId));
      upsertAutomation(response.automation);
      return response.automation;
    });
  }

  async function discardDraft(draftId: string): Promise<boolean> {
    const result = await runDraftMutation(draftId, "discard", async (cwd) => {
      await discardAutomationDraft(cwd, draftId);
      setAutomationDrafts((current) => current.filter((draft) => draft.id !== draftId));
      if (selectedDraftId === draftId) setSelectedDraftId("");
      return true;
    });
    return result ?? false;
  }

  async function previewAutomationById(automationId: string): Promise<AutomationContextPreview | undefined> {
    return runAutomationMutation(automationId, "preview", async (cwd) => {
      const response = await previewAutomation(cwd, automationId);
      setPreviewByAutomationId((current) => ({ ...current, [automationId]: response.context }));
      return response.context;
    });
  }

  async function runAutomationById(automationId: string): Promise<AutomationRun | undefined> {
    return runAutomationMutation(automationId, "run", async (cwd) => {
      const response = await runAutomation(cwd, automationId);
      setAutomationRuns((current) => [response.automationRun, ...current.filter((run) => run.id !== response.automationRun.id)]);
      if (response.automation) upsertAutomation(response.automation);
      if (response.context) setPreviewByAutomationId((current) => ({ ...current, [automationId]: response.context as AutomationContextPreview }));
      return response.automationRun;
    });
  }

  async function archiveAutomationById(automationId: string): Promise<boolean> {
    const result = await runAutomationMutation(automationId, "archive", async (cwd) => {
      await archiveAutomation(cwd, automationId);
      setAutomations((current) => current.filter((automation) => automation.id !== automationId));
      if (selectedAutomationId === automationId) setSelectedAutomationId("");
      return true;
    });
    return result ?? false;
  }

  async function setAutomationStatusById(automationId: string, status: AutomationStatus): Promise<AutomationDefinition | undefined> {
    return updateDefinition(automationId, "status", { status });
  }

  async function setAutomationScheduleById(automationId: string, trigger: AutomationTrigger, rrule?: string): Promise<AutomationDefinition | undefined> {
    return updateDefinition(automationId, "schedule", { trigger, rrule: rrule ?? null });
  }

  async function setAutomationTargetById(automationId: string, target: AutomationTarget): Promise<AutomationDefinition | undefined> {
    return updateDefinition(automationId, "target", {
      target,
      targetThreadId: target.scope === "thread" ? target.threadId ?? null : null,
    });
  }

  async function startScheduler(): Promise<boolean> {
    return runSchedulerMutation("start", async (cwd) => {
      const response = await startAutomationScheduler(cwd);
      setSchedulers([response.scheduler]);
    });
  }

  async function stopScheduler(): Promise<boolean> {
    return runSchedulerMutation("stop", async (cwd) => {
      const response = await stopAutomationScheduler(cwd);
      setSchedulers([response.scheduler]);
    });
  }

  async function updateDefinition(
    automationId: string,
    kind: Extract<AutomationMutationKind, "schedule" | "status" | "target">,
    patch: Parameters<typeof updateAutomation>[2],
  ): Promise<AutomationDefinition | undefined> {
    return runAutomationMutation(automationId, kind, async (cwd) => {
      const response = await updateAutomation(cwd, automationId, patch);
      upsertAutomation(response.automation);
      return response.automation;
    });
  }

  async function runCreateMutation<T>(kind: Exclude<AutomationCreateKind, "">, mutation: (cwd: string) => Promise<T>): Promise<T | undefined> {
    const cwd = cwdRef.current;
    if (!cwd || createBusyRef.current) return undefined;
    createBusyRef.current = true;
    setCreateAction(kind);
    setCreateError("");
    try {
      const result = await mutation(cwd);
      return cwdRef.current === cwd ? result : undefined;
    } catch (caught) {
      if (cwdRef.current === cwd) setCreateError(errorMessage(caught));
      return undefined;
    } finally {
      createBusyRef.current = false;
      if (cwdRef.current === cwd) setCreateAction("");
    }
  }

  async function runAutomationMutation<T>(
    automationId: string,
    kind: AutomationMutationKind,
    mutation: (cwd: string) => Promise<T>,
  ): Promise<T | undefined> {
    const cwd = cwdRef.current;
    if (!cwd || !automationId || automationBusyRef.current.has(automationId)) return undefined;
    automationBusyRef.current.add(automationId);
    setAutomationActionById((current) => ({ ...current, [automationId]: kind }));
    setAutomationErrorById((current) => ({ ...current, [automationId]: undefined }));
    try {
      const result = await mutation(cwd);
      return cwdRef.current === cwd ? result : undefined;
    } catch (caught) {
      if (cwdRef.current === cwd) setAutomationErrorById((current) => ({ ...current, [automationId]: errorMessage(caught) }));
      return undefined;
    } finally {
      automationBusyRef.current.delete(automationId);
      if (cwdRef.current === cwd) setAutomationActionById((current) => ({ ...current, [automationId]: undefined }));
    }
  }

  async function runDraftMutation<T>(
    draftId: string,
    kind: AutomationDraftMutationKind,
    mutation: (cwd: string) => Promise<T>,
  ): Promise<T | undefined> {
    const cwd = cwdRef.current;
    if (!cwd || !draftId || draftBusyRef.current.has(draftId)) return undefined;
    draftBusyRef.current.add(draftId);
    setDraftActionById((current) => ({ ...current, [draftId]: kind }));
    setDraftErrorById((current) => ({ ...current, [draftId]: undefined }));
    try {
      const result = await mutation(cwd);
      return cwdRef.current === cwd ? result : undefined;
    } catch (caught) {
      if (cwdRef.current === cwd) setDraftErrorById((current) => ({ ...current, [draftId]: errorMessage(caught) }));
      return undefined;
    } finally {
      draftBusyRef.current.delete(draftId);
      if (cwdRef.current === cwd) setDraftActionById((current) => ({ ...current, [draftId]: undefined }));
    }
  }

  async function runSchedulerMutation(kind: "start" | "stop", mutation: (cwd: string) => Promise<void>): Promise<boolean> {
    const cwd = cwdRef.current;
    if (!cwd || schedulerBusyRef.current) return false;
    schedulerBusyRef.current = true;
    setSchedulerAction(kind);
    setSchedulerError("");
    try {
      await mutation(cwd);
      return cwdRef.current === cwd;
    } catch (caught) {
      if (cwdRef.current === cwd) setSchedulerError(errorMessage(caught));
      return false;
    } finally {
      schedulerBusyRef.current = false;
      if (cwdRef.current === cwd) setSchedulerAction("");
    }
  }

  function isCurrentDataRequest(cwd: string, requestId: number): boolean {
    return cwdRef.current === cwd && dataRequestSequenceRef.current === requestId;
  }

  function upsertAutomation(automation: AutomationDefinition): void {
    if (cwdRef.current !== input.cwd.trim()) return;
    setAutomations((current) => [automation, ...current.filter((item) => item.id !== automation.id)]);
  }

  function upsertDraft(draft: AutomationDraft): void {
    if (cwdRef.current !== input.cwd.trim()) return;
    setAutomationDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
  }

  function clearWorkspaceData(): void {
    setAutomations([]);
    setAutomationRuns([]);
    setAutomationDrafts([]);
    setTemplates([]);
    setSchedulers([]);
    setSelectedAutomationId("");
    setSelectedDraftId("");
    setPreviewByAutomationId({});
    setDraftPreviewById({});
    setLoadedOnce(false);
    setRefreshing(false);
  }

  function resetForCwd(): void {
    dataRequestSequenceRef.current += 1;
    automationBusyRef.current.clear();
    draftBusyRef.current.clear();
    createBusyRef.current = false;
    schedulerBusyRef.current = false;
    clearWorkspaceData();
    setCreateAction("");
    setSchedulerAction("");
    setAutomationActionById({});
    setDraftActionById({});
    setRefreshError("");
    setCreateError("");
    setSchedulerError("");
    setAutomationErrorById({});
    setDraftErrorById({});
  }

  return {
    state: {
      automations,
      automationRuns,
      automationDrafts,
      templates,
      selectedAutomationId,
      selectedDraftId,
      previewByAutomationId,
      draftPreviewById,
      loading: refreshing && !loadedOnce,
      refreshing,
      loadedOnce,
      createAction,
      schedulerAction,
      automationActionById,
      draftActionById,
      refreshError,
      createError,
      schedulerError,
      automationErrorById,
      draftErrorById,
      schedulers,
    },
    actions: {
      setSelectedAutomationId,
      setSelectedDraftId,
      refreshAutomations,
      createFromTemplate,
      createManualDraft,
      createAutomationDefinition,
      createChatDraft,
      updateDraft,
      previewDraft,
      confirmDraft,
      discardDraft,
      previewAutomationById,
      runAutomationById,
      archiveAutomationById,
      setAutomationStatusById,
      setAutomationScheduleById,
      setAutomationTargetById,
      startScheduler,
      stopScheduler,
      resetForCwd,
    },
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
