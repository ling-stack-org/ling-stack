import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  approvalToolDecisions,
  approvalStatuses,
  createRunId,
  createSqliteRunStore,
  defaultApprovalToolDecisions,
  defaultProviderTemplates,
  getRunSummaryPath,
  isSupportedSecretRef,
  mediaJobStatuses,
  mediaOperations,
  providerApis,
  providerCapabilities,
  providerKinds,
  redactSecrets,
  readOnlyRunTools,
  resolveSecretRef,
  taskStatuses,
  writeRunSummary,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalStatus,
  type ApprovalToolDecision,
  type ArtifactType,
  type CreateApprovalRequestInput,
  type ChannelUpdateInput,
  type CreateMediaJobInput,
  type CreateChannelInput,
  type CreateTaskInput,
  type MediaJob,
  type MediaJobStatus,
  type MediaOperation,
  type ProviderApi,
  type ProviderCapability,
  type ProviderCheckResult,
  type ProviderKind,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
  type PublicProviderPreset,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventType,
  type RunTool,
  type RunSession,
  type RunStore,
  type RunSummary,
  type RunStatus,
  type TaskStatus,
  type TaskUpdateInput,
} from "@ling-stack/core";
import {
  createPiRunner,
  type PiRunnerApprovalRequest,
  type PiRunnerEvent,
  type PiRunnerProviderConfig,
  type PiRunnerResult,
  type PiRunnerRunOptions,
} from "@ling-stack/runner-pi";
import {
  createDefaultMediaAdapterRegistry,
  createLiveMediaVendorTransport,
  executeMediaJob as executeMediaAdapterJob,
  resolveMediaAdapter,
  resolveMediaVendorTransportGateConfig,
  type MediaExecutionArtifact,
} from "@ling-stack/providers";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
}

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export type RunStoreFactory = (cwd: string) => RunStore;

export interface DaemonDependencies {
  readonly runner?: RunnerAdapter;
  readonly storeFactory?: RunStoreFactory;
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
  maxBodyBytes: 1024 * 1024,
};

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_PREVIEW_LIMIT = 1_200;
const PROVIDER_CHECK_TIMEOUT_MS = 10_000;
const MAX_EXTRACTED_ARTIFACT_BYTES = 256 * 1024;
const MAX_EXTRACTED_ARTIFACTS_PER_TOOL = 6;

export interface RunRequest extends Omit<PiRunnerRunOptions, "onApprovalRequired" | "onEvent" | "provider"> {
  readonly workspaceCwd?: string;
  readonly providerPresetId?: string;
  readonly provider?: PiRunnerProviderConfig;
  readonly skipProviderPreflight?: boolean;
}

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonServer(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runner = dependencies.runner ?? createPiRunner();
  const storeRegistry = new RunStoreRegistry(dependencies.storeFactory ?? createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolvedConfig, runner, storeRegistry, activeRuns);
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  return {
    server,
    config: resolvedConfig,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        server.close((error) => {
          storeRegistry.closeAll();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function startDaemon(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): Promise<DaemonServer> {
  const daemon = createDaemonServer(config, dependencies);
  await daemon.start();
  return daemon;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, service: "ling-stack-daemon" });
    return;
  }

  if (url.pathname === "/channels") {
    await handleChannelsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/tasks") {
    await handleTasksCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/providers") {
    await handleProvidersCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/media-jobs") {
    await handleMediaJobsCollection(request, response, config, storeRegistry);
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

  if (request.method === "POST" && url.pathname === "/runs") {
    await handleRun(request, response, config, runner, storeRegistry, activeRuns);
    return;
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    handleListRuns(response, url, storeRegistry);
    return;
  }

  const runRoute = parseRunRoute(url.pathname);
  if (request.method === "POST" && runRoute?.kind === "cancel") {
    handleCancelRun(response, url, storeRegistry, activeRuns, runRoute.runId);
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

  const artifactRoute = parseArtifactRoute(url.pathname);
  if (request.method === "GET" && artifactRoute?.kind === "artifact") {
    handleGetArtifact(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }
  if (request.method === "GET" && artifactRoute?.kind === "content") {
    handleGetArtifactContent(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }

  const channelRoute = parseChannelRoute(url.pathname);
  if (channelRoute) {
    await handleChannelItem(request, response, config, storeRegistry, channelRoute.channelId);
    return;
  }

  const taskRoute = parseTaskRoute(url.pathname);
  if (taskRoute) {
    await handleTaskItem(request, response, config, storeRegistry, taskRoute.taskId);
    return;
  }

  const providerRoute = parseProviderRoute(url.pathname);
  if (providerRoute) {
    await handleProviderItem(request, response, config, storeRegistry, providerRoute);
    return;
  }

  const mediaJobRoute = parseMediaJobRoute(url.pathname);
  if (mediaJobRoute) {
    if (request.method === "POST" && mediaJobRoute.action === "run") {
      await handleRunMediaJob(response, url, storeRegistry, mediaJobRoute.mediaJobId);
      return;
    }
    if (request.method === "GET" && mediaJobRoute.action === "artifacts") {
      handleListMediaJobArtifacts(response, url, storeRegistry, mediaJobRoute.mediaJobId);
      return;
    }
    if (mediaJobRoute.action) {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for media job ${mediaJobRoute.action}` });
      return;
    }
    handleMediaJobItem(request, response, config, storeRegistry, mediaJobRoute.mediaJobId);
    return;
  }

  const approvalRoute = parseApprovalRoute(url.pathname);
  if (approvalRoute) {
    await handleApprovalItem(request, response, config, storeRegistry, approvalRoute);
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
): Promise<void> {
  let runRequest: RunRequest;
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    runRequest = parseRunRequest(body);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let store: RunStore;
  let run: RunSession;
  let runnerRequest: PiRunnerRunOptions;
  try {
    const workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
    store = storeRegistry.getStore(workspaceCwd);
    const resolvedProvider = resolveProviderForRun(store, runRequest);
    runnerRequest = {
      cwd: runRequest.cwd,
      task: runRequest.task,
      provider: resolvedProvider,
      tools: runRequest.tools,
      thinkingLevel: runRequest.thinkingLevel,
      systemPrompt: runRequest.systemPrompt,
      appendSystemPrompt: runRequest.appendSystemPrompt,
      agentDir: runRequest.agentDir,
    };
    const runId = createRunId();
    const createdAt = new Date().toISOString();
    run = store.createRun({
      id: runId,
      cwd: runRequest.cwd,
      taskId: runRequest.task.id,
      channelId: runRequest.task.channelId,
      providerPresetId: runRequest.providerPresetId,
      providerName: resolvedProvider.provider,
      providerModel: resolvedProvider.model,
      taskSnapshot: runRequest.task,
      providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...resolvedProvider },
      requestSnapshot: { ...runRequest, workspaceCwd, provider: resolvedProvider },
      createdAt,
    });
    storeRegistry.rememberRun(run.id, store);
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      workspaceCwd,
      cwd: run.cwd,
      providerName: run.providerName,
      providerModel: run.providerModel,
    });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  writeSseHead(response);
  writeSse(response, "ready", { ok: true, runId: run.id });

  const abortController = new AbortController();
  let clientClosed = false;
  let runStartedAt: string | undefined;
  let persistedRunError = false;
  let persistenceError: unknown;
  let extractedArtifactCounter = 0;
  const toolStartArgsById = new Map<string, unknown>();
  response.on("close", () => {
    clientClosed = true;
  });

  const streamEnvelope = (envelope: RunEventEnvelope): void => {
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
  };

  activeRuns.add(run.id, {
    abortController,
    streamEnvelope,
  });

  const appendAndMaybeStream = (type: RunEventType, data: unknown): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }
    if (abortController.signal.aborted && type !== "run_cancelled") {
      return undefined;
    }
    if (store.getRun(run.id)?.status === "cancelled" && type !== "run_cancelled") {
      return undefined;
    }

    try {
      const envelope = store.appendEvent(run.id, type, data);
      if (type === "run_error") {
        persistedRunError = true;
      }
      streamEnvelope(envelope);
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };

  try {
    runStartedAt = new Date().toISOString();
    store.markRunStarted(run.id, runStartedAt);
    updateLinkedTaskForRun(store, run.taskId, { status: "running", currentRunId: run.id });
    const approvalPolicy = store.getApprovalPolicy();

    const result = await runner.runTask({
      ...runnerRequest,
      onApprovalRequired: createRunApprovalHandler({
        store,
        run,
        approvalPolicy,
        appendAndMaybeStream,
        streamEnvelope,
        signal: abortController.signal,
      }),
      onEvent: (event: PiRunnerEvent) => {
        if (event.type === "tool_start") {
          toolStartArgsById.set(event.toolCallId, event.args);
        }
        const eventEnvelope = appendAndMaybeStream(event.type, event);
        if (eventEnvelope && event.type === "tool_end") {
          const sourceArgs = toolStartArgsById.get(event.toolCallId);
          try {
            const artifacts = persistExtractedArtifacts({
              store,
              run,
              event,
              sourceArgs,
              nextIndex: () => {
                extractedArtifactCounter += 1;
                return extractedArtifactCounter;
              },
            });
            for (const artifact of artifacts) {
              appendAndMaybeStream("artifact_created", {
                artifact,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
            }
          } catch {
            // Artifact extraction is best-effort evidence capture; runner output remains authoritative.
          }
        }
      },
      signal: abortController.signal,
    });

    if (persistenceError) {
      throw persistenceError;
    }
    if (store.getRun(run.id)?.status === "cancelled") {
      if (!clientClosed) {
        response.end();
      }
      return;
    }

    const resultEnvelope = appendAndMaybeStream("result", {
      taskId: result.taskId,
      messageCount: result.messages.length,
      runnerEventCount: result.events.length,
    });
    if (!resultEnvelope && persistenceError) {
      throw persistenceError;
    }

    const endedAt = new Date().toISOString();
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "succeeded",
      taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id),
      messageCount: result.messages.length,
      startedAt: runStartedAt,
      endedAt,
      errorMessage: null,
    });
    store.markRunSucceeded(run.id, endedAt, summaryPath);
    updateLinkedTaskForRun(store, run.taskId, { status: "done", currentRunId: run.id });

    if (!clientClosed) {
      response.end();
    }
  } catch (error) {
    if (isAbortError(error) || store.getRun(run.id)?.status === "cancelled") {
      ensureRunCancelled({
        store,
        runId: run.id,
        taskId: run.taskId,
        startedAt: runStartedAt,
        reason: "cancelled",
        active: false,
        streamEnvelope,
      });
      if (!clientClosed) {
        response.end();
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const endedAt = new Date().toISOString();
    const failureEvent = persistedRunError
      ? undefined
      : appendFailureEvent(store, run.id, message, clientClosed, response);
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "failed",
      taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt,
      endedAt,
      errorMessage: message,
    });
    store.markRunFailed(run.id, endedAt, message, summaryPath);
    updateLinkedTaskForRun(store, run.taskId, { status: "failed", currentRunId: run.id });

    if (!clientClosed) {
      response.end();
    }
  } finally {
    activeRuns.delete(run.id);
  }
}

async function handleChannelsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channels: store.listChannels({ limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const channel = store.createChannel(parseCreateChannelInput(body), new Date().toISOString());
      writeJson(response, 201, { channel });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { channel });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateChannel(channelId, parseChannelUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { channel: updated });
      return;
    }

    if (request.method === "DELETE") {
      const tasks = store.listTasks({ channelId, limit: 1 });
      if (tasks.length > 0) {
        writeJson(response, 409, { error: "channel_has_tasks", message: `Channel has tasks and cannot be deleted: ${channelId}` });
        return;
      }
      store.deleteChannel(channelId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTasksCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        tasks: store.listTasks({
          channelId: url.searchParams.get("channelId") ?? undefined,
          status: readOptionalTaskStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateTaskInput(body);
      if (!store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const task = store.createTask(input, new Date().toISOString());
      writeJson(response, 201, { task });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTaskItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  taskId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const task = store.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${taskId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { task });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseTaskUpdateInput(body);
      if (input.channelId && !store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const updated = store.updateTask(taskId, input, new Date().toISOString());
      writeJson(response, 200, { task: updated });
      return;
    }

    if (request.method === "DELETE") {
      store.deleteTask(taskId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleProvidersCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd,
      providers: store.listProviderPresets().map(toPublicProviderPreset),
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const preset = store.createProviderPreset(parseProviderPresetInput(body), new Date().toISOString());
      writeJson(response, 201, { provider: toPublicProviderPreset(preset) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /providers` });
}

async function handleProviderItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly providerId: string; readonly action?: "check" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const preset = store.getProviderPreset(route.providerId);
  if (!preset) {
    writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
    return;
  }

  if (request.method === "POST" && route.action === "check") {
    const checkResult = await checkProviderPreset(preset);
    store.recordProviderCheckResult(route.providerId, checkResult);
    writeJson(response, 200, checkResult);
    return;
  }

  if (route.action) {
    writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, { provider: toPublicProviderPreset(preset) });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updateInput = parseProviderPresetUpdateInput(body);
      validateProviderPresetUpdate(preset, updateInput);
      const updated = store.updateProviderPreset(route.providerId, updateInput, new Date().toISOString());
      if (!updated) {
        writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
        return;
      }
      writeJson(response, 200, { provider: toPublicProviderPreset(updated) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    store.deleteProviderPreset(route.providerId);
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for provider presets` });
}

async function handleMediaJobsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        mediaJobs: store.listMediaJobs({
          providerPresetId: url.searchParams.get("providerPresetId") ?? undefined,
          status: readOptionalMediaJobStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateMediaJobInput(body);
      assertMediaJobProvider(store, input);
      const job = store.createMediaJob(input, new Date().toISOString());
      writeJson(response, 201, { mediaJob: job });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /media-jobs` });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleMediaJobItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for media jobs` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, { mediaJob: job });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRunMediaJob(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  let store: RunStore | undefined;
  let job: MediaJob | undefined;
  let startedExecution = false;
  try {
    store = storeRegistry.getStore(cwd);
    job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    if (!isRunnableMediaJobStatus(job.status)) {
      writeJson(response, 409, {
        error: "media_job_not_runnable",
        message: `Media job cannot be run from status ${job.status}: ${mediaJobId}`,
      });
      return;
    }

    const provider = assertMediaJobProvider(store, {
      providerPresetId: job.providerPresetId,
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
    });

    const approvalGate = applyMediaCostApprovalGate(store, job, provider);
    if (approvalGate.kind === "waiting_for_approval") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }
    if (approvalGate.kind === "blocked") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }

    job = store.updateMediaJobStatus(job.id, { status: "running", errorMessage: null }, new Date().toISOString()) ?? job;
    startedExecution = true;

    const requestedAt = new Date().toISOString();
    const execution = await executeMediaAdapterJob(createMediaAdapterForProvider(provider), {
      jobId: job.id,
      provider: {
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        providerId: provider.providerId,
        model: provider.model,
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKeyRef: provider.apiKeyRef,
        capabilities: provider.capabilities,
      },
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
      requestedAt,
    });

    if (execution.status === "failed") {
      const failed = store.updateMediaJobStatus(
        job.id,
        {
          status: "failed",
          errorMessage: execution.errorMessage ?? "Media adapter execution failed.",
        },
        new Date().toISOString(),
      ) ?? job;
      writeJson(response, 200, { mediaJob: failed, artifacts: [] });
      return;
    }

    const completedAt = new Date().toISOString();
    const artifacts = createMediaJobArtifacts(store, job, execution.artifacts, completedAt);
    const artifactIds = [...new Set([...job.artifactIds, ...artifacts.map((artifact) => artifact.id)])];
    const succeeded = store.updateMediaJobStatus(
      job.id,
      {
        status: "succeeded",
        artifactIds,
        errorMessage: null,
      },
      completedAt,
    ) ?? job;

    writeJson(response, 200, { mediaJob: succeeded, artifacts });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : startedExecution ? 500 : 400;
    const message = error instanceof Error ? error.message : String(error);
    const failed = store && job && startedExecution
      ? store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString())
      : undefined;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : startedExecution ? "media_job_execution_failed" : "bad_request",
      message,
      ...(failed ? { mediaJob: failed } : {}),
    });
  }
}

function handleListMediaJobArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, {
      mediaJobId,
      artifacts: store.listMediaJobArtifacts(mediaJobId),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovalPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, { cwd, policy: store.getApprovalPolicy() });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const policy = store.updateApprovalPolicy(parseApprovalPolicyUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { cwd, policy });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval policy` });
}

function handleApprovalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /approvals` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    expireStalePendingApprovals(store, {
      runId: url.searchParams.get("runId") ?? undefined,
      mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      approvals: store.listApprovalRequests({
        status: readOptionalApprovalStatusQuery(url),
        runId: url.searchParams.get("runId") ?? undefined,
        mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly approvalId: string; readonly action?: "approve" | "deny" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  expireStaleApproval(store, route.approvalId);
  const approval = store.getApprovalRequest(route.approvalId);
  if (!approval) {
    writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
    return;
  }

  if (!route.action && request.method === "GET") {
    writeJson(response, 200, { approval });
    return;
  }

  if (!route.action) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval requests` });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval decisions` });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const decision = { reason: isRecord(body) ? readOptionalString(body, "reason") : undefined, resolvedBy: "local-user" as const };
    const now = new Date().toISOString();
    const updated =
      route.action === "approve"
        ? store.approveApprovalRequest(route.approvalId, decision, now)
        : store.denyApprovalRequest(route.approvalId, decision, now);
    if (!updated) {
      writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
      return;
    }
    appendApprovalDecisionEvent(store, updated);
    writeJson(response, 200, { approval: updated });
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error && error.message.includes("not pending") ? "approval_not_pending" : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeTerminalSummary(summaryPath: string, summary: RunSummary): string | undefined {
  try {
    writeRunSummary(summaryPath, summary);
    return summaryPath;
  } catch {
    return undefined;
  }
}

function handleListRuns(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, {
      error: "bad_request",
      message: "cwd query parameter is required",
    });
    return;
  }

  try {
    const limit = readOptionalIntegerQuery(url, "limit", 1);
    const status = readOptionalRunStatusQuery(url);
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      runs: store.listRuns({ limit, status }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleGetRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, run);
}

function handleGetRunEvents(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  let afterSeq: number | undefined;
  let limit: number | undefined;
  try {
    afterSeq = readOptionalIntegerQuery(url, "afterSeq", 0);
    limit = readOptionalIntegerQuery(url, "limit", 1);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  const events = store.listEvents(runId, { afterSeq, limit });
  const lastEvent = events.at(-1);
  writeJson(response, 200, {
    runId,
    events,
    nextSeq: lastEvent ? lastEvent.seq + 1 : (afterSeq ?? 0) + 1,
  });
}

function handleListRunArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    runId,
    artifacts: store.listArtifacts(runId),
  });
}

function handleGetArtifact(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    artifact: lookup.artifact,
  });
}

function handleGetArtifactContent(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  let artifactPath: string;
  try {
    artifactPath = resolveArtifactContentPath(lookup.store, lookup.artifact);
  } catch (error) {
    writeJson(response, 403, {
      error: "artifact_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const stats = statSync(artifactPath);
    if (!stats.isFile()) {
      writeJson(response, 404, {
        error: "artifact_content_not_found",
        message: `Artifact content is not a file: ${lookup.artifact.id}`,
      });
      return;
    }

    const content = readFileSync(artifactPath);
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
      "Content-Length": String(content.byteLength),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    writeJson(response, 404, {
      error: "artifact_content_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleCancelRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!store || !run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (run.status === "cancelled") {
    writeJson(response, 200, { cancelled: true, active: false, run });
    return;
  }

  if (isTerminalRunStatus(run.status)) {
    writeJson(response, 409, {
      error: "run_not_cancellable",
      message: `Run ${runId} is already ${run.status}.`,
      run,
    });
    return;
  }

  const activeRun = activeRuns.get(runId);
  const cancelled = ensureRunCancelled({
    store,
    runId,
    taskId: run.taskId,
    startedAt: run.startedAt,
    reason: "user_requested",
    active: Boolean(activeRun),
    streamEnvelope: activeRun?.streamEnvelope,
  });
  activeRun?.abortController.abort();

  writeJson(response, 200, {
    cancelled: true,
    active: Boolean(activeRun),
    run: store.getRun(runId),
    event: cancelled.event,
  });
}

function ensureRunCancelled(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}): { readonly event?: RunEventEnvelope } {
  const current = input.store.getRun(input.runId);
  if (!current || current.status === "cancelled") {
    return {};
  }
  if (isTerminalRunStatus(current.status)) {
    return {};
  }

  const endedAt = new Date().toISOString();
  const event = input.store.appendEvent(input.runId, "run_cancelled", {
    reason: input.reason,
    active: input.active,
  });
  input.streamEnvelope?.(event);
  const summaryPath = writeTerminalSummary(getRunSummaryPath(input.store.paths, input.runId), {
    runId: input.runId,
    status: "cancelled",
    taskId: input.taskId,
    eventCount: event.seq,
    startedAt: input.startedAt,
    endedAt,
    errorMessage: null,
  });
  input.store.markRunCancelled(input.runId, endedAt, summaryPath);
  updateLinkedTaskForRun(input.store, input.taskId, { status: "cancelled", currentRunId: input.runId });
  return { event };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function updateLinkedTaskForRun(store: RunStore, taskId: string, input: TaskUpdateInput): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, input, new Date().toISOString());
}

function appendFailureEvent(
  store: RunStore,
  runId: string,
  message: string,
  clientClosed: boolean,
  response: ServerResponse,
): RunEventEnvelope | undefined {
  try {
    const envelope = store.appendEvent(runId, "run_error", { message });
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function resolveProviderForRun(store: RunStore, runRequest: RunRequest): PiRunnerProviderConfig {
  if (runRequest.providerPresetId && runRequest.provider) {
    throw new HttpError(400, "bad_request", "providerPresetId and inline provider cannot both be supplied");
  }

  if (runRequest.providerPresetId) {
    const preset = store.getProviderPreset(runRequest.providerPresetId);
    if (!preset) {
      throw new HttpError(404, "provider_not_found", `Provider preset not found: ${runRequest.providerPresetId}`);
    }
    if (!preset.enabled) {
      throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
    }
    if (preset.api === "media-job") {
      throw new HttpError(400, "unsupported_capability", "Media provider presets cannot run pi coding tasks");
    }
    if (!preset.capabilities.includes("chat")) {
      throw new HttpError(400, "unsupported_capability", "Provider preset must include chat capability for coding runs");
    }
    assertProviderRunPreflight(preset, runRequest.skipProviderPreflight === true);
    const secret = resolveSecretRef(preset.apiKeyRef);
    return removeUndefined({
      provider: preset.providerId,
      model: preset.model,
      displayName: preset.displayName,
      apiKey: secret.value,
      baseUrl: preset.baseUrl,
      api: preset.api as PiRunnerProviderConfig["api"],
      headers: preset.headers,
      authHeader: preset.authHeader,
      reasoning: preset.reasoning,
      input: preset.input,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      compat: preset.compat,
    }) as PiRunnerProviderConfig;
  }

  if (!runRequest.provider) {
    throw new HttpError(400, "bad_request", "Either providerPresetId or provider is required");
  }

  return runRequest.provider;
}

function assertProviderRunPreflight(preset: ProviderPreset, skipProviderPreflight: boolean): void {
  if (skipProviderPreflight) {
    return;
  }

  const secretBlocker = providerSecretPreflightBlocker(preset);
  if (secretBlocker) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: ${secretBlocker}`);
  }

  if (!preset.lastCheck) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: provider has not been checked. Run provider check before starting.`);
  }
  if (!preset.lastCheck.ok) {
    throw new HttpError(
      400,
      "provider_preflight_failed",
      `${preset.displayName}: provider check failed (${preset.lastCheck.code ?? "failed"}). ${preset.lastCheck.message}`.trim(),
    );
  }
}

function providerSecretPreflightBlocker(preset: ProviderPreset): string | undefined {
  const needsSecret = preset.api !== "media-job" && (preset.api === "anthropic-messages" || preset.authHeader !== false);
  if (needsSecret && !preset.apiKeyRef) {
    return "missing apiKeyRef.";
  }
  if (preset.apiKeyRef && !resolveSecretRef(preset.apiKeyRef).configured) {
    return `missing ${preset.apiKeyRef}.`;
  }
  return undefined;
}

function appendApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): void {
  if (!approval.runId) {
    return;
  }
  const run = store.getRun(approval.runId);
  if (!run) {
    return;
  }
  store.appendEvent(approval.runId, approvalDecisionEventType(approval), {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
  });
}

function approvalDecisionEventType(approval: ApprovalRequest): Extract<RunEventType, "approval_approved" | "approval_denied" | "approval_expired"> {
  if (approval.status === "approved") {
    return "approval_approved";
  }
  if (approval.status === "expired") {
    return "approval_expired";
  }
  return "approval_denied";
}

function expireStalePendingApprovals(store: RunStore, options: { readonly runId?: string; readonly mediaJobId?: string } = {}): void {
  const now = new Date().toISOString();
  let safety = 0;
  for (;;) {
    const pending = store.listApprovalRequests({ status: "pending", runId: options.runId, mediaJobId: options.mediaJobId, limit: 500 });
    const expired = pending.filter((approval) => approval.expiresAt && approval.expiresAt <= now);
    if (expired.length === 0) {
      return;
    }
    for (const approval of expired) {
      expireApproval(store, approval, now);
    }
    safety += 1;
    if (pending.length < 500 || safety > 20) {
      return;
    }
  }
}

function expireStaleApproval(store: RunStore, approvalId: string): void {
  const approval = store.getApprovalRequest(approvalId);
  const now = new Date().toISOString();
  if (!approval || approval.status !== "pending" || !approval.expiresAt || approval.expiresAt > now) {
    return;
  }
  expireApproval(store, approval, now);
}

function expireApproval(store: RunStore, approval: ApprovalRequest, now: string): ApprovalRequest | undefined {
  const expired = store.expireApprovalRequest(
    approval.id,
    { reason: "Approval request expired before a decision was received." },
    now,
  );
  if (expired) {
    appendApprovalDecisionEvent(store, expired);
  }
  return expired;
}

function createRunApprovalHandler(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approvalPolicy: ApprovalPolicy;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
}): PiRunnerRunOptions["onApprovalRequired"] {
  return async (request: PiRunnerApprovalRequest) => {
    const approvalInput = toCreateApprovalRequestInput(options.run, request);
    const policyDecision = evaluateApprovalPolicy(options.approvalPolicy, request, approvalInput.payload);
    if (policyDecision.decision === "allow") {
      return {
        approved: true,
        reason: policyDecision.reason,
      };
    }

    if (policyDecision.decision === "deny") {
      const denied = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
      const resolved = options.store.denyApprovalRequest(
        denied.id,
        { reason: policyDecision.reason },
        new Date().toISOString(),
      );
      if (!resolved) {
        throw new Error(`Approval request not found after policy denial: ${denied.id}`);
      }
      const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(resolved));
      streamOrAppendApprovalDecisionEvent({
        store: options.store,
        approval: resolved,
        afterSeq: requestEvent?.seq ?? 0,
        appendAndMaybeStream: options.appendAndMaybeStream,
        streamEnvelope: options.streamEnvelope,
      });
      return {
        approved: false,
        approvalId: resolved.id,
        reason: resolved.decisionReason,
      };
    }

    const approval = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
    const waitingAt = new Date().toISOString();
    options.store.markRunWaitingForApproval(options.run.id, waitingAt);
    const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(approval));

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    options.store.markRunRunning(options.run.id, new Date().toISOString());
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
    });

    if (resolvedApproval.status === "approved") {
      return {
        approved: true,
        approvalId: resolvedApproval.id,
        reason: resolvedApproval.decisionReason,
      };
    }

    return {
      approved: false,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
    };
  };
}

function approvalRequestEventPayload(approval: ApprovalRequest): Record<string, unknown> {
  return {
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    expiresAt: approval.expiresAt,
  };
}

function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  request: PiRunnerApprovalRequest,
  payload: ApprovalPayload,
): { readonly decision: ApprovalToolDecision; readonly reason: string } {
  const toolDecision = policy.toolDecisions[request.toolName] ?? defaultApprovalToolDecisions[request.toolName];
  if (toolDecision === "deny") {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}.`,
    };
  }

  if ((payload.type === "file_write" || payload.type === "file_edit") && !isPathWithinAllowedWritePaths(payload.path, request.cwd, policy.allowedWritePaths)) {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}: ${payload.path} is outside allowed write paths.`,
    };
  }

  if (toolDecision === "allow") {
    return {
      decision: "allow",
      reason: `Ling Stack policy allowed ${request.toolName}.`,
    };
  }

  return {
    decision: "ask",
    reason: `Ling Stack policy requires approval for ${request.toolName}.`,
  };
}

function toCreateApprovalRequestInput(run: RunSession, request: PiRunnerApprovalRequest): CreateApprovalRequestInput {
  const payload = toApprovalPayload(request);
  const risk = classifyApprovalRisk(request, payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: request.toolName,
    risk,
    title: approvalTitle(request.toolName, risk),
    description: approvalDescription(request.toolName, payload),
    payload,
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function toApprovalPayload(request: PiRunnerApprovalRequest): ApprovalPayload {
  if (request.toolName === "bash") {
    const command = readInputString(request.input, "command", "");
    return {
      type: "bash",
      cwd: request.cwd,
      command,
      riskFlags: classifyBashRiskFlags(command),
    };
  }

  if (request.toolName === "write") {
    const path = readInputString(request.input, "path", "<unknown>");
    const content = readInputString(request.input, "content", "");
    return {
      type: "file_write",
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncatePreview(content),
    };
  }

  if (request.toolName !== "edit") {
    return {
      type: "tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  const path = readInputString(request.input, "path", "<unknown>");
  return {
    type: "file_edit",
    path,
    diffPreview: truncatePreview(formatEditPreview(readInputArray(request.input, "edits"))),
  };
}

function classifyApprovalRisk(request: PiRunnerApprovalRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }

  if (payload.type === "file_write" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "file_edit" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "tool_call") {
    return "low";
  }

  return "medium";
}

function approvalTitle(toolName: PiRunnerApprovalRequest["toolName"], risk: ApprovalRisk): string {
  if (toolName === "bash") {
    return risk === "high" ? "Approve high-risk shell command" : "Approve shell command";
  }
  if (toolName === "write") {
    return "Approve file write";
  }
  if (toolName === "edit") {
    return "Approve file edit";
  }
  return `Approve ${toolName}`;
}

function approvalDescription(toolName: PiRunnerApprovalRequest["toolName"], payload: ApprovalPayload): string {
  if (payload.type === "bash") {
    return payload.command || "The agent requested a shell command.";
  }
  if (payload.type === "file_write") {
    return `The agent requested writing ${payload.bytes} bytes to ${payload.path}.`;
  }
  if (payload.type === "file_edit") {
    return `The agent requested editing ${payload.path}.`;
  }
  if (payload.type === "tool_call") {
    return `The agent requested ${payload.toolName}.`;
  }
  return `The agent requested ${toolName}.`;
}

async function waitForApprovalDecision(store: RunStore, approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const approval = store.getApprovalRequest(approvalId);
    if (!approval) {
      throw new Error(`Approval request not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      return approval;
    }
    await delay(APPROVAL_POLL_INTERVAL_MS);
  }

  const expired = store.expireApprovalRequest(
    approvalId,
    { reason: "Approval request timed out before a decision was received." },
    new Date().toISOString(),
  );
  if (!expired) {
    throw new Error(`Approval request not found after timeout: ${approvalId}`);
  }
  appendApprovalDecisionEvent(store, expired);
  return expired;
}

function streamOrAppendApprovalDecisionEvent(options: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly afterSeq: number;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}): void {
  const existingEvent = findApprovalDecisionEvent(options.store, options.approval, options.afterSeq);
  if (existingEvent) {
    options.streamEnvelope(existingEvent);
    return;
  }

  options.appendAndMaybeStream(approvalDecisionEventType(options.approval), {
    approvalId: options.approval.id,
    status: options.approval.status,
    resolvedBy: options.approval.resolvedBy,
    decisionReason: options.approval.decisionReason,
  });
}

function findApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
  afterSeq: number,
): RunEventEnvelope | undefined {
  if (!approval.runId) {
    return undefined;
  }
  return store
    .listEvents(approval.runId, { afterSeq, limit: 1000 })
    .find(
      (event) =>
        (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") &&
        isRecord(event.data) &&
        event.data.approvalId === approval.id,
    );
}

function classifyBashRiskFlags(command: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\n]*r[^\n]*f|[^\n]*f[^\n]*r)\b/i, "destructive_remove"],
    [/\bgit\s+reset\s+--hard\b/i, "git_reset_hard"],
    [/\bgit\s+push\b[^\n]*--force\b/i, "git_force_push"],
    [/\bsudo\b/i, "sudo"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\b(?:dd|mkfs|diskutil)\b/i, "disk_mutation"],
    [/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*\b(?:apply|delete|deploy|destroy|terminate)\b/i, "external_mutation"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash)\b/i, "remote_script_execution"],
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, flag]) => flag);
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") {
    return true;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  if (inputPath === "<unknown>") {
    return false;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

interface ExtractedArtifactCandidate {
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType?: string;
  readonly content?: string;
  readonly existingPath?: string;
}

function persistExtractedArtifacts(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
  readonly nextIndex: () => number;
}): RunArtifact[] {
  const candidates = extractArtifactCandidates(options);
  const artifacts: RunArtifact[] = [];
  for (const candidate of candidates.slice(0, MAX_EXTRACTED_ARTIFACTS_PER_TOOL)) {
    const artifact = materializeExtractedArtifact(options.store, options.run.id, candidate, options.nextIndex());
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function extractArtifactCandidates(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
}): ExtractedArtifactCandidate[] {
  const candidates: ExtractedArtifactCandidate[] = [];
  const addTextCandidate = (title: string, content: string, type?: ArtifactType): void => {
    if (!content.trim()) {
      return;
    }
    const artifactType = type ?? inferArtifactTypeFromText(content);
    candidates.push({
      type: artifactType,
      title,
      content,
      contentType: contentTypeForArtifactType(artifactType),
    });
  };

  collectToolResultTextCandidates(options.event).forEach((candidate) => addTextCandidate(candidate.title, candidate.content, candidate.type));

  const generatedPath = readInputString(options.sourceArgs, "path", "");
  if (options.event.toolName === "write") {
    const generatedContent = readInputString(options.sourceArgs, "content", "");
    if (generatedContent) {
      addTextCandidate(
        `Generated file content: ${generatedPath || options.event.toolCallId}`,
        generatedContent,
        inferArtifactTypeFromPath(generatedPath, generatedContent),
      );
    }
  }

  if (options.event.toolName === "edit") {
    const edits = readInputArray(options.sourceArgs, "edits");
    const hasDiffOutput = candidates.some((candidate) => candidate.type === "diff");
    if (edits.length > 0 && !hasDiffOutput) {
      addTextCandidate(`Generated edit diff: ${generatedPath || options.event.toolCallId}`, formatEditPreview(edits), "diff");
    }
  }

  for (const rawPath of collectGeneratedArtifactPaths(options.event, options.sourceArgs)) {
    const existingPath = resolveExistingArtifactPath(options.store.paths.artifactsDir, options.run.cwd, rawPath);
    if (existingPath) {
      const artifactType = inferArtifactTypeFromPath(existingPath);
      candidates.push({
        type: artifactType,
        title: `Generated file: ${basename(rawPath) || rawPath}`,
        existingPath,
        contentType: contentTypeForArtifactType(artifactType),
      });
    } else {
      candidates.push({
        type: "file",
        title: `Generated file metadata: ${rawPath}`,
        content: formatGeneratedFileMetadata(options.event, rawPath),
        contentType: contentTypeForArtifactType("file"),
      });
    }
  }

  return dedupeArtifactCandidates(candidates);
}

function collectToolResultTextCandidates(
  event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>,
): Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> {
  if (typeof event.result === "string") {
    return [{ title: `${event.toolName} output`, content: event.result, type: inferArtifactTypeFromText(event.result) }];
  }
  const result = event.result;
  if (!isRecord(result)) {
    return [];
  }

  const candidates: Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> = [];
  const addField = (key: string, title: string, type?: ArtifactType): void => {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push({ title, content: value, type: type ?? inferArtifactTypeFromText(value) });
      return;
    }
    const textContent = readToolResultTextContent(value);
    if (textContent.trim()) {
      candidates.push({ title, content: textContent, type: type ?? inferArtifactTypeFromText(textContent) });
    }
  };

  addField("diff", `${event.toolName} diff`, "diff");
  addField("patch", `${event.toolName} patch`, "diff");
  addField("unifiedDiff", `${event.toolName} diff`, "diff");
  addField("markdown", `${event.toolName} markdown`, "markdown");
  addField("stdout", `${event.toolName} stdout`, "log");
  addField("stderr", `${event.toolName} stderr`, "log");
  addField("log", `${event.toolName} log`, "log");
  addField("output", `${event.toolName} output`);
  addField("text", `${event.toolName} text`);
  addField("content", `${event.toolName} content`);
  return candidates;
}

function readToolResultTextContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      const type = item.type;
      const text = item.text;
      if ((type === undefined || type === "text") && typeof text === "string") {
        return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function collectGeneratedArtifactPaths(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, sourceArgs: unknown): string[] {
  const paths = new Set<string>();
  for (const path of collectPathLikeFields(event.result)) {
    paths.add(path);
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = readInputString(sourceArgs, "path", "");
    if (looksLikeFilePathString(path)) {
      paths.add(path);
    }
  }

  return [...paths];
}

function collectPathLikeFields(value: unknown, keyHint = ""): string[] {
  if (typeof value === "string") {
    return keyLooksLikePath(keyHint) && looksLikeFilePathString(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPathLikeFields(item, keyHint));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => collectPathLikeFields(item, key));
}

function keyLooksLikePath(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "filename" ||
    normalized === "files" ||
    normalized === "paths" ||
    normalized.endsWith("path") ||
    normalized.endsWith("file") ||
    normalized.endsWith("files") ||
    normalized.includes("outputpath") ||
    normalized.includes("outputfile") ||
    normalized.includes("artifactpath") ||
    normalized.includes("targetpath")
  );
}

function looksLikeFilePathString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes("\n") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return false;
  }
  return trimmed.includes("/") || trimmed.includes("\\") || extname(trimmed) !== "";
}

function resolveExistingArtifactPath(artifactRoot: string, cwd: string, rawPath: string): string | undefined {
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [resolvePath(artifactRoot, rawPath), resolvePath(cwd, rawPath)];

  for (const candidate of candidates) {
    const absolutePath = resolvePath(candidate);
    if (!isPathInsideRoot(artifactRoot, absolutePath)) {
      continue;
    }
    const stats = statFileIfPresent(absolutePath);
    if (stats?.isFile()) {
      return absolutePath;
    }
  }
  return undefined;
}

function materializeExtractedArtifact(
  store: RunStore,
  runId: string,
  candidate: ExtractedArtifactCandidate,
  index: number,
): RunArtifact | undefined {
  const createdAt = new Date().toISOString();

  if (candidate.existingPath) {
    if (!isPathInsideRoot(store.paths.artifactsDir, candidate.existingPath)) {
      return undefined;
    }
    const stats = statFileIfPresent(candidate.existingPath);
    if (!stats?.isFile()) {
      return undefined;
    }
    return store.createArtifact({
      runId,
      type: candidate.type,
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, candidate.existingPath)),
      title: candidate.title,
      contentType: candidate.contentType,
      sizeBytes: Number(stats.size),
      createdAt,
    });
  }

  if (candidate.content === undefined) {
    return undefined;
  }

  const runArtifactDir = resolvePath(store.paths.artifactsDir, runId);
  mkdirSync(runArtifactDir, { recursive: true });
  const relativePath = `${runId}/${formatArtifactFilename(index, candidate)}`;
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  const content = truncateExtractedArtifactContent(redactArtifactContent(candidate.content));
  writeFileSync(absolutePath, content, "utf8");
  const stats = statSync(absolutePath);

  return store.createArtifact({
    runId,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType,
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function createMediaAdapterForProvider(provider: ProviderPreset) {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok) {
    throw new HttpError(400, gate.errorCode ?? "invalid_request", gate.errorMessage ?? "Invalid media vendor transport configuration.");
  }
  const secret = resolveSecretRef(provider.apiKeyRef);
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: gate.config?.mode === "live"
      ? createLiveMediaVendorTransport({
        baseUrl: provider.baseUrl,
        apiKeyRef: provider.apiKeyRef,
        apiKeyConfigured: secret.configured,
        apiKey: secret.value,
      })
      : undefined,
  });
  const resolution = resolveMediaAdapter(registry, {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKeyRef: provider.apiKeyRef,
    capabilities: provider.capabilities,
  });
  if (!resolution.ok || !resolution.adapter) {
    throw new HttpError(400, resolution.errorCode ?? "unsupported_capability", resolution.errorMessage ?? "Media adapter is not available.");
  }
  return resolution.adapter;
}

type MediaCostApprovalGateResult =
  | { readonly kind: "not_required" }
  | { readonly kind: "approved"; readonly approval: ApprovalRequest }
  | { readonly kind: "waiting_for_approval"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest }
  | { readonly kind: "blocked"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest };

function applyMediaCostApprovalGate(store: RunStore, job: MediaJob, provider: ProviderPreset): MediaCostApprovalGateResult {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok || gate.config?.mode !== "live") {
    return { kind: "not_required" };
  }

  expireStalePendingApprovals(store, { mediaJobId: job.id });
  const approvals = store
    .listApprovalRequests({ mediaJobId: job.id, limit: 500 })
    .filter((approval) => approval.actionType === "media_cost");

  for (const approval of approvals) {
    if (approval.status === "pending") {
      return {
        kind: "waiting_for_approval",
        mediaJob: markMediaJobWaitingForApproval(store, job),
        approval,
      };
    }
    if (approval.status === "approved") {
      return { kind: "approved", approval };
    }
    if (approval.status === "denied" || approval.status === "expired") {
      return {
        kind: "blocked",
        mediaJob: failMediaJobForApprovalDecision(store, job, approval),
        approval,
      };
    }
  }

  const approval = store.createApprovalRequest(createMediaCostApprovalInput(job, provider), new Date().toISOString());
  return {
    kind: "waiting_for_approval",
    mediaJob: markMediaJobWaitingForApproval(store, job),
    approval,
  };
}

function createMediaCostApprovalInput(job: MediaJob, provider: ProviderPreset): CreateApprovalRequestInput {
  return {
    mediaJobId: job.id,
    actionType: "media_cost",
    risk: "high",
    title: "Approve media job cost",
    description: `${provider.displayName} ${job.operation} requires approval before live media execution.`,
    payload: {
      type: "media_cost",
      providerPresetId: provider.id,
      model: provider.model,
      operation: job.operation,
      promptPreview: truncatePreview(job.prompt),
    },
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function markMediaJobWaitingForApproval(store: RunStore, job: MediaJob): MediaJob {
  if (job.status === "waiting_for_approval" && !job.errorMessage) {
    return job;
  }
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "waiting_for_approval",
      errorMessage: null,
    },
    new Date().toISOString(),
  ) ?? job;
}

function failMediaJobForApprovalDecision(store: RunStore, job: MediaJob, approval: ApprovalRequest): MediaJob {
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "failed",
      errorMessage: `Media cost approval ${approval.status} before live media execution.`,
    },
    new Date().toISOString(),
  ) ?? job;
}

function createMediaJobArtifacts(
  store: RunStore,
  job: MediaJob,
  candidates: readonly MediaExecutionArtifact[],
  createdAt: string,
): RunArtifact[] {
  return candidates
    .map((candidate, index) => createMediaJobArtifact(store, job, candidate, index, createdAt))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact));
}

function createMediaJobArtifact(
  store: RunStore,
  job: MediaJob,
  candidate: MediaExecutionArtifact,
  index: number,
  createdAt: string,
): RunArtifact | undefined {
  if (candidate.content === undefined && candidate.contentBytes === undefined) {
    return undefined;
  }
  const artifactDir = resolvePath(store.paths.artifactsDir, "media_jobs", job.id);
  mkdirSync(artifactDir, { recursive: true });
  const relativePath = normalizeArtifactPath(`media_jobs/${job.id}/${formatMediaArtifactFilename(index, candidate, createdAt)}`);
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  if (candidate.contentBytes !== undefined) {
    writeFileSync(absolutePath, Buffer.from(candidate.contentBytes));
  } else {
    const content = redactArtifactContent(candidate.content ?? "");
    writeFileSync(absolutePath, content, "utf8");
  }
  const stats = statSync(absolutePath);

  return store.createArtifact({
    mediaJobId: job.id,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType ?? contentTypeForArtifactType(candidate.type),
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function formatMediaArtifactFilename(index: number, candidate: MediaExecutionArtifact, createdAt: string): string {
  const hintedName = candidate.pathHint ? basename(candidate.pathHint) : "";
  const titleSlug = (hintedName || candidate.title)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `artifact-${formatTimestampSlug(createdAt)}`;
  const extension = extname(titleSlug) ? "" : `.${artifactExtensionForType(candidate.type)}`;
  return `${String(index + 1).padStart(3, "0")}-${titleSlug}${extension}`;
}

function formatTimestampSlug(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "now";
}

function dedupeArtifactCandidates(candidates: readonly ExtractedArtifactCandidate[]): ExtractedArtifactCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}\0${candidate.title}\0${candidate.existingPath ?? candidate.content ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatArtifactFilename(index: number, candidate: ExtractedArtifactCandidate): string {
  const titleSlug = candidate.title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact";
  return `${String(index).padStart(3, "0")}-${titleSlug}.${artifactExtensionForType(candidate.type)}`;
}

function artifactExtensionForType(type: ArtifactType): string {
  if (type === "markdown") {
    return "md";
  }
  if (type === "diff") {
    return "diff";
  }
  if (type === "json") {
    return "json";
  }
  if (type === "log") {
    return "log";
  }
  if (type === "image") {
    return "png";
  }
  if (type === "video") {
    return "mp4";
  }
  return "txt";
}

function inferArtifactTypeFromPath(path: string, content = ""): ArtifactType {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".diff" || extension === ".patch") {
    return "diff";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".log" || extension === ".txt" || extension === ".out" || extension === ".err") {
    return "log";
  }
  if (content) {
    return inferArtifactTypeFromText(content);
  }
  return "file";
}

function inferArtifactTypeFromText(content: string): ArtifactType {
  if (isDiffLikeContent(content)) {
    return "diff";
  }
  if (isMarkdownLikeContent(content)) {
    return "markdown";
  }
  return "log";
}

function isDiffLikeContent(content: string): boolean {
  return /^diff --git /m.test(content) || /^--- .+\n\+\+\+ /m.test(content) || /^@@ /m.test(content);
}

function isMarkdownLikeContent(content: string): boolean {
  return /^#{1,6}\s+\S/m.test(content) || /```/.test(content) || /^\s*[-*]\s+\S/m.test(content);
}

function formatGeneratedFileMetadata(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, rawPath: string): string {
  return [
    `Generated file path: ${rawPath}`,
    `Source tool: ${event.toolName}`,
    `Tool call: ${event.toolCallId}`,
    "",
    "Content was not copied because artifact content is served only from .ling-stack/artifacts.",
  ].join("\n");
}

function redactArtifactContent(content: string): string {
  const redacted = redactSecrets(content);
  return typeof redacted === "string" ? redacted : content;
}

function truncateExtractedArtifactContent(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_EXTRACTED_ARTIFACT_BYTES) {
    return content;
  }
  const truncated = Buffer.from(content, "utf8").subarray(0, MAX_EXTRACTED_ARTIFACT_BYTES).toString("utf8");
  return `${truncated}\n\n[truncated from ${bytes} bytes]`;
}

function statFileIfPresent(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isPathInsideRoot(root: string, path: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function contentTypeForArtifactType(type: ArtifactType): string {
  if (type === "json") {
    return "application/json; charset=utf-8";
  }
  if (type === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (type === "diff") {
    return "text/x-diff; charset=utf-8";
  }
  if (type === "log" || type === "file") {
    return "text/plain; charset=utf-8";
  }
  if (type === "image") {
    return "image/png";
  }
  if (type === "video") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function resolveArtifactContentPath(store: RunStore, artifact: RunArtifact): string {
  const artifactRoot = store.paths.artifactsDir;
  const absolutePath = isAbsolute(artifact.path) ? artifact.path : resolvePath(artifactRoot, artifact.path);
  const relativePath = relative(artifactRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact content path is outside .ling-stack/artifacts: ${artifact.path}`);
  }
  return absolutePath;
}

function inferArtifactContentType(artifact: RunArtifact): string {
  return contentTypeForArtifactType(artifact.type);
}

function formatEditPreview(edits: readonly unknown[]): string {
  if (edits.length === 0) {
    return "No edit preview was provided.";
  }
  return edits
    .map((edit, index) => {
      if (!isRecord(edit)) {
        return `#${index + 1}\n<invalid edit entry>`;
      }
      const oldText = readInputString(edit, "oldText", "");
      const newText = readInputString(edit, "newText", "");
      return `#${index + 1}\n- ${truncatePreview(oldText, 320)}\n+ ${truncatePreview(newText, 320)}`;
    })
    .join("\n\n");
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readOptionalJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function parseRunRequest(value: unknown): RunRequest {
  if (!isRecord(value)) {
    throw new Error("Run request must be a JSON object");
  }

  const cwd = readString(value, "cwd");
  const workspaceCwd = readOptionalString(value, "workspaceCwd");
  const task = value.task;
  const provider = value.provider;
  const providerPresetId = readOptionalString(value, "providerPresetId");
  const skipProviderPreflight = readOptionalBoolean(value, "skipProviderPreflight") ?? false;

  if (!isRecord(task)) {
    throw new Error("task must be an object");
  }
  if (provider !== undefined && !isRecord(provider)) {
    throw new Error("provider must be an object");
  }
  if (providerPresetId && provider !== undefined) {
    throw new Error("providerPresetId and provider cannot both be supplied");
  }
  if (!providerPresetId && provider === undefined) {
    throw new Error("Either providerPresetId or provider is required");
  }

  const runRequest: RunRequest = {
    cwd,
    workspaceCwd,
    providerPresetId,
    skipProviderPreflight,
    task: {
      id: readString(task, "id"),
      title: readString(task, "title"),
      prompt: readString(task, "prompt"),
      channelId: readOptionalString(task, "channelId"),
    },
    provider: provider ? parseInlineProvider(provider) : undefined,
    tools: readOptionalStringArray(value, "tools", ["read", "bash", "edit", "write", "grep", "find", "ls"]) ?? [...readOnlyRunTools],
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };

  return runRequest;
}

function parseInlineProvider(provider: Record<string, unknown>): PiRunnerProviderConfig {
  return {
    provider: readString(provider, "provider"),
    model: readString(provider, "model"),
    displayName: readOptionalString(provider, "displayName"),
    apiKey: readOptionalString(provider, "apiKey"),
    baseUrl: readOptionalString(provider, "baseUrl"),
    api: readOptionalProviderApi(provider, "api"),
    headers: readOptionalStringRecord(provider, "headers"),
    authHeader: readOptionalBoolean(provider, "authHeader"),
    reasoning: readOptionalBoolean(provider, "reasoning"),
    input: readOptionalStringArray(provider, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(provider, "contextWindow"),
    maxTokens: readOptionalNumber(provider, "maxTokens"),
    compat: isRecord(provider.compat) ? provider.compat : undefined,
  };
}

function parseRunRoute(
  pathname: string,
): { kind: "run"; runId: string } | { kind: "events"; runId: string } | { kind: "artifacts"; runId: string } | { kind: "cancel"; runId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "runs") {
    return { kind: "run", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    return { kind: "events", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "artifacts") {
    return { kind: "artifacts", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
    return { kind: "cancel", runId: segments[1] };
  }
  return undefined;
}

function parseArtifactRoute(pathname: string): { kind: "artifact"; artifactId: string } | { kind: "content"; artifactId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "artifacts") {
    return { kind: "artifact", artifactId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "artifacts" && segments[2] === "content") {
    return { kind: "content", artifactId: segments[1] };
  }
  return undefined;
}

function parseChannelRoute(pathname: string): { readonly channelId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channels") {
    return { channelId: segments[1] };
  }
  return undefined;
}

function parseTaskRoute(pathname: string): { readonly taskId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "tasks") {
    return { taskId: segments[1] };
  }
  return undefined;
}

function parseProviderRoute(pathname: string): { readonly providerId: string; readonly action?: "check" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "providers") {
    return { providerId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "check") {
    return { providerId: segments[1], action: "check" };
  }
  return undefined;
}

function parseMediaJobRoute(pathname: string): { readonly mediaJobId: string; readonly action?: "run" | "artifacts" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-jobs") {
    return { mediaJobId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "media-jobs" && (segments[2] === "run" || segments[2] === "artifacts")) {
    return { mediaJobId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseApprovalRoute(pathname: string): { readonly approvalId: string; readonly action?: "approve" | "deny" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "approvals") {
    return { approvalId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "approvals" && (segments[2] === "approve" || segments[2] === "deny")) {
    return { approvalId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseApprovalPolicyUpdateInput(value: unknown): ApprovalPolicyUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Approval policy update must be a JSON object");
  }
  const input: ApprovalPolicyUpdateInput = {
    toolDecisions: readOptionalApprovalToolDecisions(value, "toolDecisions"),
    allowedWritePaths: readOptionalStringArray(value, "allowedWritePaths")?.map((path) => path.trim()),
  };
  validateApprovalPolicyUpdateInput(input);
  return input;
}

function validateApprovalPolicyUpdateInput(input: ApprovalPolicyUpdateInput): void {
  if (input.allowedWritePaths?.some((path) => path.trim().length === 0)) {
    throw new Error("allowedWritePaths must not contain empty paths");
  }
}

function parseCreateChannelInput(value: unknown): CreateChannelInput {
  if (!isRecord(value)) {
    throw new Error("Channel request must be a JSON object");
  }
  const input: CreateChannelInput = {
    name: readString(value, "name"),
    boundPath: readOptionalString(value, "boundPath"),
    defaultProviderPresetId: readOptionalString(value, "defaultProviderPresetId"),
    defaultTeammateId: readOptionalString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
  };
  validateChannelInput(input);
  return input;
}

function parseChannelUpdateInput(value: unknown): ChannelUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Channel update must be a JSON object");
  }
  const input: ChannelUpdateInput = {
    name: readOptionalString(value, "name"),
    boundPath: readNullableString(value, "boundPath"),
    defaultProviderPresetId: readNullableString(value, "defaultProviderPresetId"),
    defaultTeammateId: readNullableString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
  };
  validateChannelInput(input);
  return input;
}

function validateChannelInput(input: ChannelUpdateInput): void {
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) {
    throw new Error("Task request must be a JSON object");
  }
  const input: CreateTaskInput = {
    channelId: readString(value, "channelId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
  };
  validateTaskInput(input);
  return input;
}

function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Task update must be a JSON object");
  }
  const input: TaskUpdateInput = {
    channelId: readOptionalString(value, "channelId"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readNullableString(value, "assigneeTeammateId"),
    currentRunId: readNullableString(value, "currentRunId"),
  };
  validateTaskInput(input);
  return input;
}

function validateTaskInput(input: TaskUpdateInput): void {
  if (input.channelId !== undefined && input.channelId.trim().length === 0) {
    throw new Error("channelId must be a non-empty string");
  }
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
}

function parseCreateMediaJobInput(value: unknown): CreateMediaJobInput {
  if (!isRecord(value)) {
    throw new Error("Media job request must be a JSON object");
  }
  const input: CreateMediaJobInput = {
    providerPresetId: readString(value, "providerPresetId"),
    operation: readMediaOperation(value, "operation"),
    prompt: readString(value, "prompt"),
    input: readOptionalObject(value, "input"),
  };
  validateMediaJobInput(input);
  return input;
}

function validateMediaJobInput(input: CreateMediaJobInput): void {
  if (!input.providerPresetId.trim()) {
    throw new Error("providerPresetId must be a non-empty string");
  }
  if (!input.prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
}

function assertMediaJobProvider(store: RunStore, input: CreateMediaJobInput): ProviderPreset {
  const preset = store.getProviderPreset(input.providerPresetId);
  if (!preset) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${input.providerPresetId}`);
  }
  if (!preset.enabled) {
    throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
  }
  if (preset.api !== "media-job") {
    throw new HttpError(400, "unsupported_capability", "Media jobs require a media-job provider preset");
  }
  if (!preset.capabilities.includes(input.operation)) {
    throw new HttpError(400, "unsupported_capability", `${preset.displayName} does not support ${input.operation}`);
  }
  return preset;
}

function isRunnableMediaJobStatus(status: MediaJobStatus): boolean {
  return status === "queued" || status === "waiting_for_approval" || status === "failed" || status === "cancelled";
}

function shouldForceStaticMediaFailure(input: Record<string, unknown>): boolean {
  return input.forceFailure === true;
}

function parseProviderPresetInput(value: unknown): ProviderPresetInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return validateProviderPresetInput({
    kind: readProviderKind(value, "kind"),
    displayName: readString(value, "displayName"),
    providerId: readString(value, "providerId"),
    model: readString(value, "model"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(value, "contextWindow"),
    maxTokens: readOptionalNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  });
}

function parseProviderPresetUpdateInput(value: unknown): ProviderPresetUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }

  const input: ProviderPresetUpdateInput = {
    kind: value.kind === undefined ? undefined : readProviderKind(value, "kind"),
    displayName: readOptionalString(value, "displayName"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    api: value.api === undefined ? undefined : readProviderApi(value, "api"),
    baseUrl: readNullableString(value, "baseUrl"),
    apiKeyRef: readNullableApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readNullableBoolean(value, "authHeader"),
    reasoning: readNullableBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readNullableNumber(value, "contextWindow"),
    maxTokens: readNullableNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: value.capabilities === undefined ? undefined : readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  };

  return input;
}

function validateProviderPresetInput(input: ProviderPresetInput): ProviderPresetInput {
  validateProviderPresetShape(input);
  return input;
}

function validateProviderPresetUpdate(existing: ProviderPreset, input: ProviderPresetUpdateInput): void {
  validateProviderPresetShape({
    kind: input.kind ?? existing.kind,
    displayName: input.displayName ?? existing.displayName,
    providerId: input.providerId ?? existing.providerId,
    model: input.model ?? existing.model,
    api: input.api ?? existing.api,
    baseUrl: input.baseUrl === null ? undefined : input.baseUrl ?? existing.baseUrl,
    apiKeyRef: input.apiKeyRef === null ? undefined : input.apiKeyRef ?? existing.apiKeyRef,
    capabilities: input.capabilities ?? existing.capabilities,
  });
}

function validateProviderPresetShape(input: {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly capabilities?: readonly ProviderCapability[];
}): void {
  if (!input.displayName?.trim()) {
    throw new Error("displayName must be a non-empty string");
  }
  if (!input.providerId?.trim()) {
    throw new Error("providerId must be a non-empty string");
  }
  if (input.providerId && !/^[A-Za-z0-9._-]+$/.test(input.providerId)) {
    throw new Error("providerId may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!input.model?.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (input.kind === "openai-compatible" && !input.baseUrl) {
    throw new Error("baseUrl is required for openai-compatible providers");
  }
  if (input.baseUrl) {
    validateUrl(input.baseUrl, "baseUrl");
  }
  if (input.apiKeyRef && !isSupportedSecretRef(input.apiKeyRef)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  if (!input.capabilities || input.capabilities.length === 0) {
    throw new Error("capabilities must contain at least one capability");
  }
  if (input.api === "media-job") {
    const hasMediaCapability = input.capabilities.some((capability) =>
      ["image_generate", "image_edit", "video_generate"].includes(capability),
    );
    if (!hasMediaCapability) {
      throw new Error("media-job providers must include a media capability");
    }
    return;
  }
  if (!input.capabilities.includes("chat")) {
    throw new Error("coding provider presets must include chat capability");
  }
}

function toPublicProviderPreset(preset: ProviderPreset): PublicProviderPreset {
  return {
    ...preset,
    apiKeyConfigured: resolveSecretRef(preset.apiKeyRef).configured,
  };
}

async function checkProviderPreset(preset: ProviderPreset): Promise<ProviderCheckResult> {
  const checkedAt = new Date().toISOString();
  if (preset.baseUrl) {
    try {
      validateUrl(preset.baseUrl, "baseUrl");
    } catch (error) {
      return { ok: false, code: "bad_request", message: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }
  const needsSecret = preset.api === "anthropic-messages" || preset.authHeader !== false;
  if (needsSecret && !preset.apiKeyRef) {
    return { ok: false, code: "secret_missing", message: "Secret is not configured: apiKeyRef is required for live checks.", checkedAt };
  }
  if (preset.apiKeyRef && !resolveSecretRef(preset.apiKeyRef).configured) {
    return { ok: false, code: "secret_missing", message: `Secret is not configured: ${preset.apiKeyRef}`, checkedAt };
  }
  if (preset.api !== "media-job" && !preset.capabilities.includes("chat")) {
    return { ok: false, code: "unsupported_capability", message: "Provider preset cannot run chat tasks.", checkedAt };
  }
  if (!preset.enabled) {
    return { ok: false, code: "provider_disabled", message: "Provider preset is disabled.", checkedAt };
  }

  if (preset.api === "media-job") {
    const gate = resolveMediaVendorTransportGateConfig(preset.compat);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.errorCode ?? "invalid_request",
        message: gate.errorMessage ?? "Invalid media vendor transport configuration.",
        checkedAt,
      };
    }
    if (gate.config?.mode === "live") {
      if (!preset.baseUrl) {
        return { ok: false, code: "bad_request", message: "baseUrl is required for live media vendor transport.", checkedAt };
      }
      if (!preset.apiKeyRef) {
        return { ok: false, code: "secret_missing", message: "Secret is not configured: apiKeyRef is required for live media vendor transport.", checkedAt };
      }
      if (!resolveSecretRef(preset.apiKeyRef).configured) {
        return { ok: false, code: "secret_missing", message: `Secret is not configured: ${preset.apiKeyRef}`, checkedAt };
      }
      if (preset.kind !== "seedream" || !preset.capabilities.includes("image_generate")) {
        return {
          ok: false,
          code: "unsupported_capability",
          message: "Live media vendor transport currently supports Seedream image_generate only.",
          checkedAt,
        };
      }
      return {
        ok: true,
        code: "static_check",
        message: "Seedream image_generate live transport configuration is complete. Provider check does not create media or make generation requests.",
        checkedAt,
      };
    }
    return {
      ok: true,
      code: "static_check",
      message: "Media provider configuration is valid. Media vendor transport is disabled by default and no live vendor HTTP request will be made.",
      checkedAt,
    };
  }

  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(preset.api)) {
    return {
      ok: true,
      code: "static_check",
      message: `Provider configuration is valid. Live checks for ${preset.api} are not implemented yet.`,
      checkedAt,
    };
  }

  return await probeChatProvider(preset, checkedAt);
}

async function probeChatProvider(preset: ProviderPreset, checkedAt: string): Promise<ProviderCheckResult> {
  try {
    const response = await fetch(buildProviderCheckUrl(preset), {
      method: "POST",
      headers: buildProviderCheckHeaders(preset),
      body: JSON.stringify(buildProviderCheckBody(preset)),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      return {
        ok: true,
        code: "ready",
        message: "Provider is reachable and accepted the configured model.",
        checkedAt,
      };
    }

    return await providerCheckHttpFailure(response, checkedAt);
  } catch (error) {
    return {
      ok: false,
      code: "network_failed",
      message: `Provider network check failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  }
}

function buildProviderCheckUrl(preset: ProviderPreset): string {
  const baseUrl = normalizeProviderBaseUrl(preset);
  if (preset.api === "anthropic-messages") {
    return `${baseUrl}/messages`;
  }
  if (preset.api === "openai-responses") {
    return `${baseUrl}/responses`;
  }
  return `${baseUrl}/chat/completions`;
}

function normalizeProviderBaseUrl(preset: ProviderPreset): string {
  if (preset.baseUrl) {
    return preset.baseUrl.replace(/\/+$/, "");
  }
  if (preset.api === "anthropic-messages" || preset.kind === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function buildProviderCheckHeaders(preset: ProviderPreset): Record<string, string> {
  const secret = resolveSecretRef(preset.apiKeyRef);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...preset.headers,
  };

  if (preset.api === "anthropic-messages") {
    if (secret.value) {
      headers["x-api-key"] = secret.value;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }

  if (preset.authHeader !== false && secret.value) {
    headers.Authorization = `Bearer ${secret.value}`;
  }
  return headers;
}

function buildProviderCheckBody(preset: ProviderPreset): Record<string, unknown> {
  if (preset.api === "anthropic-messages") {
    return {
      model: preset.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
    };
  }
  if (preset.api === "openai-responses") {
    return {
      model: preset.model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      stream: false,
    };
  }
  return {
    model: preset.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
  };
}

async function providerCheckHttpFailure(response: Response, checkedAt: string): Promise<ProviderCheckResult> {
  const bodyText = await readLimitedResponseText(response, 800);
  const lowerBody = bodyText.toLowerCase();
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "auth_failed",
      message: `Provider authentication failed with HTTP ${response.status}. Check apiKeyRef and account access.`,
      checkedAt,
    };
  }
  if (response.status === 404 || lowerBody.includes("model") && (lowerBody.includes("not found") || lowerBody.includes("does not exist"))) {
    return {
      ok: false,
      code: "model_unsupported",
      message: `Provider rejected the endpoint or model with HTTP ${response.status}. Check baseUrl and model.`,
      checkedAt,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      message: "Provider is reachable but rate limited the health check.",
      checkedAt,
    };
  }
  return {
    ok: false,
    code: "provider_error",
    message: `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`,
    checkedAt,
  };
}

async function readLimitedResponseText(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "";
  }
}

function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  return {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 17891,
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeSseHead(response: ServerResponse): void {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": ling-stack run stream\n\n");
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readNullableBoolean(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean or null`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number or null`);
  }
  return value;
}

function readOptionalStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw new Error(`${key}.${entryKey} must be a string`);
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readOptionalObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function readOptionalApiKeyRef(record: Record<string, unknown>): string | undefined {
  const value = readOptionalString(record, "apiKeyRef");
  if (value && !isSupportedSecretRef(value)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  return value;
}

function readNullableApiKeyRef(record: Record<string, unknown>): string | null | undefined {
  const value = readNullableString(record, "apiKeyRef");
  if (typeof value === "string" && !isSupportedSecretRef(value)) {
    throw new Error("apiKeyRef must use env:NAME");
  }
  return value;
}

function readOptionalStringArray<T extends string = string>(
  record: Record<string, unknown>,
  key: string,
  allowed?: readonly T[],
): T[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be a string`);
    }
    if (allowed && !allowed.includes(item as T)) {
      throw new Error(`${key}[${index}] must be one of: ${allowed.join(", ")}`);
    }
    return item as T;
  });
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readOptionalApprovalToolDecisions(
  record: Record<string, unknown>,
  key: string,
): Partial<Record<RunTool, ApprovalToolDecision>> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }

  const result: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  const validTools = Object.keys(defaultApprovalToolDecisions) as RunTool[];
  for (const [tool, decision] of Object.entries(value)) {
    if (!validTools.includes(tool as RunTool)) {
      throw new Error(`${key}.${tool} is not a supported tool`);
    }
    if (typeof decision !== "string" || !approvalToolDecisions.includes(decision as ApprovalToolDecision)) {
      throw new Error(`${key}.${tool} must be one of: ${approvalToolDecisions.join(", ")}`);
    }
    result[tool as RunTool] = decision as ApprovalToolDecision;
  }
  return result;
}

function readOptionalTaskStatus(record: Record<string, unknown>, key: string): TaskStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`${key} must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readProviderKind(record: Record<string, unknown>, key: string): ProviderKind {
  const value = readString(record, key);
  if (!providerKinds.includes(value as ProviderKind)) {
    throw new Error(`${key} must be one of: ${providerKinds.join(", ")}`);
  }
  return value as ProviderKind;
}

function readProviderApi(record: Record<string, unknown>, key: string): ProviderApi {
  const value = readString(record, key);
  if (!providerApis.includes(value as ProviderApi)) {
    throw new Error(`${key} must be one of: ${providerApis.join(", ")}`);
  }
  return value as ProviderApi;
}

function readProviderCapabilities(record: Record<string, unknown>, key: string): ProviderCapability[] {
  return readOptionalStringArray(record, key, providerCapabilities)?.map((capability) => capability as ProviderCapability) ?? [];
}

function readMediaOperation(record: Record<string, unknown>, key: string): MediaOperation {
  const value = readString(record, key);
  if (!mediaOperations.includes(value as MediaOperation)) {
    throw new Error(`${key} must be one of: ${mediaOperations.join(", ")}`);
  }
  return value as MediaOperation;
}

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])?.[0];
}

function readOptionalProviderApi(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["api"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
  ])?.[0];
}

function readOptionalIntegerQuery(url: URL, key: string, minValue: number): number | undefined {
  const rawValue = url.searchParams.get(key);
  if (rawValue === null) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < minValue || String(value) !== rawValue) {
    throw new Error(`${key} must be an integer greater than or equal to ${minValue}`);
  }
  return value;
}

function readOptionalRunStatusQuery(url: URL): RunStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].includes(value)) {
    throw new Error("status must be one of: queued, running, waiting_for_approval, succeeded, failed, cancelled");
  }
  return value as RunStatus;
}

function readOptionalTaskStatusQuery(url: URL): TaskStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`status must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readOptionalApprovalStatusQuery(url: URL): ApprovalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!approvalStatuses.includes(value as ApprovalStatus)) {
    throw new Error(`status must be one of: ${approvalStatuses.join(", ")}`);
  }
  return value as ApprovalStatus;
}

function readOptionalMediaJobStatusQuery(url: URL): MediaJobStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!mediaJobStatuses.includes(value as MediaJobStatus)) {
    throw new Error(`status must be one of: ${mediaJobStatuses.join(", ")}`);
  }
  return value as MediaJobStatus;
}

function validateUrl(value: string, fieldName: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}

class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRun>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, run);
  }

  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  delete(runId: string): void {
    this.activeRuns.delete(runId);
  }

  cancelAll(): void {
    for (const run of this.activeRuns.values()) {
      run.abortController.abort();
    }
    this.activeRuns.clear();
  }
}

class RunStoreRegistry {
  private readonly storesByCwd = new Map<string, RunStore>();
  private readonly storesByRunId = new Map<string, RunStore>();

  constructor(private readonly storeFactory: RunStoreFactory) {}

  getStore(cwd: string): RunStore {
    const existing = this.storesByCwd.get(cwd);
    if (existing) {
      return existing;
    }

    const store = this.storeFactory(cwd);
    store.recoverStaleRuns(new Date().toISOString());
    this.storesByCwd.set(cwd, store);
    return store;
  }

  rememberRun(runId: string, store: RunStore): void {
    this.storesByRunId.set(runId, store);
  }

  findStoreForRun(runId: string, cwd?: string): RunStore | undefined {
    if (cwd) {
      return this.getStore(cwd);
    }

    const knownStore = this.storesByRunId.get(runId);
    if (knownStore?.getRun(runId)) {
      return knownStore;
    }

    for (const store of this.storesByCwd.values()) {
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    return undefined;
  }

  findStoreForArtifact(artifactId: string, cwd?: string): { readonly store: RunStore; readonly artifact: RunArtifact } | undefined {
    if (cwd) {
      const store = this.getStore(cwd);
      const artifact = store.getArtifact(artifactId);
      return artifact ? { store, artifact } : undefined;
    }

    for (const store of this.storesByCwd.values()) {
      const artifact = store.getArtifact(artifactId);
      if (artifact) {
        if (artifact.runId) {
          this.rememberRun(artifact.runId, store);
        }
        return { store, artifact };
      }
    }

    return undefined;
  }

  closeAll(): void {
    for (const store of this.storesByCwd.values()) {
      store.close();
    }
    this.storesByCwd.clear();
    this.storesByRunId.clear();
  }
}
