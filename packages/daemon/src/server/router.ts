import type { IncomingMessage, ServerResponse } from "node:http";
import { defaultProviderTemplates, executeExternalWorkAction } from "@ling-stack/core";
import type { AiTeammate, RunSession, RunStore, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import {
  handleAutomationItem,
  handleAutomationDraftItem,
  handleAutomationDraftsCollection,
  handleAutomationRunItem,
  handleAutomationRunsCollection,
  handleAutomationSchedulerCollection,
  handleAutomationSchedulerStart,
  handleAutomationSchedulerStop,
  handleAutomationsCollection,
  parseAutomationRoute,
  parseAutomationDraftRoute,
  parseAutomationRunRoute,
} from "../features/automations/routes.js";
import {
  handleAiCouncilHealth,
  handleAiCouncilClone,
  handleAiCouncilItem,
  handleAiCouncilMembers,
  handleAiCouncilsCollection,
  handleChannelCouncilPolicy,
  handleChannelEffectiveCouncil,
} from "../features/ai-councils/routes.js";
import {
  handleChannelAttachmentItem,
  handleChannelAttachmentsCollection,
} from "../features/channels/attachments.js";
import { createAiChannelReply } from "../features/channels/ai-replies.js";
import { getChannelMessageView } from "../features/channels/conversation-item-messages.js";
import { handleChannelCollaborationProtocol } from "../features/channels/collaboration-protocol.js";
import { handleChannelPlaybookCandidates } from "../features/channels/playbooks.js";
import { handleChannelLinkPreviewItem, handleChannelLinkPreviewsCollection } from "../features/channels/link-previews.js";
import { handleChannelMessagesCollection, handleChannelMessageStream, handleLingAgentChannelMessage } from "../features/channels/messages.js";
import { confirmChannelExecutionProposalWorkflow } from "../features/channels/proposal-workflows.js";
import { handleChannelTeamExpertsProjection } from "../features/channels/team-experts.js";
import { handleChannelTeamMetricsProjection } from "../features/channels/team-metrics.js";
import { handleChannelTerminalReports, handleTerminalReportItem, handleTerminalReportsCollection } from "../features/channels/terminal-report-routes.js";
import { maybeScheduleRunTerminalReport } from "../features/channels/terminal-report-coordinator.js";
import { handleChannelTeamAuthorityLedger } from "../features/channels/team-authority-ledger.js";
import { handleChannelTeamPatterns } from "../features/channels/team-patterns.js";
import {
  handleChannelTeamEvaluations,
  handleChannelTeamSnapshots,
} from "../features/channels/team-snapshots.js";
import {
  handleWorkflowHandoffIntentAccept,
  handleWorkflowHandoffIntentItem,
  handleWorkflowHandoffIntentsCollection,
  handleWorkflowSelectorDecisionItem,
  handleWorkflowSelectorDecisionsCollection,
} from "../features/channels/workflow-coordination-routes.js";
import {
  cancelChannelWorkflow,
  finalizeOrchestratedWorkflowStepRun,
  orchestrateChannelWorkflow,
  retryChannelWorkflowStep,
  syncWorkflowApprovalDecision,
  type StartOrchestratedWorkflowStepRun,
} from "../features/channels/orchestrator.js";
import {
  handleChannelBrief,
  handleChannelBranchItem,
  handleChannelBranchesCollection,
  handleChannelContextSummariesCollection,
  handleChannelContextSummaryItem,
  handleChannelDecisionItem,
  handleChannelDecisionsCollection,
  handleChannelExecutionProposalItem,
  handleChannelExecutionProposalsCollection,
  handleChannelHandoffItem,
  handleChannelHandoffsCollection,
  handleChannelItem,
  handleChannelIntentDecisionsCollection,
  handleChannelMessageRouteDecisionsCollection,
  handleChannelProposedPlans,
  handleChannelsCollection,
} from "../features/channels/routes.js";
import { assertChannelWorkspaceReady, handleChannelWorkspace } from "../features/channels/workspace.js";
import {
  handleChannelCollaborationCardsCollection,
  handleChannelWorkflowCollaborationCard,
  handleChannelWorkflowEvidence,
  handleChannelWorkflowFromHandoff,
  handleChannelWorkflowItem,
  handleChannelWorkflowStepEvidence,
  handleChannelWorkflowStepItem,
  handleChannelWorkflowStepStartRoute,
  handleChannelWorkflowStepsCollection,
  handleChannelWorkflowsCollection,
} from "../features/channels/workflows.js";
import {
  handleGetWorkflowWorkspaceChanges,
  handleMutateWorkflowWorkspaceChanges,
} from "../features/channels/workflow-workspace-change-recovery.js";
import { createWorkflowStepContextArtifact } from "../features/channels/workflow-step-packets.js";
import {
  handleExternalWorkActionCancel,
  handleExternalWorkActionDetail,
  handleExternalWorkActionExecute,
  handleExternalWorkActionPropose,
  handleExternalWorkActionsCollection,
} from "../features/external-work/actions.js";
import {
  handleExternalGitHubBackgroundStart,
  handleExternalWorkBackgroundCollection,
  handleExternalWorkBackgroundStop,
} from "../features/external-work/background.js";
import { handleExternalWorkCollection, handleExternalWorkItem, handleExternalWorkRoute } from "../features/external-work/routes.js";
import {
  handleExternalGitHubCiTriage,
  handleExternalWorkCiTriageItem,
  handleExternalWorkCiTriageRun,
} from "../features/external-work/ci-triage.js";
import { handleExternalWorkStatus } from "../features/external-work/status.js";
import {
  handleExternalWorkSecretConfigure,
  handleExternalWorkSecretDelete,
  handleExternalWorkWorkflowConfigure,
} from "../features/external-work/workflow.js";
import { handleControlPlaneRoute } from "../features/control-plane/routes.js";
import { handleComputerUseRoute } from "../features/computer-use/routes.js";
import { handleExternalGitHubImport, handleExternalLinearImport } from "../features/external-work/imports.js";
import {
  handleExternalGitHubPoll,
  handleExternalLinearPoll,
  handleExternalWorkReconcile,
} from "../features/external-work/sync.js";
import {
  handleListUsedMemoryEvents,
  handleMemoryCollection,
  handleMemoryConsolidationJobs,
  handleMemoryExport,
  handleMemoryHealth,
  handleMemoryImport,
  handleMemoryItem,
  handleMemoryPromotionInbox,
  handleMemoryRecall,
  handleMemoryReviewAction,
  handleMemoryReviewPolicy,
} from "../features/memory/routes.js";
import {
  handleGovernanceNotificationRoute,
  parseGovernanceNotificationRoute,
} from "../features/governance-notifications/routes.js";
import { handleConversationAttachmentsCollection, handleConversationDetail, handleConversationStream, startConversationReplacementRun } from "../features/conversations/routes.js";
import { startDetachedRunAndResolveReady } from "../features/runs/detached.js";
import { handleConversationMessageEdit } from "../features/conversations/message-edits.js";
import { dispatchMediaJobExecution, handleRunMediaJob, syncMediaJobForApprovalDecision, type RunMediaJobHooks } from "../features/media/executor.js";
import { handleMediaJobRoute, handleMediaJobsCollection } from "../features/media/routes.js";
import {
  handleMediaProjectRoute,
  handleMediaProjectsCollection,
  handleMediaSceneRoute,
  handleMediaSceneRunRoute,
  parseMediaProjectRoute,
  parseMediaSceneRoute,
  parseMediaSceneRunRoute,
} from "../features/media/production-routes.js";
import {
  handleMediaWorkflowAnalyze,
  handleMediaWorkflowConnectionsCollection,
  handleMediaWorkflowImport,
  handleMediaWorkflowRoute,
  handleMediaWorkflowsCollection,
  parseMediaWorkflowRoute,
} from "../features/media/workflows/workflow-routes.js";
import { handleMcpServerItem, handleMcpServersCollection, handleMcpToolsCollection } from "../features/mcp/routes.js";
import {
  handlePluginItem,
  handlePluginPackageItem,
  handlePluginSourcesCollection,
  handlePluginsCollection,
} from "../features/plugins/routes.js";
import { handleCuaDriverLeaseRoute } from "../features/plugins/cua-driver-lease-routes.js";
import { handleWorkItemRoute, handleWorkItemsCollection } from "../features/work-items/routes.js";
import { handleWorkspaceDirectorySelect, handleWorkspaceTerminalCommand, handleWorkspaceTerminalProfile } from "../features/workspace-directory/routes.js";
import {
  handleProviderDraftCheck,
  handleProviderItem,
  handleProviderModelImport,
  handleProviderModelsProbe,
  handleProvidersCollection,
  handleSecretStatus,
} from "../features/providers/routes.js";
import { handleUserProfile } from "../features/profile/routes.js";
import { ensureRunCancelled } from "../features/runs/cancellation.js";
import { handleExecutionActionsCollection } from "../features/runs/execution-actions.js";
import {
  createDetachedRunExecutionSink,
  createSseRunExecutionSink,
  executeRunRequest,
  type RunExecutionSink,
} from "../features/runs/orchestrator.js";
import type { RunRequest } from "../features/runs/schemas.js";
import {
  handleRunInterventionItem,
  handleRunInterventionPromote,
  handleRunInterventions,
  maybeQueueGoalContinuation,
  maybeStartNextRunInterventionContinuation,
} from "../features/runs/interventions.js";
import {
  handleGetShellSnapshot,
  handleListShellSnapshots,
} from "../features/runs/shell-snapshots.js";
import {
  handleApprovalItem,
  handleApprovalPolicy,
  handleApprovalsCollection,
  handleCancelRun,
  handleGetArtifact,
  handleGetArtifactContent,
  handleGetArtifactPreview,
  handleGetRun,
  handleGetRunEvents,
  handleListRunArtifacts,
  handleListRuns,
  handleRun,
} from "../features/runs/routes.js";
import { handleLingThreadItem, handleLingThreadsCollection } from "../features/runs/thread-routes.js";
import { handleToolLoadRequestsCollection, handleToolSurfacesCollection } from "../features/runs/tool-surfaces.js";
import { handleTraceItem, handleTracesCollection } from "../features/runs/traces-routes.js";
import { resolveProviderForRun } from "../features/runs/providers.js";
import { handleGetWorkspaceChanges } from "../features/previews/workspace-changes.js";
import {
  handleGetWorkspaceFileContent,
  handleGetWorkspaceFileOpenIcon,
  handleGetWorkspaceFileOpenOptions,
  handlePostWorkspaceFileOpen,
} from "../features/previews/workspace-file-actions.js";
import { handleGetWorkspaceFilePreview } from "../features/previews/workspace-file-preview.js";
import {
  handleGetRunWorkspaceChanges,
  handleMutateRunWorkspaceChanges,
} from "../features/runs/workspace-change-recovery.js";
import { handleEffectiveConfig, handleWorkspaceSettings } from "../features/settings/routes.js";
import { handleSkillRoute } from "../features/skills/routes.js";
import { handleTaskItem, handleTaskRun, handleTasksCollection } from "../features/tasks/routes.js";
import { materializeTaskAttachmentsForPrompt } from "../features/tasks/task-attachments.js";
import {
  DirectReplyControlService,
  handleTeammateDirectInterventionCancel,
  handleTeammateDirectInterventionPromote,
  handleTeammateDirectInterventions,
  handleTeammateDirectReplyCancel,
  handleTeammateDirectRuntime,
} from "../features/teammates/direct-controls.js";
import { handleTeammateDirectLinkPreviews } from "../features/teammates/direct-link-previews.js";
import { handleTeammateDirectMessagesCollection, handleTeammateDirectMessageStream, handleTeammateDirectThread } from "../features/teammates/direct-messages.js";
import { createAiTeammateDirectReply } from "../features/teammates/direct-replies.js";
import { ensureDirectWorkspaceReady, handleTeammateDirectWorkspace } from "../features/teammates/direct-workspace.js";
import { handleTeammateAvatar, handleTeammateDirectAttachments, handleTeammateHardDelete } from "../features/teammates/private-attachments.js";
import {
  handleTeammateActivity,
  handleTeammateChannelMemberships,
  handleTeammateItem,
  handleTeammateMcpBindings,
  handleTeammateMemoryScopes,
  handleTeammatePersonaDraft,
  handleTeammateSkillBindings,
  handleTeammateTasks,
  handleTeammatesCollection,
} from "../features/teammates/routes.js";
import {
  handleGetRuntime,
  handleGetRuntimeSupervisor,
  handleGetRunnerReadiness,
  handleListResourceLeases,
  handleListRuntimeExtensions,
  handleListRuntimeActive,
  handleListRuntimeSemaphores,
  handleListRuntimeStuck,
  handleListRunners,
  handleListStateTransitions,
  handleListWorkUnits,
  handleRuntimeSettings,
  handleWorkUnitRoute,
} from "../runtime/routes.js";
import {
  startRuntimeWorkUnit,
  transitionWorkUnitTerminal,
} from "../runtime/work-units.js";
import {
  matchSingleSegmentRoute,
  parseRunnerReadinessRoute,
  parseMemoryRoute,
  parseApprovalRoute,
  parseArtifactRoute,
  parseAiCouncilRoute,
  parseChannelAttachmentRoute,
  parseChannelContextSummaryRoute,
  parseChannelDecisionRoute,
  parseChannelExecutionProposalRoute,
  parseChannelHandoffRoute,
  parseChannelLinkPreviewRoute,
  parseChannelRoute,
  parseChannelWorkflowRoute,
  parseWorkflowHandoffIntentRoute,
  parseWorkflowSelectorDecisionRoute,
  parseExternalWorkActionRoute,
  parseExternalWorkBackgroundStopRoute,
  parseExternalWorkCiTriageItemRoute,
  parseExternalWorkCiTriageRunRoute,
  parseExternalWorkRoute,
  parseLingThreadRoute,
  parseManagedPluginRoute,
  parsePluginPackageRoute,
  parseMcpServerRoute,
  parseMediaJobRoute,
  parseProviderRoute,
  parseRunInterventionRoute,
  parseRunRoute,
  parseSkillRoute,
  parseTaskRoute,
  parseTeammateDirectInterventionRoute,
  parseTeammateDirectReplyRoute,
  parseTeammateRoute,
  parseTerminalReportRoute,
  parseTraceRoute,
  parseWorkItemRoute,
  parseWorkUnitRoute,
} from "./routes.js";
import { RunControlService } from "../run-control.js";
import { allowLocalWorkspaceRequest } from "../shared/local-workspace-access.js";
import { setCorsHeaders, writeJson } from "../shared/response.js";
import { handleStartupStatus } from "../startup/routes.js";

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (await context.remoteAccess.handleManagementRequest(request, response)) {
    return;
  }
  const {
    config,
    runnerRegistry,
    extensionRegistry,
    storeRegistry,
    activeRuns,
    activeDirectReplies,
    channelReplyDispatchCoordinator,
    runtimeSupervisor,
    secretResolver,
    externalSecretStore,
    mcpBroker,
    externalWorkFetch,
    imageVisionSummarizer,
    backgroundSchedulers,
    automationSchedulers,
    controlPlaneEvents,
    providerImportPreflight,
    providerStartupRefresh,
    startupState,
    computerUsePreviews,
    cuaDriverActivationService,
  } = context;
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const maybeContinueRunInterventions = async (terminalRun: RunSession): Promise<void> => {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const workspaceCwd = readRunWorkspaceCwd(terminalRun) ?? terminalRun.cwd;
    const store = storeRegistry.findStoreForRun(sourceRunId, workspaceCwd) ?? storeRegistry.findStoreForRun(terminalRun.id, workspaceCwd);
    if (!store) {
      return;
    }
    maybeScheduleRunTerminalReport(store, terminalRun.id, { linkedRunId: terminalRun.id });
    const goalContinuation = maybeQueueGoalContinuation({
      terminalRun,
      store,
      activeRuns,
    });
    await maybeStartNextRunInterventionContinuation({
      sourceRunId: goalContinuation?.sourceRunId ?? sourceRunId,
      terminalRun,
      store,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      controlPlaneEvents,
      startupState,
      computerUsePreviews,
    });
  };
  const startTeammateDirectRun = async (runRequest: RunRequest, sink: RunExecutionSink): Promise<string | undefined> =>
    executeRunRequest(
      runRequest,
      sink,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      {
        afterRunTerminal: maybeContinueRunInterventions,
        controlPlaneEvents,
        startupState,
        computerUsePreviews,
      },
    );
  const directReplyControl = new DirectReplyControlService({
    startRun: startTeammateDirectRun,
    activeRuns,
    secretResolver,
    activeDirectReplies,
    runControl: new RunControlService(),
    providerStartupRefresh,
    imageVisionSummarizer,
  });

  const mediaJobHooks: RunMediaJobHooks = {
    startRuntimeWorkUnit: (input) => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
    transitionRuntimeWorkUnitTerminal: (input) => {
      transitionWorkUnitTerminal(input.store, {
        workUnitId: input.workUnitId,
        attemptId: input.attemptId,
        event: input.event,
        attemptStatus: input.attemptStatus,
        runtimeEventType: input.runtimeEventType,
        actor: input.actor,
        now: input.now,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
    },
  };
  const launchMediaJob = (cwd: string, mediaJobId: string): void => {
    dispatchMediaJobExecution({ cwd, storeRegistry, secretResolver, mediaJobId, hooks: mediaJobHooks });
  };
  if (await handleCuaDriverLeaseRoute(request, response, context)) {
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "ling-stack-daemon",
      defaultWorkspaceCwd: config.defaultWorkspaceCwd,
      readiness: startupState.snapshot(config.defaultWorkspaceCwd)?.state ?? "starting",
      features: {
        channels: {
          autoRoute: config.channels.autoRoute === true,
          intentSelector: config.channels.intentSelector === true,
          teamObserverBus: config.channels.teamObserverBus === true,
          terminalReports: config.channels.terminalReports === true,
        },
        transports: {
          providerWebSocketFallback: config.transports.providerWebSocketFallback === true,
          localWebSocketRpc: config.transports.localWebSocketRpc === true,
        },
      },
    });
    return;
  }

  if (await handleControlPlaneRoute(request, response, context)) {
    return;
  }

  if (await handleComputerUseRoute(request, response, context)) {
    return;
  }

  if (url.pathname === "/startup/status" || url.pathname === "/startup/refresh") {
    await handleStartupStatus(request, response, context);
    return;
  }

  if (url.pathname === "/config/effective") {
    await handleEffectiveConfig(request, response, config, storeRegistry, runnerRegistry);
    return;
  }

  if (url.pathname === "/channels") {
    await handleChannelsCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/terminal-reports") {
    await handleTerminalReportsCollection(request, response, config, storeRegistry);
    return;
  }

  const terminalReportRoute = parseTerminalReportRoute(url.pathname);
  if (terminalReportRoute) {
    await handleTerminalReportItem(request, response, config, storeRegistry, terminalReportRoute.reportId);
    return;
  }

  if (url.pathname === "/ai-councils") {
    await handleAiCouncilsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/ai-councils/health") {
    await handleAiCouncilHealth(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/workspace-settings") {
    await handleWorkspaceSettings(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/workspace-directory/select") {
    await handleWorkspaceDirectorySelect(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/workspace-terminal/profile") {
    await handleWorkspaceTerminalProfile(request, response, config);
    return;
  }

  if (url.pathname === "/workspace-terminal/commands") {
    await handleWorkspaceTerminalCommand(request, response, config);
    return;
  }

  if (url.pathname === "/profile") {
    await handleUserProfile(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/teammates") {
    await handleTeammatesCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/tasks") {
    await handleTasksCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/providers") {
    await handleProvidersCollection(request, response, config, storeRegistry, secretResolver, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/providers/import-models") {
    await handleProviderModelImport(request, response, config, storeRegistry, secretResolver, controlPlaneEvents, providerImportPreflight);
    return;
  }

  if (url.pathname === "/mcp/servers") {
    await handleMcpServersCollection(request, response, config, storeRegistry, secretResolver, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/mcp/tools") {
    handleMcpToolsCollection(request, response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/automations") {
    await handleAutomationsCollection(request, response, config, storeRegistry, automationSchedulers);
    return;
  }

  if (url.pathname === "/automation-runs") {
    await handleAutomationRunsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/automation-drafts") {
    await handleAutomationDraftsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/automations/scheduler/start") {
    await handleAutomationSchedulerStart(request, response, config, automationSchedulers);
    return;
  }

  if (url.pathname === "/automations/scheduler") {
    await handleAutomationSchedulerCollection(request, response, config, automationSchedulers);
    return;
  }

  if (url.pathname === "/automations/scheduler/stop") {
    await handleAutomationSchedulerStop(request, response, config, automationSchedulers);
    return;
  }

  const automationRoute = parseAutomationRoute(url.pathname);
  if (automationRoute) {
    await handleAutomationItem(
      request,
      response,
      config,
      storeRegistry,
      automationRoute,
      async (runRequest, hooks) =>
        await startDetachedRunAndResolveReady((onRunReady) =>
          executeRunRequest(
            runRequest,
            createDetachedRunExecutionSink(),
            runnerRegistry,
            storeRegistry,
            activeRuns,
            runtimeSupervisor,
            secretResolver,
            mcpBroker,
            {
              onRunReady: (runId) => {
                hooks.onRunReady?.(runId);
                onRunReady(runId);
              },
              afterRunTerminal: async (terminalRun) => {
                await hooks.afterRunTerminal?.(terminalRun);
                await maybeContinueRunInterventions(terminalRun);
              },
              controlPlaneEvents,
              startupState,
              computerUsePreviews,
            },
          )),
      automationSchedulers,
    );
    return;
  }

  const automationDraftRoute = parseAutomationDraftRoute(url.pathname);
  if (automationDraftRoute) {
    await handleAutomationDraftItem(request, response, config, storeRegistry, automationSchedulers, automationDraftRoute);
    return;
  }

  const automationRunRoute = parseAutomationRunRoute(url.pathname);
  if (automationRunRoute) {
    await handleAutomationRunItem(request, response, config, storeRegistry, activeRuns, automationRunRoute);
    return;
  }

  if (url.pathname === "/plugins") {
    await handlePluginsCollection(
      request,
      response,
      config,
      storeRegistry,
      extensionRegistry,
      mcpBroker,
      context.lockedComputerControl,
    );
    return;
  }

  if (url.pathname === "/plugins/sources") {
    await handlePluginSourcesCollection(request, response, config);
    return;
  }

  const pluginPackageRoute = parsePluginPackageRoute(url.pathname);
  if (pluginPackageRoute) {
    await handlePluginPackageItem(request, response, config, pluginPackageRoute.pluginId);
    return;
  }

  const managedPluginRoute = parseManagedPluginRoute(url.pathname);
  if (managedPluginRoute) {
    await handlePluginItem(
      request,
      response,
      config,
      storeRegistry,
      extensionRegistry,
      mcpBroker,
      secretResolver,
      cuaDriverActivationService,
      managedPluginRoute,
    );
    return;
  }

  if (url.pathname === "/provider-check") {
    await handleProviderDraftCheck(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/provider-models") {
    await handleProviderModelsProbe(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/media-jobs") {
    await handleMediaJobsCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/media-projects") {
    await handleMediaProjectsCollection(request, response, config, storeRegistry);
    return;
  }

  const mediaWorkflowRouteContext = {
    request,
    response,
    config,
    storeRegistry,
    secretResolver,
    secretStore: externalSecretStore,
    launchMediaJob,
  };
  if (url.pathname === "/media-workflow-connections") {
    await handleMediaWorkflowConnectionsCollection(mediaWorkflowRouteContext);
    return;
  }
  if (url.pathname === "/media-workflows") {
    await handleMediaWorkflowsCollection(mediaWorkflowRouteContext);
    return;
  }
  if (url.pathname === "/media-workflows/analyze") {
    await handleMediaWorkflowAnalyze(mediaWorkflowRouteContext);
    return;
  }
  if (url.pathname === "/media-workflows/import") {
    await handleMediaWorkflowImport(mediaWorkflowRouteContext);
    return;
  }

  if (url.pathname === "/external-work/github/import") {
    await handleExternalGitHubImport(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/linear/import") {
    await handleExternalLinearImport(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/status") {
    await handleExternalWorkStatus(request, response, config, storeRegistry, secretResolver, backgroundSchedulers);
    return;
  }

  if (url.pathname === "/external-work/workflow/configure") {
    await handleExternalWorkWorkflowConfigure(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/secrets/configure") {
    await handleExternalWorkSecretConfigure(request, response, config, storeRegistry, secretResolver, externalSecretStore);
    return;
  }

  if (url.pathname === "/external-work/secrets/delete") {
    await handleExternalWorkSecretDelete(request, response, config, storeRegistry, secretResolver, externalSecretStore);
    return;
  }

  if (url.pathname === "/external-work/github/poll") {
    await handleExternalGitHubPoll(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/linear/poll") {
    await handleExternalLinearPoll(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/github/background/start") {
    await handleExternalGitHubBackgroundStart(request, response, config, storeRegistry, backgroundSchedulers);
    return;
  }

  if (url.pathname === "/external-work/background") {
    await handleExternalWorkBackgroundCollection(request, response, config, backgroundSchedulers);
    return;
  }

  const externalWorkBackgroundStopRoute = parseExternalWorkBackgroundStopRoute(url.pathname);
  if (externalWorkBackgroundStopRoute) {
    await handleExternalWorkBackgroundStop(request, response, config, backgroundSchedulers, externalWorkBackgroundStopRoute.schedulerId);
    return;
  }

  if (url.pathname === "/external-work/github/ci/triage") {
    await handleExternalGitHubCiTriage(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  const externalWorkCiTriageItemRoute = parseExternalWorkCiTriageItemRoute(url.pathname);
  if (externalWorkCiTriageItemRoute) {
    await handleExternalWorkCiTriageItem(request, response, config, storeRegistry, externalWorkCiTriageItemRoute.triageId);
    return;
  }

  const externalWorkCiTriageRunRoute = parseExternalWorkCiTriageRunRoute(url.pathname);
  if (externalWorkCiTriageRunRoute) {
    await handleExternalWorkCiTriageRun(
      request,
      response,
      config,
      storeRegistry,
      externalWorkCiTriageRunRoute.triageId,
      async (runRequest, runResponse, hooks) => {
        await executeRunRequest(
          runRequest,
          createSseRunExecutionSink(runResponse),
          runnerRegistry,
          storeRegistry,
          activeRuns,
          runtimeSupervisor,
          secretResolver,
          mcpBroker,
          {
            ...hooks,
            afterRunTerminal: maybeContinueRunInterventions,
            controlPlaneEvents,
            startupState,
            computerUsePreviews,
          },
        );
      },
    );
    return;
  }

  if (url.pathname === "/external-work/reconcile") {
    await handleExternalWorkReconcile(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/actions/propose") {
    await handleExternalWorkActionPropose(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/actions") {
    await handleExternalWorkActionsCollection(request, response, config, storeRegistry);
    return;
  }

  const externalWorkActionRoute = parseExternalWorkActionRoute(url.pathname);
  if (externalWorkActionRoute) {
    if (!externalWorkActionRoute.action) {
      await handleExternalWorkActionDetail(request, response, config, storeRegistry, externalWorkActionRoute.actionId);
      return;
    }
    if (externalWorkActionRoute.action === "cancel") {
      await handleExternalWorkActionCancel(request, response, config, storeRegistry, externalWorkActionRoute.actionId);
      return;
    }
    await handleExternalWorkActionExecute(
      request,
      response,
      config,
      storeRegistry,
      secretResolver,
      externalWorkFetch,
      externalWorkActionRoute.actionId,
      {
        startRuntimeWorkUnit: (input) => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
        appendArtifactRuntimeEvent: (input) => {
          input.store.appendRuntimeEvent({
            workUnitId: input.workUnitId,
            attemptId: input.attemptId,
            type: "artifact_created",
            actor: "system",
            ts: input.now,
            data: { artifactId: input.artifact.id, title: input.artifact.title, path: input.artifact.path },
          });
        },
        transitionRuntimeWorkUnitTerminal: (input) => {
          transitionWorkUnitTerminal(input.store, {
            workUnitId: input.workUnitId,
            attemptId: input.attemptId,
            event: input.event,
            attemptStatus: input.attemptStatus,
            runtimeEventType: input.runtimeEventType,
            actor: input.actor,
            now: input.now,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
          });
        },
        executeExternalWorkAction: async (input) => executeExternalWorkAction(input),
      },
    );
    return;
  }

  if (url.pathname === "/external-work") {
    await handleExternalWorkCollection(request, response, config, storeRegistry);
    return;
  }

  const externalWorkItemRoute = parseExternalWorkRoute(url.pathname);
  if (externalWorkItemRoute) {
    if (externalWorkItemRoute.action === "route") {
      await handleExternalWorkRoute(request, response, config, storeRegistry, externalWorkItemRoute.externalWorkId);
      return;
    }
    await handleExternalWorkItem(request, response, config, storeRegistry, externalWorkItemRoute.externalWorkId);
    return;
  }

  if (request.method === "GET" && url.pathname === "/provider-templates") {
    writeJson(response, 200, { templates: defaultProviderTemplates() });
    return;
  }

  if (url.pathname === "/approval-policy") {
    await handleApprovalPolicy(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/approvals") {
    handleApprovalsCollection(request, response, url, storeRegistry, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/execution-actions") {
    handleExecutionActionsCollection(request, response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/work-items") {
    await handleWorkItemsCollection(request, response, config, storeRegistry);
    return;
  }

  const workItemRoute = parseWorkItemRoute(url.pathname);
  if (workItemRoute) {
    await handleWorkItemRoute(
      request,
      response,
      config,
      storeRegistry,
      workItemRoute.workItemId,
      "action" in workItemRoute ? workItemRoute.action : undefined,
    );
    return;
  }

  if (url.pathname === "/threads") {
    await handleLingThreadsCollection(request, response, url, storeRegistry, config.maxBodyBytes);
    return;
  }

  if (url.pathname === "/conversations/attachments") {
    await handleConversationAttachmentsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/conversations/stream") {
    await handleConversationStream(request, response, config, storeRegistry, runnerRegistry, async (runRequest, sink) =>
      await executeRunRequest(
        runRequest,
        sink,
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        {
          afterRunTerminal: maybeContinueRunInterventions,
          controlPlaneEvents,
          startupState,
          computerUsePreviews,
        },
      ), imageVisionSummarizer);
    return;
  }

  const conversationRoute = parseConversationRoute(url.pathname);
  if (conversationRoute) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for conversation detail` });
      return;
    }
    handleConversationDetail(response, url, storeRegistry, conversationRoute.threadId);
    return;
  }

  if (url.pathname === "/traces") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /traces` });
      return;
    }
    handleTracesCollection(response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/tool-surfaces") {
    handleToolSurfacesCollection(request, response, url, storeRegistry, runnerRegistry);
    return;
  }

  const traceRoute = parseTraceRoute(url.pathname);
  if (traceRoute) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for trace routes` });
      return;
    }
    handleTraceItem(response, url, storeRegistry, traceRoute);
    return;
  }

  const lingThreadRoute = parseLingThreadRoute(url.pathname);
  if (lingThreadRoute) {
    await handleLingThreadItem(request, response, url, storeRegistry, lingThreadRoute, {
      maxBodyBytes: config.maxBodyBytes,
      startResumeRun: async (runRequest) =>
        await startDetachedRunAndResolveReady((onRunReady) =>
          executeRunRequest(
            runRequest,
            createDetachedRunExecutionSink(),
            runnerRegistry,
            storeRegistry,
            activeRuns,
            runtimeSupervisor,
            secretResolver,
            mcpBroker,
            {
              onRunReady,
              afterRunTerminal: maybeContinueRunInterventions,
              controlPlaneEvents,
              startupState,
              computerUsePreviews,
            },
          )),
      startForkRun: async (runRequest) =>
        await startDetachedRunAndResolveReady((onRunReady) =>
          executeRunRequest(
            runRequest,
            createDetachedRunExecutionSink(),
            runnerRegistry,
            storeRegistry,
            activeRuns,
            runtimeSupervisor,
            secretResolver,
            mcpBroker,
            {
              onRunReady,
              afterRunTerminal: maybeContinueRunInterventions,
              controlPlaneEvents,
              startupState,
              computerUsePreviews,
            },
          )),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/state-transitions") {
    handleListStateTransitions(response, url, storeRegistry);
    return;
  }

  const skillRoute = parseSkillRoute(url.pathname);
  if (
    url.pathname === "/skills" ||
    url.pathname === "/skills/refresh" ||
    url.pathname === "/skills/import-draft" ||
    url.pathname === "/skills/import-draft/optimization-preview" ||
    url.pathname === "/skills/sync/gstack/preview" ||
    url.pathname === "/skills/sync/gstack/apply" ||
    url.pathname === "/skills/sync/gstack/status" ||
    url.pathname === "/skills/sync/gstack/publish" ||
    url.pathname === "/skills/sync/gstack/refresh" ||
    url.pathname === "/skills/sync/gstack/check-updates" ||
    url.pathname === "/skills/source-upgrade-policy" ||
    url.pathname.startsWith("/skills/source-artifacts/") ||
    url.pathname === "/skills/suggestions" ||
    url.pathname === "/skills/usage-events" ||
    url.pathname === "/skills/usage-stats" ||
    url.pathname === "/candidate-generation-decisions" ||
    url.pathname === "/skill-recordings/eligibility" ||
    url.pathname === "/skill-recordings" ||
    url.pathname === "/skill-candidates" ||
    url.pathname === "/skill-candidates/observe" ||
    url.pathname === "/procedure-observation-clusters" ||
    url.pathname.startsWith("/procedure-observation-clusters/") ||
    url.pathname === "/procedure-observations" ||
    url.pathname === "/procedure-observations/jobs" ||
    skillRoute
  ) {
    await handleSkillRoute(request, response, config, storeRegistry, controlPlaneEvents, skillRoute);
    return;
  }

  const governanceNotificationRoute = parseGovernanceNotificationRoute(url.pathname);
  if (
    url.pathname === "/governance-notifications" ||
    url.pathname === "/governance-notifications/summary" ||
    governanceNotificationRoute
  ) {
    await handleGovernanceNotificationRoute(request, response, config, storeRegistry, governanceNotificationRoute);
    return;
  }

  if (url.pathname === "/memory") {
    await handleMemoryCollection(request, response, config, storeRegistry, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/memory/recall") {
    await handleMemoryRecall(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/consolidation-jobs") {
    await handleMemoryConsolidationJobs(request, response, config, storeRegistry, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/memory/export") {
    await handleMemoryExport(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/import") {
    await handleMemoryImport(request, response, config, storeRegistry, controlPlaneEvents);
    return;
  }

  if (request.method === "GET" && url.pathname === "/memory/health") {
    handleMemoryHealth(response, url, storeRegistry);
    return;
  }
  if (url.pathname === "/memory/health") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/health` });
    return;
  }

  if (request.method === "GET" && url.pathname === "/memory/used") {
    handleListUsedMemoryEvents(response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/review-policy") {
    await handleMemoryReviewPolicy(request, response, config, storeRegistry, controlPlaneEvents);
    return;
  }

  if (url.pathname === "/memory/promotion-inbox") {
    if (request.method === "GET") {
      handleMemoryPromotionInbox(response, url, storeRegistry);
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/promotion-inbox` });
    return;
  }

  const nestedMemoryRoute = parseMemoryRoute(url.pathname);
  if (nestedMemoryRoute?.kind === "review") {
    await handleMemoryReviewAction(request, response, config, storeRegistry, controlPlaneEvents, nestedMemoryRoute.memoryId);
    return;
  }

  const memoryRoute = matchSingleSegmentRoute(url.pathname, "/memory");
  if (memoryRoute) {
    await handleMemoryItem(request, response, config, storeRegistry, memoryRoute);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/leases") {
    handleListResourceLeases(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runners") {
    handleListRunners(response, url, storeRegistry, runnerRegistry, config);
    return;
  }

  const runnerReadinessRoute = parseRunnerReadinessRoute(url.pathname);
  if (runnerReadinessRoute) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for runner readiness` });
      return;
    }
    await handleGetRunnerReadiness(response, url, storeRegistry, runnerRegistry, config, runnerReadinessRoute.runnerId);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/extensions") {
    handleListRuntimeExtensions(response, url, storeRegistry, extensionRegistry);
    return;
  }

  if (url.pathname === "/runtime/settings") {
    await handleRuntimeSettings(request, response, url, storeRegistry, runnerRegistry, config.maxBodyBytes, controlPlaneEvents);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime") {
    handleGetRuntime(response, url, storeRegistry, runtimeSupervisor);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/supervisor") {
    handleGetRuntimeSupervisor(response, url, storeRegistry, runtimeSupervisor);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/active") {
    handleListRuntimeActive(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/stuck") {
    handleListRuntimeStuck(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/semaphores") {
    handleListRuntimeSemaphores(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/work-units") {
    handleListWorkUnits(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/secrets/status") {
    handleSecretStatus(response, url, secretResolver);
    return;
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    await handleRun(request, response, config, (runRequest) =>
      executeRunRequest(
        runRequest,
        createSseRunExecutionSink(response),
        runnerRegistry,
        storeRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        {
          afterRunTerminal: maybeContinueRunInterventions,
          controlPlaneEvents,
          startupState,
          computerUsePreviews,
        },
      ));
    return;
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    handleListRuns(response, url, storeRegistry);
    return;
  }

  const runRoute = parseRunRoute(url.pathname);
  if (request.method === "POST" && runRoute?.kind === "cancel") {
    handleCancelRun(response, url, storeRegistry, activeRuns, runRoute.runId, ensureRunCancelled);
    return;
  }
  if (runRoute?.kind === "interventions") {
    await handleRunInterventions(
      request,
      response,
      config,
      url,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
      computerUsePreviews,
      controlPlaneEvents,
      startupState,
      runRoute.runId,
    );
    return;
  }
  if (runRoute?.kind === "tool-load-requests") {
    await handleToolLoadRequestsCollection(request, response, config, url, storeRegistry, runnerRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "run") {
    handleGetRun(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "events") {
    handleGetRunEvents(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "artifacts") {
    handleListRunArtifacts(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "shell-snapshots") {
    handleListShellSnapshots(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "shell-snapshot") {
    handleGetShellSnapshot(response, url, storeRegistry, runRoute.runId, runRoute.snapshotId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "workspace-changes") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleGetRunWorkspaceChanges(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "POST" && runRoute?.kind === "workspace-changes-undo") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleMutateRunWorkspaceChanges(response, url, storeRegistry, runRoute.runId, "undo");
    return;
  }
  if (request.method === "POST" && runRoute?.kind === "workspace-changes-reapply") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleMutateRunWorkspaceChanges(response, url, storeRegistry, runRoute.runId, "reapply");
    return;
  }

  const runInterventionRoute = parseRunInterventionRoute(url.pathname);
  if (runInterventionRoute) {
    if (runInterventionRoute.kind === "promote") {
      handleRunInterventionPromote(
        request,
        response,
        url,
        storeRegistry,
        runnerRegistry,
        activeRuns,
        runtimeSupervisor,
        secretResolver,
        mcpBroker,
        computerUsePreviews,
        controlPlaneEvents,
        startupState,
        runInterventionRoute.interventionId,
      );
      return;
    }
    handleRunInterventionItem(request, response, url, storeRegistry, runInterventionRoute);
    return;
  }

  const teammateDirectInterventionRoute = parseTeammateDirectInterventionRoute(url.pathname);
  if (teammateDirectInterventionRoute) {
    if (teammateDirectInterventionRoute.kind === "promote") {
      await handleTeammateDirectInterventionPromote(request, response, config, storeRegistry, teammateDirectInterventionRoute.interventionId, directReplyControl);
      return;
    }
    await handleTeammateDirectInterventionCancel(request, response, config, storeRegistry, teammateDirectInterventionRoute.interventionId, directReplyControl);
    return;
  }

  const teammateDirectReplyRoute = parseTeammateDirectReplyRoute(url.pathname);
  if (teammateDirectReplyRoute) {
    await handleTeammateDirectReplyCancel(request, response, config, storeRegistry, teammateDirectReplyRoute.workUnitId, directReplyControl);
    return;
  }

  const workUnitRoute = parseWorkUnitRoute(url.pathname);
  if (workUnitRoute) {
    handleWorkUnitRoute(request, response, url, storeRegistry, activeRuns, runtimeSupervisor, workUnitRoute, ensureRunCancelled, controlPlaneEvents);
    return;
  }

  if (request.method === "GET" && url.pathname === "/workspace-files/preview") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleGetWorkspaceFilePreview(response, url);
    return;
  }
  if (request.method === "GET" && url.pathname === "/workspace/changes") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleGetWorkspaceChanges(response, url);
    return;
  }
  const workspaceFileOpenIconTarget = parseWorkspaceFileOpenIconTarget(url.pathname);
  if (request.method === "GET" && workspaceFileOpenIconTarget) {
    const cwd = url.searchParams.get("cwd")?.trim();
    if (!cwd) {
      writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
      return;
    }
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) {
      return;
    }
    await handleGetWorkspaceFileOpenIcon(request, response, workspaceFileOpenIconTarget);
    return;
  }
  if (request.method === "GET" && url.pathname === "/workspace-files/open-options") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    handleGetWorkspaceFileOpenOptions(response, url);
    return;
  }
  if (request.method === "POST" && url.pathname === "/workspace-files/open") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handlePostWorkspaceFileOpen(request, response, url, config.maxBodyBytes);
    return;
  }
  if (request.method === "GET" && url.pathname === "/workspace-files/content") {
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
      return;
    }
    await handleGetWorkspaceFileContent(response, url);
    return;
  }

  const artifactRoute = parseArtifactRoute(url.pathname);
  if (request.method === "GET" && artifactRoute?.kind === "artifact") {
    handleGetArtifact(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }
  if (request.method === "GET" && artifactRoute?.kind === "content") {
    handleGetArtifactContent(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }
  if (request.method === "GET" && artifactRoute?.kind === "preview") {
    handleGetArtifactPreview(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }

  const attachmentRoute = parseChannelAttachmentRoute(url.pathname);
  if (attachmentRoute) {
    await handleChannelAttachmentItem(request, response, config, storeRegistry, attachmentRoute);
    return;
  }

  const linkPreviewRoute = parseChannelLinkPreviewRoute(url.pathname);
  if (linkPreviewRoute) {
    await handleChannelLinkPreviewItem(request, response, config, storeRegistry, linkPreviewRoute);
    return;
  }

  const decisionRoute = parseChannelDecisionRoute(url.pathname);
  if (decisionRoute) {
    await handleChannelDecisionItem(request, response, config, storeRegistry, decisionRoute.decisionId);
    return;
  }

  const handoffRoute = parseChannelHandoffRoute(url.pathname);
  if (handoffRoute) {
    if (handoffRoute.action === "workflow") {
      await handleChannelWorkflowFromHandoff(request, response, config, storeRegistry, handoffRoute.handoffId);
      return;
    }
    await handleChannelHandoffItem(request, response, config, storeRegistry, handoffRoute.handoffId);
    return;
  }

  const createStartOrchestratedRun = (store: RunStore, cwd: string): StartOrchestratedWorkflowStepRun => {
    const startOrchestratedRun: StartOrchestratedWorkflowStepRun = ({ workflow, workflowStep, taskId, runRequest }) =>
      new Promise((resolve) => {
        let resolved = false;
        const resolveOnce = (runId: string | undefined): void => {
          if (!resolved) {
            resolved = true;
            resolve(runId);
          }
        };
        void executeRunRequest(
          runRequest,
          createDetachedRunExecutionSink(),
          runnerRegistry,
          storeRegistry,
          activeRuns,
          runtimeSupervisor,
          secretResolver,
          mcpBroker,
          {
            onRunReady: (runId) => {
              const now = new Date().toISOString();
              store.updateChannelWorkflowStep(workflowStep.id, { taskId, runId }, now);
              const run = store.getRun(runId);
              if (run) {
                try {
                  const latestStep = store.getChannelWorkflowStep(workflowStep.id) ?? workflowStep;
                  const artifact = createWorkflowStepContextArtifact({
                    store,
                    workflow,
                    step: latestStep,
                    run,
                    runRequest,
                    now,
                  });
                  const stepWithLatestMetadata = store.getChannelWorkflowStep(workflowStep.id) ?? latestStep;
                  store.updateChannelWorkflowStep(
                    workflowStep.id,
                    { metadata: { ...stepWithLatestMetadata.metadata, contextArtifactId: artifact.id } },
                    now,
                  );
                } catch {
                  // Context artifacts are audit evidence; a write failure must not orphan an already-started run.
                }
              }
              resolveOnce(runId);
            },
            afterRunTerminal: async (terminalRun) => {
              finalizeOrchestratedWorkflowStepRun(store, workflowStep.id, taskId, terminalRun);
              await maybeContinueRunInterventions(terminalRun);
              if (terminalRun.status === "succeeded") {
                await orchestrateChannelWorkflow({
                  store,
                  cwd,
                  workflowId: workflow.id,
                  validateRunRequest: (candidateRunRequest) => {
                    resolveProviderForRun(store, candidateRunRequest, secretResolver);
                  },
                  startRun: startOrchestratedRun,
                });
              }
            },
            controlPlaneEvents,
            startupState,
            computerUsePreviews,
          },
        ).then(resolveOnce, () => resolveOnce(undefined));
      });
    return startOrchestratedRun;
  };

  const confirmAndOrchestrateChannelProposal = async (input: {
    readonly store: RunStore;
    readonly cwd: string;
    readonly proposalId: string;
  }) => {
    const confirmed = confirmChannelExecutionProposalWorkflow({
      store: input.store,
      cwd: input.cwd,
      proposalId: input.proposalId,
      runnerRegistry,
      validateRunRequest: (candidateRunRequest) => {
        resolveProviderForRun(input.store, candidateRunRequest, secretResolver);
      },
    });
    const startOrchestratedRun = createStartOrchestratedRun(input.store, input.cwd);
    const orchestration = await orchestrateChannelWorkflow({
      store: input.store,
      cwd: input.cwd,
      workflowId: confirmed.workflow.id,
      validateRunRequest: (candidateRunRequest) => {
        resolveProviderForRun(input.store, candidateRunRequest, secretResolver);
      },
      startRun: startOrchestratedRun,
    });
    return {
      proposal: input.store.getChannelExecutionProposal(input.proposalId) ?? confirmed.proposal,
      workflow: orchestration.workflow,
      workflowSteps: input.store.listChannelWorkflowSteps({ workflowId: confirmed.workflow.id, limit: 500 }),
      orchestration,
    };
  };

  if (url.pathname === "/conversation-message-edits") {
    await handleConversationMessageEdit(request, response, config, storeRegistry, {
      activeRuns,
      startReplacement: async ({ store, editable, request: editRequest, revision }) => {
        if (editable.surface === "normal_conversation") {
          const previousRun = editable.supersededRunIds
            .map((runId) => store.getRun(runId))
            .filter((run): run is RunSession => Boolean(run))
            .at(-1);
          const started = await startConversationReplacementRun({
            store,
            workspaceCwd: store.paths.cwd,
            thread: editable.thread,
            message: revision.body,
            messageId: revision.messageId,
            attachmentIds: revision.attachmentIds,
            providerPresetId: editRequest.providerPresetId,
            permissionPreset: editRequest.permissionPreset,
            permissionConfirmation: editRequest.permissionConfirmation,
            previousRun,
            runnerRegistry,
            startRun: startTeammateDirectRun,
            imageVisionSummarizer,
          });
          return { replacementTurnId: started.turn.id };
        }

        if (editable.surface === "teammate_direct") {
          const teammate = store.getAiTeammate(editable.ownerId);
          const sourceMessage = store.getTeammateDirectMessage(editable.messageId);
          if (!teammate || !sourceMessage) {
            throw new HttpError(404, "message_not_found", "The edited private message is no longer available.");
          }
          const workspace = await ensureDirectWorkspaceReady({ store, thread: editable.thread, workspaceCwd: store.paths.cwd });
          if (!workspace.ok) {
            throw new HttpError(409, "edit_replacement_start_failed", workspace.message);
          }
          await providerStartupRefresh.refreshBeforeRun({
            cwd: store.paths.cwd,
            store,
            providerPresetId: editRequest.providerPresetId ?? teammate.providerPresetId,
          });
          return await new Promise<{ readonly replacementTurnId?: string }>((resolve, reject) => {
            let started = false;
            void createAiTeammateDirectReply({
              startRun: startTeammateDirectRun,
              store,
              teammate,
              thread: editable.thread,
              sourceMessage,
              providerPresetId: editRequest.providerPresetId,
              permissionPreset: editRequest.permissionPreset,
              permissionConfirmation: editRequest.permissionConfirmation,
              requestedSkillId: editRequest.requestedSkillId,
              workspace: workspace.workspace,
              secretResolver,
              imageVisionSummarizer,
              webFetch: context.webFetch,
              webResolveHostAddresses: context.webResolveHostAddresses,
              onWorkUnitStarted: ({ workUnitId }) => {
                if (started) {
                  return;
                }
                started = true;
                const runId = store.getWorkUnit(workUnitId)?.linkedRunId;
                resolve({ replacementTurnId: runId ? store.getLingTurnForRun(runId)?.id : undefined });
              },
            }).then((reply) => {
              if (!started) {
                reject(new Error(reply.errorMessage || "Private replacement did not start a run."));
              }
            }, reject);
          });
        }

        const sourceMessage = getChannelMessageView(store, editable.messageId);
        if (!sourceMessage) {
          throw new HttpError(404, "message_not_found", "The edited channel message is no longer available.");
        }
        await handleLingAgentChannelMessage({
          store,
          channel: editable.channel,
          sourceMessage,
          requestedProviderPresetId: editRequest.providerPresetId,
          requestAiReply: true,
          createAiReply: (input) => createAiChannelReply({
            startRun: startTeammateDirectRun,
            secretResolver,
            webFetch: context.webFetch,
            webResolveHostAddresses: context.webResolveHostAddresses,
            ...input,
            completionMode: "background",
            trackCompletion: (completion) => activeRuns.trackCompletion(completion),
            teamObserverBusEnabled: config.channels.teamObserverBus === true,
          }),
          startExecutionProposalWorkflow: (input) => confirmAndOrchestrateChannelProposal({
            store: input.store,
            cwd: store.paths.cwd,
            proposalId: input.proposalId,
          }),
          config,
          routeDependencies: { runnerRegistry, secretResolver, config },
          imageVisionSummarizer,
          replyDispatchCoordinator: channelReplyDispatchCoordinator,
        });
        return {};
      },
    });
    return;
  }

  const workflowHandoffIntentRoute = parseWorkflowHandoffIntentRoute(url.pathname);
  if (workflowHandoffIntentRoute) {
    if (workflowHandoffIntentRoute.kind === "collection") {
      await handleWorkflowHandoffIntentsCollection(request, response, config, storeRegistry);
      return;
    }
    if (workflowHandoffIntentRoute.action === "accept") {
      await handleWorkflowHandoffIntentAccept(request, response, config, storeRegistry, workflowHandoffIntentRoute.intentId);
      return;
    }
    await handleWorkflowHandoffIntentItem(request, response, config, storeRegistry, workflowHandoffIntentRoute.intentId);
    return;
  }

  const workflowSelectorDecisionRoute = parseWorkflowSelectorDecisionRoute(url.pathname);
  if (workflowSelectorDecisionRoute) {
    if (workflowSelectorDecisionRoute.kind === "collection") {
      await handleWorkflowSelectorDecisionsCollection(request, response, config, storeRegistry);
      return;
    }
    await handleWorkflowSelectorDecisionItem(request, response, config, storeRegistry, workflowSelectorDecisionRoute.decisionId);
    return;
  }

  const workflowRoute = parseChannelWorkflowRoute(url.pathname);
  if (workflowRoute) {
    if (workflowRoute.kind === "workflow") {
      if (workflowRoute.action === "workspace-changes" || workflowRoute.action === "workspace-changes-undo" || workflowRoute.action === "workspace-changes-reapply") {
        const expectedMethod = workflowRoute.action === "workspace-changes" ? "GET" : "POST";
        if (request.method !== expectedMethod) {
          writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow workspace recovery` });
          return;
        }
        if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd: url.searchParams.get("cwd") ?? undefined })) {
          return;
        }
        if (workflowRoute.action === "workspace-changes") {
          await handleGetWorkflowWorkspaceChanges(response, url, storeRegistry, workflowRoute.workflowId);
        } else {
          await handleMutateWorkflowWorkspaceChanges(
            response,
            url,
            storeRegistry,
            workflowRoute.workflowId,
            workflowRoute.action === "workspace-changes-undo" ? "undo" : "reapply",
          );
        }
        return;
      }
      if (workflowRoute.action === "orchestrate") {
        if (request.method !== "POST") {
          writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow orchestration` });
          return;
        }
        const cwd = url.searchParams.get("cwd");
        if (!cwd) {
          writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
          return;
        }
        try {
          const store = storeRegistry.getStore(cwd);
          const startOrchestratedRun = createStartOrchestratedRun(store, cwd);
          const result = await orchestrateChannelWorkflow({
            store,
            cwd,
            workflowId: workflowRoute.workflowId,
            validateRunRequest: (candidateRunRequest) => {
              resolveProviderForRun(store, candidateRunRequest, secretResolver);
            },
            startRun: startOrchestratedRun,
          });
          writeJson(response, 200, result);
        } catch (error) {
          writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
            error: error instanceof HttpError ? error.code : "bad_request",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (workflowRoute.action === "cancel") {
        if (request.method !== "POST") {
          writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow cancellation` });
          return;
        }
        const cwd = url.searchParams.get("cwd");
        if (!cwd) {
          writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
          return;
        }
        try {
          const store = storeRegistry.getStore(cwd);
          const result = cancelChannelWorkflow({
            store,
            workflowId: workflowRoute.workflowId,
            cancelRun: (run) => {
              const activeRun = activeRuns.get(run.id);
              ensureRunCancelled({
                store,
                runId: run.id,
                taskId: run.taskId,
                startedAt: run.startedAt,
                reason: "workflow_cancelled",
                active: Boolean(activeRun),
                streamEnvelope: activeRun?.streamEnvelope,
              });
              activeRun?.abortController.abort();
            },
          });
          writeJson(response, 200, result);
        } catch (error) {
          writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
            error: error instanceof HttpError ? error.code : "bad_request",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (workflowRoute.action === "evidence") {
        await handleChannelWorkflowEvidence(request, response, config, storeRegistry, workflowRoute.workflowId);
        return;
      }
      if (workflowRoute.action === "collaboration-card") {
        await handleChannelWorkflowCollaborationCard(request, response, config, storeRegistry, workflowRoute.workflowId);
        return;
      }
      await handleChannelWorkflowItem(request, response, config, storeRegistry, workflowRoute.workflowId);
      return;
    }
    if (workflowRoute.kind === "steps") {
      await handleChannelWorkflowStepsCollection(request, response, config, storeRegistry, workflowRoute.workflowId);
      return;
    }
    if (workflowRoute.action === "evidence") {
      await handleChannelWorkflowStepEvidence(request, response, config, storeRegistry, workflowRoute.workflowStepId);
      return;
    }
    if (workflowRoute.action === "retry") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow step retry` });
        return;
      }
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
        return;
      }
      try {
        const store = storeRegistry.getStore(cwd);
        const startOrchestratedRun = createStartOrchestratedRun(store, cwd);
        const result = await retryChannelWorkflowStep({
          store,
          cwd,
          workflowStepId: workflowRoute.workflowStepId,
          validateRunRequest: (candidateRunRequest) => {
            resolveProviderForRun(store, candidateRunRequest, secretResolver);
          },
          startRun: startOrchestratedRun,
        });
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
          error: error instanceof HttpError ? error.code : "bad_request",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (workflowRoute.action === "start") {
      await handleChannelWorkflowStepStartRoute(
        request,
        response,
        config,
        storeRegistry,
        workflowRoute.workflowStepId,
        (runRequest) => {
          const store = storeRegistry.getStore(runRequest.workspaceCwd);
          resolveProviderForRun(store, runRequest, secretResolver);
        },
        ({ runRequest, response }) =>
          executeRunRequest(
            runRequest,
            createSseRunExecutionSink(response),
            runnerRegistry,
            storeRegistry,
            activeRuns,
            runtimeSupervisor,
            secretResolver,
            mcpBroker,
            {
              afterRunTerminal: maybeContinueRunInterventions,
              controlPlaneEvents,
              startupState,
              computerUsePreviews,
            },
          ),
      );
      return;
    }
    await handleChannelWorkflowStepItem(request, response, config, storeRegistry, workflowRoute.workflowStepId);
    return;
  }

  const contextSummaryRoute = parseChannelContextSummaryRoute(url.pathname);
  if (contextSummaryRoute) {
    await handleChannelContextSummaryItem(request, response, config, storeRegistry, contextSummaryRoute.contextSummaryId);
    return;
  }

  const channelRoute = parseChannelRoute(url.pathname);
  if (channelRoute) {
    if (channelRoute.action === "workspace") {
      await handleChannelWorkspace(request, response, config, storeRegistry, channelRoute.channelId, channelRoute.workspaceAction);
      return;
    }
    if (channelRoute.action === "protocol") {
      await handleChannelCollaborationProtocol(
        request,
        response,
        config,
        storeRegistry,
        channelRoute.channelId,
        channelRoute.protocolAction,
        channelRoute.protocolDraftId,
        channelRoute.protocolClusterId,
      );
      return;
    }
    if (channelRoute.action === "playbooks") {
      await handleChannelPlaybookCandidates(
        request,
        response,
        config,
        storeRegistry,
        channelRoute.channelId,
        channelRoute.playbookAction,
        channelRoute.playbookCandidateId,
        channelRoute.playbookClusterId,
      );
      return;
    }
    if (channelRoute.action === "brief") {
      await handleChannelBrief(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "branches") {
      if (channelRoute.branchId) {
        await handleChannelBranchItem(request, response, config, storeRegistry, channelRoute.channelId, channelRoute.branchId);
        return;
      }
      await handleChannelBranchesCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "proposed-plans") {
      await handleChannelProposedPlans(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "messages") {
      const channelMessagesCwd = url.searchParams.get("cwd") ?? "";
      await handleChannelMessagesCollection(request, response, config, storeRegistry, channelRoute.channelId, (input) =>
        createAiChannelReply({
          startRun: startTeammateDirectRun,
          secretResolver,
          webFetch: context.webFetch,
          webResolveHostAddresses: context.webResolveHostAddresses,
          ...input,
          trackCompletion: (completion) => activeRuns.trackCompletion(completion),
          teamObserverBusEnabled: config.channels.teamObserverBus === true,
        }),
        (input) => confirmAndOrchestrateChannelProposal({
          store: input.store,
          cwd: channelMessagesCwd,
          proposalId: input.proposalId,
        }),
        {
          runnerRegistry,
          secretResolver,
          config,
        },
        imageVisionSummarizer,
        channelReplyDispatchCoordinator,
      );
      return;
    }
    if (channelRoute.action === "messages-stream") {
      const channelMessagesCwd = url.searchParams.get("cwd") ?? "";
      await handleChannelMessageStream(request, response, config, storeRegistry, channelRoute.channelId, (input) =>
        createAiChannelReply({
          startRun: startTeammateDirectRun,
          secretResolver,
          webFetch: context.webFetch,
          webResolveHostAddresses: context.webResolveHostAddresses,
          ...input,
          trackCompletion: (completion) => activeRuns.trackCompletion(completion),
          teamObserverBusEnabled: config.channels.teamObserverBus === true,
        }),
        (input) => confirmAndOrchestrateChannelProposal({
          store: input.store,
          cwd: channelMessagesCwd,
          proposalId: input.proposalId,
        }),
        {
          runnerRegistry,
          secretResolver,
          config,
        },
        imageVisionSummarizer,
        channelReplyDispatchCoordinator,
      );
      return;
    }
    if (channelRoute.action === "message-route-decisions") {
      await handleChannelMessageRouteDecisionsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "intent-decisions") {
      await handleChannelIntentDecisionsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "proposals") {
      await handleChannelExecutionProposalsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "attachments") {
      await handleChannelAttachmentsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "link-previews") {
      await handleChannelLinkPreviewsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "decisions") {
      await handleChannelDecisionsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "handoffs") {
      await handleChannelHandoffsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "context-summaries") {
      await handleChannelContextSummariesCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "workflows") {
      await handleChannelWorkflowsCollection(request, response, config, storeRegistry, channelRoute.channelId, runnerRegistry);
      return;
    }
    if (channelRoute.action === "collaboration-cards") {
      await handleChannelCollaborationCardsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "terminal-reports") {
      await handleChannelTerminalReports(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-experts") {
      await handleChannelTeamExpertsProjection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-metrics") {
      await handleChannelTeamMetricsProjection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-authority-ledger") {
      await handleChannelTeamAuthorityLedger(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-patterns") {
      await handleChannelTeamPatterns(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-snapshots") {
      await handleChannelTeamSnapshots(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "team-evaluations") {
      await handleChannelTeamEvaluations(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "council-policy") {
      await handleChannelCouncilPolicy(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "effective-council") {
      await handleChannelEffectiveCouncil(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    await handleChannelItem(request, response, config, storeRegistry, channelRoute.channelId, secretResolver);
    return;
  }

  const aiCouncilRoute = parseAiCouncilRoute(url.pathname);
  if (aiCouncilRoute) {
    if (aiCouncilRoute.action === "members") {
      await handleAiCouncilMembers(request, response, config, storeRegistry, aiCouncilRoute.councilId);
      return;
    }
    if (aiCouncilRoute.action === "clone") {
      await handleAiCouncilClone(request, response, config, storeRegistry, aiCouncilRoute.councilId);
      return;
    }
    await handleAiCouncilItem(request, response, config, storeRegistry, aiCouncilRoute.councilId);
    return;
  }

  const channelProposalRoute = parseChannelExecutionProposalRoute(url.pathname);
  if (channelProposalRoute) {
    if (channelProposalRoute.action === "confirm-workflow") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for proposal workflow confirmation` });
        return;
      }
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
        return;
      }
      try {
        const store = storeRegistry.getStore(cwd);
        const confirmed = await confirmAndOrchestrateChannelProposal({
          store,
          cwd,
          proposalId: channelProposalRoute.proposalId,
        });
        writeJson(response, 200, {
          proposal: confirmed.proposal,
          workflow: confirmed.workflow,
          workflowSteps: confirmed.workflowSteps,
          orchestration: confirmed.orchestration,
        });
      } catch (error) {
        writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
          error: error instanceof HttpError ? error.code : "bad_request",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    await handleChannelExecutionProposalItem(request, response, config, storeRegistry, channelProposalRoute.proposalId);
    return;
  }

  const teammateRoute = parseTeammateRoute(url.pathname);
  if (teammateRoute) {
    if (!teammateRoute.action) {
      await handleTeammateItem(request, response, config, storeRegistry, teammateRoute.teammateId, secretResolver);
      return;
    }
    if (teammateRoute.action === "channels") {
      await handleTeammateChannelMemberships(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "memory-scopes") {
      await handleTeammateMemoryScopes(request, response, config, storeRegistry, teammateRoute.teammateId, controlPlaneEvents);
      return;
    }
    if (teammateRoute.action === "skills") {
      await handleTeammateSkillBindings(request, response, config, storeRegistry, teammateRoute.teammateId, controlPlaneEvents);
      return;
    }
    if (teammateRoute.action === "mcp") {
      await handleTeammateMcpBindings(request, response, config, storeRegistry, teammateRoute.teammateId, controlPlaneEvents);
      return;
    }
    if (teammateRoute.action === "persona-draft") {
      await handleTeammatePersonaDraft(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "tasks") {
      await handleTeammateTasks(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "activity") {
      await handleTeammateActivity(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "direct-thread") {
      await handleTeammateDirectThread(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "direct-runtime") {
      await handleTeammateDirectRuntime(request, response, config, storeRegistry, teammateRoute.teammateId, directReplyControl);
      return;
    }
    if (teammateRoute.action === "direct-workspace") {
      await handleTeammateDirectWorkspace(request, response, config, storeRegistry, teammateRoute.teammateId, teammateRoute.workspaceAction);
      return;
    }
    if (teammateRoute.action === "direct-interventions") {
      await handleTeammateDirectInterventions(request, response, config, storeRegistry, teammateRoute.teammateId, directReplyControl);
      return;
    }
    if (teammateRoute.action === "direct-link-previews") {
      await handleTeammateDirectLinkPreviews(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "direct-messages") {
      await handleTeammateDirectMessagesCollection(
        request,
        response,
        config,
        storeRegistry,
        teammateRoute.teammateId,
        async ({
          store,
          teammate,
          thread,
          sourceMessage,
          providerPresetId,
          permissionPreset,
          permissionConfirmation,
          requestedSkillId,
          skillOptimizationMode,
          onWorkUnitStarted,
        }) => {
          let sourceWorkUnitId: string | undefined;
          const workspace = await ensureDirectWorkspaceReady({ store, thread, workspaceCwd: store.paths.cwd });
          if (!workspace.ok) {
            return createBlockedTeammateDirectReply(store, teammate, thread, workspace.message);
          }
          await providerStartupRefresh.refreshBeforeRun({
            cwd: store.paths.cwd,
            store,
            providerPresetId: providerPresetId ?? teammate.providerPresetId,
          });
          const reply = await createAiTeammateDirectReply({
            startRun: startTeammateDirectRun,
            store,
            teammate,
            thread,
            sourceMessage,
            providerPresetId,
            permissionPreset,
            permissionConfirmation,
            requestedSkillId,
            skillOptimizationMode,
            workspace: workspace.workspace,
            secretResolver,
            imageVisionSummarizer,
            webFetch: context.webFetch,
            webResolveHostAddresses: context.webResolveHostAddresses,
            onWorkUnitStarted: (handle) => {
              sourceWorkUnitId = handle.workUnitId;
              onWorkUnitStarted?.(handle);
            },
          });
          await directReplyControl.maybeStartNextQueuedContinuation({ store, teammateId: teammate.id, threadId: thread.id, sourceWorkUnitId });
          return reply;
        },
      );
      return;
    }
    if (teammateRoute.action === "direct-attachments") {
      await handleTeammateDirectAttachments(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "avatar") {
      await handleTeammateAvatar(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "hard-delete") {
      await handleTeammateHardDelete(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "direct-messages-stream") {
      await handleTeammateDirectMessageStream(
        request,
        response,
        config,
        storeRegistry,
        teammateRoute.teammateId,
        async ({
          store,
          teammate,
          thread,
          sourceMessage,
          providerPresetId,
          permissionPreset,
          permissionConfirmation,
          requestedSkillId,
          skillOptimizationMode,
          signal,
          onWorkUnitStarted,
          stream,
        }) => {
          let sourceWorkUnitId: string | undefined;
          const workspace = await ensureDirectWorkspaceReady({ store, thread, workspaceCwd: store.paths.cwd });
          if (!workspace.ok) {
            const blocked = createBlockedTeammateDirectReply(store, teammate, thread, workspace.message);
            stream?.onBlocked(blocked);
            return blocked;
          }
          await providerStartupRefresh.refreshBeforeRun({
            cwd: store.paths.cwd,
            store,
            providerPresetId: providerPresetId ?? teammate.providerPresetId,
          });
          const reply = await createAiTeammateDirectReply({
            startRun: startTeammateDirectRun,
            store,
            teammate,
            thread,
            sourceMessage,
            providerPresetId,
            permissionPreset,
            permissionConfirmation,
            requestedSkillId,
            skillOptimizationMode,
            workspace: workspace.workspace,
            secretResolver,
            imageVisionSummarizer,
            webFetch: context.webFetch,
            webResolveHostAddresses: context.webResolveHostAddresses,
            signal,
            onWorkUnitStarted: (handle) => {
              sourceWorkUnitId = handle.workUnitId;
              onWorkUnitStarted?.(handle);
            },
            stream,
          });
          await directReplyControl.maybeStartNextQueuedContinuation({ store, teammateId: teammate.id, threadId: thread.id, sourceWorkUnitId });
          return reply;
        },
        activeDirectReplies,
      );
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate ${teammateRoute.action}` });
    return;
  }

  const taskRoute = parseTaskRoute(url.pathname);
  if (taskRoute) {
    if (taskRoute.action === "run") {
      await handleTaskRun(
        request,
        response,
        config,
        storeRegistry,
        taskRoute.taskId,
        async ({ workspaceCwd, task, channel, runRequest, response }) => {
          const workspace = assertChannelWorkspaceReady(channel, workspaceCwd);
          if (!workspace.ok) {
            writeJson(response, 409, { error: "channel_workspace_unavailable", message: workspace.message });
            return;
          }
          const store = storeRegistry.getStore(workspaceCwd);
          const taskAttachmentPrompt = await materializeTaskAttachmentsForPrompt({
            store,
            channel,
            task,
            now: new Date().toISOString(),
            imageVisionSummarizer,
          });
          const taskPrompt = taskAttachmentPrompt ? `${task.prompt}\n\n${taskAttachmentPrompt}` : task.prompt;
          await executeRunRequest(
            {
              workspaceCwd,
              cwd: workspace.executionCwd,
              providerPresetId: runRequest.providerPresetId,
              runnerId: runRequest.runnerId,
              teammateId: task.assigneeTeammateId ?? channel.defaultTeammateId,
              requestedSkillId: runRequest.requestedSkillId ?? task.requestedSkillId,
              skillOptimizationMode: runRequest.skillOptimizationMode,
              skipProviderPreflight: runRequest.skipProviderPreflight,
              idempotencyKey: runRequest.idempotencyKey,
              task: {
                id: task.id,
                title: task.title,
                prompt: taskPrompt,
                channelId: task.channelId,
              },
              tools: runRequest.tools ?? channel.allowedTools,
              approvalProfile: runRequest.approvalProfile,
              authorizationMode: runRequest.authorizationMode,
              workspaceAccessMode: runRequest.workspaceAccessMode,
              permissionPreset: runRequest.permissionPreset,
              permissionMode: runRequest.permissionMode,
              permissionConfirmation: runRequest.permissionConfirmation,
              thinkingLevel: runRequest.thinkingLevel,
              systemPrompt: runRequest.systemPrompt,
              appendSystemPrompt: runRequest.appendSystemPrompt,
              agentDir: runRequest.agentDir,
            },
            createSseRunExecutionSink(response),
            runnerRegistry,
            storeRegistry,
            activeRuns,
            runtimeSupervisor,
            secretResolver,
            mcpBroker,
            {
              afterRunTerminal: maybeContinueRunInterventions,
              controlPlaneEvents,
              startupState,
              computerUsePreviews,
            },
          );
        },
      );
      return;
    }
    await handleTaskItem(request, response, config, storeRegistry, taskRoute.taskId);
    return;
  }

  const providerRoute = parseProviderRoute(url.pathname);
  if (providerRoute) {
    await handleProviderItem(request, response, config, storeRegistry, secretResolver, externalSecretStore, controlPlaneEvents, providerRoute);
    return;
  }

  const mcpServerRoute = parseMcpServerRoute(url.pathname);
  if (mcpServerRoute) {
    await handleMcpServerItem(request, response, config, storeRegistry, mcpBroker, secretResolver, controlPlaneEvents, mcpServerRoute);
    return;
  }

  const mediaJobRoute = parseMediaJobRoute(url.pathname);
  if (mediaJobRoute) {
    await handleMediaJobRoute(
      request,
      response,
      config,
      storeRegistry,
      mediaJobRoute.mediaJobId,
      mediaJobRoute.action,
      ({ response, url, mediaJobId }) =>
        handleRunMediaJob(response, url, storeRegistry, secretResolver, mediaJobId, mediaJobHooks),
    );
    return;
  }

  const mediaProjectRoute = parseMediaProjectRoute(url.pathname);
  if (mediaProjectRoute) {
    await handleMediaProjectRoute(
      request,
      response,
      config,
      storeRegistry,
      secretResolver,
      launchMediaJob,
      mediaProjectRoute,
    );
    return;
  }

  const mediaWorkflowRoute = parseMediaWorkflowRoute(url.pathname);
  if (mediaWorkflowRoute) {
    await handleMediaWorkflowRoute({ ...mediaWorkflowRouteContext, route: mediaWorkflowRoute });
    return;
  }

  const mediaSceneRoute = parseMediaSceneRoute(url.pathname);
  if (mediaSceneRoute) {
    await handleMediaSceneRoute(
      request,
      response,
      config,
      storeRegistry,
      secretResolver,
      launchMediaJob,
      mediaSceneRoute,
    );
    return;
  }

  const mediaSceneRunRoute = parseMediaSceneRunRoute(url.pathname);
  if (mediaSceneRunRoute) {
    handleMediaSceneRunRoute(request, response, config, storeRegistry, mediaSceneRunRoute);
    return;
  }

  const approvalRoute = parseApprovalRoute(url.pathname);
  if (approvalRoute) {
    await handleApprovalItem(request, response, config, storeRegistry, approvalRoute, controlPlaneEvents, ({ cwd, store, approval, now }) => {
      syncWorkflowApprovalDecision(store, approval, now);
      return syncMediaJobForApprovalDecision({
        cwd,
        store,
        storeRegistry,
        secretResolver,
        approval,
        now,
        hooks: mediaJobHooks,
      });
    });
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

function readRunWorkspaceCwd(run: RunSession): string | undefined {
  const snapshot = run.requestSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return undefined;
  }
  const workspaceCwd = (snapshot as { readonly workspaceCwd?: unknown }).workspaceCwd;
  return typeof workspaceCwd === "string" && workspaceCwd.trim() ? workspaceCwd : undefined;
}

function parseConversationRoute(pathname: string): { readonly threadId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "conversations" && segments[1]) {
    return { threadId: segments[1] };
  }
  return undefined;
}

function parseWorkspaceFileOpenIconTarget(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "workspace-files" && segments[1] === "open-icons" && segments[2]) {
    return segments[2];
  }
  return undefined;
}

function createBlockedTeammateDirectReply(
  store: RunStore,
  teammate: AiTeammate,
  thread: TeammateDirectThread,
  reason: string,
): TeammateDirectMessage {
  return store.createTeammateDirectMessage(
    {
      threadId: thread.id,
      teammateId: teammate.id,
      authorType: "ai-teammate",
      authorId: teammate.id,
      body: `私聊工作区不可用：${reason}`,
      status: "blocked",
      errorMessage: reason,
    },
    new Date().toISOString(),
  );
}
