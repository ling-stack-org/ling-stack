import type { IncomingMessage, ServerResponse } from "node:http";
import { defaultProviderTemplates, executeExternalWorkAction } from "@ling-stack/core";
import type { RunSession, RunStore } from "@ling-stack/core";
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
  handleChannelAttachmentItem,
  handleChannelAttachmentsCollection,
} from "../features/channels/attachments.js";
import { createAiChannelReply } from "../features/channels/ai-replies.js";
import { handleChannelLinkPreviewItem, handleChannelLinkPreviewsCollection } from "../features/channels/link-previews.js";
import { handleChannelMessagesCollection } from "../features/channels/messages.js";
import {
  cancelChannelWorkflow,
  finalizeOrchestratedWorkflowStepRun,
  orchestrateChannelWorkflow,
  retryChannelWorkflowStep,
  type StartOrchestratedWorkflowStepRun,
} from "../features/channels/orchestrator.js";
import {
  handleChannelBrief,
  handleChannelContextSummariesCollection,
  handleChannelContextSummaryItem,
  handleChannelDecisionItem,
  handleChannelDecisionsCollection,
  handleChannelExecutionProposalItem,
  handleChannelExecutionProposalsCollection,
  handleChannelHandoffItem,
  handleChannelHandoffsCollection,
  handleChannelItem,
  handleChannelsCollection,
} from "../features/channels/routes.js";
import {
  handleChannelWorkflowFromHandoff,
  handleChannelWorkflowItem,
  handleChannelWorkflowStepItem,
  handleChannelWorkflowStepStartRoute,
  handleChannelWorkflowStepsCollection,
  handleChannelWorkflowsCollection,
} from "../features/channels/workflows.js";
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
import { handleExternalWorkCollection, handleExternalWorkItem } from "../features/external-work/routes.js";
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
  handleMemoryItem,
  handleMemoryPromotionInbox,
  handleMemoryRecall,
  handleMemoryReviewAction,
  handleMemoryReviewPolicy,
} from "../features/memory/routes.js";
import { handleRunMediaJob, syncMediaJobForApprovalDecision } from "../features/media/executor.js";
import { handleMediaJobRoute, handleMediaJobsCollection } from "../features/media/routes.js";
import { handleMcpServerItem, handleMcpServersCollection, handleMcpToolsCollection } from "../features/mcp/routes.js";
import { handlePluginItem, handlePluginsCollection } from "../features/plugins/routes.js";
import {
  handleProviderDraftCheck,
  handleProviderItem,
  handleProviderModelsProbe,
  handleProvidersCollection,
  handleSecretStatus,
} from "../features/providers/routes.js";
import { expireStalePendingApprovals } from "../features/runs/approvals.js";
import { ensureRunCancelled } from "../features/runs/cancellation.js";
import { handleExecutionActionsCollection } from "../features/runs/execution-actions.js";
import { createDetachedRunExecutionSink, createSseRunExecutionSink, executeRunRequest } from "../features/runs/orchestrator.js";
import {
  handleRunInterventionItem,
  handleRunInterventions,
  maybeStartNextRunInterventionContinuation,
} from "../features/runs/interventions.js";
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
import { resolveProviderForRun } from "../features/runs/providers.js";
import { handleSkillRoute } from "../features/skills/routes.js";
import { handleTaskItem, handleTaskRun, handleTasksCollection } from "../features/tasks/routes.js";
import { handleTeammateDirectMessagesCollection, handleTeammateDirectMessageStream, handleTeammateDirectThread } from "../features/teammates/direct-messages.js";
import { createAiTeammateDirectReply } from "../features/teammates/direct-replies.js";
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
  handleListResourceLeases,
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
  parseMemoryRoute,
  parseApprovalRoute,
  parseArtifactRoute,
  parseChannelAttachmentRoute,
  parseChannelContextSummaryRoute,
  parseChannelDecisionRoute,
  parseChannelExecutionProposalRoute,
  parseChannelHandoffRoute,
  parseChannelLinkPreviewRoute,
  parseChannelRoute,
  parseChannelWorkflowRoute,
  parseExternalWorkActionRoute,
  parseExternalWorkBackgroundStopRoute,
  parseExternalWorkCiTriageItemRoute,
  parseExternalWorkCiTriageRunRoute,
  parseLingThreadRoute,
  parseManagedPluginRoute,
  parseMcpServerRoute,
  parseMediaJobRoute,
  parseProviderRoute,
  parseRunInterventionRoute,
  parseRunRoute,
  parseSkillRoute,
  parseTaskRoute,
  parseTeammateRoute,
  parseWorkUnitRoute,
} from "./routes.js";
import { setCorsHeaders, writeJson } from "../shared/response.js";

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  const {
    config,
    runnerRegistry,
    extensionRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver,
    externalSecretStore,
    mcpBroker,
    externalWorkFetch,
    backgroundSchedulers,
    automationSchedulers,
  } = context;
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const maybeContinueRunInterventions = (terminalRun: RunSession): void => {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const store = storeRegistry.findStoreForRun(sourceRunId, terminalRun.cwd) ?? storeRegistry.findStoreForRun(terminalRun.id, terminalRun.cwd);
    if (!store) {
      return;
    }
    maybeStartNextRunInterventionContinuation({
      sourceRunId,
      store,
      runnerRegistry,
      storeRegistry,
      activeRuns,
      runtimeSupervisor,
      secretResolver,
      mcpBroker,
    });
  };

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "ling-stack-daemon",
      defaultWorkspaceCwd: config.defaultWorkspaceCwd,
    });
    return;
  }

  if (url.pathname === "/channels") {
    await handleChannelsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/teammates") {
    await handleTeammatesCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/tasks") {
    await handleTasksCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/providers") {
    await handleProvidersCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/mcp/servers") {
    await handleMcpServersCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/mcp/tools") {
    handleMcpToolsCollection(request, response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/automations") {
    await handleAutomationsCollection(request, response, config, storeRegistry);
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
              afterRunTerminal: (terminalRun) => {
                hooks.afterRunTerminal?.(terminalRun);
                maybeContinueRunInterventions(terminalRun);
              },
            },
          )),
    );
    return;
  }

  const automationDraftRoute = parseAutomationDraftRoute(url.pathname);
  if (automationDraftRoute) {
    await handleAutomationDraftItem(request, response, config, storeRegistry, automationDraftRoute);
    return;
  }

  const automationRunRoute = parseAutomationRunRoute(url.pathname);
  if (automationRunRoute) {
    await handleAutomationRunItem(request, response, config, storeRegistry, activeRuns, automationRunRoute);
    return;
  }

  if (url.pathname === "/plugins") {
    await handlePluginsCollection(request, response, config, storeRegistry, extensionRegistry);
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

  const externalWorkItemRoute = matchSingleSegmentRoute(url.pathname, "/external-work");
  if (externalWorkItemRoute) {
    await handleExternalWorkItem(request, response, config, storeRegistry, externalWorkItemRoute);
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
    handleApprovalsCollection(request, response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/execution-actions") {
    handleExecutionActionsCollection(request, response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/threads") {
    handleLingThreadsCollection(request, response, url, storeRegistry);
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
  if (url.pathname === "/skills" || url.pathname === "/skills/import-draft" || skillRoute) {
    await handleSkillRoute(request, response, config, storeRegistry, skillRoute);
    return;
  }

  if (url.pathname === "/memory") {
    await handleMemoryCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/recall") {
    await handleMemoryRecall(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/consolidation-jobs") {
    await handleMemoryConsolidationJobs(request, response, config, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/memory/used") {
    handleListUsedMemoryEvents(response, url, storeRegistry);
    return;
  }

  if (url.pathname === "/memory/review-policy") {
    await handleMemoryReviewPolicy(request, response, config, storeRegistry);
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
    await handleMemoryReviewAction(request, response, config, storeRegistry, nestedMemoryRoute.memoryId);
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
    handleListRunners(response, url, storeRegistry, runnerRegistry);
    return;
  }

  if (url.pathname === "/runtime/settings") {
    await handleRuntimeSettings(request, response, url, storeRegistry, runnerRegistry, config.maxBodyBytes);
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
      runRoute.runId,
    );
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

  const runInterventionRoute = parseRunInterventionRoute(url.pathname);
  if (runInterventionRoute) {
    handleRunInterventionItem(request, response, url, storeRegistry, runInterventionRoute);
    return;
  }

  const workUnitRoute = parseWorkUnitRoute(url.pathname);
  if (workUnitRoute) {
    handleWorkUnitRoute(request, response, url, storeRegistry, activeRuns, runtimeSupervisor, workUnitRoute, ensureRunCancelled);
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
            afterRunTerminal: (terminalRun) => {
              finalizeOrchestratedWorkflowStepRun(store, workflowStep.id, taskId, terminalRun);
              maybeContinueRunInterventions(terminalRun);
              if (terminalRun.status === "succeeded") {
                void orchestrateChannelWorkflow({
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
          },
        ).then(resolveOnce, () => resolveOnce(undefined));
      });
    return startOrchestratedRun;
  };

  const workflowRoute = parseChannelWorkflowRoute(url.pathname);
  if (workflowRoute) {
    if (workflowRoute.kind === "workflow") {
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
      await handleChannelWorkflowItem(request, response, config, storeRegistry, workflowRoute.workflowId);
      return;
    }
    if (workflowRoute.kind === "steps") {
      await handleChannelWorkflowStepsCollection(request, response, config, storeRegistry, workflowRoute.workflowId);
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
    if (channelRoute.action === "brief") {
      await handleChannelBrief(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "messages") {
      await handleChannelMessagesCollection(request, response, config, storeRegistry, channelRoute.channelId, (input) =>
        createAiChannelReply({
          runnerRegistry,
          runtimeSupervisor,
          secretResolver,
          ...input,
        }));
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
    await handleChannelItem(request, response, config, storeRegistry, channelRoute.channelId);
    return;
  }

  const channelProposalRoute = parseChannelExecutionProposalRoute(url.pathname);
  if (channelProposalRoute) {
    await handleChannelExecutionProposalItem(request, response, config, storeRegistry, channelProposalRoute.proposalId);
    return;
  }

  const teammateRoute = parseTeammateRoute(url.pathname);
  if (teammateRoute) {
    if (!teammateRoute.action) {
      await handleTeammateItem(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "channels") {
      await handleTeammateChannelMemberships(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "memory-scopes") {
      await handleTeammateMemoryScopes(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "skills") {
      await handleTeammateSkillBindings(request, response, config, storeRegistry, teammateRoute.teammateId);
      return;
    }
    if (teammateRoute.action === "mcp") {
      await handleTeammateMcpBindings(request, response, config, storeRegistry, teammateRoute.teammateId);
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
    if (teammateRoute.action === "direct-messages") {
      await handleTeammateDirectMessagesCollection(
        request,
        response,
        config,
        storeRegistry,
        teammateRoute.teammateId,
        ({ store, teammate, thread, sourceMessage, providerPresetId }) =>
          createAiTeammateDirectReply({
            runnerRegistry,
            store,
            teammate,
            thread,
            sourceMessage,
            providerPresetId,
            runtimeSupervisor,
            secretResolver,
          }),
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
        ({ store, teammate, thread, sourceMessage, providerPresetId, signal, stream }) =>
          createAiTeammateDirectReply({
            runnerRegistry,
            store,
            teammate,
            thread,
            sourceMessage,
            providerPresetId,
            runtimeSupervisor,
            secretResolver,
            signal,
            stream,
          }),
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
          await executeRunRequest(
            {
              workspaceCwd,
              cwd: channel.boundPath ?? workspaceCwd,
              providerPresetId: runRequest.providerPresetId,
              runnerId: runRequest.runnerId,
              teammateId: task.assigneeTeammateId ?? channel.defaultTeammateId,
              requestedSkillId: runRequest.requestedSkillId ?? task.requestedSkillId,
              skipProviderPreflight: runRequest.skipProviderPreflight,
              idempotencyKey: runRequest.idempotencyKey,
              task: {
                id: task.id,
                title: task.title,
                prompt: task.prompt,
                channelId: task.channelId,
              },
              tools: runRequest.tools ?? channel.allowedTools,
              approvalProfile: runRequest.approvalProfile,
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
    await handleProviderItem(request, response, config, storeRegistry, secretResolver, providerRoute);
    return;
  }

  const mcpServerRoute = parseMcpServerRoute(url.pathname);
  if (mcpServerRoute) {
    await handleMcpServerItem(request, response, config, storeRegistry, mcpBroker, secretResolver, mcpServerRoute);
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
        handleRunMediaJob(response, url, storeRegistry, secretResolver, mediaJobId, {
          expirePendingMediaApprovals: (store, pendingMediaJobId) => {
            expireStalePendingApprovals(store, { mediaJobId: pendingMediaJobId });
          },
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
        }),
    );
    return;
  }

  const approvalRoute = parseApprovalRoute(url.pathname);
  if (approvalRoute) {
    await handleApprovalItem(request, response, config, storeRegistry, approvalRoute, ({ cwd, store, approval, now }) =>
      syncMediaJobForApprovalDecision({
        cwd,
        store,
        storeRegistry,
        secretResolver,
        approval,
        now,
        hooks: {
          expirePendingMediaApprovals: (approvalStore, pendingMediaJobId) => {
            expireStalePendingApprovals(approvalStore, { mediaJobId: pendingMediaJobId });
          },
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
        },
      }));
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

async function startDetachedRunAndResolveReady(
  startRun: (onRunReady: (runId: string) => void) => Promise<string | undefined>,
): Promise<string | undefined> {
  let settled = false;
  return await new Promise<string | undefined>((resolve) => {
    const settle = (runId: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(runId);
    };
    void startRun((runId) => settle(runId))
      .then((runId) => settle(runId))
      .catch(() => settle(undefined));
  });
}
