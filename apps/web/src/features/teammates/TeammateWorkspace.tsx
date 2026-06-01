import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Brain,
  CheckCircle2,
  Hash,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { SkillPack } from "@ling-stack/core/skill-types";
import {
  createTask,
  createTeammateDirectMessage,
  listTeammateActivity,
  listTeammateChannels,
  listTeammateDirectMessages,
  listTeammateMemoryScopes,
  listTeammateSkills,
  listTeammateTasks,
  replaceTeammateChannels,
  replaceTeammateSkills,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime, titleFromPrompt } from "../../lib/formatting.js";
import { providerPreflightReady } from "../../lib/providers.js";
import { AvatarInitial, MetaRow, StatusBadge } from "../../shared/components/index.js";
import type {
  AiTeammate,
  Channel,
  ProviderPreset,
  Task,
  TeammateActivityItem,
  TeammateChannelMembership,
  TeammateDirectMessage,
  TeammateDirectThread,
  TeammateMemoryScope,
  TeammateSkillBinding,
  UpdateAiTeammateRequest,
} from "../../types.js";
import { approvalProfileText, teammateInitialFromName, workflowPhaseLabel } from "./helpers.js";

type TeammateWorkspaceTab = "chat" | "tasks" | "activity" | "channels" | "skills" | "memory" | "settings";

interface TeammateSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
}

interface TeammateTaskCreateForm {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
}

type MaybePromise<T> = T | Promise<T>;

export function TeammateWorkspace({
  cwd,
  teammate,
  providers,
  channels,
  skillPack,
  onUpdateTeammate,
  onDisableTeammate,
  onOpenProviders,
  onRefreshChannels,
  onRefreshTasks,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly skillPack: SkillPack | undefined;
  readonly onUpdateTeammate: (teammateId: string, input: UpdateAiTeammateRequest) => Promise<void>;
  readonly onDisableTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenProviders: () => void;
  readonly onRefreshChannels?: () => MaybePromise<void>;
  readonly onRefreshTasks?: (channelId: string) => MaybePromise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TeammateWorkspaceTab>("chat");
  const [thread, setThread] = useState<TeammateDirectThread | undefined>();
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [memberships, setMemberships] = useState<readonly TeammateChannelMembership[]>([]);
  const [skillBindings, setSkillBindings] = useState<readonly TeammateSkillBinding[]>([]);
  const [memoryScopes, setMemoryScopes] = useState<readonly TeammateMemoryScope[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [activityItems, setActivityItems] = useState<readonly TeammateActivityItem[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [manualSkillInput, setManualSkillInput] = useState("");
  const [taskForm, setTaskForm] = useState<TeammateTaskCreateForm>({ channelId: "", title: "", prompt: "" });
  const [settingsForm, setSettingsForm] = useState<TeammateSettingsForm>(() => teammateToSettingsForm(teammate));
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [savingChannels, setSavingChannels] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [taskMessage, setTaskMessage] = useState("");
  const [channelMessage, setChannelMessage] = useState("");
  const [skillMessage, setSkillMessage] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
  const skillById = useMemo(() => new Map((skillPack?.skills ?? []).map((skill) => [skill.id, skill])), [skillPack]);
  const bindingBySkillId = useMemo(() => new Map(skillBindings.map((binding) => [binding.skillId, binding])), [skillBindings]);
  const enabledSkillCount = useMemo(() => skillBindings.filter((binding) => binding.enabled).length, [skillBindings]);
  const skillRows = useMemo(() => {
    const builtInRows = (skillPack?.skills ?? []).map((skill) => ({
      id: skill.id,
      skill,
      binding: bindingBySkillId.get(skill.id),
    }));
    const unknownRows = skillBindings
      .filter((binding) => !skillById.has(binding.skillId))
      .map((binding) => ({
        id: binding.skillId,
        skill: undefined,
        binding,
      }));
    return [...builtInRows, ...unknownRows];
  }, [bindingBySkillId, skillBindings, skillById, skillPack]);
  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const membershipByChannelId = useMemo(() => new Map(memberships.map((membership) => [membership.channelId, membership])), [memberships]);
  const taskChannelOptions = useMemo(() => {
    const seen = new Set<string>();
    const ordered: Channel[] = [];
    for (const membership of memberships) {
      const channel = channelsById.get(membership.channelId);
      if (channel && !seen.has(channel.id)) {
        ordered.push(channel);
        seen.add(channel.id);
      }
    }
    for (const channel of channels) {
      if (!seen.has(channel.id)) {
        ordered.push(channel);
        seen.add(channel.id);
      }
    }
    return ordered;
  }, [channels, channelsById, memberships]);
  const tabs: readonly { readonly id: TeammateWorkspaceTab; readonly label: string; readonly count?: number }[] = [
    { id: "chat", label: t("Private chat"), count: messages.length },
    { id: "tasks", label: t("Tasks"), count: tasks.length },
    { id: "activity", label: t("Activity"), count: activityItems.length },
    { id: "channels", label: t("Channels"), count: memberships.length },
    { id: "skills", label: t("Skills"), count: enabledSkillCount },
    { id: "memory", label: t("Memory"), count: memoryScopes.length },
    { id: "settings", label: t("Settings") },
  ];

  useEffect(() => {
    setSettingsForm(teammateToSettingsForm(teammate));
  }, [teammate]);

  useEffect(() => {
    setSaveMessage("");
    setTaskMessage("");
    setChannelMessage("");
    setSkillMessage("");
    setManualSkillInput("");
    setTaskForm({ channelId: "", title: "", prompt: "" });
  }, [teammate.id]);

  useEffect(() => {
    void refreshTeammateWorkspace();
  }, [cwd, teammate.id]);

  useEffect(() => {
    setTaskForm((current) => {
      const channelId = resolvePreferredTaskChannelId(current.channelId);
      return channelId === current.channelId ? current : { ...current, channelId };
    });
  }, [channels, memberships]);

  async function refreshTeammateWorkspace(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return;
    }
    setLoading(true);
    try {
      setWorkspaceError("");
      const [directResponse, channelResponse, skillResponse, memoryResponse, taskResponse, activityResponse] = await Promise.all([
        listTeammateDirectMessages(workspaceCwd, teammate.id),
        listTeammateChannels(workspaceCwd, teammate.id),
        listTeammateSkills(workspaceCwd, teammate.id),
        listTeammateMemoryScopes(workspaceCwd, teammate.id),
        listTeammateTasks(workspaceCwd, teammate.id),
        listTeammateActivity(workspaceCwd, teammate.id),
      ]);
      setThread(directResponse.thread);
      setMessages(directResponse.messages);
      setMemberships(channelResponse.memberships);
      setSkillBindings(skillResponse.bindings);
      setMemoryScopes(memoryResponse.scopes);
      setTasks(taskResponse.tasks);
      setActivityItems(activityResponse.items);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function sendPrivateMessage(): Promise<void> {
    const body = messageDraft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    try {
      setWorkspaceError("");
      const response = await createTeammateDirectMessage(cwd.trim(), teammate.id, {
        body,
        requestAiReply: true,
        providerPresetId: teammate.providerPresetId,
      });
      setMessages((current) => [
        ...current,
        response.message,
        ...(response.aiReply ? [response.aiReply] : []),
      ]);
      setMessageDraft("");
      const activityResponse = await listTeammateActivity(cwd.trim(), teammate.id);
      setActivityItems(activityResponse.items);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function createAssignedTask(input: Partial<TeammateTaskCreateForm> = {}): Promise<void> {
    const prompt = (input.prompt ?? taskForm.prompt).trim();
    if (!prompt || creatingTask) {
      return;
    }
    const channelId = resolvePreferredTaskChannelId(input.channelId ?? taskForm.channelId);
    if (!channelId) {
      setWorkspaceError(t("Select a channel before creating a task."));
      return;
    }

    setCreatingTask(true);
    try {
      setWorkspaceError("");
      setTaskMessage("");
      const title = (input.title ?? taskForm.title).trim() || titleFromPrompt(prompt);
      const response = await createTask(cwd.trim(), channelId, {
        title,
        prompt,
        assigneeTeammateId: teammate.id,
      });
      setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
      setTaskForm((current) => ({ ...current, title: "", prompt: "", channelId }));
      const activityResponse = await listTeammateActivity(cwd.trim(), teammate.id);
      setActivityItems(activityResponse.items);
      await onRefreshTasks?.(channelId);
      setTaskMessage(t("Task created for {name}", { name: teammate.displayName }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingTask(false);
    }
  }

  async function createTaskFromMessage(message: TeammateDirectMessage): Promise<void> {
    await createAssignedTask({
      channelId: resolvePreferredTaskChannelId(taskForm.channelId),
      title: titleFromPrompt(message.body),
      prompt: message.body,
    });
    setActiveTab("tasks");
  }

  async function saveChannelMemberships(
    nextMemberships: readonly { readonly channelId: string; readonly isDefault?: boolean }[],
  ): Promise<void> {
    setSavingChannels(true);
    try {
      setWorkspaceError("");
      setChannelMessage("");
      const response = await replaceTeammateChannels(cwd.trim(), teammate.id, nextMemberships);
      setMemberships(response.memberships);
      await onRefreshChannels?.();
      setChannelMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingChannels(false);
    }
  }

  async function toggleChannelMembership(channelId: string): Promise<void> {
    const current = memberships.map((membership) => ({ channelId: membership.channelId, isDefault: membership.isDefault }));
    const existing = current.find((membership) => membership.channelId === channelId);
    const next = existing
      ? current.filter((membership) => membership.channelId !== channelId)
      : [...current, { channelId, isDefault: current.length === 0 }];
    await saveChannelMemberships(next);
  }

  async function setDefaultChannel(channelId: string): Promise<void> {
    const current = memberships.map((membership) => ({ channelId: membership.channelId, isDefault: membership.isDefault }));
    const hasMembership = current.some((membership) => membership.channelId === channelId);
    const next = current.map((membership) => ({ ...membership, isDefault: membership.channelId === channelId }));
    if (!hasMembership) {
      next.push({ channelId, isDefault: true });
    }
    await saveChannelMemberships(next);
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    try {
      setWorkspaceError("");
      await onUpdateTeammate(teammate.id, {
        displayName: settingsForm.displayName.trim() || teammate.displayName,
        description: settingsForm.description.trim(),
        providerPresetId: settingsForm.providerPresetId || null,
        status: settingsForm.status,
        pinned: settingsForm.pinned,
        hidden: settingsForm.hidden,
        systemPrompt: settingsForm.systemPrompt.trim() || null,
      });
      setSaveMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveSkillBindings(
    nextBindings: readonly { readonly skillId: string; readonly source?: TeammateSkillBinding["source"]; readonly enabled?: boolean }[],
    message: string,
  ): Promise<boolean> {
    if (savingSkills) {
      return false;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return false;
    }
    setSavingSkills(true);
    try {
      setWorkspaceError("");
      setSkillMessage("");
      const response = await replaceTeammateSkills(workspaceCwd, teammate.id, nextBindings);
      setSkillBindings(response.bindings);
      setSkillMessage(message);
      return true;
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSavingSkills(false);
    }
  }

  async function toggleSkillBinding(skillId: string): Promise<void> {
    const nextBindings = bindingBySkillId.has(skillId)
      ? skillBindings.map((binding) =>
        binding.skillId === skillId
          ? { skillId: binding.skillId, source: binding.source, enabled: !binding.enabled }
          : { skillId: binding.skillId, source: binding.source, enabled: binding.enabled },
      )
      : [
        ...skillBindings.map((binding) => ({ skillId: binding.skillId, source: binding.source, enabled: binding.enabled })),
        { skillId, source: "user" as const, enabled: true },
      ];
    await saveSkillBindings(nextBindings, t("Skills updated"));
  }

  async function addManualSkillBinding(): Promise<void> {
    const skillId = normalizeManualSkillId(manualSkillInput);
    if (!skillId) {
      setSkillMessage(t("Enter a skill id first"));
      return;
    }
    const existing = bindingBySkillId.get(skillId);
    if (existing?.enabled) {
      setSkillMessage(t("Skill already exists"));
      return;
    }
    const nextBindings = existing
      ? skillBindings.map((binding) =>
        binding.skillId === skillId
          ? { skillId: binding.skillId, source: binding.source, enabled: true }
          : { skillId: binding.skillId, source: binding.source, enabled: binding.enabled },
      )
      : [
        ...skillBindings.map((binding) => ({ skillId: binding.skillId, source: binding.source, enabled: binding.enabled })),
        { skillId, source: "user" as const, enabled: true },
      ];
    if (await saveSkillBindings(nextBindings, t("Skill added"))) {
      setManualSkillInput("");
    }
  }

  async function deleteUserSkillBinding(skillId: string): Promise<void> {
    const binding = bindingBySkillId.get(skillId);
    if (!binding || binding.source === "template") {
      setSkillMessage(t("Default skills cannot be deleted"));
      return;
    }
    const nextBindings = skillBindings
      .filter((item) => item.skillId !== skillId)
      .map((item) => ({ skillId: item.skillId, source: item.source, enabled: item.enabled }));
    await saveSkillBindings(nextBindings, t("Skill deleted"));
  }

  function resolvePreferredTaskChannelId(channelId: string): string {
    if (channelId && channels.some((channel) => channel.id === channelId)) {
      return channelId;
    }
    return memberships.find((membership) => membership.isDefault)?.channelId ?? memberships[0]?.channelId ?? channels[0]?.id ?? "";
  }

  return (
    <div className="teammate-workspace">
      <section className="teammate-workspace-hero" aria-label={t("AI teammate private workspace")}>
        <div className="teammate-workspace-identity">
          <AvatarInitial label={teammateInitialFromName(teammate.displayName)} tone={teammateAvatarTone(teammate)} />
          <div>
            <span className="teammate-pack-label">{t(`role.${teammate.roleKey}`)}</span>
            <h2>{teammate.displayName}</h2>
            <p>{teammate.description}</p>
          </div>
        </div>
        <div className="teammate-workspace-actions">
          <StatusBadge status={teammate.status} />
          <button className="secondary-button" type="button" onClick={() => void refreshTeammateWorkspace()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
            {t("Refresh")}
          </button>
        </div>
        <div className="teammate-workspace-meta">
          <MetaRow label={t("Provider")} value={provider ? provider.displayName : t("None")} compact />
          <MetaRow label={t("Model")} value={provider?.model ?? "-"} compact />
          <MetaRow label={t("Approval")} value={approvalProfileText(teammate.approvalProfile, t)} compact />
          <MetaRow label={t("Thread")} value={thread?.id ?? "-"} compact />
        </div>
        {provider && !providerPreflightReady(provider) ? (
          <div className="provider-run-notice">
            <ShieldCheck size={16} />
            <span>{t("Provider needs a successful check before reliable AI replies.")}</span>
          </div>
        ) : !provider ? (
          <div className="provider-run-notice neutral">
            <ShieldCheck size={16} />
            <span>{t("No provider is bound. Private chat will record messages but AI replies may be blocked.")}</span>
          </div>
        ) : null}
      </section>

      <div className="teammate-workspace-tabs" role="tablist" aria-label={t("AI teammate workspace tabs")}>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {t(tab.label)}
            {tab.count !== undefined ? <span>{tab.count}</span> : null}
          </button>
        ))}
      </div>

      {workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
      {loading ? (
        <div className="client-empty-state teammate-empty">
          <Loader2 className="spin" />
          <span>{t("Loading teammate workspace...")}</span>
        </div>
      ) : null}

      {activeTab === "chat" ? (
        <section className="teammate-private-chat" aria-label={t("Private chat")}>
          <div className="teammate-message-list">
            {messages.length === 0 ? (
              <div className="client-empty-state teammate-empty">
                <MessageSquare size={18} />
                <span>{t("No private messages yet")}</span>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`teammate-message-row ${message.authorType}`}>
                  <AvatarInitial label={message.authorType === "ai-teammate" ? teammateInitialFromName(teammate.displayName) : "U"} tone={message.authorType === "ai-teammate" ? teammateAvatarTone(teammate) : "gray"} />
                  <div>
                    <header>
                      <strong>{message.authorType === "ai-teammate" ? teammate.displayName : t("You")}</strong>
                      <time>{formatDateTime(message.createdAt)}</time>
                      <StatusBadge status={message.status} />
                    </header>
                    <p>{message.body}</p>
                    {message.errorMessage ? <small>{message.errorMessage}</small> : null}
                    <div className="teammate-message-actions">
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => void createTaskFromMessage(message)}
                        disabled={creatingTask || taskChannelOptions.length === 0}
                      >
                        {creatingTask ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                        {t("Create task")}
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="teammate-chat-composer">
            <textarea
              rows={3}
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder={t("Message this AI teammate privately")}
            />
            <button className="primary-button" type="button" onClick={() => void sendPrivateMessage()} disabled={sending || !messageDraft.trim()}>
              {sending ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
              {sending ? t("Sending...") : t("Send")}
            </button>
          </div>
        </section>
      ) : null}

      {activeTab === "tasks" ? (
        <>
          <section className="teammate-list-panel teammate-task-create-panel" aria-label={t("New teammate task")}>
            <div className="panel-title split">
              <span>
                <SquareTerminal size={16} />
                <h2>{t("New teammate task")}</h2>
              </span>
              {taskMessage ? <small>{taskMessage}</small> : null}
            </div>
            <div className="teammate-task-create-grid">
              <label className="field">
                <span>{t("Task channel")}</span>
                <select
                  value={taskForm.channelId}
                  onChange={(event) => setTaskForm({ ...taskForm, channelId: event.target.value })}
                  disabled={taskChannelOptions.length === 0}
                >
                  {taskChannelOptions.length === 0 ? <option value="">{t("No channels available")}</option> : null}
                  {taskChannelOptions.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("Task title")}</span>
                <input value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} />
              </label>
              <label className="field wide">
                <span>{t("Task prompt")}</span>
                <textarea rows={5} value={taskForm.prompt} onChange={(event) => setTaskForm({ ...taskForm, prompt: event.target.value })} />
              </label>
            </div>
            <div className="teammate-task-create-footer">
              <span className="phase-token implement">{t("Assigned to {name}", { name: teammate.displayName })}</span>
              <button className="primary-button" type="button" onClick={() => void createAssignedTask()} disabled={creatingTask || !taskForm.prompt.trim() || taskChannelOptions.length === 0}>
                {creatingTask ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                {t("Create task")}
              </button>
            </div>
          </section>
          <TeammateListSection
            icon={<SquareTerminal size={16} />}
            title={t("Tasks")}
            emptyLabel={t("No tasks assigned to this teammate")}
            items={tasks}
            renderItem={(task) => (
              <article key={task.id} className="teammate-data-row">
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.prompt}</small>
                </span>
                <StatusBadge status={task.status} />
              </article>
            )}
          />
        </>
      ) : null}

      {activeTab === "activity" ? (
        <TeammateListSection
          icon={<Activity size={16} />}
          title={t("Activity")}
          emptyLabel={t("No teammate activity yet")}
          items={activityItems}
          renderItem={(item) => (
            <article key={item.id} className="teammate-data-row">
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle ?? item.sourceId} · {formatDateTime(item.createdAt)}</small>
              </span>
              <StatusBadge status={item.status ?? item.kind} />
            </article>
          )}
        />
      ) : null}

      {activeTab === "channels" ? (
        <section className="teammate-list-panel teammate-channels-panel" aria-label={t("Channels")}>
          <div className="panel-title split">
            <span>
              <Hash size={16} />
              <h2>{t("Channels")}</h2>
            </span>
            <small>{savingChannels ? t("Saving...") : channelMessage || memberships.length}</small>
          </div>
          {channels.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Hash size={18} />
              <span>{t("No channel memberships")}</span>
            </div>
          ) : (
            <div className="teammate-data-list">
              {channels.map((channel) => {
                const membership = membershipByChannelId.get(channel.id);
                const joined = Boolean(membership);
                const isDefault = Boolean(membership?.isDefault || channel.defaultTeammateId === teammate.id);
                return (
                  <article key={channel.id} className="teammate-data-row teammate-channel-row">
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{isDefault ? t("Channel default") : joined ? t("Joined channel") : t("Not joined")}</small>
                    </span>
                    <div className="teammate-channel-actions">
                      <StatusBadge status={channel.status} />
                      <button className="secondary-button compact-button" type="button" onClick={() => void toggleChannelMembership(channel.id)} disabled={savingChannels}>
                        {joined ? <X size={14} /> : <Plus size={14} />}
                        {joined ? t("Leave") : t("Join")}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => void setDefaultChannel(channel.id)} disabled={savingChannels || isDefault}>
                        <CheckCircle2 size={14} />
                        {isDefault ? t("Default teammate") : t("Set default")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "skills" ? (
        <section className="teammate-list-panel teammate-skills-panel" aria-label={t("Skills")}>
          <div className="panel-title split">
            <span>
              <Brain size={16} />
              <h2>{t("Skills")}</h2>
            </span>
            <small>{savingSkills ? t("Saving...") : skillMessage || t("{count} bound", { count: enabledSkillCount })}</small>
          </div>
          <div className="teammate-skill-add-row">
            <label className="field">
              <span>{t("Manual skill")}</span>
              <input
                value={manualSkillInput}
                onChange={(event) => setManualSkillInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addManualSkillBinding();
                  }
                }}
                placeholder={t("URL, repo/name, or skill id")}
              />
            </label>
            <button className="secondary-button" type="button" onClick={() => void addManualSkillBinding()} disabled={savingSkills}>
              <Plus size={15} />
              {t("Add custom skill")}
            </button>
          </div>
          {skillRows.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Brain size={18} />
              <span>{t("No skills bound to this teammate")}</span>
            </div>
          ) : (
            <div className="teammate-data-list">
              {skillRows.map(({ id, skill, binding }) => {
                const enabled = Boolean(binding?.enabled);
                const sourceLabel = binding
                  ? binding.source === "template"
                    ? t("Default skill")
                    : t("User skill")
                  : t("Available skill");
                const canDelete = binding?.source === "user";
                return (
                  <article key={id} className={`teammate-data-row teammate-skill-row ${enabled ? "enabled" : ""}`}>
                    <span>
                      <strong>{skill ? t(skill.name) : id}</strong>
                      <small>{skill ? t(skill.summary) : t("Custom skill binding")}</small>
                    </span>
                    <div className="teammate-skill-actions">
                      <span className="skill-binding-source">{sourceLabel}</span>
                      <span className={`phase-token ${skill?.workflowPhase ?? "operate"}`}>{skill ? workflowPhaseLabel(skill.workflowPhase, t) : t("Custom")}</span>
                      <button className="secondary-button compact-button" type="button" onClick={() => void toggleSkillBinding(id)} disabled={savingSkills}>
                        {enabled ? <X size={14} /> : <Plus size={14} />}
                        {binding ? enabled ? t("Disable skill") : t("Enable skill") : t("Bind skill")}
                      </button>
                      {canDelete ? (
                        <button className="secondary-button danger compact-button" type="button" onClick={() => void deleteUserSkillBinding(id)} disabled={savingSkills}>
                          <Trash2 size={14} />
                          {t("Delete skill")}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "memory" ? (
        <TeammateListSection
          icon={<Bot size={16} />}
          title={t("Memory")}
          emptyLabel={t("No memory scopes enabled")}
          items={memoryScopes}
          renderItem={(scope) => (
            <article key={scope.id} className="teammate-data-row">
              <span>
                <strong>{t(scope.kind)}</strong>
                <small>{scope.channelId ? channelsById.get(scope.channelId)?.name ?? scope.channelId : t("Private workspace")}</small>
              </span>
              <StatusBadge status={scope.enabled ? "active" : "paused"} />
            </article>
          )}
        />
      ) : null}

      {activeTab === "settings" ? (
        <section className="teammate-settings-panel" aria-label={t("Teammate settings")}>
          <div className="panel-title split">
            <span>
              <Settings size={16} />
              <h2>{t("Settings")}</h2>
            </span>
            {saveMessage ? <small>{saveMessage}</small> : null}
          </div>
          <div className="teammate-settings-grid">
            <label className="field">
              <span>{t("Teammate name")}</span>
              <input value={settingsForm.displayName} onChange={(event) => setSettingsForm({ ...settingsForm, displayName: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Provider")}</span>
              <select value={settingsForm.providerPresetId} onChange={(event) => setSettingsForm({ ...settingsForm, providerPresetId: event.target.value })}>
                <option value="">{t("None")}</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName} / {item.model}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("Status")}</span>
              <select value={settingsForm.status} onChange={(event) => setSettingsForm({ ...settingsForm, status: event.target.value as AiTeammate["status"] })}>
                <option value="active">{t("active")}</option>
                <option value="paused">{t("paused")}</option>
                <option value="disabled">{t("disabled")}</option>
              </select>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.pinned} onChange={(event) => setSettingsForm({ ...settingsForm, pinned: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Pinned in sidebar")}</strong>
                <small>{t("Keep this teammate near the top of the workspace roster.")}</small>
              </span>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.hidden} onChange={(event) => setSettingsForm({ ...settingsForm, hidden: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Hidden from sidebar")}</strong>
                <small>{t("The teammate remains durable and can be restored later.")}</small>
              </span>
            </label>
            <label className="field wide">
              <span>{t("Description")}</span>
              <textarea rows={3} value={settingsForm.description} onChange={(event) => setSettingsForm({ ...settingsForm, description: event.target.value })} />
            </label>
            <label className="field wide">
              <span>{t("System prompt")}</span>
              <textarea rows={5} value={settingsForm.systemPrompt} onChange={(event) => setSettingsForm({ ...settingsForm, systemPrompt: event.target.value })} />
            </label>
          </div>
          <div className="teammate-settings-actions">
            <button className="secondary-button" type="button" onClick={onOpenProviders}>
              <ShieldCheck size={15} />
              {t("Model Workbench")}
            </button>
            <button className="secondary-button danger" type="button" onClick={() => void onDisableTeammate(teammate.id)}>
              {t("Disable")}
            </button>
            <button className="primary-button" type="button" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              {t("Save")}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function TeammateListSection<T>({
  icon,
  title,
  emptyLabel,
  items,
  renderItem,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => JSX.Element;
}): JSX.Element {
  return (
    <section className="teammate-list-panel">
      <div className="panel-title split">
        <span>
          {icon}
          <h2>{title}</h2>
        </span>
        <small>{items.length}</small>
      </div>
      {items.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          {icon}
          <span>{emptyLabel}</span>
        </div>
      ) : (
        <div className="teammate-data-list">{items.map(renderItem)}</div>
      )}
    </section>
  );
}

function normalizeManualSkillId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const urlSkillId = parseSkillIdFromUrl(trimmed);
  const candidate = urlSkillId || trimmed;
  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function parseSkillIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return [url.hostname, ...segments.slice(-2)].join("/");
  } catch {
    return "";
  }
}

function teammateToSettingsForm(teammate: AiTeammate): TeammateSettingsForm {
  return {
    displayName: teammate.displayName,
    description: teammate.description,
    providerPresetId: teammate.providerPresetId ?? "",
    status: teammate.status,
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    systemPrompt: teammate.systemPrompt ?? "",
  };
}

function teammateAvatarTone(teammate: AiTeammate): "default" | "orange" | "teal" | "violet" | "blue" | "rose" | "gray" {
  if (
    teammate.avatarTone === "default" ||
    teammate.avatarTone === "orange" ||
    teammate.avatarTone === "teal" ||
    teammate.avatarTone === "violet" ||
    teammate.avatarTone === "blue" ||
    teammate.avatarTone === "rose" ||
    teammate.avatarTone === "gray"
  ) {
    return teammate.avatarTone;
  }
  if (teammate.roleKey === "product" || teammate.roleKey === "release") {
    return "orange";
  }
  if (teammate.roleKey === "engineer" || teammate.roleKey === "architect") {
    return "teal";
  }
  if (teammate.roleKey === "designer" || teammate.roleKey === "docs") {
    return "violet";
  }
  if (teammate.roleKey === "qa") {
    return "blue";
  }
  if (teammate.roleKey === "security") {
    return "rose";
  }
  return "default";
}
