import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationExecutionEnvironment,
  AutomationOutputDestination,
  AutomationReasoningEffort,
  AutomationTarget,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  Channel,
  CreateAutomationRequest,
  LingThread,
  ProviderPreset,
} from "../../types.js";
import type { AutomationScheduleValue } from "./AutomationScheduleFields.js";

const DEFAULT_WORKSPACE_ID = "workspace_default";

export interface AutomationFormValue {
  readonly cwd: string;
  readonly outputArtifact: boolean;
  readonly prompt: string;
  readonly providerPresetId: string;
  readonly reasoningEffort: AutomationReasoningEffort;
  readonly runtime: AutomationExecutionEnvironment;
  readonly schedule: AutomationScheduleValue;
  readonly targetId: string;
  readonly title: string;
}

export interface AutomationFormErrors {
  readonly prompt?: string;
  readonly schedule?: string;
  readonly target?: string;
  readonly title?: string;
}

export function defaultAutomationFormValue(input: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
}): AutomationFormValue {
  return {
    cwd: input.cwd,
    outputArtifact: true,
    prompt: "",
    providerPresetId: input.providers.find(isRunnableChatProvider)?.id ?? "",
    reasoningEffort: "medium",
    runtime: "worktree",
    schedule: defaultSchedule(),
    targetId: input.channels.find((channel) => channel.status === "active")
      ? `channel:${input.channels.find((channel) => channel.status === "active")?.id}`
      : "workspace",
    title: "",
  };
}

export function templateAutomationFormValue(
  template: BuiltinAutomationTemplate,
  base: AutomationFormValue,
): AutomationFormValue {
  return {
    ...base,
    prompt: template.defaultPromptTemplate.promptMarkdown,
    providerPresetId: template.defaultExecutionPolicy.providerPresetId ?? base.providerPresetId,
    schedule: scheduleValueFromTrigger(template.defaultTrigger),
    title: template.title,
  };
}

export function draftAutomationFormValue(draft: AutomationDraft, base: AutomationFormValue): AutomationFormValue {
  const targetId = targetIdFromTarget(draft.target) ?? base.targetId;
  return {
    ...base,
    outputArtifact: draft.outputPolicy?.destinations.some((destination) => destination.type === "markdown_artifact") ?? base.outputArtifact,
    prompt: draft.promptTemplate?.promptMarkdown ?? base.prompt,
    providerPresetId: draft.executionPolicy?.providerPresetId ?? base.providerPresetId,
    reasoningEffort: base.reasoningEffort,
    runtime: targetId.startsWith("thread:") ? "local" : base.runtime,
    schedule: scheduleValueFromTrigger(draft.trigger),
    targetId,
    title: draft.title ?? base.title,
  };
}

export function definitionScheduleValue(automation: AutomationDefinition): AutomationScheduleValue {
  if (automation.rrule) {
    return { ...defaultSchedule(), customRRule: automation.rrule, mode: "custom" };
  }
  return scheduleValueFromTrigger(automation.trigger);
}

export function validateAutomationForm(value: AutomationFormValue, requiredMessage: string): AutomationFormErrors {
  let schedule: string | undefined;
  if (value.schedule.mode === "interval" && Number(value.schedule.intervalMinutes) <= 0) schedule = requiredMessage;
  if ((value.schedule.mode === "daily" || value.schedule.mode === "weekly") && !value.schedule.timeOfDay) schedule = requiredMessage;
  if (value.schedule.mode === "custom" && !/^FREQ=/i.test(value.schedule.customRRule.trim())) schedule = requiredMessage;
  return {
    prompt: value.prompt.trim() ? undefined : requiredMessage,
    schedule,
    target: value.targetId ? undefined : requiredMessage,
    title: value.title.trim() ? undefined : requiredMessage,
  };
}

export function buildAutomationRequest(value: AutomationFormValue, providers: readonly ProviderPreset[]): CreateAutomationRequest {
  const target = automationTargetFromId(value.targetId, value.cwd);
  const threadTarget = target.scope === "thread";
  const provider = providers.find((candidate) => candidate.id === value.providerPresetId);
  const outputDestinations: AutomationOutputDestination[] = [{ type: "automation_thread" }];
  if (value.outputArtifact) outputDestinations.push({ type: "markdown_artifact" });
  return {
    automationMode: threadTarget ? "heartbeat" : "cron",
    channelId: target.channelId,
    cwds: threadTarget ? [] : [value.cwd],
    executionEnvironment: threadTarget ? undefined : value.runtime,
    executionPolicy: {
      allowedTools: ["read", "grep", "find", "ls"],
      approvalProfile: { mode: "none" },
      providerPresetId: value.providerPresetId || undefined,
    },
    kind: "custom_prompt",
    model: provider?.model,
    outputPolicy: { artifactFormat: "markdown", destinations: outputDestinations },
    promptTemplate: {
      contextSelectors: [
        { kind: "channel_brief" },
        { kind: "recent_runs", limit: 8 },
        { kind: "pending_approvals", limit: 8 },
        { kind: "external_work", limit: 8 },
        { kind: "recent_artifacts", limit: 8 },
      ],
      maxContextItems: 32,
      promptMarkdown: value.prompt.trim(),
      systemPurpose: "Run a confirmed automation from supplied Ling context only.",
      templateVersion: 1,
    },
    reasoningEffort: value.reasoningEffort,
    rrule: value.schedule.mode === "custom" ? value.schedule.customRRule.trim() : undefined,
    target,
    targetThreadId: target.threadId,
    title: value.title.trim(),
    trigger: triggerFromAutomationSchedule(value.schedule),
  };
}

export function automationTargetOptions(input: {
  readonly channels: readonly Channel[];
  readonly threads: readonly LingThread[];
}): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: "Current workspace", value: "workspace" },
    ...input.channels.filter((channel) => channel.status === "active").map((channel) => ({ label: `#${channel.name}`, value: `channel:${channel.id}` })),
    ...input.threads.filter((thread) => thread.status !== "archived").map((thread) => ({ label: thread.title, value: `thread:${thread.id}` })),
  ];
}

function isRunnableChatProvider(provider: ProviderPreset): boolean {
  return provider.enabled && provider.capabilities.includes("chat");
}

export function automationTargetFromId(targetId: string, cwd: string): AutomationTarget {
  if (targetId.startsWith("channel:")) {
    return { channelId: targetId.slice("channel:".length), cwd, scope: "channel", workspaceId: DEFAULT_WORKSPACE_ID };
  }
  if (targetId.startsWith("thread:")) {
    return { cwd, scope: "thread", threadId: targetId.slice("thread:".length), workspaceId: DEFAULT_WORKSPACE_ID };
  }
  return { cwd, scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID };
}

function targetIdFromTarget(target?: AutomationTarget): string | undefined {
  if (!target) return undefined;
  if (target.scope === "channel" && target.channelId) return `channel:${target.channelId}`;
  if (target.scope === "thread" && target.threadId) return `thread:${target.threadId}`;
  if (target.scope === "workspace") return "workspace";
  return undefined;
}

export function triggerFromAutomationSchedule(schedule: AutomationScheduleValue): AutomationTrigger {
  if (schedule.mode === "manual") return { type: "manual" };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (schedule.mode === "interval") {
    return { missedRunPolicy: "skip", schedule: { cadence: "interval", everyMs: Math.max(1, Number(schedule.intervalMinutes)) * 60_000 }, timezone, type: "schedule" };
  }
  if (schedule.mode === "weekly") {
    const weekday = Math.min(6, Math.max(0, Number(schedule.weekday))) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    return { missedRunPolicy: "skip", schedule: { cadence: "weekly", timeOfDay: schedule.timeOfDay || "09:00", weekday }, timezone, type: "schedule" };
  }
  return { missedRunPolicy: "skip", schedule: { cadence: "daily", timeOfDay: schedule.timeOfDay || "09:00" }, timezone, type: "schedule" };
}

function scheduleValueFromTrigger(trigger?: AutomationTrigger): AutomationScheduleValue {
  if (!trigger || trigger.type !== "schedule") return { ...defaultSchedule(), mode: "manual" };
  if (trigger.schedule.cadence === "interval") {
    return { ...defaultSchedule(), intervalMinutes: String(Math.max(1, Math.round(trigger.schedule.everyMs / 60_000))), mode: "interval" };
  }
  if (trigger.schedule.cadence === "weekly") {
    return { ...defaultSchedule(), mode: "weekly", timeOfDay: trigger.schedule.timeOfDay, weekday: String(trigger.schedule.weekday) };
  }
  return { ...defaultSchedule(), mode: "daily", timeOfDay: trigger.schedule.timeOfDay };
}

function defaultSchedule(): AutomationScheduleValue {
  return {
    customRRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    intervalMinutes: "60",
    mode: "manual",
    timeOfDay: "09:00",
    weekday: "1",
  };
}
