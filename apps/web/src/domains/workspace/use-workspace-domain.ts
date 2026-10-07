import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  getChannelCollaborationProtocol,
  getChannelBrief,
  getChannelCouncilPolicy,
  getChannelEffectiveCouncil,
  listChannelAttachments,
  listChannelContextSummaries,
  listChannelDecisions,
  listChannelExecutionProposals,
  listChannelHandoffs,
  listChannelLinkPreviews,
  listChannelConversationItems,
  listChannelMessageRouteDecisions,
  listChannelIntentDecisions,
  listChannelWorkflowSteps,
  listChannelWorkflows,
  listExecutionActions,
  getAiCouncilHealth,
  listAiCouncils,
  listChannels,
  listGovernanceNotifications,
  listMemoryObjects,
  listRunArtifacts,
  listStateTransitions,
  listTasks,
  listUsedMemoryEvents,
  markGovernanceNotificationSeen,
  dismissGovernanceNotification,
  updateChannelCouncilPolicy,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import { deriveChannelTasks } from "../../lib/channel-artifacts.js";
import { mergeConversationItems, mergeChannelUserInputPage, projectChannelConversationItemPage, type ChannelConversationMessagePage } from "../../lib/channel-conversation-items.js";
import { createConversationReadEpoch } from "../../lib/conversation-read-epoch.js";
import { isUserInputAnchor } from "@ling-stack/conversation-ui-core";
import type { ConversationReasoningSummaryRecord, TurnContextAssignment, UserInputTranscriptItemV1 } from "@ling-stack/contracts";
import { channelMessagesEqual } from "../../lib/channel-message-equality.js";
import { liveNarrationWorkflowIds, mergeWorkflowNarration, mergeWorkflowStepReadModels } from "../../lib/workflow-narration-refresh.js";
import {
  defaultChannelCreateForm,
  defaultChannelEditForm,
} from "../../lib/channels.js";
import { useLatestKeyedRequestGuard } from "../../lib/use-latest-request.js";
import type {
  Channel,
  AiCouncil,
  AiCouncilHealthReport,
  ChannelBranch,
  ChannelAttachment,
  ChannelBrief,
  ChannelCollaborationProtocolResponse,
  ChannelContextSummary,
  ChannelCouncilPolicy,
  ChannelCreateFormState,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelFormState,
  ChannelHandoff,
  ChannelLinkPreview,
  ChannelMessage,
  ConversationItemV1,
  ConversationGeneratedMedia,
  ChannelIntentDecision,
  ChannelMessageRouteDecision,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ExecutionAction,
  GovernanceNotification,
  MemoryObject,
  RunArtifact,
  RunSession,
  StateEntityType,
  StateTransitionEvent,
  Task,
  TaskEditFormState,
  TaskFormState,
  EffectiveChannelCouncilProjection,
  UpdateChannelCouncilPolicyRequest,
  UsedMemoryEvent,
} from "../../types.js";

const channelMessageInitialLimit = 200;
const channelMessageOlderLimit = 100;
const channelMessageRouteDecisionLimit = 200;
const channelIntentDecisionLimit = 200;

export const defaultTaskForm: TaskFormState = {
  title: "Inspect workspace",
  prompt: "Inspect the current project structure, give next implementation advice, and do not modify files.",
};

export const defaultTaskEditForm: TaskEditFormState = {
  title: "",
  prompt: "",
  status: "todo",
};

export interface WorkspaceState {
  readonly channels: readonly Channel[];
  readonly channelBranches: readonly ChannelBranch[];
  readonly channelsLoading: boolean;
  readonly selectedChannelId: string;
  readonly channelForm: ChannelCreateFormState;
  readonly channelCreateOpen: boolean;
  readonly channelEditForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly tasksLoading: boolean;
  readonly taskForm: TaskFormState;
  readonly selectedTaskId: string;
  readonly taskEditForm: TaskEditFormState;
  readonly taskRunProviderId: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelConversationItems: readonly ConversationItemV1[];
  readonly channelTurnContextAssignments: readonly TurnContextAssignment[];
  readonly channelUserInputs: readonly UserInputTranscriptItemV1[];
  readonly channelReasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly channelGeneratedMedia: readonly ConversationGeneratedMedia[];
  readonly memoryObjects: readonly MemoryObject[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly channelMessagesHasOlder: boolean;
  readonly channelMessagesLoadingOlder: boolean;
  readonly channelExecutionProposals: readonly ChannelExecutionProposal[];
  readonly channelAttachments: readonly ChannelAttachment[];
  readonly channelLinkPreviews: readonly ChannelLinkPreview[];
  readonly channelArtifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly channelArtifactErrorsByRun: Readonly<Record<string, string>>;
  readonly channelExecutionActions: readonly ExecutionAction[];
  readonly channelExecutionActionError: string;
  readonly channelBrief: ChannelBrief | undefined;
  readonly channelCollaborationProtocol: ChannelCollaborationProtocolResponse | undefined;
  readonly channelDecisions: readonly ChannelDecision[];
  readonly channelIntentDecisions: readonly ChannelIntentDecision[];
  readonly channelMessageRouteDecisions: readonly ChannelMessageRouteDecision[];
  readonly channelHandoffs: readonly ChannelHandoff[];
  readonly channelContextSummaries: readonly ChannelContextSummary[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly channelMessagesLoading: boolean;
  readonly channelFilesLoading: boolean;
  readonly channelRunArtifactsLoading: boolean;
  readonly channelProtocolLoading: boolean;
  readonly channelStateTransitions: readonly StateTransitionEvent[];
  readonly channelActivityTransitionsLoading: boolean;
  readonly channelActivityTransitionError: string;
  readonly channelGovernanceNotifications: readonly GovernanceNotification[];
  readonly channelGovernanceNotificationsLoading: boolean;
  readonly channelGovernanceNotificationActionId: string;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilHealthReport: AiCouncilHealthReport | undefined;
  readonly aiCouncilsLoading: boolean;
  readonly channelCouncilPolicy: ChannelCouncilPolicy | undefined;
  readonly channelEffectiveCouncil: EffectiveChannelCouncilProjection | undefined;
  readonly channelCouncilLoading: boolean;
  readonly channelCouncilSaving: boolean;
}

export interface WorkspaceActions {
  readonly setChannels: Dispatch<SetStateAction<readonly Channel[]>>;
  readonly setChannelBranches: Dispatch<SetStateAction<readonly ChannelBranch[]>>;
  readonly setSelectedChannelId: Dispatch<SetStateAction<string>>;
  readonly setChannelForm: Dispatch<SetStateAction<ChannelCreateFormState>>;
  readonly setChannelCreateOpen: Dispatch<SetStateAction<boolean>>;
  readonly setChannelEditForm: Dispatch<SetStateAction<ChannelFormState>>;
  readonly setTasks: Dispatch<SetStateAction<readonly Task[]>>;
  readonly setSelectedTaskId: Dispatch<SetStateAction<string>>;
  readonly setTaskForm: Dispatch<SetStateAction<TaskFormState>>;
  readonly setTaskEditForm: Dispatch<SetStateAction<TaskEditFormState>>;
  readonly setTaskRunProviderId: Dispatch<SetStateAction<string>>;
  readonly setChannelMessages: Dispatch<SetStateAction<readonly ChannelMessage[]>>;
  readonly setChannelConversationItems: Dispatch<SetStateAction<readonly ConversationItemV1[]>>;
  readonly setChannelExecutionProposals: Dispatch<SetStateAction<readonly ChannelExecutionProposal[]>>;
  readonly setChannelAttachments: Dispatch<SetStateAction<readonly ChannelAttachment[]>>;
  readonly setChannelLinkPreviews: Dispatch<SetStateAction<readonly ChannelLinkPreview[]>>;
  readonly setChannelFilesLoading: Dispatch<SetStateAction<boolean>>;
  readonly setChannelBrief: Dispatch<SetStateAction<ChannelBrief | undefined>>;
  readonly setChannelCollaborationProtocol: Dispatch<SetStateAction<ChannelCollaborationProtocolResponse | undefined>>;
  readonly setChannelDecisions: Dispatch<SetStateAction<readonly ChannelDecision[]>>;
  readonly setChannelIntentDecisions: Dispatch<SetStateAction<readonly ChannelIntentDecision[]>>;
  readonly setChannelMessageRouteDecisions: Dispatch<SetStateAction<readonly ChannelMessageRouteDecision[]>>;
  readonly setChannelHandoffs: Dispatch<SetStateAction<readonly ChannelHandoff[]>>;
  readonly setChannelContextSummaries: Dispatch<SetStateAction<readonly ChannelContextSummary[]>>;
  readonly setChannelWorkflows: Dispatch<SetStateAction<readonly ChannelWorkflow[]>>;
  readonly setChannelWorkflowSteps: Dispatch<SetStateAction<readonly ChannelWorkflowStep[]>>;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly refreshChannelMessages: (channelId?: string, threadId?: string, options?: ChannelMessageRefreshOptions) => Promise<void>;
  readonly loadOlderChannelMessages: (channelId?: string, threadId?: string) => Promise<void>;
  readonly refreshChannelExecutionProposals: (channelId?: string) => Promise<void>;
  readonly upsertChannelExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly refreshChannelFiles: (channelId?: string) => Promise<void>;
  readonly refreshChannelRunArtifacts: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelExecutionActions: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelActivityTransitions: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelGovernanceNotifications: (channelId?: string) => Promise<void>;
  readonly markChannelGovernanceNotificationSeen: (notificationId: string) => Promise<void>;
  readonly dismissChannelGovernanceNotification: (notificationId: string) => Promise<void>;
  readonly refreshAiCouncils: (cwd?: string) => Promise<void>;
  readonly refreshSelectedChannelCouncil: (channelId?: string) => Promise<void>;
  readonly updateSelectedChannelCouncilPolicy: (input: UpdateChannelCouncilPolicyRequest, channelId?: string) => Promise<void>;
  readonly refreshChannelMessageRouteDecisions: (channelId?: string) => Promise<void>;
  readonly refreshChannelIntentDecisions: (channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
  readonly resetSelectedChannelActivity: () => void;
  readonly resetForCwd: (cwd: string) => void;
}

export interface ChannelMessageRefreshOptions {
  readonly silent?: boolean;
}

export type WorkspaceController = DomainController<WorkspaceState, WorkspaceActions>;

type WorkspaceFeedbackSurface = "workspace" | "composer" | "task" | "workflow" | "protocol" | "dock";
type WorkspaceFeedbackScope = "load" | "mutation" | "stream";

interface WorkspaceFeedbackEntry {
  readonly surface: WorkspaceFeedbackSurface;
  readonly identity: string;
  readonly scope: WorkspaceFeedbackScope;
  readonly message: string;
}

export function useWorkspaceDomain(input: {
  readonly cwd: string;
  readonly initialWorkspaceCwd: string;
  readonly selectedChannelBranchId: string;
  readonly translate: (value: string) => string;
  readonly reportFeedback: (entry: WorkspaceFeedbackEntry) => void;
  readonly clearFeedback: (surface: WorkspaceFeedbackSurface, identity: string) => void;
  readonly onChannelMessagesLoaded?: (channelId: string, messages: readonly ChannelMessage[]) => void;
}): WorkspaceController {
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [channelBranches, setChannelBranches] = useState<readonly ChannelBranch[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [channelForm, setChannelForm] = useState<ChannelCreateFormState>(() => ({
    ...defaultChannelCreateForm,
    boundPath: input.initialWorkspaceCwd,
  }));
  const [channelCreateOpen, setChannelCreateOpen] = useState(false);
  const [channelEditForm, setChannelEditForm] = useState<ChannelFormState>(defaultChannelEditForm);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskFormState>(() => ({
    ...defaultTaskForm,
    title: input.translate(defaultTaskForm.title),
    prompt: input.translate(defaultTaskForm.prompt),
  }));
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(defaultTaskEditForm);
  const [taskRunProviderId, setTaskRunProviderId] = useState("");
  const [channelMessages, setChannelMessages] = useState<readonly ChannelMessage[]>([]);
  const [channelConversationItems, setChannelConversationItems] = useState<readonly ConversationItemV1[]>([]);
  const [channelTurnContextAssignmentState, setChannelTurnContextAssignmentState] = useState<{
    owner: string;
    assignments: readonly TurnContextAssignment[];
  }>({ owner: "", assignments: [] });
  const [channelUserInputState, setChannelUserInputState] = useState<{ owner: string; items: readonly UserInputTranscriptItemV1[] }>({ owner: "", items: [] });
  const [channelReasoningSummaryState, setChannelReasoningSummaryState] = useState<{
    owner: string;
    items: readonly ConversationReasoningSummaryRecord[];
  }>({ owner: "", items: [] });
  const channelInputPageRef = useRef<ChannelConversationMessagePage | undefined>(undefined);
  const channelReadEpochRef = useRef(createConversationReadEpoch());
  const channelReadOwnerRef = useRef("");
  const [channelGeneratedMedia, setChannelGeneratedMedia] = useState<readonly ConversationGeneratedMedia[]>([]);
  const [channelItemsBeforeSequence, setChannelItemsBeforeSequence] = useState<number | undefined>();
  const [memoryObjects, setMemoryObjects] = useState<readonly MemoryObject[]>([]);
  const [usedMemoryEvents, setUsedMemoryEvents] = useState<readonly UsedMemoryEvent[]>([]);
  const [channelMessagesHasOlder, setChannelMessagesHasOlder] = useState(false);
  const [channelMessagesLoadingOlder, setChannelMessagesLoadingOlder] = useState(false);
  const [channelExecutionProposals, setChannelExecutionProposals] = useState<readonly ChannelExecutionProposal[]>([]);
  const [channelAttachments, setChannelAttachments] = useState<readonly ChannelAttachment[]>([]);
  const [channelLinkPreviews, setChannelLinkPreviews] = useState<readonly ChannelLinkPreview[]>([]);
  const [channelArtifactsByRun, setChannelArtifactsByRun] = useState<Record<string, readonly RunArtifact[]>>({});
  const [channelArtifactErrorsByRun, setChannelArtifactErrorsByRun] = useState<Record<string, string>>({});
  const [channelExecutionActions, setChannelExecutionActions] = useState<readonly ExecutionAction[]>([]);
  const [channelExecutionActionError, setChannelExecutionActionError] = useState("");
  const [channelBrief, setChannelBrief] = useState<ChannelBrief | undefined>();
  const [channelCollaborationProtocol, setChannelCollaborationProtocol] = useState<ChannelCollaborationProtocolResponse | undefined>();
  const [channelDecisions, setChannelDecisions] = useState<readonly ChannelDecision[]>([]);
  const [channelIntentDecisions, setChannelIntentDecisions] = useState<readonly ChannelIntentDecision[]>([]);
  const [channelMessageRouteDecisions, setChannelMessageRouteDecisions] = useState<readonly ChannelMessageRouteDecision[]>([]);
  const [channelHandoffs, setChannelHandoffs] = useState<readonly ChannelHandoff[]>([]);
  const [channelContextSummaries, setChannelContextSummaries] = useState<readonly ChannelContextSummary[]>([]);
  const [channelWorkflows, setChannelWorkflows] = useState<readonly ChannelWorkflow[]>([]);
  const [channelWorkflowSteps, setChannelWorkflowSteps] = useState<readonly ChannelWorkflowStep[]>([]);
  // Active-run polling can outlive the initial protocol load. Read its latest scope.
  const channelWorkflowStepsRef = useRef(channelWorkflowSteps);
  channelWorkflowStepsRef.current = channelWorkflowSteps;
  const [channelMessagesLoading, setChannelMessagesLoading] = useState(false);
  const [channelFilesLoading, setChannelFilesLoading] = useState(false);
  const [channelRunArtifactsLoading, setChannelRunArtifactsLoading] = useState(false);
  const [channelProtocolLoading, setChannelProtocolLoading] = useState(false);
  const [channelStateTransitions, setChannelStateTransitions] = useState<readonly StateTransitionEvent[]>([]);
  const [channelActivityTransitionsLoading, setChannelActivityTransitionsLoading] = useState(false);
  const channelActivityTransitionsLoadedScopeRef = useRef("");
  const [channelActivityTransitionError, setChannelActivityTransitionError] = useState("");
  const [channelGovernanceNotifications, setChannelGovernanceNotifications] = useState<readonly GovernanceNotification[]>([]);
  const [channelGovernanceNotificationsLoading, setChannelGovernanceNotificationsLoading] = useState(false);
  const [channelGovernanceNotificationActionId, setChannelGovernanceNotificationActionId] = useState("");
  const [aiCouncils, setAiCouncils] = useState<readonly AiCouncil[]>([]);
  const [aiCouncilHealthReport, setAiCouncilHealthReport] = useState<AiCouncilHealthReport | undefined>();
  const [aiCouncilsLoading, setAiCouncilsLoading] = useState(false);
  const [channelCouncilPolicy, setChannelCouncilPolicy] = useState<ChannelCouncilPolicy | undefined>();
  const [channelEffectiveCouncil, setChannelEffectiveCouncil] = useState<EffectiveChannelCouncilProjection | undefined>();
  const [channelCouncilLoading, setChannelCouncilLoading] = useState(false);
  const [channelCouncilSaving, setChannelCouncilSaving] = useState(false);
  const [error, setError] = useState<DomainError | undefined>();
  const loadGuard = useLatestKeyedRequestGuard();

  const selectedChannelBranch = channelBranches.find((branch) =>
    branch.id === input.selectedChannelBranchId &&
    branch.channelId === selectedChannelId &&
    branch.status !== "archived"
  );
  const selectedChannelMessageThreadId = input.selectedChannelBranchId
    ? selectedChannelBranch?.rootThreadId ?? `missing-channel-branch-thread:${input.selectedChannelBranchId}`
    : undefined;
  const selectedChannelIdRef = useRef(selectedChannelId);
  const selectedChannelMessageThreadIdRef = useRef(selectedChannelMessageThreadId);
  selectedChannelIdRef.current = selectedChannelId;
  selectedChannelMessageThreadIdRef.current = selectedChannelMessageThreadId;
  const channelReadOwner = JSON.stringify([input.cwd.trim(), selectedChannelId, selectedChannelMessageThreadId ?? ""]);
  if (channelReadOwnerRef.current !== channelReadOwner) {
    channelReadOwnerRef.current = channelReadOwner;
    channelReadEpochRef.current.invalidate();
    channelInputPageRef.current = undefined;
  }

  function isSelectedChannelConversation(channelId: string, threadId?: string): boolean {
    return channelId === selectedChannelIdRef.current && threadId === selectedChannelMessageThreadIdRef.current;
  }

  function clearScopedFeedback(surface: WorkspaceFeedbackSurface, identity: string): void {
    input.clearFeedback(surface, identity);
  }

  function reportScopedFeedback(
    surface: WorkspaceFeedbackSurface,
    identity: string,
    scope: WorkspaceFeedbackScope,
    caught: unknown,
  ): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    setError({ scope, message });
    input.reportFeedback({ surface, identity, scope, message });
  }

  async function refreshChannels(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setChannels([]);
      setChannelBranches([]);
      setSelectedChannelId("");
      return;
    }

    const token = loadGuard.next(`channels:${cwd}`);
    setChannelsLoading(true);
    try {
      clearScopedFeedback("workspace", cwd);
      setError(undefined);
      const response = await listChannels(cwd);
      if (!loadGuard.isCurrent(`channels:${cwd}`, token)) {
        return;
      }
      setChannels(response.channels);
      setChannelBranches(response.branches ?? []);
      setSelectedChannelId((current) => {
        if (response.channels.some((channel) => channel.id === current)) {
          return current;
        }
        return "";
      });
    } catch (caught) {
      if (!loadGuard.isCurrent(`channels:${cwd}`, token)) return;
      reportScopedFeedback("workspace", cwd, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`channels:${cwd}`, token)) {
        setChannelsLoading(false);
      }
    }
  }

  async function refreshTasks(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setTasks([]);
      return;
    }

    const token = loadGuard.next(`tasks:${cwd}:${channelId}`);
    setTasksLoading(true);
    try {
      clearScopedFeedback("task", channelId);
      setError(undefined);
      const response = await listTasks(cwd, channelId);
      if (!loadGuard.isCurrent(`tasks:${cwd}:${channelId}`, token)) {
        return;
      }
      setTasks(response.tasks);
      setSelectedTaskId((current) => {
        if (response.tasks.some((task) => task.id === current)) {
          return current;
        }
        return "";
      });
    } catch (caught) {
      if (!loadGuard.isCurrent(`tasks:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("task", channelId, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`tasks:${cwd}:${channelId}`, token)) {
        setTasksLoading(false);
      }
    }
  }

  async function refreshAiCouncils(cwd = input.cwd.trim()): Promise<void> {
    if (!cwd) {
      setAiCouncils([]);
      setAiCouncilHealthReport(undefined);
      setAiCouncilsLoading(false);
      return;
    }

    const token = loadGuard.next(`aiCouncils:${cwd}`);
    setAiCouncilsLoading(true);
    try {
      clearScopedFeedback("workspace", selectedChannelId || cwd);
      setError(undefined);
      const [listResponse, healthResponse] = await Promise.all([
        listAiCouncils(cwd, { limit: 100 }),
        getAiCouncilHealth(cwd, { limit: 500 }),
      ]);
      if (!loadGuard.isCurrent(`aiCouncils:${cwd}`, token)) {
        return;
      }
      setAiCouncils(listResponse.councils);
      setAiCouncilHealthReport(healthResponse.report);
    } catch (caught) {
      if (!loadGuard.isCurrent(`aiCouncils:${cwd}`, token)) return;
      reportScopedFeedback("workspace", selectedChannelId || cwd, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`aiCouncils:${cwd}`, token)) {
        setAiCouncilsLoading(false);
      }
    }
  }

  async function refreshSelectedChannelCouncil(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelCouncilPolicy(undefined);
      setChannelEffectiveCouncil(undefined);
      setChannelCouncilLoading(false);
      return;
    }

    const token = loadGuard.next(`channelCouncil:${cwd}:${channelId}`);
    setChannelCouncilLoading(true);
    try {
      clearScopedFeedback("workspace", channelId);
      setError(undefined);
      const [policyResponse, effectiveResponse] = await Promise.all([
        getChannelCouncilPolicy(cwd, channelId),
        getChannelEffectiveCouncil(cwd, channelId),
      ]);
      if (!loadGuard.isCurrent(`channelCouncil:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelCouncilPolicy(policyResponse.policy);
      setChannelEffectiveCouncil(effectiveResponse.effectiveCouncil);
    } catch (caught) {
      if (!loadGuard.isCurrent(`channelCouncil:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("workspace", channelId, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`channelCouncil:${cwd}:${channelId}`, token)) {
        setChannelCouncilLoading(false);
      }
    }
  }

  async function updateSelectedChannelCouncilPolicy(
    policyInput: UpdateChannelCouncilPolicyRequest,
    channelId = selectedChannelId,
  ): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId || channelCouncilSaving) {
      return;
    }

    setChannelCouncilSaving(true);
    try {
      clearScopedFeedback("workspace", channelId);
      setError(undefined);
      const policyResponse = await updateChannelCouncilPolicy(cwd, channelId, policyInput);
      const effectiveResponse = await getChannelEffectiveCouncil(cwd, channelId);
      setChannelCouncilPolicy(policyResponse.policy);
      setChannelEffectiveCouncil(effectiveResponse.effectiveCouncil);
    } catch (caught) {
      reportScopedFeedback("workspace", channelId, "mutation", caught);
    } finally {
      setChannelCouncilSaving(false);
    }
  }

  async function refreshChannelMessages(
    channelId = selectedChannelId,
    threadId?: string,
    options?: ChannelMessageRefreshOptions,
  ): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelMessages([]);
      setChannelConversationItems([]);
      setChannelTurnContextAssignmentState({ owner: channelReadOwnerRef.current, assignments: [] });
      channelReadEpochRef.current.invalidate();
      channelInputPageRef.current = undefined;
      setChannelUserInputState({ owner: channelReadOwnerRef.current, items: [] });
      setChannelReasoningSummaryState({ owner: channelReadOwnerRef.current, items: [] });
      setChannelMessagesHasOlder(false);
      setChannelItemsBeforeSequence(undefined);
      return;
    }

    const readOwner = JSON.stringify([cwd, channelId, threadId ?? ""]);
    if (readOwner !== channelReadOwnerRef.current) return;
    const guardKey = `messages:${cwd}:${channelId}`;
    const token = loadGuard.next(guardKey);
    const readTicket = channelReadEpochRef.current.begin(readOwner);
    setChannelMessagesLoadingOlder(false);
    if (!options?.silent) {
      setChannelMessagesLoading(true);
    }
    try {
      if (!options?.silent) {
        clearScopedFeedback("composer", channelId);
        setError(undefined);
      }
      const response = await listChannelConversationItems(cwd, channelId, {
        limit: channelMessageInitialLimit,
        surface: threadId ? { kind: "thread", threadId } : { kind: "channel_root" },
      });
      if (!loadGuard.isCurrent(guardKey, token) || !channelReadEpochRef.current.isCurrent(readTicket)) {
        return;
      }
      if (!isSelectedChannelConversation(channelId, threadId)) {
        return;
      }
      const page = projectChannelConversationItemPage(response);
      if (response.channelId !== channelId || response.thread.channelId !== channelId
        || (threadId !== undefined && response.thread.id !== threadId)) throw new Error("Channel response scope mismatch.");
      const hydrated = mergeChannelUserInputPage(channelInputPageRef.current, page);
      channelInputPageRef.current = hydrated;
      setChannelTurnContextAssignmentState({ owner: readOwner, assignments: hydrated.turnContextAssignments });
      setChannelUserInputState({ owner: readOwner, items: hydrated.userInputs ?? [] });
      setChannelReasoningSummaryState({ owner: readOwner, items: hydrated.reasoningSummaries });
      const messagesChanged = !channelMessagesEqual(channelMessages, page.messages);
      setChannelMessages((current) => channelMessagesEqual(current, page.messages) ? current : page.messages);
      const visibleIds = new Set(page.conversationItems.map(item => item.id));
      setChannelConversationItems(hydrated.conversationItems.filter(item => visibleIds.has(item.id)));
      setChannelGeneratedMedia(page.generatedMedia);
      setChannelMessagesHasOlder(page.hasMore);
      setChannelItemsBeforeSequence(page.nextBeforeSequence);
      if (messagesChanged) {
        input.onChannelMessagesLoaded?.(channelId, page.messages);
      }
    } catch (caught) {
      if (!loadGuard.isCurrent(guardKey, token) || !channelReadEpochRef.current.isCurrent(readTicket) || !isSelectedChannelConversation(channelId, threadId)) return;
      if (!options?.silent) {
        reportScopedFeedback("composer", channelId, "load", caught);
      }
    } finally {
      if (loadGuard.isCurrent(guardKey, token) && channelReadEpochRef.current.isCurrent(readTicket) && isSelectedChannelConversation(channelId, threadId)) {
        setChannelMessagesLoading(false);
      }
    }
  }

  async function loadOlderChannelMessages(channelId = selectedChannelId, threadId?: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId || channelItemsBeforeSequence === undefined || channelMessagesLoadingOlder || !channelMessagesHasOlder) {
      return;
    }

    const readOwner = JSON.stringify([cwd, channelId, threadId ?? ""]);
    if (readOwner !== channelReadOwnerRef.current) return;
    const guardKey = `olderMessages:${cwd}:${channelId}`;
    const token = loadGuard.next(guardKey);
    const readTicket = channelReadEpochRef.current.begin(readOwner, "page");
    const requestedBeforeSequence = channelItemsBeforeSequence;
    setChannelMessagesLoadingOlder(true);
    try {
      clearScopedFeedback("composer", channelId);
      setError(undefined);
      const response = await listChannelConversationItems(cwd, channelId, {
        limit: channelMessageOlderLimit,
        beforeSequence: requestedBeforeSequence,
        surface: threadId ? { kind: "thread", threadId } : { kind: "channel_root" },
      });
      if (!loadGuard.isCurrent(guardKey, token) || !channelReadEpochRef.current.isCurrent(readTicket)) {
        return;
      }
      if (!isSelectedChannelConversation(channelId, threadId)) {
        return;
      }
      const page = projectChannelConversationItemPage(response);
      if (response.channelId !== channelId || response.thread.channelId !== channelId
        || (threadId !== undefined && response.thread.id !== threadId)) throw new Error("Channel response scope mismatch.");
      const hydrated = mergeChannelUserInputPage(channelInputPageRef.current, page, requestedBeforeSequence);
      channelInputPageRef.current = hydrated;
      setChannelTurnContextAssignmentState({ owner: readOwner, assignments: hydrated.turnContextAssignments });
      setChannelUserInputState({ owner: readOwner, items: hydrated.userInputs ?? [] });
      setChannelReasoningSummaryState({ owner: readOwner, items: hydrated.reasoningSummaries });
      setChannelMessages((current) => mergeChannelMessages(page.messages, current));
      setChannelConversationItems((current) => {
        const visibleIds = new Set([...current, ...page.conversationItems].map(item => item.id));
        return mergeConversationItems(page.conversationItems.filter(item => !isUserInputAnchor(item)), current.filter(item => !isUserInputAnchor(item)))
          .concat(hydrated.conversationItems.filter(item => isUserInputAnchor(item) && visibleIds.has(item.id)))
          .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
      });
      setChannelGeneratedMedia((current) => mergeGeneratedMedia(page.generatedMedia, current));
      setChannelMessagesHasOlder(page.hasMore);
      setChannelItemsBeforeSequence(page.nextBeforeSequence);
    } catch (caught) {
      if (!loadGuard.isCurrent(guardKey, token) || !channelReadEpochRef.current.isCurrent(readTicket) || !isSelectedChannelConversation(channelId, threadId)) return;
      reportScopedFeedback("composer", channelId, "load", caught);
    } finally {
      if (loadGuard.isCurrent(guardKey, token) && channelReadEpochRef.current.isCurrent(readTicket) && isSelectedChannelConversation(channelId, threadId)) {
        setChannelMessagesLoadingOlder(false);
      }
    }
  }

  async function refreshChannelExecutionProposals(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelExecutionProposals([]);
      return;
    }

    const token = loadGuard.next(`executionProposals:${cwd}:${channelId}`);
    try {
      clearScopedFeedback("workflow", channelId);
      setError(undefined);
      const response = await listChannelExecutionProposals(cwd, channelId);
      if (!loadGuard.isCurrent(`executionProposals:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelExecutionProposals(response.proposals);
    } catch (caught) {
      if (!loadGuard.isCurrent(`executionProposals:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("workflow", channelId, "load", caught);
    }
  }

  function upsertChannelExecutionProposal(proposal: ChannelExecutionProposal): void {
    setChannelExecutionProposals((current) => [
      proposal,
      ...current.filter((item) => item.id !== proposal.id),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async function refreshChannelFiles(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelAttachments([]);
      setChannelLinkPreviews([]);
      return;
    }

    const token = loadGuard.next(`files:${cwd}:${channelId}`);
    setChannelFilesLoading(true);
    try {
      clearScopedFeedback("dock", channelId);
      setError(undefined);
      const [attachmentsResponse, linksResponse] = await Promise.all([
        listChannelAttachments(cwd, channelId),
        listChannelLinkPreviews(cwd, channelId),
      ]);
      if (!loadGuard.isCurrent(`files:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelAttachments(attachmentsResponse.attachments);
      setChannelLinkPreviews(linksResponse.linkPreviews);
    } catch (caught) {
      if (!loadGuard.isCurrent(`files:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("dock", channelId, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`files:${cwd}:${channelId}`, token)) {
        setChannelFilesLoading(false);
      }
    }
  }

  async function refreshChannelRunArtifacts(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    if (!cwd || !channelId) {
      setChannelArtifactsByRun({});
      setChannelArtifactErrorsByRun({});
      setChannelRunArtifactsLoading(false);
      return;
    }
    if (channelRuns.length === 0) {
      setChannelRunArtifactsLoading(false);
      return;
    }

    const token = loadGuard.next(`runArtifacts:${cwd}:${channelId}`);
    setChannelRunArtifactsLoading(true);
    const results = await Promise.all(
      channelRuns.map(async (sourceRun) => {
        try {
          const response = await listRunArtifacts(sourceRun.id, cwd);
          return { runId: sourceRun.id, artifacts: response.artifacts } as const;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          return { runId: sourceRun.id, error: message } as const;
        }
      }),
    );
    if (!loadGuard.isCurrent(`runArtifacts:${cwd}:${channelId}`, token)) {
      return;
    }

    const nextArtifacts: Record<string, readonly RunArtifact[]> = {};
    const nextErrors: Record<string, string> = {};
    for (const result of results) {
      if ("artifacts" in result) {
        nextArtifacts[result.runId] = result.artifacts ?? [];
      } else {
        nextErrors[result.runId] = result.error;
      }
    }
    setChannelArtifactsByRun(nextArtifacts);
    setChannelArtifactErrorsByRun(nextErrors);
    setChannelRunArtifactsLoading(false);
  }

  async function refreshChannelExecutionActions(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    if (!cwd || !channelId) {
      setChannelExecutionActions([]);
      setChannelExecutionActionError("");
      return;
    }
    if (channelRuns.length === 0) {
      setChannelExecutionActions([]);
      setChannelExecutionActionError("");
      return;
    }

    const token = loadGuard.next(`executionActions:${cwd}:${channelId}`);
    const [results, narrationResults] = await Promise.all([Promise.all(
      channelRuns.map(async (sourceRun) => {
        try {
          const response = await listExecutionActions(cwd, { runId: sourceRun.id, limit: 100 });
          return { actions: response.actions } as const;
        } catch (caught) {
          return { error: caught instanceof Error ? caught.message : String(caught) } as const;
        }
      }),
    ), Promise.all(liveNarrationWorkflowIds(channelWorkflowStepsRef.current, channelRuns, channelId).map(async workflowId => {
      try {
        return { steps: (await listChannelWorkflowSteps(cwd, workflowId)).workflowSteps };
      } catch (caught) {
        return { error: caught instanceof Error ? caught.message : String(caught) };
      }
    }))]);
    if (!loadGuard.isCurrent(`executionActions:${cwd}:${channelId}`, token)) {
      return;
    }

    const nextActions = new Map<string, ExecutionAction>();
    const errors = new Set<string>();
    setChannelWorkflowSteps(current => mergeWorkflowNarration(current, narrationResults.flatMap(result => result.steps ?? [])));
    for (const result of narrationResults) if (result.error) errors.add(result.error);
    for (const result of results) {
      if ("error" in result) {
        errors.add(result.error ?? "unknown_error");
      } else {
        for (const action of result.actions) {
          nextActions.set(action.id, action);
        }
      }
    }
    setChannelExecutionActions([...nextActions.values()].sort((a, b) =>
      (b.completedAt ?? b.executedAt ?? b.resolvedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.executedAt ?? a.resolvedAt ?? a.createdAt) ||
      b.id.localeCompare(a.id),
    ));
    setChannelExecutionActionError(errors.size > 0 ? [...errors][0] : "");
  }

  async function refreshChannelActivityTransitions(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    if (!cwd || !channelId) {
      channelActivityTransitionsLoadedScopeRef.current = "";
      setChannelStateTransitions([]);
      setChannelActivityTransitionError("");
      setChannelActivityTransitionsLoading(false);
      return;
    }

    const scopeKey = `${cwd}:${channelId}`;
    const entities = buildChannelTransitionEntities(channelId, tasks, channelRuns, channelWorkflows, channelWorkflowSteps);
    if (entities.length === 0) {
      channelActivityTransitionsLoadedScopeRef.current = scopeKey;
      setChannelStateTransitions([]);
      setChannelActivityTransitionError("");
      setChannelActivityTransitionsLoading(false);
      return;
    }

    const token = loadGuard.next(`activityTransitions:${cwd}:${channelId}`);
    setChannelActivityTransitionsLoading(channelActivityTransitionsLoadedScopeRef.current !== scopeKey);
    const results = await Promise.all(
      entities.map(async (entity) => {
        try {
          const response = await listStateTransitions(cwd, {
            entityType: entity.entityType,
            entityId: entity.entityId,
            limit: 20,
          });
          return { transitions: response.transitions } as const;
        } catch (caught) {
          return { error: caught instanceof Error ? caught.message : String(caught) } as const;
        }
      }),
    );
    if (!loadGuard.isCurrent(`activityTransitions:${cwd}:${channelId}`, token)) {
      return;
    }

    const nextTransitions = new Map<string, StateTransitionEvent>();
    const errors = new Set<string>();
    for (const result of results) {
      if ("error" in result) {
        errors.add(result.error ?? "unknown_error");
      } else {
        for (const transition of result.transitions) {
          nextTransitions.set(transition.id, transition);
        }
      }
    }

    setChannelStateTransitions([...nextTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setChannelActivityTransitionError(errors.size > 0 ? [...errors][0] : "");
    channelActivityTransitionsLoadedScopeRef.current = scopeKey;
    setChannelActivityTransitionsLoading(false);
  }

  async function refreshChannelGovernanceNotifications(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelGovernanceNotifications([]);
      setChannelGovernanceNotificationsLoading(false);
      return;
    }

    const token = loadGuard.next(`governanceNotifications:${cwd}:${channelId}`);
    setChannelGovernanceNotificationsLoading(true);
    try {
      const response = await listGovernanceNotifications(cwd, {
        surface: "channel",
        channelId,
        limit: 50,
      });
      if (!loadGuard.isCurrent(`governanceNotifications:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelGovernanceNotifications(response.notifications);
    } catch {
      if (!loadGuard.isCurrent(`governanceNotifications:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelGovernanceNotifications([]);
    } finally {
      if (loadGuard.isCurrent(`governanceNotifications:${cwd}:${channelId}`, token)) {
        setChannelGovernanceNotificationsLoading(false);
      }
    }
  }

  async function markChannelGovernanceNotificationSeen(notificationId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !notificationId || channelGovernanceNotificationActionId) {
      return;
    }

    setChannelGovernanceNotificationActionId(notificationId);
    try {
      clearScopedFeedback("workspace", selectedChannelId);
      const response = await markGovernanceNotificationSeen(cwd, notificationId);
      setChannelGovernanceNotifications((current) =>
        current.map((notification) => notification.id === notificationId ? response.notification : notification),
      );
    } catch (caught) {
      reportScopedFeedback("workspace", selectedChannelId, "mutation", caught);
    } finally {
      setChannelGovernanceNotificationActionId("");
    }
  }

  async function dismissChannelGovernanceNotification(notificationId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !notificationId || channelGovernanceNotificationActionId) {
      return;
    }

    setChannelGovernanceNotificationActionId(notificationId);
    try {
      clearScopedFeedback("workspace", selectedChannelId);
      await dismissGovernanceNotification(cwd, notificationId);
      setChannelGovernanceNotifications((current) => current.filter((notification) => notification.id !== notificationId));
    } catch (caught) {
      reportScopedFeedback("workspace", selectedChannelId, "mutation", caught);
    } finally {
      setChannelGovernanceNotificationActionId("");
    }
  }

  async function refreshChannelMessageRouteDecisions(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelMessageRouteDecisions([]);
      return;
    }

    const token = loadGuard.next(`messageRouteDecisions:${cwd}:${channelId}`);
    try {
      clearScopedFeedback("protocol", channelId);
      setError(undefined);
      const response = await listChannelMessageRouteDecisions(cwd, channelId, { limit: channelMessageRouteDecisionLimit });
      if (!loadGuard.isCurrent(`messageRouteDecisions:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelMessageRouteDecisions(response.decisions);
    } catch (caught) {
      if (!loadGuard.isCurrent(`messageRouteDecisions:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("protocol", channelId, "load", caught);
    }
  }

  async function refreshChannelIntentDecisions(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      setChannelIntentDecisions([]);
      return;
    }

    const token = loadGuard.next(`intentDecisions:${cwd}:${channelId}`);
    try {
      clearScopedFeedback("protocol", channelId);
      setError(undefined);
      const response = await listChannelIntentDecisions(cwd, channelId, { limit: channelIntentDecisionLimit });
      if (!loadGuard.isCurrent(`intentDecisions:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelIntentDecisions(response.decisions);
    } catch (caught) {
      if (!loadGuard.isCurrent(`intentDecisions:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("protocol", channelId, "load", caught);
    }
  }

  async function refreshChannelProtocol(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || !channelId) {
      resetChannelProtocol();
      return;
    }

    const token = loadGuard.next(`protocol:${cwd}:${channelId}`);
    setChannelProtocolLoading(true);
    try {
      clearScopedFeedback("protocol", channelId);
      setError(undefined);
      const [briefResponse, protocolResponse, decisionsResponse, routeDecisionsResponse, intentDecisionsResponse, handoffsResponse, summariesResponse, workflowsResponse] = await Promise.all([
        getChannelBrief(cwd, channelId),
        getChannelCollaborationProtocol(cwd, channelId),
        listChannelDecisions(cwd, channelId),
        listChannelMessageRouteDecisions(cwd, channelId, { limit: channelMessageRouteDecisionLimit }),
        listChannelIntentDecisions(cwd, channelId, { limit: channelIntentDecisionLimit }),
        listChannelHandoffs(cwd, channelId),
        listChannelContextSummaries(cwd, channelId),
        listChannelWorkflows(cwd, channelId),
      ]);
      const workflowSteps = await loadWorkflowSteps(cwd, workflowsResponse.workflows);
      if (!loadGuard.isCurrent(`protocol:${cwd}:${channelId}`, token)) {
        return;
      }
      setChannelBrief(briefResponse.brief);
      setChannelCollaborationProtocol(protocolResponse);
      setChannelDecisions(decisionsResponse.decisions);
      setChannelMessageRouteDecisions(routeDecisionsResponse.decisions);
      setChannelIntentDecisions(intentDecisionsResponse.decisions);
      setChannelHandoffs(handoffsResponse.handoffs);
      setChannelContextSummaries(summariesResponse.contextSummaries);
      setChannelWorkflows(workflowsResponse.workflows);
      setChannelWorkflowSteps(current => mergeWorkflowStepReadModels(current, workflowSteps));
    } catch (caught) {
      if (!loadGuard.isCurrent(`protocol:${cwd}:${channelId}`, token)) return;
      reportScopedFeedback("protocol", channelId, "load", caught);
    } finally {
      if (loadGuard.isCurrent(`protocol:${cwd}:${channelId}`, token)) {
        setChannelProtocolLoading(false);
      }
    }
  }

  async function refreshUsedMemoryAudit(cwd = input.cwd.trim()): Promise<void> {
    if (!cwd) {
      setMemoryObjects([]);
      setUsedMemoryEvents([]);
      return;
    }

    const token = loadGuard.next(`memory:${cwd}`);
    try {
      const [memoryResponse, usedResponse] = await Promise.all([
        listMemoryObjects(cwd),
        listUsedMemoryEvents(cwd, { limit: 200 }),
      ]);
      if (!loadGuard.isCurrent(`memory:${cwd}`, token)) {
        return;
      }
      setMemoryObjects(memoryResponse.memories);
      setUsedMemoryEvents(usedResponse.events);
    } catch {
      if (!loadGuard.isCurrent(`memory:${cwd}`, token)) {
        return;
      }
      setMemoryObjects([]);
      setUsedMemoryEvents([]);
    }
  }

  async function loadWorkflowSteps(cwd: string, workflows: readonly ChannelWorkflow[]): Promise<readonly ChannelWorkflowStep[]> {
    if (workflows.length === 0) {
      return [];
    }
    const stepResponses = await Promise.all(workflows.map((workflow) => listChannelWorkflowSteps(cwd, workflow.id)));
    return stepResponses.flatMap((response) => response.workflowSteps);
  }

  function resetChannelProtocol(): void {
    setChannelBrief(undefined);
    setChannelCollaborationProtocol(undefined);
    setChannelDecisions([]);
    setChannelMessageRouteDecisions([]);
    setChannelIntentDecisions([]);
    setChannelHandoffs([]);
    setChannelContextSummaries([]);
    setChannelWorkflows([]);
    setChannelWorkflowSteps([]);
    setChannelProtocolLoading(false);
  }

  function resetSelectedChannelActivity(): void {
    channelReadEpochRef.current.invalidate();
    channelInputPageRef.current = undefined;
    setChannelUserInputState({ owner: channelReadOwnerRef.current, items: [] });
    setChannelReasoningSummaryState({ owner: channelReadOwnerRef.current, items: [] });
    setTasks([]);
    setChannelMessages([]);
    setChannelConversationItems([]);
    setChannelTurnContextAssignmentState({ owner: channelReadOwnerRef.current, assignments: [] });
    setChannelGeneratedMedia([]);
    setChannelMessagesHasOlder(false);
    setChannelItemsBeforeSequence(undefined);
    setChannelMessagesLoadingOlder(false);
    setChannelExecutionProposals([]);
    setChannelAttachments([]);
    setChannelLinkPreviews([]);
    setChannelArtifactsByRun({});
    setChannelArtifactErrorsByRun({});
    setChannelExecutionActions([]);
    setChannelExecutionActionError("");
    setChannelStateTransitions([]);
    setChannelActivityTransitionError("");
    setChannelActivityTransitionsLoading(false);
    setChannelGovernanceNotifications([]);
    setChannelGovernanceNotificationsLoading(false);
    setChannelGovernanceNotificationActionId("");
    setChannelCouncilPolicy(undefined);
    setChannelEffectiveCouncil(undefined);
    setChannelCouncilLoading(false);
    setChannelCouncilSaving(false);
    resetChannelProtocol();
  }

  function resetForCwd(cwd: string): void {
    channelReadEpochRef.current.invalidate();
    channelInputPageRef.current = undefined;
    setChannelUserInputState({ owner: "", items: [] });
    setChannelReasoningSummaryState({ owner: "", items: [] });
    loadGuard.reset();
    channelActivityTransitionsLoadedScopeRef.current = "";
    setChannels([]);
    setChannelBranches([]);
    setSelectedChannelId("");
    setChannelForm((current) => ({
      ...defaultChannelCreateForm,
      ...current,
      boundPath: cwd || current.boundPath,
    }));
    setChannelCreateOpen(false);
    setChannelEditForm(defaultChannelEditForm);
    setTasks([]);
    setTaskForm({
      ...defaultTaskForm,
      title: input.translate(defaultTaskForm.title),
      prompt: input.translate(defaultTaskForm.prompt),
    });
    setSelectedTaskId("");
    setTaskEditForm(defaultTaskEditForm);
    setTaskRunProviderId("");
    setChannelsLoading(false);
    setTasksLoading(false);
    setChannelMessages([]);
    setChannelConversationItems([]);
    setChannelTurnContextAssignmentState({ owner: channelReadOwnerRef.current, assignments: [] });
    setChannelGeneratedMedia([]);
    setMemoryObjects([]);
    setUsedMemoryEvents([]);
    setChannelMessagesHasOlder(false);
    setChannelItemsBeforeSequence(undefined);
    setChannelMessagesLoadingOlder(false);
    setChannelExecutionProposals([]);
    setChannelAttachments([]);
    setChannelLinkPreviews([]);
    setChannelArtifactsByRun({});
    setChannelArtifactErrorsByRun({});
    setChannelExecutionActions([]);
    setChannelExecutionActionError("");
    setChannelMessagesLoading(false);
    setChannelFilesLoading(false);
    setChannelRunArtifactsLoading(false);
    setChannelStateTransitions([]);
    setChannelActivityTransitionsLoading(false);
    setChannelActivityTransitionError("");
    setChannelGovernanceNotifications([]);
    setChannelGovernanceNotificationsLoading(false);
    setChannelGovernanceNotificationActionId("");
    setAiCouncils([]);
    setAiCouncilHealthReport(undefined);
    setAiCouncilsLoading(false);
    setChannelCouncilPolicy(undefined);
    setChannelEffectiveCouncil(undefined);
    setChannelCouncilLoading(false);
    setChannelCouncilSaving(false);
    resetChannelProtocol();
    setError(undefined);
  }

  return {
    state: {
      channels,
      channelBranches,
      channelsLoading,
      selectedChannelId,
      channelForm,
      channelCreateOpen,
      channelEditForm,
      tasks,
      tasksLoading,
      taskForm,
      selectedTaskId,
      taskEditForm,
      taskRunProviderId,
      channelMessages,
      channelConversationItems,
      channelTurnContextAssignments: channelTurnContextAssignmentState.owner === channelReadOwner
        ? channelTurnContextAssignmentState.assignments
        : [],
      channelUserInputs: channelUserInputState.owner === channelReadOwner ? channelUserInputState.items : [],
      channelReasoningSummaries: channelReasoningSummaryState.owner === channelReadOwner
        ? channelReasoningSummaryState.items
        : [],
      channelGeneratedMedia,
      memoryObjects,
      usedMemoryEvents,
      channelMessagesHasOlder,
      channelMessagesLoadingOlder,
      channelExecutionProposals,
      channelAttachments,
      channelLinkPreviews,
      channelArtifactsByRun,
      channelArtifactErrorsByRun,
      channelExecutionActions,
      channelExecutionActionError,
      channelBrief,
      channelCollaborationProtocol,
      channelDecisions,
      channelIntentDecisions,
      channelMessageRouteDecisions,
      channelHandoffs,
      channelContextSummaries,
      channelWorkflows,
      channelWorkflowSteps,
      channelMessagesLoading,
      channelFilesLoading,
      channelRunArtifactsLoading,
      channelProtocolLoading,
      channelStateTransitions,
      channelActivityTransitionsLoading,
      channelActivityTransitionError,
      channelGovernanceNotifications,
      channelGovernanceNotificationsLoading,
      channelGovernanceNotificationActionId,
      aiCouncils,
      aiCouncilHealthReport,
      aiCouncilsLoading,
      channelCouncilPolicy,
      channelEffectiveCouncil,
      channelCouncilLoading,
      channelCouncilSaving,
    },
    actions: {
      setChannels,
      setChannelBranches,
      setSelectedChannelId,
      setChannelForm,
      setChannelCreateOpen,
      setChannelEditForm,
      setTasks,
      setSelectedTaskId,
      setTaskForm,
      setTaskEditForm,
      setTaskRunProviderId,
      setChannelMessages,
      setChannelConversationItems,
      setChannelExecutionProposals,
      setChannelAttachments,
      setChannelLinkPreviews,
      setChannelFilesLoading,
      setChannelBrief,
      setChannelCollaborationProtocol,
      setChannelDecisions,
      setChannelIntentDecisions,
      setChannelMessageRouteDecisions,
      setChannelHandoffs,
      setChannelContextSummaries,
      setChannelWorkflows,
      setChannelWorkflowSteps,
      refreshChannels,
      refreshTasks,
      refreshChannelMessages,
      loadOlderChannelMessages,
      refreshChannelExecutionProposals,
      upsertChannelExecutionProposal,
      refreshChannelFiles,
      refreshChannelRunArtifacts,
      refreshChannelExecutionActions,
      refreshChannelActivityTransitions,
      refreshChannelGovernanceNotifications,
      markChannelGovernanceNotificationSeen,
      dismissChannelGovernanceNotification,
      refreshAiCouncils,
      refreshSelectedChannelCouncil,
      updateSelectedChannelCouncilPolicy,
      refreshChannelMessageRouteDecisions,
      refreshChannelIntentDecisions,
      refreshChannelProtocol,
      refreshUsedMemoryAudit,
      resetSelectedChannelActivity,
      resetForCwd,
    },
    refresh: refreshChannels,
    isLoading: channelsLoading || tasksLoading || channelMessagesLoading || channelFilesLoading || channelProtocolLoading || aiCouncilsLoading || channelCouncilLoading,
    error,
    clearError: () => setError(undefined),
  };
}

function mergeChannelMessages(
  olderMessages: readonly ChannelMessage[],
  currentMessages: readonly ChannelMessage[],
): readonly ChannelMessage[] {
  const seen = new Set<string>();
  const merged: ChannelMessage[] = [];
  for (const message of [...olderMessages, ...currentMessages]) {
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

function mergeGeneratedMedia(
  olderItems: readonly ConversationGeneratedMedia[],
  currentItems: readonly ConversationGeneratedMedia[],
): readonly ConversationGeneratedMedia[] {
  const byId = new Map<string, ConversationGeneratedMedia>();
  for (const item of [...olderItems, ...currentItems]) byId.set(item.mediaJobId, item);
  return [...byId.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.mediaJobId.localeCompare(right.mediaJobId),
  );
}

interface ChannelTransitionEntity {
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly updatedAt: string;
}

function buildChannelTransitionEntities(
  channelId: string,
  tasks: readonly Task[],
  runs: readonly RunSession[],
  workflows: readonly ChannelWorkflow[],
  workflowSteps: readonly ChannelWorkflowStep[],
): readonly ChannelTransitionEntity[] {
  if (!channelId) {
    return [];
  }

  const channelTasks = deriveChannelTasks(channelId, tasks);
  const channelTaskIds = new Set(channelTasks.map((task) => task.id));
  const items: ChannelTransitionEntity[] = [
    ...channelTasks.map((task) => ({ entityType: "task" as const, entityId: task.id, updatedAt: task.updatedAt })),
    ...runs
      .filter((run) => run.channelId === channelId || channelTaskIds.has(run.taskId))
      .map((run) => ({ entityType: "run" as const, entityId: run.id, updatedAt: run.updatedAt })),
    ...workflows
      .filter((workflow) => workflow.channelId === channelId)
      .map((workflow) => ({ entityType: "workflow" as const, entityId: workflow.id, updatedAt: workflow.updatedAt })),
    ...workflowSteps
      .filter((step) => step.channelId === channelId)
      .map((step) => ({ entityType: "workflow_step" as const, entityId: step.id, updatedAt: step.updatedAt })),
  ];

  const deduped = new Map<string, ChannelTransitionEntity>();
  for (const item of items) {
    deduped.set(`${item.entityType}:${item.entityId}`, item);
  }

  return [...deduped.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
}
