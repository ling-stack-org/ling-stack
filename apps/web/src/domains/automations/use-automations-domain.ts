import { useEffect, useState } from "react";
import {
  archiveAutomation,
  confirmAutomationDraft,
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
  AutomationTrigger,
  BuiltinAutomationTemplate,
  BuiltinAutomationTemplateId,
  Channel,
  CreateAutomationRequest,
} from "../../types.js";

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
  readonly mutatingAutomationId: string;
  readonly mutatingDraftId: string;
  readonly schedulers: readonly AutomationSchedulerState[];
  readonly schedulerAction: "start" | "stop" | "";
}

export interface AutomationsActions {
  readonly setSelectedAutomationId: (automationId: string) => void;
  readonly setSelectedDraftId: (draftId: string) => void;
  readonly refreshAutomations: (cwd?: string) => Promise<void>;
  readonly createFromTemplate: (templateId: BuiltinAutomationTemplateId) => Promise<void>;
  readonly createManualDraft: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly createChatDraft: (prompt: string) => Promise<void>;
  readonly updateDraft: (draftId: string, partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly previewDraft: (draftId: string) => Promise<void>;
  readonly confirmDraft: (draftId: string) => Promise<void>;
  readonly discardDraft: (draftId: string) => Promise<void>;
  readonly previewSelectedAutomation: () => Promise<void>;
  readonly runSelectedAutomation: () => Promise<void>;
  readonly archiveSelectedAutomation: () => Promise<void>;
  readonly setSelectedSchedule: (trigger: AutomationTrigger) => Promise<void>;
  readonly refreshSchedulers: (cwd?: string) => Promise<void>;
  readonly startScheduler: () => Promise<void>;
  readonly stopScheduler: () => Promise<void>;
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
  readonly setErrorMessage: (message: string) => void;
}): AutomationsController {
  const [automations, setAutomations] = useState<readonly AutomationDefinition[]>([]);
  const [automationRuns, setAutomationRuns] = useState<readonly AutomationRun[]>([]);
  const [automationDrafts, setAutomationDrafts] = useState<readonly AutomationDraft[]>([]);
  const [templates, setTemplates] = useState<readonly BuiltinAutomationTemplate[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [previewByAutomationId, setPreviewByAutomationId] = useState<Record<string, AutomationContextPreview>>({});
  const [draftPreviewById, setDraftPreviewById] = useState<Record<string, AutomationContextPreview>>({});
  const [loading, setLoading] = useState(false);
  const [mutatingAutomationId, setMutatingAutomationId] = useState("");
  const [mutatingDraftId, setMutatingDraftId] = useState("");
  const [schedulers, setSchedulers] = useState<readonly AutomationSchedulerState[]>([]);
  const [schedulerAction, setSchedulerAction] = useState<"start" | "stop" | "">("");

  useEffect(() => {
    if (selectedAutomationId && automations.some((automation) => automation.id === selectedAutomationId)) {
      return;
    }
    setSelectedAutomationId(automations[0]?.id ?? "");
  }, [automations, selectedAutomationId]);

  useEffect(() => {
    if (selectedDraftId && automationDrafts.some((draft) => draft.id === selectedDraftId)) {
      return;
    }
    setSelectedDraftId(automationDrafts[0]?.id ?? "");
  }, [automationDrafts, selectedDraftId]);

  async function refreshAutomations(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setAutomations([]);
      setAutomationRuns([]);
      setAutomationDrafts([]);
      setTemplates([]);
      return;
    }
    setLoading(true);
    try {
      input.setErrorMessage("");
      const response = await listAutomations(cwd);
      setAutomations(response.automations);
      setTemplates(response.templates);
      const draftsResponse = await listAutomationDrafts(cwd, { limit: 100 });
      setAutomationDrafts(draftsResponse.drafts);
      if (draftsResponse.templates?.length) {
        setTemplates(draftsResponse.templates);
      }
      const runsResponse = await listAutomationRuns(cwd, { limit: 100 });
      setAutomationRuns(runsResponse.automationRuns);
      await refreshSchedulers(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function refreshSchedulers(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setSchedulers([]);
      return;
    }
    try {
      const response = await listAutomationSchedulers(cwd);
      setSchedulers(response.schedulers);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function createFromTemplate(templateId: BuiltinAutomationTemplateId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    const channelId = input.selectedChannelId || input.channels[0]?.id;
    if (!channelId) {
      input.setErrorMessage("请先创建或选择一个频道");
      return;
    }
    setLoading(true);
    try {
      input.setErrorMessage("");
      const response = await createAutomationDraft(cwd, {
        source: "template",
        templateId,
        partialAutomation: { channelId },
      });
      setSelectedDraftId(response.draft.id);
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function createManualDraft(partialAutomation: Partial<CreateAutomationRequest>): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    setLoading(true);
    try {
      input.setErrorMessage("");
      const response = await createAutomationDraft(cwd, {
        source: "manual",
        partialAutomation,
      });
      setSelectedDraftId(response.draft.id);
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function createChatDraft(prompt: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    const channelId = input.selectedChannelId || input.channels[0]?.id;
    setLoading(true);
    try {
      input.setErrorMessage("");
      const response = await createAutomationDraft(cwd, {
        source: "chat",
        prompt,
        partialAutomation: channelId ? { channelId } : undefined,
      });
      setSelectedDraftId(response.draft.id);
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function updateDraft(draftId: string, partialAutomation: Partial<CreateAutomationRequest>): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !draftId) {
      return;
    }
    setMutatingDraftId(draftId);
    try {
      input.setErrorMessage("");
      const response = await updateAutomationDraft(cwd, draftId, { partialAutomation });
      setAutomationDrafts((current) => current.map((draft) => draft.id === response.draft.id ? response.draft : draft));
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingDraftId("");
    }
  }

  async function previewDraft(draftId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !draftId) {
      return;
    }
    setMutatingDraftId(draftId);
    try {
      input.setErrorMessage("");
      const response = await previewAutomationDraft(cwd, draftId);
      setDraftPreviewById((current) => ({ ...current, [draftId]: response.context }));
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingDraftId("");
    }
  }

  async function confirmDraft(draftId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !draftId) {
      return;
    }
    setMutatingDraftId(draftId);
    try {
      input.setErrorMessage("");
      const response = await confirmAutomationDraft(cwd, draftId);
      setSelectedAutomationId(response.automation.id);
      setSelectedDraftId("");
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingDraftId("");
    }
  }

  async function discardDraft(draftId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !draftId) {
      return;
    }
    setMutatingDraftId(draftId);
    try {
      input.setErrorMessage("");
      await discardAutomationDraft(cwd, draftId);
      setAutomationDrafts((current) => current.filter((draft) => draft.id !== draftId));
      setSelectedDraftId("");
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingDraftId("");
    }
  }

  async function previewSelectedAutomation(): Promise<void> {
    const automationId = selectedAutomationId;
    const cwd = input.cwd.trim();
    if (!cwd || !automationId) {
      return;
    }
    setMutatingAutomationId(automationId);
    try {
      input.setErrorMessage("");
      const response = await previewAutomation(cwd, automationId);
      setPreviewByAutomationId((current) => ({ ...current, [automationId]: response.context }));
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingAutomationId("");
    }
  }

  async function runSelectedAutomation(): Promise<void> {
    const automationId = selectedAutomationId;
    const cwd = input.cwd.trim();
    if (!cwd || !automationId) {
      return;
    }
    setMutatingAutomationId(automationId);
    try {
      input.setErrorMessage("");
      const response = await runAutomation(cwd, automationId);
      setAutomationRuns((current) => [response.automationRun, ...current.filter((run) => run.id !== response.automationRun.id)]);
      if (response.automation) {
        setAutomations((current) => current.map((automation) => automation.id === response.automation?.id ? response.automation : automation));
      }
      if (response.context) {
        setPreviewByAutomationId((current) => ({ ...current, [automationId]: response.context as AutomationContextPreview }));
      }
      void refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingAutomationId("");
    }
  }

  async function archiveSelectedAutomation(): Promise<void> {
    const automationId = selectedAutomationId;
    const cwd = input.cwd.trim();
    if (!cwd || !automationId) {
      return;
    }
    setMutatingAutomationId(automationId);
    try {
      input.setErrorMessage("");
      await archiveAutomation(cwd, automationId);
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingAutomationId("");
    }
  }

  async function setSelectedSchedule(trigger: AutomationTrigger): Promise<void> {
    const automationId = selectedAutomationId;
    const cwd = input.cwd.trim();
    if (!cwd || !automationId) {
      return;
    }
    setMutatingAutomationId(automationId);
    try {
      input.setErrorMessage("");
      const response = await updateAutomation(cwd, automationId, { trigger });
      setAutomations((current) => current.map((automation) => automation.id === response.automation.id ? response.automation : automation));
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutatingAutomationId("");
    }
  }

  async function startScheduler(): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    setSchedulerAction("start");
    try {
      input.setErrorMessage("");
      const response = await startAutomationScheduler(cwd);
      setSchedulers([response.scheduler]);
      await refreshAutomations(cwd);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSchedulerAction("");
    }
  }

  async function stopScheduler(): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      return;
    }
    setSchedulerAction("stop");
    try {
      input.setErrorMessage("");
      const response = await stopAutomationScheduler(cwd);
      setSchedulers([response.scheduler]);
    } catch (caught) {
      input.setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSchedulerAction("");
    }
  }

  function resetForCwd(): void {
    setAutomations([]);
    setAutomationRuns([]);
    setAutomationDrafts([]);
    setTemplates([]);
    setSelectedAutomationId("");
    setSelectedDraftId("");
    setPreviewByAutomationId({});
    setDraftPreviewById({});
    setLoading(false);
    setMutatingAutomationId("");
    setMutatingDraftId("");
    setSchedulers([]);
    setSchedulerAction("");
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
      loading,
      mutatingAutomationId,
      mutatingDraftId,
      schedulers,
      schedulerAction,
    },
    actions: {
      setSelectedAutomationId,
      setSelectedDraftId,
      refreshAutomations,
      createFromTemplate,
      createManualDraft,
      createChatDraft,
      updateDraft,
      previewDraft,
      confirmDraft,
      discardDraft,
      previewSelectedAutomation,
      runSelectedAutomation,
      archiveSelectedAutomation,
      setSelectedSchedule,
      refreshSchedulers,
      startScheduler,
      stopScheduler,
      resetForCwd,
    },
  };
}
