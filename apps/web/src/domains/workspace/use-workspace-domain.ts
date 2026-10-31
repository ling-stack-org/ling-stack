import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { channelSessionThreadId, isChannelSessionDraft } from "../../app/channel-session-state.js";
import { reconcileChannelSessionMessageCache } from "./channel-session-message-cache.js";
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
import type { ConversationReasoningSummaryRecord, ConversationRuntimeMetrics, TurnContextAssignment, UserInputTranscriptItemV1 } from "@ling-stack/contracts";
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
  readonly channelRuntimeMetrics?: ConversationRuntimeMetrics;
  readonly channelTurnContextAssignments: readonly TurnContextAssignment[];
  readonly channelUserInputs: readonly UserInputTranscriptItemV1[];
  readonly channelReasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly channelConversationRefreshToken: number;
  readonly channelContextCompactions: readonly import("../../types.js").ConversationContextCompactionRecord[];
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
  readonly workspaceCwd: string;
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
  readonly clearFeedback: (surface: WorkspaceFeedbackSurface, identity: string, workspaceCwd: string) => void;
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
  const [taskSelection, setTaskSelection] = useState({ id: "", explicitRevision: 0 });
  const selectedTaskId = taskSelection.id;
  function setSelectedTaskId(update: SetStateAction<string>): void {
    setTaskSelection(current => ({ ...current, id: typeof update === "function" ? update(current.id) : update }));
  }
  function selectTaskExplicitly(update: SetStateAction<string>): void {
    setTaskSelection(current => ({
      id: typeof update === "function" ? update(current.id) : update,
      explicitRevision: current.explicitRevision + 1,
    }));
  }
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(defaultTaskEditForm);
  const [taskRunProviderId, setTaskRunProviderId] = useState("");
  const [channelMessages, setChannelMessages] = useState<readonly ChannelMessage[]>([]);
  const [channelConversationItems, setChannelConversationItems] = useState<readonly ConversationItemV1[]>([]);
  const [channelRuntimeMetricsState, setChannelRuntimeMetricsState] = useState<{ owner: string; metrics?: ConversationRuntimeMetrics }>({ owner: "" });
  const [channelTurnContextAssignmentState, setChannelTurnContextAssignmentState] = useState<{
    owner: string;
    assignments: readonly TurnContextAssignment[];
  }>({ owner: "", assignments: [] });
  const [channelUserInputState, setChannelUserInputState] = useState<{ owner: string; items: readonly UserInputTranscriptItemV1[] }>({ owner: "", items: [] });
  const [channelReasoningSummaryState, setChannelReasoningSummaryState] = useState<{
    owner: string;
    items: readonly ConversationReasoningSummaryRecord[];
  }>({ owner: "", items: [] });
  const [channelConversationRefreshToken, setChannelConversationRefreshToken] = useState(0);
  const [channelContextCompactionState, setChannelContextCompactionState] = useState<{ owner: string; items: readonly import("../../types.js").ConversationContextCompactionRecord[] }>({ owner: "", items: [] });
  const channelInputPageRef = useRef<ChannelConversationMessagePage | undefined>(undefined);
  const channelMessageCacheRef = useRef(new Map<string, {
    messages: readonly ChannelMessage[]; items: readonly ConversationItemV1[]; page?: ChannelConversationMessagePage;
    generatedMedia: readonly ConversationGeneratedMedia[]; hasOlder: boolean; before?: number;
  }>());
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
    ? channelSessionThreadId(input.selectedChannelBranchId) ?? selectedChannelBranch?.rootThreadId ?? (isChannelSessionDraft(input.selectedChannelBranchId) ? input.selectedChannelBranchId : `missing-channel-branch-thread:${input.selectedChannelBranchId}`)
    : undefined;
  const selectedChannelIdRef = useRef(selectedChannelId);
  const selectedChannelMessageThreadIdRef = useRef(selectedChannelMessageThreadId);
  selectedChannelIdRef.current = selectedChannelId;
  selectedChannelMessageThreadIdRef.current = selectedChannelMessageThreadId;
  // Dock panels belong to the channel, not its selected root/topic/branch.
  const channelPanelOwnerKey = JSON.stringify([input.cwd.trim(), selectedChannelId]);
  const [channelPanelStateOwner, setChannelPanelStateOwner] = useState({
    key: channelPanelOwnerKey, cwd: input.cwd.trim(), taskSelectionRevision: taskSelection.explicitRevision,
  });
  const channelPanelOwnerRef = useRef({ key: channelPanelOwnerKey });
  if (channelPanelOwnerRef.current.key !== channelPanelOwnerKey) {
    channelPanelOwnerRef.current = { key: channelPanelOwnerKey };
  }
  if (channelPanelStateOwner.key !== channelPanelOwnerKey ||
    channelPanelStateOwner.taskSelectionRevision !== taskSelection.explicitRevision) {
    setChannelPanelStateOwner({
      key: channelPanelOwnerKey, cwd: input.cwd.trim(), taskSelectionRevision: taskSelection.explicitRevision,
    });
  }
  const channelReadOwner = JSON.stringify([input.cwd.trim(), selectedChannelId, selectedChannelMessageThreadId ?? ""]);
  const channelRuntimeMetrics = channelRuntimeMetricsState.owner === channelReadOwner ? channelRuntimeMetricsState.metrics : undefined;
  const channelReadOwnerChanged = channelReadOwnerRef.current !== channelReadOwner;
  if (channelReadOwnerChanged) {
    if (channelReadOwnerRef.current) channelMessageCacheRef.current.set(channelReadOwnerRef.current, {
      messages: channelMessages, items: channelConversationItems, page: channelInputPageRef.current,
      generatedMedia: channelGeneratedMedia, hasOlder: channelMessagesHasOlder, before: channelItemsBeforeSequence,
    });
    channelReadOwnerRef.current = channelReadOwner;
    channelReadEpochRef.current.invalidate();
    const cached = channelMessageCacheRef.current.get(channelReadOwner);
    channelInputPageRef.current = cached?.page;
    // Keep the owner transition synchronous so a newly selected channel cannot
    // paint the previous channel's transcript while its first read is pending.
    setChannelMessages(cached?.messages ?? []);
    setChannelConversationItems(cached?.items ?? []);
    setChannelGeneratedMedia(cached?.generatedMedia ?? []);
    setChannelMessagesHasOlder(cached?.hasOlder ?? false);
    setChannelItemsBeforeSequence(cached?.before);
    setChannelMessagesLoadingOlder(false);
    setChannelTurnContextAssignmentState(cached?.page
      ? { owner: channelReadOwner, assignments: cached.page.turnContextAssignments }
      : { owner: channelReadOwner, assignments: [] });
    setChannelUserInputState(cached?.page
      ? { owner: channelReadOwner, items: cached.page.userInputs ?? [] }
      : { owner: channelReadOwner, items: [] });
    setChannelReasoningSummaryState(cached?.page
      ? { owner: channelReadOwner, items: cached.page.reasoningSummaries }
      : { owner: channelReadOwner, items: [] });
    setChannelContextCompactionState(cached?.page
      ? { owner: channelReadOwner, items: cached.page.contextCompactions ?? [] }
      : { owner: channelReadOwner, items: [] });
  } else {
    channelMessageCacheRef.current.set(channelReadOwner, {
      messages: channelMessages, items: channelConversationItems, page: channelInputPageRef.current,
      generatedMedia: channelGeneratedMedia, hasOlder: channelMessagesHasOlder, before: channelItemsBeforeSequence,
    });
  }

  if (channelPanelStateOwner.key !== channelPanelOwnerKey) {
    // Clear before React commits the new owner, so a newly selected channel cannot paint old dock data.
    setChannelExecutionProposals([]);
    setChannelAttachments([]);
    setChannelLinkPreviews([]);
    setChannelFilesLoading(false);
    // Task navigation can inject a target row before selecting its channel in the same React batch.
    setTasks(current => channelPanelStateOwner.cwd === input.cwd.trim()
      ? current.filter(task => task.channelId === selectedChannelId) : []);
    if (channelPanelStateOwner.taskSelectionRevision === taskSelection.explicitRevision) {
      setSelectedTaskId("");
    }
    setTasksLoading(false);
    setChannelArtifactsByRun({});
    setChannelArtifactErrorsByRun({});
    setChannelRunArtifactsLoading(false);
    setChannelExecutionActions([]);
    setChannelExecutionActionError("");
    setChannelStateTransitions([]);
    setChannelActivityTransitionError("");
    setChannelActivityTransitionsLoading(false);
    channelActivityTransitionsLoadedScopeRef.current = "";
    setChannelGovernanceNotifications([]);
    setChannelGovernanceNotificationsLoading(false);
    setChannelCouncilPolicy(undefined);
    setChannelEffectiveCouncil(undefined);
    setChannelCouncilLoading(false);
    resetChannelProtocol();
    setError(undefined);
  }

  function isSelectedChannelConversation(channelId: string, threadId?: string): boolean {
    return channelId === selectedChannelIdRef.current && threadId === selectedChannelMessageThreadIdRef.current;
  }

  function beginChannelPanelRead(key: string, cwd: string, channelId: string) {
    const owner = channelPanelOwnerRef.current;
    const token = owner.key === JSON.stringify([cwd, channelId]) ? loadGuard.next(key) : undefined;
    const isCurrent = () => token !== undefined && channelPanelOwnerRef.current === owner && loadGuard.isCurrent(key, token);
    function publish<T>(setter: Dispatch<SetStateAction<T>>, update: SetStateAction<NoInfer<T>>): void {
      if (!isCurrent()) return;
      // React may apply an updater after navigation or a newer request.
      setter(current => !isCurrent() ? current : typeof update === "function"
        ? (update as (value: T) => T)(current) : update);
    }
    function report(surface: WorkspaceFeedbackSurface, caught: unknown): void {
      if (!isCurrent()) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      const error: DomainError = { scope: "load", message };
      publish(setError, error);
      input.reportFeedback({ workspaceCwd: cwd.trim(), surface, identity: channelId, scope: "load", message });
    }
    return { isCurrent, publish, report };
  }

  function clearScopedFeedback(surface: WorkspaceFeedbackSurface, identity: string): void {
    input.clearFeedback(surface, identity, input.cwd.trim());
  }

  function reportScopedFeedback(
    surface: WorkspaceFeedbackSurface,
    identity: string,
    scope: WorkspaceFeedbackScope,
    caught: unknown,
  ): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    setError({ scope, message });
    input.reportFeedback({ workspaceCwd: input.cwd.trim(), surface, identity, scope, message });
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
    const read = beginChannelPanelRead(`tasks:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setTasks, []);
      read.publish(setTasksLoading, false);
      return;
    }

    read.publish(setTasksLoading, true);
    try {
      clearScopedFeedback("task", channelId);
      read.publish(setError, undefined);
      const response = await listTasks(cwd, channelId);
      read.publish(setTasks, response.tasks);
      read.publish(setSelectedTaskId, (current) => {
        if (response.tasks.some((task) => task.id === current)) {
          return current;
        }
        return "";
      });
    } catch (caught) {
      read.report("task", caught);
    } finally {
      read.publish(setTasksLoading, false);
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
    const read = beginChannelPanelRead(`channelCouncil:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelCouncilPolicy, undefined);
      read.publish(setChannelEffectiveCouncil, undefined);
      read.publish(setChannelCouncilLoading, false);
      return;
    }

    read.publish(setChannelCouncilLoading, true);
    try {
      clearScopedFeedback("workspace", channelId);
      read.publish(setError, undefined);
      const [policyResponse, effectiveResponse] = await Promise.all([
        getChannelCouncilPolicy(cwd, channelId),
        getChannelEffectiveCouncil(cwd, channelId),
      ]);
      read.publish(setChannelCouncilPolicy, policyResponse.policy);
      read.publish(setChannelEffectiveCouncil, effectiveResponse.effectiveCouncil);
    } catch (caught) {
      read.report("workspace", caught);
    } finally {
      read.publish(setChannelCouncilLoading, false);
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
    if (!cwd || !channelId || (threadId && isChannelSessionDraft(threadId))) {
      setChannelMessages([]);
      setChannelConversationItems([]);
      setChannelRuntimeMetricsState({ owner: channelReadOwnerRef.current });
      setChannelTurnContextAssignmentState({ owner: channelReadOwnerRef.current, assignments: [] });
      channelReadEpochRef.current.invalidate();
      channelInputPageRef.current = undefined;
      setChannelUserInputState({ owner: channelReadOwnerRef.current, items: [] });
      setChannelReasoningSummaryState({ owner: channelReadOwnerRef.current, items: [] });
      setChannelContextCompactionState({ owner: channelReadOwnerRef.current, items: [] });
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
      setChannelContextCompactionState({ owner: readOwner, items: hydrated.contextCompactions ?? [] });
      setChannelConversationRefreshToken(current => current + 1);
      setChannelRuntimeMetricsState({ owner: readOwner, metrics: response.runtimeMetrics });
      const messagesChanged = !channelMessagesEqual(channelMessages, page.messages);
      const cached = channelMessageCacheRef.current.get(readOwner);
      const reconciled = reconcileChannelSessionMessageCache(cached, page, hydrated.conversationItems);
      setChannelMessages(current => channelMessagesEqual(current, reconciled.messages) ? current : reconciled.messages);
      setChannelConversationItems(reconciled.items);
      setChannelGeneratedMedia(reconciled.generatedMedia);
      setChannelMessagesHasOlder(reconciled.hasOlder);
      setChannelItemsBeforeSequence(reconciled.before);
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
      setChannelContextCompactionState({ owner: readOwner, items: hydrated.contextCompactions ?? [] });
      setChannelRuntimeMetricsState({ owner: readOwner, metrics: response.runtimeMetrics });
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
    const read = beginChannelPanelRead(`executionProposals:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelExecutionProposals, []);
      return;
    }

    try {
      clearScopedFeedback("workflow", channelId);
      read.publish(setError, undefined);
      const response = await listChannelExecutionProposals(cwd, channelId);
      read.publish(setChannelExecutionProposals, response.proposals);
    } catch (caught) {
      read.report("workflow", caught);
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
    const read = beginChannelPanelRead(`files:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelAttachments, []);
      read.publish(setChannelLinkPreviews, []);
      read.publish(setChannelFilesLoading, false);
      return;
    }

    read.publish(setChannelFilesLoading, true);
    try {
      clearScopedFeedback("dock", channelId);
      read.publish(setError, undefined);
      const [attachmentsResponse, linksResponse] = await Promise.all([
        listChannelAttachments(cwd, channelId),
        listChannelLinkPreviews(cwd, channelId),
      ]);
      read.publish(setChannelAttachments, attachmentsResponse.attachments);
      read.publish(setChannelLinkPreviews, linksResponse.linkPreviews);
    } catch (caught) {
      read.report("dock", caught);
    } finally {
      read.publish(setChannelFilesLoading, false);
    }
  }


  async function refreshChannelRunArtifacts(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    const read = beginChannelPanelRead(`runArtifacts:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelArtifactsByRun, {});
      read.publish(setChannelArtifactErrorsByRun, {});
      read.publish(setChannelRunArtifactsLoading, false);
      return;
    }
    if (channelRuns.length === 0) {
      read.publish(setChannelRunArtifactsLoading, false);
      return;
    }

    read.publish(setChannelRunArtifactsLoading, true);
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
    if (!read.isCurrent()) {
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
    read.publish(setChannelArtifactsByRun, nextArtifacts);
    read.publish(setChannelArtifactErrorsByRun, nextErrors);
    read.publish(setChannelRunArtifactsLoading, false);
  }


  async function refreshChannelExecutionActions(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    const read = beginChannelPanelRead(`executionActions:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelExecutionActions, []);
      read.publish(setChannelExecutionActionError, "");
      return;
    }
    if (channelRuns.length === 0) {
      read.publish(setChannelExecutionActions, []);
      read.publish(setChannelExecutionActionError, "");
      return;
    }

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
    if (!read.isCurrent()) {
      return;
    }

    const nextActions = new Map<string, ExecutionAction>();
    const errors = new Set<string>();
    read.publish(setChannelWorkflowSteps, current => mergeWorkflowNarration(current, narrationResults.flatMap(result => result.steps ?? [])));
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
    read.publish(setChannelExecutionActions, [...nextActions.values()].sort((a, b) =>
      (b.completedAt ?? b.executedAt ?? b.resolvedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.executedAt ?? a.resolvedAt ?? a.createdAt) ||
      b.id.localeCompare(a.id),
    ));
    read.publish(setChannelExecutionActionError, errors.size > 0 ? [...errors][0] : "");
  }


  async function refreshChannelActivityTransitions(
    cwd = input.cwd.trim(),
    channelId = selectedChannelId,
    channelRuns: readonly RunSession[] = [],
  ): Promise<void> {
    const read = beginChannelPanelRead(`activityTransitions:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      channelActivityTransitionsLoadedScopeRef.current = "";
      read.publish(setChannelStateTransitions, []);
      read.publish(setChannelActivityTransitionError, "");
      read.publish(setChannelActivityTransitionsLoading, false);
      return;
    }

    const scopeKey = `${cwd}:${channelId}`;
    const entities = buildChannelTransitionEntities(channelId, tasks, channelRuns, channelWorkflows, channelWorkflowSteps);
    if (entities.length === 0) {
      channelActivityTransitionsLoadedScopeRef.current = scopeKey;
      read.publish(setChannelStateTransitions, []);
      read.publish(setChannelActivityTransitionError, "");
      read.publish(setChannelActivityTransitionsLoading, false);
      return;
    }

    read.publish(setChannelActivityTransitionsLoading, channelActivityTransitionsLoadedScopeRef.current !== scopeKey);
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
    if (!read.isCurrent()) {
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

    read.publish(setChannelStateTransitions, [...nextTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    read.publish(setChannelActivityTransitionError, errors.size > 0 ? [...errors][0] : "");
    channelActivityTransitionsLoadedScopeRef.current = scopeKey;
    read.publish(setChannelActivityTransitionsLoading, false);
  }


  async function refreshChannelGovernanceNotifications(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    const read = beginChannelPanelRead(`governanceNotifications:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelGovernanceNotifications, []);
      read.publish(setChannelGovernanceNotificationsLoading, false);
      return;
    }

    read.publish(setChannelGovernanceNotificationsLoading, true);
    try {
      const response = await listGovernanceNotifications(cwd, {
        surface: "channel",
        channelId,
        limit: 50,
      });
      read.publish(setChannelGovernanceNotifications, response.notifications);
    } catch {
      read.publish(setChannelGovernanceNotifications, []);
    } finally {
      read.publish(setChannelGovernanceNotificationsLoading, false);
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
    const read = beginChannelPanelRead(`messageRouteDecisions:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelMessageRouteDecisions, []);
      return;
    }

    try {
      clearScopedFeedback("protocol", channelId);
      read.publish(setError, undefined);
      const response = await listChannelMessageRouteDecisions(cwd, channelId, { limit: channelMessageRouteDecisionLimit });
      read.publish(setChannelMessageRouteDecisions, response.decisions);
    } catch (caught) {
      read.report("protocol", caught);
    }
  }


  async function refreshChannelIntentDecisions(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    const read = beginChannelPanelRead(`intentDecisions:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      read.publish(setChannelIntentDecisions, []);
      return;
    }

    try {
      clearScopedFeedback("protocol", channelId);
      read.publish(setError, undefined);
      const response = await listChannelIntentDecisions(cwd, channelId, { limit: channelIntentDecisionLimit });
      read.publish(setChannelIntentDecisions, response.decisions);
    } catch (caught) {
      read.report("protocol", caught);
    }
  }


  async function refreshChannelProtocol(channelId = selectedChannelId): Promise<void> {
    const cwd = input.cwd.trim();
    const read = beginChannelPanelRead(`protocol:${cwd}:${channelId}`, cwd, channelId);
    if (!read.isCurrent()) return;
    if (!cwd || !channelId) {
      resetChannelProtocol();
      return;
    }

    read.publish(setChannelProtocolLoading, true);
    try {
      clearScopedFeedback("protocol", channelId);
      read.publish(setError, undefined);
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
      if (!read.isCurrent()) return;
      const workflowSteps = await loadWorkflowSteps(cwd, workflowsResponse.workflows);
      read.publish(setChannelBrief, briefResponse.brief);
      read.publish(setChannelCollaborationProtocol, protocolResponse);
      read.publish(setChannelDecisions, decisionsResponse.decisions);
      read.publish(setChannelMessageRouteDecisions, routeDecisionsResponse.decisions);
      read.publish(setChannelIntentDecisions, intentDecisionsResponse.decisions);
      read.publish(setChannelHandoffs, handoffsResponse.handoffs);
      read.publish(setChannelContextSummaries, summariesResponse.contextSummaries);
      read.publish(setChannelWorkflows, workflowsResponse.workflows);
      read.publish(setChannelWorkflowSteps, current => mergeWorkflowStepReadModels(current, workflowSteps));
    } catch (caught) {
      read.report("protocol", caught);
    } finally {
      read.publish(setChannelProtocolLoading, false);
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
    setChannelContextCompactionState({ owner: channelReadOwnerRef.current, items: [] });
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
    setChannelContextCompactionState({ owner: "", items: [] });
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
      channelRuntimeMetrics,
      channelTurnContextAssignments: channelTurnContextAssignmentState.owner === channelReadOwner
        ? channelTurnContextAssignmentState.assignments
        : [],
      channelUserInputs: channelUserInputState.owner === channelReadOwner ? channelUserInputState.items : [],
      channelReasoningSummaries: channelReasoningSummaryState.owner === channelReadOwner
        ? channelReasoningSummaryState.items
        : [],
      channelConversationRefreshToken,
      channelContextCompactions: channelContextCompactionState.owner === channelReadOwner ? channelContextCompactionState.items : [],
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
      setSelectedTaskId: selectTaskExplicitly,
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
