import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTask, listTeammateTasks } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { titleFromPrompt } from "../../lib/formatting.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  AiTeammate,
  Channel,
  EffectiveTeammateSkill,
  Task,
  TeammateChannelMembership,
  TeammateDirectMessage,
} from "../../types.js";
import {
  buildTeammateTaskRows,
  deriveActiveTeammateTaskChannels,
  emptyTeammateTaskCreateForm,
  filterTeammateTaskRows,
  resolveTeammateTaskChannelId,
  summarizeTeammateTasks,
  type TeammateTaskCreateForm,
  type TeammateTaskFilter,
} from "./teammate-tasks-view-models.js";

export function useTeammateTasksController({
  cwd,
  teammate,
  channels,
  memberships,
  skills,
  onOpenTask,
  onOpenWorkBoard,
  onTaskCreated,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly channels: readonly Channel[];
  readonly memberships: readonly TeammateChannelMembership[];
  readonly skills: readonly EffectiveTeammateSkill[];
  readonly onOpenTask?: (task: Task) => void;
  readonly onOpenWorkBoard?: () => void;
  readonly onTaskCreated?: (task: Task) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammate.id}`;
  const identityRef = useRef(identityKey);
  const requestSequenceRef = useRef(0);
  const busyKeysRef = useRef(new Set<string>());
  const tasksRef = useRef<readonly Task[]>([]);
  const feedbackToastIdRef = useRef("");
  identityRef.current = identityKey;

  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<TeammateTaskFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<TeammateTaskCreateForm>(emptyTeammateTaskCreateForm);
  const [formError, setFormError] = useState("");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [messageErrors, setMessageErrors] = useState<Readonly<Record<string, string>>>({});

  const taskChannels = useMemo(
    () => deriveActiveTeammateTaskChannels(channels, memberships),
    [channels, memberships],
  );
  const rows = useMemo(
    () => buildTeammateTaskRows({ tasks, channels, skills }),
    [channels, skills, tasks],
  );
  const visibleRows = useMemo(
    () => filterTeammateTaskRows(rows, searchQuery, filter),
    [filter, rows, searchQuery],
  );
  const stats = useMemo(() => summarizeTeammateTasks(rows), [rows]);

  const refresh = useCallback(async (mode: "initial" | "refresh" = "refresh"): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const requestIdentity = `${workspaceCwd}::${teammate.id}`;
    const requestId = ++requestSequenceRef.current;
    if (!workspaceCwd) {
      setLoadError(t("Workspace path is required."));
      return;
    }
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setLoadError("");
    try {
      const response = await listTeammateTasks(workspaceCwd, teammate.id, 100);
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      tasksRef.current = response.tasks;
      setTasks(response.tasks);
      setStale(false);
    } catch {
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      setStale(tasksRef.current.length > 0);
      setLoadError(t("Recent tasks could not be loaded. Try again."));
    } finally {
      if (identityRef.current === requestIdentity && requestId === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, t, teammate.id]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    busyKeysRef.current = new Set();
    tasksRef.current = [];
    setTasks([]);
    setLoading(false);
    setRefreshing(false);
    setStale(false);
    setLoadError("");
    setSearchQuery("");
    setFilter("all");
    setCreateOpen(false);
    setForm(emptyTeammateTaskCreateForm);
    setFormError("");
    setBusyKeys(new Set());
    setMessageErrors({});
    if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = "";
    void refresh("initial");
  }, [dismissToast, identityKey, refresh]);

  useEffect(() => {
    setForm((current) => {
      const channelId = resolveTeammateTaskChannelId(current.channelId, taskChannels, memberships);
      return channelId === current.channelId ? current : { ...current, channelId };
    });
  }, [memberships, taskChannels]);

  function updateForm(nextForm: TeammateTaskCreateForm): void {
    setForm(nextForm);
    setFormError("");
  }

  function clearFilters(): void {
    setSearchQuery("");
    setFilter("all");
  }

  function toggleCreate(): void {
    setCreateOpen((current) => !current);
    setFormError("");
  }

  async function createFromForm(): Promise<void> {
    await createAssignedTask({
      key: "form",
      channelId: form.channelId,
      title: form.title,
      prompt: form.prompt,
      requestedSkillId: form.requestedSkillId,
    });
  }

  async function createFromMessage(message: TeammateDirectMessage): Promise<void> {
    await createAssignedTask({
      key: `message:${message.id}`,
      messageId: message.id,
      channelId: form.channelId,
      title: titleFromPrompt(message.body),
      prompt: message.body,
      requestedSkillId: form.requestedSkillId,
    });
  }

  async function createAssignedTask(input: {
    readonly key: string;
    readonly messageId?: string;
    readonly channelId: string;
    readonly title: string;
    readonly prompt: string;
    readonly requestedSkillId: string;
  }): Promise<void> {
    const workspaceCwd = cwd.trim();
    const operationIdentity = identityRef.current;
    const channelId = resolveTeammateTaskChannelId(input.channelId, taskChannels, memberships);
    const prompt = input.prompt.trim();
    if (!workspaceCwd || !prompt || !channelId || busyKeysRef.current.has(input.key)) {
      if (!channelId) setCreateError(input.messageId, t("Join this teammate to an active channel before creating a task."));
      else if (!prompt) setCreateError(input.messageId, t("Enter a task prompt first."));
      return;
    }

    beginBusy(input.key);
    setCreateError(input.messageId, "");
    try {
      const response = await createTask(workspaceCwd, channelId, {
        title: input.title.trim() || titleFromPrompt(prompt),
        prompt,
        assigneeTeammateId: teammate.id,
        requestedSkillId: input.requestedSkillId || undefined,
      });
      if (identityRef.current !== operationIdentity) return;
      requestSequenceRef.current += 1;
      setLoading(false);
      setRefreshing(false);
      setLoadError("");
      const nextTasks = [response.task, ...tasksRef.current.filter((task) => task.id !== response.task.id)];
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      setStale(false);
      if (!input.messageId) {
        setForm((current) => ({ ...current, channelId, title: "", prompt: "" }));
        setCreateOpen(false);
      }
      if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
      feedbackToastIdRef.current = showToast({
        message: t("Task created for {name}", { name: teammate.displayName }),
        scope: `teammate:tasks:${teammate.id}:create:${response.task.id}`,
        tone: "success",
        action: onOpenTask ? {
          altText: t("View task"),
          label: t("View task"),
          onSelect: () => onOpenTask(response.task),
        } : undefined,
      });
      void Promise.resolve(onTaskCreated?.(response.task)).catch(() => undefined);
    } catch {
      if (identityRef.current === operationIdentity) {
        setCreateError(input.messageId, t("Task could not be created. Try again."));
      }
    } finally {
      if (identityRef.current === operationIdentity) finishBusy(input.key);
    }
  }

  function setCreateError(messageId: string | undefined, message: string): void {
    if (!messageId) {
      setFormError(message);
      return;
    }
    setMessageErrors((current) => {
      if (!message && !(messageId in current)) return current;
      const next = { ...current };
      if (message) next[messageId] = message;
      else delete next[messageId];
      return next;
    });
  }

  function beginBusy(key: string): void {
    busyKeysRef.current = new Set([...busyKeysRef.current, key]);
    setBusyKeys(new Set(busyKeysRef.current));
  }

  function finishBusy(key: string): void {
    const next = new Set(busyKeysRef.current);
    next.delete(key);
    busyKeysRef.current = next;
    setBusyKeys(new Set(next));
  }

  return {
    busyKeys,
    createOpen,
    filter,
    form,
    formError,
    loadError,
    loading,
    messageErrors,
    refreshing,
    rows,
    searchQuery,
    stale,
    stats,
    taskChannels,
    visibleRows,
    clearFilters,
    createFromForm,
    createFromMessage,
    onOpenTask,
    onOpenWorkBoard,
    refresh,
    setCreateOpen,
    setFilter,
    setSearchQuery,
    toggleCreate,
    updateForm,
  };
}

export type TeammateTasksController = ReturnType<typeof useTeammateTasksController>;
